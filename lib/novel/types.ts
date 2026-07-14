import type { NumberedParagraph } from "../screenplay/paragraphs";

export interface ParagraphRange {
  start: number;
  end: number;
}

export interface NovelChapter {
  id: string;
  index: number;
  title: string;
  paragraphRange: ParagraphRange;
  charCount: number;
  kind?: Exclude<StructureHeadingRole, "toc"> | "fallback";
  headingParagraph?: number;
}

export type HeadingLevelHint = "volume" | "chapter" | "section" | "unknown";

export type HeadingSignal =
  | "explicit_volume"
  | "explicit_chapter"
  | "explicit_section"
  | "markdown"
  | "bracketed"
  | "special_heading"
  | "numbered_short_line"
  | "repeated_later"
  | "likely_toc";

export interface HeadingContextSnippet {
  paragraph: number;
  text: string;
}

export interface HeadingCandidateEvidence {
  paragraph: number;
  text: string;
  normalizedText: string;
  levelHint: HeadingLevelHint;
  signals: HeadingSignal[];
  charsSincePreviousCandidate: number | null;
  charsUntilNextCandidate: number | null;
  duplicateParagraphs: number[];
  duplicateCount?: number;
  contextBefore?: HeadingContextSnippet;
  contextAfter?: HeadingContextSnippet;
}

export type StructureHeadingRole =
  | "front_matter"
  | "volume"
  | "chapter"
  | "section"
  | "back_matter"
  | "toc";

export interface ModelStructureHeading {
  headingParagraph: number;
  role: StructureHeadingRole;
  decision: "selected" | "uncertain";
}

export interface ChapterStructureModelOutput {
  headings: ModelStructureHeading[];
}

export interface ValidatedStructureHeading {
  headingParagraph: number;
  title: string;
  role: StructureHeadingRole;
  parentHeadingParagraph?: number;
}

export type ChapterStructureStatus = "resolved" | "partial" | "fallback";

export type ChapterStructureIssueCode =
  | "invalid_model_output"
  | "unknown_candidate"
  | "duplicate_heading"
  | "candidate_limit_exceeded"
  | "likely_toc_as_body"
  | "broken_hierarchy"
  | "uncertain_heading"
  | "no_usable_boundary";

export interface ChapterStructureIssue {
  code: ChapterStructureIssueCode;
  severity: "error" | "warning";
  paragraphs: number[];
  message: string;
}

export interface ValidatedChapterStructure {
  status: ChapterStructureStatus;
  headings: ValidatedStructureHeading[];
  primaryBoundaries: number[];
  splitHints: number[];
  tocParagraphs: number[];
  issues: ChapterStructureIssue[];
}

export interface NovelChunk {
  id: string;
  index: number;
  chapterIds: string[];
  chapterRanges: Array<{ chapterId: string; paragraphRange: ParagraphRange }>;
  coreRange: ParagraphRange;
  contextRange: ParagraphRange;
  overlapBefore?: ParagraphRange;
  overlapAfter?: ParagraphRange;
  coreCharCount: number;
  contextCharCount: number;
}

export interface ChunkedNovel {
  paragraphs: NumberedParagraph[];
  chapters: NovelChapter[];
  chunks: NovelChunk[];
  totalChars: number;
}

export interface ChunkNovelOptions {
  targetChars?: number;
  overlapChars?: number;
}

export interface ChapterPackOptions extends ChunkNovelOptions {
  splitHints?: number[];
}

export const LONG_NOVEL_LIMITS = {
  singleFileChars: 500_000,
  projectChars: 2_000_000,
  maxFileBytes: 10 * 1024 * 1024,
  targetChunkChars: 25_000,
  overlapChars: 800,
} as const;
