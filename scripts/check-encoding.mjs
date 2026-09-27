/**
 * 检查源文件里有没有被错误编码写坏的中文。
 *
 * 判定逻辑在 `src/lib/tools/encoding-check.ts`（纯函数、有测试）。
 * 本文件只是 CLI 外壳：遍历文件、打印结果、设置退出码。
 *
 * ## 背景
 *
 * 在 PowerShell 5.1 里用 `Get-Content -Raw` 读、`Set-Content -Encoding utf8` 写，
 * 中文字符会走一轮"GBK 解码 → UTF-8 编码"，变成 `锛/銆/鈥` 这类乱码。
 * 这种损坏 `tsc` 不一定报错（它只是字符串常量），甚至可能把换行吞掉、
 * 让代码行与注释行连成一行，所以必须有工具能扫出来。
 *
 * 用法：
 *   node scripts/check-encoding.mjs [目录]      # 默认当前目录
 *   npm run check:encoding                      # 只扫 src
 *
 * 退出码非 0 表示发现问题（已接进 `npm run verify`）。
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

import { findCorruptedLines } from "../src/lib/tools/encoding-check.ts";

const SKIP_DIRS = new Set(["node_modules", ".next", ".data", ".npm-cache", ".git"]);

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const full = path.join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, out);
    else if (/\.(ts|tsx|mjs|css|md|json|sql)$/.test(name)) out.push(full);
  }
  return out;
}

const root = process.argv[2] ?? ".";
const files = walk(root);
let totalBad = 0;

for (const file of files) {
  const bad = findCorruptedLines(readFileSync(file, "utf8"));
  if (bad.length > 0) {
    totalBad += bad.length;
    console.log(
      `${file}: ${bad.length} 行疑似乱码 -> ${bad.slice(0, 12).join(", ")}${bad.length > 12 ? " …" : ""}`,
    );
  }
}

if (totalBad === 0) {
  console.log(`没有发现乱码。（已扫描 ${files.length} 个文件）`);
  process.exit(0);
}

console.log(`\n合计 ${totalBad} 行疑似乱码。`);
console.log("修复方式见 AGENTS.md 的 R1；判断某文件能否无损还原：");
console.log("  node scripts/fix-encoding.mjs <文件> check");
process.exit(1);
