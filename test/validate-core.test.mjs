// validate-core 的用例：每条对应一个真实踩过的坑，而不是「把实现抄一遍」。
// 用临时目录造一份最小插件，只改被测的那一处，断言它被抓到 / 不被误报。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { validatePlugin } from "../scripts/validate-core.mjs";

/** 造一份能通过全部检查的最小插件；overrides 覆盖个别文件内容。 */
function makePlugin(overrides) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "valcore-"));
  const files = {
    "manifest.json": JSON.stringify({
      id: "demo-plugin",
      name: "演示",
      version: "1.2.3",
      tier: "js",
      description: "演示用",
      repo: "someone/demo-plugin",
      icon: "icon.png",
      permissions: ["storage"],
    }),
    "main.js": "export default function activate(ctx) { ctx.storage.get('k'); return () => {}; }\n",
    "package.json": JSON.stringify({ name: "demo-plugin", version: "1.2.3" }),
    "README.md": "# 演示\n",
    LICENSE: "MIT\n",
  };
  Object.assign(files, overrides || {});
  for (const [rel, body] of Object.entries(files)) {
    if (body === null) continue;
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, body);
  }
  // 图标只需存在且是图片
  fs.writeFileSync(path.join(root, "icon.png"), "x");
  return root;
}

function run(overrides) {
  const root = makePlugin(overrides);
  try {
    return validatePlugin({ root, quiet: true });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

const has = (list, re) => list.some((m) => re.test(m));

/** 造 manifest 的差异版本。只覆盖被测字段，其余保持合法。 */
function manifestWith(patch) {
  return JSON.stringify(
    Object.assign(
      {
        id: "demo-plugin",
        name: "演示",
        version: "1.2.3",
        tier: "js",
        description: "演示用",
        repo: "someone/demo-plugin",
        icon: "icon.png",
        permissions: [],
      },
      patch,
    ),
  );
}

test("合法插件零报错：规则不能严到把正常插件也拦下", () => {
  const { errors, warnings } = run();
  assert.deepEqual(errors, []);
  assert.deepEqual(warnings, []);
});

test("id 不符合小写连字符规则时报错", () => {
  const { errors } = run({
    "manifest.json": manifestWith({ id: "Demo_Plugin" }),
  });
  assert.ok(has(errors, /id 不合法/), errors.join("; "));
});

test("未知权限要报错：宿主会整条拒绝加载", () => {
  const { errors } = run({
    "manifest.json": manifestWith({ id: "demo-plugin", permissions: ["storage", "teleport"] }),
  });
  assert.ok(has(errors, /未知权限：teleport/), errors.join("; "));
});

test("源码请求的 host 没在 manifest 声明时报错", () => {
  // 这正是「端点换了但忘了改 manifest」的形态：JS 侧会被宿主直接拒绝，
  // 而界面上只看到一句网络错误。
  const { errors } = run({
    "manifest.json": manifestWith({ permissions: ["network:old.example.com"] }),
    "main.js": 'export default function activate(ctx) { void ctx; }\nconst U = "https://new.example.com/feedback";\nfunction go(b) { return b.invoke("plugin_http_request", { url: U }); }\n',
  });
  assert.ok(has(errors, /new\.example\.com/), errors.join("; "));
});

test("plugin_exec 的 bin 没声明 exec: 时报错，声明了就不报", () => {
  const src = (bin) =>
    `export default function activate(ctx) {\n  return ctx.bridge.invoke("plugin_exec_run", { bin: "${bin}", args: [] });\n}\n`;
  const bad = run({ "manifest.json": manifestWith({ permissions: ["storage"] }), "main.js": src("node") });
  assert.ok(has(bad.errors, /exec:node/), bad.errors.join("; "));

  const good = run({ "manifest.json": manifestWith({ permissions: ["exec:node"] }), "main.js": src("node") });
  assert.deepEqual(good.errors, []);
});

test("bin 是变量、静态推断不到时：已声明任意 exec: 就不报", () => {
  // 真实形态：bin 由设置项决定（用户在设置里选引擎）。这时推断不出具体的
  // exec:node / exec:git，但只要有 exec: 授权就不该报错——否则会逼人声明
  // 一个字面量 "exec:*"，而那不是宿主认的权限。
  const src = (bin) =>
    `export default function activate(ctx) {\n  return ctx.bridge.invoke("plugin_exec_run", { bin: ${bin}, args: [] });\n}\n`;

  const ok = run({
    "manifest.json": manifestWith({ permissions: ["exec:node"] }),
    "main.js": src("settings.bin"),
  });
  assert.deepEqual(ok.errors, [], ok.errors.join("; "));

  const bad = run({
    "manifest.json": manifestWith({ permissions: ["storage"] }),
    "main.js": src("settings.bin"),
  });
  assert.ok(has(bad.errors, /exec:/), bad.errors.join("; "));
});

test("只当链接用的 host 不算网络请求，不要求 network: 声明", () => {
  // 四个插件都有 buildIssueUrl()，产物里必然出现 https://github.com。
  // 它只是「打开预填好的 Issue 页面」，不经过 plugin_http_request，也不需要
  // network: 授权。按全文件的 https 字面量推断会把这样的插件全判失败。
  const { errors } = run({
    "manifest.json": manifestWith({ permissions: ["network:feedback.example.com"] }),
    "main.js": [
      "export default function activate(ctx) { void ctx; }",
      'function issueUrl(repo) { return "https://github.com/" + repo + "/issues/new"; }',
      'const ENDPOINT = "https://feedback.example.com";',
      "function send(b) { return b.invoke('plugin_http_request', { method: 'POST', url: ENDPOINT + '/feedback' }); }",
    ].join("\n"),
  });
  assert.deepEqual(errors, [], errors.join("; "));
});

test("端点经参数/别名传进网络层时也能追到 host", () => {
  // 真实形态（四个插件都是这个结构）：常量声明在顶部，作为 opts.endpoint 传给
  // 网络层工厂，工厂内部再 `url: endpoint + "/feedback"`。只看调用点的字面量
  // 会漏掉——那样「改了端点忘了改 manifest」这条最该拦的检查就形同虚设。
  const src = [
    'const FEEDBACK_ENDPOINT = "https://feedback.example.com";',
    "export default function activate(ctx) {",
    "  const net = createFeedbackNet(ctx, { endpoint: FEEDBACK_ENDPOINT, pluginId: 'x' });",
    "  return net.send('hi');",
    "}",
    "function createFeedbackNet(ctx, opts) {",
    "  const endpoint = String(opts.endpoint || '');",
    "  async function send(text) {",
    "    return ctx.bridge.invoke('plugin_http_request', { method: 'POST', url: endpoint + '/feedback', body: text });",
    "  }",
    "  return { send };",
    "}",
  ].join("\n");

  const bad = run({ "manifest.json": manifestWith({ permissions: [] }), "main.js": src });
  assert.ok(has(bad.errors, /feedback\.example\.com/), bad.errors.join("; "));

  const ok = run({
    "manifest.json": manifestWith({ permissions: ["network:feedback.example.com"] }),
    "main.js": src,
  });
  assert.deepEqual(ok.errors, [], ok.errors.join("; "));
});

test("请求经过 httpGet 这类包装函数转手时，也能追到调用方传的 host", () => {
  // 每日热点的真实结构：plugin_http_request 只在 httpGetOnce 里出现一次，
  // url 是形参；真正的地址由 httpGet(...) 的调用方给出。只查调用点附近，
  // 会得出「声明了 api.github.com 但没请求」的错误结论。
  const src = [
    "export default function activate(ctx) {",
    "  async function httpGetOnce(url, headers) {",
    "    return ctx.bridge.invoke('plugin_http_request', { method: 'GET', url, headers });",
    "  }",
    "  async function httpGet(url, headers) { return httpGetOnce(url, headers); }",
    "  const a = httpGet('https://api.github.com/search/repositories?q=x');",
    "  const b = httpGet('https://raw.githubusercontent.com/o/r/HEAD/README.md');",
    "  const c = httpGet(buildUrl());",
    "  return [a, b, c];",
    "}",
  ].join("\n");

  const bad = run({ "manifest.json": manifestWith({ permissions: [] }), "main.js": src });
  assert.ok(has(bad.errors, /api\.github\.com/), bad.errors.join("; "));
  assert.ok(has(bad.errors, /raw\.githubusercontent\.com/), bad.errors.join("; "));

  const ok = run({
    "manifest.json": manifestWith({
      permissions: ["network:api.github.com", "network:raw.githubusercontent.com"],
    }),
    "main.js": src,
  });
  assert.deepEqual(ok.errors, [], ok.errors.join("; "));
});

test("形参名恰好与别处某个 URL 常量同名时，仍按形参追调用方", () => {
  // 真实产物里 `url` 既是 httpGetOnce 的形参，也在别处当过
  // `const url = "https://api.github.com/..."`。常量表没有作用域，
  // 按名字查会把形参误当成常量，结果漏掉 raw.githubusercontent.com。
  const src = [
    "export default function activate(ctx) {",
    "  async function httpGetOnce(url, headers) {",
    "    return ctx.bridge.invoke('plugin_http_request', { method: 'GET', url, headers });",
    "  }",
    "  function readmeUrl(repo) {",
    "    const url = 'https://api.github.com/repos/' + repo + '/readme';",
    "    return url;",
    "  }",
    "  return httpGetOnce('https://raw.githubusercontent.com/o/r/HEAD/README.md', {});",
    "}",
  ].join("\n");

  const { errors } = run({
    "manifest.json": manifestWith({ permissions: ["network:raw.githubusercontent.com"] }),
    "main.js": src,
  });
  assert.deepEqual(errors, [], errors.join("; "));
});

test("url 由构造函数返回（buildUrl / trendingUrl）时，也能追到 host", () => {
  // 与「包装函数收 url」相反的方向：httpGet(trendingUrl(...)) 里，
  // host 写在 trendingUrl 的 return 上。两个方向都得追，否则每日热点会误报
  // 「声明了 network:github.com 但没请求」。
  const src = [
    "export default function activate(ctx) {",
    "  async function httpGetOnce(url, headers) {",
    "    return ctx.bridge.invoke('plugin_http_request', { method: 'GET', url, headers });",
    "  }",
    "  function trendingUrl(lang) {",
    "    const base = 'https://github.com/trending' + (lang ? '/' + lang : '');",
    "    return base;",
    "  }",
    "  function discoverUrl(q) {",
    "    return 'https://api.github.com/search/repositories?q=' + q;",
    "  }",
    "  return [httpGetOnce(trendingUrl('rust'), {}), httpGetOnce(discoverUrl('x'), {})];",
    "}",
  ].join("\n");

  const bad = run({ "manifest.json": manifestWith({ permissions: [] }), "main.js": src });
  assert.ok(has(bad.errors, /github\.com/), bad.errors.join("; "));
  assert.ok(has(bad.errors, /api\.github\.com/), bad.errors.join("; "));

  const ok = run({
    "manifest.json": manifestWith({ permissions: ["network:github.com", "network:api.github.com"] }),
    "main.js": src,
  });
  assert.deepEqual(ok.errors, [], ok.errors.join("; "));
});

test("innerHTML 赋值要报错，但只是注释里提到不算", () => {
  const bad = run({
    "main.js": 'export default function activate(ctx) { void ctx; }\nfunction f(el, s) { el.innerHTML = s; }\n',
  });
  assert.ok(has(bad.errors, /innerHTML/), bad.errors.join("; "));

  // worklog 的真实情况：注释里写「不用 innerHTML」，不能因此判失败。
  const ok = run({
    "main.js": "export default function activate(ctx) { void ctx; }\n/** 不用 innerHTML，避免把报告内容当 HTML 执行。 */\nfunction f() { return 1; }\n",
  });
  assert.deepEqual(ok.errors, []);
});

test("声明了权限却没检出对应调用：只警告，不拦构建", () => {
  const { errors, warnings } = run({
    "manifest.json": manifestWith({ permissions: ["storage", "agent"] }),
  });
  assert.deepEqual(errors, []);
  assert.ok(has(warnings, /agent/), warnings.join("; "));
});

test("package.json 与 manifest.json 版本漂开时报错", () => {
  const { errors } = run({ "package.json": JSON.stringify({ name: "d", version: "1.2.4" }) });
  assert.ok(has(errors, /版本/), errors.join("; "));
});

test("extraRules 能追加插件自己的检查，并共用一份 errors/warnings", () => {
  const seen = [];
  const { root, ...rest } = (() => {
    const r = makePlugin();
    return { root: r };
  })();
  try {
    const out = validatePlugin({
      root,
      quiet: true,
      extraRules: (ctx) => {
        seen.push(ctx.manifest && ctx.manifest.id, typeof ctx.fail, typeof ctx.warn);
        if (fs.existsSync(path.join(root, "src", "lib", "missing.mjs"))) ctx.fail("不该走到这里");
        ctx.fail("插件自有的检查项");
      },
    });
    assert.ok(has(out.errors, /插件自有的检查项/), out.errors.join("; "));
    // 上下文里给的是已解析的 manifest 与 fail/warn，插件不必自己再读文件。
    assert.equal(seen[0], "demo-plugin");
    assert.deepEqual(seen.slice(1), ["function", "function"]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
