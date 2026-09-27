"use client";

/**
 * 图表块：渲染流程图 / 分支图。
 *
 * 三条设计取舍：
 *
 *  1. **渲染成 SVG 字符串并注入**，而不是用 React 逐个元素构建。
 *     渲染器因此可以是一个纯函数，能在没有 DOM 的环境里完整单测 ——
 *     这是它敢手写布局算法的前提。
 *
 *  2. **节点跳转用真正的 `<a href>`**（由渲染器输出）。用户能中键新窗口打开、
 *     能复制链接，符合"像超链接一样"的预期；也不需要在这里绑定事件。
 *     链接形如 `?doc=<id>`，由上层（WorkspaceShell）监听并切换到对应文档。
 *
 *  3. **编辑与预览并排，而不是弹窗**。图和文字一样需要边看边改，
 *     弹窗会把上下文遮住。
 */

import { AlertTriangle, Code2, Eye, Image as ImageIcon } from "lucide-react";
import { useMemo, useState } from "react";

import { cn } from "@/lib/ui/client";
import { type LinkResolver, renderDiagram } from "@/lib/render/diagram";

interface DiagramBlockProps {
  /** 块的原始正文（可能是带 ``` 围栏的，也可能只是图语法本身） */
  source: string;
  onChange?: (next: string) => void;
  /** 只读模式：预览页里不给编辑入口 */
  readOnly?: boolean;
  /** 解析 `doc:` / `url:` 目标。默认只认 http(s)。 */
  resolveLink?: LinkResolver;
  /** 初始展示哪一面 */
  defaultView?: "preview" | "source" | "split";
  className?: string;
}

/**
 * 剥掉 ``` 围栏。
 *
 * 块正文里**保留围栏**（与代码块一致，序列化回 Markdown 时才能往返无损），
 * 但图表渲染器只认图语法，所以在这里剥一层。
 */
function stripFence(text: string): string {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  if (lines.length === 0) return text;
  const first = lines[0].trim();
  if (!/^(`{3,}|~{3,})/.test(first)) return text;
  const last = lines[lines.length - 1].trim();
  const body = /^(`{3,}|~{3,})\s*$/.test(last) ? lines.slice(1, -1) : lines.slice(1);
  return body.join("\n");
}

/** 给图语法套回围栏，保持与块存储格式一致 */
function wrapFence(body: string): string {
  return `\`\`\`diagram\n${body.replace(/\n+$/, "")}\n\`\`\``;
}

export default function DiagramBlock({
  source,
  onChange,
  readOnly = false,
  resolveLink,
  defaultView = "split",
  className,
}: DiagramBlockProps) {
  const [view, setView] = useState<"preview" | "source" | "split">(
    readOnly ? "preview" : defaultView,
  );
  const [draft, setDraft] = useState(() => stripFence(source));

  // 外部内容变化时同步草稿（例如切换文档）
  const [lastSource, setLastSource] = useState(source);
  if (lastSource !== source) {
    setLastSource(source);
    setDraft(stripFence(source));
  }

  const { svg, layout, spec } = useMemo(
    () => renderDiagram(draft, resolveLink),
    [draft, resolveLink],
  );

  const commit = (next: string) => {
    setDraft(next);
    onChange?.(wrapFence(next));
  };

  const warnings = [...spec.warnings, ...layout.warnings];
  const isEmpty = draft.trim() === "";

  return (
    <div className={cn("overflow-hidden rounded-lg border border-[#23282f] bg-[#0f1216]", className)}>
      <div className="flex items-center gap-2 border-b border-[#23282f] px-2 py-1.5">
        <ImageIcon size={12} className="shrink-0 text-[#6aa8ff]" />
        <span className="text-[11px] font-medium text-[var(--nodes-ink-dim)]">
          {spec.title || "分支图"}
        </span>
        <span className="shrink-0 font-mono text-[10px] text-[var(--nodes-ink-faint)]">
          {spec.nodes.length} 节点 · {spec.edges.length} 连线
        </span>

        {!readOnly && (
          <div className="ml-auto flex shrink-0 items-center gap-0.5 rounded-md bg-[#171b21] p-0.5">
            {(
              [
                ["source", Code2, "看源文本"],
                ["split", ImageIcon, "并排"],
                ["preview", Eye, "只看图"],
              ] as const
            ).map(([key, Icon, label]) => (
              <button
                key={key}
                type="button"
                title={label}
                aria-label={label}
                aria-pressed={view === key}
                onClick={() => setView(key)}
                className={cn(
                  "rounded p-1 transition-colors",
                  view === key
                    ? "bg-[#23282f] text-[var(--nodes-ink)]"
                    : "text-[var(--nodes-ink-faint)] hover:text-[var(--nodes-ink-dim)]",
                )}
              >
                <Icon size={11} />
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="flex min-h-0">
        {!readOnly && view !== "preview" && (
          <textarea
            value={draft}
            onChange={(e) => commit(e.target.value)}
            spellCheck={false}
            aria-label="图表源文本"
            placeholder={"# 标题\n入口 --> 分支A\n入口 --> 分支B\n分支A --> 汇合\n汇合 --> doc:某篇文档的id"}
            className={cn(
              "min-h-[140px] resize-y bg-transparent p-2.5 font-mono text-[11px] leading-relaxed text-[#c9d1d9] placeholder:text-[var(--nodes-ink-faint)]",
              view === "split" ? "w-1/2 border-r border-[#23282f]" : "flex-1",
            )}
          />
        )}

        {view !== "source" && (
          <div className="min-w-0 flex-1 overflow-auto p-2">
            {isEmpty ? (
              <p className="px-2 py-6 text-center text-[11px] text-[var(--nodes-ink-faint)]">
                还没有内容。左侧写图语法，这里就会画出可点击的分支图。
              </p>
            ) : (
              <div
                className="nodes-diagram inline-block"
                // SVG 由纯函数渲染器产出，内部对所有用户文本做了 XML 逃逸，
                // 链接协议也在解析阶段受限 —— 见 diagram.ts 的注释
                dangerouslySetInnerHTML={{ __html: svg }}
              />
            )}
          </div>
        )}
      </div>

      {warnings.length > 0 && (
        <div className="border-t border-[#23282f] px-2.5 py-1.5">
          {warnings.map((w, index) => (
            <p key={index} className="flex items-start gap-1.5 text-[10px] leading-relaxed text-[#f5b544]">
              <AlertTriangle size={10} className="mt-0.5 shrink-0" />
              <span>{w}</span>
            </p>
          ))}
        </div>
      )}

      {!readOnly && (
        <div className="border-t border-[#23282f] px-2.5 py-1.5 text-[10px] leading-relaxed text-[var(--nodes-ink-faint)]">
          语法：<code className="font-mono text-[var(--nodes-ink-dim)]">A --&gt; B</code> 连线、
          <code className="font-mono text-[var(--nodes-ink-dim)]">{"A[\"显示名\"]"}</code> 命名、
          <code className="font-mono text-[var(--nodes-ink-dim)]">A{"{判断}"}</code> 菱形、
          <code className="font-mono text-[var(--nodes-ink-dim)]">--&gt; doc:文档id</code> 可点击跳转、
          <code className="font-mono text-[var(--nodes-ink-dim)]">#</code> 开头是标题。
        </div>
      )}
    </div>
  );
}
