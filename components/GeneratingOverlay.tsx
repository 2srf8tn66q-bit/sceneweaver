"use client";

// 全屏暗底生成加载页。接收 SSE 进度流，展示百分比/进度条/阶段/日志。

import { useEffect, useRef, useState } from "react";
import type { Progress } from "@/lib/screenplay/pipeline";
import type { GenerateResult } from "@/lib/screenplay/pipeline";

interface Props {
  novel: string;
  config: { provider: string; baseUrl: string; model: string; apiKey: string };
  title: string;
  onDone: (result: GenerateResult) => void;
  onCancel: () => void;
}

const STAGES = [
  { key: "理解", label: "理解全文", sub: "识别人物、切分场景" },
  { key: "改编", label: "改编剧本", sub: "逐批生成对白与动作" },
  { key: "质检", label: "质量检查", sub: "校验格式、修复问题" },
];

export default function GeneratingOverlay({ novel, config, title, onDone, onCancel }: Props) {
  const [pct, setPct] = useState(0);
  const [stage, setStage] = useState("理解");
  const [msg, setMsg] = useState("准备中…");
  const [finished, setFinished] = useState(false);
  const [stats, setStats] = useState<{ scenes: number; chars: number; repaired: boolean; errors: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    const ctrl = new AbortController();
    abortRef.current = ctrl;

    async function run() {
      try {
        const res = await fetch("/api/generate", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ novel, config, title }),
          signal: ctrl.signal,
        });
        if (!res.ok) throw new Error(`生成失败 (${res.status})`);
        const reader = res.body?.getReader();
        if (!reader) throw new Error("无法读取响应流");
        const decoder = new TextDecoder();
        let buffer = "";
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";
          for (const line of lines) {
            if (!line.startsWith("data: ")) continue;
            try {
              const data = JSON.parse(line.slice(6));
              if (data.progress) {
                const p: Progress = data.progress;
                setPct(p.pct);
                setStage(p.stage);
                setMsg(p.msg);
              } else if (data.done) {
                setFinished(true);
                setPct(100);
                setStats({
                  scenes: data.scenes ?? 0,
                  chars: (data.screenplay?.characters?.length) ?? 0,
                  repaired: data.repaired ?? false,
                  errors: data.validation?.errors?.length ?? 0,
                });
                // 等用户点「进入工作台」
                (window as unknown as Record<string, unknown>).__genResult = data;
              } else if (data.error) {
                setError(data.error);
              }
            } catch { /* skip malformed */ }
          }
        }
      } catch (e) {
        if ((e as Error).name !== "AbortError") {
          setError(e instanceof Error ? e.message : "生成失败");
        }
      }
    }
    run();
    return () => ctrl.abort();
  }, [novel, config, title]);

  function enter() {
    const result = (window as unknown as Record<string, unknown>).__genResult as GenerateResult | undefined;
    if (result) {
      delete (window as unknown as Record<string, unknown>).__genResult;
      onDone(result);
    }
  }

  const currentStageIdx = STAGES.findIndex((s) => s.key === stage);

  return (
    <div className="fixed inset-0 z-50 flex flex-col" style={{ background: "#111110", color: "#fff" }}>
      {/* 顶栏 */}
      <header className="flex items-center justify-between border-b px-6 py-4" style={{ borderColor: "rgba(255,255,255,.08)" }}>
        <span className="text-sm text-white/55">正在改编《{title}》</span>
        {!finished && (
          <button onClick={() => { abortRef.current?.abort(); onCancel(); }} className="text-xs text-white/30 hover:text-white/55">
            取消
          </button>
        )}
      </header>

      {/* 中间 */}
      <div className="flex flex-1 flex-col items-center justify-center px-6">
        {error ? (
          <div className="text-center">
            <p className="text-lg text-red-400">{error}</p>
            <button onClick={onCancel} className="mt-6 text-sm text-white/55 hover:text-white">返回</button>
          </div>
        ) : (
          <>
            {/* 百分比 */}
            <div className="font-serif text-7xl font-bold leading-none">
              {pct}<span className="text-xl font-normal text-[#C0974A]">%</span>
            </div>
            {/* 进度条 */}
            <div className="mt-4 h-0.5 w-72 overflow-hidden rounded-full bg-white/10">
              <div className="h-full rounded-full bg-[#C0974A] transition-all duration-500" style={{ width: `${pct}%` }} />
            </div>

            {/* 阶段列表 */}
            <div className="mt-10 flex flex-col gap-1 w-72">
              {STAGES.map((s, i) => {
                const done = i < currentStageIdx;
                const active = i === currentStageIdx;
                return (
                  <div key={s.key} className={`flex items-center gap-4 rounded-lg px-4 py-3 transition ${active ? "bg-white/5" : ""} ${done ? "opacity-50" : ""}`}>
                    <span
                      className={`flex h-6 w-6 items-center justify-center rounded-full text-xs font-medium ${
                        done ? "text-[#C0974A]" : active ? "bg-[#C0974A] text-[#111]" : "border border-white/15 text-white/30"
                      }`}
                    >
                      {done ? "✓" : i + 1}
                    </span>
                    <div>
                      <div className="text-sm font-semibold">{s.label}</div>
                      <div className="text-xs text-white/30">{s.sub}</div>
                    </div>
                  </div>
                );
              })}
            </div>

            {/* 当前消息 */}
            {!finished && <p className="mt-8 text-sm text-white/40">{msg}</p>}

            {/* 完成 */}
            {finished && stats && (
              <div className="mt-10 flex flex-col items-center gap-4">
                <p className="text-sm text-white/55">
                  <b className="text-white">{stats.scenes}</b> 场 · <b className="text-white">{stats.chars}</b> 人物
                  {stats.errors > 0 && (
                    <span className="ml-2 text-[#C0974A]">{stats.errors} 处待确认</span>
                  )}
                </p>
                <button
                  onClick={enter}
                  className="inline-flex items-center gap-2 rounded-lg bg-[#C0974A] px-6 py-3 text-sm font-semibold text-[#111] transition hover:brightness-110"
                >
                  进入工作台 →
                </button>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
