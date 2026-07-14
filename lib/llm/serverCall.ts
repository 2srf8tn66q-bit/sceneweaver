// 服务端直连 LLM（不经浏览器代理）。在 Node 里跑，没有浏览器"同源 6 连接"限制，
// 可高并发请求 DeepSeek。供 /api/generate 的服务端编排使用。

import type { LLMConfig, ChatMessage } from "./types";
import { getProvider } from "./providers";

export interface ServerChatUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
}

export interface ServerChatResult {
  content: string;
  usage?: ServerChatUsage;
}

export interface ServerChatOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  maxTokens?: number;
}

function tokenCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export async function serverChatDetailed(
  config: LLMConfig,
  messages: ChatMessage[],
  options: ServerChatOptions = {},
): Promise<ServerChatResult> {
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
    body = {
      model: config.model,
      max_tokens: options.maxTokens ?? 4096,
      messages: conversation,
      ...(system ? { system } : {}),
    };
  } else {
    url = `${config.baseUrl}/chat/completions`;
    headers = { "Content-Type": "application/json", Authorization: `Bearer ${config.apiKey}` };
    body = {
      model: config.model,
      messages: messages.map((m) => ({ role: m.role, content: m.content })),
      stream: false,
      ...(options.maxTokens ? { max_tokens: options.maxTokens } : {}),
    };
  }

  const controller = new AbortController();
  const timeout = options.timeoutMs
    ? setTimeout(() => controller.abort(), options.timeoutMs)
    : undefined;
  const abort = () => controller.abort();
  if (options.signal?.aborted) controller.abort();
  else options.signal?.addEventListener("abort", abort, { once: true });

  try {
    const res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok) {
      const txt = await res.text();
      throw new Error(`LLM ${res.status}: ${txt.slice(0, 200)}`);
    }
    const data = await res.json();
    const content = isClaude ? data?.content?.[0]?.text : data?.choices?.[0]?.message?.content;
    if (!content) throw new Error("LLM 返回格式异常");
    const inputTokens = tokenCount(data?.usage?.input_tokens ?? data?.usage?.prompt_tokens);
    const outputTokens = tokenCount(
      data?.usage?.output_tokens ?? data?.usage?.completion_tokens,
    );
    const totalTokens = tokenCount(data?.usage?.total_tokens) ??
      (inputTokens !== undefined && outputTokens !== undefined
        ? inputTokens + outputTokens
        : undefined);
    const usage =
      inputTokens !== undefined || outputTokens !== undefined || totalTokens !== undefined
        ? { inputTokens, outputTokens, totalTokens }
        : undefined;
    return { content: content as string, usage };
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      if (options.signal?.aborted) {
        throw new DOMException("Request aborted by user", "AbortError");
      }
      throw new Error("LLM 请求超时");
    }
    throw error;
  } finally {
    if (timeout) clearTimeout(timeout);
    options.signal?.removeEventListener("abort", abort);
  }
}

export async function serverChat(
  config: LLMConfig,
  messages: ChatMessage[],
  signal?: AbortSignal,
): Promise<string> {
  return (await serverChatDetailed(config, messages, { signal })).content;
}
