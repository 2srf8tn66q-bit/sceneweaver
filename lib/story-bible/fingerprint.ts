import type { ChunkedNovel } from "../novel/types";

/** 检查点绑定原文与实际分块边界，不依赖请求完成顺序。 */
export function fingerprintStorySource(
  novel: string,
  chunkedNovel: ChunkedNovel,
  salt = "",
): string {
  const frozenSnapshot = {
    paragraphs: chunkedNovel.paragraphs.map((paragraph) => [
      paragraph.n,
      paragraph.text,
    ]),
    chapters: chunkedNovel.chapters.map((chapter) => [
      chapter.id,
      chapter.index,
      chapter.title,
      chapter.paragraphRange.start,
      chapter.paragraphRange.end,
      chapter.charCount,
      chapter.kind ?? null,
      chapter.headingParagraph ?? null,
    ]),
    chunks: chunkedNovel.chunks.map((chunk) => [
      chunk.id,
      chunk.index,
      chunk.chapterIds,
      chunk.chapterRanges.map((chapter) => [
        chapter.chapterId,
        chapter.paragraphRange.start,
        chapter.paragraphRange.end,
      ]),
      [chunk.coreRange.start, chunk.coreRange.end],
      [chunk.contextRange.start, chunk.contextRange.end],
      chunk.overlapBefore
        ? [chunk.overlapBefore.start, chunk.overlapBefore.end]
        : null,
      chunk.overlapAfter
        ? [chunk.overlapAfter.start, chunk.overlapAfter.end]
        : null,
      chunk.coreCharCount,
      chunk.contextCharCount,
    ]),
    totalChars: chunkedNovel.totalChars,
  };
  const input = JSON.stringify([novel, salt, frozenSnapshot]);
  let first = 0x811c9dc5;
  let second = 0x9e3779b9;
  for (let index = 0; index < input.length; index++) {
    const code = input.charCodeAt(index);
    first = Math.imul(first ^ code, 0x01000193);
    second = Math.imul(second ^ code, 0x85ebca6b);
  }
  return `swb3_${(first >>> 0).toString(16).padStart(8, "0")}${(second >>> 0)
    .toString(16)
    .padStart(8, "0")}`;
}
