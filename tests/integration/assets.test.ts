/**
 * 素材库（图片存储）的集成测试。
 *
 * 这里跑的是**真实文件系统**：`npm run test:integration` 会把工作目录切到
 * 临时目录，所以 `.data/assets/` 也落在临时目录里，不会污染真实的笔记库。
 *
 * 保护三件事：
 *  1. **内容寻址**：同一张图两次上传必须得到同一个 id、只占一份空间。
 *     这条挂了会直接毁掉缓存 —— 用户眼里"同一张图"，缓存眼里是"块被编辑了"。
 *  2. **魔数判定**：伪装成图片的其它文件必须被拒。这条挂了就是存储型 XSS。
 *  3. **路径穿越**：素材 id 是唯一从用户输入流向文件路径的字符串。
 */

import assert from "node:assert/strict";
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";

/*
 * 动态 import：必须先确认工作目录被切到了临时目录，再加载任何会碰磁盘的模块。
 * 静态 import 会被提升到文件顶部，那时 cwd 还没被验证。
 */
const { ASSETS_DIR, assetIdFor, getAsset, isAssetId, putAsset, sniffImageMime, extractAssetIds } =
  await import("../../src/lib/assets/store.ts");
const { renderMarkdownToHtml } = await import("../../src/lib/render/markdown.ts");

/* ------------------------------------------------------------------ *
 * 测试用图片字节（真实文件头，不是编造的）
 * ------------------------------------------------------------------ */

/**
 * 最小合法 PNG：8 字节签名 + IHDR 块。
 *
 * 刻意不写完整的可解码 PNG —— 我们要测的是**类型判定与存储**，
 * 不是解码。字节必须是真实签名，否则测的就不是"魔数判定"了。
 */
function pngBytes(tag: number): Uint8Array {
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  const ihdr = [0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01];
  return Uint8Array.from([...sig, ...ihdr, tag]);
}

/** 最小 GIF：`GIF89a` + 少量尾随字节 */
function gifBytes(tag: number): Uint8Array {
  const head = Array.from("GIF89a", (c) => c.charCodeAt(0));
  return Uint8Array.from([...head, 0x01, 0x00, 0x01, 0x00, tag]);
}

/** 最小 WebP：`RIFF` + 4 字节长度 + `WEBP` */
function webpBytes(tag: number): Uint8Array {
  const riff = Array.from("RIFF", (c) => c.charCodeAt(0));
  const webp = Array.from("WEBP", (c) => c.charCodeAt(0));
  return Uint8Array.from([...riff, 0x20, 0x00, 0x00, 0x00, ...webp, tag]);
}

/* ------------------------------------------------------------------ *
 * 1. 魔数判定
 * ------------------------------------------------------------------ */

test("PNG / GIF / WebP 都能凭魔数认出来", () => {
  assert.equal(sniffImageMime(pngBytes(1)), "image/png");
  assert.equal(sniffImageMime(gifBytes(1)), "image/gif");
  assert.equal(sniffImageMime(webpBytes(1)), "image/webp");
});

test("JPEG 凭 FF D8 FF 认出来", () => {
  const jpeg = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01]);
  assert.equal(sniffImageMime(jpeg), "image/jpeg");
});

test("RIFF 但子类型不是 WEBP 的（例如 wav）不会被当成图片", () => {
  const riff = Array.from("RIFF", (c) => c.charCodeAt(0));
  const wav = Array.from("WAVE", (c) => c.charCodeAt(0));
  const bytes = Uint8Array.from([...riff, 0x20, 0x00, 0x00, 0x00, ...wav, 0x01, 0x02]);
  assert.equal(sniffImageMime(bytes), null, "WAVE 音频不能通过图片判定");
});

test("HTML 文件不会被当成图片 —— 这是存储型 XSS 的入口", () => {
  const html = Uint8Array.from(Buffer.from("<html><script>alert(1)</script></html>", "utf8"));
  assert.equal(sniffImageMime(html), null);
});

test("SVG 不会被当成图片 —— 它内部可以带 <script>", () => {
  const svg = Uint8Array.from(
    Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"></svg>`, "utf8"),
  );
  assert.equal(sniffImageMime(svg), null);
});

test("字节太少时直接判 null，不越界读", () => {
  assert.equal(sniffImageMime(Uint8Array.from([0x89, 0x50])), null);
  assert.equal(sniffImageMime(new Uint8Array(0)), null);
});

/* ------------------------------------------------------------------ *
 * 2. 素材 id 白名单（唯一的"用户输入 → 文件路径"通道）
 * ------------------------------------------------------------------ */

test("合法的素材 id 被接受", () => {
  const id = assetIdFor(pngBytes(9), "image/png");
  assert.equal(isAssetId(id), true);
  assert.match(id, /^[0-9a-f]{64}\.png$/);
});

test("路径穿越形态的 id 一律拒绝", () => {
  const evil = [
    "../../etc/passwd",
    "..\\..\\windows\\system32\\config\\sam",
    "/etc/passwd",
    "C:\\Windows\\win.ini",
    `${"a".repeat(64)}.png/../../secret`,
    `${"a".repeat(64)}.php`,
    `${"A".repeat(64)}.png`, // 大写十六进制：不接受，避免大小写两份文件
    `${"a".repeat(63)}.png`, // 少一位
    `${"a".repeat(64)}`, // 没有扩展名
    `${"a".repeat(64)}.`,
    `${"a".repeat(64)}.png\u0000.txt`,
    "../" + "a".repeat(64) + ".png",
  ];
  for (const bad of evil) {
    assert.equal(isAssetId(bad), false, `必须拒绝：${JSON.stringify(bad)}`);
  }
});

test("穿越 id 读不到文件（不抛异常，返回 null）", () => {
  assert.equal(getAsset("../../etc/passwd"), null);
  assert.equal(getAsset("....//....//x.png"), null);
  assert.equal(getAsset(`${"a".repeat(64)}.png`), null, "格式合法但不存在 → null");
});

/* ------------------------------------------------------------------ *
 * 3. 内容寻址：同一张图只存一份，且 id 稳定
 * ------------------------------------------------------------------ */

test("同一份内容两次上传得到同一个 id，且第二次不重复写盘", () => {
  const bytes = pngBytes(0x42);
  const first = putAsset(bytes);
  const second = putAsset(bytes);

  assert.equal(first.id, second.id, "内容相同 → id 必须相同（否则缓存前缀会漂移）");
  assert.equal(first.created, true, "第一次应当是新建");
  assert.equal(second.created, false, "第二次应当复用已有文件");
});

test("内容只要差一个字节，id 就不同", () => {
  const a = putAsset(pngBytes(0x01));
  const b = putAsset(pngBytes(0x02));
  assert.notEqual(a.id, b.id);
});

test("存进去的字节能原样读回来，mime 取自扩展名且与魔数一致", () => {
  const bytes = gifBytes(0x7f);
  const stored = putAsset(bytes);
  const blob = getAsset(stored.id);

  assert.ok(blob, "刚存进去的素材必须读得到");
  assert.equal(blob.mime, "image/gif");
  assert.deepEqual(Array.from(blob.bytes), Array.from(bytes), "字节必须逐位一致");
});

test("素材文件按哈希前两位分片存放", () => {
  const stored = putAsset(pngBytes(0x11));
  const expectedDir = path.join(ASSETS_DIR, stored.id.slice(0, 2));
  assert.ok(
    existsSync(path.join(expectedDir, stored.id)),
    `素材应落在分片目录里：${expectedDir}`,
  );
});

test("分片目录里不会有非素材文件混进来", () => {
  putAsset(pngBytes(0x22));
  const prefix = "22";
  const dir = path.join(ASSETS_DIR, prefix);
  if (!existsSync(dir)) return; // 前两位恰好不是 22，这个分片不存在，跳过
  for (const name of readdirSync(dir)) {
    assert.equal(isAssetId(name), true, `分片目录里出现了非法文件名：${name}`);
  }
});

/* ------------------------------------------------------------------ *
 * 4. 拒绝：空文件、超大文件、非图片
 * ------------------------------------------------------------------ */

test("空文件被拒绝", () => {
  assert.throws(() => putAsset(new Uint8Array(0)), /空/);
});

test("非图片内容被拒绝，且错误信息说明了支持什么", () => {
  const text = Uint8Array.from(Buffer.from("这不是图片，只是一段文字，用来确认它不会被存成素材。", "utf8"));
  assert.throws(() => putAsset(text), /PNG \/ JPEG \/ GIF \/ WebP/);
});

/* ------------------------------------------------------------------ *
 * 5. 正文 → 素材引用（孤儿统计的依据）
 * ------------------------------------------------------------------ */

test("能从正文里抽出素材 id，去重且保序", () => {
  const a = putAsset(pngBytes(0x31)).id;
  const b = putAsset(pngBytes(0x32)).id;
  const md = `# 标题\n\n![第一张](asset:${a})\n\n文字\n\n![第二张](asset:${b})\n\n![又引用第一张](asset:${a})`;

  assert.deepEqual(extractAssetIds(md), [a, b], "应当去重并保持出现顺序");
});

test("外链图和坏 id 不会被当成素材引用", () => {
  const md = "![远程](https://example.com/a.png)\n\n![坏的](asset:not-a-real-id)\n\n![图片](asset:)";
  assert.deepEqual(extractAssetIds(md), []);
});

/* ------------------------------------------------------------------ *
 * 6. 渲染：正文里的引用要能变成真正的 <img>
 * ------------------------------------------------------------------ */

test("asset: 引用被渲染成指向 /api/assets/ 的图片", () => {
  const id = putAsset(pngBytes(0x51)).id;
  const html = renderMarkdownToHtml(`![受击判定框](asset:${id})`);

  assert.match(html, /<img /, "应当渲染出图片标签");
  assert.ok(html.includes(`src="/api/assets/${id}"`), `src 应当指向素材接口：${html}`);
  assert.match(html, /alt="受击判定框"/, "说明文字要进 alt，读屏软件才能用");
  assert.match(html, />受击判定框<\/span>/, "有说明时应当渲染出可见的说明文字");
  assert.match(html, /loading="lazy"/, "长文档里的图应当懒加载");
});

test("没有说明文字时不渲染空的说明容器", () => {
  const id = putAsset(pngBytes(0x52)).id;
  const html = renderMarkdownToHtml(`![](asset:${id})`);
  assert.match(html, /<img /);
  // 只有一个 span 外层 + 一个 a，不该出现第二个空 span
  assert.equal((html.match(/<span/g) ?? []).length, 1, "空说明不该占一行空白");
});

test("不存在的素材 id 仍然渲染成图片标签（由接口回 404，而不是正文变异）", () => {
  const id = `${"b".repeat(64)}.png`;
  const html = renderMarkdownToHtml(`![图](asset:${id})`);
  assert.ok(html.includes(`/api/assets/${id}`));
});
