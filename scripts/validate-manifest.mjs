#!/usr/bin/env node
// 工作志的插件自检。
// 通用规则（manifest 形状、权限白名单、产物黑名单、权限↔用法一致性、展示素材、
// 版本一致）在 scripts/validate-core.mjs 里，四插件共用一份；这里只放本插件
// 特有的检查，所以新增插件时不必再整段复制 validate 脚本。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { validatePlugin } from "./validate-core.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// 工作志独有的纯函数库与子进程脚本：它们不参与 bundle 自检，只能在这里确认存在。
const LIB = ["feedback", "feedback-net"];
const SCAN = ["scan.mjs"];

const result = validatePlugin({
  root: ROOT,
  extraRules({ fail }) {
    for (const name of LIB) {
      if (!fs.existsSync(path.join(ROOT, "src", "lib", name + ".mjs"))) fail(`缺少 src/lib/${name}.mjs`);
    }
    for (const name of SCAN) {
      if (!fs.existsSync(path.join(ROOT, "scripts", name))) fail(`缺少 scripts/${name}`);
    }
  },
});

process.exit(result.code);
