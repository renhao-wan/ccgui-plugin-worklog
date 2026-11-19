/* =========================================================================
 * 工作志 worklog — CC GUI 插件
 *
 * 每天做了哪些活，散落在会话记录和 git 里。这个插件把它们收拢成一份
 * 可以核对的日志：先本地扫描事实（零 token），需要文字时再交给模型。
 *
 * 单文件 ESM：不能 import，扫描器由 scripts/build.mjs 内联为 SCAN_SOURCE。
 * 所有数据只读本机文件；插件从不写源会话。
 * ========================================================================= */

const PLUGIN_ID = "worklog";
const TAB_KEY = "worklog";
const PLUGIN_VERSION = "0.1.0";
const SETTINGS_KEY = "worklog.settings.v1";
const SCAN_REL = "runtime/scan.mjs";
const REPORTS_DIR = "reports";
const MAX_PROMPT_CHARS = 14000;
const AGENT_TIMEOUT_MS = 10 * 60 * 1000;
const SCAN_TIMEOUT_MS = 120 * 1000;
const GIT_TIMEOUT_MS = 20000;

const DEFAULT_SETTINGS = {
  sessionRoot: "",
  engine: "",
  model: "",
  workspacePath: "",
  extraPath: "",
  gitReconcile: true,
  tone: "daily",
};

/*__SCAN_SOURCE__*/

const CSS = `
.wl-root { display:flex; flex-direction:column; gap:12px; height:100%; min-height:0; box-sizing:border-box; padding:16px 18px 28px; overflow:auto; font-size:13px; line-height:1.55; color-scheme:light dark; }
.wl-head { display:flex; align-items:center; gap:8px; flex-wrap:wrap; }
.wl-title { font-size:16px; font-weight:600; margin-right:2px; }
.wl-spacer { flex:1 1 auto; }
.wl-btn { appearance:none; border:1px solid rgba(127,127,127,.32); background:rgba(127,127,127,.06); color:inherit; border-radius:6px; padding:4px 11px; font:inherit; cursor:pointer; white-space:nowrap; }
.wl-btn:hover:not(:disabled) { background:rgba(127,127,127,.14); }
.wl-btn:disabled { opacity:.45; cursor:default; }
.wl-btn.primary { border-color:rgba(127,127,127,.5); background:rgba(127,127,127,.16); font-weight:600; }
.wl-btn.danger { border-color:rgba(200,80,80,.5); }
.wl-input { border:1px solid rgba(127,127,127,.32); background:transparent; color:inherit; border-radius:6px; padding:3px 8px; font:inherit; }
.wl-input:focus { outline:1px solid rgba(127,127,127,.5); outline-offset:0; }
.wl-muted { opacity:.58; }
.wl-dim { opacity:.78; }
.wl-chip { border-radius:999px; padding:1px 9px; font-size:11px; border:1px solid rgba(127,127,127,.28); opacity:.85; }
.wl-error { border:1px solid rgba(200,80,80,.45); background:rgba(200,80,80,.08); border-radius:8px; padding:7px 10px; }
.wl-toast { border:1px solid rgba(80,160,110,.45); background:rgba(80,160,110,.09); border-radius:8px; padding:7px 10px; }
.wl-stats { display:grid; grid-template-columns:repeat(auto-fit,minmax(92px,1fr)); gap:8px; }
.wl-stat { border:1px solid rgba(127,127,127,.22); border-radius:8px; padding:8px 10px; }
.wl-stat b { display:block; font-size:18px; font-weight:600; line-height:1.25; }
.wl-stat span { font-size:11px; opacity:.6; }
.wl-card { border:1px solid rgba(127,127,127,.22); border-radius:10px; padding:10px 12px; display:flex; flex-direction:column; gap:8px; }
.wl-card-head { display:flex; align-items:center; gap:8px; flex-wrap:wrap; }
.wl-card-title { font-weight:600; word-break:break-all; }
.wl-session { border-top:1px solid rgba(127,127,127,.16); padding-top:8px; display:flex; flex-direction:column; gap:5px; }
.wl-session:first-of-type { border-top:0; padding-top:0; }
.wl-session-head { display:flex; align-items:center; gap:8px; flex-wrap:wrap; }
.wl-list { margin:0; padding-left:18px; }
.wl-list li { margin:1px 0; }
.wl-msg { white-space:pre-wrap; word-break:break-word; }
.wl-code { font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace; font-size:11.5px; opacity:.8; }
.wl-dirty { display:inline-block; margin:0 8px 2px 0; font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace; font-size:11px; }
.wl-empty { border:1px dashed rgba(127,127,127,.32); border-radius:10px; padding:22px 16px; text-align:center; opacity:.75; }
.wl-report { display:flex; flex-direction:column; gap:8px; }
.wl-report-head { display:flex; align-items:center; gap:8px; flex-wrap:wrap; }
.wl-textarea { width:100%; min-height:280px; box-sizing:border-box; resize:vertical; border:1px solid rgba(127,127,127,.28); border-radius:8px; background:rgba(127,127,127,.03); color:inherit; padding:10px 12px; font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace; font-size:12px; line-height:1.6; }
.wl-stream { border:1px solid rgba(127,127,127,.28); border-radius:8px; background:rgba(127,127,127,.03); padding:10px 12px; white-space:pre-wrap; word-break:break-word; max-height:360px; overflow:auto; font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace; font-size:12px; }
.wl-settings { display:flex; flex-direction:column; gap:12px; max-width:640px; }
.wl-env { display:flex; flex-direction:column; gap:2px; font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace; font-size:12px; }
.wl-field { display:flex; flex-direction:column; gap:4px; }
.wl-field label { font-weight:600; }
.wl-field .wl-hint { font-size:11.5px; opacity:.6; }
.wl-field .wl-input { width:100%; box-sizing:border-box; }
.wl-check { display:flex; align-items:center; gap:6px; }
`;

const PROMPTS = {
  daily: [
    "你是一位替工程师写工作日报的助手。只依据下面提供的事实写作，不要补充事实中不存在的内容，也不要评价技术方案的好坏。",
    "不要读取文件、不要调用任何工具、不要检索记忆，直接输出文字。",
    "",
    "写作要求：",
    "1. 按工作区组织，每个工作区交代「做了什么、做到什么程度」。",
    "2. 严格区分三类：已完成（有代码或提交证据）、进行中（会话里还在改）、试过但放弃（出现失败、报错或回退）。",
    "3. 事实里没有的结论不要写。无法判断是否完成时，写「改动已落地，尚未验证」。",
    "4. 每一条尽量带上来源（工作区名或会话短 ID）。",
    "5. 输出 Markdown，不要用代码块包裹整篇。",
    "",
    "结构：",
    "# <日期> 工作日报",
    "## 今日完成",
    "## 进行中",
    "## 卡点与风险",
    "## 明天接着做",
    "## 今日数据",
  ].join("\n"),
  retro: [
    "你是一位帮工程师做当日复盘的教练。只依据下面提供的事实分析，不要编造事实里没有的工作内容。",
    "不要读取文件、不要调用任何工具、不要检索记忆，直接输出文字。",
    "",
    "写作要求：",
    "1. 事实比计划重要：先写实际发生了什么，再谈感受。",
    "2. 「走过的弯路」只能从事实中的工具报错、反复修改同一文件、失败的尝试推断，并写明依据（会话短 ID 或报错原文）。",
    "3. 对事不对人，语气平实，不要灌鸡汤。",
    "4. 建议要具体到明天能执行的动作，不要写「提升效率」这类空话。",
    "5. 输出 Markdown，不要用代码块包裹整篇。",
    "",
    "结构：",
    "# <日期> 复盘",
    "## 今天实际做了什么",
    "## 时间花在哪",
    "## 有效产出",
    "## 走过的弯路",
    "## 明天怎么做得更好",
  ].join("\n"),
};

/* ------------------------------------------------------------------ 工具 */

let appCtx = null;

function safeError(e) {
  if (e == null) return "未知错误";
  if (typeof e === "string") return e;
  const msg = e.message || e.error || String(e);
  return msg.length > 500 ? msg.slice(0, 500) + "…" : msg;
}

function pad2(n) {
  return String(n).padStart(2, "0");
}

function todayStr() {
  const d = new Date();
  return d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate());
}

function nextDayStr(date) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(date || ""));
  if (!m) return date;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + 1);
  return d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate());
}

function hhmm(iso) {
  const t = Date.parse(iso || "");
  if (!Number.isFinite(t)) return "";
  const d = new Date(t);
  return pad2(d.getHours()) + ":" + pad2(d.getMinutes());
}

function clip(text, max) {
  const s = String(text == null ? "" : text);
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + "…";
}

function joinPath(root, rel) {
  const base = String(root || "").replace(/[\\/]+$/, "");
  return base + "/" + String(rel || "").replace(/\\/g, "/").replace(/^\/+/, "");
}

function shortPath(p) {
  const parts = String(p || "").split(/[\\/]/);
  return parts[parts.length - 1] || p;
}

function oneLine(text) {
  return String(text == null ? "" : text).replace(/\s+/g, " ").trim();
}

/* ------------------------------------------------------------------ 状态 */

const store = {
  snap: {
    ready: false,
    date: todayStr(),
    settings: Object.assign({}, DEFAULT_SETTINGS),
    scanning: false,
    rechecking: false,
    facts: null,
    git: null,
    error: "",
    toast: "",
    report: "",
    reportSaved: "",
    reportMode: "daily",
    generating: false,
    streamText: "",
    runId: "",
    env: null,
    envAt: 0,
    envChecking: false,
  },
  listeners: new Set(),
};

function set(patch) {
  store.snap = Object.assign({}, store.snap, patch);
  for (const fn of store.listeners) {
    try {
      fn();
    } catch (e) {
      /* 订阅方自己的错误不应影响其他订阅 */
    }
  }
}

function subscribe(fn) {
  store.listeners.add(fn);
  return () => store.listeners.delete(fn);
}

function useSnap() {
  return appCtx.react.useSyncExternalStore(subscribe, () => store.snap);
}

let toastTimer = null;
// 每次生成递增；停止或开始新一轮都会让旧轮次的结果失效
let genSeq = 0;
let activeAbort = null;
function flash(msg) {
  set({ toast: msg });
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => set({ toast: "" }), 2800);
}

/* ------------------------------------------------------------ 存储与脚本 */

let storageRoot = "";

async function ensureStorageRoot() {
  if (storageRoot) return storageRoot;
  const loc = await appCtx.documentStorage.getLocation();
  storageRoot = String(loc && loc.path ? loc.path : "").replace(/[\\/]+$/, "");
  if (!storageRoot) throw new Error("无法确定插件数据目录");
  return storageRoot;
}

async function ensureScanner() {
  const root = await ensureStorageRoot();
  const abs = joinPath(root, SCAN_REL);
  let cur = null;
  try {
    cur = await appCtx.documentStorage.readText(SCAN_REL);
  } catch (e) {
    cur = null;
  }
  if (!cur || cur.content !== SCAN_SOURCE) {
    await appCtx.documentStorage.writeTextAtomic(SCAN_REL, SCAN_SOURCE, cur ? cur.version : null);
  }
  return abs;
}

async function readSettings() {
  if (!appCtx) return Object.assign({}, DEFAULT_SETTINGS);
  let saved = null;
  try {
    saved = await appCtx.storage.get(SETTINGS_KEY);
  } catch (e) {
    saved = null;
  }
  const base = Object.assign({}, DEFAULT_SETTINGS);
  if (saved && typeof saved === "object") {
    for (const key of Object.keys(DEFAULT_SETTINGS)) {
      if (key in saved) base[key] = saved[key];
    }
  }
  return base;
}

async function writeSettings(next) {
  set({ settings: next });
  try {
    await appCtx.storage.set(SETTINGS_KEY, next);
  } catch (e) {
    /* 只影响本次会话 */
  }
}

/* -------------------------------------------------------------- 扫描流程 */

async function scanDay(date) {
  const scriptPath = await ensureScanner();
  const root = await ensureStorageRoot();
  const factsRel = "runtime/facts-" + date + ".json";
  const factsAbs = joinPath(root, factsRel);
  const sessionRoot = String(store.snap.settings.sessionRoot || "").trim() || "auto";

  const started = Date.now();
  const res = await appCtx.bridge.invoke("plugin_exec_run", {
    bin: "node",
    args: [scriptPath, "--root", sessionRoot, "--date", date, "--out", factsAbs],
    env: execEnv(),
    timeoutMs: SCAN_TIMEOUT_MS,
  });

  if (!res || res.code !== 0) {
    const detail = res ? String(res.stderr || res.stdout || "").trim() : "";
    throw new Error(detail ? clip(detail, 600) : "扫描脚本以非零退出（exit " + (res ? res.code : "?") + "）");
  }

  const doc = await appCtx.documentStorage.readText(factsRel);
  if (!doc || !doc.content) throw new Error("扫描结束但没有产出结果文件");
  let facts;
  try {
    facts = JSON.parse(doc.content);
  } catch (e) {
    throw new Error("扫描结果不是合法 JSON：" + safeError(e));
  }
  facts._elapsedMs = Date.now() - started;
  return facts;
}

/**
 * 宿主只按命令名查找可执行文件，插件不能传绝对路径。
 * 如果 node / git 不在宿主默认的 PATH 里，设置页可以让用户补一个目录；
 * 宿主会把它放在搜索顺序最前面，再追加自己的 CLI 目录。
 */
function execEnv() {
  const env = { GIT_OPTIONAL_LOCKS: "0" };
  const extra = String(store.snap.settings.extraPath || "").trim();
  if (extra) env.PATH = extra;
  return env;
}

/** 真实探测 node 与 git，让用户在设置页看到结果，而不是等扫描失败。 */
async function checkEnv(force) {
  if (!appCtx) return;
  if (!force && store.snap.env && Date.now() - store.snap.envAt < 5 * 60 * 1000) return;
  set({ envChecking: true });
  const env = execEnv();
  const out = {};
  for (const bin of ["node", "git"]) {
    try {
      const res = await appCtx.bridge.invoke("plugin_exec_run", {
        bin: bin,
        args: ["--version"],
        env: env,
        timeoutMs: 8000,
      });
      if (res && res.code === 0) {
        out[bin] = { ok: true, version: clip(oneLine(res.stdout || res.stderr || ""), 120) };
      } else {
        const detail = oneLine((res && (res.stderr || res.stdout)) || "");
        out[bin] = { ok: false, error: clip(detail || "exit " + (res ? res.code : "?"), 200) };
      }
    } catch (e) {
      out[bin] = { ok: false, error: clip(safeError(e), 200) };
    }
  }
  set({ env: out, envAt: Date.now(), envChecking: false });
}

function envLine(item) {
  if (!item) return "未检测";
  return item.ok ? "✓ " + item.version : "✗ " + item.error;
}

async function execGit(args, timeoutMs) {
  return appCtx.bridge.invoke("plugin_exec_run", {
    bin: "git",
    args: args,
    env: execEnv(),
    timeoutMs: timeoutMs || GIT_TIMEOUT_MS,
  });
}

async function gitForWorkspace(workspace, date) {
  const out = { workspace: workspace, isRepo: false, commits: [], dirty: [], error: "" };
  if (!workspace) return out;

  let probe;
  try {
    probe = await execGit(["-C", workspace, "rev-parse", "--is-inside-work-tree"]);
  } catch (e) {
    out.error = safeError(e);
    return out;
  }
  if (!probe || probe.code !== 0 || String(probe.stdout || "").trim() !== "true") {
    out.error = oneLine(probe && probe.stderr ? probe.stderr : "").slice(0, 160);
    return out;
  }
  out.isRepo = true;

  const since = date + "T00:00:00";
  const until = nextDayStr(date) + "T00:00:00";

  try {
    const log = await execGit([
      "-C", workspace, "log",
      "--since=" + since,
      "--until=" + until,
      "--pretty=format:%h%x09%ad%x09%s",
      "--date=format:%H:%M",
    ]);
    if (log && log.code === 0) {
      out.commits = String(log.stdout || "")
        .split(/\r?\n/)
        .filter(Boolean)
        .slice(0, 100)
        .map((line) => {
          const parts = line.split("\t");
          return {
            hash: parts[0] || "",
            time: parts[1] || "",
            subject: clip(parts.slice(2).join("\t") || "", 200),
          };
        });
    }
  } catch (e) {
    /* git log 失败不影响 status */
  }

  try {
    const st = await execGit(["-C", workspace, "-c", "core.quotepath=false", "status", "--porcelain=v1"]);
    if (st && st.code === 0) {
      out.dirty = String(st.stdout || "")
        .split(/\r?\n/)
        .filter(Boolean)
        .slice(0, 200)
        .map((line) => ({ code: line.slice(0, 2).trim(), path: line.slice(3).trim() }));
    }
  } catch (e) {
    /* 忽略 */
  }

  return out;
}

function findGit(workspace) {
  const list = store.snap.git;
  if (!list) return null;
  for (const g of list) {
    if (g && g.workspace === workspace) return g;
  }
  return null;
}

/** 清掉过期的扫描快照，避免 plugin-data 无限增长。 */
async function pruneOldFacts(keepDays) {
  const days = keepDays || 30;
  try {
    const list = await appCtx.documentStorage.list("runtime/");
    const cutoff = Date.now() - days * 86400000;
    for (const rel of list || []) {
      const m = /facts-(\d{4}-\d{2}-\d{2})\.json$/.exec(String(rel));
      if (!m) continue;
      const t = Date.parse(m[1] + "T00:00:00");
      if (Number.isFinite(t) && t < cutoff) {
        try {
          await appCtx.documentStorage.remove(rel);
        } catch (e) {
          /* 单个清理失败不影响其它文件 */
        }
      }
    }
  } catch (e) {
    /* 清理属于收尾工作，失败不阻塞扫描 */
  }
}

async function doScan() {
  if (store.snap.scanning) return;
  const date = store.snap.date;
  const mode = store.snap.reportMode;
  set({ scanning: true, error: "", toast: "", facts: null, git: null, streamText: "" });
  try {
    const facts = await scanDay(date);
    // 扫描期间用户切了日期：这批结果属于旧日期，丢弃
    if (store.snap.date !== date) return;
    set({ facts: facts });
    void pruneOldFacts();

    if (store.snap.settings.gitReconcile && facts.workspaces && facts.workspaces.length) {
      set({ rechecking: true });
      const results = await Promise.all(
        facts.workspaces
          .filter((group) => group.workspace)
          .map((group) =>
            gitForWorkspace(group.workspace, facts.range.from).catch((e) => ({
              workspace: group.workspace,
              isRepo: false,
              commits: [],
              dirty: [],
              error: safeError(e),
            }))
          )
      );
      if (store.snap.date !== date) return;
      set({ git: results, rechecking: false });
    }

    const saved = await loadSavedReport(date, mode);
    if (store.snap.date !== date || store.snap.reportMode !== mode) return;
    set({ report: saved || "", reportSaved: saved || "" });
  } catch (e) {
    set({ error: "扫描失败：" + safeError(e) });
  } finally {
    set({ scanning: false, rechecking: false });
  }
}

/* -------------------------------------------------------------- 报告读写 */

function reportRel(date, mode) {
  return REPORTS_DIR + "/" + date + "-" + mode + ".md";
}

async function loadSavedReport(date, mode) {
  if (!appCtx) return "";
  try {
    const doc = await appCtx.documentStorage.readText(reportRel(date, mode));
    return doc && doc.content ? doc.content : "";
  } catch (e) {
    return "";
  }
}

async function saveReportText(date, mode, text) {
  const rel = reportRel(date, mode);
  let cur = null;
  try {
    cur = await appCtx.documentStorage.readText(rel);
  } catch (e) {
    cur = null;
  }
  try {
    await appCtx.documentStorage.writeTextAtomic(rel, text, cur ? cur.version : null);
  } catch (e) {
    // CAS 冲突：重新读一次再写，避免把外部改动整个顶掉
    const again = await appCtx.documentStorage.readText(rel).catch(() => null);
    await appCtx.documentStorage.writeTextAtomic(rel, text, again ? again.version : null);
  }
}

/** 切换日期或口吻前，把未保存的编辑落盘，避免静默丢失。 */
async function flushPendingReport() {
  const text = store.snap.report;
  if (!text.trim() || text === store.snap.reportSaved) return;
  try {
    await saveReportText(store.snap.date, store.snap.reportMode, text);
    set({ reportSaved: text });
  } catch (e) {
    /* 自动保存失败不阻塞切换，用户仍可手动保存 */
  }
}

async function switchReportMode(mode) {
  if (mode === store.snap.reportMode) return;
  await flushPendingReport();
  const date = store.snap.date;
  const text = await loadSavedReport(date, mode);
  // 期间又切了模式或日期：这批结果已经过期
  if (store.snap.reportMode === mode || store.snap.date !== date) return;
  set({ reportMode: mode, report: text, reportSaved: text, streamText: "" });
}

/* ------------------------------------------------------------ 事实摘要文本 */

function buildFactsDigest(facts, gitList, opts) {
  const full = opts && opts.full;
  const maxMessages = full ? 40 : 12;
  const lines = [];

  lines.push("【日期】" + facts.range.from + (facts.range.to !== facts.range.from ? " 至 " + facts.range.to : "") + "（时区 " + facts.range.timezone + "）");
  lines.push(
    "【合计】会话 " + facts.totals.sessions + " 个 / 用户消息 " + facts.totals.userTurns +
    " 轮 / 工具调用 " + facts.totals.toolCalls + " 次 / 工具报错 " + facts.totals.toolErrors +
    " 次 / 改动文件 " + facts.totals.editedFiles + " 个"
  );

  const byId = new Map();
  for (const s of facts.sessions) byId.set(s.sessionId, s);

  const gitByWs = new Map();
  for (const g of gitList || []) gitByWs.set(g.workspace, g);

  for (const group of facts.workspaces) {
    lines.push("");
    lines.push("【工作区】" + (group.workspace || "(未知工作区)"));

    const g = gitByWs.get(group.workspace);
    if (g && g.isRepo) {
      if (g.commits.length) {
        lines.push("git 提交 " + g.commits.length + " 次：" + g.commits.map((c) => c.time + " " + c.subject).join("；"));
      } else {
        lines.push("git 提交：无");
      }
      if (g.dirty.length) {
        lines.push(
          "未提交改动 " + g.dirty.length + " 个：" +
          g.dirty.slice(0, 20).map((d) => d.code + " " + d.path).join("；")
        );
      }
    } else if (g && !g.isRepo) {
      lines.push("git：不是仓库或无法读取");
    }

    for (const id of group.sessions) {
      const s = byId.get(id);
      if (!s) continue;
      lines.push(
        "- 会话 " + String(id).slice(0, 8) +
        "（" + (hhmm(s.firstSeenAt) || "?") + "–" + (hhmm(s.lastSeenAt) || "?") +
        "，用户 " + s.userTurns + " 轮，工具 " +
        Object.values(s.tools).reduce((a, b) => a + b, 0) + " 次）" +
        (s.continuedFromEarlierDay ? " [前一天已开始]" : "")
      );

      const msgs = s.userMessages.slice(0, maxMessages);
      for (const m of msgs) lines.push("  · " + clip(oneLine(m.text), 240));
      if (s.userMessages.length > msgs.length) {
        lines.push("  · （另有 " + (s.userMessages.length - msgs.length) + " 条用户消息略）");
      }

      if (s.finalAssistantText) lines.push("  最后回复：" + clip(oneLine(s.finalAssistantText), 300));

      const toolTop = Object.entries(s.tools)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 6)
        .map(([name, n]) => name + "×" + n)
        .join(" ");
      if (toolTop) lines.push("  工具：" + toolTop);

      if (s.toolErrors.length) {
        lines.push(
          "  工具报错 " + s.toolErrors.length + " 次：" +
          s.toolErrors.slice(0, 5).map((e) => clip(oneLine(e.text), 120)).join(" | ")
        );
      }

      if (s.editedFiles.length) {
        lines.push("  改动文件 " + s.editedFiles.length + " 个：" + s.editedFiles.slice(0, 20).join(", "));
      }
    }
  }

  let out = lines.join("\n");
  if (out.length > MAX_PROMPT_CHARS) out = out.slice(0, MAX_PROMPT_CHARS) + "\n（事实过长，已截断）";
  return out;
}

/* ---------------------------------------------------------------- AI 生成 */

function runAgent(prompt, startOpts, signal) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let acc = "";
    let timer = null;
    let unlisten = null;
    let streamTimer = null;
    let expectedRunId = "";

    // 流式片段按 80ms 合并，避免每个 delta 都触发一次整棵树重渲染
    const pushStream = () => {
      if (streamTimer) return;
      streamTimer = setTimeout(() => {
        streamTimer = null;
        if (!settled) set({ streamText: acc });
      }, 80);
    };

    const finish = (err, text) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (streamTimer) {
        clearTimeout(streamTimer);
        streamTimer = null;
      }
      if (signal) {
        try {
          signal.removeEventListener("abort", onAbort);
        } catch (e) {
          /* 已失效 */
        }
      }
      if (unlisten) {
        try {
          unlisten();
        } catch (e) {
          /* 已卸载 */
        }
      }
      if (err) reject(err);
      else resolve(text);
    };

    function onAbort() {
      finish(new Error("生成已停止"));
    }

    timer = setTimeout(() => finish(new Error("生成超时，请稍后重试")), AGENT_TIMEOUT_MS);

    if (signal) {
      if (signal.aborted) {
        finish(new Error("生成已停止"));
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });
    }

    try {
      unlisten = appCtx.events.on("agent://" + PLUGIN_ID, (ev) => {
        if (settled || !ev || typeof ev !== "object") return;
        // 只接收本轮 runId 的事件，其他轮次的流不能混进来
        if (expectedRunId && ev.runId && ev.runId !== expectedRunId) return;

        const kind = ev.kind;

        if (kind === "delta") {
          const piece = typeof ev.data === "string" ? ev.data : ev.data && typeof ev.data.text === "string" ? ev.data.text : "";
          if (piece) {
            acc += piece;
            pushStream();
          }
          return;
        }
        if (kind === "message") {
          const d = ev.data;
          if (d && d.role === "assistant" && typeof d.text === "string") {
            acc = d.text;
            pushStream();
          }
          return;
        }
        if (kind === "done") {
          const finalText = ev.data && typeof ev.data.text === "string" ? ev.data.text : "";
          finish(null, (finalText || acc).trim());
          return;
        }
        if (kind === "error" || kind === "permission_denied") {
          finish(new Error("引擎返回 " + kind));
          return;
        }
        if (kind === "question") {
          finish(new Error("引擎要求交互，后台生成无法继续"));
        }
      });
    } catch (e) {
      finish(e);
      return;
    }

    Promise.resolve()
      .then(() => appCtx.agent.start(startOpts))
      .then((started) => {
        const id = started && started.runId ? String(started.runId) : "";
        if (id) {
          expectedRunId = id;
          set({ runId: id });
        }
        // 停止发生在 start resolve 之前时，宿主可能已经开始推事件
        if (signal && signal.aborted) finish(new Error("生成已停止"));
      })
      .catch((e) => finish(e));
  });
}

async function generateReport() {
  if (store.snap.generating) return;
  const facts = store.snap.facts;
  if (!facts) {
    set({ error: "请先扫描当天的会话，再生成报告。" });
    return;
  }

  const seq = ++genSeq;
  const targetDate = store.snap.date;
  const targetMode = store.snap.reportMode;
  const ctrl = new AbortController();
  activeAbort = ctrl;

  set({ generating: true, error: "", toast: "", streamText: "" });

  try {
    const cfg = store.snap.settings;
    const firstWs = facts.workspaces && facts.workspaces[0] ? facts.workspaces[0].workspace : "";
    const workspacePath = String(cfg.workspacePath || firstWs || "").trim();
    if (!workspacePath) throw new Error("没有可用于运行引擎的工作区，请在设置里填写一个已存在的目录。");

    const catalog = await appCtx.agent.catalog(workspacePath);
    if (seq !== genSeq) return;

    const preferEngine = String(cfg.engine || "").trim();
    let entry = null;
    if (preferEngine) {
      entry = catalog.find((item) => item.engine === preferEngine) || null;
      if (!entry || !entry.available) throw new Error("引擎 " + preferEngine + " 不可用。");
    } else {
      entry = catalog.find((item) => item.available) || null;
      if (!entry) throw new Error("宿主没有返回可用引擎。");
    }

    const models = (entry.models || []).filter((m) => m && typeof m.id === "string" && m.id.trim());
    const preferModel = String(cfg.model || "").trim();
    const model = preferModel || (models[0] ? models[0].id : undefined);

    const digest = buildFactsDigest(facts, store.snap.git, { full: true });
    const prompt =
      PROMPTS[targetMode].replace(/<日期>/g, facts.range.from) +
      "\n\n===== 事实 =====\n" + digest;

    const text = await runAgent(
      prompt,
      {
        engine: entry.engine,
        model: model,
        workspacePath: workspacePath,
        prompt: prompt,
        readOnly: entry.readOnly === true,
      },
      ctrl.signal
    );

    // 被停止，或已经开始新一轮：本轮结果作废
    if (seq !== genSeq) return;
    if (!text) throw new Error("模型没有返回文本。");

    await saveReportText(targetDate, targetMode, text);
    if (seq !== genSeq) return;

    const sameView = store.snap.date === targetDate && store.snap.reportMode === targetMode;
    set({ generating: false, streamText: "", runId: "" });
    if (sameView) set({ report: text, reportSaved: text });
    flash("报告已生成并保存");
  } catch (e) {
    // 停止导致的 reject 不是错误，静默退出
    if (seq !== genSeq) return;
    set({ generating: false, streamText: "", runId: "" });
    set({ error: "生成失败：" + safeError(e) });
  } finally {
    if (activeAbort === ctrl) activeAbort = null;
  }
}

async function stopGenerate() {
  // 让旧轮次的后续回调全部失效
  genSeq++;
  const runId = store.snap.runId;
  const ctrl = activeAbort;
  activeAbort = null;

  set({ generating: false, streamText: "", runId: "" });
  if (ctrl) {
    try {
      ctrl.abort();
    } catch (e) {
      /* 已经结束 */
    }
  }
  if (!runId) return;
  try {
    await appCtx.agent.interrupt(runId);
  } catch (e) {
    /* 轮次可能已经结束 */
  }
}

/* ---------------------------------------------------------------- 动作 */

async function openSession(session) {
  try {
    await appCtx.sessions.selectSession(session.engine || "claude", session.sessionId, session.workspace);
  } catch (e) {
    set({ error: "打开会话失败：" + safeError(e) });
  }
}

async function saveReport() {
  const text = store.snap.report;
  if (!text.trim()) {
    flash("报告为空，没有可保存的内容");
    return;
  }
  try {
    await saveReportText(store.snap.date, store.snap.reportMode, text);
    set({ reportSaved: text });
    flash("已保存到 " + reportRel(store.snap.date, store.snap.reportMode));
  } catch (e) {
    set({ error: "保存失败：" + safeError(e) });
  }
}

function insertReport() {
  const text = store.snap.report;
  if (!text.trim()) {
    flash("报告为空");
    return;
  }
  try {
    appCtx.composer.setDraft(text);
    flash("已插入输入框");
  } catch (e) {
    set({ error: "插入输入框失败：" + safeError(e) });
  }
}

/** 插件 SDK 没有剪贴板能力，navigator.clipboard 在部分 WebView 下不可用，留一条兜底。 */
function fallbackCopy(text) {
  if (typeof document === "undefined") throw new Error("no document");
  const el = document.createElement("textarea");
  el.value = text;
  el.setAttribute("readonly", "");
  el.style.position = "fixed";
  el.style.top = "-1000px";
  el.style.opacity = "0";
  document.body.appendChild(el);
  el.select();
  let ok = false;
  try {
    ok = document.execCommand("copy");
  } finally {
    document.body.removeChild(el);
  }
  if (!ok) throw new Error("execCommand copy failed");
}

async function copyReport() {
  const text = store.snap.report;
  if (!text.trim()) {
    flash("报告为空");
    return;
  }
  try {
    if (typeof navigator !== "undefined" && navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
      await navigator.clipboard.writeText(text);
    } else {
      fallbackCopy(text);
    }
    flash("已复制到剪贴板");
  } catch (e) {
    try {
      fallbackCopy(text);
      flash("已复制到剪贴板");
    } catch (e2) {
      set({ error: "复制失败，请手动全选复制。" });
    }
  }
}

async function changeDate(date) {
  if (!date || date === store.snap.date) return;
  await flushPendingReport();
  const mode = store.snap.reportMode;
  set({ date: date, facts: null, git: null, report: "", reportSaved: "", streamText: "", error: "" });
  const text = await loadSavedReport(date, mode);
  // 加载期间用户又换了日期或口吻
  if (store.snap.date === date && store.snap.reportMode === mode) {
    set({ report: text, reportSaved: text });
  }
}

function openSettings() {
  try {
    appCtx.ui.openSettings(PLUGIN_ID);
  } catch (e) {
    set({ error: "打开设置失败：" + safeError(e) });
  }
}

/* ---------------------------------------------------------------- 组件 */

function h(type, props) {
  const args = [type, props];
  for (let i = 2; i < arguments.length; i++) args.push(arguments[i]);
  return appCtx.react.createElement.apply(null, args);
}

function Icon() {
  return h(
    "svg",
    { width: 16, height: 16, viewBox: "0 0 16 16", fill: "none", "aria-hidden": "true" },
    h("path", {
      d: "M3 2.5h7.5L13 5v8.5H3z",
      stroke: "currentColor",
      strokeWidth: 1.2,
      strokeLinejoin: "round",
    }),
    h("path", { d: "M5 7h6M5 9.5h6M5 4.5h3", stroke: "currentColor", strokeWidth: 1.2, strokeLinecap: "round" })
  );
}

function Stat(props) {
  return h("div", { className: "wl-stat" }, h("b", null, String(props.value)), h("span", null, props.label));
}

function SessionBlock(props) {
  const R = appCtx.react;
  const open = R.useState(false);
  const isOpen = open[0];
  const setOpen = open[1];
  const s = props.session;
  const tools = Object.entries(s.tools || {})
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6);

  const messages = isOpen ? s.userMessages : s.userMessages.slice(0, 3);

  return h(
    "div",
    { className: "wl-session" },
    h(
      "div",
      { className: "wl-session-head" },
      h("span", { className: "wl-code" }, String(s.sessionId).slice(0, 8)),
      h("span", { className: "wl-muted" }, (hhmm(s.firstSeenAt) || "?") + "–" + (hhmm(s.lastSeenAt) || "?")),
      h("span", { className: "wl-dim" }, s.userTurns + " 轮 · 工具 " + Object.values(s.tools || {}).reduce((a, b) => a + b, 0) + " 次"),
      s.toolErrors.length ? h("span", { className: "wl-chip" }, "报错 " + s.toolErrors.length) : null,
      s.continuedFromEarlierDay ? h("span", { className: "wl-chip" }, "跨天") : null,
      h("span", { className: "wl-spacer" }),
      h("button", { className: "wl-btn", onClick: () => void openSession(s) }, "打开会话")
    ),
    h(
      "div",
      null,
      h("div", { className: "wl-muted" }, "用户要求："),
      h(
        "ul",
        { className: "wl-list" },
        messages.map((m, i) => h("li", { key: i, className: "wl-msg" }, clip(oneLine(m.text), 200))),
        s.userMessages.length > messages.length
          ? h("li", { className: "wl-muted" }, "另有 " + (s.userMessages.length - messages.length) + " 条")
          : null
      ),
      s.userMessages.length > 3
        ? h("button", { className: "wl-btn", onClick: () => setOpen(!isOpen) }, isOpen ? "收起" : "展开全部")
        : null
    ),
    s.finalAssistantText
      ? h("div", null, h("span", { className: "wl-muted" }, "最后回复："), h("span", { className: "wl-msg" }, clip(oneLine(s.finalAssistantText), 300)))
      : null,
    tools.length
      ? h("div", { className: "wl-dim" }, "工具：" + tools.map(([name, n]) => name + "×" + n).join("  "))
      : null,
    s.editedFiles.length
      ? h("div", { className: "wl-dim" }, "改动文件 " + s.editedFiles.length + " 个：" + s.editedFiles.slice(0, 8).map(shortPath).join(", ") + (s.editedFiles.length > 8 ? " …" : ""))
      : null
  );
}

function GitBlock(props) {
  const g = props.git;
  if (!g) return null;
  if (!g.isRepo) {
    return h("div", { className: "wl-muted" }, "git：不是仓库或无法读取" + (g.error ? "（" + g.error + "）" : ""));
  }
  return h(
    "div",
    null,
    h("div", { className: "wl-dim" }, "git 提交 " + g.commits.length + " 次"),
    g.commits.length
      ? h(
          "ul",
          { className: "wl-list" },
          g.commits.slice(0, 10).map((c, i) =>
            h("li", { key: i }, h("span", { className: "wl-code" }, c.hash), " ", h("span", { className: "wl-muted" }, c.time), " ", c.subject)
          )
        )
      : null,
    g.dirty.length
      ? h(
          "div",
          { className: "wl-dim" },
          "未提交 " + g.dirty.length + " 个：",
          g.dirty.slice(0, 10).map((d, i) =>
            h("span", { key: i, className: "wl-dirty" }, d.code.padEnd(2, " ") + " " + shortPath(d.path))
          )
        )
      : null
  );
}

function WorkspaceCard(props) {
  const group = props.group;
  const byId = props.byId;
  const sessions = group.sessions.map((id) => byId.get(id)).filter(Boolean);

  return h(
    "div",
    { className: "wl-card" },
    h(
      "div",
      { className: "wl-card-head" },
      h("span", { className: "wl-card-title" }, group.workspace || "(未知工作区)"),
      h("span", { className: "wl-muted" }, sessions.length + " 个会话 · " + group.userTurns + " 轮"),
      h("span", { className: "wl-spacer" }),
      h("span", { className: "wl-chip" }, "改动 " + group.editedFiles.length + " 个文件")
    ),
    sessions.map((s) => h(SessionBlock, { key: s.sessionId, session: s })),
    h(GitBlock, { git: findGit(group.workspace) })
  );
}

function FactsView() {
  const snap = store.snap;
  const facts = snap.facts;
  const byId = new Map();
  for (const s of facts.sessions) byId.set(s.sessionId, s);

  if (!facts.totals.sessions) {
    return h("div", { className: "wl-empty" }, "这一天没有会话记录。换个日期，或在设置里检查会话根目录。");
  }

  return h(
    "div",
    { style: { display: "flex", flexDirection: "column", gap: "12px" } },
    h(
      "div",
      { className: "wl-dim" },
      "来源核对：" + facts.totals.filesScanned + " 个会话文件 · " +
      facts.totals.sessions + " 个会话 · " +
      (facts.totals.filesFailed ? "读取失败 " + facts.totals.filesFailed + " 个 · " : "失败 0 · ") +
      "耗时 " + (facts._elapsedMs ? (facts._elapsedMs / 1000).toFixed(1) + " 秒" : "—") +
      (snap.rechecking ? " · 正在核对 git…" : "")
    ),
    h(
      "div",
      { className: "wl-stats" },
      h(Stat, { label: "会话", value: facts.totals.sessions }),
      h(Stat, { label: "用户消息", value: facts.totals.userTurns }),
      h(Stat, { label: "工具调用", value: facts.totals.toolCalls }),
      h(Stat, { label: "工具报错", value: facts.totals.toolErrors }),
      h(Stat, { label: "改动文件", value: facts.totals.editedFiles }),
      h(Stat, { label: "工作区", value: facts.totals.workspaces })
    ),
    facts.workspaces.map((group, i) => h(WorkspaceCard, { key: i, group: group, byId: byId }))
  );
}

function ReportPanel() {
  const R = appCtx.react;
  const snap = store.snap;

  // 编辑草稿留在本组件：受控于 store 时每次按键都会让整棵树重渲染
  const draftState = R.useState(snap.report);
  const draft = draftState[0];
  const setDraft = draftState[1];
  const seen = R.useRef(snap.report);

  // 生成完成、切换日期/口吻等外部变化时，用 store 的值覆盖草稿
  if (seen.current !== snap.report) {
    seen.current = snap.report;
    if (draft !== snap.report) setDraft(snap.report);
  }

  // 点按钮前先把草稿交回 store，后续动作读的才是最新内容
  const commit = () => {
    if (draft !== store.snap.report) {
      seen.current = draft;
      set({ report: draft });
    }
  };

  const modeLabel = snap.reportMode === "retro" ? "复盘" : "日报";
  const hasReport = !!draft.trim();
  const canGenerate = !!snap.facts && !snap.generating;

  return h(
    "div",
    { className: "wl-card wl-report" },
    h(
      "div",
      { className: "wl-report-head" },
      h("span", { className: "wl-card-title" }, "报告"),
      h("button", { className: "wl-btn" + (snap.reportMode === "daily" ? " primary" : ""), onClick: () => void switchReportMode("daily") }, "日报"),
      h("button", { className: "wl-btn" + (snap.reportMode === "retro" ? " primary" : ""), onClick: () => void switchReportMode("retro") }, "复盘"),
      h("span", { className: "wl-spacer" }),
      snap.generating
        ? h("button", { className: "wl-btn danger", onClick: () => void stopGenerate() }, "停止")
        : h("button", { className: "wl-btn primary", disabled: !canGenerate, onClick: () => void generateReport() }, "生成" + modeLabel)
    ),
    snap.generating
      ? h("div", { className: "wl-stream" }, snap.streamText || "正在等待模型返回…")
      : null,
    !snap.generating && !hasReport
      ? h("div", { className: "wl-muted" }, "扫描后点「生成" + modeLabel + "」，模型会依据上面的事实写成文字。生成前不消耗任何 token。")
      : null,
    hasReport || snap.generating
      ? h("textarea", {
          className: "wl-textarea",
          value: draft,
          spellCheck: false,
          onChange: (e) => setDraft(e.target.value),
          onBlur: commit,
          placeholder: "报告会出现在这里，可以直接修改。",
        })
      : null,
    hasReport
      ? h(
          "div",
          { className: "wl-report-head" },
          h("button", {
            className: "wl-btn",
            onClick: () => {
              commit();
              void saveReport();
            },
          }, "保存"),
          h("button", {
            className: "wl-btn",
            onClick: () => {
              commit();
              insertReport();
            },
          }, "插入输入框"),
          h("button", {
            className: "wl-btn",
            onClick: () => {
              commit();
              void copyReport();
            },
          }, "复制"),
          h("span", { className: "wl-spacer" }),
          h("span", { className: "wl-muted" }, draft.length + " 字符")
        )
      : null
  );
}

function CenterTab() {
  const snap = useSnap();
  appCtx.react.useEffect(() => {
    void checkEnv(false);
  }, []);

  return h(
    "div",
    { className: "wl-root" },
    h(
      "div",
      { className: "wl-head" },
      h("span", { className: "wl-title" }, "工作志"),
      h("input", {
        type: "date",
        className: "wl-input",
        value: snap.date,
        onChange: (e) => void changeDate(e.target.value),
      }),
      h("button", { className: "wl-btn primary", disabled: snap.scanning, onClick: () => void doScan() }, snap.scanning ? "扫描中…" : "扫描当天"),
      h("button", { className: "wl-btn", onClick: () => openSettings() }, "设置"),
      h("span", { className: "wl-spacer" }),
      snap.facts ? h("span", { className: "wl-chip" }, "扫描于 " + (hhmm(snap.facts.scannedAt) || "—")) : null
    ),
    snap.error ? h("div", { className: "wl-error" }, snap.error) : null,
    snap.toast ? h("div", { className: "wl-toast" }, snap.toast) : null,
    snap.facts
      ? h(FactsView)
      : h("div", { className: "wl-empty" }, "还没有扫描。点「扫描当天」读取这一天的会话记录；整个过程只读本地文件，不消耗 token。"),
    h(ReportPanel)
  );
}

function SettingsSection() {
  const R = appCtx.react;
  const snap = useSnap();
  const formState = R.useState(null);
  const form = formState[0] || snap.settings;
  const setForm = formState[1];

  function patch(key, value) {
    setForm((prev) => Object.assign({}, prev || snap.settings, { [key]: value }));
  }

  async function save() {
    await writeSettings(form);
    await checkEnv(true);
    flash("设置已保存");
  }

  R.useEffect(() => {
    void checkEnv(false);
  }, []);

  return h(
    "div",
    { className: "wl-settings" },
    h(
      "div",
      { className: "wl-card" },
      h(
        "div",
        { className: "wl-card-head" },
        h("span", { className: "wl-card-title" }, "环境自检"),
        h("span", { className: "wl-spacer" }),
        h(
          "button",
          { className: "wl-btn", disabled: snap.envChecking, onClick: () => void checkEnv(true) },
          snap.envChecking ? "检测中…" : "重新检测"
        )
      ),
      h(
        "div",
        { className: "wl-env" },
        h("div", null, "node  " + envLine(snap.env && snap.env.node)),
        h("div", null, "git   " + envLine(snap.env && snap.env.git))
      ),
      h(
        "span",
        { className: "wl-hint" },
        "插件经宿主按命令名执行 node 与 git，不使用绝对路径。若显示未找到，请确认已安装并加入系统 PATH，或在下方补充它们所在的目录。"
      )
    ),
    h(
      "div",
      { className: "wl-field" },
      h("label", null, "额外的可执行文件目录"),
      h("input", {
        className: "wl-input",
        value: form.extraPath || "",
        placeholder: "例如 D:\\IDEAjava\\nodejs；多个目录用本机 PATH 分隔符（Windows 为 ; ，macOS/Linux 为 :）",
        onChange: (e) => patch("extraPath", e.target.value),
      }),
      h("span", { className: "wl-hint" }, "只在自检报告「未找到」时才需要填。宿主会把这个目录排在搜索顺序最前面。")
    ),
    h(
      "div",
      { className: "wl-field" },
      h("label", null, "会话根目录"),
      h("input", {
        className: "wl-input",
        value: form.sessionRoot || "",
        placeholder: "留空则使用 ~/.claude/projects",
        onChange: (e) => patch("sessionRoot", e.target.value),
      }),
      h("span", { className: "wl-hint" }, "Claude Code 的会话日志目录，插件只读不写。")
    ),
    h(
      "div",
      { className: "wl-field" },
      h("label", null, "生成报告用的引擎"),
      h("input", {
        className: "wl-input",
        value: form.engine || "",
        placeholder: "留空则自动选择第一个可用引擎",
        onChange: (e) => patch("engine", e.target.value),
      }),
      h("span", { className: "wl-hint" }, "例如 claude。只有点「生成报告」时才会调用模型。")
    ),
    h(
      "div",
      { className: "wl-field" },
      h("label", null, "模型"),
      h("input", {
        className: "wl-input",
        value: form.model || "",
        placeholder: "留空则使用该引擎的第一个可用模型",
        onChange: (e) => patch("model", e.target.value),
      })
    ),
    h(
      "div",
      { className: "wl-field" },
      h("label", null, "报告生成的工作区"),
      h("input", {
        className: "wl-input",
        value: form.workspacePath || "",
        placeholder: "留空则使用当天第一个会话的工作区",
        onChange: (e) => patch("workspacePath", e.target.value),
      }),
      h("span", { className: "wl-hint" }, "只作为 agent 进程的当前目录，报告读的是扫描结果，不依赖这个目录里的文件。")
    ),
    h(
      "label",
      { className: "wl-check" },
      h("input", {
        type: "checkbox",
        checked: form.gitReconcile !== false,
        onChange: (e) => patch("gitReconcile", e.target.checked),
      }),
      "扫描的同时核对每个工作区的 git 提交与未提交改动"
    ),
    h(
      "div",
      { className: "wl-field" },
      h("label", null, "打开时默认的报告口吻"),
      h(
        "select",
        { className: "wl-input", value: form.tone || "daily", onChange: (e) => patch("tone", e.target.value) },
        h("option", { value: "daily" }, "工作日报"),
        h("option", { value: "retro" }, "个人复盘")
      )
    ),
    h("div", null, h("button", { className: "wl-btn primary", onClick: () => void save() }, "保存设置")),
    h("div", { className: "wl-muted" }, "版本 " + (appCtx && appCtx.version ? appCtx.version : PLUGIN_VERSION) + " · 数据只留在这台机器上，插件不上传任何内容。")
  );
}

/* ---------------------------------------------------------------- 激活 */

async function bootstrap() {
  const settings = await readSettings();
  if (!appCtx) return;
  const mode = settings.tone === "retro" ? "retro" : "daily";
  set({ settings: settings, ready: true, reportMode: mode });
  const saved = await loadSavedReport(store.snap.date, mode);
  if (saved) set({ report: saved, reportSaved: saved });
}

function sidebarBadge() {
  const facts = store.snap.facts;
  if (facts && facts.totals && facts.totals.sessions > 0) return facts.totals.sessions;
  return null;
}

export default function activate(ctx) {
  appCtx = ctx;
  const disposers = [];

  try {
    disposers.push(ctx.theme.injectCss(CSS));
  } catch (e) {
    /* 主题注入失败不影响功能 */
  }

  disposers.push(
    ctx.ui.registerCenterTab({
      key: TAB_KEY,
      title: () => "工作志",
      icon: Icon,
      component: CenterTab,
      order: 45,
    })
  );

  disposers.push(
    ctx.ui.registerSidebarNav({
      key: PLUGIN_ID,
      label: () => "工作志",
      icon: Icon,
      order: 45,
      badge: sidebarBadge,
      onOpen: () => {
        try {
          ctx.ui.openCenterTab(TAB_KEY);
        } catch (e) {
          set({ error: "打开工作志失败：" + safeError(e) });
        }
      },
    })
  );

  disposers.push(
    ctx.ui.registerSettingsSection({
      key: PLUGIN_ID,
      label: () => "工作志",
      icon: Icon,
      component: SettingsSection,
    })
  );

  disposers.push(
    ctx.ui.registerCommand({
      key: PLUGIN_ID,
      title: () => "工作志：查看今日工作志",
      keywords: () => ["worklog", "工作志", "日报", "复盘", "日志", "journal"],
      run: () => {
        try {
          ctx.ui.openCenterTab(TAB_KEY);
        } catch (e) {
          set({ error: "打开工作志失败：" + safeError(e) });
        }
      },
    })
  );

  void bootstrap();

  return () => {
    if (toastTimer) clearTimeout(toastTimer);
    for (const d of disposers) {
      try {
        if (typeof d === "function") d();
      } catch (e) {
        /* 已卸载 */
      }
    }
    store.listeners.clear();
    appCtx = null;
  };
}
