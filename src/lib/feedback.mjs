/**
 * 反馈渠道的纯函数层：正文归一化、Issue 链接拼装、请求体收敛、响应文案。
 *
 * 全部离线可测。网络与 UI 在 main.head.js 里，这一层只回答「发什么」和
 * 「回什么」，方便把隐私边界钉死在测试里：请求体只允许五个字段。
 */

/** 正文上限。再长就不是一条反馈，而是一篇文档了。 */
export const TEXT_LIMIT = 1000;

/**
 * 收敛用户输入：去控制字符、统一换行、折叠连续空行与行尾空白、限长。
 * 保留大小写、中文、emoji 与**换行**——用户最常贴的就是报错日志，
 * 压成一行后堆栈就没法看了。
 *
 * @param {unknown} raw
 * @returns {string}
 */
export function normaliseFeedbackText(raw) {
  return String(raw === undefined || raw === null ? "" : raw)
    // 先统一换行，再剥控制字符（保留 \n）。制表符换成空格——堆栈缩进有用。
    .replace(/\r\n?/g, "\n")
    .replace(/\t/g, " ")
    .replace(/[\u0000-\u0009\u000b-\u001f\u007f�]/g, "")
    // 只去行尾空白与整段的首尾空白。**正文内行首缩进要留着**：
    // 报错堆栈靠它对齐，去掉后 `at fetchTrending` 就和日志正文混在一起了。
    .replace(/[ \t]+$/gm, "")
    .replace(/^[ \t]+/, "")
    // 三个以上连续换行压成两个（一段空行），既保留分段又不留大片空白。
    .replace(/\n{3,}/g, "\n\n")
    // 首尾空行去掉。
    .replace(/^\n+|\n+$/g, "")
    .slice(0, TEXT_LIMIT)
    .replace(/[ \t\n]+$/, "");
}

/**
 * GitHub 新建 Issue 的预填链接。
 *
 * 用预填而不是直接调 API：API 要 PAT，PAT 写进插件源码等于公开。预填链接
 * 只依赖用户浏览器里已有的登录态，插件一行网络代码都不用写。
 *
 * @param {{repo: string, pluginName: string, text: string, pluginVersion: string, hostVersion: string}} o
 * @returns {string}
 */
export function buildIssueUrl(o) {
  const text = normaliseFeedbackText(o.text);
  const body = [
    text || "_（请在这里描述问题或建议）_",
    "",
    "---",
    "插件：" + String(o.pluginName || "") + " " + String(o.pluginVersion || ""),
    "CC GUI：" + String(o.hostVersion || ""),
  ].join("\n");
  const q = new URLSearchParams({
    title: "[反馈] " + String(o.pluginName || ""),
    body,
  });
  return "https://github.com/" + String(o.repo || "") + "/issues/new?" + q.toString();
}

/** 请求体允许的字段。白名单而非黑名单：漏传字段比误传路径好。 */
const PAYLOAD_FIELDS = ["text", "pluginId", "pluginVersion", "hostVersion", "ts"];

/**
 * 组装发往中转的请求体，只保留白名单字段。
 *
 * @param {object} o
 * @returns {{text: string, pluginId: string, pluginVersion: string, hostVersion: string, ts: number}}
 */
export function buildFeedbackPayload(o) {
  const src = {
    text: normaliseFeedbackText(o.text),
    pluginId: String(o.pluginId || ""),
    pluginVersion: String(o.pluginVersion || ""),
    hostVersion: String(o.hostVersion || ""),
    ts: Number(o.now) || Date.now(),
  };
  const out = {};
  for (const k of PAYLOAD_FIELDS) out[k] = src[k];
  return out;
}

function parseJson(body) {
  if (typeof body !== "string" || !body) return null;
  try {
    const v = JSON.parse(body);
    return v && typeof v === "object" ? v : null;
  } catch {
    return null;
  }
}

/**
 * 把服务端给的额度字段收敛成 `number | null`。
 *
 * **别用 `Number.isFinite(Number(v))`**：`Number(null)` 与 `Number("")` 都是 0，
 * 于是「中转没带这个字段」会被读成「今天 0 条额度」，界面就对刚发送成功的
 * 用户说「今天的额度已用完」。这里只认真正的数字与非空数字字符串。
 *
 * @param {unknown} v
 * @returns {number|null}
 */
export function quotaCount(v) {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string") {
    if (!v.trim()) return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/**
 * 发送成功后更新界面上的剩余额度。
 *
 * 服务端回传的额度优先（顺手纠正「暂时连不上」）；没给就按本地旧值自减
 * 一条，旧值也没有就原样保留。纯函数，单测钉住「别把 null 读成 0」。
 *
 * @param {{remaining?: number, dailyLimit?: number, offline?: boolean}|null} prev
 * @param {unknown} fromServer 服务端回传的 remaining
 * @returns {object|null}
 */
export function nextQuota(prev, fromServer) {
  const n = quotaCount(fromServer);
  if (n !== null) {
    return { remaining: n, dailyLimit: (prev && prev.dailyLimit) || 30 };
  }
  const prevRemaining = prev && typeof prev.remaining === "number" ? prev.remaining : null;
  if (prevRemaining === null) return prev;
  return { remaining: Math.max(0, prevRemaining - 1), dailyLimit: prev.dailyLimit || 30 };
}

/**
 * 把一次中转响应翻译成界面文案。
 *
 * 一条原则：**永远给出「你还能做什么」**。反馈发不出去不是用户的错，
 * 所以每条失败文案都要么说清原因，要么指向还能走的路（GitHub Issue）。
 * 泛泛一句「发送失败」等于让用户卡死在这里。
 *
 * @param {{status?: number, body?: string, error?: Error}} r
 * @returns {{ok: boolean, kind: string, message: string, remaining: number|null}}
 */
export function describeFeedbackResult(r) {
  if (r && r.error) {
    const raw = String(r.error.message || r.error);
    if (/timed?\s*out|timeout|ETIMEDOUT/i.test(raw)) {
      return {
        ok: false,
        kind: "timeout",
        message: "发送超时。中转可能被网络挡住，可改用 GitHub Issue 反馈",
        remaining: null,
      };
    }
    if (/network:|permission|授权/i.test(raw)) {
      return { ok: false, kind: "denied", message: "网络权限未生效，请重新安装插件", remaining: null };
    }
    // DNS 污染、代理没开、防火墙——国内最常见的三种，用户能分不清，
    // 但「检查网络或代理」这句对他们是有用的动作。
    return {
      ok: false,
      kind: "network",
      message: "连不上反馈服务，请检查网络或代理，也可改用 GitHub Issue 反馈",
      remaining: null,
    };
  }

  const status = Number(r && r.status) || 0;
  const data = parseJson(r && r.body);
  const remaining = data ? quotaCount(data.remaining) : null;
  const code = data && typeof data.error === "string" ? data.error : "";

  if (status >= 200 && status < 300) {
    // 成功响应必须带 ok:true。只看状态码会把运营商劫持页、登录门户、
    // 代理错误页（都会返回 200）当成「已发送」——用户以为发出去了，
    // 实际什么都没有。
    if (!data || data.ok !== true) {
      return {
        ok: false,
        kind: "garbled",
        message: "反馈服务返回了无法识别的内容，可能被网络拦截，可改用 GitHub Issue 反馈",
        remaining: null,
      };
    }
    return { ok: true, kind: "sent", message: "反馈已发送，谢谢", remaining };
  }

  if (status === 429) {
    // kind 是 Worker 给的：burst = 10 分钟窗口撞了，daily = 今天真没了。
    // 分不清就按 daily 说——让人等十分钟比让人白等一天更糟。
    const burst = data && data.kind === "burst";
    return {
      ok: false,
      kind: "rate_limited",
      message: burst
        ? "发得太快了，稍等几分钟再试，或改用 GitHub Issue 反馈"
        : "今天的反馈额度已用完，明天再来，或改用 GitHub Issue 反馈",
      // burst 时今天还有额度，写死 0 会让界面谎报「今天用完了」。
      remaining: burst ? remaining : 0,
    };
  }

  if (status === 413) {
    return { ok: false, kind: "invalid", message: "反馈内容太长了，请缩短后重试", remaining };
  }

  if (status === 400) {
    // 400 的几种原因要分开说：empty_text 是用户没写，unknown_plugin 是
    // 版本错位，叫用户去「缩短内容」是把他引到错的方向。
    if (code === "unknown_plugin") {
      return {
        ok: false,
        kind: "invalid",
        message: "中转不认识这个插件版本，请更新插件，或改用 GitHub Issue 反馈",
        remaining,
      };
    }
    if (code === "empty_text") {
      return { ok: false, kind: "invalid", message: "反馈内容是空的，写点内容再发", remaining };
    }
    return { ok: false, kind: "invalid", message: "反馈内容不合要求，请缩短后重试", remaining };
  }

  if (status === 502 || status === 503 || status === 500) {
    return {
      ok: false,
      kind: "http",
      // 502 = 发不出邮件、503 = KV 不可用、500 = 中转内部错误。
      // 三种都是中转那边的事，用户唯一能做的是稍后再试或换 Issue。
      message: "中转暂时不可用，稍后再试，或改用 GitHub Issue 反馈",
      remaining,
    };
  }

  if (status === 0) {
    // 请求根本没拿到响应：和网络错误一样处理，别把 "HTTP 0" 甩给用户。
    return {
      ok: false,
      kind: "network",
      message: "连不上反馈服务，请检查网络或代理，也可改用 GitHub Issue 反馈",
      remaining: null,
    };
  }

  return {
    ok: false,
    kind: "http",
    message: "发送失败（HTTP " + status + "），可改用 GitHub Issue 反馈",
    remaining,
  };
}

/**
 * 额度提示文案。查不到额度时也要给一句话，不能空着。
 *
 * 两种「查不到」要分开：
 *   - `{offline: true}`：请求失败（网络/代理/中转挂了）。说「额度有限」
 *     会把网络故障说成用户在刷屏，把他引到错误的方向。
 *   - 其他：服务端回了但字段脏，或压根没查。这时该提醒别刷屏。
 *
 * @param {{remaining?: number, dailyLimit?: number, offline?: boolean}|null} quota
 * @returns {{remaining: number|null, message: string}}
 */
export function describeQuota(quota) {
  if (quota && quota.offline) {
    return { remaining: null, message: "暂时连不上反馈服务，发送时再试", canRetry: true };
  }
  // Number(null) === 0、Number("") === 0：不显式挡掉，脏数据会被读成「0 条」，
  // 界面就说「今天的额度已用完」。先用「是不是数字」把它挡在这一层。
  const raw = quota ? quota.remaining : undefined;
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    return { remaining: null, message: "额度有限，请勿刷屏", canRetry: true };
  }
  const remaining = Math.max(0, raw);
  if (remaining === 0) {
    return { remaining: 0, message: "今天的反馈额度已用完，明天再来", canRetry: true };
  }
  return { remaining, message: "今天还可发 " + remaining + " 条反馈", canRetry: false };
}
