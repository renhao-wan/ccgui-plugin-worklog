import { test } from "node:test";
import assert from "node:assert/strict";
import { createFakeReact, textOf, byClass } from "../scripts/fake-react.mjs";
import { useFeedbackForm } from "../src/lib/feedback-ui.mjs";

const h = (type, props, ...children) => ({ type, props, children });

/**
 * 把 hook 套进一个组件里渲染，并把每次渲染的返回值记下来。
 * hook 只能在组件渲染期调用，所以测试也必须走「渲染一个组件」这条路，
 * 而不是直接调 useFeedbackForm —— 直接调拿不到重渲染后的新值。
 */
function setup(opts) {
  const R = createFakeReact();
  const seen = [];
  function Probe() {
    const form = useFeedbackForm(R.api, opts);
    seen.push(form);
    return h("div", null, form.sendLabel);
  }
  const run = (extra) => R.renderKeep(Probe, extra || {});
  // 首次挂载就带 effect：反馈区查额度是 useMemo 里的 effect，只在挂载时跑。
  // 这里不预先 renderKeep —— 多渲染一次会让「只查一次」的用例凭空多数一遍。
  R.renderFresh(Probe, {}, { effects: true });
  return {
    R,
    run,
    last: () => seen[seen.length - 1],
    first: () => seen[0],
  };
}

function baseOpts(over) {
  return Object.assign(
    {
      repo: "someone/demo-plugin",
      pluginName: "演示",
      pluginVersion: "1.2.3",
      hostVersion: "9.9.9",
      send: async () => ({ ok: true, kind: "sent", message: "反馈已发送，谢谢", remaining: 4 }),
      quota: async () => ({ remaining: 5, message: "今天还能发 5 条", canRetry: false }),
    },
    over,
  );
}

test("挂载时查一次额度，查到了就显示服务端给的真实值", async () => {
  let calls = 0;
  const t = setup(baseOpts({ quota: async () => { calls += 1; return { remaining: 5 }; } }));
  await new Promise((r) => setTimeout(r, 0));
  t.run();
  assert.equal(calls, 1, "只查一次");
  // 文案由 describeQuota 按 remaining 生成，服务端的 message 不参与。
  assert.equal(t.last().quotaText.message, "今天还可发 5 条反馈");
});

test("额度查不到时给 canRetry，重试会重新请求", async () => {
  let calls = 0;
  const t = setup(baseOpts({
    quota: async () => { calls += 1; return { remaining: null, message: "暂时连不上反馈服务", canRetry: true }; },
  }));
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(t.last().quotaText.canRetry, true);
  await t.last().retryQuota();
  assert.equal(calls, 2, "重试要再查一次");
});

test("不良额度（null）不会被读成 0 条", async () => {
  const t = setup(baseOpts({
    quota: async () => ({ remaining: null, message: "暂时连不上反馈服务", canRetry: true }),
  }));
  await new Promise((r) => setTimeout(r, 0));
  assert.doesNotMatch(t.last().quotaText.message, /已用完|0 条/, "null 不能谎报额度用完");
});

test("空正文不能发送；有正文才能发", async () => {
  const t = setup(baseOpts());
  assert.equal(t.last().canSend, false, "空正文时按钮不可点");
  t.last().setText("有个建议");
  t.run();
  assert.equal(t.last().canSend, true);
});

test("提交成功后：状态置 sent、正文清空、额度用服务端回传值", async () => {
  const t = setup(baseOpts());
  await new Promise((r) => setTimeout(r, 0));
  t.last().setText("有个建议");
  t.run();
  await t.last().submit();
  t.run();
  assert.equal(t.last().sendStatus, "sent");
  assert.equal(t.last().text, "", "成功后清空正文");
  assert.equal(t.last().sendLabel, "已发送", "回执落在按钮上");
  assert.equal(t.last().quota.remaining, 4, "额度用服务端回传的 4，不是自减的 4");
});

test("成功但中转没回传额度时，按旧值自减而不是读成 0 条", async () => {
  // 旧写法 `Number(r.remaining) || 0` 在缺少 remaining 时会得到 0，
  // 界面立刻谎报「今天的反馈额度已用完」。这里让成功响应不带 remaining。
  const t = setup(baseOpts({
    quota: async () => ({ remaining: 5 }),
    send: async () => ({ ok: true, kind: "sent", message: "反馈已发送，谢谢" }),
  }));
  await new Promise((r) => setTimeout(r, 0));
  t.run();
  t.last().setText("有个建议");
  t.run();
  await t.last().submit();
  t.run();
  assert.equal(t.last().quota.remaining, 4, "没有回传就自减一格，不能变 0");
  assert.doesNotMatch(t.last().quotaText.message, /已用完/, "不能谎报额度用完");
});

test("提交失败时保留正文，按钮回到「发送反馈」", async () => {
  const t = setup(baseOpts({
    send: async () => ({ ok: false, kind: "network", message: "连不上反馈服务", remaining: null }),
  }));
  await new Promise((r) => setTimeout(r, 0));
  t.last().setText("有个建议");
  t.run();
  await t.last().submit();
  t.run();
  assert.equal(t.last().text, "有个建议", "失败不能清空正文，免得用户重打");
  assert.equal(t.last().sendStatus, "error");
  assert.equal(t.last().sendLabel, "发送反馈");
  assert.equal(t.last().result.message, "连不上反馈服务");
});

test("发送期间继续打字，成功后新内容不被清掉", async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const t = setup(baseOpts({
    send: async () => { await gate; return { ok: true, kind: "sent", message: "已发送", remaining: 3 }; },
  }));
  await new Promise((r) => setTimeout(r, 0));
  t.last().setText("第一版");
  t.run();
  const pending = t.last().submit();
  // 请求还没回来，用户又敲了新内容
  t.last().setText("第一版，又补了一句");
  t.run();
  release();
  await pending;
  t.run();
  assert.equal(t.last().text, "第一版，又补了一句", "只清掉这次发出去的那段");
});

test("同一 tick 连点两次只发一条", async () => {
  let calls = 0;
  const t = setup(baseOpts({
    send: async () => { calls += 1; return { ok: true, kind: "sent", message: "已发送", remaining: 3 }; },
  }));
  await new Promise((r) => setTimeout(r, 0));
  t.last().setText("有个建议");
  t.run();
  const form = t.last();
  // 同一 tick：两次都读到同一份闭包值，只能靠同步的 ref 挡
  const a = form.submit();
  const b = form.submit();
  await Promise.all([a, b]);
  assert.equal(calls, 1, "第二次点击必须被挡住");
});

test("重新输入会撤掉上一条回执", async () => {
  const t = setup(baseOpts());
  await new Promise((r) => setTimeout(r, 0));
  t.last().setText("有个建议");
  t.run();
  await t.last().submit();
  t.run();
  assert.equal(t.last().statusText, "反馈已发送，谢谢");
  t.last().setText("另一条");
  t.run();
  assert.equal(t.last().statusText, "", "新输入等于开了一条新反馈");
  assert.equal(t.last().sendLabel, "发送反馈");
});

test("Issue 链接带预填正文，且不含本机信息", () => {
  const t = setup(baseOpts());
  t.last().setText("有个建议");
  t.run();
  const url = t.last().issueUrl;
  assert.match(url, /^https:\/\/github\.com\/someone\/demo-plugin\/issues\/new\?/);
  assert.match(url, /body=/, "正文要预填进去");
  assert.match(url, /1\.2\.3/, "带上插件版本");
  // 路径正则要避开 URL 自身的 https://：只认「盘符 + 反斜杠」或家目录。
  assert.doesNotMatch(url, /[A-Za-z]:\\|~\/\.claude|\/Users\/|\/home\//, "不能带本机路径");
});

test("提交中用 sending 状态，重试按钮此时不可点", async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const t = setup(baseOpts({
    send: async () => { await gate; return { ok: true, kind: "sent", message: "已发送", remaining: 3 }; },
  }));
  await new Promise((r) => setTimeout(r, 0));
  t.last().setText("有个建议");
  t.run();
  const pending = t.last().submit();
  t.run();
  assert.equal(t.last().sendStatus, "sending");
  assert.equal(t.last().sendLabel, "发送中…");
  assert.equal(t.last().canSend, false, "发送中不能重复点");
  release();
  await pending;
});

test("正文为空时 Issue 链接带弱化类，有正文时去掉", () => {
  const t = setup(baseOpts());
  const render = () => {
    const el = t.last().render(t.R.api.createElement, { prefix: "zz", classes: { muted: "zz-muted" } });
    return byClass(h("div", null, el), "zz-feedback-issue");
  };
  assert.match(String(render().props.className), /zz-muted/, "空正文时弱化");
  t.last().setText("有个建议");
  t.run();
  assert.doesNotMatch(String(render().props.className), /zz-muted/, "有正文时不弱化");
});

test("渲染出来的结构带统一类名，样式由各插件自己注入", () => {
  const t = setup(baseOpts());
  t.last().setText("有个建议");
  t.run();
  const el = t.last().render(t.R.api.createElement, { prefix: "zz", rows: 4 });
  const tree = h("div", null, el);
  assert.ok(byClass(tree, "zz-feedback-text"), "正文框类名前缀来自参数");
  assert.ok(byClass(tree, "zz-feedback-send"), "发送按钮类名前缀来自参数");
  assert.ok(byClass(tree, "zz-feedback-quota"), "额度行类名前缀来自参数");
  assert.match(textOf(tree), /通过 GitHub 提 Issue/);
  assert.match(textOf(tree), /1000/);
});
