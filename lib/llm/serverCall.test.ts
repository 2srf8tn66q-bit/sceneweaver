import { afterEach, describe, expect, it, vi } from "vitest";
import type { LLMConfig } from "./types";
import { serverChat, serverChatDetailed } from "./serverCall";

const config: LLMConfig = {
  provider: "deepseek",
  baseUrl: "https://example.invalid/v1",
  apiKey: "test-only",
  model: "test-model",
};

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("服务端 LLM 调用边界", () => {
  it("既有 serverChat wrapper 不会被实验用 240 秒超时影响", async () => {
    vi.useFakeTimers();
    let capturedSignal: AbortSignal | undefined;
    let resolveFetch!: (response: Response) => void;
    vi.stubGlobal(
      "fetch",
      (_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((resolve) => {
          capturedSignal = init?.signal as AbortSignal;
          resolveFetch = resolve;
        }),
    );

    const task = serverChat(config, [{ role: "user", content: "test" }]);
    await vi.advanceTimersByTimeAsync(300_000);
    expect(capturedSignal?.aborted).toBe(false);
    resolveFetch(
      new Response(
        JSON.stringify({ choices: [{ message: { content: "ok" } }] }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    await expect(task).resolves.toBe("ok");
  });

  it("只有显式传入 timeoutMs 的调用才会超时", async () => {
    vi.useFakeTimers();
    let capturedSignal: AbortSignal | undefined;
    vi.stubGlobal(
      "fetch",
      (_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          capturedSignal = init?.signal as AbortSignal;
          capturedSignal?.addEventListener(
            "abort",
            () => reject(new DOMException("aborted", "AbortError")),
            { once: true },
          );
        }),
    );

    const task = serverChatDetailed(
      config,
      [{ role: "user", content: "test" }],
      { timeoutMs: 10 },
    );
    const rejected = expect(task).rejects.toThrow("LLM 请求超时");
    await vi.advanceTimersByTimeAsync(10);
    await rejected;
    expect(capturedSignal?.aborted).toBe(true);
  });

  it("真实实验可记录 OpenAI 兼容接口的 token usage", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            choices: [{ message: { content: "ok" } }],
            usage: { prompt_tokens: 120, completion_tokens: 30, total_tokens: 150 },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      ),
    );
    const result = await serverChatDetailed(config, [
      { role: "user", content: "test" },
    ]);
    expect(result).toEqual({
      content: "ok",
      usage: { inputTokens: 120, outputTokens: 30, totalTokens: 150 },
    });
  });
});
