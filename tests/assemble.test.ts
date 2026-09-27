/**
 * 组装器的不变式测试。
 *
 * 这些断言保护的是**缓存命中率**这一核心目标：
 * 任何一条挂掉，用户就会真实地多付钱。改动 assemble.ts / layers.ts 后
 * 必须先跑 `npm test`。
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { assembleContext, decideBreakpoints, type AssembleInput } from "../src/lib/cache/assemble.ts";
import {
  normalizeBlockText,
  renderSourceContent,
  sortBlocksDeterministically,
  type SourceBlock,
} from "../src/lib/cache/layers.ts";
import { estimateTokens } from "../src/lib/tokens.ts";

function makeBlock(id: string, text: string, overrides: Partial<SourceBlock> = {}): SourceBlock {
  return {
    id,
    docId: "doc_1",
    seq: 0,
    kind: "paragraph",
    text,
    textHash: `hash_${id}_${text.length}`,
    cacheKey: `key_${id}`,
    docTitle: "部署手册",
    path: "部署手册 › 回滚流程",
    ...overrides,
  };
}

function baseInput(overrides: Partial<AssembleInput> = {}): AssembleInput {
  return {
    workspaceName: "测试库",
    persona: "你是一个严谨的助手。",
    conventions: "术语：知识块 = 段落单元。",
    blocks: [],
    history: [],
    turn: "帮我总结一下",
    sourceBudgetTokens: 40000,
    contextWindow: 128000,
    providerKind: "openai",
    previousLayerHashes: null,
    previousPromptTokens: null,
    /*
     * 门槛显式设成一个低于 fixture 前缀的小值。
     *
     * ⚠️ 这行不是可有可无的样板。原先这里没有它，于是**整个文件的行为都取决于
     * `renderPersona` 恰好拼了多少模板文字** —— 那些"命中 > 0"的断言之所以成立，
     * 只是因为 L0 里有一段很长的写死模板把前缀顶过了 1024。
     * 一旦那段模板被删掉（见 layers.ts），前缀掉到门槛以下，
     * 一批与缓存门槛毫无关系的测试就集体变红，看起来像实现坏了，
     * 实际是它们偷偷依赖了一个无关变量。
     *
     * 需要测门槛本身的用例（见「前缀短于可缓存门槛时…」）自己覆盖这个值。
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
 * 1. 顺序无关性 —— 缓存命中率的头号保证
 * ------------------------------------------------------------------ */

test("同一组块以不同传入顺序组装，产出逐字节相同的 prompt 与指纹", () => {
  const a = makeBlock("blk_a", "第一段内容，讲的是部署流程。");
  const b = makeBlock("blk_b", "第二段内容，讲的是回滚策略。");
  const c = makeBlock("blk_c", "第三段内容，讲的是监控告警。");

  const r1 = assembleContext(baseInput({ blocks: [a, b, c] }));
  const r2 = assembleContext(baseInput({ blocks: [c, a, b] }));
  const r3 = assembleContext(baseInput({ blocks: [b, c, a] }));

  assert.deepEqual(
    r1.messages.map((m) => m.content),
    r2.messages.map((m) => m.content),
    "消息内容必须完全一致",
  );
  assert.deepEqual(r1.messages.map((m) => m.content), r3.messages.map((m) => m.content));
  assert.equal(r1.prefixHash, r2.prefixHash, "前缀指纹必须一致");
  assert.equal(r1.prefixHash, r3.prefixHash);
  assert.deepEqual(r1.orderedBlockIds, r2.orderedBlockIds, "排序后的块 id 序列必须一致");
});

test("稳定排序是内容哈希序而非插入序", () => {
  const blocks = [
    makeBlock("z", "zzz", { cacheKey: "ff00" }),
    makeBlock("a", "aaa", { cacheKey: "00aa" }),
    makeBlock("m", "mmm", { cacheKey: "8080" }),
  ];
  assert.deepEqual(
    sortBlocksDeterministically(blocks).map((b) => b.cacheKey),
    ["00aa", "8080", "ff00"],
  );
});

/* ------------------------------------------------------------------ *
 * 2. 失效定位精度
 * ------------------------------------------------------------------ */

test("编辑被引用的块，失效层精确落在 L2 正文，L0/L1 仍为命中态", () => {
  const block = makeBlock("blk_a", "原始内容");
  const turn1 = assembleContext(baseInput({ blocks: [block], turn: "第一问" }));

  // 第二轮：块内容被编辑
  const edited = makeBlock("blk_a", "编辑后的内容");
  const turn2 = assembleContext(
    baseInput({
      blocks: [edited],
      turn: "第二问",
      previousLayerHashes: hashesOf(turn1),
      previousPromptTokens: turn1.totalTokens,
    }),
  );

  const byName = Object.fromEntries(turn2.layers.map((l) => [l.name, l]));
  assert.equal(byName.L0_persona.unchangedFromPrevious, true, "L0 人设不应失效");
  assert.equal(byName.L1_workspace.unchangedFromPrevious, true, "L1 约定不应失效");
  assert.equal(
    byName.L2_source_index.unchangedFromPrevious,
    true,
    "清单只依赖块的集合，编辑正文不应让它失效",
  );
  assert.equal(byName.L2_source_content.unchangedFromPrevious, false, "L2 正文应当失效");
  assert.equal(turn2.invalidation.fromLayer, "L2_source_content");
  assert.equal(turn2.invalidation.reason, "block_edited");
  assert.ok(
    turn2.prediction.predictedCachedTokens > 0,
    "L0+L1+清单 的稳定前缀仍应产生命中",
  );
});

test("只改了人设时，失效根因是人设且命中归零", () => {
  const turn1 = assembleContext(baseInput({ turn: "第一问" }));
  const turn2 = assembleContext(
    baseInput({
      persona: "完全换了个人设。",
      turn: "第二问",
      previousLayerHashes: hashesOf(turn1),
      previousPromptTokens: turn1.totalTokens,
    }),
  );
  // fromLayer 是"缓存起点的回退位置"；L0 变了意味着没有任何可复用前缀，
  // 因此从最起点 L0 算起，命中为 0。
  assert.equal(turn2.invalidation.fromLayer, "L0_persona");
  assert.equal(turn2.invalidation.reason, "persona_changed");
  assert.equal(turn2.prediction.predictedCachedTokens, 0);
});

test("仅追加历史、不改动前面内容时，历史层保持命中", () => {
  const history = [
    { id: "m1", role: "user" as const, content: "第一问" },
    { id: "m2", role: "assistant" as const, content: "第一答" },
  ];
  const turn1 = assembleContext(baseInput({ history, turn: "第二问" }));

  const appended = [...history, { id: "m3", role: "assistant" as const, content: "第二答" }];
  const turn2 = assembleContext(
    baseInput({
      history: appended,
      turn: "第三问",
      previousLayerHashes: hashesOf(turn1),
      previousPromptTokens: turn1.totalTokens,
    }),
  );

  // L3 整体变了（因为追加），但 L0/L1/L2 必须保持命中
  const byName = Object.fromEntries(turn2.layers.map((l) => [l.name, l]));
  assert.equal(byName.L0_persona.unchangedFromPrevious, true);
  assert.equal(byName.L1_workspace.unchangedFromPrevious, true);
  assert.equal(byName.L2_source_content.unchangedFromPrevious, true);
  assert.equal(turn2.invalidation.fromLayer, "L3_history");
});

/* ------------------------------------------------------------------ *
 * 3. 第二轮必须产生命中（端到端收益保证）
 * ------------------------------------------------------------------ */

test("连续两轮、仅追加历史时，第二轮产生真实命中预测", () => {
  // 用足够大的块越过服务商的最小可缓存长度（1024 token），
  // 否则缓存机制根本不参与计费，测不到命中。
  const blocks = [
    makeBlock("blk_a", "甲".repeat(2500)),
    makeBlock("blk_b", "乙".repeat(2500)),
  ];
  const history = [{ id: "m1", role: "user" as const, content: "第一问".repeat(50) }];

  const turn1 = assembleContext(baseInput({ blocks, history, turn: "第一轮提问" }));
  const turn2 = assembleContext(
    baseInput({
      blocks,
      history: [...history, { id: "m2", role: "assistant" as const, content: "第一轮回答" }],
      turn: "第二轮提问",
      previousLayerHashes: hashesOf(turn1),
      previousPromptTokens: turn1.totalTokens,
    }),
  );

  assert.equal(turn2.prediction.belowCacheFloor, false, "前缀已越过缓存门槛");
  assert.equal(turn2.prediction.verdict, "partial", "L3 因追加而变化，应判定为部分命中");
  assert.ok(
    turn2.prediction.predictedCachedTokens > 1024,
    `预期有实质缓存读取，实际为 ${turn2.prediction.predictedCachedTokens}`,
  );
  assert.equal(turn2.invalidation.reason, "history_rewritten");
  assert.equal(turn2.invalidation.fromLayer, "L3_history");
  // 命中量必须是缓存块粒度的整数倍（保守预测，不四舍五入到块中间）
  assert.equal(turn2.prediction.predictedCachedTokens % 128, 0);
  assert.ok(turn2.stablePrefixTokens >= turn2.prediction.predictedCachedTokens);
});

test("前缀短于可缓存门槛时，明确标记缓存未生效而非仅仅命中 0", () => {
  const history = [{ id: "m1", role: "user" as const, content: "第一问" }];
  const first = assembleContext(baseInput({ history, turn: "第一轮" }));
  const turn2 = assembleContext(
    baseInput({
      history: [...history, { id: "m2", role: "assistant" as const, content: "答" }],
      turn: "第二轮",
      previousLayerHashes: hashesOf(first),
      previousPromptTokens: first.totalTokens,
      /*
       * 门槛**显式抬高**，而不是指望"默认人设够短"。
       *
       * 这条测试原本靠 `persona: "你是一个严谨的助手。"` 让前缀自然短于 1024。
       * 但 L0 的长度取决于 renderPersona 拼了多少模板文字 —— 后来把模板句删掉
       * （见 layers.ts 里"不追加写死的角色说明"），L0 一下缩到 146 token，
       * 前缀越过了门槛，这条测试就**静默地不再测它名字里那件事**了：
       * 断言全绿，但走的根本不是"低于门槛"的分支。
       *
       * 门槛取 2048 而不是随手一个大数：它会被按 128 对齐，
       * 100000 这种值对齐后反而算出 128，把测试又带偏一次。
       * 2048 既是 128 的整数倍，又明显高于这里的前缀长度。
       */
      cacheFloorTokens: 2048,
    }),
  );

  assert.equal(turn2.prediction.belowCacheFloor, true);
  assert.equal(turn2.prediction.predictedCachedTokens, 0);
  assert.equal(turn2.prediction.predictedWriteTokens, 0, "缓存未生效就不该声称写入了缓存");
  assert.equal(turn2.prediction.cacheFloorTokens, 2048);
  // 前缀虽然短于门槛，但确实是稳定的 —— 这两个概念必须能分别被观测到
  assert.ok(turn2.prediction.stablePrefixTokens > 0);
});

test("低于门槛时命中与写入必须一起归零（不能只归零一个）", () => {
  /*
   * 这条守的是一个**自相矛盾的状态**。
   *
   * 原先的实现只把 `predictedWriteTokens` 归零，`predictedCachedTokens`
   * 仍按前缀长度算 —— 于是界面上会同时出现「命中 128 token」和「写入 0 token」。
   * 那是物理上不可能的：这一轮既然什么都没写进缓存，就不可能从缓存里读出东西。
   *
   * 用户看到的是一组自相矛盾的数字，而这比数字偏小更难察觉 ——
   * 它看起来像"两个独立指标"，实际是同一个判据只应用了一半。
   */
  const history = [{ id: "m1", role: "user" as const, content: "第一问" }];
  const first = assembleContext(baseInput({ history, turn: "第一轮" }));
  const below = assembleContext(
    baseInput({
      history: [...history, { id: "m2", role: "assistant" as const, content: "答" }],
      turn: "第二轮",
      previousLayerHashes: hashesOf(first),
      previousPromptTokens: first.totalTokens,
      cacheFloorTokens: 4096,
    }),
  );
  const above = assembleContext(
    baseInput({
      history: [...history, { id: "m2", role: "assistant" as const, content: "答" }],
      turn: "第二轮",
      previousLayerHashes: hashesOf(first),
      previousPromptTokens: first.totalTokens,
      cacheFloorTokens: 128,
    }),
  );

  // 同一个场景，只改门槛：高于门槛时两者都非零，低于门槛时两者都必须为零
  assert.ok(above.prediction.predictedCachedTokens > 0, "高于门槛时应当有可读的缓存");
  assert.ok(above.prediction.predictedWriteTokens > 0, "高于门槛时应当有写入");

  assert.equal(below.prediction.belowCacheFloor, true);
  assert.equal(below.prediction.predictedCachedTokens, 0, "没写进去就不可能读出来");
  assert.equal(below.prediction.predictedWriteTokens, 0, "低于门槛不写入");
  // 全部输入都是未命中 —— 这才是"缓存未生效"的真实含义
  assert.equal(below.prediction.predictedMissTokens, below.prediction.totalInputTokens);
});

/* ------------------------------------------------------------------ *
 * 4. 断点决策（Anthropic 显式缓存，写错就是净亏损）
 * ------------------------------------------------------------------ */

test("首次对话只在最早稳定层打断点，避免为易变层付写入溢价", () => {
  const result = assembleContext(
    baseInput({ providerKind: "anthropic", blocks: [makeBlock("a", "内容")] }),
  );
  const withBp = result.layers.filter((l) => l.hasBreakpoint);
  assert.equal(withBp.length, 1, "冷启动应只打一个断点");
  assert.equal(withBp[0].name, "L0_persona");
});

test("冷启动也必须过缓存门槛：前缀太短就不该打断点", () => {
  /*
   * 这条来自审计发现的一个真实浪费。
   *
   * 断点决策里"有上一轮"的分支会检查 `cumulative < minimumTokens`，
   * 而"冷启动"分支直接 return —— 门槛只作用于一条路径。
   * 后果是一组自相矛盾的状态同时出现：
   *
   *   - 请求带上 `cache_control`，而前缀只有 160 多 token。
   *     Anthropic 不会缓存这么短的前缀，那 1.25x 的写入溢价**纯浪费**；
   *   - 同一份预测里 `belowCacheFloor` 为 true（界面显示"缓存不会生效"），
   *     于是屏幕上一边写着"缓存不生效"、一边写着"已在 L0 打了断点"；
   *   - 断点说明还会打印"覆盖前 0 token 的稳定前缀"——冷启动时
   *     `stablePrefixTokens` 本来就是 0；
   *   - 下一轮同样的上下文又变成不打断了（那时走有门槛的分支），
   *     相同前缀在两轮之间反复横跳，看起来像随机行为。
   *
   * 判据只有一份：稳定前缀长度。它与"有没有上一轮"无关。
   */
  const cold = assembleContext(
    baseInput({ providerKind: "anthropic", cacheFloorTokens: 4096 }),
  );

  const marked = cold.layers.filter((l) => l.hasBreakpoint);
  assert.deepEqual(
    marked.map((l) => l.name),
    [],
    `冷启动 + 前缀过短时不该有任何断点，实际打了：${marked.map((l) => l.name).join(",")}`,
  );
  // 两条路径的判据必须一致：既然决定不打，请求里就不能带 cache_control
  assert.equal(
    cold.messages.some((m) => m.cacheControl),
    false,
    "既然决定不打，请求里就不能带 cache_control —— 那是要付写入溢价的",
  );
  // 同一份预测里也不该同时声称"缓存不生效"和"已打断点"
  assert.equal(cold.prediction.belowCacheFloor, true, "前置条件：前缀确实低于门槛");
});

test("冷启动时前缀够长仍然打断点（门槛不能把正常情况也拦掉）", () => {
  const cold = assembleContext(
    baseInput({ providerKind: "anthropic", blocks: [makeBlock("big", "内容".repeat(400))] }),
  );
  const marked = cold.layers.filter((l) => l.hasBreakpoint);
  assert.ok(
    marked.length > 0,
    "前缀足够长时冷启动必须建立缓存起点，否则永远攒不出缓存",
  );
  assert.equal(marked[0].name, "L0_persona", "冷启动应当在最早的稳定层打断点");
});

test("前缀短于最小可缓存长度时放弃断点", () => {  const layers = [
    {
      name: "L0_persona" as const,
      title: "L0",
      text: "很短",
      tokens: 10,
      hash: "h",
      prefixHash: "h",
      unchangedFromPrevious: true,
      hasBreakpoint: false,
    },
  ];
  const decision = decideBreakpoints(layers, { L0_persona: "h" }, 1024);
  assert.equal(decision.breakpointLayer, null);
  assert.match(decision.reason, /低于最小可缓存长度/);
});

test("所有层都变化时不打断点（打断点等于白付 25% 写入费）", () => {
  const layers = [
    {
      name: "L0_persona" as const,
      title: "L0",
      text: "x".repeat(5000),
      tokens: 2000,
      hash: "new",
      prefixHash: "new",
      unchangedFromPrevious: false,
      hasBreakpoint: false,
    },
    {
      name: "L3_history" as const,
      title: "L3",
      text: "y".repeat(5000),
      tokens: 2000,
      hash: "new2",
      prefixHash: "new2",
      unchangedFromPrevious: false,
      hasBreakpoint: false,
    },
  ];
  const decision = decideBreakpoints(layers, { L0_persona: "old", L3_history: "old2" }, 1024);
  assert.equal(decision.breakpointLayer, null);
  assert.match(decision.reason, /跳过断点/);
});

test("存在稳定深层时，断点落在最深稳定层以覆盖最长前缀", () => {
  const mk = (
    name: "L0_persona" | "L2_source_content",
    tokens: number,
    unchanged: boolean,
  ) => ({
    name,
    title: name,
    text: "t",
    tokens,
    hash: "h",
    prefixHash: "h",
    unchangedFromPrevious: unchanged,
    hasBreakpoint: false,
  });
  const decision = decideBreakpoints(
    [mk("L0_persona", 2000, true), mk("L2_source_content", 3000, true)],
    { L0_persona: "h", L2_source_content: "h" },
    1024,
  );
  assert.equal(decision.breakpointLayer, "L2_source_content");
});

/* ------------------------------------------------------------------ *
 * 5. 预算裁剪不破坏清单稳定性
 * ------------------------------------------------------------------ */

test("超出预算的块只被移出正文，清单仍然完整", () => {
  const big = makeBlock("big", "长".repeat(5000));
  const small = makeBlock("small", "短内容");
  const result = assembleContext(
    baseInput({ blocks: [big, small], sourceBudgetTokens: 100 }),
  );

  const indexLayer = result.layers.find((l) => l.name === "L2_source_index")!;
  const contentLayer = result.layers.find((l) => l.name === "L2_source_content")!;

  // 清单里两个块都在（模型知道它们存在），正文里被裁掉的那个不能出现
  assert.match(indexLayer.text, /`key_/i, "清单应带块标识");
  assert.match(indexLayer.text, /短内容|正文/, "清单应给出路径与类型");
  assert.equal(result.omittedBlockIds.length >= 1, true, "应有块被标记为未展开");
  assert.ok(
    contentLayer.tokens < indexLayer.tokens + estimateTokens(big.text),
    "正文不应包含被裁掉的大块",
  );
  assert.ok(result.warnings.some((w) => w.includes("未展开正文")));
});

/* ------------------------------------------------------------------ *
 * 6. 文本规范化幂等性
 * ------------------------------------------------------------------ */

test("规范化是幂等的", () => {
  const messy = "  行尾有空格   \n\n\n\n第二行\r\n第三行\r\n";
  const once = normalizeBlockText(messy);
  assert.equal(normalizeBlockText(once), once, "二次规范化必须无变化");
  assert.equal(once.includes("\r"), false, "换行符应统一为 \\n");
  assert.equal(/[ \t]+\n/.test(once), false, "不应有行尾空白");
});

test("规范化不改变语义顺序，只清理空白", () => {
  const text = "# 标题\n\n- a\n- b";
  assert.equal(normalizeBlockText(text), text, "已经干净的文本不应被改动");
});

/* ------------------------------------------------------------------ *
 * 7. 无隐藏的非确定性来源
 * ------------------------------------------------------------------ */

test("跨调用重复组装产生完全相同的结果（无时间/随机依赖）", () => {
  const blocks = [makeBlock("a", "内容 A"), makeBlock("b", "内容 B")];
  const runs = Array.from({ length: 5 }, () =>
    assembleContext(baseInput({ blocks, turn: "同一个问题" })),
  );
  const first = runs[0];
  for (const run of runs.slice(1)) {
    assert.equal(run.prefixHash, first.prefixHash);
    assert.deepEqual(run.messages, first.messages);
    assert.deepEqual(run.layers.map((l) => l.hash), first.layers.map((l) => l.hash));
  }
});

test("prompt 中不含时间戳或 UUID 形态的易变内容", () => {
  const result = assembleContext(
    baseInput({ blocks: [makeBlock("a", "内容")], turn: "问题" }),
  );
  const all = result.messages.map((m) => m.content).join("\n");
  assert.equal(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(all), false, "不应出现 ISO 时间戳");
  assert.equal(
    /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.test(all),
    false,
    "不应出现 UUID",
  );
});

/* ------------------------------------------------------------------ *
 * 8. 层顺序不变式
 * ------------------------------------------------------------------ */

test("层顺序永远是 L0 → L4，且每层只出现一次", () => {
  const result = assembleContext(
    baseInput({
      blocks: [makeBlock("a", "内容")],
      history: [
        { id: "m1", role: "user", content: "问" },
        { id: "m2", role: "assistant", content: "答" },
      ],
      turn: "再问",
    }),
  );
  assert.deepEqual(
    result.layers.map((l) => l.name),
    [
      "L0_persona",
      "L1_workspace",
      "L2_source_index",
      "L2_source_content",
      "L2_doc_index",
      "L2_doc_content",
      "L3_history",
      "L4_turn",
    ],
  );
  // 每层只出现一次 —— 漏掉这条会让"同一层被插两次"的回归悄悄通过。
  // L3 是用 splice 补进数组的，正是最容易插错位置的地方。
  assert.equal(
    new Set(result.layers.map((l) => l.name)).size,
    result.layers.length,
    "同一层不能出现两次",
  );
});

test("消息序列里 system 只出现在最前面", () => {
  const result = assembleContext(
    baseInput({
      blocks: [makeBlock("a", "内容")],
      history: [
        { id: "m1", role: "user", content: "问" },
        { id: "m2", role: "assistant", content: "答" },
      ],
    }),
  );
  const roles = result.messages.map((m) => m.role);
  const lastSystem = roles.lastIndexOf("system");
  const firstNonSystem = roles.findIndex((r) => r !== "system");
  assert.ok(lastSystem < firstNonSystem, "system 消息必须全部位于最前");
  assert.equal(roles[roles.length - 1], "user", "最后一条必须是本轮 user 输入");
});

/* ------------------------------------------------------------------ *
 * 9. 知识块正文渲染格式
 * ------------------------------------------------------------------ */

test("块正文带稳定分隔标记，顺序与稳定排序一致", () => {
  const b1 = makeBlock("b1", "内容一", { cacheKey: "0001" });
  const b2 = makeBlock("b2", "内容二", { cacheKey: "0002" });
  const rendered = renderSourceContent([b2, b1], new Set());
  const i1 = rendered.indexOf("内容一");
  const i2 = rendered.indexOf("内容二");
  assert.ok(i1 > 0 && i2 > 0);
  assert.ok(i1 < i2, "cacheKey 小的块应排在前面");
  assert.match(rendered, /<<<BLOCK 0001/);
  assert.match(rendered, /<<<END BLOCK>>>/);
});

test("没有引用块时不渲染 L2 层", () => {
  const result = assembleContext(baseInput({ blocks: [] }));
  const content = result.layers.find((l) => l.name === "L2_source_content")!;
  assert.equal(content.tokens, 0);
  assert.equal(
    result.messages.some((m) => m.layer === "L2_source_content"),
    false,
  );
});
