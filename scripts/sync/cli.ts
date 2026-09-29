/**
 * 知识库同步的 CLI 入口（薄壳）。
 *
 * 逻辑全在 `src/lib/sync/knowledge-sync.ts` —— 放那边是为了让**测试能 import
 * 纯函数**（入口写在这里、逻辑写在那里，import 逻辑不会顺带执行 CLI）。
 */

import path from "node:path";

import { doExport, doImport, OUT_DEFAULT } from "@/lib/sync/knowledge-sync";

/* ------------------------------------------------------------------ *
 * 入口
 * ------------------------------------------------------------------ */

const [, , command, ...rest] = process.argv;
const apply = rest.includes("--apply");
const dirArg = rest.find((a) => !a.startsWith("--"));
const outDir = path.resolve(dirArg ?? OUT_DEFAULT);

if (command === "export") {
  doExport(outDir);
} else if (command === "import") {
  doImport(outDir, apply);
} else {
  console.error(`未知命令：${command ?? "(空)"}。用 export 或 import。`);
  process.exitCode = 1;
}
