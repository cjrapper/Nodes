/**
 * 集成测试入口。
 *
 * 为什么需要这个文件：`node a.ts b.ts` 只会执行 a.ts，后面的位置参数会被
 * 当成 process.argv 而不是"再来一个脚本"。所以在同一个进程里显式 import
 * 所有集成测试文件，node:test 会在 import 时注册并执行它们。
 *
 * ⚠️ 这些测试会读写**当前工作目录下**的 .data/nodes.db，
 * 必须通过 `npm run test:integration` 运行（它会把工作目录切到临时目录）。
 */

import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

const FILES = [
  "pipeline.test.ts",
  "providers.test.ts",
  "errors.test.ts",
  "empty-reply.test.ts",
  "persona-fixed.test.ts",
  "migration.test.ts",
  "coverage.test.ts",
  "assets.test.ts",
  "soft-delete.test.ts",
  "tools.test.ts",
  "tool-loop.test.ts",
  "undo.test.ts",
];

for (const file of FILES) {
  await import(pathToFileURL(path.join(here, file)).href);
}
