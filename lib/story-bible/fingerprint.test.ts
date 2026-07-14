import { describe, expect, it } from "vitest";
import type { ChunkedNovel } from "../novel/types";
import { fingerprintStorySource } from "./fingerprint";

const NOVEL = "第一章\n雨夜\n清晨";

function frozenNovel(): ChunkedNovel {
  return {
    paragraphs: [
      { n: 1, text: "第一章" },
      { n: 2, text: "雨夜" },
      { n: 3, text: "清晨" },
    ],
    chapters: [
      {
        id: "chapter_001",
        index: 0,
        title: "第一章",
        paragraphRange: { start: 1, end: 3 },
        charCount: 12,
        kind: "chapter",
        headingParagraph: 1,
      },
    ],
    chunks: [
      {
        id: "chunk_001",
        index: 0,
        chapterIds: ["chapter_001"],
        chapterRanges: [
          {
            chapterId: "chapter_001",
            paragraphRange: { start: 2, end: 2 },
          },
        ],
        coreRange: { start: 2, end: 2 },
        contextRange: { start: 1, end: 3 },
        overlapBefore: { start: 1, end: 1 },
        overlapAfter: { start: 3, end: 3 },
        coreCharCount: 5,
        contextCharCount: 12,
      },
    ],
    totalChars: 12,
  };
}

function cloneFrozen(): ChunkedNovel {
  return structuredClone(frozenNovel());
}

describe("Story Bible 检查点指纹", () => {
  it("绑定所有进入 prompt 或 validator 的冻结分块字段", () => {
    const baseline = fingerprintStorySource(NOVEL, frozenNovel(), "identity");

    const withoutOverlapBefore = cloneFrozen();
    withoutOverlapBefore.chunks[0].overlapBefore = undefined;

    const withoutOverlapAfter = cloneFrozen();
    withoutOverlapAfter.chunks[0].overlapAfter = undefined;

    const changedChapterRange = cloneFrozen();
    changedChapterRange.chunks[0].chapterRanges[0].paragraphRange.start = 1;

    const changedParagraph = cloneFrozen();
    changedParagraph.paragraphs[0].text = "被替换的冻结段落";

    for (const changed of [
      withoutOverlapBefore,
      withoutOverlapAfter,
      changedChapterRange,
      changedParagraph,
    ]) {
      expect(fingerprintStorySource(NOVEL, changed, "identity")).not.toBe(
        baseline,
      );
    }
  });
});
