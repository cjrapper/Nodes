/**
 * 仓储层：所有 SQL 都集中在这里，上层（API 路由、AI 编排）只面对领域对象。
 *
 * 命名参数一律使用 `@name` 前缀（better-sqlite3 要求绑定对象带前缀键），
 * 拼 SQL 时用 `${P}name`，避免手写前缀漏掉导致运行时才炸。
 */

import { getDb, newId } from "./index";
import { parseAppearance } from "./types";
import type {
  Block,
  BlockKind,
  Conversation,
  Doc,
  DocKind,
  Invocation,
  Message,
  ModelConfig,
  ProviderKind,
  Workspace,
  WorkspaceAppearance,
} from "./types";

/** 命名参数前缀 */
const P = "@";

function now(): number {
  return Date.now();
}

/* ------------------------------------------------------------------ *
 * workspace
 * ------------------------------------------------------------------ */

/** 把 workspace.appearance 的 JSON 字符串解析成对象 —— 坏数据一律回退为空对象 */
function rowToAppearance(raw: unknown): WorkspaceAppearance {
  let parsed: unknown = {};
  try {
    parsed = JSON.parse(typeof raw === "string" && raw ? raw : "{}") as unknown;
  } catch {
    parsed = {};
  }
  return parseAppearance(parsed);
}

export function getWorkspace(id?: string): Workspace | null {
  const db = getDb();
  const row = id
    ? db
        .prepare<
          [string],
          Record<string, unknown>
        >("SELECT * FROM workspace WHERE id = ?")
        .get(id)
    : db
        .prepare<
          [],
          Record<string, unknown>
        >("SELECT * FROM workspace ORDER BY created_at LIMIT 1")
        .get();
  if (!row) return null;
  return {
    id: row.id as string,
    name: row.name as string,
    persona: row.persona as string,
    conventions: row.conventions as string,
    appearance: rowToAppearance(row.appearance),
    createdAt: row.created_at as number,
    updatedAt: row.updated_at as number,
  };
}

export function updateWorkspace(
  id: string,
  patch: Partial<Pick<Workspace, "name" | "persona" | "conventions">> & {
    /** 允许只传部分外观字段，缺的沿用当前值 */
    appearance?: Partial<WorkspaceAppearance>;
  },
): Workspace | null {
  const current = getWorkspace(id);
  if (!current) return null;
  getDb()
    .prepare(
      `UPDATE workspace
         SET name = ${P}name, persona = ${P}persona, conventions = ${P}conventions,
             appearance = ${P}appearance, updated_at = ${P}updatedAt
       WHERE id = ${P}id`,
    )
    .run({
      id,
      name: patch.name ?? current.name,
      persona: patch.persona ?? current.persona,
      conventions: patch.conventions ?? current.conventions,
      // 存字符串前先过一遍容错解析，避免把半截/超范围的值写进库
      appearance: JSON.stringify(
        patch.appearance === undefined
          ? current.appearance
          : parseAppearance({ ...current.appearance, ...patch.appearance }),
      ),
      updatedAt: now(),
    });
  return getWorkspace(id);
}

/* ------------------------------------------------------------------ *
 * doc
 * ------------------------------------------------------------------ */

function rowToDoc(row: Record<string, unknown>): Doc {
  return {
    id: row.id as string,
    workspaceId: row.workspace_id as string,
    parentId: (row.parent_id as string | null) ?? null,
    title: row.title as string,
    icon: (row.icon as string) ?? "",
    // 旧库里的行没有这一列时按普通文档处理
    kind: row.kind === "module" ? "module" : "doc",
    sort: row.sort as number,
    deletedAt: (row.deleted_at as number | null) ?? null,
    createdAt: row.created_at as number,
    updatedAt: row.updated_at as number,
  };
}

export function listDocs(workspaceId: string): Doc[] {
  const rows = getDb()
    .prepare<
      [string],
      Record<string, unknown>
    >(
      "SELECT * FROM doc WHERE workspace_id = ? AND deleted_at IS NULL ORDER BY sort, created_at",
    )
    .all(workspaceId);
  return rows.map(rowToDoc);
}

/**
 * 取一篇文档。**已软删的不返回**（返回 `null`）。
 *
 * 这条过滤顺带成了别的读路径的保险：`GET /api/blocks` 之类都是先
 * `getDoc(docId)` 确认存在再查块，所以删掉的文档不会从侧门漏出来。
 * 但**直接 JOIN doc 的查询必须自己加过滤** —— 见下面的覆盖度与搜索。
 */
export function getDoc(id: string): Doc | null {
  const row = getDb()
    .prepare<
      [string],
      Record<string, unknown>
    >("SELECT * FROM doc WHERE id = ? AND deleted_at IS NULL")
    .get(id);
  return row ? rowToDoc(row) : null;
}

export function createDoc(input: {
  workspaceId: string;
  parentId?: string | null;
  title?: string;
  icon?: string;
  kind?: DocKind;
}): Doc {
  const ts = now();
  const id = newId("doc");
  const maxSort = getDb()
    .prepare<
      [string, string | null],
      { m: number | null }
    >("SELECT MAX(sort) AS m FROM doc WHERE workspace_id = ? AND parent_id IS ? AND deleted_at IS NULL")
    .get(input.workspaceId, input.parentId ?? null);
  getDb()
    .prepare(
      `INSERT INTO doc (id, workspace_id, parent_id, title, icon, kind, sort, created_at, updated_at)
       VALUES (${P}id, ${P}workspaceId, ${P}parentId, ${P}title, ${P}icon, ${P}kind, ${P}sort, ${P}createdAt, ${P}updatedAt)`,
    )
    .run({
      id,
      workspaceId: input.workspaceId,
      parentId: input.parentId ?? null,
      title: input.title ?? "",
      icon: input.icon ?? "",
      kind: input.kind ?? "doc",
      sort: (maxSort?.m ?? -1) + 1,
      createdAt: ts,
      updatedAt: ts,
    });
  return getDoc(id)!;
}

export function updateDoc(
  id: string,
  patch: Partial<Pick<Doc, "title" | "icon" | "kind" | "parentId" | "sort">>,
): Doc | null {
  const current = getDoc(id);
  if (!current) return null;
  getDb()
    .prepare(
      `UPDATE doc
         SET title = ${P}title, icon = ${P}icon, kind = ${P}kind, parent_id = ${P}parentId,
             sort = ${P}sort, updated_at = ${P}updatedAt
       WHERE id = ${P}id`,
    )
    .run({
      id,
      title: patch.title ?? current.title,
      icon: patch.icon ?? current.icon,
      kind: patch.kind ?? current.kind,
      parentId: patch.parentId === undefined ? current.parentId : patch.parentId,
      sort: patch.sort ?? current.sort,
      updatedAt: now(),
    });
  return getDoc(id);
}

/**
 * 删除文档及其所有子文档 —— **软删除**。
 *
 * ## 为什么改成软删
 *
 * 这里原来是 `DELETE FROM doc` + 级联删块，一次误操作就永久带走一篇文档
 * 和它的全部块，而且 `doc` 表上没有任何删除标记，**删掉就真的没了**。
 * 用户的知识笔记是唯一不可再生的东西（`AGENTS.md` 第五节：
 * 破坏用户数据是唯一不可接受的失败），所以"删除"必须是可逆的。
 *
 * 现在写 `deleted_at` 时间戳，整棵子树一起标记。读路径一律过滤
 * （`listDocs` / `getDoc` / 覆盖度 / 搜索），所以**行为上仍然是"删掉了"**，
 * 但数据留在库里，可以恢复。
 *
 * 块的追加式修订意味着旧内容本来就都在，这一步补上的是"整篇文档"那一层。
 *
 * 返回被删除的文档 id 列表，便于前端同步状态。
 */
export function deleteDoc(id: string): string[] {
  const db = getDb();
  const all = db
    .prepare<
      [],
      { id: string; parent_id: string | null }
    >("SELECT id, parent_id FROM doc WHERE deleted_at IS NULL")
    .all();
  const childrenOf = new Map<string | null, string[]>();
  for (const row of all) {
    const list = childrenOf.get(row.parent_id) ?? [];
    list.push(row.id);
    childrenOf.set(row.parent_id, list);
  }
  const toDelete: string[] = [];
  const walk = (docId: string) => {
    toDelete.push(docId);
    for (const child of childrenOf.get(docId) ?? []) walk(child);
  };
  walk(id);

  const stmt = db.prepare("UPDATE doc SET deleted_at = ?, updated_at = ? WHERE id = ?");
  const ts = now();
  const run = db.transaction((ids: string[]) => {
    for (const docId of ids) stmt.run(ts, ts, docId);
  });
  run(toDelete);
  return toDelete;
}

/**
 * 列出已软删的文档，最近删的在前。给"回收站 / 撤销"用。
 *
 * 刻意**不带**块数统计：这里只回答"我删过什么、什么时候删的"，
 * 不是列表页，统计留给真正需要它的地方。
 */
export function listDeletedDocs(workspaceId: string): Doc[] {
  const rows = getDb()
    .prepare<
      [string],
      Record<string, unknown>
    >(
      `SELECT * FROM doc
        WHERE workspace_id = ? AND deleted_at IS NOT NULL
        ORDER BY deleted_at DESC`,
    )
    .all(workspaceId);
  return rows.map(rowToDoc);
}

/**
 * 恢复一篇被软删的文档（连同它那一次被一起删掉的子树）。
 *
 * ## 判据为什么是"同一个 deleted_at"而不是"整棵子树"
 *
 * 删父文档时整棵子树被打上**同一个时间戳**（见 `deleteDoc`）。而用户完全可能
 * 先单独删掉一个子文档、之后再删父文档 —— 那种情况下子文档的时间戳更早，
 * 不该被这次恢复顺带复活（用户当初就是想删它）。
 *
 * 所以只恢复 `deleted_at` 等于目标文档那一批。这个判据是精确的：
 * 一次删除动作产生一个时间戳，恢复就还原子集。
 *
 * 恢复后**不碰 `updated_at` 之外的时间戳**，`sort` 与 `parentId` 原样保留 ——
 * 文档会回到它原来的位置，而不是变成列表末尾的新文档。
 */
export function restoreDoc(id: string): string[] | null {
  const db = getDb();
  const target = db
    .prepare<
      [string],
      { id: string; deleted_at: number | null }
    >("SELECT id, deleted_at FROM doc WHERE id = ?")
    .get(id);
  // 不存在，或者本来就没被删 —— 都返回 null，由调用方区分这两种情况
  if (!target || target.deleted_at === null) return null;

  const stamp = target.deleted_at;
  const all = db
    .prepare<
      [],
      { id: string; parent_id: string | null }
    >("SELECT id, parent_id FROM doc")
    .all();
  const childrenOf = new Map<string | null, string[]>();
  for (const row of all) {
    const list = childrenOf.get(row.parent_id) ?? [];
    list.push(row.id);
    childrenOf.set(row.parent_id, list);
  }

  const toRestore: string[] = [];
  const seen = new Set<string>();
  const walk = (docId: string) => {
    if (seen.has(docId)) return;
    seen.add(docId);
    toRestore.push(docId);
    for (const child of childrenOf.get(docId) ?? []) walk(child);
  };
  walk(id);

  const stmt = db.prepare(
    "UPDATE doc SET deleted_at = NULL, updated_at = ? WHERE id = ? AND deleted_at = ?",
  );
  const ts = now();
  const run = db.transaction((ids: string[]) => {
    for (const docId of ids) stmt.run(ts, docId, stamp);
  });
  run(toRestore);

  // 只回报**真的被恢复**的那些（时间戳不匹配的子文档会留在回收站里）
  return toRestore.filter((docId) => {
    const row = db.prepare<[string], { deleted_at: number | null }>(
      "SELECT deleted_at FROM doc WHERE id = ?",
    ).get(docId);
    return row?.deleted_at === null;
  });
}

/**
 * **彻底清除**一篇已软删的文档及其子树的全部数据。不可逆。
 *
 * ## 为什么必须有它
 *
 * 软删让数据永远留在库里。用户删掉一篇含隐私内容的笔记时，他要的是
 * "真的没了"，而不是"看不见了" —— 没有这个函数，回收站就是一个只进不出的
 * 黑洞，而 `--purge` 这一侧的语义（"彻底删掉"）在实现里根本不存在。
 *
 * ## 两道保护（这是全库唯一不可逆的操作）
 *
 * 1. **只清已经软删的**。传一篇活着的文档会返回 `null`，调用方据此回 400。
 *    这样"手滑传错 id"最多是删掉一个已经在回收站里的东西，
 *    而不是把一篇正在用的笔记永久抹掉。
 * 2. **只清一棵子树**，没有"清空全部"的入口。批量永久删除必须由人逐个确认。
 *
 * 块与文档由外键 `ON DELETE CASCADE` 一起带走 —— 这一点在这里是**想要**的
 * 行为（与之前"误删带走笔记"相反，这次是"确认要删，就该删干净"）。
 */
export function purgeDoc(id: string): string[] | null {
  const db = getDb();
  const target = db
    .prepare<
      [string],
      { deleted_at: number | null }
    >("SELECT deleted_at FROM doc WHERE id = ?")
    .get(id);
  if (!target || target.deleted_at === null) return null;

  const all = db
    .prepare<
      [],
      { id: string; parent_id: string | null }
    >("SELECT id, parent_id FROM doc")
    .all();
  const childrenOf = new Map<string | null, string[]>();
  for (const row of all) {
    const list = childrenOf.get(row.parent_id) ?? [];
    list.push(row.id);
    childrenOf.set(row.parent_id, list);
  }

  const toPurge: string[] = [];
  const seen = new Set<string>();
  const walk = (docId: string) => {
    if (seen.has(docId)) return;
    seen.add(docId);
    toPurge.push(docId);
    for (const child of childrenOf.get(docId) ?? []) walk(child);
  };
  walk(id);

  const stmt = db.prepare("DELETE FROM doc WHERE id = ?");
  const run = db.transaction((ids: string[]) => {
    for (const docId of ids) stmt.run(docId);
  });
  run(toPurge);
  return toPurge;
}

/**
 * 往上找第一个还在回收站里的祖先；没有就返回 `null`。
 * 用途见 `DELETE /api/docs?id=…&restore=1`：祖先还删着的时候恢复子文档，
 * 会让它挂不到任何可见节点上 —— 接口回 200、列表里却不出现。
 * 这种"成功但看不见"比直接报错难查得多，所以在入口就拦住。
 */
export function findDeletedAncestor(
  id: string,
): { id: string; title: string } | null {
  const db = getDb();
  const row = db
    .prepare<
      [string],
      { parent_id: string | null }
    >("SELECT parent_id FROM doc WHERE id = ?")
    .get(id);
  if (!row) return null;

  const guard = new Set<string>();
  let cursor = row.parent_id;
  while (cursor) {
    if (guard.has(cursor)) break; // 数据异常时不死循环
    guard.add(cursor);
    const parent = db
      .prepare<
        [string],
        { id: string; title: string; parent_id: string | null; deleted_at: number | null }
      >("SELECT id, title, parent_id, deleted_at FROM doc WHERE id = ?")
      .get(cursor);
    if (!parent) return null; // 父行不在了（正常不该发生），不拦
    if (parent.deleted_at !== null) return { id: parent.id, title: parent.title };
    cursor = parent.parent_id;
  }
  return null;
}

/* ------------------------------------------------------------------ *
 * block
 * ------------------------------------------------------------------ */

interface BlockRow extends Record<string, unknown> {
  id: string;
  doc_id: string;
  seq: number;
  kind: string;
  text: string;
  text_hash: string;
  updated_at: number;
}

function rowToBlock(row: BlockRow): Block {
  return {
    id: row.id,
    docId: row.doc_id,
    seq: row.seq,
    kind: row.kind as BlockKind,
    text: row.text,
    textHash: row.text_hash,
    updatedAt: row.updated_at,
  };
}

/**
 * 读取文档的当前块（每个 id 取最大 revision）。
 *
 * ⚠️ 文档被软删时返回空数组。
 *
 * 这不是多余的一层保护：`listBlocks` 只按 `doc_id` 查，**完全绕过了
 * `getDoc` 的存在性检查**。软删上线后如果不在这里过滤，会出现一种很难发现的
 * 状态：一篇"已经删掉"的文档，它里面对话仍在 @ 引用的块**照旧进 AI 上下文**，
 * 而 `getDoc` 返回 null 让标题退化成「未命名文档」—— 既没干净消失，
 * 也没正常参与，用户只会觉得"这段内容怎么还在被引用"。
 */
export function listBlocks(docId: string): Block[] {
  const rows = getDb()
    .prepare<[string], BlockRow>(
      `SELECT b.id, b.doc_id, b.seq, b.kind, b.text, b.text_hash, b.updated_at
         FROM block b
         JOIN doc d ON d.id = b.doc_id AND d.deleted_at IS NULL
         JOIN (SELECT id, MAX(revision) AS rev FROM block WHERE doc_id = ? GROUP BY id) cur
           ON cur.id = b.id AND cur.rev = b.revision
        ORDER BY b.seq`,
    )
    .all(docId);
  return rows.map(rowToBlock);
}

/** 取单个块。所在文档已软删时返回 `null`（理由同 `listBlocks`）。 */
export function getBlock(id: string): Block | null {
  const row = getDb()
    .prepare<[string], BlockRow>(
      `SELECT b.id, b.doc_id, b.seq, b.kind, b.text, b.text_hash, b.updated_at
         FROM block b
         JOIN doc d ON d.id = b.doc_id AND d.deleted_at IS NULL
        WHERE b.id = ? ORDER BY b.revision DESC LIMIT 1`,
    )
    .get(id);
  return row ? rowToBlock(row) : null;
}

/**
 * 批量取块（@ 引用回显走这里）。**所在文档已软删的块直接不返回。**
 *
 * 调用方（`/api/refs`）把"查不到"当作 `missing` 处理，所以删掉的文档
 * 会自动从引用列表里消失，而不是留一段点不开的幽灵引用。
 */
export function getBlocksByIds(ids: readonly string[]): Block[] {
  if (ids.length === 0) return [];
  const placeholders = ids.map(() => "?").join(",");
  const rows = getDb()
    .prepare<string[], BlockRow>(
      `SELECT b.id, b.doc_id, b.seq, b.kind, b.text, b.text_hash, b.updated_at
         FROM block b
         JOIN doc d ON d.id = b.doc_id AND d.deleted_at IS NULL
         JOIN (SELECT id, MAX(revision) AS rev FROM block WHERE id IN (${placeholders}) GROUP BY id) cur
           ON cur.id = b.id AND cur.rev = b.revision`,
    )
    .all(...ids);
  return rows.map(rowToBlock);
}

export interface BlockInput {
  id?: string;
  kind: BlockKind;
  text: string;
}

/**
 * 保存文档的块结构 —— **追加式修订**。
 *
 * 行为：
 *  - 内容哈希未变的块：只更新 seq，**不写新 revision**。
 *    这一步至关重要：无谓的新 revision 会让 cacheKey 变化，
 *    导致引用它的对话缓存全部失效。
 *  - 内容变了：写一个新 revision。
 *  - 新块：插入 revision 1。
 *  - 本次未出现的块：**软删除**（seq = -1 并写一条空文本修订）。
 *    不硬删是为了让历史 @ 引用仍能追溯。
 *
 * ## 块身份是怎么保住的（这段逻辑是缓存稳定性的关键）
 *
 * 调用方传来的 `inputs[i].id` 是"上一次保存时的第 i 个块的 id"。但用户
 * 完全可能在第 2 段后面插入一段 —— 那样从第 3 段起，位置与 id 就整体错位了。
 * 如果直接按位置采信，后面每一个块的"内容"看起来都变了，
 * 于是全都被写成新 revision、cacheKey 全部翻新，**引用这篇文档的所有会话
 * 的 L2 缓存会被无谓地整体击穿**。
 *
 * 所以块身份的认领分三趟走（顺序不能变，理由见函数内注释）：
 *   1. **按内容哈希**把没变动的块钉死到原 id —— 这是"在中间插入一段"时
 *      保住后续所有块身份的关键。
 *   2. 用**位置提示**消化剩下的槽位，也就是内容被改过的那些块 ——
 *      这是"编辑一段"时保住该块身份的关键。
 *   3. 都没匹配上的才是真正的新块，生成全新 id。
 *
 * 早期版本只做其中一趟，结果两头都漏：先做位置匹配则插入一段会让后面全部
 * 块翻新 cacheKey；先要求哈希一致则每次编辑都变成"删旧建新"。
 * 两种都会把引用本文档的所有会话的 L2 缓存整体击穿。
 *
 * ## 为什么还需要一条「显式复原」通道（options.reviveIds）
 *
 * 三趟认领有一个共同的盲点：**它只看当前还活着的块**（`seq >= 0`）。
 * 块一旦在上一轮保存里被软删，就不在候选里了，于是
 *
 *   - 用户撤销一次"把这段删掉了"的改写时，写回去的块会**发一个新 id**；
 *   - `@` 引用指向的是旧 id，因此**引用不会自动接回来** ——
 *     而内容看起来一模一样，界面上完全看不出差别。
 *
 * `update_doc` 允许 AI 删减内容之后，这条路径从"罕见"变成"常见"：
 * 撤销必须能把被删掉的块按原 id 复活。所以给调用方一个显式入口 ——
 * 传进来的 id 若命中一个**已软删、且内容与类型完全一致**的历史块，
 * 就沿用它的 id 复活（写新 revision），而不是另起一个新块。
 *
 * 判据刻意严格到"内容与类型逐字相同"：这是**复原**，不是**认领**。
 * 内容不同就该走正常的新建/改写路径，否则会把两个不相干的块混成一个。
 */
export function saveDocBlocks(
  docId: string,
  inputs: readonly BlockInput[],
  hashFn: (text: string) => string,
  /** 上一次保存时的块 id 序列（按位置）。不传则从库里当前状态取。 */
  previousIds?: readonly (string | null)[],
  /**
   * 显式复原已软删的块。传进来的 id 若命中一个已软删、且内容与类型
   * 完全一致的历史块，就沿用它的 id 复活（而不是新建一个块）。
   * 撤销 AI 删减内容时用它把 `@` 引用接回去。
   */
  options?: { reviveIds?: readonly string[] },
): { changed: string[]; created: string[]; removed: string[]; revived: string[] } {
  const db = getDb();
  const ts = now();
  const existing = new Map(listBlocks(docId).map((b) => [b.id, b]));

  // 既有块按内容哈希建索引，供错位时的兜底认领
  const byHash = new Map<string, string[]>();
  for (const [id, block] of existing) {
    if (block.seq < 0) continue; // 已软删的不参与认领
    const list = byHash.get(block.textHash) ?? [];
    list.push(id);
    byHash.set(block.textHash, list);
  }

  const claimed = new Set<string>();
  const changed: string[] = [];
  const created: string[] = [];
  const removed: string[] = [];
  const revived: string[] = [];

  /*
   * 显式复原通道要查的东西：**这个块被软删之前长什么样**。
   *
   * ⚠️ 不能只看当前 revision。软删的写法是把最新 revision 的 `text` 清成空串
   * （见下面"软删除"那段），所以"当前 revision 的内容"永远是空 ——
   * 拿它跟新内容比，判据永远不成立，复原通道等于没接上（真实踩过）。
   *
   * 原文在**最近一条非空 revision** 里，取它的 `text_hash` 与 `kind`：
   *   - `text_hash` 用来判断调用方写回的是不是同一段文字；
   *   - `kind` 取当前 revision（软删保留了 kind，且它不会随文本清空而变）。
   *
   * 只查调用方点名的那几个 id，不做全表扫描 —— 一次撤销涉及的块是有限的。
   */
  const reviveCandidate = db.prepare<
    [string, string, string],
    { id: string; kind: string; seq: number; textHash: string }
  >(
    `SELECT cur.id            AS id,
            cur.kind          AS kind,
            cur.seq           AS seq,
            last.text_hash    AS textHash
       FROM block cur
       JOIN (SELECT id, MAX(revision) AS rev
               FROM block WHERE doc_id = ? GROUP BY id) m
         ON m.id = cur.id AND m.rev = cur.revision
       JOIN block last
         ON last.id = cur.id
        AND last.revision = (SELECT MAX(revision) FROM block
                              WHERE id = cur.id AND text <> '')
      WHERE cur.doc_id = ? AND cur.id = ?`,
  );

  const insertRevision = db.prepare(
    `INSERT INTO block (id, doc_id, seq, kind, text, text_hash, revision, updated_at)
     VALUES (${P}id, ${P}docId, ${P}seq, ${P}kind, ${P}text, ${P}textHash, ${P}revision, ${P}updatedAt)`,
  );
  const nextRevision = db.prepare<[string], { r: number | null }>(
    "SELECT MAX(revision) AS r FROM block WHERE id = ?",
  );
  const bumpSeq = db.prepare(
    `UPDATE block SET seq = ${P}seq WHERE id = ${P}id AND revision = ${P}revision`,
  );

  const tx = db.transaction(() => {
    const hashes = inputs.map((input) => hashFn(input.text));
    const hints = inputs.map((input, index) => input.id ?? previousIds?.[index] ?? undefined);

    /** 每个位置最终用哪个既有块 id（null 表示要新建） */
    const assigned: (string | null)[] = new Array(inputs.length).fill(null);

    /**
     * 第零趟：**显式复原已软删的块**（只有撤销会用到）。
     *
     * 必须跑在三趟认领**之前**：那三趟都只看活着的块（`seq >= 0`），
     * 已软删的块对它们不可见。先把点名的 id 复活，后面的趟次才不会
     * 把它当成"新块"另发一个 id。
     *
     * 判据刻意严到"内容与类型逐字相同"—— 这是复原，不是认领。
     * 内容对不上就说明调用方想写的不是原来那个块，交给正常路径处理。
     */
    if (options?.reviveIds && options.reviveIds.length > 0) {
      for (let index = 0; index < inputs.length; index += 1) {
        const wanted = inputs[index].id;
        if (!wanted || !options.reviveIds.includes(wanted)) continue;
        if (claimed.has(wanted)) continue;

        const row = reviveCandidate.get(docId, docId, wanted);
        if (!row) continue; // 这个 id 在这篇文档里从未存在过，或没有过非空内容
        if (row.seq >= 0) continue; // 还活着，走正常认领
        if (row.kind !== inputs[index].kind) continue;
        /*
         * 比对"被软删之前那段文字"的哈希。
         * 对不上说明调用方想写的不是原来那个块 —— 那是改写，不是复原，
         * 交给正常路径去发新 id，不要把它硬按到旧身份上。
         */
        if (row.textHash !== hashes[index]) continue;

        claimed.add(wanted);
        assigned[index] = wanted;
        revived.push(wanted);
      }
    }

    /**
     * 第一趟：**按内容把没变动的块优先钉死**。
     *
     * 这一趟必须跑在所有位置匹配之前。理由是"编辑"和"插入"对匹配方式的要求
     * 正好相反，而先做内容匹配能同时满足两者：
     *
     *  - **插入一段**（最危险的情形）：从插入点起，后面每个位置的 id 提示
     *    都整体错位、指向了前一个块。若先按位置匹配，这些块会被判定为
     *    "内容变了"，从而集体翻新 cacheKey，把引用本文档的所有会话缓存击穿。
     *    先按内容匹配，它们的正文逐一都能找到原主，id 原样保留。
     *  - **编辑一段**：被编辑的那个块内容对不上，本趟找不到主，留给第二趟。
     *
     * ⚠️ 但"认领"必须逐个满足两个条件，否则会**张冠李戴**：
     *
     *  1. **kind 必须相同。** 早先只比哈希，于是"## dupe"与"dupe"内容哈希
     *     不同但无所谓 —— 真正出事的是同一段文字先后以不同类型出现时，
     *     会把 ID 认到类型不同的块上。第三趟本来就会处理 kind 变化
     *     （走 revision），所以这里排除掉它们不丢任何能力，只是把
     *     "该走 revision" 的块正确地留给第二趟。
     *
     *  2. **同内容候选里取位置最近的那个。** 这是本趟曾经的真实缺陷：
     *     文档里有两段完全相同的文字（`dupe / other / dupe`）时，
     *     编辑**靠前**那一段会让它的哈希不再匹配，而靠后那段仍在候选里，
     *     于是"第一个未认领的候选"把**靠后那段的 ID 发给了靠前的位置**。
     *     结果两个块的 ID 对调：引用"靠后那段"的会话拿到了编辑后的内容
     *     （内容张冠李戴），而靠后那段自己换了个新 ID、原 ID 被软删。
     *
     *     按位置距离取最近，能同时满足两个目标：相同的块各自归位
     *     （距离 0 优先），被编辑的块则留给第二趟按位置提示认领。
     *
     * 副作用是"内容相同但其实是两个不同块"时会认成同一个 —— 这在缓存意义下
     * 无害：两者字节完全一致，缓存键本来就该一样。
     */
    inputs.forEach((_, index) => {
      const candidates = byHash.get(hashes[index]);
      if (!candidates) return;
      let best: string | null = null;
      let bestDistance = Number.POSITIVE_INFINITY;
      for (const candidate of candidates) {
        if (claimed.has(candidate)) continue;
        const prev = existing.get(candidate);
        // 类型不同的块不能在本趟被认领（留给第二趟走 revision）
        if (!prev || prev.kind !== inputs[index].kind) continue;
        // seq 是上一次的真实位置，用它算距离；软删的块 seq < 0，已在 byHash 里排除
        const distance = Math.abs(prev.seq - index);
        if (distance < bestDistance) {
          bestDistance = distance;
          best = candidate;
        }
      }
      if (best !== null) {
        claimed.add(best);
        assigned[index] = best;
      }
    });

    /**
     * 第二趟：用位置提示消化"内容变了"的槽位 —— 也就是被编辑过的块。
     *
     * 这一步是块身份在编辑后得以延续的关键：用户改了某段，期望的是那一段
     * 被更新，而不是删掉旧的、另建一个新的。若走成后者，块 id 会换新、
     * cacheKey 随之全变，引用它的会话缓存会被完全击穿。
     */
    inputs.forEach((_, index) => {
      if (assigned[index] !== null) return;
      const hint = hints[index];
      if (hint && existing.has(hint) && !claimed.has(hint)) {
        const prev = existing.get(hint)!;
        if (prev.seq >= 0) {
          claimed.add(hint);
          assigned[index] = hint;
        }
      }
    });

    // 第三趟：逐个落库
    inputs.forEach((input, index) => {
      const hash = hashes[index];
      const claimedId = assigned[index];

      if (claimedId) {
        /*
         * ⚠️ 复活的块**不在 `existing` 里** —— `listBlocks` 按 `seq >= 0` 过滤，
         * 已软删的块根本不在那张表里。所以不能用 `existing.get(claimedId)!`
         * （会取到 undefined 然后崩在 `.textHash` 上）。
         *
         * 复活的语义很明确：内容与类型在"第零趟"已经逐字校验过，
         * 这里必须写一条**新 revision 把 seq 摆回正数**，块才算真的活过来。
         */
        if (revived.includes(claimedId)) {
          insertRevision.run({
            id: claimedId,
            docId,
            seq: index,
            kind: input.kind,
            text: input.text,
            textHash: hash,
            revision: (nextRevision.get(claimedId)?.r ?? 0) + 1,
            updatedAt: ts,
          });
          changed.push(claimedId);
          return;
        }

        const prev = existing.get(claimedId)!;
        if (prev.textHash === hash && prev.kind === input.kind) {
          // 内容与类型都没变，只挪位置 —— 不写新 revision
          if (prev.seq !== index) {
            bumpSeq.run({
              id: claimedId,
              seq: index,
              revision: nextRevision.get(claimedId)?.r ?? 1,
            });
          }
          return;
        }
        const rev = (nextRevision.get(claimedId)?.r ?? 0) + 1;
        insertRevision.run({
          id: claimedId,
          docId,
          seq: index,
          kind: input.kind,
          text: input.text,
          textHash: hash,
          revision: rev,
          updatedAt: ts,
        });
        changed.push(claimedId);
        return;
      }

      /**
       * 真正的新块。
       *
       * ⚠️ 必须生成**全新 id**，绝不能用 `hints[index]`：
       * 那个 id 属于别的块（它已经在第一/二趟里被认领了，或者是已被软删的块）。
       * 拿它当新块的 id 会直接撞 `block(id, revision)` 主键。
       */
      const id = newId("blk");
      claimed.add(id);
      insertRevision.run({
        id,
        docId,
        seq: index,
        kind: input.kind,
        text: input.text,
        textHash: hash,
        revision: 1,
        updatedAt: ts,
      });
      created.push(id);
    });

    // 本次未被认领的既有块 → 软删除
    for (const [id, prev] of existing) {
      if (claimed.has(id) || prev.seq === -1) continue;
      const rev = (nextRevision.get(id)?.r ?? 0) + 1;
      insertRevision.run({
        id,
        docId,
        seq: -1,
        kind: prev.kind,
        text: "",
        textHash: hashFn(""),
        revision: rev,
        updatedAt: ts,
      });
      removed.push(id);
    }
  });

  tx();
  return { changed, created, removed, revived };
}

/** 该块被多少个会话引用 —— 用于在编辑前警告"会损失多少缓存" */
export function countBlockReferences(blockId: string): number {
  const row = getDb()
    .prepare<
      [string],
      { c: number }
    >("SELECT COUNT(*) AS c FROM conversation_ref WHERE block_id = ?")
    .get(blockId);
  return row?.c ?? 0;
}

/**
 * 每个文档的"总块数 / 被 AI 看过的块数"，按工作区聚合。
 *
 * 用途是模块概览页的**覆盖度**：只有进过 AI 上下文的内容才可能被挑错、
 * 出题、判断缺失，所以"已看过占比"衡量的是"这个方向有多少内容被检验过"，
 * 比"写了多少字"更接近学习者真正关心的问题。
 *
 * ## 为什么必须把「整篇挂载」展开成子树
 *
 * 挂载一个模块时，`conversation_doc_ref` 里记的是**模块自己**的 id，
 * 而内容全在它的子文档里。第一版直接用 `b.doc_id IN (挂载的 id)` 去比 ——
 * 子文档的 doc_id 永远不等于模块的 id，于是"我用「查漏补缺」看过整个模块"
 * 这件事被算成 0%，而且是最容易被忽略的那类错：指标恒为 0，看起来像没数据。
 *
 * 所以先把挂载的模块展开成完整子树，再判断每个块是否落在其中。
 * 这里刻意复用 `collectDocSubtree`（与 AI 组装用的是同一套展开逻辑），
 * 避免"覆盖度认为看过、实际组装没送进去"这种更糟的不一致。
 */
export function getDocCoverage(
  workspaceId: string,
): Record<string, { blockCount: number; referencedBlockCount: number }> {
  const db = getDb();

  // 1) 被块级引用过的块
  const directlyReferenced = new Set(
    db
      .prepare<[], { block_id: string }>("SELECT DISTINCT block_id FROM conversation_ref")
      .all()
      .map((r) => r.block_id),
  );

  // 2) 被整体挂载的文档/模块 → 展开成子树后，其下每个块都算"看过"
  const mountedDocIds = db
    .prepare<[], { doc_id: string }>("SELECT DISTINCT doc_id FROM conversation_doc_ref")
    .all()
    .map((r) => r.doc_id);
  const mountedBlocks = new Set<string>();
  for (const docId of mountedDocIds) {
    for (const inSubtree of collectDocSubtree(docId)) {
      for (const block of db
        .prepare<[string], { id: string }>(
          "SELECT id FROM block WHERE doc_id = ? AND seq >= 0 AND text <> '' GROUP BY id",
        )
        .all(inSubtree)) {
        mountedBlocks.add(block.id);
      }
    }
  }

  // 3) 按文档聚合
  const rows = db
    .prepare<
      [string],
      { id: string; doc_id: string }
    >(
      `SELECT b.id, b.doc_id
         FROM block b
         JOIN doc d ON d.id = b.doc_id
        WHERE d.workspace_id = ?
          AND d.deleted_at IS NULL
          AND b.seq >= 0
          AND b.text <> ''`,
    )
    .all(workspaceId);

  const out: Record<string, { blockCount: number; referencedBlockCount: number }> = {};
  for (const row of rows) {
    const entry = (out[row.doc_id] ??= { blockCount: 0, referencedBlockCount: 0 });
    entry.blockCount += 1;
    if (directlyReferenced.has(row.id) || mountedBlocks.has(row.id)) {
      entry.referencedBlockCount += 1;
    }
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * model_config
 * ------------------------------------------------------------------ */

function rowToModelConfig(row: Record<string, unknown>): ModelConfig {
  let extra: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse((row.extra_json as string) || "{}") as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      extra = parsed as Record<string, unknown>;
    }
  } catch {
    extra = {};
  }
  return {
    id: row.id as string,
    name: row.name as string,
    provider: row.provider as ProviderKind,
    baseUrl: row.base_url as string,
    apiKey: row.api_key as string,
    model: row.model as string,
    temperature: row.temperature as number,
    maxTokens: row.max_tokens as number | null,
    contextWindow: row.context_window as number,
    supportsPromptCache: Boolean(row.supports_prompt_cache),
    inputPrice: row.input_price as number,
    cachedInputPrice: row.cached_input_price as number,
    outputPrice: row.output_price as number,
    extra,
    isDefault: Boolean(row.is_default),
    createdAt: row.created_at as number,
    updatedAt: row.updated_at as number,
  };
}

export function listModelConfigs(): ModelConfig[] {
  const rows = getDb()
    .prepare<
      [],
      Record<string, unknown>
    >("SELECT * FROM model_config ORDER BY is_default DESC, created_at")
    .all();
  return rows.map(rowToModelConfig);
}

export function getModelConfig(id: string): ModelConfig | null {
  const row = getDb()
    .prepare<
      [string],
      Record<string, unknown>
    >("SELECT * FROM model_config WHERE id = ?")
    .get(id);
  return row ? rowToModelConfig(row) : null;
}

export function getDefaultModelConfig(): ModelConfig | null {
  const row = getDb()
    .prepare<
      [],
      Record<string, unknown>
    >("SELECT * FROM model_config ORDER BY is_default DESC, created_at LIMIT 1")
    .get();
  return row ? rowToModelConfig(row) : null;
}

export function createModelConfig(
  input: Omit<ModelConfig, "id" | "createdAt" | "updatedAt" | "isDefault"> & {
    isDefault?: boolean;
  },
): ModelConfig {
  const db = getDb();
  const ts = now();
  const id = newId("mc");
  const tx = db.transaction(() => {
    if (input.isDefault) db.prepare("UPDATE model_config SET is_default = 0").run();
    db.prepare(
      `INSERT INTO model_config
         (id, name, provider, base_url, api_key, model, temperature, max_tokens,
          context_window, supports_prompt_cache, input_price, cached_input_price,
          output_price, extra_json, is_default, created_at, updated_at)
       VALUES (${P}id, ${P}name, ${P}provider, ${P}baseUrl, ${P}apiKey, ${P}model,
               ${P}temperature, ${P}maxTokens, ${P}contextWindow, ${P}supportsPromptCache,
               ${P}inputPrice, ${P}cachedInputPrice, ${P}outputPrice, ${P}extraJson,
               ${P}isDefault, ${P}createdAt, ${P}updatedAt)`,
    ).run({
      id,
      name: input.name,
      provider: input.provider,
      baseUrl: input.baseUrl,
      apiKey: input.apiKey,
      model: input.model,
      temperature: input.temperature,
      maxTokens: input.maxTokens,
      contextWindow: input.contextWindow,
      supportsPromptCache: input.supportsPromptCache ? 1 : 0,
      inputPrice: input.inputPrice,
      cachedInputPrice: input.cachedInputPrice,
      outputPrice: input.outputPrice,
      extraJson: JSON.stringify(input.extra ?? {}),
      isDefault: input.isDefault ? 1 : 0,
      createdAt: ts,
      updatedAt: ts,
    });
  });
  tx();
  return getModelConfig(id)!;
}

export function updateModelConfig(
  id: string,
  patch: Partial<Omit<ModelConfig, "id" | "createdAt" | "updatedAt">>,
): ModelConfig | null {
  const current = getModelConfig(id);
  if (!current) return null;
  const db = getDb();
  const merged = { ...current, ...patch };
  const tx = db.transaction(() => {
    if (patch.isDefault) db.prepare("UPDATE model_config SET is_default = 0").run();
    db.prepare(
      `UPDATE model_config
          SET name = ${P}name, provider = ${P}provider, base_url = ${P}baseUrl,
              api_key = ${P}apiKey, model = ${P}model, temperature = ${P}temperature,
              max_tokens = ${P}maxTokens, context_window = ${P}contextWindow,
              supports_prompt_cache = ${P}supportsPromptCache, input_price = ${P}inputPrice,
              cached_input_price = ${P}cachedInputPrice, output_price = ${P}outputPrice,
              extra_json = ${P}extraJson, is_default = ${P}isDefault, updated_at = ${P}updatedAt
        WHERE id = ${P}id`,
    ).run({
      id,
      name: merged.name,
      provider: merged.provider,
      baseUrl: merged.baseUrl,
      apiKey: merged.apiKey,
      model: merged.model,
      temperature: merged.temperature,
      maxTokens: merged.maxTokens,
      contextWindow: merged.contextWindow,
      supportsPromptCache: merged.supportsPromptCache ? 1 : 0,
      inputPrice: merged.inputPrice,
      cachedInputPrice: merged.cachedInputPrice,
      outputPrice: merged.outputPrice,
      extraJson: JSON.stringify(merged.extra ?? {}),
      isDefault: merged.isDefault ? 1 : 0,
      updatedAt: now(),
    });
  });
  tx();
  return getModelConfig(id);
}

export function deleteModelConfig(id: string): boolean {
  return getDb().prepare("DELETE FROM model_config WHERE id = ?").run(id).changes > 0;
}

/* ------------------------------------------------------------------ *
 * conversation / message / ref
 * ------------------------------------------------------------------ */

function rowToConversation(row: Record<string, unknown>): Conversation {
  return {
    id: row.id as string,
    workspaceId: row.workspace_id as string,
    title: row.title as string,
    modelConfigId: (row.model_config_id as string | null) ?? null,
    sourceBudgetTokens: row.source_budget_tokens as number,
    createdAt: row.created_at as number,
    updatedAt: row.updated_at as number,
  };
}

export function listConversations(workspaceId: string): Conversation[] {
  const rows = getDb()
    .prepare<
      [string],
      Record<string, unknown>
    >("SELECT * FROM conversation WHERE workspace_id = ? ORDER BY updated_at DESC")
    .all(workspaceId);
  return rows.map(rowToConversation);
}

export function getConversation(id: string): Conversation | null {
  const row = getDb()
    .prepare<
      [string],
      Record<string, unknown>
    >("SELECT * FROM conversation WHERE id = ?")
    .get(id);
  return row ? rowToConversation(row) : null;
}

export function createConversation(input: {
  workspaceId: string;
  title?: string;
  modelConfigId?: string | null;
  refBlockIds?: readonly string[];
}): Conversation {
  const db = getDb();
  const ts = now();
  const id = newId("conv");
  const tx = db.transaction(() => {
    db.prepare(
      `INSERT INTO conversation (id, workspace_id, title, model_config_id, source_budget_tokens, created_at, updated_at)
       VALUES (${P}id, ${P}workspaceId, ${P}title, ${P}modelConfigId, 40000, ${P}createdAt, ${P}updatedAt)`,
    ).run({
      id,
      workspaceId: input.workspaceId,
      title: input.title ?? "新对话",
      modelConfigId: input.modelConfigId ?? null,
      createdAt: ts,
      updatedAt: ts,
    });
    if (input.refBlockIds?.length) {
      const stmt = db.prepare(
        `INSERT OR IGNORE INTO conversation_ref (conversation_id, block_id, pinned, created_at)
         VALUES (${P}cid, ${P}bid, 0, ${P}createdAt)`,
      );
      for (const bid of input.refBlockIds) stmt.run({ cid: id, bid, createdAt: ts });
    }
  });
  tx();
  return getConversation(id)!;
}

export function updateConversation(
  id: string,
  patch: Partial<Pick<Conversation, "title" | "modelConfigId" | "sourceBudgetTokens">>,
): Conversation | null {
  const current = getConversation(id);
  if (!current) return null;
  getDb()
    .prepare(
      `UPDATE conversation
          SET title = ${P}title, model_config_id = ${P}modelConfigId,
              source_budget_tokens = ${P}sourceBudgetTokens, updated_at = ${P}updatedAt
        WHERE id = ${P}id`,
    )
    .run({
      id,
      title: patch.title ?? current.title,
      modelConfigId: patch.modelConfigId === undefined ? current.modelConfigId : patch.modelConfigId,
      sourceBudgetTokens: patch.sourceBudgetTokens ?? current.sourceBudgetTokens,
      updatedAt: now(),
    });
  return getConversation(id);
}

export function deleteConversation(id: string): boolean {
  return getDb().prepare("DELETE FROM conversation WHERE id = ?").run(id).changes > 0;
}

export function listRefBlockIds(conversationId: string): string[] {
  const rows = getDb()
    .prepare<
      [string],
      { block_id: string }
    >("SELECT block_id FROM conversation_ref WHERE conversation_id = ? ORDER BY created_at, block_id")
    .all(conversationId);
  return rows.map((r) => r.block_id);
}

/** 覆盖式设置会话的引用集合 */
export function setConversationRefs(conversationId: string, blockIds: readonly string[]): void {
  const db = getDb();
  const ts = now();
  const tx = db.transaction(() => {
    db.prepare("DELETE FROM conversation_ref WHERE conversation_id = ?").run(conversationId);
    const stmt = db.prepare(
      `INSERT OR IGNORE INTO conversation_ref (conversation_id, block_id, pinned, created_at)
       VALUES (${P}cid, ${P}bid, 0, ${P}createdAt)`,
    );
    for (const bid of blockIds) stmt.run({ cid: conversationId, bid, createdAt: ts });
  });
  tx();
}

export function addConversationRef(conversationId: string, blockId: string): void {
  getDb()
    .prepare(
      `INSERT OR IGNORE INTO conversation_ref (conversation_id, block_id, pinned, created_at)
       VALUES (${P}cid, ${P}bid, 0, ${P}createdAt)`,
    )
    .run({ cid: conversationId, bid: blockId, createdAt: now() });
}

/* ---------------- 整体挂载的文档/模块 ---------------- */

export function listRefDocIds(conversationId: string): string[] {
  const rows = getDb()
    .prepare<
      [string],
      { doc_id: string }
    >("SELECT doc_id FROM conversation_doc_ref WHERE conversation_id = ? ORDER BY created_at, doc_id")
    .all(conversationId);
  return rows.map((r) => r.doc_id);
}

/**
 * 覆盖式设置会话整体挂载的文档集合。
 *
 * 与块级引用一样用"整体替换"而不是增删：调用方（对话面板）手里始终握着
 * 完整的一份列表，替换语义不容易出现"漏删一项"的漂移。
 */
export function setConversationDocRefs(conversationId: string, docIds: readonly string[]): void {
  const db = getDb();
  const ts = now();
  const tx = db.transaction(() => {
    db.prepare("DELETE FROM conversation_doc_ref WHERE conversation_id = ?").run(conversationId);
    const stmt = db.prepare(
      `INSERT OR IGNORE INTO conversation_doc_ref (conversation_id, doc_id, pinned, created_at)
       VALUES (${P}cid, ${P}did, 0, ${P}createdAt)`,
    );
    for (const docId of docIds) stmt.run({ cid: conversationId, did: docId, createdAt: ts });
  });
  tx();
}

/**
 * 取一个文档（或模块）及其**全部后代文档**的 id。
 *
 * 「查漏补缺」需要看整个模块，而模块下面可能还有子模块 ——
 * 只取直接子级会漏掉深层内容，那正是最容易缺失的地方。
 * 这里一次性把整棵子树摊平，并做了环保护（数据异常时不会死循环）。
 */
export function collectDocSubtree(rootId: string): string[] {
  const all = getDb()
    .prepare<
      [],
      { id: string; parent_id: string | null }
    >("SELECT id, parent_id FROM doc WHERE deleted_at IS NULL")
    .all();

  const childrenOf = new Map<string | null, string[]>();
  for (const row of all) {
    const list = childrenOf.get(row.parent_id) ?? [];
    list.push(row.id);
    childrenOf.set(row.parent_id, list);
  }

  const out: string[] = [];
  const seen = new Set<string>();
  const walk = (id: string) => {
    if (seen.has(id)) return;
    seen.add(id);
    out.push(id);
    for (const child of childrenOf.get(id) ?? []) walk(child);
  };
  walk(rootId);
  return out;
}

function rowToMessage(row: Record<string, unknown>): Message {
  let refs: string[] = [];
  try {
    const parsed = JSON.parse((row.ref_block_ids as string) || "[]") as unknown;
    if (Array.isArray(parsed)) refs = parsed.filter((x): x is string => typeof x === "string");
  } catch {
    refs = [];
  }
  return {
    id: row.id as string,
    conversationId: row.conversation_id as string,
    role: row.role as Message["role"],
    content: row.content as string,
    refBlockIds: refs,
    seq: row.seq as number,
    createdAt: row.created_at as number,
  };
}

export function listMessages(conversationId: string): Message[] {
  const rows = getDb()
    .prepare<
      [string],
      Record<string, unknown>
    >("SELECT * FROM message WHERE conversation_id = ? ORDER BY seq")
    .all(conversationId);
  return rows.map(rowToMessage);
}

export function getMessage(id: string): Message | null {
  const row = getDb()
    .prepare<
      [string],
      Record<string, unknown>
    >("SELECT * FROM message WHERE id = ?")
    .get(id);
  return row ? rowToMessage(row) : null;
}

export function appendMessage(input: {
  conversationId: string;
  role: Message["role"];
  content: string;
  refBlockIds?: readonly string[];
}): Message {
  const db = getDb();
  const ts = now();
  const id = newId("msg");
  const maxSeq = db
    .prepare<
      [string],
      { m: number | null }
    >("SELECT MAX(seq) AS m FROM message WHERE conversation_id = ?")
    .get(input.conversationId);
  db.prepare(
    `INSERT INTO message (id, conversation_id, role, content, ref_block_ids, seq, created_at)
     VALUES (${P}id, ${P}conversationId, ${P}role, ${P}content, ${P}refBlockIds, ${P}seq, ${P}createdAt)`,
  ).run({
    id,
    conversationId: input.conversationId,
    role: input.role,
    content: input.content,
    refBlockIds: JSON.stringify(input.refBlockIds ?? []),
    seq: (maxSeq?.m ?? -1) + 1,
    createdAt: ts,
  });
  db.prepare("UPDATE conversation SET updated_at = ? WHERE id = ?").run(ts, input.conversationId);
  return getMessage(id)!;
}

/** 删除某条消息及其之后的所有消息 —— 用于"重新生成" */
export function deleteMessagesFrom(conversationId: string, seq: number): number {
  return getDb()
    .prepare("DELETE FROM message WHERE conversation_id = ? AND seq >= ?")
    .run(conversationId, seq).changes;
}

/* ------------------------------------------------------------------ *
 * invocation
 * ------------------------------------------------------------------ */

function rowToInvocation(row: Record<string, unknown>): Invocation {
  let hashes: Record<string, string> = {};
  try {
    const parsed = JSON.parse((row.layer_hashes_json as string) || "{}") as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      hashes = parsed as Record<string, string>;
    }
  } catch {
    hashes = {};
  }
  return {
    id: row.id as string,
    conversationId: row.conversation_id as string,
    messageId: (row.message_id as string | null) ?? null,
    modelConfigId: (row.model_config_id as string | null) ?? null,
    provider: row.provider as string,
    model: row.model as string,
    layerHashes: hashes,
    prefixHash: row.prefix_hash as string,
    stablePrefixTokens: row.stable_prefix_tokens as number,
    predictedCachedTokens: row.predicted_cached_tokens as number,
    predictedWriteTokens: row.predicted_write_tokens as number,
    promptTokens: row.prompt_tokens as number,
    cachedTokens: row.cached_tokens as number,
    cacheWriteTokens: row.cache_write_tokens as number,
    completionTokens: row.completion_tokens as number,
    actualUsd: row.actual_usd as number,
    baselineUsd: row.baseline_usd as number,
    savedUsd: row.saved_usd as number,
    latencyMs: row.latency_ms as number,
    status: row.status as string,
    error: (row.error as string | null) ?? null,
    requestFingerprint: row.request_fingerprint as string,
    createdAt: row.created_at as number,
  };
}

export type InvocationInput = Omit<Invocation, "id" | "createdAt"> & { id?: string };

export function recordInvocation(input: InvocationInput): Invocation {
  const db = getDb();
  const id = input.id ?? newId("inv");
  const ts = now();
  db.prepare(
    `INSERT INTO invocation
       (id, conversation_id, message_id, model_config_id, provider, model,
        layer_hashes_json, prefix_hash, stable_prefix_tokens, predicted_cached_tokens,
        predicted_write_tokens, prompt_tokens, cached_tokens, cache_write_tokens,
        completion_tokens, actual_usd, baseline_usd, saved_usd, latency_ms,
        status, error, request_fingerprint, created_at)
     VALUES (${P}id, ${P}conversationId, ${P}messageId, ${P}modelConfigId, ${P}provider, ${P}model,
             ${P}layerHashesJson, ${P}prefixHash, ${P}stablePrefixTokens, ${P}predictedCachedTokens,
             ${P}predictedWriteTokens, ${P}promptTokens, ${P}cachedTokens, ${P}cacheWriteTokens,
             ${P}completionTokens, ${P}actualUsd, ${P}baselineUsd, ${P}savedUsd, ${P}latencyMs,
             ${P}status, ${P}error, ${P}requestFingerprint, ${P}createdAt)`,
  ).run({
    id,
    conversationId: input.conversationId,
    messageId: input.messageId,
    modelConfigId: input.modelConfigId,
    provider: input.provider,
    model: input.model,
    layerHashesJson: JSON.stringify(input.layerHashes),
    prefixHash: input.prefixHash,
    stablePrefixTokens: input.stablePrefixTokens,
    predictedCachedTokens: input.predictedCachedTokens,
    predictedWriteTokens: input.predictedWriteTokens,
    promptTokens: input.promptTokens,
    cachedTokens: input.cachedTokens,
    cacheWriteTokens: input.cacheWriteTokens,
    completionTokens: input.completionTokens,
    actualUsd: input.actualUsd,
    baselineUsd: input.baselineUsd,
    savedUsd: input.savedUsd,
    latencyMs: input.latencyMs,
    status: input.status,
    error: input.error,
    requestFingerprint: input.requestFingerprint,
    createdAt: ts,
  });
  const row = db
    .prepare<
      [string],
      Record<string, unknown>
    >("SELECT * FROM invocation WHERE id = ?")
    .get(id);
  return rowToInvocation(row!);
}

/** 取会话最近一次**成功**的调用，用于命中预测与断点决策 */
export function getLastInvocation(conversationId: string): Invocation | null {
  const row = getDb()
    .prepare<
      [string],
      Record<string, unknown>
    >(
      `SELECT * FROM invocation
        WHERE conversation_id = ? AND status = 'ok'
        ORDER BY created_at DESC, rowid DESC LIMIT 1`,
    )
    .get(conversationId);
  return row ? rowToInvocation(row) : null;
}

export function listInvocations(conversationId: string, limit = 50): Invocation[] {
  const rows = getDb()
    .prepare<
      [string, number],
      Record<string, unknown>
    >(
      `SELECT * FROM invocation WHERE conversation_id = ?
        ORDER BY created_at DESC, rowid DESC LIMIT ?`,
    )
    .all(conversationId, limit);
  return rows.map(rowToInvocation).reverse();
}

/* ------------------------------------------------------------------ *
 * tool_call —— AI 工具调用的审计日志
 * ------------------------------------------------------------------ */

export interface ToolCallRecord {
  id: string;
  conversationId: string | null;
  messageId: string | null;
  modelConfigId: string | null;
  round: number;
  toolName: string;
  /** 模型给的原始参数串 */
  argsJson: string;
  status: string;
  resultSummary: string;
  error: string | null;
  /** 写入类工具：动手前的整篇 markdown */
  snapshotMarkdown: string | null;
  /**
   * 写入类工具：动手前的**元数据**（标题 / 父级 / 删除标记），JSON 串。
   *
   * 快照管内容，这一列管元数据 —— 改名、移动、删除要回滚的都不是正文。
   * 形状与解析见 `src/lib/ai/before-state.ts`。
   */
  beforeState: string | null;
  targetDocId: string | null;
  createdAt: number;
}

export interface ToolCallInput {
  conversationId?: string | null;
  messageId?: string | null;
  modelConfigId?: string | null;
  round: number;
  toolName: string;
  argsJson: string;
  status: string;
  resultSummary: string;
  error?: string | null;
  snapshotMarkdown?: string | null;
  beforeState?: string | null;
  targetDocId?: string | null;
}

/**
 * 记一条工具调用审计。
 *
 * 存在的意义只有一条：回答"这笔改动是谁写的、写了什么、怎么撤"。
 * 所以**失败也要记** —— 只记成功的日志会让人误以为"没记录就是没执行过"。
 */
export function recordToolCall(input: ToolCallInput): ToolCallRecord {
  const id = newId("tc");
  const ts = now();
  getDb()
    .prepare(
      `INSERT INTO tool_call
         (id, conversation_id, message_id, model_config_id, round, tool_name,
          args_json, status, result_summary, error, snapshot_markdown, before_state,
          target_doc_id, created_at)
       VALUES (${P}id, ${P}conversationId, ${P}messageId, ${P}modelConfigId, ${P}round,
               ${P}toolName, ${P}argsJson, ${P}status, ${P}resultSummary, ${P}error,
               ${P}snapshotMarkdown, ${P}beforeState, ${P}targetDocId, ${P}createdAt)`,
    )
    .run({
      id,
      conversationId: input.conversationId ?? null,
      messageId: input.messageId ?? null,
      modelConfigId: input.modelConfigId ?? null,
      round: input.round,
      toolName: input.toolName,
      argsJson: input.argsJson,
      status: input.status,
      resultSummary: input.resultSummary,
      error: input.error ?? null,
      snapshotMarkdown: input.snapshotMarkdown ?? null,
      beforeState: input.beforeState ?? null,
      targetDocId: input.targetDocId ?? null,
      createdAt: ts,
    });
  return {
    id,
    conversationId: input.conversationId ?? null,
    messageId: input.messageId ?? null,
    modelConfigId: input.modelConfigId ?? null,
    round: input.round,
    toolName: input.toolName,
    argsJson: input.argsJson,
    status: input.status,
    resultSummary: input.resultSummary,
    error: input.error ?? null,
    snapshotMarkdown: input.snapshotMarkdown ?? null,
    beforeState: input.beforeState ?? null,
    targetDocId: input.targetDocId ?? null,
    createdAt: ts,
  };
}

function rowToToolCall(row: Record<string, unknown>): ToolCallRecord {
  return {
    id: row.id as string,
    conversationId: (row.conversation_id as string | null) ?? null,
    messageId: (row.message_id as string | null) ?? null,
    modelConfigId: (row.model_config_id as string | null) ?? null,
    round: row.round as number,
    toolName: row.tool_name as string,
    argsJson: row.args_json as string,
    status: row.status as string,
    resultSummary: row.result_summary as string,
    error: (row.error as string | null) ?? null,
    snapshotMarkdown: (row.snapshot_markdown as string | null) ?? null,
    beforeState: (row.before_state as string | null) ?? null,
    targetDocId: (row.target_doc_id as string | null) ?? null,
    createdAt: row.created_at as number,
  };
}

/** 列出最近的工具调用（全局，最近的在前）—— 审计界面用 */
export function listToolCalls(limit = 100): ToolCallRecord[] {
  const rows = getDb()
    .prepare<
      [number],
      Record<string, unknown>
    >("SELECT * FROM tool_call ORDER BY created_at DESC, rowid DESC LIMIT ?")
    .all(limit);
  return rows.map(rowToToolCall);
}

/** 单个会话里发生的工具调用（按发生顺序） */
export function listToolCallsByConversation(conversationId: string): ToolCallRecord[] {
  const rows = getDb()
    .prepare<
      [string],
      Record<string, unknown>
    >(
      "SELECT * FROM tool_call WHERE conversation_id = ? ORDER BY created_at, rowid",
    )
    .all(conversationId);
  return rows.map(rowToToolCall);
}

export function getToolCall(id: string): ToolCallRecord | null {
  const row = getDb()
    .prepare<
      [string],
      Record<string, unknown>
    >("SELECT * FROM tool_call WHERE id = ?")
    .get(id);
  return row ? rowToToolCall(row) : null;
}

/** 把一条工具调用标记为已撤销（保留原记录，只改状态 —— 审计不能被删改） */
export function markToolCallUndone(id: string): boolean {
  const info = getDb()
    .prepare("UPDATE tool_call SET status = 'undone' WHERE id = ? AND status <> 'undone'")
    .run(id);
  return info.changes > 0;
}

export interface CacheStats {
  invocations: number;
  promptTokens: number;
  cachedTokens: number;
  cacheWriteTokens: number;
  completionTokens: number;
  actualUsd: number;
  baselineUsd: number;
  savedUsd: number;
  hitRate: number;
  /** 按会话聚合的排行，用于找出"最该优化的对话" */
  byConversation: {
    conversationId: string;
    title: string;
    invocations: number;
    hitRate: number;
    savedUsd: number;
  }[];
  /** 按天聚合的趋势 */
  daily: {
    day: string;
    invocations: number;
    promptTokens: number;
    cachedTokens: number;
    hitRate: number;
    savedUsd: number;
  }[];
}

/**
 * 汇总缓存统计。
 *
 * 注意 hitRate 用 token 加权而非按轮次平均 —— 一轮 50K token 的命中
 * 和一轮 500 token 的命中不该等权。
 */
export function getCacheStats(workspaceId: string, sinceMs?: number): CacheStats {
  const db = getDb();
  const since = sinceMs ?? 0;

  const totals = db
    .prepare<
      [string, number],
      {
        invocations: number;
        prompt_tokens: number;
        cached_tokens: number;
        cache_write_tokens: number;
        completion_tokens: number;
        actual_usd: number;
        baseline_usd: number;
        saved_usd: number;
      }
    >(
      `SELECT COUNT(*) AS invocations,
              COALESCE(SUM(i.prompt_tokens), 0)        AS prompt_tokens,
              COALESCE(SUM(i.cached_tokens), 0)        AS cached_tokens,
              COALESCE(SUM(i.cache_write_tokens), 0)   AS cache_write_tokens,
              COALESCE(SUM(i.completion_tokens), 0)    AS completion_tokens,
              COALESCE(SUM(i.actual_usd), 0)           AS actual_usd,
              COALESCE(SUM(i.baseline_usd), 0)         AS baseline_usd,
              COALESCE(SUM(i.saved_usd), 0)            AS saved_usd
         FROM invocation i
         JOIN conversation c ON c.id = i.conversation_id
        WHERE c.workspace_id = ? AND i.status = 'ok' AND i.created_at >= ?`,
    )
    .get(workspaceId, since);

  const byConv = db
    .prepare<
      [string, number],
      {
        conversation_id: string;
        title: string;
        invocations: number;
        prompt_tokens: number;
        cached_tokens: number;
        saved_usd: number;
      }
    >(
      `SELECT c.id AS conversation_id, c.title,
              COUNT(*) AS invocations,
              COALESCE(SUM(i.prompt_tokens), 0) AS prompt_tokens,
              COALESCE(SUM(i.cached_tokens), 0) AS cached_tokens,
              COALESCE(SUM(i.saved_usd), 0)     AS saved_usd
         FROM invocation i
         JOIN conversation c ON c.id = i.conversation_id
        WHERE c.workspace_id = ? AND i.status = 'ok' AND i.created_at >= ?
        GROUP BY c.id, c.title
        ORDER BY saved_usd DESC
        LIMIT 10`,
    )
    .all(workspaceId, since);

  const daily = db
    .prepare<
      [string, number],
      {
        day: string;
        invocations: number;
        prompt_tokens: number;
        cached_tokens: number;
        saved_usd: number;
      }
    >(
      `SELECT strftime('%Y-%m-%d', i.created_at / 1000, 'unixepoch', 'localtime') AS day,
              COUNT(*) AS invocations,
              COALESCE(SUM(i.prompt_tokens), 0) AS prompt_tokens,
              COALESCE(SUM(i.cached_tokens), 0) AS cached_tokens,
              COALESCE(SUM(i.saved_usd), 0)     AS saved_usd
         FROM invocation i
         JOIN conversation c ON c.id = i.conversation_id
        WHERE c.workspace_id = ? AND i.status = 'ok' AND i.created_at >= ?
        GROUP BY day
        ORDER BY day`,
    )
    .all(workspaceId, since);

  const promptTokens = totals?.prompt_tokens ?? 0;
  const cachedTokens = totals?.cached_tokens ?? 0;

  return {
    invocations: totals?.invocations ?? 0,
    promptTokens,
    cachedTokens,
    cacheWriteTokens: totals?.cache_write_tokens ?? 0,
    completionTokens: totals?.completion_tokens ?? 0,
    actualUsd: totals?.actual_usd ?? 0,
    baselineUsd: totals?.baseline_usd ?? 0,
    savedUsd: totals?.saved_usd ?? 0,
    hitRate: promptTokens > 0 ? cachedTokens / promptTokens : 0,
    byConversation: byConv.map((r) => ({
      conversationId: r.conversation_id,
      title: r.title,
      invocations: r.invocations,
      hitRate: r.prompt_tokens > 0 ? r.cached_tokens / r.prompt_tokens : 0,
      savedUsd: r.saved_usd,
    })),
    daily: daily.map((r) => ({
      day: r.day,
      invocations: r.invocations,
      promptTokens: r.prompt_tokens,
      cachedTokens: r.cached_tokens,
      hitRate: r.prompt_tokens > 0 ? r.cached_tokens / r.prompt_tokens : 0,
      savedUsd: r.saved_usd,
    })),
  };
}

/** 全库检索：标题 + 块正文，用于 @ 引用面板的搜索 */
export function searchBlocks(
  workspaceId: string,
  query: string,
  limit = 30,
): { block: Block; docTitle: string; snippet: string }[] {
  const db = getDb();
  const like = `%${query.replace(/[%_]/g, (m) => `\\${m}`)}%`;
  const rows = db
    .prepare<
      [string, string, string, number],
      BlockRow & { doc_title: string }
    >(
      `SELECT b.id, b.doc_id, b.seq, b.kind, b.text, b.text_hash, b.updated_at, d.title AS doc_title
         FROM block b
         JOIN (SELECT id, MAX(revision) AS rev FROM block GROUP BY id) cur
           ON cur.id = b.id AND cur.rev = b.revision
         JOIN doc d ON d.id = b.doc_id
        WHERE d.workspace_id = ?
          AND d.deleted_at IS NULL
          AND b.seq >= 0
          AND (b.text LIKE ? ESCAPE '\\' OR d.title LIKE ? ESCAPE '\\')
        ORDER BY d.updated_at DESC, b.seq
        LIMIT ?`,
    )
    .all(workspaceId, like, like, limit);
  return rows.map((r) => ({
    block: rowToBlock(r),
    docTitle: r.doc_title,
    snippet: (r.text as string).replace(/\s+/g, " ").slice(0, 120),
  }));
}
