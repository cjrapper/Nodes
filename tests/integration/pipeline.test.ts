/**
 * 端到端集成测试：真实 SQLite + 真实组装器 + 真实成本核算。
 *
 * 与 assemble.test.ts 的区别：那个文件用假的 SourceBlock 测组装器的不变式，
 * 这个文件走**完整数据管线** —— Markdown → 块解析 → 落库（追加式修订）
 * → 载入 SourceBlock → 组装 → 命中预测 → 成本核算。
 *
 * 能覆盖到的真实缺陷类型（单测覆盖不到的）：
 *  - block.text_hash 的规范化与渲染时的规范化不一致导致的"假失效"
 *  - 保存流程给未修改的块写了新 revision，导致 cacheKey 抖动
 *  - 保存后块的 seq 变化影响路径渲染
 *  - previewTurn 里"上一轮调用"的查询与同模型判定
 *
 * ⚠️ 这个测试**必须在临时工作目录下运行**，因为 `getDb()` 用 process.cwd()
 * 定位 .data/nodes.db 与 schema.sql。运行方式见 npm run test:integration。
 * 顶部的守卫会在工作目录不对时直接失败，避免误写到仓库的真实数据库。
 */

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";

import { parseMarkdown } from "../../src/lib/blocks/parse-blocks.ts";

/* ------------------------------------------------------------------ *
 * 环境守卫：必须跑在临时目录里
 * ------------------------------------------------------------------ */

function assertIsolatedEnvironment(): void {
  const schemaPath = path.join(process.cwd(), "src", "lib", "db", "schema.sql");
  assert.ok(
    existsSync(schemaPath),
    `schema.sql 不在当前工作目录下（cwd=${process.cwd()}）。请通过 npm run test:integration 运行。`,
  );
  const pkgPath = path.join(process.cwd(), "package.json");
  assert.ok(existsSync(pkgPath), "当前工作目录看起来不是项目根目录");
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { name?: string };
  assert.equal(
    pkg.name,
    "nodes",
    "工作目录不是 nodes 项目根目录，拒绝运行以免污染真实数据库",
  );
}

assertIsolatedEnvironment();

// 动态 import：确保任何模块在被加载前，工作目录已经校验通过。
// 用命名空间对象而不是 `{ default: repo }` —— 这些是 CJS 源码，
// Node 的类型擦除把它们当 ESM 的命名空间处理，没有 default 导出。
const repo = await import("../../src/lib/db/repo.ts");
const { contentHash } = await import("../../src/lib/blocks/markdown.ts");
const { previewTurn } = await import("../../src/lib/ai/chat.ts");
const { computeCost } = await import("../../src/lib/cache/pricing.ts");
const { loadSourceBlocks } = await import("../../src/lib/cache/source.ts");
const { assembleContext } = await import("../../src/lib/cache/assemble.ts");
const { sortBlocksDeterministically } = await import("../../src/lib/cache/layers.ts");

/* ------------------------------------------------------------------ *
 * 测试脚手架
 * ------------------------------------------------------------------ */

const DOC_MARKDOWN = `# 发布流程

发布前必须确认三件事：灰度比例、回滚方案、监控看板。

## 回滚流程

回滚分两步：先把流量切回上一版本，再确认数据库迁移是否可逆。

\`\`\`bash
kubectl rollout undo deployment/api
\`\`\`

> 回滚不需要审批，但要立刻在群里同步。

## 监控看板

关键指标是错误率、P99 延迟、以及队列积压量。

## 灰度策略

灰度分四个批次推进，每批之间至少观察十五分钟，确认无异常再进入下一批。

第一批只放行内部账号，用来验证核心链路是否可用。这一批不承载真实流量，
因此出现问题时直接回滚即可，不需要额外的评估流程。

第二批放行百分之一的真实用户，重点观察错误率与登录成功率。这一批是
风险最高的一批，因为此时才会第一次接触真实流量的分布特征。

第三批放行百分之十，重点观察数据库连接池与下游依赖的容量水位。
到了这一批，任何容量问题都会以延迟上升的形式暴露出来。

第四批全量放行。全量之后仍然要保持至少一小时的观察窗口，
不要因为"已经全量了"就提前收工。

## 值班与沟通

发布窗口固定在每周二与周四的下午两点到五点，避免周五发布。

发布期间必须至少有一名值班人在线，负责盯看板与处理告警。

任何回滚决定都由值班人独立做出，不需要等待审批。
`;

/** 准备一个工作区 + 一篇带块的内容 + 一个可用的模型配置 */
function seedFixture(): {
  workspaceId: string;
  docId: string;
  modelId: string;
  conversationId: string;
  blockIds: string[];
} {  const ws = repo.getWorkspace();
  assert.ok(ws, "播种后应该存在默认工作区");

  const doc = repo.createDoc({ workspaceId: ws.id, title: "发布手册" });

  // 走真实的"保存 Markdown"路径，而不是直接插块
  const parsed = parseMarkdown(DOC_MARKDOWN);
  const saveResult = repo.saveDocBlocks(
    doc.id,
    parsed.map((p) => ({ kind: p.kind, text: p.text })),
    contentHash,
  );
  assert.ok(saveResult.created.length >= 6, `应至少解析出 6 个块，实际 ${saveResult.created.length}`);

  const blocks = repo.listBlocks(doc.id);
  assert.equal(blocks.length, parsed.length, "库里的块数应与解析结果一致");

  const model = repo.listModelConfigs()[0];
  assert.ok(model, "播种后应该存在默认模型配置");
  // 定价显式设成已知值，避免依赖内置价目表的具体数字
  repo.updateModelConfig(model.id, {
    inputPrice: 2,
    cachedInputPrice: 0.2,
    outputPrice: 8,
    contextWindow: 128000,
    supportsPromptCache: true,
  });

  const conversation = repo.createConversation({
    workspaceId: ws.id,
    title: "集成测试会话",
    modelConfigId: model.id,
  });

  return {
    workspaceId: ws.id,
    docId: doc.id,
    modelId: model.id,
    conversationId: conversation.id,
    blockIds: blocks.map((b) => b.id),
  };
}

/* ------------------------------------------------------------------ *
 * 1. 保存 → 载入 → 组装 的基本正确性
 * ------------------------------------------------------------------ */

test("Markdown 保存后能被载入为知识块，且路径包含标题层级", () => {
  const fx = seedFixture();
  const sources = loadSourceBlocks(fx.blockIds);

  assert.equal(sources.length, fx.blockIds.length);
  // 每个块都有 cacheKey 与可读路径
  for (const s of sources) {
    assert.equal(typeof s.cacheKey, "string");
    assert.equal(s.cacheKey.length, 16, "cacheKey 应是 16 位十六进制");
    assert.ok(s.path.startsWith("发布手册"), `路径应以文档名开头，实际 ${s.path}`);
  }

  // "回滚流程" 小节下的代码块，路径里应当出现该小节
  const codeBlock = sources.find((s) => s.kind === "code");
  assert.ok(codeBlock, "应当解析出代码块");
  assert.match(codeBlock.path, /回滚流程/, `代码块路径应含所属小节，实际 ${codeBlock.path}`);
});

test("块类型被正确识别（标题/段落/代码/引用）", () => {
  const fx = seedFixture();
  const sources = loadSourceBlocks(fx.blockIds);
  const kinds = new Set(sources.map((s) => s.kind));
  for (const expected of ["heading", "paragraph", "code", "quote"]) {
    assert.ok(kinds.has(expected as never), `应识别出 ${expected} 类型`);
  }
});

/* ------------------------------------------------------------------ *
 * 2. 最核心的一条：连续两轮真的产生缓存命中
 * ------------------------------------------------------------------ */

test("连续两轮对话：第二轮预测命中，且实际成本显著低于不缓存", () => {
  const fx = seedFixture();

  // 第一轮：冷启动
  const first = previewTurn({
    conversationId: fx.conversationId,
    content: "帮我把发布流程整理成检查清单",
    modelConfigId: fx.modelId,
    refBlockIds: fx.blockIds,
  });
  assert.ok(!("error" in first), "首轮预览不应报错");
  assert.equal(first.plan.prediction.verdict, "cold", "首轮必然是冷启动");
  assert.equal(first.plan.invalidation.reason, "cold_start");

  // 模拟第一轮真实发生：写入用户消息 + 助手回复 + 一条 invocation 记录。
  // 这一步必须走真实仓储，否则测不到"上一轮调用"的查询逻辑。
  const userMsg = repo.appendMessage({
    conversationId: fx.conversationId,
    role: "user",
    content: "帮我把发布流程整理成检查清单",
    refBlockIds: fx.blockIds,
  });
  const assistantMsg = repo.appendMessage({
    conversationId: fx.conversationId,
    role: "assistant",
    content: "## 发布检查清单\n\n1. 确认灰度比例\n2. 准备回滚方案\n3. 打开监控看板",
  });

  const firstPromptTokens = first.plan.totalTokens;
  // previewTurn 只返回展示用的分层信息，不含哈希。这里补一次真实组装拿到
  // 分层哈希 —— 下一轮的命中预测正是拿它作为"上一轮状态"的基准。
  const ws = repo.getWorkspace()!;
  const conv = repo.getConversation(fx.conversationId)!;
  const assembled1 = assembleContext({
    workspaceName: ws.name,
    persona: ws.persona,
    conventions: ws.conventions,
    blocks: loadSourceBlocks(fx.blockIds),
    history: [],
    turn: userMsg.content,
    sourceBudgetTokens: conv.sourceBudgetTokens,
    contextWindow: 128000,
    providerKind: "openai",
    previousLayerHashes: null,
    previousPromptTokens: null,
  });
  const layerHashes: Record<string, string> = {};
  for (const l of assembled1.layers) layerHashes[l.name] = l.hash;

  repo.recordInvocation({
    conversationId: fx.conversationId,
    messageId: assistantMsg.id,
    modelConfigId: fx.modelId,
    provider: "openai",
    model: "test-model",
    layerHashes,
    prefixHash: assembled1.prefixHash,
    stablePrefixTokens: assembled1.stablePrefixTokens,
    predictedCachedTokens: 0,
    predictedWriteTokens: firstPromptTokens,
    promptTokens: firstPromptTokens,
    cachedTokens: 0,
    cacheWriteTokens: 0,
    completionTokens: 40,
    actualUsd: 0,
    baselineUsd: 0,
    savedUsd: 0,
    latencyMs: 900,
    status: "ok",
    error: null,
    requestFingerprint: "test",
  });

  // 第二轮：应当命中
  const second = previewTurn({
    conversationId: fx.conversationId,
    content: "那回滚的时候要不要通知值班？",
    modelConfigId: fx.modelId,
    refBlockIds: fx.blockIds,
  });
  assert.ok(!("error" in second), "第二轮预览不应报错");

  const pred = second.plan.prediction;
  assert.equal(second.plan.invalidation.reason, "history_rewritten", "只有 L3 历史因追加而变化");
  assert.equal(second.plan.invalidation.fromLayer, "L3_history");
  assert.equal(pred.belowCacheFloor, false, "前缀应已越过最小可缓存长度");
  assert.ok(
    pred.predictedCachedTokens > 0,
    `第二轮应预测到缓存命中，实际 ${pred.predictedCachedTokens}`,
  );
  assert.ok(
    pred.predictedCachedTokens < pred.totalInputTokens,
    "命中不应超过总输入（L3 追加部分必然是新内容）",
  );

  // 分层验证：L0/L1/L2 都应标记为命中
  const byName = Object.fromEntries(second.plan.layers.map((l) => [l.name, l]));
  assert.equal(byName.L0_persona.unchanged, true);
  assert.equal(byName.L1_workspace.unchanged, true);
  assert.equal(byName.L2_source_index.unchanged, true);
  assert.equal(byName.L2_source_content.unchanged, true, "没有编辑块，L2 正文应保持命中");
  assert.equal(byName.L3_history.unchanged, false, "历史因追加而变化");

  // 成本核算：命中部分应按折扣价
  const usage = {
    promptTokens: pred.totalInputTokens,
    cachedTokens: pred.predictedCachedTokens,
    cacheWriteTokens: 0,
    completionTokens: 200,
  };
  const pricing = { input: 2, cachedInput: 0.2, output: 8, cacheWrite: 0 };
  const withCache = computeCost(usage, pricing);
  const withoutCache = computeCost({ ...usage, cachedTokens: 0 }, pricing);

  assert.ok(
    withCache.actualUsd < withoutCache.actualUsd,
    "有命中的成本必须低于无命中",
  );
  assert.ok(
    withCache.savedUsd > 0,
    `应计算出正数的节省金额，实际 ${withCache.savedUsd}`,
  );
  assert.ok(withCache.hitRate > 0.5, `命中率应高于 50%，实际 ${withCache.hitRate}`);
});

/* ------------------------------------------------------------------ *
 * 3. 追加式修订：不改的块不能产生新版本
 * ------------------------------------------------------------------ */

test("重复保存同样的 Markdown，不产生任何块变更（避免缓存键无谓抖动）", () => {
  const fx = seedFixture();
  const before = repo.listBlocks(fx.docId).map((b) => ({ id: b.id, hash: b.textHash }));

  const parsed = parseMarkdown(DOC_MARKDOWN);
  const result = repo.saveDocBlocks(
    fx.docId,
    parsed.map((p, i) => ({ id: fx.blockIds[i], kind: p.kind, text: p.text })),
    contentHash,
  );

  assert.equal(result.changed.length, 0, "内容未变不应有 changed");
  assert.equal(result.created.length, 0, "内容未变不应有 created");
  assert.equal(result.removed.length, 0, "内容未变不应有 removed");

  const after = repo.listBlocks(fx.docId).map((b) => ({ id: b.id, hash: b.textHash }));
  assert.deepEqual(after, before, "块的 id 与内容哈希都不应变化");
});

test("编辑一个块只让该块的 contentHash 变化，其它块保持稳定", () => {
  const fx = seedFixture();
  const before = repo.listBlocks(fx.docId);
  const target = before.find((b) => b.kind === "paragraph");
  assert.ok(target, "应存在段落块");

  const edited = DOC_MARKDOWN.replace(
    "发布前必须确认三件事：灰度比例、回滚方案、监控看板。",
    "发布前必须确认四件事：灰度比例、回滚方案、监控看板、值班人。",
  );
  const parsed = parseMarkdown(edited);
  repo.saveDocBlocks(
    fx.docId,
    parsed.map((p, i) => ({ id: fx.blockIds[i], kind: p.kind, text: p.text })),
    contentHash,
  );

  const after = repo.listBlocks(fx.docId);
  const changedIds = after
    .filter((b) => {
      const prev = before.find((x) => x.id === b.id);
      return !prev || prev.textHash !== b.textHash;
    })
    .map((b) => b.id);

  assert.equal(changedIds.length, 1, `应只有 1 个块变化，实际 ${changedIds.length}`);
  assert.equal(changedIds[0], target.id, "变化的应当是那个被编辑的段落");
});

test("空白差异不算内容变化（规范化在哈希前生效）", () => {
  const fx = seedFixture();
  const before = repo.listBlocks(fx.docId);
  const target = before.find((b) => b.kind === "paragraph")!;

  // 行尾加空格、把换行换成 CRLF —— 语义没变
  const parsed = parseMarkdown(DOC_MARKDOWN);
  const mutated = parsed.map((p) =>
    p.id === target.id ? p : { ...p, text: `${p.text}   `.replace(/\n/g, "\r\n") },
  );
  const result = repo.saveDocBlocks(
    fx.docId,
    mutated.map((p, i) => ({ id: fx.blockIds[i], kind: p.kind, text: p.text })),
    contentHash,
  );

  assert.equal(result.changed.length, 0, "只有空白差异时不应判定为内容变更");
});

/* ------------------------------------------------------------------ *
 * 4. 引用集合与排序
 * ------------------------------------------------------------------ */

test("引用集合以任意顺序传入，载入后按稳定键排序", () => {
  const fx = seedFixture();
  const forward = loadSourceBlocks(fx.blockIds);
  const backward = loadSourceBlocks([...fx.blockIds].reverse());

  const sortForward = sortBlocksDeterministically(forward).map((b) => b.id);
  const sortBackward = sortBlocksDeterministically(backward).map((b) => b.id);
  assert.deepEqual(sortForward, sortBackward, "不同传入顺序应得到同一排序结果");
});

test("删掉一个块后，它从引用集合中消失且不破坏其它块", () => {
  const fx = seedFixture();
  const before = repo.listBlocks(fx.docId);
  const victim = before.find((b) => b.kind === "quote")!;

  // 从 Markdown 里移除引用块。客户端此时**仍然按旧位置回传 blockIds**
  // （它只是把被删的那一项去掉，后面的 id 整体前移了一位）——
  // 这正是真实编辑器会发生的情形，服务端必须靠内容哈希兜住。
  const withoutQuote = DOC_MARKDOWN.replace("> 回滚不需要审批，但要立刻在群里同步。\n", "");
  const parsed = parseMarkdown(withoutQuote);

  const victimIndex = before.findIndex((b) => b.id === victim.id);
  const shifted = fx.blockIds.filter((_, i) => i !== victimIndex);

  const result = repo.saveDocBlocks(
    fx.docId,
    parsed.map((p, i) => ({ id: shifted[i], kind: p.kind, text: p.text })),
    contentHash,
    fx.blockIds,
  );

  assert.ok(result.removed.includes(victim.id), "被移除的块应记录进 removed");
  assert.equal(result.created.length, 0, "删除一段不应导致任何块被当成新块重建");
  assert.equal(result.changed.length, 0, "删除一段不应改动任何块的内容");

  const after = repo.listBlocks(fx.docId).filter((b) => b.seq >= 0);
  assert.equal(after.length, before.length - 1);
  assert.equal(
    after.some((b) => b.id === victim.id),
    false,
    "软删除的块不应再出现在当前块列表中",
  );

  // 幸存块的 id 必须原样保留 —— 这是缓存不被无谓击穿的前提
  const survivors = before.filter((b) => b.id !== victim.id).map((b) => b.id);
  const afterIds = after.map((b) => b.id);
  assert.deepEqual(
    [...afterIds].sort(),
    [...survivors].sort(),
    "除被删块外，其余块的 id 必须完全不变",
  );
});

test("在文档中间插入一段，不应让后续所有块被当成新块（id 错位兜底）", () => {
  const fx = seedFixture();
  const before = repo.listBlocks(fx.docId);
  const beforeIds = before.map((b) => b.id);

  // 在第 3 段之后插入一段新内容
  const inserted = DOC_MARKDOWN.replace(
    "## 回滚流程",
    "新增一段：本次发布由张三负责值班。\n\n## 回滚流程",
  );
  const parsed = parseMarkdown(inserted);

  // 模拟客户端的错位回传：新插入的那一项没有 id，后面整体后移
  const misaligned = [...fx.blockIds.slice(0, 3), undefined, ...fx.blockIds.slice(3)];

  const result = repo.saveDocBlocks(
    fx.docId,
    parsed.map((p, i) => ({ id: misaligned[i], kind: p.kind, text: p.text })),
    contentHash,
    beforeIds,
  );

  assert.equal(result.created.length, 1, "只应新增 1 个块（插入的那一段）");
  assert.equal(result.changed.length, 0, "插入不应改动任何既有块的内容");
  assert.equal(result.removed.length, 0, "插入不应删除任何块");

  const after = repo.listBlocks(fx.docId).filter((b) => b.seq >= 0);
  assert.equal(after.length, before.length + 1);

  const afterIdSet = new Set(after.map((b) => b.id));
  for (const id of beforeIds) {
    assert.ok(afterIdSet.has(id), `既有块 ${id} 的 id 应被保留，而不是被重建`);
  }
});

/* ------------------------------------------------------------------ *
 * 4.1 重复内容的块：编辑时必须各归各位
 *
 * 这是审计发现的一个真实缺陷，危害是**内容张冠李戴**：
 *
 * 文档里有 `dupe / other / dupe` 三段，编辑**靠前**那段时，
 * 它的哈希不再匹配，而靠后那段仍在候选里，于是"第一个未认领的候选"
 * 把靠后那段的 id 发给了靠前的位置。结果两个块的 id 对调：
 *
 *   - 任何引用"靠后那段"id 的会话，会拿到编辑后的内容（内容错了）；
 *   - 靠后那段自己换了个新 id，原 id 被软删。
 *
 * 文档顺序里**重复文字**其实很常见（TODO、待补、`-`、占位标题），
 * 所以这不是构造出来的极端输入。修法是：认领时要求 kind 相同，
 * 并在同内容候选里取**位置最近**的那个。
 * ------------------------------------------------------------------ */

test("重复内容的块：编辑靠前的那一段，两段各自的 id 都不能变", () => {
  const fx = seedFixture();

  // 造一个"首尾文字完全相同"的文档
  const dupDoc = repo.createDoc({
    workspaceId: repo.getWorkspace()!.id,
    parentId: null,
    title: "重复块测试",
    kind: "doc",
  });
  const first = repo.saveDocBlocks(
    dupDoc.id,
    [
      { kind: "paragraph", text: "dupe" },
      { kind: "paragraph", text: "other" },
      { kind: "paragraph", text: "dupe" },
    ],
    contentHash,
  );
  assert.equal(first.created.length, 3, "前置条件：三个块都应当新建");

  const idsBefore = repo
    .listBlocks(dupDoc.id)
    .filter((b) => b.seq >= 0)
    .map((b) => b.id);
  assert.equal(idsBefore.length, 3);

  // 只改**靠前**那个 dupe，并把旧 id 序列原样回传（编辑器的真实行为）
  repo.saveDocBlocks(
    dupDoc.id,
    [
      { kind: "paragraph", text: "dupe EDITED" },
      { kind: "paragraph", text: "other" },
      { kind: "paragraph", text: "dupe" },
    ],
    contentHash,
    idsBefore,
  );

  const after = repo.listBlocks(dupDoc.id).filter((b) => b.seq >= 0);
  assert.equal(after.length, 3, "不应多出或少于三个块");

  // 位置 0：内容变了，但 id 必须是原来位置 0 的那个
  assert.equal(
    after[0].id,
    idsBefore[0],
    "被编辑的块必须保留自己的 id —— 换了 id 就等于对引用它的会话说「这个块没了」",
  );
  assert.match(after[0].text, /EDITED/);

  // 位置 2：内容没变，id 也必须不变。这一条正是原缺陷的反面
  assert.equal(after[2].id, idsBefore[2], "未被触碰的重复块不能被抢走 id");
  assert.equal(after[2].text.trim(), "dupe");
});

test("重复内容的块：内容完全不变时，重复保存不得让任何 id 漂移", () => {
  const dupDoc = repo.createDoc({
    workspaceId: repo.getWorkspace()!.id,
    parentId: null,
    title: "重复块幂等测试",
    kind: "doc",
  });
  repo.saveDocBlocks(
    dupDoc.id,
    [
      { kind: "paragraph", text: "same" },
      { kind: "paragraph", text: "same" },
      { kind: "paragraph", text: "same" },
    ],
    contentHash,
  );
  const ids = repo
    .listBlocks(dupDoc.id)
    .filter((b) => b.seq >= 0)
    .map((b) => b.id);

  // 原样再存一次（自动保存会反复发生）
  repo.saveDocBlocks(
    dupDoc.id,
    [
      { kind: "paragraph", text: "same" },
      { kind: "paragraph", text: "same" },
      { kind: "paragraph", text: "same" },
    ],
    contentHash,
    ids,
  );

  const after = repo
    .listBlocks(dupDoc.id)
    .filter((b) => b.seq >= 0)
    .map((b) => b.id);
  assert.deepEqual(after, ids, "没有内容变化时，id 序列必须逐位相同");
});

test("改块类型（段落↔标题）时 id 仍要保留，只是走 revision", () => {
  const typeDoc = repo.createDoc({
    workspaceId: repo.getWorkspace()!.id,
    parentId: null,
    title: "改类型测试",
    kind: "doc",
  });
  repo.saveDocBlocks(typeDoc.id, [{ kind: "paragraph", text: "标题文字" }], contentHash);
  const before = repo.listBlocks(typeDoc.id).filter((b) => b.seq >= 0)[0];

  repo.saveDocBlocks(
    typeDoc.id,
    [{ kind: "heading", text: "# 标题文字" }],
    contentHash,
    [before.id],
  );

  const after = repo.listBlocks(typeDoc.id).filter((b) => b.seq >= 0)[0];
  assert.equal(after.id, before.id, "改类型不应换 id —— 那会把引用它的会话全部击穿");
  assert.equal(after.kind, "heading", "类型要真的更新");
});

/* ------------------------------------------------------------------ *
 * 5. 预算裁剪在真实数据上生效
 * ------------------------------------------------------------------ */

test("把预算调到很小，正文被裁剪但清单仍完整", () => {
  const fx = seedFixture();
  repo.updateConversation(fx.conversationId, { sourceBudgetTokens: 120 });

  const preview = previewTurn({
    conversationId: fx.conversationId,
    content: "总结一下",
    modelConfigId: fx.modelId,
    refBlockIds: fx.blockIds,
  });
  assert.ok(!("error" in preview), "预览不应报错");

  assert.ok(preview.plan.omittedBlockIds.length > 0, "小预算下应有块未展开");
  assert.ok(
    preview.plan.warnings.some((w) => w.includes("未展开正文")),
    "应给出裁剪警告",
  );
  assert.equal(
    preview.plan.blockTokens.length,
    fx.blockIds.length,
    "清单里仍应列出全部块",
  );
});

/* ------------------------------------------------------------------ *
 * 6. 缓存统计聚合
 * ------------------------------------------------------------------ */

test("getCacheStats 正确聚合命中率与节省金额", () => {
  const fx = seedFixture();
  /*
   * 每个测试都在同一个进程里共用同一个数据库，而本应用是"单工作区"设计
   * （getWorkspace() 永远返回第一个），所以没法靠新建工作区来隔离统计。
   * 做法改为**看增量**：先记一份基线，再写入本测试的调用，然后比差值。
   * 这样无论别的测试往库里写了什么，本测试的断言都是确定的。
   */
  const before = repo.getCacheStats(fx.workspaceId, 0);

  const conv = repo.createConversation({
    workspaceId: fx.workspaceId,
    title: "统计专用会话",
    modelConfigId: fx.modelId,
  });

  const base = {
    conversationId: conv.id,
    messageId: null,
    modelConfigId: fx.modelId,
    provider: "openai",
    model: "test-model",
    layerHashes: { L0_persona: "h" },
    prefixHash: "p",
    stablePrefixTokens: 5000,
    predictedCachedTokens: 0,
    predictedWriteTokens: 0,
    completionTokens: 100,
    cacheWriteTokens: 0,
    latencyMs: 100,
    status: "ok",
    error: null,
    requestFingerprint: "f",
  };

  repo.recordInvocation({
    ...base,
    promptTokens: 10000,
    cachedTokens: 0,
    actualUsd: 0.02,
    baselineUsd: 0.02,
    savedUsd: 0,
  });
  repo.recordInvocation({
    ...base,
    promptTokens: 10000,
    cachedTokens: 9000,
    actualUsd: 0.004,
    baselineUsd: 0.02,
    savedUsd: 0.016,
  });
  // 失败的调用不应计入统计
  repo.recordInvocation({
    ...base,
    promptTokens: 99999,
    cachedTokens: 0,
    actualUsd: 9.99,
    baselineUsd: 9.99,
    savedUsd: 0,
    status: "error",
  });

  const after = repo.getCacheStats(fx.workspaceId, 0);
  const delta = {
    invocations: after.invocations - before.invocations,
    promptTokens: after.promptTokens - before.promptTokens,
    cachedTokens: after.cachedTokens - before.cachedTokens,
    savedUsd: after.savedUsd - before.savedUsd,
  };

  assert.equal(delta.invocations, 2, "失败轮次不应计入（写入 3 条，只应算 2 条）");
  assert.equal(delta.promptTokens, 20000, "失败轮次的 token 不应计入");
  assert.equal(delta.cachedTokens, 9000);
  assert.ok(Math.abs(delta.savedUsd - 0.016) < 1e-9);

  // 命中率用总量算，所以这里验证"新增了 9000/20000 的命中"体现在整体比率里
  const expectedHitRate = after.cachedTokens / after.promptTokens;
  assert.ok(Math.abs(after.hitRate - expectedHitRate) < 1e-12);

  const convRow = after.byConversation.find((c) => c.conversationId === conv.id);
  assert.ok(convRow, "统计专用会话应出现在会话排行里");
  assert.equal(convRow.invocations, 2);
  assert.equal(convRow.hitRate, 0.45, "该会话命中率应是 9000/20000");
  assert.ok(Math.abs(convRow.savedUsd - 0.016) < 1e-9);
});
