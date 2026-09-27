/** 前端 API 客户端与格式化工具。 */

import type { ChatEvent, SearchResultView } from "./types";

export class ApiError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
  });

  const text = await response.text();
  let parsed: unknown = null;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = null;
    }
  }

  if (!response.ok) {
    const message =
      parsed && typeof parsed === "object" && "error" in parsed
        ? String((parsed as { error: unknown }).error)
        : `请求失败（HTTP ${response.status}）`;
    throw new ApiError(message, response.status);
  }

  return parsed as T;
}

export const api = {
  get: <T>(url: string) => request<T>(url),
  post: <T>(url: string, body: unknown) =>
    request<T>(url, { method: "POST", body: JSON.stringify(body) }),
  patch: <T>(url: string, body: unknown) =>
    request<T>(url, { method: "PATCH", body: JSON.stringify(body) }),
  put: <T>(url: string, body: unknown) =>
    request<T>(url, { method: "PUT", body: JSON.stringify(body) }),
  del: <T>(url: string) => request<T>(url, { method: "DELETE" }),
};

export interface UploadedAsset {
  id: string;
  /** 可直接插进正文的 Markdown 片段 */
  markdown: string;
  bytes: number;
  mime: string;
  /** false = 这张图之前传过（内容寻址，复用同一份文件） */
  created: boolean;
}

/**
 * 上传一张图片。
 *
 * **不能用 `api.post`**：那个函数写死了 `Content-Type: application/json`，
 * 而 multipart 的 `Content-Type` 必须带上 boundary，由浏览器自己生成。
 * 手动指定会覆盖掉 boundary，服务端就再也切不出文件部分 ——
 * 表现为 `formData()` 抛异常或 file 字段为空。
 *
 * 因此这里的 fetch **不设 headers**，让浏览器按 FormData 自行决定。
 */
export async function uploadAsset(file: File): Promise<UploadedAsset> {
  const form = new FormData();
  form.append("file", file, file.name || "image.png");

  const response = await fetch("/api/assets", { method: "POST", body: form });
  const text = await response.text();
  let parsed: unknown = null;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = null;
    }
  }

  if (!response.ok) {
    const message =
      parsed && typeof parsed === "object" && "error" in parsed
        ? String((parsed as { error: unknown }).error)
        : `上传失败（HTTP ${response.status}）`;
    throw new ApiError(message, response.status);
  }

  const asset = (parsed as { asset?: UploadedAsset } | null)?.asset;
  if (!asset?.markdown) throw new ApiError("服务端没有返回素材信息", 500);
  return asset;
}

/**
 * 读取 SSE 事件流。
 *
 * 用 fetch + ReadableStream 而不是 EventSource：EventSource 只能发 GET，
 * 而对话需要提交本轮输入、引用块、模型覆盖等请求体。
 */
export async function* streamChat(
  body: {
    conversationId: string;
    content: string;
    modelConfigId?: string | null;
    refBlockIds?: string[];
  },
  signal?: AbortSignal,
): AsyncGenerator<ChatEvent> {
  const response = await fetch("/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    let message = `HTTP ${response.status}`;
    try {
      const parsed = JSON.parse(text) as { error?: string };
      if (parsed.error) message = parsed.error;
    } catch {
      if (text) message = text.slice(0, 300);
    }
    throw new ApiError(message, response.status);
  }
  if (!response.body) throw new ApiError("服务端没有返回事件流", 500);

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let idx: number;
      while ((idx = buffer.indexOf("\n\n")) !== -1) {
        const frame = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        for (const line of frame.split("\n")) {
          if (!line.startsWith("data:")) continue;
          const payload = line.slice(5).trim();
          if (!payload) continue;
          try {
            yield JSON.parse(payload) as ChatEvent;
          } catch {
            // 单帧损坏不应中断整轮对话
          }
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

/* ---------------- 格式化 ---------------- */

export function formatTokens(tokens: number): string {
  if (tokens < 1000) return String(Math.round(tokens));
  if (tokens < 1_000_000) return `${(tokens / 1000).toFixed(1)}K`;
  return `${(tokens / 1_000_000).toFixed(2)}M`;
}

export function formatUsd(usd: number): string {
  if (!Number.isFinite(usd) || usd === 0) return "$0";
  if (usd < 0.0001) return `$${usd.toExponential(2)}`;
  if (usd < 1) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(2)}`;
}

export function formatPercent(ratio: number, digits = 0): string {
  if (!Number.isFinite(ratio)) return "—";
  return `${(ratio * 100).toFixed(digits)}%`;
}

export function formatRelative(ms: number): string {
  const diff = Date.now() - ms;
  if (diff < 60_000) return "刚刚";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
  if (diff < 7 * 86_400_000) return `${Math.floor(diff / 86_400_000)} 天前`;
  return new Date(ms).toLocaleDateString("zh-CN");
}

export function cn(...classes: (string | false | null | undefined)[]): string {
  return classes.filter(Boolean).join(" ");
}

export type { SearchResultView };
