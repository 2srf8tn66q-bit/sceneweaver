// 服务端直连 LLM（不经浏览器代理）。在 Node 里跑，没有浏览器"同源 6 连接"限制，
// 可高并发请求 DeepSeek。供 /api/generate 的服务端编排使用。

import type { LLMConfig, ChatMessage } from "./types";
import { getProvider } from "./providers";

export async function serverChat(config: LLMConfig, messages: ChatMessage[]): Promise<string> {
  const isClaude = getProvider(config.provider).format === "claude";

  let url: string;
  let headers: Record<string, string>;
  let body: unknown;

  if (isClaude) {
    url = `${config.baseUrl}/messages`;
    headers = {
      "Content-Type": "application/json",
      "x-api-key": config.apiKey,
      "anthropic-version": "2023-06-01",
    };
    const system = messages.find((m) => m.role === "system")?.content ?? "";
    const conversation = messages
      .filter((m) => m.role !== "system")
      .map((m) => ({ role: m.role, content: m.content }));
    body = { model: config.model, max_tokens: 4096, messages: conversation, ...(system ? { system } : {}) };
  } else {
    url = `${config.baseUrl}/chat/completions`;
    headers = { "Content-Type": "application/json", Authorization: `Bearer ${config.apiKey}` };
    body = {
      model: config.model,
      messages: messages.map((m) => ({ role: m.role, content: m.content })),
      stream: false,
    };
  }

  const res = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`LLM ${res.status}: ${txt.slice(0, 200)}`);
  }
  const data = await res.json();
  const content = isClaude ? data?.content?.[0]?.text : data?.choices?.[0]?.message?.content;
  if (!content) throw new Error("LLM 返回格式异常");
  return content as string;
}
