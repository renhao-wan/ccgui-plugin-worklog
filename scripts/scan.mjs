#!/usr/bin/env node
/**
 * 工作志扫描器：只读解析本机 CLI 会话日志，输出指定日期的事实快照。
 *
 * 设计约束：
 * - 零依赖，只使用 node 内置模块
 * - 绝不写入源会话文件
 * - 只输出结构化事实，不做任何 AI 推演
 *
 * 用法：
 *   node scan.mjs --root <会话根目录> --date YYYY-MM-DD [--out <结果文件>]
 *   node scan.mjs --root <dir> --from YYYY-MM-DD --to YYYY-MM-DD
 *
 * 输出：默认 stdout 一段 JSON；给 --out 时写入该文件，stdout 只回一行摘要。
 * 错误走 stderr 并以非零退出。
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";

const MAX_USER_MESSAGES_PER_SESSION = 80;
const MAX_USER_TEXT = 800;
const MAX_SUMMARY_TEXT = 1500;
const MAX_COMMAND_TEXT = 300;
const MAX_COMMANDS_PER_SESSION = 60;
const MAX_TOOL_ERRORS_PER_SESSION = 50;
// 每轮「用户要求 → 助手首条回应」保留最近 N 对，供报告判断实际进展
const MAX_TURNS_PER_SESSION = 40;
const MAX_TURN_USER_TEXT = 500;
const MAX_TURN_REPLY_TEXT = 300;
// 用户连续发言、助手还没回应时先排队的上限
const MAX_PENDING_TURNS = 5;

/** 内部注入的消息特征：这些不是用户真正输入的内容。
 *  只列已知标签，不用裸 "<" 兜底——用户会粘贴 HTML/XML/JSX，
 *  那种消息是真实需求，不能吞掉。 */
const INTERNAL_PREFIXES = [
  "<task-notification",
  "<fork-boilerplate",
  "<command-message",
  "<command-name>",
  "<command-args>",
  "<local-command-stdout>",
  "<local-command-stderr>",
  "<local-command-caveat>",
  "<system-reminder>",
  "<user-prompt-submit-hook>",
  "<bash-input>",
  "<bash-stdout>",
  "<bash-stderr>",
  "<ide_opened_file>",
  "<ide_selection>",
  "Base directory for this skill:",
  "[CCGUI internal",
  "Caveat: The messages below were generated",
  "This is a resumed session",
  "This session is being continued",
  "This conversation has been compacted",
  "[Request interrupted",
];

function isInternalText(text) {
  const t = text.trim();
  if (!t) return true;
  return INTERNAL_PREFIXES.some((p) => t.startsWith(p));
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    const val = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : "true";
    out[key] = val;
  }
  return out;
}

function localDayStart(dateStr) {
  // dateStr 按本机本地时区解释为当天 00:00；不使用 Date.parse 的 UTC 语义
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr);
  if (!m) throw new Error("日期格式应为 YYYY-MM-DD：" + dateStr);
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 0, 0, 0, 0).getTime();
}

function dayKey(tsMs) {
  const d = new Date(tsMs);
  const p = (n) => String(n).padStart(2, "0");
  return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate());
}

function hourKey(tsMs) {
  return String(new Date(tsMs).getHours()).padStart(2, "0");
}

function collectFiles(dir, sinceMs, out) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      collectFiles(p, sinceMs, out);
    } else if (e.name.endsWith(".jsonl")) {
      let st;
      try {
        st = fs.statSync(p);
      } catch {
        continue;
      }
      // 通常 mtime 早于起始日的文件不含当天消息，跳过它省时间。
      // 复制、恢复备份或时钟漂移会打破这个假设，所以这只是优化，不是正确性保证。
      if (st.mtimeMs >= sinceMs) out.push({ p, mtimeMs: st.mtimeMs, size: st.size });
    }
  }
  return out;
}

/** 从消息内容数组里提取纯文本；tool_result / image 等不算。 */
function textBlocks(content) {
  if (!Array.isArray(content)) return [];
  return content
    .filter((b) => b && b.type === "text" && typeof b.text === "string")
    .map((b) => b.text);
}

function isToolResult(content) {
  return Array.isArray(content) && content.some((b) => b && b.type === "tool_result");
}

/** message.content 可能是块数组、纯字符串或缺失；统一成数组，缺失返回 null。 */
function messageContent(msg) {
  if (!msg) return null;
  const c = msg.content;
  if (typeof c === "string") return c.trim() ? [{ type: "text", text: c }] : [];
  if (Array.isArray(c)) return c;
  return null;
}

/** 截断，保留首尾；避免把大段附件写进结果。 */
function clip(text, max) {
  if (text.length <= max) return text;
  const head = Math.floor(max * 0.7);
  const tail = max - head - 3;
  return text.slice(0, head) + "…" + text.slice(-tail);
}

/* ------------------------------------------------------------ 引擎适配器
 * 扫描器只认识一种会话日志格式：Claude Code 的 JSONL。其它引擎（Codex、
 * Qoder、Kimi…）的字段名与目录布局都不同，没有真实样本前不臆造解析。
 * 这里把「读一行原始对象 → 规范字段」集中成适配器，后续接入新引擎时
 * 只需要新增一个条目，扫描主流程不用改。
 */
const ADAPTERS = {
  claude: {
    id: "claude",
    label: "Claude Code",
    /** 规范形状：{ ts, sessionId, workspace, branch, cliVersion, sidechain, kind, content } */
    readLine(o) {
      if (!o || typeof o !== "object") return null;
      const kind = o.type === "user" || o.type === "assistant" ? o.type : "";
      return {
        ts: typeof o.timestamp === "string" ? o.timestamp : null,
        sessionId: o.sessionId ? String(o.sessionId) : null,
        workspace: o.cwd ? String(o.cwd) : "",
        branch: o.gitBranch ? String(o.gitBranch) : null,
        cliVersion: o.version ? String(o.version) : null,
        sidechain: o.isSidechain === true,
        kind: kind,
        content: messageContent(o.message),
      };
    },
  },
};

function resolveAdapter(name) {
  const key = String(name || "").trim().toLowerCase();
  if (!key || key === "auto") return ADAPTERS.claude;
  // 只认 ADAPTERS 的自有属性：constructor / __proto__ 之类会命中原型链，
  // 拿到一个没有 readLine 的对象，最后变成「扫描成功但 0 个会话」。
  return Object.prototype.hasOwnProperty.call(ADAPTERS, key) ? ADAPTERS[key] : null;
}

async function scanSessionFile(file, windowStart, windowEnd, adapter) {
  const s = {
    sessionId: null,
    engine: adapter.id,
    workspace: "",
    gitBranch: null,
    cliVersion: null,
    sourceFile: path.basename(file.p),
    sourceSizeMB: Number((file.size / 1048576).toFixed(2)),
    continuedFromEarlierDay: false,
    firstSeenAt: null,
    lastSeenAt: null,
    userTurns: 0,
    assistantTurns: 0,
    thinkingTurns: 0,
    userMessages: [],
    turns: [],
    finalAssistantText: "",
    tools: {},
    toolErrors: [],
    editedFiles: new Set(),
    fileEditCounts: {},
    commands: [],
    hours: {},
    sidechainTurns: 0,
  };

  let sawAnyMessageBeforeWindow = false;
  let sawAnyMessageInWindow = false;
  // 当前等待助手回应的用户轮次（可能连续多条），用于把「要求」和「怎么回应」配对
  let pendingTurns = [];
  // 窗口之前最后一条真实用户消息：当天助手首次回应时用它配对，避免跨天丢失
  let carryTurn = null;

  const rl = readline.createInterface({
    input: fs.createReadStream(file.p, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });

  for await (const line of rl) {
    if (!line || line.length < 2) continue;
    let o;
    try {
      o = JSON.parse(line);
    } catch {
      continue; // 残缺尾部或非 JSON 行：忽略，不伪造事件
    }

    const rec = adapter.readLine(o);
    if (!rec) continue;
    if (rec.sessionId && !s.sessionId) s.sessionId = rec.sessionId;
    if (rec.workspace && !s.workspace) s.workspace = rec.workspace;
    if (rec.branch && !s.gitBranch) s.gitBranch = rec.branch;
    if (rec.cliVersion && !s.cliVersion) s.cliVersion = rec.cliVersion;

    const tsRaw = rec.ts;
    const ts = typeof tsRaw === "string" ? Date.parse(tsRaw) : NaN;
    if (!Number.isFinite(ts)) continue;

    if (ts < windowStart) {
      sawAnyMessageBeforeWindow = true;
      // 窗口之前最后一条真实用户消息：留给当天助手首次回应配对
      if (rec.kind === "user" && !rec.sidechain) {
        const early = rec.content;
        if (early && !isToolResult(early)) {
          const text = textBlocks(early).join("\n").trim();
          if (text && !isInternalText(text)) {
            carryTurn = {
              ts: tsRaw,
              user: clip(text, MAX_TURN_USER_TEXT),
              fromEarlierDay: true,
            };
          }
        }
      }
      continue;
    }
    if (ts >= windowEnd) continue;

    // content 可能是块数组，也可能是字符串：CLI 的内部注入、
    // 部分续接消息与简单用户输入都会以纯字符串落盘。
    const content = rec.content;
    if (content === null) continue;

    if (rec.sidechain) {
      s.sidechainTurns++;
      continue;
    }

    if (rec.kind === "user") {

      // 工具错误：tool_result 块上的 is_error
      for (const b of content) {
        if (b && b.type === "tool_result" && b.is_error) {
          const raw = Array.isArray(b.content)
            ? b.content.filter((x) => x && x.type === "text").map((x) => x.text).join("\n")
            : typeof b.content === "string"
              ? b.content
              : "";
          s.toolErrors.push({ ts: tsRaw, text: clip(String(raw || ""), 300) });
          // 报错只保留最近的，避免单个会话几百条错误撑大快照
          if (s.toolErrors.length > MAX_TOOL_ERRORS_PER_SESSION) s.toolErrors.shift();
        }
      }

      if (isToolResult(content)) continue; // 工具回包不算用户轮次

      const joined = textBlocks(content).join("\n").trim();
      if (!joined || isInternalText(joined)) continue;

      sawAnyMessageInWindow = true;
      s.userTurns++;
      if (s.firstSeenAt === null) s.firstSeenAt = tsRaw;
      s.lastSeenAt = tsRaw;
      s.hours[hourKey(ts)] = (s.hours[hourKey(ts)] || 0) + 1;
      // 保留最近的 N 条：报告关心的是会话最后在做什么
      s.userMessages.push({ ts: tsRaw, text: clip(joined, MAX_USER_TEXT) });
      if (s.userMessages.length > MAX_USER_MESSAGES_PER_SESSION) s.userMessages.shift();
      pendingTurns.push({ ts: tsRaw, user: clip(joined, MAX_TURN_USER_TEXT) });
      if (pendingTurns.length > MAX_PENDING_TURNS) pendingTurns.shift();
      // 用户已经继续对话，之前窗口外的要求不再等待配对
      carryTurn = null;
      continue;
    }

    if (rec.kind === "assistant") {
      sawAnyMessageInWindow = true;
      s.assistantTurns++;
      if (s.firstSeenAt === null) s.firstSeenAt = tsRaw;
      s.lastSeenAt = tsRaw;
      s.hours[hourKey(ts)] = (s.hours[hourKey(ts)] || 0) + 1;

      let replyText = "";
      for (const b of content) {
        if (!b) continue;
        if (b.type === "thinking") s.thinkingTurns++;
        if (b.type === "tool_use") {
          const name = b.name || "unknown";
          s.tools[name] = (s.tools[name] || 0) + 1;
          const input = b.input || {};
          const fp = input.file_path || input.path || input.notebook_path;
          if (fp && /^(Edit|Write|MultiEdit|NotebookEdit)$/.test(name)) {
            const key = String(fp);
            s.editedFiles.add(key);
            s.fileEditCounts[key] = (s.fileEditCounts[key] || 0) + 1;
          }
          if (name === "Bash" && typeof input.command === "string") {
            // 同样保留最近的命令
            s.commands.push({ ts: tsRaw, command: clip(input.command, MAX_COMMAND_TEXT) });
            if (s.commands.length > MAX_COMMANDS_PER_SESSION) s.commands.shift();
          }
        }
        if (b.type === "text" && typeof b.text === "string" && b.text.trim()) {
          s.finalAssistantText = b.text.trim();
          if (!replyText) replyText = b.text.trim();
        }
      }
      // 把这一轮助手的第一条文字挂到待回应的用户消息上。
      // 用户连续发了几条就合并成一个要求，不要只留最后一条。
      if (replyText) {
        let turn = null;
        if (pendingTurns.length) {
          turn = {
            ts: pendingTurns[pendingTurns.length - 1].ts,
            user: clip(pendingTurns.map((t) => t.user).join(" / "), MAX_TURN_USER_TEXT),
            fromEarlierDay: false,
          };
          pendingTurns = [];
        } else if (carryTurn) {
          // 跨天：前一天的用户要求，当天才得到第一次回应
          turn = carryTurn;
          carryTurn = null;
        }
        if (turn) {
          s.turns.push({
            ts: turn.ts,
            user: turn.user,
            reply: clip(replyText, MAX_TURN_REPLY_TEXT),
            fromEarlierDay: turn.fromEarlierDay === true,
          });
          if (s.turns.length > MAX_TURNS_PER_SESSION) s.turns.shift();
        }
      }
    }
  }

  if (!s.sessionId) {
    // 没有会话 ID 的文件无法追溯，不纳入结果
    return null;
  }
  if (!sawAnyMessageInWindow) return null;

  s.continuedFromEarlierDay = sawAnyMessageBeforeWindow;
  s.editedFiles = [...s.editedFiles];
  // 同一文件被改多次是「返工/卡点」的可靠信号
  s.hotFiles = Object.entries(s.fileEditCounts)
    .filter(([, n]) => n >= 2)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([p, n]) => ({ path: p, edits: n }));
  delete s.fileEditCounts;
  s.finalAssistantText = clip(s.finalAssistantText, MAX_SUMMARY_TEXT);

  return s;
}

function groupByWorkspace(sessions) {
  const map = new Map();
  for (const s of sessions) {
    const key = s.workspace || "(未知工作区)";
    if (!map.has(key)) {
      map.set(key, { workspace: key, sessions: [], editedFiles: new Set(), tools: {}, userTurns: 0 });
    }
    const g = map.get(key);
    g.sessions.push(s.sessionId);
    g.userTurns += s.userTurns;
    for (const f of s.editedFiles) g.editedFiles.add(f);
    for (const [name, n] of Object.entries(s.tools)) g.tools[name] = (g.tools[name] || 0) + n;
  }
  return [...map.values()].map((g) => ({ ...g, editedFiles: [...g.editedFiles] }));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  // 目前只实现 Claude Code 的适配器；显式指定未知引擎时明确失败，
  // 而不是悄悄按 Claude 的格式解析出一堆空会话。
  const adapter = resolveAdapter(args.engine);
  if (!adapter) {
    throw new Error(
      "不支持引擎 " + args.engine + "；目前只能解析 Claude Code 的会话日志（--engine claude）"
    );
  }
  // --root auto（或缺省）= Claude Code 的默认会话目录
  const root = !args.root || args.root === "auto" ? path.join(os.homedir(), ".claude", "projects") : args.root;
  if (!root) throw new Error("缺少 --root <会话根目录>");
  // 显式指定的目录不存在时直接报错：返回空结果会被误读成「今天没干活」
  // （auto 目录不存在是正常的，新机器上还没用过 Claude Code）
  if (args.root && args.root !== "auto" && !fs.existsSync(root)) {
    throw new Error("会话根目录不存在：" + root);
  }

  const from = args.from || args.date;
  const to = args.to || args.date || from;
  if (!from) throw new Error("缺少 --date 或 --from/--to");

  const windowStart = localDayStart(from);
  const windowEnd = localDayStart(to) + 86400000;

  const files = collectFiles(root, windowStart, []);
  const sessions = [];
  const failed = [];
  for (const f of files) {
    try {
      const s = await scanSessionFile(f, windowStart, windowEnd, adapter);
      if (s) sessions.push(s);
    } catch (e) {
      failed.push({ file: path.basename(f.p), reason: String(e && e.message ? e.message : e).slice(0, 200) });
    }
  }

  sessions.sort((a, b) => String(a.firstSeenAt).localeCompare(String(b.firstSeenAt)));

  const totals = {
    sessions: sessions.length,
    userTurns: sessions.reduce((n, s) => n + s.userTurns, 0),
    assistantTurns: sessions.reduce((n, s) => n + s.assistantTurns, 0),
    toolCalls: sessions.reduce((n, s) => n + Object.values(s.tools).reduce((a, b) => a + b, 0), 0),
    toolErrors: sessions.reduce((n, s) => n + s.toolErrors.length, 0),
    editedFiles: new Set(sessions.flatMap((s) => s.editedFiles)).size,
    workspaces: new Set(sessions.map((s) => s.workspace).filter(Boolean)).size,
    filesScanned: files.length,
    filesFailed: failed.length,
  };

  const payload = {
    schema: "worklog.facts.v1",
    engine: adapter.id,
    engineLabel: adapter.label,
    supportedEngines: Object.keys(ADAPTERS),
    scannedAt: new Date().toISOString(),
    range: { from, to, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone },
    root,
    sessions,
    workspaces: groupByWorkspace(sessions),
    totals,
    failures: failed,
  };

  const json = JSON.stringify(payload, null, 1);
  if (args.out) {
    // 结果可能超过宿主单流上限，写文件再让插件读回，避免 stdout 截断
    fs.mkdirSync(path.dirname(args.out), { recursive: true });
    fs.writeFileSync(args.out, json, "utf8");
    process.stdout.write(
      JSON.stringify({ ok: true, out: args.out, bytes: Buffer.byteLength(json), totals: totals }) + "\n",
    );
    return;
  }
  process.stdout.write(json);
}

main().catch((e) => {
  process.stderr.write("scan failed: " + (e && e.stack ? e.stack : e) + "\n");
  process.exit(1);
});
