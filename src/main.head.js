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
// 用户最后停在哪个口吻。宿主重新激活插件（切页签、热重载）时靠它恢复，
// 不能让「刚选好的自定义口吻」在回来时退回到默认口吻。
const VIEW_KEY = "worklog.view.v1";
const SCAN_REL = "runtime/scan.mjs";
const REPORTS_DIR = "reports";
const MAX_PROMPT_CHARS = 20000;
const AGENT_TIMEOUT_MS = 10 * 60 * 1000;
const SCAN_TIMEOUT_MS = 120 * 1000;
const GIT_TIMEOUT_MS = 20000;
// 扫描器对没有 cwd 的会话使用的占位符；不能当作真实目录传给引擎
const UNKNOWN_WORKSPACE = "(未知工作区)";
// 同时跑多少个 git 对账；工作区多时避免一次拉起几十个子进程
const GIT_CONCURRENCY = 4;

const DEFAULT_SETTINGS = {
  sessionRoot: "",
  engine: "",
  model: "",
  workspacePath: "",
  // 宿主只按命令名找 node/git；这里是可以追加到 PATH 前面的目录列表
  extraPaths: [],
  gitReconcile: true,
  tone: "daily",
  // 用户自定义的报告口吻；内置三种（daily/retro/weekly）不在这里
  customTones: [],
};

/** 扫描器目前只实现了 Claude Code 的日志适配器；其它引擎没有真实样本前不臆造。
 *  这只限制「扫描什么日志」，不限制用哪个引擎来写报告。 */
const SCAN_ENGINE_ID = "claude";
const SCAN_ENGINE_LABEL = "Claude Code";

/** 日期范围预设：单日 / 本周 / 自定义。 */
const PRESETS = [
  { value: "day", label: "单日" },
  { value: "week", label: "本周" },
  { value: "custom", label: "自定义" },
];

const MAX_CUSTOM_TONES = 6;
// 单个自定义口吻的名称/模板上限；设置页的输入框与 sanitizeCustomTones 共用
const MAX_TONE_LABEL = 24;
const MAX_TONE_PROMPT = 8000;
const TONE_ID_RE = /^[a-z][a-z0-9]{0,15}$/;
// 口吻 id 之后会直接拼进报告文件名；除格式外还要挡住 Object 原型上的名字
const RESERVED_TONE_IDS = Object.getOwnPropertyNames(Object.prototype).map((k) => k.toLowerCase());
// 报告历史只给最近这么多份读大小；再多的只靠文件名列出，避免开个面板读上百个文件
const MAX_REPORT_LIST_READ = 40;
// 未保存草稿的持久化：只留最近这么多份、总长不超过这个数，避免 storage 无限增长
const DRAFTS_KEY = "worklog.drafts.v1";
const MAX_DRAFT_ENTRIES = 20;
const MAX_DRAFT_CHARS = 200000;
const DRAFT_PERSIST_DELAY_MS = 400;
// 自定义范围一次最多看这么多天：再长就接近扫全库，node 子进程会超时，
// 界面上也会长时间停在「扫描中」。
const MAX_RANGE_DAYS = 92;

/**
 * 引擎显示名。宿主的 catalog 只回 engine id，界面上给全名更好认。
 * 键与 ccgui 的 AgentFrameProviderSection 枚举一致；表里没有的回退成 id 本身。
 */
const ENGINE_LABELS = {
  claude: "Claude Code",
  codex: "Codex",
  opencode: "OpenCode",
  qoder: "Qoder",
  "qoder-cn": "Qoder (CN)",
  kimi: "Kimi CLI",
  grok: "Grok CLI",
  codebuddy: "CodeBuddy",
  minimax: "MiniMax",
  omp: "OMP",
  dsh: "DSH",
  agy: "AGY",
  pi: "Pi",
};

function engineLabel(id) {
  const key = String(id || "").trim();
  if (!key) return "";
  const lower = key.toLowerCase();
  // 宿主 catalog 的 id 是不可信输入：只认表里的自有属性，别把 constructor 之类当引擎名
  const hit =
    Object.prototype.hasOwnProperty.call(ENGINE_LABELS, key) ? ENGINE_LABELS[key]
      : Object.prototype.hasOwnProperty.call(ENGINE_LABELS, lower) ? ENGINE_LABELS[lower]
        : "";
  return hit || key;
}

/** 可用的排前面，组内按显示名首字母排序（与 CLI 安装检测插件一致）。 */
function sortEngines(list) {
  return (Array.isArray(list) ? list.slice() : []).sort((a, b) => {
    const ai = a && a.available === false ? 1 : 0;
    const bi = b && b.available === false ? 1 : 0;
    if (ai !== bi) return ai - bi;
    return engineLabel(a && a.engine).localeCompare(engineLabel(b && b.engine), "en");
  });
}

/*__SCAN_SOURCE__*/

const CSS = `
/* 设计方向：achromatic-ledger（浅色账本风格）。
 * chrome 不含品牌色，数字用 ink，唯一的蓝（--wl-accent）只落在当天时间线上。
 * 唯一的“脸”是时间线：每个工作区一行，横轴 00–24 点。
 * 宿主在 <html> 上打 .dark，这里据此切换一套 token。 */
/* token 同时挂在中心页签与设置区上：两者是独立的宿主容器。 */
.wl-root, .wl-settings {
  --wl-ground:#f7f8fa; --wl-surface:#ffffff; --wl-raised:#f6f7f9;
  --wl-border:#e6e6e6; --wl-rule:#f0f0f0; --wl-control:#d4d4d4;
  --wl-text:#0a0a0a; --wl-muted:#6b6b6b; --wl-faint:#8a8a8a;
  --wl-primary:#141414; --wl-primary-ink:#ffffff;
  --wl-accent:#1d5fbf;
  --wl-positive:#2e7d32; --wl-negative:#c4242a;
  --wl-neg-bg:#ffedea; --wl-neg-ink:#831c1e;
  --wl-warn-bg:#fffbeb; --wl-warn-ink:#92400e; --wl-warn-border:#fde68a;
  --wl-r-card:10px; --wl-r-ctl:6px;
}
.wl-root {
  box-sizing:border-box; height:100%; min-height:0; overflow:auto;
  padding:24px 32px 48px; background:var(--wl-ground); color:var(--wl-text);
  font-family:-apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",system-ui,sans-serif;
  font-size:14px; line-height:1.6; color-scheme:light dark;
  -webkit-font-smoothing:antialiased;
}
.wl-settings { color:var(--wl-text); font-size:14px; line-height:1.6; }
html.dark .wl-root, .dark .wl-root, html.dark .wl-settings, .dark .wl-settings {
  --wl-ground:#0f1012; --wl-surface:#17191c; --wl-raised:#1d2024;
  --wl-border:#2a2d32; --wl-rule:#212429; --wl-control:#3a3e44;
  --wl-text:#f2f3f5; --wl-muted:#a3a7ad; --wl-faint:#7d828a;
  --wl-primary:#f2f3f5; --wl-primary-ink:#0b0c0d;
  --wl-accent:#5b9bf0;
  --wl-positive:#4fc27a; --wl-negative:#e5566f;
  --wl-neg-bg:#2c1a20; --wl-neg-ink:#f0a0b0;
  --wl-warn-bg:#241f14; --wl-warn-ink:#e8b866; --wl-warn-border:#4a3c1f;
}
@media (prefers-color-scheme: dark) {
  html:not(.light) .wl-root, html:not(.light) .wl-settings {
    --wl-ground:#0f1012; --wl-surface:#17191c; --wl-raised:#1d2024;
    --wl-border:#2a2d32; --wl-rule:#212429; --wl-control:#3a3e44;
    --wl-text:#f2f3f5; --wl-muted:#a3a7ad; --wl-faint:#7d828a;
    --wl-primary:#f2f3f5; --wl-primary-ink:#0b0c0d;
    --wl-accent:#5b9bf0;
    --wl-positive:#4fc27a; --wl-negative:#e5566f;
    --wl-neg-bg:#2c1a20; --wl-neg-ink:#f0a0b0;
    --wl-warn-bg:#241f14; --wl-warn-ink:#e8b866; --wl-warn-border:#4a3c1f;
  }
}

.wl-wrap { max-width:1080px; margin:0 auto; display:flex; flex-direction:column; gap:16px; container-type:inline-size; }
.wl-num { font-variant-numeric:tabular-nums; }
.wl-muted { color:var(--wl-muted); }

/* ---------- 标题行 ---------- */
/* 标题行只放标题与右侧固定按钮：日期范围另占一行，切换预设时不会把「扫描」挤到下一行 */
.wl-head { display:flex; flex-direction:column; gap:8px; }
.wl-head-row { display:flex; align-items:center; gap:10px; flex-wrap:nowrap; }
.wl-title { margin:0; font-size:24px; font-weight:600; letter-spacing:-.01em; line-height:1.25; flex:none; }
/* 日期范围与扫描按钮一行：预设固定三项，宽度不随状态变化，右侧按钮不会跳
 * 「自定义」只多出两个日期框，在日期区内部换行，不把整行挤开。 */
.wl-head-tools { display:flex; align-items:center; gap:10px; flex-wrap:nowrap; min-height:36px; }
.wl-head-tools .wl-range { flex:0 1 auto; min-width:0; }
/* 扫描按钮在「扫描 / 扫描中…」之间切换时宽度不变，右侧按钮不会跟着挪 */
.wl-btn-scan { min-width:96px; }
.wl-sub { margin:0; font-size:13px; color:var(--wl-muted); }
.wl-sub b { font-weight:500; color:var(--wl-text); }
.wl-spacer { flex:1 1 auto; }

/* ---------- 控件 ---------- */
.wl-btn {
  appearance:none; display:inline-flex; align-items:center; justify-content:center; gap:6px;
  height:32px; padding:0 12px; box-sizing:border-box;
  border:1px solid var(--wl-control); border-radius:var(--wl-r-ctl);
  background:var(--wl-surface); color:var(--wl-text);
  font:inherit; font-size:13px; line-height:1; cursor:pointer; white-space:nowrap;
}
.wl-btn:hover:not(:disabled) { background:var(--wl-raised); }
.wl-btn:disabled { opacity:.5; cursor:not-allowed; }
.wl-btn.primary { border-color:var(--wl-primary); background:var(--wl-primary); color:var(--wl-primary-ink); font-weight:500; }
.wl-btn.primary:hover:not(:disabled) { opacity:.88; background:var(--wl-primary); }
.wl-btn.ghost { border-color:transparent; background:transparent; color:var(--wl-muted); height:28px; padding:0 8px; }
.wl-btn.ghost:hover:not(:disabled) { background:var(--wl-raised); color:var(--wl-text); }
.wl-btn.block { width:100%; height:36px; font-size:14px; }
.wl-btn.danger { border-color:var(--wl-negative); color:var(--wl-negative); background:transparent; }

/* 进行中的转圈：与参考插件同一套观感，颜色走 token */
@keyframes wl-spin { to { transform:rotate(360deg); } }
.wl-spinner {
  display:inline-block; flex:none; width:12px; height:12px; box-sizing:border-box;
  border:2px solid var(--wl-control); border-top-color:var(--wl-accent); border-radius:50%;
  animation:wl-spin .8s linear infinite;
}
.wl-btn-inner { display:inline-flex; align-items:center; gap:6px; }
.wl-btn.primary .wl-spinner { border-color:rgba(127,127,127,.35); border-top-color:currentColor; }
@media (prefers-reduced-motion: reduce) { .wl-spinner { animation:none; } }

.wl-input {
  height:32px; box-sizing:border-box; padding:0 10px;
  border:1px solid var(--wl-control); border-radius:var(--wl-r-ctl);
  background:var(--wl-surface); color:var(--wl-text); font:inherit; font-size:13px;
}
.wl-input:focus { outline:2px solid var(--wl-accent); outline-offset:-1px; }
.wl-input::placeholder { color:var(--wl-faint); }
.wl-input[type="date"] { width:136px; }

/* 下拉：按钮 + 自绘列表。原生 select 的展开层由系统绘制，在宿主 WebView 里不跟主题；
   自绘列表才能保证浅色/深色、字号、行高与输入框完全一致。 */
.wl-dd { position:relative; width:100%; }
.wl-dd-trigger {
  appearance:none; display:flex; align-items:center; gap:10px;
  width:100%; height:36px; box-sizing:border-box; padding:0 12px;
  border:1px solid var(--wl-control); border-radius:var(--wl-r-ctl);
  background:var(--wl-surface); color:var(--wl-text); text-align:left;
  font:inherit; font-size:13px; cursor:pointer;
}
.wl-dd-trigger:hover:not(:disabled) { border-color:var(--wl-faint); }
.wl-dd-trigger:focus-visible { outline:2px solid var(--wl-accent); outline-offset:-1px; }
.wl-dd-trigger:disabled { opacity:.55; cursor:not-allowed; }
.wl-dd.is-open .wl-dd-trigger { border-color:var(--wl-accent); }
.wl-dd-value { flex:1 1 auto; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.wl-dd-value.is-empty { color:var(--wl-muted); }
.wl-dd-caret {
  flex:none; width:6px; height:6px; margin-top:-3px;
  border-right:1.5px solid var(--wl-muted); border-bottom:1.5px solid var(--wl-muted);
  transform:rotate(45deg); transition:transform .15s ease, margin .15s ease;
}
.wl-dd.is-open .wl-dd-caret { transform:rotate(-135deg); margin-top:3px; }
.wl-dd-scrim { position:fixed; inset:0; z-index:80; }
.wl-dd-menu {
  position:absolute; top:calc(100% + 6px); left:0; right:0; z-index:81;
  max-height:260px; overflow-y:auto; box-sizing:border-box; padding:4px;
  border:1px solid var(--wl-border); border-radius:10px;
  background:var(--wl-surface); box-shadow:0 8px 24px rgba(0,0,0,.16);
}
/* 靠近视口底部时向上弹，避免菜单被裁掉 */
.wl-dd.is-up .wl-dd-menu { top:auto; bottom:calc(100% + 6px); }
html.dark .wl-dd-menu, .dark .wl-dd-menu { box-shadow:0 8px 24px rgba(0,0,0,.45); }
.wl-dd-item {
  display:flex; align-items:center; gap:8px; min-height:32px; padding:5px 10px;
  border-radius:6px; font-size:13px; line-height:1.4; color:var(--wl-text); cursor:pointer;
}
.wl-dd-item.is-active { background:var(--wl-raised); }
.wl-dd-item.is-disabled { opacity:.45; cursor:default; }
.wl-dd-item.is-disabled.is-active { background:transparent; }
.wl-dd-label { flex:1 1 auto; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.wl-dd-check { flex:none; font-size:12px; color:var(--wl-accent); opacity:0; }
.wl-dd-item[aria-selected="true"] .wl-dd-check { opacity:1; }
.wl-dd-empty { padding:8px 10px; font-size:12px; color:var(--wl-muted); }

.wl-seg { display:inline-flex; padding:2px; gap:2px; border-radius:var(--wl-r-ctl); background:var(--wl-raised); border:1px solid var(--wl-border); }
.wl-seg button {
  appearance:none; border:0; background:transparent; color:var(--wl-muted);
  height:26px; padding:0 10px; border-radius:4px; font:inherit; font-size:12px; cursor:pointer;
}
.wl-seg button.on { background:var(--wl-surface); color:var(--wl-text); font-weight:500; }
.wl-seg button:disabled { opacity:.45; cursor:not-allowed; }

/* ---------- 提示 ---------- */
.wl-error, .wl-toast {
  border-radius:8px; padding:9px 12px; font-size:13px;
  border:1px solid var(--wl-border); background:var(--wl-surface);
}
.wl-error { border-color:var(--wl-neg-ink); background:var(--wl-neg-bg); color:var(--wl-neg-ink); }
/* 操作反馈固定贴在视口底部：页面滚到哪、按钮点在哪都能看见，不再依赖页面顶部的提示条 */
.wl-toast {
  position:fixed; left:50%; bottom:24px; transform:translateX(-50%);
  z-index:120; width:max-content; max-width:min(440px, calc(100vw - 32px));
  box-sizing:border-box; color:var(--wl-text);
  box-shadow:0 8px 24px rgba(0,0,0,.18);
  animation:wl-toast-in .16s ease;
}
html.dark .wl-toast, .dark .wl-toast { box-shadow:0 8px 24px rgba(0,0,0,.5); }
@keyframes wl-toast-in {
  from { opacity:0; transform:translate(-50%, 6px); }
  to { opacity:1; transform:translate(-50%, 0); }
}
@media (prefers-reduced-motion: reduce) { .wl-toast { animation:none; } }

/* ---------- KPI 分栏条：一个容器 + 1px 分隔线 ---------- */
.wl-stats {
  display:grid; grid-template-columns:repeat(6,minmax(0,1fr));
  border:1px solid var(--wl-border); border-radius:var(--wl-r-card);
  background:var(--wl-surface); overflow:hidden;
}
.wl-stat { padding:13px 16px; border-left:1px solid var(--wl-rule); min-width:0; }
.wl-stat:first-child { border-left:0; }
.wl-stat span { display:block; font-size:12px; color:var(--wl-muted); line-height:1.4; white-space:nowrap; }
.wl-stat b { display:block; margin-top:2px; font-size:24px; font-weight:500; line-height:1.2; font-variant-numeric:tabular-nums; letter-spacing:-.01em; }

/* ---------- 两栏 ---------- */
.wl-body { display:grid; grid-template-columns:minmax(0,1fr) 372px; gap:16px; align-items:start; }
.wl-main { display:flex; flex-direction:column; gap:16px; min-width:0; }

/* ---------- 时间线（产品独有的元素，唯一的数据色） ---------- */
.wl-timeline {
  display:flex; flex-direction:column; gap:10px;
  border:1px solid var(--wl-border); border-radius:var(--wl-r-card);
  background:var(--wl-surface); padding:16px 18px 12px;
}
.wl-timeline-head { display:flex; align-items:baseline; gap:8px; }
.wl-timeline-head h2 { margin:0; font-size:14px; font-weight:600; }
.wl-timeline-head span { font-size:12px; color:var(--wl-muted); }
.wl-track-row { display:flex; align-items:center; gap:12px; height:28px; }
.wl-track-name { flex:0 0 128px; font-size:12px; color:var(--wl-muted); text-align:right; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.wl-track { position:relative; flex:1 1 auto; height:6px; border-radius:3px; background:var(--wl-rule); }
.wl-track-bar { position:absolute; top:0; bottom:0; border-radius:3px; background:var(--wl-accent); min-width:3px; }
.wl-track-ends { flex:0 0 84px; font-size:11px; color:var(--wl-muted); font-variant-numeric:tabular-nums; white-space:nowrap; }
.wl-axis { display:flex; justify-content:space-between; margin-left:140px; margin-right:96px; font-size:11px; color:var(--wl-faint); font-variant-numeric:tabular-nums; }

/* ---------- 工作区账页 ---------- */
.wl-card { border:1px solid var(--wl-border); border-radius:var(--wl-r-card); background:var(--wl-surface); overflow:hidden; }
.wl-card-head { display:flex; align-items:center; gap:10px; flex-wrap:wrap; padding:14px 18px; border-bottom:1px solid var(--wl-rule); }
.wl-card > summary { cursor:pointer; list-style:none; }
.wl-card > summary::-webkit-details-marker { display:none; }
.wl-card > summary:focus-visible { outline:2px solid var(--wl-accent); outline-offset:-2px; }
.wl-card-caret {
  flex:none; width:7px; height:7px; margin-right:2px;
  border-right:1.5px solid var(--wl-muted); border-bottom:1.5px solid var(--wl-muted);
  transform:rotate(-45deg); transition:transform .15s ease;
}
.wl-card[open] > summary .wl-card-caret { transform:rotate(45deg); }
.wl-card-ignore { margin-left:2px; }
.wl-card-ignore:hover:not(:disabled) { color:var(--wl-negative); }
.wl-card-title { margin:0; font-size:16px; font-weight:600; line-height:1.3; word-break:break-all; }
.wl-card-path { font-size:12px; color:var(--wl-muted); word-break:break-all; }
.wl-card-meta { margin-left:auto; display:flex; gap:6px; flex-wrap:wrap; }
.wl-chip {
  display:inline-flex; align-items:center; height:20px; padding:0 8px; flex:none;
  border-radius:4px; background:var(--wl-raised); color:var(--wl-muted);
  font-size:11px; white-space:nowrap; font-variant-numeric:tabular-nums;
}
.wl-chip.warn { background:var(--wl-warn-bg); color:var(--wl-warn-ink); }
.wl-chip.neg { background:var(--wl-neg-bg); color:var(--wl-neg-ink); }

.wl-session { padding:14px 18px; border-top:1px solid var(--wl-rule); display:flex; flex-direction:column; gap:8px; }
.wl-session:first-of-type { border-top:0; }
.wl-session-head { display:flex; align-items:center; gap:10px; flex-wrap:wrap; }
.wl-session-time { font-size:12px; font-variant-numeric:tabular-nums; color:var(--wl-text); }
.wl-session-id { font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace; font-size:11px; color:var(--wl-muted); }
.wl-session-meta { font-size:12px; color:var(--wl-muted); font-variant-numeric:tabular-nums; }
.wl-session-head .wl-btn { margin-left:auto; }

.wl-label { display:block; font-size:11px; font-weight:500; color:var(--wl-muted); }
.wl-list { margin:4px 0 0; padding-left:18px; }
.wl-list li { margin:0; font-size:14px; line-height:1.55; }
.wl-msg { white-space:pre-wrap; word-break:break-word; }
.wl-note { font-size:13px; line-height:1.6; display:-webkit-box; -webkit-line-clamp:3; -webkit-box-orient:vertical; overflow:hidden; }
.wl-code { font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace; font-size:11px; color:var(--wl-muted); }
.wl-files { font-size:12px; color:var(--wl-muted); line-height:1.6; }

.wl-git { padding:12px 18px; border-top:1px solid var(--wl-rule); background:var(--wl-raised); display:flex; flex-direction:column; gap:6px; }
.wl-git-line { font-size:12px; color:var(--wl-muted); }
.wl-git-line b { font-weight:500; color:var(--wl-text); font-variant-numeric:tabular-nums; }
.wl-commit { display:flex; gap:8px; font-size:12px; line-height:1.5; }
.wl-commit .hash { font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace; color:var(--wl-faint); flex:none; }
.wl-commit .time { color:var(--wl-muted); flex:none; font-variant-numeric:tabular-nums; }
.wl-commit .subject { color:var(--wl-text); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.wl-dirty-item { display:inline-block; margin:0 8px 2px 0; font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace; font-size:11px; color:var(--wl-muted); }

/* ---------- 空态 ---------- */
.wl-empty {
  border:1px dashed var(--wl-control); border-radius:var(--wl-r-card);
  background:var(--wl-surface); padding:28px 20px; text-align:center; color:var(--wl-muted); font-size:13px;
}
.wl-empty b { display:block; margin-bottom:4px; color:var(--wl-text); font-size:14px; font-weight:500; }

/* ---------- 报告面板 ---------- */
.wl-report {
  display:flex; flex-direction:column; gap:10px; min-width:0;
  border:1px solid var(--wl-border); border-radius:var(--wl-r-card);
  background:var(--wl-surface); padding:16px;
  position:sticky; top:0;
}
/* 头部分两行：第一行固定是标题 + 范围 + 原文/预览，第二行专门放口吻。
 * 口吻数量变化时只影响第二行内部，上面的东西不会左右挪。 */
.wl-report-head { display:flex; align-items:center; gap:8px; flex-wrap:nowrap; min-height:28px; }
.wl-report-head h2 { margin:0; font-size:16px; font-weight:600; flex:none; }
.wl-report-range { flex:0 1 auto; min-width:0; }
.wl-report-tabs { display:flex; align-items:center; gap:8px; min-height:32px; }
/* 内置三个口吻固定成按钮；自定义口吻收进右侧下拉，不再横向滚动。
 * 横向滚动等于把后面的口吻藏起来——用户根本发现不了，也点不到。 */
.wl-seg-tones { flex:0 1 auto; min-width:0; }
.wl-tone-pick { flex:none; width:132px; }
.wl-tone-pick .wl-dd-trigger { height:30px; padding:0 8px; font-size:12px; border-radius:var(--wl-r-ctl); }
.wl-tone-pick .wl-dd-value { font-size:12px; }
/* 下拉里选中的是自定义口吻时，用描边标出来，和左侧按钮的选中态区分开 */
.wl-tone-pick.is-current .wl-dd-trigger { border-color:var(--wl-accent); color:var(--wl-text); }
.wl-report-state { margin:0; font-size:12px; color:var(--wl-muted); }
/* 生成中的状态行：字色提到正常文本级，前面挂一个呼吸点，和下面流式区呼应。
 * 圆点用 inline-block 而不是 flex 容器：flex 的高度由内容算，和旁边那行纯文本
 * 的行高对不齐，会让这一行比别的状态高 2px，面板跟着长高。 */
.wl-state-live { color:var(--wl-text); }
.wl-state-live::before {
  content:""; display:inline-block; vertical-align:.05em; margin-right:6px;
  width:6px; height:6px; border-radius:50%; background:var(--wl-accent);
  animation:wl-dot 1.25s ease-in-out infinite;
}
@media (prefers-reduced-motion: reduce) { .wl-state-live::before { animation:none; opacity:.7; } }
.wl-report-actions { display:flex; gap:6px; }
.wl-report-actions .wl-btn { flex:1 1 auto; }
/* 编辑区高度固定：生成前是占位框，生成中是流式区，生成后是编辑区。
 * 三者公用同一个 340px 的槽位，面板高度不会随着状态切换忽大忽小。 */
.wl-report-body { min-height:340px; display:flex; flex-direction:column; gap:8px; }
.wl-report-body > * { flex:1 1 auto; }
.wl-report-empty {
  display:flex; align-items:center; justify-content:center; text-align:center;
  box-sizing:border-box; min-height:340px; padding:24px 20px;
  border:1px dashed var(--wl-control); border-radius:8px;
  color:var(--wl-muted); font-size:13px; line-height:1.7;
}
.wl-report-empty-inner { min-width:0; }
/* 范围与口吻不匹配时的说明：不挡生成，只把后果讲清楚 */
.wl-report-hint { margin:8px 0 0; font-size:12px; line-height:1.6; color:var(--wl-text); }
.wl-report-hint.is-quiet { color:var(--wl-faint); }
.wl-report-foot { display:flex; align-items:center; gap:6px; flex-wrap:wrap; }
.wl-report-foot .wl-spacer { flex:1 1 auto; }
/* 保存 / 保存中… 的文案长度不同：给一个下限，旁边「复制全文」不会跟着挪 */
.wl-report-foot .wl-btn { min-width:88px; }
/* 路径留两行高度：目录尚未就绪时是短路径，就绪后变长，面板底部不会突然变矮 */
.wl-report-path { margin:0; min-height:34px; font-size:12px; color:var(--wl-faint); line-height:1.5; word-break:break-all; }
.wl-textarea {
  width:100%; min-height:340px; flex:1 1 auto; box-sizing:border-box; resize:vertical;
  border:1px solid var(--wl-control); border-radius:8px;
  background:var(--wl-surface); color:var(--wl-text); padding:12px 14px;
  font:inherit; font-size:13px; line-height:1.75;
}
.wl-textarea:focus { outline:2px solid var(--wl-accent); outline-offset:-1px; }
/* 扫光条要画在不会滚动的这一层：内容一长，滚动条会把贴着顶部的绝对定位元素一起卷走，
 * 恰恰是最需要「还活着」的证据的时候看不见。所以外面加一层只负责描边与裁切。 */
.wl-stream-box {
  position:relative; height:340px; box-sizing:border-box; overflow:hidden;
  border:1px solid var(--wl-border); border-radius:8px; background-color:var(--wl-raised);
}
.wl-stream {
  height:100%; box-sizing:border-box; overflow:auto;
  padding:12px 14px; word-break:break-word;
  font-size:13px; line-height:1.7;
}
.wl-stream-text { white-space:pre-wrap; }
/* 光标停在最新一个字后面：内容在长、却看不出在动，就是因为缺这个 */
.wl-caret {
  display:inline-block; width:2px; height:1.05em; margin-left:2px; vertical-align:-.15em;
  border-radius:1px; background:var(--wl-accent);
  animation:wl-caret 1s steps(2,end) infinite;
}
@keyframes wl-caret { 0%,100% { opacity:1; } 50% { opacity:0; } }
/* 首字未到：三点依次呼吸，说明在等模型而不是卡住 */
.wl-wait { display:flex; align-items:center; gap:9px; color:var(--wl-muted); }
.wl-dots { display:inline-flex; gap:4px; }
.wl-dots > i {
  width:5px; height:5px; border-radius:50%; background:var(--wl-accent);
  animation:wl-dot 1.25s ease-in-out infinite;
}
.wl-dots > i:nth-child(2) { animation-delay:.16s; }
.wl-dots > i:nth-child(3) { animation-delay:.32s; }
@keyframes wl-dot { 0%,100% { opacity:.22; transform:scale(.75); } 50% { opacity:1; transform:scale(1); } }
/* 顶部一条反复扫过的亮带：模型吐字很慢时，也能一眼看出它还活着 */
.wl-stream-box.is-live::before {
  content:""; position:absolute; top:0; left:0; z-index:1; width:40%; height:2px;
  background:linear-gradient(90deg, transparent, var(--wl-accent), transparent);
  animation:wl-sweep 1.5s ease-in-out infinite;
}
@keyframes wl-sweep { from { transform:translateX(-100%); } to { transform:translateX(350%); } }
@media (prefers-reduced-motion: reduce) {
  .wl-caret { animation:none; }
  .wl-dots > i { animation:none; opacity:.6; transform:none; }
  .wl-stream-box.is-live::before { animation:none; width:100%; opacity:.5; }
}
/* Markdown 预览：与编辑区同宽同高，只换内部排版 */
.wl-md {
  width:100%; min-height:340px; max-height:340px; flex:1 1 auto; box-sizing:border-box;
  overflow:auto; border:1px solid var(--wl-control); border-radius:8px;
  background:var(--wl-surface); color:var(--wl-text);
  padding:12px 16px; font-size:13px; line-height:1.75; word-break:break-word;
}
.wl-md > :first-child { margin-top:0; }
.wl-md > :last-child { margin-bottom:0; }
.wl-md h1, .wl-md h2, .wl-md h3, .wl-md h4, .wl-md h5, .wl-md h6 {
  margin:16px 0 8px; line-height:1.35; font-weight:600;
}
.wl-md h1 { font-size:19px; }
.wl-md h2 { font-size:16px; }
.wl-md h3 { font-size:14px; }
.wl-md h4, .wl-md h5, .wl-md h6 { font-size:13px; }
.wl-md p { margin:8px 0; }
.wl-md ul, .wl-md ol { margin:8px 0; padding-left:22px; }
.wl-md li { margin:3px 0; }
.wl-md li::marker { color:var(--wl-muted); }
.wl-md strong { font-weight:600; }
.wl-md a { color:var(--wl-accent); text-decoration:underline; text-underline-offset:2px; }
.wl-md code {
  font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace; font-size:12px;
  background:var(--wl-raised); border:1px solid var(--wl-border);
  border-radius:4px; padding:1px 4px;
}
.wl-md pre {
  margin:10px 0; padding:10px 12px; overflow:auto;
  background:var(--wl-raised); border:1px solid var(--wl-border); border-radius:8px;
}
.wl-md pre code { background:transparent; border:0; padding:0; font-size:12px; line-height:1.6; }
.wl-md blockquote {
  margin:10px 0; padding:2px 0 2px 12px;
  border-left:3px solid var(--wl-border); color:var(--wl-muted);
}
.wl-md hr { margin:16px 0; border:0; border-top:1px solid var(--wl-border); }
.wl-md-table-wrap { margin:10px 0; overflow-x:auto; }
.wl-md-table { width:100%; border-collapse:collapse; font-size:12.5px; line-height:1.55; }
.wl-md-table th, .wl-md-table td {
  border:1px solid var(--wl-border); padding:5px 9px;
  text-align:left; vertical-align:top; word-break:break-word;
}
.wl-md-table th { background:var(--wl-raised); font-weight:600; color:var(--wl-text); }
.wl-md-table tbody tr:nth-child(even) td { background:var(--wl-raised); }

/* ---------- 设置页 ---------- */
.wl-settings { max-width:1080px; margin:0 auto; display:flex; flex-direction:column; container-type:inline-size; }
.wl-settings-intro { margin:0 0 8px; font-size:13px; color:var(--wl-muted); }
.wl-section {
  display:grid; grid-template-columns:280px minmax(0,1fr); gap:32px;
  padding:28px 0; border-top:1px solid var(--wl-border);
}
.wl-section:first-of-type { border-top:0; padding-top:8px; }
.wl-section-label h2 { margin:0; font-size:16px; font-weight:600; line-height:1.4; }
.wl-section-label p { margin:6px 0 0; font-size:13px; line-height:1.55; color:var(--wl-muted); }
.wl-section-panel {
  display:flex; flex-direction:column; gap:18px;
  background:var(--wl-surface); border:1px solid var(--wl-border); border-radius:12px; padding:18px;
}
.wl-field { display:flex; flex-direction:column; gap:6px; }
.wl-field > label { font-size:14px; font-weight:500; }
.wl-field .wl-input { width:100%; height:36px; }
/* 路径字段：只读展示 + 文件夹选择按钮，路径只能通过系统选择器产生 */
.wl-path { display:flex; align-items:center; gap:8px; min-width:0; }
.wl-path-value {
  flex:1 1 auto; min-width:0; height:36px; box-sizing:border-box;
  display:block; padding:0 12px; line-height:34px;
  border:1px solid var(--wl-control); border-radius:var(--wl-r-ctl);
  background:var(--wl-raised); color:var(--wl-text); font-size:13px;
  overflow:hidden; text-overflow:ellipsis; white-space:nowrap;
}
.wl-path-value.is-empty { color:var(--wl-muted); }
/* 没设置时显示的默认路径：虚框表示「这不是你选的，是插件自己的目录」 */
.wl-path-value.is-default {
  color:var(--wl-text); border-style:dashed; background:transparent;
}
.wl-path-pick { flex:none; height:36px; }
.wl-path-list { display:flex; flex-direction:column; gap:8px; }
.wl-path-row { display:flex; align-items:center; gap:8px; min-width:0; }
.wl-field .wl-hint { font-size:12px; line-height:1.5; color:var(--wl-muted); }
.wl-section-panel > .wl-hint { margin:0; font-size:12px; line-height:1.5; color:var(--wl-muted); }
.wl-check { display:flex; align-items:flex-start; gap:8px; font-size:14px; line-height:1.5; }
.wl-check input { margin:3px 0 0; flex:none; accent-color:var(--wl-accent); }
/* 本次扫描的临时隐藏条：只在有隐藏项时出现，明确说明「重新扫描会回来」 */
.wl-muted-bar {
  display:flex; align-items:center; gap:8px; flex-wrap:wrap;
  padding:8px 12px; border:1px dashed var(--wl-control); border-radius:8px;
  font-size:12px; line-height:1.5; color:var(--wl-muted);
}
.wl-env { display:flex; flex-direction:column; gap:4px; font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace; font-size:12px; }
.wl-env-row { display:flex; align-items:center; gap:8px; }
.wl-env-ok { color:var(--wl-positive); }
.wl-env-bad { color:var(--wl-negative); }
.wl-save-bar { display:flex; align-items:center; gap:12px; padding-top:20px; border-top:1px solid var(--wl-border); }
.wl-save-bar .wl-spacer { flex:1 1 auto; }
.wl-save-state { font-size:12px; color:var(--wl-muted); }
.wl-save-state.is-saved { color:var(--wl-positive); }
.wl-save-state.is-bad { color:var(--wl-neg-ink); }
.wl-save-bar .wl-muted { font-size:12px; color:var(--wl-muted); }

/* ---------- 日期范围 ---------- */
.wl-range { display:inline-flex; align-items:center; gap:8px; flex-wrap:wrap; }
.wl-range-inputs { display:inline-flex; align-items:center; gap:6px; }
.wl-range-sep { font-size:12px; color:var(--wl-muted); }
.wl-range-note { font-size:12px; color:var(--wl-muted); font-variant-numeric:tabular-nums; }

/* ---------- 报告历史 ---------- */
.wl-history { border:1px solid var(--wl-border); border-radius:var(--wl-r-card); background:var(--wl-surface); }
.wl-history-toggle {
  display:flex; align-items:center; gap:8px; width:100%;
  padding:10px 14px; border:0; background:transparent; color:var(--wl-text);
  font:inherit; font-size:13px; text-align:left; cursor:pointer; border-radius:var(--wl-r-card);
}
.wl-history-toggle:hover { background:var(--wl-raised); }
.wl-history-toggle:focus-visible { outline:2px solid var(--wl-accent); outline-offset:-2px; }
.wl-history-toggle b { font-weight:500; }
.wl-history-toggle .wl-muted { margin-left:auto; font-size:12px; }
/* 整个历史列表限高，内部统一滚动：月份折叠之后每个月的标题只占一行，
 * 外层滚一滚就能看到「还有哪几个月」。内层不再各自限高——嵌套两层滚动
 * 会让人分不清正在滚哪一层，滚轮也会在边界处卡住。
 * 高度取 50vh：面板本身已有 621px，历史再高就会把扫描结果挤出首屏。 */
.wl-history-scroll {
  border-top:1px solid var(--wl-rule);
  max-height:min(360px, 50vh); overflow-y:auto; overscroll-behavior:contain;
}
.wl-history-scroll:focus-visible { outline:2px solid var(--wl-accent); outline-offset:-2px; }
.wl-history-list { list-style:none; margin:0; padding:0 0 6px; }
/* 搜索行留在滚动区外面：翻到列表深处时，换关键词不用先滚回顶部 */
.wl-history-search {
  display:flex; align-items:center; gap:8px;
  padding:8px 14px; border-top:1px solid var(--wl-rule);
}
.wl-history-search .wl-input { flex:1 1 auto; min-width:0; height:30px; font-size:12px; }
/* 行里有两块可点区域：左边查看、右边删除。li 负责横排，两个按钮各自是相邻兄弟 */
.wl-history-list li {
  display:flex; align-items:center; gap:0;
  border-bottom:1px solid transparent;
}
.wl-history-list li:hover { background:var(--wl-raised); }
.wl-history-del {
  flex:none; height:100%; min-height:30px; padding:0 10px;
  border:0; background:transparent; color:var(--wl-faint);
  font:inherit; font-size:11px; cursor:pointer; white-space:nowrap;
  opacity:0; transition:opacity .12s ease;
}
/* 平时不显眼：删除是低频且不可撤销的操作，不该和「查看」抢注意力。
 * 悬停行、键盘聚焦到它时再露出来。 */
.wl-history-list li:hover .wl-history-del,
.wl-history-del:focus-visible { opacity:1; }
.wl-history-del:hover:not(:disabled) { color:var(--wl-negative); }
.wl-history-del:disabled { opacity:.4; cursor:not-allowed; }
/* 触屏没有 hover：删除入口必须常显，否则在平板上根本找不到它 */
@media (hover: none) {
  .wl-history-del { opacity:.75; }
}
/* 已经点过一次、等待确认：常显 + 红色，让「再点一次就没了」足够清楚 */
.wl-history-del.is-confirm {
  opacity:1; color:var(--wl-neg-ink); background:var(--wl-neg-bg); font-weight:500;
}
/* 月份标题本身可折叠：点它展开/收起这一组。
 * 粘在滚动区顶部：同时展开几个月往下翻时，始终知道自己在哪个月。 */
.wl-history-month {
  position:sticky; top:0; z-index:1;
  display:flex; align-items:center; gap:8px; width:100%;
  padding:6px 14px 4px; border:0; background:var(--wl-surface);
  color:var(--wl-muted); font:inherit; font-size:11px; text-align:left; cursor:pointer;
  font-variant-numeric:tabular-nums; border-bottom:1px solid var(--wl-rule);
}
.wl-history-month:hover { background:var(--wl-raised); }
.wl-history-month:focus-visible { outline:2px solid var(--wl-accent); outline-offset:-2px; }
.wl-history-month[aria-expanded="true"] .wl-card-caret { transform:rotate(45deg); }
.wl-history-month-n { margin-left:auto; color:var(--wl-faint); }
.wl-history-group + .wl-history-group .wl-history-month { border-top:1px solid var(--wl-rule); }
.wl-history-row {
  display:flex; align-items:center; gap:10px; flex:1 1 auto; min-width:0;
  padding:7px 14px; border:0; background:transparent; color:var(--wl-text);
  font:inherit; font-size:12px; text-align:left; cursor:pointer;
}
/* 行的背景交给 li：右侧还有删除按钮，只给左边上色会让整行断成两截 */
.wl-history-row:hover:not(:disabled) { background:transparent; }
.wl-history-row:focus-visible { outline:2px solid var(--wl-accent); outline-offset:-2px; }
.wl-history-row:disabled { opacity:.5; cursor:not-allowed; }
.wl-history-list li.is-current { background:var(--wl-raised); }
.wl-history-list li.is-current .wl-history-date { font-weight:500; }
/* 正在浮层里看的那份：左侧加一条竖线，和「当前面板里的那份」区分开 */
.wl-history-row.is-viewing { box-shadow:inset 2px 0 0 var(--wl-accent); }
.wl-history-date { font-variant-numeric:tabular-nums; min-width:150px; }
.wl-history-tone { color:var(--wl-muted); }
.wl-history-size { margin-left:auto; color:var(--wl-faint); font-variant-numeric:tabular-nums; }
.wl-history-empty { margin:0; padding:10px 14px 14px; font-size:12px; color:var(--wl-muted); }

/* ---------- 历史报告查看器（浮层） ---------- */
/* 遮罩压在 toast(120) 之下：提示仍然看得见，不至于被挡住 */
.wl-viewer-mask {
  position:fixed; inset:0; z-index:110;
  display:flex; align-items:center; justify-content:center; padding:24px;
  box-sizing:border-box; background:rgba(0,0,0,.42);
}
.wl-viewer {
  display:flex; flex-direction:column; gap:0;
  width:min(760px, 100%); max-height:min(84vh, 900px); box-sizing:border-box;
  background:var(--wl-surface); color:var(--wl-text);
  border:1px solid var(--wl-border); border-radius:12px;
  box-shadow:0 24px 64px rgba(0,0,0,.32);
  overflow:hidden;
}
.wl-viewer-head {
  display:flex; align-items:center; gap:8px; flex-wrap:wrap;
  padding:14px 18px; border-bottom:1px solid var(--wl-rule);
}
.wl-viewer-title { margin:0; font-size:15px; font-weight:600; font-variant-numeric:tabular-nums; }
.wl-viewer-tone { font-size:12px; color:var(--wl-muted); }
.wl-viewer-size { font-size:12px; color:var(--wl-faint); font-variant-numeric:tabular-nums; }
.wl-viewer-body { flex:1 1 auto; min-height:0; overflow:auto; padding:16px 18px; }
/* 浮层里的正文继承 .wl-md 的排版，但高度交给外层滚动，不再自己限高 */
.wl-viewer-md { min-height:0; max-height:none; height:auto; overflow:visible; border:0; padding:0; }
.wl-viewer-note { margin:0; font-size:13px; color:var(--wl-muted); }
.wl-viewer-note.is-error { color:var(--wl-neg-ink); }
.wl-viewer-foot {
  display:flex; align-items:center; gap:10px;
  padding:12px 18px; border-top:1px solid var(--wl-rule); background:var(--wl-raised);
}
.wl-viewer-path {
  font-size:11px; color:var(--wl-faint); min-width:0;
  overflow:hidden; text-overflow:ellipsis; white-space:nowrap;
}
@keyframes wl-viewer-in { from { opacity:0; transform:translateY(6px); } to { opacity:1; transform:none; } }
@media (prefers-reduced-motion: no-preference) {
  .wl-viewer { animation:wl-viewer-in .14s ease; }
}
/* 窄屏：浮层贴边，正文自己滚 */
@media (max-width: 720px) {
  .wl-viewer-mask { padding:0; align-items:stretch; }
  .wl-viewer { width:100%; max-height:100vh; border-radius:0; border:0; }
}

/* ---------- 会话 ↔ git 交叉对账 ---------- */
.wl-cross { display:flex; flex-direction:column; gap:4px; margin-top:2px; padding-top:6px; border-top:1px dashed var(--wl-control); }
.wl-cross-line { font-size:12px; line-height:1.6; color:var(--wl-muted); word-break:break-all; }
.wl-cross-line b { font-weight:500; color:var(--wl-text); font-variant-numeric:tabular-nums; }
.wl-cross-line.is-warn { color:var(--wl-warn-ink); }
.wl-cross-line.is-muted { color:var(--wl-faint); }

/* 报告里引用的会话短 ID：渲染成可点击的文字按钮 */
.wl-md-session {
  padding:0 3px; border:0; border-radius:3px; background:var(--wl-raised);
  color:var(--wl-accent); font:inherit; font-size:12px; cursor:pointer;
  font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
}
.wl-md-session:hover { text-decoration:underline; }
.wl-md-session:focus-visible { outline:2px solid var(--wl-accent); outline-offset:1px; }

/* ---------- 自定义口吻编辑器 ---------- */
.wl-note-line { margin:0; font-size:13px; line-height:1.6; color:var(--wl-muted); }
.wl-note-line code {
  padding:1px 4px; border-radius:3px; background:var(--wl-raised);
  font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace; font-size:12px;
}
.wl-tones { display:flex; flex-direction:column; gap:8px; }
/* 每个自定义口吻默认收起：只占一行，模板编辑区要手动点开。
 * 这样口吻从 0 个加到 6 个，设置页的纵向长度是线性增长的，不会一上来就撑满屏。 */
.wl-tone-row {
  border:1px solid var(--wl-border); border-radius:8px; background:var(--wl-raised);
  overflow:hidden;
}
.wl-tone-head { display:flex; align-items:center; gap:8px; padding:10px 12px; min-height:44px; cursor:pointer; list-style:none; }
.wl-tone-head::-webkit-details-marker { display:none; }
.wl-tone-head:focus-visible { outline:2px solid var(--wl-accent); outline-offset:-2px; }
.wl-tone-caret {
  flex:none; width:7px; height:7px;
  border-right:1.5px solid var(--wl-muted); border-bottom:1.5px solid var(--wl-muted);
  transform:rotate(-45deg); transition:transform .15s ease;
}
.wl-tone-row[open] > .wl-tone-head .wl-tone-caret { transform:rotate(45deg); }
.wl-tone-label { flex:1 1 auto; min-width:0; font-size:14px; font-weight:500; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.wl-tone-hint { flex:none; font-size:12px; color:var(--wl-faint); }
.wl-tone-head .wl-btn { flex:none; }
.wl-tone-body { display:flex; flex-direction:column; gap:8px; padding:0 12px 12px; border-top:1px solid var(--wl-rule); padding-top:10px; }
.wl-tone-name { width:100%; }
.wl-tone-prompt { min-height:160px; background:var(--wl-surface); }

/* ---------- 窄屏 ---------- */
@media (max-width: 920px) {
  .wl-root { padding:18px 16px 40px; }
  .wl-body { grid-template-columns:minmax(0,1fr); }
  .wl-report { position:static; order:-1; }
  .wl-stats { grid-template-columns:repeat(3,minmax(0,1fr)); }
  .wl-stat:nth-child(4) { border-left:0; }
  .wl-stat:nth-child(n+4) { border-top:1px solid var(--wl-rule); }
  .wl-section { grid-template-columns:minmax(0,1fr); gap:10px; }
  .wl-track-name { flex-basis:84px; }
  .wl-track-ends { display:none; }
  .wl-axis { margin-left:96px; margin-right:0; }
}
@media (max-width: 520px) {
  .wl-title { font-size:20px; }
  .wl-stats { grid-template-columns:repeat(2,minmax(0,1fr)); }
  .wl-stat:nth-child(odd) { border-left:0; }
  .wl-stat:nth-child(n+3) { border-top:1px solid var(--wl-rule); }
  .wl-track-name { flex-basis:64px; }
  .wl-axis { margin-left:76px; }
  /* 日期框收窄后，预设、日期、扫描能排在一行。这里一律 nowrap：
   * 切到「本周」多一行说明、切到「自定义」多两个日期框，都只让控件自己收缩，
   * 不换行，页头高度就不会随手一换选项就变。 */
  .wl-input[type="date"] { width:120px; }
  .wl-head-tools .wl-range { flex:1 1 auto; flex-wrap:nowrap; min-width:0; }
  .wl-range .wl-seg { flex:0 1 auto; min-width:0; }
  /* 三个预设平分可用宽度，但文字不折行：否则「自定义」会被压成两行，页头又跳高 */
  .wl-range .wl-seg button { flex:1 1 0; white-space:nowrap; padding:0 6px; }
  .wl-range-inputs { flex:0 1 auto; min-width:0; }
  .wl-range-inputs .wl-input[type="date"] { flex:1 1 0; width:auto; min-width:0; }
  .wl-range-note { flex:none; }
  .wl-history-date { min-width:0; }
  .wl-card-meta { margin-left:0; width:100%; }
  .wl-session-head .wl-btn { margin-left:0; }
  /* 带动作的面板在窄屏上移到列表之前，别让用户滚过几百行才看到「生成」 */
  .wl-report { order:-1; }
}
/* 宿主把插件放进比视口更窄的容器时，按容器宽度折叠，而不是按窗口。 */
@container (max-width: 880px) {
  .wl-body { grid-template-columns:minmax(0,1fr); }
  .wl-report { position:static; order:-1; }
  .wl-stats { grid-template-columns:repeat(3,minmax(0,1fr)); }
  .wl-stat:nth-child(4) { border-left:0; }
  .wl-stat:nth-child(n+4) { border-top:1px solid var(--wl-rule); }
  .wl-track-name { flex-basis:84px; }
  .wl-track-ends { display:none; }
  .wl-axis { margin-left:96px; margin-right:0; }
}
@container (max-width: 760px) {
  .wl-section { grid-template-columns:minmax(0,1fr); gap:10px; }
}
@container (max-width: 560px) {
  .wl-title { font-size:20px; }
  .wl-stats { grid-template-columns:repeat(2,minmax(0,1fr)); }
  .wl-stat:nth-child(odd) { border-left:0; }
  .wl-stat:nth-child(n+3) { border-top:1px solid var(--wl-rule); }
  .wl-track-name { flex-basis:64px; }
  .wl-axis { margin-left:76px; }
  .wl-input[type="date"] { width:120px; }
  .wl-head-tools .wl-range { flex:1 1 auto; flex-wrap:nowrap; min-width:0; }
  .wl-range .wl-seg { flex:0 1 auto; min-width:0; }
  .wl-range .wl-seg button { flex:1 1 0; white-space:nowrap; padding:0 6px; }
  .wl-range-inputs { flex:0 1 auto; min-width:0; }
  .wl-range-inputs .wl-input[type="date"] { flex:1 1 0; width:auto; min-width:0; }
  .wl-card-meta { margin-left:0; width:100%; }
  .wl-session-head .wl-btn { margin-left:0; }
  .wl-report { order:-1; }
}
`;


const PROMPTS = {
  daily: [
    "你是一位替工程师写工作日报的助手。只依据下面提供的事实写作，不要补充事实中不存在的内容，也不要评价技术方案的好坏。",
    "不要读取文件、不要调用任何工具、不要检索记忆，直接输出文字。",
    "",
    "事实怎么读：",
    "- 「过程」是用户原话与助手当场回答的配对，判断在做什么、卡在哪以它为先；「最后回复」只代表会话结尾。",
    "- 完成度以 git 提交、未提交改动、改动文件为准；只有用户要求、没有代码证据的，写「已讨论，尚未落地」。",
    "- 「反复编辑」「工具报错」「常执行」是判断返工和卡点的证据；没有这些证据就不写卡点。",
    "",
    "写作要求：",
    "1. 按工作区组织，每个工作区交代「做了什么、做到什么程度」，优先写具体功能、文件、报错原文，少写抽象总结。",
    "2. 严格区分三类：已完成（有代码或提交证据）、进行中（会话里还在改）、试过但放弃（出现失败、报错或回退）。",
    "3. 事实里没有的结论不要写。无法判断是否完成时，写「改动已落地，尚未验证」。",
    "4. 每一条尽量带上来源（工作区名或会话短 ID）。",
    "5. 「今日数据」用 Markdown 表格（| 指标 | 数值 |）。不要编造耗时、效率或事实里没有的数字。",
    "6. 输出 Markdown，不要用代码块包裹整篇。",
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
    "事实怎么读：",
    "- 「过程」是用户要求与助手回应的配对，能看出需求怎么变、哪里反复；「活跃」是当天有消息的小时区间。",
    "- 「时间花在哪」只能按会话数、活跃区间、工具调用量来描述，不要编造精确分钟数。",
    "- 「反复编辑」「工具报错」「常执行」是判断弯路的直接证据。",
    "",
    "写作要求：",
    "1. 事实比计划重要：先写实际发生了什么，再谈感受。",
    "2. 「走过的弯路」只能从工具报错、反复修改同一文件、失败的尝试推断，并写明依据（会话短 ID、文件名或报错原文）。没有证据就写「今天没有明显弯路」。",
    "3. 对事不对人，语气平实，不要灌鸡汤。",
    "4. 建议要具体到明天能执行的动作，不要写「提升效率」这类空话。",
    "5. 「时间花在哪」用 Markdown 表格（| 时段 | 工作区 | 在做什么 |），内容必须来自事实。",
    "6. 输出 Markdown，不要用代码块包裹整篇。",
    "",
    "结构：",
    "# <日期> 复盘",
    "## 今天实际做了什么",
    "## 时间花在哪",
    "## 有效产出",
    "## 走过的弯路",
    "## 明天怎么做得更好",
  ].join("\n"),
  weekly: [
    "你是一位替工程师写周报的助手。输入覆盖一段时间（<日期起> 至 <日期止>）的事实，你要按周来组织，不要写成流水账。",
    "不要读取文件、不要调用任何工具、不要检索记忆，直接输出文字。",
    "",
    "事实怎么读：",
    "- 「过程」是用户原话与助手回应的配对；跨天的会话会被标出，说明这件事持续了多天。",
    "- 完成度以 git 提交、未提交改动、改动文件为准；只有讨论没有代码证据的，写「已讨论，尚未落地」。",
    "- 「反复编辑」「工具报错」集中的地方，就是这个周期的主要卡点。",
    "",
    "写作要求：",
    "1. 先按工作区归纳，再在区内按主题（功能、修复、调研）归并，同一件事跨越多天的写成一条，不再按天拆开。",
    "2. 明确区分「本周完成」「仍在进行」「遇到阻碍」，每一类都要给出证据（提交、文件、报错）。",
    "3. 不要编造事实里没有的工时、百分比或评价。",
    "4. 每个工作区用一行说明这周在这个方向上推进了多少、卡在哪。",
    "5. 「本周产出」用 Markdown 表格（| 工作区 | 产出 | 证据 |）。",
    "6. 输出 Markdown，不要用代码块包裹整篇。",
    "",
    "结构：",
    "# <日期> 工作周报",
    "## 本周概览",
    "## 按工作区推进",
    "## 本周产出",
    "## 卡点与阻碍",
    "## 下周安排",
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

/** 日期加减天数；输入非法时原样返回。 */
function shiftDay(date, delta) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(date || ""));
  if (!m) return date;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + Number(delta || 0));
  return d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate());
}

/** 本周一（周一为一周起点，与国内习惯一致）。 */
function weekStart(date) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(date || ""));
  if (!m) return date;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  const dow = d.getDay(); // 0 = 周日
  const back = dow === 0 ? 6 : dow - 1;
  return shiftDay(date, -back);
}

/** 把范围规范成 { from, to }；from 必须不晚于 to。 */
function normalizeRange(range) {
  const from = String((range && range.from) || "").trim();
  const to = String((range && range.to) || "").trim() || from;
  if (!from) return { from: todayStr(), to: todayStr() };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
    return { from: from, to: from };
  }
  return from <= to ? { from: from, to: to } : { from: to, to: from };
}

/** 范围的稳定键：单日就是日期本身，多日写成 from_to。报告文件名与缓存都用它。 */
function rangeKey(range) {
  const r = normalizeRange(range);
  return r.from === r.to ? r.from : r.from + "_" + r.to;
}

function rangeLabel(range) {
  const r = normalizeRange(range);
  if (r.from === r.to) return r.from;
  return r.from + " 至 " + r.to;
}

/** 范围覆盖的自然日数量（含首尾）。 */
function rangeDays(range) {
  const r = normalizeRange(range);
  const a = Date.parse(r.from + "T00:00:00");
  const b = Date.parse(r.to + "T00:00:00");
  if (!Number.isFinite(a) || !Number.isFinite(b)) return 1;
  return Math.max(1, Math.round((b - a) / 86400000) + 1);
}

function hhmm(iso) {
  const t = Date.parse(iso || "");
  if (!Number.isFinite(t)) return "";
  const d = new Date(t);
  return pad2(d.getHours()) + ":" + pad2(d.getMinutes());
}

/**
 * 扫描时间戳压缩成界面能读的一小段：今天只给时刻，更早的带上日期。
 * 快照是从磁盘读回来的，没有本次耗时，「耗时 0 秒」会让人以为刚扫完。
 */
function shortStamp(iso) {
  const t = Date.parse(iso || "");
  if (!Number.isFinite(t)) return "";
  const d = new Date(t);
  const day = d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate());
  const hm = pad2(d.getHours()) + ":" + pad2(d.getMinutes());
  return day === todayStr() ? hm : day.slice(5) + " " + hm;
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

function fmtNum(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return "0";
  return v.toLocaleString("en-US");
}

/** 当天第几分钟；时间线按本地时区画，与扫描器的 hourKey 一致。 */
function minuteOfDay(iso) {
  const t = Date.parse(iso || "");
  if (!Number.isFinite(t)) return null;
  const d = new Date(t);
  return d.getHours() * 60 + d.getMinutes();
}

function hhmmFromMin(min) {
  const m = Math.max(0, Math.min(1439, Math.round(min)));
  return pad2(Math.floor(m / 60)) + ":" + pad2(m % 60);
}

/* ------------------------------------------------------------------ 状态 */

const store = {
  snap: {
    ready: false,
    // 扫描范围：单日时 from === to。所有「当前在看哪一天」的判断都走 rangeKey()。
    range: { from: todayStr(), to: todayStr() },
    rangePreset: "day",
    // 自定义范围的两个输入框；与 range 分开存，避免输入过程中被规范化打断
    rangeDraft: { from: todayStr(), to: todayStr() },
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
    // 报告历史列表：{ rel, key, mode, size, mtime }[]
    reportList: null,
    reportListLoading: false,
    // 列目录失败的原因；和「确实没有报告」分开，否则一次读盘失败看着像自己没存
    reportListError: "",
    // 历史列表的过滤词：按日期或口吻名筛。空串表示不过滤。
    historyFilter: "",
    // 历史里待确认删除的那份（rel）；null 表示没有在确认
    pendingDelete: null,
    // 历史报告查看器：null 表示没打开。点历史里的某一份只在这里看，
    // 不占用右侧生成面板——那块地方归「生成」用，看过往报告不该把当前草稿替换掉。
    viewer: null,
    generating: false,
    streamText: "",
    runId: "",
    env: null,
    envAt: 0,
    envChecking: false,
    catalog: [],
    catalogError: "",
    // 插件的文档存储位置（报告、扫描器缓存都在它下面）
    storage: null,
    // 本次扫描里被用户点掉的工作区；只影响当前这一屏，重新扫描就清空
    mutedWorkspaces: [],
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

/**
 * 生成报告时引擎进程的默认 cwd。
 *
 * 用插件自己的数据目录，而不是「当天第一个会话的工作区」：agent 跑一轮会在
 * ~/.claude/projects 里留下会话记录，cwd 就是这里传的值。挂在真实项目名下，
 * 「写日报」本身就会被下次扫描当成一项工作产出，越滚越多。
 * 收到插件目录后，这类会话归在 plugin-data/worklog 下，谁产生的也一眼看得出。
 * 拿不到目录时返回空串，由调用方回退。
 */
async function defaultWorkspace() {
  if (!appCtx || !appCtx.documentStorage || typeof appCtx.documentStorage.getLocation !== "function") {
    return "";
  }
  try {
    const root = await ensureStorageRoot();
    return root;
  } catch (e) {
    /* 拿不到就回退到当天第一个会话的工作区 */
    return "";
  }
}

/** 读取当前文档存储位置并同步到界面；切换位置后也要调用它。 */
async function refreshStorageLocation() {
  if (!appCtx) return null;
  try {
    const loc = await appCtx.documentStorage.getLocation();
    const path = String(loc && loc.path ? loc.path : "").replace(/[\\/]+$/, "");
    storageRoot = path;
    if (path) set({ storage: { kind: (loc && loc.kind) || "data", path: path } });
    return loc || null;
  } catch (e) {
    return null;
  }
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
    // 覆盖旧扫描器时宿主会留一份 .bak，和报告一样只保留当前版本
    await removeDoc(SCAN_REL + ".bak");
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
  // 存储里的值可能是手改过的脏数据，读进来先规整成字符串数组
  if (!Array.isArray(base.extraPaths)) base.extraPaths = [];
  base.extraPaths = base.extraPaths.map((p) => String(p || "").trim()).filter(Boolean);
  base.customTones = sanitizeCustomTones(base.customTones);
  const knownTones = Object.keys(BUILTIN_TONE_LABELS).concat(base.customTones.map((t) => t.id));
  if (!knownTones.includes(base.tone)) base.tone = "daily";
  return base;
}

async function writeSettings(next) {
  // 先更新内存，主界面立即按新设置工作；写盘失败由调用方提示
  const clean = Object.assign({}, next, { customTones: sanitizeCustomTones(next.customTones) });
  set({ settings: clean });
  await appCtx.storage.set(SETTINGS_KEY, clean);
}

/** 工作区路径的稳定键：Windows 不区分大小写，尾斜杠不参与比较。 */
function workspaceKey(p) {
  const s = String(p || "").trim().replace(/[\\/]+$/, "");
  // Linux 的路径区分大小写，只有 Windows 才折叠大小写
  return isWindowsHost() ? s.toLowerCase() : s;
}

function isWindowsHost() {
  const ua = typeof navigator !== "undefined" ? String(navigator.userAgent || "") : "";
  // 宿主 WebView 一定有 UA；纯 node 环境（冒烟测试）回退到 process.platform
  if (/windows/i.test(ua)) return true;
  if (ua) return false;
  const plat = typeof process !== "undefined" && process && process.platform ? String(process.platform) : "";
  return /^win/i.test(plat);
}

/** 界面展示统一用本机分隔符；存储与 API 调用仍使用原始路径。 */
function displayPath(p) {
  const s = String(p || "").trim();
  if (!s) return "";
  return isWindowsHost() ? s.replace(/\//g, "\\") : s.replace(/\\/g, "/");
}

function joinDisplayPath(root, rel) {
  const base = displayPath(root).replace(/[\\/]+$/, "");
  const tail = displayPath(rel).replace(/^[\\/]+/, "");
  if (!base) return tail;
  if (!tail) return base;
  return base + (isWindowsHost() ? "\\" : "/") + tail;
}

let catalogLoading = false;
/** 读取宿主可用的引擎与模型，供设置页下拉使用；失败时不阻塞其余功能。 */
async function loadCatalog() {
  if (!appCtx || catalogLoading) return;
  catalogLoading = true;
  try {
    // 用和生成时同一个 cwd 去查（显式设置 > 插件数据目录），否则下拉里看到的
    // 引擎可能和真正跑起来的那一套不是同一个环境。
    const ws = String(store.snap.settings.workspacePath || "").trim() || (await defaultWorkspace()) || undefined;
    const list = await appCtx.agent.catalog(ws);
    set({ catalog: Array.isArray(list) ? list : [], catalogError: "" });
  } catch (e) {
    set({ catalog: [], catalogError: String((e && e.message) || e) });
  } finally {
    catalogLoading = false;
  }
}

/**
 * 本次扫描里临时隐藏某个工作区。只影响当前这一屏：
 * 重新扫描会清空，不写进设置，也不改变扫描结果本身。
 */
function muteWorkspace(workspace) {
  const key = workspaceKey(workspace);
  const cur = Array.isArray(store.snap.mutedWorkspaces) ? store.snap.mutedWorkspaces.slice() : [];
  if (!cur.some((p) => workspaceKey(p) === key)) cur.push(workspace);
  set({ mutedWorkspaces: cur });
  flash("本次已隐藏 " + (shortPath(workspace) || workspace) + "，重新扫描会回来");
}

function unmuteWorkspace(workspace) {
  const key = workspaceKey(workspace);
  const cur = (store.snap.mutedWorkspaces || []).filter((p) => workspaceKey(p) !== key);
  set({ mutedWorkspaces: cur });
}

function unmuteAll() {
  set({ mutedWorkspaces: [] });
}

/* -------------------------------------------------------------- 扫描流程 */

async function scanRange(range) {
  const scriptPath = await ensureScanner();
  const root = await ensureStorageRoot();
  const r = normalizeRange(range);
  const key = rangeKey(r);
  const factsRel = "runtime/facts-" + key + ".json";
  const factsAbs = joinPath(root, factsRel);
  const sessionRoot = String(store.snap.settings.sessionRoot || "").trim() || "auto";

  const started = Date.now();
  const args = [scriptPath, "--root", sessionRoot, "--engine", SCAN_ENGINE_ID];
  if (r.from === r.to) args.push("--date", r.from);
  else args.push("--from", r.from, "--to", r.to);
  args.push("--out", factsAbs);

  const res = await appCtx.bridge.invoke("plugin_exec_run", {
    bin: "node",
    args: args,
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
  // 扫描器的适配器是唯一的：结果不是本引擎产出的，界面上就不能当成本引擎的事实展示
  if (facts.engine && facts.engine !== SCAN_ENGINE_ID) {
    throw new Error("扫描结果来自 " + engineLabel(facts.engine) + "，当前只能解析 " + SCAN_ENGINE_LABEL + " 的日志");
  }
  facts._elapsedMs = Date.now() - started;
  return facts;
}

/**
 * 读回某个范围上一次扫描的快照（scanRange 写进 runtime/facts-<范围>.json 的那份）。
 *
 * 只写不读的话，关掉宿主再打开，扫描区就是空的——明明早上刚扫过。
 * 读失败一律当作「没有快照」，不能拦住启动。
 */
async function loadFactsSnapshot(range) {
  if (!appCtx) return null;
  const key = rangeKey(normalizeRange(range));
  const rel = "runtime/facts-" + key + ".json";
  let doc = null;
  try {
    doc = await appCtx.documentStorage.readText(rel);
  } catch (e) {
    return null;
  }
  if (!doc || typeof doc.content !== "string" || !doc.content) return null;
  let facts = null;
  try {
    facts = JSON.parse(doc.content);
  } catch (e) {
    return null;
  }
  if (!facts || typeof facts !== "object" || !facts.totals) return null;
  // 快照是本机文件，可能被手改或半写：渲染期直接 slice/entries 会抛错，
  // 没有错误边界就是整页白屏。结构性字段不对就当没有快照。
  if (!Array.isArray(facts.sessions) || !Array.isArray(facts.workspaces)) return null;
  if (!Array.isArray(facts.failures)) facts.failures = [];
  // 快照可能来自另一个扫描引擎版本：认不出来就当没有
  if (facts.engine && facts.engine !== SCAN_ENGINE_ID) return null;
  if (facts.range && (facts.range.from !== normalizeRange(range).from || facts.range.to !== normalizeRange(range).to)) {
    return null;
  }
  // 这一份是从磁盘读回来的，不是刚跑出来的：没有真实耗时
  facts._elapsedMs = 0;
  facts._restored = true;
  return facts;
}

/**
 * 宿主只按命令名查找可执行文件，插件不能传绝对路径。
 * 如果 node / git 不在宿主默认的 PATH 里，设置页可以让用户补若干目录；
 * 宿主会把它放在搜索顺序最前面，再追加自己的 CLI 目录。
 */
function pathDelimiter() {
  return isWindowsHost() ? ";" : ":";
}

function execEnv() {
  const env = { GIT_OPTIONAL_LOCKS: "0" };
  const extra = (Array.isArray(store.snap.settings.extraPaths) ? store.snap.settings.extraPaths : [])
    .map((p) => String(p || "").trim())
    .filter(Boolean);
  if (extra.length) env.PATH = extra.join(pathDelimiter());
  return env;
}

/**
 * 切换文档目录后，把旧目录下的报告与扫描快照搬到新目录。
 * 用 node 直接操作文件系统；目标已有同名文件时保留目标、不覆盖，只删除确认复制过去的源文件。
 */
const STORAGE_MOVE_SCRIPT = `
(async () => {
  const fs = await import("node:fs");
  const path = await import("node:path");
  const from = process.argv[1];
  const to = process.argv[2];
  const copied = [];
  let skipped = 0;
  for (const sub of ["reports", "runtime"]) {
    const src = path.join(from, sub);
    if (!fs.existsSync(src)) continue;
    const dst = path.join(to, sub);
    fs.mkdirSync(dst, { recursive: true });
    for (const name of fs.readdirSync(src)) {
      if (name.endsWith(".bak")) continue;
      const s = path.join(src, name);
      const d = path.join(dst, name);
      let st;
      try { st = fs.statSync(s); } catch (e) { continue; }
      if (!st.isFile()) continue;
      if (fs.existsSync(d)) { skipped += 1; continue; }
      fs.copyFileSync(s, d);
      copied.push(s);
    }
  }
  for (const s of copied) {
    try { fs.unlinkSync(s); } catch (e) {}
  }
  // 宿主留下的 .bak 不搬，旧目录和新目录里的一并清掉
  for (const sub of ["reports", "runtime"]) {
    for (const root of [from, to]) {
      const dir = path.join(root, sub);
      if (!fs.existsSync(dir)) continue;
      for (const name of fs.readdirSync(dir)) {
        if (!name.endsWith(".bak")) continue;
        try { fs.unlinkSync(path.join(dir, name)); } catch (e) {}
      }
    }
  }
  for (const sub of ["reports", "runtime"]) {
    try { fs.rmdirSync(path.join(from, sub)); } catch (e) {}
  }
  process.stdout.write(JSON.stringify({ moved: copied.length, skipped: skipped }));
})().catch((e) => {
  process.stderr.write(String((e && e.stack) || e));
  process.exitCode = 1;
});
`;

async function moveStorageFiles(fromRoot, toRoot) {
  const res = await appCtx.bridge.invoke("plugin_exec_run", {
    bin: "node",
    args: ["-e", STORAGE_MOVE_SCRIPT, fromRoot, toRoot],
    env: execEnv(),
    timeoutMs: 60000,
  });
  if (!res || res.code !== 0) {
    const detail = res ? String(res.stderr || res.stdout || "").trim() : "";
    throw new Error(detail ? clip(detail, 300) : "搬运脚本以非零退出");
  }
  try {
    const out = JSON.parse(String(res.stdout || "").trim());
    return { moved: Number(out.moved) || 0, skipped: Number(out.skipped) || 0 };
  } catch (e) {
    return { moved: 0, skipped: 0 };
  }
}

/** 真实探测 node 与 git，让用户在设置页看到结果，而不是等扫描失败。 */
async function checkEnv(force) {
  if (!appCtx) return;
  if (!force && store.snap.env && Date.now() - store.snap.envAt < 5 * 60 * 1000) return;
  // 中心页与设置页会同时挂载，两边都触发时只跑一轮探测
  if (store.snap.envChecking) return;
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

async function execGit(args, timeoutMs) {
  return appCtx.bridge.invoke("plugin_exec_run", {
    bin: "git",
    args: args,
    env: execEnv(),
    timeoutMs: timeoutMs || GIT_TIMEOUT_MS,
  });
}

async function gitForWorkspace(workspace, range) {
  const out = { workspace: workspace, isRepo: false, toplevel: "", commits: [], dirty: [], error: "" };
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

  // git status 输出的路径以仓库根为基准，而工作区可能是仓库里的子目录（monorepo 常见）。
  // 记下仓库根，换算路径时才知道该拿谁当基准。
  try {
    const tp = await execGit(["-C", workspace, "rev-parse", "--show-toplevel"]);
    if (tp && tp.code === 0) out.toplevel = String(tp.stdout || "").trim();
  } catch (e) {
    /* 老版本 git 或裸仓库：回退成按工作区算 */
  }

  const r = normalizeRange(range);
  const since = r.from + "T00:00:00";
  // --until 是排他的：结束日的次日 00:00 才能把结束日整天算进去
  const until = nextDayStr(r.to) + "T00:00:00";

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
    // relativePaths=false：让路径固定以仓库根为基准，不受「从哪个子目录执行」影响
    const st = await execGit([
      "-C", workspace,
      "-c", "core.quotepath=false",
      "-c", "status.relativePaths=false",
      "status", "--porcelain=v1",
    ]);
    if (st && st.code === 0) {
      out.dirty = String(st.stdout || "")
        .split(/\r?\n/)
        .filter(Boolean)
        .slice(0, 200)
        .map((line) => ({ code: line.slice(0, 2).trim(), path: statusPath(line.slice(3).trim()) }));
    }
  } catch (e) {
    /* 忽略 */
  }

  return out;
}

/* -------------------------------------------------------------- git 对账 */

/** 把会话里记录的路径换算成相对 base（仓库根）的路径，方便和 git status 比对。
 *  - 在 base 下：返回相对路径
 *  - 本来就是相对路径：原样返回
 *  - base 之外的绝对路径：返回 ""（不属于这个仓库，不参与对账） */
function relToBase(base, filePath) {
  const root = String(base || "").replace(/[\\/]+$/, "");
  const f = String(filePath || "").trim();
  if (!f) return "";
  const norm = (s) => s.replace(/\\/g, "/");
  const b = norm(f);
  const isAbs = /^[a-zA-Z]:\//.test(b) || b.startsWith("/") || b.startsWith("//");
  if (!root) return isAbs ? "" : b;
  const a = norm(root);
  const win = isWindowsHost();
  const hit = win ? b.toLowerCase() === a.toLowerCase() : b === a;
  if (hit) return "";
  if (win ? b.toLowerCase().startsWith(a.toLowerCase() + "/") : b.startsWith(a + "/")) {
    return b.slice(a.length + 1);
  }
  return isAbs ? "" : b;
}

/* git status --porcelain 的路径转义表：quotepath=false 时只有引号包裹的
 * 路径会带 C 风格转义（\n、\t、\303\251 这种八进制字节）。不解码就会
 * 和会话里记的真实路径对不上，对账时误报「git 里看不到」。 */
function unquoteGitPath(p) {
  if (!/^"(.*)"$/s.test(p)) return p;
  const body = p.slice(1, -1);
  let out = "";
  for (let i = 0; i < body.length; i += 1) {
    const ch = body[i];
    if (ch !== "\\") {
      out += ch;
      continue;
    }
    const next = body[i + 1];
    if (next === undefined) {
      out += "\\";
      break;
    }
    if (/[0-7]/.test(next)) {
      // 八进制字节串按 UTF-8 还原：git 用 \303\251 表示 é
      let oct = "";
      let j = i + 1;
      while (j < body.length && oct.length < 3 && /[0-7]/.test(body[j])) {
        oct += body[j];
        j += 1;
      }
      const byte = Number.parseInt(oct, 8);
      if (byte >= 0x80) {
        // 收集连续的八进制字节后统一解码，避免逐个解码出错
        const bytes = [byte];
        let k = j;
        while (k + 3 < body.length && body[k] === "\\" && /[0-7]/.test(body[k + 1])) {
          let o2 = "";
          let m = k + 1;
          while (m < body.length && o2.length < 3 && /[0-7]/.test(body[m])) {
            o2 += body[m];
            m += 1;
          }
          const b2 = Number.parseInt(o2, 8);
          if (b2 < 0x80) break;
          bytes.push(b2);
          k = m;
        }
        try {
          out += new TextDecoder("utf-8", { fatal: false }).decode(new Uint8Array(bytes));
          i = k - 1;
          continue;
        } catch (e) {
          out += String.fromCharCode(byte);
          i = j - 1;
          continue;
        }
      }
      out += String.fromCharCode(byte);
      i = j - 1;
      continue;
    }
    const map = { n: "\n", t: "\t", r: "\r", '"': '"', "\\": "\\", a: "\x07", b: "\b", f: "\f", v: "\v" };
    out += Object.prototype.hasOwnProperty.call(map, next) ? map[next] : next;
    i += 1;
  }
  return out;
}

/** git status --porcelain 的行尾路径：重命名是 "old -> new"，对账只关心当前路径。 */
function statusPath(text) {
  const raw = String(text || "").trim();
  const arrow = raw.lastIndexOf(" -> ");
  const p = arrow >= 0 ? raw.slice(arrow + 4) : raw;
  // 带空格/特殊字符的路径会被整体加引号，里面可能是 C 风格转义
  return unquoteGitPath(p);
}

/**
 * 会话改动 ↔ git 状态交叉对账。
 * - 会话改过、git 里没有未提交改动：可能已提交，也可能被还原/丢弃，交给用户判断。
 * - git 有未提交改动、会话没碰过：多半是这段范围之前留下的，不是这次的产出。
 * 只做「对不上」的提示，不替用户下结论。
 */
function crossCheck(workspace, sessions, git) {
  // git status 以仓库根为基准；会话里记的是绝对路径。两边都折到「相对仓库根」。
  const base = (git && git.toplevel) || workspace;
  const edited = new Set();
  for (const s of sessions || []) {
    for (const f of s.editedFiles || []) {
      const rel = relToBase(base, f);
      if (rel) edited.add(rel);
    }
  }
  const dirty = new Set();
  for (const d of (git && git.dirty) || []) {
    const rel = String(d.path || "").replace(/\\/g, "/");
    if (rel) dirty.add(rel);
  }
  const pending = [];
  const sessionOnly = [];
  for (const f of edited) {
    if (dirty.has(f)) pending.push(f);
    else sessionOnly.push(f);
  }
  const gitOnly = [];
  for (const f of dirty) if (!edited.has(f)) gitOnly.push(f);
  return {
    edited: edited.size,
    pending: pending.slice(0, 8),
    pendingCount: pending.length,
    settled: sessionOnly.slice(0, 8),
    settledCount: sessionOnly.length,
    gitOnly: gitOnly.slice(0, 8),
    gitOnlyCount: gitOnly.length,
  };
}

function findGit(workspace) {
  const list = store.snap.git;
  if (!list) return null;
  for (const g of list) {
    if (g && g.workspace === workspace) return g;
  }
  return null;
}

/** 限并发的 map：工作区多时不要一次拉起几十个 git 子进程。 */
async function mapLimit(items, limit, fn) {
  const list = Array.isArray(items) ? items : [];
  const out = new Array(list.length);
  let next = 0;
  const worker = async () => {
    while (next < list.length) {
      const i = next++;
      out[i] = await fn(list[i], i);
    }
  };
  const workers = [];
  for (let i = 0; i < Math.min(Math.max(1, limit), list.length); i += 1) workers.push(worker());
  await Promise.all(workers);
  return out;
}

/** 清掉过期的扫描快照，避免 plugin-data 无限增长。 */
async function pruneOldFacts(keepDays) {
  const days = keepDays || 30;
  try {
    const list = await listDir("runtime");
    const cutoff = Date.now() - days * 86400000;
    for (const rel of list || []) {
      // 快照名是 facts-<from>.json 或 facts-<from>_<to>.json；多日快照按结束日算年龄
      const m = /facts-(\d{4}-\d{2}-\d{2})(?:_(\d{4}-\d{2}-\d{2}))?\.json$/.exec(String(rel));
      if (!m) continue;
      const t = Date.parse((m[2] || m[1]) + "T00:00:00");
      if (Number.isFinite(t) && t < cutoff) {
        try {
          await appCtx.documentStorage.remove(withDir("runtime", rel));
        } catch (e) {
          /* 单个清理失败不影响其它文件 */
        }
      }
    }
  } catch (e) {
    /* 清理属于收尾工作，失败不阻塞扫描 */
  }
}

/** 扫完之后跑 git 对账并更新 store。抽出来给 doScan 和快照恢复后的补核对共用。
 *
 *  同一时刻只允许一轮对账在跑：调用方有三处（扫描、快照恢复、切换范围），
 *  没有轮次标记时，先发起的旧一轮后返回会把新范围的结果盖掉，还会提前把
 *  rechecking 清成 false，让「扫描」按钮在真正核对完成前就可点。 */
let gitRound = 0;
async function reconcileGit(facts, range) {
  if (!store.snap.settings.gitReconcile || !facts.workspaces || !facts.workspaces.length) return;
  const key = rangeKey(range);
  const round = ++gitRound;
  set({ rechecking: true });
  const groups = facts.workspaces.filter(
    (group) => group.workspace && group.workspace !== UNKNOWN_WORKSPACE
  );
  // 限并发：每个工作区要跑 3 条 git 命令，一次全开容易压垮进程创建
  const gitRange = facts.range && facts.range.from ? facts.range : range;
  const results = await mapLimit(groups, GIT_CONCURRENCY, (group) =>
    gitForWorkspace(group.workspace, gitRange).catch((e) => ({
      workspace: group.workspace,
      isRepo: false,
      commits: [],
      dirty: [],
      error: safeError(e),
    }))
  );
  if (round !== gitRound) return; // 已经有更新的一轮接手，连 rechecking 都不该由这轮复位
  if (rangeKey(store.snap.range) !== key) {
    // 结果属于旧范围：丢弃。但 rechecking 要收回来——扫描按钮的 disabled
    // 里有它，留着不放会让按钮一直点不动。
    set({ rechecking: false });
    return;
  }
  set({ git: results, rechecking: false });
}

async function doScan() {
  if (store.snap.scanning) return;
  const range = normalizeRange(store.snap.range);
  const key = rangeKey(range);
  const mode = store.snap.reportMode;
  // 上限只在这里统一拦：日期框之外，历史报告的文件名、手改过的快照
  // 都可能带进任意跨度，而那些路径不经过 changeRangeDraft。
  if (rangeDays(range) > MAX_RANGE_DAYS) {
    set({ error: "一次最多看 " + MAX_RANGE_DAYS + " 天，当前范围是 " + rangeDays(range) + " 天。请缩小区间再扫描。" });
    return;
  }
  // 扫描不丢编辑中的草稿：先记进内存，扫描完再放回编辑区
  stashReportDraft();
  set({ scanning: true, error: "", toast: "", facts: null, git: null, streamText: "" });
  try {
    const facts = await scanRange(range);
    // 扫描期间用户换了范围：这批结果属于旧范围，丢弃
    if (rangeKey(store.snap.range) !== key) return;
    // 新一轮扫描重新给出全部工作区，上一轮临时隐藏的恢复显示
    set({ facts: facts, mutedWorkspaces: [] });
    void pruneOldFacts();

    await reconcileGit(facts, range);

    const saved = await loadReportIntoCache(range, mode);
    if (rangeKey(store.snap.range) !== key || store.snap.reportMode !== mode) return;
    showReport(range, mode, saved);
  } catch (e) {
    // 范围已经变了：这一轮的错误属于旧范围，别挂到用户正在看的范围上
    if (rangeKey(store.snap.range) === key) set({ error: "扫描失败：" + safeError(e) });
  } finally {
    // 只有仍是当前这一轮才复位；晚到的旧轮次不能把新轮次的 spinner 关掉
    if (rangeKey(store.snap.range) === key) set({ scanning: false, rechecking: false });
    else set({ scanning: false });
    // 扫描期间切了范围：changeRange 里的 restoreFactsFor 因 scanning 跳过了，
    // 这里补一次，否则明明扫过的范围会一直显示「还没有扫描」。
    if (rangeKey(store.snap.range) !== key) void restoreFactsFor(store.snap.range);
  }
}

/* -------------------------------------------------------------- 报告读写 */

function reportRel(range, mode) {
  return REPORTS_DIR + "/" + rangeKey(range) + "-" + mode + ".md";
}

async function loadSavedReport(range, mode) {
  if (!appCtx) return "";
  try {
    const doc = await appCtx.documentStorage.readText(reportRel(range, mode));
    return doc && doc.content ? doc.content : "";
  } catch (e) {
    // readText 对不存在的文件返回 null；抛错说明是真的读不了（权限、存储位置失效）
    set({ error: "读取报告失败：" + safeError(e) });
    return "";
  }
}

/* 每个「范围+口吻」各留一份磁盘文本和一份未保存草稿：
   切换口吻或范围时内容不会互相覆盖，切回来还能接着改。
   草稿另外写进 storage（reportDraftText 的内存副本是真相，storage 只是兜底）：
   插件热重载或重启后模块重新加载，光靠内存会让写了一半的报告无声消失。 */
const REPORT_KEY = (range, mode) => rangeKey(range) + "|" + mode;
const reportDiskText = new Map();
const reportDraftText = new Map();

// 落盘草稿的内容；只留最近若干份、总长有上限，避免 storage 越滚越大
let draftSaveTimer = null;
function draftPayload() {
  const entries = [];
  for (const [key, text] of reportDraftText) {
    if (!text || !text.trim()) continue;
    entries.push({ key: key, text: text });
  }
  // 新的在前（Map 的插入顺序就是最近一次写入的顺序），从新到旧累计到预算用完
  entries.reverse();
  const kept = [];
  let total = 0;
  for (const e of entries) {
    if (kept.length >= MAX_DRAFT_ENTRIES) break;
    if (total + e.text.length > MAX_DRAFT_CHARS) break;
    kept.push(e);
    total += e.text.length;
  }
  return { v: 1, entries: kept };
}

/** 把内存里的草稿写进 storage。连续输入时只写最后一次。 */
function persistDraftsSoon() {
  if (!appCtx || !appCtx.storage || typeof appCtx.storage.set !== "function") return;
  if (draftSaveTimer) clearTimeout(draftSaveTimer);
  draftSaveTimer = setTimeout(() => {
    draftSaveTimer = null;
    flushDraftsNow();
  }, DRAFT_PERSIST_DELAY_MS);
}

/** 立刻落一次草稿（不等防抖）。卸载时要用：定时器醒来时 appCtx 已经是 null。 */
function flushDraftsNow() {
  if (!appCtx || !appCtx.storage || typeof appCtx.storage.set !== "function") return;
  try {
    void Promise.resolve(appCtx.storage.set(DRAFTS_KEY, draftPayload())).catch(() => {});
  } catch (e) {
    /* 存不下只影响下次启动能否恢复，不影响当前编辑 */
  }
}

/** 启动时把上次没保存的草稿读回来。读失败就当作没有草稿，不能拦住启动。 */
async function loadPersistedDrafts() {
  if (!appCtx || !appCtx.storage || typeof appCtx.storage.get !== "function") return;
  let raw = null;
  try {
    raw = await appCtx.storage.get(DRAFTS_KEY);
  } catch (e) {
    return;
  }
  const entries = raw && Array.isArray(raw.entries) ? raw.entries : [];
  for (const e of entries) {
    if (!e || typeof e.key !== "string" || typeof e.text !== "string") continue;
    if (!e.text.trim()) continue;
    // 内存里已经有更新的版本就不覆盖
    if (!reportDraftText.has(e.key)) reportDraftText.set(e.key, e.text);
  }
}

/** 记一份草稿（编辑中按内容调用）。空文本或与磁盘一致就不留。 */
function noteDraft(range, mode, text) {
  const key = REPORT_KEY(range, mode);
  const saved = reportDiskText.has(key) ? reportDiskText.get(key) : "";
  rememberDraft(key, text && text.trim() && text !== saved ? text : "");
  persistDraftsSoon();
}

/** 写入草稿；先删再插，让 Map 的插入顺序真的等于「最近一次编辑」。 */
function rememberDraft(key, text) {
  // Map.set 对已有 key 不会挪位置，直接 set 会让很久没碰的草稿排在前面，
  // 落盘裁剪时反而先把它留下、把新写的挤掉
  reportDraftText.delete(key);
  if (text) reportDraftText.set(key, text);
}

/** 把当前视图的未保存草稿记进内存；已保存的内容不重复存。 */
function stashReportDraft() {
  const key = REPORT_KEY(store.snap.range, store.snap.reportMode);
  const text = store.snap.report || "";
  rememberDraft(key, text.trim() && text !== store.snap.reportSaved ? text : "");
  persistDraftsSoon();
}

/* 编辑区（ReportPanel 的 textarea）里最新的文本。
 * 组件状态对外不可见，而切口吻、扫描、卸载这些模块级动作用的是 store。
 * 用户没 blur 就点按钮时，store 里还是上一版——必须先把这份交回去。 */
let editorDraft = null;
let editorDraftKey = "";

function noteEditorDraft(viewKey, text) {
  editorDraft = text;
  editorDraftKey = viewKey;
}

/** 把编辑区的最新文本交回 store（只在它确实属于当前视图时）。 */
function commitEditorDraft() {
  if (editorDraft === null) return;
  if (editorDraftKey !== REPORT_KEY(store.snap.range, store.snap.reportMode)) return;
  if (store.snap.report !== editorDraft) set({ report: editorDraft });
}

/** 磁盘缓存被我们自己的保存更新过几次。读盘期间发生过写入时，
 *  读回来的旧内容不能覆盖缓存里刚写进去的新版本。 */
let diskWriteSeq = 0;

/** 读磁盘内容并更新缓存，返回文本。 */
async function loadReportIntoCache(range, mode) {
  const key = REPORT_KEY(range, mode);
  const seq = diskWriteSeq;
  const text = await loadSavedReport(range, mode);
  // 读盘期间这份报告刚被保存过：缓存里那份比磁盘快照新，别回填旧的
  if (seq !== diskWriteSeq && reportDiskText.has(key)) return reportDiskText.get(key);
  reportDiskText.set(key, text);
  return text;
}

/** 把某份报告放进编辑区：有未保存草稿优先用草稿，否则用磁盘内容。 */
function showReport(range, mode, diskText) {
  const key = REPORT_KEY(range, mode);
  if (typeof diskText === "string") reportDiskText.set(key, diskText);
  const saved = reportDiskText.has(key) ? reportDiskText.get(key) : "";
  if (reportDraftText.has(key) && reportDraftText.get(key) !== saved) {
    set({ report: reportDraftText.get(key), reportSaved: saved });
  } else {
    reportDraftText.delete(key);
    set({ report: saved, reportSaved: saved });
  }
}

/**
 * 列出某个目录下的文件，统一返回「这个目录下的文件名」。
 *
 * 宿主 `list(prefix?)` 的语义在不同版本上有出入：有的按目录列，有的按字符串前缀匹配，
 * 返回值也可能带或不带前缀。更麻烦的是「前缀拼法不对」时可能不报错、只返回空数组，
 * 那样看着就和「目录里真的没有文件」一样。
 *
 * 所以两种拼法都问一遍，先问带尾斜杠的（宿主文档与现有调用都用这种），
 * 拿不到再问不带斜杠的；两个都空才算是真的空。
 */
async function listDir(dir) {
  const base = String(dir).replace(/[\\/]+$/, "");
  let lastErr = null;
  let empty = null;
  for (const prefix of [base + "/", base]) {
    let list;
    try {
      list = await appCtx.documentStorage.list(prefix);
    } catch (e) {
      lastErr = e;
      continue;
    }
    if (!Array.isArray(list)) continue;
    const names = list
      .map((item) => {
        // 返回项可能是字符串，也可能是 { path, size } 之类的对象：
        // 直接 String(obj) 会得到 "[object Object]"，一个文件都列不出来
        const raw = typeof item === "string" ? item : item && typeof item === "object" ? item.path || item.name || item.rel || "" : "";
        // 反斜杠统一成正斜杠后再裁前缀，Windows 宿主两种都可能返回
        const s = String(raw).replace(/\\/g, "/");
        if (s.startsWith(base + "/")) return s.slice(base.length + 1);
        // 没带前缀（或前缀拼错）就取最后一段，至少不会把目录名混进文件名
        const cut = s.lastIndexOf("/");
        return cut >= 0 ? s.slice(cut + 1) : s;
      })
      .filter(Boolean);
    if (names.length) return names;
    empty = names;
  }
  if (empty) return empty;
  throw lastErr || new Error("无法列出目录 " + base);
}

/**
 * documentStorage.list(prefix) 返回的路径在不同宿主版本里可能是
 * "reports/x.md.bak"，也可能只是 "x.md.bak"；统一补上目录前缀。
 */
function withDir(dir, item) {
  const rel = String(item == null ? "" : item);
  if (!rel) return rel;
  if (/[\\/]/.test(rel)) return rel;
  return String(dir).replace(/[\\/]+$/, "") + "/" + rel;
}

async function removeDoc(rel) {
  try {
    await appCtx.documentStorage.remove(rel);
  } catch (e) {
    /* 文件本来就不存在 */
  }
}

/** 宿主原子写入会留一份 .bak；插件只保留当前版本，启动时和每次保存后都清掉。 */
async function cleanupReportBaks() {
  if (!appCtx) return;
  try {
    const list = await listDir(REPORTS_DIR);
    for (const item of list || []) {
      const rel = String(item);
      if (!rel.endsWith(".bak")) continue;
      await removeDoc(withDir(REPORTS_DIR, rel));
    }
  } catch (e) {
    /* 宿主不支持 list 时跳过 */
  }
}

/** 每份报告一条保存队列：并发保存同一份时按点击顺序落盘，后完成的旧文本不能盖掉新文本。 */
const saveQueues = new Map();

async function writeReportText(range, mode, text) {
  const rel = reportRel(range, mode);
  const key = REPORT_KEY(range, mode);
  let cur = null;
  try {
    cur = await appCtx.documentStorage.readText(rel);
  } catch (e) {
    cur = null;
  }
  try {
    await appCtx.documentStorage.writeTextAtomic(rel, text, cur ? cur.version : null);
  } catch (e) {
    // 版本冲突。只有在「磁盘内容仍是我们最后看到的那个版本」时才重试——
    // 内容变了说明别处（另一个窗口、同步盘）改过它，拿对方的新 version
    // 强写就是把外部改动顶掉，那正是这一重试想避免的事。
    const again = await appCtx.documentStorage.readText(rel).catch(() => null);
    const known = reportDiskText.has(key) ? reportDiskText.get(key) : null;
    const sameAsKnown = again && known !== null && String(again.content || "") === known;
    if (sameAsKnown) {
      await appCtx.documentStorage.writeTextAtomic(rel, text, again.version);
    } else {
      throw new Error("这份报告在别处被修改过，本次保存没有覆盖它；请先看一眼历史里的版本再决定");
    }
  }
  await removeDoc(rel + ".bak");
  reportDiskText.set(key, text);
  diskWriteSeq += 1;   // 让在途的读盘知道磁盘已经不是它读到的那一版了
  // 只有「草稿就是刚写进去的这一版」才清：写完到落盘之间用户可能又改了，
  // 那时的草稿是更新的内容，不能一起抹掉。
  const draft = reportDraftText.has(key) ? reportDraftText.get(key) : null;
  if (draft === null || draft === text) reportDraftText.delete(key);
  persistDraftsSoon();
}

async function saveReportText(range, mode, text) {
  const key = REPORT_KEY(range, mode);
  const prev = saveQueues.get(key) || Promise.resolve();
  const run = prev.then(
    () => writeReportText(range, mode, text),
    () => writeReportText(range, mode, text)
  );
  saveQueues.set(
    key,
    run.then(
      () => {},
      () => {}
    )
  );
  return run;
}

/** 切换范围或口吻时不写盘；未保存的修改留在内存里，切回来还能继续编辑。 */
let reportSwitchSeq = 0;

/** 切到「范围 + 口吻」对应的报告：先用内存缓存立即换屏（有未保存草稿就用草稿），
 *  读盘完成后再校正。extra 是调用方要一并改掉的其它状态（facts、预设等）。
 *  切换范围、切换口吻、从历史点回来都走这里，读盘与防竞态只有一处。 */
async function switchView(range, mode, extra) {
  const r = normalizeRange(range);
  const key = rangeKey(r);
  viewPickSeq += 1;
  // 调用方可能忘了先把编辑区交回 store（例如直接在口吻按钮上点击、
  // 输入框还没 blur）。用面板里的最新文本覆盖 store 再 stash，
  // 否则最后一段输入不会进草稿。
  commitEditorDraft();
  stashReportDraft();
  reportSwitchSeq += 1;
  const seq = reportSwitchSeq;
  const rkey = REPORT_KEY(r, mode);
  const savedNow = reportDiskText.has(rkey) ? reportDiskText.get(rkey) : "";
  const cached = reportDraftText.has(rkey) ? reportDraftText.get(rkey) : savedNow;
  set(
    Object.assign(
      {
        range: r,
        reportMode: mode,
        report: cached,
        reportSaved: savedNow,
        streamText: "",
      },
      extra || {}
    )
  );
  // 记下最后停在的口吻，重新激活时不会被默认口吻顶掉。
  // 放在 set 之后立刻做，不等读盘结束——否则切完口吻马上切走页签就会丢。
  rememberMode(mode);
  const text = await loadReportIntoCache(r, mode);
  // 期间又切了范围或口吻：这批结果已经过期
  if (seq !== reportSwitchSeq) return;
  if (rangeKey(store.snap.range) !== key || store.snap.reportMode !== mode) return;
  showReport(r, mode, text);
}

/** 记住用户最后停在的口吻。宿主切页签 / 热重载会重新 activate，
 *  只从 settings.tone 恢复的话，刚选好的自定义口吻会退回默认值。 */
function rememberMode(mode) {
  if (!appCtx || !appCtx.storage || typeof appCtx.storage.set !== "function") return;
  const tone = store.snap.settings ? store.snap.settings.tone : "";
  try {
    // 外层 try 只拦同步抛出，宿主拒绝写入是 rejection
    void Promise.resolve(
      appCtx.storage.set(VIEW_KEY, {
        mode: String(mode || ""),
        tone: String(tone || ""),
      })
    ).catch(() => {});
  } catch (e) {
    /* 记不住只影响下次打开，不算失败 */
  }
}

async function switchReportMode(mode) {
  if (mode === store.snap.reportMode || store.snap.generating) return;
  await switchView(store.snap.range, mode);
}

/* ------------------------------------------------------------ 口吻与历史 */

/** 内置口吻的显示名。自定义口吻用用户填的名字。 */
const BUILTIN_TONE_LABELS = { daily: "工作日报", retro: "个人复盘", weekly: "工作周报" };
/** 按钮上用的短名。自定义口吻的 label 本身就很短，直接复用。 */
const BUILTIN_TONE_SHORT = { daily: "日报", retro: "复盘", weekly: "周报" };

/** 所有可用口吻：[{ id, label, short, builtin }]，内置在前，自定义按创建顺序排在后面。
 *  设置页编辑中的自定义列表可以直接传进来，不必等自动保存生效。 */
function allTones(customList) {
  const list = Object.keys(BUILTIN_TONE_LABELS).map((id) => ({
    id: id,
    label: BUILTIN_TONE_LABELS[id],
    short: BUILTIN_TONE_SHORT[id] || BUILTIN_TONE_LABELS[id],
    builtin: true,
  }));
  const custom = Array.isArray(customList)
    ? customList
    : Array.isArray(store.snap.settings.customTones)
      ? store.snap.settings.customTones
      : [];
  for (const t of custom) {
    // 内置 id 不能被自定义项覆盖；原型链上的名字（constructor 等）也不能混进来
    if (!t || !isValidToneId(t.id)) continue;
    const label = String(t.label || "").trim() || t.id;
    list.push({ id: t.id, label: label, short: label, builtin: false });
  }
  return list;
}

/** 口吻 id 是否可用作自定义口吻：格式合法、不占用内置 id、不是原型链上的名字。 */
function isValidToneId(id) {
  const s = String(id || "");
  return TONE_ID_RE.test(s) &&
    !Object.prototype.hasOwnProperty.call(BUILTIN_TONE_LABELS, s) &&
    !RESERVED_TONE_IDS.includes(s);
}

function toneLabel(mode) {
  const tones = allTones();
  const hit = tones.find((t) => t.id === mode);
  return hit ? hit.label : String(mode || "");
}

/**
 * 口吻和当前范围的匹配提示。三种内置口吻的模板是按时间尺度写死的结构
 * （日报有「今日/明天」、周报有「本周/下周」），范围不匹配时模型只能硬凑。
 * 不禁用——用户可能就是想用周报看一天；只把后果说清楚。
 */
function toneRangeHint(mode, range) {
  const days = rangeDays(range);
  if (mode === "weekly" && days <= 1) {
    return "工作周报按一周组织；当前范围只有 1 天，「本周产出」「下周安排」会很空。";
  }
  if (mode === "daily" && days > 1) {
    return "工作日报按一天写；当前范围是 " + days + " 天，「今日完成」「明天接着做」会变成笼统概括。";
  }
  if (mode === "retro" && days > 1) {
    return "个人复盘原为单日设计；当前范围是 " + days + " 天，会把多天混在一起看。";
  }
  return "";
}

/** 报告空白态的建议口吻：单日推日报/复盘，多日推周报。 */
function suggestTone(range) {
  return rangeDays(range) > 1 ? "工作周报" : "工作日报或个人复盘";
}

/**
 * 取某个口吻的提示词。内置的直接用 PROMPTS；
 * 自定义口吻存的是用户写的模板正文（不含「事实怎么读」那一段通用说明）。
 */
function promptFor(mode, range) {
  const r = normalizeRange(range);
  // 口吻 id 来自设置或报告文件名，可能是 constructor / valueof 之类；
  // 直接 PROMPTS[mode] 会命中原型链，拿到 Object 构造函数当模板。
  const builtin = Object.prototype.hasOwnProperty.call(PROMPTS, mode) ? PROMPTS[mode] : "";
  let text = builtin;
  if (!text) {
    const custom = (Array.isArray(store.snap.settings.customTones) ? store.snap.settings.customTones : [])
      .find((t) => t && t.id === mode);
    text = custom && String(custom.prompt || "").trim() ? String(custom.prompt) : "";
    // 自定义口吻的模板只有写作要求，事实怎么读、别调工具这些通用约束要补上
    if (text) {
      text = [
        "你是一位替工程师写工作记录的助手。只依据下面提供的事实写作，不要补充事实中不存在的内容。",
        "不要读取文件、不要调用任何工具、不要检索记忆，直接输出文字。",
        "",
        "事实怎么读：",
        "- 「过程」是用户原话与助手当场回答的配对；「最后回复」只代表会话结尾。",
        "- 完成度以 git 提交、未提交改动、改动文件为准；没有代码证据的写「已讨论，尚未落地」。",
        "- 「反复编辑」「工具报错」是卡点的证据，没有证据就不写卡点。",
        "",
        text,
      ].join("\n");
    }
  }
  if (!text) text = PROMPTS.daily;
  // 模板里可能没有占位符；替换是幂等的
  return String(text).replace(/<日期>/g, rangeLabel(r)).replace(/<日期起>/g, r.from).replace(/<日期止>/g, r.to);
}

/** 校验并规整自定义口吻列表：id 只能是半角小写字母数字，不能占用内置 id 或原型链上的名字。
 *  名称和模板允许暂时为空（用户正在编辑），渲染时各自有兜底。 */
function sanitizeCustomTones(list) {
  const out = [];
  for (const raw of Array.isArray(list) ? list : []) {
    if (!raw || typeof raw !== "object") continue;
    const id = String(raw.id || "").trim();
    if (!isValidToneId(id) || out.some((t) => t.id === id)) continue;
    out.push({
      id: id,
      label: String(raw.label || "").trim().slice(0, MAX_TONE_LABEL),
      prompt: String(raw.prompt || "").slice(0, MAX_TONE_PROMPT),
    });
    if (out.length >= MAX_CUSTOM_TONES) break;
  }
  return out;
}

/** 把报告文件按「范围 + 口吻」拆开；不合规的文件名返回 null。 */
function parseReportName(name) {
  const base = String(name || "").replace(/^.*[\\/]/, "");
  if (!base.endsWith(".md")) return null;
  const stem = base.slice(0, -3);
  // <from>-<mode> 或 <from>_<to>-<mode>
  const m = /^(\d{4}-\d{2}-\d{2})(?:_(\d{4}-\d{2}-\d{2}))?-([a-z][a-z0-9]{0,15})$/.exec(stem);
  if (!m) return null;
  return { from: m[1], to: m[2] || m[1], mode: m[3] };
}

/** 读取 reports/ 下的报告清单，按结束日倒序（同日再按开始日倒序）。
 *  只有文件不多时才逐个读大小；报告多了光靠文件名就够了，别为了一个数字读上百个文件。 */
let reportListSeq = 0;
async function loadReportList() {
  if (!appCtx) return;
  const seq = ++reportListSeq;
  set({ reportListLoading: true });
  try {
    const list = await listDir(REPORTS_DIR);
    const metas = [];
    for (const item of list || []) {
      const rel = String(item || "");
      if (!rel.endsWith(".md")) continue;
      const meta = parseReportName(rel);
      if (!meta) continue;
      metas.push(Object.assign({ rel: withDir(REPORTS_DIR, rel), key: rangeKey(meta) }, meta));
    }
    metas.sort((a, b) => {
      if (a.to !== b.to) return b.to.localeCompare(a.to);
      return b.from.localeCompare(a.from);
    });
    const rows = metas.slice(0, MAX_REPORT_LIST_READ);
    for (const row of rows) {
      // 已经有一轮新的读取在跑了：别白读后面的文件
      if (seq !== reportListSeq) return;
      try {
        const doc = await appCtx.documentStorage.readText(row.rel);
        if (doc && typeof doc.content === "string") row.size = doc.content.length;
      } catch (e) {
        /* 单个文件读不了不影响列表 */
      }
    }
    if (seq !== reportListSeq) return;
    set({ reportList: metas, reportListError: "" });
  } catch (e) {
    // 一次都没列出来过 ≠ 真的没有报告。把原因显示出来，别让用户以为是自己没保存。
    if (seq === reportListSeq) set({ reportList: [], reportListError: safeError(e) });
  } finally {
    if (seq === reportListSeq) set({ reportListLoading: false });
  }
}

/* ------------------------------------------------------------ 事实摘要文本 */

/** 把小时桶合并成「09:00–11:00、13:00–15:00」这样的活跃时段。 */
function activeRanges(hours) {
  const keys = Object.keys(hours || {})
    .map(Number)
    .filter((h) => Number.isFinite(h))
    .sort((a, b) => a - b);
  if (!keys.length) return "";
  const parts = [];
  let start = keys[0];
  let prev = keys[0];
  for (let i = 1; i < keys.length; i += 1) {
    if (keys[i] === prev + 1) {
      prev = keys[i];
      continue;
    }
    parts.push([start, prev]);
    start = keys[i];
    prev = keys[i];
  }
  parts.push([start, prev]);
  return parts
    .map(([a, b]) => pad2(a) + ":00–" + (b === 23 ? "24:00" : pad2(b + 1) + ":00"))
    .join("、");
}

/** 执行过的命令里，纯查看类对写报告帮助不大，优先保留测试/构建/git 这类动作。 */
const LOW_SIGNAL_COMMAND = /^\s*(?:cd|ls|pwd|cat|echo|head|tail|wc|which|where|type)\b/;

function pickCommands(commands) {
  const list = (commands || []).filter((c) => c && c.command);
  const meaningful = list.filter((c) => !LOW_SIGNAL_COMMAND.test(c.command));
  const picked = (meaningful.length ? meaningful : list).slice(0, 8);
  return picked.map((c) => clip(oneLine(c.command), 120)).join("；");
}

/** 把一天的事实压成给模型看的摘要：按会话分配预算、从最近的消息往前取。
 *  预算耗尽时后面的工作区降级成一行摘要，而不是把整段工作区直接截掉。 */
function buildFactsDigest(facts, gitList) {
  const lines = [];
  let usedChars = 0;
  const push = (text) => {
    const s = String(text == null ? "" : text);
    lines.push(s);
    usedChars += s.length + 1;
  };

  push("【日期】" + facts.range.from + (facts.range.to !== facts.range.from ? " 至 " + facts.range.to : "") + "（时区 " + facts.range.timezone + "）");
  push(
    "【合计】会话 " + facts.totals.sessions + " 个 / 用户消息 " + facts.totals.userTurns +
    " 轮 / 工具调用 " + facts.totals.toolCalls + " 次 / 工具报错 " + facts.totals.toolErrors +
    " 次 / 改动文件 " + facts.totals.editedFiles + " 个"
  );

  const byId = new Map();
  for (const s of facts.sessions) byId.set(s.sessionId, s);

  const gitByWs = new Map();
  for (const g of gitList || []) gitByWs.set(g.workspace, g);

  const sessionCount = Math.max(1, facts.sessions.length);
  // 单会话细节预算：工作区多时压缩，但低于 400 连两条过程都放不下
  const perSession = Math.max(400, Math.min(6000, Math.floor((MAX_PROMPT_CHARS - 1200) / sessionCount)));

  for (const group of facts.workspaces) {
    // 预算已经用完：后面的工作区保留存在感，不再输出细节
    if (usedChars > MAX_PROMPT_CHARS - 300) {
      push(
        "【工作区】" + (group.workspace || UNKNOWN_WORKSPACE) +
        "（细节已省略：会话 " + group.sessions.length + " 个，用户 " + (group.userTurns || 0) + " 轮）"
      );
      continue;
    }

    push("");
    push("【工作区】" + (group.workspace || UNKNOWN_WORKSPACE));

    const g = gitByWs.get(group.workspace);
    if (g && g.isRepo) {
      if (g.commits.length) {
        push("git 提交 " + g.commits.length + " 次：" + g.commits.map((c) => (c.time || "") + " " + (c.hash ? c.hash + " " : "") + c.subject).join("；"));
      } else {
        push("git 提交：无");
      }
      if (g.dirty.length) {
        push(
          "未提交改动 " + g.dirty.length + " 个：" +
          g.dirty.slice(0, 20).map((d) => d.code + " " + d.path).join("；")
        );
      }
    } else if (g && !g.isRepo) {
      push("git：不是仓库或无法读取");
    }

    for (let si = 0; si < group.sessions.length; si += 1) {
      if (usedChars > MAX_PROMPT_CHARS - 200) {
        push("  · 另有 " + (group.sessions.length - si) + " 个会话未展开");
        break;
      }
      const id = group.sessions[si];
      const s = byId.get(id);
      if (!s) continue;

      const active = activeRanges(s.hours);
      push(
        "- 会话 " + String(id).slice(0, 8) +
        "（" + (hhmm(s.firstSeenAt) || "?") + "–" + (hhmm(s.lastSeenAt) || "?") +
        (active ? "，活跃 " + active : "") +
        "，用户 " + s.userTurns + " 轮，工具 " +
        Object.values(s.tools || {}).reduce((a, b) => a + (Number.isFinite(b) ? b : 0), 0) + " 次）" +
        (s.continuedFromEarlierDay ? " [前一天已开始]" : "")
      );

      // 固定信息先占位，剩余预算留给「用户要求 → 助手回应」
      const fixed = [];
      if (s.finalAssistantText) fixed.push("  最后回复：" + clip(oneLine(s.finalAssistantText), 300));

      const toolTop = Object.entries(s.tools || {})
        .filter(([, n]) => Number.isFinite(n))
        .sort((a, b) => b[1] - a[1])
        .slice(0, 6)
        .map(([name, n]) => name + "×" + n)
        .join(" ");
      if (toolTop) fixed.push("  工具：" + toolTop);

      const cmds = pickCommands(s.commands);
      if (cmds) fixed.push("  常执行：" + cmds);

      if (Array.isArray(s.hotFiles) && s.hotFiles.length) {
        fixed.push(
          "  反复编辑：" +
          s.hotFiles.slice(0, 5).map((f) => shortPath(f.path) + " 编辑 " + f.edits + " 次").join("；")
        );
      }

      if ((s.toolErrors || []).length) {
        fixed.push(
          "  工具报错 " + s.toolErrors.length + " 次：" +
          s.toolErrors.slice(0, 5).map((e) => clip(oneLine(e.text), 160)).join(" | ")
        );
      }

      if ((s.editedFiles || []).length) {
        fixed.push("  改动文件 " + s.editedFiles.length + " 个：" + s.editedFiles.slice(0, 12).join(", "));
      }

      const fixedLen = fixed.reduce((n, x) => n + x.length + 1, 0);
      const msgBudget = Math.max(300, perSession - fixedLen - 160);

      const turns = (s.turns || []).filter((t) => t && t.user);
      const useTurns = turns.length > 0;
      const items = useTurns ? turns : (s.userMessages || []).map((m) => ({ ts: m.ts, user: m.text }));

      const picked = [];
      let used = 0;
      for (let i = items.length - 1; i >= 0; i -= 1) {
        const it = items[i];
        const head = (it.fromEarlierDay ? "前一天 " : "") + (hhmm(it.ts) || "?");
        const text = useTurns && it.reply
          ? head + " 用户：" + clip(oneLine(it.user), 300) + " → 助手：" + clip(oneLine(it.reply), 160)
          : head + " 用户：" + clip(oneLine(it.user), 420);
        if (used + text.length > msgBudget && picked.length >= 2) break;
        picked.unshift("  · " + text);
        used += text.length + 4;
      }

      if (picked.length) {
        const omitted = items.length - picked.length;
        push(
          "  过程（" +
          (omitted ? "最近 " + picked.length + " 条，更早 " + omitted + " 条略" : "全部 " + picked.length + " 条") +
          "）："
        );
        for (const p of picked) push(p);
      }

      for (const f of fixed) push(f);
    }
  }

  let out = lines.join("\n");
  // 降级逻辑已经把总量兜住；只剩单个工作区本身超长的情况
  if (out.length > MAX_PROMPT_CHARS) out = out.slice(0, MAX_PROMPT_CHARS) + "\n（事实过长，已截断）";
  return out;
}

/* ---------------------------------------------------------------- AI 生成 */

/** 跑一轮后台生成。
 *
 *  提示词只从 startOpts 走：宿主真正使用的是 startOpts.prompt，
 *  以前的第一个参数在任何路径下都不会被读到，留着只会让调用方
 *  以为改它能改提示词。 */
function runAgent(startOpts, signal) {
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
      // 超时 / 引擎报错 / 需要交互：宿主那边可能还在跑，主动收掉，别白花 token
      if (err && expectedRunId && appCtx) {
        try {
          // 外层 try 只拦同步抛出，IPC 失败是 rejection
          void Promise.resolve(appCtx.agent.interrupt(expectedRunId)).catch(() => {});
        } catch (e) {
          /* 轮次可能已经结束 */
        }
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

    // 事件可能在 start resolve 之前到达，这时还不知道本轮 runId：
    // 先暂存，拿到 runId 后过滤并重放，避免上一轮收尾的 done/error 结束新轮次。
    let acceptAny = false;
    const queued = [];
    const handleEvent = (ev) => {
      if (settled || !ev || typeof ev !== "object") return;
      if (ev.runId && !expectedRunId && !acceptAny) {
        if (queued.length < 100) queued.push(ev);
        return;
      }
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
    };

    try {
      unlisten = appCtx.events.on("agent://" + PLUGIN_ID, handleEvent);
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
        } else {
          // 宿主没有返回 runId：退化为不过滤，但要把暂存的事件放出去
          acceptAny = true;
        }
        // 重放 start 之前到达的事件
        const early = queued.splice(0);
        for (const ev of early) handleEvent(ev);
        // 停止发生在 start resolve 之前时，宿主可能已经开始推事件
        if (signal && signal.aborted) finish(new Error("生成已停止"));
      })
      .catch((e) => finish(e));
  });
}

async function generateReport() {
  if (store.snap.generating) return;
  const facts = visibleFacts(store.snap.facts, store.snap.mutedWorkspaces);
  if (!facts) {
    set({ error: "请先扫描这些天的会话，再生成报告。" });
    return;
  }
  if (!facts.totals.sessions) {
    set({ error: "这个范围里没有被纳入统计的工作区，先扫描或恢复一个工作区。" });
    return;
  }

  const seq = ++genSeq;
  const targetRange = normalizeRange(store.snap.range);
  const targetKey = rangeKey(targetRange);
  const targetMode = store.snap.reportMode;
  const ctrl = new AbortController();
  activeAbort = ctrl;

  set({ generating: true, error: "", toast: "", streamText: "" });

  try {
    const cfg = store.snap.settings;
    // 「(未知工作区)」是扫描器的占位符，不能当作真实目录传给引擎。
    // 显式设置 > 插件数据目录 > 当天第一个会话的工作区。
    // 中间这层是默认值：引擎只在它下面跑一轮、不读文件，放插件目录比挂在
    // 真实项目名下干净——否则「生成日报」这个动作会作为工作产出被下次扫描统计。
    const firstWs = (facts.workspaces || [])
      .map((w) => w && w.workspace)
      .find((w) => w && w !== UNKNOWN_WORKSPACE) || "";
    const workspacePath = String(
      cfg.workspacePath || (await defaultWorkspace()) || firstWs || ""
    ).trim();
    if (!workspacePath || workspacePath === UNKNOWN_WORKSPACE) {
      throw new Error("没有可用于运行引擎的工作区，请在设置里选择「引擎运行目录」。");
    }

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

    const digest = buildFactsDigest(facts, store.snap.git);
    const prompt = promptFor(targetMode, targetRange) + "\n\n===== 事实 =====\n" + digest;

    const text = await runAgent(
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

    // 生成结果只放进编辑区，不自动落盘：点「保存」才写文件
    const sameView =
      rangeKey(store.snap.range) === targetKey && store.snap.reportMode === targetMode;
    set({ generating: false, streamText: "", runId: "" });
    if (sameView) set({ report: text });
    // 生成是最贵的产出，同样要进草稿体系：不然热重载/重启就没了，
    // 而这正是草稿持久化要覆盖的「写到一半」场景。
    noteDraft(targetRange, targetMode, text);
    flash("报告已生成，点「保存」写入文件");
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

/** 会话 id / 工作区来自会话日志（外部输入），交给宿主前先做形状校验：
 *  它们会被当成参数转给宿主进程，不该原样透传任意字符串。 */
async function openSession(session) {
  const engine = String(session && session.engine ? session.engine : SCAN_ENGINE_ID);
  const sessionId = String(session && session.sessionId ? session.sessionId : "").trim();
  const workspace = String(session && session.workspace ? session.workspace : "").trim();
  // Claude Code 的 sessionId 是 UUID；放宽到「无空白、无路径分隔符」，
  // 既覆盖真实形状，也挡住 ../ 之类的注入尝试。
  if (!sessionId || sessionId.length > 128 || /[\s/\\:*?"<>|]/.test(sessionId)) {
    set({ error: "这个会话的 ID 看起来不合法，无法打开。" });
    return;
  }
  if (workspace && (workspace.length > 4096 || workspace.includes("\0"))) {
    set({ error: "这个会话记录的工作区路径不合法，无法打开。" });
    return;
  }
  try {
    await appCtx.sessions.selectSession(engine, sessionId, workspace || undefined);
  } catch (e) {
    set({ error: "打开会话失败：" + safeError(e) });
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

/** 切换扫描范围。preset 只是界面上的选中态，不影响读写哪个报告文件。 */
async function changeRange(next, preset) {
  const range = normalizeRange(next);
  const key = rangeKey(range);
  const pick = preset || store.snap.rangePreset;
  if (key === rangeKey(store.snap.range) && pick === store.snap.rangePreset) return;
  const extra = {
    rangePreset: pick,
    facts: null,
    git: null,
    error: "",
    mutedWorkspaces: [],
  };
  if (pick === "custom") extra.rangeDraft = range;
  await switchView(range, store.snap.reportMode, extra);
  // 切到这个范围如果之前扫过，直接把快照摆出来：不用再点一次「扫描」。
  // 只在用户还没等到新一轮扫描结果时才填（scanning 时不抢先）。
  void restoreFactsFor(range);
}

/**
 * 把某个范围内已存的扫描快照放回界面（如果存在）。
 * 只补「空的」那一屏：用户已经主动扫出结果时不能覆盖。
 */
/** 补读快照的轮次：同一范围连点几次「本周」，晚到的旧读盘不能盖掉新结果。 */
let restoreSeq = 0;

async function restoreFactsFor(range) {
  const r = normalizeRange(range);
  const key = rangeKey(r);
  if (store.snap.scanning) return;
  if (store.snap.facts) {
    // 已经有一份属于这个范围的结果（例如刚扫完），不用再读盘
    const cur = store.snap.facts.range;
    if (cur && cur.from === r.from && cur.to === r.to) return;
  }
  const seq = ++restoreSeq;
  const facts = await loadFactsSnapshot(r);
  if (!facts) return;
  // 读盘期间用户可能又换了范围，或开始了新一轮扫描
  if (seq !== restoreSeq) return;
  if (rangeKey(store.snap.range) !== key || store.snap.scanning) return;
  if (store.snap.facts) return;
  set({ facts: facts, mutedWorkspaces: [] });
  // git 结果没有跟着快照存：补跑一次，否则「未提交改动」那块是空的
  await reconcileGit(facts, r);
}

/** 预设按钮：单日 = 今天，本周 = 本周一至今天，自定义 = 保留当前范围并展开两个日期框。 */
function applyPreset(preset) {
  const today = todayStr();
  if (preset === "day") {
    void changeRange({ from: today, to: today }, "day");
    return;
  }
  if (preset === "week") {
    void changeRange({ from: weekStart(today), to: today }, "week");
    return;
  }
  // 切到自定义不改变范围，只是把两个输入框露出来
  const cur = normalizeRange(store.snap.range);
  set({ rangePreset: "custom", rangeDraft: cur });
}

/** 自定义范围的两个输入框：改一端时把另一端顶到合法位置，避免输入到一半就交换。 */
function changeRangeDraft(which, value) {
  const draft = Object.assign({}, store.snap.rangeDraft);
  draft[which] = value;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ""))) {
    set({ rangeDraft: draft });
    return;
  }
  // 用户把起点拖到终点之后：终点跟着走，而不是互换两端的值
  if (draft.from && draft.to) {
    if (which === "from" && draft.from > draft.to) draft.to = draft.from;
    if (which === "to" && draft.to < draft.from) draft.from = draft.to;
  }
  const range = normalizeRange(draft);
  if (rangeDays(range) > MAX_RANGE_DAYS) {
    // 不接受这次输入：界面上的日期值来自 store，会自己弹回去
    flash("一次最多看 " + MAX_RANGE_DAYS + " 天，更长的范围会拖慢扫描");
    return;
  }
  set({ rangeDraft: range });
  void changeRange(range, "custom");
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
  return h("div", { className: "wl-stat" }, h("span", null, props.label), h("b", null, fmtNum(props.value)));
}

function StatsStrip(props) {
  const t = props.facts.totals;
  return h(
    "div",
    { className: "wl-stats" },
    h(Stat, { label: "会话", value: t.sessions }),
    h(Stat, { label: "用户轮次", value: t.userTurns }),
    h(Stat, { label: "工具调用", value: t.toolCalls }),
    h(Stat, { label: "工具报错", value: t.toolErrors }),
    h(Stat, { label: "改动文件", value: t.editedFiles }),
    h(Stat, { label: "工作区", value: t.workspaces })
  );
}

/** 产品自己的元素：当天每个工作区一行，横轴 00–24 点；唯一的蓝只落在这里。 */
function DayTimeline(props) {
  // 00–24 的横轴只对单日成立：多日范围里周一的 10 点和周四的 15 点被画成
  // 一段连续区间，看起来像「同一天连干了 5 小时」。多日不画这条轴。
  if (rangeDays(store.snap.range) > 1) return null;
  const facts = props.facts;
  const byId = new Map();
  for (const s of facts.sessions) byId.set(s.sessionId, s);

  const rows = [];
  for (const group of facts.workspaces) {
    let from = null;
    let to = null;
    for (const id of group.sessions) {
      const s = byId.get(id);
      if (!s) continue;
      const a = minuteOfDay(s.firstSeenAt);
      const b = minuteOfDay(s.lastSeenAt || s.firstSeenAt);
      if (a == null) continue;
      from = from == null ? a : Math.min(from, a);
      to = to == null ? b : Math.max(to, b);
    }
    if (from == null) continue;
    rows.push({
      name: shortPath(group.workspace) || UNKNOWN_WORKSPACE,
      full: group.workspace,
      from: from,
      to: Math.max(to == null ? from : to, from + 1),
    });
  }
  if (!rows.length) return null;

  return h(
    "section",
    { className: "wl-timeline" },
    h(
      "div",
      { className: "wl-timeline-head" },
      h("h2", null, "今天的时间线"),
      h("span", null, rows.length + " 个工作区 · 00–24 点")
    ),
    rows.map((r, i) =>
      h(
        "div",
        { className: "wl-track-row", key: i },
        h("span", { className: "wl-track-name", title: r.full }, r.name),
        h(
          "div",
          { className: "wl-track" },
          h("span", {
            className: "wl-track-bar",
            title: hhmmFromMin(r.from) + "–" + hhmmFromMin(r.to),
            style: {
              left: ((r.from / 1440) * 100).toFixed(2) + "%",
              width: Math.max(((r.to - r.from) / 1440) * 100, 0.35).toFixed(2) + "%",
            },
          })
        ),
        h("span", { className: "wl-track-ends" }, hhmmFromMin(r.from) + "–" + hhmmFromMin(r.to))
      )
    ),
    h(
      "div",
      { className: "wl-axis" },
      ["00", "06", "12", "18", "24"].map((t) => h("span", { key: t }, t))
    )
  );
}

function SessionBlock(props) {
  const R = appCtx.react;
  const open = R.useState(false);
  const isOpen = open[0];
  const setOpen = open[1];
  // 快照是本机文件，字段可能是手改坏的类型：全在这里兜住，
  // 免得单个会话的脏数据把整页渲染打挂。
  const s = props.session && typeof props.session === "object" ? props.session : {};
  const allMessages = Array.isArray(s.userMessages) ? s.userMessages : [];
  const editedFiles = Array.isArray(s.editedFiles) ? s.editedFiles : [];
  const toolErrors = Array.isArray(s.toolErrors) ? s.toolErrors : [];
  const tools = Object.entries(s.tools && typeof s.tools === "object" ? s.tools : {})
    .filter(([, n]) => Number.isFinite(n))
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5);
  const toolTotal = Object.values(s.tools && typeof s.tools === "object" ? s.tools : {})
    .reduce((a, b) => a + (Number.isFinite(b) ? b : 0), 0);
  const messages = isOpen ? allMessages : allMessages.slice(0, 3);

  return h(
    "section",
    { className: "wl-session" },
    h(
      "div",
      { className: "wl-session-head" },
      h("span", { className: "wl-session-time" }, (hhmm(s.firstSeenAt) || "?") + "–" + (hhmm(s.lastSeenAt) || "?")),
      h("span", { className: "wl-session-id" }, String(s.sessionId).slice(0, 8)),
      h("span", { className: "wl-session-meta" }, s.userTurns + " 轮 · " + fmtNum(toolTotal) + " 次工具"),
      toolErrors.length ? h("span", { className: "wl-chip neg" }, toolErrors.length + " 报错") : null,
      s.continuedFromEarlierDay ? h("span", { className: "wl-chip" }, "跨天") : null,
      h("button", { className: "wl-btn ghost", onClick: () => void openSession(s) }, "打开会话")
    ),
    h(
      "div",
      null,
      h("span", { className: "wl-label" }, "用户要求"),
      h(
        "ul",
        { className: "wl-list" },
        messages.map((m, i) => h("li", { key: i, className: "wl-msg" }, clip(oneLine(m.text), 200))),
        s.userMessages.length > messages.length
          ? h("li", { className: "wl-files" }, "另有 " + (allMessages.length - messages.length) + " 条")
          : null
      ),
      allMessages.length > 3
        ? h(
            "button",
            { className: "wl-btn ghost", onClick: () => setOpen(!isOpen) },
            isOpen ? "收起" : "展开全部"
          )
        : null
    ),
    s.finalAssistantText
      ? h(
          "div",
          null,
          h("span", { className: "wl-label" }, "最后回复"),
          h("div", { className: "wl-note", title: oneLine(s.finalAssistantText) }, clip(oneLine(s.finalAssistantText), 300))
        )
      : null,
    tools.length ? h("div", { className: "wl-files" }, "工具 " + tools.map(([name, n]) => name + "×" + n).join(" · ")) : null,
    editedFiles.length
      ? h(
          "div",
          { className: "wl-files" },
          "改动 " + editedFiles.length + " 个文件：" +
            editedFiles.slice(0, 6).map(shortPath).join("、") +
            (editedFiles.length > 6 ? " …" : "")
        )
      : null
  );
}

function GitBlock(props) {
  const g = props.git;
  if (!g) return null;
  if (!g.isRepo) {
    return h(
      "div",
      { className: "wl-git" },
      h("div", { className: "wl-git-line" }, "git：不是仓库或无法读取" + (g.error ? "（" + clip(oneLine(g.error), 80) + "）" : ""))
    );
  }
  const commits = g.commits || [];
  const dirty = g.dirty || [];
  const cross = props.cross;
  return h(
    "div",
    { className: "wl-git" },
    h(
      "div",
      { className: "wl-git-line" },
      "git 提交 ", h("b", null, String(commits.length)), " 次" +
        (dirty.length ? " · " + dirty.length + " 个文件未提交" : " · 工作区干净")
    ),
    commits.slice(0, 6).map((c, i) =>
      h(
        "div",
        { key: i, className: "wl-commit" },
        h("span", { className: "hash" }, String(c.hash || "").slice(0, 7)),
        h("span", { className: "time" }, c.time || ""),
        h("span", { className: "subject", title: c.subject }, c.subject)
      )
    ),
    commits.length > 6 ? h("div", { className: "wl-git-line" }, "另有 " + (commits.length - 6) + " 次提交") : null,
    dirty.length
      ? h(
          "div",
          { className: "wl-git-line" },
          dirty.slice(0, 8).map((d, i) =>
            h("span", { key: i, className: "wl-dirty-item" }, String(d.code || "").trim().padEnd(2, " ") + " " + shortPath(d.path))
          ),
          dirty.length > 8 ? h("span", { className: "wl-dirty-item" }, "…") : null
        )
      : null,
    cross && cross.edited
      ? h(
          "div",
          { className: "wl-cross" },
          h(
            "div",
            { className: "wl-cross-line" },
            "会话改了 " + cross.edited + " 个文件",
            cross.pendingCount
              ? "，其中 " + cross.pendingCount + " 个仍是未提交改动"
              : "，git 里都没有未提交改动",
            cross.settledCount
              ? "；另有 " + cross.settledCount + " 个在 git 状态里看不到，可能已提交或被还原"
              : "",
            "。"
          ),
          cross.pending.length
            ? h(
                "div",
                { className: "wl-cross-line" },
                "仍未提交：" + cross.pending.map(shortPath).join("、") +
                  (cross.pendingCount > cross.pending.length ? " …" : "")
              )
            : null,
          cross.settled.length
            ? h(
                "div",
                { className: "wl-cross-line is-warn" },
                "对不上（会话改过、git 无未提交）：" + cross.settled.map(shortPath).join("、") +
                  (cross.settledCount > cross.settled.length ? " …" : "")
              )
            : null,
          cross.gitOnlyCount
            ? h(
                "div",
                { className: "wl-cross-line is-muted" },
                "git 有、这段范围没碰过 " + cross.gitOnlyCount + " 个：" +
                  cross.gitOnly.map(shortPath).join("、") +
                  (cross.gitOnlyCount > cross.gitOnly.length ? " …" : "")
              )
            : null
        )
      : null
  );
}

function WorkspaceCard(props) {
  const group = props.group;
  const byId = props.byId;
  const sessions = group.sessions.map((id) => byId.get(id)).filter(Boolean);
  const git = findGit(group.workspace);
  const commitCount = git && git.commits ? git.commits.length : 0;
  const cross = git && git.isRepo ? crossCheck(group.workspace, sessions, git) : null;

  return h(
    "details",
    { className: "wl-card" },
    h(
      "summary",
      { className: "wl-card-head" },
      h("span", { className: "wl-card-caret", "aria-hidden": "true" }),
      h(
        "div",
        { style: { minWidth: 0, flex: "1 1 auto" } },
        h("h2", { className: "wl-card-title" }, shortPath(group.workspace) || UNKNOWN_WORKSPACE),
        h("div", { className: "wl-card-path", title: group.workspace }, group.workspace)
      ),
      h(
        "div",
        { className: "wl-card-meta" },
        h("span", { className: "wl-chip" }, sessions.length + " 个会话 · " + group.userTurns + " 轮"),
        h("span", { className: "wl-chip" }, "改动 " + group.editedFiles.length + " 个文件"),
        commitCount ? h("span", { className: "wl-chip" }, commitCount + " 次提交") : null,
        h(
          "button",
          {
            className: "wl-btn ghost wl-card-ignore",
            title: "本次扫描里先隐藏这个工作区；重新扫描会回来",
            onClick: (e) => {
              e.preventDefault();
              e.stopPropagation();
              muteWorkspace(group.workspace);
            },
          },
          "不看这个"
        )
      )
    ),
    sessions.map((s) => h(SessionBlock, { key: s.sessionId, session: s })),
    h(GitBlock, { git: git, cross: cross })
  );
}

/** 按「本次临时隐藏的工作区」重算可见事实；隐藏只影响这一屏，不写设置。 */
function visibleFacts(facts, muted) {
  if (!facts) return facts;
  const list = Array.isArray(muted) ? muted : [];
  if (!list.length) return facts;
  const hidden = new Set(list.map(workspaceKey));
  const workspaces = (facts.workspaces || []).filter((w) => !hidden.has(workspaceKey(w.workspace)));
  if (workspaces.length === (facts.workspaces || []).length) return facts;
  const allowed = new Set(workspaces.map((w) => w.workspace));
  const sessions = (facts.sessions || []).filter((s) => allowed.has(s.workspace));
  const totals = Object.assign({}, facts.totals, {
    sessions: sessions.length,
    userTurns: sessions.reduce((n, s) => n + (s.userTurns || 0), 0),
    assistantTurns: sessions.reduce((n, s) => n + (s.assistantTurns || 0), 0),
    toolCalls: sessions.reduce(
      (n, s) => n + Object.values(s.tools || {}).reduce((a, b) => a + (Number.isFinite(b) ? b : 0), 0),
      0
    ),
    toolErrors: sessions.reduce((n, s) => n + (s.toolErrors || []).length, 0),
    editedFiles: new Set(sessions.flatMap((s) => s.editedFiles || [])).size,
    workspaces: workspaces.length,
  });
  return Object.assign({}, facts, { workspaces: workspaces, sessions: sessions, totals: totals });
}

function FactsView(props) {
  const snap = store.snap;
  const facts = props.facts;
  const byId = new Map();
  for (const s of facts.sessions) byId.set(s.sessionId, s);

  if (!facts.totals.sessions) {
    const raw = snap.facts;
    const muted = (snap.mutedWorkspaces || []).length;
    if (raw && raw.totals && raw.totals.sessions > 0 && muted) {
      return h(
        "div",
        { className: "wl-empty" },
        h("b", null, "这一屏的工作区都被你隐藏了"),
        "点下面的「全部显示」把它们放回来，或者重新扫描一次。",
        h(
          "div",
          { style: { marginTop: "12px" } },
          h("button", { className: "wl-btn", onClick: () => unmuteAll() }, "全部显示（" + muted + "）")
        )
      );
    }
    return h(
      "div",
      { className: "wl-empty" },
      h("b", null, rangeLabel(snap.range) + " 没有会话记录"),
      "换个日期范围，或在设置里检查会话根目录。"
    );
  }

  const mutedNames = (snap.mutedWorkspaces || [])
    .map((p) => shortPath(p) || p)
    .filter(Boolean);

  return h(
    "div",
    { style: { display: "flex", flexDirection: "column", gap: "16px" } },
    h(DayTimeline, { facts: facts }),
    h(
      "div",
      { className: "wl-sub" },
      "来源核对：" + facts.totals.filesScanned + " 个会话文件 · " +
      facts.totals.sessions + " 个会话 · " +
      (facts.totals.filesFailed ? "读取失败 " + facts.totals.filesFailed + " 个" : "失败 0") +
      // 从快照读回来的没有本次耗时：说清是上次扫的，别让人误以为刚扫完
      (facts._restored
        ? " · 上次扫描 " + shortStamp(facts.scannedAt)
        : " · 耗时 " + (facts._elapsedMs ? (facts._elapsedMs / 1000).toFixed(1) + " 秒" : "—")) +
      (snap.rechecking ? " · 正在核对 git…" : "")
    ),
    mutedNames.length
      ? h(
          "div",
          { className: "wl-muted-bar" },
          h(
            "span",
            null,
            "本次已隐藏 " + mutedNames.length + " 个工作区（" +
              mutedNames.slice(0, 2).join("、") +
              (mutedNames.length > 2 ? " 等" : "") +
              "）；重新扫描会回来。"
          ),
          h("span", { className: "wl-spacer" }),
          h("button", { className: "wl-btn ghost", onClick: () => unmuteAll() }, "全部显示")
        )
      : null,
    facts.workspaces.map((group) =>
      h(WorkspaceCard, { key: group.workspace, group: group, byId: byId })
    )
  );
}

/* ---------------------------------------------------------------- Markdown 预览 */

/** 会话短 ID（sessionId 前 8 位，界面与报告里都用它）→ 会话对象。
 *  renderMarkdown 对每个段落 / 列表项 / 表格单元格都调用行内渲染，
 *  每次重建索引等于把整棵渲染树的开销乘上段落数。按 facts 引用缓存一份。 */
let sessionIndexCache = { facts: null, muted: "", map: new Map() };
function sessionIndex() {
  const facts = visibleFacts(store.snap.facts, store.snap.mutedWorkspaces);
  const muted = (store.snap.mutedWorkspaces || []).join("\u0000");
  if (sessionIndexCache.facts === facts && sessionIndexCache.muted === muted) {
    return sessionIndexCache.map;
  }
  const map = new Map();
  if (facts && Array.isArray(facts.sessions)) {
    for (const s of facts.sessions) {
      const id = String(s.sessionId || "");
      if (id.length >= 8) map.set(id.slice(0, 8).toLowerCase(), s);
    }
  }
  sessionIndexCache = { facts: facts, muted: muted, map: map };
  return map;
}

/** 行内标记：粗体、行内代码、http(s) 链接、会话短 ID。不用 innerHTML，避免把报告内容当 HTML 执行。 */
function markdownInline(text, keyBase) {
  const nodes = [];
  const sessions = sessionIndex();
  const re = /(\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\([^)]+\)|\b[0-9a-f]{8}\b)/g;
  let last = 0;
  let n = 0;
  let m;
  while ((m = re.exec(text))) {
    if (m.index > last) nodes.push(text.slice(last, m.index));
    const tok = m[0];
    const key = keyBase + "i" + n;
    if (tok.startsWith("**")) {
      nodes.push(h("strong", { key: key }, tok.slice(2, -2)));
    } else if (tok.startsWith("`")) {
      nodes.push(h("code", { key: key, className: "wl-md-code" }, tok.slice(1, -1)));
    } else if (tok.startsWith("[")) {
      const link = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(tok);
      if (link && /^https?:\/\//i.test(link[2])) {
        nodes.push(
          h("a", { key: key, href: link[2], target: "_blank", rel: "noreferrer noopener" }, link[1])
        );
      } else {
        nodes.push(tok);
      }
    } else if (sessions.has(tok)) {
      // 报告里引用的会话短 ID：点一下直接打开那个会话
      const s = sessions.get(tok);
      nodes.push(
        h(
          "button",
          {
            key: key,
            type: "button",
            className: "wl-md-session",
            title: "打开会话 " + shortPath(s.workspace || "") + "（" + tok + "）",
            onClick: () => void openSession(s),
          },
          tok
        )
      );
    } else {
      nodes.push(tok);
    }
    last = m.index + tok.length;
    n += 1;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}

/** 够报告用的 Markdown 子集：标题、表格、列表、引用、代码块、分隔线、段落。 */
function renderMarkdown(text) {
  const lines = String(text || "").replace(/\r\n?/g, "\n").split("\n");
  const out = [];
  let key = 0;
  let i = 0;
  let list = null;

  const flushList = () => {
    if (!list) return;
    const items = list.items.map((item, idx) =>
      h("li", { key: "li" + idx }, markdownInline(item, "l" + key + "_" + idx + "_"))
    );
    out.push(h(list.type, { key: "md" + key++, className: "wl-md-list" }, items));
    list = null;
  };

  // GFM 表格：表头行 + |---| 分隔行；分隔行的冒号决定列对齐
  const isTableStart = (idx) =>
    idx + 1 < lines.length &&
    lines[idx].indexOf("|") >= 0 &&
    /^\s*\|?\s*:?-{1,}:?\s*(?:\|\s*:?-{1,}:?\s*)*\|?\s*$/.test(lines[idx + 1]) &&
    lines[idx + 1].indexOf("|") >= 0;
  const splitRow = (raw) => {
    let s = String(raw || "").trim();
    if (s.startsWith("|")) s = s.slice(1);
    if (s.endsWith("|")) s = s.slice(0, -1);
    return s.split("|").map((cell) => cell.trim());
  };
  const cellAlign = (spec) => {
    const left = spec.startsWith(":");
    const right = spec.endsWith(":");
    if (left && right) return "center";
    if (right) return "right";
    return "";
  };

  while (i < lines.length) {
    const line = lines[i];

    if (/^```/.test(line)) {
      flushList();
      const lang = line.slice(3).trim();
      const buf = [];
      i += 1;
      while (i < lines.length && !/^```/.test(lines[i])) {
        buf.push(lines[i]);
        i += 1;
      }
      if (i < lines.length) i += 1;
      out.push(
        h(
          "pre",
          { key: "md" + key++, className: "wl-md-pre" },
          h("code", { className: lang ? "language-" + lang : "" }, buf.join("\n"))
        )
      );
      continue;
    }

    if (isTableStart(i)) {
      flushList();
      const head = splitRow(line);
      const aligns = splitRow(lines[i + 1]).map(cellAlign);
      i += 2;
      const rows = [];
      while (i < lines.length && lines[i].trim() && lines[i].indexOf("|") >= 0) {
        rows.push(splitRow(lines[i]));
        i += 1;
      }
      const th = head.map((cell, ci) =>
        h(
          "th",
          { key: "th" + ci, style: aligns[ci] ? { textAlign: aligns[ci] } : undefined },
          markdownInline(cell, "th" + key + "_" + ci + "_")
        )
      );
      const trs = rows.map((cells, ri) =>
        h(
          "tr",
          { key: "tr" + ri },
          head.map((_, ci) =>
            h(
              "td",
              { key: "td" + ci, style: aligns[ci] ? { textAlign: aligns[ci] } : undefined },
              markdownInline(cells[ci] || "", "td" + key + "_" + ri + "_" + ci + "_")
            )
          )
        )
      );
      out.push(
        h(
          "div",
          { key: "md" + key++, className: "wl-md-table-wrap" },
          h(
            "table",
            { className: "wl-md-table" },
            h("thead", null, h("tr", null, th)),
            h("tbody", null, trs)
          )
        )
      );
      continue;
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      flushList();
      const level = Math.min(6, heading[1].length);
      out.push(
        h(
          "h" + level,
          { key: "md" + key++, className: "wl-md-h" + level },
          markdownInline(heading[2], "h" + key + "_")
        )
      );
      i += 1;
      continue;
    }

    if (/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      flushList();
      out.push(h("hr", { key: "md" + key++, className: "wl-md-hr" }));
      i += 1;
      continue;
    }

    if (/^>\s?/.test(line)) {
      flushList();
      const buf = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) {
        buf.push(lines[i].replace(/^>\s?/, ""));
        i += 1;
      }
      out.push(
        h(
          "blockquote",
          { key: "md" + key++, className: "wl-md-quote" },
          markdownInline(buf.join(" "), "q" + key + "_")
        )
      );
      continue;
    }

    const ul = /^\s*[-*+]\s+(.*)$/.exec(line);
    const ol = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (ul || ol) {
      const type = ul ? "ul" : "ol";
      if (!list || list.type !== type) {
        flushList();
        list = { type: type, items: [] };
      }
      list.items.push((ul || ol)[1]);
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
    while (
      i < lines.length &&
      lines[i].trim() &&
      !/^(?:#{1,6}\s|[-*+]\s|\d+[.)]\s|>|```)/.test(lines[i]) &&
      !isTableStart(i)
    ) {
      buf.push(lines[i]);
      i += 1;
    }
    out.push(
      h("p", { key: "md" + key++, className: "wl-md-p" }, markdownInline(buf.join(" "), "p" + key + "_"))
    );
  }
  flushList();
  return out;
}

function ReportPanel() {
  const R = appCtx.react;
  const snap = store.snap;
  // 当前编辑的是哪一份：口吻/范围一变，编辑器里的旧文本就不再属于这一屏
  const viewKey = REPORT_KEY(snap.range, snap.reportMode);

  // 编辑草稿留在本组件：受控于 store 时每次按键都会让整棵树重渲染
  const draftState = R.useState(snap.report);
  const draft = draftState[0];
  const setDraft = draftState[1];
  const seen = R.useRef(snap.report);
  // 草稿只在点「保存」时落盘，编辑过程中不自动写文件
  const saveState = R.useState("");
  const saveStatus = saveState[0];
  const setSaveStatus = saveState[1];
  // 原文编辑 / 渲染预览
  const viewState = R.useState("source");
  const viewMode = viewState[0];
  const setViewMode = viewState[1];

  // 切换范围或口吻后，上一份报告的保存状态不该跟过来
  const reportViewKey = rangeKey(snap.range) + "|" + snap.reportMode;
  const seenView = R.useRef(reportViewKey);
  if (seenView.current !== reportViewKey) {
    seenView.current = reportViewKey;
    if (saveStatus) setSaveStatus("");
  }

  // 生成完成、切换范围/口吻等外部变化时，用 store 的值覆盖草稿
  if (seen.current !== snap.report) {
    seen.current = snap.report;
    // 生成完成或切换内容后，上一份报告的「已保存 / 保存失败」不再适用
    if (saveStatus && saveStatus !== "saving") setSaveStatus("");
    if (draft !== snap.report) setDraft(snap.report);
  }
  // 编辑区的最新文本同步给模块级：切口吻/扫描/卸载走的是 store，
  // 用户在没 blur 的情况下点按钮，那一版必须先被看到。
  // 视图刚切换的这一帧里 draft 还是上一份的文本，不能挂到新 key 上：
  // 上一帧已经按旧 key 发布过了，这里跳过，下一个渲染帧会自动补上。
  const editorKeyRef = R.useRef(viewKey);
  const viewChanged = editorKeyRef.current !== viewKey;
  if (viewChanged) editorKeyRef.current = viewKey;
  if (!viewChanged) noteEditorDraft(viewKey, draft);

  // 点按钮前先把草稿交回 store，后续动作读的才是最新内容
  const commit = () => {
    if (draft !== store.snap.report) {
      seen.current = draft;
      set({ report: draft });
    }
    noteEditorDraft(viewKey, draft);
  };

  const tones = allTones();
  const currentTone = tones.find((t) => t.id === snap.reportMode);
  const modeShort = currentTone ? currentTone.short : "日报";
  // 内置口吻走按钮，自定义口吻走下拉；当前停在哪个决定下拉的选中态。
  // 切到内置口吻后，下拉一律回到「未选中」——口吻行里只有一个高亮，不能两个都像是选中的。
  const customTones = tones.filter((t) => !t.builtin);
  const customCurrent = customTones.some((t) => t.id === snap.reportMode);
  const customPick = customTones.find((t) => t.id === snap.reportMode);
  // 口吻和范围不匹配时（单日选周报、多日选日报）给一句原因，不禁用
  const rangeHint = toneRangeHint(snap.reportMode, snap.range);
  const hasReport = !!draft.trim();
  // draft 与 reportSaved 不等说明有改动还没点保存
  const dirty = hasReport && draft !== snap.reportSaved;
  const reportFile = reportRel(snap.range, snap.reportMode);
  const storeDir = snap.storage && snap.storage.path ? snap.storage.path : "";
  const reportAbs = joinDisplayPath(storeDir, reportFile);
  const factsNow = visibleFacts(snap.facts, snap.mutedWorkspaces);
  const canGenerate = !!factsNow && factsNow.totals.sessions > 0 && !snap.generating;

  // 保存是唯一一次写盘，编辑过程中不产生文件
  const saveNow = () => {
    if (!draft.trim() || saveStatus === "saving") return;
    // 先把编辑区交回 store：保存期间用户继续输入，不会被回滚
    commit();
    const text = draft;
    const targetRange = normalizeRange(store.snap.range);
    const targetKey = rangeKey(targetRange);
    const targetMode = store.snap.reportMode;
    const targetAbs = reportAbs;
    setSaveStatus("saving");
    void (async () => {
      const sameView = () =>
        rangeKey(store.snap.range) === targetKey && store.snap.reportMode === targetMode;
      try {
        await saveReportText(targetRange, targetMode, text);
        // 期间切了日期/口吻：磁盘缓存已由 saveReportText 更新，不要再动当前视图
        if (!sameView()) return;
        // 只更新「已保存到哪一版」：report 可能已经被用户继续编辑过，不能整体覆盖
        set({ reportSaved: text });
        setSaveStatus("saved");
        flash("报告已保存到 " + targetAbs);
      } catch (e) {
        if (!sameView()) return;
        setSaveStatus("error");
        set({ error: "报告保存失败：" + safeError(e) });
      }
    })();
  };

  return h(
    "aside",
    { className: "wl-report" },
    h(
      "div",
      { className: "wl-report-head" },
      h("h2", null, "报告"),
      h("span", { className: "wl-report-range", title: rangeLabel(snap.range) }, rangeLabel(snap.range)),
      h("span", { className: "wl-spacer" }),
      h(
        "div",
        { className: "wl-seg" },
        h(
          "button",
          {
            className: viewMode === "source" ? "on" : "",
            title: "编辑 Markdown 原文",
            onClick: () => setViewMode("source"),
          },
          "原文"
        ),
        h(
          "button",
          {
            className: viewMode === "preview" ? "on" : "",
            title: "查看排版后的效果",
            onClick: () => setViewMode("preview"),
          },
          "预览"
        )
      )
    ),
    // 口吻单独一行：内置三个固定按钮，自定义收进右侧下拉。
    // 不横向滚动——滚动条一藏，后面的口吻就彻底不可达了。
    // 这一行高度固定，切换口吻、新增口吻都不会改变面板的上下结构。
    h(
      "div",
      { className: "wl-report-tabs" },
      h(
        "div",
        { className: "wl-seg wl-seg-tones" },
        tones
          .filter((t) => t.builtin)
          .map((t) => {
            // 悬停就能看到「这个口吻和当前范围合不合适」，点下去依然允许
            const hint = toneRangeHint(t.id, snap.range);
            return h(
              "button",
              {
                key: t.id,
                className: snap.reportMode === t.id ? "on" : "",
                disabled: snap.generating,
                title: snap.generating
                  ? "生成完成后才能切换"
                  : "切换到" + t.label + (hint ? "\n" + hint : ""),
                onClick: () => void switchReportMode(t.id),
              },
              t.short
            );
          })
      ),
      // 自定义口吻放在下拉里：有几个都能全部列出来，不用猜右边还有没有东西
      customTones.length
        ? h(
            "div",
            { className: "wl-tone-pick" + (customCurrent ? " is-current" : "") },
            h(Dropdown, {
              items: customTones.map((t) => ({ value: t.id, label: t.label })),
              // 只有真的停在自定义口吻上才填值；切到内置口吻就回到未选中的占位
              value: customPick ? customPick.id : "",
              placeholder: "自定义口吻",
              disabled: snap.generating,
              onChange: (id) => void switchReportMode(id),
            })
          )
        : null
    ),
    h(
      "div",
      { className: "wl-report-actions" },
      snap.generating
        ? h(
            "button",
            { className: "wl-btn danger block", onClick: () => void stopGenerate() },
            h(
              "span",
              { className: "wl-btn-inner" },
              h("span", { className: "wl-spinner" }),
              "停止"
            )
          )
        : h(
            "button",
            { className: "wl-btn primary block", disabled: !canGenerate, onClick: () => void generateReport() },
            "生成" + modeShort
          )
    ),
    h(
      "div",
      { className: "wl-report-state" },
      snap.generating
        ? h(
            "span",
            { className: "wl-state-live" },
            // 状态行也要给出「在动」的证据：字数在涨，是用户最能感知的进度
            "正在生成" + (snap.streamText ? " · " + snap.streamText.length + " 字符" : "") + "，可随时停止"
          )
        : hasReport
          ? saveStatus === "saving"
            ? "正在保存… · " + draft.length + " 字符"
            : saveStatus === "error"
              ? "保存失败 · " + draft.length + " 字符"
              : dirty
                ? "有未保存的修改 · " + draft.length + " 字符"
                : "已保存 · " + draft.length + " 字符"
          : "尚未生成"
    ),
    // 编辑区固定成一个槽位：生成前占位、生成中流式、生成后编辑器，
    // 三种状态换的都是槽位里的内容，面板高度与下方按钮位置不变。
    h(
      "div",
      { className: "wl-report-body" },
      snap.generating
        ? h(
            // 外层只负责描边、裁切和扫光条：它不滚动，扫光才不会被内容卷走。
            "div",
            { className: "wl-stream-box is-live" },
            h(
              "div",
              {
                className: "wl-stream",
                // 内容一直在长，视口要跟着走；否则用户盯着的是第一屏。
                ref: (el) => {
                  if (el && typeof el.scrollHeight === "number" && el.scrollHeight > el.clientHeight) {
                    el.scrollTop = el.scrollHeight;
                  }
                },
              },
              snap.streamText
                ? h(
                    "div",
                    { className: "wl-stream-text" },
                    snap.streamText,
                    h("span", { className: "wl-caret", "aria-hidden": "true" })
                  )
                : h(
                    "div",
                    { className: "wl-wait" },
                    h(
                      "span",
                      { className: "wl-dots", "aria-hidden": "true" },
                      h("i", { key: "d1" }),
                      h("i", { key: "d2" }),
                      h("i", { key: "d3" })
                    ),
                    "正在等待模型返回…"
                  )
            )
          )
        : hasReport
          ? viewMode === "preview"
            ? h("div", { className: "wl-md" }, renderMarkdown(draft))
            : h("textarea", {
                className: "wl-textarea",
                value: draft,
                spellCheck: false,
                onChange: (e) => {
                  setDraft(e.target.value);
                  // 输入就记一份：插件热重载发生在「正在写」的时候，只靠切视图时
                  // 的 stash 会丢掉最后一段。防抖在 persistDraftsSoon 里做。
                  noteDraft(store.snap.range, store.snap.reportMode, e.target.value);
                },
                onBlur: commit,
                placeholder: "报告会出现在这里，可以直接修改。",
              })
          : h(
              "div",
              { className: "wl-report-empty" },
              h(
                "div",
                { className: "wl-report-empty-inner" },
                "扫描后点「生成" + modeShort + "」，模型只依据上面的事实写作；结果会出现在这里。",
                // 范围与口吻不匹配时说明后果，并给出更合适的选项；不禁用
                rangeHint ? h("p", { className: "wl-report-hint" }, rangeHint) : null,
                rangeHint
                  ? h("p", { className: "wl-report-hint is-quiet" }, "也可以切到：" + suggestTone(snap.range))
                  : null
              )
            )
    ),
    // 操作行始终渲染：没有报告时禁用，避免生成前后突然多出/少掉一排按钮。
    h(
      "div",
      { className: "wl-report-foot" },
      h(
        "button",
        {
          className: "wl-btn",
          title: "保存到 " + reportAbs,
          disabled: !hasReport || saveStatus === "saving" || snap.generating,
          onClick: () => saveNow(),
        },
        saveStatus === "saving" ? "保存中…" : "保存"
      ),
      h(
        "button",
        {
          className: "wl-btn",
          title: "复制报告全文到系统剪贴板",
          disabled: !hasReport,
          onClick: () => {
            commit();
            void copyReport();
          },
        },
        "复制全文"
      )
    ),
    h("p", { className: "wl-report-path", title: reportAbs }, "写入 " + reportAbs)
  );
}

function headSub(snap, facts) {
  if (snap.scanning) return "正在读取会话记录…";
  if (!facts) {
    return "按范围汇总 " + SCAN_ENGINE_LABEL + " 会话与 git 改动；事实在本地生成，不消耗 token。";
  }
  const t = facts.totals;
  if (!t.sessions) {
    if (snap.facts && snap.facts.totals && snap.facts.totals.sessions > 0) {
      return "本次扫描的工作区都被你隐藏了；重新扫描或点「全部显示」即可恢复。";
    }
    return rangeLabel(snap.range) + " 没有会话记录。";
  }
  const parts = [t.sessions + " 个会话", t.workspaces + " 个工作区"];
  if (rangeDays(snap.range) > 1) parts.push(rangeDays(snap.range) + " 天");
  const muted = (snap.mutedWorkspaces || []).length;
  if (muted) parts.push("已隐藏 " + muted + " 个");
  if (snap.git) {
    const commits = snap.git.reduce((n, g) => n + ((g.commits || []).length), 0);
    const dirty = snap.git.reduce((n, g) => n + ((g.dirty || []).length), 0);
    parts.push("git 提交 " + commits + " 次");
    if (dirty) parts.push(dirty + " 个文件未提交");
  } else if (snap.rechecking) {
    parts.push("正在核对 git…");
  }
  parts.push("扫描于 " + (hhmm(facts.scannedAt) || "—"));
  return parts.join(" · ");
}

/** 范围预设 + 自定义的两个日期。生成中禁用，避免结果落到别的文件里。 */
function RangePicker() {
  const snap = useSnap();
  const multi = rangeDays(snap.range) > 1;
  return h(
    "div",
    { className: "wl-range" },
    h(
      "div",
      { className: "wl-seg" },
      PRESETS.map((p) =>
        h(
          "button",
          {
            key: p.value,
            className: snap.rangePreset === p.value ? "on" : "",
            disabled: snap.generating,
            title: snap.generating ? "生成完成后才能切换范围" : "按" + p.label + "扫描",
            onClick: () => applyPreset(p.value),
          },
          p.label
        )
      )
    ),
    snap.rangePreset === "custom"
      ? h(
          "div",
          { className: "wl-range-inputs" },
          h("input", {
            type: "date",
            className: "wl-input",
            value: snap.rangeDraft.from,
            max: snap.rangeDraft.to,
            disabled: snap.generating,
            title: "起始日期",
            onChange: (e) => changeRangeDraft("from", e.target.value),
          }),
          h("span", { className: "wl-range-sep" }, "至"),
          h("input", {
            type: "date",
            className: "wl-input",
            value: snap.rangeDraft.to,
            min: snap.rangeDraft.from,
            disabled: snap.generating,
            title: "结束日期",
            onChange: (e) => changeRangeDraft("to", e.target.value),
          })
        )
      : null,
    multi && snap.rangePreset !== "custom"
      ? h("span", { className: "wl-range-note" }, rangeLabel(snap.range))
      : null
  );
}

/**
 * 从「报告历史」点进一条：打开只读查看器，不碰右侧生成面板。
 *
 * 之前是直接 switchView 到那个范围与口吻，于是点一下历史，右侧正在写的草稿
 * 就被换成了旧内容——「生成」那块地方是工作台，不是阅读器。查看走浮层，
 * 想接着改再点浮层里的「在面板中打开」，那才是用户明确表达要切换。
 */
async function openReportEntry(entry) {
  if (!entry) return;
  const range = normalizeRange({ from: entry.from, to: entry.to });
  const mode = String(entry.mode || "");
  // 先开浮层并把标题等元信息填上，正文随后异步补：点下去立刻有反应
  set({
    // 去查看别的报告，就别让某一行继续停在「再点一次就删」的状态
    pendingDelete: null,
    viewer: {
      rel: entry.rel,
      from: range.from,
      to: range.to,
      mode: mode,
      size: typeof entry.size === "number" ? entry.size : -1,
      text: "",
      loading: true,
      error: "",
    },
  });
  let text = "";
  let error = "";
  try {
    const doc = await appCtx.documentStorage.readText(entry.rel);
    text = doc && typeof doc.content === "string" ? doc.content : "";
  } catch (e) {
    // 丢掉了就看不到了：把原因显示在浮层里，而不是空白一片
    error = safeError(e);
  }
  // 期间用户可能已经关掉或改看了别的：只写回自己这一次
  const cur = store.snap.viewer;
  if (!cur || cur.rel !== entry.rel) return;
  set({
    viewer: Object.assign({}, cur, { text: text, loading: false, error: error, size: text.length }),
  });
}

/** 关掉查看器。 */
function closeViewer() {
  if (store.snap.viewer) set({ viewer: null, pendingDelete: null });
}

/* ------------------------------------------------------------ 删除报告 */

/**
 * 删除一份已保存的报告。
 *
 * 只删 `reports/` 下这一个文件，不碰别的；删之前要经过一次确认
 * （`pendingDelete` 记着待删的 rel），因为这是插件里唯一不可撤销的操作。
 */
async function deleteReport(entry) {
  if (!entry || !entry.rel) return;
  const rel = entry.rel;
  try {
    await appCtx.documentStorage.remove(rel);
  } catch (e) {
    // remove 对不存在的文件可能抛错；那也算删掉了
    if (!/not found|不存在|ENOENT/i.test(String(e && e.message))) {
      set({ error: "删除报告失败：" + safeError(e) });
      flash("删除失败，文件还在");
      set({ pendingDelete: null });
      return;
    }
  }
  // 宿主原子写入留下的 .bak 属于同一份报告，一起清掉
  await removeDoc(rel + ".bak");
  // 内存里那份磁盘副本也要清掉，否则切回这个范围还会看到已删的内容。
  // 草稿是另一回事：它可能是用户此刻正在写、还没保存的内容，
  // 删磁盘上的旧报告不等于要丢掉编辑区里的东西。
  const key = REPORT_KEY({ from: entry.from, to: entry.to }, entry.mode);
  reportDiskText.delete(key);
  diskWriteSeq += 1;
  // 正在看的就是这份：关掉浮层
  const cur = store.snap.viewer;
  if (cur && cur.rel === rel) set({ viewer: null });
  // 面板里现在装的正是这份报告：只把「已保存到哪一版」清掉。
  // 编辑区里可能是未保存的草稿，删除磁盘文件不该连带清空它。
  const isCurrentPanel =
    rangeKey(store.snap.range) === rangeKey({ from: entry.from, to: entry.to }) &&
    store.snap.reportMode === entry.mode;
  if (isCurrentPanel) {
    set({ reportSaved: "" });
  }
  // 草稿只有两种身份：用户此刻正在编辑（面板就是这份）时留着，
  // 否则是早前留下的、对应的磁盘文件已经没了，留着只会在切回来时复活旧内容。
  if (!isCurrentPanel) reportDraftText.delete(key);
  persistDraftsSoon();
  set({ pendingDelete: null });
  flash(isCurrentPanel && String(store.snap.report || "").trim()
    ? "已删除磁盘上的 " + rel + "；编辑区里未保存的内容仍保留"
    : "已删除 " + rel);
  await loadReportList();
}

/** 把查看器里这份报告装进右侧面板，接着改。用户明确要求才做这一步。 */
async function openViewerInPanel() {
  const v = store.snap.viewer;
  if (!v || store.snap.generating) return;
  const range = { from: v.from, to: v.to };
  const mode = v.mode;
  if (!allTones().some((t) => t.id === mode)) {
    flash("这份报告的写法「" + mode + "」已经不存在了，只能查看不能重新生成");
  }
  closeViewer();
  await switchView(range, mode, {
    rangePreset: range.from === range.to ? "day" : "custom",
    rangeDraft: range,
    facts: null,
    git: null,
    error: "",
    mutedWorkspaces: [],
  });
  // 和 changeRange 一样：切到某个范围就把上次扫描的快照摆回来，
  // 否则从历史打开旧报告后左侧扫描区是空的。
  void restoreFactsFor(range);
}

/**
 * 报告历史：按月分组列出已保存的报告，点一条在浮层里只读查看。
 *
 * 分组依据是报告覆盖的「日期」（结束日所在月），不是文件名——用户想的是
 * 「上个月那几份」。列表本身限高滚动：攒到几十上百份时，展开它不该把整页
 * 顶到很远的地方，也不该让扫描/报告面板被挤到看不见。
 */
function ReportHistory() {
  const R = appCtx.react;
  const snap = useSnap();
  const list = snap.reportList;
  const openState = R.useState(false);
  const open = openState[0];
  const setOpen = openState[1];

  const rows = Array.isArray(list) ? list : [];
  const currentKey = rangeKey(snap.range) + "|" + snap.reportMode;
  const busy = snap.generating;
  // 读取失败和「没有报告」是两件事：前者要说清原因，别让用户以为是自己没保存
  const listError = snap.reportListError || "";
  const viewingRel = snap.viewer ? snap.viewer.rel : "";
  const pendingDelete = snap.pendingDelete || "";

  // 过滤：按日期或口吻名匹配（「11-08」「周报」「个人复盘」都行）。
  // 过滤时不折叠月份——正在找东西，每一组都摊开比多点几下强。
  const filter = String(snap.historyFilter || "").trim().toLowerCase();
  const matchRow = (r) => {
    if (!filter) return true;
    const probe = [r.from, r.to, r.from + " 至 " + r.to, r.mode, toneLabel(r.mode)]
      .join(" ")
      .toLowerCase();
    return probe.includes(filter);
  };
  const filtered = rows.filter(matchRow);

  // 每个月的展开状态。没点过的月份走默认：最新一个月展开，更早的收起——
  // 报告攒到几个月时，先看到「有哪些月」，而不是把最老的那份也铺在眼前。
  // 用户点过之后记下来，不再被默认值覆盖。
  const monthOpenState = R.useState({});
  const monthOpen = monthOpenState[0];
  const setMonthOpen = monthOpenState[1];
  const isMonthOpen = (month, index) =>
    Object.prototype.hasOwnProperty.call(monthOpen, month) ? !!monthOpen[month] : index === 0;
  const toggleMonth = (month, index) => {
    // 用函数式更新：连续点两个不同月份时，基于上一次的结果合并，不丢前一次
    setMonthOpen((prev) => {
      const was = Object.prototype.hasOwnProperty.call(prev, month) ? !!prev[month] : index === 0;
      return Object.assign({}, prev, { [month]: !was });
    });
  };

  // 已经按结束日倒序排过，这里只做相邻切分，不重新排序
  const groups = [];
  for (const r of filtered) {
    const month = String(r.to || "").slice(0, 7);
    const last = groups[groups.length - 1];
    if (last && last.month === month) last.rows.push(r);
    else groups.push({ month: month, rows: [r] });
  }

  const countText = filter
    ? filtered.length + " / " + rows.length + " 份"
    : rows.length + " 份" + (groups.length > 1 ? " · " + groups.length + " 个月" : "");

  return h(
    "section",
    { className: "wl-history" },
    h(
      "button",
      {
        className: "wl-history-toggle",
        "aria-expanded": open ? "true" : "false",
        onClick: () => {
          setOpen(!open);
          // 每次展开都重新读一遍：报告可能在别的窗口里被改过
          if (!open) void loadReportList();
          // 收起时清掉「等待确认删除」：下次打开不该还停在一键即删的状态
          else if (store.snap.pendingDelete) set({ pendingDelete: null });
        },      },
      h("span", { className: "wl-card-caret", "aria-hidden": "true" }),
      h("b", null, "报告历史"),
      h(
        "span",
        { className: "wl-muted" },
        snap.reportListLoading
          ? "正在读取…"
          : listError
            ? "读取失败"
            : list
              ? countText
              : "点开查看已保存的报告"
      )
    ),
    open
      ? listError
        ? h("p", { className: "wl-history-empty" }, "读取报告目录失败：" + listError)
        : rows.length
        ? h(
            "div",
            { className: "wl-history-body" },
            // 报告多到需要折叠时，查找才是真需求；只有一两份就别占一行地方了。
            // 但过滤词还在时必须露出输入框：删到 6 份以下时行数条件会让
            // 输入框和「清空」一起消失，列表卡死在过滤态且没有出口。
            rows.length > 6 || filter
              ? h(
                  "div",
                  { className: "wl-history-search" },
                  h("input", {
                    type: "search",
                    className: "wl-input",
                    value: snap.historyFilter || "",
                    placeholder: "按日期或口吻找…",
                    "aria-label": "过滤报告历史",
                    onChange: (e) => set({ historyFilter: e.target.value }),
                  }),
                  filter
                    ? h(
                        "button",
                        {
                          className: "wl-btn ghost",
                          title: "清空过滤",
                          onClick: () => set({ historyFilter: "" }),
                        },
                        "清空"
                      )
                    : null
                )
              : null,
            filtered.length
              ? h(
                  "div",
                  { className: "wl-history-scroll" },
                  groups.map((g, gi) => {
                    // 过滤时全部摊开：用户正在找东西，收起只会多一次点击
                    const show = filter ? true : isMonthOpen(g.month, gi);
                    return h(
                      "div",
                      { key: g.month, className: "wl-history-group" },
                      h(
                        "button",
                        {
                          className: "wl-history-month",
                          "aria-expanded": show ? "true" : "false",
                          disabled: !!filter,
                          title: filter ? g.month : (show ? "收起 " : "展开 ") + g.month,
                          onClick: () => toggleMonth(g.month, gi),
                        },
                        filter
                          ? null
                          : h("span", { className: "wl-card-caret", "aria-hidden": "true" }),
                        h("span", null, g.month),
                        h("span", { className: "wl-history-month-n" }, g.rows.length + " 份")
                      ),
                      show
                        ? h(
                            "ul",
                            { className: "wl-history-list" },
                            g.rows.map((r) =>
                              h(
                                "li",
                                {
                                  key: r.rel,
                                  className: currentKey === r.key + "|" + r.mode ? "is-current" : "",
                                },
                                h(
                                  "button",
                                  {
                                    className: "wl-history-row" + (viewingRel === r.rel ? " is-viewing" : ""),
                                    "aria-current": viewingRel === r.rel ? "true" : undefined,
                                    disabled: busy,
                                    title: busy ? "生成完成后才能查看" : "查看 " + r.rel,
                                    onClick: () => void openReportEntry(r),
                                  },
                                  h("span", { className: "wl-history-date" }, r.from === r.to ? r.from : r.from + " 至 " + r.to),
                                  h("span", { className: "wl-history-tone" }, toneLabel(r.mode)),
                                  typeof r.size === "number" && r.size > 0
                                    ? h("span", { className: "wl-history-size" }, fmtNum(r.size) + " 字符")
                                    : null
                                ),
                                // 删除是不可撤销的：先点一次变成「确认删除」，再点才真删
                                h(
                                  "button",
                                  {
                                    className:
                                      "wl-history-del" + (pendingDelete === r.rel ? " is-confirm" : ""),
                                    disabled: busy,
                                    title:
                                      pendingDelete === r.rel
                                        ? "再点一次就删除 " + r.rel
                                        : "删除这份报告",
                                    onClick: () => {
                                      if (pendingDelete === r.rel) void deleteReport(r);
                                      else set({ pendingDelete: r.rel });
                                    },
                                  },
                                  pendingDelete === r.rel ? "确认删除" : "删除"
                                )
                              )
                            )
                          )
                        : null
                    );
                  })
                )
              : h(
                  "p",
                  { className: "wl-history-empty" },
                  "没有匹配「" + filter + "」的报告。",
                  h(
                    "button",
                    {
                      className: "wl-btn ghost",
                      style: { marginLeft: "8px" },
                      onClick: () => set({ historyFilter: "" }),
                    },
                    "清空过滤"
                  )
                )
          )
        : h("p", { className: "wl-history-empty" }, "还没有保存过报告。生成后点「保存」就会出现在这里。")
      : null
  );
}

/**
 * 历史报告只读查看器。
 *
 * 刻意做成浮层而不是塞进右侧面板：那块地方是「生成」的工作台，正在写的草稿
 * 不该因为看一眼旧报告就消失。浮层只管看，想接着改再点「在面板中打开」。
 */
function ReportViewer() {
  const R = appCtx.react;
  const snap = useSnap();
  const v = snap.viewer;
  const closeRef = R.useRef(null);
  const boxRef = R.useRef(null);
  // 打开前的焦点：关闭后还回去，用户不用重新找刚才停在哪
  const returnFocusRef = R.useRef(null);

  // 打开时把焦点放到关闭按钮：键盘用户不用先 Tab 一圈才逃得出去
  R.useEffect(() => {
    if (!v) return;
    if (typeof document !== "undefined") returnFocusRef.current = document.activeElement || null;
    const el = closeRef.current;
    if (el && typeof el.focus === "function") el.focus();
    return () => {
      const prev = returnFocusRef.current;
      returnFocusRef.current = null;
      if (prev && typeof prev.focus === "function") {
        try {
          prev.focus();
        } catch (e) {
          /* 元素已经不在文档里 */
        }
      }
    };
  }, [v ? v.rel : null]);

  // Esc 关闭 + 焦点陷阱：aria-modal 说了「浮层外的内容不可达」，
  // 就得真的把 Tab 圈在浮层里。
  R.useEffect(() => {
    if (!v || typeof document === "undefined") return;
    const onKey = (ev) => {
      if (ev.key === "Escape") {
        ev.preventDefault();
        closeViewer();
        return;
      }
      if (ev.key !== "Tab") return;
      const box = boxRef.current;
      if (!box || typeof box.querySelectorAll !== "function") return;
      const nodes = box.querySelectorAll(
        'a[href], button:not([disabled]), textarea, input, select, [tabindex]:not([tabindex="-1"])'
      );
      if (!nodes.length) return;
      const first = nodes[0];
      const last = nodes[nodes.length - 1];
      const active = document.activeElement;
      if (ev.shiftKey && (active === first || !box.contains(active))) {
        ev.preventDefault();
        if (typeof last.focus === "function") last.focus();
      } else if (!ev.shiftKey && (active === last || !box.contains(active))) {
        ev.preventDefault();
        if (typeof first.focus === "function") first.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [v ? v.rel : null]);

  if (!v) return null;

  const title = v.from === v.to ? v.from : v.from + " 至 " + v.to;
  const body = v.loading
    ? h("p", { className: "wl-viewer-note" }, "正在读取…")
    : v.error
      ? h("p", { className: "wl-viewer-note is-error" }, "读取失败：" + v.error)
      : v.text.trim()
        ? h("div", { className: "wl-md wl-viewer-md" }, renderMarkdown(v.text))
        : h("p", { className: "wl-viewer-note" }, "这份报告是空的。");

  return h(
    "div",
    {
      className: "wl-viewer-mask",
      // 点遮罩关闭；点在浮层本体上时 stopPropagation 拦下
      onClick: () => closeViewer(),
    },
    h(
      "div",
      {
        className: "wl-viewer",
        role: "dialog",
        "aria-modal": "true",
        "aria-label": "查看报告 " + title,
        ref: boxRef,
        onClick: (ev) => ev.stopPropagation(),
      },
      h(
        "div",
        { className: "wl-viewer-head" },
        h("h2", { className: "wl-viewer-title" }, title),
        h("span", { className: "wl-viewer-tone" }, toneLabel(v.mode)),
        typeof v.size === "number" && v.size > 0
          ? h("span", { className: "wl-viewer-size" }, fmtNum(v.size) + " 字符")
          : null,
        h("span", { className: "wl-spacer" }),
        h(
          "button",
          {
            className: "wl-btn",
            ref: closeRef,
            title: "关闭（Esc）",
            onClick: () => closeViewer(),
          },
          "关闭"
        )
      ),
      h("div", { className: "wl-viewer-body" }, body),
      h(
        "div",
        { className: "wl-viewer-foot" },
        h("span", { className: "wl-viewer-path", title: v.rel }, v.rel),
        h("span", { className: "wl-spacer" }),
        h(
          "button",
          {
            className: "wl-btn",
            title: "把这份报告装进右侧面板，改完再保存",
            disabled: v.loading || !!v.error,
            onClick: () => void openViewerInPanel(),
          },
          "在面板中打开"
        )
      )
    )
  );
}

function CenterTab() {
  const snap = useSnap();
  appCtx.react.useEffect(() => {
    void checkEnv(false);
  }, []);

  const facts = visibleFacts(snap.facts, snap.mutedWorkspaces);

  return h(
    "div",
    { className: "wl-root" },
    h(
      "div",
      { className: "wl-wrap" },
      h(
        "header",
        { className: "wl-head" },
        h(
          "div",
          { className: "wl-head-row" },
          h("h1", { className: "wl-title" }, "工作志"),
          h("span", { className: "wl-spacer" }),
          h("button", { className: "wl-btn ghost", onClick: () => openSettings() }, "设置")
        ),
        h(
          "div",
          { className: "wl-head-tools" },
          h(RangePicker),
          h("span", { className: "wl-spacer" }),
          h(
            "button",
            {
              className: "wl-btn wl-btn-scan",
              disabled: snap.scanning || snap.rechecking || snap.generating,
              onClick: () => void doScan(),
            },
            snap.scanning
              ? h("span", { className: "wl-btn-inner" }, h("span", { className: "wl-spinner" }), "扫描中…")
              : "扫描"
          )
        ),
        h("p", { className: "wl-sub" }, headSub(snap, facts))
      ),
      snap.error ? h("div", { className: "wl-error" }, snap.error) : null,
      snap.toast ? h("div", { className: "wl-toast" }, snap.toast) : null,
      h(ReportHistory),
      facts ? h(StatsStrip, { facts: facts }) : null,
      h(
        "div",
        { className: "wl-body" },
        h(
          "div",
          { className: "wl-main" },
          snap.facts
            ? h(FactsView, { facts: facts })
            : h(
                "div",
                { className: "wl-empty" },
                h("b", null, "还没有扫描"),
                "选好日期范围后点「扫描」，读取这段时间的会话记录；整个过程只读本地文件，不消耗 token。"
              )
        ),
        h(ReportPanel)
      )
    ),
    // 浮层挂在最外层：遮罩要盖住整页，不被 .wl-wrap 的宽度与间距裁掉
    h(ReportViewer)
  );
}

/**
 * 自绘下拉：按钮 + 列表，替代原生 select。
 * 原生 select 的展开层由系统绘制，宿主 WebView 里不跟随主题，字号与输入框也对不上。
 * items: [{ value, label, disabled? }]；value 用字符串比较，空字符串表示「自动」。
 */
function Dropdown(props) {
  const R = appCtx.react;
  const openState = R.useState(false);
  const open = openState[0];
  const setOpen = openState[1];
  const focusState = R.useState(-1);
  const focusIdx = focusState[0];
  const setFocusIdx = focusState[1];
  // 触发器下方空间不够时改为向上弹，避免菜单被视口底部裁掉
  const upState = R.useState(false);
  const up = upState[0];
  const setUp = upState[1];
  const triggerRef = R.useRef(null);
  const itemRefs = R.useRef([]);

  const items = props.items || [];
  // value 既是按钮上显示的内容，也是「真正生效的那个」：两者不再分开。
  // 空字符串表示未选中，显示 placeholder。
  const value = props.value == null ? "" : String(props.value);
  const selectedIdx = items.findIndex((it) => String(it.value) === value);
  const selected = selectedIdx >= 0 ? items[selectedIdx] : null;
  const placeholder = props.placeholder || "请选择";

  R.useEffect(() => {
    if (!open) return;
    const el = itemRefs.current[focusIdx];
    if (el && typeof el.focus === "function") el.focus();
  }, [open, focusIdx]);

  const openMenu = () => {
    if (props.disabled) return;
    let i = selectedIdx;
    if (i < 0) i = items.findIndex((it) => !it.disabled);
    setFocusIdx(i < 0 ? 0 : i);
    // 估算菜单高度：不超过 260，也不超过内容高度
    const est = Math.min(260, items.length * 32 + 8);
    const el = triggerRef.current;
    if (el && typeof el.getBoundingClientRect === "function" && typeof window !== "undefined") {
      const rect = el.getBoundingClientRect();
      const below = (window.innerHeight || 800) - rect.bottom;
      setUp(below < est + 12 && rect.top > below);
    }
    setOpen(true);
  };

  const choose = (item) => {
    if (!item || item.disabled) return;
    setOpen(false);
    if (String(item.value) !== value) props.onChange(item.value);
  };

  const move = (step) => {
    if (!items.length) return;
    let i = focusIdx;
    for (let n = 0; n < items.length; n++) {
      i = (i + step + items.length) % items.length;
      if (!items[i].disabled) break;
    }
    setFocusIdx(i);
  };

  const onTriggerKeyDown = (ev) => {
    if (props.disabled) return;
    if (ev.key === "ArrowDown" || ev.key === "ArrowUp") {
      ev.preventDefault();
      if (!open) openMenu();
      else move(ev.key === "ArrowDown" ? 1 : -1);
    } else if (ev.key === "Enter" || ev.key === " ") {
      ev.preventDefault();
      if (open) choose(items[focusIdx]);
      else openMenu();
    } else if (ev.key === "Escape" && open) {
      ev.preventDefault();
      setOpen(false);
    }
  };

  // 焦点会被移到选项 div 上（见上面的 useEffect），此后 trigger 的
  // onKeyDown 收不到事件：键盘操作必须在菜单上再接一层，
  // 否则方向键、回车、Esc 在选项上全部失效。
  const onMenuKeyDown = (ev) => {
    if (ev.key === "Escape") {
      ev.preventDefault();
      setOpen(false);
      const el = triggerRef.current;
      if (el && typeof el.focus === "function") el.focus();
    } else if (ev.key === "ArrowDown" || ev.key === "ArrowUp") {
      ev.preventDefault();
      move(ev.key === "ArrowDown" ? 1 : -1);
    } else if (ev.key === "Enter" || ev.key === " ") {
      ev.preventDefault();
      choose(items[focusIdx]);
    } else if (ev.key === "Tab") {
      // Tab 离开就收起，别把展开的菜单留在身后
      setOpen(false);
    }
  };

  return h(
    "div",
    { className: "wl-dd" + (open ? " is-open" : "") + (up ? " is-up" : "") },
    h(
      "button",
      {
        type: "button",
        className: "wl-dd-trigger",
        ref: triggerRef,
        disabled: props.disabled,
        "aria-haspopup": "listbox",
        "aria-expanded": open,
        onClick: () => (open ? setOpen(false) : openMenu()),
        onKeyDown: onTriggerKeyDown,
      },
      h(
        "span",
        { className: "wl-dd-value" + (selected ? "" : " is-empty") },
        selected ? selected.label : placeholder
      ),
      h("span", { className: "wl-dd-caret", "aria-hidden": "true" })
    ),
    open ? h("div", { className: "wl-dd-scrim", onClick: () => setOpen(false) }) : null,
    open
      ? h(
          "div",
          { className: "wl-dd-menu", role: "listbox", onKeyDown: onMenuKeyDown },
          items.length
            ? items.map((item, i) =>
                h(
                  "div",
                  {
                    key: String(item.value) + ":" + i,
                    ref: (el) => {
                      itemRefs.current[i] = el;
                    },
                    className:
                      "wl-dd-item" +
                      (i === focusIdx ? " is-active" : "") +
                      (item.disabled ? " is-disabled" : ""),
                    role: "option",
                    "aria-selected": String(item.value) === value,
                    "aria-disabled": item.disabled ? true : undefined,
                    tabIndex: -1,
                    onClick: () => choose(item),
                    onMouseEnter: () => {
                      if (!item.disabled) setFocusIdx(i);
                    },
                  },
                  h("span", { className: "wl-dd-label" }, item.label),
                  h("span", { className: "wl-dd-check", "aria-hidden": "true" }, "✓")
                )
              )
            : h("div", { className: "wl-dd-empty" }, props.emptyText || "没有可选项")
        )
      : null
  );
}

function EnvRow(props) {
  const item = props.item;
  const ok = !!(item && item.ok);
  const text = item ? (item.ok ? item.version : item.error || "不可用") : "检测中…";
  return h(
    "div",
    { className: "wl-env-row" },
    h("span", { style: { color: "var(--wl-muted)", minWidth: "40px" } }, props.name + " "),
    h("span", { className: ok ? "wl-env-ok" : item ? "wl-env-bad" : "" }, ok ? "✓" : item ? "✗" : "·"),
    h("span", null, " " + text)
  );
}

/* 目录授权：path → grantId。只有本次会话里选择过的目录才记得住，
 *  用来在用户不再使用某个目录时把授权还回去。 */
const grantIds = new Map();

/** 撤销一个目录的授权（如果它确实是用户选来的）。 */
async function revokeGrant(path) {
  const grantId = path ? grantIds.get(String(path)) : "";
  if (!grantId || !appCtx || !appCtx.assets || typeof appCtx.assets.revokeDirectory !== "function") return;
  grantIds.delete(String(path));
  try {
    await appCtx.assets.revokeDirectory(grantId);
  } catch (e) {
    /* 授权可能已经失效 */
  }
}

/** 目录不再被任何设置引用时才撤销它的授权。 */
async function revokeUnusedGrant(path) {
  const cur = store.snap.settings || {};
  const used = [cur.sessionRoot, cur.workspacePath].concat(Array.isArray(cur.extraPaths) ? cur.extraPaths : []);
  if (used.some((p) => p && workspaceKey(p) === workspaceKey(path))) return;
  await revokeGrant(path);
}

async function revokeUnusedGrants() {
  for (const path of [...grantIds.keys()]) await revokeUnusedGrant(path);
}

function SettingsSection() {
  const R = appCtx.react;
  const snap = useSnap();  const formState = R.useState(null);
  const form = formState[0] || snap.settings;
  const setForm = formState[1];
  // "" → "saving" → "saved"/"error"。设置改了就生效，不需要用户再记着点保存。
  const saveState = R.useState("");
  const saveStatus = saveState[0];
  const setSaveStatus = saveState[1];
  const baseline = R.useRef("");
  const saveTimer = R.useRef(null);
  const ready = R.useRef(false);
  const lastExtraPaths = R.useRef("[]");

  function patch(key, value) {
    setForm((prev) => Object.assign({}, prev || snap.settings, { [key]: value }));
  }

  // 路径只能来自宿主的系统文件夹选择器，不接受手填
  async function pickGrant() {
    if (!appCtx || !appCtx.assets || typeof appCtx.assets.grantDirectory !== "function") {
      flash("当前宿主不支持目录选择");
      return "";
    }
    try {
      const grant = await appCtx.assets.grantDirectory();
      if (!grant || !grant.path) return "";
      // 记下这次授权：用户换掉目录后要把它还回去，否则每选一次就多一条
      // 永久授权，攒久了设置里会看到一堆早就没用的目录。
      if (grant.grantId) grantIds.set(String(grant.path), String(grant.grantId));
      return String(grant.path);
    } catch (e) {
      /* 取消选择 */
      return "";
    }
  }

  async function choosePath(key) {
    const before = String((form && form[key]) || "");
    const picked = await pickGrant();
    if (!picked) return;
    patch(key, picked);
    if (before && workspaceKey(before) !== workspaceKey(picked)) void revokeUnusedGrant(before);
    void revokeUnusedGrants();
    flash("已选择 " + displayPath(picked));
  }

  async function addExtraPath() {
    const picked = await pickGrant();
    if (!picked) return;
    const cur = Array.isArray(form.extraPaths) ? form.extraPaths : [];
    if (cur.some((p) => workspaceKey(p) === workspaceKey(picked))) {
      flash("这个目录已经在列表里");
      return;
    }
    patch("extraPaths", cur.concat(picked));
    flash("已添加 " + displayPath(picked));
  }

  function removeExtraPath(idx) {
    const cur = Array.isArray(form.extraPaths) ? form.extraPaths : [];
    const gone = cur[idx];
    patch("extraPaths", cur.filter((_, i) => i !== idx));
    if (gone) {
      // 等这一版设置写进去再判断：它可能同时还被会话根目录/运行目录用着
      setTimeout(() => void revokeUnusedGrant(gone), 700);
    }
  }

  // 切换报告的保存位置。selectLocation("custom") 会打开宿主目录选择器，
  // 之后插件的文档（报告、扫描缓存）都写在那个目录下。
  // 切换文档存储位置。selectLocation 会打开宿主目录选择器；
  // 切换成功后把旧目录里的报告与扫描快照搬到新目录。
  async function switchStorage(kind, doneText) {
    if (!appCtx || !appCtx.documentStorage || typeof appCtx.documentStorage.selectLocation !== "function") {
      flash("当前宿主不支持更改存储位置");
      return;
    }
    const from = storageRoot || (store.snap.storage && store.snap.storage.path) || "";
    let loc = null;
    try {
      loc = await appCtx.documentStorage.selectLocation(kind);
    } catch (e) {
      /* 用户取消选择 */
      return;
    }
    if (!loc || !loc.path) return;
    const to = String(loc.path).replace(/[\\/]+$/, "");
    storageRoot = "";
    await refreshStorageLocation();
    let note = "";
    if (from && workspaceKey(from) !== workspaceKey(to)) {
      try {
        const r = await moveStorageFiles(from, to);
        if (r.moved) note = "，已搬运 " + r.moved + " 个文件";
        if (r.skipped) note += "；" + r.skipped + " 个同名文件已存在，未覆盖";
      } catch (e) {
        note = "；旧文件搬运失败：" + safeError(e);
      }
      // 换了目录，内存里缓存的都是旧目录的内容：不清掉的话切回某个范围
      // 还会显示上一处目录里的报告，历史列表也还是旧的。
      reportDiskText.clear();
      diskWriteSeq += 1;
      set({ viewer: null, pendingDelete: null, reportSaved: "" });
      // 当前这份草稿在旧目录没保存过：重新按新目录读一遍
      void showReportForCurrentView();
      void loadReportList();
      void cleanupReportBaks();
    }
    flash(doneText + " " + displayPath(to) + note);
  }

  /** 按当前范围 + 口吻重新读一次报告（换目录后用）。 */
  async function showReportForCurrentView() {
    const range = normalizeRange(store.snap.range);
    const mode = store.snap.reportMode;
    const key = rangeKey(range);
    const text = await loadReportIntoCache(range, mode);
    if (rangeKey(store.snap.range) !== key || store.snap.reportMode !== mode) return;
    showReport(range, mode, text);
  }

  const changeReportDir = () => switchStorage("custom", "报告目录已改为");
  const resetReportDir = () => switchStorage("data", "已恢复到默认数据目录");

  R.useEffect(() => {
    void checkEnv(false);
    void loadCatalog();
    void refreshStorageLocation();
    return () => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
    };
  }, []);

  // 改动即自动保存：防抖 500ms，避免来回切换时频繁写盘
  R.useEffect(() => {
    if (!form) return;
    const key = JSON.stringify(form);
    if (!ready.current) {
      ready.current = true;
      baseline.current = key;
      lastExtraPaths.current = JSON.stringify(form.extraPaths || []);
      return;
    }
    if (key === baseline.current) return;
    setSaveStatus("saving");
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      void (async () => {
        try {
          await writeSettings(form);
          baseline.current = key;
          setSaveStatus("saved");
          // 只有可执行文件目录列表变了才值得重新自检（要执行 node/git）
          const extra = JSON.stringify(form.extraPaths || []);
          if (extra !== lastExtraPaths.current) {
            lastExtraPaths.current = extra;
            void checkEnv(true);
          }
        } catch (e) {
          setSaveStatus("error");
          set({ error: "设置保存失败：" + safeError(e) });
        }
      })();
    }, 500);
  }, [form]);

  const field = (label, control, hint) =>
    h(
      "div",
      { className: "wl-field" },
      h("label", null, label),
      control,
      hint ? h("span", { className: "wl-hint" }, hint) : null
    );

  // 只读路径展示：值必须来自系统选择器，界面上没有可编辑入口
  const pathValue = (value, emptyText) => {
    const shown = displayPath(value);
    return h(
      "span",
      {
        className: "wl-path-value" + (shown ? "" : " is-empty"),
        title: shown || emptyText,
      },
      shown || emptyText
    );
  };

  const pickButton = (key, label) =>
    h(
      "button",
      {
        type: "button",
        className: "wl-btn wl-path-pick",
        title: "打开系统文件夹选择器",
        onClick: () => void choosePath(key),
      },
      label || "选择…"
    );

  // 空值本来就是「用默认」，没有可清除的东西时就不渲染
  const resetButton = (key, label) =>
    form[key]
      ? h(
          "button",
          {
            type: "button",
            className: "wl-btn ghost wl-path-pick",
            title: "清除并回到默认行为",
            onClick: () => patch(key, ""),
          },
          label || "默认"
        )
      : null;

  const pathField = (key, emptyText, extraButtons) =>
    h(
      "div",
      { className: "wl-path" },
      pathValue(form[key], emptyText),
      pickButton(key),
      extraButtons || null
    );

  const engines = (snap.catalog || []).filter((e) => e && typeof e.engine === "string");
  const customTones = Array.isArray(form.customTones) ? form.customTones : [];
  const toneItems = allTones(customTones).map((t) => ({
    value: t.id,
    label: t.label + (t.builtin ? "" : "（自定义）"),
  }));
  // 默认口吻认不出来（例如自定义项被删、设置被手改）时，下拉按日报显示。
  // 不要在列表里插重复项，也不要在渲染期改写表单。
  const toneValue = toneItems.some((t) => t.value === form.tone) ? form.tone : "daily";

  // 自定义口吻编辑器：id 只用来命名报告文件，界面上不展示
  const addCustomTone = () => {
    if (customTones.length >= MAX_CUSTOM_TONES) {
      flash("最多只能有 " + MAX_CUSTOM_TONES + " 个自定义口吻");
      return;
    }
    let n = 1;
    while (customTones.some((t) => t.id === "t" + n)) n += 1;
    patch(
      "customTones",
      customTones.concat({
        id: "t" + n,
        label: "自定义口吻 " + n,
        prompt: [
          "你是一位替工程师写工作记录的助手。只依据下面提供的事实写作，不要补充事实中不存在的内容。",
          "不要读取文件、不要调用任何工具、不要检索记忆，直接输出文字。",
          "",
          "写作要求：",
          "1. 按工作区组织，写清楚做了什么、做到什么程度。",
          "2. 事实里没有的结论不要写。",
          "3. 输出 Markdown，不要用代码块包裹整篇。",
          "",
          "结构：",
          "# <日期> 工作记录",
          "## 做了什么",
          "## 结果与证据",
        ].join("\n"),
      })
    );
  };

  const patchTone = (idx, key, value) => {
    const next = customTones.map((t, i) => (i === idx ? Object.assign({}, t, { [key]: value }) : t));
    patch("customTones", next);
  };

  const removeTone = (idx) => {
    const gone = customTones[idx];
    patch("customTones", customTones.filter((_, i) => i !== idx));
    // 默认口吻跟着被删掉时回到日报
    if (gone && form.tone === gone.id) patch("tone", "daily");
    // 当前正在看这个口吻时切回日报
    if (gone && store.snap.reportMode === gone.id) void switchReportMode("daily");
  };

  const toneEditor = h(
    "div",
    { className: "wl-tones" },
    customTones.length
      ? customTones.map((t, i) =>
          h(
            "details",
            { className: "wl-tone-row", key: t.id },
            h(
              "summary",
              { className: "wl-tone-head" },
              h("span", { className: "wl-tone-caret", "aria-hidden": "true" }),
              h("span", { className: "wl-tone-label" }, t.label || "未命名口吻"),
              h("span", { className: "wl-tone-hint" }, "编辑模板"),
              h(
                "button",
                {
                  type: "button",
                  className: "wl-btn ghost",
                  title: "删除这个口吻（已保存的报告文件不会删除）",
                  onClick: (e) => {
                    // 不阻止冒泡的话点删除会顺带把这一行展开
                    e.preventDefault();
                    e.stopPropagation();
                    removeTone(i);
                  },
                },
                "删除"
              )
            ),
            h(
              "div",
              { className: "wl-tone-body" },
              h("input", {
                className: "wl-input wl-tone-name",
                value: t.label || "",
                maxLength: MAX_TONE_LABEL,
                placeholder: "口吻名称，例如：周会发言稿",
                onChange: (e) => patchTone(i, "label", e.target.value),
              }),
              h("textarea", {
                className: "wl-textarea wl-tone-prompt",
                value: t.prompt || "",
                // 与 sanitizeCustomTones 的上限一致：否则粘贴超长模板会「保存成功但内容变短」
                maxLength: MAX_TONE_PROMPT,
                spellCheck: false,
                placeholder: "给模型的写作要求。用 <日期> 代表当前范围。",
                onChange: (e) => patchTone(i, "prompt", e.target.value),
              })
            )
          )
        )
      : h("span", { className: "wl-path-value is-empty" }, "还没有自定义口吻"),
    h(
      "div",
      { className: "wl-path-row" },
      h(
        "button",
        {
          type: "button",
          className: "wl-btn",
          disabled: customTones.length >= MAX_CUSTOM_TONES,
          onClick: addCustomTone,
        },
        "新增口吻…"
      )
    )
  );
  const engineEntry = engines.find((e) => e.engine === form.engine) || null;
  const models = engineEntry
    ? (engineEntry.models || []).filter((m) => m && typeof m.id === "string")
    : [];

  const engineItems = [{ value: "", label: "自动（第一个可用引擎）" }];
  const orderedEngines = sortEngines(engines);
  for (const e of orderedEngines) {
    engineItems.push({
      value: e.engine,
      label: engineLabel(e.engine) + (e.available === false ? "（不可用）" : ""),
      disabled: e.available === false,
    });
  }
  // 配置里已有、但宿主这次没列出来的引擎：保留一项，避免下拉把它吃掉
  if (form.engine && !engines.some((e) => e.engine === form.engine)) {
    engineItems.push({ value: form.engine, label: engineLabel(form.engine) });
  }

  const modelItems = [
    {
      value: "",
      label: form.engine ? "自动（该引擎的第一个模型）" : "先选引擎，或保持自动",
    },
  ];
  for (const m of models) modelItems.push({ value: m.id, label: m.id });
  if (form.model && !models.some((m) => m.id === form.model)) {
    modelItems.push({ value: form.model, label: form.model });
  }

  const dropdown = (key, items, opts) =>
    h(Dropdown, {
      items: items,
      // opts.value 用于「表单里的值暂时认不出来」时给一个兜底显示值
      value: opts && opts.value != null ? opts.value : form[key] || "",
      placeholder: opts && opts.placeholder,
      disabled: opts && opts.disabled,
      emptyText: opts && opts.emptyText,
      onChange: (opts && opts.onChange) || ((v) => patch(key, v)),
    });

  // 引擎运行目录留空表示用插件自己的数据目录。只写「插件数据目录」等于没告诉
  // 用户它在哪——把真实路径直接显示出来，和生成时实际用的 cwd 是同一个目录。
  const defaultWorkspacePath = snap.storage && snap.storage.path ? snap.storage.path : "";
  const workspaceEmpty = h(
    "span",
    {
      className: "wl-path-value" + (defaultWorkspacePath ? " is-default" : " is-empty"),
      title: defaultWorkspacePath
        ? "默认值，即插件数据目录：" + displayPath(defaultWorkspacePath)
        : "正在读取插件数据目录…",
    },
    defaultWorkspacePath ? "默认 · " + displayPath(defaultWorkspacePath) : "插件数据目录（正在读取…）"
  );
  const workspaceField = h(
    "div",
    { className: "wl-path" },
    form.workspacePath ? pathValue(form.workspacePath, "") : workspaceEmpty,
    pickButton("workspacePath"),
    resetButton("workspacePath")
  );

  const extraPaths = Array.isArray(form.extraPaths) ? form.extraPaths : [];
  const extraList = h(
    "div",
    { className: "wl-path-list" },
    extraPaths.length
      ? extraPaths.map((p, i) =>
          h(
            "div",
            { className: "wl-path-row", key: String(p) + ":" + i },
            pathValue(p, ""),
            h(
              "button",
              {
                type: "button",
                className: "wl-btn ghost wl-path-pick",
                title: "从这个列表移除",
                onClick: () => removeExtraPath(i),
              },
              "移除"
            )
          )
        )
      : h(
          "span",
          { className: "wl-path-value is-empty", title: "还没有添加额外目录" },
          "未添加，使用宿主继承的 PATH"
        ),
    h(
      "div",
      { className: "wl-path-row" },
      h(
        "button",
        { type: "button", className: "wl-btn", onClick: () => void addExtraPath() },
        "添加目录…"
      )
    )
  );

  const storagePath = snap.storage && snap.storage.path ? snap.storage.path : "";
  const reportDirControl = h(
    "div",
    { className: "wl-path" },
    pathValue(storagePath, "正在读取存储位置…"),
    h(
      "button",
      {
        type: "button",
        className: "wl-btn wl-path-pick",
        title: "打开系统文件夹选择器，更改报告的保存位置",
        onClick: () => void changeReportDir(),
      },
      "更改…"
    ),
    snap.storage && snap.storage.kind === "custom"
      ? h(
          "button",
          {
            type: "button",
            className: "wl-btn ghost wl-path-pick",
            title: "回到插件默认数据目录",
            onClick: () => void resetReportDir(),
          },
          "用默认目录"
        )
      : null
  );

  return h(
    "div",
    { className: "wl-settings" },
    snap.error ? h("div", { className: "wl-error" }, snap.error) : null,
    snap.toast ? h("div", { className: "wl-toast" }, snap.toast) : null,
    h(
      "p",
      { className: "wl-settings-intro" },
      "会话日志、报告与设置只留在这台机器上；插件不上传任何内容。"
    ),
    h(
      "section",
      { className: "wl-section" },
      h(
        "div",
        { className: "wl-section-label" },
        h("h2", null, "数据来源"),
        h("p", null, "目前只支持 Claude Code 的会话日志；其它 CLI 的日志格式还没有适配。")
      ),
      h(
        "div",
        { className: "wl-section-panel" },
        h(
          "p",
          { className: "wl-note-line" },
          "插件只读取 Claude Code 的 ",
          h("code", null, "~/.claude/projects"),
          " 下的 JSONL 会话；Codex、Qoder、Kimi 等其它引擎的会话暂时不会被统计。写报告用哪个引擎在下面单独选择，两者互不影响。"
        ),
        field(
          "会话根目录",
          pathField("sessionRoot", "默认：" + displayPath("~/.claude/projects"), resetButton("sessionRoot")),
          "扫描时只读取这段范围里的 JSONL 消息，不改动源文件；旧快照 30 天后自动清理。只能通过系统选择器指定。"
        ),
        field(
          "报告保存目录",
          reportDirControl,
          "报告和扫描缓存分别写在这个目录下的 reports、runtime 子目录里，每天、每种口吻各一个 .md 文件。切换目录时会把已有文件一并搬过去，同名文件不覆盖。"
        )
      )
    ),
    h(
      "section",
      { className: "wl-section" },
      h(
        "div",
        { className: "wl-section-label" },
        h("h2", null, "生成报告"),
        h("p", null, "只有点「生成」时才调用模型；事实层始终在本地完成。")
      ),
      h(
        "div",
        { className: "wl-section-panel" },
        field(
          "引擎",
          dropdown("engine", engineItems, {
            placeholder: "自动（第一个可用引擎）",
            onChange: (v) => {
              patch("engine", v);
              patch("model", "");
            },
          }),
          snap.catalogError
            ? "读取宿主引擎失败：" + snap.catalogError
            : "选项来自宿主当前可用的引擎。"
        ),
        field(
          "模型",
          dropdown("model", modelItems, {
            placeholder: "先选引擎，或保持自动",
            disabled: !form.engine,
            emptyText: form.engine ? "该引擎未报告可用模型" : "先选引擎",
          }),
          form.engine
            ? "选项来自所选引擎；留空则用第一个可用模型。"
            : "先选引擎，模型列表会跟着变。"
        ),
        field(
          "引擎运行目录",
          workspaceField,
          "生成报告时，模型进程在这个目录下运行。报告内容只来自上面的扫描结果，不会读取这里的文件。留空则与「报告保存目录」相同（虚线框显示的就是当前值）——生成过程留下的会话记在自己名下，不会混进你的项目工作里。"
        ),
        field(
          "打开时默认的口吻",
          dropdown("tone", toneItems, { value: toneValue }),
          "报告面板打开时默认用哪一种写法。"
        ),
        field(
          "自定义口吻",
          toneEditor,
          "最多 " + MAX_CUSTOM_TONES + " 个（每个模板最多 8000 字）。模板里可用 <日期> 代表当前范围；内置的三种写法不受这里影响。"
        )
      )
    ),
    h(
      "section",
      { className: "wl-section" },
      h(
        "div",
        { className: "wl-section-label" },
        h("h2", null, "对账"),
        h("p", null, "把会话里的改动和 git 记录放在一起核对，报告才有证据。")
      ),
      h(
        "div",
        { className: "wl-section-panel" },
        h(
          "label",
          { className: "wl-check" },
          h("input", {
            type: "checkbox",
            checked: form.gitReconcile !== false,
            onChange: (e) => patch("gitReconcile", e.target.checked),
          }),
          h("span", null, "扫描时核对每个工作区的提交与未提交改动")
        )
      )
    ),
    h(
      "section",
      { className: "wl-section" },
      h(
        "div",
        { className: "wl-section-label" },
        h("h2", null, "运行环境"),
        h("p", null, "插件经宿主按命令名执行 node 与 git，不使用绝对路径。")
      ),
      h(
        "div",
        { className: "wl-section-panel" },
        h(
          "div",
          { className: "wl-env" },
          h(EnvRow, { name: "node", item: snap.env && snap.env.node }),
          h(EnvRow, { name: "git", item: snap.env && snap.env.git })
        ),
        h(
          "div",
          null,
          h(
            "button",
            { className: "wl-btn", disabled: snap.envChecking, onClick: () => void checkEnv(true) },
            snap.envChecking
              ? h("span", { className: "wl-btn-inner" }, h("span", { className: "wl-spinner" }), "检测中…")
              : "重新检测"
          )
        ),
        field(
          "额外的可执行文件目录",
          extraList,
          "宿主只按命令名运行 node 与 git；只有自检报告「未找到」时才需要添加。排在列表前的目录优先，逐个添加、可随时移除，路径只能通过系统选择器指定。"
        )
      )
    ),
    h(
      "div",
      { className: "wl-save-bar" },
      h(
        "span",
        {
          className:
            "wl-save-state" +
            (saveStatus === "saved" ? " is-saved" : saveStatus === "error" ? " is-bad" : ""),
        },
        saveStatus === "saving"
          ? "正在保存…"
          : saveStatus === "saved"
            ? "已保存"
            : saveStatus === "error"
              ? "保存失败，改动会在下次修改时重试"
              : "设置会自动保存"
      ),
      h("span", { className: "wl-spacer" }),
      h(
        "span",
        { className: "wl-muted" },
        "版本 " + (appCtx && appCtx.version ? appCtx.version : PLUGIN_VERSION) + " · 数据只留在这台机器上"
      )
    )
  );
}

/* ---------------------------------------------------------------- 激活 */

/** 用户主动切换范围/口吻的次数。bootstrap 用它判断「我读设置这段时间里，
 *  用户是不是已经自己选过了」——选过就不该再按启动值覆盖回去。 */
let viewPickSeq = 0;

async function bootstrap() {
  const pickSeqAtStart = viewPickSeq;
  const settings = await readSettings();
  if (!appCtx) return;
  // 口吻可能是自定义的：只认得出来的那个，认不出就回到日报
  const tones = Object.keys(BUILTIN_TONE_LABELS).concat(
    (settings.customTones || []).map((t) => t.id)
  );
  // 上次停在哪个口吻优先；settings.tone 只是「默认口吻」，不该盖掉用户当前的选择。
  // 如果用户后来在设置里改了默认口吻，就以新默认值为准。
  let remembered = null;
  try {
    remembered = await appCtx.storage.get(VIEW_KEY);
  } catch (e) {
    remembered = null;
  }
  const lastMode = remembered && typeof remembered === "object" ? String(remembered.mode || "") : "";
  const lastTone = remembered && typeof remembered === "object" ? String(remembered.tone || "") : "";
  const toneChanged = lastTone && lastTone !== String(settings.tone || "");
  const mode =
    lastMode && !toneChanged && tones.includes(lastMode)
      ? lastMode
      : tones.includes(settings.tone)
        ? settings.tone
        : "daily";
  // 读设置这段时间里，用户可能已经自己切过范围或口吻：那就只更新设置，
  // 不能把启动时算出的 mode 拨回去盖掉他的选择。
  // 注意不要用 store.snap.ready 判定——同一模块实例再次 activate（宿主热重载 /
  // 冒烟测试）时它是上一轮留下的 true，会让 reportMode 再也回不到记住的口吻。
  if (viewPickSeq !== pickSeqAtStart) set({ settings: settings });
  else set({ settings: settings, ready: true, reportMode: mode });
  void loadCatalog();
  void refreshStorageLocation();
  void cleanupReportBaks();
  void loadReportList();
  // 上次没保存的草稿优先于磁盘内容：用户写到一半关掉宿主，回来还得是那份
  await loadPersistedDrafts();
  // 把今天（或上次停在的范围）的扫描结果读回来，否则每次打开都是一片空白
  void restoreFactsFor(store.snap.range);
  // 用户在此期间可能已经切了范围或口吻：按「此刻」的视图读，读完再校验一次
  const targetRange = normalizeRange(store.snap.range);
  const targetMode = store.snap.reportMode;
  const saved = await loadReportIntoCache(targetRange, targetMode);
  if (rangeKey(store.snap.range) !== rangeKey(targetRange) || store.snap.reportMode !== targetMode) return;
  // 有未保存草稿就用草稿，别让磁盘内容把它盖掉
  const draftKey = REPORT_KEY(targetRange, targetMode);
  if (reportDraftText.has(draftKey) && reportDraftText.get(draftKey) !== saved) {
    set({ report: reportDraftText.get(draftKey), reportSaved: saved });
  } else if (saved) {
    set({ report: saved, reportSaved: saved });
  }
}

function sidebarBadge() {
  const facts = store.snap.facts;
  if (facts && facts.totals && facts.totals.sessions > 0) return facts.totals.sessions;
  return null;
}

export default function activate(ctx) {
  appCtx = ctx;
  const disposers = [];

  /** 注册入口逐个兜底：宿主某个 UI 扩展点不可用时，不能因此跳过前面的
   *  disposer（CSS 会永久残留），也不能让后面的入口全部注册不上。 */
  function register(what, fn, silent) {
    try {
      const d = fn();
      if (typeof d === "function") disposers.push(d);
    } catch (e) {
      if (!silent) set({ error: what + "注册失败：" + safeError(e) });
    }
  }

  register("样式", () => ctx.theme.injectCss(CSS), true);

  register("中央页签", () =>
    ctx.ui.registerCenterTab({
      key: TAB_KEY,
      title: () => "工作志",
      icon: Icon,
      component: CenterTab,
      order: 45,
    })
  );

  register("侧栏入口", () =>
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

  register("设置区", () =>
    ctx.ui.registerSettingsSection({
      key: PLUGIN_ID,
      label: () => "工作志",
      icon: Icon,
      component: SettingsSection,
    })
  );

  register("命令", () =>
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
    // 草稿防抖还没到点就卸载：把编辑区最新内容记下来并立刻写一次。
    // 等定时器醒来时 appCtx 已是 null，最后 400ms 的输入会无声消失——
    // 这正是草稿持久化要覆盖的场景。
    if (draftSaveTimer) clearTimeout(draftSaveTimer);
    draftSaveTimer = null;
    commitEditorDraft();
    stashReportDraft();
    flushDraftsNow();
    // 卸载/热重载时收掉进行中的生成：abort 会停掉计时器与事件监听，
    // 再 interrupt 一次兜住 start 尚未 resolve、runId 还没回填的情况。
    genSeq += 1;
    const ctrl = activeAbort;
    activeAbort = null;
    if (ctrl) {
      try {
        ctrl.abort();
      } catch (e) {
        /* 已结束 */
      }
    }
    const runId = store.snap.runId;
    if (runId && appCtx) {
      try {
        // 外层 try 只拦同步抛出，宿主 IPC 失败时 rejection 需要自己接住
        void Promise.resolve(appCtx.agent.interrupt(runId)).catch(() => {});
      } catch (e) {
        /* 轮次可能已经结束 */
      }
    }
    set({ generating: false, streamText: "", runId: "" });
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
