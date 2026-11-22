/**
 * 反馈渠道的网络层：`send` 发一条反馈，`quota` 查今天还剩几条。
 *
 * 用工厂而不是两个裸函数，是为了让「插件身份」只能从一处来：`pluginId`
 * 同时决定请求体里的 pluginId 和 User-Agent 前缀，不可能出现「体里是 A、
 * UA 里是 B」的错位。宿主版本也只在这里读一次。
 *
 * 这一层只做「发什么、怎么发、回什么」的搬运；文案全部交给
 * describeFeedbackResult / describeQuota，隐私边界由 buildFeedbackPayload
 * 的白名单钉住。
 */

/**
 * 给 promise 加超时。超时抛 `Error("<label> timeout")`，
 * describeFeedbackResult 靠这个字符串识别超时。
 *
 * 名字带 `fbNet` 前缀：库文件会和 main.head.js 拼进同一作用域，
 * 那边已经有一个给工作区登记与解读用的顶层 withTimeout，重名不是覆盖
 * 而是整个模块语法错误（build.mjs 的顶层重名自检会直接拦住）。
 *
 * @template T
 * @param {Promise<T>} promise
 * @param {number} ms
 * @param {string} label
 * @returns {Promise<T>}
 */
function fbNetTimeout(promise, ms, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(label + " timeout")), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/**
 * 宿主版本。老版本宿主可能没有这一项，取不到就留空——不能因此发不出反馈。
 *
 * @param {object} ctx
 * @returns {string}
 */
function fbNetHostVersion(ctx) {
  try {
    return ctx && ctx.host && typeof ctx.host.appVersion === "string" ? ctx.host.appVersion : "";
  } catch {
    return "";
  }
}

/**
 * 建一整套反馈网络调用。
 *
 * @param {object} ctx 插件上下文（要用 ctx.bridge / ctx.version / ctx.host）
 * @param {{endpoint: string, pluginId: string, timeoutMs?: number}} opts
 *   endpoint 必须与 manifest 的 `network:<host>` 一致，否则宿主会拒。
 * @returns {{send: (text: string) => Promise<object>, quota: () => Promise<object|null>}}
 */
export function createFeedbackNet(ctx, opts) {
  const endpoint = String(opts.endpoint || "").replace(/\/+$/, "");
  const pluginId = String(opts.pluginId || "");
  const timeoutMs = Number(opts.timeoutMs) || 15000;
  const userAgent = () => "ccgui-" + pluginId + "/" + ctx.version;

  /**
   * 发一条反馈。返回值就是 describeFeedbackResult 的结果，界面直接渲染。
   *
   * 不做连接层重试：反馈是 POST，重试会把同一条内容发两遍——用户看到
   * 「发送失败」再点一次，比静默重复更可控。
   *
   * @param {string} text
   * @returns {Promise<object>}
   */
  async function send(text) {
    const payload = buildFeedbackPayload({
      text,
      pluginId,
      pluginVersion: ctx.version,
      hostVersion: fbNetHostVersion(ctx),
    });
    try {
      const res = await fbNetTimeout(
        ctx.bridge.invoke("plugin_http_request", {
          method: "POST",
          url: endpoint + "/feedback",
          headers: { "Content-Type": "application/json", "User-Agent": userAgent() },
          body: JSON.stringify(payload),
        }),
        timeoutMs,
        "feedback",
      );
      return describeFeedbackResult({ status: Number(res && res.status) || 0, body: res && res.body });
    } catch (error) {
      return describeFeedbackResult({ error });
    }
  }

  /**
   * 查今天的剩余额度。失败时返回 `{offline: true}`——额度查不到不能挡住
   * 发反馈，但要让界面知道「是连不上」而不是「额度紧张」，两句话说给用户
   * 听的意思完全不同。
   *
   * @returns {Promise<{remaining: number, dailyLimit: number}|{offline: true}|null>}
   */
  async function quota() {
    try {
      const res = await fbNetTimeout(
        ctx.bridge.invoke("plugin_http_request", {
          method: "GET",
          url: endpoint + "/quota",
          headers: { "User-Agent": userAgent() },
          body: null,
        }),
        timeoutMs,
        "quota",
      );
      const status = Number(res && res.status) || 0;
      if (!(status >= 200 && status < 300)) return { offline: true };
      const body = res && typeof res.body === "string" ? res.body : "";
      // 劫持页、登录门户都返回 200 + HTML：JSON.parse 会抛，被外层 catch 接住，
      // 与「请求失败」同样按连不上处理——不需要单独再判一次。
      const data = body ? JSON.parse(body) : null;
      // 用 quotaCount 而不是 Number.isFinite(Number(...))：后者把 null/"" 读成 0，
      // 界面会说「今天的额度已用完」。
      const remaining = data ? quotaCount(data.remaining) : null;
      return remaining === null ? null : { remaining, dailyLimit: Number(data.dailyLimit) || 30 };
    } catch {
      return { offline: true };
    }
  }

  return { send, quota };
}
