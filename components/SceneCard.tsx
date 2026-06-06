"use client";

// 场卡：渲染一场戏，带置信度三档标记（左竖条 + 置信环）与内心戏外化 ✦。
// 选中后（active）可就地编辑梗概 / 动作 / 对白台词：点字段进入编辑，改完回调父组件存盘。

import { useState } from "react";
import type { Scene, Character } from "@/lib/screenplay/types";
import { confidenceTier } from "@/lib/screenplay/confidence";

const EXT = "#7B79A8"; // 内心戏外化标记色
const TIER = {
  reliable: { color: "", label: "" },
  review: { color: "#C0974A", label: "需复核" },
  doubtful: { color: "#B4654A", label: "存疑" },
} as const;

const SETTING_CN: Record<string, string> = { INT: "内", EXT: "外", "INT/EXT": "内/外" };
const TIME_CN: Record<string, string> = {
  DAY: "日",
  NIGHT: "夜",
  DUSK: "黄昏",
  DAWN: "黎明",
  CONTINUOUS: "接",
  LATER: "稍后",
};

export default function SceneCard({
  scene,
  characters,
  onSelect,
  onSceneChange,
  active,
}: {
  scene: Scene;
  characters: Character[];
  onSelect?: () => void;
  onSceneChange?: (scene: Scene) => void;
  active?: boolean;
}) {
  const nameOf = (id: string) => characters.find((c) => c.id === id)?.name ?? id;
  const conf = scene.review?.confidence ?? 1;
  const tier = confidenceTier(conf);
  const t = TIER[tier];
  const h = scene.heading ?? { setting: "INT" as const, location: "", time: "DAY" as const };
  const slug = `${TIME_CN[h.time] ?? h.time ?? ""}　${SETTING_CN[h.setting] ?? h.setting ?? ""}　${h.location ?? ""}`;
  const pct = Math.round(conf * 100);

  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [draft, setDraft] = useState("");

  // 编辑后回写：替换字段并标记为 edited。
  function commit(next: Partial<Scene>) {
    onSceneChange?.({
      ...scene,
      ...next,
      review: { status: "edited", confidence: scene.review?.confidence ?? 1 },
    });
  }

  function patchEl(i: number, patch: Record<string, unknown>) {
    return scene.elements.map((el, idx) => (idx === i ? { ...el, ...patch } : el));
  }

  // 内联可编辑文本：未选中 → 点击冒泡去选中场（跳原文）；已选中 → 点击进入编辑。
  function editable(
    key: string,
    value: string,
    save: (v: string) => void,
    placeholder?: string,
  ) {
    if (editingKey === key) {
      return (
        <textarea
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onClick={(e) => e.stopPropagation()}
          onBlur={() => {
            if (draft !== value) save(draft);
            setEditingKey(null);
          }}
          onKeyDown={(e) => {
            if (e.key === "Escape") setEditingKey(null);
            else if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              if (draft !== value) save(draft);
              setEditingKey(null);
            }
          }}
          rows={Math.min(6, Math.max(1, draft.split("\n").length))}
          className="my-0.5 w-full resize-none rounded border border-neutral-300 bg-white px-1.5 py-1 leading-relaxed outline-none focus:border-neutral-400"
          style={{ font: "inherit", color: "inherit" }}
        />
      );
    }
    return (
      <span
        onClick={(e) => {
          if (!active) return; // 未选中：让点击冒泡到卡片 → 选中 + 跳原文
          e.stopPropagation();
          setEditingKey(key);
          setDraft(value);
        }}
        className={active ? "cursor-text rounded-sm hover:bg-amber-50" : undefined}
        title={active ? "点击编辑" : undefined}
      >
        {value || (active && placeholder ? <span className="text-neutral-300">{placeholder}</span> : value)}
      </span>
    );
  }

  return (
    <div
      onClick={onSelect}
      className={`rounded-xl border bg-white p-4 shadow-sm ${
        onSelect ? "cursor-pointer transition hover:shadow-md" : ""
      } ${active ? "border-neutral-400 ring-2 ring-neutral-300" : "border-neutral-200"}`}
      style={t.color ? { borderLeft: `3px solid ${t.color}` } : undefined}
    >
      <div className="mb-2 flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-baseline gap-2">
          <span className="text-[15px] font-bold italic text-neutral-300">{scene.number}</span>
          <span className="truncate font-serif text-[15px] font-bold italic tracking-wide text-neutral-800">
            {slug}
          </span>
        </div>
        {tier !== "reliable" && (
          <div className="flex flex-none items-center gap-2">
            {tier === "doubtful" && (
              <button
                onClick={(e) => e.stopPropagation()}
                className="rounded-md border px-2 py-0.5 text-[11px]"
                style={{ color: t.color, borderColor: "#E6C7BB" }}
              >
                重新生成
              </button>
            )}
            <span
              className="flex h-[34px] w-[34px] items-center justify-center rounded-full text-[10.5px] font-semibold tabular-nums"
              style={{ color: t.color, background: `conic-gradient(${t.color} ${pct}%, #EDEAE4 0)` }}
            >
              <span className="flex h-[27px] w-[27px] items-center justify-center rounded-full bg-white">
                {pct}
              </span>
            </span>
          </div>
        )}
      </div>

      {(scene.synopsis || active) && (
        <p className="mb-2 text-xs text-neutral-500">
          {editable("synopsis", scene.synopsis ?? "", (v) => commit({ synopsis: v }), "＋ 梗概")}
        </p>
      )}

      <div className="space-y-1.5 text-[13.5px]">
        {(scene.elements ?? []).map((el, i) => {
          if (el.type === "action") {
            return (
              <p key={i} className="text-neutral-600">
                {el.from_internal ? (
                  <span className="mr-1.5" style={{ color: EXT }} title={el.note ?? "由原文内心戏外化"}>
                    ✦
                  </span>
                ) : (
                  <span className="mr-1 text-neutral-400">△</span>
                )}
                {editable(`el-${i}`, el.text, (v) => commit({ elements: patchEl(i, { text: v }) }))}
              </p>
            );
          }
          if (el.type === "dialogue") {
            const mode = el.mode === "voiceover" ? "（画外）" : el.mode === "off_screen" ? "（画外音）" : "";
            const paren = el.parenthetical ? `（${el.parenthetical}）` : "";
            return (
              <p key={i}>
                <span className="font-semibold">{nameOf(el.character)}</span>
                <span className="text-neutral-400">
                  {mode}
                  {paren}
                </span>
                ：{editable(`el-${i}`, el.line, (v) => commit({ elements: patchEl(i, { line: v }) }))}
              </p>
            );
          }
          if (el.type === "dual_dialogue") {
            return (
              <div key={i}>
                {el.lines.map((ln, k) => (
                  <p key={k}>
                    <span className="font-semibold">{nameOf(ln.character)}</span>
                    <span className="text-neutral-400">（同时）</span>：{ln.line}
                  </p>
                ))}
              </div>
            );
          }
          return (
            <p key={i} className="text-right text-neutral-400">
              {el.text}
            </p>
          );
        })}
      </div>

      {(scene.source?.paragraph_range || scene.dramatic_function) && (
        <div className="mt-3 flex flex-wrap gap-x-3 gap-y-1 border-t border-neutral-100 pt-2 text-[11px] text-neutral-400">
          {scene.source?.paragraph_range && (
            <span>
              源自原文第{scene.source.paragraph_range[0]}—{scene.source.paragraph_range[1]}段
            </span>
          )}
          {scene.dramatic_function && <span>推进：{scene.dramatic_function}</span>}
        </div>
      )}
    </div>
  );
}
