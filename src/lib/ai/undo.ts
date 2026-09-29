/**
 * 撤销一次 AI 的工具写入。
 *
 * ## 撤销材料有两份，缺一不可
 *
 * | 材料 | 管什么 | 哪类工具需要 |
 * | --- | --- | --- |
 * | `snapshot_markdown` | **内容**：动手前的整篇正文 | `append_blocks` / `update_doc` |
 * | `before_state` | **元数据**：标题 / 父级 / 删除标记 | `update_doc` / `rename_doc` / `delete_doc` |
 *
 * 只有其中一份是不够的：改名要还原的是 `doc.title`，而快照是 markdown，
 * 里面根本没有标题；反过来，删掉一篇文档时元数据也不知道它原本有哪些块。
 *
 * 两份都为 NULL 才说明"这条记录不可撤销"（读类工具就是这种）。
 *
 * ## 为什么"撤销"是做快照重放，而不是设计一个反向操作
 *
 * 反向操作（"把刚追加的 N 个块删掉"）看起来更精准，实际做不到：
 *  - 用户可能在 AI 写入之后自己又编辑了那篇文档，反向删除会把**他的改动**
 *    一起删掉；
 *  - 追加可能改变了块的位置与身份认领结果，反推"哪些是新的"并不可靠。
 *
 * 快照重放没有这两个问题：把动手前的整整一篇 markdown 原样写回去，
 * 结果就是"那一篇回到 AI 动手之前的样子"——语义干净，用户能预期。
 *
 * ## 交付的诚实边界（必须写清楚，否则用户会以为能时光倒流）
 *
 * 撤销会把文档恢复成**工具动手前**的状态，这意味着：
 *  - 如果 AI 写入之后**你自己**又改了这篇文档，点撤销会**一并丢掉你的改动**；
 *  - 所以前端必须在确认框里把"会丢掉这之后的所有改动"说明白。
 *
 * 这不是实现缺陷，是"整篇快照"这个方案的固有代价。换成正向操作就会有
 * 上面那两个更糟的问题（悄悄吃掉用户的内容）。两害相权，取可预期的那一个。
 *
 * ## 块 id 会原样恢复
 *
 * 快照里带着原来的块 id，重放时用同一批 id 写回 —— `textHash` 与
 * `cacheKey` 因此**逐字节复原**，引用这篇文档的会话缓存也跟着回到原状。
 */

import * as repo from "../db/repo";
import { contentHash } from "../blocks/markdown";
import { parseMarkdown } from "../blocks/parse-blocks";
import { parseBeforeState } from "./before-state";

export interface UndoResult {
  ok: boolean;
  /** 回给用户的一句话 */
  message: string;
  /** 恢复到的文档 */
  docId?: string;
  /** 恢复后文档里的块 id（应当与动手前一致，缓存键才复原得了） */
  restoredBlockIds?: string[];
}

export function undoToolCall(toolCallId: string): UndoResult {
  const record = repo.getToolCall(toolCallId);
  if (!record) return { ok: false, message: "找不到这条工具记录。" };

  if (record.status === "undone") {
    return { ok: false, message: "这次操作已经撤销过了。" };
  }

  const before = parseBeforeState(record.beforeState);

  /*
   * 按**动手前记下的类型**分派，而不是按工具名。
   *
   * 形状记录在数据里（`before_state.kind`），所以将来工具改名、
   * 或者一个新工具复用了同一种改动方式，撤销逻辑都不用跟着改 ——
   * 它只关心"当时动的是内容还是元数据"。
   * 这也是 `before-state.ts` 里选择"存事实而不是存反向指令"的收益。
   */
  if (before?.kind === "create") return undoCreate(record, before);
  if (before?.kind === "rename") return undoRename(record, before);
  if (before?.kind === "delete") return undoDelete(record, before);
  if (before?.kind === "update") return undoUpdate(record, before);

  /*
   * 没有元数据 → 退回内容类撤销。
   *
   * 这是 `append_blocks` 走的路，也是**功能上线前的旧记录**唯一能走的兜底：
   * 那些记录里没有 `before_state`，但正**因为**它们都是内容类工具，
   * 只靠 markdown 快照就能正确撤销。
   *
   * ⚠️ 这里刻意不看 `snapshotMarkdown` 是否为 null 就放行 ——
   * `append_blocks` 在"动手前文档为空"时快照就是 null，而那种情况
   * 撤销的语义是"把内容清空"，仍然是一次合法的内容撤销。
   * 让 `restoreContent` 去判断"到底有没有快照可以做这件事"。
   */
  if (record.snapshotMarkdown !== null || record.toolName === "append_blocks") {
    return undoContent(record);
  }

  return {
    ok: false,
    message: "这条记录没有可撤销的改动（读类工具，或功能上线前的旧记录）。",
  };
}

/* ------------------------------------------------------------------ *
 * 新建
 * ------------------------------------------------------------------ */

/**
 * 一个文档 id 是否躺在回收站里。
 *
 * 需要它是因为 `getDoc` 会过滤掉已软删的文档，而"已被删除，在回收站里"
 * 和"已被彻底清除"对用户的处置完全不同：前者让他去恢复，后者只能承认无法挽回。
 * 只看 `deleteDoc` 的返回值区分不了这两种 —— 它对两种都返回空数组。
 */
function inTrash(docId: string): boolean {
  const ws = repo.getWorkspace();
  if (!ws) return false;
  return repo.listDeletedDocs(ws.id).some((doc) => doc.id === docId);
}

function undoCreate(
  record: repo.ToolCallRecord,
  before: { title: string; kindOfCreated: "doc" | "module" },
): UndoResult {
  const docId = record.targetDocId;
  if (!docId) return { ok: false, message: "这条记录没有关联文档，无法撤销。" };

  // 已彻底清除（或本来就没有）→ 撤销没有任何可做的事，说清楚
  if (!repo.getDoc(docId) && !inTrash(docId)) {
    return {
      ok: false,
      message: `《${before.title}》已经不在库里了 —— 可能被删除并彻底清除了。撤销无法挽回这一步。`,
    };
  }

  /*
   * 新建的撤销 = 放进回收站，而不是彻底清除。
   * 撤销本身也必须是可挽回的，否则一次误点就永久少一篇。
   */
  const deleted = repo.deleteDoc(docId);
  if (deleted.length === 0) {
    return {
      ok: false,
      message: `《${before.title}》已经不在库里了（可能已被删除或已进回收站）。`,
    };
  }
  repo.markToolCallUndone(record.id);
  return {
    ok: true,
    message:
      `已撤销：把 AI 新建的${before.kindOfCreated === "module" ? "模块" : "文档"}` +
      `《${before.title}》放进了回收站（可以再恢复）。`,
    docId,
  };
}

/* ------------------------------------------------------------------ *
 * 改名 / 移动
 * ------------------------------------------------------------------ */

type RenameBefore = Extract<import("./before-state").BeforeState, { kind: "rename" }>;
type DeleteBefore = Extract<import("./before-state").BeforeState, { kind: "delete" }>;
type UpdateBefore = Extract<import("./before-state").BeforeState, { kind: "update" }>;

function undoRename(record: repo.ToolCallRecord, before: RenameBefore): UndoResult {
  const docId = record.targetDocId;
  if (!docId) return { ok: false, message: "这条记录没有关联文档，无法撤销。" };

  const doc = repo.getDoc(docId);
  if (!doc) {
    return {
      ok: false,
      message: "目标文档已经不在了（可能被删除）。先在回收站里恢复它，再撤销这次改动。",
    };
  }

  const patch: { title?: string; parentId?: string | null } = {};
  if (before.titleChanged) patch.title = before.title;

  /*
   * 还原父级前先确认那个上级还在。
   * 它可能在这之后被删掉了 —— 那样硬写回一个已软删的 parentId，
   * 会让这篇文档**跟着从树上消失**（读路径按父级过滤），
   * 用户看到的是"撤销把文档弄没了"。此时退回根目录。
   */
  let parentNote = "";
  if (before.parentChanged) {
    if (before.beforeParentId && !repo.getDoc(before.beforeParentId)) {
      patch.parentId = null;
      parentNote = "（原来的上级已被删除，已放回根目录）";
    } else {
      patch.parentId = before.beforeParentId;
    }
  }

  repo.updateDoc(docId, patch);
  repo.markToolCallUndone(record.id);

  const after = repo.getDoc(docId);
  const parts: string[] = [];
  if (before.titleChanged) parts.push(`标题还原为《${before.title}》`);
  if (before.parentChanged) {
    parts.push(before.beforeParentId ? `位置还原到 ${before.beforeParentId}${parentNote}` : `已放回根目录${parentNote}`);
  }
  return {
    ok: true,
    message: `已撤销对《${after?.title || before.title}》的修改：${parts.join("，")}。`,
    docId,
  };
}

/* ------------------------------------------------------------------ *
 * 删除
 * ------------------------------------------------------------------ */

function undoDelete(
  record: repo.ToolCallRecord,
  before: DeleteBefore,
): UndoResult {
  const docId = record.targetDocId;
  if (!docId) return { ok: false, message: "这条记录没有关联文档，无法撤销。" };

  /*
   * 已经在回收站里 → 捞回来。
   * `restoreDoc` 按 `deleted_at` 时间戳匹配整棵子树，而 `deleteDoc`
   * 给整棵子树盖的是同一个时间戳，所以这里一次调用就能全部恢复。
   */
  const restored = repo.restoreDoc(docId);
  if (restored === null) {
    return {
      ok: false,
      message:
        `《${before.title}》不在回收站里（可能已经被恢复了，或者被彻底清除）。` +
        `如果是被彻底清除，撤销无法挽回 —— 那是"清空回收站"才会做的事。`,
    };
  }

  repo.markToolCallUndone(record.id);

  /*
   * 顺手确认父级还在。删除时父级没动，所以正常情况下它当然还在；
   * 但如果父级后来被别人删了，这篇文档恢复出来也会看不见。
   */
  let note = "";
  if (before.beforeParentId && !repo.getDoc(before.beforeParentId)) {
    repo.updateDoc(docId, { parentId: null });
    note = "（原来的上级已被删除，已放回根目录）";
  }

  return {
    ok: true,
    message:
      `已撤销删除：《${before.title}》及其 ${restored.length - 1} 篇子文档已从回收站恢复${note}。`,
    docId,
  };
}

/* ------------------------------------------------------------------ *
 * 改写正文（update_doc）—— 内容 + 可能的标题
 * ------------------------------------------------------------------ */

function undoUpdate(
  record: repo.ToolCallRecord,
  before: UpdateBefore,
): UndoResult {
  const docId = record.targetDocId;
  if (!docId) return { ok: false, message: "这条记录没有关联文档，无法撤销。" };

  const doc = repo.getDoc(docId);
  if (!doc) {
    return {
      ok: false,
      message: "目标文档已经不在了（可能被删除）。先在回收站里恢复它，再撤销这次改写。",
    };
  }

  const contentResult = restoreContent(record, docId, {
    originalBlockIds: before.originalBlockIds,
  });
  if (!contentResult.ok) return contentResult;

  // 标题：update_doc 允许顺手改标题，撤销时一并还原
  let titleNote = "";
  if (doc.title !== before.title) {
    repo.updateDoc(docId, { title: before.title });
    titleNote = `，标题还原为《${before.title}》`;
  }

  return {
    ok: true,
    message: contentResult.message.replace(/。$/, "") + `${titleNote}。`,
    docId,
    restoredBlockIds: contentResult.restoredBlockIds,
  };
}

/* ------------------------------------------------------------------ *
 * 内容类撤销（追加 / 改写）
 * ------------------------------------------------------------------ */

function undoContent(record: repo.ToolCallRecord): UndoResult {
  if (!record.targetDocId) {
    return { ok: false, message: "这条记录没有关联文档，无法撤销。" };
  }
  const doc = repo.getDoc(record.targetDocId);
  if (!doc) {
    return {
      ok: false,
      message: "目标文档已经不在了（可能被删除）。先在回收站里恢复它，再撤销这次写入。",
    };
  }
  return restoreContent(record, record.targetDocId);
}

/**
 * 按快照把正文写回去。
 *
 * @param options.originalBlockIds 快照对应的原块 id。传了它，撤销才能把
 *   **已被 AI 删掉**的块按原 id 复活（见 `restoreContent` 内注释）。
 *   追加类工具没有这个信息，走位置启发式即可 —— 追加不动前缀，
 *   位置关系仍然成立。
 */
function restoreContent(
  record: repo.ToolCallRecord,
  docId: string,
  options?: { originalBlockIds?: readonly string[] },
): UndoResult {
  const snapshot = record.snapshotMarkdown;
  if (snapshot === null) {
    return { ok: false, message: "这条记录没有内容快照，无法还原正文。" };
  }

  const current = repo.listBlocks(docId).filter((b) => b.seq >= 0 && b.text.trim() !== "");
  const parsed = parseMarkdown(snapshot);

  /*
   * ⚠️ 必须把**原来的块 id** 一起传回去，否则这次撤销只是"写了一篇内容相同的
   * 新文档"：块 id 是新的 → `cacheKey = sha256(textHash‖id)` 变了 →
   * 引用这篇文档的会话缓存不会回到原状，而且 @ 引用会对不上。
   *
   * 怎么找回原来的 id：工具是**追加**的，所以快照里的前 N 个块与当前文档的
   * 前 N 个块一一对应（`saveDocBlocks` 的块身份认领逻辑就是按顺序认领的）。
   * 用当前文档的 id 序列去配快照的块，得到的就是原 id。
   * 配不上的（理论上不该发生）留空，让 `saveDocBlocks` 发新 id ——
   * 退化成"内容对、id 新"，比直接失败好。
   */
  /*
   * 快照对应的原块 id —— 两处都要用：
   *
   *  1. 作为 `inputs[i].id`（位置提示，帮正常认领把还活着的块接回原 id）；
   *  2. 作为 `reviveIds`（把**已软删**的块按原 id 复活）。
   *
   * ⚠️ 这两件事不能只做第 1 件。被 AI 删掉的块已经软删（seq < 0），
   * `saveDocBlocks` 的三趟认领只看得见活着的块，光传 id 会被忽略、
   * 然后给它**发一个新 id**。后果很隐蔽：内容救回来了，
   * 但 `@` 引用指向的旧 id 依然解析不到东西，而界面上完全看不出差别。
   *
   * ## 早先的写法是错的
   *
   * 这里曾经是 `id: current[index]?.id` —— 假设"快照第 i 块对应当前第 i 块"。
   * 那个假设只在**追加**场景成立（前缀没动）。`update_doc` 会重排、拆合、删减，
   * 位置关系整个失效，于是配出来的 id 是错的。
   * 现在 id 由 `before_state.originalBlockIds` 显式给出，不靠猜。
   */
  const originalIds = options?.originalBlockIds ?? [];
  const inputs = parsed.map((block, index) => ({
    id: originalIds[index] ?? current[index]?.id,
    kind: block.kind,
    text: block.text,
  }));

  repo.saveDocBlocks(docId, inputs, contentHash, current.map((b) => b.id), {
    reviveIds: originalIds,
  });
  repo.markToolCallUndone(record.id);

  const doc = repo.getDoc(docId);
  const restoredIds = repo.listBlocks(docId).filter((b) => b.seq >= 0 && b.text.trim() !== "");

  return {
    ok: true,
    message:
      `已把《${doc?.title || "（无标题）"}》恢复到 AI 动手前（${inputs.length} 个知识块，` +
      `撤销掉了 ${Math.max(0, current.length - inputs.length)} 个 AI 新增的块）。` +
      `注意：AI 写入之后你自己的改动也会一起被恢复掉。`,
    docId,
    restoredBlockIds: restoredIds.map((b) => b.id),
  };
}
