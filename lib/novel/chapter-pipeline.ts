import {
  chunkPreparedNovel,
  prepareNovelParagraphs,
} from "./chunking";
import {
  materializeNovelChapters,
  recognizeChapterStructure,
  type ChapterStructureCall,
  type RecognizeChapterStructureOptions,
} from "./structure";
import type {
  ChapterPackOptions,
  ChunkedNovel,
  HeadingCandidateEvidence,
  ValidatedChapterStructure,
} from "./types";

export interface ChapterFirstChunkingOptions
  extends ChapterPackOptions,
    RecognizeChapterStructureOptions {}

export interface ChapterFirstChunkingResult {
  chunkedNovel: ChunkedNovel;
  candidates: HeadingCandidateEvidence[];
  structure: ValidatedChapterStructure;
  inputMode: "full_text" | "candidate_evidence";
}

/**
 * 结构识别与分块共用同一份编号段落，避免两次切分造成段号偏移。
 */
export async function buildChapterFirstChunks(
  novel: string,
  call: ChapterStructureCall,
  options: ChapterFirstChunkingOptions = {},
): Promise<ChapterFirstChunkingResult> {
  const paragraphs = prepareNovelParagraphs(novel, options);
  if (paragraphs.length === 0) throw new Error("长篇小说不能为空");
  const recognized = await recognizeChapterStructure(paragraphs, call, {
    shortNovelChars: options.shortNovelChars,
    signal: options.signal,
  });
  const chapters = materializeNovelChapters(paragraphs, recognized.structure);
  const chunkedNovel = chunkPreparedNovel(paragraphs, chapters, {
    targetChars: options.targetChars,
    overlapChars: options.overlapChars,
    splitHints: recognized.structure.splitHints,
  });
  return {
    chunkedNovel,
    candidates: recognized.candidates,
    structure: recognized.structure,
    inputMode: recognized.inputMode,
  };
}
