/**
 * 插件自检的公共规则（四插件共用）。
 *
 * 每次新建插件都从上一个插件里拷 validate-manifest.mjs，拷到第四份时四份已经
 * 明显漂开：`innerHTML` 黑名单和网络 host 推断只有每日热点有，另外三个漏了。
 * 漏掉的后果不是「少一条提示」，而是宿主侧直接拒绝加载 / 请求被拒，只在界面上
 * 显示一句看不懂的失败。
 *
 * 这份 core 只管**所有插件都成立**的规则；插件特有的检查通过 extraRules 追加，
 * 共用同一份 errors / warnings 与同一份输出格式。
 *
 * 用法（在 scripts/validate-manifest.mjs 里）：
 *   import { validatePlugin } from "./validate-core.mjs";
 *   const code = validatePlugin({
 *     root: ROOT,
 *     extraRules(ctx) { ... ctx.fail(...) / ctx.warn(...) ... },
 *   });
 *   process.exit(code);
 */
import fs from "node:fs";
import path from "node:path";

const ID_RE = /^[a-z0-9][a-z0-9-]{1,63}$/;
const VER_RE = /^\d+\.\d+\.\d+$/;
const EXEC_RE = /^exec:[A-Za-z0-9._-]+$/;
const NET_RE = /^network:[A-Za-z0-9.-]+(:\d{1,5}(-\d{1,5})?)?$/;

// 权限基座白名单。与索引仓校验器保持一致；`exec:` / `network:` 另有形状规则。
const BASE_PERMISSIONS = new Set([
  "storage", "ui:settings-section", "ui:add-menu", "ui:composer-status", "ui:panel-tab",
  "ui:status-bar", "ui:overlay", "ui:command", "ui:markdown", "ui:page", "ui:timeline-row",
  "ui:workspace-menu", "ui:session-menu", "ui:file-link-menu", "ui:sidebar-entry",
  "ui:center-tab", "ui:conversation-mode", "ui:worktree-badge", "agent", "theme", "i18n",
  "events", "network:none", "composer:draft", "host:session", "host:workspace",
  "host:workspace:remote", "host:worktree", "host:window", "host:models", "usage.read",
  "limits.read", "session.lifecycle.read", "runtime.events.read", "runtime.switch.observe",
  "prompt.contribute.internal", "workspace.metadata.read", "plugin.storage", "assets:bundle",
  "assets:directory",
]);

/**
 * 产物里绝不能出现的写法。
 *
 * 注意 `innerHTML` 只匹配**赋值/JSX**，不匹配裸词：插件里常有
 * 「不用 innerHTML，避免把内容当 HTML 执行」这类注释，按裸词匹配会误报。
 */
const BANNED = [
  [/\beval\s*\(/, "eval("],
  [/\bnew\s+Function\s*\(/, "new Function("],
  [/__TAURI__/, "__TAURI__"],
  [/\blocalStorage\b/, "localStorage"],
  [/\bimport\s*\(\s*["'`]https?:/, "远程 import("],
  [/^\s*import\s+.+from\s+["'][^./]/m, "bare import"],
  [/^\s*(?:const|let|var)\s+.+=\s*require\s*\(/m, "require("],
  [/\.innerHTML\s*=/, "innerHTML 赋值"],
  [/dangerouslySetInnerHTML\s*:/, "dangerouslySetInnerHTML"],
];

/**
 * 从产物里推断出**真的会被请求**的 network host。
 *
 * 不能对整份产物扫 `https://...`：四个插件都有 `buildIssueUrl()`，产物里必然
 * 出现 `https://github.com/...`，那只是打开预填好的 Issue 页面，不发请求、也不
 * 需要 network: 授权。按全文件扫会把它们全判成「缺 network:github.com」。
 *
 * 也不能按「调用点附近多少字符」扫：端点常量常声明在文件顶部
 * （`const FEEDBACK_ENDPOINT = "https://..."` 在第 16 行），而调用在几百行之后，
 * 任何固定的窗口都会漏。
 *
 * 所以分三步：
 *   1. 建常量表与别名表；
 *   2. 看每个 `plugin_http_request` 的 `url` 表达式用到了哪些常量；
 *   3. `url` 只是形参时（请求被包在 httpGetOnce 之类的函数里），向上找
 *      调用这个包装函数的实参，从实参里取 host。
 */
export function hostsInSource(src) {
  const decls = constHosts(src);
  const aliases = aliasHosts(src, decls);
  const fns = parseFunctions(src); // 只解析一次：产物动辄几千行，每次循环重解析太慢
  const hosts = new Set();

  // 从一段表达式里收集 host：字面量 + 已知常量 + 已知别名
  const hostsOfExpr = (expr) => {
    const out = new Set(literalHosts(expr));
    for (const name of expr.match(/[A-Za-z_$][\w$]*/g) || []) {
      for (const host of decls.get(name) || []) out.add(host);
      for (const host of aliases.get(name) || []) out.add(host);
    }
    return out;
  };

  const callRe = /plugin_http_request/g;
  let call;
  while ((call = callRe.exec(src))) {
    // `url` 在调用点之后的对象字面量里。两种写法都要认：
    //   url: endpoint + "/feedback"   （显式键值）
    //   { method: 'GET', url, headers } （ES6 简写属性，没有冒号）
    const area = src.slice(call.index, call.index + CALL_WINDOW);
    const kv = /url\s*:\s*([^,\n}]+)/.exec(area);
    const shorthand = /[{,]\s*url\s*[,}]/.exec(area);
    let expr = null;
    if (kv) expr = kv[1].trim();
    else if (shorthand) expr = "url";
    if (!expr) continue;

    // 单标识符要格外小心：它既可能是模块级常量（`url: ENDPOINT`），也可能是
    // 函数形参（`{ url }`）。形参的值只能从调用方看，而常量表没有作用域概念
    // ——真实产物里 `url` 这个名字既当过 httpGetOnce 的形参，也在别处当过
    // `const url = "https://api.github.com/..."`。按名字查常量表会把形参误当
    // 成常量，从而漏掉 api.github.com / raw 这类 host。
    if (/^[A-Za-z_$][\w$]*$/.test(expr)) {
      const enclosing = enclosingFunction(fns, call.index);
      const isParam =
        enclosing && (fns.get(enclosing).params || []).some((p) => p === expr);

      if (isParam) {
        for (const h of hostsFromWrappers(src, call.index, expr, fns)) hosts.add(h);
      } else {
        const asConst = decls.get(expr);
        if (asConst && asConst.length) for (const h of asConst) hosts.add(h);
        else for (const h of hostsFromWrappers(src, call.index, expr, fns)) hosts.add(h);
      }
      continue;
    }

    const direct = hostsOfExpr(expr);
    for (const h of direct) hosts.add(h);
    // 表达式是 `buildUrl()` 这类调用、且里面没有可解析的 host 时，
    // 同样往调用方追一层（例如 `url: boardUrl(row)`）。
    if (direct.size === 0) {
      for (const h of hostsFromWrappers(src, call.index, expr)) hosts.add(h);
    }
  }
  return hosts;
}

/**
 * 追一层间接：请求的 url 是形参，或 url 由某个构造函数生成。
 *
 * 两个方向都要认，因为真实产物里两个都有：
 *   - 收：`httpGetOnce(url)` 里发请求，host 在 `httpGet("https://raw...")` 实参上；
 *   - 返：`httpGet(trendingUrl(lang))`，host 在 `trendingUrl` 的 return 上。
 *
 * 用「函数可达性」而不是正则猜转手：先找出所有函数体，标记哪些函数（直接或经
 * 若干层调用）最终发出了 `plugin_http_request`，再去这些函数的调用点收 host。
 * 正则猜「谁转手了谁」在 `name(url, headers) { return other(url, headers); }`
 * 这种写法上很容易失配。
 */
function hostsFromWrappers(src, callIndex, urlExpr, fnsIn) {
  const out = new Set();
  if (!/^[A-Za-z_$][\w$]*$/.test(urlExpr)) return out;

  const fns = fnsIn || parseFunctions(src);
  const reaching = new Set();

  // 直接发出请求的函数
  for (const [name, fn] of fns) {
    if (/plugin_http_request/.test(fn.body)) reaching.add(name);
  }
  // 间接的：调用了 reaching 里任何一个
  for (let pass = 0; pass < 6; pass += 1) {
    let changed = false;
    for (const [name, fn] of fns) {
      if (reaching.has(name)) continue;
      for (const target of reaching) {
        if (new RegExp(`\\b${target}\\s*\\(`).test(fn.body)) {
          reaching.add(name);
          changed = true;
          break;
        }
      }
    }
    if (!changed) break;
  }

  // 包住这次请求的那个函数必须被认出来，否则说明分析漏了，宁可少报也不误报
  const enclosing = enclosingFunction(fns, callIndex);
  if (enclosing) reaching.add(enclosing);

  for (const name of reaching) {
    // 方向一：谁调用了发包函数，实参里可能就有 host
    const callRe = new RegExp(`\\b${name}\\s*\\(([^)]*)\\)`, "g");
    let c;
    while ((c = callRe.exec(src))) {
      // 跳过声明本身
      if (/(?:function|async)\s+$/.test(src.slice(Math.max(0, c.index - 20), c.index))) continue;
      for (const host of literalHosts(c[1])) out.add(host);
      // 方向二：实参里调用的构造函数，其 return 表达式可能有 host
      for (const callee of c[1].match(/([A-Za-z_$][\w$]*)\s*\(/g) || []) {
        const fnName = callee.replace(/\s*\($/, "");
        const built = fns.get(fnName);
        if (built) for (const host of returnHosts(built.body, src)) out.add(host);
      }
    }
  }
  return out;
}

/** 从函数体里的 `return ...` 表达式收集 host：字面量 + 体内局部常量。 */
function returnHosts(body, src) {
  const out = [];
  // 体内声明的局部常量先收集，`const base = "https://..."` 后 `return base`
  const locals = new Map();
  const declRe = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*([^;\n]+)/g;
  let m;
  while ((m = declRe.exec(body))) locals.set(m[1], literalHosts(m[2]));

  const retRe = /\breturn\b([^;\n]*)/g;
  while ((m = retRe.exec(body))) {
    for (const host of literalHosts(m[1])) out.push(host);
    for (const name of m[1].match(/[A-Za-z_$][\w$]*/g) || []) {
      for (const host of locals.get(name) || []) out.push(host);
    }
  }
  return out;
}

/** 找出包住某个位置的最内层函数名。按声明的起止区间判断，不靠文本出现次序。 */
function enclosingFunction(fns, index) {
  let hit = null;
  let bestSpan = Infinity;
  for (const [name, fn] of fns) {
    for (const [start, end] of fn.spans) {
      if (start <= index && index < end && end - start < bestSpan) {
        hit = name;
        bestSpan = end - start;
      }
    }
  }
  return hit;
}

/** 解析出「函数名 → { body, params, spans }」。只认 `function NAME(...) {` 与 `const NAME = (...) => {`。 */
function parseFunctions(src) {
  const map = new Map();
  const re = /(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(([^)]*)\)\s*\{|(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\(([^)]*)\)\s*=>\s*\{/g;
  let m;
  while ((m = re.exec(src))) {
    const name = m[1] || m[3];
    const params = (m[2] !== undefined ? m[2] : m[4]) || "";
    const open = src.indexOf("{", m.index + m[0].length - 1);
    if (open < 0) continue;
    let depth = 0;
    for (let i = open; i < src.length; i += 1) {
      if (src[i] === "{") depth += 1;
      else if (src[i] === "}") {
        depth -= 1;
        if (depth === 0) {
          // 同名重复声明（合并式）取合并，避免漏掉其中一段
          const prev = map.get(name);
          map.set(name, {
            body: (prev ? prev.body + "\n" : "") + src.slice(open, i + 1),
            params: [
              ...((prev && prev.params) || []),
              ...params
                .split(",")
                .map((p) => p.trim().replace(/=.*$/, "").trim())
                .filter(Boolean),
            ],
            spans: [...(prev ? prev.spans : []), [m.index, i + 1]],
          });
          break;
        }
      }
    }
  }
  return map;
}

/** 调用点向后取多少字符找 `url:`。够覆盖多行对象字面量，又不会跨到下一个调用。 */
const CALL_WINDOW = 600;

/** 常量表：`const NAME = "https://host..."` → host 集合。 */
function constHosts(src) {
  const map = new Map();
  const re = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*["'`][^"'`]*/g;
  let m;
  while ((m = re.exec(src))) {
    const hosts = literalHosts(m[0]);
    if (hosts.length) map.set(m[1], hosts);
  }
  return map;
}

/**
 * 别名表：把「带 host 的常量」传播到接过它的局部变量 / 参数。
 *
 * 四个插件的形状都是：常量在顶部 → 作为 `{ endpoint: FEEDBACK_ENDPOINT }` 传给
 * 工厂 → 工厂内 `const endpoint = String(opts.endpoint || '')` → `url: endpoint + ...`。
 * 不传播这一层，真实插件就永远查不出 host，这条检查等于没开。
 *
 * 认这几种形式（够用且不会误伤）：
 *   { endpoint: FEEDBACK_ENDPOINT }            对象字面量传参
 *   const endpoint = String(opts.endpoint || '')   从参数取回
 *   const endpoint = opts.endpoint
 *   opts.endpoint = FEEDBACK_ENDPOINT          直接赋值给字段
 */
function aliasHosts(src, decls) {
  const map = new Map(); // 变量/字段名 → host 数组

  const known = (name) => decls.get(name) || [];
  const hostsOf = (name) => [...known(name), ...(map.get(name) || [])];

  const add = (name, hosts) => {
    if (!name || !hosts || !hosts.length) return false;
    const prev = map.get(name) || [];
    const merged = [...new Set([...prev, ...hosts])];
    if (merged.length === prev.length) return false;
    map.set(name, merged);
    return true;
  };

  // 一轮扫描：所有「右侧表达式的标识符里出现了带 host 的名字」
  function scan() {
    let changed = false;
    const re = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*([^\n;]+)|\.([A-Za-z_$][\w$]*)\s*=\s*([A-Za-z_$][\w$]*)/g;
    let m;
    while ((m = re.exec(src))) {
      // 形式一：const X = <expr>
      if (m[1]) {
        const expr = m[2];
        // 只在表达式里出现「端点类」名字时才传播，避免把普通变量都收进来
        if (!/endpoint|base|host|url|ENDPOINT|URL/i.test(expr)) continue;
        const hosts = [];
        for (const name of expr.match(/[A-Za-z_$][\w$]*/g) || []) hosts.push(...hostsOf(name));
        // 表达式里可能还直接带字面量（如 opts.endpoint || 'https://...'）
        hosts.push(...literalHosts(expr));
        if (add(m[1], hosts)) changed = true;
        continue;
      }
      // 形式二：obj.field = NAME
      if (m[3]) {
        if (add(m[3], hostsOf(m[4]))) changed = true;
        // 对象字面量传参：{ endpoint: FEEDBACK_ENDPOINT }
      }
    }

    // 形式三：对象字面量 { field: NAME } —— 这一行往往同时声明了新变量
    const objRe = /\b([A-Za-z_$][\w$]*)\s*:\s*([A-Za-z_$][\w$]*)/g;
    while ((m = objRe.exec(src))) {
      if (add(m[1], hostsOf(m[2]))) changed = true;
    }
    return changed;
  }

  for (let pass = 0; pass < 6; pass += 1) {
    if (!scan()) break;
  }
  return map;
}

function literalHosts(text) {
  const out = [];
  const re = /https:\/\/([A-Za-z0-9.-]+)/g;
  let m;
  while ((m = re.exec(text))) out.push(m[1].toLowerCase());
  return out;
}

/** 从产物里推断出的 exec bin（plugin_exec_* 调用里的 bin 字段）。 */
export function binsInSource(src) {
  const bins = new Set();
  const re = /plugin_exec_[a-z_]+[\s\S]{0,400}?bin\s*:\s*["']([A-Za-z0-9._-]+)["']/g;
  let m;
  while ((m = re.exec(src))) bins.add(m[1]);
  return bins;
}

function readJson(root, rel, fail) {
  try {
    return JSON.parse(fs.readFileSync(path.join(root, rel), "utf8"));
  } catch (e) {
    fail(`${rel} 读取或解析失败：${e.message}`);
    return null;
  }
}

/**
 * 跑一遍全部检查。
 * @param {{root: string, extraRules?: (ctx: object) => void, quiet?: boolean}} opts
 *   quiet 只用于单测：不打印，只把结果交回去。
 * @returns {{code: number, errors: string[], warnings: string[]}}
 *   code 为 0 表示全部通过；1 表示有 error（warning 不改变退出码）。
 */
export function validatePlugin(opts) {
  const root = opts.root;
  const errors = [];
  const warnings = [];
  const fail = (m) => errors.push(m);
  const warn = (m) => warnings.push(m);

  const manifest = readJson(root, "manifest.json", fail);
  if (manifest) {
    if (!ID_RE.test(manifest.id || "")) fail(`id 不合法：${manifest.id}`);
    if (!VER_RE.test(manifest.version || "")) fail(`version 不是 x.y.z：${manifest.version}`);
    if (!["declarative", "js"].includes(manifest.tier)) fail(`tier 不合法：${manifest.tier}`);
    if (!manifest.name) fail("缺少 name");
    if (!manifest.description) fail("缺少 description");
    if (manifest.description && manifest.description.length > 120)
      fail(`description ${manifest.description.length} 字符，超过 120`);
    if (!manifest.repo || !/^[^/\s]+\/[^/\s]+$/.test(manifest.repo))
      fail(`repo 形状应为 owner/name：${manifest.repo}`);

    for (const p of manifest.permissions || []) {
      if (!BASE_PERMISSIONS.has(p) && !EXEC_RE.test(p) && !NET_RE.test(p)) fail(`未知权限：${p}`);
    }
  }

  const src = checkBundle(root, fail, warn);
  const declared = new Set((manifest && manifest.permissions) || []);

  if (src !== null) {
    const hosts = hostsInSource(src);
    const bins = binsInSource(src);
    const required = declarationsUsedBySource(src, hosts, bins);

    for (const [perm, usage] of required) {
      if (perm === EXEC_ANY) {
        // 只要声明了任意一项 exec: 就算满足
        if (![...declared].some((p) => p.startsWith("exec:"))) {
          fail(`源码用到 ${usage}，但 manifest.permissions 缺少 exec: 授权`);
        }
        continue;
      }
      if (!declared.has(perm)) fail(`源码用到 ${usage}，但 manifest.permissions 缺少 ${perm}`);
    }

    // 多声明只警告：权限可能是为「将来某个入口」预留的，或用法藏在字符串拼出来的调用里，
    // 直接报错会让人删掉真正需要的授权。
    const used = new Set(required.map(([perm]) => perm));
    const execUsed = used.has(EXEC_ANY);
    for (const perm of declared) {
      if (perm === "network:none") continue;
      if (perm.startsWith("network:")) {
        const host = perm.slice("network:".length).split(":")[0];
        if (!hosts.has(host)) warn(`声明了权限 "${perm}" 但未检出对该 host 的请求`);
        continue;
      }
      if (execUsed && perm.startsWith("exec:")) continue;
      if (!used.has(perm)) warn(`声明了权限 "${perm}" 但未检出对应调用`);
    }
  }

  checkAssets(root, manifest, fail);
  for (const r of ["README.md", "LICENSE"]) {
    if (!fs.existsSync(path.join(root, r))) fail(`仓库根缺少 ${r}`);
  }

  // manifest.json 是发版与宿主加载的唯一真相；package.json 只给本地脚本用。
  // 两份版本漂开时，打出来的 tag 与实际安装的版本对不上，查问题会绕远路。
  {
    const pkg = readJson(root, "package.json", fail);
    if (pkg && manifest && pkg.version && manifest.version && pkg.version !== manifest.version) {
      fail(`package.json 版本 ${pkg.version} 与 manifest.json ${manifest.version} 不一致`);
    }
  }

  if (typeof opts.extraRules === "function") {
    opts.extraRules({ root, manifest, src, declared, fail, warn });
  }

  if (!opts.quiet) {
    for (const w of warnings) console.warn("WARN  " + w);
    for (const e of errors) console.error("FAIL  " + e);
    // 附加规则的输出也要算进去，所以放在 extraRules 之后再打印。
    console.log(
      `\nRESULT=${errors.length === 0 ? "VALIDATE_OK" : "VALIDATE_FAIL"} errors=${errors.length} warnings=${warnings.length}`,
    );
  }
  return { code: errors.length === 0 ? 0 : 1, errors, warnings };
}

/** 产物检查。返回产物文本，缺失时返回 null（后续规则依赖它）。 */
function checkBundle(root, fail, warn) {
  const bundle = path.join(root, "main.js");
  if (!fs.existsSync(bundle)) {
    fail("缺少 main.js");
    return null;
  }
  const src = fs.readFileSync(bundle, "utf8");
  const size = Buffer.byteLength(src);
  if (size > 2 * 1024 * 1024) fail(`main.js ${(size / 1024).toFixed(0)}KB 超过 2MB 硬上限`);
  else if (size > 512 * 1024) warn(`main.js ${(size / 1024).toFixed(0)}KB 超过 512KB 建议值`);

  for (const [re, label] of BANNED) if (re.test(src)) fail(`main.js 命中黑名单：${label}`);

  // 注入的 CSS 不能引用远程资源：宿主会拒绝整段样式，界面直接变成裸 HTML。
  const cssBlock = src.match(/const CSS = `([\s\S]*?)`;/);
  if (cssBlock) {
    if (/@import/.test(cssBlock[1])) fail("注入 CSS 含 @import（宿主会拒绝）");
    if (/url\(\s*["']?https?:/i.test(cssBlock[1])) fail("注入 CSS 含远程 url()（宿主会拒绝）");
  }
  return src;
}

/** 按源码里实际出现的用法，推出必须声明的权限。 */
function declarationsUsedBySource(src, hosts, bins) {
  const required = [];
  const need = (perm, usage) => required.push([perm, usage]);

  if (/\b(?:appCtx|ctx)\.storage\s*\./.test(src)) need("storage", "ctx.storage");
  if (/\b(?:appCtx|ctx)\.documentStorage\s*\./.test(src)) need("plugin.storage", "ctx.documentStorage");
  if (/\b(?:appCtx|ctx)\.ui\.registerSettingsSection\b|\b(?:appCtx|ctx)\.ui\.openSettings\b/.test(src))
    need("ui:settings-section", "settings section");
  if (/\b(?:appCtx|ctx)\.ui\.registerCommand\b/.test(src)) need("ui:command", "registerCommand");
  if (/\b(?:appCtx|ctx)\.ui\.registerCenterTab\b|\b(?:appCtx|ctx)\.ui\.openCenterTab\b/.test(src))
    need("ui:center-tab", "center tab");
  if (/\b(?:appCtx|ctx)\.ui\.registerSidebarNav\b/.test(src)) need("ui:sidebar-entry", "sidebar entry");
  if (/\b(?:appCtx|ctx)\.ui\.registerComposerStatusItem\b|\b(?:appCtx|ctx)\.ui\.registerComposerSlot\b/.test(src))
    need("ui:composer-status", "registerComposerStatusItem");
  if (/\b(?:appCtx|ctx)\.ui\.registerOverlay\b/.test(src)) need("ui:overlay", "registerOverlay");
  if (/\b(?:appCtx|ctx)\.composer\.setDraft\s*\(/.test(src)) need("composer:draft", "composer.setDraft");
  if (/\b(?:appCtx|ctx)\.theme\.(injectCss|setTokens)\s*\(/.test(src)) need("theme", "ctx.theme");
  if (/\b(?:appCtx|ctx)\.events\.(on|emit)\s*\(/.test(src)) need("events", "ctx.events");
  if (/\b(?:appCtx|ctx)\.agent\./.test(src)) need("agent", "ctx.agent");
  if (/\b(?:appCtx|ctx)\.sessions\./.test(src)) need("host:session", "ctx.sessions");
  if (/\b(?:appCtx|ctx)\.workspaces\.(add|list)\s*\(/.test(src)) need("host:workspace", "ctx.workspaces");
  if (/\b(?:appCtx|ctx)\.models\./.test(src)) need("host:models", "ctx.models");
  if (
    /\b(?:appCtx|ctx)\.assets\.(grantDirectory|grantFile|listDirectories|revokeDirectory|directoryUrl)\s*\(/.test(src)
  )
    need("assets:directory", "ctx.assets directory picker");

  // network: 端点换了却忘记改 manifest，是最常见的「代码对、界面报错」来源。
  // network: 是精确主机匹配，没有通配，少一个字符就整条被拒。
  if (/plugin_http_request/.test(src)) {
    for (const host of hosts) need("network:" + host, "plugin_http_request → " + host);
  }

  for (const bin of bins) need("exec:" + bin, "plugin_exec_* bin=" + bin);
  if (bins.size === 0 && /plugin_exec_[a-z_]+/.test(src)) {
    // bin 由设置项或变量决定，静态推断不到具体值。这时只要求「至少有一项
    // exec: 授权」——宿主认的是具体 bin，不能要求声明一个字面量 exec:*。
    required.push([EXEC_ANY, "plugin_exec_*（bin 无法静态推断）"]);
  }
  return required;
}

/** 「任一项 exec: 授权」的标记，不是真实权限名，只在本文件内作为 required 的键。 */
const EXEC_ANY = "\u0000exec-any";

/** 展示素材：必须存在、扩展名合法、不逃逸仓库。 */
function checkAssets(root, manifest, fail) {
  const checkAsset = (rel, label) => {
    if (!rel) return;
    if (/^https:\/\//.test(rel)) return;
    const abs = path.resolve(root, rel);
    if (!abs.startsWith(root + path.sep)) return fail(`${label} 逃逸仓库：${rel}`);
    if (!fs.existsSync(abs)) return fail(`${label} 不存在：${rel}`);
    if (!/\.(png|jpe?g|webp|gif|svg|avif)$/i.test(rel)) fail(`${label} 不是图片：${rel}`);
  };
  if (!manifest) return;
  if (!manifest.icon) fail("缺少 icon（市场条目与侧栏需要）");
  checkAsset(manifest.icon, "icon");
  for (const s of manifest.screenshots || []) checkAsset(s, "screenshot");
  if ((manifest.screenshots || []).length > 5) fail("screenshots 最多 5 张");
}
