"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import SettingsModal from "@/components/SettingsModal";
import SplashScreen from "@/components/SplashScreen";
import { getAllProjects, deleteProject, type Project } from "@/lib/projects";

const SPLASH_KEY = "sceneweaver.splashSeen";

export default function HomePage() {
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [showSplash, setShowSplash] = useState<boolean | null>(null);

  useEffect(() => {
    // 一次性从 localStorage 读启动页是否展示过
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setShowSplash(!localStorage.getItem(SPLASH_KEY));
    getAllProjects().then(setProjects);
  }, []);

  function dismissSplash() {
    setShowSplash(false);
    localStorage.setItem(SPLASH_KEY, "1");
  }

  async function remove(id: string) {
    await deleteProject(id);
    setProjects((ps) => (ps ? ps.filter((p) => p.id !== id) : ps));
  }

  if (showSplash === null) return null;

  if (showSplash) {
    return <SplashScreen onEnter={dismissSplash} />;
  }

  return (
    <main className="mx-auto w-full max-w-5xl flex-1 px-6 py-10">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">SceneWeaver</h1>
          <p className="text-sm text-neutral-500">小说转剧本助手 · 我的剧本</p>
        </div>
        <div className="flex gap-2">
          <button
            data-testid="open-settings"
            onClick={() => setSettingsOpen(true)}
            className="rounded-md border border-neutral-300 px-3 py-1.5 text-sm hover:bg-neutral-100"
          >
            设置
          </button>
          <Link
            href="/import"
            className="rounded-md bg-neutral-900 px-3 py-1.5 text-sm text-white hover:bg-neutral-700"
          >
            + 新建改编
          </Link>
        </div>
      </header>

      {projects === null ? (
        <p className="mt-16 text-center text-sm text-neutral-400">加载中…</p>
      ) : projects.length === 0 ? (
        <section className="mt-16 flex flex-col items-center justify-center rounded-xl border border-dashed border-neutral-300 py-20 text-center">
          <p className="text-lg font-medium">还没有改编项目</p>
          <p className="mt-2 max-w-md text-sm text-neutral-500">
            导入一篇 3 章以上的小说，SceneWeaver 会把它改编成结构化、可溯源、可打磨的剧本。
          </p>
        </section>
      ) : (
        <div className="mt-8 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {projects.map((p) => (
            <Link
              key={p.id}
              href={`/project/${p.id}`}
              className="group relative rounded-xl border border-neutral-200 bg-white p-4 transition hover:border-neutral-300 hover:shadow-sm"
            >
              <h2 className="truncate pr-6 font-medium text-neutral-900">{p.title}</h2>
              <p className="mt-1 text-xs text-neutral-400">
                {p.screenplay ? `已生成 ${p.screenplay.scenes.length} 场` : "未生成"}
                {" · "}
                {new Date(p.updatedAt).toLocaleDateString()}
              </p>
              <button
                onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  if (confirm(`删除「${p.title}」？此操作不可撤销。`)) remove(p.id);
                }}
                className="absolute top-2 right-2 rounded p-1 text-neutral-300 opacity-0 transition group-hover:opacity-100 hover:bg-neutral-100 hover:text-rose-600"
                aria-label="删除项目"
              >
                ✕
              </button>
            </Link>
          ))}
        </div>
      )}

      {settingsOpen && <SettingsModal onClose={() => setSettingsOpen(false)} />}
    </main>
  );
}
