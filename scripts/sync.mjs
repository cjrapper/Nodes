/**
 * 知识库同步 CLI —— 把文档导出成 Markdown，或把 Markdown 合并回库。
 *
 * ## 为什么需要它
 *
 * 在两台机器之间同步这个知识库，**不能直接同步 `.data/nodes.db`**。
 * SQLite 是 db + wal + shm 三个文件协同工作的：网盘同步会把它们拆开传、
 * 或者在写入中途复制，结果是数据库不一致 —— 而且**不会立刻报错**，
 * 你可能几天后才发现某些文档变成了旧版本，那时已经分不清哪个是对的。
 *
 * 所以走"传文本、不传库"的路线：
 *
 *     工作电脑                          宿舍电脑
 *     nodes.db                          nodes.db
 *        │ export                          ▲ import
 *        ▼                                 │
 *     knowledge/*.md ──► git push ──► git pull
 *
 * Markdown 是纯文本，git 能逐行 diff，冲突能看出是哪一段；
 * 数据库各自独立，永远不会互相破坏。
 *
 * ## 用法
 *
 *     node scripts/sync.mjs export [目录]      # 默认 knowledge/
 *     node scripts/sync.mjs import [目录]      # 默认只报告，不写库
 *     node scripts/sync.mjs import [目录] --apply
 *
 * import 默认是 **dry-run**：先看清会改什么、有没有冲突，再决定加 `--apply`。
 *
 * 详细设计见 `knowledge/README.md`（首次导出时自动生成）。
 */

import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);

if (args.length === 0 || args[0] === "--help" || args[0] === "-h") {
  console.log(`
知识库同步工具

  node scripts/sync.mjs export [目录]              导出为 Markdown（默认 knowledge/）
  node scripts/sync.mjs import [目录]              合并回库（**只报告，不写库**）
  node scripts/sync.mjs import [目录] --apply      真正写入

流程（两台机器之间）：

  改完知识库 → npm run sync:export → git add knowledge && git commit && git push
  换机器     → git pull → npm run sync:import   → 看清报告 → 加 --apply 执行
`);
  process.exit(0);
}

const result = spawnSync(
  process.execPath,
  [
    "--experimental-strip-types",
    "--import",
    "./tests/ts-resolve.mjs",
    "--disable-warning=MODULE_TYPELESS_PACKAGE_JSON",
    "--disable-warning=ExperimentalWarning",
    "scripts/sync/cli.ts",
    ...args,
  ],
  { cwd: repoRoot, stdio: "inherit" },
);

if (result.error) {
  console.error("[sync] 启动失败：", result.error.message);
}
process.exitCode = result.status ?? 1;
