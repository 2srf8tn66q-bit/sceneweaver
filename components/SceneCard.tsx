// 场卡：渲染一场戏，带置信度三档标记（左竖条 + 置信环）与内心戏外化 ✦。
// 纯展示组件（无客户端状态），可在服务端渲染。

import type { Scene, Character } from "@/lib/screenplay/types";
import { confidenceTier } from "@/lib/screenplay/confidence";

const EXT = "#7B79A8"; // 内心戏外化标记色
const TIER = {
  reliable: { color: "", label: "" },
  review: { color: "#C0974A", label: "需复核" },
  doubtful: { color: "#B4654A", label: "存疑" },
} as const;

const SETTING_CN: Record<string, string> = { INT: "内", EXT: "外" };
const TIME_CN: Record<string, string> = {
  DAY: "日",
  NIGHT: "夜",
  DUSK: "黄昏",
  DAWN: "黎明",
  CONTINUOUS: "接",
  LATER: "稍后",
};

export default function SceneCard({ scene, characters }: { scene: Scene; characters: Character[] }) {
  const nameOf = (id: string) => characters.find((c) => c.id === id)?.name ?? id;
  const conf = scene.review?.confidence ?? 1;
  const tier = confidenceTier(conf);
  const t = TIER[tier];
  const h = scene.heading;
  const slug = `${TIME_CN[h.time] ?? h.time}　${SETTING_CN[h.setting] ?? h.setting}　${h.location}`;
  const pct = Math.round(conf * 100);

  return (
    <div
      className="rounded-xl border border-neutral-200 bg-white p-4 shadow-sm"
      style={t.color ? { borderLeft: `3px solid ${t.color}` } : undefined}
    >
      <div className="mb-2 flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2 text-sm">
          <span className="text-neutral-400">{scene.number}</span>
          <span className="truncate tracking-wide text-neutral-500">{slug}</span>
        </div>
        {tier !== "reliable" && (
          <div className="flex flex-none items-center gap-2">
            {tier === "doubtful" && (
              <button
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

      {scene.synopsis && <p className="mb-2 text-xs text-neutral-500">{scene.synopsis}</p>}

      <div className="space-y-1.5 text-[13.5px]">
        {scene.elements.map((el, i) => {
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
                {el.text}
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
                ：{el.line}
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
            <span>源自原文 ¶{scene.source.paragraph_range[0]}–{scene.source.paragraph_range[1]}</span>
          )}
          {scene.dramatic_function && <span>推进：{scene.dramatic_function}</span>}
        </div>
      )}
    </div>
  );
}
