// 反馈纯函数是从 ccgui-plugin-github-trending/src/lib/feedback.mjs 整段复制的
// （这个插件没有构建步骤，只能内联）。注释里写了「改这里记得同步」，但注释拦不住
// 忘同步。这个脚本把「两份逐字一致」变成可执行检查。
//
// 只比对纯函数层（正文收敛、Issue 链接、请求体白名单、额度文案）——
// 网络与 UI 各自实现，不在比对范围。
//
// 用法：node scripts/check-feedback-sync.mjs
//   基准文件默认是本地兄弟目录里的 github-trending；CI 里没有兄弟目录，
//   可以用环境变量 FEEDBACK_BASE 指到 checkout 下来的那份。
import fs from 'node:fs';
import path from 'node:path';

const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1'));
const REPO = path.resolve(HERE, '..');
const BASE =
  process.env.FEEDBACK_BASE ||
  path.resolve(REPO, '..', 'ccgui-plugin-github-trending', 'src', 'lib', 'feedback.mjs');
// 无构建插件的纯函数内联在 main.js 里；有构建的插件保留 src/lib/feedback.mjs，
// 用 FEEDBACK_TARGET 指过去即可复用同一份检查。
const TARGET = process.env.FEEDBACK_TARGET
  ? path.resolve(REPO, process.env.FEEDBACK_TARGET)
  : path.join(REPO, 'main.js');

// 按函数名切段：从 `function X(` 或 `const X =` 到下一个同级声明。
// 只在反馈纯函数区间里找，避免把 UI 里的同名局部量算进来。
const NAMES = [
  'TEXT_LIMIT',
  'normaliseFeedbackText',
  'buildIssueUrl',
  'PAYLOAD_FIELDS',
  'buildFeedbackPayload',
  'parseJson',
  'quotaCount',
  'nextQuota',
  'describeFeedbackResult',
  'describeQuota',
];

// 归一化：把 `function parseJson(` 与 `function parseJsonBody(` 当成同一个名字
// （无构建插件里为避免与其它符号冲突改了名），并抹掉引号风格与分号。
function normalize(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/\bparseJson\b/g, 'parseJsonBody')
    .replace(/export\s+/g, '')
    .replace(/;/g, '')
    .replace(/["']/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

// 从一段源码里抓出某个声明的完整文本。
// 允许前导空白：无构建插件的纯函数嵌在 activate() 里，比基准多一层缩进。
function grab(source, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const start = new RegExp(`^[ \\t]*(?:export\\s+)?(?:async\\s+)?(?:function|const|let|var)\\s+${escaped}\\b`, 'm');
  const m = start.exec(source);
  if (!m) return null;
  const begin = m.index;
  // 单行声明（const X = ...;）到行尾；函数体按大括号配平。
  const head = source.slice(begin, begin + 200);
  if (!/\b(function|=>)\b/.test(head.split('\n')[0]) && !head.includes('{')) {
    const nl = source.indexOf('\n', begin);
    return source.slice(begin, nl === -1 ? undefined : nl);
  }
  if (/^(?:export\s+)?(?:async\s+)?function\b/.test(head)) {
    let depth = 0;
    let started = false;
    for (let i = begin; i < source.length; i += 1) {
      const ch = source[i];
      if (ch === '{') {
        depth += 1;
        started = true;
      } else if (ch === '}') {
        depth -= 1;
        if (started && depth === 0) return source.slice(begin, i + 1);
      }
    }
    return null;
  }
  // const + 对象/数组字面量：配平到分号或行尾
  let depth = 0;
  for (let i = begin; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === '{' || ch === '[') depth += 1;
    else if (ch === '}' || ch === ']') depth -= 1;
    else if (ch === ';' && depth === 0) return source.slice(begin, i);
    else if (ch === '\n' && depth === 0) {
      // 继续看下一行，可能是多行的 const（三元/数组）
      const rest = source.slice(i + 1).split('\n')[0];
      if (!/^\s{2, }\S/.test(rest) && !/^\s{2,}/.test(rest)) return source.slice(begin, i);
    }
  }
  return source.slice(begin);
}

// 在目标仓库里找同名库文件。
//
// 不能用 path.dirname(TARGET) 拼：TARGET 是仓库根的 main.js，拼出来的
// REPO/feedback-ui.mjs 永远不存在——几段检查因此静默跳过（markdown 那段
// 没有兜底，直接 continue，改了文件也报 IN_SYNC）。构建型插件的库在
// src/lib/ 下，无构建插件没有独立文件、纯函数内联在 main.js 里。
function findLib(name) {
  const dirs = [path.join(REPO, 'src', 'lib'), path.dirname(TARGET)];
  for (const dir of dirs) {
    const p = path.join(dir, name + '.mjs');
    if (p !== TARGET && fs.existsSync(p)) {
      return { path: p, src: fs.readFileSync(p, 'utf8'), label: path.basename(p) };
    }
  }
  return null;
}

if (!fs.existsSync(BASE)) {
  // 本地缺基准可以跳过；CI 里跳过就等于没检查，所以只认显式声明的环境。
  if (process.env.CI) {
    console.log(`FAIL=找不到基准文件（${BASE}）。CI 里请 checkout github-trending 并设置 FEEDBACK_BASE`);
    process.exit(1);
  }
  console.log(`SKIP=基准文件不存在（${BASE}）`);
  process.exit(0);
}

const baseSrc = fs.readFileSync(BASE, 'utf8');
const targetSrc = fs.readFileSync(TARGET, 'utf8');

const diffs = [];
for (const name of NAMES) {
  // 基准里是 parseJson；无构建插件为了避免与其它符号冲突改叫 parseJsonBody。
  // 有构建的插件直接复用基准文件，名字不变——两种都试，找到哪种用哪种。
  const candidates = name === 'parseJson' ? ['parseJsonBody', 'parseJson'] : [name];
  const a = grab(baseSrc, name);
  let b = null;
  let usedName = candidates[0];
  for (const cand of candidates) {
    b = grab(targetSrc, cand);
    if (b !== null) {
      usedName = cand;
      break;
    }
  }
  if (a === null) {
    diffs.push(`${name}：基准里找不到（基准文件结构变了？）`);
    continue;
  }
  if (b === null) {
    diffs.push(`${name}：${path.basename(TARGET)} 里找不到`);
    continue;
  }
  if (normalize(a) !== normalize(b)) diffs.push(`${name}：${path.basename(TARGET)} 里与基准不一致（${usedName}）`);
}

// 网络层：createFeedbackNet 整段内联，同样必须与基准逐字一致。
// 这段最容易「改一处忘三处」——本次 quotaCount 的 bug 就同时存在于四处，
// 只因为纯函数层被查才一次抓到；网络层此前完全没人拦。
const NET_BASE = path.join(path.dirname(BASE), "feedback-net.mjs");
// 有构建的插件是 src/lib/feedback-net.mjs；无构建插件没有独立文件，退回 main.js。
const netFound = findLib("feedback-net");
const netTarget = netFound || { src: targetSrc, label: path.basename(TARGET) };

if (fs.existsSync(NET_BASE)) {
  const netBase = fs.readFileSync(NET_BASE, "utf8");
  for (const name of ["fbNetTimeout", "fbNetHostVersion", "createFeedbackNet"]) {
    const a = grab(netBase, name);
    const b = grab(netTarget.src, name);
    if (a === null) diffs.push(`${name}：基准 feedback-net.mjs 里找不到`);
    else if (b === null) diffs.push(`${name}：${netTarget.label} 里找不到`);
    else if (normalize(a) !== normalize(b)) diffs.push(`${name}：${netTarget.label} 里与基准 feedback-net.mjs 不一致`);
  }
} else if (process.env.CI) {
  diffs.push("找不到基准 feedback-net.mjs（CI 里请 checkout github-trending 并设置 FEEDBACK_BASE）");
}

// 行为层：useFeedbackForm 整段内联（无构建插件）或整文件复制（有构建插件）。
// 不查这一段就等于给新抽出来的代码开了个口子——里面恰好是最易错的那几处：
// sendingRef 挡双击、成功后只清「这次发出去的那段」、额度不能被 null 读成 0。
const UI_BASE = path.join(path.dirname(BASE), "feedback-ui.mjs");
const uiFound = findLib("feedback-ui");
const uiTarget = uiFound || { src: targetSrc, label: path.basename(TARGET) };

if (fs.existsSync(UI_BASE)) {
  const uiBase = fs.readFileSync(UI_BASE, "utf8");
  for (const name of ["useFeedbackForm"]) {
    const a = grab(uiBase, name);
    const b = grab(uiTarget.src, name);
    if (a === null) diffs.push(`${name}：基准 feedback-ui.mjs 里找不到`);
    else if (b === null) diffs.push(`${name}：${uiTarget.label} 里找不到`);
    else if (normalize(a) !== normalize(b)) diffs.push(`${name}：${uiTarget.label} 里与基准 feedback-ui.mjs 不一致`);
  }
} else if (process.env.CI) {
  diffs.push("找不到基准 feedback-ui.mjs（CI 里请 checkout github-trending 并设置 FEEDBACK_BASE）");
}

// Markdown 解析与渲染：两个构建型插件各有一份 src/lib/markdown*.mjs。
// 无构建插件（slash / cli）不渲染 Markdown，连 src/lib 目录都没有，
// 所以按「目标仓库有没有 src/lib」来判断该不该查——只要它是构建型
// 插件，缺文件就是漂移，不能静默跳过（上一版正是这么漏掉的）。
const hasLibDir = fs.existsSync(path.join(REPO, "src", "lib"));
for (const name of ["markdown", "markdown-view"]) {
  const mdBasePath = path.join(path.dirname(BASE), name + ".mjs");
  if (!fs.existsSync(mdBasePath)) continue;
  if (!hasLibDir) continue;
  const mdTargetPath = path.join(REPO, "src", "lib", name + ".mjs");
  if (!fs.existsSync(mdTargetPath)) {
    diffs.push(`${name}.mjs：src/lib/ 里缺这个文件（构建型插件必须与基准一致）`);
    continue;
  }
  const a = fs.readFileSync(mdBasePath, "utf8");
  const b = fs.readFileSync(mdTargetPath, "utf8");
  if (normalize(a) !== normalize(b)) {
    diffs.push(`${name}.mjs：${path.relative(REPO, mdTargetPath)} 里与基准不一致`);
  }
}

if (diffs.length === 0) {
  console.log('RESULT=FEEDBACK_IN_SYNC');
  process.exit(0);
}

console.log('反馈代码与基准不一致：');
for (const d of diffs) console.log('  - ' + d);
console.log('\n基准：' + path.relative(REPO, BASE) + ' 与 feedback-net.mjs');
console.log(
  '把基准里对应的函数整段复制到 ' +
    path.basename(TARGET) +
    '（构建型插件是 src/lib/feedback.mjs），保持逐字一致（只改缩进与 parseJson 命名）。',
);
process.exit(1);
