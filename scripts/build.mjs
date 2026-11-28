#!/usr/bin/env node
/**
 * 把 src/main.head.js 与 scripts/scan.mjs 拼成可分发的单文件 main.js。
 *
 * 插件以 ESM blob 加载，不能 import 兄弟文件，所以扫描器必须以字符串内联。
 * 纯函数库另走一路：剥掉 export 前缀后拼进同一作用域。
 * 库清单读 plugin.libs.mjs，与 validate-manifest.mjs 是同一份。
 *
 * 骨架在 ccgui-plugin-shared/build-lib 里，六插件共用一份。
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildPlugin } from "ccgui-plugin-shared/build-lib";
import spec from "../plugin.libs.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const { bytes } = buildPlugin({
  root: ROOT,
  libs: spec,
  scripts: [{ marker: "/*__SCAN_SOURCE__*/", file: "scripts/scan.mjs", constName: "SCAN_SOURCE" }],
});
process.stdout.write("main.js " + bytes + " bytes\n");
