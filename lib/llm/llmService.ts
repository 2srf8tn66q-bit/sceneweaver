// LLM 调用层 —— 移植自 copychat services/llmService.ts。
// 经本地代理 /api/llm/proxy 转发，支持 OpenAI 兼容与 Claude 两种格式，含中文友好错误与超时/abort。

import type { LLMConfig, ChatMessage } from "./types";
import { getProvider } from "./providers";

/**
 * 把服务商返回的难懂错误转成中文友好提示。
 * 主要针对国内模型的内容审核 / 鉴权 / 限流 / 模型不存在等常见错误。
 */
function humanizeApiError(status: number, raw: string): string {
  let parsed:
    | { error?: { code?: string; message?: string }; contentFilter?: unknown; message?: string }
    | null = null;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // 不是 JSON 就保留原文
  }

  const lower = raw.toLowerCase();

  // 内容审核（国内模型最常见）
  if (parsed?.contentFilter || /contentfilter|content_filter|sensitive|敏感|审核|不安全/i.test(raw)) {
    return "当前模型的内容审核拒绝了这条消息（模型方策略偏严）。建议换成 Claude / OpenAI / Kimi / DeepSeek，或换一种说法重试。";
  }

  // 鉴权
  if (status === 401 || /unauthorized|invalid api key|invalid_api_key/i.test(lower)) {
    return "API Key 无效或已过期。请到「设置」检查配置。";
  }
  if (status === 403 || /forbidden|permission|没有权限/i.test(lower)) {
    return "没有调用这个模型的权限。可能是模型未开通，或地区限制。";
  }

  // 限流 / 余额
  if (status === 429 || /rate.?limit|too many requests|限流/i.test(lower)) {
    return "请求太频繁了，稍等几秒再试。";
  }
  if (/quota|insufficient|余额|额度|payment/i.test(lower)) {
    return "账户额度不足或欠费。请到模型方控制台充值。";
  }

  // 模型 ID 错误
  if (status === 404 || /model.*not.*found|模型不存在/i.test(lower)) {
    return "模型 ID 不存在。请到「设置」检查 model 字段（例如 gpt-4o-mini、deepseek-chat、claude-3-7-sonnet）。";
  }

  // 服务端故障
  if (status >= 500) {
    return `模型服务方暂时出错（${status}），稍后重试。`;
  }

  const msg = parsed?.error?.message ?? parsed?.message;
  if (msg && typeof msg === "string" && msg.length < 200) {
    return `请求失败（${status}）：${msg}`;
  }
  return `请求失败（${status}）。完整错误已打到 console。`;
}

function buildOpenAICompatibleRequest(config: LLMConfig, messages: ChatMessage[]) {
  const url = `${config.baseUrl}/chat/completions`;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${config.apiKey}`,
  };
  const body = {
    model: config.model,
    messages: messages.map((m) => ({ role: m.role, content: m.content })),
    stream: false,
  };
  return { url, headers, body };
}

function buildClaudeRequest(config: LLMConfig, messages: ChatMessage[]) {
  const url = `${config.baseUrl}/messages`;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "x-api-key": config.apiKey,
    "anthropic-version": "2023-06-01",
  };
  const systemMessage = messages.find((m) => m.role === "system")?.content ?? "";
  const conversationMessages = messages
    .filter((m) => m.role !== "system")
    .map((m) => ({ role: m.role, content: m.content }));
  const body: Record<string, unknown> = {
    model: config.model,
    max_tokens: 4096, // 剧本一场的 YAML 可能较长，给足余量
    messages: conversationMessages,
  };
  if (systemMessage) body.system = systemMessage;
  return { url, headers, body };
}

function buildProxyPayload(url: string, headers: Record<string, string>, body: unknown) {
  return { targetUrl: url, headers, body };
}

/**
 * 发送一轮对话，返回助手回复文本。
 * @param externalSignal 可选外部 AbortSignal —— 用户点"停止生成"时取消 in-flight 请求
 */
export async function sendChatMessage(
  config: LLMConfig,
  messages: ChatMessage[],
  externalSignal?: AbortSignal,
): Promise<string> {
  const isClaude = getProvider(config.provider).format === "claude";
  const { url, headers, body } = isClaude
    ? buildClaudeRequest(config, messages)
    : buildOpenAICompatibleRequest(config, messages);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 240000);

  let externalAbortHandler: (() => void) | null = null;
  if (externalSignal) {
    if (externalSignal.aborted) {
      controller.abort();
    } else {
      externalAbortHandler = () => controller.abort();
      externalSignal.addEventListener("abort", externalAbortHandler, { once: true });
    }
  }

  try {
    const response = await fetch("/api/llm/proxy", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(buildProxyPayload(url, headers, body)),
      signal: controller.signal,
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error("[LLM] API error", response.status, errorText);
      throw new Error(humanizeApiError(response.status, errorText));
    }

    const data = await response.json();

    if (isClaude) {
      const content = data?.content?.[0]?.text;
      if (!content) throw new Error("Unexpected Claude response format");
      return content;
    } else {
      const content = data?.choices?.[0]?.message?.content;
      if (!content) throw new Error("Unexpected OpenAI response format");
      return content;
    }
  } catch (error: unknown) {
    if (error instanceof DOMException && error.name === "AbortError") {
      if (externalSignal?.aborted) {
        throw new DOMException("Request aborted by user", "AbortError");
      }
      throw new Error("请求超时，请稍后重试");
    }
    throw error;
  } finally {
    clearTimeout(timeout);
    if (externalSignal && externalAbortHandler) {
      externalSignal.removeEventListener("abort", externalAbortHandler);
    }
  }
}

/** 设置页「测试连接」用。 */
export async function testConnection(
  config: LLMConfig,
): Promise<{ success: boolean; message: string }> {
  try {
    const result = await sendChatMessage(config, [
      { role: "user", content: 'Say "OK" and nothing else.' },
    ]);
    return { success: true, message: `连接成功，模型回复：${result.slice(0, 100)}` };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "未知错误";
    return { success: false, message: `连接失败：${message}` };
  }
}
