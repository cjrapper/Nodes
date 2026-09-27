/**
 * 编码检查器自身的测试。
 *
 * <!-- encoding-check:ignore-file —— 本文件必须包含真实的乱码文本 -->
 *
 * ## 为什么一个"检查工具"也需要测试
 *
 * 它有两种失败方式，两种都有害：
 *
 *  - **假通过**：真损坏没报出来 —— 界面上的中文会全变乱码，而工具说没问题。
 *  - **假失败**：正常文件被报错 —— 于是 `npm run verify` 永远失败，
 *    人会养成忽略它的习惯，真损坏也就一起被忽略了。
 *
 * 这个模块的判据**改过好几版**，每版的问题都是靠下面这组用例发现的：
 *
 *  1. 第一版用 `\u4e00-\u9fff` 当"正常中文" —— 而乱码字符本身就落在那个区间里
 *     （`锛 銆 鈥 涓` 全是 U+9xxx / U+6xxx），真损坏永远判不出来。
 *  2. 第二版列"乱码特征字符表" —— 拿真实损坏数据一量，那张表只覆盖了
 *     20 个字里的 2 个。
 *  3. 第三版按"生僻字占比 > 0.2" —— 把 `* 可拖拽分栏。` 这类正常注释判成损坏，
 *     因为常用字表里没有"拖拽栏"。
 *
 * 所以下面的"真实损坏文本"是**从被写坏的文件里原样抄出来的**，不是编的。
 * 改动判据时，这些用例是唯一能告诉你有没有退化的东西。
 *
 * ## 关于文件头的豁免标记
 *
 * 这个文件**必须**包含真实乱码文本（否则没法验证"真损坏能被抓到"），
 * 而那种文本与真损坏在字节层面完全一样。所以加了 `encoding-check:ignore-file`。
 * 这是知情的例外：豁免的是这个文件，不是这条规则。
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  analyzeLine,
  findCorruptedLines,
  isIgnored,
  looksCorrupted,
} from "../src/lib/tools/encoding-check.ts";

/* ------------------------------------------------------------------ *
 * 1. 必须抓到的（假通过不可接受）
 *
 * 下面这些字符串是从真实损坏的文件里抄出来的原文。
 * ------------------------------------------------------------------ */

test("真实损坏的 Markdown 标题（原 `## 1. 为什么缓存命中是核心`）", () => {
  assert.equal(looksCorrupted("## 1. 涓轰粈涔堢紦瀛樺懡涓槸鏍稿績"), true);
});

test("真实损坏的正文（原 `缓存只是一个加分项，我更多的是学习知识`）", () => {
  assert.equal(
    looksCorrupted("缂撳瓨鍙槸涓€涓姞鍒嗛」锛屾垜鏇村鐨勬槸瀛︿範鐭ヨ瘑"),
    true,
  );
});

test("真实损坏的长正文（原 `我更多的是学习知识，需要利用 ai 针对某个知识区查漏补缺`）", () => {
  assert.equal(
    looksCorrupted("鎴戞洿澶氱殑鏄涔犵煡璇嗭紝闇€瑕佸埄鐢?ai 閽堝鏌愪釜鐭ヨ瘑鍖烘煡婕曡ˉ缂恒€"),
    true,
  );
});

test("真实损坏的代码行（原 `const 为什么缓存 = \"是核心的核\";`）", () => {
  assert.equal(
    looksCorrupted('const 涓轰粈涔堢紦瀛 = "涓槸鏍稿績鐨勬牳蹇";'),
    true,
  );
});

test("真实损坏的模板字符串（原 `[nodes] 「${label}」在 ${windowMs}ms 内渲染了`）", () => {
  assert.equal(
    looksCorrupted("`[nodes] 銆?{label}銆嶅湪 ${windowMs}ms 鍐呮覆鏌撲簡 ${limit} 娆?鈥斺€?鏋佸彲鑳芥槸娓叉煋寰幆銆俙"),
    true,
  );
});

test("整行几乎全是生僻字时判为损坏", () => {
  assert.equal(looksCorrupted("銆€銆€銆€銆€銆€"), true);
});

test("中英混排但中文全碎时仍抓到", () => {
  assert.equal(looksCorrupted("return 涓轰粈涔堢紦瀛樺懡涓; // 鎻愪緵缂撳瓨"), true);
});

/* ------------------------------------------------------------------ *
 * 2. 必须放过的（假失败会让检查被忽略）
 * ------------------------------------------------------------------ */

test("正常的代码与注释", () => {
  assert.equal(looksCorrupted("## 1. 为什么缓存命中是核心"), false);
  assert.equal(looksCorrupted("const persona = \"你是知识库助手\";"), false);
  assert.equal(looksCorrupted("export function assembleContext(input: AssembleInput) {"), false);
  assert.equal(looksCorrupted("  // 这是一个普通注释"), false);
});

test("工具的特征字表与此类说明文字", () => {
  // 编码检查器自己的特征表 —— 第一版就是被这些行误报的
  assert.equal(looksCorrupted('  "\\u9518", // 锘'), false);
  assert.equal(
    looksCorrupted("const BAD = [锛, 銆, 鈥]; // 特征字符表，成片出现才算损坏"),
    false,
  );
  assert.equal(
    looksCorrupted("若文件已被按其他编码读过，中文会变成锛銆鈥这类字符。"),
    false,
    "一行里只有两个生僻字，占比也低，不该判成损坏",
  );
});

test("技术文档里合法的生僻字与生僻词", () => {
  assert.equal(looksCorrupted("弩 是一种远程武器，此处仅为测试生僻字。"), false);
  assert.equal(
    looksCorrupted("## 常用字表里没有但确实合法的词：饕餮、貔貅"),
    false,
    "这句话生僻字占比约 0.11，离损坏的 1.0 差一个数量级",
  );
});

test("空行与纯 ASCII", () => {
  assert.equal(looksCorrupted(""), false);
  assert.equal(looksCorrupted("   "), false);
  assert.equal(looksCorrupted("const x = 1; // ok"), false);
});

/* ------------------------------------------------------------------ *
 * 3. 判据的边界（改阈值时这些会告诉你影响面）
 * ------------------------------------------------------------------ */

test("少于 3 个非常用字时放过（MIN_UNCOMMON 的作用）", () => {
  // 只有一两个生僻字，很可能是新词或人名，不足以判定损坏
  assert.equal(looksCorrupted("这里用了弩这个字"), false);
  const verdict = analyzeLine("这里用了弩这个字");
  assert.ok(verdict.uncommonCount < 3, `实际非常用字 ${verdict.uncommonCount}`);
});

test("已知局限：正常中文与乱码混排的行可能漏报", () => {
  /*
   * 判据看的是"非常用字占中文的比例"。如果一行里**一半是正常中文、
   * 一半是乱码**，占比只有 0.45，低于 0.5 的阈值，会被放过。
   *
   * 这个局限是**知情接受**的，理由有两条：
   *
   *  1. 真实的编码损坏是整片发生的 —— 一个文件被错误读写一次，
   *     它里面的中文会**全部**变成乱码。实测的三种真实损坏，
   *     非常用字占比都是 1.000。混合行是"手工修补过一半"的产物，
   *     在真实工作流里不出现。
   *  2. 阈值往低调（试过 0.2）会把"## 常用字表里没有但确实合法的词：
   *     饕餮、貔貅"这类正常行判成损坏，于是 `npm run verify` 永远失败。
   *     **假失败比假通过更危险**：它让人学会忽略这个检查。
   *
   * 所以这条测试固定住当前行为。如果将来真的遇到混合行漏报，
   * 正确的做法是让检查器**按 CJK 连续段**而不是按整行来判断，
   * 而不是简单调低阈值。
   */
  const mixed = "结果全变成 `锛/銆/鈥` 这类乱码。更糟的是";
  const verdict = analyzeLine(mixed);
  assert.ok(verdict.ratio > 0.2 && verdict.ratio < 0.5, `实际占比 ${verdict.ratio.toFixed(3)}`);
  assert.equal(verdict.corrupted, false, "混合行当前会被放过 —— 这是知情的取舍");
});

test("非常用字占比低于阈值时放过", () => {
  const line = "这是一段正常的说明文字，里面夹了弩和饕两个字，其余都是常用字。";
  const verdict = analyzeLine(line);
  assert.ok(
    verdict.ratio <= 0.5,
    `占比 ${verdict.ratio.toFixed(3)} 应低于阈值`,
  );
  assert.equal(verdict.corrupted, false);
});

test("analyzeLine 给出的数字可供人工核对", () => {
  const good = analyzeLine("为什么缓存命中是核心");
  assert.ok(good.cjkCount >= 9);
  assert.ok(good.ratio < 0.2, `正常中文的非常用字占比应当很低，实际 ${good.ratio.toFixed(3)}`);

  const bad = analyzeLine("涓轰粈涔堢紦瀛樺懡涓槸鏍稿績");
  assert.equal(bad.ratio, 1, "损坏文本的每一个中文字都是非常用字");
  assert.equal(bad.corrupted, true);
});

/* ------------------------------------------------------------------ *
 * 4. 按行扫描
 * ------------------------------------------------------------------ */

test("findCorruptedLines 返回正确的行号（1 起）", () => {
  const text = [
    "# 标题",
    "",
    "## 1. 涓轰粈涔堢紦瀛樺懡涓槸鏍稿績",
    "正常的一行中文",
    "return 涓轰粈涔堢紦瀛樺懡涓;",
  ].join("\n");

  assert.deepEqual(findCorruptedLines(text), [3, 5]);
});

test("干净文本返回空数组", () => {
  const text = ["# 标题", "", "正常内容", "const x = 1;"].join("\n");
  assert.deepEqual(findCorruptedLines(text), []);
});

test("损坏文件里夹着特征字表时，只报真正损坏的行", () => {
  // 这是本次会话里 scripts/check-encoding.mjs 的真实形态：
  // 表里有几个生僻字，但那一行本身是正常中文
  const text = [
    '  "\\u9518", // 锘',
    "## 1. 涓轰粈涔堢紦瀛樺懡涓槸鏍稿績",
    "正常的一行",
  ].join("\n");

  assert.deepEqual(findCorruptedLines(text), [2]);
});

test("行号在含 CRLF 的文本里仍然正确", () => {
  const text = "正常\r\n## 1. 涓轰粈涔堢紦瀛樺懡涓槸鏍稿績\r\n正常";
  // split("\n") 之后第一行末尾会带 \r，但行号计算不受影响
  assert.deepEqual(findCorruptedLines(text), [2]);
});

/* ------------------------------------------------------------------ *
 * 5. 文件级豁免
 *
 * 有些文件**必须**包含真实乱码文本（最典型的就是本文件：要验证
 * "真损坏能被抓到"，就得把真实的错误编码结果写进用例）。
 * 那种文本与真损坏在字节层面完全一样，只能靠显式标记区分。
 * ------------------------------------------------------------------ */

test("带豁免标记的文件被整体跳过", () => {
  const text = [
    "// encoding-check:ignore-file —— 必须有乱码示例",
    "## 1. 涓轰粈涔堢紦瀛樺懡涓槸鏍稿績",
    "缂撳瓨鍙槸涓€涓姞鍒嗛」锛屾垜鏇村鐨勬槸瀛︿範鐭ヨ瘑",
  ].join("\n");

  assert.deepEqual(findCorruptedLines(text), [], "豁免文件不该报任何行");
  assert.equal(isIgnored(text), true);
});

test("豁免是**文件级**的，不会波及其他文件", () => {
  // 同一个目录里，有豁免的与没豁免的互不影响
  const ignored = "<!-- encoding-check:ignore-file -->\n涓轰粈涔堢紦瀛樺懡涓槸鏍稿績";
  const notIgnored = "## 1. 涓轰粈涔堢紦瀛樺懡涓槸鏍稿績";

  assert.deepEqual(findCorruptedLines(ignored), []);
  assert.deepEqual(findCorruptedLines(notIgnored), [1], "没标记的文件照常报");
});

test("没有豁免标记时不会被误判为豁免", () => {
  // 只是恰好提到了这个词（例如文档在解释这条规则）
  const text = "规则说明：豁免标记是 `encoding-check-ignore`，注意它必须写在文件里。";
  assert.equal(isIgnored(text), false, "只有精确标记才算豁免");
});

test("豁免标记本身必须在文件里出现，不能靠环境变量之类的隐式开关", () => {
  // 这是刻意的设计约束：豁免必须是**写在文件里、能被人看见**的
  const withoutMarker = "## 1. 涓轰粈涔堢紦瀛樺懡涓槸鏍稿績";
  assert.equal(isIgnored(withoutMarker), false);
  assert.deepEqual(findCorruptedLines(withoutMarker), [1]);
});
