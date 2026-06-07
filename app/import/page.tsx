"use client";

import { useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { newProject, saveProject } from "@/lib/projects";

export default function ImportPage() {
  const [text, setText] = useState("");
  const [fileName, setFileName] = useState<string | null>(null);
  const [reading, setReading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const router = useRouter();

  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    const name = file.name.replace(/\.[^.]+$/, "");
    setFileName(name);
    setReading(true);
    setError(null);
    try {
      const name = file.name.toLowerCase();
      if (name.endsWith(".docx")) {
        const mod = await import("mammoth");
        const mammoth = (mod.default ?? mod) as typeof import("mammoth");
        const arrayBuffer = await file.arrayBuffer();
        const res = await mammoth.extractRawText({ arrayBuffer });
        setText(res.value);
      } else {
        setText(await file.text());
      }
    } catch {
      setError("读取文件失败，请确认是 .txt / .md / .docx 文件");
    } finally {
      setReading(false);
    }
  }

  async function start() {
    if (!text.trim()) return;
    const project = newProject(text, fileName ?? undefined);
    await saveProject(project);
    router.push(`/project/${project.id}/generating`);
  }

  const chars = text.replace(/\s/g, "").length;

  return (
    <main className="mx-auto w-full max-w-3xl flex-1">
      <header className="flex items-center justify-between border-b border-neutral-200 px-6 py-5">
        <div>
          <h1 className="text-lg font-bold">导入小说</h1>
          <p className="mt-0.5 text-sm text-neutral-500">粘贴正文，或上传 .txt / .md / .docx 文件（建议 3 章以上）</p>
        </div>
        <Link href="/" className="text-sm text-neutral-500 hover:text-neutral-900">
          ← 返回
        </Link>
      </header>

      <div className="px-6 py-8">
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="在此粘贴小说正文…"
          className="h-[52vh] w-full resize-none rounded-xl border border-neutral-300 p-4 font-serif text-base leading-relaxed outline-none focus:border-neutral-400"
        />

        <div className="mt-3 flex items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <button
              onClick={() => fileRef.current?.click()}
              disabled={reading}
              className="rounded-md border border-neutral-300 px-3 py-1.5 text-sm hover:bg-neutral-100 disabled:opacity-50"
            >
              {reading ? "读取中…" : "上传文件"}
            </button>
            <input
              ref={fileRef}
              type="file"
              accept=".txt,.md,.docx"
              onChange={onFile}
              className="hidden"
            />
            <span className="text-xs text-neutral-400">{chars} 字</span>
            {error && <span className="text-xs text-rose-600">{error}</span>}
          </div>
          <button
            onClick={start}
            disabled={!text.trim()}
            className="rounded-md bg-neutral-900 px-4 py-1.5 text-sm text-white hover:bg-neutral-700 disabled:opacity-40"
          >
            开始改编 →
          </button>
        </div>
      </div>
    </main>
  );
}
