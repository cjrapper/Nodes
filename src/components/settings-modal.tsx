"use client";

/**
 * 工作区设置：人设（L0）、工作区约定（L1）与外观。
 *
 * 这个弹窗存在的意义不只是"填配置" —— 它要**明确告诉用户改前两者会
 * 让哪些缓存失效**。L0 改动会让全部缓存重建，L1 改动会保留 L0 但
 * 重建 L1 之后的一切。把代价写清楚，用户才会在改之前想一想。
 *
 * 外观（字号/字体/颜色）刻意**不**影响缓存，所以放在另一个分区里，
 * 并且不给任何失效警告 —— 这样用户能一眼分辨"哪些改动要花钱"。
 */

import { AlertTriangle, Palette, RotateCcw, Save, SlidersHorizontal, X } from "lucide-react";
import { useEffect, useState } from "react";

import AppearancePanel from "@/components/appearance-panel";
import { api } from "@/lib/ui/client";
import { cn } from "@/lib/ui/client";
import { DEFAULT_CONVENTIONS, DEFAULT_PERSONA } from "@/lib/db/defaults";
import type { WorkspaceView } from "@/lib/ui/types";

interface SettingsModalProps {
  workspace: WorkspaceView;
  onClose: () => void;
  onSaved: (workspace: WorkspaceView) => void;
}

type SettingsTab = "prompt" | "appearance";

export default function SettingsModal({ workspace, onClose, onSaved }: SettingsModalProps) {
  const [tab, setTab] = useState<SettingsTab>("prompt");
  const [name, setName] = useState(workspace.name);
  const [persona, setPersona] = useState(workspace.persona);
  const [conventions, setConventions] = useState(workspace.conventions);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedNote, setSavedNote] = useState<string | null>(null);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  const personaChanged = persona !== workspace.persona;
  const conventionsChanged = conventions !== workspace.conventions;

  const save = async () => {
    setSaving(true);
    setError(null);
    setSavedNote(null);
    try {
      const result = await api.patch<{
        workspace: WorkspaceView;
        invalidatedLayers: string[];
      }>("/api/workspace", { name, persona, conventions });
      onSaved(result.workspace);
      setSavedNote(
        result.invalidatedLayers.length > 0
          ? `已保存。以下层的缓存会重建：${result.invalidatedLayers.join("、")}`
          : "已保存，本次修改不影响缓存前缀。",
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "保存失败");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/60 p-6 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="w-full max-w-2xl rounded-xl border border-[#23282f] bg-[#12151a] shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-[#23282f] px-4 py-3">
          <h2 className="text-[13px] font-semibold text-[var(--nodes-ink)]">工作区设置</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="关闭"
            className="rounded p-1 text-[var(--nodes-ink-faint)] transition-colors hover:text-[var(--nodes-ink)]"
          >
            <X size={14} />
          </button>
        </div>

        {/* 分区标签：把"改了要花更多钱"（人设/约定）与"改了不花钱"（外观）分开 */}
        <div className="flex gap-1 border-b border-[#23282f] px-4 py-2">
          {(
            [
              ["prompt", "人设与约定", SlidersHorizontal],
              ["appearance", "外观", Palette],
            ] as const
          ).map(([key, label, Icon]) => (
            <button
              key={key}
              type="button"
              onClick={() => setTab(key)}
              aria-pressed={tab === key}
              className={cn(
                "flex items-center gap-1.5 rounded-md px-2.5 py-1 text-[11px] transition-colors",
                tab === key
                  ? "bg-[#23282f] text-[var(--nodes-ink)]"
                  : "text-[var(--nodes-ink-faint)] hover:text-[var(--nodes-ink-dim)]",
              )}
            >
              <Icon size={12} />
              {label}
            </button>
          ))}
        </div>

        {tab === "appearance" ? (
          <div className="p-4">
            <AppearancePanel
              workspace={workspace}
              onSaved={(ws) => {
                // 外观不影响缓存，所以这里不弹失效提示，只同步状态
                onSaved(ws);
              }}
            />
          </div>
        ) : (
        <div className="space-y-4 p-4">
          <div>
            <label
              htmlFor="ws-name"
              className="mb-1 block text-[11px] font-medium text-[var(--nodes-ink-dim)]"
            >
              工作区名称
            </label>
            <input
              id="ws-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="w-full rounded-md border border-[#23282f] bg-[#0b0d10] px-2.5 py-1.5 text-[12px] text-[var(--nodes-ink)] focus:border-[#3ddc97]/50"
            />
            <p className="mt-1 text-[10px] text-[var(--nodes-ink-faint)]">
              会作为 L0 层的一部分写进人设（"你是「XX」这个知识库的助手"）。
            </p>
          </div>

          <div>
            <div className="mb-1 flex items-center gap-2">
              <label
                htmlFor="ws-persona"
                className="text-[11px] font-medium text-[var(--nodes-ink-dim)]"
              >
                助手人设（L0 层）
              </label>
              {personaChanged && (
                <span className="flex items-center gap-1 rounded bg-[#f2555a]/10 px-1.5 py-0.5 text-[10px] text-[#f2555a]">
                  <AlertTriangle size={9} />
                  修改会让所有会话的全部缓存失效
                </span>
              )}
              {/*
                「恢复默认」必须在场。
                人设的默认值不是空白而是一段有实质内容的提示词，用户改坏之后
                没有回头路会很难受；而且默认值会随版本更新，给用户一个
                "看看现在推荐的是什么"的入口比让他去翻源码合理。
              */}
              {persona !== DEFAULT_PERSONA && (
                <button
                  type="button"
                  onClick={() => setPersona(DEFAULT_PERSONA)}
                  className="ml-auto flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-[10px] text-[var(--nodes-ink-faint)] transition-colors hover:bg-[#171b21] hover:text-[var(--nodes-ink)]"
                >
                  <RotateCcw size={9} />
                  恢复默认
                </button>
              )}
            </div>
            <textarea
              id="ws-persona"
              value={persona}
              onChange={(e) => setPersona(e.target.value)}
              rows={7}
              className="w-full resize-y rounded-md border border-[#23282f] bg-[#0b0d10] px-2.5 py-1.5 font-mono text-[12px] leading-relaxed text-[var(--nodes-ink)] focus:border-[#3ddc97]/50"
            />
            <p className="mt-1 text-[10px] leading-relaxed text-[var(--nodes-ink-faint)]">
              L0 是稳定性的最高层。写在这里的内容会在每一轮对话中被完整复用 ——
              写得越具体、改得越少，长期成本越低。输出契约（引用来源、Markdown 格式等）由系统自动附加，不需要在这里重复。
            </p>
          </div>

          <div>
            <div className="mb-1 flex items-center gap-2">
              <label
                htmlFor="ws-conventions"
                className="text-[11px] font-medium text-[var(--nodes-ink-dim)]"
              >
                工作区约定（L1 层）
              </label>
              {conventionsChanged && (
                <span className="flex items-center gap-1 rounded bg-[#f5b544]/10 px-1.5 py-0.5 text-[10px] text-[#f5b544]">
                  <AlertTriangle size={9} />
                  L0 仍可命中，L1 之后的缓存会重建
                </span>
              )}
              {conventions !== DEFAULT_CONVENTIONS && (
                <button
                  type="button"
                  onClick={() => setConventions(DEFAULT_CONVENTIONS)}
                  className="ml-auto flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-[10px] text-[var(--nodes-ink-faint)] transition-colors hover:bg-[#171b21] hover:text-[var(--nodes-ink)]"
                >
                  <RotateCcw size={9} />
                  恢复默认
                </button>
              )}
            </div>
            <textarea
              id="ws-conventions"
              value={conventions}
              onChange={(e) => setConventions(e.target.value)}
              rows={7}
              className="w-full resize-y rounded-md border border-[#23282f] bg-[#0b0d10] px-2.5 py-1.5 font-mono text-[12px] leading-relaxed text-[var(--nodes-ink)] focus:border-[#3ddc97]/50"
            />
            <p className="mt-1 text-[10px] leading-relaxed text-[var(--nodes-ink-faint)]">
              放术语表和写作约定。这一层比 L0 变得频繁一些，但仍应尽量克制 ——
              术语定义改一个字，所有会话从这一层开始的前缀都要重建。
            </p>
          </div>

          {error && (
            <p className="rounded-md bg-[#f2555a]/10 px-2.5 py-1.5 text-[11px] text-[#f2555a]">
              {error}
            </p>
          )}
          {savedNote && (
            <p className="rounded-md bg-[#171b21] px-2.5 py-1.5 text-[11px] text-[var(--nodes-ink-dim)]">
              {savedNote}
            </p>
          )}
        </div>
        )}

        <div className="flex justify-end gap-2 border-t border-[#23282f] px-4 py-3">
          {/*
            外观是即时保存的（改一下就生效），所以那一区不需要保存按钮 ——
            给它一个按不动的按钮只会让人以为"改完还没生效"。
          */}
          {tab === "prompt" ? (
            <>
              <button
                type="button"
                onClick={onClose}
                className="rounded-md border border-[#23282f] px-3 py-1.5 text-[11px] text-[var(--nodes-ink-dim)] transition-colors hover:text-[var(--nodes-ink)]"
              >
                关闭
              </button>
              <button
                type="button"
                onClick={() => void save()}
                disabled={saving}
                className="flex items-center gap-1 rounded-md bg-[#3ddc97]/15 px-3 py-1.5 text-[11px] text-[#3ddc97] transition-colors hover:bg-[#3ddc97]/25 disabled:opacity-40"
              >
                <Save size={11} />
                {saving ? "保存中…" : "保存"}
              </button>
            </>
          ) : (
            <button
              type="button"
              onClick={onClose}
              className="rounded-md border border-[#23282f] px-3 py-1.5 text-[11px] text-[var(--nodes-ink-dim)] transition-colors hover:text-[var(--nodes-ink)]"
            >
              完成
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
