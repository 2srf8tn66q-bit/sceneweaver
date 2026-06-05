// LLM 配置与消息类型（沿用 copychat 的 OpenAI 兼容 / Claude 双格式约定）

export type LLMProvider =
  | "deepseek"
  | "openai"
  | "kimi"
  | "zhipu"
  | "claude"
  | "aliyun"
  | "minimax"
  | "mimo"
  | "ollama"
  | "custom";

export interface LLMConfig {
  // claude = Anthropic 原生格式；openai = 任意 OpenAI 兼容服务（DeepSeek / Kimi / 七牛 等）
  provider: LLMProvider;
  baseUrl: string; // 例: https://api.openai.com/v1 或 https://api.anthropic.com/v1
  apiKey: string;
  model: string; // 例: gpt-4o-mini / deepseek-chat / claude-3-7-sonnet
}

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}
