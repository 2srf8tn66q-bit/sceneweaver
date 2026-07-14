import { describe, expect, it } from "vitest";
import {
  chunkNovel,
  countNumberedParagraphChars,
} from "../novel/chunking";
import type { ChunkedNovel } from "../novel/types";
import type { StoryBible } from "./types";
import { buildRollingStoryBibleFromChunks } from "./pipeline";
import { makeDelta, THREE_CHAPTER_NOVEL } from "./test-helpers";

function frozenNovel(): ChunkedNovel {
  const chunked = chunkNovel(THREE_CHAPTER_NOVEL, {
    targetChars: 29,
    overlapChars: 0,
  });
  return {
    ...chunked,
    chunks: chunked.chunks.map((chunk, index) => ({
      ...chunk,
      id: `frozen_${String(index + 1).padStart(3, "0")}`,
    })),
  };
}

describe("冻结分块上的串行 Story Bible 基线", () => {
  it("空冻结输入在模型调用前拒绝", async () => {
    const empty = chunkNovel("", { targetChars: 29, overlapChars: 0 });
    let calls = 0;
    await expect(
      buildRollingStoryBibleFromChunks(
        "",
        empty,
        async () => {
          calls += 1;
          return "";
        },
        { checkpointIdentity: "test-model:rolling-prompt-v4:schema-v1" },
      ),
    ).rejects.toThrow("不能为空");
    expect(calls).toBe(0);
  });

  it("不重新分块、严格按冻结 core 顺序调用，且检查点绑定冻结边界", async () => {
    const baseFrozen = frozenNovel();
    const second = baseFrozen.chunks[1];
    const preceding = baseFrozen.paragraphs.find(
      (paragraph) => paragraph.n === 4,
    )!;
    const frozen: ChunkedNovel = {
      ...baseFrozen,
      chunks: [
        baseFrozen.chunks[0],
        {
          ...second,
          overlapBefore: { start: 4, end: 4 },
          contextRange: { start: 4, end: second.contextRange.end },
          contextCharCount:
            second.contextCharCount + countNumberedParagraphChars([preceding]),
        },
      ],
    };
    expect(frozen.chunks.map((chunk) => chunk.coreRange)).toEqual([
      { start: 1, end: 4 },
      { start: 5, end: 6 },
    ]);

    const prompts: string[] = [];
    let callIndex = 0;
    let firstCheckpoint: StoryBible | undefined;
    const result = await buildRollingStoryBibleFromChunks(
      THREE_CHAPTER_NOVEL,
      frozen,
      async (messages) => {
        prompts.push(messages[1].content);
        return JSON.stringify(makeDelta(frozen.chunks[callIndex++]));
      },
      {
        checkpointIdentity: "test-model:rolling-prompt-v3:schema-v1",
        onCheckpoint: (bible, chunk) => {
          if (chunk.id === "frozen_001") firstCheckpoint = bible;
        },
      },
    );

    expect(callIndex).toBe(2);
    expect(prompts).toHaveLength(2);
    expect(prompts[0]).toContain("当前文本块：frozen_001");
    expect(prompts[0]).toContain("核心责任区：¶1—¶4");
    expect(prompts[1]).toContain("当前文本块：frozen_002");
    expect(prompts[1]).toContain("核心责任区：¶5—¶6");
    expect(result.chunkedNovel).toEqual(frozen);
    expect(result.bible.processedRange).toEqual({ start: 1, end: 6 });
    expect(firstCheckpoint?.sourceFingerprint).toMatch(/^swb\d+_/);

    // 原文、core、contextRange 和计数全不变，只删除实际进入 prompt 的 overlap。
    // 旧实现遗漏 overlap 字段，会错误接受这个旧检查点。
    const changedFrozen: ChunkedNovel = {
      ...frozen,
      chunks: [
        frozen.chunks[0],
        {
          ...frozen.chunks[1],
          overlapBefore: undefined,
        },
      ],
    };
    let resumedCalls = 0;
    await expect(
      buildRollingStoryBibleFromChunks(
        THREE_CHAPTER_NOVEL,
        changedFrozen,
        async () => {
          resumedCalls += 1;
          return "不应调用";
        },
        {
          checkpointIdentity: "test-model:rolling-prompt-v3:schema-v1",
          initialBible: firstCheckpoint!,
        },
      ),
    ).rejects.toThrow("检查点不属于当前小说");
    expect(resumedCalls).toBe(0);
  });
});
