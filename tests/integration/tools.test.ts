/**
 * AI 工具集的回归测试。
 *
 * ## 这里守的是什么
 *
 * 这批工具是**唯一允许 AI 碰用户笔记的地方**，所以断言必须钉在
 * `docs/agent-write-policy.md` 的红线上，而不是"函数能跑通"。
 *
 * 三条红线各有对应的判据：
 *  1. AI 永远不能删  → 工具清单里**不存在**删除类工具（断言名字清单）
 *  2. AI 不能改人写的块 → `append_blocks` 之后，既有块的 id 与文本一字未变
 *  3. 每笔写入落审计 → 每次执行（含失败）都留下一条 tool_call 记录
 *
 * ## 为什么"既有块一字未变"这条必须单独测
 *
 * 因为 `saveDocBlocks` 是**整篇替换**语义：本次没出现的块全部被软删。
 * 所以"往文档追加一段"如果实现成"只把新块写上去"，会**一次抹掉整篇文档** ——
 * 而且接口会返回成功、新块确实写进去了，只有回头翻文档才发现旧内容没了。
 * 这是本次改动里最容易出、也最难发现的一种破坏。
 */

import assert from "node:assert/strict";
import { test } from "node:test";

/*
 * ⚠️ 这里必须用 `../../src/...` 的动态 import，不能用 `../src/...` 的静态 import。
 *
 * 集成测试的运行方式是把 `src/` 与 `tests/` 复制到一个临时目录，然后在
 * **临时目录根**执行 `tests/integration/run.mjs`。所以从
 * `<tmp>/tests/integration/tools.test.ts` 出发，源码在 `../../src/`，
 * 写成 `../src/` 会去找 `<tmp>/tests/src/...` —— 报一个 ENOENT，
 * 而且症状是"测试文件根本没被跑、总数凭空少一截"，不是一眼能看出的失败。
 *
 * 单测（tests/*.test.ts）跑在仓库根，所以那边用 `../src/` 的静态 import 是对的。
 * 两处的相对层级不同，这是环境差异，不是笔误。
 */
const repo = await import("../../src/lib/db/repo.ts");
const { contentHash } = await import("../../src/lib/blocks/markdown.ts");
const { TOOL_SPECS, findTool, toolDefinitions, toolNames } = await import(
  "../../src/lib/ai/tools.ts"
);

function makeContext() {
  const ws = repo.getWorkspace()!;
  return {
    conversationId: "conv_tool_test",
    messageId: "msg_tool_test",
    modelConfigId: null,
    workspaceId: ws.id,
    round: 1,
  };
}

/** 建一篇带内容的文档，返回文档与其块 */
function makeDoc(title: string, paragraphs: string[]) {
  const ws = repo.getWorkspace()!;
  const doc = repo.createDoc({ workspaceId: ws.id, title });
  repo.saveDocBlocks(
    doc.id,
    paragraphs.map((text) => ({ kind: "paragraph" as const, text })),
    contentHash,
  );
  return { doc, blocks: repo.listBlocks(doc.id).filter((b) => b.seq >= 0) };
}

async function run(toolName: string, args: Record<string, unknown>) {
  const spec = findTool(toolName);
  assert.ok(spec, `工具 ${toolName} 不存在`);
  return spec.run(args, makeContext());
}

/* ================================================================== *
 * 策略转变：从「不许做危险动作」改成「每个动作都可撤销」
 *
 * 这里曾经断言"工具清单里不存在 delete / update / rename 类工具"，
 * 也就是早期那条"AI 只能追加"的红线。
 *
 * 那条红线**已经按用户要求放开了**，理由写在 `docs/agent-write-policy.md`：
 * 只能追加的助手当不了导师 —— 它没法说"这两篇该合并""这块放错分类了"
 * "这段理解是错的"，只能往后面贴补丁。
 *
 * ⚠️ 所以这一节不是"删掉了旧测试"，而是**换了判据**：
 * 以前问"有没有危险工具"，现在问"危险动作是否真的可逆"。
 * 少了下半部分，这次放开就只是一次没有防护的权限扩张。
 * ================================================================== */

test("可重组工具都在清单里（update / rename / delete）", () => {
  const names = toolNames();
  for (const required of ["update_doc", "rename_doc", "delete_doc"]) {
    assert.ok(
      names.includes(required),
      `缺少 ${required} —— AI 整理知识需要它，只能追加的助手当不了导师`,
    );
  }
});

test("update_doc 的描述明确允许删减与覆盖（守卫已按要求放开）", () => {
  /*
   * 这条守的是**语义而不是实现**：`update_doc` 曾经有一道"原文一字不丢"
   * 的守卫，描述里写着"必须原样保留，否则会被拒绝"。
   *
   * 用户的要求是「原文可以删，或者说是覆盖」—— 那条守卫被放开了。
   * 如果描述还留着旧措辞，模型会因为怕被拒而不敢删减，
   * 于是**功能上放开了、行为上没放开**：它在描述里读到禁令就不做了。
   *
   * 所以描述必须明说"可以删减"。
   */
  const spec = TOOL_SPECS.find((s) => s.definition.name === "update_doc");
  assert.ok(spec, "update_doc 必须在工具清单里");
  const desc = spec.definition.description;
  assert.match(desc, /删减|覆盖/, "描述必须明确允许删减/覆盖，否则模型不敢做");
  assert.doesNotMatch(
    desc,
    /必须原样保留|会被拒绝/,
    "不能留旧守卫的措辞 —— 那会让模型在行为上自我审查",
  );
  // 同时必须告诉它撤销的存在：那是放开之后唯一的约束来源
  assert.match(desc, /撤销|快照/, "要说明改动可撤销，这既是提醒也是它的责任边界");
});

test("每个写入类工具都必须登记在某个可撤销类别里", () => {
  /*
   * 这是放开之后的**核心不变量**。
   *
   * 判据不能是"有没有危险工具"（那正是被放开的），而必须是：
   * **每一个会改数据的工具，都留下了足以还原的材料。**
   *
   * 内容类 → `snapshotMarkdown`；元数据类 → `beforeState`。
   * 一个既不属于内容类、也不属于元数据类的写入工具 =
   * 用户被改坏了也退不回去 —— 那才是真正不可接受的状态。
   *
   * ⚠️ 这里只保证"工具被登记过"。**撤销确实能还原**由
   * `undo.test.ts` 对每个工具跑真实撤销来保证 —— 那张表漏登记会在这里变红，
   * 登记了但撤销实现写错会在那边变红，两层缺一不可。
   */
  const contentUndoable = new Set(["append_blocks", "update_doc"]);
  const metaUndoable = new Set([
    "create_doc",
    "create_module",
    "update_doc",
    "rename_doc",
    "delete_doc",
  ]);

  for (const spec of TOOL_SPECS) {
    if (!spec.writes) continue;
    const name = spec.definition.name;
    assert.ok(
      contentUndoable.has(name) || metaUndoable.has(name),
      `写入类工具 ${name} 没有登记撤销材料 —— ` +
        `放开权限的同时必须保证每个动作都可逆（见 docs/agent-write-policy.md）`,
    );
  }

  // 反向：写类工具不能只有读类的那几个，否则上面这条循环会空转通过
  assert.ok(
    TOOL_SPECS.filter((s) => s.writes).length >= 5,
    "写入类工具应当有若干个，数量异常说明上面的检查可能在空转",
  );
});

test("删除工具存在，但含子文档的模块会被拒绝（用户明确要求保留的保护）", async () => {
  const ws = repo.getWorkspace()!;
  const parent = repo.createDoc({ workspaceId: ws.id, title: "删除保护-模块", kind: "module" });
  const child = repo.createDoc({
    workspaceId: ws.id,
    parentId: parent.id,
    title: "删除保护-子文档",
  });

  const result = await run("delete_doc", { docId: parent.id });
  assert.equal(result.isError, true, "含子文档的模块必须拒绝删除");
  assert.match(result.content, /拒绝整棵删除/);
  // 关键：拒绝之后什么都没动
  assert.ok(repo.getDoc(parent.id), "被拒绝的删除不能真的删掉它");
  assert.ok(repo.getDoc(child.id), "子文档也必须原样还在");
});

test("删除工具对没有子文档的文档生效，且进的是回收站（可恢复）", async () => {
  // makeDoc 返回 { doc, blocks }，这里要的是 doc
  const { doc } = makeDoc("删除保护-独立文档", ["要被删掉的内容。"]);
  const result = await run("delete_doc", { docId: doc.id });
  assert.equal(result.isError, undefined, `应当删除成功，实际：${result.content}`);
  assert.equal(repo.getDoc(doc.id), null, "删除后不该还能查到");
  assert.equal(
    repo.listDeletedDocs(repo.getWorkspace()!.id).some((d) => d.id === doc.id),
    true,
    "必须在回收站里 —— 可恢复是放开删除的前提",
  );
  assert.ok(result.beforeState, "删除必须留下元数据快照，否则撤销无从下手");
});

test("工具定义与实现同源，不会漂移", () => {
  assert.equal(
    toolDefinitions().length,
    TOOL_SPECS.length,
    "provider 拿到的定义必须就是注册表里那份",
  );
  for (const def of toolDefinitions()) {
    assert.ok(findTool(def.name), `${def.name} 有定义却没有实现`);
    assert.equal(def.parameters["type"], "object", `${def.name} 的参数 schema 必须是 object`);
  }
});

/* ================================================================== *
 * 读工具：让模型知道用户已经写过什么
 * ================================================================== */

test("list_docs 能列出文档与模块，并带上 id 与层级", async () => {
  const ws = repo.getWorkspace()!;
  const module = repo.createDoc({ workspaceId: ws.id, title: "工具测试模块", kind: "module" });
  const child = repo.createDoc({
    workspaceId: ws.id,
    parentId: module.id,
    title: "工具测试子文档",
  });

  const result = await run("list_docs", {});
  assert.equal(result.isError, undefined);
  assert.match(result.content, /工具测试模块/);
  assert.match(result.content, /工具测试子文档/);
  assert.match(result.content, new RegExp(module.id), "必须带 id，否则模型无法继续调用别的工具");
  assert.match(result.content, /模块/, "必须区分模块与文档");
  assert.ok(child.id);
});

test("read_doc 返回正文；不存在的 id 给出可行动的错误而不是抛异常", async () => {
  const { doc } = makeDoc("工具测试-读", ["第一段正文。", "第二段正文。"]);

  const ok = await run("read_doc", { docId: doc.id });
  assert.equal(ok.isError, undefined);
  assert.match(ok.content, /第一段正文/);
  assert.match(ok.content, /第二段正文/);

  const bad = await run("read_doc", { docId: "doc_不存在" });
  assert.equal(bad.isError, true);
  assert.match(bad.content, /list_docs/, "错误信息要告诉模型下一步怎么做");
});

test("search_blocks 命中与未命中都给可用信息", async () => {
  makeDoc("工具测试-搜索", ["这段里有专用标记词 QRST。"]);

  const hit = await run("search_blocks", { query: "专用标记词 QRST" });
  assert.equal(hit.isError, undefined);
  assert.match(hit.content, /工具测试-搜索/);

  const miss = await run("search_blocks", { query: "绝不可能存在的词ZZZZ" });
  assert.equal(miss.isError, undefined, "搜不到不是错误");
  assert.match(miss.content, /没有搜到/);
});

/* ================================================================== *
 * 红线 2：只能追加，不能改写
 * ================================================================== */

test("append_blocks 之后既有块的 id 与文本一字未变（红线 2）", async () => {
  const { doc, blocks } = makeDoc("工具测试-追加", ["原有的第一段。", "原有的第二段。"]);
  const beforeIds = blocks.map((b) => b.id);
  const beforeTexts = blocks.map((b) => b.text);
  const beforeHashes = blocks.map((b) => b.textHash);

  const result = await run("append_blocks", {
    docId: doc.id,
    markdown: "追加的一段。\n\n再追加一段。",
  });
  assert.equal(result.isError, undefined);

  const after = repo.listBlocks(doc.id).filter((b) => b.seq >= 0 && b.text.trim() !== "");
  const afterById = new Map(after.map((b) => [b.id, b]));

  for (const [i, id] of beforeIds.entries()) {
    const kept = afterById.get(id);
    assert.ok(
      kept,
      `既有块 ${id} 在追加后消失了 —— 这说明实现用了整篇替换，` +
        `会一次抹掉用户写的整篇内容`,
    );
    assert.equal(kept.text, beforeTexts[i], "既有块的文本不能被改动");
    assert.equal(
      kept.textHash,
      beforeHashes[i],
      "textHash 必须不变 —— 它决定 cacheKey，一变就意味着引用这篇文档的所有会话缓存被击穿",
    );
  }

  assert.equal(after.length, 4, "应当是 2 个原有块 + 2 个追加块");
  assert.match(result.content, /原有 2 块未改动/);
});

test("往模块追加正文被拒绝（按约定模块不写正文）", async () => {
  const ws = repo.getWorkspace()!;
  const module = repo.createDoc({ workspaceId: ws.id, title: "工具测试-纯模块", kind: "module" });

  const result = await run("append_blocks", { docId: module.id, markdown: "想往模块里塞正文。" });
  assert.equal(result.isError, true);
  assert.match(result.content, /模块/, "要说清为什么不行");
  assert.equal(
    repo.listBlocks(module.id).filter((b) => b.text.trim() !== "").length,
    0,
    "被拒绝就不该有任何写入",
  );
});

test("追加内容是空白时不做任何改动", async () => {
  const { doc, blocks } = makeDoc("工具测试-空追加", ["原有内容。"]);

  const result = await run("append_blocks", { docId: doc.id, markdown: "   \n\n  " });
  assert.equal(result.isError, true);
  assert.equal(
    repo.listBlocks(doc.id).filter((b) => b.seq >= 0 && b.text.trim() !== "").length,
    blocks.length,
    "空追加不能动文档",
  );
});

test("缺少必填参数时明确报错，不静默成功", async () => {
  const missing = await run("append_blocks", { docId: "x" });
  assert.equal(missing.isError, true);
  assert.match(missing.content, /markdown/, "要指出缺的是哪个参数");

  const noTitle = await run("create_doc", {});
  assert.equal(noTitle.isError, true);
  assert.match(noTitle.content, /title/);
});

/* ================================================================== *
 * 写工具：新建
 * ================================================================== */

test("create_doc 建出文档、写入正文、并打上来源标记", async () => {
  const result = await run("create_doc", {
    title: "工具测试-新建",
    markdown: "# 小标题\n\n一段正文。",
  });
  assert.equal(result.isError, undefined);
  assert.ok(result.targetDocId, "要回报文档 id，前端据此给跳转");

  const doc = repo.getDoc(result.targetDocId!);
  assert.ok(doc);
  assert.equal(doc.title, "工具测试-新建");
  assert.equal(
    doc.icon,
    "sparkles",
    "AI 建的文档要能被一眼认出来（策略文档的可见性要求）",
  );
  assert.ok(
    repo.listBlocks(doc.id).filter((b) => b.seq >= 0 && b.text.trim() !== "").length > 0,
    "正文应当被真的写进块表",
  );
});

test("create_doc 的 parentId 不存在时拒绝，而不是建出一篇挂空的文档", async () => {
  const before = repo.listDocs(repo.getWorkspace()!.id).length;
  const result = await run("create_doc", { title: "工具测试-挂空", parentId: "doc_不存在" });

  assert.equal(result.isError, true);
  assert.equal(
    repo.listDocs(repo.getWorkspace()!.id).length,
    before,
    "被拒绝的调用不能留下任何文档",
  );
});

test("超长标题被截断（模型会把一整段话当标题）", async () => {
  const long = "很长的标题".repeat(30);
  const result = await run("create_doc", { title: long });
  const doc = repo.getDoc(result.targetDocId!);
  assert.ok(doc);
  assert.ok(doc.title.length <= 81, `标题应被截断，实际长度 ${doc.title.length}`);
  assert.match(doc.title, /…$/);
});

/* ================================================================== *
 * 工具的返回契约
 * ================================================================== */

test("所有工具都必须返回非空 content（空串会让服务商报错）", async () => {
  const cases: [string, Record<string, unknown>][] = [
    ["list_docs", {}],
    ["read_doc", { docId: "doc_不存在" }],
    ["search_blocks", { query: "随便" }],
    ["append_blocks", { docId: "doc_不存在", markdown: "x" }],
    ["create_doc", {}],
  ];

  for (const [name, args] of cases) {
    const result = await run(name, args);
    assert.ok(
      result.content.trim().length > 0,
      `${name} 返回了空 content —— 服务商要求 content 与 tool_calls 不能同时为空，` +
        `空串会污染之后每一轮请求`,
    );
  }
});
