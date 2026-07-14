import { chunkNovel } from "../novel/chunking";
import type { NovelChunk } from "../novel/types";
import type { StoryBibleDelta, StorySourceRef } from "./types";

export const THREE_CHAPTER_NOVEL = [
  "第一章",
  "甲甲甲甲",
  "第二章",
  "乙乙乙乙",
  "第三章",
  "丙丙丙丙",
].join("\n");

export function threeChunks() {
  return chunkNovel(THREE_CHAPTER_NOVEL, {
    targetChars: 14,
    overlapChars: 7,
  }).chunks;
}

export function sourceRef(
  chunk: NovelChunk,
  paragraph = chunk.coreRange.start,
): StorySourceRef {
  const chapter = chunk.chapterRanges.find(
    (item) =>
      item.paragraphRange.start <= paragraph &&
      item.paragraphRange.end >= paragraph,
  );
  if (!chapter) throw new Error(`¶${paragraph} 不在 ${chunk.id} 的核心章节区间内`);
  return {
    chapterId: chapter.chapterId,
    chunkId: chunk.id,
    paragraphRange: { start: paragraph, end: paragraph },
  };
}

export function makeDelta(
  chunk: NovelChunk,
  overrides: Partial<StoryBibleDelta> = {},
): StoryBibleDelta {
  const ref = sourceRef(chunk, chunk.coreRange.end);
  return {
    chunkId: chunk.id,
    processedRange: { ...chunk.coreRange },
    characters: [],
    newFacts: [],
    timelineEvents: [],
    openedThreads: [],
    resolvedThreads: [],
    reportedConflicts: [],
    resolvedConflicts: [],
    boundaryState: {
      chunkId: chunk.id,
      asOfParagraph: chunk.coreRange.end,
      timeLabel: "",
      location: "",
      characters: [],
      objects: [],
      openReferences: [],
      sourceRefs: [ref],
    },
    ...overrides,
  };
}
