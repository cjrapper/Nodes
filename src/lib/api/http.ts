/** API 路由共用的工具函数。 */

import { NextResponse } from "next/server";

import { getWorkspace, listDocs } from "../db/repo";
import type { Workspace } from "../db/types";

export function json<T>(data: T, init?: number | ResponseInit): NextResponse<T> {
  return NextResponse.json(data, typeof init === "number" ? { status: init } : init);
}

export function badRequest(message: string): NextResponse {
  return NextResponse.json({ error: message }, { status: 400 });
}

export function notFound(message = "资源不存在"): NextResponse {
  return NextResponse.json({ error: message }, { status: 404 });
}

export function serverError(err: unknown): NextResponse {
  const message = err instanceof Error ? err.message : String(err);
  console.error("[api]", err);
  return NextResponse.json({ error: message }, { status: 500 });
}

/**
 * 本地单机场景下只有一个工作区，所有路由都通过它解析归属，
 * 避免前端到处传 workspaceId。
 */
export function requireWorkspace(): Workspace {
  const ws = getWorkspace();
  if (!ws) throw new Error("工作区未初始化，数据库可能未正确创建");
  return ws;
}

/** 读取 JSON 请求体，失败时返回 null 而不是抛异常 */
export async function readJson<T>(request: Request): Promise<T | null> {
  try {
    return (await request.json()) as T;
  } catch {
    return null;
  }
}

/**
 * 脱敏 API Key。
 *
 * 前端永远拿不到完整 key —— 只在保存时单向写入。
 * 返回的 `apiKeySet` 让 UI 知道"是否已配置"，而 `apiKeyHint` 只露尾四位。
 */
export function maskApiKey(key: string): { apiKeySet: boolean; apiKeyHint: string } {
  if (!key) return { apiKeySet: false, apiKeyHint: "" };
  const tail = key.slice(-4);
  return { apiKeySet: true, apiKeyHint: `••••${tail}` };
}

/** 树形结构的扁平列表 → 嵌套结构 */
export interface DocTreeNode {
  id: string;
  parentId: string | null;
  title: string;
  icon: string;
  sort: number;
  blockCount: number;
  children: DocTreeNode[];
}

export function buildDocTree(workspaceId: string): DocTreeNode[] {
  const docs = listDocs(workspaceId);
  const nodes = new Map<string, DocTreeNode>();
  for (const d of docs) {
    nodes.set(d.id, {
      id: d.id,
      parentId: d.parentId,
      title: d.title,
      icon: d.icon,
      sort: d.sort,
      // blockCount 由调用方按需填充，这里先置 0 避免为树形渲染做 N 次查询
      blockCount: 0,
      children: [],
    });
  }
  const roots: DocTreeNode[] = [];
  for (const node of nodes.values()) {
    const parent = node.parentId ? nodes.get(node.parentId) : null;
    if (parent) parent.children.push(node);
    else roots.push(node);
  }
  const sortRec = (list: DocTreeNode[]) => {
    list.sort((a, b) => a.sort - b.sort || a.id.localeCompare(b.id));
    for (const n of list) sortRec(n.children);
  };
  sortRec(roots);
  return roots;
}
