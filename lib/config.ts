// LLM 配置的本地持久化（localStorage）。API Key 只存本地，不上传、不入库。

import type { LLMConfig } from "./llm/types";
import { getProvider } from "./llm/providers";

const KEY = "sceneweaver.llmConfig";

const ds = getProvider("deepseek");
const DEFAULT_CONFIG: LLMConfig = {
  provider: "deepseek",
  baseUrl: ds.baseUrl,
  apiKey: "",
  model: ds.model,
};

export function loadLLMConfig(): LLMConfig {
  if (typeof window === "undefined") return DEFAULT_CONFIG;
  try {
    const raw = window.localStorage.getItem(KEY);
    return raw ? { ...DEFAULT_CONFIG, ...JSON.parse(raw) } : DEFAULT_CONFIG;
  } catch {
    return DEFAULT_CONFIG;
  }
}

export function saveLLMConfig(config: LLMConfig): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(KEY, JSON.stringify(config));
}
