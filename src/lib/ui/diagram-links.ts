"use client";

/**
 * 图表里的链接解析。
 *
 * 单独抽一个模块，是为了让"图节点该跳到哪"这件事**只有一处定义**：
 *  - 图表渲染器用它把 `doc:<id>` / `url:<地址>` 变成真正的 href；
 *  - WorkspaceShell 用同一套规则处理点击（把 `?doc=<id>` 变成切换文档）；
 *  - 编辑器预览注入它，保证预览与图表块行为一致。
 *
 * 之前这个函数内联在组件里，结果是"预览里的链接能点、收藏后的链接点不动"
 * 这类不一致特别容易出现。
 */

/** 文档跳转用的查询参数名 */
export const DOC_QUERY_PARAM = "doc";

/**
 * 把图表里的目标写成 href。
 *
 * 刻意用查询参数而不是 `#` 锚点或自定义协议：
 *  - 查询参数对浏览器来说是普通同源导航，用户中键新窗口、复制链接都正常；
 *  - 刷新页面也能落在同一篇文档上（shell 启动时会读这个参数）。
 */
export function resolveDiagramLink(target: string): string | null {
  const value = target.trim();

  const docMatch = /^doc[:：]\s*(.+)$/i.exec(value);
  if (docMatch) {
    return `?${DOC_QUERY_PARAM}=${encodeURIComponent(docMatch[1].trim())}`;
  }

  const urlMatch = /^url[:：]\s*(.+)$/i.exec(value);
  if (urlMatch) {
    const url = urlMatch[1].trim();
    // 只放行 http(s)：`javascript:` 之类的协议不能进 href
    return /^https?:\/\//i.test(url) ? url : null;
  }

  return null;
}

/** 从 `?doc=<id>` 形式的 href 里取出文档 id；不是文档链接则返回 null */
export function docIdFromHref(href: string): string | null {
  const match = new RegExp(`[?&]${DOC_QUERY_PARAM}=([^&]+)`).exec(href);
  if (!match) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return match[1];
  }
}
