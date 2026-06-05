import Link from "next/link";
import SceneCard from "@/components/SceneCard";
import { sampleScreenplay } from "@/lib/screenplay/sample";

export default async function WorkbenchPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  return (
    <div className="flex h-screen flex-col">
      {/* 顶栏 */}
      <header className="flex items-center justify-between border-b border-neutral-200 px-4 py-2 text-sm">
        <div className="flex items-center gap-3">
          <Link href="/" className="text-neutral-500 hover:text-neutral-900">
            ← 我的剧本
          </Link>
          <span className="font-medium">工作台</span>
          <span className="text-neutral-400">项目 {id}</span>
        </div>
        <div className="flex items-center gap-2">
          <span className="rounded border border-neutral-300 px-2 py-1">第 1 章 / 共 — 章 ▾</span>
          <button className="rounded bg-neutral-900 px-2.5 py-1 text-white">一键生成</button>
          <button className="rounded border border-neutral-300 px-2.5 py-1">导出</button>
        </div>
      </header>

      {/* 四区骨架：场次列表 | 原文 | 剧本 */}
      <div className="flex flex-1 overflow-hidden">
        <aside className="w-48 shrink-0 border-r border-neutral-200 p-3 text-sm">
          <p className="mb-2 font-medium text-neutral-500">场次</p>
          <p className="text-neutral-400">（生成后在此列出，带置信度颜色）</p>
        </aside>
        <section className="flex-1 overflow-auto border-r border-neutral-200 p-4">
          <p className="mb-2 text-xs font-medium tracking-wide text-neutral-400 uppercase">
            原文（本章）
          </p>
          <p className="text-neutral-400">导入小说后显示；点右侧场景会高亮其来源段落。</p>
        </section>
        <section className="flex-1 overflow-auto p-4">
          <p className="mb-3 text-xs font-medium tracking-wide text-neutral-400 uppercase">
            剧本（本章各场）
          </p>
          <div className="space-y-3">
            {sampleScreenplay.scenes.map((s) => (
              <SceneCard key={s.id} scene={s} characters={sampleScreenplay.characters} />
            ))}
          </div>
        </section>
      </div>
    </div>
  );
}
