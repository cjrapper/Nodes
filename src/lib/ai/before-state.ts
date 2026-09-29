/**
 * 工具调用的「动手前状态」—— 撤销的第二种载体。
 *
 * ## 为什么不能只靠 markdown 快照
 *
 * `snapshot_markdown` 记的是**正文**。而这三件事要撤的都不是正文：
 *
 * | 动作 | 要还原的东西 | 快照里有吗 |
 * | --- | --- | --- |
 * | 改名 | `doc.title` | ❌ |
 * | 移动 | `doc.parentId` | ❌ |
 * | 删除 | `doc.deleted_at`（以及整棵子树） | ❌ |
 *
 * 所以撤销需要两份记录：`snapshot_markdown` 管内容，`before_state` 管元数据。
 * 两者都为 NULL 才说明"这条记录不可撤销"。
 *
 * ## 为什么存 JSON 而不是给每种动作加一列
 *
 * 每加一个可写工具就要加一列，而 SQLite 加列要走迁移 —— 迁移是这个项目
 * 唯一会**阻塞用户打开数据库**的操作（见 `lib/db/index.ts` 里那段
 * `NOT NULL constraint failed` 的教训）。用一种自描述的 JSON，
 * 新工具只需要在自己的 `beforeState` 里多写几个字段，不必碰 schema。
 *
 * ## 为什么不存"反向操作"
 *
 * 存"该怎么撤回去"（例如 `{op: "move_back", to: "X"}`）看起来更紧凑，
 * 但它把**决策**和**数据**混在了一起：将来撤销逻辑变了，历史记录里的
 * 反向指令就是错的，而且无法补救。存**事实**（当时是什么样）不会过期 ——
 * 撤销逻辑可以随便改进，老记录照样能正确回滚。
 */

/**
 * 新建（`create_doc` / `create_module`）。
 *
 * 撤销 = 把它放进回收站（所以撤销本身还能再撤销）。
 *
 * ## 为什么需要显式记这个类型
 *
 * 早先 `undo.ts` 是靠 `snapshotMarkdown === null` **推断**"这是新建类操作"的。
 * 那个推断同时承担了两个含义：
 *
 *   - `create_doc` 没有快照，因为它不需要（撤销就是删掉）；
 *   - `append_blocks` 的快照也可能是 `null` —— 当它动手前那篇文档是空的时候。
 *
 * 两者混在一起，于是一旦撤销逻辑改成"两份材料都为空就拒绝"，
 * 新建类工具的撤销就整个失效了（真实发生过：`undo.test.ts` 变红）。
 * 靠字段是否为 null 去猜意图本来就脆 —— 现在把意图直接写进数据。
 */
export interface BeforeCreate extends BeforeStateBase {
  kind: "create";
  kindOfCreated: "doc" | "module";
}

/** 撤销元数据的公共字段 */
interface BeforeStateBase {
  /** 动作前的文档标题 */
  title: string;
}

/**
 * 正文被改写过（`update_doc`）。
 *
 * 内容本身由 `snapshot_markdown` 负责，这里记的是**快照回滚不了的元数据**：
 * 标题、父级，以及**原块 id**。
 *
 * ## 为什么必须记原块 id
 *
 * 撤销时要把被 AI 删掉的块"复活"，而复活必须按**原 id** 写回 ——
 * 否则 `@` 引用指向的旧 id 永远解析不到东西（内容能救回，引用接不上，
 * 而界面上完全看不出差别）。
 *
 * ⚠️ 不能指望从 `snapshot_markdown` 里推出 id：markdown 本身就是纯文本，
 * `parseMarkdown` 返回的 `ParsedBlock` 只有 `seq/kind/text`，没有 id。
 * 早先的撤销代码假设"快照里的前 N 块与当前文档一一对应"来配 id ——
 * 那个假设在**追加**场景成立（前缀没动），但 `update_doc` 会重排、拆合、
 * 删减，位置关系整个失效。所以 id 必须显式存下来。
 *
 * `originalBlockIds` 与 `snapshot_markdown` 按同一顺序一一对应。
 */
export interface BeforeUpdate extends BeforeStateBase {
  kind: "update";
  beforeParentId: string | null;
  /** 动手前那篇文档的块 id，顺序与 `snapshot_markdown` 里的块一致 */
  originalBlockIds: string[];
}

/** 改名或移动（`rename_doc`）。撤销就是把这两项写回去。 */
export interface BeforeRename extends BeforeStateBase {
  kind: "rename";
  beforeParentId: string | null;
  /** 是否同时改了标题（只移动时标题没动，还原时就不必写它） */
  titleChanged: boolean;
  /** 是否同时改了位置 */
  parentChanged: boolean;
}

/**
 * 放进回收站（`delete_doc`）。
 *
 * 撤销 = 把这棵子树恢复回来。存 `deletedIds` 是**刻意的冗余**：
 * `restoreDoc(rootId)` 自己会算子树，但将来的删除策略若改成"只删一部分"，
 * 记录里这份明确的清单能让撤销行为保持可预期，而不是跟着实现漂移。
 */
export interface BeforeDelete extends BeforeStateBase {
  kind: "delete";
  beforeParentId: string | null;
  /** 被一起软删的文档 id（含根自己） */
  deletedIds: string[];
}

export type BeforeState = BeforeCreate | BeforeUpdate | BeforeRename | BeforeDelete;

/** 序列化进 `tool_call.before_state` */
export function serializeBeforeState(state: BeforeState): string {
  return JSON.stringify(state);
}

/**
 * 从库里读回来。
 *
 * 解析失败一律返回 null 而不是抛异常：一条坏掉的审计记录不该让
 * "撤销另一条记录"也跟着失败。调用方看到 null 会拒绝撤销并给出可读提示。
 */
export function parseBeforeState(raw: string | null): BeforeState | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") return null;
    const kind = (parsed as { kind?: unknown }).kind;
    if (kind !== "create" && kind !== "update" && kind !== "rename" && kind !== "delete") {
      return null;
    }
    const title = (parsed as { title?: unknown }).title;
    if (typeof title !== "string") return null;
    return parsed as BeforeState;
  } catch {
    return null;
  }
}
