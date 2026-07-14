import { describe, expect, it } from "vitest";
import { chunkNovel } from "../novel/chunking";
import type { ChunkNovelOptions } from "../novel/types";
import {
  buildRollingStoryBibleFromChunks,
  StoryBiblePipelineError,
  type StoryBibleCall,
  type StoryBiblePipelineOptions,
} from "./pipeline";
import { makeDelta, THREE_CHAPTER_NOVEL, threeChunks } from "./test-helpers";

const chunking = {
  targetChars: 14,
  overlapChars: 7,
  checkpointIdentity: "test-model:rolling-prompt-v3:schema-v1",
} as const;

function runRollingWithTestChunks(
  novel: string,
  call: StoryBibleCall,
  options: StoryBiblePipelineOptions & ChunkNovelOptions,
) {
  const { targetChars, overlapChars, ...pipelineOptions } = options;
  const chunkedNovel = chunkNovel(novel, { targetChars, overlapChars });
  return buildRollingStoryBibleFromChunks(
    novel,
    chunkedNovel,
    call,
    pipelineOptions,
  );
}

describe("滚动 Story Bible pipeline", () => {
  it("严格按原文顺序调用，并把上一检查点交给下一块", async () => {
    const chunks = threeChunks();
    const snapshots: string[] = [];
    const checkpoints: number[] = [];
    let callIndex = 0;
    const result = await runRollingWithTestChunks(
      THREE_CHAPTER_NOVEL,
      async (messages) => {
        snapshots.push(messages[1].content);
        return JSON.stringify(makeDelta(chunks[callIndex++]));
      },
      {
        ...chunking,
        onCheckpoint: (bible) => {
          checkpoints.push(bible.version);
        },
      },
    );

    expect(callIndex).toBe(3);
    expect(snapshots[0]).toContain('"version":0');
    expect(snapshots[1]).toContain('"version":1');
    expect(snapshots[2]).toContain('"version":2');
    expect(checkpoints).toEqual([1, 2, 3]);
    expect(result.bible).toMatchObject({
      version: 3,
      processedRange: { start: 1, end: 6 },
      boundaryState: { chunkId: "chunk_003", asOfParagraph: 6 },
    });
  });

  it("第二块失败时只返回第一块检查点，恢复后只重跑第二、三块", async () => {
    const chunks = threeChunks();
    let callIndex = 0;
    let failure: StoryBiblePipelineError | undefined;
    try {
      await runRollingWithTestChunks(
        THREE_CHAPTER_NOVEL,
        async () => {
          if (callIndex++ === 1) return "模型没有返回 JSON";
          return JSON.stringify(makeDelta(chunks[0]));
        },
        chunking,
      );
    } catch (error) {
      if (error instanceof StoryBiblePipelineError) failure = error;
    }

    expect(failure).toBeDefined();
    expect(failure?.failedChunk.id).toBe("chunk_002");
    expect(failure?.completedBible).toMatchObject({
      version: 1,
      processedRange: { start: 1, end: 2 },
    });

    let resumedCalls = 0;
    const resumed = await runRollingWithTestChunks(
      THREE_CHAPTER_NOVEL,
      async () => JSON.stringify(makeDelta(chunks[resumedCalls++ + 1])),
      { ...chunking, initialBible: failure!.completedBible },
    );
    expect(resumedCalls).toBe(2);
    expect(resumed.bible.version).toBe(3);

    let completedCalls = 0;
    const repeated = await runRollingWithTestChunks(
      THREE_CHAPTER_NOVEL,
      async () => {
        completedCalls++;
        return "不应调用";
      },
      { ...chunking, initialBible: resumed.bible },
    );
    expect(completedCalls).toBe(0);
    expect(repeated.bible.version).toBe(3);
  });

  it("小说内容或实际冻结分块变化时拒绝误用旧检查点", async () => {
    const chunks = threeChunks();
    let checkpoint: Awaited<ReturnType<typeof runRollingWithTestChunks>>["bible"] | undefined;
    let index = 0;
    await runRollingWithTestChunks(
      THREE_CHAPTER_NOVEL,
      async () => JSON.stringify(makeDelta(chunks[index++])),
      {
        ...chunking,
        onCheckpoint: (bible) => {
          if (bible.version === 1) checkpoint = bible;
        },
      },
    );

    expect(checkpoint?.version).toBe(1);
    let calls = 0;
    await expect(
      runRollingWithTestChunks(
        `${THREE_CHAPTER_NOVEL}改`,
        async () => {
          calls++;
          return "";
        },
        { ...chunking, initialBible: checkpoint! },
      ),
    ).rejects.toThrow("检查点不属于当前小说");
    await expect(
      runRollingWithTestChunks(
        THREE_CHAPTER_NOVEL,
        async () => {
          calls++;
          return "";
        },
        {
          targetChars: 10,
          overlapChars: 7,
          checkpointIdentity: chunking.checkpointIdentity,
          initialBible: checkpoint!,
        },
      ),
    ).rejects.toThrow("检查点不属于当前小说");
    expect(calls).toBe(0);
  });

  it("把同一个 AbortSignal 传入正在进行的模型请求", async () => {
    const controller = new AbortController();
    let receivedSignal: AbortSignal | undefined;
    const task = runRollingWithTestChunks(
      THREE_CHAPTER_NOVEL,
      async (_messages, signal) => {
        receivedSignal = signal;
        return new Promise<string>((_resolve, reject) => {
          signal?.addEventListener(
            "abort",
            () => reject(new DOMException("Request aborted by user", "AbortError")),
            { once: true },
          );
        });
      },
      {
        targetChars: 100,
        overlapChars: 0,
        checkpointIdentity: chunking.checkpointIdentity,
        signal: controller.signal,
      },
    );
    controller.abort();

    await expect(task).rejects.toMatchObject({ name: "StoryBiblePipelineError" });
    expect(receivedSignal).toBe(controller.signal);
  });

  it("检查点绑定模型、prompt 与 schema 版本，版本变化或空标识均拒绝", async () => {
    const chunks = threeChunks();
    let checkpoint: Awaited<ReturnType<typeof runRollingWithTestChunks>>["bible"] | undefined;
    let index = 0;
    await runRollingWithTestChunks(
      THREE_CHAPTER_NOVEL,
      async () => JSON.stringify(makeDelta(chunks[index++])),
      {
        ...chunking,
        onCheckpoint: (bible) => {
          if (bible.version === 1) checkpoint = bible;
        },
      },
    );

    let calls = 0;
    await expect(
      runRollingWithTestChunks(
        THREE_CHAPTER_NOVEL,
        async () => {
          calls += 1;
          return "";
        },
        {
          ...chunking,
          checkpointIdentity: "test-model:rolling-prompt-v4:schema-v1",
          initialBible: checkpoint!,
        },
      ),
    ).rejects.toThrow("检查点不属于当前小说");
    await expect(
      runRollingWithTestChunks(THREE_CHAPTER_NOVEL, async () => "", {
        ...chunking,
        checkpointIdentity: "   ",
      }),
    ).rejects.toThrow("checkpointIdentity");
    expect(calls).toBe(0);
  });

  it("进度回调内取消后不再启动当前块模型调用", async () => {
    const controller = new AbortController();
    let calls = 0;
    await expect(
      runRollingWithTestChunks(
        THREE_CHAPTER_NOVEL,
        async () => {
          calls += 1;
          return "";
        },
        {
          ...chunking,
          signal: controller.signal,
          onProgress: (progress) => {
            if (progress.stage === "understanding") controller.abort();
          },
        },
      ),
    ).rejects.toMatchObject({ name: "StoryBiblePipelineError" });
    expect(calls).toBe(0);
  });

  it("块完成进度中取消时返回已完成检查点，不启动下一块", async () => {
    const chunks = threeChunks();
    const controller = new AbortController();
    let calls = 0;
    let failure: StoryBiblePipelineError | undefined;
    try {
      await runRollingWithTestChunks(
        THREE_CHAPTER_NOVEL,
        async () => JSON.stringify(makeDelta(chunks[calls++])),
        {
          ...chunking,
          signal: controller.signal,
          onProgress: (progress) => {
            if (progress.stage === "understanding" && progress.completed === 1) {
              controller.abort();
            }
          },
        },
      );
    } catch (error) {
      if (error instanceof StoryBiblePipelineError) failure = error;
    }

    expect(calls).toBe(1);
    expect(failure?.failedChunk.id).toBe("chunk_002");
    expect(failure?.completedBible).toMatchObject({
      version: 1,
      processedRange: { start: 1, end: 2 },
    });
  });

  it("onLog 内取消后不发出当前模型调用", async () => {
    const controller = new AbortController();
    let calls = 0;
    await expect(
      runRollingWithTestChunks(
        THREE_CHAPTER_NOVEL,
        async () => {
          calls += 1;
          return "";
        },
        {
          ...chunking,
          signal: controller.signal,
          onLog: () => controller.abort(),
        },
      ),
    ).rejects.toMatchObject({ name: "StoryBiblePipelineError" });
    expect(calls).toBe(0);
  });
});
