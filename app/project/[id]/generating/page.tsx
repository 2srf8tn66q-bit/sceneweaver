"use client";

// 独立生成页：导入后直接进这里 → SSE 实时进度 → 完成后进工作台。
// 从 IDB 读项目（novel + title），从 localStorage 读 LLM 配置。

import { useEffect, useState } from "react";
import { useRouter, useParams } from "next/navigation";
import GeneratingOverlay from "@/components/GeneratingOverlay";
import { loadLLMConfig } from "@/lib/config";
import { getProject, saveProject } from "@/lib/projects";
import type { GenerateResult } from "@/lib/screenplay/pipeline";

export default function GeneratingPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const [novel, setNovel] = useState<string | null>(null);
  const [title, setTitle] = useState("未命名剧本");
  const [config, setConfig] = useState<ReturnType<typeof loadLLMConfig> | null>(null);
  useEffect(() => {
    const cfg = loadLLMConfig();
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setConfig(cfg);
    getProject(params.id).then((p) => {
      if (!p) { router.push("/import"); return; }
      setNovel(p.novel);
      setTitle(p.title);
    });
  }, [params.id, router]);

  async function onDone(result: GenerateResult) {
    if (result.screenplay && result.screenplay.scenes.length > 0) {
      const project = await getProject(params.id);
      if (project) {
        await saveProject({
          ...project,
          screenplay: result.screenplay,
          title: result.screenplay.meta.title || project.title,
          updatedAt: new Date().toISOString(),
        });
      }
    }
    router.push(`/project/${params.id}`);
  }

  if (novel === null || !config) return null;

  return (
    <GeneratingOverlay
      novel={novel!}
      config={config!}
      title={title}
      onDone={onDone}
      onCancel={() => router.push(`/project/${params.id}`)}
    />
  );
}
