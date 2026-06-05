"use client";

import { useState } from "react";
import Image from "next/image";
import type { LLMConfig, LLMProvider } from "@/lib/llm/types";
import { PROVIDERS, getProvider } from "@/lib/llm/providers";
import { loadLLMConfig, saveLLMConfig } from "@/lib/config";
import { testConnection } from "@/lib/llm/llmService";

export default function SettingsModal({ onClose }: { onClose: () => void }) {
  // 仅在打开时挂载（见 page.tsx 条件渲染），useState 初始化即加载本地配置。
  const [config, setConfig] = useState<LLMConfig>(loadLLMConfig());
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<string | null>(null);

  // 选厂商：自动填入该家的 baseUrl / 默认 model（自定义则保留用户已填的）
  function selectProvider(id: LLMProvider) {
    const meta = getProvider(id);
    setConfig((c) => ({
      ...c,
      provider: id,
      baseUrl: meta.baseUrl || c.baseUrl,
      model: meta.model || c.model,
    }));
  }

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
      <div className="w-full max-w-lg rounded-xl bg-white p-6 shadow-xl">
        <h2 className="text-lg font-semibold">设置 · 模型配置</h2>
        <p className="mt-1 text-xs text-neutral-500">
          API Key 仅保存在本地浏览器，不上传、不入库。
        </p>

        {/* 厂商网格：点一下自动填 URL 和默认模型 */}
        <div className="mt-4 grid grid-cols-5 gap-2">
          {PROVIDERS.map((p) => {
            const active = config.provider === p.id;
            return (
              <button
                key={p.id}
                type="button"
                onClick={() => selectProvider(p.id)}
                title={p.label}
                className={`flex flex-col items-center gap-1 rounded-lg border px-1.5 py-2 text-[11px] ${
                  active
                    ? "border-neutral-900 bg-neutral-50"
                    : "border-neutral-200 hover:bg-neutral-50"
                }`}
              >
                {p.logo ? (
                  <Image
                    src={p.logo}
                    alt={p.label}
                    width={22}
                    height={22}
                    className="h-[22px] w-[22px] object-contain"
                  />
                ) : (
                  <span className="flex h-[22px] w-[22px] items-center justify-center text-neutral-400">
                    ✎
                  </span>
                )}
                <span className="w-full truncate text-center">{p.label}</span>
              </button>
            );
          })}
        </div>

        {/* 详细字段 */}
        <div className="mt-4 space-y-3 text-sm">
          <label className="block">
            <span className="text-neutral-600">Base URL</span>
            <input
              className="mt-1 w-full rounded-md border border-neutral-300 px-2 py-1.5"
              value={config.baseUrl}
              onChange={(e) => update("baseUrl", e.target.value)}
              placeholder="https://api.deepseek.com/v1"
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
              placeholder="deepseek-v4-pro"
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
