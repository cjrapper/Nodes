import { badRequest, json, serverError } from "@/lib/api/http";
import { MAX_ASSET_BYTES, putAsset } from "@/lib/assets/store";

/**
 * 上传一张图片，返回它在正文里的引用 id。
 *
 * 两种请求体都接受：
 *  - `multipart/form-data`（浏览器 <input type="file"> / 拖拽 / 粘贴的默认形态）
 *  - 原始字节 + `Content-Type`（给脚本用，省掉 multipart 的边界处理）
 *
 * ⚠️ 两种都**不采信**客户端声明的类型 —— 真正的类型由 `putAsset` 按魔数判定。
 * 客户端传 `Content-Type: image/png` 只影响不了任何事，这是刻意的：
 * 一个伪装成 png 的 HTML 文件如果被同源 serve 出去，就是存储型 XSS。
 */
export async function POST(request: Request) {
  try {
    const contentType = request.headers.get("content-type") ?? "";
    let bytes: Uint8Array;

    if (contentType.includes("multipart/form-data")) {
      const form = await request.formData();
      const file = form.get("file");
      if (!(file instanceof File)) {
        return badRequest("multipart 请求里缺少 file 字段。");
      }
      if (file.size > MAX_ASSET_BYTES) {
        return badRequest(`图片 ${(file.size / 1024 / 1024).toFixed(1)} MB，超过上限。`);
      }
      bytes = new Uint8Array(await file.arrayBuffer());
    } else {
      /*
       * 先看 Content-Length 再读 body。
       *
       * 直接 arrayBuffer() 会把任意大小的请求体整个读进内存，一个 2 GB 的
       * 请求足以让服务进程 OOM —— 而这是一个本地单机服务，OOM 之后
       * Next.js 会重启，用户看到的是"应用莫名其妙崩了"。
       * 声明了长度就提前拒绝，没声明则读完再判。
       */
      const declared = Number(request.headers.get("content-length") ?? "0");
      if (Number.isFinite(declared) && declared > MAX_ASSET_BYTES) {
        return badRequest(`请求体 ${(declared / 1024 / 1024).toFixed(1)} MB，超过上限。`);
      }
      bytes = new Uint8Array(await request.arrayBuffer());
    }

    const stored = putAsset(bytes);
    return json(
      {
        asset: {
          id: stored.id,
          // 正文里直接可以粘贴的片段 —— 前端不必知道 asset: 协议的拼法
          markdown: `![](${"asset:"}${stored.id})`,
          bytes: stored.bytes,
          mime: stored.mime,
          /** false = 这张图之前就传过，没有产生新文件 */
          created: stored.created,
        },
      },
      stored.created ? 201 : 200,
    );
  } catch (err) {
    // putAsset 的校验失败是**用户可修正**的（格式不对 / 太大），归 400；
    // 其余（磁盘满、权限）才是 500。用 instanceof 分不开，看是不是 Error 且
    // 没带 errno 之类的系统字段来判断。
    if (err instanceof Error && !("code" in err)) return badRequest(err.message);
    return serverError(err);
  }
}
