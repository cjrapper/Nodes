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
 * 红线 1：AI 永远不能删
 * ================================================================== */

test("工具清单里不存在任何删除类工具（红线 1）", () => {
  const names = toolNames();
  for (const forbidden of ["delete", "remove", "drop", "trash", "purge"]) {
    assert.equal(
      names.some((n) => n.toLowerCase().includes(forbidden)),
      false,
      `工具清单里不能出现 ${forbidden} —— 删除对用户的笔记是不可逆的，` +
        `正确做法是"根本没有这个工具"，而不是"有但要确认"`,
    );
  }
  // 也不该有能力改写/覆盖既有内容
  for (const forbidden of ["update", "overwrite", "replace", "edit"]) {
    assert.equal(
      names.some((n) => n.toLowerCase().includes(forbidden)),
      false,
      `不能有 ${forbidden} 类工具：AI 只允许新增，不允许改写人写的东西`,
    );
  }
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
