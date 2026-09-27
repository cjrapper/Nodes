/**
 * AI 工具注册表。
 *
 * 这是「全自动整理知识」唯一允许碰用户数据的地方。权限策略写在
 * `docs/agent-write-policy.md`，这里逐条落成代码，并在注释里标明对应哪一条。
 *
 * ## 三条红线在代码里的形态
 *
 * 1. **AI 永远不能删。** 这个数组里**没有**删除工具 —— 不是"有一个需要确认的
 *    删除工具"，是根本不存在。`deleteDoc` 是硬删（现已改软删，但仍然
 *    不该由模型触发）。
 * 2. **AI 不能改人写的块。** 没有"改写块"工具，只有 `append_blocks`，
 *    它的语义是"读当前 markdown → 追加 → 整篇写回"，既有的块 id 与内容
 *    一字不动（见 `appendBlocks` 的实现与它的回归测试）。
 * 3. **每笔写入落审计。** 所有工具执行（含失败）都写 `tool_call` 表，
 *    写入类工具额外保存**动手前的整篇快照** —— 那是"一键撤销"的载体。
 *
 * ## 工具集必须近乎静态
 *
 * 工具定义位于请求体的最前面（Anthropic 的缓存顺序是 tools → system →
 * messages，OpenAI 兼容系的 chat 模板同样如此），所以"按当前问题动态挑几个
 * 工具"这种看起来很聪明的优化，会让整段前缀每轮失效，把前缀缓存全吃掉
 * —— 而缓存命中是这个应用的立身之本。
 * 所以这里是**常量数组**，不按上下文裁剪。
 */

import * as repo from "../db/repo";
import { contentHash } from "../blocks/markdown";
import { parseMarkdown, serializeBlocks } from "../blocks/parse-blocks";
import type { ToolDefinition } from "../providers/types";

export interface ToolContext {
  conversationId: string;
  messageId: string;
  modelConfigId: string | null;
  workspaceId: string;
  /** 当前是第几轮工具调用（审计与 UI 用） */
  round: number;
}

export interface ToolResult {
  /** 回传给模型的文本。**必须是有内容的字符串** —— 空串会让服务商报
   * "content or tool_calls must be set"，而且会污染之后每一轮。 */
  content: string;
  /** 是否失败。失败也要回传（模型需要知道并据此调整），不要静默丢弃。 */
  isError?: boolean;
  /** 给 UI 的一句话摘要 */
  summary: string;
  /** 写入类工具动到的文档，前端可据此给出跳转 */
  targetDocId?: string;
  /** 撤销时用：动手前的整篇 markdown */
  snapshotMarkdown?: string | null;
}

interface ToolSpec {
  definition: ToolDefinition;
  /** 是否属于"写入类"：决定要不要存快照、UI 要不要高亮 */
  writes: boolean;
  run: (args: Record<string, unknown>, ctx: ToolContext) => ToolResult | Promise<ToolResult>;
}

/* ------------------------------------------------------------------ *
 * 参数读取小工具：模型给的参数不可信，一律当作 unknown 校验
 * ------------------------------------------------------------------ */

function requireString(
  args: Record<string, unknown>,
  key: string,
  label: string,
): { ok: true; value: string } | { ok: false; error: string } {
  const raw = args[key];
  if (typeof raw !== "string" || raw.trim() === "") {
    return { ok: false, error: `缺少必填参数 ${key}（${label}）` };
  }
  return { ok: true, value: raw.trim() };
}

function optionalString(args: Record<string, unknown>, key: string): string | undefined {
  const raw = args[key];
  return typeof raw === "string" && raw.trim() !== "" ? raw.trim() : undefined;
}

/** 标题长度保护：模型偶尔会生成一整段话当标题 */
function clampTitle(title: string): string {
  const oneLine = title.replace(/\s+/g, " ").trim();
  return oneLine.length > 80 ? `${oneLine.slice(0, 80)}…` : oneLine;
}

/* ------------------------------------------------------------------ *
 * 工具实现
 * ------------------------------------------------------------------ */

/**
 * 列出知识库的文档树。
 *
 * 这是**第一个**该给模型的读工具：没有它，模型只会凭空建议"你应该补一篇
 * 关于 X 的笔记"，而不知道你已经写了一篇。有它才能说"你那篇《X》里缺 Y"。
 */
function listDocs(): ToolResult {
  const docs = repo.listDocs(repo.getWorkspace()!.id);
  if (docs.length === 0) {
    return {
      content: "知识库还是空的：没有任何文档或模块。",
      summary: "知识库为空",
    };
  }

  const byId = new Map(docs.map((d) => [d.id, d]));
  /** 缩进层级：靠 parentId 往上数，带上环保护 */
  const depthOf = (id: string): number => {
    let depth = 0;
    let cursor = byId.get(id)?.parentId ?? null;
    const guard = new Set<string>();
    while (cursor && !guard.has(cursor)) {
      guard.add(cursor);
      depth += 1;
      cursor = byId.get(cursor)?.parentId ?? null;
    }
    return Math.min(depth, 6);
  };

  const lines = docs.map((doc) => {
    const indent = "  ".repeat(depthOf(doc.id));
    const kind = doc.kind === "module" ? "模块" : "文档";
    return `${indent}- [${kind}] ${doc.title || "（无标题）"}  id=${doc.id}`;
  });

  const modules = docs.filter((d) => d.kind === "module").length;
  return {
    content: [
      `知识库共 ${docs.length} 项（其中模块 ${modules} 个）：`,
      ...lines,
      ``,
      `模块是分类节点，本身不写正文；文档才是知识点。`,
    ].join("\n"),
    summary: `列出 ${docs.length} 项`,
  };
}

/** 读一篇文档的完整正文 */
function readDoc(args: Record<string, unknown>): ToolResult {
  const idResult = requireString(args, "docId", "文档 id，可从 list_docs 得到");
  if (!idResult.ok) return { content: idResult.error, isError: true, summary: "参数非法" };

  const doc = repo.getDoc(idResult.value);
  if (!doc) {
    return {
      content: `没有找到文档 ${idResult.value}。用 list_docs 确认 id。`,
      isError: true,
      summary: "文档不存在",
    };
  }

  const blocks = repo.listBlocks(doc.id).filter((b) => b.seq >= 0 && b.text.trim() !== "");
  const markdown = serializeBlocks(blocks);
  return {
    content: [
      `《${doc.title || "（无标题）"}》（${doc.kind === "module" ? "模块" : "文档"}，${blocks.length} 个知识块）`,
      ``,
      markdown || "（正文为空）",
    ].join("\n"),
    summary: `读取《${doc.title || "无标题"}》`,
  };
}

/** 关键词搜索知识块 */
function searchBlocks(args: Record<string, unknown>): ToolResult {
  const qResult = requireString(args, "query", "要搜索的关键词");
  if (!qResult.ok) return { content: qResult.error, isError: true, summary: "参数非法" };

  const hits = repo.searchBlocks(repo.getWorkspace()!.id, qResult.value, 20);
  if (hits.length === 0) {
    return {
      content: `没有搜到包含「${qResult.value}」的知识块。可以换个说法，或先用 list_docs 看看有哪些文档。`,
      summary: `搜索「${qResult.value}」无结果`,
    };
  }

  const lines = hits.map(
    (hit) => `- [${hit.docTitle || "（无标题）"}] ${hit.snippet}\n  blockId=${hit.block.id} docId=${hit.block.docId}`,
  );
  return {
    content: [
      `搜到 ${hits.length} 个包含「${qResult.value}」的知识块：`,
      ...lines,
    ].join("\n"),
    summary: `搜索「${qResult.value}」命中 ${hits.length}`,
  };
}

/** 新建一篇文档 */
function createDoc(
  args: Record<string, unknown>,
  ctx: ToolContext,
  kind: "doc" | "module",
): ToolResult {
  const titleResult = requireString(args, "title", "文档标题");
  if (!titleResult.ok) {
    return { content: titleResult.error, isError: true, summary: "参数非法" };
  }

  const parentId = optionalString(args, "parentId");
  if (parentId && !repo.getDoc(parentId)) {
    return {
      content: `上级文档 ${parentId} 不存在。用 list_docs 确认 id，或省略 parentId 建在根目录。`,
      isError: true,
      summary: "上级不存在",
    };
  }

  const title = clampTitle(titleResult.value);
  const doc = repo.createDoc({
    workspaceId: ctx.workspaceId,
    parentId: parentId ?? null,
    title,
    kind,
    // 标记来源：用 icon 让人一眼看出"这篇是 AI 建的"（红线之外的可见性要求）
    icon: "sparkles",
  });

  const body = optionalString(args, "markdown");
  let blockCount = 0;
  if (body) {
    const inputs = parseMarkdown(body).map((b) => ({ kind: b.kind, text: b.text }));
    if (inputs.length > 0) {
      repo.saveDocBlocks(doc.id, inputs, contentHash);
      blockCount = inputs.length;
    }
  }

  return {
    content:
      `已创建${kind === "module" ? "模块" : "文档"}《${title}》（id=${doc.id}）` +
      (blockCount > 0 ? `，写入 ${blockCount} 个知识块。` : `，正文为空。`),
    summary: `新建《${title}》${blockCount > 0 ? `（${blockCount} 块）` : ""}`,
    targetDocId: doc.id,
    // 新建的文档"撤销"就是把它删掉，不需要快照；留着 null 让审计语义一致
    snapshotMarkdown: null,
  };
}

/**
 * 往已有文档**追加**内容。
 *
 * ## 为什么必须是"读全文 → 追加 → 整篇写回"
 *
 * `saveDocBlocks` 是**整篇替换**语义：本次没出现的块全部被软删。
 * 所以"只把新块 PUT 上去"会**一次抹掉整篇文档**。这不是理论风险 ——
 * 这是 `repo.saveDocBlocks` 的既有行为（`block` 的追加式修订只保护
 * "同 id 的新版本"，保护不了"没被提及的块"）。
 *
 * ## 为什么这是安全的追加
 *
 * 把读到的 markdown 原样放在前面、新内容接在后面再整篇写回：
 *  - 既有块的**文本一字未改**，`textHash` 不变 → `cacheKey` 不变
 *    → 引用这些块的会话缓存**不受影响**；
 *  - 块的身份认领逻辑（`saveDocBlocks` 的三趟匹配）会把前缀里的旧块
 *    一一认领回去，所以不会产生"整篇被重写"的缓存击穿。
 *
 * 这几条不是推理出来的结论，是 `tests/integration/tools.test.ts` 里
 * 逐条断言的事实（既有块 id 与内容一字未变）。
 */
function appendBlocks(args: Record<string, unknown>, ctx: ToolContext): ToolResult {
  const idResult = requireString(args, "docId", "目标文档 id，可从 list_docs 得到");
  if (!idResult.ok) return { content: idResult.error, isError: true, summary: "参数非法" };

  const bodyResult = requireString(args, "markdown", "要追加的 Markdown 正文");
  if (!bodyResult.ok) return { content: bodyResult.error, isError: true, summary: "参数非法" };

  const doc = repo.getDoc(idResult.value);
  if (!doc) {
    return {
      content: `没有找到文档 ${idResult.value}。用 list_docs 确认 id。`,
      isError: true,
      summary: "文档不存在",
    };
  }
  if (doc.kind === "module") {
    return {
      content:
        `《${doc.title}》是模块（分类节点），按约定模块本身不写正文。` +
        `请在它下面新建一篇文档来放内容。`,
      isError: true,
      summary: "模块不能写正文",
    };
  }

  // 动手前的快照 —— 这是"撤销"唯一需要的东西
  const before = repo
    .listBlocks(doc.id)
    .filter((b) => b.seq >= 0 && b.text.trim() !== "");
  const snapshotMarkdown = serializeBlocks(before);

  const incoming = parseMarkdown(bodyResult.value).filter((b) => b.text.trim() !== "");
  if (incoming.length === 0) {
    return {
      content: `要追加的内容解析后是空的，没有做任何改动。`,
      isError: true,
      summary: "追加内容为空",
    };
  }

  const combined = snapshotMarkdown ? `${snapshotMarkdown}\n\n${bodyResult.value}` : bodyResult.value;
  const inputs = parseMarkdown(combined).map((b) => ({ kind: b.kind, text: b.text }));
  repo.saveDocBlocks(doc.id, inputs, contentHash);

  /*
   * 写入后自检：追加**绝不能**让既有块消失。
   *
   * `saveDocBlocks` 的返回里带 `removed`，语义是"这次没出现、因此被软删的块"。
   * 纯追加场景下它必须为空 —— 不为空说明内容被吃掉了，
   * 此时立刻按快照回滚，而不是把这个状态留在用户库里。
   * （策略文档里"追加不越界"那条判据就落在这里。）
   */
  const after = repo.listBlocks(doc.id).filter((b) => b.seq >= 0 && b.text.trim() !== "");
  const afterIds = new Set(after.map((b) => b.id));
  const lost = before.filter((b) => !afterIds.has(b.id));
  if (lost.length > 0) {
    repo.saveDocBlocks(
      doc.id,
      parseMarkdown(snapshotMarkdown).map((b) => ({ kind: b.kind, text: b.text })),
      contentHash,
      before.map((b) => b.id),
    );
    return {
      content: `追加失败：检测到 ${lost.length} 个既有知识块会丢失，已按快照回滚，文档保持原样。`,
      isError: true,
      summary: "追加越界，已回滚",
      targetDocId: doc.id,
      snapshotMarkdown,
    };
  }

  void ctx;
  return {
    content:
      `已往《${doc.title || "（无标题）"}》追加 ${incoming.length} 个知识块` +
      `（原有 ${before.length} 块未改动）。`,
    summary: `追加 ${incoming.length} 块 → 《${doc.title || "无标题"}》`,
    targetDocId: doc.id,
    snapshotMarkdown,
  };
}

/* ------------------------------------------------------------------ *
 * 注册表
 * ------------------------------------------------------------------ */

export const TOOL_SPECS: readonly ToolSpec[] = [
  {
    writes: false,
    definition: {
      name: "list_docs",
      description:
        "列出知识库里所有文档与模块（含 id、层级、类型）。想了解用户已经整理了什么时先用它，不要凭空猜测用户写过什么。",
      parameters: { type: "object", properties: {}, required: [] },
    },
    run: () => listDocs(),
  },
  {
    writes: false,
    definition: {
      name: "read_doc",
      description:
        "读一篇文档或模块的完整正文（Markdown）。需要判断某篇内容对不对、缺什么时用它。docId 从 list_docs 得到。",
      parameters: {
        type: "object",
        properties: { docId: { type: "string", description: "文档 id" } },
        required: ["docId"],
      },
    },
    run: (args) => readDoc(args),
  },
  {
    writes: false,
    definition: {
      name: "search_blocks",
      description:
        "按关键词搜索知识块，返回所在文档与片段。适合确认某个概念用户有没有写过、写在哪。",
      parameters: {
        type: "object",
        properties: { query: { type: "string", description: "搜索关键词" } },
        required: ["query"],
      },
    },
    run: (args) => searchBlocks(args),
  },
  {
    writes: true,
    definition: {
      name: "create_doc",
      description:
        "在知识库里新建一篇文档（知识点）。可选 parentId 挂到某个模块下，可选 markdown 直接写入正文。只在确有新知识点要沉淀时用；不要为了显得有产出而建空文档。",
      parameters: {
        type: "object",
        properties: {
          title: { type: "string", description: "文档标题，简短一行" },
          parentId: { type: "string", description: "上级模块/文档 id，可省略（建在根目录）" },
          markdown: { type: "string", description: "正文 Markdown，可省略" },
        },
        required: ["title"],
      },
    },
    run: (args, ctx) => createDoc(args, ctx, "doc"),
  },
  {
    writes: true,
    definition: {
      name: "create_module",
      description:
        "新建一个模块（分类节点，本身不写正文），用来把同一方向的知识点挂在一起。",
      parameters: {
        type: "object",
        properties: {
          title: { type: "string", description: "模块名，例如「Unity」「图形学」" },
          parentId: { type: "string", description: "上级 id，可省略" },
        },
        required: ["title"],
      },
    },
    run: (args, ctx) => createDoc(args, ctx, "module"),
  },
  {
    writes: true,
    definition: {
      name: "append_blocks",
      description:
        "往**已有文档**末尾追加内容。只追加、不改写：既有内容一字不动。想补全某篇时用它。不要用它来重写或删减内容 —— 那件事没有工具可做。",
      parameters: {
        type: "object",
        properties: {
          docId: { type: "string", description: "目标文档 id" },
          markdown: { type: "string", description: "要追加的 Markdown" },
        },
        required: ["docId", "markdown"],
      },
    },
    run: (args, ctx) => appendBlocks(args, ctx),
  },
];

/** 供 provider 使用的工具定义清单（与实现同源，不会漂移） */
export function toolDefinitions(): ToolDefinition[] {
  return TOOL_SPECS.map((spec) => spec.definition);
}

export function findTool(name: string): ToolSpec | undefined {
  return TOOL_SPECS.find((spec) => spec.definition.name === name);
}

/** 工具名清单，供测试直接断言"删除类工具不存在"（红线 1） */
export function toolNames(): string[] {
  return TOOL_SPECS.map((spec) => spec.definition.name);
}
