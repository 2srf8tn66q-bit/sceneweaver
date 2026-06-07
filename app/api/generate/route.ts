// 服务端编排生成 + SSE 流式进度推送。
// 客户端 fetch → 逐条接收进度事件 → 最终事件含完整结果。

import { generateScreenplay, type Progress } from "@/lib/screenplay/pipeline";
import { serverChat } from "@/lib/llm/serverCall";
import type { LLMConfig } from "@/lib/llm/types";

export const runtime = "nodejs";
export const maxDuration = 300;

interface GenerateBody {
  novel?: string;
  config?: LLMConfig;
  title?: string;
}

function sse(event: Record<string, unknown>): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}

export async function POST(req: Request) {
  try {
    const { novel, config, title }: GenerateBody = await req.json();
    if (!novel || !config?.apiKey) {
      return Response.json({ error: "缺少小说正文或 API 配置" }, { status: 400 });
    }

    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      async start(controller) {
        const onProgress = (p: Progress) => {
          controller.enqueue(encoder.encode(sse({ progress: p })));
        };
        const onLog = (m: string) => console.log("[gen]", m);

        try {
          const result = await generateScreenplay(
            novel,
            (messages) => serverChat(config, messages),
            { title: title ?? "未命名剧本", concurrency: 20, onLog, onProgress },
          );
          controller.enqueue(encoder.encode(sse({ done: true, ...result })));
        } catch (err) {
          const message = err instanceof Error ? err.message : "生成失败";
          controller.enqueue(encoder.encode(sse({ error: message })));
        }
        controller.close();
      },
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "生成失败";
    return Response.json({ error: message }, { status: 500 });
  }
}
