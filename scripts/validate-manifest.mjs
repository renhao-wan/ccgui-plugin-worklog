#!/usr/bin/env node
// 工作志的插件自检。
// 通用规则在 ccgui-plugin-shared/validate-core 里，六插件共用一份。
// 库清单读 plugin.libs.mjs，与 build.mjs 是同一份。
import { runValidateCli } from "ccgui-plugin-shared/validate-core";

runValidateCli(import.meta.url, {
  libSpec: "plugin.libs.mjs",
  // 本插件独有的子进程脚本：它不参与 bundle 自检，只能在这里确认存在。
  required: ["scripts/scan.mjs"],
}).then((r) => process.exit(r.code));
