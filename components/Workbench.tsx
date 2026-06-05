"use client";

import { useState, useSyncExternalStore } from "react";
import Link from "next/link";
import SettingsModal from "@/components/SettingsModal";
import SceneCard from "@/components/SceneCard";
import { loadLLMConfig } from "@/lib/config";
import { sendChatMessage } from "@/lib/llm/llmService";
import { generateScreenplay } from "@/lib/screenplay/pipeline";
import { splitParagraphs } from "@/lib/screenplay/paragraphs";
import type { Screenplay } from "@/lib/screenplay/types";

const emptySubscribe = () => () => {};

/** 读取导入页存入 sessionStorage 的小说草稿（SSR 安全，无水合不匹配）。 */
function useDraftNovel(): string {
  return useSyncExternalStore(
    emptySubscribe,
    () => sessionStorage.getItem("sceneweaver.draftNovel") ?? "",
    () => "",
  );
}

export default function Workbench({ id }: { id: string }) {
  const novel = useDraftNovel();
  const [screenplay, setScreenplay] = useState<Screenplay | null>(null);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);

  const paras = novel ? splitParagraphs(novel) : [];

  async function generate() {
    const config = loadLLMConfig();
    if (!config.apiKey) {
      setError("请先在「设置」里填入 API Key");
      setSettingsOpen(true);
      return;
    }
    if (!novel.trim()) return;
    setGenerating(true);
    setError(null);
    try {
      const result = await generateScreenplay(
        novel,
        (messages) => sendChatMessage(config, messages),
        { title: "未命名剧本" },
      );
      if (result.screenplay) {
        setScreenplay(result.screenplay);
      } else {
        setError(
          "生成结果未通过校验：" +
            result.validation.errors.slice(0, 3).map((e) => e.message).join("；"),
        );
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "生成失败");
    } finally {
      setGenerating(false);
    }
  }

  return (
    <div className="flex h-screen flex-col">
      <header className="flex items-center justify-between border-b border-neutral-200 px-4 py-2 text-sm">
        <div className="flex items-center gap-3">
          <Link href="/" className="text-neutral-500 hover:text-neutral-900">
            ← 我的剧本
          </Link>
          <span className="font-medium">工作台</span>
          <span className="text-neutral-400">项目 {id}</span>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setSettingsOpen(true)}
            className="rounded border border-neutral-300 px-2 py-1 hover:bg-neutral-100"
          >
            ⚙ 设置
          </button>
          <button
            onClick={generate}
            disabled={generating || !novel.trim()}
            className="rounded bg-neutral-900 px-2.5 py-1 text-white hover:bg-neutral-700 disabled:opacity-40"
          >
            {generating ? "生成中…" : "一键生成"}
          </button>
          <button className="rounded border border-neutral-300 px-2.5 py-1 disabled:opacity-40" disabled>
            导出
          </button>
        </div>
      </header>

      {error && (
        <div className="border-b border-rose-200 bg-rose-50 px-4 py-2 text-xs text-rose-700">{error}</div>
      )}

      <div className="flex flex-1 overflow-hidden">
        <aside className="w-48 shrink-0 overflow-auto border-r border-neutral-200 p-3 text-sm">
          <p className="mb-2 font-medium text-neutral-500">场次</p>
          {screenplay ? (
            <ul className="space-y-1">
              {screenplay.scenes.map((s) => (
                <li key={s.id} className="truncate text-neutral-600">
                  第{s.number}场 · {s.heading.location}
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-neutral-400">生成后在此列出</p>
          )}
        </aside>

        <section className="flex-1 overflow-auto border-r border-neutral-200 p-4">
          <p className="mb-2 text-xs font-medium tracking-wide text-neutral-400 uppercase">原文</p>
          {paras.length ? (
            <div className="space-y-2 text-sm leading-relaxed text-neutral-700">
              {paras.map((p) => (
                <p key={p.n}>
                  <span className="mr-2 align-top text-xs text-neutral-300">{p.n}</span>
                  {p.text}
                </p>
              ))}
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
                <SceneCard key={s.id} scene={s} characters={screenplay.characters} />
              ))}
            </div>
          ) : (
            <p className="text-neutral-400">{generating ? "正在改编，请稍候…" : "点「一键生成」开始改编"}</p>
          )}
        </section>
      </div>

      {settingsOpen && <SettingsModal onClose={() => setSettingsOpen(false)} />}
    </div>
  );
}
