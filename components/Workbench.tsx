"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import SettingsModal from "@/components/SettingsModal";
import SceneCard from "@/components/SceneCard";
import WebMark from "@/components/WebMark";
import GeneratingOverlay from "@/components/GeneratingOverlay";
import { loadLLMConfig } from "@/lib/config";
import { splitParagraphs } from "@/lib/screenplay/paragraphs";
import { toYaml } from "@/lib/screenplay/yaml";
import { renderCn } from "@/lib/screenplay/render";
import { confidenceTier } from "@/lib/screenplay/confidence";
import type { GenerateResult } from "@/lib/screenplay/pipeline";
import type { Screenplay, Scene } from "@/lib/screenplay/types";
import { getProject, saveProject, type Project } from "@/lib/projects";

/** 在浏览器触发一次文本文件下载。 */
function downloadText(filename: string, content: string) {
  const blob = new Blob([content], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export default function Workbench({ id }: { id: string }) {
  const [project, setProject] = useState<Project | null>(null);
  const [screenplay, setScreenplay] = useState<Screenplay | null>(null);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [activeSceneId, setActiveSceneId] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    getProject(id).then((p) => {
      if (!alive) return;
      setProject(p ?? null);
      if (p?.screenplay) setScreenplay(p.screenplay);
    });
    return () => {
      alive = false;
    };
  }, [id]);

  const novel = project?.novel ?? "";
  const paras = novel ? splitParagraphs(novel) : [];
  const activeRange =
    screenplay?.scenes.find((s) => s.id === activeSceneId)?.source?.paragraph_range ?? null;

  function startGenerate() {
    const config = loadLLMConfig();
    if (!config.apiKey) {
      setError("请先在「设置」里填入 API Key");
      setSettingsOpen(true);
      return;
    }
    if (!novel.trim()) return;
    setError(null);
    setNotice(null);
    setGenerating(true);
  }

  async function onGenerateDone(result: GenerateResult) {
    setGenerating(false);
    if (result.screenplay && result.screenplay.scenes.length > 0) {
      setScreenplay(result.screenplay);
      if (project) {
        const updated: Project = {
          ...project,
          screenplay: result.screenplay,
          title: result.screenplay.meta.title || project.title,
          updatedAt: new Date().toISOString(),
        };
        setProject(updated);
        await saveProject(updated);
      }
      if (!result.validation.valid) {
        setNotice(
          `生成完成，但有 ${result.validation.errors.length} 处待确认（已渲染，可手动调整）：` +
            result.validation.errors.slice(0, 3).map((e) => e.message).join("；"),
        );
      }
    } else {
      setError("没能生成出有效场景，请重试或换一段文本。");
    }
  }

  function exportAs(format: "cn" | "yaml") {
    if (!screenplay) return;
    const base = (screenplay.meta.title || "剧本").replace(/[\\/:*?"<>|]/g, "_");
    if (format === "yaml") downloadText(`${base}.yaml`, toYaml(screenplay));
    else downloadText(`${base}.txt`, renderCn(screenplay));
    setExportOpen(false);
  }

  function selectScene(scene: Scene) {
    setActiveSceneId(scene.id);
    const start = scene.source?.paragraph_range?.[0];
    if (start != null) {
      document.getElementById(`para-${start}`)?.scrollIntoView({ behavior: "smooth", block: "center" });
    }
    document.getElementById(`scene-${scene.id}`)?.scrollIntoView({ behavior: "smooth", block: "center" });
  }

  // 场卡就地编辑回写：替换该场并持久化到 IDB。
  function handleSceneChange(updated: Scene) {
    if (!screenplay) return;
    const next: Screenplay = {
      ...screenplay,
      scenes: screenplay.scenes.map((s) => (s.id === updated.id ? updated : s)),
    };
    setScreenplay(next);
    if (project) {
      const p: Project = { ...project, screenplay: next, updatedAt: new Date().toISOString() };
      setProject(p);
      void saveProject(p);
    }
  }

  return (
    <div className="flex h-screen flex-col">
      <header className="flex items-center justify-between border-b border-neutral-200 px-4 py-2 text-sm">
        <div className="flex items-center gap-3">
          <Link href="/" className="flex items-center gap-1 text-neutral-500 hover:text-neutral-900 shrink-0">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"><path d="M19 12H5M11 18l-6-6 6-6"/></svg>
            我的剧本
          </Link>
          <span className="w-px h-4 bg-neutral-200 shrink-0" />
          <WebMark size={19} className="shrink-0" />
          <span className="truncate font-serif text-[15px] font-bold italic text-neutral-800">{screenplay?.meta.title || project?.title || "…"}</span>
          {screenplay?.meta.genre?.length ? (
            <span className="shrink-0 text-xs text-neutral-400">{screenplay.meta.genre.join(" · ")}</span>
          ) : null}
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setSettingsOpen(true)}
            className="rounded border border-neutral-300 px-2 py-1 hover:bg-neutral-100"
          >
            ⚙ 设置
          </button>
          <button
            onClick={startGenerate}
            disabled={generating || !novel.trim()}
            className="rounded bg-neutral-900 px-2.5 py-1 text-white hover:bg-neutral-700 disabled:opacity-40"
          >
            {generating ? "生成中…" : "一键生成"}
          </button>
          <div className="relative">
            <button
              onClick={() => setExportOpen((v) => !v)}
              disabled={!screenplay}
              className="rounded border border-neutral-300 px-2.5 py-1 hover:bg-neutral-100 disabled:opacity-40"
            >
              导出
            </button>
            {exportOpen && screenplay && (
              <>
                <div className="fixed inset-0 z-10" onClick={() => setExportOpen(false)} />
                <div className="absolute right-0 z-20 mt-1 w-44 rounded border border-neutral-200 bg-white py-1 shadow-lg">
                  <button
                    onClick={() => exportAs("cn")}
                    className="block w-full px-3 py-1.5 text-left hover:bg-neutral-100"
                  >
                    国内排版（.txt）
                  </button>
                  <button
                    onClick={() => exportAs("yaml")}
                    className="block w-full px-3 py-1.5 text-left hover:bg-neutral-100"
                  >
                    YAML（.yaml）
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      </header>

      {error && (
        <div className="border-b border-rose-200 bg-rose-50 px-4 py-2 text-xs text-rose-700">{error}</div>
      )}
      {notice && (
        <div className="border-b border-amber-200 bg-amber-50 px-4 py-2 text-xs text-amber-800">{notice}</div>
      )}

      <div className="flex flex-1 overflow-hidden">
        <aside className="w-48 shrink-0 overflow-auto border-r border-neutral-200 p-3 text-sm">
          <div className="mb-2 flex items-center justify-between">
            <span className="font-medium text-neutral-500">场次</span>
            {screenplay ? <span className="text-xs text-neutral-400">{screenplay.scenes.length}</span> : null}
          </div>
          {screenplay ? (
            <ul className="space-y-0.5">
              {screenplay.scenes.map((s) => {
                const tier = confidenceTier(s.review?.confidence ?? 1);
                const dot =
                  tier === "reliable" ? null : tier === "review"
                    ? "#C0974A" : "#B4654A";
                return (
                <li
                  key={s.id}
                  onClick={() => selectScene(s)}
                  className={`flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 transition hover:text-neutral-900 ${
                    s.id === activeSceneId ? "bg-neutral-100 font-medium text-neutral-900" : "text-neutral-600"
                  }`}
                >
                  <span className={`text-xs ${s.id === activeSceneId ? "text-[#C0974A]" : "text-neutral-400"}`}>
                    {String(s.number).padStart(2, "0")}
                  </span>
                  <span className="truncate">{s.heading.location}</span>
                  {dot && <span className="ml-auto h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: dot }} />}
                </li>
                );
              })}
            </ul>
          ) : (
            <p className="text-neutral-400">生成后在此列出</p>
          )}
        </aside>

        <section className="flex-1 overflow-auto border-r border-neutral-200 p-4">
          <p className="mb-2 text-xs font-medium tracking-wide text-neutral-400 uppercase">原文</p>
          {paras.length ? (
            <div className="space-y-2 text-sm leading-relaxed text-neutral-700">
              {paras.map((p) => {
                const on = activeRange != null && p.n >= activeRange[0] && p.n <= activeRange[1];
                return (
                  <p
                    key={p.n}
                    id={`para-${p.n}`}
                    className={on ? "-mx-1 rounded bg-amber-100 px-1" : undefined}
                  >
                    <span className="mr-2 align-top text-xs text-neutral-300">{p.n}</span>
                    {p.text}
                  </p>
                );
              })}
            </div>
          ) : (
            <p className="text-neutral-400">
              未导入小说。
              <Link href="/import" className="underline">
                去新建改编
              </Link>
            </p>
          )}
        </section>

        <section className="flex-1 overflow-auto p-4">
          <p className="mb-3 text-xs font-medium tracking-wide text-neutral-400 uppercase">剧本</p>
          {screenplay ? (
            <div className="space-y-3">
              {screenplay.scenes.map((s) => (
                <div key={s.id} id={`scene-${s.id}`}>
                  <SceneCard
                    scene={s}
                    characters={screenplay.characters}
                    onSelect={() => selectScene(s)}
                    onSceneChange={handleSceneChange}
                    active={s.id === activeSceneId}
                  />
                </div>
              ))}
            </div>
          ) : (
            <p className="text-neutral-400">{generating ? "正在改编，请稍候…" : "点「一键生成」开始改编"}</p>
          )}
        </section>
      </div>

      {settingsOpen && <SettingsModal onClose={() => setSettingsOpen(false)} />}

      {generating && (
        <GeneratingOverlay
          novel={novel}
          config={loadLLMConfig()}
          title={project?.title ?? "未命名剧本"}
          onDone={onGenerateDone}
          onCancel={() => setGenerating(false)}
        />
      )}
    </div>
  );
}
