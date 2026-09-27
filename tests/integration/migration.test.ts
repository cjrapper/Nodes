/**
 * 数据库迁移的回归测试。
 *
 * ## 这里守的是什么
 *
 * 曾经有过一个非常隐蔽的真实缺陷：列迁移写好了，但对运行中的 dev server
 * **完全没生效**，表现是"外观一保存就 500 / no such column: appearance"。
 *
 * 原因是连接缓存：
 *
 *     if (!globalThis.__nodesDb) globalThis.__nodesDb = createDb();  // migrate 在里面
 *
 * dev server 启动时 `createDb()` 跑的是当时那份 `migrate`。之后新增了迁移
 * 代码，热重载只替换了模块与函数，`globalThis` 上那个连接原封不动 ——
 * 于是新迁移一次都没跑过。**代码看起来完全正确，行为却不对。**
 *
 * 修法是让 `getDb()` 每次都保证迁移已应用（进程内只做一次实际工作）。
 * 这个测试用一个**旧结构的库**去跑真实的 `getDb()`，确保无论连接从哪来，
 * 缺的列都会被补上。
 *
 * ## 实现说明：为什么用"带 query 的 import"而不是起子进程
 *
 * `src/lib/db/index.ts` 在**模块加载时**就用 `process.cwd()` 算出了数据库路径，
 * 所以在同一个进程里没法用 `process.chdir()` 换库。起子进程是最直观的办法，
 * 但受限沙箱下 `spawnSync` 会被直接拒绝（EPERM）。
 *
 * 于是改用 ESM 的查询串：`index.ts?case=legacy` 会被当作**另一个模块实例**
 * 重新执行一遍，并重新读取 `process.cwd()` —— 只要在此之前把 cwd 换成
 * 临时目录，就能让真实的生产代码去打开那个旧结构的库。
 * 跑完再把 cwd 换回来（同一个测试进程里还有别的测试在用真实目录）。
 */

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";

/*
 * ⚠️ 用 process.cwd() 定位项目根，而不是从 import.meta.url 往回算。
 *
 * 集成测试运行器会把 src/ 与 tests/ 复制到一个临时目录并在那里执行，
 * 所以 `import.meta.url` 指向的是**副本的副本**。而 `src/lib/db/index.ts`
 * 是用 `process.cwd()` 定位 schema 与数据的 —— 两者必须指向同一棵树。
 */
const projectRoot = process.cwd();

test("旧结构的库经 getDb() 后自动补上 appearance 列，且不丢原有数据", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "nodes-migrate-"));

  try {
    // 1) 用 better-sqlite3 直接造一个"上一个版本"的库：
    //    有数据、但没有 appearance 列。这正是用户升级时的形态。
    const Database = (await import("better-sqlite3")).default;
    const dataDir = path.join(dir, ".data");
    const dbPath = path.join(dataDir, "nodes.db");
    mkdirSync(dataDir, { recursive: true });

    const legacy = new Database(dbPath);
    legacy.exec(`
      CREATE TABLE workspace (
        id          TEXT PRIMARY KEY,
        name        TEXT NOT NULL,
        persona     TEXT NOT NULL DEFAULT '',
        conventions TEXT NOT NULL DEFAULT '',
        created_at  INTEGER NOT NULL,
        updated_at  INTEGER NOT NULL
      );
      INSERT INTO workspace (id, name, persona, conventions, created_at, updated_at)
      VALUES ('ws_legacy', '我的知识库', '旧人设', '旧约定', 1, 1);
    `);
    legacy.close();

    // 造完确认一下旧库确实是旧结构（防止 setup 本身写错导致断言失去意义）
    const verify = new Database(dbPath, { readonly: true });
    const before = verify.prepare("PRAGMA table_info(workspace)").all() as { name: string }[];
    verify.close();
    assert.equal(
      before.some((c) => c.name === "appearance"),
      false,
      "前置条件不成立：造出来的库已经有 appearance 列了",
    );

    // 2) 用 NODES_DATA_DIR 把数据目录指向刚造的旧库，再 import 一份独立实例。
    //
    //    刻意**不改 cwd**：schema.sql 是从 cwd 推导的，改了 cwd 就找不到它。
    //    把数据目录做成可配置项之后，"对着另一个库跑真实代码"就不需要动 cwd 了。
    //    注意 NODES_DATA_DIR 指的是**数据目录本身**，不是它的父目录。
    process.env.NODES_DATA_DIR = dataDir;

    /*
     * 清掉连接缓存。
     *
     * 这一步恰恰点出了当初那个真实缺陷的核心：连接被缓存在 `globalThis` 上，
     * 所以"模块被重新加载"并不等于"库被重新打开"。同一个测试进程里，
     * 前面的测试已经打开过真实项目的库并缓存了连接；不清理的话，
     * getDb() 会把那个连接还给我们，于是"迁移没生效"看起来像是迁移代码的问题。
     *
     * 在真实应用里，正确的做法**不是**去清理缓存，而是让 getDb() 每次都保证
     * 迁移已应用 —— 见 src/lib/db/index.ts 里的说明。
     */
    const dbGlobal = globalThis as unknown as {
      __nodesDb?: unknown;
      __nodesMigrated?: boolean;
    };
    delete dbGlobal.__nodesDb;
    delete dbGlobal.__nodesMigrated;

    const moduleUrl = `${pathToFileURL(path.join(projectRoot, "src", "lib", "db", "index.ts")).href}?legacy=1`;
    const dbModule = (await import(moduleUrl)) as {
      getDb: () => {
        prepare: (sql: string) => {
          all: () => Record<string, unknown>[];
          get: () => Record<string, unknown> | undefined;
        };
      };
    };

    const db = dbModule.getDb();

    // 先确认打开的确实是那个旧库 —— 否则后面的断言全都没有意义
    const attached = db.prepare("PRAGMA database_list").all() as { name: string; file: string }[];
    const mainFile = attached.find((r) => r.name === "main")?.file ?? "";
    assert.equal(
      path.resolve(mainFile),
      path.resolve(dbPath),
      `getDb() 打开的库不是刚造的那个。期望 ${dbPath}，实际 ${mainFile}`,
    );

    // 3) 断言迁移真的补上了列
    const columns = db.prepare("PRAGMA table_info(workspace)").all().map((c) => c.name);
    assert.ok(
      columns.includes("appearance"),
      `迁移没有补上 appearance 列，实际列：${columns.join(", ")}`,
    );

    // 4) 断言原有数据没被破坏
    const ws = db.prepare("SELECT * FROM workspace WHERE id = 'ws_legacy'").get();
    const all = db.prepare("SELECT * FROM workspace").all() as Record<string, unknown>[];
    assert.ok(
      ws,
      `迁移后原有工作区应当还在。表里有 ${all.length} 行：${JSON.stringify(all).slice(0, 400)}`,
    );
    assert.equal(ws.name, "我的知识库", "迁移不能丢原有数据");
    assert.equal(ws.persona, "旧人设");
    assert.equal(
      ws.appearance,
      "{}",
      "新增列应有默认值，具体字段由 parseAppearance 在读取时补齐",
    );

    // 5) 幂等性：再取一次连接不能抛 "duplicate column name"
    assert.doesNotThrow(() => dbModule.getDb(), "重复 getDb() 必须是幂等的");
  } finally {    /*
     * 清理顺序很重要：
     *  1. 先关掉数据库连接 —— SQLite 持有文件句柄时，Windows 上的
     *     rmSync 会直接 EPERM，而且这个错误会盖掉真正的断言失败信息。
     *  2. 再恢复环境变量 —— 同进程里其它测试依赖默认的数据目录。
     *  3. 最后删目录，并且**容错**：清理失败不该让一个通过的测试变红。
     */
    try {
      const stale = globalThis as unknown as { __nodesDb?: { close?: () => void } };
      stale.__nodesDb?.close?.();
      delete stale.__nodesDb;
      delete (globalThis as unknown as { __nodesMigrated?: boolean }).__nodesMigrated;
    } catch {
      // 连接可能已经关了
    }

    delete process.env.NODES_DATA_DIR;

    try {
      if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
    } catch (err) {
      console.warn(
        `[migration.test] 临时目录清理失败（不影响测试结果）：${dir} — ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
});

/**
 * 最大输出的默认值迁移：4096 → 8192 → **NULL（不限制）**。
 *
 * ## 为什么要动用户已有的库
 *
 * 真实故障（复发过两次）：推理模型的思维链与正文**共用** `max_tokens`，
 * 4096 时「AI 分析」把预算全花在思考上，正文一个字都写不出来。提到 8192
 * 之后**同样的故障又出现了一次** —— 因为问题不在"数字够不够大"，
 * 而在"填了一个具体数字"：DeepSeek 思考模式不填时原生默认 64K，
 * 填 8192 等于把它砍到 1/8。
 *
 * 所以终点是 NULL（请求里不带 `max_tokens`），这是唯一撞不上上限的填法。
 *
 * ## 但绝不能覆盖用户自己的选择
 *
 * 判据是**值等于某个旧默认值**才改。用户手动调成 2048（也许是为了省钱）
 * 或 16384 必须原样保留 —— 擅自改用户配置比默认值偏小更糟。
 *
 * ## 这个用例同时守住三件事
 *
 * 1. 老库的 `max_tokens` 是 `NOT NULL`，写 NULL 会抛
 *    `NOT NULL constraint failed` 且**每次启动都抛** —— 必须先把约束去掉；
 * 2. 去掉约束要重建表，重建**不能丢数据**，也不能弄丢 `conversation`
 *    指向它的外键关系（`ON DELETE SET NULL` 的表最容易被这种事误伤）；
 * 3. 迁移必须幂等。
 */
test("旧库的 max_tokens 旧默认值被改成不限制（NULL），用户手改过的值保持不动", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "nodes-migrate-maxtok-"));

  try {
    const Database = (await import("better-sqlite3")).default;
    const dataDir = path.join(dir, ".data");
    mkdirSync(dataDir, { recursive: true });
    const dbPath = path.join(dataDir, "nodes.db");

    const legacy = new Database(dbPath);
    legacy.exec(`
      CREATE TABLE workspace (
        id TEXT PRIMARY KEY, name TEXT NOT NULL,
        persona TEXT NOT NULL DEFAULT '', conventions TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
      );
      INSERT INTO workspace VALUES ('ws_legacy', '我的知识库', '', '', 1, 1);

      CREATE TABLE model_config (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, provider TEXT NOT NULL,
        base_url TEXT NOT NULL, api_key TEXT NOT NULL DEFAULT '',
        model TEXT NOT NULL, temperature REAL NOT NULL DEFAULT 0.3,
        max_tokens INTEGER NOT NULL DEFAULT 4096,
        context_window INTEGER NOT NULL DEFAULT 128000,
        supports_prompt_cache INTEGER NOT NULL DEFAULT 1,
        input_price REAL NOT NULL DEFAULT 0, cached_input_price REAL NOT NULL DEFAULT 0,
        output_price REAL NOT NULL DEFAULT 0, extra_json TEXT NOT NULL DEFAULT '{}',
        is_default INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
      );
      -- 四种形态：最初默认 / 上一版默认 / 用户调小过 / 用户调大过
      INSERT INTO model_config VALUES ('mc_old','最初默认','openai','http://x','','m',0.3,4096,128000,1,0,0,0,'{}',1,1,1);
      INSERT INTO model_config VALUES ('mc_prev','上一版默认','openai','http://x','','m',0.3,8192,128000,1,0,0,0,'{}',0,1,1);
      INSERT INTO model_config VALUES ('mc_small','用户调小','openai','http://x','','m',0.3,2048,128000,1,0,0,0,'{}',0,1,1);
      INSERT INTO model_config VALUES ('mc_big','用户调大','openai','http://x','','m',0.3,16384,128000,1,0,0,0,'{}',0,1,1);

      -- 指向模型配置的会话：重建表时最容易被误伤的就是这条引用
      CREATE TABLE conversation (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
        title TEXT NOT NULL,
        model_config_id TEXT REFERENCES model_config(id) ON DELETE SET NULL,
        source_budget_tokens INTEGER NOT NULL DEFAULT 40000,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
      );
      INSERT INTO conversation VALUES ('cv_1','ws_legacy','引用着 mc_prev','mc_prev',40000,1,1);
    `);
    legacy.close();

    // 前置条件：确认造出来的库确实是"旧结构"，否则下面的断言可能因为 setup
    // 本身就写错而失去意义（R4：检查器要先在已知输入上跑通）
    const verify = new Database(dbPath, { readonly: true });
    const beforeCols = verify.prepare("PRAGMA table_info(model_config)").all() as {
      name: string;
      notnull: number;
    }[];
    verify.close();
    const beforeMaxTokens = beforeCols.find((c) => c.name === "max_tokens");
    assert.equal(
      beforeMaxTokens?.notnull,
      1,
      "前置条件不成立：造的库里 max_tokens 已经是可空的，测不到'去掉 NOT NULL'这一步",
    );

    process.env.NODES_DATA_DIR = dataDir;
    const dbGlobal = globalThis as unknown as { __nodesDb?: unknown; __nodesMigrated?: boolean };
    delete dbGlobal.__nodesDb;
    delete dbGlobal.__nodesMigrated;

    const moduleUrl = `${pathToFileURL(path.join(projectRoot, "src", "lib", "db", "index.ts")).href}?maxtok=1`;
    const dbModule = (await import(moduleUrl)) as {
      getDb: () => {
        prepare: (sql: string) => { all: () => Record<string, unknown>[] };
        pragma: (source: string) => unknown;
      };
    };
    const db = dbModule.getDb();

    const rows = db.prepare("SELECT id, max_tokens FROM model_config ORDER BY id").all() as {
      id: string;
      max_tokens: number | null;
    }[];
    const byId = Object.fromEntries(rows.map((r) => [r.id, r.max_tokens]));

    assert.equal(rows.length, 4, "重建表不能丢行");
    assert.equal(byId.mc_old, null, "最初默认值 4096 应当被改成'不限制'");
    assert.equal(byId.mc_prev, null, "上一版默认值 8192 同样确定失效，应当被改成'不限制'");
    assert.equal(byId.mc_small, 2048, "用户手动调小的值必须原样保留");
    assert.equal(byId.mc_big, 16384, "用户手动调大的值必须原样保留");

    // 约束真的去掉了（而不是"现在恰好没有 NULL 所以没报错"）
    const afterCols = db.prepare("PRAGMA table_info(model_config)").all() as {
      name: string;
      notnull: number;
    }[];
    assert.equal(
      afterCols.find((c) => c.name === "max_tokens")?.notnull,
      0,
      "max_tokens 的 NOT NULL 必须被去掉，否则下一次写入 NULL 依然会炸",
    );

    // 外键关系没被重建弄丢
    const conv = db
      .prepare("SELECT model_config_id FROM conversation WHERE id = 'cv_1'")
      .all() as { model_config_id: string | null }[];
    assert.equal(conv[0]?.model_config_id, "mc_prev", "重建 model_config 不能弄丢会话对它的引用");

    /*
     * ⚠️ 只查"值还在"是不够的 —— 这里必须查**外键定义本身**。
     *
     * 第一版实现是把原表 `ALTER TABLE ... RENAME` 走再重建，SQLite 会顺手把
     * `conversation` 的外键改写成指向那张临时表，临时表一删，引用就悬空了。
     * 而**数据看起来完全正常**（`model_config_id` 的值一字不差），
     * 只有 `foreign_key_check` 能看出来：
     *     { table: 'conversation', parent: 'model_config__rebuild' }
     */
    const dangling = db.prepare("PRAGMA foreign_key_check").all();
    assert.deepEqual(dangling, [], `重建后不能留下悬空外键：${JSON.stringify(dangling)}`);

    // 索引要在重建后回来（CREATE INDEX IF NOT EXISTS 遇到同名索引会静默跳过）
    const indexes = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'model_config'")
      .all() as { name: string }[];
    assert.ok(
      indexes.length > 0,
      "重建不能把表上的索引弄丢 —— 丢了不会报错，只会让查询悄悄变慢",
    );

    // 没有临时表残留
    const leftover = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE '%__new%'")
      .all();
    assert.deepEqual(leftover, [], "重建用的临时表必须被清理掉");

    // 其它列的内容不能在重建中丢失或错位
    const nameRow = db
      .prepare("SELECT name, context_window, temperature FROM model_config WHERE id = 'mc_prev'")
      .all() as { name: string; context_window: number; temperature: number }[];
    assert.equal(nameRow[0]?.name, "上一版默认");
    assert.equal(nameRow[0]?.context_window, 128000);
    assert.equal(nameRow[0]?.temperature, 0.3);

    // 幂等：再跑一次迁移（新模块实例 = 新连接）不能报错、不能改别的值
    delete dbGlobal.__nodesDb;
    const againUrl = `${pathToFileURL(path.join(projectRoot, "src", "lib", "db", "index.ts")).href}?maxtok=2`;
    const againModule = (await import(againUrl)) as { getDb: () => unknown };
    againModule.getDb();
    const rowsAgain = db
      .prepare("SELECT id, max_tokens FROM model_config ORDER BY id")
      .all() as { id: string; max_tokens: number | null }[];
    assert.deepEqual(
      rowsAgain.map((r) => r.max_tokens),
      rows.map((r) => r.max_tokens),
      "迁移必须幂等：第二次执行不能改动任何值",
    );
  } finally {
    try {
      const stale = globalThis as unknown as { __nodesDb?: { close?: () => void } };
      stale.__nodesDb?.close?.();
      delete stale.__nodesDb;
      delete (globalThis as unknown as { __nodesMigrated?: boolean }).__nodesMigrated;
    } catch {
      // 连接可能已经关了
    }
    delete process.env.NODES_DATA_DIR;
    try {
      if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
    } catch (err) {
      console.warn(
        `[migration.test] 临时目录清理失败（不影响测试结果）：${dir} — ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
});
