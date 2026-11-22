#!/usr/bin/env node
// 工作志的插件自检。
// 通用规则（manifest 形状、权限白名单、产物黑名单、权限↔用法一致性、展示素材、
// 版本一致）在 ccgui-plugin-shared/validate-core 里，四插件共用一份；这里只放
// 本插件特有的检查。
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { validatePlugin } from "ccgui-plugin-shared/validate-core";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);

// 构建时要从包里读的入口。缺任何一个，build.mjs 都会失败，但那要等到
// 跑构建才知道；这里先报出来，让 npm run validate 单独也能发现。
const SHARED_ENTRIES = ["feedback", "feedback-net", "feedback-ui", "markdown", "markdown-view"];

// 本插件独有的子进程脚本：它不参与 bundle 自检，只能在这里确认存在。
const SCAN = ["scan.mjs"];

const result = validatePlugin({
  root: ROOT,
  extraRules({ fail }) {
    for (const name of SHARED_ENTRIES) {
      try {
        require.resolve("ccgui-plugin-shared/" + name);
      } catch {
        fail(`读不到共用库 ccgui-plugin-shared/${name}：先跑 npm install`);
      }
    }
    for (const name of SCAN) {
      if (!fs.existsSync(path.join(ROOT, "scripts", name))) fail(`缺少 scripts/${name}`);
    }
  },
});

process.exit(result.code);
