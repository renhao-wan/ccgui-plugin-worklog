#!/usr/bin/env node
/**
 * 把 src/main.head.js 与 scripts/scan.mjs 拼成可分发的单文件 main.js。
 *
 * 插件以 ESM blob 加载，不能 import 兄弟文件，所以扫描器必须以字符串内联。
 * 用 JSON.stringify 生成字面量，反引号、${} 与反斜杠都不需要额外转义。
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..");
const MARKER = "/*__SCAN_SOURCE__*/";

const head = fs.readFileSync(path.join(ROOT, "src", "main.head.js"), "utf8");
const scan = fs.readFileSync(path.join(ROOT, "scripts", "scan.mjs"), "utf8");

if (!head.includes(MARKER)) throw new Error("main.head.js 缺少占位符 " + MARKER);

// 用函数替换：字符串形式的替换值会把扫描器里的 $&、$' 等当成特殊模式
const out = head.replace(MARKER, () => "const SCAN_SOURCE = " + JSON.stringify(scan) + ";");
fs.writeFileSync(path.join(ROOT, "main.js"), out, "utf8");

process.stdout.write("main.js " + Buffer.byteLength(out) + " bytes\n");
