/**
 * 单元测试入口。
 *
 * 刻意不用 `node --test`：那个模式会为每个测试文件 spawn 一个子进程，
 * 在受限环境（如本机沙箱）下 spawn 管道会直接 EPERM 失败。
 * 改为在同一个进程内动态 import 测试文件 —— node:test 会在 import 时
 * 注册并执行测试，失败时自动把退出码置为非零。
 *
 * 不含集成测试（那些需要真实 SQLite 与隔离的工作目录），
 * 见 `npm run test:integration`。
 */

import { readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

// 1) tests/ 下的纯逻辑测试（.test.ts）
const unitFiles = readdirSync(here)
  .filter((f) => f.endsWith(".test.ts"))
  .sort();

/*
 * 2) tests/ui/ 下的组件测试（.test.tsx）
 *
 * 这些用 react-test-renderer 真的把组件渲染起来，能抓到类型检查和纯函数
 * 测试都抓不到的渲染循环。之前有过一次真实事故（内联回调被当成 effect
 * 依赖 → 文档列表疯狂闪烁 + 请求刷屏），所以单独留了这一层。
 */
const uiDir = path.join(here, "ui");
const uiFiles = readdirSync(uiDir)
  .filter((f) => f.endsWith(".test.tsx"))
  .sort()
  .map((f) => path.join("ui", f));

const files = [...unitFiles, ...uiFiles];

if (files.length === 0) {
  console.error("没有找到任何测试文件");
  process.exit(1);
}

for (const file of files) {
  await import(pathToFileURL(path.join(here, file)).href);
}
