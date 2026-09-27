/**
 * 一次性修复脚本：把被 PowerShell 5.1 错误编码转坏的 UTF-8 中文还原回来。
 *
 * 成因：PS 5.1 的 `Get-Content -Raw` 默认用系统 ANSI 代码页（中文 Windows 是
 * GBK）解码文件字节，`Set-Content -Encoding utf8` 再把得到的字符串按 UTF-8
 * 写回。原本正确的 UTF-8 字节就这样被"GBK 解码 → UTF-8 编码"了一轮。
 *
 * 还原就是反向操作：把文件按 UTF-8 读成字符串，拿它的**字符码点**当字节
 * 序列（即 GBK 解码的结果），再用 GBK 解码一次得到原始字节，最后按 UTF-8 读。
 *
 * ⚠️ 这个还原**只在原始字节全部能映射到 GBK 时无损**。若原文里含有 GBK
 * 无法表示的字符，PS 当时会写入 '?' 或替换字符，那部分信息已经永久丢失，
 * 还原只能尽力而为 —— 脚本会报告可疑字符让人工判断。
 */

import { readFileSync, writeFileSync } from "node:fs";

const [, , filePath, mode = "check"] = process.argv;
if (!filePath) {
  console.error("用法: node scripts/fix-encoding.mjs <file> [check|fix]");
  process.exit(1);
}

/** 特征：UTF-8 被按 GBK 解码后，中文常落在这些区间（"锛/銆/鈥/涓"等） */
const MOJIBAKE = /[\u9518\u9286\u9225\u9544\u9428\u6d93\u9566\u93a7\u9422\u93c9\u93b4]/;

const raw = readFileSync(filePath, "utf8");
if (!MOJIBAKE.test(raw)) {
  console.log("文件没有乱码特征，无需处理。");
  process.exit(0);
}

/*
 * 关键的一步：把字符串的每个码点当成一个字节（≤0xFF），
 * 得到"GBK 解码后的字节序列"。
 */
const bytes = [];
let lossy = 0;
for (const ch of raw) {
  const cp = ch.codePointAt(0);
  if (cp <= 0xff) {
    bytes.push(cp);
  } else {
    // 码点超出单字节 —— 说明这一步不是纯粹的反向操作，记下来
    lossy += 1;
    bytes.push(0x3f); // '?'
  }
}

let recovered;
try {
  recovered = new TextDecoder("gbk", { fatal: false }).decode(Uint8Array.from(bytes));
} catch (err) {
  console.error("GBK 解码失败：", err instanceof Error ? err.message : err);
  process.exit(1);
}

const stillBad = MOJIBAKE.test(recovered);
console.log(`码点超出单字节的字符数：${lossy}`);
console.log(`还原后是否仍有乱码特征：${stillBad ? "是（可能有损）" : "否"}`);
console.log("--- 还原后前 3 行 ---");
console.log(recovered.split("\n").slice(0, 3).join("\n"));

if (mode === "fix") {
  if (stillBad) {
    console.error("\n还原后仍检测到乱码，拒绝写回以免造成二次损坏。");
    process.exit(1);
  }
  writeFileSync(filePath, recovered, "utf8");
  console.log(`\n已写回：${filePath}`);
}
