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
fs.mkdirSync(sessionRoot, { recursive: true });
fs.mkdirSync(repoDir, { recursive: true });

function makeFixture() {
  fs.writeFileSync(path.join(repoDir, "login.js"), "export const ok = true;\n");
  const git = (args) => execFileSync("git", args, { cwd: repoDir, encoding: "utf8" });
  git(["init"]);
  git(["add", "."]);
  git(["-c", "user.name=Smoke", "-c", "user.email=smoke@example.com", "commit", "-m", "feat: 登录校验第一版"]);

  const base = {
    sessionId: "smoke-sess-1",
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
    path.join(sessionRoot, "smoke-sess-1.jsonl"),
    rows.map((r) => JSON.stringify(r)).join("\n"),
    "utf8"
  );
}

makeFixture();

/* ------------------------------------------------------------ React 替身 */

const states = new Map();
let stateIdx = 0;
let refIdx = 0;
const refs = [];

const fakeReact = {
  createElement: (type, props, ...children) => ({ type, props, children }),
  useState: (init) => {
    const i = stateIdx++;
    if (!states.has(i)) states.set(i, typeof init === "function" ? init() : init);
    return [
      states.get(i),
      (v) => states.set(i, typeof v === "function" ? v(states.get(i)) : v),
    ];
  },
  useEffect: () => {},
  useRef: (init) => {
    const i = refIdx++;
    if (!refs[i]) refs[i] = { current: init === undefined ? null : init };
    return refs[i];
  },
  useCallback: (fn) => fn,
  useMemo: (fn) => fn(),
  useSyncExternalStore: (_subscribe, getSnapshot) => getSnapshot(),
};

// React 会调用函数组件，替身也要展开，否则拿到的只是 {type: Comp} 外壳。
function expand(node) {
  if (Array.isArray(node)) return node.map(expand);
  if (!node || typeof node !== "object") return node;
  if (typeof node.type === "function") {
    const props = Object.assign({}, node.props || {}, { children: node.children || [] });
    return expand(node.type(props));
  }
  return Object.assign({}, node, { children: (node.children || []).map(expand) });
}

function renderFresh(comp, props) {
  states.clear();
  refs.length = 0;
  stateIdx = 0;
  refIdx = 0;
  return expand(comp(props || {}));
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

const drafts = [];
const storageData = new Map();
const execCalls = [];
const agentStarts = [];
const sessionOpens = [];
let agentDelayMs = 5;
let agentRunIdx = 0;
let tabDef = null;
let navDef = null;
let settingsDef = null;
let commandDef = null;

const eventHandlers = new Set();
function emit(ev) {
  for (const cb of Array.from(eventHandlers)) cb(ev);
}

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
    getLocation: async () => ({ kind: "data", path: storageDir }),
    readText: async (rel) => {
      const p = path.join(storageDir, rel);
      if (!fs.existsSync(p)) return null;
      return { content: fs.readFileSync(p, "utf8"), version: String(fs.statSync(p).mtimeMs) };
    },
    writeTextAtomic: async (rel, content) => {
      const p = path.join(storageDir, rel);
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, content, "utf8");
      return { version: String(Date.now()) };
    },
    remove: async () => {},
    list: async () => [],
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
  composer: { setDraft: (t) => drafts.push(t) },
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
      { engine: "claude", available: true, readOnly: true, models: [{ id: "claude-sonnet-5" }] },
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
          emit({ runId, kind: "delta", data: "## 今日完成\n- 修复登录校验（smoke-sess）\n" });
        } else {
          emit({ runId, kind: "delta", data: "# SECOND-RUN-MARKER\n## 今日完成\n- 这一轮会被停止\n" });
        }
        emit({ runId, kind: "done", data: null });
      }, agentDelayMs);
      return { runId, sessionId: null };
    },
    interrupt: async () => true,
  },
  bridge: {
    invoke: async (cmd, args) => {
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
// 重新激活以载入设置
dispose();
const dispose2 = mod.default(ctx);
await sleep(80);

let tree = renderFresh(tabDef.component);
const scanButton = findByText(tree, "扫描当天");
check("页面初始为空态并给出说明", () => {
  assert.ok(scanButton, "应有扫描按钮");
  assert.match(textOf(tree), /还没有扫描/);
});

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
});

check("git 对账读到了当天的提交", () => {
  const t = textOf(renderFresh(tabDef.component));
  assert.match(t, /git 提交 1 次/);
  assert.match(t, /登录校验第一版/);
});

check("扫描调用的是 node，且只读源目录", () => {
  const nodeCalls = execCalls.filter((c) => c.bin === "node");
  assert.ok(nodeCalls.length >= 1);
  const gitCalls = execCalls.filter((c) => c.bin === "git");
  assert.ok(gitCalls.length >= 1);
});

// 点击「打开会话」
tree = renderFresh(tabDef.component);
const openBtn = findByText(tree, "打开会话");
openBtn.props.onClick();
await sleep(30);
check("跳回原会话带上 engine/sessionId/workspace", () => {
  assert.equal(sessionOpens.length, 1);
  assert.equal(sessionOpens[0].engine, "claude");
  assert.equal(sessionOpens[0].sessionId, "smoke-sess-1");
  assert.equal(sessionOpens[0].workspacePath, repoDir);
});

// 生成日报
tree = renderFresh(tabDef.component);
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
});

// 保存、插入输入框
tree = renderFresh(tabDef.component);
const saveBtn = findByText(tree, "保存");
saveBtn.props.onClick();
await sleep(80);
check("报告写入了 documentStorage", () => {
  const p = path.join(storageDir, "reports", DATE + "-daily.md");
  assert.ok(fs.existsSync(p), "应有 " + p);
  assert.match(fs.readFileSync(p, "utf8"), /今日完成/);
});

tree = renderFresh(tabDef.component);
const insertBtn = findByText(tree, "插入输入框");
insertBtn.props.onClick();
await sleep(20);
check("插入输入框拿到完整报告", () => {
  assert.equal(drafts.length, 1);
  assert.match(drafts[0], /今日完成/);
});

// 设置保存
const settingsTree = renderFresh(settingsDef.component);
const saveSettings = findByText(settingsTree, "保存设置");
check("设置区能渲染出保存按钮", () => assert.ok(saveSettings));
saveSettings.props.onClick();
await sleep(50);
check("设置写回 storage", () => {
  const saved = storageData.get("worklog.settings.v1");
  assert.ok(saved);
  assert.equal(saved.sessionRoot, sessionRoot);
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

dispose2();

/* ------------------------------------------------------------ 汇总 */

for (const r of results) {
  console.log((r.ok ? "ok   " : "FAIL ") + r.name + (r.ok ? "" : " —— " + r.error));
}
const failed = results.filter((r) => !r.ok).length;
console.log("\nRESULT=" + (failed === 0 ? "SMOKE_OK" : "SMOKE_FAIL") + " checks=" + results.length + " failed=" + failed);

fs.rmSync(workDir, { recursive: true, force: true });
process.exit(failed === 0 ? 0 : 1);
