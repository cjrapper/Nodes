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
import {
  serializeBeforeState,
  type BeforeDelete,
  type BeforeRename,
  type BeforeUpdate,
} from "./before-state";

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
  /** 撤销时用：动手前的整篇 markdown（内容类改动） */
  snapshotMarkdown?: string | null;
  /**
   * 撤销时用：动手前的**元数据**（标题 / 父级 / 删除标记），已序列化的 JSON。
   *
   * 与 `snapshotMarkdown` 是互补的两份记录：改名、移动、删除要回滚的
   * 都不是正文，快照里没有它们。形状见 `before-state.ts`。
   */
  beforeState?: string | null;
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
    /*
     * 新建类**没有内容快照**（撤销就是把它删掉，不需要还原成什么样），
     * 但要显式记下"这是一次新建"。
     *
     * ⚠️ 别指望靠"快照为 null"来推断这件事 —— `append_blocks` 的快照在
     * "动手前文档为空"时同样是 null，两者会混。靠字段是否为 null 猜意图
     * 已经害得新建类撤销失效过一次（见 `before-state.ts` 的说明）。
     */
    snapshotMarkdown: null,
    beforeState: serializeBeforeState({
      kind: "create",
      title,
      kindOfCreated: kind,
    }),
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
 * 可重组类工具：改写正文 / 改名移动 / 删除
 *
 * ## 为什么放开了（这里曾经是红线）
 *
 * 早期策略是"AI 只能追加"，写死在 `docs/agent-write-policy.md` 里。
 * 但那条策略的**理由已经消失了**：
 *
 *  - 当年"不能删"是因为 `deleteDoc` 是硬删，一次误调用永久带走一篇文档；
 *    现在它是软删（`deleted_at`）+ 可恢复，删除从"灾难"降级成"可挽回"；
 *  - 当年"不能改"是怕覆盖用户的字节；现在改写走 `saveDocBlocks` 的三趟
 *    身份认领，旧 revision 全部留在库里，加上快照撤销，同样可逆。
 *
 * 而代价一直存在：只能追加的助手**当不了导师**。它没法指出"这两篇该合并"、
 * "这块放错分类了"、"这段理解是错的，应该改成这样" —— 只能往后面贴补丁。
 * 对一个用来补视野盲区的学习工具来说，这个代价比"可逆的改动"大得多。
 *
 * ## 现在靠什么保证安全
 *
 * 判据从"不做危险动作"换成"**每个动作都可撤销**"：
 *
 * | 工具 | 撤销靠什么 |
 * | --- | --- |
 * | `update_doc` | markdown 快照重放（含原块 id，cacheKey 逐字节复原） |
 * | `rename_doc` | `before_state` 里的原标题 / 原父级 |
 * | `delete_doc` | 软删 + `restoreDoc`（撤销 = 从回收站捞回来） |
 *
 * 外加一条不动的底线：**模块带子文档时不许删** —— 理由见 deleteDoc。
 * ------------------------------------------------------------------ */

/**
 * 校对：改写之后，**原本存在的块内容必须都还在**。
 *
 * ## 这条守卫是整个放开方案里最要紧的一环
 *
 * 允许模型改写正文，就等于允许它弄丢用户的笔记。而模型最常见的失败模式
 * 恰恰是"顺手精简"：让它补一句，它把整段重写得"更通顺"，
 * 于是用户写下的具体表述、代码片段、踩坑记录全没了。
 *
 * 所以规则是：**要删就必须显式删**（调用 `delete_doc` 或另一次明确的改写），
 * 不能作为改写的副作用发生。
 *
 * ## 判据为什么是"逐块包含"而不是"块数不变"
 *
 * 块数不变太弱：把 A 段和 B 段合并成一段，块数也会变，而那可能是合理的整理。
 * "每一块原来的文字都能在新内容里找到"才对应我们真正在意的东西 ——
 * **用户写下的字节还在**。允许重组顺序、允许合并、允许插入新内容，
 * 但不允许悄悄丢。
 *
 * 比对用规范化后的文本（空白折叠 + 去首尾），这样重排缩进、
 * 统一换行不会误判成"内容丢了"。
 *
 * ## 代价（明确写出来）
 *
 * 这条守卫会**阻止一批合理的整理**：模型想改写一句有语病的表述、
 * 想删掉一段过时的内容，都会被拒。这是刻意的取舍 ——
 * 拒绝的后果是"这次改动没做成，模型会告诉用户为什么"；
 * 放行的后果是"用户的笔记少了一段，而且没人知道"。
 * 前者可挽回，后者不可挽回。
 */
function findLostBlocks(
  before: readonly { text: string }[],
  afterMarkdown: string,
): string[] {
  const normalize = (text: string): string => text.replace(/\s+/g, " ").trim();
  const haystack = normalize(afterMarkdown);
  const lost: string[] = [];
  for (const block of before) {
    const needle = normalize(block.text);
    if (needle === "") continue;
    if (!haystack.includes(needle)) lost.push(block.text);
  }
  return lost;
}

/** 把丢内容的情况汇成一句模型能据此改正的话 */
function describeLost(lost: readonly string[]): string {
  const preview = lost
    .slice(0, 3)
    .map((text) => `「${text.replace(/\s+/g, " ").trim().slice(0, 40)}」`)
    .join("、");
  const more = lost.length > 3 ? ` 等 ${lost.length} 处` : "";
  return (
    `改写被拒绝：新内容里找不到原有的 ${lost.length} 个知识块 —— ${preview}${more}。\n` +
    `已有内容不允许在改写中消失。请把原样保留它们，或者改用 delete_doc 明确删除整篇文档。`
  );
}

/** 改写一篇文档的正文（可同时改标题） */
function updateDoc(args: Record<string, unknown>, ctx: ToolContext): ToolResult {
  const idResult = requireString(args, "docId", "目标文档 id");
  if (!idResult.ok) return { content: idResult.error, isError: true, summary: "参数非法" };

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
        `请改写它下面的文档，或者用 rename_doc 调整这个模块本身。`,
      isError: true,
      summary: "模块不能写正文",
    };
  }

  const mdResult = requireString(args, "markdown", "改写后的完整 Markdown 正文");
  if (!mdResult.ok) return { content: mdResult.error, isError: true, summary: "参数非法" };

  const before = repo
    .listBlocks(doc.id)
    .filter((b) => b.seq >= 0 && b.text.trim() !== "");
  const snapshotMarkdown = serializeBlocks(before);

  /*
   * ## 关于"改写不许丢内容"那条守卫：**已按要求放开**
   *
   * 这里原先有一道守卫：每个既有块的文字必须原样出现在新内容里，
   * 否则整次调用被拒。它的理由是"模型的失败模式是顺手精简，
   * 用户写下的东西会悄悄消失"。
   *
   * 但它在实践中挡掉的更多是**正当的整理**：AI 没法删掉过时的段落、
   * 没法合并两篇重复文档、没法把一段啰嗦的表述改短。用户的原话是
   * 「原文可以删，或者说是覆盖」—— 也就是说，这条守卫不是他要的边界。
   *
   * ## 为什么现在放开是安全的
   *
   * 因为**真正的安全网不是那道守卫，是可撤销性**，而这一轮把它补完整了：
   *
   *  1. 动手前存整篇快照（`snapshotMarkdown`）；
   *  2. 快照对应的**原块 id** 存进 `beforeState.originalBlockIds`；
   *  3. 撤销时走 `saveDocBlocks(..., { reviveIds })` —— 被删掉的块会按
   *     **原 id 复活**。这一点是关键：在那条通道存在之前，撤销只能救回内容，
   *     块会拿到新 id，于是 `@` 引用永远接不回来（内容看着一样，
   *     界面上完全看不出差别）。现在引用会自动接回。
   *
   * 所以判据从"不许删"换成了"删了能原样退回"。代价是撤销成了必要动作 ——
   * 但那是用户明确接受的（"实际考虑不需要太在乎它"）。
   *
   * ## 那个函数还在
   *
   * `findLostBlocks` / `describeLost` 保留在文件里：它们是这段历史的记录，
   * 也是"如果将来要加回严格模式"的现成实现。现在不调用而已。
   * 刻意不删掉它们 —— 一个被移除的安全机制应该留下可见的痕迹，
   * 而不是无声消失，让后人以为从来没有过。
   */
  const inputs = parseMarkdown(mdResult.value)
    .map((b) => ({ kind: b.kind, text: b.text }))
    .filter((b) => b.text.trim() !== "");

  /*
   * 把旧块 id 按顺序交回去，让身份尽量延续。
   *
   * 为什么不传 `previousIds`（第三个参数）：那个参数是"上一次保存时的 id 序列，
   * 按位置"——而模型改写之后位置关系已经不可靠了。交给 `saveDocBlocks`
   * 的内容匹配那趟去认领更准：文本没变的块自己会找回原 id，
   * 于是 `cacheKey` 不变、引用它们的会话不受影响。
   */
  repo.saveDocBlocks(doc.id, inputs, contentHash);

  // 标题可选：模型可以在改写正文时顺手把它改得更贴切
  const newTitle = optionalString(args, "title");
  if (newTitle) repo.updateDoc(doc.id, { title: clampTitle(newTitle) });

  const after = repo.listBlocks(doc.id).filter((b) => b.seq >= 0 && b.text.trim() !== "");
  /*
   * ⚠️ 必须把元数据快照也交回去。
   *
   * 声明了 `ToolResult.beforeState`、`undo.ts` 里也写了 `kind === "update"`
   * 的分支，但这里漏了 return —— 于是撤销会退回"只恢复内容"那条路，
   * 正文回来了、**标题回不去**（标题不在 markdown 快照里）。
   * 这个漏洞很隐蔽：撤销报告"成功"，内容看着也对，只有标题悄悄留着 AI 改的版本。
   *
   * 教训：新增一个"撤销维度"时，要在三处同时落地 ——
   * 类型声明、撤销分支、以及**工具自己的 return**。
   * 少任何一处都不会报错，只会静默失效。
   */
  const beforeState: BeforeUpdate = {
    kind: "update",
    title: doc.title,
    beforeParentId: doc.parentId,
    // 与 snapshotMarkdown 同序，撤销时用来把被删掉的块按原 id 复活
    originalBlockIds: before.map((b) => b.id),
  };

  void ctx;
  return {
    content:
      `已改写《${doc.title || "（无标题）"}》：${before.length} 块 → ${after.length} 块` +
      (newTitle ? `，标题改为「${clampTitle(newTitle)}」` : "") +
      `。原有内容全部保留。`,
    summary: `改写《${doc.title || "无标题"}》（${before.length} → ${after.length} 块）`,
    targetDocId: doc.id,
    snapshotMarkdown,
    beforeState: serializeBeforeState(beforeState),
  };
}

/** 改名 / 移动一篇文档或模块 */
function renameDoc(args: Record<string, unknown>): ToolResult {
  const idResult = requireString(args, "docId", "目标文档 id");
  if (!idResult.ok) return { content: idResult.error, isError: true, summary: "参数非法" };

  const doc = repo.getDoc(idResult.value);
  if (!doc) {
    return {
      content: `没有找到文档 ${idResult.value}。用 list_docs 确认 id。`,
      isError: true,
      summary: "文档不存在",
    };
  }

  const newTitle = optionalString(args, "title");
  /*
   * `parentId` 用"显式传 null 表示移到根"的语义。
   *
   * `optionalString` 把 null / 空串都当成"没传"，那样就没法表达"移到根目录"——
   * 而移回根是个常见操作（从模块里拿出来独立成篇）。
   * 所以这里单独判 `"parentId" in args`：**键存在**才算"要动位置"。
   */
  const wantsMove = Object.prototype.hasOwnProperty.call(args, "parentId");
  const rawParent = args.parentId;
  const newParentId =
    rawParent === null || rawParent === undefined || rawParent === ""
      ? null
      : typeof rawParent === "string"
        ? rawParent.trim()
        : undefined;

  if (!newTitle && !wantsMove) {
    return {
      content: "既没有给 title 也没有给 parentId，没有要改的东西。",
      isError: true,
      summary: "参数为空",
    };
  }

  if (wantsMove && newParentId !== null && newParentId !== undefined) {
    const parent = repo.getDoc(newParentId);
    if (!parent) {
      return {
        content: `上级 ${newParentId} 不存在。用 list_docs 确认 id，或传 parentId=null 移到根目录。`,
        isError: true,
        summary: "上级不存在",
      };
    }
    /*
     * 环保护：不能把一个模块移进它自己的子孙里。
     * 那会让这棵子树从文档树上**整段消失**（根节点在自己的子树里，
     * 遍历时永远走不到），而用户只会看到"文档不见了"。
     */
    if (repo.collectDocSubtree(doc.id).includes(newParentId)) {
      return {
        content: `不能把《${doc.title}》移动到它自己的子级（${newParentId}）里 —— 那会让这棵子树从文档树上消失。`,
        isError: true,
        summary: "拒绝成环",
      };
    }
  }

  const beforeState: BeforeRename = {
    kind: "rename",
    title: doc.title,
    beforeParentId: doc.parentId,
    titleChanged: Boolean(newTitle) && clampTitle(newTitle!) !== doc.title,
    parentChanged: wantsMove && newParentId !== doc.parentId,
  };

  const patch: { title?: string; parentId?: string | null } = {};
  if (newTitle) patch.title = clampTitle(newTitle);
  if (wantsMove) patch.parentId = newParentId ?? null;
  repo.updateDoc(doc.id, patch);

  const after = repo.getDoc(doc.id)!;
  const parts: string[] = [];
  if (beforeState.titleChanged) parts.push(`《${doc.title}》→《${after.title}》`);
  else parts.push(`《${after.title}》`);
  if (beforeState.parentChanged) {
    parts.push(newParentId ? `已移入 ${newParentId}` : "已移到根目录");
  }

  return {
    content: `已更新${doc.kind === "module" ? "模块" : "文档"}：${parts.join("，")}。`,
    summary: parts.join("，"),
    targetDocId: doc.id,
    beforeState: serializeBeforeState(beforeState),
  };
}

/** 把一篇文档（及其子文档）放进回收站 */
function deleteDoc(args: Record<string, unknown>): ToolResult {
  const idResult = requireString(args, "docId", "要删除的文档 id");
  if (!idResult.ok) return { content: idResult.error, isError: true, summary: "参数非法" };

  const doc = repo.getDoc(idResult.value);
  if (!doc) {
    return {
      content: `没有找到文档 ${idResult.value}。用 list_docs 确认 id。`,
      isError: true,
      summary: "文档不存在",
    };
  }

  const subtree = repo.collectDocSubtree(doc.id);
  const children = subtree.filter((id) => id !== doc.id);

  /*
   * ⚠️ 模块带子文档时**拒绝删除**。
   *
   * 这不是技术限制（软删能整棵恢复），是**影响面**的取舍：
   * 一次 tool call 带走十几篇文档，用户看到的是"一个模块空了"，
   * 而他要逐个确认"哪些是本来就该删的"。
   *
   * 要求模型先把子文档一个个处理掉，等于把"一次大误操作"拆成
   * "若干次可核对的小操作"—— 每次它都得说出删的是哪一篇。
   *
   * 这条是用户明确要求保留的（"保护模块是要留的"）。
   */
  if (children.length > 0) {
    const names = children
      .slice(0, 5)
      .map((id) => {
        const child = repo.getDoc(id);
        return `《${child?.title || "（无标题）"}》(${id})`;
      })
      .join("、");
    const more = children.length > 5 ? ` 等 ${children.length} 篇` : "";
    return {
      content:
        `《${doc.title}》下面还有 ${children.length} 篇内容（${names}${more}），拒绝整棵删除。\n` +
        `请先逐篇处理它们（把有用的合并到别处，再单独删掉确实没用的），` +
        `或者直接告诉用户你建议怎么整理，让他决定。`,
      isError: true,
      summary: `拒绝删除（含 ${children.length} 篇子文档）`,
      targetDocId: doc.id,
    };
  }

  const beforeState: BeforeDelete = {
    kind: "delete",
    title: doc.title,
    beforeParentId: doc.parentId,
    deletedIds: subtree,
  };

  repo.deleteDoc(doc.id);

  return {
    content:
      `已把《${doc.title || "（无标题）"}》放进回收站（可以恢复）。` +
      `如果这是误操作，在回收站里点恢复，或者撤销这次工具调用。`,
    summary: `删除《${doc.title || "无标题"}》`,
    targetDocId: doc.id,
    beforeState: serializeBeforeState(beforeState),
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
        "往**已有文档**末尾追加内容。只追加、不改写：既有内容一字不动。想补全某篇时用它。",
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
  {
    writes: true,
    definition: {
      name: "update_doc",
      description:
        "改写一篇文档的**完整正文**（Markdown 全文，不是增量）。用于合并重复内容、纠正错误、重组结构、删减过时或冗余的内容、把零散笔记整理成有条理的文档。\n" +
        "可以删减与覆盖原有内容 —— 这是被允许的。但请注意每次改写都会存下动手前的快照，用户可以一键撤销，所以请确保改动是你认为确实更好的版本。\n" +
        "调用前先用 read_doc 读一遍当前正文，避免凭记忆改写（凭记忆写会丢掉你没记住的部分）。",
      parameters: {
        type: "object",
        properties: {
          docId: { type: "string", description: "目标文档 id" },
          markdown: {
            type: "string",
            description: "改写后的**完整** Markdown 正文（必须是全文，不是要改的那一段）",
          },
          title: { type: "string", description: "顺带修改标题，可省略" },
        },
        required: ["docId", "markdown"],
      },
    },
    run: (args, ctx) => updateDoc(args, ctx),
  },
  {
    writes: true,
    definition: {
      name: "rename_doc",
      description:
        "改标题，或把一篇文档/模块移动到另一个分类下。用于「这篇放错模块了」「标题起得不准」这类整理。\n" +
        "传 parentId=null 表示移到根目录。不能移动到自己的子级里。",
      parameters: {
        type: "object",
        properties: {
          docId: { type: "string", description: "目标文档或模块 id" },
          title: { type: "string", description: "新标题，不改标题就省略" },
          parentId: {
            type: ["string", "null"],
            description: "新的上级 id；传 null 移到根目录；不改位置就省略这个键",
          },
        },
        required: ["docId"],
      },
    },
    run: (args) => renameDoc(args),
  },
  {
    writes: true,
    definition: {
      name: "delete_doc",
      description:
        "把一篇文档放进回收站（可恢复，不是永久删除）。用于清理重复内容、过时笔记。\n" +
        "**含子文档的模块会被拒绝** —— 那种情况请先逐篇处理子文档，或把建议告诉用户让他决定。\n" +
        "删除前请确认内容确实没有价值；宁可先合并到别处再删。",
      parameters: {
        type: "object",
        properties: {
          docId: { type: "string", description: "要删除的文档 id" },
        },
        required: ["docId"],
      },
    },
    run: (args) => deleteDoc(args),
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
