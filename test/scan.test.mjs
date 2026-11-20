import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCAN = path.join(HERE, "..", "scripts", "scan.mjs");

const today = new Date();
today.setHours(0, 0, 0, 0);
const DAY = today.getTime();
const pad = (n) => String(n).padStart(2, "0");
const DATE = `${today.getFullYear()}-${pad(today.getMonth() + 1)}-${pad(today.getDate())}`;
const at = (hours, minutes = 0) => new Date(DAY + hours * 3600000 + minutes * 60000).toISOString();

function line(obj) {
  return JSON.stringify(obj);
}

function makeFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "worklog-test-"));
  const projectDir = path.join(dir, "proj-a");
  fs.mkdirSync(projectDir, { recursive: true });

  const base = {
    sessionId: "sess-1",
    cwd: "D:\\proj\\demo",
    gitBranch: "main",
    version: "2.1.0",
    isSidechain: false,
  };

  const rows = [
    // 前一天的消息：应被排除，但要让 continuedFromEarlierDay = true
    {
      ...base,
      type: "user",
      timestamp: new Date(DAY - 86400000 + 3600000).toISOString(),
      message: { role: "user", content: [{ type: "text", text: "昨天的旧任务" }] },
    },
    // 当天真实用户消息
    {
      ...base,
      type: "user",
      timestamp: at(9, 10),
      message: { role: "user", content: [{ type: "text", text: "给上传接口加格式校验" }] },
    },
    // 工具结果行：不是用户轮次
    {
      ...base,
      type: "user",
      timestamp: at(9, 11),
      message: {
        role: "user",
        content: [{ type: "tool_result", is_error: true, content: "Error: file not found" }],
      },
    },
    // 内部注入：应被过滤
    {
      ...base,
      type: "user",
      timestamp: at(9, 12),
      message: {
        role: "user",
        content: [{ type: "text", text: "Base directory for this skill: C:\\skills\\x" }],
      },
    },
    // 助手：思考 + 工具调用 + 文本
    {
      ...base,
      type: "assistant",
      timestamp: at(9, 13),
      message: {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "先看控制器" },
          { type: "tool_use", name: "Read", input: { file_path: "D:\\proj\\demo\\A.java" } },
          { type: "tool_use", name: "Edit", input: { file_path: "D:\\proj\\demo\\A.java" } },
          { type: "tool_use", name: "Edit", input: { file_path: "D:\\proj\\demo\\A.java" } },
          { type: "tool_use", name: "Write", input: { file_path: "D:\\proj\\demo\\B.java" } },
          { type: "tool_use", name: "Bash", input: { command: "git status" } },
          { type: "text", text: "已加上白名单校验。" },
        ],
      },
    },
    // 第二条用户消息
    {
      ...base,
      type: "user",
      timestamp: at(10, 5),
      message: { role: "user", content: [{ type: "text", text: "图片也要限制" }] },
    },
    // 窗口之外（明天）
    {
      ...base,
      type: "user",
      timestamp: at(30),
      message: { role: "user", content: [{ type: "text", text: "明天的消息" }] },
    },
    // 坏行：不应导致崩溃
    "{not valid json",
  ];

  const file = path.join(projectDir, "sess-1.jsonl");
  fs.writeFileSync(file, rows.map((r) => (typeof r === "string" ? r : line(r))).join("\n"), "utf8");
  return { dir, file };
}

function run(dir) {
  const out = execFileSync(process.execPath, [SCAN, "--root", dir, "--date", DATE], {
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
  return JSON.parse(out);
}

test("扫描：按消息时间过滤，不按文件 mtime", () => {
  const { dir } = makeFixture();
  const r = run(dir);
  assert.equal(r.totals.sessions, 1);
  assert.equal(r.totals.userTurns, 2, "只统计当天两条真实用户消息");
  assert.equal(r.sessions[0].continuedFromEarlierDay, true);
});

test("扫描：tool_result 不算用户轮次，内部注入被过滤", () => {
  const { dir } = makeFixture();
  const s = run(dir).sessions[0];
  const texts = s.userMessages.map((m) => m.text);
  assert.deepEqual(texts, ["给上传接口加格式校验", "图片也要限制"]);
});

test("扫描：工具统计与改过的文件", () => {
  const { dir } = makeFixture();
  const s = run(dir).sessions[0];
  assert.equal(s.tools.Read, 1);
  assert.equal(s.tools.Edit, 2);
  assert.equal(s.tools.Write, 1);
  assert.equal(s.tools.Bash, 1);
  assert.deepEqual(s.editedFiles.sort(), ["D:\\proj\\demo\\A.java", "D:\\proj\\demo\\B.java"]);
  assert.equal(s.commands.length, 1);
  assert.equal(s.commands[0].command, "git status");
});

test("扫描：同一文件反复编辑会记成返工信号", () => {
  const { dir } = makeFixture();
  const s = run(dir).sessions[0];
  assert.deepEqual(s.hotFiles, [{ path: "D:\\proj\\demo\\A.java", edits: 2 }]);
});

test("扫描：用户要求与助手首条回应配对，内部注入不进入", () => {
  const { dir } = makeFixture();
  const s = run(dir).sessions[0];
  assert.equal(s.turns.length, 1);
  assert.equal(s.turns[0].user, "给上传接口加格式校验");
  assert.equal(s.turns[0].reply, "已加上白名单校验。");
});

test("扫描：工具错误被记录", () => {
  const { dir } = makeFixture();
  const s = run(dir).sessions[0];
  assert.equal(s.toolErrors.length, 1);
  assert.match(s.toolErrors[0].text, /file not found/);
});

test("扫描：最后一条助手文本作为结论", () => {
  const { dir } = makeFixture();
  const s = run(dir).sessions[0];
  assert.equal(s.finalAssistantText, "已加上白名单校验。");
  assert.equal(s.thinkingTurns, 1);
});

test("扫描：坏行不崩溃，且披露扫描失败数", () => {
  const { dir } = makeFixture();
  const r = run(dir);
  assert.equal(r.totals.filesFailed, 0);
  assert.equal(r.totals.filesScanned, 1);
});

test("扫描：空目录返回 0 会话", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "worklog-empty-"));
  const r = run(dir);
  assert.equal(r.totals.sessions, 0);
  assert.deepEqual(r.sessions, []);
});

test("扫描：字符串形式的用户消息也要计入", () => {
  // Claude Code 的 message.content 不总是数组：部分用户输入与续接消息
  // 会以纯字符串落盘，早期实现会整条丢弃。
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "worklog-str-"));
  const projectDir = path.join(dir, "proj");
  fs.mkdirSync(projectDir, { recursive: true });

  const base = { sessionId: "s-str", cwd: "D:\\proj\\demo", isSidechain: false };
  const rows = [
    {
      ...base,
      type: "user",
      timestamp: at(11, 0),
      message: { role: "user", content: "帮我修一下登录 bug" },
    },
    {
      ...base,
      type: "user",
      timestamp: at(11, 1),
      message: { role: "user", content: "<task-notification>内部注入</task-notification>" },
    },
    {
      ...base,
      type: "assistant",
      timestamp: at(11, 2),
      message: { role: "assistant", content: [{ type: "text", text: "好的" }] },
    },
  ];
  fs.writeFileSync(path.join(projectDir, "s.jsonl"), rows.map(line).join("\n"), "utf8");

  const r = run(dir);
  assert.equal(r.totals.sessions, 1);
  assert.equal(r.totals.userTurns, 1, "字符串形式只计真实输入，注入仍被过滤");
  assert.deepEqual(
    r.sessions[0].userMessages.map((m) => m.text),
    ["帮我修一下登录 bug"]
  );
});

test("扫描：插件自己生成报告留下的会话不算工作产出", () => {
  // 宿主跑 agent 会把这一轮写进会话日志。默认 cwd 在插件数据目录下，
  // 但用户也可能把它指到真实项目里，所以扫描器本身也要认得出来。
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "worklog-self-"));
  const projectDir = path.join(dir, "proj");
  fs.mkdirSync(projectDir, { recursive: true });

  const base = { sessionId: "s-self", cwd: "D:\\proj\\demo", isSidechain: false };
  const rows = [
    {
      ...base,
      type: "user",
      timestamp: at(9, 0),
      message: {
        role: "user",
        content: "你是一位替工程师写工作日报的助手。只依据下面提供的事实写作，不要补充事实中不存在的内容。",
      },
    },
    {
      ...base,
      type: "assistant",
      timestamp: at(9, 1),
      message: { role: "assistant", content: [{ type: "text", text: "# 工作日报" }] },
    },
  ];
  fs.writeFileSync(path.join(projectDir, "self.jsonl"), rows.map(line).join("\n"), "utf8");

  const r = run(dir);
  assert.equal(r.totals.sessions, 0, "插件自身生成的会话不应计入");
});

test("扫描：用户真的要求写日报时不会被误当成插件自身会话", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "worklog-ask-"));
  const projectDir = path.join(dir, "proj");
  fs.mkdirSync(projectDir, { recursive: true });

  const base = { sessionId: "s-ask", cwd: "D:\\proj\\demo", isSidechain: false };
  const rows = [
    {
      ...base,
      type: "user",
      timestamp: at(9, 0),
      message: { role: "user", content: "帮我写一份日报，把今天的改动整理一下" },
    },
    {
      ...base,
      type: "assistant",
      timestamp: at(9, 1),
      message: { role: "assistant", content: [{ type: "text", text: "好的" }] },
    },
  ];
  fs.writeFileSync(path.join(projectDir, "ask.jsonl"), rows.map(line).join("\n"), "utf8");

  const r = run(dir);
  assert.equal(r.totals.sessions, 1, "用户自己的写日报请求是真实工作，不能过滤");
});

test("扫描：以 HTML 标签开头的真实输入不会被当成内部注入", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "worklog-html-"));
  const projectDir = path.join(dir, "proj");
  fs.mkdirSync(projectDir, { recursive: true });

  const base = { sessionId: "s-html", cwd: "D:\\proj\\demo", isSidechain: false };
  const rows = [
    {
      ...base,
      type: "user",
      timestamp: at(12, 0),
      message: { role: "user", content: '<div class="card">样式不对</div>' },
    },
    {
      ...base,
      type: "user",
      timestamp: at(12, 1),
      message: { role: "user", content: "<task-notification>内部注入</task-notification>" },
    },
    {
      ...base,
      type: "assistant",
      timestamp: at(12, 2),
      message: { role: "assistant", content: [{ type: "text", text: "好的" }] },
    },
  ];
  fs.writeFileSync(path.join(projectDir, "s.jsonl"), rows.map(line).join("\n"), "utf8");

  const s = run(dir).sessions[0];
  assert.deepEqual(s.userMessages.map((m) => m.text), ['<div class="card">样式不对</div>']);
});

test("扫描：用户消息超过上限时保留最近的", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "worklog-cap-"));
  const projectDir = path.join(dir, "proj");
  fs.mkdirSync(projectDir, { recursive: true });

  const base = { sessionId: "s-cap", cwd: "D:\\proj\\demo", isSidechain: false };
  const rows = [];
  for (let i = 0; i < 85; i += 1) {
    rows.push({
      ...base,
      type: "user",
      timestamp: at(9, 0),
      message: { role: "user", content: [{ type: "text", text: "m" + i }] },
    });
  }
  fs.writeFileSync(path.join(projectDir, "s.jsonl"), rows.map(line).join("\n"), "utf8");

  const s = run(dir).sessions[0];
  assert.equal(s.userMessages.length, 80);
  assert.equal(s.userMessages[0].text, "m5", "应丢掉最早的 5 条");
  assert.equal(s.userMessages[79].text, "m84");
});

test("扫描：跨天会话的首次回应会配对到前一天的要求", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "worklog-carry-"));
  const projectDir = path.join(dir, "proj");
  fs.mkdirSync(projectDir, { recursive: true });

  const base = { sessionId: "s-carry", cwd: "D:\\proj\\demo", isSidechain: false };
  const rows = [
    {
      ...base,
      type: "user",
      timestamp: at(-1),
      message: { role: "user", content: [{ type: "text", text: "昨天没做完的接口" }] },
    },
    {
      ...base,
      type: "assistant",
      timestamp: at(0, 5),
      message: { role: "assistant", content: [{ type: "text", text: "今天继续把它补完" }] },
    },
  ];
  fs.writeFileSync(path.join(projectDir, "s.jsonl"), rows.map(line).join("\n"), "utf8");

  const s = run(dir).sessions[0];
  assert.equal(s.turns.length, 1);
  assert.equal(s.turns[0].user, "昨天没做完的接口");
  assert.equal(s.turns[0].fromEarlierDay, true);
});

test("扫描：连续多条用户消息会合并成同一轮要求", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "worklog-merge-"));
  const projectDir = path.join(dir, "proj");
  fs.mkdirSync(projectDir, { recursive: true });

  const base = { sessionId: "s-merge", cwd: "D:\\proj\\demo", isSidechain: false };
  const rows = [
    {
      ...base,
      type: "user",
      timestamp: at(13, 0),
      message: { role: "user", content: [{ type: "text", text: "先加校验" }] },
    },
    {
      ...base,
      type: "user",
      timestamp: at(13, 1),
      message: { role: "user", content: [{ type: "text", text: "图片也要限制" }] },
    },
    {
      ...base,
      type: "assistant",
      timestamp: at(13, 2),
      message: { role: "assistant", content: [{ type: "text", text: "两处都加好了" }] },
    },
  ];
  fs.writeFileSync(path.join(projectDir, "s.jsonl"), rows.map(line).join("\n"), "utf8");

  const s = run(dir).sessions[0];
  assert.equal(s.turns.length, 1);
  assert.equal(s.turns[0].user, "先加校验 / 图片也要限制");
  assert.equal(s.turns[0].reply, "两处都加好了");
});

test("扫描：指定目录不存在时明确失败", () => {
  const missing = path.join(os.tmpdir(), "worklog-missing-" + Date.now());
  let err = null;
  try {
    execFileSync(process.execPath, [SCAN, "--root", missing, "--date", DATE], {
      encoding: "utf8",
      stdio: "pipe",
    });
  } catch (e) {
    err = e;
  }
  assert.ok(err, "应非零退出");
  assert.notEqual(err.status, 0);
  assert.match(String(err.stderr || ""), /会话根目录不存在/);
});

test("扫描：显式 --engine claude 走 Claude Code 适配器", () => {
  const { dir } = makeFixture();
  const out = execFileSync(process.execPath, [SCAN, "--root", dir, "--date", DATE, "--engine", "claude"], {
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
  const r = JSON.parse(out);
  assert.equal(r.engine, "claude");
  assert.equal(r.engineLabel, "Claude Code");
  assert.deepEqual(r.supportedEngines, ["claude"]);
  assert.equal(r.totals.sessions, 1);
});

test("扫描：指定未知引擎时明确失败，不按 Claude 格式硬解析", () => {
  const { dir } = makeFixture();
  let err = null;
  try {
    execFileSync(process.execPath, [SCAN, "--root", dir, "--date", DATE, "--engine", "codex"], {
      encoding: "utf8",
      stdio: "pipe",
    });
  } catch (e) {
    err = e;
  }
  assert.ok(err, "应非零退出");
  assert.notEqual(err.status, 0);
  assert.match(String(err.stderr || ""), /不支持引擎 codex/);
});

test("扫描：--engine 命中原型链名字时同样明确失败", () => {
  const { dir } = makeFixture();
  for (const name of ["constructor", "__proto__", "toString"]) {
    let err = null;
    try {
      execFileSync(process.execPath, [SCAN, "--root", dir, "--date", DATE, "--engine", name], {
        encoding: "utf8",
        stdio: "pipe",
      });
    } catch (e) {
      err = e;
    }
    assert.ok(err, name + " 应非零退出");
    assert.notEqual(err.status, 0);
    assert.match(String(err.stderr || ""), /不支持引擎/, name + " 应报不支持引擎");
  }
});
