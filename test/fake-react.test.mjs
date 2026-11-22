import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createFakeReact,
  walk,
  textOf,
  byClass,
  findByType,
  findAll,
} from "../scripts/fake-react.mjs";

const h = (type, props, ...children) => ({ type, props, children });

test("expand 真的展开函数组件，而不是留下外壳", () => {
  const R = createFakeReact();
  function Inner() {
    return h("span", { className: "inner" }, "内部");
  }
  function Outer() {
    return h("div", { className: "outer" }, h(Inner, null));
  }
  const tree = R.renderFresh(Outer, {});
  // 不展开的话，Inner 留在树里的是 { type: Inner } 外壳，类名 span 一个都找不到。
  assert.ok(byClass(tree, "inner"), "函数组件应被展开成真实元素");
  assert.equal(textOf(tree), "内部");
});

test("给 key 后，列表前插不影响同一实例的 state（与真实 React 一致）", () => {
  const R = createFakeReact();
  const seen = new Map();
  function Card({ id }) {
    const [v] = R.api.useState("card-" + id);
    seen.set(id, v);
    return h("div", null, v);
  }
  function List({ ids }) {
    return h("div", null, ids.map((id) => h(Card, { id, key: id })));
  }

  R.renderKeep(List, { ids: [1, 2] });
  assert.equal(seen.get(1), "card-1");

  seen.clear();
  // 前面多插一张卡：有 key 时同一 key 的槽位不动
  R.renderKeep(List, { ids: [9, 1, 2] });
  assert.equal(seen.get(1), "card-1", "有 key 时前插不能让 state 串位");
  assert.equal(seen.get(9), "card-9");
});

test("不给 key 时按出现顺序编号：前插会串位，这是替身的已知边界", () => {
  const R = createFakeReact();
  const seen = new Map();
  function Card({ id }) {
    const [v] = R.api.useState("card-" + id);
    seen.set(id, v);
    return h("div", null, v);
  }
  function List({ ids }) {
    return h("div", null, ids.map((id) => h(Card, { id })));
  }
  R.renderKeep(List, { ids: [1, 2] });
  seen.clear();
  R.renderKeep(List, { ids: [9, 1, 2] });
  // 没有 key：Card#0 仍是 Card#0，state 被第一项沿用——这正是真实 React
  // 会警告「列表项应有 key」的场景。用例把边界钉住，免得日后误以为是 bug。
  assert.equal(seen.get(9), "card-1", "不给 key 时槽位按序号走，会串位");
});

test("renderFresh 换新 refs 数组：字符串键的 ref 不跨挂载残留", () => {
  const R = createFakeReact();
  const runs = [];
  function Comp() {
    const tried = R.api.useRef(false);
    R.api.useEffect(() => {
      if (tried.current) return;
      tried.current = true;
      runs.push(1);
    }, []);
    return h("div", null, "x");
  }

  R.renderFresh(Comp, {}, { effects: true });
  assert.equal(runs.length, 1, "首次挂载跑一次");

  // 重新挂载：quotaTried 这类「只跑一次」的标志必须复位
  R.renderFresh(Comp, {}, { effects: true });
  assert.equal(runs.length, 2, "重挂载后 effect 必须重新跑（refs.length=0 清不掉字符串键）");
});

test("renderKeep 保留 state，renderFresh 清空 state", () => {
  const R = createFakeReact();
  function Counter() {
    const [n, setN] = R.api.useState(0);
    Counter.bump = () => setN((v) => v + 1);
    return h("div", null, String(n));
  }
  R.renderKeep(Counter, {});
  Counter.bump();
  assert.equal(textOf(R.renderKeep(Counter, {})), "1", "renderKeep 保留状态");
  assert.equal(textOf(R.renderFresh(Counter, {})), "0", "renderFresh 重置状态");
});

test("renderKeep 处理渲染期 setState（跑多轮直到稳定）", () => {
  const R = createFakeReact();
  function Sync() {
    const [draft, setDraft] = R.api.useState("");
    if (draft !== "已补") setDraft("已补");
    return h("div", null, draft);
  }
  assert.equal(textOf(R.renderKeep(Sync, {})), "已补");
});

test("effect 依赖不变时不重跑，变化时跑", () => {
  const R = createFakeReact();
  let runs = 0;
  function Comp({ dep }) {
    R.api.useEffect(() => {
      runs += 1;
    }, [dep]);
    return h("div", null, "x");
  }
  R.renderFresh(Comp, { dep: 1 }, { effects: true });
  assert.equal(runs, 1);
  R.renderKeep(Comp, { dep: 1 });
  assert.equal(runs, 1, "依赖没变不重跑");
  R.renderKeep(Comp, { dep: 2 });
  assert.equal(runs, 2, "依赖变了要跑");
});

test("forgetComponent 模拟重新挂载", () => {
  const R = createFakeReact();
  let runs = 0;
  function Comp() {
    const tried = R.api.useRef(false);
    R.api.useEffect(() => {
      if (tried.current) return;
      tried.current = true;
      runs += 1;
    }, []);
    return h("div", null, "x");
  }
  R.renderFresh(Comp, {}, { effects: true });
  assert.equal(runs, 1);
  R.forgetComponent(Comp);
  R.renderFresh(Comp, {}, { effects: true });
  assert.equal(runs, 2);
});

test("查询辅助：byClass / findByType / findAll / textOf", () => {
  const tree = h(
    "div",
    { className: "root a" },
    h("span", { className: "gt-hint" }, "提示"),
    h("textarea", { className: "gt-feedback-text" }),
  );
  assert.equal(byClass(tree, "a").type, "div", "className 多值时按单个类名命中");
  assert.equal(findByType(tree, "span", "gt-hint").children[0], "提示");
  assert.equal(findByType(tree, "textarea").props.className, "gt-feedback-text");
  assert.equal(findAll(tree, (n) => n.type === "span").length, 1);
  assert.equal(textOf(tree), "提示");
  const visited = [];
  walk(tree, (n) => visited.push(n.type));
  assert.deepEqual(visited, ["div", "span", "textarea"]);
});

test("findByType 不传 cls 时匹配没有 className 的元素", () => {
  // Markdown 渲染出来的 strong/h2 大多没有 className。若「不传 cls」也要求
  // 元素带 className 字符串，这些标签一个都找不到——冒烟里会误报成没渲染。
  const tree = h("div", { className: "gt-digest-body" }, h("strong", null, "粗体"), h("h2", null, "标题"));
  assert.ok(findByType(tree, "strong"), "strong 没有 className，也应能按标签找到");
  assert.equal(textOf(findByType(tree, "h2")), "标题");
  assert.equal(findByType(tree, "strong", "gt-md-code"), null, "传了 cls 时仍要按类名过滤");
});

test("waitFor 命中返回 true 而不是谓词值", async () => {
  const { waitFor } = await import("../scripts/fake-react.mjs");
  let ready = false;
  setTimeout(() => {
    ready = true;
  }, 10);
  assert.equal(await waitFor(() => ready, 500), true);
  assert.equal(await waitFor(() => false, 30), false);
});
