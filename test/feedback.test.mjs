import { test } from "node:test";
import assert from "node:assert/strict";
import {
  TEXT_LIMIT,
  normaliseFeedbackText,
  buildIssueUrl,
  buildFeedbackPayload,
  describeFeedbackResult,
  describeQuota,
  nextQuota,
  quotaCount,
} from "../src/lib/feedback.mjs";

test("normaliseFeedbackText 折叠控制字符并限长", () => {
  assert.equal(normaliseFeedbackText("  两行\n\n文字\t带制表  "), "两行\n\n文字 带制表");
  assert.equal(normaliseFeedbackText(null), "");
  assert.equal(normaliseFeedbackText(undefined), "");
  assert.equal(normaliseFeedbackText(123), "123");
  assert.equal(normaliseFeedbackText("\u0000\u001f\ufffd"), "");
  assert.equal(normaliseFeedbackText("a".repeat(TEXT_LIMIT + 50)).length, TEXT_LIMIT);
});

test("normaliseFeedbackText 保留换行，堆栈日志不被压成一行", () => {
  // 用户最常贴的就是报错日志。压成一行后堆栈就没法看了。
  const paste = "点了「生成解读」后报错：\nError: timeout\n    at fetchTrending (main.js:480)\n\n试了三次都一样。";
  const out = normaliseFeedbackText(paste);
  assert.match(out, /\n/, "应保留换行");
  assert.match(out, /Error: timeout\n\s+at fetchTrending/);
  assert.ok(!/\r/.test(out), "CRLF 应收敛成 LF");
});

test("normaliseFeedbackText 折叠连续空行与行尾空白", () => {
  assert.equal(normaliseFeedbackText("a\n\n\n\n\nb"), "a\n\nb", "连续空行压成一行空行");
  // 行尾空白去掉，但行首缩进保留——堆栈靠它对齐（见上一条用例）。
  assert.equal(normaliseFeedbackText("a   \n    b"), "a\n    b", "行尾去空白、行首缩进保留");
  assert.equal(normaliseFeedbackText("\n\n\na\n\n\n"), "a", "首尾空行去掉");
  assert.equal(normaliseFeedbackText("  开头缩进要去掉"), "开头缩进要去掉", "整段开头的缩进去掉");
});

test("normaliseFeedbackText 保留中文与 emoji", () => {
  assert.equal(normaliseFeedbackText("界面卡住了 😵‍💫"), "界面卡住了 😵‍💫");
});

test("buildIssueUrl 预填标题与正文并做编码", () => {
  const url = buildIssueUrl({
    repo: "renhao-wan/ccgui-plugin-github-trending",
    pluginName: "每日热点",
    text: "设置页 #号 & 问号 ? 换行",
    pluginVersion: "0.1.0",
    hostVersion: "1.2.4",
  });
  assert.ok(url.startsWith("https://github.com/renhao-wan/ccgui-plugin-github-trending/issues/new?"));
  assert.ok(!url.includes(" "), "URL 里不能有裸空格");
  assert.ok(url.includes("title="));
  assert.ok(url.includes("body="));
  const q = new URL(url).searchParams;
  assert.equal(q.get("title"), "[反馈] 每日热点");
  assert.match(q.get("body"), /设置页 #号 & 问号 \? 换行/);
  assert.match(q.get("body"), /0\.1\.0/);
  assert.match(q.get("body"), /1\.2\.4/);
});

test("buildIssueUrl 无正文时仍生成合法链接", () => {
  const url = buildIssueUrl({ repo: "a/b", pluginName: "X", text: "", pluginVersion: "1", hostVersion: "2" });
  assert.ok(url.startsWith("https://github.com/a/b/issues/new?"));
  assert.ok(new URL(url).searchParams.get("title"));
});

test("buildFeedbackPayload 只带必要字段，不含任何本机路径", () => {
  const payload = buildFeedbackPayload({
    text: "  建议加个深色模式  ",
    pluginId: "github-trending",
    pluginVersion: "0.1.0",
    hostVersion: "1.2.4",
    now: 1795000000000,
  });
  assert.deepEqual(Object.keys(payload).sort(), ["hostVersion", "pluginId", "pluginVersion", "text", "ts"]);
  assert.equal(payload.text, "建议加个深色模式");
  assert.equal(payload.pluginId, "github-trending");
  assert.equal(payload.ts, 1795000000000);
});

test("buildFeedbackPayload 去掉插件白名单外的字段", () => {
  const payload = buildFeedbackPayload({
    text: "hi",
    pluginId: "evil",
    pluginVersion: "0",
    hostVersion: "0",
    now: 1,
    token: "secret",
    workspacePath: "D:\\secret",
  });
  assert.equal(payload.token, undefined);
  assert.equal(payload.workspacePath, undefined);
});

test("describeFeedbackResult 命中各响应分支", () => {
  assert.equal(describeFeedbackResult({ status: 200, body: '{"ok":true}' }).ok, true);

  const limited = describeFeedbackResult({
    status: 429,
    body: '{"ok":false,"error":"rate_limited","remaining":0}',
  });
  assert.equal(limited.ok, false);
  assert.equal(limited.kind, "rate_limited");
  assert.match(limited.message, /额度/);

  const rejected = describeFeedbackResult({ status: 400, body: '{"ok":false,"error":"invalid_text"}' });
  assert.equal(rejected.kind, "invalid");

  const server = describeFeedbackResult({ status: 500, body: "boom" });
  assert.equal(server.ok, false);
  assert.match(server.message, /GitHub Issue/);
});

test("describeFeedbackResult 区分突发限流与日额度耗尽", () => {
  // 突发：10 分钟 3 条撞了。让用户「明天再来」是错的——等十分钟就好。
  const burst = describeFeedbackResult({
    status: 429,
    body: '{"ok":false,"error":"rate_limited","kind":"burst","remaining":0}',
  });
  assert.equal(burst.kind, "rate_limited");
  assert.match(burst.message, /太快|稍候|分钟/);
  assert.doesNotMatch(burst.message, /明天/);

  // 日额度：真的今天没了。
  const daily = describeFeedbackResult({
    status: 429,
    body: '{"ok":false,"error":"rate_limited","kind":"daily","remaining":0}',
  });
  assert.match(daily.message, /明天/);

  // 服务端没给 kind 时保守按日额度处理，不能说「稍候再试」骗人白等。
  const unknownKind = describeFeedbackResult({
    status: 429,
    body: '{"ok":false,"error":"rate_limited","remaining":0}',
  });
  assert.match(unknownKind.message, /明天/);
});

test("describeFeedbackResult 把 400 的几种原因分开说", () => {
  // 插件 id 没在 Worker 白名单里：是版本错位，不是用户写错了字。
  const unknown = describeFeedbackResult({
    status: 400,
    body: '{"ok":false,"error":"unknown_plugin"}',
  });
  assert.equal(unknown.kind, "invalid");
  assert.match(unknown.message, /GitHub Issue/);
  assert.doesNotMatch(unknown.message, /缩短/, "不该叫用户去缩短一段本来就不长的话");

  const empty = describeFeedbackResult({ status: 400, body: '{"ok":false,"error":"empty_text"}' });
  assert.match(empty.message, /空|写点|内容/);
});

test("describeFeedbackResult 把 502 说成服务端发不出，而不是用户的错", () => {
  const smtp = describeFeedbackResult({ status: 502, body: '{"ok":false,"error":"smtp_failed"}' });
  assert.equal(smtp.ok, false);
  assert.match(smtp.message, /GitHub Issue/);
  assert.match(smtp.message, /暂时|中转|稍后/);
  assert.doesNotMatch(smtp.message, /缩短|写得|内容不合/);
});

test("describeFeedbackResult 对未知状态码与 0 也有话说", () => {
  const zero = describeFeedbackResult({ status: 0, body: "" });
  assert.equal(zero.ok, false);
  assert.match(zero.message, /连不上|网络|GitHub Issue/);
  assert.doesNotMatch(zero.message, /HTTP 0/);

  const teapot = describeFeedbackResult({ status: 418, body: "" });
  assert.match(teapot.message, /418/);
  assert.match(teapot.message, /GitHub Issue/);

  const notFound = describeFeedbackResult({ status: 404, body: '{"ok":false,"error":"not_found"}' });
  assert.match(notFound.message, /GitHub Issue/);
});

test("describeFeedbackResult 网络异常时提示检查网络或代理", () => {
  // 国内最常见的失败：workers.dev 被 DNS 污染，连接直接超时。
  // 光说「连不上」用户不知道能干什么。
  const r = describeFeedbackResult({ error: new Error("SocketException: Failed host lookup") });
  assert.equal(r.ok, false);
  assert.match(r.message, /网络|代理/);
  assert.match(r.message, /GitHub Issue/);
});

test("describeFeedbackResult 权限未生效时让用户重装，而不是去查网络", () => {
  // network: 授权是安装时授予的。从旧版本升级、没重新安装的机器就会撞这条，
  // 提示「检查网络」会让他白白排查半天。
  const r = describeFeedbackResult({
    error: new Error('plugin_http_request denied: network:ccgui-feedback.2653990378.workers.dev not granted'),
  });
  assert.equal(r.ok, false);
  assert.equal(r.kind, "denied");
  assert.match(r.message, /重新安装/);
  assert.doesNotMatch(r.message, /检查网络/);
});

test("describeFeedbackResult 对非 JSON 响应不抛错", () => {
  const r = describeFeedbackResult({ status: 502, body: "<html>bad gateway</html>" });
  assert.equal(r.ok, false);
  assert.equal(typeof r.message, "string");
  assert.ok(r.message.length > 0);
});

test("describeFeedbackResult 网络异常转成可读文案", () => {
  const r = describeFeedbackResult({ error: new Error("error sending request") });
  assert.equal(r.ok, false);
  assert.match(r.message, /网络|GitHub Issue/);
  const timeout = describeFeedbackResult({ error: new Error("http timeout") });
  assert.match(timeout.message, /超时|GitHub Issue/);
});

test("describeQuota 生成额度提示文案", () => {
  assert.equal(describeQuota({ remaining: 27, dailyLimit: 30 }).remaining, 27);
  assert.match(describeQuota({ remaining: 27, dailyLimit: 30 }).message, /27/);

  assert.match(describeQuota({ remaining: 0, dailyLimit: 30 }).message, /用完|明天/);

  const unknown = describeQuota(null);
  assert.equal(unknown.remaining, null);
  assert.match(unknown.message, /额度有限/);
});

test("describeQuota 中转连不上时不冒充「额度有限」", () => {
  // 「额度有限，请勿刷屏」暗示是用户发太多。可如果是网络不通，
  // 用户会一直以为是自己的问题，而不是去检查代理。
  const r = describeQuota({ offline: true });
  assert.equal(r.remaining, null);
  assert.match(r.message, /连不上|暂时|服务/);
  assert.doesNotMatch(r.message, /刷屏/, "网络故障不该说成用户刷屏");
});

test("describeFeedbackResult 只有带 ok:true 的 200 才算发送成功", () => {
  // 运营商劫持页、登录门户、代理错误页都会返回 200。只看状态码就会
  // 告诉用户「已发送」，而他实际上什么也没发出去。
  const hijack = describeFeedbackResult({
    status: 200,
    body: "<html><body>请登录校园网</body></html>",
  });
  assert.equal(hijack.ok, false, "HTML 劫持页不能判成功");
  assert.match(hijack.message, /GitHub Issue/);
  assert.doesNotMatch(hijack.message, /已发送/);

  const empty = describeFeedbackResult({ status: 200, body: "" });
  assert.equal(empty.ok, false, "空响应不能判成功");

  const notOk = describeFeedbackResult({ status: 200, body: '{"error":"proxy blocked"}' });
  assert.equal(notOk.ok, false, "没有 ok:true 不能判成功");

  // 真的成功响应必须带 ok:true。
  const good = describeFeedbackResult({ status: 200, body: '{"ok":true,"remaining":26}' });
  assert.equal(good.ok, true);
  assert.equal(good.remaining, 26);
});

test("describeFeedbackResult 突发限流透传服务端的真实剩余额度", () => {
  // Worker 在 burst 时回的是 remaining:27（今天还剩 27 条）。
  // 插件写死 0 的话，一旦界面用这个值更新额度，就会说「今天用完了」。
  const r = describeFeedbackResult({
    status: 429,
    body: '{"ok":false,"error":"rate_limited","kind":"burst","remaining":27}',
  });
  assert.equal(r.remaining, 27, "突发限流不该把剩余额度说成 0");
  assert.match(r.message, /太快|稍候|分钟/);
});

test("describeFeedbackResult 把 413 / 503 分开说", () => {
  const big = describeFeedbackResult({ status: 413, body: '{"ok":false,"error":"too_large"}' });
  assert.match(big.message, /长|缩短/);

  // KV 挂了是中转自己的事，别让用户去改内容。
  const storage = describeFeedbackResult({ status: 503, body: '{"ok":false,"error":"storage_unavailable"}' });
  assert.match(storage.message, /中转|稍后/);
  assert.match(storage.message, /GitHub Issue/);
  assert.doesNotMatch(storage.message, /缩短|内容不合/);

  // 500 也应该是「中转出了问题」，不是用户的错。
  const internal = describeFeedbackResult({ status: 500, body: '{"ok":false,"error":"internal_error"}' });
  assert.match(internal.message, /GitHub Issue/);
  assert.doesNotMatch(internal.message, /缩短/);
});

test("describeQuota 额度字段是脏数据时退回安全文案而不是显示 NaN", () => {
  for (const bad of [{ remaining: "abc" }, { remaining: null }, { remaining: NaN }, {}]) {
    const r = describeQuota(bad);
    assert.equal(r.remaining, null);
    assert.doesNotMatch(r.message, /NaN|undefined/, "不能把 NaN/undefined 漏到界面上");
    assert.ok(r.message.length > 0);
  }
});

test("nextQuota 在服务端没给额度时不会把 null 读成 0 条", () => {
  // describeFeedbackResult 在响应体里没有 remaining 时会回 remaining: null。
  // 旧写法 Number.isFinite(Number(null)) === true 把它当成 0，
  // 界面于是谎报「今天的反馈额度已用完」——用户明明刚发送成功。
  const prev = { remaining: 12, dailyLimit: 30 };
  const q = nextQuota(prev, null);
  assert.equal(q.remaining, 11, "没有回传额度时应当自减，而不是清零");
  assert.notEqual(q.remaining, 0);
});

test("nextQuota 只采信真正的数字", () => {
  assert.equal(nextQuota({ remaining: 5, dailyLimit: 30 }, 7).remaining, 7);
  assert.equal(nextQuota({ remaining: 5, dailyLimit: 30 }, "7").remaining, 7, "数字字符串可以接受");
  // 空字符串与 null 一样是「没给」，不是「零」。
  for (const missing of [null, undefined, "", "abc", NaN, Infinity, {}]) {
    const q = nextQuota({ remaining: 9, dailyLimit: 30 }, missing);
    assert.equal(q.remaining, 8, `${JSON.stringify(missing)} 应走自减分支，实际 ${q.remaining}`);
  }
});

test("nextQuota 没有旧额度时保持原样", () => {
  assert.equal(nextQuota(null, null), null);
  assert.equal(nextQuota({ offline: true }, null).offline, true);
});

test("describeFeedbackResult 与 fetchQuota 用的额度转换不把空串当 0", () => {
  // Worker 若回 {"remaining":""}，Number("") === 0 会让界面说「今天用完了」。
  const r = describeFeedbackResult({ status: 200, body: '{"ok":true,"remaining":""}' });
  assert.equal(r.remaining, null, "空串应当被当成「没给」，而不是 0");
  assert.equal(quotaCount(""), null);
  assert.equal(quotaCount(null), null);
  assert.equal(quotaCount("0"), 0, "真正的 0 要保留");
  assert.equal(quotaCount(0), 0);
});
