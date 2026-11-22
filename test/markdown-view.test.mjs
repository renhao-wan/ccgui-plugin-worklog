import { test } from "node:test";
import assert from "node:assert/strict";
import { createFakeReact, byClass, findAll, textOf, walk } from "../scripts/fake-react.mjs";
import { markdownBlocks, renderMarkdown } from "../src/lib/markdown-view.mjs";

const h = (type, props, ...children) => ({ type, props, children });

function render(text, opts) {
  const R = createFakeReact();
  // 类名前缀跟真实调用一致（worklog 用 wl），否则断言查的是别的类名。
  const nodes = renderMarkdown(R.api.createElement, text, Object.assign({ prefix: "wl" }, opts));
  return h("div", { className: "wl-md" }, nodes);
}

/** 把块节点压成便于断言的形状。 */
function types(text) {
  return markdownBlocks(text).map((b) => b.type);
}

/* ---------------------------------------------------------------- 块级 */

test("标题：一到六级都认，标题文字不带 #", () => {
  const tree = render("# 一级\n\n### 三级");
  const h1 = byClass(tree, "wl-md-h1");
  const h3 = byClass(tree, "wl-md-h3");
  assert.equal(h1.type, "h1");
  assert.equal(textOf(h1), "一级");
  assert.equal(h3.type, "h3");
});

test("段落：连续两行合并成一段，空行断开", () => {
  assert.deepEqual(types("第一行\n第二行\n\n第三段"), ["paragraph", "paragraph"]);
  assert.equal(textOf(render("第一行\n第二行")), "第一行 第二行");
});

test("无序与有序列表：切换类型要重开列表", () => {
  assert.deepEqual(types("- a\n- b"), ["ul"]);
  assert.deepEqual(types("1. a\n2. b"), ["ol"]);
  // 混写时不能全塞进一个 ul
  assert.deepEqual(types("- a\n1. b"), ["ul", "ol"]);
});

test("列表缩进表达层级：缩进变化时重开列表，块本身带 depth", () => {
  // 解析器的选择是「缩进一变就重开一个列表」，而不是把一个嵌套列表塞进
  // 上一层——混在一个 <ul> 里渲染出来全是同样的圆点。所以层级落在块的
  // depth 上，渲染时按它缩进。
  const blocks = markdownBlocks("- 一级\n  - 二级");
  assert.equal(blocks.length, 2, "缩进变化重开列表");
  assert.deepEqual(blocks.map((b) => b.depth), [0, 1]);
  const tree = render("- 一级\n  - 二级");
  const lists = findAll(tree, (n) => n.type === "ul");
  assert.equal(lists.length, 2);
  assert.equal(lists[0].props.style, undefined, "一级不缩进");
  assert.match(JSON.stringify(lists[1].props.style), /marginLeft/, "二级要缩进");
});

test("引用：连续 > 行合成一个 blockquote", () => {
  const tree = render("> 第一句\n> 第二句");
  const q = byClass(tree, "wl-md-quote");
  assert.equal(textOf(q), "第一句 第二句");
});

test("分隔线渲染成 hr", () => {
  assert.equal(byClass(render("---"), "wl-md-hr").type, "hr");
});

test("代码块：保留原样，不做行内解析，带语言标记", () => {
  const tree = render("```js\nconst a = **not bold**;\n```");
  const pre = byClass(tree, "wl-md-pre");
  const code = findAll(pre, (n) => n.type === "code")[0];
  assert.equal(textOf(code), "const a = **not bold**;");
  assert.equal(code.props.className, "language-js");
  assert.equal(findAll(tree, (n) => n.type === "strong").length, 0, "代码块里的 ** 不能变成粗体");
});

test("代码块未闭合（流式中途）也把剩余内容当代码", () => {
  const tree = render("```\n还没写完");
  assert.equal(textOf(byClass(tree, "wl-md-pre")), "还没写完");
});

test("表格：冒号决定对齐，列数按表头补齐", () => {
  const blocks = markdownBlocks("| 左 | 右 |\n|:--|--:|\n| a | b |\n| c |");
  assert.equal(blocks[0].type, "table");
  assert.deepEqual(blocks[0].align, ["left", "right"]);
  assert.equal(blocks[0].rows.length, 2);
  assert.equal(blocks[0].rows[1].length, 2, "少写的单元格要补空，不能让整行错位");
  const table = byClass(render("| a |\n|---|\n| b |"), "wl-md-table");
  assert.ok(table, "表格要有可横向滚动的外壳");
});

test("没有分隔行的竖线不算表格", () => {
  assert.deepEqual(types("| 只是 | 一行 |"), ["paragraph"]);
});

test("单元格内的转义竖线不拆列", () => {
  const blocks = markdownBlocks("| a \\| b | c |\n|---|---|\n| 1 | 2 |");
  assert.equal(blocks[0].head.length, 2);
});

/* ---------------------------------------------------------------- 行内 */

test("粗体、行内代码、链接", () => {
  const tree = render("这是 **粗体** 与 `代码` 与 [链接](https://example.com)");
  assert.equal(textOf(byClass(tree, "wl-md-code")), "代码");
  const link = findAll(tree, (n) => n.type === "a")[0];
  assert.equal(link.props.href, "https://example.com");
  assert.equal(textOf(link), "链接");
});

test("非 http(s) 链接降级成文字，不产生 a 标签", () => {
  const tree = render("[点我](javascript:alert(1))");
  assert.equal(findAll(tree, (n) => n.type === "a").length, 0, "不安全的协议不能变成链接");
  assert.match(textOf(tree), /点我/);
});

test("流式未闭合的粗体按原文输出，不吞字符", () => {
  assert.equal(textOf(render("这是 **粗")), "这是 **粗");
});

/* ---------------------------------------------------------------- 会话 ID 钩子 */

test("extraInline 能把短 ID 变成可点节点", () => {
  const opts = {
    extraInline: (text, keyBase, h2) => {
      const out = [];
      const re = /\b[0-9a-f]{8}\b/g;
      let last = 0;
      let m;
      while ((m = re.exec(text))) {
        if (m.index > last) out.push(text.slice(last, m.index));
        out.push(h2("button", { key: keyBase + "s" + m.index, className: "wl-md-session" }, m[0]));
        last = m.index + m[0].length;
      }
      if (last < text.length) out.push(text.slice(last));
      return out;
    },
  };
  const tree = render("见会话 abc12345 的结论", opts);
  const btn = byClass(tree, "wl-md-session");
  assert.ok(btn, "短 ID 要变成按钮");
  assert.equal(textOf(btn), "abc12345");
  assert.match(textOf(tree), /见会话/);
});

test("不传 extraInline 时短 ID 就是普通文字", () => {
  const tree = render("见会话 abc12345 的结论");
  assert.equal(byClass(tree, "wl-md-session"), null);
  assert.match(textOf(tree), /abc12345/);
});

/* ---------------------------------------------------------------- 安全 */

test("全程不产生 innerHTML，模型输出只当文本", () => {
  const tree = render('<img src=x onerror="alert(1)">\n\n<script>x</script>');
  let raw = 0;
  walk(tree, (n) => {
    if (n.props && n.props.dangerouslySetInnerHTML) raw += 1;
  });
  assert.equal(raw, 0, "不能有 dangerouslySetInnerHTML");
  assert.match(textOf(tree), /<img/, "标签按原文显示");
});

test("空输入与纯空白不抛错", () => {
  assert.deepEqual(markdownBlocks(""), []);
  assert.deepEqual(markdownBlocks("   \n\n  "), []);
  assert.deepEqual(markdownBlocks(null), []);
});

/* ---------------------------------------------------------------- 缓存 */

test("相同内容复用解析结果，不同内容各自解析", () => {
  const a = markdownBlocks("# 同一个");
  const b = markdownBlocks("# 同一个");
  assert.equal(a, b, "内容没变就不该重新解析");
  const c = markdownBlocks("# 另一个");
  assert.notEqual(a, c);
});
