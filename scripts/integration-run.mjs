/**
 * 集成测试运行器。
 *
 * 为什么要单独一个脚本：集成测试要跑**真实的 SQLite**，而
 * `getDb()` 用 `process.cwd()` 定位 `.data/nodes.db` 与 `schema.sql`。
 * 如果直接在仓库根目录跑，它会往开发用的真实数据库里写测试数据。
 *
 * 做法：把 cwd 切到一个临时目录，再把 `src/` 与 `tests/` 复制过去，
 * 这样 schema.sql 找得到、数据落在临时目录、仓库的 .data 完全不受影响。
 * 跑完删掉临时目录（除非 KEEP=1）。
 */

import { cpSync, existsSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const keep = process.env.KEEP === "1";
const tmp = mkdtempSync(path.join(os.tmpdir(), "nodes-itest-"));

try {
  // 只复制必需的目录：src 里有 schema.sql，tests 里有测试与解析钩子，
  // package.json 用于环境守卫校验。
  cpSync(path.join(repoRoot, "src"), path.join(tmp, "src"), { recursive: true });
  cpSync(path.join(repoRoot, "tests"), path.join(tmp, "tests"), { recursive: true });
  cpSync(path.join(repoRoot, "package.json"), path.join(tmp, "package.json"));

  /*
   * node_modules 用目录联接（junction）而不是复制：它有好几百 MB，
   * 复制一次要几十秒。Windows 上 junction 不需要管理员权限，正好。
   * 如果联接失败（权限或跨盘），退回复制。
   */
  const nodeModulesSrc = path.join(repoRoot, "node_modules");
  const nodeModulesDst = path.join(tmp, "node_modules");
  if (existsSync(nodeModulesSrc)) {
    try {
      symlinkSync(nodeModulesSrc, nodeModulesDst, "junction");
    } catch (err) {
      console.warn(
        `[integration] 无法联接 node_modules（${err instanceof Error ? err.message : err}），改为复制…`,
      );
      cpSync(nodeModulesSrc, nodeModulesDst, { recursive: true });
    }
  }

  console.log(`[integration] 临时工作目录：${tmp}`);

  const result = spawnSync(
    process.execPath,
    [
      "--experimental-strip-types",
      "--import",
      "./tests/ts-resolve.mjs",
      "--disable-warning=MODULE_TYPELESS_PACKAGE_JSON",
      "--disable-warning=ExperimentalWarning",
      // 只传一个入口文件：node 会把多余的位置参数当成 argv 而不是"再跑一个脚本"
      "tests/integration/run.mjs",
    ],
    { cwd: tmp, stdio: "inherit" },
  );

  if (result.error) {
    console.error("[integration] 启动失败：", result.error.message);
  }
  process.exitCode = result.status ?? 1;
} finally {
  if (keep) {
    console.log(`[integration] 已保留临时目录（KEEP=1）：${tmp}`);
  } else if (existsSync(tmp)) {
    rmSync(tmp, { recursive: true, force: true });
  }
}
