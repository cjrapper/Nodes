/**
 * 一次性 codemod：把硬编码的"文字层级色"换成 CSS 变量引用。
 *
 * ## 为什么需要一个脚本
 *
 * 文字层级色（主文字 / 次要 / 弱化）在源码里硬编码了 287 处。要让用户能调整
 * 它们，每一处都得改成 `text-[var(--nodes-ink)]` 这种写法。
 * 手工改 287 处既慢又必然出错，而且改完无法核对"到底改了几处"。
 *
 * ## 为什么是安全的
 *
 * 只替换三个**精确的类名字符串**：
 *
 *   `text-[#e6e9ee]` → `text-[var(--nodes-ink)]`
 *   `text-[#98a2b3]` → `text-[var(--nodes-ink-dim)]`
 *   `text-[#6b7280]` → `text-[var(--nodes-ink-faint)]`
 *
 * 带 `text-[...]` 前缀是刻意的：色值本身还出现在 `border-[#23282f]`、
 * `bg-[#12151a]`、`style={{ color: "#..." }}` 等地方，那些不属于"文字层级"，
 * 不该被这个脚本碰。用完整的类名字符串做匹配，既精确又可核对。
 *
 * 语义色（强调 `#3ddc97`、警告 `#f5b544`、危险 `#f2555a`、信息 `#6aa8ff`）
 * **刻意不动** —— 它们是语义，不是用户偏好。用户改"强调色"是另一个控件的事。
 *
 * ## 用法
 *
 *   node scripts/retheme-ink.mjs --dry     # 只报告，不写
 *   node scripts/retheme-ink.mjs           # 实际写入
 *
 * 跑完必须 `npm run typecheck && npm test`，并肉眼抽查两个组件文件。
 */

import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

const MAP = [
  ["text-[#e6e9ee]", "text-[var(--nodes-ink)]"],
  ["text-[#98a2b3]", "text-[var(--nodes-ink-dim)]"],
  ["text-[#6b7280]", "text-[var(--nodes-ink-faint)]"],
];

const SKIP_DIRS = new Set(["node_modules", ".next", ".data", ".npm-cache", ".git", "scripts"]);

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const full = path.join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(name)) out.push(full);
  }
  return out;
}

const dryRun = process.argv.includes("--dry");
const files = walk("src");

let filesChanged = 0;
let totalReplacements = 0;
const perFile = [];

for (const file of files) {
  const original = readFileSync(file, "utf8");
  let next = original;
  let count = 0;

  for (const [from, to] of MAP) {
    // split/join 而不是 replaceAll + 正则：类名里的 `[` `]` `#` 都是正则元字符，
    // 转义容易漏；这里要的是**字面量**替换，split/join 最直白也最安全。
    const parts = next.split(from);
    count += parts.length - 1;
    next = parts.join(to);
  }

  if (count > 0) {
    filesChanged += 1;
    totalReplacements += count;
    perFile.push([file, count]);
    if (!dryRun) writeFileSync(file, next, "utf8");
  }
}

perFile.sort((a, b) => b[1] - a[1]);
console.log(`${dryRun ? "[dry] " : ""}改动文件 ${filesChanged} 个，替换 ${totalReplacements} 处`);
for (const [file, count] of perFile) {
  console.log(`  ${String(count).padStart(3)}  ${file}`);
}
if (dryRun) console.log("\n（未写入。去掉 --dry 才会实际修改）");
