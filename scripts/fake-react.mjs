/**
 * 冒烟测试用的最小 React 替身。
 *
 * 三次踩坑都固化在这里，改之前请先读完：
 *
 * 1. **hook 槽位按组件实例分域**，不是整棵树共用一个自增序号。
 *    真实 React 按 fiber 存状态，兄弟组件多一个少一个都不影响别人；
 *    全局序号则会让「扫描前后卡片数量变化」把后面组件的槽位整体顶歪，
 *    useState 读到别人的值（draft 变成布尔值之类）。
 *
 * 2. **renderFresh 必须整体换新 refs 数组**。槽位键是 `domain|idx` 字符串，
 *    `refs.length = 0` 只清数字索引，字符串键会留到下一次挂载——那样
 *    useRef 的「只在挂载时跑一次」标志（quotaTried 之类）会被当成还在，
 *    重挂载就不再跑初始化。
 *
 * 3. **函数组件必须展开**（expand），否则 h(FeedbackSection, null) 只是
 *    一个 { type: Comp } 外壳，按钮、文案全在壳里看不见。
 *
 * 用法：
 *   const R = createFakeReact();
 *   ... 插件里用 ctx.react = R.api ...
 *   R.renderFresh(Component, props, { effects: true })
 *   R.renderKeep(Component, props)
 *   R.walk / R.textOf / R.byClass / R.findByText ... 是纯查询辅助
 *
 * 注意：这个文件是**测试期**的 ESM 模块，只有 smoke 会 import，
 * 绝不进 main.js，也不受「插件不能 import 兄弟文件」的约束。
 */

/**
 * @param {{componentName?: string}} [opts]
 *   componentName 用于给匿名组件命名（调试时能看出是哪个槽位）。
 */
export function createFakeReact(opts) {
  const options = opts || {};
  const states = new Map();
  let stateIdx = 0;
  let refIdx = 0;
  let effectIdx = 0;
  let refs = [];
  const pendingEffects = [];

  let domain = "root";
  let domainSeq = new Map();
  const effectStores = new WeakMap();
  let effectStore = new Map();

  function sameDeps(a, b) {
    if (!a || !b) return false;
    if (a.length !== b.length) return false;
    return a.every((d, i) => Object.is(d, b[i]));
  }

  function cleanupEffects(store) {
    for (const e of store.values()) {
      if (typeof e.cleanup === "function") {
        try {
          e.cleanup();
        } catch {
          /* 清理失败不影响测试 */
        }
      }
    }
  }

  // 渲染结束后跑 effect；依赖没变的跳过，行为和 React 一致
  function flushEffects() {
    for (const e of pendingEffects) {
      const prev = effectStore.get(e.i);
      if (prev && (!e.deps || sameDeps(prev.deps, e.deps))) continue;
      if (prev && typeof prev.cleanup === "function") {
        try {
          prev.cleanup();
        } catch {
          /* 清理失败不影响测试 */
        }
      }
      let cleanup = null;
      try {
        cleanup = e.fn();
      } catch {
        /* effect 内的错误留给断言暴露 */
      }
      effectStore.set(e.i, {
        deps: e.deps,
        cleanup: typeof cleanup === "function" ? cleanup : null,
      });
    }
    pendingEffects.length = 0;
  }

  function useStoreFor(comp) {
    effectStore = effectStores.get(comp) || new Map();
    effectStores.set(comp, effectStore);
  }

  // React 会调用函数组件，替身也要展开，否则拿到的只是 {type: Comp} 外壳。
  //
  // 槽位身份按「名字 + 序号」，与真实 React 不完全相同：
  //   - 有 props.key 时用 key（与 React 一致，列表重排/前插都认得同一实例）；
  //   - 没有 key 时按同名组件的出现顺序编号（Card#0、Card#1…）。
  // 因此**列表里请给 key**：不给 key 的话，在列表前面插入一项会把后面
  // 所有同组件的槽位整体平移，state 会串（真实 React 靠 key 避免这一点）。
  function expand(node) {
    if (Array.isArray(node)) return node.map(expand);
    if (!node || typeof node !== "object") return node;
    if (typeof node.type === "function") {
      const nm = node.type.name || options.componentName || "anon";
      const key = node.props && node.props.key;
      let identity;
      if (key !== undefined && key !== null) {
        identity = nm + "@" + String(key);
      } else {
        const inst = domainSeq.get(nm) || 0;
        domainSeq.set(nm, inst + 1);
        identity = nm + "#" + inst;
      }
      const prev = { domain, stateIdx, refIdx };
      domain = identity;
      stateIdx = 0;
      refIdx = 0;
      const props = Object.assign({}, node.props || {}, { children: node.children || [] });
      const out = node.type(props);
      domain = prev.domain;
      stateIdx = prev.stateIdx;
      refIdx = prev.refIdx;
      return expand(out);
    }
    return Object.assign({}, node, { children: (node.children || []).map(expand) });
  }

  /**
   * 全新渲染：清空组件状态，默认不执行 effect。
   * 测试里若每 50ms 轮询一次渲染，每次都跑 effect 会反复启动子进程。
   */
  function renderFresh(comp, props, renderOpts) {
    const prev = effectStores.get(comp);
    if (prev) cleanupEffects(prev);
    effectStore = new Map();
    effectStores.set(comp, effectStore);
    states.clear();
    refs = [];
    stateIdx = 0;
    refIdx = 0;
    effectIdx = 0;
    domain = "root";
    domainSeq = new Map();
    pendingEffects.length = 0;
    const tree = expand(comp(props || {}));
    if (renderOpts && renderOpts.effects) flushEffects();
    else pendingEffects.length = 0;
    return tree;
  }

  /** 保留组件内部状态的重渲染：用于验证下拉、输入框、自动保存这类局部状态。 */
  function renderKeep(comp, props) {
    useStoreFor(comp);
    let tree;
    // React 允许组件在渲染期间 setState（例如切口吻时同步草稿），会立即重渲染。
    // 替身据此多跑几轮，直到状态稳定。
    for (let pass = 0; pass < 5; pass += 1) {
      const before = new Map(states);
      stateIdx = 0;
      refIdx = 0;
      effectIdx = 0;
      domain = "root";
      domainSeq = new Map();
      pendingEffects.length = 0;
      tree = expand(comp(props || {}));
      let changed = before.size !== states.size;
      for (const [k, v] of states) {
        if (!changed && before.get(k) !== v) changed = true;
      }
      if (!changed) break;
    }
    flushEffects();
    return tree;
  }

  /** 把某个组件的 effect 记录丢掉：换组件引用时模拟「重新挂载」。 */
  function forgetComponent(comp) {
    effectStores.delete(comp);
    states.clear();
    refs = [];
  }

  const api = {
    createElement: (type, props, ...children) => ({ type, props, children }),
    useState: (init) => {
      const i = domain + "|" + stateIdx++;
      if (!states.has(i)) states.set(i, typeof init === "function" ? init() : init);
      return [
        states.get(i),
        (v) => states.set(i, typeof v === "function" ? v(states.get(i)) : v),
      ];
    },
    useEffect: (fn, deps) => {
      pendingEffects.push({ i: effectIdx++, fn, deps });
    },
    useRef: (init) => {
      const i = domain + "|" + refIdx++;
      if (!refs[i]) refs[i] = { current: init === undefined ? null : init };
      return refs[i];
    },
    useCallback: (fn) => fn,
    useMemo: (fn) => fn(),
    useSyncExternalStore: (_subscribe, getSnapshot) => getSnapshot(),
  };

  return { api, renderFresh, renderKeep, flushEffects, expand, forgetComponent };
}

/* ------------------------------------------------------------ 查询辅助 */

export function walk(node, fn) {
  if (Array.isArray(node)) {
    for (const n of node) walk(n, fn);
    return;
  }
  if (!node || typeof node !== "object") return;
  fn(node);
  for (const k of node.children || []) walk(k, fn);
}

export function textOf(node) {
  if (typeof node === "string") return node;
  if (typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  if (!node || typeof node !== "object") return "";
  return (node.children || []).map(textOf).join("");
}

export function findByText(node, text) {
  let hit = null;
  walk(node, (n) => {
    if (hit) return;
    if (n.type === "button" && textOf(n).includes(text)) hit = n;
  });
  return hit;
}

/** 按 className 里的某一个类名找元素（className 可能是 "gt-btn gt-btn--primary"）。 */
export function byClass(node, cls) {
  let hit = null;
  walk(node, (n) => {
    if (hit) return;
    const c = n.props && n.props.className;
    if (typeof c === "string" && c.split(/\s+/).includes(cls)) hit = n;
  });
  return hit;
}

/** 按标签 + 类名找：冒烟里最常见的「找那个 textarea / span / a」。 */
export function findByType(node, tag, cls) {
  let hit = null;
  walk(node, (n) => {
    if (hit) return;
    if (n.type !== tag) return;
    // 只在传了 cls 时才要求 className。Markdown 渲染出的 strong / h2 / table
    // 大多没有 className，无条件要求带类名会把它们全过滤掉。
    if (cls) {
      const c = n.props && n.props.className;
      if (typeof c !== "string" || !c.split(/\s+/).includes(cls)) return;
    }
    hit = n;
  });
  return hit;
}

export function findAll(node, pred) {
  const out = [];
  walk(node, (n) => {
    if (pred(n)) out.push(n);
  });
  return out;
}

/** 等条件成立；命中返回 true（不是谓词值——拿它当元素用会得到空串）。 */
export async function waitFor(fn, timeoutMs = 2000, stepMs = 20) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fn()) return true;
    await new Promise((r) => setTimeout(r, stepMs));
  }
  return false;
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
