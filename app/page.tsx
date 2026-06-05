"use client";

import { useState } from "react";
import SettingsModal from "@/components/SettingsModal";

export default function HomePage() {
  const [settingsOpen, setSettingsOpen] = useState(false);

  return (
    <main className="mx-auto w-full max-w-5xl flex-1 px-6 py-10">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">SceneWeaver</h1>
          <p className="text-sm text-neutral-500">小说转剧本助手 · 我的剧本</p>
        </div>
        <div className="flex gap-2">
          <button
            onClick={() => setSettingsOpen(true)}
            className="rounded-md border border-neutral-300 px-3 py-1.5 text-sm hover:bg-neutral-100"
          >
            设置
          </button>
          <button className="rounded-md bg-neutral-900 px-3 py-1.5 text-sm text-white hover:bg-neutral-700">
            + 新建改编
          </button>
        </div>
      </header>

      {/* 空状态：项目库列表与 IndexedDB 持久化在 PR#2 接入 */}
      <section className="mt-16 flex flex-col items-center justify-center rounded-xl border border-dashed border-neutral-300 py-20 text-center">
        <p className="text-lg font-medium">还没有改编项目</p>
        <p className="mt-2 max-w-md text-sm text-neutral-500">
          导入一篇 3 章以上的小说，SceneWeaver 会把它改编成结构化、可溯源、可打磨的剧本。
        </p>
      </section>

      <SettingsModal open={settingsOpen} onClose={() => setSettingsOpen(false)} />
    </main>
  );
}
