"use client";

import { useState } from "react";
import type { LLMConfig, LLMProvider } from "@/lib/llm/types";
import { loadLLMConfig, saveLLMConfig } from "@/lib/config";
import { testConnection } from "@/lib/llm/llmService";

export default function SettingsModal({ onClose }: { onClose: () => void }) {
  // 仅在打开时挂载（见 page.tsx 的条件渲染），useState 初始化即加载本地配置，
  // 无需在 effect 里 setState。
  const [config, setConfig] = useState<LLMConfig>(loadLLMConfig());
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<string | null>(null);

  function update<K extends keyof LLMConfig>(key: K, value: LLMConfig[K]) {
    setConfig((c) => ({ ...c, [key]: value }));
  }

  function handleSave() {
    saveLLMConfig(config);
    onClose();
  }

  async function handleTest() {
    setTesting(true);
    setResult(null);
    const r = await testConnection(config);
    setResult(r.message);
    setTesting(false);
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="w-full max-w-md rounded-xl bg-white p-6 shadow-xl">
        <h2 className="text-lg font-semibold">设置 · 模型配置</h2>
        <p className="mt-1 text-xs text-neutral-500">
          API Key 仅保存在本地浏览器，不上传、不入库。
        </p>

        <div className="mt-4 space-y-3 text-sm">
          <label className="block">
            <span className="text-neutral-600">提供方</span>
            <select
              className="mt-1 w-full rounded-md border border-neutral-300 px-2 py-1.5"
              value={config.provider}
              onChange={(e) => update("provider", e.target.value as LLMProvider)}
            >
              <option value="openai">OpenAI 兼容（DeepSeek / Kimi / 七牛 等）</option>
              <option value="claude">Claude（Anthropic 原生）</option>
            </select>
          </label>
          <label className="block">
            <span className="text-neutral-600">Base URL</span>
            <input
              className="mt-1 w-full rounded-md border border-neutral-300 px-2 py-1.5"
              value={config.baseUrl}
              onChange={(e) => update("baseUrl", e.target.value)}
              placeholder="https://api.openai.com/v1"
            />
          </label>
          <label className="block">
            <span className="text-neutral-600">API Key</span>
            <input
              type="password"
              className="mt-1 w-full rounded-md border border-neutral-300 px-2 py-1.5"
              value={config.apiKey}
              onChange={(e) => update("apiKey", e.target.value)}
            />
          </label>
          <label className="block">
            <span className="text-neutral-600">Model</span>
            <input
              className="mt-1 w-full rounded-md border border-neutral-300 px-2 py-1.5"
              value={config.model}
              onChange={(e) => update("model", e.target.value)}
              placeholder="gpt-4o-mini / deepseek-chat / claude-3-7-sonnet"
            />
          </label>
        </div>

        {result && <p className="mt-3 text-xs text-neutral-600">{result}</p>}

        <div className="mt-5 flex items-center justify-between">
          <button
            onClick={handleTest}
            disabled={testing}
            className="rounded-md border border-neutral-300 px-3 py-1.5 text-sm hover:bg-neutral-100 disabled:opacity-50"
          >
            {testing ? "测试中…" : "测试连接"}
          </button>
          <div className="flex gap-2">
            <button
              onClick={onClose}
              className="rounded-md px-3 py-1.5 text-sm hover:bg-neutral-100"
            >
              取消
            </button>
            <button
              onClick={handleSave}
              className="rounded-md bg-neutral-900 px-3 py-1.5 text-sm text-white hover:bg-neutral-700"
            >
              保存
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
