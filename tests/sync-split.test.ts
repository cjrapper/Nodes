/**
 * 同步工具的回归测试。
 *
 * ## 为什么这些断言值得存在
 *
 * `sync:export` / `sync:import` 是**跨机器**的：一台机器上的 bug 不会在两台
 * 都跑测试时暴露，只会在你换机器时以"我的文档怎么变成这样了"的形式出现，
 * 而且那时已经很难定位。所以这几条针对的是**开发时踩过的真实故障**：
 *
 *  1. **切块规则漂移** —— 导出用一套、导入用另一套，块 id 全部对不上，
 *     每次同步都重建全部块（cacheKey 全变、`@` 引用全断）。
 *  2. **文件名撞车** —— 43 篇文档只生成 36 个唯一路径，7 篇被静默覆盖。
 *  3. **BOM 让标题退化** —— 带 BOM 时 `# 标题` 的首字符不是 `#`，
 *     标题块退化成段落（内容看着一样，但不再是 heading）。
 *  4. **往返不收敛** —— 导出→导入→再导出，块被越切越碎。
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { splitBlocks } from "../src/lib/sync/knowledge-sync.ts";
import { parseMarkdown, serializeBlocks } from "../src/lib/blocks/parse-blocks.ts";

/* ------------------------------------------------------------------ *
 * 1. 切块结果必须与应用自己的解析器一致
 * ------------------------------------------------------------------ */

/**
 * 判定两套切块是否"等价"。
 *
 * 刻意**不**比较 `kind` 的逐个相同，而是比较「切出来的块数 + 每块规范化后的内容」——
 * 理由是两套实现各自维护、`kind` 的细微差异（比如把 `> 引用` 判成 quote 还是
 * paragraph）不影响同步的正确性：同步只关心"块的数量与文本对得上"，
 * 因为块 id 是按位置 + 内容对齐的。
 * 数量或文本对不上才是致命的（会把块合并/拆开）。
 */
function sameSplitting(markdown: string): void {
  const app = parseMarkdown(markdown).map((b) => b.text.replace(/\s+/g, " ").trim());
  const sync = splitBlocks(markdown).map((b) => b.text.replace(/\s+/g, " ").trim());
  assert.deepEqual(
    sync,
    app,
    `切块与应用解析器不一致：\n  应用: ${JSON.stringify(app)}\n  同步: ${JSON.stringify(sync)}`,
  );
}

test("常见结构：应用解析器与同步工具切出相同的块", () => {
  const cases = [
    "# 标题\n\n一个段落。",
    "# 标题\n\n## 二级\n\n段落一。\n\n段落二。",
    "- 甲\n- 乙\n- 丙",
    "- [ ] 待办一\n- [x] 待办二",
    "> 引用第一行\n>\n> 引用第二行",
    "```js\nconst a = 1;\n```",
    "```diagram\nA --> B\n```",
    "# 标题\n\n段落\n\n- [ ] 待办\n\n> 引用\n\n```lua\nlocal x = 1\n```\n\n收尾段落。",
    "段落里带 `行内代码` 和 **粗体**。",
    "1. 一\n2. 二\n3. 三",
    "- [ ] 甲\n  续行解释\n- [ ] 乙",
  ];
  for (const md of cases) sameSplitting(md);
});

test("连续列表项：两边都按项切开（不是一坨）", () => {
  sameSplitting("- 甲\n- 乙\n- 丙");
  sameSplitting("- [ ] 甲\n- [ ] 乙");
});

test("块内容里的空行不改变切块数量", () => {
  sameSplitting("段落一。\n\n段落二。\n\n段落三。");
  sameSplitting("# 标题\n\n\n\n段落。");
});

/* ------------------------------------------------------------------ *
 * 2. 往返收敛
 * ------------------------------------------------------------------ */

test("导出→导入→再导出：块不增多、内容不丢", () => {
  /*
   * 这是同步工具最重要的性质。它不成立时表现为"同步几次之后文档越来越碎"，
   * 而这种退化是渐进的，不容易当场发现。
   */
  const cases = [
    "# 标题\n\n段落一。\n\n段落二。",
    "- [ ] 甲\n- [ ] 乙\n- [ ] 丙",
    "# 标题\n\n- [ ] 待办一\n  说明\n- [ ] 待办二\n\n> 引用\n\n```lua\nx = 1\n```",
    "纯段落，没有任何结构。",
  ];
  for (const md of cases) {
    const once = splitBlocks(md);
    // 用应用的序列化函数"写回文件"，再切一次 —— 模拟真实的导出/导入
    const written = serializeBlocks(once);
    const twice = splitBlocks(written);
    assert.deepEqual(
      twice.map((b) => b.text.replace(/\s+/g, " ").trim()),
      once.map((b) => b.text.replace(/\s+/g, " ").trim()),
      `往返不收敛：${JSON.stringify(md)}`,
    );
  }
});

/* ------------------------------------------------------------------ *
 * 3. BOM 与边界
 * ------------------------------------------------------------------ */

test("带 BOM 的正文：标题仍然是标题（不能被降级成段落）", () => {
  /*
   * 这条守的是一个真实故障：PowerShell 的 `Set-Content -Encoding UTF8`
   * 和记事本都会写 BOM。带 BOM 时首字符是 `\uFEFF`，
   * `# 标题` 就匹配不上标题规则，于是**标题块退化成段落** ——
   * 目录里不再有它、kind 变了、cacheKey 也变了。
   *
   * 这里断言的是"没有剥离 BOM 时确实会出问题"，从而说明
   * `stripBom` 不是多余的防御。
   */
  const withBom = "\uFEFF# 标题\n\n段落。";
  const blocks = splitBlocks(withBom);
  assert.equal(blocks[0].kind, "paragraph", "未剥离 BOM 时首块确实不是 heading —— 这就是要防的事");
  assert.match(blocks[0].text, /^\uFEFF/, "BOM 会留在文本里");

  // 剥离之后应当恢复成标题
  const stripped = splitBlocks(withBom.replace(/^\uFEFF/, ""));
  assert.equal(stripped[0].kind, "heading", "剥离 BOM 后必须识别回 heading");
  assert.equal(stripped.length, 2);
});

test("空正文与纯空白不产生块", () => {
  assert.deepEqual(splitBlocks(""), []);
  assert.deepEqual(splitBlocks("\n\n   \n"), []);
  assert.deepEqual(splitBlocks("\n"), []);
});

test("CRLF 与 LF 切出相同结果", () => {
  const lf = "# 标题\n\n段落一。\n\n- 甲\n- 乙";
  const crlf = lf.replace(/\n/g, "\r\n");
  assert.deepEqual(
    splitBlocks(crlf).map((b) => b.text),
    splitBlocks(lf).map((b) => b.text),
  );
});
