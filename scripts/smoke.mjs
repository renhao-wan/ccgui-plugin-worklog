// 冒烟测试：用最小 React 替身真实跑通「扫描 → 展示 → 生成 → 保存/插入」。
// 不依赖 CC GUI 宿主；node/git 子进程是真实调用，documentStorage 用临时目录模拟。
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..");
const PLUGIN = pathToFileURL(path.join(ROOT, "main.js")).href;
const MANIFEST = JSON.parse(fs.readFileSync(path.join(ROOT, "manifest.json"), "utf8"));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pad = (n) => String(n).padStart(2, "0");
const today = new Date();
today.setHours(0, 0, 0, 0);
const DAY = today.getTime();
const DATE = today.getFullYear() + "-" + pad(today.getMonth() + 1) + "-" + pad(today.getDate());
const at = (h, m = 0) => new Date(DAY + h * 3600000 + m * 60000).toISOString();

/* ------------------------------------------------------------ 临时资料 */

const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "wl-smoke-"));
const sessionRoot = path.join(workDir, "sessions");
const repoDir = path.join(workDir, "proj");
const storageDir = path.join(workDir, "storage");
const pickedDir = path.join(workDir, "picked-dir");
fs.mkdirSync(sessionRoot, { recursive: true });
fs.mkdirSync(repoDir, { recursive: true });

function makeFixture() {
  fs.writeFileSync(path.join(repoDir, "login.js"), "export const ok = true;\n");
  const git = (args) => execFileSync("git", args, { cwd: repoDir, encoding: "utf8" });
  git(["init"]);
  git(["add", "."]);
  git(["-c", "user.name=Smoke", "-c", "user.email=smoke@example.com", "commit", "-m", "feat: 登录校验第一版"]);
  // 提交后再改一次，制造一个「会话改过、仍未提交」的文件，用于交叉对账
  fs.writeFileSync(path.join(repoDir, "login.js"), "export const ok = false;\n");

  // 真实 Claude Code 的 sessionId 是 UUID，报告引用它时会显示前 8 位十六进制
  const base = {
    sessionId: "a1b2c3d4-1111-2222-3333-444455556666",
    cwd: repoDir,
    gitBranch: "main",
    version: "2.1.0",
    isSidechain: false,
  };
  const rows = [
    {
      ...base,
      type: "user",
      timestamp: at(9, 10),
      message: { role: "user", content: [{ type: "text", text: "修复登录校验，空密码要拦截" }] },
    },
    {
      ...base,
      type: "assistant",
      timestamp: at(9, 12),
      message: {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "看校验函数" },
          { type: "tool_use", name: "Edit", input: { file_path: path.join(repoDir, "login.js") } },
          { type: "tool_use", name: "Bash", input: { command: "npm test" } },
          { type: "text", text: "已加上空密码校验。" },
        ],
      },
    },
    {
      ...base,
      type: "user",
      timestamp: at(9, 14),
      message: {
        role: "user",
        content: [{ type: "tool_result", is_error: true, content: "Error: 测试未通过" }],
      },
    },
  ];
  fs.writeFileSync(
    path.join(sessionRoot, "a1b2c3d4.jsonl"),
    rows.map((r) => JSON.stringify(r)).join("\n"),
    "utf8"
  );
}

makeFixture();

/* ------------------------------------------------------------ DOM 替身 */
// 插件只用到 document.addEventListener/removeEventListener（浮层的 Esc 与焦点陷阱）。
// 给一个最小实现，能验证「注册了、关掉时解绑了」这件事本身。
const docListeners = new Map();
// 会话源目录的内容指纹：用来验证「扫描不写源目录」这件事本身，
// 而不是只数一数调用了几次 node。
function sessionTreeFingerprint() {
  const out = {};
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else out[p] = fs.readFileSync(p, "utf8") + "|" + fs.statSync(p).mtimeMs;
    }
  };
  walk(sessionRoot);
  return JSON.stringify(out);
}
let sessionFingerprintBeforeScan = "";
globalThis.document = {
  activeElement: null,
  addEventListener: (type, fn) => {
    if (!docListeners.has(type)) docListeners.set(type, new Set());
    docListeners.get(type).add(fn);
  },
  removeEventListener: (type, fn) => {
    const set = docListeners.get(type);
    if (set) set.delete(fn);
  },
  createElement: () => ({ style: {}, setAttribute() {}, select() {}, value: "" }),
  body: { appendChild() {}, removeChild() {} },
  execCommand: () => true,
};
function fireDocKey(key) {
  const set = docListeners.get("keydown");
  if (!set) return;
  for (const fn of [...set]) fn({ key: key, preventDefault() {} });
}

/* ------------------------------------------------------------ React 替身 */

const states = new Map();
let stateIdx = 0;
let refIdx = 0;
let effectIdx = 0;
// 用 let 而不是 const：renderFresh 必须整体换新数组（见那里的注释）
let refs = [];
const pendingEffects = [];
// hook 槽位按「组件实例」分域，不能整棵树共用一个序号：
// 真实 React 按 fiber 存状态，兄弟组件多一个少一个都不影响别人；
// 全局序号则会——扫描前后会话卡片数量变化，后面 ReportPanel 的槽位整体后移，
// useState 读到别人的值（draft 变成布尔值之类）。
let domain = "root";
let domainSeq = new Map();
// effect 记录按组件分区：tab 与设置页的 effect 槽位不能互相覆盖
const effectStores = new WeakMap();
let effectStore = new Map();

const fakeReact = {
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
      } catch (err) {
        /* ignore */
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
      } catch (err) {
        /* 清理失败不影响测试 */
      }
    }
    let cleanup = null;
    try {
      cleanup = e.fn();
    } catch (err) {
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
// 每个函数组件进入自己的域：同名组件按出现顺序编号（SessionBlock#0、#1…），
// 每次 pass 重排。这样兄弟组件增删不会让后面组件的槽位整体错位。
function expand(node) {
  if (Array.isArray(node)) return node.map(expand);
  if (!node || typeof node !== "object") return node;
  if (typeof node.type === "function") {
    const nm = node.type.name || "anon";
    const inst = domainSeq.get(nm) || 0;
    domainSeq.set(nm, inst + 1);
    const prev = { domain, stateIdx, refIdx };
    domain = nm + "#" + inst;
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
 * 测试里每 50ms 轮询一次渲染，若每次都跑 checkEnv 会反复启动子进程。
 *
 * 注意 ref 的清法：槽位键是 `domain|idx` 字符串，`refs.length = 0` 只清数字
 * 索引，字符串键会留到下一次挂载——那样 useRef 的「只在挂载时跑一次」标志
 * （quotaTried 之类）会被当成还在，重挂载就不再跑初始化。必须整体换新数组。
 */
function renderFresh(comp, props, opts) {
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
  if (opts && opts.effects) flushEffects();
  else pendingEffects.length = 0;
  return tree;
}

// 保留组件内部状态的重渲染：用于验证下拉、自动保存这类局部状态
function renderKeep(comp, props) {
  useStoreFor(comp);
  let tree;
  // React 允许组件在渲染期间 setState（报告面板切口吻时会同步草稿），会立即重渲染。
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

function walk(node, fn) {
  if (Array.isArray(node)) {
    for (const n of node) walk(n, fn);
    return;
  }
  if (!node || typeof node !== "object") return;
  fn(node);
  for (const k of node.children || []) walk(k, fn);
}

function textOf(node) {
  if (typeof node === "string") return node;
  if (typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  if (!node || typeof node !== "object") return "";
  return (node.children || []).map(textOf).join("");
}

function findByText(node, text) {
  let hit = null;
  walk(node, (n) => {
    if (hit) return;
    if (n.type === "button" && textOf(n).includes(text)) hit = n;
  });
  return hit;
}

function byClass(node, cls) {
  let hit = null;
  walk(node, (n) => {
    if (hit) return;
    const c = n.props && n.props.className;
    if (typeof c === "string" && c.split(/\s+/).includes(cls)) hit = n;
  });
  return hit;
}

/* ------------------------------------------------------------ 假宿主 */

const storageData = new Map();
const execCalls = [];
const agentStarts = [];
const agentInterrupts = [];
const sessionOpens = [];
let agentDelayMs = 5;
let agentRunIdx = 0;
let tabDef = null;
let navDef = null;
let settingsDef = null;
let commandDef = null;
// 反馈相关的桥接替身：默认全部拒绝（等同「权限未生效」），由各条用例自己设。
const httpCalls = [];
let httpResponder = null;

const eventHandlers = new Set();
function emit(ev) {
  for (const cb of Array.from(eventHandlers)) cb(ev);
}

// 文档存储位置可切换：custom 指向 pickedDir，data 回到默认数据目录
let docLocation = { kind: "data", path: storageDir };
const ctx = {
  react: fakeReact,
  pluginId: MANIFEST.id,
  version: MANIFEST.version,
  host: { sdkVersion: "0.3.25", appVersion: "1.2.4", locale: "zh-CN", isWeb: false },
  theme: { injectCss: () => () => {}, setTokens: () => () => {} },
  storage: {
    get: async (k) => (storageData.has(k) ? storageData.get(k) : null),
    set: async (k, v) => {
      storageData.set(k, v);
    },
    delete: async (k) => {
      storageData.delete(k);
    },
  },
  documentStorage: {
    getLocation: async () => Object.assign({}, docLocation),
    selectLocation: async (kind) => {
      docLocation = kind === "custom" ? { kind: "custom", path: pickedDir } : { kind: "data", path: storageDir };
      return Object.assign({}, docLocation);
    },
    readText: async (rel) => {
      const p = path.join(docLocation.path, rel);
      if (!fs.existsSync(p)) return null;
      return { content: fs.readFileSync(p, "utf8"), version: String(fs.statSync(p).mtimeMs) };
    },
    writeTextAtomic: async (rel, content, expectedVersion) => {
      const p = path.join(docLocation.path, rel);
      // 保真 CAS：版本对不上就拒绝，否则插件的冲突分支永远测不到。
      // 宿主语义：expectedVersion 为 null/undefined 表示「覆盖或不要求」，
      // 有值时必须与当前文件版本一致。
      if (expectedVersion != null && fs.existsSync(p)) {
        const cur = String(fs.statSync(p).mtimeMs);
        if (cur !== String(expectedVersion)) throw new Error("version conflict");
      }
      fs.mkdirSync(path.dirname(p), { recursive: true });
      // 模拟宿主原子写入前留一份 .bak
      if (fs.existsSync(p)) fs.writeFileSync(p + ".bak", fs.readFileSync(p));
      fs.writeFileSync(p, content, "utf8");
      return { version: String(Date.now()) };
    },
    remove: async (rel) => {
      try {
        fs.unlinkSync(path.join(docLocation.path, rel));
      } catch (e) {
        /* 不存在 */
      }
    },
    list: async (relDir) => {
      const dir = path.join(docLocation.path, relDir || "");
      if (!fs.existsSync(dir)) return [];
      return fs.readdirSync(dir).map((name) => (relDir ? relDir + name : name));
    },
  },
  assets: {
    // 系统文件夹选择器：测试里固定返回一个目录，验证选择后写回设置
    grantDirectory: async () => ({ grantId: "smoke-grant", path: pickedDir }),
  },
  ui: {
    registerCenterTab: (def) => {
      tabDef = def;
      return () => {};
    },
    registerSidebarNav: (def) => {
      navDef = def;
      return () => {};
    },
    registerSettingsSection: (def) => {
      settingsDef = def;
      return () => {};
    },
    registerCommand: (def) => {
      commandDef = def;
      return () => {};
    },
    openCenterTab: () => {},
    openSettings: () => {},
  },
  sessions: {
    selectSession: async (engine, sessionId, workspacePath) => {
      sessionOpens.push({ engine, sessionId, workspacePath });
    },
  },
  events: {
    on: (_topic, cb) => {
      eventHandlers.add(cb);
      return () => eventHandlers.delete(cb);
    },
    emit: () => {},
  },
  agent: {
    catalog: async () => [
      { engine: "qoder", available: true, readOnly: true, models: [{ id: "qoder-max" }] },
      { engine: "claude", available: true, readOnly: true, models: [{ id: "claude-sonnet-5" }] },
      { engine: "omp", available: false, readOnly: true, models: [] },
      { engine: "codex", available: true, readOnly: true, models: [{ id: "gpt-5" }] },
    ],
    start: async (opts) => {
      agentStarts.push(opts);
      agentRunIdx += 1;
      const idx = agentRunIdx;
      const runId = "smoke-run-" + idx;
      // 模拟引擎流式事件：先 delta，再 done
      setTimeout(() => {
        if (idx === 1) {
          emit({ runId, kind: "delta", data: "# " + DATE + " 工作日报\n" });
          emit({ runId, kind: "delta", data: "## 今日完成\n- 修复登录校验（a1b2c3d4）\n" });
        } else {
          emit({ runId, kind: "delta", data: "# SECOND-RUN-MARKER\n## 今日完成\n- 这一轮会被停止\n" });
        }
        emit({ runId, kind: "done", data: null });
      }, agentDelayMs);
      return { runId, sessionId: null };
    },
    interrupt: async (runId) => {
      agentInterrupts.push(runId);
      return true;
    },
  },
  bridge: {
    invoke: async (cmd, args) => {
      if (cmd === "plugin_http_request") {
        httpCalls.push(args);
        if (httpResponder) return httpResponder(args);
        throw new Error("network:ccgui-feedback.2653990378.workers.dev not granted");
      }
      if (cmd !== "plugin_exec_run") throw new Error("unexpected bridge command " + cmd);
      execCalls.push({ bin: args.bin, args: args.args });
      const out = execFileSync(args.bin, args.args, {
        encoding: "utf8",
        maxBuffer: 16 * 1024 * 1024,
        timeout: args.timeoutMs || 60000,
        env: Object.assign({}, process.env, args.env || {}),
      });
      return { code: 0, stdout: out, stderr: "" };
    },
  },
};

/* ------------------------------------------------------------ 执行 */

const results = [];
function check(name, fn) {
  try {
    fn();
    results.push({ ok: true, name });
  } catch (e) {
    results.push({ ok: false, name, error: e.message });
  }
}

async function waitFor(pred, ms) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (pred()) return true;
    await sleep(50);
  }
  return pred();
}

const mod = await import(PLUGIN);
const dispose = mod.default(ctx);
await sleep(60);

check("四个入口全部注册", () => {
  assert.ok(tabDef, "center tab");
  assert.ok(navDef, "sidebar nav");
  assert.ok(settingsDef, "settings section");
  assert.ok(commandDef, "command");
});

check("侧栏入口与命令都指向同一个页签", () => {
  assert.equal(navDef.label(), "工作志");
  assert.equal(tabDef.title(), "工作志");
  assert.ok(commandDef.keywords().includes("日报"));
});

// 先把设置里的会话根目录指向 fixture，避免依赖本机真实会话
storageData.set("worklog.settings.v1", {
  sessionRoot: sessionRoot,
  engine: "claude",
  model: "",
  workspacePath: repoDir,
  gitReconcile: true,
  tone: "daily",
});
// 启动时应该顺手清掉宿主遗留的 .bak
fs.mkdirSync(path.join(storageDir, "reports"), { recursive: true });
fs.writeFileSync(path.join(storageDir, "reports", "stale.md.bak"), "old");
// 预置一份旧扫描器和一份过期的事实快照，验证首次扫描会升级并清理
fs.mkdirSync(path.join(storageDir, "runtime"), { recursive: true });
fs.writeFileSync(path.join(storageDir, "runtime", "scan.mjs"), "// stale scanner\n");
const staleFactsName =
  "facts-" + new Date(Date.now() - 40 * 86400000).toISOString().slice(0, 10) + ".json";
fs.writeFileSync(path.join(storageDir, "runtime", staleFactsName), "{}");
// 多日快照是 facts-<from>_<to>.json，清理逻辑也得认
const staleWeek =
  "facts-" +
  new Date(Date.now() - 47 * 86400000).toISOString().slice(0, 10) + "_" +
  new Date(Date.now() - 40 * 86400000).toISOString().slice(0, 10) + ".json";
fs.writeFileSync(path.join(storageDir, "runtime", staleWeek), "{}");
// 重新激活以载入设置
dispose();
const dispose2 = mod.default(ctx);
await sleep(120);
check("启动时清理遗留的 .bak", () => {
  assert.equal(fs.existsSync(path.join(storageDir, "reports", "stale.md.bak")), false);
});

let tree = renderFresh(tabDef.component);
const scanButton = findByText(tree, "扫描");
check("页面初始为空态并给出说明", () => {
  assert.ok(scanButton, "应有扫描按钮");
  assert.match(textOf(tree), /还没有扫描/);
});

sessionFingerprintBeforeScan = sessionTreeFingerprint();
scanButton.props.onClick();
const scanned = await waitFor(() => {
  const t = textOf(renderFresh(tabDef.component));
  return t.includes("来源核对");
}, 30000);

check("扫描完成后展示来源核对与会话内容", () => {
  assert.ok(scanned, "应出现来源核对");
  const t = textOf(renderFresh(tabDef.component));
  assert.match(t, /1 个会话/);
  assert.match(t, /修复登录校验/);
  assert.match(t, /已加上空密码校验/);
  assert.match(t, /打开会话/);
  // 单日才有 00–24 的横轴
  assert.match(t, /今天的时间线/);
});

check("git 对账读到了当天的提交", () => {
  const t = textOf(renderFresh(tabDef.component));
  assert.match(t, /git 提交 1 次/);
  assert.match(t, /登录校验第一版/);
});

check("交叉对账把会话改动和 git 状态对上", () => {
  const t = textOf(renderFresh(tabDef.component));
  assert.match(t, /会话改了 1 个文件/);
  assert.match(t, /其中 1 个仍是未提交改动/);
  assert.match(t, /仍未提交：login\.js/);
});

check("扫描调用的是 node，且只读源目录", () => {
  const nodeCalls = execCalls.filter((c) => c.bin === "node");
  assert.ok(nodeCalls.length >= 1);
  const gitCalls = execCalls.filter((c) => c.bin === "git");
  assert.ok(gitCalls.length >= 1);
  // 「只读」不是数调用次数，而是源目录一个字节都没变
  assert.equal(sessionTreeFingerprint(), sessionFingerprintBeforeScan, "扫描不应改动会话源目录");
  // 扫描器的输出目录必须在插件数据目录下，不能落在会话源目录里
  const scanCall = nodeCalls.find((c) => c.args.some((a) => String(a).endsWith("scan.mjs")));
  assert.ok(scanCall, "应调用扫描器脚本");
  const outIdx = scanCall.args.indexOf("--out");
  assert.ok(outIdx >= 0, "扫描器应写结果文件");
  const outPath = String(scanCall.args[outIdx + 1]);
  assert.equal(path.resolve(outPath).startsWith(path.resolve(sessionRoot)), false, "结果文件不应写进会话源目录");
  assert.ok(path.resolve(outPath).startsWith(path.resolve(storageDir)), "结果文件应落在插件数据目录");
});

// 扫描器升级与事实快照清理是异步尾巴，等它落地再断言
await sleep(400);
check("旧扫描器被覆盖后不留下 .bak", () => {
  assert.equal(fs.existsSync(path.join(storageDir, "runtime", "scan.mjs.bak")), false);
});
check("超出保留期的旧事实快照会被清理", () => {
  assert.equal(fs.existsSync(path.join(storageDir, "runtime", staleFactsName)), false);
});
check("多日快照同样按结束日清理", () => {
  assert.equal(fs.existsSync(path.join(storageDir, "runtime", staleWeek)), false);
});

// 点击「打开会话」
tree = renderFresh(tabDef.component);
const openBtn = findByText(tree, "打开会话");
openBtn.props.onClick();
await sleep(30);
check("跳回原会话带上 engine/sessionId/workspace", () => {
  assert.equal(sessionOpens.length, 1);
  assert.equal(sessionOpens[0].engine, "claude");
  assert.equal(sessionOpens[0].sessionId, "a1b2c3d4-1111-2222-3333-444455556666");
  assert.equal(sessionOpens[0].workspacePath, repoDir);
});

// 生成日报
tree = renderFresh(tabDef.component);
check("报告区三种状态共用同一个槽位", () => {
  // 没有报告时：占位框 + 禁用的保存按钮，结构已经就位，
  // 生成完成后换的只是槽位里的内容，面板高度与下方按钮位置不变
  const body = byClass(tree, "wl-report-body");
  assert.ok(body, "应有 .wl-report-body");
  assert.ok(byClass(body, "wl-report-empty"), "空态应放在槽位里");
  const foot = byClass(tree, "wl-report-foot");
  assert.ok(foot, "操作行应始终存在");
  assert.equal(findByText(foot, "保存").props.disabled, true, "没有报告时保存应禁用");
});
const genBtn = findByText(tree, "生成日报");
check("生成前按钮可用", () => assert.equal(genBtn.props.disabled, false));
genBtn.props.onClick();

const generated = await waitFor(() => {
  const area = byClass(renderFresh(tabDef.component), "wl-textarea");
  return !!(area && typeof area.props.value === "string" && area.props.value.includes("今日完成"));
}, 15000);

check("生成完成后报告进入编辑区", () => {
  assert.ok(generated, "应看到模型返回的文本");
  const area = byClass(renderFresh(tabDef.component), "wl-textarea");
  assert.ok(area, "应有 textarea");
  assert.match(area.props.value, /今日完成/);
});

check("生成请求带上了事实摘要与只读标记", () => {
  assert.equal(agentStarts.length, 1);
  const opts = agentStarts[0];
  assert.equal(opts.engine, "claude");
  assert.equal(opts.model, "claude-sonnet-5");
  assert.equal(opts.readOnly, true);
  assert.match(opts.prompt, /修复登录校验/);
  assert.match(opts.prompt, /工作日报/);
  // 事实摘要要带上「用户要求 → 助手回应」的配对和真实执行过的命令
  assert.match(opts.prompt, /过程（/);
  assert.match(opts.prompt, /用户：修复登录校验/);
  assert.match(opts.prompt, /助手：已加上空密码校验/);
  assert.match(opts.prompt, /常执行：/);
});

// 生成结果只进编辑区，不自动落盘；编辑同样不写盘，只有点「保存」才落盘
const reportPath = path.join(storageDir, "reports", DATE + "-daily.md");
check("生成报告不会自动写盘", () => {
  assert.equal(fs.existsSync(reportPath), false, "生成后不应出现文件");
  assert.match(textOf(renderFresh(tabDef.component)), /有未保存的修改/);
});

tree = renderFresh(tabDef.component);
const reportArea = byClass(tree, "wl-textarea");
check("报告编辑区存在", () => assert.ok(reportArea, "应有 textarea"));
reportArea.props.onChange({ target: { value: "编辑后的报告内容" } });
renderKeep(tabDef.component);
await sleep(1000);
check("编辑报告不会自动写盘", () => {
  assert.equal(fs.existsSync(reportPath), false, "编辑后仍不应出现文件");
});

const saveTree = renderKeep(tabDef.component);
check("报告面板不再有插入输入框按钮", () => assert.equal(findByText(saveTree, "插入输入框"), null));
const saveArea = byClass(saveTree, "wl-textarea");
saveArea.props.onChange({ target: { value: "手动保存的内容" } });
const saveBtn = findByText(renderKeep(tabDef.component), "保存");
check("报告面板提供保存按钮", () => assert.ok(saveBtn, "应有保存按钮"));
saveBtn.props.onClick();
await sleep(80);
check("点保存立即写入报告文件", () => {
  assert.match(fs.readFileSync(reportPath, "utf8"), /手动保存的内容/);
});
check("保存后清掉宿主留下的 .bak", () => {
  assert.equal(fs.existsSync(reportPath + ".bak"), false, "不应留下 .bak");
});

// 报告可以在「原文」和「预览」之间切换，预览只读不写盘
const viewTree = renderKeep(tabDef.component);
const previewBtn = findByText(viewTree, "预览");
check("报告面板提供原文 / 预览切换", () => {
  assert.ok(previewBtn, "应有预览按钮");
  assert.ok(findByText(viewTree, "原文"), "应有原文按钮");
});
// 换成带标题、列表、表格和会话引用的 Markdown，验证渲染
const viewArea = byClass(viewTree, "wl-textarea");
viewArea.props.onChange({
  target: {
    value:
      "# 今日完成\n\n- 修复登录\n\n| 项目 | 耗时 |\n| --- | ---: |\n| 登录校验 | 2h |\n\n来源：a1b2c3d4\n",
  },
});
renderKeep(tabDef.component);
findByText(renderKeep(tabDef.component), "预览").props.onClick();
const previewTree = renderKeep(tabDef.component);
check("切到预览后渲染 Markdown，编辑区消失", () => {
  const md = byClass(previewTree, "wl-md");
  assert.ok(md, "应有 .wl-md 预览区");
  assert.equal(byClass(previewTree, "wl-textarea"), null, "预览时不应再有 textarea");
  const t = textOf(md);
  assert.match(t, /今日完成/);
  assert.match(t, /修复登录/);
});
check("预览能渲染 Markdown 表格", () => {
  const table = byClass(previewTree, "wl-md-table");
  assert.ok(table, "应有 .wl-md-table");
  const t = textOf(table);
  assert.match(t, /项目/);
  assert.match(t, /耗时/);
  assert.match(t, /登录校验/);
  assert.match(t, /2h/);
});
check("报告里引用的会话短 ID 渲染成可点击的按钮", () => {
  const ref = byClass(previewTree, "wl-md-session");
  assert.ok(ref, "应把会话短 ID 渲染成按钮");
  assert.equal(textOf(ref), "a1b2c3d4");
  assert.equal(ref.props.role || "button", "button");
});
// 点击引用后应调用 sessions.selectSession
byClass(renderKeep(tabDef.component), "wl-md-session").props.onClick();
await sleep(30);
check("会话引用走的是同一个打开会话的动作", () => {
  assert.equal(sessionOpens.length, 2);
  assert.equal(sessionOpens[1].sessionId, "a1b2c3d4-1111-2222-3333-444455556666");
});
check("预览不写盘", () => {
  assert.match(fs.readFileSync(reportPath, "utf8"), /手动保存的内容/);
});
const sourceBtn = findByText(previewTree, "原文");
sourceBtn.props.onClick();
check("切回原文后恢复编辑区", () => {
  assert.ok(byClass(renderKeep(tabDef.component), "wl-textarea"), "应回到 textarea");
});

// 日报 / 复盘切换：各口吻加载自己的文件，未保存草稿切回来还在
const switchTree = renderKeep(tabDef.component);
const swArea = byClass(switchTree, "wl-textarea");
swArea.props.onChange({ target: { value: "日报未保存的草稿" } });
// onChange 后要重新渲染，拿到的 onBlur 闭包才会捕获新草稿
byClass(renderKeep(tabDef.component), "wl-textarea").props.onBlur();
renderKeep(tabDef.component);

const retroBtn = findByText(renderKeep(tabDef.component), "复盘");
check("报告面板提供日报 / 复盘切换", () => assert.ok(retroBtn, "应有复盘按钮"));
retroBtn.props.onClick();
await sleep(60);
const retroTree = renderKeep(tabDef.component);
check("切到复盘后加载该口吻自己的内容", () => {
  assert.match(textOf(retroTree), /尚未生成/);
  assert.equal(byClass(retroTree, "wl-textarea"), null, "复盘还没有内容");
});

findByText(retroTree, "日报").props.onClick();
await sleep(80);
const backTree = renderKeep(tabDef.component);
check("切回日报时未保存的草稿还在", () => {
  const a = byClass(backTree, "wl-textarea");
  assert.ok(a, "应有编辑区");
  assert.equal(a.props.value, "日报未保存的草稿");
  assert.match(textOf(backTree), /有未保存的修改/);
});

// 竞态：读取文件期间又切了回来，结果以最后一次点击为准
findByText(backTree, "复盘").props.onClick();
findByText(renderKeep(tabDef.component), "日报").props.onClick();
await sleep(120);
check("快速切换以最后一次点击为准", () => {
  const a = byClass(renderKeep(tabDef.component), "wl-textarea");
  assert.ok(a, "应停在最后点击的日报");
  assert.equal(a.props.value, "日报未保存的草稿");
});

// 竞态：保存还没落盘就切换口吻，晚到的写入不得覆盖当前视图
const origWriteText = ctx.documentStorage.writeTextAtomic;
let releaseSave = null;
let saveWriteStarted = false;
ctx.documentStorage.writeTextAtomic = async (rel, content, ver) => {
  if (rel === "reports/" + DATE + "-daily.md") {
    saveWriteStarted = true;
    await new Promise((resolve) => {
      releaseSave = resolve;
    });
  }
  return origWriteText(rel, content, ver);
};
findByText(renderKeep(tabDef.component), "保存").props.onClick();
await waitFor(() => saveWriteStarted, 2000);
check("保存确实进入了写盘阶段", () => assert.ok(saveWriteStarted));

findByText(renderKeep(tabDef.component), "复盘").props.onClick();
await sleep(80);
releaseSave();
await sleep(200);
ctx.documentStorage.writeTextAtomic = origWriteText;

check("保存期间切换口吻，晚到的结果不会覆盖新视图", () => {
  const view = renderKeep(tabDef.component);
  assert.match(textOf(view), /尚未生成/, "应停在空白的复盘");
  assert.equal(byClass(view, "wl-textarea"), null, "不应塞回日报内容");
});
check("被切走的保存仍然写进了它原本的日报文件", () => {
  assert.match(fs.readFileSync(reportPath, "utf8"), /日报未保存的草稿/);
});

findByText(renderKeep(tabDef.component), "日报").props.onClick();
await sleep(120);
check("切回日报后内容与磁盘一致", () => {
  const a = byClass(renderKeep(tabDef.component), "wl-textarea");
  assert.ok(a, "应试回日报");
  assert.equal(a.props.value, "日报未保存的草稿");
});

// 草稿落盘的深度：切视图只在内存里留一份，插件热重载或重启就全没了。
// 写到一半关掉宿主，回来还得是那份——这条路径只能靠 ctx.storage 兜住。
const draftArea = byClass(renderKeep(tabDef.component), "wl-textarea");
check("未保存草稿会写进 storage", () => {
  assert.ok(draftArea, "应有编辑区");
});
draftArea.props.onChange({ target: { value: "# 重启前的日报草稿\n- 写到一半关掉了宿主\n" } });
// 防抖 400ms：等它真的写进 storage 再模拟重启
await sleep(700);
check("storage 里能读到这份草稿", () => {
  const raw = storageData.get("worklog.drafts.v1");
  assert.ok(raw && Array.isArray(raw.entries), "应有草稿记录");
  const key = DATE + "|daily";
  const hit = raw.entries.find((e) => e.key === key);
  assert.ok(hit, "应记下「" + key + "」，实际：" + raw.entries.map((e) => e.key).join(" / "));
  assert.match(hit.text, /重启前的日报草稿/);
});
// 模拟插件热重载：重新 activate 一个全新的模块实例，内存 Map 从零开始
const freshMod = await import(PLUGIN + "?reload=" + Date.now());
const disposeReload = freshMod.default(ctx);
await sleep(400);
check("重新激活后草稿没有丢", () => {
  const a = byClass(renderFresh(tabDef.component), "wl-textarea");
  assert.ok(a, "应回到编辑区");
  assert.match(a.props.value, /重启前的日报草稿/, "应把上次没保存的草稿读回来");
  assert.match(textOf(renderFresh(tabDef.component)), /有未保存的修改/);
});

// 恢复后续用例期望的报告内容
byClass(renderKeep(tabDef.component), "wl-textarea").props.onChange({
  target: { value: "手动保存的内容" },
});
findByText(renderKeep(tabDef.component), "保存").props.onClick();
await sleep(80);

// 设置自动保存：没有保存按钮，改动后防抖落盘
const settingsTree = renderFresh(settingsDef.component, {}, { effects: true });
check("设置页说明自动保存且不再有手动按钮", () => {
  const t = textOf(settingsTree);
  assert.match(t, /设置会自动保存/);
  assert.equal(findByText(settingsTree, "立即保存"), null, "不应再有手动保存按钮");
});
let gitCheck = null;
walk(settingsTree, (n) => {
  if (n.type === "input" && n.props && n.props.type === "checkbox") gitCheck = n;
});
check("设置页有对账开关", () => assert.ok(gitCheck));
gitCheck.props.onChange({ target: { checked: false } });
renderKeep(settingsDef.component);
await sleep(650);
check("设置改动自动写回 storage", () => {
  const saved = storageData.get("worklog.settings.v1");
  assert.ok(saved);
  assert.equal(saved.gitReconcile, false);
});

// 目录字段只能来自系统选择器：只读展示 + 选择按钮，没有可填写的输入框
const pickTree = renderKeep(settingsDef.component);
const pickButtons = [];
walk(pickTree, (n) => {
  const c = n.props && n.props.className;
  if (
    n.type === "button" &&
    typeof c === "string" &&
    c.split(/\s+/).includes("wl-path-pick") &&
    textOf(n).trim() === "选择…"
  ) {
    pickButtons.push(n);
  }
});
check("会话根目录与引擎运行目录都有选择按钮", () => {
  assert.equal(pickButtons.length, 2);
});
const settingInputs = [];
walk(pickTree, (n) => {
  if (n.type === "input") settingInputs.push(n);
});
check("设置页的目录字段只读，没有可手动填写的输入框", () => {
  assert.ok(settingInputs.length > 0);
  assert.ok(
    settingInputs.every((n) => n.props.type === "checkbox"),
    "目录不应是可编辑 input"
  );
});
check("设置页明确说明目前只支持 Claude Code", () => {
  const t = textOf(pickTree);
  assert.match(t, /目前只支持 Claude Code/);
});
const pathTexts = [];
walk(pickTree, (n) => {
  const c = n.props && n.props.className;
  if (typeof c === "string" && c.split(/\s+/).includes("wl-path-value")) pathTexts.push(textOf(n));
});
check("目录字段展示当前值", () => {
  assert.ok(pathTexts.includes(sessionRoot), "应显示会话根目录");
  assert.ok(pathTexts.includes(repoDir), "应显示引擎运行目录");
});

pickButtons[1].props.onClick();
await sleep(30);
const pickedTree = renderKeep(settingsDef.component);
const pickedTexts = [];
walk(pickedTree, (n) => {
  const c = n.props && n.props.className;
  if (typeof c === "string" && c.split(/\s+/).includes("wl-path-value")) pickedTexts.push(textOf(n));
});
check("选择目录后写回引擎运行目录", () => {
  assert.ok(pickedTexts.includes(pickedDir));
});
await sleep(650);
check("目录选择同样触发自动保存", () => {
  const saved = storageData.get("worklog.settings.v1");
  assert.equal(saved.workspacePath, pickedDir);
});

// 额外可执行文件目录是列表：可添加多个、可逐个移除
const addBtn = findByText(pickedTree, "添加目录…");
check("额外可执行目录用列表，提供添加按钮", () => assert.ok(addBtn));
addBtn.props.onClick();
await sleep(30);
const addedTree = renderKeep(settingsDef.component);
const removeBtns = [];
walk(addedTree, (n) => {
  if (n.type === "button" && textOf(n).trim() === "移除") removeBtns.push(n);
});
check("添加目录后列表多一行，可单独移除", () => {
  assert.equal(removeBtns.length, 1);
});
await sleep(650);
check("新增的可执行目录写进设置", () => {
  const saved = storageData.get("worklog.settings.v1");
  assert.deepEqual(saved.extraPaths, [pickedDir]);
});
removeBtns[0].props.onClick();
renderKeep(settingsDef.component);
await sleep(650);
check("移除后列表清空并写回设置", () => {
  const saved = storageData.get("worklog.settings.v1");
  assert.deepEqual(saved.extraPaths, []);
});

// 报告保存目录可以脱离插件数据目录
const changeDirBtn = findByText(renderKeep(settingsDef.component), "更改…");
check("报告保存目录提供更改入口", () => assert.ok(changeDirBtn));
changeDirBtn.props.onClick();
await sleep(30);
const changedTree = renderKeep(settingsDef.component);
const changedTexts = [];
walk(changedTree, (n) => {
  const c = n.props && n.props.className;
  if (typeof c === "string" && c.split(/\s+/).includes("wl-path-value")) changedTexts.push(textOf(n));
});
check("更改后显示新的报告目录并给出恢复默认", () => {
  assert.ok(changedTexts.includes(pickedDir));
  assert.ok(findByText(changedTree, "用默认目录"));
});
await sleep(800);
check("更换目录时把已有报告搬到新位置", () => {
  const moved = path.join(pickedDir, "reports", DATE + "-daily.md");
  assert.ok(fs.existsSync(moved), "应有 " + moved);
  assert.match(fs.readFileSync(moved, "utf8"), /手动保存的内容/);
  assert.equal(
    fs.existsSync(path.join(storageDir, "reports", DATE + "-daily.md")),
    false,
    "源文件应从旧目录移走"
  );
});
const resetDirBtn = findByText(changedTree, "用默认目录");
resetDirBtn.props.onClick();
await sleep(800);
renderKeep(settingsDef.component);
check("报告目录可以回到默认数据目录", () => {
  assert.equal(docLocation.kind, "data");
  assert.equal(docLocation.path, storageDir);
});
check("恢复默认时把文件搬回默认目录", () => {
  const back = path.join(storageDir, "reports", DATE + "-daily.md");
  assert.ok(fs.existsSync(back), "应有 " + back);
  assert.equal(fs.existsSync(path.join(pickedDir, "reports", DATE + "-daily.md")), false);
});

// 下拉是自绘的（原生 select 在宿主 WebView 里不跟主题），这里检查展开、选中与联动
check("设置页不再使用原生 select", () => {
  let found = null;
  walk(settingsTree, (n) => {
    if (n.type === "select") found = n;
  });
  assert.equal(found, null, "不应出现 <select>");
});

const ddTree = renderFresh(settingsDef.component);
const triggers = [];
walk(ddTree, (n) => {
  const c = n.props && n.props.className;
  if (typeof c === "string" && c.split(/\s+/).includes("wl-dd-trigger")) triggers.push(n);
});
check("生成报告区有三个下拉，当前引擎已选中且显示全名", () => {
  assert.equal(triggers.length, 3);
  assert.ok(textOf(triggers[0]).includes("Claude Code"), "应显示全名");
  assert.equal(triggers[1].props.disabled, false, "已选引擎时模型下拉应可用");
  assert.ok(textOf(triggers[2]).includes("工作日报"));
});

triggers[0].props.onClick();
const menu = byClass(renderKeep(settingsDef.component), "wl-dd-menu");
check("点开下拉后渲染自绘菜单", () => assert.ok(menu));
const options = [];
walk(menu, (n) => {
  if (n.props && n.props.role === "option") options.push(n);
});
check("引擎显示全名，可用的在前、组内按首字母排序，不可用置后", () => {
  const labels = options.map((o) => textOf(o).replace("✓", "").trim());
  assert.deepEqual(labels, [
    "自动（第一个可用引擎）",
    "Claude Code",
    "Codex",
    "Qoder",
    "OMP（不可用）",
  ]);
  assert.equal(options[1].props["aria-selected"], true);
  assert.equal(options[4].props["aria-disabled"], true);
});

// 切回「自动」：模型同时被清空
const optsNow = [];
walk(byClass(renderKeep(settingsDef.component), "wl-dd-menu"), (n) => {
  if (n.props && n.props.role === "option") optsNow.push(n);
});
optsNow[0].props.onClick();
const ddAfter = renderKeep(settingsDef.component);
const triggersAfter = [];
walk(ddAfter, (n) => {
  const c = n.props && n.props.className;
  if (typeof c === "string" && c.split(/\s+/).includes("wl-dd-trigger")) triggersAfter.push(n);
});
check("切回自动后显示占位文案", () => {
  assert.ok(textOf(triggersAfter[0]).includes("自动（第一个可用引擎）"));
});

// 环境自检：真实执行 node --version 与 git --version
const envTree = renderFresh(settingsDef.component);
const recheckBtn = findByText(envTree, "重新检测");
check("设置页提供环境自检入口", () => assert.ok(recheckBtn));
recheckBtn.props.onClick();
const envOk = await waitFor(() => {
  const t = textOf(renderFresh(settingsDef.component));
  return /node\s+✓/.test(t) && /git\s+✓/.test(t);
}, 10000);
check("环境自检能真实检出 node 与 git", () => {
  assert.ok(envOk, "应同时检出 node 与 git");
  const t = textOf(renderFresh(settingsDef.component));
  assert.match(t, /v\d+\./);
  assert.match(t, /git version/);
});

// 侧栏 badge
check("扫描后侧栏 badge 显示会话数", () => {
  assert.equal(navDef.badge(), 1);
});

// 停止生成：第二轮故意拖慢，在 done 之前点停止，结果不得落盘
agentDelayMs = 400;
tree = renderFresh(tabDef.component);
findByText(tree, "生成日报").props.onClick();
const sawStop = await waitFor(() => !!findByText(renderFresh(tabDef.component), "停止"), 3000);
check("生成过程中出现停止按钮", () => assert.ok(sawStop));
check("生成中的扫光条挂在不会滚动的外层", () => {
  const t = renderFresh(tabDef.component);
  const box = byClass(t, "wl-stream-box");
  assert.ok(box, "应有流式容器外层");
  assert.ok(box.props.className.includes("is-live"), "生成中应带 is-live");
  // 扫光条是绝对定位的伪元素，挂在滚动容器上会被内容卷走
  const inner = byClass(box, "wl-stream");
  assert.ok(inner, "外层里应有滚动层");
  assert.ok(!inner.props.className.includes("is-live"), "is-live 不该落在滚动层上");
  assert.ok(byClass(t, "wl-caret") || byClass(t, "wl-wait"), "应显示光标或等待三点");
  // 自动滚动必须挂在真正会滚的那一层
  assert.equal(typeof inner.props.ref, "function", "滚动 ref 应挂在 wl-stream 上");
});
// 等 start 的 Promise resolve，runId 才写进状态；停止要靠它通知宿主
await sleep(80);
findByText(renderFresh(tabDef.component), "停止").props.onClick();
await sleep(800);

check("停止后编辑区不被这一轮覆盖", () => {
  const t = textOf(renderFresh(tabDef.component));
  assert.ok(!t.includes("SECOND-RUN-MARKER"), "停止的轮次不应进入界面");
  const area = byClass(renderFresh(tabDef.component), "wl-textarea");
  assert.ok(area, "应保留上一份报告");
  assert.ok(!String(area.props.value).includes("SECOND-RUN-MARKER"), "编辑区不应被停止的轮次覆盖");
});

check("停止后已保存的报告文件不变", () => {
  const p = path.join(storageDir, "reports", DATE + "-daily.md");
  assert.ok(fs.existsSync(p), "上一份报告应还在");
  assert.ok(!fs.readFileSync(p, "utf8").includes("SECOND-RUN-MARKER"), "文件不应被停止的轮次覆盖");
});

check("停止时真的通知宿主中断了这一轮", () => {
  assert.ok(agentInterrupts.includes("smoke-run-2"), "应对当前 runId 调用 interrupt，实际 " + JSON.stringify(agentInterrupts));
});

// 本次扫描内临时隐藏工作区：不写设置，重新扫描就回来
tree = renderFresh(tabDef.component);
const muteBtn = findByText(tree, "不看这个");
check("工作区卡片提供临时隐藏入口", () => assert.ok(muteBtn));
muteBtn.props.onClick({ preventDefault: () => {}, stopPropagation: () => {} });
await sleep(120);
check("隐藏后工作区从列表与 KPI 中移除，且不写设置", () => {
  const t = textOf(renderFresh(tabDef.component));
  assert.match(t, /这一屏的工作区都被你隐藏了/);
  assert.match(t, /全部显示（1）/);
  const saved = storageData.get("worklog.settings.v1");
  assert.ok(!("ignoredWorkspaces" in saved), "隐藏不应写进设置");
});

const showAllBtn = findByText(renderFresh(tabDef.component), "全部显示（1）");
check("空态提供一次性全部显示", () => assert.ok(showAllBtn));
showAllBtn.props.onClick();
await sleep(80);
check("全部显示后工作区回到列表", () => {
  const t = textOf(renderFresh(tabDef.component));
  assert.match(t, /修复登录校验/);
});

// 隐藏后再扫一次，工作区应当自动回来
tree = renderFresh(tabDef.component);
findByText(tree, "不看这个").props.onClick({ preventDefault: () => {}, stopPropagation: () => {} });
await sleep(80);
findByText(renderFresh(tabDef.component), "扫描").props.onClick();
const rescanned = await waitFor(() => {
  const t = textOf(renderFresh(tabDef.component));
  return t.includes("修复登录校验") && !t.includes("本次已隐藏");
}, 30000);
check("重新扫描后隐藏的临时状态清空", () => assert.ok(rescanned));

/* ------------------------------------------------------ 日期范围与周报 */

const monday = (() => {
  const d = new Date(DAY);
  const dow = d.getDay();
  const back = dow === 0 ? 6 : dow - 1;
  d.setDate(d.getDate() - back);
  return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
})();
const weekFile = "reports/" + monday + "_" + DATE + "-weekly.md";

check("页头提供单日 / 本周 / 自定义三种范围", () => {
  const t = renderFresh(tabDef.component);
  ["单日", "本周", "自定义"].forEach((label) => {
    assert.ok(findByText(t, label), "应有「" + label + "」按钮");
  });
});

findByText(renderFresh(tabDef.component), "本周").props.onClick();
await sleep(60);
check("点「本周」把范围切到本周一至今天", () => {
  const t = textOf(renderFresh(tabDef.component));
  assert.match(t, new RegExp(monday + " 至 " + DATE));
});

findByText(renderFresh(tabDef.component), "扫描").props.onClick();
const weekScanned = await waitFor(() => textOf(renderFresh(tabDef.component)).includes("来源核对"), 30000);
check("多日范围也能扫描", () => assert.ok(weekScanned, "应完成扫描"));

check("多日范围不画单日时间线", () => {
  const t = textOf(renderFresh(tabDef.component));
  assert.ok(!t.includes("今天的时间线"), "多日范围下 00–24 的横轴会把不同天画成连续区间");
});

const lastNodeCall = execCalls.filter((c) => c.bin === "node").pop();
check("多日范围把 --from/--to 传给扫描器", () => {
  assert.ok(lastNodeCall, "应调用过 node");
  const args = lastNodeCall.args.join(" ");
  assert.ok(args.includes("--from " + monday), "应带 --from，实际 " + args);
  assert.ok(args.includes("--to " + DATE), "应带 --to，实际 " + args);
});

check("周报口吻出现在报告面板", () => {
  assert.ok(findByText(renderFresh(tabDef.component), "周报"), "应有周报按钮");
});

// 三种范围 × 三种口吻都允许选，但范围不匹配时要说明后果（只提示，不禁用）
check("多日范围选日报时给出范围不匹配的提示", () => {
  const t = renderFresh(tabDef.component);
  const btn = findByText(t, "周报");
  assert.ok(!btn.props.disabled, "周报按钮不该被禁用");
  // 当前生效口吻是日报，多日范围下要提示「今日/明天」会变笼统
  assert.match(textOf(byClass(t, "wl-report-empty")), /当前范围是 \d+ 天/);
  assert.match(textOf(byClass(t, "wl-report-empty")), /工作周报/);
});

findByText(renderFresh(tabDef.component), "周报").props.onClick();
await sleep(80);
findByText(renderFresh(tabDef.component), "生成周报").props.onClick();
const weekGenerated = await waitFor(
  () => agentStarts.length >= 2 && !!byClass(renderFresh(tabDef.component), "wl-textarea"),
  15000
);
check("周报使用周报的提示词模板", () => {
  assert.ok(weekGenerated, "应发起生成并拿到文本");
  const opts = agentStarts[agentStarts.length - 1];
  assert.match(opts.prompt, /工作周报/);
  assert.match(opts.prompt, /本周产出/);
  assert.match(opts.prompt, new RegExp(monday + " 至 " + DATE));
});

// 保存一份多日报告，随后能从历史里点回来
byClass(renderKeep(tabDef.component), "wl-textarea").props.onChange({
  target: { value: "# 本周周报\n\n- 完成了登录校验\n" },
});
findByText(renderKeep(tabDef.component), "保存").props.onClick();
await sleep(120);
check("多日报告写进 from_to 文件名", () => {
  const p = path.join(storageDir, weekFile);
  assert.ok(fs.existsSync(p), "应有 " + weekFile);
  assert.match(fs.readFileSync(p, "utf8"), /本周周报/);
});

// 回到单日，再从历史点回这份周报
const nodeCallsBeforeRestore = execCalls.filter((c) => c.bin === "node").length;
findByText(renderFresh(tabDef.component), "单日").props.onClick();
await sleep(80);
check("切回单日后范围回到今天", () => {
  const t = textOf(renderFresh(tabDef.component));
  assert.ok(!t.includes(monday + " 至 " + DATE), "不应还显示多日范围");
});

// 今天已经扫过一次：切回来时快照直接摆出来，不用再点「扫描」。
// 关掉宿主再打开也是这条路径——JSONL 早就写在 runtime/ 里了。
await waitFor(() => textOf(renderFresh(tabDef.component)).includes("来源核对"), 3000);
check("切回已扫过的范围时自动读回快照", () => {
  const t = textOf(renderFresh(tabDef.component));
  assert.match(t, /来源核对/, "应直接展示上次的扫描结果");
  assert.match(t, /1 个会话/, "内容应来自当天那份快照");
  // 读回来的没有本次耗时：「耗时 0 秒」会让人以为刚扫完
  assert.match(t, /上次扫描 \d{2}:\d{2}/, "应标明这是上次扫描的时间");
  const nodeCallsNow = execCalls.filter((c) => c.bin === "node").length;
  assert.equal(nodeCallsNow, nodeCallsBeforeRestore, "读快照不该再跑一次扫描器");
});

// 单日范围下选周报：允许点，但要说清「本周产出 / 下周安排」会很空
check("单日范围选周报时给出范围不匹配的提示", () => {
  const t = renderFresh(tabDef.component);
  const btn = findByText(t, "周报");
  assert.ok(!btn.props.disabled, "周报按钮不该被禁用");
  assert.match(btn.props.title, /当前范围只有 1 天/, "悬停提示应说明周报不适合单日");
});

check("报告历史入口存在", () => {
  assert.ok(findByText(renderFresh(tabDef.component), "报告历史"));
});

findByText(renderFresh(tabDef.component), "报告历史").props.onClick();
// 展开状态留在组件内部：用 renderKeep 才能看到菜单
await waitFor(() => !!byClass(renderKeep(tabDef.component), "wl-history-list"), 3000);
await sleep(150);
const historyTree = renderKeep(tabDef.component);
const historyRows = [];
walk(historyTree, (n) => {
  const c = n.props && n.props.className;
  if (typeof c === "string" && c.split(/\s+/).includes("wl-history-row")) historyRows.push(n);
});
check("报告历史按范围与口吻列已保存的报告", () => {
  assert.ok(historyRows.length >= 2, "应有单日与多日两份，实际 " + historyRows.length);
  const texts = historyRows.map((r) => textOf(r));
  assert.ok(texts.some((t) => t.includes(monday + " 至 " + DATE)), "应列出本周这份");
});

// 攒到几十上百份时，列表要按月份分开、并限高滚动，不能把整页顶下去
check("报告历史按月分组并限高滚动", () => {
  const t = renderKeep(tabDef.component);
  const groups = [];
  walk(t, (n) => {
    const c = n.props && n.props.className;
    if (typeof c === "string" && c.split(/\s+/).includes("wl-history-group")) groups.push(n);
  });
  assert.ok(groups.length >= 1, "应有月份分组");
  const months = [];
  walk(t, (n) => {
    const c = n.props && n.props.className;
    if (typeof c === "string" && c.split(/\s+/).includes("wl-history-month")) months.push(textOf(n));
  });
  assert.equal(months.length, groups.length, "每个月分组应各有一个标题");
  assert.match(months[0], /^\d{4}-\d{2}/, "分组标题应是月份，实际 " + months[0]);
  assert.ok(byClass(t, "wl-history-scroll"), "整个历史列表应有统一的限高滚动容器");
});

// 月份默认折叠：最新一个月展开，更早的收起；点标题才展开那一组。
// 造一份上个月的报告，验证「默认不铺开」和「点了能展开」。
const prevMonthDay = (() => {
  const d = new Date(today);
  d.setDate(1);
  d.setMonth(d.getMonth() - 1);
  return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-15";
})();
fs.writeFileSync(path.join(storageDir, "reports", prevMonthDay + "-retro.md"), "# 上个月的复盘\n", "utf8");
// 收起再展开一次，触发重新读盘
findByText(renderKeep(tabDef.component), "报告历史").props.onClick();
await sleep(120);
findByText(renderKeep(tabDef.component), "报告历史").props.onClick();
const monthButtons = (t) => {
  const out = [];
  walk(t, (n) => {
    const c = n.props && n.props.className;
    if (typeof c === "string" && c.split(/\s+/).includes("wl-history-month")) out.push(n);
  });
  return out;
};
await waitFor(() => monthButtons(renderKeep(tabDef.component)).length >= 2, 3000);
check("报告历史默认只展开最新月份", () => {
  let t = renderKeep(tabDef.component);
  const btns = monthButtons(t);
  assert.equal(btns.length, 2, "应有两个月份分组，实际 " + btns.length);
  assert.equal(btns[0].props["aria-expanded"], "true", "最新月份应默认展开");
  assert.equal(btns[1].props["aria-expanded"], "false", "更早的月份应默认收起");
  assert.ok(!textOf(t).includes(prevMonthDay), "收起时不该渲染那一组的报告行");
  btns[1].props.onClick();
  t = renderKeep(tabDef.component);
  assert.equal(monthButtons(t)[1].props["aria-expanded"], "true", "点月份标题后应展开");
  assert.ok(textOf(t).includes(prevMonthDay), "展开后应看到上个月的报告");
});

// 宿主 list(prefix) 的两种语义（带/不带尾斜杠、返回带/不带前缀）都要能列出报告。
// 真实宿主里曾因为拼法与预期不符返回空数组，界面就显示成「还没有保存过报告」。
const origListImpl = ctx.documentStorage.list;
const listVariants = {
  "带尾斜杠 + 带前缀（SDK 文档写法）": (prefix) => origListImpl(prefix),
  "只给文件名": async (prefix) => (await origListImpl(prefix)).map((p) => p.replace(/^reports\//, "")),
  "只认不带尾斜杠的前缀": async (prefix) => (String(prefix).endsWith("/") ? [] : origListImpl(prefix + "/")),
  // 部分宿主返回 { path, size } 对象；直接 String() 会变成 "[object Object]"
  "返回对象 { path, size }": async (prefix) => (await origListImpl(prefix)).map((p) => ({ path: p, size: 1 })),
};
const listVariantResults = [];
try {
  for (const [label, impl] of Object.entries(listVariants)) {
    ctx.documentStorage.list = impl;
    // 先收起，展开时才会重新读盘（组件只在 open 由假变真时调 loadReportList）
    findByText(renderKeep(tabDef.component), "报告历史").props.onClick();
    await sleep(150);
    findByText(renderKeep(tabDef.component), "报告历史").props.onClick();
    // 等读取真正落地：旧行还在，只看 wl-history-list 是否存在会立刻为真，读到的全是上一次的数据
    await waitFor(() => {
      const rows = [];
      walk(renderKeep(tabDef.component), (n) => {
        const c = n.props && n.props.className;
        if (typeof c === "string" && c.split(/\s+/).includes("wl-history-row")) rows.push(n);
      });
      return rows.length !== historyRows.length;
    }, 3000);
    const rows = [];
    walk(renderKeep(tabDef.component), (n) => {
      const c = n.props && n.props.className;
      if (typeof c === "string" && c.split(/\s+/).includes("wl-history-row")) rows.push(n);
    });
    listVariantResults.push({ label, n: rows.length });
  }
} finally {
  ctx.documentStorage.list = origListImpl;
}
check("宿主 list 语义变化时报告历史仍然读得到", () => {
  const bad = listVariantResults.filter((r) => r.n < 2);
  assert.equal(
    bad.length,
    0,
    "下列写法列不出报告：" + bad.map((r) => r.label + "=" + r.n).join("；")
  );
});

// 点历史只开浮层查看，不能把右侧生成面板里的内容换掉：
// 那是正在写的工作台，看一份旧报告不该丢掉当前草稿。
const panelBefore = renderFresh(tabDef.component);
const areaBefore = byClass(panelBefore, "wl-textarea");
const beforeValue = areaBefore ? String(areaBefore.props.value) : "";
const weekRow = historyRows.find((r) => textOf(r).includes(monday + " 至 " + DATE));
weekRow.props.onClick();
await sleep(200);
check("点历史记录打开只读查看器", () => {
  const t = renderFresh(tabDef.component);
  const mask = byClass(t, "wl-viewer-mask");
  assert.ok(mask, "应出现查看器浮层");
  assert.match(textOf(mask), new RegExp(monday + " 至 " + DATE), "标题应是那份报告的范围");
  const dialog = byClass(mask, "wl-viewer");
  assert.equal(dialog.props["aria-modal"], "true", "浮层应是模态对话框");
  assert.match(textOf(dialog), /本周周报/, "应显示报告正文");
  assert.ok(byClass(dialog, "wl-md"), "正文应走 Markdown 渲染");
});
check("查看历史不影响右侧生成面板", () => {
  const t = renderFresh(tabDef.component);
  const area = byClass(t, "wl-textarea") || byClass(t, "wl-md");
  assert.ok(area, "面板内容应还在");
  assert.equal(
    byClass(t, "wl-textarea") ? String(byClass(t, "wl-textarea").props.value) : "",
    beforeValue,
    "面板里的内容不应被历史报告替换"
  );
});

// Esc 是浮层的约定出口；关闭后 keydown 监听要解绑，不能留在 document 上
// 注意用 renderKeep：renderFresh 默认丢弃 effect，监听根本不会挂上
renderKeep(tabDef.component);
check("查看器打开时注册了 Esc 关闭", () => {
  assert.ok((docListeners.get("keydown") || new Set()).size > 0, "打开时应挂上 keydown");
});
fireDocKey("Escape");
await sleep(120);
check("Esc 关闭查看器并解绑监听", () => {
  renderKeep(tabDef.component);
  assert.equal(byClass(renderKeep(tabDef.component), "wl-viewer-mask"), null, "Esc 应关闭浮层");
  assert.equal((docListeners.get("keydown") || new Set()).size, 0, "关闭后应解绑 keydown");
});
// 关掉之后面板仍原样，Esc 不该顺带切换视图
check("Esc 关闭后右侧面板仍没被替换", () => {
  const area = byClass(renderFresh(tabDef.component), "wl-textarea");
  assert.equal(area ? String(area.props.value) : "", beforeValue);
});

// 重新打开浮层，验证「在面板中打开」——这是用户明确要求切换的那一步
weekRow.props.onClick();
await sleep(200);
findByText(byClass(renderFresh(tabDef.component), "wl-viewer"), "在面板中打开").props.onClick();
await sleep(200);
check("从查看器在面板中打开这份报告", () => {
  const t = renderFresh(tabDef.component);
  assert.equal(byClass(t, "wl-viewer-mask"), null, "点完应关闭浮层");
  assert.match(textOf(t), new RegExp(monday + " 至 " + DATE));
  const area = byClass(t, "wl-textarea");
  assert.ok(area, "应显示报告内容");
  assert.match(area.props.value, /本周周报/);
});

/* ------------------------------------------------------ 历史搜索与删除 */

// 总共才几份时搜索框没必要占地方；造几份跨月的报告，让行数过门槛
for (const d of ["2026-08-14", "2026-08-13", "2026-07-09", "2026-07-08"]) {
  fs.writeFileSync(path.join(storageDir, "reports", d + "-retro.md"), "# 旧复盘 " + d + "\n", "utf8");
}
fs.writeFileSync(path.join(storageDir, "reports", "2026-06-20-daily.md"), "# 旧日报\n", "utf8");

const historyRowsNow = (t) => {
  const out = [];
  walk(t, (n) => {
    const c = n.props && n.props.className;
    if (typeof c === "string" && c.split(/\s+/).includes("wl-history-row")) out.push(n);
  });
  return out;
};
const historySearchInput = (t) => {
  const box = byClass(t, "wl-history-search");
  let input = null;
  if (box) walk(box, (n) => {
    if (!input && n.type === "input") input = n;
  });
  return input;
};
// 一行里有「查看」和「删除」两个按钮，按行文本取到这两块
function historyRowPair(t, needle) {
  let hit = null;
  walk(t, (n) => {
    if (hit || n.type !== "li") return;
    const kids = (n.children || []).filter((c) => c && typeof c === "object" && c.type);
    const isCls = (c, cls) =>
      typeof (c.props || {}).className === "string" && c.props.className.split(/\s+/).includes(cls);
    const row = kids.find((c) => isCls(c, "wl-history-row"));
    if (!row || !textOf(row).includes(needle)) return;
    hit = { row: row, del: kids.find((c) => isCls(c, "wl-history-del")) };
  });
  return hit;
}

// 确保历史是展开的：收起时列表整个不渲染
if (!byClass(renderKeep(tabDef.component), "wl-history-body")) {
  findByText(renderKeep(tabDef.component), "报告历史").props.onClick();
  await sleep(150);
}
// 收起再展开，触发重新读盘（组件只在 open 由假变真时读）
findByText(renderKeep(tabDef.component), "报告历史").props.onClick();
await sleep(120);
findByText(renderKeep(tabDef.component), "报告历史").props.onClick();
await waitFor(() => historyRowsNow(renderKeep(tabDef.component)).length >= 8, 3000);

check("报告多了以后提供历史过滤框", () => {
  assert.ok(historySearchInput(renderKeep(tabDef.component)), "应有过滤输入框");
});

const filterHistory = async (kw) => {
  historySearchInput(renderKeep(tabDef.component)).props.onChange({ target: { value: kw } });
  await sleep(60);
};
await filterHistory("复盘");
check("历史过滤只留下匹配的报告", () => {
  const rows = historyRowsNow(renderKeep(tabDef.component));
  assert.ok(rows.length >= 1, "应还剩复盘报告");
  const wrong = rows.filter((r) => !textOf(r).includes("个人复盘"));
  assert.equal(wrong.length, 0, "应只剩复盘，实际还有：" + wrong.map((r) => textOf(r)).join(" / "));
});
check("过滤时月份全部摊开", () => {
  const t = renderKeep(tabDef.component);
  const months = [];
  walk(t, (n) => {
    const c = n.props && n.props.className;
    if (typeof c === "string" && c.split(/\s+/).includes("wl-history-month")) months.push(n);
  });
  assert.ok(months.length >= 1, "应有月份分组");
  assert.ok(
    months.every((m) => m.props["aria-expanded"] === "true" && m.props.disabled),
    "过滤时应展开并且不允许再折叠"
  );
});

await filterHistory("不存在的口吻");
check("过滤无结果时说明并给出一键清空", () => {
  const t = renderKeep(tabDef.component);
  assert.match(textOf(t), /没有匹配「不存在的口吻」的报告/);
  assert.ok(findByText(t, "清空过滤"), "应能一键清空");
});
findByText(renderKeep(tabDef.component), "清空过滤").props.onClick();
await sleep(60);
check("清空过滤后恢复全部报告", () => {
  const t = renderKeep(tabDef.component);
  assert.equal(historySearchInput(t).props.value, "", "过滤词应被清空");
  const months = [];
  walk(t, (n) => {
    const c = n.props && n.props.className;
    if (typeof c === "string" && c.split(/\s+/).includes("wl-history-month")) months.push(n);
  });
  assert.ok(months.length >= 4, "几个月都应回来，实际 " + months.length);
  // 回到默认态：最新月展开、更早的收起，月份按钮重新可点
  assert.equal(months[0].props["aria-expanded"], "true");
  assert.equal(months[1].props["aria-expanded"], "false");
  assert.ok(months.every((m) => !m.props.disabled), "月份应能重新折叠");
});

// 删除：不可撤销，所以要两次点击；筛到目标月份，免得被折叠挡住
await filterHistory("2026-08");
const delTarget = "2026-08-14";
const delPath = path.join(storageDir, "reports", delTarget + "-retro.md");
check("历史行提供删除入口", () => {
  const pair = historyRowPair(renderKeep(tabDef.component), delTarget);
  assert.ok(pair && pair.del, "每行应有删除按钮");
});
historyRowPair(renderKeep(tabDef.component), delTarget).del.props.onClick();
await sleep(60);
check("第一次点删除只是等确认", () => {
  const pair = historyRowPair(renderKeep(tabDef.component), delTarget);
  assert.equal(textOf(pair.del), "确认删除", "应变成确认态");
  assert.ok(fs.existsSync(delPath), "第一次点击不该真删");
});
// 宿主写盘会留一份 .bak，删报告时得一起清掉
fs.writeFileSync(delPath + ".bak", "old", "utf8");
historyRowPair(renderKeep(tabDef.component), delTarget).del.props.onClick();
await sleep(300);
check("确认后真的删掉这份报告", () => {
  assert.equal(fs.existsSync(delPath), false, "文件应被删除");
  assert.equal(fs.existsSync(delPath + ".bak"), false, "宿主留下的 .bak 也该清掉");
  const rows = historyRowsNow(renderKeep(tabDef.component));
  assert.equal(rows.some((r) => textOf(r).includes(delTarget)), false, "列表里也不该再有");
});
// 先让某一行进入确认态再收起，重新展开不该还停在一键即删
const remainBefore = historyRowPair(renderKeep(tabDef.component), "2026-08-13");
remainBefore.del.props.onClick();
await sleep(60);
findByText(renderKeep(tabDef.component), "报告历史").props.onClick();
await sleep(60);
findByText(renderKeep(tabDef.component), "报告历史").props.onClick();
await sleep(200);
check("收起历史时清掉待确认状态", () => {
  const pair = historyRowPair(renderKeep(tabDef.component), "2026-08-13");
  assert.ok(pair, "重新展开后应还在");
  assert.equal(textOf(pair.del), "删除", "不该还停在确认态");
});
findByText(renderKeep(tabDef.component), "清空").props.onClick();
await sleep(60);

/* ------------------------------------------------------ 自定义口吻 */

// 先渲染一次让自动保存 effect 记下基线，再点新增，改动才会被检测到
const toneTree = renderKeep(settingsDef.component);
const addToneBtn = findByText(toneTree, "新增口吻…");
check("设置页有自定义口吻入口", () => assert.ok(addToneBtn));
addToneBtn.props.onClick();
renderKeep(settingsDef.component);
await sleep(700);
check("新增的口吻写进设置", () => {
  const saved = storageData.get("worklog.settings.v1");
  assert.ok(saved);
  assert.equal(saved.customTones.length, 1);
  assert.equal(saved.customTones[0].id, "t1");
});

check("报告面板把内置口吻做成按钮、自定义口吻收进下拉", () => {
  const t = renderFresh(tabDef.component);
  const tabs = byClass(t, "wl-report-tabs");
  assert.ok(tabs, "应有独立的 .wl-report-tabs 行");
  assert.equal(byClass(byClass(t, "wl-report-head"), "wl-seg-tones"), null, "口吻栏不应塞进标题行");
  // 内置三种固定成按钮，数量与文案都不随自定义口吻增长
  const seg = byClass(tabs, "wl-seg-tones");
  const labels = [];
  walk(seg, (n) => {
    if (n.type === "button") labels.push(textOf(n));
  });
  assert.deepEqual(labels, ["日报", "复盘", "周报"], "内置口吻应固定三个按钮");
  // 自定义口吻走下拉：有几个都能列全，不再横向滚动藏起来
  const pick = byClass(tabs, "wl-tone-pick");
  assert.ok(pick, "应给自定义口吻留一个下拉");
  // 占位文案绝不能拼上数量：用户的口吻常按「自定义口吻 1…N」命名，
  // 拼了数量就会在切走时显示成「自定义口吻 6」，看着像口吻自己变了。
  assert.equal(textOf(pick).trim(), "自定义口吻", "占位文案不该拼数量");
  assert.equal(byClass(tabs, "wl-seg-tones").props.style, undefined, "不应再有横向滚动容器");
});

check("设置页自定义口吻默认收起", () => {
  const row = byClass(renderFresh(settingsDef.component), "wl-tone-row");
  assert.ok(row, "应有自定义口吻行");
  assert.equal(row.type, "details");
  assert.ok(!row.props.open, "默认不应展开");
  const body = byClass(row, "wl-tone-body");
  assert.ok(body, "模板编辑区应在 <details> 里");
  assert.ok(byClass(row, "wl-tone-head"), "summary 行应显示名称");
  assert.match(textOf(byClass(row, "wl-tone-head")), /自定义口吻 1/);
});

// 切换范围会清空事实，重新扫一次再生成
findByText(renderFresh(tabDef.component), "扫描").props.onClick();
await waitFor(() => textOf(renderFresh(tabDef.component)).includes("来源核对"), 30000);
// 自定义口吻在下拉里：先点开，再从菜单里选
const toneTrigger = byClass(byClass(renderFresh(tabDef.component), "wl-tone-pick"), "wl-dd-trigger");
check("自定义口吻下拉可以展开", () => assert.ok(toneTrigger, "应有下拉触发按钮"));
toneTrigger.props.onClick();
const toneMenu = byClass(renderKeep(tabDef.component), "wl-dd-menu");
check("自定义口吻下拉能列出全部自定义口吻", () => {
  assert.ok(toneMenu, "应弹出下拉菜单");
  const opts = [];
  walk(toneMenu, (n) => {
    if (n.props && n.props.role === "option") opts.push(textOf(n).replace("✓", "").trim());
  });
  assert.deepEqual(opts, ["自定义口吻 1"]);
});
walk(toneMenu, (n) => {
  if (n.props && n.props.role === "option") n.props.onClick();
});
// 切口吻要先读一次磁盘，等「生成」按钮的文案真的跟着变
const toneSwitched = await waitFor(
  () => !!findByText(renderFresh(tabDef.component), "生成自定义口吻 1"),
  3000
);
check("切到自定义口吻后生成按钮跟着变", () => assert.ok(toneSwitched));
// 用户的实际操作：选完自定义口吻，再点「日报」——下拉必须回到未选中态。
// 口吻行里只能有一个高亮；下拉继续显示旧名字会像「还停在自定义口吻上」。
findByText(renderFresh(tabDef.component), "日报").props.onClick();
await sleep(200);
const afterBackToDaily = byClass(byClass(renderFresh(tabDef.component), "wl-tone-pick"), "wl-dd-trigger");
check("切回日报后自定义下拉回到未选中", () => {
  assert.ok(afterBackToDaily, "应有口吻下拉");
  assert.equal(textOf(afterBackToDaily).trim(), "自定义口吻", "应显示占位文案，不能留着刚才那个口吻");
  assert.ok(byClass(afterBackToDaily, "wl-dd-value").props.className.includes("is-empty"), "应处于空态");
  assert.equal(byClass(renderFresh(tabDef.component), "wl-tone-pick").props.className.includes("is-current"), false, "停在内置口吻时不应描边");
});
// 点「复盘」同理
findByText(renderFresh(tabDef.component), "复盘").props.onClick();
await sleep(200);
check("切到复盘后自定义下拉也回到未选中", () => {
  const trig = byClass(byClass(renderFresh(tabDef.component), "wl-tone-pick"), "wl-dd-trigger");
  assert.equal(textOf(trig).trim(), "自定义口吻");
});
// 从下拉再切回自定义口吻，仍要能正常生效
byClass(byClass(renderFresh(tabDef.component), "wl-tone-pick"), "wl-dd-trigger").props.onClick();
const menuAgain = byClass(renderKeep(tabDef.component), "wl-dd-menu");
walk(menuAgain, (n) => {
  if (n.props && n.props.role === "option") n.props.onClick();
});
const backToCustom = await waitFor(
  () => !!findByText(renderFresh(tabDef.component), "生成自定义口吻 1"),
  3000
);
check("从下拉能再切回自定义口吻", () => assert.ok(backToCustom));

const startsBefore = agentStarts.length;
findByText(renderFresh(tabDef.component), "生成自定义口吻 1").props.onClick();
const customGenerated = await waitFor(() => agentStarts.length > startsBefore, 10000);
check("自定义口吻使用自己的模板并补上通用约束", () => {
  assert.ok(customGenerated, "应发起生成");
  const opts = agentStarts[agentStarts.length - 1];
  assert.match(opts.prompt, /工作记录/);
  assert.match(opts.prompt, /事实怎么读/);
  assert.match(opts.prompt, /不要读取文件/);
});

check("设置页明确说明引擎日志只支持 Claude Code", () => {
  assert.match(textOf(renderFresh(settingsDef.component)), /目前只支持 Claude Code/);
});

// 宿主切页签、热重载都会重新 activate：刚选好的自定义口吻不能被默认口吻顶掉
dispose2();
storageData.set("worklog.settings.v1", Object.assign({}, storageData.get("worklog.settings.v1"), { tone: "daily" }));
const dispose3 = mod.default(ctx);
await sleep(200);
const toneAfterReactivate = byClass(byClass(renderFresh(tabDef.component), "wl-tone-pick"), "wl-dd-trigger");
check("重新激活后仍停在刚才选的自定义口吻", () => {
  assert.ok(toneAfterReactivate, "应有口吻下拉");
  assert.match(textOf(toneAfterReactivate), /自定义口吻 1/, "不该退回占位文案");
  assert.ok(findByText(renderFresh(tabDef.component), "生成自定义口吻 1"), "生成按钮文案应跟着");
});

// 反过来：用户在设置里改了默认口吻，就该以新默认值为准，而不是一直锁着旧选择
const savedSettings = Object.assign({}, storageData.get("worklog.settings.v1"));
storageData.set("worklog.settings.v1", Object.assign({}, savedSettings, { tone: "retro" }));
dispose3();
const dispose4 = mod.default(ctx);
await sleep(200);
check("改过默认口吻后重新激活按新默认值走", () => {
  const tabs = byClass(renderFresh(tabDef.component), "wl-report-tabs");
  const on = [];
  walk(tabs, (n) => {
    if (n.type === "button" && n.props.className === "on") on.push(textOf(n));
  });
  assert.deepEqual(on, ["复盘"], "应回到新的默认口吻");
});
storageData.set("worklog.settings.v1", savedSettings);
dispose4();

// 引擎运行目录留空时用插件数据目录：生成过程留下的会话记在插件名下，
// 不会挂到真实项目上被下次扫描当成工作产出。显式设置的值仍优先。
dispose4();
storageData.set(
  "worklog.settings.v1",
  Object.assign({}, storageData.get("worklog.settings.v1"), { workspacePath: "" })
);
const dispose5 = mod.default(ctx);
await sleep(200);
findByText(renderFresh(tabDef.component), "扫描").props.onClick();
await waitFor(() => textOf(renderFresh(tabDef.component)).includes("来源核对"), 30000);
const startsBeforeDefaultWs = agentStarts.length;
const genBtnDefaultWs = findByText(renderFresh(tabDef.component), "生成");
if (genBtnDefaultWs) genBtnDefaultWs.props.onClick();
await waitFor(() => agentStarts.length > startsBeforeDefaultWs, 10000);
check("引擎运行目录留空时默认用插件数据目录", () => {
  const opts = agentStarts[agentStarts.length - 1];
  assert.ok(opts, "应发起生成");
  assert.equal(opts.workspacePath, storageDir, "默认应落在插件数据目录，不是当天第一个会话的工作区");
  assert.notEqual(opts.workspacePath, repoDir, "不能挂到真实项目名下");
});
// 只写「插件数据目录」等于没说它在哪：必须把真实路径显示出来
check("引擎运行目录留空时显示插件数据目录的真实路径", () => {
  const tree = renderFresh(settingsDef.component);
  const texts = [];
  walk(tree, (n) => {
    const c = n.props && n.props.className;
    if (typeof c === "string" && c.split(/\s+/).includes("is-default")) texts.push(textOf(n));
  });
  assert.equal(texts.length, 1, "应有一处默认目录展示");
  assert.match(texts[0], /默认 · /, "应标明这是默认值而不是用户选的");
  assert.ok(texts[0].includes(storageDir), "应显示真实路径 " + storageDir);
});
dispose5();

/* ------------------------------------------------------------ 反馈区 */

// dispose 会把 appCtx 置回 null，反馈用例需要重新激活一次。
const dispose6 = mod.default(ctx);
await sleep(200);

// 每条用例都从「当前设置页状态」出发：renderKeep 保留状态，反馈组件的
// hook 槽位按组件名分域，不会和设置表单互相串。
async function mountFeedback(responder) {
  httpResponder = responder;
  httpCalls.length = 0;
  // effects 要跑一次：额度只在挂载时查一次。查询是异步的，等它落定后
  // 再重渲染一遍，否则拿到的还是「还没查」的那一帧。
  renderFresh(settingsDef.component, {}, { effects: true });
  await sleep(80);
  return renderKeep(settingsDef.component);
}

// findByText 只认 button；Issue 入口是 <a>，单独找一个。
function findLink(tree, text) {
  let hit = null;
  walk(tree, (n) => {
    if (!hit && n.type === "a" && textOf(n).includes(text)) hit = n;
  });
  return hit;
}

const okQuota = () => ({ status: 200, body: JSON.stringify({ remaining: 1, dailyLimit: 1, fallbackRemaining: 3 }) });
// 发送成功后本插件即进入 48h 冷却（remaining:0），兜底池少一条。
const okSend = () => ({ status: 200, body: JSON.stringify({ ok: true, remaining: 0, dailyLimit: 1, fallbackRemaining: 2 }) });

await (async () => {
  const tree = await mountFeedback((args) =>
    args.url.includes("/quota") ? okQuota() : okSend(),
  );

  check("反馈：两种渠道都在，且请求体只有白名单字段", () => {
    const box = byClass(tree, "wl-feedback-text");
    assert.ok(box, "应有反馈输入框");
    assert.equal(box.props.maxLength, 1000);
    const link = findLink(tree, "通过 GitHub 提 Issue");
    assert.ok(link, "应有 Issue 链接");
    assert.match(link.props.href, /github\.com\/renhao-wan\/ccgui-plugin-worklog\/issues\/new\?/);
    assert.match(link.props.href, /title=%5B%E5%8F%8D%E9%A6%88%5D/, "标题应预填并编码");

    // 挂载时查过一次额度
    const quotaCall = httpCalls.find((c) => String(c.url).includes("/quota"));
    assert.ok(quotaCall, "挂载时应查一次额度");
    assert.equal(httpCalls.length, 1, "挂载时只该查额度，不该发反馈");
  });

  check("反馈：额度文案用服务端回传的真实值", () => {
    assert.match(textOf(byClass(tree, "wl-feedback-quota")), /两天|48/);
  });

  const filled = await (async () => {
    // 写内容：onChange 是唯一的输入通道
    byClass(renderKeep(settingsDef.component), "wl-feedback-text").props.onChange({
      target: { value: "点「生成」后一直停在扫描中\nError: timeout\n    at scan (scan.mjs:12)" },
    });
    const t = renderKeep(settingsDef.component);
    return t;
  })();

  check("反馈：正文保留换行与堆栈缩进", () => {
    const box = byClass(filled, "wl-feedback-text");
    assert.match(box.props.value, /\nError: timeout\n {4}at scan/);
    assert.match(textOf(byClass(filled, "wl-feedback-count")), /^\d+\s*\/\s*1000$/);
  });

  const btn = byClass(filled, "wl-feedback-send");
  assert.ok(btn, "应有发送按钮");
  assert.equal(btn.props.disabled, false, "有内容时应可发送");
  btn.props.onClick();
  btn.props.onClick(); // 同一 tick 连点两次
  await sleep(120);

  const sentTree = renderKeep(settingsDef.component);
  check("反馈：同一 tick 连点两次只发一条", () => {
    const posts = httpCalls.filter((c) => String(c.url).endsWith("/feedback"));
    assert.equal(posts.length, 1, "应只发出 1 条，实际 " + posts.length);
    const payload = JSON.parse(posts[0].body);
    assert.deepEqual(Object.keys(payload).sort(), ["hostVersion", "pluginId", "pluginVersion", "text", "ts"]);
    assert.equal(payload.pluginId, "worklog");
    assert.equal(payload.hostVersion, "1.2.4");
    assert.equal(posts[0].method, "POST");
    assert.match(String(posts[0].headers["User-Agent"]), /^ccgui-worklog\//);
  });

  check("反馈：成功后清空正文、按钮回到可用态且额度反映冷却状态", () => {
    assert.equal(byClass(sentTree, "wl-feedback-text").props.value, "");
    assert.match(textOf(byClass(sentTree, "wl-feedback-send")), /已发送/);
    assert.match(textOf(byClass(sentTree, "wl-feedback-quota")), /共享|48|两天/);
    assert.match(textOf(byClass(sentTree, "wl-feedback-status")), /已发送/);
  });
})();

await (async () => {
  // 额度查不到（500），但发送成功并回传 remaining
  const tree = await mountFeedback((args) =>
    args.url.includes("/quota") ? { status: 500, body: "boom" } : okSend(),
  );

  check("反馈：额度查不到时说明是连不上，并给重试入口", () => {
    assert.match(textOf(byClass(tree, "wl-feedback-quota")), /连不上|暂时/);
    assert.ok(byClass(tree, "wl-feedback-quota-retry"), "应提供重试按钮");
  });

  // 重试按钮真的会再查一次
  httpResponder = (args) => (args.url.includes("/quota") ? okQuota() : okSend());
  const before = httpCalls.filter((c) => String(c.url).includes("/quota")).length;
  byClass(renderKeep(settingsDef.component), "wl-feedback-quota-retry").props.onClick();
  await sleep(120);
  const retried = renderKeep(settingsDef.component);
  check("反馈：重试按钮会重新查额度，查到后收起重试入口", () => {
    assert.equal(httpCalls.filter((c) => String(c.url).includes("/quota")).length, before + 1);
    assert.match(textOf(byClass(retried, "wl-feedback-quota")), /两天|48/);
    assert.equal(byClass(retried, "wl-feedback-quota-retry"), null, "有额度时不该再挂重试按钮");
  });

  // 再挂一次「查不到」，验证发送成功会顺手纠正额度区
  httpResponder = (args) => (args.url.includes("/quota") ? { status: 500, body: "boom" } : okSend());
  byClass(renderKeep(settingsDef.component), "wl-feedback-text").props.onChange({ target: { value: "一条反馈" } });
  byClass(renderKeep(settingsDef.component), "wl-feedback-send").props.onClick();
  await sleep(120);
  const after = renderKeep(settingsDef.component);
  check("反馈：额度查不到但发送成功，额度区不再停留在「连不上」", () => {
    assert.match(textOf(byClass(after, "wl-feedback-quota")), /共享|48|两天/);
    assert.doesNotMatch(textOf(byClass(after, "wl-feedback-quota")), /连不上/);
  });
})();

await (async () => {
  await mountFeedback((args) =>
    args.url.includes("/quota") ? okQuota() : { status: 200, body: "<html>请登录校园网</html>" },
  );
  byClass(renderKeep(settingsDef.component), "wl-feedback-text").props.onChange({ target: { value: "被劫持" } });
  byClass(renderKeep(settingsDef.component), "wl-feedback-send").props.onClick();
  await sleep(120);
  const t = renderKeep(settingsDef.component);
  check("反馈：200 但正文不是我们的 JSON 时不当成功", () => {
    assert.doesNotMatch(textOf(t), /已发送/, "劫持页不能判成功");
    assert.match(textOf(byClass(t, "wl-feedback-status")), /GitHub Issue/);
    assert.notEqual(byClass(t, "wl-feedback-text").props.value, "", "失败时正文必须留着");
  });
})();

await (async () => {
  await mountFeedback((args) => {
    if (args.url.includes("/quota")) return okQuota();
    throw new Error("net::ERR_NAME_NOT_RESOLVED");
  });
  byClass(renderKeep(settingsDef.component), "wl-feedback-text").props.onChange({ target: { value: "断网" } });
  byClass(renderKeep(settingsDef.component), "wl-feedback-send").props.onClick();
  await sleep(120);
  const t = renderKeep(settingsDef.component);
  check("反馈：网络不通时提示检查网络或代理", () => {
    const s = textOf(byClass(t, "wl-feedback-status"));
    assert.match(s, /网络|代理/);
    assert.match(s, /GitHub Issue/);
  });
})();

await (async () => {
  await mountFeedback((args) => {
    if (args.url.includes("/quota")) return okQuota();
    return { status: 429, body: JSON.stringify({ ok: false, error: "rate_limited", kind: "burst", remaining: 25 }) };
  });
  byClass(renderKeep(settingsDef.component), "wl-feedback-text").props.onChange({ target: { value: "发太快" } });
  byClass(renderKeep(settingsDef.component), "wl-feedback-send").props.onClick();
  await sleep(120);
  const t = renderKeep(settingsDef.component);
  check("反馈：突发限流说「稍等几分钟」，不谎报额度耗尽", () => {
    const s = textOf(byClass(t, "wl-feedback-status"));
    assert.match(s, /太快|稍候|分钟/);
    assert.doesNotMatch(s, /48|两天/);
    assert.match(textOf(byClass(t, "wl-feedback-quota")), /共享|48|两天/);
  });
})();

httpResponder = null;
dispose6();

/* ------------------------------------------------------------ 汇总 */

for (const r of results) {
  console.log((r.ok ? "ok   " : "FAIL ") + r.name + (r.ok ? "" : " —— " + r.error));
}
const failed = results.filter((r) => !r.ok).length;
console.log("\nRESULT=" + (failed === 0 ? "SMOKE_OK" : "SMOKE_FAIL") + " checks=" + results.length + " failed=" + failed);

fs.rmSync(workDir, { recursive: true, force: true });
process.exit(failed === 0 ? 0 : 1);
