/**
 * 图片素材库（本地文件存储，零依赖）。
 *
 * ## 为什么是"内容寻址"
 *
 * 文件名 = 内容的 SHA-256。这个选择不是为了好看，而是为了**缓存**：
 *
 *  - 同一张图重复粘贴，得到的是同一个 id，正文里的引用字节完全相同，
 *    块内容不变 → 该块的 cache_key 不变 → 会话前缀不变。
 *  - 如果按"上传时间"或"随机数"命名，同一张图两次上传会得到两个 id，
 *    用户看到的是"同一张图"，缓存看到的却是"块被编辑了"，前缀整段失效。
 *
 * 换句话说：**正文里存的是内容指纹，不是一个会漂移的句柄**。
 * 这也意味着素材永远不会因为"重新上传"而产生冗余副本。
 *
 * ## 为什么不进数据库
 *
 * 素材的元数据（mime、尺寸）都能从**文件自身**推出来，落库只会多一份
 * 可能与文件不一致的副本。真正无法从字节推出的信息（谁引用了它）由正文
 * 反向检索得到，那本来就是正文的职责。少一张表，就少一次迁移风险。
 *
 * ## 安全模型
 *
 * 素材 id 是唯一从**用户输入**流向文件系统的字符串，所以：
 *
 *  1. id 必须匹配 `^[0-9a-f]{64}\.[a-z0-9]{1,8}$` —— 严格白名单。
 *     `../`、绝对路径、NUL、Windows 盘符在正则层面就不可能通过。
 *  2. 扩展名只从**魔数**推断，绝不采信用户传来的文件名或 Content-Type。
 *     否则 `.html` / `.svg` 会被当成图片存下来，再被同源 serve 出去 ——
 *     那是一个存储型 XSS（`<svg onload=...>` 正是最常见的打法）。
 *  3. 目录按前两位哈希分片。单目录几万个文件在 Windows 上枚举会明显变慢，
 *     分片之后每个目录最多几百个。
 */

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

import { DATA_DIR } from "../db/index";

/** 素材根目录：`.data/assets/ab/abcdef....png` */
export const ASSETS_DIR = path.join(DATA_DIR, "assets");

/** 单张图上限 12 MiB。超过这个体积的图在笔记里也没有阅读价值。 */
export const MAX_ASSET_BYTES = 12 * 1024 * 1024;

/** 正文里引用素材的协议名：`![说明](asset:ab12...ff.png)` */
export const ASSET_PROTOCOL = "asset:";

/** 允许的图片类型 —— 只认这四种，全部由魔数判定 */
export type ImageMime = "image/png" | "image/jpeg" | "image/gif" | "image/webp";

const EXT_BY_MIME: Record<ImageMime, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
};

const MIME_BY_EXT: Record<string, ImageMime> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
};

/**
 * 按**魔数**判定图片类型 —— 全部字节都在判断范围内，不看扩展名、不看头部声明。
 *
 * 为什么必须这样：`Content-Type` 和文件名都是用户可控的。一个伪装成
 * `cat.png` 的 HTML 文件如果被当作图片存下并同源返回，浏览器会按 HTML 解析它，
 * 于是攻击者得到一个在站点源上执行的脚本。魔数是唯一无法伪装的证据。
 */
export function sniffImageMime(bytes: Uint8Array): ImageMime | null {
  /*
   * 门槛是 6 而不是 12。
   *
   * 12 这个数字来自 WebP（"RIFF" + 4 字节长度 + "WEBP" 要读到第 12 字节），
   * 但把它当**全局**门槛是错的：合法的最小 GIF 只要 6 字节文件头，
   * `GIF89a` + 一个最小逻辑屏幕描述符就是 11 字节 —— 正好被 12 挡在门外。
   * 每个分支各自检查自己需要的前缀长度，全局门槛取所有分支里最小的那个。
   */
  if (bytes.length < 6) return null;

  /*
   * 判定一律基于**字节比较**，不用 `String.fromCharCode(...)` 拼字符串再比。
   * 后者有两个坑：巨量参数展开有栈溢出风险，而且字节 → 字符的映射
   * 一旦写成 `String.fromCharCode.apply` 之类的变体，遇到高位字节
   * （PNG 签名开头的 `\x89` 就是）就容易出偏差。
   * Buffer 的 latin1 解码是逐字节恒等映射，没有歧义。
   */
  const head = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return "image/png";
  }

  // JPEG: FF D8 FF
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";

  // GIF: "GIF87a" / "GIF89a"
  const head6 = head.subarray(0, 6).toString("latin1");
  if (head6 === "GIF87a" || head6 === "GIF89a") return "image/gif";

  // WebP: "RIFF" .... "WEBP"（第 4~8 字节是文件长度，必须跳过再比对）
  if (bytes.length >= 12) {
    const riff = head.subarray(0, 4).toString("latin1");
    const webp = head.subarray(8, 12).toString("latin1");
    if (riff === "RIFF" && webp === "WEBP") return "image/webp";
  }

  return null;
}

/**
 * 素材 id 的严格白名单。这是唯一从用户输入到文件路径的通道。
 *
 * 扩展名**必须是已知的图片扩展名**，不能只要求"看起来像扩展名"。
 * 早期写成 `\.[a-z0-9]{1,8}$`，于是 `aaaa….php` 这种 id 能通过形状检查 ——
 * 虽然它取不到文件（盘上不存在），但"形状合法"这件事本身就是错的：
 * 任何将来把它当扩展名用的代码都会立刻变成漏洞（把 .php 存进可执行目录、
 * 或者按扩展名猜 Content-Type 时给出可执行类型）。
 * 白名单比"长度 1~8 的小写字母数字"窄得多，且窄得有道理。
 */
const ASSET_ID_RE = /^[0-9a-f]{64}\.(?:png|jpe?g|gif|webp)$/;

export function isAssetId(id: string): boolean {
  return ASSET_ID_RE.test(id);
}

/** 由字节算出素材 id。纯函数，同内容必然同 id。 */
export function assetIdFor(bytes: Uint8Array, mime: ImageMime): string {
  const hash = createHash("sha256").update(bytes).digest("hex");
  return `${hash}.${EXT_BY_MIME[mime]}`;
}

export function assetPath(id: string): string | null {
  if (!isAssetId(id)) return null;
  return path.join(ASSETS_DIR, id.slice(0, 2), id);
}

export interface StoredAsset {
  id: string;
  mime: ImageMime;
  bytes: number;
  /** 本次调用是否真的写了盘（false = 内容已存在，直接复用） */
  created: boolean;
}

/**
 * 存一张图。**内容已存在时不重复写盘** —— 这是"同一张图两次粘贴"
 * 只占一份空间、且引用完全相同的原因。
 */
export function putAsset(input: Uint8Array): StoredAsset {
  if (input.length === 0) throw new Error("文件是空的，没有内容可存。");
  if (input.length > MAX_ASSET_BYTES) {
    const mb = (input.length / 1024 / 1024).toFixed(1);
    throw new Error(`图片 ${mb} MB，超过 ${MAX_ASSET_BYTES / 1024 / 1024} MB 上限。`);
  }

  const mime = sniffImageMime(input);
  if (mime === null) {
    throw new Error("只支持 PNG / JPEG / GIF / WebP —— 其它格式的文件会被当成图片渲染，有安全风险。");
  }

  const id = assetIdFor(input, mime);
  const file = assetPath(id);
  if (file === null) throw new Error("素材 id 非法。");

  // 已存在就直接返回：内容寻址下"同一个 id"必然"同一份内容"
  try {
    statSync(file);
    return { id, mime, bytes: input.length, created: false };
  } catch {
    // 不存在 → 继续写
  }

  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, input);
  return { id, mime, bytes: input.length, created: true };
}

export interface AssetBlob {
  bytes: Uint8Array;
  mime: ImageMime;
}

/** 读取一张图。id 非法或文件不存在都返回 null（调用方回 404）。 */
export function getAsset(id: string): AssetBlob | null {
  const file = assetPath(id);
  if (file === null) return null;

  const ext = id.slice(id.lastIndexOf(".") + 1).toLowerCase();
  const mime = MIME_BY_EXT[ext];
  if (!mime) return null;

  try {
    return { bytes: readFileSync(file), mime };
  } catch {
    return null;
  }
}

/**
 * 正文 → 素材 id 列表（去重、保序）。
 *
 * 用途是"孤儿素材"的统计：文件不会因为正文删掉引用而自动消失，
 * 而**破坏用户数据是唯一不可接受的失败**，所以这里只报告、绝不自动删除。
 */
export function extractAssetIds(markdown: string): string[] {
  const found: string[] = [];
  const seen = new Set<string>();
  const re = new RegExp(`\\]\\(${ASSET_PROTOCOL}([^)\\s]+)\\)`, "g");
  for (const match of markdown.matchAll(re)) {
    const id = match[1];
    if (!seen.has(id) && isAssetId(id)) {
      seen.add(id);
      found.push(id);
    }
  }
  return found;
}
