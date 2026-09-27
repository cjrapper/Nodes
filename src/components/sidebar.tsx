"use client";

/**
 * 左侧资源栏：文档树 + 对话列表。
 *
 * 文档树和对话列表放在同一个侧栏里，是因为这个软件的核心动作就是
 * "在文档之间跳、把文档片段拉进对话" —— 两者需要随时在视线内共存，
 * 而不是藏在两个不同的页面里。
 *
 * 视图切换被刻意**删掉了**：原先有「笔记 / 对话 / 缓存」三个标签，但
 * 笔记页本身就带对话面板，"对话"那个标签点进去只是把面板放大一点，
 * 反而让人以为对话和笔记是两个割裂的功能。现在只剩"笔记"这一个主视图，
 * 缓存仪表盘降级为顶部的一个图标按钮。
 */

import {
  ChevronDown,
  ChevronRight,
  FileText,
  FolderPlus,
  FolderTree,
  Gauge,
  MessageSquarePlus,
  Pencil,
  Plus,
  Settings2,
  SlidersHorizontal,
  Sparkles,
  Trash2,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { cn, formatPercent, formatRelative } from "@/lib/ui/client";
import type { ConversationView, DocTreeNode } from "@/lib/ui/types";

interface SidebarProps {
  docs: DocTreeNode[];
  counts: Record<string, number>;
  activeDocId: string | null;
  conversations: ConversationView[];
  activeConversationId: string | null;
  /** 是否正在看缓存仪表盘（面板打开时高亮图标） */
  cacheOpen: boolean;
  onToggleCache: () => void;
  /** 面板宽度（px），由上层拖拽控制 */
  width: number;
  onSelectDoc: (docId: string) => void;
  onCreateDoc: (parentId: string | null) => void;
  /** 新建模块容器（不写正文，只挂载同类知识点） */
  onCreateModule: (parentId: string | null) => void;
  onRenameDoc: (docId: string, title: string) => void;
  /** 在「普通文档」与「模块容器」之间互转 */
  onSetKind: (docId: string, kind: "doc" | "module") => void;
  onDeleteDoc: (docId: string) => void;
  onSelectConversation: (conversationId: string) => void;
  onCreateConversation: () => void;
  onDeleteConversation: (conversationId: string) => void;
  onOpenSettings: () => void;
  onOpenModels: () => void;
}

/**
 * 就地重命名输入框。
 *
 * 为什么文档树里必须能改名：原先把改名能力只放在编辑器顶部的标题里，
 * 而那个位置的输入框长得和普通文字一模一样（无边框无底色），
 * 结果就是用户完全找不到改名的入口。
 * 树里双击即可改名，是符合直觉、也必须有的。
 */
function RenameInput({
  initial,
  onCommit,
  onCancel,
}: {
  initial: string;
  onCommit: (value: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(initial);
  const ref = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);

  return (
    <input
      ref={ref}
      value={value}
      onChange={(e) => setValue(e.target.value)}
      // 提交用 blur 兜底：用户改完直接点别处是很自然的操作
      onBlur={() => onCommit(value)}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          onCommit(value);
        } else if (e.key === "Escape") {
          e.preventDefault();
          onCancel();
        }
        e.stopPropagation();
      }}
      aria-label="重命名文档"
      className="min-w-0 flex-1 rounded border border-[#3ddc97]/50 bg-[#0b0d10] px-1 py-0.5 text-[13px] text-[var(--nodes-ink)]"
    />
  );
}

function TreeNode({
  node,
  depth,
  counts,
  activeDocId,
  onSelect,
  onCreate,
  onRename,
  onSetKind,
  onDelete,
}: {
  node: DocTreeNode;
  depth: number;
  counts: Record<string, number>;
  activeDocId: string | null;
  onSelect: (id: string) => void;
  onCreate: (parentId: string | null) => void;
  onRename: (id: string, title: string) => void;
  onSetKind: (id: string, kind: "doc" | "module") => void;
  onDelete: (id: string) => void;
}) {
  const [expanded, setExpanded] = useState(depth === 0);
  const [hovered, setHovered] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const hasChildren = node.children.length > 0;
  const active = node.id === activeDocId;
  const isModule = node.kind === "module";

  return (
    <div>
      <div
        className={cn(
          "group flex items-center gap-1 rounded-md pr-1 text-[13px] transition-colors",
          active ? "bg-[#3ddc97]/12 text-[var(--nodes-ink)]" : "text-[var(--nodes-ink-dim)] hover:bg-[#171b21]",
        )}
        style={{ paddingLeft: `${depth * 12 + 4}px` }}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
      >
        <button
          type="button"
          aria-label={expanded ? "折叠" : "展开"}
          onClick={() => setExpanded((v) => !v)}
          className={cn(
            "flex h-6 w-4 shrink-0 items-center justify-center",
            !hasChildren && "invisible",
          )}
        >
          {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        </button>

        {renaming ? (
          <RenameInput
            initial={node.title}
            onCommit={(value) => {
              setRenaming(false);
              const next = value.trim();
              if (next && next !== node.title) onRename(node.id, next);
            }}
            onCancel={() => setRenaming(false)}
          />
        ) : (
          <button
            type="button"
            onClick={() => onSelect(node.id)}
            onDoubleClick={() => setRenaming(true)}
            title={
              isModule
                ? `${node.title || "未命名模块"}（模块容器，双击重命名）`
                : `${node.title || "未命名文档"}（双击重命名）`
            }
            className="flex min-w-0 flex-1 items-center gap-1.5 py-1 text-left"
          >
            {isModule ? (
              // 模块容器用文件夹图标，和普通文档一眼区分开
              <FolderTree size={13} className={cn("shrink-0", active && "text-[#3ddc97]")} />
            ) : (
              <FileText size={13} className={cn("shrink-0", active && "text-[#3ddc97]")} />
            )}
            {node.title ? (
              <span className={cn("truncate", isModule && "font-medium")}>{node.title}</span>
            ) : (
              // 空标题显示成弱化占位，与"真的叫这个名字"区分开
              <span className="truncate text-[var(--nodes-ink-faint)] italic">
                {isModule ? "未命名模块" : "未命名文档"}
              </span>
            )}
            {counts[node.id] ? (
              <span className="shrink-0 font-mono text-[10px] text-[var(--nodes-ink-faint)]">
                {counts[node.id]}
              </span>
            ) : null}
          </button>
        )}

        {/* 操作按钮只在悬浮时出现，避免静态视觉噪音 */}
        {!renaming && (
          <div className={cn("flex shrink-0 items-center gap-0.5", !hovered && "opacity-0")}>
            {/*
              文档 ↔ 模块互转。
              用户往往是先建了一堆普通文档，之后才意识到某个方向应该是个
              分类容器 —— 没有这个入口就只能删了重建，把内容一起丢掉。
            */}
            <button
              type="button"
              aria-label={isModule ? "转为普通文档" : "转为模块容器"}
              title={
                isModule
                  ? "转为普通文档（模块不能写正文）"
                  : "转为模块容器（不写正文，只用来挂载同类知识点）"
              }
              onClick={(e) => {
                e.stopPropagation();
                onSetKind(node.id, isModule ? "doc" : "module");
              }}
              className="rounded p-1 text-[var(--nodes-ink-faint)] hover:bg-[#23282f] hover:text-[#6aa8ff]"
            >
              {isModule ? <FileText size={11} /> : <FolderTree size={11} />}
            </button>
            <button
              type="button"
              aria-label="重命名"
              title="重命名（也可双击文档名）"
              onClick={(e) => {
                e.stopPropagation();
                setRenaming(true);
              }}
              className="rounded p-1 text-[var(--nodes-ink-faint)] hover:bg-[#23282f] hover:text-[var(--nodes-ink)]"
            >
              <Pencil size={11} />
            </button>
            <button
              type="button"
              aria-label="新建子文档"
              title="新建子文档"
              onClick={(e) => {
                e.stopPropagation();
                onCreate(node.id);
                setExpanded(true);
              }}
              className="rounded p-1 text-[var(--nodes-ink-faint)] hover:bg-[#23282f] hover:text-[var(--nodes-ink)]"
            >
              <Plus size={11} />
            </button>
            <button
              type="button"
              aria-label="删除文档"
              title="删除文档"
              onClick={(e) => {
                e.stopPropagation();
                onDelete(node.id);
              }}
              className="rounded p-1 text-[var(--nodes-ink-faint)] hover:bg-[#23282f] hover:text-[#f2555a]"
            >
              <Trash2 size={11} />
            </button>
          </div>
        )}
      </div>

      {expanded &&
        node.children.map((child) => (
          <TreeNode
            key={child.id}
            node={child}
            depth={depth + 1}
            counts={counts}
            activeDocId={activeDocId}
            onSelect={onSelect}
            onCreate={onCreate}
            onRename={onRename}
            onSetKind={onSetKind}
            onDelete={onDelete}
          />
        ))}
    </div>
  );
}

export default function Sidebar(props: SidebarProps) {
  const {
    docs,
    counts,
    activeDocId,
    conversations,
    activeConversationId,
    cacheOpen,
    onToggleCache,
    width,
    onSelectDoc,
    onCreateDoc,
    onCreateModule,
    onRenameDoc,
    onSetKind,
    onDeleteDoc,
    onSelectConversation,
    onCreateConversation,
    onDeleteConversation,
    onOpenSettings,
    onOpenModels,
  } = props;

  return (
    <aside
      className="flex h-full shrink-0 flex-col border-r border-[#23282f] bg-[#12151a]"
      // 宽度由上层拖拽决定，写死在组件里会让面板无法调整
      style={{ width: `${width}px` }}
    >
      <div className="flex items-center gap-2 px-3 py-3">
        <div className="flex h-6 w-6 items-center justify-center rounded-md bg-[#3ddc97]/15">
          <Sparkles size={13} className="text-[#3ddc97]" />
        </div>
        <span className="text-[13px] font-semibold tracking-wide text-[var(--nodes-ink)]">Nodes</span>
        <div className="ml-auto flex items-center gap-0.5">
          <button
            type="button"
            onClick={onOpenModels}
            title="模型配置"
            aria-label="模型配置"
            className="rounded p-1.5 text-[var(--nodes-ink-faint)] transition-colors hover:bg-[#171b21] hover:text-[var(--nodes-ink)]"
          >
            <Settings2 size={14} />
          </button>
          <button
            type="button"
            onClick={onToggleCache}
            title="缓存与成本仪表盘"
            aria-label="缓存与成本仪表盘"
            aria-pressed={cacheOpen}
            className={cn(
              "rounded p-1.5 transition-colors",
              cacheOpen
                ? "bg-[#3ddc97]/15 text-[#3ddc97]"
                : "text-[var(--nodes-ink-faint)] hover:bg-[#171b21] hover:text-[var(--nodes-ink)]",
            )}
          >
            <Gauge size={14} />
          </button>
          <button
            type="button"
            onClick={onOpenSettings}
            title="工作区设置（人设、约定与外观）"
            aria-label="工作区设置"
            className="rounded p-1.5 text-[var(--nodes-ink-faint)] transition-colors hover:bg-[#171b21] hover:text-[var(--nodes-ink)]"
          >
            <SlidersHorizontal size={14} />
          </button>
        </div>
      </div>

      <div className="flex min-h-0 flex-1 flex-col">
        {/* 文档树 */}
        <div className="flex items-center justify-between px-3 py-1.5">
          <span className="text-[10px] font-medium tracking-wider text-[var(--nodes-ink-faint)] uppercase">
            知识库
          </span>
          <div className="flex items-center gap-0.5">
            {/*
              "模块"与"文档"两个新建入口刻意并列。
              模块是容器（不写正文，只挂载同类知识点），文档才有正文 ——
              用户能一眼看出这是个分类动作，而不是又建了一篇空文件。
            */}
            <button
              type="button"
              onClick={() => onCreateModule(null)}
              title="新建模块容器（不写正文，用来挂载同一类知识点）"
              aria-label="新建模块容器"
              className="rounded p-1 text-[var(--nodes-ink-faint)] transition-colors hover:bg-[#171b21] hover:text-[#6aa8ff]"
            >
              <FolderPlus size={12} />
            </button>
            <button
              type="button"
              onClick={() => onCreateDoc(null)}
              title="新建文档"
              aria-label="新建文档"
              className="rounded p-1 text-[var(--nodes-ink-faint)] transition-colors hover:bg-[#171b21] hover:text-[#3ddc97]"
            >
              <Plus size={12} />
            </button>
          </div>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
          {docs.length === 0 ? (
            <button
              type="button"
              onClick={() => onCreateDoc(null)}
              className="w-full rounded-lg border border-dashed border-[#23282f] px-3 py-4 text-[11px] text-[var(--nodes-ink-faint)] transition-colors hover:border-[#3ddc97]/40 hover:text-[var(--nodes-ink-dim)]"
            >
              还没有文档，点这里新建一篇
            </button>
          ) : (
            docs.map((node) => (
              <TreeNode
                key={node.id}
                node={node}
                depth={0}
                counts={counts}
                activeDocId={activeDocId}
                onSelect={onSelectDoc}
                onCreate={onCreateDoc}
                onRename={onRenameDoc}
                onSetKind={onSetKind}
                onDelete={onDeleteDoc}
              />
            ))
          )}
        </div>

        {/* 对话列表 */}
        <div className="flex items-center justify-between border-t border-[#23282f] px-3 py-1.5">
          <span className="text-[10px] font-medium tracking-wider text-[var(--nodes-ink-faint)] uppercase">
            对话
          </span>
          <button
            type="button"
            onClick={onCreateConversation}
            title="新建对话"
            aria-label="新建对话"
            className="rounded p-1 text-[var(--nodes-ink-faint)] transition-colors hover:bg-[#171b21] hover:text-[#3ddc97]"
          >
            <MessageSquarePlus size={12} />
          </button>
        </div>
        <div className="max-h-[38%] min-h-[120px] overflow-y-auto px-2 pb-3">
          {conversations.length === 0 ? (
            <p className="px-2 py-2 text-[11px] text-[var(--nodes-ink-faint)]">还没有对话</p>
          ) : (
            conversations.map((conv) => {
              const active = conv.id === activeConversationId;
              return (
                <div
                  key={conv.id}
                  className={cn(
                    "group flex items-center gap-1.5 rounded-md px-2 py-1.5 text-[12px] transition-colors",
                    active ? "bg-[#3ddc97]/12" : "hover:bg-[#171b21]",
                  )}
                >
                  <button
                    type="button"
                    onClick={() => onSelectConversation(conv.id)}
                    className="min-w-0 flex-1 text-left"
                  >
                    <div
                      className={cn("truncate", active ? "text-[var(--nodes-ink)]" : "text-[var(--nodes-ink-dim)]")}
                    >
                      {conv.title}
                    </div>
                    <div className="mt-0.5 flex items-center gap-2 text-[10px] text-[var(--nodes-ink-faint)]">
                      <span>{formatRelative(conv.updatedAt)}</span>
                      {conv.lastCache && conv.lastCache.hitRate > 0 && (
                        <span className="text-[#3ddc97]">
                          命中 {formatPercent(conv.lastCache.hitRate)}
                        </span>
                      )}
                    </div>
                  </button>
                  <button
                    type="button"
                    aria-label="删除对话"
                    onClick={() => onDeleteConversation(conv.id)}
                    className="shrink-0 rounded p-1 text-[var(--nodes-ink-faint)] opacity-0 transition-opacity hover:text-[#f2555a] group-hover:opacity-100"
                  >
                    <Trash2 size={11} />
                  </button>
                </div>
              );
            })
          )}
        </div>
      </div>
    </aside>
  );
}
