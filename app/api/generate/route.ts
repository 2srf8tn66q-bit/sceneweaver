// 服务端编排生成：浏览器只发一个请求，服务端（Node）高并发请求 LLM 跑完整 pipeline。
// 避开浏览器"同源 6 连接"限制，真正并行、提速。

import { generateScreenplay } from "@/lib/screenplay/pipeline";
import { serverChat } from "@/lib/llm/serverCall";
import type { LLMConfig } from "@/lib/llm/types";

export const runtime = "nodejs";
export const maxDuration = 300; // 部署时给足（本地 dev 无此限制）

interface GenerateBody {
  novel?: string;
  config?: LLMConfig;
  title?: string;
}

export async function POST(req: Request) {
  try {
    const { novel, config, title }: GenerateBody = await req.json();
    if (!novel || !config?.apiKey) {
      return Response.json({ error: "缺少小说正文或 API 配置" }, { status: 400 });
    }
    const result = await generateScreenplay(novel, (messages) => serverChat(config, messages), {
      title: title ?? "未命名剧本",
      concurrency: 20, // 服务端无浏览器连接限制，可高并发
      onLog: (m) => console.log("[gen]", m), // 打到 dev server 日志，便于定位
    });
    return Response.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : "生成失败";
    return Response.json({ error: message }, { status: 500 });
  }
}
