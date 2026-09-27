import { getAsset } from "@/lib/assets/store";

/**
 * 取回一张图片的原始字节。
 *
 * 路径形如 `/api/assets/<sha256>.<ext>`。id 的合法性由 `getAsset`
 * （进而 `isAssetId` 的正则）判定，非法一律 404 —— 这里绝不把用户输入
 * 拼进文件路径，`../` 在正则层面就过不去。
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const blob = getAsset(id);

  if (blob === null) {
    return new Response("素材不存在", { status: 404 });
  }

  /*
   * 三个响应头都是刻意的：
   *
   *  - `Content-Type` 用**魔数判定出来的**类型，不是客户端当初声明的。
   *  - `X-Content-Type-Options: nosniff` 阻止浏览器"猜"类型。没有它，
   *    即使我们给了正确的 image/png，某些旧浏览器仍可能把内容当 HTML 嗅探，
   *    于是"上传一张伪装图"又能变成 XSS。魔数判定 + nosniff 是两道独立的锁。
   *  - `Content-Security-Policy: default-src 'none'` —— 万一还是被当成文档
   *    打开，这条策略让图里夹带的任何脚本都无处执行；图片本身不受影响。
   *  - `immutable`：id 是内容哈希，**内容永不改变**，所以可以放心长期缓存。
   *    这也让浏览器不会为同一张图反复回源，预览滚动更顺。
   */
  return new Response(blob.bytes as unknown as BodyInit, {
    status: 200,
    headers: {
      "Content-Type": blob.mime,
      "Content-Length": String(blob.bytes.byteLength),
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'; sandbox",
      "Cache-Control": "public, max-age=31536000, immutable",
    },
  });
}
