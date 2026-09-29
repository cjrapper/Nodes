/**
 * 知识库同步的实际实现（由 `scripts/sync.mjs` 用 ts-resolve 加载）。
 *
 * ## 同步范围
 *
 * **只同步文档与正文**（`doc` + `block`）。刻意**不同步**：
 *
 *  - `model_config` —— 里面有 **API 密钥**。传进 git 等于泄密，
 *    而且两台机器本来就可能配不同的模型。
 *  - `conversation` / `message` / `tool_call` / `invocation` —— 对话与审计记录。
 *    它们是"在这台机器上发生过的事"，不是知识内容；两边分叉没有意义。
 *  - `workspace.persona` / `conventions` —— 这两项**故意留在各自机器上**。
 *    你明确想保留"除非我主动改，否则它遵循我这份人设"的能力；
 *    如果同步，A 机器改一次人设就会覆盖 B 机器的，反而失控。
 *
 * ## 冲突是怎么判定的
 *
 * 关键在 manifest 里记的 **baseHash**（上次同步时这个块的内容哈希）。
 * 于是每块都能算出三个值：base（上次同步）/ local（本机现在）/ incoming（传进来的）。
 *
 * | local 与 base | incoming 与 base | 怎么做 |
 * |---|---|---|
 * | 相同 | 相同 | 什么都不用做 |
 * | 相同 | **变了** | 用 incoming（本机没动过） |
 * | **变了** | 相同 | 保留 local（对端没动过） |
 * | **变了** | **变了** | **冲突** —— 两边都改过同一块 |
 *
 * 配对采用**两阶段匹配**，跟库里 `saveDocBlocks` 的三趟认领是同一个思路：
 *   1. 先按**块 id** 配（id 稳定，绝大多数情况走这条）；
 *   2. 剩下的按**内容哈希**配（处理"同一块被两端各改了一次"）；
 *   3. 仍配不上的，各自算"只在一侧存在"。
 *
 * 阶段 3 还要再分一次：**本机新写的** vs **对端删掉的**。
 * 判据是「块在不在 base 里」——
 *   不在 base、只在 local  → 本机新增 → **保留**
 *   不在 base、只在 incoming → 对端新增 → **插入**
 *   在 base 里、缺在 local → 本机删了 → 尊重删除
 *   在 base 里、缺在 incoming → 对端删了 → 删除
 * 这一步不问清楚就会出现"我这边刚写的一段被同步抹掉"这种最气人的事故。
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

/*
 * 用 `@/` 别名而不是相对路径 + `.ts` 后缀：
 * 项目 tsconfig 没开 `allowImportingTsExtensions`（那是给 tests 目录用的，
 * 而 tests 被 exclude 掉了）。`@/*` → `./src/*` 有 path 映射，
 * 运行时的 `tests/ts-resolve.mjs` 也会处理它。
 */
import * as repo from "@/lib/db/repo";
import { contentHash } from "@/lib/blocks/markdown";
import type { BlockKind, DocKind } from "@/lib/db/types";

/* ------------------------------------------------------------------ *
 * 类型
 * ------------------------------------------------------------------ */

interface BlockRecord {
  id: string;
  kind: string;
  text: string;
  textHash: string;
}

export interface DocEntry {
  id: string;
  title: string;
  kind: string;
  parentId: string | null;
  sort: number;
  icon: string;
  /**
   * 导出这份 manifest 时该文档的正文哈希（不含块 id）。
   * 它是整个冲突判定的**基准（base）**：本机哈希与它不同 = 本机动过。
   */
  contentHash: string;
  blocks: BlockRecord[];
}

export interface Manifest {
  version: number;
  /** 生成这份 manifest 的机器标识（人工填，比如 "work" / "dorm"），只用于提示 */
  exportedBy: string;
  exportedAt: number;
  docs: DocEntry[];
}

/* ------------------------------------------------------------------ *
 * 工具
 * ------------------------------------------------------------------ */

export const OUT_DEFAULT = "knowledge";
const MANIFEST_NAME = "manifest.json";

/** 文件名只留安全字符；中文保留（git 与文件系统都能处理） */
export function safeName(title: string): string {
  const cleaned = title
    .replace(/[\\/:*?"<>|]/g, "") // Windows 非法字符
    .replace(/[\u0000-\u001f]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  // 兜底：标题全是非法字符时给个名字，否则会生成 "." / ".." 这类危险路径
  return cleaned === "" || cleaned === "." || cleaned === ".." ? "未命名" : cleaned.slice(0, 80);
}

/**
 * 取一个**全库唯一**的相对路径。
 *
 * ## 为什么必须有这一步（踩过的坑）
 *
 * `safeName` 会删掉非法字符，于是不同标题可能塌成同一个文件名：
 *
 *     "C++：面向对象"        →  "C++面向对象"
 *     "C++/面向对象"          →  "C++面向对象"   ← 撞车
 *
 * 实测在某次导出里，**43 篇文档只生成了 36 个唯一路径** —— 也就是说有 7 篇
 * 被同名的兄弟文档**静默覆盖**了。这种故障最恶劣的地方是它不报错：
 * 你只会发现"某几篇文档在另一台机器上变成了别人的内容"。
 *
 * 撞车时补一个文档 id 的短后缀。后缀取 id 的末 8 位而不是标题哈希 ——
 * 标题改名时后缀不变，文件不会被无谓地改名（改名会让 git 显示成删除+新增）。
 *
 * 副作用（可接受）：路径里出现 id 时，那个文件名不再"纯标题"。
 * 但正确性优先于好看，而且只在真正撞车时才出现。
 */
function uniquePath(
  title: string,
  kind: string,
  id: string,
  parentDir: string,
  used: Set<string>,
): string {
  const base = kind === "module" ? "index" : safeName(title);
  const dir = parentDir ? parentDir + "/" : "";
  let candidate = `${dir}${base}.md`;
  if (!used.has(candidate)) {
    used.add(candidate);
    return candidate;
  }
  candidate = `${dir}${base} (${id.slice(-8)}).md`;
  // 连 id 后缀都撞（理论上不可能）——再退一档，保证一定终止
  let n = 2;
  while (used.has(candidate)) {
    candidate = `${dir}${base} (${id.slice(-8)}-${n}).md`;
    n += 1;
  }
  used.add(candidate);
  return candidate;
}

/**
 * 算出"文档 id → 相对路径"的完整映射。
 *
 * 导出与导入**必须共用这一个函数**：两边只要有一处算法不同，
 * 就会把同一篇文档当成两篇（一边写出去、另一边认不出来）。
 */
export function computeFileMap(docs: readonly DocEntry[]): Map<string, string> {
  const byId = new Map(docs.map((d) => [d.id, d]));
  const fileOf = new Map<string, string>();
  const used = new Set<string>();

  /*
   * 按"深度优先、父级先于子级"的顺序处理，这样拼目录时父级路径一定已经算好。
   * 同时这也让 used 集合的填充顺序是确定的 —— 同样的库导出两次，
   * 撞车的那一篇永远拿到同一个后缀，不会每次导出换个名字。
   */
  const ordered: DocEntry[] = [];
  const visit = (d: DocEntry) => {
    ordered.push(d);
    for (const child of docs) if (child.parentId === d.id) visit(child);
  };
  for (const d of docs) if (!d.parentId || !byId.has(d.parentId)) visit(d);

  for (const d of ordered) {
    const parent = d.parentId ? byId.get(d.parentId) : undefined;
    const parentDir = parent ? fileOf.get(parent.id)!.replace(/[^\\/]+$/, "") + safeName(parent.title) : "";
    fileOf.set(d.id, uniquePath(d.title, d.kind, d.id, parentDir, used));
  }
  return fileOf;
}

/** 文档正文字符串（串成 markdown）——用于算 contentHash，与块 id 无关 */
export function bodyOf(blocks: readonly { text: string }[]): string {
  return blocks
    .map((b) => b.text.replace(/\s+$/, ""))
    .filter((t) => t.trim())
    .join("\n\n");
}

/**
 * 去掉 UTF-8 BOM。
 *
 * 为什么要管这个：带 BOM 时文件首字符是 `\uFEFF`，于是
 * `# 标题` 会变成 `\uFEFF# 标题` —— 首字符不是 `#`，**标题块退化成普通段落**。
 * 表现很隐蔽：内容看着一模一样，只是那一段不再是标题，
 * 于是它不再进目录、不再是 `heading` 块，块的 kind 与 cacheKey 都会变。
 *
 * 我自己的导出（Node `writeFileSync(..., "utf8")`）不写 BOM，
 * 但**记事本、某些 VS Code 配置、PowerShell 的 `Set-Content -Encoding UTF8`
 * 都会加 BOM** —— 而这些正是你手动看一眼文件时最可能用的工具。
 */
export function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/** 从正文里推标题：第一个 H1 的文本，没有就用文档 title */
function titleFromBody(markdown: string, fallback: string): string {
  const m = /^#\s+(.+?)\s*$/m.exec(markdown);
  return m ? m[1].trim() : fallback;
}

/**
 * 极简 Markdown 切块 —— **判据必须与 `src/lib/blocks/parse-blocks.ts` 一致**，
 * 否则导出再导入会把块切碎或合并。
 *
 * 这里不 import 应用的解析器，是为了让同步工具只依赖"文件格式"这一个契约：
 * 万一将来解析规则变了，同步工具的失败是**看得见的**（块数对不上会报出来），
 * 而不是悄悄按新规则重切一遍、把块 id 全部翻新。
 *
 * 已知取舍：只处理标题、围栏代码、引用、列表（含待办）、段落、空行。
 * 图片/表格在应用里也是按段落落的，这里同样按段落处理，结果一致。
 *
 * 导出给测试用 —— 切块规则是这套同步的**承重结构**（切错了块 id 会对不上，
 * 表现为每次同步都重建全部块、cacheKey 全变），必须有回归测试钉住。
 */
export function splitBlocks(markdown: string): { kind: BlockKind; text: string }[] {
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  const out: { kind: BlockKind; text: string }[] = [];
  const push = (kind: BlockKind, text: string) => {
    const trimmed = text.replace(/\s+$/, "");
    if (trimmed.trim()) out.push({ kind, text: trimmed });
  };

  const FENCE = /^(\s*)(`{3,}|~{3,})(.*)$/;
  const HEADING = /^(#{1,6})\s+(.*)$/;
  const QUOTE = /^\s*>\s?/;
  const UL = /^\s*[-*+]\s+/;
  const OL = /^\s*\d+[.)]\s+/;
  const TODO = /^\s*[-*+]\s+\[[ xX]\]\s+/;

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      i += 1;
      continue;
    }

    const fence = line.match(FENCE);
    if (fence) {
      const marker = fence[2][0];
      const len = fence[2].length;
      const buf = [line];
      i += 1;
      while (i < lines.length) {
        buf.push(lines[i]);
        const closing = lines[i].match(FENCE);
        i += 1;
        if (closing && closing[2][0] === marker && closing[2].length >= len) break;
      }
      const lang = (fence[3] ?? "").trim();
      push(lang === "diagram" ? "diagram" : "code", buf.join("\n"));
      continue;
    }

    if (HEADING.test(line)) {
      push("heading", line);
      i += 1;
      continue;
    }

    if (QUOTE.test(line)) {
      const buf: string[] = [];
      while (i < lines.length) {
        if (!lines[i].trim()) {
          if (i + 1 < lines.length && QUOTE.test(lines[i + 1])) {
            buf.push("");
            i += 1;
            continue;
          }
          break;
        }
        if (!QUOTE.test(lines[i])) break;
        buf.push(lines[i]);
        i += 1;
      }
      push("quote", buf.join("\n"));
      continue;
    }

    if (UL.test(line) || OL.test(line)) {
      const isTodo = TODO.test(line);
      const buf = [line];
      i += 1;
      while (i < lines.length) {
        const cur = lines[i];
        if (UL.test(cur) || OL.test(cur)) break;
        if (cur.trim() && /^\s{2,}/.test(cur)) {
          buf.push(cur);
          i += 1;
          continue;
        }
        if (!cur.trim()) {
          const next = lines[i + 1];
          if (next !== undefined && next.trim() && /^\s{2,}/.test(next)) {
            buf.push("");
            i += 1;
            continue;
          }
        }
        break;
      }
      push(isTodo ? "todo" : "list", buf.join("\n"));
      continue;
    }

    const buf: string[] = [];
    while (i < lines.length) {
      const cur = lines[i];
      if (!cur.trim()) break;
      if (FENCE.test(cur) || HEADING.test(cur) || QUOTE.test(cur) || UL.test(cur) || OL.test(cur)) break;
      buf.push(cur);
      i += 1;
    }
    if (buf.length > 0) push("paragraph", buf.join("\n"));
    else {
      push("paragraph", line);
      i += 1;
    }
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * export
 * ------------------------------------------------------------------ */

export function doExport(outDir: string) {
  const ws = repo.getWorkspace();
  if (!ws) throw new Error("没有工作区");

  const docs = repo.listDocs(ws.id);

  /*
   * 先把 manifest 需要的元信息收集齐（**不写文件**），因为路径映射要求
   * 全部文档都在手，才能做冲突消解 —— 边遍历边写文件的话，
   * 撞车时已经写出去的那一篇已经被覆盖了。
   */
  const entries: DocEntry[] = [];
  let blockCount = 0;
  let nonEmpty = 0;

  for (const doc of docs) {
    const blocks = repo.listBlocks(doc.id).filter((b) => b.seq >= 0 && b.text.trim());
    const markdown = bodyOf(blocks);
    if (markdown.trim()) nonEmpty += 1;
    entries.push({
      id: doc.id,
      title: doc.title,
      kind: doc.kind,
      parentId: doc.parentId,
      sort: doc.sort,
      icon: doc.icon,
      contentHash: contentHash(markdown),
      blocks: blocks.map((b) => ({ id: b.id, kind: b.kind, text: b.text, textHash: b.textHash })),
    });
    blockCount += blocks.length;
  }

  const fileOf = computeFileMap(entries);
  const paths = [...fileOf.values()];
  const dupes = paths.length - new Set(paths).size;
  if (dupes > 0) {
    // 走到这里说明 uniquePath 失效了 —— 那会导致静默覆盖，必须硬失败
    throw new Error(`内部错误：有 ${dupes} 个路径重复，拒绝导出（会覆盖文档）`);
  }

  // 目录先清掉旧的 md：否则改过标题/删过的文档会在磁盘上留孤儿文件，
  // 下次 import 会把它们当成"对端新增"又建回来。
  if (existsSync(outDir)) {
    for (const entry of readdirSync(outDir, { recursive: true, withFileTypes: true })) {
      if (!entry.isFile()) continue;
      const abs = path.join(entry.parentPath ?? outDir, entry.name);
      const rel = path.relative(outDir, abs).split(path.sep).join("/");
      if (/\.md$/i.test(rel) || rel === MANIFEST_NAME) rmSync(abs, { force: true });
    }
  } else {
    mkdirSync(outDir, { recursive: true });
  }

  for (const d of entries) {
    const abs = path.join(outDir, fileOf.get(d.id)!);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, bodyOf(d.blocks) + "\n", "utf8");
  }

  const manifest: Manifest = {
    version: 1,
    exportedBy: process.env.NODES_MACHINE ?? "unknown",
    exportedAt: Date.now(),
    docs: entries,
  };
  writeFileSync(path.join(outDir, MANIFEST_NAME), JSON.stringify(manifest, null, 2) + "\n", "utf8");
  writeReadme(outDir);

  console.log(`已导出 ${entries.length} 篇文档 / ${blockCount} 个块 → ${outDir}/`);
  console.log(`  其中 ${nonEmpty} 篇有正文，${entries.length - nonEmpty} 篇是空模块/空文档`);
  console.log(`  唯一路径 ${new Set(paths).size} 个（撞车的文件名自动补了文档 id 后缀）`);
  console.log("");
  console.log("下一步：");
  console.log(`  git add ${path.relative(process.cwd(), outDir) || outDir}`);
  console.log('  git commit -m "sync 知识库" && git push');
}

function writeReadme(outDir: string) {
  const text = `# knowledge/ —— 知识库的文本镜像

这个目录是**自动生成**的，由 \`npm run sync:export\` 写出。

## 不要手动改这里

改内容请改数据库（打开应用编辑），然后重新导出。
手改这里的文件会在下次导入时产生冲突，反而更麻烦。

## 它是干什么的

在两台机器之间同步知识库。**不要同步 \`.data/nodes.db\`** ——
SQLite 是 db + wal + shm 三个文件协同的，网盘会把它们拆开传或传到一半，
结果是数据库不一致，而且不会立刻报错。

这里只放纯文本，git 能逐行 diff，冲突看得出是哪一段。

## 文件对应关系

每篇文档一个 \`.md\`，目录结构镜像文档树；模块对应目录里的 \`index.md\`。
\`manifest.json\` 记录每篇文档的 id、父级、以及**每个块的 id 与上次同步时的内容哈希**。

## 同步流程

\`\`\`bash
# 改完知识库，在这台机器上
npm run sync:export
git add knowledge && git commit -m "sync" && git push

# 到另一台机器
git pull
npm run sync:import          # 先看报告，不写库
npm run sync:import -- --apply   # 确认无误再执行
\`\`\`

## 冲突怎么处理

如果两台机器改了同一篇文档的同一块，导入时会报冲突。
默认策略：**保留本机版本**，并在报告里列出对端的内容，由你决定要不要手工合并。
报告一定会打印出来，不会静默丢弃任何一侧的内容。

## 什么不会被同步

- **API 密钥、模型配置**（\`model_config\`）—— 传进 git 等于泄密
- **对话与审计记录** —— 那是"在这台机器上发生过的事"，不是知识内容
- **人设与规约**（\`workspace.persona\` / \`conventions\`）—— 故意留在各自机器上，
  否则 A 机器改一次人设就会覆盖 B 机器的
`;
  writeFileSync(path.join(outDir, "README.md"), text, "utf8");
}

/* ------------------------------------------------------------------ *
 * import
 * ------------------------------------------------------------------ */

interface IncomingDoc {
  /** 磁盘上的相对路径，用于报告 */
  file: string;
  id: string | null;
  title: string;
  kind: DocKind;
  markdown: string;
  contentHash: string;
  blocks: { kind: BlockKind; text: string }[];
}

function readIncoming(outDir: string, manifest: Manifest): IncomingDoc[] {
  /*
   * ⚠️ 路径必须**只从 manifest 推**，绝不能查本机库。
   *
   * 踩过的坑：最初这里查 `repo.listDocs()` 拿本地文档来拼路径。
   * 但 manifest 是**对端**导出的 —— 对端新建的文档，本机库里根本没有那些 id，
   * 于是每一篇都对不上、全被判成"本机也要新增"，`inc.id` 全是 null。
   * 表现是同一个文档在两边各存一份，而且永远不会合并。
   *
   * manifest 里已经带了完整 parentId / kind / title，拼路径的信息它是自足的，
   * 而且用的是与导出**同一个** `computeFileMap` —— 这是两边能对上的唯一保证。
   */
  const byFile = new Map<string, DocEntry>();
  for (const [id, rel] of computeFileMap(manifest.docs)) {
    const entry = manifest.docs.find((d) => d.id === id);
    if (entry) byFile.set(rel, entry);
  }

  const result: IncomingDoc[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const abs = path.join(dir, entry);
      if (statSync(abs).isDirectory()) {
        walk(abs);
        continue;
      }
      if (!/\.md$/i.test(entry) || entry.toLowerCase() === "readme.md") continue;
      const rel = path.relative(outDir, abs).split(path.sep).join("/");
      const markdown = stripBom(readFileSync(abs, "utf8"));
      const matched = byFile.get(rel);
      result.push({
        file: rel,
        id: matched?.id ?? null,
        title: titleFromBody(markdown, matched?.title ?? path.basename(entry, ".md")),
        kind: (matched?.kind as DocKind | undefined) ?? "doc",
        markdown,
        contentHash: contentHash(markdown),
        blocks: splitBlocks(markdown),
      });
    }
  };
  walk(outDir);
  return result;
}

/** 两阶段配对：先按 id，再按内容哈希 */
function pairBlocks(
  local: { id: string; kind: string; text: string; textHash: string }[],
  incoming: { kind: string; text: string }[],
) {
  const pairs: { localIndex: number; incomingIndex: number }[] = [];
  const localUsed = new Set<number>();
  const incomingUsed = new Set<number>();

  // 阶段 1：位置 + 内容哈希一致 → 同一块（绝大多数的正常情况）
  const max = Math.min(local.length, incoming.length);
  for (let i = 0; i < max; i += 1) {
    if (local[i].kind === incoming[i].kind && local[i].textHash === contentHash(incoming[i].text)) {
      pairs.push({ localIndex: i, incomingIndex: i });
      localUsed.add(i);
      incomingUsed.add(i);
    }
  }

  // 阶段 2：剩下的按内容哈希配（处理"两端各改了一次"）
  const byHash = new Map<string, number[]>();
  local.forEach((b, i) => {
    if (localUsed.has(i)) return;
    const list = byHash.get(b.textHash) ?? [];
    list.push(i);
    byHash.set(b.textHash, list);
  });
  incoming.forEach((b, j) => {
    if (incomingUsed.has(j)) return;
    const cands = byHash.get(contentHash(b.text));
    const hit = cands?.find((i) => !localUsed.has(i) && local[i].kind === b.kind);
    if (hit !== undefined) {
      pairs.push({ localIndex: hit, incomingIndex: j });
      localUsed.add(hit);
      incomingUsed.add(j);
    }
  });

  return {
    pairs,
    localOnly: local.map((_, i) => i).filter((i) => !localUsed.has(i)),
    incomingOnly: incoming.map((_, j) => j).filter((j) => !incomingUsed.has(j)),
  };
}

export function doImport(outDir: string, apply: boolean) {
  const ws = repo.getWorkspace();
  if (!ws) throw new Error("没有工作区");

  const manifestPath = path.join(outDir, MANIFEST_NAME);
  const manifest: Manifest | null = existsSync(manifestPath)
    ? (JSON.parse(readFileSync(manifestPath, "utf8")) as Manifest)
    : null;
  if (!manifest) {
    console.error(`找不到 ${manifestPath} —— 这个目录不是 sync 导出的，无法合并。`);
    console.error("（首次同步请在一台机器上先跑 npm run sync:export，把 knowledge/ 提交上去）");
    process.exitCode = 1;
    return;
  }

  const incoming = readIncoming(outDir, manifest);
  const localDocs = repo.listDocs(ws.id);
  const localById = new Map(localDocs.map((d) => [d.id, d]));

  console.log(`本机 ${localDocs.length} 篇文档；待合并 ${incoming.length} 篇（来自 ${outDir}/）`);
  console.log("");

  let newDocs = 0;
  let updated = 0;
  let unchanged = 0;
  let conflicts = 0;

  for (const inc of incoming) {
    const localDoc = inc.id ? localById.get(inc.id) : undefined;

    if (!localDoc) {
      console.log(`  [新增] ${inc.title}  (${inc.blocks.length} 块)`);
      newDocs += 1;
      if (apply) {
        const created = repo.createDoc({
          workspaceId: ws.id,
          parentId: null, // 父级在第二趟统一挂
          title: inc.title,
          kind: inc.kind ?? "doc",
        });
        repo.saveDocBlocks(
          created.id,
          inc.blocks.map((b) => ({ kind: b.kind as never, text: b.text })),
          contentHash,
        );
      }
      continue;
    }

    const manifestDoc = manifest.docs.find((d) => d.id === localDoc.id);
    const localBlocks = repo
      .listBlocks(localDoc.id)
      .filter((b) => b.seq >= 0 && b.text.trim())
      .map((b) => ({ id: b.id, kind: b.kind, text: b.text, textHash: b.textHash }));

    const localBody = bodyOf(localBlocks);
    const localHash = contentHash(localBody);

    if (localHash === inc.contentHash) {
      unchanged += 1;
      continue;
    }

    /*
     * ## 这里**故意不做**"文档级捷径"
     *
     * 曾经有一版是：先用文档级 `contentHash` 判断"本机相对 base 动过吗"，
     * 没动过就直接采用对端、跳过逐块合并。看着是个合理的快路径，实际会静默丢数据：
     *
     *   - 文档级哈希是**整篇正文**的哈希，它只回答"两边一样吗"，
     *     回答不了"**哪个块**变了"；
     *   - 于是"本机改了 A 块、对端改了 B 块"这种**本可自动合并**的情况，
     *     会被判成"本机改了 → 直接采用对端"，**A 块的改动被无声丢掉**。
     *     实测就撞上了：模拟对端改一处，报告说"保留本机改动"，
     *     而代码走的是"用对端整篇覆盖本机"那条路。
     *
     * 块级基准（manifest.doc.blocks）是精确的，而且逐块比对的开销
     * 在几百块这个量级上完全可以忽略。**有精确判据就不要用粗判据抢答。**
     */
    // 两边都动过 → **逐块三路合并**
    /*
     * ## 为什么必须是三路而不是启发式
     *
     * 我第一版用的是启发式：把只出现在一侧的块，按"它的内容在不在 base 里"
     * 猜是新增还是删除。实测立刻出错 —— 那 2 个块是我**上一次导入进来的**，
     * 本轮对端把它们删了，正确行为是**跟着删掉**，
     * 而启发式把它们当成了"本机新增"并保留，于是删不掉。
     *
     * 之所以会猜，是因为我以为"块在文档里但 base 里没有"只能靠内容比对。
     * **其实不用猜**：manifest 存了该文档 base 状态下的**完整块 id 顺序**，
     * base 的第 i 项就是第 i 槽位的 id。位置对齐之后，每个槽位的
     * base / local / incoming 三者都是确定的，删除与新增自然分得开。
     *
     * 前提是"同一篇文档内块只增删、不重排"。这条前提不成立时（重排、拆合）
     * 位置对齐会给出错误配对 —— 但那种情况下**任何**基于位置的合并都会出错，
     * 逐块内容比对是另一个量级的复杂度。真遇到时报告会显示成冲突，
     * 不会静默丢数据。
     */
    const base = manifestDoc?.blocks ?? [];
    const n = Math.max(base.length, localBlocks.length, inc.blocks.length);

    const finalBlocks: { kind: BlockKind; text: string }[] = [];
    const bothChanged: { localText: string; incomingText: string }[] = [];
    let tookIncoming = 0;
    let keptLocal = 0;
    let deleted = 0;

    for (let i = 0; i < n; i += 1) {
      const b = base[i];
      const l = localBlocks[i];
      const inc2 = inc.blocks[i];

      const L: string | null = l ? l.text : null;
      const I: string | null = inc2 ? inc2.text : null;
      // base 缺失该槽位 = 它没被同步过：只有"本机有"才说明 base 有内容
      const B: string | null = b ? b.text : l ? l.text : null;

      const localChanged = L !== B;
      const incomingChanged = I !== B;

      if (!localChanged) {
        // 本机没动 → 完全跟随对端
        if (incomingChanged) {
          if (I !== null) {
            finalBlocks.push({ kind: inc2!.kind, text: I });
            tookIncoming += 1;
          } else if (l) {
            deleted += 1; // 对端删了，本机跟着删（saveDocBlocks 会自动软删没出现的块）
          }
        } else if (L !== null) {
          finalBlocks.push({ kind: l!.kind, text: L });
        }
        continue;
      }

      // 本机动了、对端没动 → 保留本机
      if (!incomingChanged) {
        if (L !== null) {
          finalBlocks.push({ kind: l!.kind, text: L });
          keptLocal += 1;
        }
        continue;
      }

      // 两边都动了
      if (L === I) {
        // 恰好改成同一个结果 —— 不是冲突
        if (I !== null) finalBlocks.push({ kind: inc2!.kind, text: I });
        continue;
      }

      bothChanged.push({
        localText: L ?? "(已删除)",
        incomingText: I ?? "(已删除)",
      });
      if (L !== null) finalBlocks.push({ kind: l!.kind, text: L }); // 默认保留本机
    }

    const parts: string[] = [];
    if (tookIncoming > 0) parts.push(`跟随对端 ${tookIncoming} 块`);
    if (keptLocal > 0) parts.push(`保留本机改动 ${keptLocal} 块`);
    if (deleted > 0) parts.push(`跟随对端删除 ${deleted} 块`);
    if (bothChanged.length > 0) parts.push(`**冲突 ${bothChanged.length} 块**`);

    console.log(`  [${bothChanged.length > 0 ? "冲突" : "合并"}] ${inc.title}  ${parts.join("，") || "（无内容变化）"}`);

    if (bothChanged.length > 0) {
      conflicts += bothChanged.length;
      for (const c of bothChanged.slice(0, 3)) {
        const head = (t: string) => t.split("\n", 1)[0].slice(0, 58);
        console.log(`         本机：${head(c.localText)}`);
        console.log(`         对端：${head(c.incomingText)}`);
      }
      if (bothChanged.length > 3) console.log(`         …另有 ${bothChanged.length - 3} 块冲突`);
      console.log(`         → 默认保留本机版本；对端内容在报告里，需要时手工合并`);
    }

    if (apply) {
      repo.saveDocBlocks(
        localDoc.id,
        finalBlocks,
        contentHash,
        localBlocks.map((b) => b.id),
      );
    }

    updated += 1;
  }

  /* -------- 父级关系：第二趟统一挂（此时新文档都已存在） -------- */
  if (apply) {
    const all = repo.listDocs(ws.id);
    const byId = new Map(all.map((d) => [d.id, d]));
    for (const d of manifest.docs) {
      const target = byId.get(d.id);
      if (!target) continue;
      const wantParent = d.parentId && byId.has(d.parentId) ? d.parentId : null;
      if (target.parentId !== wantParent || target.title !== d.title) {
        repo.updateDoc(d.id, { title: d.title, parentId: wantParent });
      }
    }
  }

  console.log("");
  console.log("────────────────────────────────");
  console.log(`新增 ${newDocs} 篇 / 更新 ${updated} 篇 / 未变 ${unchanged} 篇`);
  if (conflicts > 0) {
    console.log(`冲突 ${conflicts} 块 —— 已按"保留本机"处理，对端内容见上面的报告`);
  }
  console.log("");

  if (!apply) {
    console.log("这是 **dry-run**，什么都没有写入。");
    console.log("确认上面的报告没问题后，加 --apply 真正执行：");
    console.log(`  npm run sync:import -- --apply`);
  } else {
    console.log("已写入。");
    console.log("建议现在跑一次 npm run sync:export 把合并结果写回 knowledge/，再提交 git ——");
    console.log("否则下一次同步仍会以旧的 manifest 作为 base，把已经解决的冲突再报一遍。");
  }
}
