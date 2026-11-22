/**
 * 反馈区的行为层：状态、提交、额度、Issue 链接全在这里，四个插件共用。
 *
 * 为什么分成「行为 + 渲染」两步而不是一个组件：
 * - 每日热点 / 工作志 / 斜杠面板有 CSS 文件，类名各有前缀（gt- / wl- / sp-）；
 * - CLI 安装检测整套 UI 用内联 style，根本没有 CSS 文件。
 *
 * 所以这里只输出「长得一样」的元素树，类名与样式类由调用方传进来；
 * 内联 style 的那个插件可以只用 useFeedbackForm、自己写渲染。
 *
 * 逻辑部分原本在四个插件里各抄一份，而重复的恰好是最容易写错的那几段：
 * sendingRef 挡双击、成功后只清「这次发出去的那段」、额度不能被 null 读成 0。
 * 这些行为现在由 test/feedback-ui.test.mjs 逐个钉住。
 *
 * 依赖 feedback.mjs 的纯函数。内联进 main.js 后两者在同一作用域；
 * 单测里通过这条 import 直接解析。build.mjs 会剥掉这行 import。
 */

import {
  TEXT_LIMIT,
  normaliseFeedbackText,
  buildIssueUrl,
  describeQuota,
  nextQuota,
} from "./feedback.mjs";

/**
 * 反馈区的状态与动作。
 *
 * @param {{useState: Function, useRef: Function, useEffect: Function}} R React 子系统
 *   （插件里是 ctx.react，测试里是假 React 的 api）。
 * @param {object} opts
 * @param {string} opts.repo           Issue 落到哪个仓库（owner/name）。
 * @param {string} opts.pluginName     Issue 标题里的插件中文名。
 * @param {string} opts.pluginVersion  写进请求体与 Issue 的插件版本。
 * @param {string} [opts.hostVersion]  CC GUI 版本，取不到就留空。
 * @param {(text: string) => Promise<object>} opts.send
 * @param {() => Promise<object|null>} opts.quota
 * @returns {object} 状态 + 动作 + `render(h, styleOpts)`
 */
export function useFeedbackForm(R, opts) {
  const textState = R.useState("");
  const text = textState[0];
  const setText = textState[1];
  // "" -> "sending" -> "sent"/"error"
  const sendState = R.useState("");
  const sendStatus = sendState[0];
  const setSendStatus = sendState[1];
  const resultState = R.useState(null);
  const result = resultState[0];
  const setResult = resultState[1];
  const quotaState = R.useState(null);
  const quota = quotaState[0];
  const setQuota = quotaState[1];
  // 「只在挂载时查一次额度」的标志。用 ref 而不是 state：它只在 effect
  // 里读写，不该触发重渲染。
  const quotaTried = R.useRef(false);
  // 同步的在途标志。canSend 是渲染时的闭包值，同一 tick 内两次触发都会
  // 读到旧的 sendStatus=""，只在状态里防不住双击。
  const sendingRef = R.useRef(false);

  // 查不到就保持 {canRetry:true}，UI 说明是「连不上」而不是「额度紧张」
  // ——两句话对用户的意思完全不同。
  async function loadQuota() {
    const q = await opts.quota();
    setQuota(q);
    return q;
  }

  R.useEffect(() => {
    if (quotaTried.current) return;
    quotaTried.current = true;
    void loadQuota();
    // 只在挂载时查一次；之后由「重试」按钮或发送结果更新。
  }, []);

  const trimmed = normaliseFeedbackText(text);
  const canSend = trimmed.length > 0 && sendStatus !== "sending";

  const issueUrl = buildIssueUrl({
    repo: opts.repo,
    pluginName: opts.pluginName,
    text: trimmed,
    pluginVersion: opts.pluginVersion,
    hostVersion: opts.hostVersion || "",
  });

  async function submit() {
    // sendingRef 是同步的：同一 tick 内两次触发都会读到 true，挡住双击。
    // sendStatus 要等重渲染才更新，靠它挡不住。
    if (!canSend || sendingRef.current) return;
    sendingRef.current = true;
    const submitted = trimmed;
    setSendStatus("sending");
    setResult(null);

    let r;
    try {
      r = await opts.send(submitted);
    } finally {
      sendingRef.current = false;
    }

    setSendStatus(r.ok ? "sent" : "error");
    setResult(r);
    // 失败时正文原样留着：用户重打一遍比什么都糟。
    if (!r.ok) return;

    // 只清掉「这次发出去的那段」。发送期间用户可能又敲了内容（那几个请求
    // 往返里 textarea 没禁用），直接清空会把他新写的也抹掉。
    setText((cur) => (cur === submitted ? "" : cur));

    // 额度优先用服务端回传的真实值。查额度时失败了也不要紧——成功响应里
    // 带了 remaining，正好顺手把「暂时连不上」纠正过来。没有回传就自减一格。
    setQuota((prev) => nextQuota(prev, r.remaining));
  }

  /** 正文变化。重新输入等于开了一条新反馈，上一条的回执（成功或失败）都该撤掉。 */
  function changeText(value) {
    setText(value);
    if (sendStatus !== "sending") {
      setSendStatus("");
      setResult(null);
    }
  }

  const quotaText = describeQuota(quota);
  const statusText =
    sendStatus === "sending" ? "发送中…" : result ? result.message : "";
  // 成功时正文被清空，按钮会变成不可点的死按钮。若文案还停在「发送反馈」，
  // 用户看到的就是「点了没反应」——回执必须落在按钮自己身上。
  const sendLabel =
    sendStatus === "sending" ? "发送中…" : sendStatus === "sent" ? "已发送" : "发送反馈";

  /**
   * 渲染成元素树。
   *
   * @param {Function} h createElement
   * @param {object} [style]
   * @param {string} [style.prefix]      类名前缀，如 "gt"；产出 `${prefix}-feedback-*`
   * @param {number} [style.rows]        正文框行数
   * @param {string} [style.variant]     "section"（带 section 外壳）或 "bare"
   * @param {object} [style.classes]     各插件的样式类：input / primaryBtn /
   *   secondaryBtn / hint / note / linkBtn。缺省为空。
   */
  function render(h, style) {
    const s = style || {};
    const prefix = s.prefix || "fb";
    const rows = s.rows || 5;
    const c = s.classes || {};
    // 统一样式钩子（行为稳定、可被任何插件套）与各插件自己的样式类
    // （决定长什么样）拼在一起。两者都要，缺了哪一半都不行。
    const cls = (name, extra) => {
      const own = prefix + "-feedback-" + name;
      return extra ? own + " " + extra : own;
    };
    const join = (a, b) => (a && b ? a + " " + b : a || b || "");

    const head =
      s.variant === "section"
        ? h(
            "div",
            { className: prefix + "-section-label" },
            h("h2", null, "反馈"),
            h("p", null, "遇到问题或想提建议，两种方式任选其一。"),
          )
        : null;

    const body = [
      h("textarea", {
        className: cls("text", c.input),
        value: text,
        rows: rows,
        maxLength: TEXT_LIMIT,
        placeholder: "描述问题或建议…（最多 " + TEXT_LIMIT + " 字）",
        spellCheck: false,
        "aria-label": "反馈正文",
        onChange: (e) => changeText(e.target.value),
      }),
      h(
        "div",
        { className: cls("row") },
        h("span", { className: cls("count", c.hint) }, text.length + " / " + TEXT_LIMIT),
        h(
          "span",
          { className: cls("quota", c.hint) },
          quotaText.message,
          // 额度查不到 / 用完了都给一条重试路径，否则用户只能重开设置页。
          quotaText.canRetry
            ? h(
                "button",
                {
                  type: "button",
                  className: cls("quota-retry", c.linkBtn),
                  disabled: sendStatus === "sending",
                  onClick: () => void loadQuota(),
                },
                "重试",
              )
            : null,
        ),
      ),
      h(
        "div",
        { className: cls("actions") },
        h(
          "a",
          {
            className: join(
              cls("issue", c.secondaryBtn),
              // 正文为空时 Issue 链接仍可点，但看起来不该和「能发」时一样重。
              // 判断口径必须与 canSend 一致，所以这里用同一个 trimmed，
              // 不能让调用方自己再算一遍（那样两边迟早漂开）。
              trimmed ? "" : c.muted || "",
            ),
            href: issueUrl,
            target: "_blank",
            rel: "noreferrer noopener",
            title: "在浏览器里打开预填好的 Issue 页面",
          },
          "通过 GitHub 提 Issue",
        ),
        h(
          "button",
          {
            type: "button",
            className: cls("send", c.primaryBtn) + (sendStatus === "sent" ? " " + cls("sent") : ""),
            disabled: !canSend,
            onClick: () => void submit(),
          },
          sendLabel,
        ),
      ),
      statusText
        ? h(
            "p",
            {
              className:
                cls("status", c.note) +
                (sendStatus === "sent" ? " is-ok" : "") +
                (sendStatus === "error" ? " is-bad" : ""),
              role: "status",
              "aria-live": "polite",
            },
            statusText,
          )
        : null,
      h(
        "p",
        { className: c.hint || "" },
        "发送的内容只有这段文字、插件版本与 CC GUI 版本。不含会话、代码或本机路径。",
      ),
    ].filter(Boolean);

    if (s.variant === "section") {
      return h(
        "section",
        { className: prefix + "-section" },
        head,
        h("div", { className: prefix + "-section-panel" }, body),
      );
    }
    return h("div", { className: prefix + "-feedback" }, body);
  }

  return {
    text,
    setText: changeText,
    sendStatus,
    result,
    quota,
    quotaText,
    canSend,
    submit,
    retryQuota: loadQuota,
    issueUrl,
    statusText,
    sendLabel,
    render,
  };
}
