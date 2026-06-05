// 各家大模型厂商预设（照搬自 copychat 的 PROVIDER_META）。
// 选厂商时自动填入对应 baseUrl / 默认 model；format 决定调用走 Claude 还是 OpenAI 兼容格式。
// 注：各家 model 更新很快，这里用"已发布过的合理 ID"作默认值，用户可在设置页改。

import type { LLMProvider } from "./types";

export interface ProviderMeta {
  id: LLMProvider;
  label: string;
  baseUrl: string;
  model: string;
  color: string;
  format: "openai" | "claude"; // claude 走 Anthropic 格式，其余 OpenAI 兼容
  logo?: string; // /providers/xxx.png（自定义无）
}

export const PROVIDERS: ProviderMeta[] = [
  { id: "deepseek", label: "DeepSeek", baseUrl: "https://api.deepseek.com/v1", model: "deepseek-v4-pro", color: "#4d6bfe", format: "openai", logo: "/providers/deepseek.png" },
  { id: "openai", label: "OpenAI", baseUrl: "https://api.openai.com/v1", model: "gpt-5.5", color: "#10a37f", format: "openai", logo: "/providers/openai.png" },
  { id: "kimi", label: "Kimi", baseUrl: "https://api.moonshot.cn/v1", model: "kimi-k2.6", color: "#6366f1", format: "openai", logo: "/providers/kimi.png" },
  { id: "zhipu", label: "智谱", baseUrl: "https://open.bigmodel.cn/api/paas/v4", model: "glm-5", color: "#3b82f6", format: "openai", logo: "/providers/zhipu.png" },
  { id: "claude", label: "Claude", baseUrl: "https://api.anthropic.com/v1", model: "claude-sonnet-4-6", color: "#d97706", format: "claude", logo: "/providers/claude.png" },
  { id: "aliyun", label: "阿里云", baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1", model: "qwen-max-latest", color: "#f97316", format: "openai", logo: "/providers/aliyun.png" },
  { id: "minimax", label: "MiniMax", baseUrl: "https://api.minimax.io/v1", model: "MiniMax-M2.7", color: "#6366f1", format: "openai", logo: "/providers/minimax.png" },
  { id: "mimo", label: "小米 MiMo", baseUrl: "https://api.xiaomimimo.com/v1", model: "mimo-v2.5-pro", color: "#ff6700", format: "openai", logo: "/providers/mimo.png" },
  { id: "ollama", label: "Ollama", baseUrl: "http://localhost:11434/v1", model: "llama4:scout", color: "#64748b", format: "openai", logo: "/providers/ollama.png" },
  { id: "custom", label: "自定义", baseUrl: "", model: "", color: "#6d7b6d", format: "openai" },
];

export function getProvider(id: LLMProvider): ProviderMeta {
  return PROVIDERS.find((p) => p.id === id) ?? PROVIDERS[PROVIDERS.length - 1];
}
