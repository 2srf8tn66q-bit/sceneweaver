"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import SettingsModal from "@/components/SettingsModal";
import WebMark from "@/components/WebMark";
import SplashScreen from "@/components/SplashScreen";
import { getAllProjects, deleteProject, saveProject, type Project } from "@/lib/projects";

export default function HomePage() {
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [splashDismissed, setSplashDismissed] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const editRef = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    getAllProjects().then(setProjects);
  }, []);

  async function remove(id: string) {
    await deleteProject(id);
    setProjects((ps) => (ps ? ps.filter((p) => p.id !== id) : ps));
  }

  async function rename(id: string) {
    const el = editRef.current;
    if (!el) return;
    const title = (el.textContent ?? "").trim().slice(0, 40) || "未命名改编";
    const proj = projects?.find((p) => p.id === id);
    if (!proj || title === proj.title) { setEditingId(null); return; }
    const updated = { ...proj, title, updatedAt: new Date().toISOString() };
    await saveProject(updated);
    setProjects((ps) => (ps ? ps.map((p) => (p.id === id ? updated : p)) : ps));
    setEditingId(null);
  }

  useEffect(() => {
    if (!editingId) return;
    const el = editRef.current;
    if (!el) return;
    requestAnimationFrame(() => {
      el.focus();
      const range = document.createRange();
      range.selectNodeContents(el);
      range.collapse(false);
      window.getSelection()?.removeAllRanges();
      window.getSelection()?.addRange(range);
    });
  }, [editingId]);

  const showSplash = projects !== null && projects.length === 0 && !splashDismissed;

  if (projects === null) return null;

  if (showSplash) {
    return <SplashScreen onEnter={() => setSplashDismissed(true)} />;
  }

  return (
    <main className="mx-auto w-full max-w-4xl flex-1">
      <header className="flex items-center justify-between border-b border-neutral-200 px-6 py-5">
        <div className="flex items-center gap-2.5">
          <WebMark size={24} className="shrink-0 -mt-0.5" />
          <h1 className="font-serif text-2xl font-bold italic">SceneWeaver</h1>
          <span className="text-sm text-neutral-400">我的剧本</span>
        </div>
        <button
          data-testid="open-settings"
          onClick={() => setSettingsOpen(true)}
          className="rounded-md border border-neutral-300 px-3 py-1.5 text-sm hover:bg-neutral-100"
        >
          设置
        </button>
      </header>

      {projects.length === 0 ? (
        <section className="flex flex-col items-center justify-center px-6 py-32 text-center">
          <p className="text-lg font-medium">还没有改编项目</p>
          <p className="mt-2 max-w-md text-sm text-neutral-500">
            导入一篇 3 章以上的小说，SceneWeaver 会把它改编成结构化、可溯源、可打磨的剧本。
          </p>
        </section>
      ) : (
        <div className="grid grid-cols-2 gap-4 px-6 py-8">
          <Link
            href="/import"
            className="flex min-h-[130px] flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-neutral-300 text-neutral-400 transition hover:border-neutral-400 hover:text-neutral-600"
          >
            <span className="text-2xl font-light">+</span>
            <span className="text-sm">新建改编</span>
          </Link>
          {projects.map((p) => {
            const chars = p.novel.replace(/\s/g, "").length;
            return (
            <Link
              key={p.id}
              href={`/project/${p.id}`}
              className="group relative flex min-h-[130px] flex-col rounded-xl border border-neutral-200 bg-white p-4 transition hover:border-neutral-300 hover:shadow-sm"
            >
              {editingId === p.id ? (
                <h2
                  ref={editRef}
                  contentEditable
                  suppressContentEditableWarning
                  onClick={(e) => e.stopPropagation()}
                  onBlur={() => rename(p.id)}
                  onKeyDown={(e) => {
                    if (e.key === "Escape") { editRef.current!.textContent = p.title; setEditingId(null); }
                    if (e.key === "Enter") { e.preventDefault(); (e.target as HTMLElement).blur(); }
                  }}
                  className="truncate pr-6 font-medium text-neutral-900 outline-none"
                >
                  {p.title}
                </h2>
              ) : (
                <h2 className="truncate pr-6 font-medium text-neutral-900">{p.title}</h2>
              )}
              <p className="mt-1 text-xs text-neutral-400">
                {p.screenplay ? `${p.screenplay.scenes.length} 场` : "未生成"}
                {" · "}
                {(chars / 1000).toFixed(1)}k 字
                {" · "}
                {new Date(p.updatedAt).toLocaleDateString()}
              </p>
              <div className="absolute top-2 right-2 flex gap-1 opacity-0 transition group-hover:opacity-100">
                <button
                  onClick={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    setEditingId(p.id);
                  }}
                  className="rounded p-1 text-neutral-300 hover:bg-neutral-100 hover:text-neutral-600"
                  aria-label="重命名"
                >
                  ✎
                </button>
                <button
                  onClick={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    if (confirm(`删除「${p.title}」？此操作不可撤销。`)) remove(p.id);
                  }}
                  className="rounded p-1 text-neutral-300 hover:bg-neutral-100 hover:text-rose-600"
                  aria-label="删除项目"
                >
                  ✕
                </button>
              </div>
            </Link>
            );
          })}
        </div>
      )}

      {settingsOpen && <SettingsModal onClose={() => setSettingsOpen(false)} />}
    </main>
  );
}
