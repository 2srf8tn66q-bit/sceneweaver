import {
  splitParagraphs,
  toNumberedText,
  type NumberedParagraph,
} from "../screenplay/paragraphs";
import {
  LONG_NOVEL_LIMITS,
  type ChapterPackOptions,
  type ChunkedNovel,
  type ChunkNovelOptions,
  type NovelChapter,
  type NovelChunk,
  type ParagraphRange,
} from "./types";

const CHAPTER_HEADING = /^(?:第[零〇一二三四五六七八九十百千万两\d]+[章回节卷部篇](?:$|[\s：:·、—-].*)|[零〇一二三四五六七八九十百千万两]{1,8}、\s*\S.*|(?:chapter|part)\s+[\divxlcdm]+(?:$|[\s：:·、—-].*)|序章|序言|前言|楔子|尾声|后记|番外.*)$/i;
const WHITESPACE_CHARACTER = /\s/u;

interface CoreUnit {
  chapterId: string;
  range: ParagraphRange;
  charCount: number;
}

interface CoreChunk {
  chapterIds: string[];
  range: ParagraphRange;
  charCount: number;
}

export function countTextChars(text: string): number {
  let count = 0;
  for (const character of text) {
    if (!WHITESPACE_CHARACTER.test(character)) count += 1;
  }
  return count;
}

/** 模型请求预算按真实 Unicode 字符计算，空白同样占用上下文。 */
export function countPromptChars(text: string): number {
  let count = 0;
  for (let index = 0; index < text.length; count += 1) {
    const codePoint = text.codePointAt(index)!;
    index += codePoint > 0xffff ? 2 : 1;
  }
  return count;
}

/** 与实际传给模型的 `toNumberedText` 完全同口径。 */
export function countNumberedParagraphChars(
  paragraphs: NumberedParagraph[],
): number {
  return paragraphs.reduce(
    (sum, paragraph, index) =>
      sum +
      countPromptChars(paragraph.text) +
      countPromptChars(`¶${paragraph.n} `) +
      (index > 0 ? 1 : 0),
    0,
  );
}

const SENTENCE_BOUNDARY = /[。！？!?；;]/u;

/**
 * 尽量在句末切开文本；单句本身超预算时，按 Unicode 字符硬切。
 * 所有返回片段按顺序拼接后与输入完全一致。
 */
export function splitTextByBudget(text: string, maxChars: number): string[] {
  if (maxChars <= 0) throw new Error("maxChars 必须大于 0");
  if (countPromptChars(text) <= maxChars) return [text];

  const parts: string[] = [];
  let start = 0;

  while (start < text.length) {
    let usedChars = 0;
    let lastSentenceEnd = -1;
    let cursor = start;

    while (cursor < text.length) {
      const codePoint = text.codePointAt(cursor)!;
      const character = String.fromCodePoint(codePoint);
      if (usedChars + 1 > maxChars) break;
      usedChars += 1;
      cursor += character.length;
      if (SENTENCE_BOUNDARY.test(character)) lastSentenceEnd = cursor;
    }

    if (cursor === text.length) {
      parts.push(text.slice(start));
      break;
    }

    const end = lastSentenceEnd > start ? lastSentenceEnd : cursor;
    if (end <= start) {
      const codePoint = text.codePointAt(start)!;
      const character = String.fromCodePoint(codePoint);
      parts.push(character);
      start += character.length;
    } else {
      parts.push(text.slice(start, end));
      start = end;
    }
  }

  return parts;
}

function splitOversizedParagraphs(
  paragraphs: NumberedParagraph[],
  targetChars: number,
  overlapChars: number,
): NumberedParagraph[] {
  const totalPromptChars = paragraphs.reduce(
    (sum, paragraph) => sum + countPromptChars(paragraph.text),
    0,
  );
  const maxParagraphDigits = String(
    Math.max(1, paragraphs.length, totalPromptChars),
  ).length;
  const maxNumberPrefixChars = maxParagraphDigits + 2; // ¶ + 段号 + 空格
  const coreTextBudget = targetChars - maxNumberPrefixChars;
  if (coreTextBudget <= 0 && paragraphs.some((paragraph) => paragraph.text.length > 0)) {
    throw new Error("targetChars 太小，无法容纳编号段落");
  }
  const overlapTextBudget = overlapChars - maxNumberPrefixChars;
  const longParagraphPieceChars =
    overlapTextBudget > 0
      ? Math.min(coreTextBudget, overlapTextBudget)
      : coreTextBudget;
  const texts = paragraphs.flatMap((paragraph) => {
    const paragraphChars = countPromptChars(paragraph.text);
    const needsOverlapAtoms =
      overlapTextBudget > 0 &&
      paragraphChars > overlapTextBudget &&
      paragraphChars >= 256;
    return paragraphChars > coreTextBudget || needsOverlapAtoms
      ? splitTextByBudget(paragraph.text, longParagraphPieceChars)
      : [paragraph.text];
  });
  const numbered = texts.map((text, index) => ({ n: index + 1, text }));
  for (const paragraph of numbered) {
    if (countNumberedParagraphChars([paragraph]) > targetChars) {
      throw new Error(`¶${paragraph.n} 加入段号后超过核心硬上限`);
    }
  }
  return numbered;
}

function resolveChunkOptions(options: ChunkNovelOptions) {
  const targetChars = options.targetChars ?? LONG_NOVEL_LIMITS.targetChunkChars;
  const overlapChars = options.overlapChars ?? LONG_NOVEL_LIMITS.overlapChars;
  if (!Number.isFinite(targetChars) || !Number.isInteger(targetChars) || targetChars <= 0) {
    throw new Error("targetChars 必须大于 0 且为有限整数");
  }
  if (
    !Number.isFinite(overlapChars) ||
    !Number.isInteger(overlapChars) ||
    overlapChars < 0
  ) {
    throw new Error("overlapChars 不能小于 0，且必须为有限整数");
  }
  return { targetChars, overlapChars };
}

export function validateNovelInput(novel: string) {
  const characters = countTextChars(novel);
  if (characters > LONG_NOVEL_LIMITS.singleFileChars) {
    throw new Error(
      `单个小说文件最多 ${LONG_NOVEL_LIMITS.singleFileChars} 个非空白字符`,
    );
  }
  let bytes = 0;
  for (const character of novel) {
    const codePoint = character.codePointAt(0)!;
    bytes += codePoint <= 0x7f
      ? 1
      : codePoint <= 0x7ff
        ? 2
        : codePoint <= 0xffff
          ? 3
          : 4;
    if (bytes > LONG_NOVEL_LIMITS.maxFileBytes) break;
  }
  if (bytes > LONG_NOVEL_LIMITS.maxFileBytes) {
    throw new Error(
      `单个小说文件最大 ${LONG_NOVEL_LIMITS.maxFileBytes} 字节`,
    );
  }
}

export function prepareNovelParagraphs(
  novel: string,
  options: ChunkNovelOptions = {},
): NumberedParagraph[] {
  validateNovelInput(novel);
  const { targetChars, overlapChars } = resolveChunkOptions(options);
  return splitOversizedParagraphs(
    splitParagraphs(novel),
    targetChars,
    overlapChars,
  );
}

export function isChapterHeading(text: string): boolean {
  const trimmed = text.trim();
  return trimmed.length > 0 && trimmed.length <= 80 && CHAPTER_HEADING.test(trimmed);
}

function paragraphsInRange(
  paragraphs: NumberedParagraph[],
  range: ParagraphRange,
): NumberedParagraph[] {
  return paragraphs.filter((p) => p.n >= range.start && p.n <= range.end);
}

function countParagraphs(paragraphs: NumberedParagraph[]): number {
  return countNumberedParagraphChars(paragraphs);
}

function countRange(paragraphs: NumberedParagraph[], range: ParagraphRange): number {
  return countParagraphs(paragraphsInRange(paragraphs, range));
}

export function splitNovelChapters(paragraphs: NumberedParagraph[]): NovelChapter[] {
  if (paragraphs.length === 0) return [];

  const headingIndexes = paragraphs
    .map((p, index) => (isChapterHeading(p.text) ? index : -1))
    .filter((index) => index >= 0);

  const raw: Array<{ title: string; startIndex: number; endIndex: number }> = [];
  if (headingIndexes.length === 0) {
    raw.push({ title: "正文", startIndex: 0, endIndex: paragraphs.length - 1 });
  } else {
    if (headingIndexes[0] > 0) {
      raw.push({ title: "开篇", startIndex: 0, endIndex: headingIndexes[0] - 1 });
    }
    headingIndexes.forEach((startIndex, i) => {
      raw.push({
        title: paragraphs[startIndex].text,
        startIndex,
        endIndex: (headingIndexes[i + 1] ?? paragraphs.length) - 1,
      });
    });
  }

  return raw.map((chapter, index) => {
    const range = {
      start: paragraphs[chapter.startIndex].n,
      end: paragraphs[chapter.endIndex].n,
    };
    return {
      id: `chapter_${String(index + 1).padStart(3, "0")}`,
      index,
      title: chapter.title,
      paragraphRange: range,
      charCount: countRange(paragraphs, range),
    };
  });
}

function splitChapterIntoUnits(
  chapter: NovelChapter,
  paragraphs: NumberedParagraph[],
  targetChars: number,
  splitHints: number[],
): CoreUnit[] {
  if (chapter.charCount <= targetChars) {
    return [{ chapterId: chapter.id, range: chapter.paragraphRange, charCount: chapter.charCount }];
  }

  const units: CoreUnit[] = [];
  const semanticBoundaries = [
    chapter.paragraphRange.start,
    ...splitHints.filter(
      (paragraph) =>
        paragraph > chapter.paragraphRange.start &&
        paragraph <= chapter.paragraphRange.end,
    ),
  ].sort((left, right) => left - right);

  for (let boundaryIndex = 0; boundaryIndex < semanticBoundaries.length; boundaryIndex++) {
    const semanticRange = {
      start: semanticBoundaries[boundaryIndex],
      end:
        (semanticBoundaries[boundaryIndex + 1] ?? chapter.paragraphRange.end + 1) - 1,
    };
    const semanticChars = countRange(paragraphs, semanticRange);
    if (semanticChars <= targetChars) {
      units.push({ chapterId: chapter.id, range: semanticRange, charCount: semanticChars });
      continue;
    }

    const semanticParagraphs = paragraphsInRange(paragraphs, semanticRange);
    let start = semanticParagraphs[0]?.n;
    let end = start;
    let chars = 0;
    for (const paragraph of semanticParagraphs) {
      const paragraphChars = countNumberedParagraphChars([paragraph]);
      const addedChars = chars > 0 ? paragraphChars + 1 : paragraphChars;
      if (chars > 0 && chars + addedChars > targetChars) {
        units.push({
          chapterId: chapter.id,
          range: { start: start!, end: end! },
          charCount: chars,
        });
        start = paragraph.n;
        chars = 0;
      }
      end = paragraph.n;
      chars += chars > 0 ? paragraphChars + 1 : paragraphChars;
    }
    if (start !== undefined && end !== undefined) {
      units.push({ chapterId: chapter.id, range: { start, end }, charCount: chars });
    }
  }
  return units;
}

function combineUnits(units: CoreUnit[], targetChars: number): CoreChunk[] {
  const chunks: CoreChunk[] = [];
  let current: CoreChunk | null = null;

  for (const unit of units) {
    if (current && current.charCount + 1 + unit.charCount > targetChars) {
      chunks.push(current);
      current = null;
    }
    if (!current) {
      current = {
        chapterIds: [unit.chapterId],
        range: { ...unit.range },
        charCount: unit.charCount,
      };
      continue;
    }
    current.range.end = unit.range.end;
    current.charCount += unit.charCount + 1;
    if (!current.chapterIds.includes(unit.chapterId)) current.chapterIds.push(unit.chapterId);
  }

  if (current) chunks.push(current);
  return chunks;
}

function expandBefore(
  paragraphs: NumberedParagraph[],
  coreStart: number,
  overlapChars: number,
): ParagraphRange | undefined {
  const index = paragraphs.findIndex((p) => p.n === coreStart);
  let chars = 0;
  let start = coreStart;
  for (let i = index - 1; i >= 0; i--) {
    const paragraphChars = countNumberedParagraphChars([paragraphs[i]]);
    const addedChars = chars > 0 ? paragraphChars + 1 : paragraphChars;
    if (chars + addedChars > overlapChars) break;
    start = paragraphs[i].n;
    chars += addedChars;
  }
  return start < coreStart ? { start, end: coreStart - 1 } : undefined;
}

function expandAfter(
  paragraphs: NumberedParagraph[],
  coreEnd: number,
  overlapChars: number,
): ParagraphRange | undefined {
  const index = paragraphs.findIndex((p) => p.n === coreEnd);
  let chars = 0;
  let end = coreEnd;
  for (let i = index + 1; i < paragraphs.length; i++) {
    const paragraphChars = countNumberedParagraphChars([paragraphs[i]]);
    const addedChars = chars > 0 ? paragraphChars + 1 : paragraphChars;
    if (chars + addedChars > overlapChars) break;
    end = paragraphs[i].n;
    chars += addedChars;
  }
  return end > coreEnd ? { start: coreEnd + 1, end } : undefined;
}

export function chunkNovel(
  novel: string,
  options: ChunkNovelOptions = {},
): ChunkedNovel {
  const paragraphs = prepareNovelParagraphs(novel, options);
  const chapters = splitNovelChapters(paragraphs);
  return chunkPreparedNovel(paragraphs, chapters, options);
}

function assertChapterCoverage(
  paragraphs: NumberedParagraph[],
  chapters: NovelChapter[],
  targetChars: number,
) {
  if (paragraphs.length === 0) {
    if (chapters.length > 0) throw new Error("空文本不应包含章节");
    return;
  }
  if (chapters.length === 0) throw new Error("章节表不能为空");
  const paragraphNumbers = new Set(paragraphs.map((paragraph) => paragraph.n));
  const chapterIds = new Set<string>();
  paragraphs.forEach((paragraph, index) => {
    if (paragraph.n !== index + 1) throw new Error("段号必须从 1 开始连续递增");
    if (countNumberedParagraphChars([paragraph]) > targetChars) {
      throw new Error(`¶${paragraph.n} 超过核心硬上限，请先调用 prepareNovelParagraphs`);
    }
  });
  let expectedStart = paragraphs[0].n;
  for (const chapter of chapters) {
    if (chapterIds.has(chapter.id)) throw new Error(`章节 id 重复：${chapter.id}`);
    chapterIds.add(chapter.id);
    if (
      !Number.isInteger(chapter.paragraphRange.start) ||
      !Number.isInteger(chapter.paragraphRange.end) ||
      !paragraphNumbers.has(chapter.paragraphRange.start) ||
      !paragraphNumbers.has(chapter.paragraphRange.end)
    ) {
      throw new Error(`章节 ${chapter.id} 的范围端点必须是真实整数段号`);
    }
    if (chapter.paragraphRange.start !== expectedStart) {
      throw new Error(`章节范围不连续：期待从 ¶${expectedStart} 开始`);
    }
    if (chapter.paragraphRange.end < chapter.paragraphRange.start) {
      throw new Error(`章节 ${chapter.id} 的范围无效`);
    }
    if (chapter.paragraphRange.end > paragraphs.at(-1)!.n) {
      throw new Error(`章节 ${chapter.id} 越过原文末尾`);
    }
    const actualChars = countRange(paragraphs, chapter.paragraphRange);
    if (chapter.charCount !== actualChars) {
      throw new Error(`章节 ${chapter.id} 的字符数与原文不一致`);
    }
    expectedStart = chapter.paragraphRange.end + 1;
  }
  if (expectedStart !== paragraphs.at(-1)!.n + 1) {
    throw new Error(`章节表未覆盖到原文末尾 ¶${paragraphs.at(-1)!.n}`);
  }
}

export function chunkPreparedNovel(
  paragraphs: NumberedParagraph[],
  chapters: NovelChapter[],
  options: ChapterPackOptions = {},
): ChunkedNovel {
  const { targetChars, overlapChars } = resolveChunkOptions(options);
  assertChapterCoverage(paragraphs, chapters, targetChars);
  const splitHints = [...new Set(options.splitHints ?? [])].sort(
    (left, right) => left - right,
  );
  const paragraphNumbers = new Set(paragraphs.map((paragraph) => paragraph.n));
  for (const hint of splitHints) {
    if (!Number.isInteger(hint) || !paragraphNumbers.has(hint)) {
      throw new Error(`切分提示 ${hint} 不是真实整数段号`);
    }
  }
  const units = chapters.flatMap((chapter) =>
    splitChapterIntoUnits(chapter, paragraphs, targetChars, splitHints),
  );
  const cores = combineUnits(units, targetChars);
  for (const core of cores) {
    const actualChars = countRange(paragraphs, core.range);
    if (actualChars !== core.charCount || actualChars > targetChars) {
      throw new Error(
        `核心范围 ¶${core.range.start}—¶${core.range.end} 与实际字数不一致或超出硬上限`,
      );
    }
  }
  const chunks: NovelChunk[] = cores.map((core, index) => {
    const overlapBefore = expandBefore(paragraphs, core.range.start, overlapChars);
    const overlapAfter = expandAfter(paragraphs, core.range.end, overlapChars);
    const contextRange = {
      start: overlapBefore?.start ?? core.range.start,
      end: overlapAfter?.end ?? core.range.end,
    };
    const chapterRanges = chapters
      .filter(
        (chapter) =>
          core.chapterIds.includes(chapter.id) &&
          chapter.paragraphRange.start <= core.range.end &&
          chapter.paragraphRange.end >= core.range.start,
      )
      .map((chapter) => ({
        chapterId: chapter.id,
        paragraphRange: {
          start: Math.max(chapter.paragraphRange.start, core.range.start),
          end: Math.min(chapter.paragraphRange.end, core.range.end),
        },
      }));
    return {
      id: `chunk_${String(index + 1).padStart(3, "0")}`,
      index,
      chapterIds: core.chapterIds,
      chapterRanges,
      coreRange: core.range,
      contextRange,
      overlapBefore,
      overlapAfter,
      coreCharCount: core.charCount,
      contextCharCount:
        core.charCount +
        (overlapBefore ? countRange(paragraphs, overlapBefore) : 0) +
        (overlapAfter ? countRange(paragraphs, overlapAfter) : 0),
    };
  });

  return {
    paragraphs,
    chapters,
    chunks,
    totalChars: paragraphs.reduce(
      (sum, paragraph) => sum + countTextChars(paragraph.text),
      0,
    ),
  };
}

export function renderNovelChunk(
  paragraphs: NumberedParagraph[],
  chunk: NovelChunk,
): string {
  const parts: string[] = [];
  if (chunk.overlapBefore) {
    parts.push(
      "【重叠上文：只用于理解衔接，不重复提取事实】",
      toNumberedText(paragraphsInRange(paragraphs, chunk.overlapBefore)),
    );
  }
  parts.push(
    "【核心文本：本次只对这个区间提取事实】",
    toNumberedText(paragraphsInRange(paragraphs, chunk.coreRange)),
  );
  if (chunk.overlapAfter) {
    parts.push(
      "【重叠下文：只用于理解衔接，不重复提取事实】",
      toNumberedText(paragraphsInRange(paragraphs, chunk.overlapAfter)),
    );
  }
  return parts.join("\n");
}
