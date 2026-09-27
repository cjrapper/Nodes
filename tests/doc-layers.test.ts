/**
 * 「整体挂载模块」这一层的组装测试。
 *
 * 这是「查漏补缺」「评判修改」的地基：那类学习任务要判断"这个方向缺什么"，
 * 只看几个块是做不到的，必须把整个模块（含子模块）作为一个稳定单元喂进去。
 *
 * 本文件守四件事：
 *  1. **模块不含正文时也要能摊平成内容** —— 模块是容器，内容全在子文档里；
 *  2. **确定性** —— 挂载顺序不影响渲染字节（缓存前缀不碎的前提）；
 *  3. **预算裁剪不留半篇** —— 半个知识点比没有更容易误导模型；
 *  4. **层顺序与失效定位** —— 模块层变化不该连累块层已命中的部分。
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { assembleContext, type AssembleInput } from "../src/lib/cache/assemble.ts";
import {
  renderDocContent,
  renderDocIndex,
  sortDocsDeterministically,
  type SourceDoc,
} from "../src/lib/cache/layers.ts";

function makeDoc(
  docId: string,
  title: string,
  texts: string[],
  overrides: Partial<SourceDoc> = {},
): SourceDoc {
  const blocks = texts.map((text) => ({ kind: "paragraph" as const, text }));
  return {
    docId,
    title,
    kind: "doc",
    blocks,
    textHash: `hash_${docId}`,
    cacheKey: `key_${docId}`,
    blockCount: blocks.length,
    ...overrides,
  };
}

function baseInput(overrides: Partial<AssembleInput> = {}): AssembleInput {
  return {
    workspaceName: "测试库",
    persona: "你是一个严谨的助手。",
    conventions: "术语：知识块 = 段落单元。",
    blocks: [],
    docs: [],
    history: [],
    turn: "帮我看看这个方向还缺什么",
    sourceBudgetTokens: 40000,
    contextWindow: 128000,
    providerKind: "openai",
    previousLayerHashes: null,
    previousPromptTokens: null,
    /*
     * 门槛显式设成低于 fixture 前缀的小值 —— 理由与 assemble.test.ts 里
     * 完全一样：不这么写的话，这些用例的成败就取决于 `renderPersona`
     * 恰好拼了多长的模板文字，而那是个与它们毫不相干的变量。
     */
    cacheFloorTokens: 128,
    ...overrides,
  };
}

function hashesOf(result: ReturnType<typeof assembleContext>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const l of result.layers) out[l.name] = l.hash;
  return out;
}

/* ------------------------------------------------------------------ *
 * 1. 渲染
 * ------------------------------------------------------------------ */

test("模块清单只列标题与类型，不含正文规模", () => {
  const index = renderDocIndex([
    makeDoc("d1", "Unity 生命周期", ["内容一"]),
    makeDoc("d2", "图形学", ["内容二"], { kind: "module" }),
  ]);

  assert.match(index, /Unity 生命周期/);
  assert.match(index, /图形学/);
  assert.match(index, /\[模块\]/, "模块要在清单里标出来");
  // 关键：不写"约 N token"这类随内容变化的数字，否则编辑正文会让清单跟着失效
  assert.equal(/token/.test(index), false, "清单里不该出现随内容变化的规模数字");
});

test("模块正文按文档分节，并标出边界", () => {
  const content = renderDocContent(
    [makeDoc("d1", "Unity 生命周期", ["Awake 最先执行。", "OnEnable 紧随其后。"])],
    40000,
  );

  assert.match(content, /<<<DOC key_d1 \| Unity 生命周期>>>/);
  assert.match(content, /<<<END DOC>>>/);
  assert.match(content, /Awake 最先执行。/);
  assert.match(content, /OnEnable 紧随其后。/);
});

test("预算不足时跳过整篇文档，而不是切一半", () => {
  const content = renderDocContent(
    [
      makeDoc("d1", "第一篇", ["短"]),
      makeDoc("d2", "第二篇", ["长".repeat(2000)]),
    ],
    200,
  );

  assert.match(content, /第一篇/);
  assert.match(content, /第二篇/);
  assert.match(content, /未展开/, "被跳过的文档要明确标注");
  assert.equal(
    content.includes("长长长"),
    false,
    "超出预算的文档不应只塞进去半篇正文",
  );
});

test("没有文档时不渲染模块层", () => {
  assert.equal(renderDocIndex([]), "");
  assert.equal(renderDocContent([], 40000), "");
});

/* ------------------------------------------------------------------ *
 * 2. 确定性
 * ------------------------------------------------------------------ */

test("文档排序与挂载顺序无关", () => {
  const a = makeDoc("da", "A", ["内容 A"], { cacheKey: "0001" });
  const b = makeDoc("db", "B", ["内容 B"], { cacheKey: "0002" });
  const c = makeDoc("dc", "C", ["内容 C"], { cacheKey: "0003" });

  assert.deepEqual(
    sortDocsDeterministically([c, a, b]).map((d) => d.docId),
    ["da", "db", "dc"],
  );
  assert.deepEqual(
    sortDocsDeterministically([b, c, a]).map((d) => d.docId),
    ["da", "db", "dc"],
  );
});

test("同一组文档以不同顺序挂载，产出的 prompt 逐字节相同", () => {
  const a = makeDoc("da", "图形学", ["渲染管线分几个阶段。"], { cacheKey: "0001" });
  const b = makeDoc("db", "Unity", ["生命周期从 Awake 开始。"], { cacheKey: "0002" });

  const r1 = assembleContext(baseInput({ docs: [a, b] }));
  const r2 = assembleContext(baseInput({ docs: [b, a] }));

  assert.deepEqual(
    r1.messages.map((m) => m.content),
    r2.messages.map((m) => m.content),
    "挂载顺序不该影响渲染结果 —— 否则缓存前缀每轮都在变",
  );
  assert.equal(r1.prefixHash, r2.prefixHash);
});

/* ------------------------------------------------------------------ *
 * 3. 层结构与失效定位
 * ------------------------------------------------------------------ */

test("模块层插在块层之后、历史之前", () => {
  const result = assembleContext(
    baseInput({
      blocks: [],
      docs: [makeDoc("da", "Unity", ["内容"])],
      history: [{ id: "m1", role: "user", content: "问" }],
    }),
  );

  assert.deepEqual(
    result.layers.map((l) => l.name).filter((n) => n.startsWith("L2")),
    ["L2_source_index", "L2_source_content", "L2_doc_index", "L2_doc_content"],
    "模块层应当紧跟块层",
  );
  const names = result.layers.map((l) => l.name);
  assert.ok(
    names.indexOf("L2_doc_content") < names.indexOf("L3_history"),
    "模块层必须在历史之前",
  );
});

test("模块内容变化时，失效从模块层开始，块层仍保持命中", () => {
  const block = makeDoc("db1", "块来源", ["块内容"]);
  void block;

  const sourceBlock = {
    id: "blk_1",
    docId: "doc_x",
    seq: 0,
    kind: "paragraph" as const,
    text: "一段被 @ 的内容",
    textHash: "h1",
    cacheKey: "k1",
    docTitle: "来源",
    path: "来源",
  };

  const turn1 = assembleContext(
    baseInput({
      blocks: [sourceBlock],
      docs: [makeDoc("da", "Unity", ["原始内容"])],
      turn: "第一问",
    }),
  );

  // 第二轮：模块里的文档被编辑
  const turn2 = assembleContext(
    baseInput({
      blocks: [sourceBlock],
      docs: [makeDoc("da", "Unity", ["改过的内容"])],
      turn: "第二问",
      previousLayerHashes: hashesOf(turn1),
      previousPromptTokens: turn1.totalTokens,
    }),
  );

  const byName = Object.fromEntries(turn2.layers.map((l) => [l.name, l]));
  assert.equal(byName.L2_source_index.unchangedFromPrevious, true, "块层清单不该失效");
  assert.equal(byName.L2_source_content.unchangedFromPrevious, true, "块层正文不该失效");
  assert.equal(byName.L2_doc_content.unchangedFromPrevious, false, "模块正文应当失效");
  assert.ok(
    turn2.prediction.predictedCachedTokens > 0,
    "块层与 L0/L1 的稳定前缀仍应产生命中",
  );
});

test("挂载顺序变化不产生任何失效（说明集合没变）", () => {
  const a = makeDoc("da", "A 文档", ["内容 A"], { cacheKey: "0001" });
  const b = makeDoc("db", "B 文档", ["内容 B"], { cacheKey: "0002" });

  const turn1 = assembleContext(baseInput({ docs: [a, b], turn: "第一问" }));
  const turn2 = assembleContext(
    baseInput({
      docs: [b, a],
      turn: "第二问",
      previousLayerHashes: hashesOf(turn1),
      previousPromptTokens: turn1.totalTokens,
    }),
  );

  assert.equal(
    turn2.invalidation.fromLayer,
    "L4_turn",
    "只有本轮输入不同，模块层应当完全命中",
  );
  const byName = Object.fromEntries(turn2.layers.map((l) => [l.name, l]));
  assert.equal(byName.L2_doc_index.unchangedFromPrevious, true, "模块清单应命中");
  assert.equal(byName.L2_doc_content.unchangedFromPrevious, true, "模块正文应命中");
});

/* ------------------------------------------------------------------ *
 * 4. 与块层共存
 * ------------------------------------------------------------------ */

test("块层与模块层可以同时存在，各自独立计入 token", () => {
  const result = assembleContext(
    baseInput({
      blocks: [
        {
          id: "blk_1",
          docId: "doc_x",
          seq: 0,
          kind: "paragraph",
          text: "块内容",
          textHash: "h1",
          cacheKey: "k1",
          docTitle: "来源",
          path: "来源",
        },
      ],
      docs: [makeDoc("da", "Unity", ["模块内容"])],
    }),
  );

  const byName = Object.fromEntries(result.layers.map((l) => [l.name, l]));
  assert.ok(byName.L2_source_content.tokens > 0, "块层应有内容");
  assert.ok(byName.L2_doc_content.tokens > 0, "模块层应有内容");

  const sum = result.layers.reduce((s, l) => s + l.tokens, 0);
  assert.equal(sum, result.totalTokens, "各层 token 之和应等于总输入");
});

test("模块预算可独立于块预算，且预算不够时标注未展开", () => {
  const small = makeDoc("da", "小文档", ["短内容"]);
  const big = makeDoc("db", "大文档", ["长".repeat(3000)]);

  // 第一篇始终保留（否则上下文会变成空的），所以至少放两篇才能看出裁剪
  const tight = assembleContext(
    baseInput({ docs: [small, big], sourceBudgetTokens: 40000, docBudgetTokens: 100 }),
  );
  const loose = assembleContext(
    baseInput({ docs: [small, big], sourceBudgetTokens: 40000, docBudgetTokens: 40000 }),
  );

  const tightText = tight.layers.find((l) => l.name === "L2_doc_content")!.text;
  const looseText = loose.layers.find((l) => l.name === "L2_doc_content")!.text;

  assert.match(tightText, /未展开/, "预算不够时应当标注哪些文档没展开");
  assert.equal(looseText.includes("未展开"), false, "预算充足时不该有裁剪标注");
  assert.ok(
    tight.totalTokens < loose.totalTokens,
    "收紧模块预算应当让整体输入变小",
  );
});

test("单篇文档时预算再小也保留正文（避免上下文变空）", () => {
  const only = makeDoc("da", "唯一文档", ["唯一的内容"]);
  const result = assembleContext(baseInput({ docs: [only], docBudgetTokens: 1 }));
  const content = result.layers.find((l) => l.name === "L2_doc_content")!;
  assert.ok(content.tokens > 0, "至少保留第一篇的正文，否则模型无从作答");
  assert.match(content.text, /唯一的内容/);
});
