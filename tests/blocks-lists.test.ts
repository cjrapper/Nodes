/**
 * 块切分的边界用例。
 *
 * ## 为什么单独测这个
 *
 * `parseMarkdown` 决定"什么是一个知识块"，而块是**引用、缓存、AI 上下文**
 * 三件事的最小单位。切得太粗或太细都会立刻影响使用：
 *
 *  - 切太粗（整个列表一坨）→ 单项无法 `@` 引用，勾一项整坨 cacheKey 变化；
 *  - 切太细（把一个逻辑项的续行拆开）→ 一条待办被拆成两块，读起来断裂。
 *
 * 这里守的是**列表按项切块**这条判据。它曾经是错的：
 * `- [ ] 甲\n- [ ] 乙\n- [ ] 丙` 被切成**一个**块，
 * 于是复盘的勾选项、FAQ 的每一条都没法单独挂进对话 ——
 * 而逐条引用恰恰是这类清单最需要的用法。
 *
 * 判据与段落一致：**空行分隔的每个单元是一个块**，且相邻列表项
 * 本来就不是同一个单元（Markdown 语义如此）。
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { parseMarkdown, serializeBlocks } from "../src/lib/blocks/parse-blocks.ts";

/** 切块结果的简写：`kind` 序列 */
function kinds(md: string): string[] {
  return parseMarkdown(md).map((b) => b.kind);
}

/** 切块结果的简写：每块首行 */
function firstLines(md: string): string[] {
  return parseMarkdown(md).map((b) => b.text.split("\n", 1)[0]);
}

/* ------------------------------------------------------------------ *
 * 1. 列表按项切块
 * ------------------------------------------------------------------ */

test("相邻的待办项各自成块（不是一整坨）", () => {
  const md = ["- [ ] 甲", "- [ ] 乙", "- [ ] 丙"].join("\n");
  assert.deepEqual(kinds(md), ["todo", "todo", "todo"]);
  assert.deepEqual(firstLines(md), ["- [ ] 甲", "- [ ] 乙", "- [ ] 丙"]);
});

test("相邻的普通列表项各自成块", () => {
  assert.deepEqual(kinds("- 甲\n- 乙\n- 丙"), ["list", "list", "list"]);
});

test("有序列表同样按项切", () => {
  assert.deepEqual(kinds("1. 甲\n2. 乙"), ["list", "list"]);
});

test("待办的勾选状态不影响切块", () => {
  // `- [x]` 与 `- [ ]` 都是待办项，各自成块
  assert.deepEqual(kinds("- [x] 已完成\n- [ ] 未完成"), ["todo", "todo"]);
});

test("缩进续行归入所属那一项，不被拆开", () => {
  const md = ["- [ ] Q1：问题？", "  这是解释第一行。", "  这是解释第二行。", "- [ ] Q2：问题？"].join(
    "\n",
  );
  const blocks = parseMarkdown(md);
  assert.equal(blocks.length, 2, "两个待办项应当只有两块");
  assert.match(blocks[0].text, /解释第一行/, "续行必须留在第一项里");
  assert.match(blocks[0].text, /解释第二行/);
  assert.equal(blocks[1].text.startsWith("- [ ] Q2"), true);
});

test("嵌套列表：父项与子项各自成块", () => {
  /*
   * 子项 `  - 甲一` 以 `- ` 开头（缩进不影响 UL_RE），所以它**另起一块**。
   *
   * 这是"按项切块"这条判据的直接推论，不是漏判。取舍如下：
   *
   *  - **好处**：子项可以单独 `@` 引用。嵌套列表在知识库里常被当
   *    "一个主题下的并列要点"用，逐条引用是有意义的。
   *  - **代价**：块级看不出父子关系，引用一个孤立子项时不知道它属于谁。
   *
   * 暂时接受这个代价 —— 要做成理想形态需要一个真正的列表树模型，
   * 那是更大的改动，且当前没有场景在要求它。
   *
   * 内容不丢：四块拼回去仍是原来的四行。
   */
  const md = ["- 甲", "  - 甲一", "  - 甲二", "- 乙"].join("\n");
  const blocks = parseMarkdown(md);
  assert.equal(blocks.length, 4, "父项、两个子项、兄弟项各一块");
  assert.deepEqual(
    blocks.map((b) => b.text),
    ["- 甲", "  - 甲一", "  - 甲二", "- 乙"],
    "逐行还原，内容一字不丢",
  );
});

/* ------------------------------------------------------------------ *
 * 2. 与段落、引用的判据一致
 * ------------------------------------------------------------------ */

test("列表项之间有空行时同样各自成块（两种写法结果一致）", () => {
  const tight = "- [ ] 甲\n- [ ] 乙";
  const loose = "- [ ] 甲\n\n- [ ] 乙";
  assert.deepEqual(kinds(tight), kinds(loose), "紧凑与松散写法应当切出一样多的块");
});

test("段落与列表混排时互不吞并", () => {
  const md = "普通段落\n\n- 甲\n- 乙\n\n又一段落";
  assert.deepEqual(kinds(md), ["paragraph", "list", "list", "paragraph"]);
});

test("引用块内部的空行仍然按引用规则处理（不受本次改动影响）", () => {
  const md = "> 第一行\n>\n> 第二行";
  const blocks = parseMarkdown(md);
  assert.equal(blocks.length, 1, "同一个引用块应当保持完整");
  assert.equal(blocks[0].kind, "quote");
});

/* ------------------------------------------------------------------ *
 * 3. 往返稳定性：切开之后写回去必须收敛
 * ------------------------------------------------------------------ */

test("列表切开后 serializeBlocks 往返收敛（内容不丢、不继续碎片化）", () => {
  /*
   * 这是本次改动最需要守的性质：`serializeBlocks` 用 `\n\n` 连接各块，
   * 所以"相邻项被切块"写回去会变成"项之间多一个空行"。
   * 只要再解析一次结果不变，就是收敛的 —— 那是可以接受的规范化。
   */
  const cases = [
    "- [ ] 甲\n- [ ] 乙\n- [ ] 丙",
    "- [ ] Q1：问题？\n  解释。\n- [ ] Q2：问题？\n  解释。",
    "1. 甲\n2. 乙\n3. 丙",
    "段落\n\n- 甲\n- 乙",
  ];
  for (const md of cases) {
    const once = parseMarkdown(md);
    const twice = parseMarkdown(serializeBlocks(once));
    assert.deepEqual(
      twice.map((b) => b.text),
      once.map((b) => b.text),
      `往返不收敛：${JSON.stringify(md)}`,
    );
  }
});

test("切开之后每块都是可引用的完整单元（没有把一项劈成两半）", () => {
  // 反向检查：不能为了"切细"把一条待办的续行切出去
  const md = ["- [ ] 甲", "  续行一", "  续行二", "- [ ] 乙"].join("\n");
  const blocks = parseMarkdown(md);
  assert.equal(blocks.length, 2);
  for (const b of blocks) {
    assert.equal(b.kind, "todo");
    assert.ok(b.text.startsWith("- [ ]"), `每块都应当以列表标记开头：${JSON.stringify(b.text)}`);
  }
});
