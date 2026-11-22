#!/usr/bin/env node
/**
 * 把 src/main.head.js 与 scripts/scan.mjs 拼成可分发的单文件 main.js。
 *
 * 插件以 ESM blob 加载，不能 import 兄弟文件，所以扫描器必须以字符串内联。
 * 用 JSON.stringify 生成字面量，反引号、${} 与反斜杠都不需要额外转义。
 *
 * 纯函数库（src/lib/*.mjs）走另一条路：它们要在单测里直接 import，所以
 * 内联方式是「剥掉 export 前缀后拼进同一作用域」，和 github-trending 一致。
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..");
const MARKER = "/*__SCAN_SOURCE__*/";
const LIB_START = "/*__LIB_SOURCE__*/";
const LIB_END = "/*__LIB_SOURCE_END__*/";
const LIB_ORDER = ["feedback", "feedback-net", "feedback-ui"];

function stripExports(source) {
  // 只动行首的 export 关键字，避免误伤字符串里的 "export"。
  return source.replace(/^export\s+(?=(?:function|const|let|var|class)\s)/gm, "");
}

/**
 * 剥掉「指向兄弟 lib 的 import」。
 *
 * 库文件内联进同一个作用域后，这些 import 语句就成了语法错误。只放行
 * `./name.mjs` 这一种形状：真实的外部依赖仍然要拦，否则会产出一个
 * 宿主加载即失败的 main.js。
 */
function stripLocalImports(source, name) {
  return source.replace(
    /^import\s*\{([^}]*)\}\s*from\s*["']\.\/([A-Za-z0-9_-]+)\.mjs["'];?[ \t]*\n/gm,
    (_all, _names, dep) => {
      if (!LIB_ORDER.includes(dep)) {
        throw new Error(`${name}.mjs 引用了不在 LIB_ORDER 里的库：./${dep}.mjs`);
      }
      return "";
    },
  );
}

const head = fs.readFileSync(path.join(ROOT, "src", "main.head.js"), "utf8");
const scan = fs.readFileSync(path.join(ROOT, "scripts", "scan.mjs"), "utf8");

if (!head.includes(MARKER)) throw new Error("main.head.js 缺少占位符 " + MARKER);

// 先内联纯函数库，再内联扫描器字符串——两者互不干扰，顺序固定便于 diff。
let out = head;
if (out.includes(LIB_START) !== out.includes(LIB_END)) {
  throw new Error(`main.head.js 的内联标记不成对：${LIB_START} / ${LIB_END}`);
}
if (out.includes(LIB_START)) {
  const startAt = out.indexOf(LIB_START);
  const endAt = out.indexOf(LIB_END);
  if (endAt < startAt) throw new Error("内联标记顺序颠倒");
  const chunks = [];
  for (const name of LIB_ORDER) {
    const raw = fs.readFileSync(path.join(ROOT, "src", "lib", name + ".mjs"), "utf8");
    const src = stripLocalImports(raw, name);
    // 兄弟库的 import 上面已经剥掉了；还剩 import 就说明是外部依赖，
    // 内联进单文件产物后宿主加载会直接失败，必须拦在这里。
    if (/^\s*import\s/m.test(src)) throw new Error(`${name}.mjs 含无法内联的 import`);
    if (/\beval\s*\(|\bnew\s+Function\s*\(/.test(src)) throw new Error(`${name}.mjs 含禁用写法`);
    chunks.push("// ---- src/lib/" + name + ".mjs ----\n" + stripExports(src).trim() + "\n");
  }
  out =
    out.slice(0, startAt) +
    "// ---- 以下由 src/lib/*.mjs 内联生成 ----\n" +
    chunks.join("\n") +
    out.slice(endAt + LIB_END.length);
}

// 用函数替换：字符串形式的替换值会把扫描器里的 $&、$' 等当成特殊模式
const spliced = out.replace(MARKER, () => "const SCAN_SOURCE = " + JSON.stringify(scan) + ";");
fs.writeFileSync(path.join(ROOT, "main.js"), spliced, "utf8");

// 自检：内联内容必须与源文件逐字一致（去掉 export 前缀与兄弟 import 之后）。
for (const name of LIB_ORDER) {
  const raw = fs.readFileSync(path.join(ROOT, "src", "lib", name + ".mjs"), "utf8");
  const src = stripExports(stripLocalImports(raw, name)).trim();
  if (!spliced.includes(src)) throw new Error(`内联校验失败：${name}.mjs 与产物不一致`);
}
if (spliced.includes(LIB_START) || spliced.includes(LIB_END)) throw new Error("产物里残留内联标记");

// 顶层重名自检：库文件和 main.head.js 会被拼进同一个作用域，重名不是
// 「后一个覆盖前一个」而是整个模块语法错误（宿主导入即失败）。
const topLevel = /^(?:export\s+)?(?:function|const|let|var|class)\s+([A-Za-z0-9_$]+)/gm;
const seen = new Map();
let m2;
while ((m2 = topLevel.exec(spliced))) {
  const name = m2[1];
  const line = spliced.slice(0, m2.index).split("\n").length;
  if (seen.has(name)) throw new Error(`顶层标识符重名：${name}（第 ${seen.get(name)} 行与第 ${line} 行）`);
  seen.set(name, line);
}

process.stdout.write("main.js " + Buffer.byteLength(spliced) + " bytes\n");
