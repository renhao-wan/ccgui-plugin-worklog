/**
 * 解读正文用的 Markdown 子集解析。纯函数，输出的是「节点描述」而不是
 * HTML —— 渲染端自己把它们变成元素，避免把模型的输出当 HTML 执行。
 *
 * 覆盖模型最常写的那几种：标题、段落、有序/无序列表（含缩进层级）、
 * GFM 表格、代码块、行内代码、粗体、斜体、删除线、链接、引用、分隔线。
 *
 * 流式输入的容错是硬要求：解读是一个字一个字推过来的，任何时刻都可能停在
 * `**粗`、`| a | b`（分隔行还没来）、``` 未闭合这种半截状态。所以：
 * - 未闭合的行内标记按原文输出，不吞字符；
 * - 未闭合的代码块一直吃到末尾；
 * - 没有分隔行的表格行当普通段落。
 */

/** 行内标记。顺序即优先级：`**` 必须先于 `*`，否则粗体会被切成两个斜体。
 * 这里存的是不带 g 的「模板」：带 g 的正则 lastIndex 是实例状态，而 parseInline
 * 会递归，内层一重置就会把外层循环卡在原地。每次调用自己造实例。 */
const INLINE_RE = /(\*\*[^*\n]+\*\*|__[^_\n]+__|`[^`\n]+`|~~[^~\n]+~~|\[[^\]\n]+\]\([^)\s]+\)|\*[^*\n]+\*)/;

/** 链接只放行 http(s)。其他协议（javascript:、file:）一律降级成文字。
 * 名字带 md 前缀：这个文件会被内联进 main.js 顶层作用域，和插件里的
 * safeHref（给仓库链接用）重名就会直接语法错误。 */
function safeMdHref(href) {
  return /^https?:\/\//i.test(href) ? href : "";
}

/**
 * 把一行切成行内节点。
 *
 * 强调类标记（strong/em/del）的内容会递归解析：模型很爱写
 * `**\`owner/repo\`**` 这种「粗体包代码」，不递归的话反引号会原样显示出来。
 * 强调标记本身不嵌套（`*a **b** c*` 会先命中内层的 `**b**`），这是有意的
 * 简化：解读正文里几乎不会出现，换来的是流式输入下不会卡死。递归只往
 * 「非强调」的行内标记里走，层数限死 2 层。
 *
 * 正则每次调用都要新造实例：带 g 的正则 lastIndex 是实例状态，递归共用一个
 * 就会被内层重置，外层 exec 原地打转。
 *
 * @param {string} text
 * @param {number} [depth]
 * @returns {Array<{t: string, v: string, href?: string, children?: Array<object>}>}
 */
export function parseInline(text, depth = 0) {
  const src = String(text == null ? "" : text);
  const out = [];
  let last = 0;
  let m;
  // 递归解析强调内容时不能和外层共用同一个带 g 的正则实例。
  const re = new RegExp(INLINE_RE.source, "g");
  while ((m = re.exec(src))) {
    if (m.index > last) out.push({ t: "text", v: src.slice(last, m.index) });
    const tok = m[0];
    const wrap = (t) => {
      const inner = tok.slice(t === "em" ? 1 : 2, t === "em" ? -1 : -2);
      const node = { t: t, v: inner };
      if (depth < 2) node.children = parseInline(inner, depth + 1);
      return node;
    };
    if (tok.startsWith("**")) {
      out.push(wrap("strong"));
    } else if (tok.startsWith("__")) {
      out.push(wrap("strong"));
    } else if (tok.startsWith("`")) {
      out.push({ t: "code", v: tok.slice(1, -1) });
    } else if (tok.startsWith("~~")) {
      out.push(wrap("del"));
    } else if (tok.startsWith("[")) {
      const link = /^\[([^\]\n]+)\]\(([^)\s]+)\)$/.exec(tok);
      const href = link ? safeMdHref(link[2]) : "";
      if (link && href) out.push({ t: "link", v: link[1], href: href });
      else out.push({ t: "text", v: tok });
    } else {
      out.push(wrap("em"));
    }
    last = m.index + tok.length;
  }
  if (last < src.length) out.push({ t: "text", v: src.slice(last) });
  return out;
}

/* ---- 表格与列表的识别 ---- */

const FENCE_RE = /^\s*(```|~~~)\s*([^\s`]*)\s*$/;
const HEADING_RE = /^\s{0,3}(#{1,6})\s+(.*)$/;
const HR_RE = /^\s{0,3}(?:-{3,}|\*{3,}|_{3,})\s*$/;
const QUOTE_RE = /^\s{0,3}>\s?(.*)$/;
const UL_RE = /^(\s*)[-*+]\s+(.*)$/;
const OL_RE = /^(\s*)\d+[.)]\s+(.*)$/;
const TABLE_DIV_RE = /^\s*\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)*\|?\s*$/;

function hasPipe(line) {
  return String(line || "").indexOf("|") >= 0;
}

/** 表头行 + `|---|` 分隔行；只有表头行时不算表格。 */
function isTableStart(lines, i) {
  return i + 1 < lines.length && hasPipe(lines[i]) && hasPipe(lines[i + 1]) && TABLE_DIV_RE.test(lines[i + 1]);
}

function splitRow(raw) {
  let s = String(raw || "").trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|")) s = s.slice(0, -1);
  // 手写扫描而不是 split(/(?<!\\)\|/)：lookbehind 在老版本 Chromium 上不支持，
  // 宿主的内置内核版本不在我们控制范围内。`\|` 是单元格内的转义竖线。
  const cells = [];
  let buf = "";
  for (let i = 0; i < s.length; i += 1) {
    const ch = s[i];
    if (ch === "\\" && s[i + 1] === "|") {
      buf += "|";
      i += 1;
      continue;
    }
    if (ch === "|") {
      cells.push(buf.trim());
      buf = "";
      continue;
    }
    buf += ch;
  }
  cells.push(buf.trim());
  return cells;
}

function cellAlign(spec) {
  const s = String(spec || "").trim();
  const left = s.startsWith(":");
  const right = s.endsWith(":");
  if (left && right) return "center";
  if (right) return "right";
  if (left) return "left";
  return "";
}

/** 缩进换算成层级：两个空格或一个 Tab 算一级，最多 4 级（再深也没人看）。 */
function depthOf(indent) {
  const expanded = String(indent || "").replace(/\t/g, "  ").length;
  return Math.min(4, Math.floor(expanded / 2));
}

/** 块级元素是否从这里开始；段落收集到这些行就停。 */
function startsBlock(lines, i) {
  const line = lines[i];
  return (
    FENCE_RE.test(line) ||
    HEADING_RE.test(line) ||
    HR_RE.test(line) ||
    QUOTE_RE.test(line) ||
    UL_RE.test(line) ||
    OL_RE.test(line) ||
    isTableStart(lines, i)
  );
}

/**
 * @param {string} text 模型输出的 Markdown
 * @returns {Array<object>} 块节点数组，结构见文件头注释
 */
export function parseMarkdown(text) {
  const lines = String(text == null ? "" : text).replace(/\r\n?/g, "\n").split("\n");
  const out = [];
  let i = 0;
  let list = null;

  const flushList = () => {
    if (!list) return;
    out.push(list);
    list = null;
  };

  while (i < lines.length) {
    const line = lines[i];

    const fence = FENCE_RE.exec(line);
    if (fence) {
      flushList();
      const marker = fence[1];
      const lang = fence[2] || "";
      const buf = [];
      i += 1;
      // 闭合行只要以同样的围栏开头即可（```js 和 ``` 都算）
      while (i < lines.length && lines[i].trim().indexOf(marker) !== 0) {
        buf.push(lines[i]);
        i += 1;
      }
      // 未闭合时（流式中途）i 会停在末尾，代码原样输出，不丢内容
      if (i < lines.length) i += 1;
      out.push({ type: "code", lang: lang, text: buf.join("\n") });
      continue;
    }

    if (isTableStart(lines, i)) {
      flushList();
      const head = splitRow(line).map(parseInline);
      const align = splitRow(lines[i + 1]).map(cellAlign);
      i += 2;
      const rows = [];
      while (i < lines.length && lines[i].trim() && hasPipe(lines[i]) && !startsBlock(lines, i)) {
        const cells = splitRow(lines[i]);
        // 列数按表头补齐/截断：模型偶尔少写一格，不能让整行错位
        const row = [];
        for (let c = 0; c < head.length; c += 1) row.push(parseInline(cells[c] == null ? "" : cells[c]));
        rows.push(row);
        i += 1;
      }
      out.push({ type: "table", align: align, head: head, rows: rows });
      continue;
    }

    const heading = HEADING_RE.exec(line);
    if (heading) {
      flushList();
      out.push({ type: "heading", level: Math.min(6, heading[1].length), inlines: parseInline(heading[2]) });
      i += 1;
      continue;
    }

    if (HR_RE.test(line)) {
      flushList();
      out.push({ type: "hr" });
      i += 1;
      continue;
    }

    if (QUOTE_RE.test(line)) {
      flushList();
      const buf = [];
      while (i < lines.length) {
        const q = QUOTE_RE.exec(lines[i]);
        if (!q) break;
        buf.push(q[1]);
        i += 1;
      }
      out.push({ type: "quote", inlines: parseInline(buf.join(" ")) });
      continue;
    }

    const ul = UL_RE.exec(line);
    const ol = OL_RE.exec(line);
    if (ul || ol) {
      const type = ul ? "ul" : "ol";
      // 有序/无序切换或缩进回退都要重开一个列表：混在一个 <ul> 里会全变成圆点
      if (!list || list.type !== type || list.depth !== depthOf((ul || ol)[1])) {
        flushList();
        list = { type: type, depth: depthOf((ul || ol)[1]), items: [] };
      }
      list.items.push({ inlines: parseInline((ul || ol)[2]), depth: depthOf((ul || ol)[1]) });
      i += 1;
      continue;
    }

    if (!line.trim()) {
      flushList();
      i += 1;
      continue;
    }

    flushList();
    const buf = [line];
    i += 1;
    while (i < lines.length && lines[i].trim() && !startsBlock(lines, i)) {
      buf.push(lines[i]);
      i += 1;
    }
    out.push({ type: "paragraph", inlines: parseInline(buf.join(" ")) });
  }

  flushList();
  return out;
}
