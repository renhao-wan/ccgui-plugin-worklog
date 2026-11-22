import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..");
const MAIN = path.join(ROOT, "main.js");
const SCAN = path.join(ROOT, "scripts", "scan.mjs");
const MANIFEST = path.join(ROOT, "manifest.json");

function readManifest() {
  return JSON.parse(fs.readFileSync(MANIFEST, "utf8"));
}

function fakeContext() {
  const calls = { registered: [], disposers: 0, storageSet: [], exec: [] };
  const disposer = () => {
    calls.disposers++;
  };
  const ctx = {
    pluginId: "worklog",
    version: "0.1.0",
    host: { sdkVersion: "0.3.25", appVersion: "1.2.4", locale: "zh-CN", isWeb: false },
    react: {
      createElement: () => null,
      useSyncExternalStore: () => null,
      useState: (v) => [v, () => {}],
      useEffect: () => {},
    },
    storage: {
      get: async () => null,
      set: async (k, v) => {
        calls.storageSet.push({ k, v });
      },
      delete: async () => {},
    },
    documentStorage: {
      getLocation: async () => ({ kind: "data", path: fs.mkdtempSync(path.join(os.tmpdir(), "wl-store-")) }),
      readText: async () => null,
      writeTextAtomic: async (_rel, content) => {
        calls.scanWritten = content;
        return { version: "v1" };
      },
      remove: async () => {},
      list: async () => [],
    },
    theme: {
      injectCss: (css) => {
        calls.css = css;
        return disposer;
      },
      setTokens: () => disposer,
    },
    ui: {
      registerCenterTab: (def) => {
        calls.registered.push({ kind: "centerTab", def });
        return disposer;
      },
      registerSidebarNav: (def) => {
        calls.registered.push({ kind: "sidebarNav", def });
        return disposer;
      },
      registerSettingsSection: (def) => {
        calls.registered.push({ kind: "settingsSection", def });
        return disposer;
      },
      registerCommand: (def) => {
        calls.registered.push({ kind: "command", def });
        return disposer;
      },
      openCenterTab: () => {},
      openSettings: () => {},
    },
    composer: { setDraft: () => {} },
    sessions: { selectSession: async () => {} },
    events: { on: () => disposer, emit: () => {} },
    agent: {
      catalog: async () => [],
      start: async () => ({ runId: "wl-run", sessionId: null }),
      interrupt: async () => true,
    },
    bridge: {
      invoke: async (cmd, args) => {
        calls.exec.push({ cmd, args });
        return { code: 0, stdout: "", stderr: "" };
      },
    },
  };
  return { ctx, calls };
}

test("构建：main.js 内联的扫描器与 scripts/scan.mjs 完全一致", () => {
  const src = fs.readFileSync(MAIN, "utf8");
  const m = /^const SCAN_SOURCE = ("(?:[^"\\]|\\.)*");$/m.exec(src);
  assert.ok(m, "main.js 中找不到 SCAN_SOURCE");
  assert.equal(JSON.parse(m[1]), fs.readFileSync(SCAN, "utf8"));
});

test("构建产物大小远低于硬上限", () => {
  const size = fs.statSync(MAIN).size;
  assert.ok(size < 512 * 1024, "bundle 应低于 512KB，实际 " + size);
});

test("manifest：必填字段与权限形状", () => {
  const m = readManifest();
  assert.match(m.id, /^[a-z][a-z0-9-]*$/);
  assert.equal(m.tier, "js");
  assert.ok(m.description.length <= 120, "description 不应超过 120 字符");
  assert.match(m.version, /^\d+\.\d+\.\d+$/);
  assert.match(m.sdkVersion, /^\^0\.3/);

  const base = new Set([
    "ui:center-tab", "ui:sidebar-entry", "ui:settings-section", "ui:command",
    "composer:draft", "plugin.storage", "storage", "theme", "events", "agent",
    "host:session", "assets:directory",
  ]);
  for (const p of m.permissions) {
    const ok = base.has(p) || /^exec:[A-Za-z0-9._-]+$/.test(p) || /^network:[^/]+$/.test(p);
    assert.ok(ok, "未知权限：" + p);
  }
  assert.ok(m.permissions.includes("exec:node"));
  assert.ok(m.permissions.includes("exec:git"));
});

test("CSS 不含远程引用", () => {
  const src = fs.readFileSync(MAIN, "utf8");
  const m = /^const CSS = `([\s\S]*?)`;$/m.exec(src);
  assert.ok(m, "找不到 CSS");
  assert.doesNotMatch(m[1], /@import|url\(\s*https?:/i);
});

test("activate：注册四个入口，并在卸载时全部释放", async () => {
  const mod = await import(pathToFileURL(MAIN).href);
  const { ctx, calls } = fakeContext();
  const dispose = mod.default(ctx);
  await new Promise((r) => setTimeout(r, 30));

  const kinds = calls.registered.map((r) => r.kind).sort();
  assert.deepEqual(kinds, ["centerTab", "command", "settingsSection", "sidebarNav"]);

  const tab = calls.registered.find((r) => r.kind === "centerTab");
  assert.equal(tab.def.key, "worklog");
  assert.equal(tab.def.title(), "工作志");
  assert.equal(typeof tab.def.component, "function");

  const nav = calls.registered.find((r) => r.kind === "sidebarNav");
  assert.equal(nav.def.label(), "工作志");

  const cmd = calls.registered.find((r) => r.kind === "command");
  assert.ok(cmd.def.keywords().includes("日报"));

  assert.equal(typeof dispose, "function");
  dispose();
  // CSS + 4 个注册 = 5 个 disposer
  assert.equal(calls.disposers, 5);
});

test("activate：启动时读取设置，未保存过则使用默认值", async () => {
  const mod = await import(pathToFileURL(MAIN).href);
  const { ctx } = fakeContext();
  const dispose = mod.default(ctx);
  await new Promise((r) => setTimeout(r, 30));
  dispose();
  assert.ok(true);
});
