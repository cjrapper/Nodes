"use client";

/**
 * 外观设置面板：字号 / 字体 / 行高 / 强调色 / 画布与面板底色。
 *
 * ## 职责边界（重要）
 *
 * 这个组件**只改数据**：把改动 debounce 之后 PATCH 回服务端，再通过 `onSaved`
 * 把新的工作区对象交回父组件。
 *
 * 它刻意**不**往 DOM 上写任何 CSS 变量 —— 那是 WorkspaceShell 的职责。
 * 两边都写的话，会在"本地预览"和"服务端已保存值"之间来回打架：
 * 用户拖滑块时组件把变量改成新值，父组件拿到旧值又改回去，出现闪烁。
 * 所以这里只负责预览块自己的内联样式，全局变量由单一来源（Shell）落地。
 */

import { Check, Loader2, RotateCcw, TriangleAlert } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { DEFAULT_APPEARANCE, type WorkspaceAppearance } from "@/lib/db/types";
import { api } from "@/lib/ui/client";
import type { WorkspaceView } from "@/lib/ui/types";

/** 拖滑块时不要每个像素都发一次请求 */
const SAVE_DEBOUNCE_MS = 400;

const FONT_OPTIONS: { label: string; value: string }[] = [
  { label: "系统默认", value: "" },
  { label: "思源黑体 / 无衬线", value: '"Noto Sans SC", system-ui, sans-serif' },
  { label: "宋体 / 衬线", value: '"Songti SC", Georgia, serif' },
  { label: "等宽", value: "ui-monospace, SFMono-Regular, Menlo, monospace" },
];

const ACCENT_PRESETS: { color: string; name: string }[] = [
  { color: "#3ddc97", name: "青绿" },
  { color: "#6aa8ff", name: "蓝" },
  { color: "#f5b544", name: "琥珀" },
  { color: "#f2555a", name: "红" },
  { color: "#a78bfa", name: "紫" },
  { color: "#2dd4bf", name: "青" },
];

/** 深色底：从纯黑到浅灰蓝，保证面板与画布之间始终有层次差 */
const SURFACE_PRESETS: { color: string; name: string }[] = [
  { color: "#0b0d10", name: "墨黑" },
  { color: "#0d1117", name: "深蓝黑" },
  { color: "#101317", name: "炭黑" },
  { color: "#14181d", name: "石板" },
  { color: "#1a1f26", name: "灰蓝" },
];

/**
 * 文字三层色各自的明度档位。
 *
 * ⚠️ 三层**不能共用一组预设** —— 那样点一下就会把三层刷成同一个颜色，
 * 信息层级当场塌掉。每层只列属于自己明度区间的值：
 *
 *   正文   `#d0d5dd` → `#ffffff`（偏暗 → 纯白）
 *   次要   `#6b7280` → `#cbd5e1`（与正文的下限始终留出差距）
 *   弱化   `#4b5563` → `#94a3b8`（永远比次要更暗）
 *
 * 也就是说三个区间是**互不重叠**的，用户无论怎么点都保得住层次。
 */
const INK_PRESETS: { color: string; name: string }[] = [
  { color: "#d0d5dd", name: "柔和白" },
  { color: "#e6e9ee", name: "默认" },
  { color: "#f5f7fa", name: "亮白" },
  { color: "#ffffff", name: "纯白" },
  { color: "#cfe3ff", name: "冷白" },
];

const INK_DIM_PRESETS: { color: string; name: string }[] = [
  { color: "#6b7280", name: "灰" },
  { color: "#98a2b3", name: "默认" },
  { color: "#b6c0cd", name: "浅灰" },
  { color: "#cbd5e1", name: "更浅" },
  { color: "#9db4d0", name: "冷灰" },
];

const INK_FAINT_PRESETS: { color: string; name: string }[] = [
  { color: "#4b5563", name: "深灰" },
  { color: "#6b7280", name: "默认" },
  { color: "#7d8794", name: "中灰" },
  { color: "#94a3b8", name: "浅灰" },
];

type SaveStatus = "idle" | "pending" | "saving" | "saved" | "error";

interface AppearancePanelProps {
  workspace: WorkspaceView;
  onSaved: (ws: WorkspaceView) => void;
}

const SLIDER_CLASS =
  "h-1.5 w-full cursor-pointer appearance-none rounded-lg bg-[#23282f] accent-[#3ddc97] focus:outline-none focus:ring-2 focus:ring-[#3ddc97]";

const SELECT_CLASS =
  "w-full rounded-md border border-[#23282f] bg-[#0b0d10] px-2.5 py-1.5 text-[12px] text-[var(--nodes-ink)] focus:border-[#3ddc97]/50";

const LABEL_CLASS = "block text-[11px] font-medium text-[var(--nodes-ink-dim)]";

export default function AppearancePanel({ workspace, onSaved }: AppearancePanelProps) {
  const [draft, setDraft] = useState<WorkspaceAppearance>(workspace.appearance);
  const [status, setStatus] = useState<SaveStatus>("idle");
  const [error, setError] = useState<string | null>(null);

  /** 最新草稿 —— 防抖回调与请求返回后都要读它，不能依赖闭包里的旧值 */
  const draftRef = useRef<WorkspaceAppearance>(workspace.appearance);
  /** 最近一次"已知"的服务端值（JSON），用于识别真正的外部改动 */
  const syncedRef = useRef<string>(JSON.stringify(workspace.appearance));
  /** onSaved 用 ref 持有：父组件传内联箭头函数也不会让防抖重新计时 */
  const onSavedRef = useRef(onSaved);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    onSavedRef.current = onSaved;
  }, [onSaved]);

  // 卸载时清掉挂起的防抖，避免请求打到已卸载的组件上
  useEffect(
    () => () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    },
    [],
  );

  /*
   * 外部改动才覆盖本地草稿（例如别处保存了工作区）。
   * 自己刚保存的那次也会从父组件回流进来，这里靠 JSON 比对认出来并跳过，
   * 否则用户正在拖的滑块会被"拽回去"。
   */
  useEffect(() => {
    const incoming = JSON.stringify(workspace.appearance);
    if (incoming === syncedRef.current) return;
    syncedRef.current = incoming;
    if (incoming === JSON.stringify(draftRef.current)) return;
    draftRef.current = workspace.appearance;
    setDraft(workspace.appearance);
  }, [workspace.appearance]);

  const save = useCallback(async (next: WorkspaceAppearance) => {
    setStatus("saving");
    setError(null);
    try {
      const result = await api.patch<{ workspace: WorkspaceView }>("/api/workspace", {
        appearance: next,
      });
      syncedRef.current = JSON.stringify(result.workspace.appearance);
      onSavedRef.current(result.workspace);
      // 请求飞在天上时用户又改了 → 保持"待保存"，新的防抖会接手
      setStatus(JSON.stringify(draftRef.current) === JSON.stringify(next) ? "saved" : "pending");
    } catch (err) {
      setError(err instanceof Error ? err.message : "保存失败");
      setStatus("error");
    }
  }, []);

  /** 即时预览 + 400ms 防抖保存 */
  const apply = useCallback(
    (patch: Partial<WorkspaceAppearance>) => {
      const next = { ...draftRef.current, ...patch };
      draftRef.current = next;
      setDraft(next);
      setStatus("pending");
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => {
        timerRef.current = null;
        void save(next);
      }, SAVE_DEBOUNCE_MS);
    },
    [save],
  );

  const resetAll = useCallback(() => {
    apply(DEFAULT_APPEARANCE);
  }, [apply]);

  const { fontSize, codeFontSize, lineHeight, fontFamily, accent, canvas, panel } = draft;

  return (
    <section className="rounded-xl border border-[#23282f] bg-[#12151a] p-4">
      <header className="mb-3 flex items-center justify-between gap-3">
        <div>
          <h2 className="text-[13px] font-semibold text-[var(--nodes-ink)]">外观</h2>
          <p className="mt-0.5 text-[10px] text-[var(--nodes-ink-faint)]">
            纯展示层设置，不参与缓存哈希 —— 改了不会让任何一层缓存失效。
          </p>
        </div>
        <StatusNotice status={status} error={error} />
      </header>

      <div className="space-y-4">
        {/* ---------------- 字号与行高 ---------------- */}
        <div className="grid gap-4 sm:grid-cols-3">
          <div>
            <div className="mb-1 flex items-baseline justify-between">
              <label htmlFor="appearance-font-size" className={LABEL_CLASS}>
                正文字号
              </label>
              <span className="font-mono text-[11px] text-[var(--nodes-ink)]">{fontSize}px</span>
            </div>
            <input
              id="appearance-font-size"
              type="range"
              min={11}
              max={22}
              step={1}
              value={fontSize}
              onChange={(e) => apply({ fontSize: Number(e.target.value) })}
              className={SLIDER_CLASS}
            />
          </div>

          <div>
            <div className="mb-1 flex items-baseline justify-between">
              <label htmlFor="appearance-line-height" className={LABEL_CLASS}>
                行高
              </label>
              <span className="font-mono text-[11px] text-[var(--nodes-ink)]">
                {lineHeight.toFixed(2)}
              </span>
            </div>
            <input
              id="appearance-line-height"
              type="range"
              min={1.2}
              max={2.4}
              step={0.05}
              value={lineHeight}
              onChange={(e) => apply({ lineHeight: Number(e.target.value) })}
              className={SLIDER_CLASS}
            />
          </div>

          <div>
            <div className="mb-1 flex items-baseline justify-between">
              <label htmlFor="appearance-code-font-size" className={LABEL_CLASS}>
                代码字号
              </label>
              <span className="font-mono text-[11px] text-[var(--nodes-ink)]">{codeFontSize}px</span>
            </div>
            <input
              id="appearance-code-font-size"
              type="range"
              min={11}
              max={22}
              step={1}
              value={codeFontSize}
              onChange={(e) => apply({ codeFontSize: Number(e.target.value) })}
              className={SLIDER_CLASS}
            />
          </div>
        </div>

        {/* ---------------- 字体 ---------------- */}
        <div>
          <label htmlFor="appearance-font-family" className={`${LABEL_CLASS} mb-1`}>
            字体
          </label>
          <select
            id="appearance-font-family"
            value={fontFamily}
            onChange={(e) => apply({ fontFamily: e.target.value })}
            className={SELECT_CLASS}
          >
            {FONT_OPTIONS.map((option) => (
              <option key={option.label} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </div>

        {/* ---------------- 强调色 ---------------- */}
        <div>
          <div className="mb-1 flex items-center justify-between">
            <label htmlFor="appearance-accent" className={LABEL_CLASS}>
              强调色
            </label>
            <span className="font-mono text-[11px] text-[var(--nodes-ink-dim)]">{accent}</span>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <input
              id="appearance-accent"
              type="color"
              value={accent}
              onChange={(e) => apply({ accent: e.target.value })}
              className="h-7 w-10 cursor-pointer rounded border border-[#23282f] bg-[#0b0d10]"
            />
            <SwatchRow
              presets={ACCENT_PRESETS}
              selected={accent}
              onPick={(color) => apply({ accent: color })}
            />
          </div>
        </div>

        {/* ---------------- 文字颜色（三层次） ---------------- */}
        <div>
          <div className="mb-1 flex items-center gap-2">
            <span className={LABEL_CLASS}>文字颜色</span>
            <span className="text-[10px] text-[var(--nodes-ink-faint)]">
              分三层是为了保住信息权重；三层都用同一个色会让界面对比度塌掉
            </span>
          </div>
          <div className="grid gap-3 sm:grid-cols-3">
            {(
              [
                ["ink", "正文", "appearance-ink", INK_PRESETS],
                ["inkDim", "次要（说明、时间）", "appearance-ink-dim", INK_DIM_PRESETS],
                ["inkFaint", "弱化（元信息、占位）", "appearance-ink-faint", INK_FAINT_PRESETS],
              ] as const
            ).map(([field, label, id, presets]) => (
              <div key={field}>
                <div className="mb-1 flex items-center justify-between gap-2">
                  <label htmlFor={id} className="text-[10px] text-[var(--nodes-ink-dim)]">
                    {label}
                  </label>
                  <span className="font-mono text-[10px] text-[var(--nodes-ink-faint)]">
                    {draft[field]}
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  <input
                    id={id}
                    type="color"
                    value={draft[field]}
                    onChange={(e) => apply({ [field]: e.target.value })}
                    className="h-7 w-10 shrink-0 cursor-pointer rounded border border-[#23282f] bg-[#0b0d10]"
                  />
                  <SwatchRow
                    presets={presets}
                    selected={draft[field]}
                    onPick={(color) => apply({ [field]: color })}
                  />
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* ---------------- 画布 / 面板底色 ---------------- */}
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <div className="mb-1 flex items-center justify-between">
              <label htmlFor="appearance-canvas" className={LABEL_CLASS}>
                画布背景色
              </label>
              <span className="font-mono text-[11px] text-[var(--nodes-ink-dim)]">{canvas}</span>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <input
                id="appearance-canvas"
                type="color"
                value={canvas}
                onChange={(e) => apply({ canvas: e.target.value })}
                className="h-7 w-10 cursor-pointer rounded border border-[#23282f] bg-[#0b0d10]"
              />
              <SwatchRow
                presets={SURFACE_PRESETS}
                selected={canvas}
                onPick={(color) => apply({ canvas: color })}
              />
            </div>
          </div>

          <div>
            <div className="mb-1 flex items-center justify-between">
              <label htmlFor="appearance-panel" className={LABEL_CLASS}>
                面板背景色
              </label>
              <span className="font-mono text-[11px] text-[var(--nodes-ink-dim)]">{panel}</span>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <input
                id="appearance-panel"
                type="color"
                value={panel}
                onChange={(e) => apply({ panel: e.target.value })}
                className="h-7 w-10 cursor-pointer rounded border border-[#23282f] bg-[#0b0d10]"
              />
              <SwatchRow
                presets={SURFACE_PRESETS}
                selected={panel}
                onPick={(color) => apply({ panel: color })}
              />
            </div>
          </div>
        </div>

        {/* ---------------- 预览 ---------------- */}
        <div>
          <p className="mb-1 text-[11px] font-medium text-[var(--nodes-ink-dim)]">实时预览</p>
          <div
            className="overflow-hidden rounded-lg border border-[#23282f] p-3"
            style={{ backgroundColor: canvas }}
          >
            <div
              className="rounded-md p-3"
              style={{ backgroundColor: panel, fontFamily: fontFamily || undefined }}
            >
              <p
                className="font-semibold"
                style={{ fontSize: `${fontSize + 3}px`, color: accent, lineHeight }}
              >
                缓存命中率
              </p>
              <p
                className="mt-1"
                style={{ fontSize: `${fontSize}px`, color: "#e6e9ee", lineHeight }}
              >
                前缀不变的部分会被服务端缓存。改外观只影响这一屏的观感 ——
                人设与约定不动，缓存就不会重建。
              </p>
              <pre
                className="mt-2 overflow-x-auto rounded border border-[#23282f] bg-[#0b0d10] px-2 py-1.5 font-mono"
                style={{ fontSize: `${codeFontSize}px`, color: "#98a2b3", lineHeight: 1.6 }}
              >
                <code>{'const hitRate = cachedTokens / promptTokens;'}</code>
              </pre>
            </div>
          </div>
        </div>

        {/* ---------------- 恢复默认 ---------------- */}
        <div className="flex justify-end border-t border-[#23282f] pt-3">
          <button
            type="button"
            onClick={resetAll}
            className="flex items-center gap-1 rounded-md border border-[#23282f] px-3 py-1.5 text-[11px] text-[var(--nodes-ink-dim)] transition-colors hover:text-[var(--nodes-ink)]"
          >
            <RotateCcw size={11} />
            恢复默认
          </button>
        </div>
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ *
 * 预设色块
 * ------------------------------------------------------------------ */

function SwatchRow({
  presets,
  selected,
  onPick,
}: {
  presets: { color: string; name: string }[];
  selected: string;
  onPick: (color: string) => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {presets.map((preset) => {
        const active = preset.color.toLowerCase() === selected.toLowerCase();
        return (
          <button
            key={`${preset.name}-${preset.color}`}
            type="button"
            onClick={() => onPick(preset.color)}
            title={`${preset.name} ${preset.color}`}
            aria-label={`${preset.name} ${preset.color}`}
            aria-pressed={active}
            style={{ backgroundColor: preset.color }}
            className={`h-5 w-5 rounded-full border transition-transform hover:scale-110 ${
              active ? "border-[#e6e9ee]" : "border-[#23282f]"
            }`}
          />
        );
      })}
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * 状态提示条（页面内提示，不用 alert）
 * ------------------------------------------------------------------ */

function StatusNotice({ status, error }: { status: SaveStatus; error: string | null }) {
  if (status === "idle") {
    return <span className="text-[10px] text-[var(--nodes-ink-faint)]">改动会自动保存</span>;
  }
  if (status === "error") {
    return (
      <span className="flex items-center gap-1 rounded bg-[#f2555a]/10 px-2 py-1 text-[10px] text-[#f2555a]">
        <TriangleAlert size={10} />
        {error ?? "保存失败"}
      </span>
    );
  }
  if (status === "saving") {
    return (
      <span className="flex items-center gap-1 rounded bg-[#171b21] px-2 py-1 text-[10px] text-[var(--nodes-ink-dim)]">
        <Loader2 size={10} className="animate-spin" />
        保存中…
      </span>
    );
  }
  if (status === "pending") {
    return (
      <span className="rounded bg-[#171b21] px-2 py-1 text-[10px] text-[var(--nodes-ink-faint)]">
        待保存…
      </span>
    );
  }
  return (
    <span className="flex items-center gap-1 rounded bg-[#3ddc97]/10 px-2 py-1 text-[10px] text-[#3ddc97]">
      <Check size={10} />
      已保存
    </span>
  );
}
