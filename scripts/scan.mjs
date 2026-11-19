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

/** 内部注入的消息特征：这些不是用户真正输入的内容。 */
const INTERNAL_PREFIXES = [
  "<",
  "Base directory for this skill:",
  "[CCGUI internal",
  "Caveat: The messages below were generated",
  "This is a resumed session",
  "<command-name>",
  "<local-command-stdout>",
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
      // mtime 早于起始日的文件不可能含当天消息，直接跳过
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

/** 截断，保留首尾；避免把大段附件写进结果。 */
function clip(text, max) {
  if (text.length <= max) return text;
  const head = Math.floor(max * 0.7);
  const tail = max - head - 3;
  return text.slice(0, head) + "…" + text.slice(-tail);
}

async function scanSessionFile(file, windowStart, windowEnd) {
  const s = {
    sessionId: null,
    engine: "claude",
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
    finalAssistantText: "",
    tools: {},
    toolErrors: [],
    editedFiles: new Set(),
    commands: [],
    hours: {},
    sidechainTurns: 0,
  };

  let sawAnyMessageBeforeWindow = false;
  let sawAnyMessageInWindow = false;

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

    if (o.sessionId && !s.sessionId) s.sessionId = o.sessionId;
    if (o.cwd && !s.workspace) s.workspace = o.cwd;
    if (o.gitBranch && !s.gitBranch) s.gitBranch = o.gitBranch;
    if (o.version && !s.cliVersion) s.cliVersion = o.version;

    const tsRaw = o.timestamp;
    const ts = typeof tsRaw === "string" ? Date.parse(tsRaw) : NaN;
    if (!Number.isFinite(ts)) continue;

    if (ts < windowStart) sawAnyMessageBeforeWindow = true;
    if (ts < windowStart || ts >= windowEnd) continue;

    const msg = o.message;
    if (!msg) continue;

    // content 可能是块数组，也可能是字符串：CLI 的内部注入、
    // 部分续接消息与简单用户输入都会以纯字符串落盘。
    let content;
    if (typeof msg.content === "string") {
      content = msg.content.trim() ? [{ type: "text", text: msg.content }] : [];
    } else if (Array.isArray(msg.content)) {
      content = msg.content;
    } else {
      continue;
    }

    if (o.isSidechain) {
      s.sidechainTurns++;
      continue;
    }

    if (o.type === "user") {

      // 工具错误：tool_result 块上的 is_error
      for (const b of content) {
        if (b && b.type === "tool_result" && b.is_error) {
          const raw = Array.isArray(b.content)
            ? b.content.filter((x) => x && x.type === "text").map((x) => x.text).join("\n")
            : typeof b.content === "string"
              ? b.content
              : "";
          s.toolErrors.push({ ts: tsRaw, text: clip(String(raw || ""), 300) });
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
      if (s.userMessages.length < MAX_USER_MESSAGES_PER_SESSION) {
        s.userMessages.push({ ts: tsRaw, text: clip(joined, MAX_USER_TEXT) });
      }
      continue;
    }

    if (o.type === "assistant") {
      sawAnyMessageInWindow = true;
      s.assistantTurns++;
      if (s.firstSeenAt === null) s.firstSeenAt = tsRaw;
      s.lastSeenAt = tsRaw;
      s.hours[hourKey(ts)] = (s.hours[hourKey(ts)] || 0) + 1;

      for (const b of content) {
        if (!b) continue;
        if (b.type === "thinking") s.thinkingTurns++;
        if (b.type === "tool_use") {
          const name = b.name || "unknown";
          s.tools[name] = (s.tools[name] || 0) + 1;
          const input = b.input || {};
          const fp = input.file_path || input.path || input.notebook_path;
          if (fp && /^(Edit|Write|MultiEdit|NotebookEdit)$/.test(name)) {
            s.editedFiles.add(String(fp));
          }
          if (name === "Bash" && typeof input.command === "string") {
            if (s.commands.length < MAX_COMMANDS_PER_SESSION) {
              s.commands.push({ ts: tsRaw, command: clip(input.command, MAX_COMMAND_TEXT) });
            }
          }
        }
        if (b.type === "text" && typeof b.text === "string" && b.text.trim()) {
          s.finalAssistantText = b.text.trim();
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
  // --root auto（或缺省）= Claude Code 的默认会话目录
  const root = !args.root || args.root === "auto" ? path.join(os.homedir(), ".claude", "projects") : args.root;
  if (!root) throw new Error("缺少 --root <会话根目录>");

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
      const s = await scanSessionFile(f, windowStart, windowEnd);
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
