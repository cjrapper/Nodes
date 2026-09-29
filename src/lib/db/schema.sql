-- Nodes 数据库结构
--
-- 设计要点：
--  * block 采用**追加式修订**：每次编辑写入新 revision，而非原地更新。
--    这样历史 invocation 引用的块版本永远可追溯，也便于定位"是哪次编辑
--    导致了缓存失效"。
--  * 所有时间戳为 Unix 毫秒（INTEGER）。
--  * 所有 id 为应用侧生成的随机 hex 字符串，不含时间语义 —— 避免 id 变化
--    引起缓存键抖动。

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS workspace (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  persona     TEXT NOT NULL DEFAULT '',
  conventions TEXT NOT NULL DEFAULT '',
  -- 外观设置（字号/字体/行高/配色）的 JSON 字符串。纯展示层数据，
  -- 不参与任何缓存层哈希，缺字段时由 parseAppearance 补齐默认值。
  appearance  TEXT NOT NULL DEFAULT '{}',
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS doc (
  id           TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  parent_id    TEXT REFERENCES doc(id) ON DELETE CASCADE,
  title        TEXT NOT NULL,
  icon         TEXT NOT NULL DEFAULT '',
  -- 'doc' = 普通文档（有正文）；'module' = 模块容器（不写正文，只用来的挂载知识点）
  kind         TEXT NOT NULL DEFAULT 'doc',
  sort         INTEGER NOT NULL DEFAULT 0,
  -- 软删除：NULL = 未删，有值 = 删除时刻（毫秒）。
  -- 以前这里是硬删除（`DELETE FROM doc` + 级联删块），一次误操作就永久带走
  -- 一篇文档和它的全部块 —— 而用户的知识笔记是唯一不可再生的东西。
  -- 见 docs/agent-write-policy.md：这是把"删除"从不可逆变成可逆的那块地基。
  deleted_at   INTEGER DEFAULT NULL,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_doc_parent ON doc(workspace_id, parent_id, sort);

-- 块的追加式修订表。查询当前内容取 MAX(revision)。
CREATE TABLE IF NOT EXISTS block (
  id         TEXT NOT NULL,
  doc_id     TEXT NOT NULL REFERENCES doc(id) ON DELETE CASCADE,
  seq        INTEGER NOT NULL,
  kind       TEXT NOT NULL DEFAULT 'paragraph',
  text       TEXT NOT NULL,
  text_hash  TEXT NOT NULL,
  revision   INTEGER NOT NULL DEFAULT 1,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (id, revision)
);
CREATE INDEX IF NOT EXISTS idx_block_doc ON block(doc_id, seq);
CREATE INDEX IF NOT EXISTS idx_block_current ON block(doc_id, revision DESC);

CREATE TABLE IF NOT EXISTS model_config (
  id                    TEXT PRIMARY KEY,
  name                  TEXT NOT NULL,
  provider              TEXT NOT NULL,
  base_url              TEXT NOT NULL,
  api_key               TEXT NOT NULL DEFAULT '',
  model                 TEXT NOT NULL,
  temperature           REAL NOT NULL DEFAULT 0.3,
  -- NULL = 不限制：请求里不带 max_tokens，交给服务商用它的原生默认值
  -- （DeepSeek 思考模式原生默认 64K）。填死一个数就一定会撞上它 —— 见 index.ts 的迁移说明
  max_tokens            INTEGER DEFAULT NULL,
  context_window        INTEGER NOT NULL DEFAULT 128000,
  supports_prompt_cache INTEGER NOT NULL DEFAULT 1,
  input_price           REAL NOT NULL DEFAULT 0,
  cached_input_price    REAL NOT NULL DEFAULT 0,
  output_price          REAL NOT NULL DEFAULT 0,
  extra_json            TEXT NOT NULL DEFAULT '{}',
  is_default            INTEGER NOT NULL DEFAULT 0,
  created_at            INTEGER NOT NULL,
  updated_at            INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS conversation (
  id                  TEXT PRIMARY KEY,
  workspace_id        TEXT NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  title               TEXT NOT NULL,
  model_config_id     TEXT REFERENCES model_config(id) ON DELETE SET NULL,
  source_budget_tokens INTEGER NOT NULL DEFAULT 40000,
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_conversation_ws ON conversation(workspace_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS message (
  id              TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversation(id) ON DELETE CASCADE,
  role            TEXT NOT NULL,
  content         TEXT NOT NULL,
  ref_block_ids   TEXT NOT NULL DEFAULT '[]',
  seq             INTEGER NOT NULL,
  created_at      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_message_conv ON message(conversation_id, seq);

-- 会话挂载的知识块（@ 引用）。集合本身参与 L2 层哈希。
CREATE TABLE IF NOT EXISTS conversation_ref (
  conversation_id TEXT NOT NULL REFERENCES conversation(id) ON DELETE CASCADE,
  block_id        TEXT NOT NULL,
  pinned          INTEGER NOT NULL DEFAULT 0,
  created_at      INTEGER NOT NULL,
  PRIMARY KEY (conversation_id, block_id)
);

-- 会话整体挂载的文档 / 模块。
--
-- 与 conversation_ref 的区别是**粒度**：块级引用适合"就这几段回答我"，
-- 整篇挂载适合"看看这个方向我整理得怎么样" —— 后者是「查漏补缺」
-- 「评判修改」这类学习任务的前提。
CREATE TABLE IF NOT EXISTS conversation_doc_ref (
  conversation_id TEXT NOT NULL REFERENCES conversation(id) ON DELETE CASCADE,
  doc_id          TEXT NOT NULL,
  pinned          INTEGER NOT NULL DEFAULT 0,
  created_at      INTEGER NOT NULL,
  PRIMARY KEY (conversation_id, doc_id)
);

CREATE TABLE IF NOT EXISTS invocation (
  id                     TEXT PRIMARY KEY,
  conversation_id        TEXT NOT NULL REFERENCES conversation(id) ON DELETE CASCADE,
  message_id             TEXT,
  model_config_id        TEXT,
  provider               TEXT NOT NULL,
  model                  TEXT NOT NULL,
  layer_hashes_json      TEXT NOT NULL DEFAULT '{}',
  prefix_hash            TEXT NOT NULL,
  stable_prefix_tokens   INTEGER NOT NULL DEFAULT 0,
  predicted_cached_tokens INTEGER NOT NULL DEFAULT 0,
  predicted_write_tokens INTEGER NOT NULL DEFAULT 0,
  prompt_tokens          INTEGER NOT NULL DEFAULT 0,
  cached_tokens          INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens     INTEGER NOT NULL DEFAULT 0,
  completion_tokens      INTEGER NOT NULL DEFAULT 0,
  actual_usd             REAL NOT NULL DEFAULT 0,
  baseline_usd           REAL NOT NULL DEFAULT 0,
  saved_usd              REAL NOT NULL DEFAULT 0,
  latency_ms             INTEGER NOT NULL DEFAULT 0,
  status                 TEXT NOT NULL DEFAULT 'ok',
  error                  TEXT,
  request_fingerprint    TEXT NOT NULL DEFAULT '',
  created_at             INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_invocation_conv ON invocation(conversation_id, created_at);
CREATE INDEX IF NOT EXISTS idx_invocation_created ON invocation(created_at);

-- AI 工具调用的审计日志（见 docs/agent-write-policy.md 红线 3）。
--
-- 每一次工具执行都记一行，**含失败的**。它不参与缓存统计，也不进 UI 消息列表，
-- 存在的唯一目的是回答"刚才那一笔是谁写的、写了什么、怎么撤"。
--
-- `snapshot_markdown` 是写入前的整篇快照。有了它，"撤销"就不需要设计一套
-- 反向操作：把快照原样写回去即可（用原来的块 id，cacheKey 逐字节复原）。
-- 这是"写入前快照 + 按快照重放"那条结论的落地载体。
CREATE TABLE IF NOT EXISTS tool_call (
  id                TEXT PRIMARY KEY,
  conversation_id   TEXT REFERENCES conversation(id) ON DELETE CASCADE,
  message_id        TEXT,
  model_config_id   TEXT,
  /** 第几轮（一次对话轮次里可能有多轮工具调用） */
  round             INTEGER NOT NULL DEFAULT 0,
  tool_name         TEXT NOT NULL,
  /** 模型给的原始参数串，原样保存，便于复核 */
  args_json         TEXT NOT NULL DEFAULT '{}',
  status            TEXT NOT NULL DEFAULT 'ok',
  result_summary    TEXT NOT NULL DEFAULT '',
  error             TEXT,
  /** 写入类工具：动手之前的整篇 markdown（内容类撤销用） */
  snapshot_markdown TEXT,
  /**
   * 写入类工具：动手之前的**元数据**，JSON。
   *
   * 快照只能回滚"正文"，回滚不了标题、父级、删除标记 —— 而改名、移动、
   * 删除要撤的恰恰是这些。所以撤销需要第二份记录，形状见
   * `src/lib/ai/before-state.ts`。
   */
  before_state      TEXT,
  /** 写入类工具：动到的文档 id */
  target_doc_id     TEXT,
  created_at        INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tool_call_conv ON tool_call(conversation_id, created_at);
CREATE INDEX IF NOT EXISTS idx_tool_call_created ON tool_call(created_at);
