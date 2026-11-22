/**
 * 把 markdown.mjs 的块节点渲染成元素。
 *
 * 解析与渲染分开的理由：worklog 与 github-trending 共用解析器，但渲染出来
 * 的类名与可交互节点不同——worklog 要把会话短 ID 变成可点的按钮，trending
 * 不需要。所以解析层是纯函数，渲染层接一个 `extraInline` 钩子。
 *
 * 全程不拼 HTML 字符串：模型输出属于不可信内容，只当文本处理。
 */

import { parseMarkdown } from "./markdown.mjs";

/**
 * 解析结果缓存。流式输出时每个 delta 都会重渲染整棵报告树，而解析要扫全文；
 * 内容没变（别处 set 触发的重渲染）就不该再解析一遍。
 */
const mdCache = new Map();
const MD_CACHE_LIMIT = 4;

/**
 * @param {string} text
 * @returns {Array<object>} 块节点；相同输入返回同一个数组引用
 */
export function markdownBlocks(text) {
  const src = String(text || "");
  const hit = mdCache.get(src);
  if (hit) {
    // 命中后挪到队尾：Map 保持插入序，删第一个就是删最久没用的。
    mdCache.delete(src);
    mdCache.set(src, hit);
    return hit;
  }
  const blocks = parseMarkdown(src);
  mdCache.set(src, blocks);
  while (mdCache.size > MD_CACHE_LIMIT) mdCache.delete(mdCache.keys().next().value);
  return blocks;
}

/**
 * 行内节点 → 元素。
 *
 * @param {Function} h createElement
 * @param {Array<object>} inlines parseMarkdown 产出的行内节点
 * @param {string} keyBase
 * @param {string} codeClass 行内代码的类名（各插件前缀不同）
 * @param {(text: string, keyBase: string, h: Function) => Array|null} [textHook]
 *   纯文本节点的改写机会。返回数组就用它（可以拆成多个节点），返回 null
 *   就按普通文字输出。worklog 用它把会话短 ID 变成可点按钮。
 */
export function inlineNodes(h, inlines, keyBase, codeClass, textHook) {
  return (inlines || []).map((n, i) => {
    const key = keyBase + "i" + i;
    if (n.children) {
      return h(n.t === "strong" ? "strong" : n.t === "em" ? "em" : "del", { key },
        inlineNodes(h, n.children, key + "_", codeClass, textHook));
    }
    if (n.t === "text" && typeof textHook === "function") {
      const got = textHook(n.v, key, h);
      if (got) return got;
    }
    if (n.t === "strong") return h("strong", { key }, n.v);
    if (n.t === "em") return h("em", { key }, n.v);
    if (n.t === "del") return h("del", { key }, n.v);
    if (n.t === "code") return h("code", { key, className: codeClass || "" }, n.v);
    if (n.t === "link") {
      return h("a", { key, href: n.href, target: "_blank", rel: "noreferrer noopener" }, n.v);
    }
    return n.v;
  });
}

/**
 * 渲染整份 Markdown。
 *
 * @param {Function} h createElement
 * @param {string} text
 * @param {object} [opts]
 * @param {string} [opts.prefix] 类名前缀，如 "wl"；产出 `${prefix}-md-*`
 * @param {(text: string, keyBase: string, h: Function) => Array|null} [opts.extraInline]
 *   纯文本节点的改写钩子。返回数组就用它（可以拆成多个节点），返回 null
 *   就走默认输出。worklog 用它把会话短 ID 变成可点按钮。
 * @returns {Array|null} 元素数组
 */
export function renderMarkdown(h, text, opts) {
  const o = opts || {};
  const prefix = o.prefix || "md";
  const codeClass = prefix + "-md-code";
  const blocks = markdownBlocks(text);
  const inline = (inlines, keyBase) =>
    inlineNodes(h, inlines, keyBase, codeClass, o.extraInline);

  return blocks.map((b, i) => {
    const key = prefix + "md" + i;
    if (b.type === "heading") {
      return h("h" + b.level, { key, className: prefix + "-md-h" + b.level }, inline(b.inlines, key));
    }
    if (b.type === "paragraph") {
      return h("p", { key, className: prefix + "-md-p" }, inline(b.inlines, key));
    }
    if (b.type === "hr") return h("hr", { key, className: prefix + "-md-hr" });
    if (b.type === "quote") {
      return h("blockquote", { key, className: prefix + "-md-quote" }, inline(b.inlines, key));
    }
    if (b.type === "code") {
      return h(
        "pre",
        { key, className: prefix + "-md-pre" },
        h("code", { className: b.lang ? "language-" + b.lang : "" }, b.text),
      );
    }
    if (b.type === "ul" || b.type === "ol") {
      return h(
        b.type,
        {
          key,
          className: prefix + "-md-list",
          // 解析器在缩进变化时重开一个列表（混在一个 <ul> 里会全变圆点），
          // 所以层级信息落在块本身的 depth 上，渲染时按它缩进。
          style: b.depth ? { marginLeft: b.depth * 14 } : undefined,
        },
        b.items.map((item, j) =>
          h(
            "li",
            { key: key + "li" + j },
            inline(item.inlines, key + "li" + j),
          ),
        ),
      );
    }
    if (b.type === "table") {
      const cellStyle = (ci) => (b.align[ci] ? { textAlign: b.align[ci] } : undefined);
      return h(
        "div",
        { key, className: prefix + "-md-table-wrap" },
        h(
          "table",
          { className: prefix + "-md-table" },
          h(
            "thead",
            null,
            h(
              "tr",
              null,
              b.head.map((cell, ci) =>
                h("th", { key: key + "th" + ci, style: cellStyle(ci) }, inline(cell, key + "th" + ci)),
              ),
            ),
          ),
          h(
            "tbody",
            null,
            b.rows.map((row, ri) =>
              h(
                "tr",
                { key: key + "tr" + ri },
                row.map((cell, ci) =>
                  h(
                    "td",
                    { key: key + "td" + ci, style: cellStyle(ci) },
                    inline(cell, key + "td" + ri + "_" + ci),
                  ),
                ),
              ),
            ),
          ),
        ),
      );
    }
    return null;
  });
}
