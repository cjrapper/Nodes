/**
 * SQLite 连接与初始化。
 *
 * 用 globalThis 缓存连接：Next.js 开发模式会反复热重载模块，
 * 不缓存的话每次都会新建一个 better-sqlite3 句柄，最终耗尽文件句柄。
 */

import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import path from "node:path";

import Database from "better-sqlite3";

import { DEFAULT_APPEARANCE } from "./types";
import { DEFAULT_CONVENTIONS, DEFAULT_PERSONA } from "./defaults";

export { DEFAULT_CONVENTIONS, DEFAULT_PERSONA };

export type Db = Database.Database;

/*
 * 项目根目录。注意这里用 `process.cwd()` —— Next 与 `next start` 都从项目根运行。
 * 测试环境（tests/integration）会把整棵树复制到临时目录再运行，所以 cwd
 * 天然指向那份副本，schema.sql 也就跟着副本走。
 */
const PROJECT_ROOT = process.cwd();

const SCHEMA_PATH = path.join(PROJECT_ROOT, "src", "lib", "db", "schema.sql");

/**
 * 数据目录。默认在项目根的 `.data/`，可用 `NODES_DATA_DIR` 覆盖。
 *
 * 为什么需要这个开关：数据库路径与 schema 路径原先都从 `process.cwd()` 推导，
 * 于是"想把数据放在别处"就必须改 cwd —— 而一改 cwd，`schema.sql` 就找不到了，
 * 报的是 `ENOENT: ... schema.sql` 这种和真实意图毫无关系的错。
 * 把两者解耦之后，迁移测试（要对着一个旧结构的库跑真实代码）和"把笔记库
 * 放到同步盘里"这类需求都能干净地实现。
 */
const DATA_DIR = process.env.NODES_DATA_DIR
  ? path.resolve(process.env.NODES_DATA_DIR)
  : path.join(PROJECT_ROOT, ".data");

const DB_PATH = path.join(DATA_DIR, "nodes.db");

/*
 * 只缓存**连接**，不缓存"迁移跑过了"这种状态。
 *
 * 连接必须缓存（见文件头注释），但迁移状态不能 —— 它同样会跨热重载存活，
 * 于是新加的列/表永远等不到迁移。迁移的判据改成 schema 内容指纹，
 * 存在模块作用域里（模块重载即失效，正是我们要的语义）。
 */
const globalForDb = globalThis as unknown as {
  __nodesDb?: Db;
};

/** 生成无时间语义的随机 id —— id 抖动会连带缓存键抖动 */
export function newId(prefix = ""): string {
  const hex = randomBytes(12).toString("hex");
  return prefix ? `${prefix}_${hex}` : hex;
}

/**
 * 幂等地补一列。
 *
 * 为什么需要它：`CREATE TABLE IF NOT EXISTS` 对**已存在**的表什么都不做，
 * 而用户手里已经有库了（`.data/nodes.db` 里是他们的全部笔记）。
 * 只改 schema.sql 的话，新列永远不会出现在他们的表里，随后所有
 * `SELECT *` 都少一列，一保存就报 `no such column: xxx`。
 *
 * SQLite 没有 `ADD COLUMN IF NOT EXISTS`，所以靠 PRAGMA 自己判断。
 * 这段每次启动都会跑，因此必须幂等 —— 重复 ADD COLUMN 会直接抛
 * "duplicate column name"。
 */
function ensureColumn(db: Db, table: string, column: string, definition: string): void {
  const columns = db.prepare<[], { name: string }>(`PRAGMA table_info(${table})`).all();
  if (!columns.some((col) => col.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

/**
 * 从 schema.sql 里取出某张表的**列定义部分**（外层括号里的内容）。
 *
 * ⚠️ 必须用**文件里那份**，不能用 `sqlite_master` 里那份。
 *
 * 这里踩过一次：`makeColumnNullable` 第一版读的是 `sqlite_master.sql`，
 * 想的是"拿到当前表定义再重建"。但我们要改的恰恰是**旧库**的旧定义 ——
 * 读回来的那句 CREATE TABLE 里 `max_tokens` 依然写着 `NOT NULL`，
 * 于是重建出来的表约束一点没变，紧接着的 `SET max_tokens = NULL`
 * 照样抛 `NOT NULL constraint failed`。**看起来做了很多事，其实等于没做。**
 *
 * schema.sql 是"应该是的样子"（新定义），旧库是"现在的样子"，
 * 迁移要做的正是把后者变成前者 —— 所以定义必须取自前者。
 */
function columnDefsFromSchema(schemaSql: string, table: string): string | null {
  const pattern = new RegExp(
    `CREATE\\s+TABLE\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?["'\`]?${table}["'\`]?\\s*\\(([\\s\\S]*?)\\n\\s*\\);`,
    "i",
  );
  return schemaSql.match(pattern)?.[1]?.trim() ?? null;
}

/**
 * 把一列重建为可空（去掉 `NOT NULL`）。**只在确实需要时**动手。
 *
 * ## 为什么必须有这个函数
 *
 * 老库里的 `model_config.max_tokens` 是 `NOT NULL` 的（建表时写的是
 * `INTEGER NOT NULL DEFAULT 8192`）。现在要把它改成"可留空 = 不限制"，
 * 于是迁移里的 `UPDATE ... SET max_tokens = NULL` 会直接抛
 * `NOT NULL constraint failed` —— **而且是每次启动都抛**，
 * 整个应用起不来。用户手里那个装满笔记的库就这样变成了打不开的库。
 *
 * SQLite 没有 `ALTER COLUMN`，改约束只能重建表，所以走官方推荐的流程。
 *
 * ## ⚠️ 两个必须避开的坑（都真踩到了）
 *
 * **坑一：不能把原表 `RENAME` 走。**
 * 第一版写的是 `ALTER TABLE model_config RENAME TO model_config__rebuild`
 * → 建新表 → 删临时表。结果 `conversation.model_config_id` 的外键
 * **被 SQLite 顺手改写成指向 `model_config__rebuild`**（这是 RENAME 的既定行为），
 * 临时表一删，引用就悬空了。`PRAGMA foreign_key_check` 直接报：
 *
 *     { table: 'conversation', parent: 'model_config__rebuild' }
 *
 * 而且**它不会报错**，只是变成一条查不出来的坏引用 —— 等到某天删一个模型
 * 配置时才发现级联行为不对。所以现在改成全程不动原表名：
 * 建 `model_config__new` → 拷数据 → `DROP TABLE model_config` → 改名就位。
 * 中间没有任何一刻存在"指向临时表的引用"。
 *
 * **坑二：索引要先删。**
 * `CREATE INDEX IF NOT EXISTS` 在"索引名已被占用"时静默跳过。若不在重建前
 * 把索引删干净，重建完索引就全丢了 —— 表面一切正常，查询慢慢变慢。
 *
 * ## 幂等性
 *
 * 判据是"这一列在 PRAGMA 里是不是 `notnull=1`"，改完就变 0，
 * 所以重复执行是空操作。这也是 R11 的要求：判据看**内容**，不看"跑过没跑过"。
 */
function makeColumnNullable(
  db: Db,
  schemaSql: string,
  table: string,
  column: string,
): void {
  const info = db
    .prepare<[], { name: string; notnull: number }>(`PRAGMA table_info(${table})`)
    .all();
  const target = info.find((col) => col.name === column);
  // 列还不存在（全新库走的是 schema.sql，本来就是可空的）或已经可空 → 什么都不做
  if (!target || target.notnull === 0) return;

  const columnDefs = columnDefsFromSchema(schemaSql, table);
  if (!columnDefs) {
    throw new Error(
      `迁移失败：在 schema.sql 里找不到 ${table} 的建表语句，无法去掉 ${column} 的 NOT NULL`,
    );
  }

  const newName = `${table}__new`;
  const columnList = info.map((col) => `"${col.name.replace(/"/g, '""')}"`).join(", ");
  const staleIndexes = db
    .prepare<[string], { name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = ? AND sql IS NOT NULL",
    )
    .all(table);

  /*
   * `PRAGMA foreign_keys` 在事务内是空操作，所以必须在 BEGIN 之前关、
   * COMMIT 之后开。关掉的理由：重建期间 `conversation.model_config_id`
   * 会短暂指向一张不存在的表（旧表已删、新表还没改名就位），
   * 开着外键约束时中间状态可能被判定为违规。
   */
  db.pragma("foreign_keys = OFF");
  try {
    db.exec("BEGIN");
    for (const index of staleIndexes) {
      db.exec(`DROP INDEX IF EXISTS "${index.name.replace(/"/g, '""')}"`);
    }
    db.exec(`CREATE TABLE "${newName}" (${columnDefs})`);
    db.exec(`INSERT INTO "${newName}" (${columnList}) SELECT ${columnList} FROM "${table}"`);
    db.exec(`DROP TABLE "${table}"`);
    db.exec(`ALTER TABLE "${newName}" RENAME TO "${table}"`);
    db.exec(schemaSql); // 把索引建回来（建表语句都是 IF NOT EXISTS，重复执行无害）
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  } finally {
    db.pragma("foreign_keys = ON");
  }

  /*
   * 收尾自检：重建之后外键必须仍然指向**真实存在**的表。
   * 这个断言是"坑一"留下的教训 —— 那次的坏引用一声不吭，
   * 只靠肉眼是发现不了的（R4：诊断工具的静默与正确判断必须能区分开）。
   */
  const dangling = db.prepare("PRAGMA foreign_key_check").all();
  if (dangling.length > 0) {
    throw new Error(
      `迁移失败：重建 ${table} 之后存在悬空外键引用：${JSON.stringify(dangling)}`,
    );
  }
}

function migrate(db: Db, schemaSql: string): void {
  db.exec(schemaSql);

  // 工作区外观设置（字号/字体/颜色）
  ensureColumn(db, "workspace", "appearance", "TEXT NOT NULL DEFAULT '{}'");

  /*
   * 文档类型。
   *
   * `module` 是"模块容器"—— 本身不写正文，只用来把同一类知识点挂在一起
   * （如「Unity」「图形学」）。用户明确要这种"空组件"：
   * 分类本身也是知识结构的一部分，不该被硬塞成一篇可有可无的文档。
   *
   * 已有文档一律默认成 `doc`，行为不变。
   */
  ensureColumn(db, "doc", "kind", "TEXT NOT NULL DEFAULT 'doc'");

  /*
   * 文档软删除。
   *
   * 加这一列是为了把"删除"从不可逆变成可逆 —— 以前 `deleteDoc` 是
   * `DELETE FROM doc` + 级联删块，一次误操作永久带走一篇文档和它的全部块。
   * 已存在的文档一律 `NULL`（未删），行为不变。见 `repo.deleteDoc` 与
   * `docs/agent-write-policy.md`。
   */
  ensureColumn(db, "doc", "deleted_at", "INTEGER DEFAULT NULL");

  /*
   * 最大输出从 4096 提到 8192。
   *
   * 原因是一次真实故障：用推理模型（思维链会走 reasoning 通道的那种）点
   * 「AI 分析」，思维链把 4096 全烧完，正文一个字都没写出来，
   * 用户看到的是"思考了半天然后什么都没有"。
   *
   * ⚠️ 只改**还停留在旧默认值**的行。用户手动调过的值必须原样保留 ——
   * 擅自改动用户配置比默认值偏小更糟。
   * 判据放在 schema 指纹迁移里，所以热重载后不会反复执行。
   */
  db.prepare("UPDATE model_config SET max_tokens = 8192 WHERE max_tokens = 4096").run();

  /*
   * 最大输出从"一个具体数字"改成"可留空 = 不限制"。
   *
   * 8192 这个默认值是错的，而且错得很隐蔽：它比服务商的**原生默认**还小。
   * DeepSeek 对 deepseek-flash 的口径是「不填时非思考 8K、思考 64K」，
   * 也就是说填 8192 等于主动把思考模式的预算砍到 1/8。用户实际看到的是
   * 「思考过程用完了全部输出预算，正文还没开始写就被截断」反复出现 ——
   * 而且**调大也治不好**：只要还填着数字，思维链够长就还能烧完。
   *
   * 所以不挑了：NULL = 请求体里不带 `max_tokens`，由服务商按自己的上限约束。
   * 这是唯一不会撞上限的填法。
   *
   * ⚠️ 同样只改**正好等于旧默认值 8192** 的行。8192 曾经是"默认"，但也是
   * 用户可能主动选的值 —— 这里接受这个代价，因为 8192 对思考模型**确定失效**，
   * 留着它等于留着一个必然复发的故障。其他任何数字（包括用户手改的 131072）
   * 一律不动。
   */
  /*
   * ⚠️ 先去掉这一列的 `NOT NULL`，再写 NULL。
   *
   * 老库的建表语句是 `max_tokens INTEGER NOT NULL DEFAULT 8192`，
   * 直接 `SET max_tokens = NULL` 会抛 `NOT NULL constraint failed` ——
   * 而且**每次启动都抛**，用户手里那个装满笔记的库就再也打不开了。
   */
  makeColumnNullable(db, schemaSql, "model_config", "max_tokens");

  db.prepare("UPDATE model_config SET max_tokens = NULL WHERE max_tokens = 8192").run();
}

/**
 * 幂等播种：只在库为空时写入默认工作区、几个待填 key 的模型配置。
 * 刻意不预置任何示例文档 —— 用户的知识库应该从空白开始。
 */
function seed(db: Db): void {
  const wsCount = db.prepare<[], { c: number }>("SELECT COUNT(*) AS c FROM workspace").get();
  if ((wsCount?.c ?? 0) > 0) return;

  const now = Date.now();
  const wsId = newId("ws");

  db.prepare(
    `INSERT INTO workspace (id, name, persona, conventions, appearance, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    wsId,
    "我的知识库",
    DEFAULT_PERSONA,
    DEFAULT_CONVENTIONS,
    // 显式落一份完整默认外观，而不是留给列默认值 '{}'，
    // 这样库里的内容一眼能看出当前外观是什么
    JSON.stringify(DEFAULT_APPEARANCE),
    now,
    now,
  );

  const models: Array<[string, string, string, string, number, number, number, number, number]> = [
    // name, provider, baseUrl, model, contextWindow, in, cachedIn, out, isDefault
    [
      "DeepSeek Chat",
      "openai",
      "https://api.deepseek.com/v1",
      "deepseek-chat",
      64000,
      0.27,
      0.027,
      1.1,
      1,
    ],
    [
      "Kimi K2",
      "openai",
      "https://api.moonshot.cn/v1",
      "kimi-k2-0711-preview",
      128000,
      0.6,
      0.15,
      2.5,
      0,
    ],
    [
      "Claude Sonnet 4.5",
      "anthropic",
      "https://api.anthropic.com",
      "claude-sonnet-4-5",
      200000,
      3,
      0.3,
      15,
      0,
    ],
    [
      "OpenAI GPT-4o",
      "openai",
      "https://api.openai.com/v1",
      "gpt-4o",
      128000,
      2.5,
      1.25,
      10,
      0,
    ],
  ];

  /*
   * 种子的 max_tokens 一律是 NULL（不限制）。
   *
   * 以前这里写死 8192，于是"新建一个模型配置"就等于"给模型套一个比服务商
   * 原生默认还小的输出上限"。改成 NULL 之后，新用户不会再踩这个坑。
   */
  const insertModel = db.prepare(
    `INSERT INTO model_config
       (id, name, provider, base_url, api_key, model, temperature, max_tokens,
        context_window, supports_prompt_cache, input_price, cached_input_price,
        output_price, extra_json, is_default, created_at, updated_at)
     VALUES (?, ?, ?, ?, '', ?, 0.3, NULL, ?, 1, ?, ?, ?, '{}', ?, ?, ?)`,
  );

  for (const [name, provider, baseUrl, model, ctx, inp, cachedIn, out, isDefault] of models) {
    insertModel.run(
      newId("mc"),
      name,
      provider,
      baseUrl,
      model,
      ctx,
      inp,
      cachedIn,
      out,
      isDefault,
      now,
      now,
    );
  }
}

function createDb(): Db {
  mkdirSync(DATA_DIR, { recursive: true });
  const db = new Database(DB_PATH);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  return db;
}

/**
 * 打开数据库，并保证 schema 与迁移**总是**被应用过。
 *
 * ## 为什么迁移不能只在"第一次建连接"时跑
 *
 * 这里踩过一个真实的坑。原先的写法是：
 *
 *     export function getDb() {
 *       if (!globalForDb.__nodesDb) {
 *         globalForDb.__nodesDb = createDb();   // ← migrate 与 seed 在里面
 *       }
 *       return globalForDb.__nodesDb;
 *     }
 *
 * 连接被缓存在 `globalThis` 上（这是 Next 开发模式下的必要做法，否则每次
 * 热重载都会新开一个 SQLite 句柄，很快耗尽文件句柄）。但由此产生一个
 * 很隐蔽的后果：
 *
 *   dev server 启动 → createDb 跑的是**当时那份** migrate（还没有新列）
 *   → 之后改了 schema.sql / 加了迁移代码 → 热重载只替换了模块与函数，
 *   `globalThis.__nodesDb` 里的连接原封不动 → 迁移**从未执行**
 *   → 所有 `SELECT *` 缺列 → 一保存外观就 "no such column: appearance"。
 *
 * 更一般地说："迁移只在建连接时跑一次"这个前提本身就不可靠 ——
 * 任何让连接存活得比代码更久的情况（热重载、长驻进程、多次启动同一个库）
 * 都会让新迁移永远不生效。
 *
 * 所以改成：**每次取连接都保证迁移已经应用**。但"每次"不能靠一个
 * "跑过了"的布尔标志 —— 那同样会跨热重载存活下来，于是新加的列/表
 * 照样等不到迁移（真实症状：`no such table: conversation_doc_ref`、
 * `table doc has no column named kind`，而代码明明写得没错）。
 *
 * 最终做法是看**内容有没有变**：把 schema.sql 的长度 + 内容指纹当判据，
 * 没变就什么都不做（零开销），一变就重新执行建表与列迁移。
 * 这样"改了 schema 就一定会生效"是无条件的，不依赖任何跨热重载存活的标志。
 * 指纹里带上长度是刻意的：多几个字节就能顺带区分"文件被截断"的情况。
 */
let schemaCache: { fingerprint: string; sql: string } | null = null;
let appliedFingerprint: string | null = null;

function readSchema(): { fingerprint: string; sql: string } {
  const sql = readFileSync(SCHEMA_PATH, "utf8");
  const fingerprint = `${sql.length}:${createHash("sha256").update(sql, "utf8").digest("hex").slice(0, 16)}`;
  schemaCache = { fingerprint, sql };
  return schemaCache;
}

export function getDb(): Db {
  if (!globalForDb.__nodesDb) {
    globalForDb.__nodesDb = createDb();
  }
  const db = globalForDb.__nodesDb;

  const current = schemaCache ?? readSchema();
  if (appliedFingerprint !== current.fingerprint) {
    migrate(db, current.sql);
    seed(db);
    appliedFingerprint = current.fingerprint;
  }

  return db;
}

export { DB_PATH, DATA_DIR };
