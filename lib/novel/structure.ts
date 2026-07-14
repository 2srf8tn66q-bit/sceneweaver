import { extractJSON } from "../llm/json";
import type { ChatMessage } from "../llm/types";
import { toNumberedText, type NumberedParagraph } from "../screenplay/paragraphs";
import { countNumberedParagraphChars, countTextChars } from "./chunking";
import type {
  ChapterStructureIssue,
  ChapterStructureModelOutput,
  HeadingCandidateEvidence,
  HeadingLevelHint,
  HeadingSignal,
  ModelStructureHeading,
  NovelChapter,
  StructureHeadingRole,
  ValidatedChapterStructure,
  ValidatedStructureHeading,
} from "./types";

const CHINESE_NUMBER =
  "零〇一二三四五六七八九十百千万两壹貳叁肆伍陸柒捌玖拾佰仟萬廿卅卌";
const ENGLISH_NUMBER =
  "(?:\\d+|[ivxlcdm]+|[a-z]+(?:[-\\s][a-z]+){0,3})";
const SPECIAL_HEADING = /^(?:序章|序言|前言|楔子|引子|尾声|後記|后记|番外|prologue|epilogue|preface|foreword|afterword)(?:$|[\s：:].*)/iu;
const MAX_STRONG_HEADING_CANDIDATES = 5_000;
const MAX_WEAK_HEADING_CANDIDATES = 1_200;
export const MAX_STRUCTURE_EVIDENCE_CHARS = 300_000;
export const MAX_STRUCTURE_USER_MESSAGE_CHARS =
  MAX_STRUCTURE_EVIDENCE_CHARS + 1_000;
const CHINESE_VOLUME_HEADING = new RegExp(
  `^(?:第[${CHINESE_NUMBER}\\d]+卷|卷[${CHINESE_NUMBER}\\d]+)`,
  "u",
);
const CHINESE_CHAPTER_HEADING = new RegExp(
  `^第[${CHINESE_NUMBER}\\d]+(?:章|回|篇|部)`,
  "u",
);
const CHINESE_SECTION_HEADING = new RegExp(
  `^第[${CHINESE_NUMBER}\\d]+节`,
  "u",
);
const CHINESE_NUMBERED_HEADING = new RegExp(
  `^[${CHINESE_NUMBER}]{1,8}[、.]​*\\S`,
  "u",
);
const ARABIC_NUMBERED_HEADING = /^\d{1,4}[.．、]\s*\S/u;
const ENGLISH_VOLUME_HEADING = new RegExp(
  `^(?:part|book|volume)\\s+${ENGLISH_NUMBER}\\b`,
  "iu",
);
const ENGLISH_CHAPTER_HEADING = new RegExp(
  `^chapter\\s+${ENGLISH_NUMBER}\\b`,
  "iu",
);
const ENGLISH_SECTION_HEADING = new RegExp(
  `^section\\s+${ENGLISH_NUMBER}\\b`,
  "iu",
);
const STRUCTURE_ROLES = new Set<StructureHeadingRole>([
  "front_matter",
  "volume",
  "chapter",
  "section",
  "back_matter",
  "toc",
]);

export type ChapterStructureCall = (
  messages: ChatMessage[],
  signal?: AbortSignal,
) => Promise<string>;

export interface RecognizeChapterStructureOptions {
  shortNovelChars?: number;
  signal?: AbortSignal;
}

export interface RecognizedChapterStructure {
  inputMode: "full_text" | "candidate_evidence";
  candidates: HeadingCandidateEvidence[];
  structure: ValidatedChapterStructure;
}

export interface HeadingCandidateCounts {
  strong: number;
  weak: number;
  total: number;
}

function addSignal(signals: HeadingSignal[], signal: HeadingSignal) {
  if (!signals.includes(signal)) signals.push(signal);
}

function unwrapHeading(text: string): {
  display: string;
  markdown: boolean;
  bracketed: boolean;
} {
  let display = text.trim().normalize("NFKC");
  const markdown = /^#{1,6}(?:\s|$)/u.test(display);
  if (markdown) display = display.replace(/^#{1,6}\s*/u, "");

  const bold = display.match(/^(?:\*\*|__)(.+)(?:\*\*|__)$/u);
  if (bold) display = bold[1].trim();

  let bracketed = false;
  const brackets = display.match(/^[【\[]\s*([^】\]]+)\s*[】\]]\s*(.*)$/u);
  if (brackets) {
    bracketed = true;
    display = `${brackets[1]} ${brackets[2]}`.trim();
  }
  return { display: display.replace(/\s+/gu, " "), markdown, bracketed };
}

function classifyCandidate(text: string): {
  normalizedText: string;
  levelHint: HeadingLevelHint;
  signals: HeadingSignal[];
} | null {
  const { display, markdown, bracketed } = unwrapHeading(text);
  const normalizedText = display.toLocaleLowerCase().replace(/\s+/gu, "");
  const compact = display.replace(/\s+/gu, "");
  const signals: HeadingSignal[] = [];
  if (markdown) addSignal(signals, "markdown");
  if (bracketed) addSignal(signals, "bracketed");

  let levelHint: HeadingLevelHint = "unknown";
  if (CHINESE_VOLUME_HEADING.test(compact) || ENGLISH_VOLUME_HEADING.test(display)) {
    levelHint = "volume";
    addSignal(signals, "explicit_volume");
  } else if (
    CHINESE_CHAPTER_HEADING.test(compact) ||
    ENGLISH_CHAPTER_HEADING.test(display)
  ) {
    levelHint = "chapter";
    addSignal(signals, "explicit_chapter");
  } else if (
    CHINESE_SECTION_HEADING.test(compact) ||
    ENGLISH_SECTION_HEADING.test(display)
  ) {
    levelHint = "section";
    addSignal(signals, "explicit_section");
  } else if (SPECIAL_HEADING.test(display)) {
    addSignal(signals, "special_heading");
  } else if (
    CHINESE_NUMBERED_HEADING.test(compact) ||
    ARABIC_NUMBERED_HEADING.test(display)
  ) {
    addSignal(signals, "numbered_short_line");
  }

  if (signals.length === 0 || countTextChars(display) > 160) return null;
  return { normalizedText, levelHint, signals };
}

function snippet(paragraph: NumberedParagraph | undefined) {
  if (!paragraph) return undefined;
  return {
    paragraph: paragraph.n,
    text: Array.from(paragraph.text).slice(0, 80).join(""),
  };
}

export function countHeadingCandidateMatches(
  paragraphs: NumberedParagraph[],
): HeadingCandidateCounts {
  let strongCount = 0;
  let weakCount = 0;
  for (const paragraph of paragraphs) {
    const classified = classifyCandidate(paragraph.text);
    if (!classified) continue;
    if (classified.signals.some((signal) => signal !== "numbered_short_line")) {
      strongCount += 1;
    } else {
      weakCount += 1;
    }
  }
  return {
    strong: strongCount,
    weak: weakCount,
    total: strongCount + weakCount,
  };
}

export function collectHeadingCandidates(
  paragraphs: NumberedParagraph[],
): HeadingCandidateEvidence[] {
  const { strong: strongCount, weak: weakCount } =
    countHeadingCandidateMatches(paragraphs);
  const sampledOrdinals = (total: number, limit: number) => {
    const selected = new Set<number>();
    const count = Math.min(total, limit);
    if (count <= 0) return selected;
    if (count === 1) {
      selected.add(0);
      return selected;
    }
    for (let index = 0; index < count; index++) {
      selected.add(Math.round((index * (total - 1)) / (count - 1)));
    }
    return selected;
  };
  const selectedStrong = sampledOrdinals(
    strongCount,
    MAX_STRONG_HEADING_CANDIDATES,
  );
  const selectedWeak = sampledOrdinals(
    weakCount,
    MAX_WEAK_HEADING_CANDIDATES,
  );
  const initial: HeadingCandidateEvidence[] = [];
  const candidateIndexes = new Map<number, number>();
  let strongOrdinal = 0;
  let weakOrdinal = 0;
  paragraphs.forEach((paragraph, index) => {
    const classified = classifyCandidate(paragraph.text);
    if (!classified) return;
    const strong = classified.signals.some(
      (signal) => signal !== "numbered_short_line",
    );
    const ordinal = strong ? strongOrdinal++ : weakOrdinal++;
    if (!(strong ? selectedStrong : selectedWeak).has(ordinal)) return;
    initial.push({
      paragraph: paragraph.n,
      text: paragraph.text,
      normalizedText: classified.normalizedText,
      levelHint: classified.levelHint,
      signals: [...classified.signals],
      charsSincePreviousCandidate: null,
      charsUntilNextCandidate: null,
      duplicateParagraphs: [],
      contextBefore: snippet(paragraphs[index - 1]),
      contextAfter: snippet(paragraphs[index + 1]),
    });
    candidateIndexes.set(paragraph.n, index);
  });

  const duplicateStats = new Map<
    string,
    { count: number; firstParagraphs: number[]; lastParagraph: number }
  >();
  for (const candidate of initial) {
    duplicateStats.set(candidate.normalizedText, {
      count: 0,
      firstParagraphs: [],
      lastParagraph: candidate.paragraph,
    });
  }
  for (const paragraph of paragraphs) {
    const classified = classifyCandidate(paragraph.text);
    if (!classified) continue;
    const stats = duplicateStats.get(classified.normalizedText);
    if (!stats) continue;
    stats.count += 1;
    if (stats.firstParagraphs.length < 3) stats.firstParagraphs.push(paragraph.n);
    stats.lastParagraph = paragraph.n;
  }

  const prefixChars = [0];
  for (const paragraph of paragraphs) {
    prefixChars.push(prefixChars.at(-1)! + countTextChars(paragraph.text));
  }
  const charsBetween = (leftParagraph: number, rightParagraph: number) => {
    const leftIndex = candidateIndexes.get(leftParagraph);
    const rightIndex = candidateIndexes.get(rightParagraph);
    if (leftIndex === undefined || rightIndex === undefined || rightIndex <= leftIndex + 1) {
      return 0;
    }
    return prefixChars[rightIndex] - prefixChars[leftIndex + 1];
  };
  const earlyLimit = Math.max(20, Math.ceil(paragraphs.length * 0.15));
  return initial.map((candidate, index) => {
    const previous = initial[index - 1];
    const next = initial[index + 1];
    const stats = duplicateStats.get(candidate.normalizedText)!;
    const duplicateParagraphs = [
      ...stats.firstParagraphs,
      stats.lastParagraph,
    ].flatMap((paragraph) =>
      paragraph !== undefined && paragraph !== candidate.paragraph ? [paragraph] : [],
    );
    const limitedDuplicates = [...new Set(duplicateParagraphs)].slice(0, 4);
    const laterDuplicate = stats.lastParagraph > candidate.paragraph;
    const charsUntilNextCandidate = next
      ? charsBetween(candidate.paragraph, next.paragraph)
      : null;
    const signals = [...candidate.signals];
    if (laterDuplicate) addSignal(signals, "repeated_later");
    if (
      laterDuplicate &&
      candidate.paragraph <= earlyLimit &&
      charsUntilNextCandidate !== null &&
      charsUntilNextCandidate < 400
    ) {
      addSignal(signals, "likely_toc");
    }
    return {
      ...candidate,
      signals,
      duplicateParagraphs: limitedDuplicates,
      duplicateCount: Math.max(0, stats.count - 1),
      charsSincePreviousCandidate: previous
        ? charsBetween(previous.paragraph, candidate.paragraph)
        : null,
      charsUntilNextCandidate,
    };
  });
}

function fallbackStructure(issue: ChapterStructureIssue): ValidatedChapterStructure {
  return {
    status: "fallback",
    headings: [],
    primaryBoundaries: [],
    splitHints: [],
    tocParagraphs: [],
    issues: [issue],
  };
}

function invalidOutput(message: string): ValidatedChapterStructure {
  return fallbackStructure({
    code: "invalid_model_output",
    severity: "error",
    paragraphs: [],
    message,
  });
}

function parseModelOutput(raw: string): ChapterStructureModelOutput | null {
  try {
    const parsed = JSON.parse(extractJSON(raw)) as unknown;
    if (!parsed || typeof parsed !== "object") return null;
    const headings = (parsed as { headings?: unknown }).headings;
    if (!Array.isArray(headings)) return null;
    for (const heading of headings) {
      if (!heading || typeof heading !== "object") return null;
      const item = heading as Partial<ModelStructureHeading>;
      if (
        !Number.isInteger(item.headingParagraph) ||
        typeof item.role !== "string" ||
        !STRUCTURE_ROLES.has(item.role as StructureHeadingRole) ||
        (item.decision !== "selected" && item.decision !== "uncertain")
      ) {
        return null;
      }
    }
    return { headings: headings as ModelStructureHeading[] };
  } catch {
    return null;
  }
}

export function parseAndValidateChapterStructure(
  raw: string,
  paragraphs: NumberedParagraph[],
  candidates: HeadingCandidateEvidence[],
): ValidatedChapterStructure {
  const parsed = parseModelOutput(raw);
  if (!parsed) return invalidOutput("模型返回不是合法的章节结构 JSON");

  const seen = new Set<number>();
  for (const heading of parsed.headings) {
    if (seen.has(heading.headingParagraph)) {
      return fallbackStructure({
        code: "duplicate_heading",
        severity: "error",
        paragraphs: [heading.headingParagraph],
        message: `模型重复选择了 ¶${heading.headingParagraph}`,
      });
    }
    seen.add(heading.headingParagraph);
  }

  const candidateByParagraph = new Map(
    candidates.map((candidate) => [candidate.paragraph, candidate]),
  );
  const unknown = parsed.headings.find(
    (heading) => !candidateByParagraph.has(heading.headingParagraph),
  );
  if (unknown) {
    return fallbackStructure({
      code: "unknown_candidate",
      severity: "error",
      paragraphs: [unknown.headingParagraph],
      message: `模型选择了不存在的标题候选 ¶${unknown.headingParagraph}`,
    });
  }

  const issues: ChapterStructureIssue[] = [];
  const tocParagraphs: number[] = [];
  const selected: ModelStructureHeading[] = [];
  for (const heading of [...parsed.headings].sort(
    (left, right) => left.headingParagraph - right.headingParagraph,
  )) {
    if (heading.decision === "uncertain") {
      issues.push({
        code: "uncertain_heading",
        severity: "warning",
        paragraphs: [heading.headingParagraph],
        message: `不确定候选 ¶${heading.headingParagraph} 不作为正式边界`,
      });
      continue;
    }
    if (heading.role === "toc") {
      tocParagraphs.push(heading.headingParagraph);
      continue;
    }
    selected.push(heading);
  }

  const headings: ValidatedStructureHeading[] = [];
  let currentVolume: number | undefined;
  let currentChapter: number | undefined;
  let bodyHasStarted = false;
  for (const heading of selected) {
    let parentHeadingParagraph: number | undefined;
    if (heading.role === "volume") {
      currentVolume = heading.headingParagraph;
      currentChapter = undefined;
      bodyHasStarted = true;
    } else if (heading.role === "chapter") {
      parentHeadingParagraph = currentVolume;
      currentChapter = heading.headingParagraph;
      bodyHasStarted = true;
    } else if (heading.role === "section") {
      parentHeadingParagraph = currentChapter ?? currentVolume;
      bodyHasStarted = true;
    } else if (heading.role === "front_matter" && bodyHasStarted) {
      issues.push({
        code: "broken_hierarchy",
        severity: "warning",
        paragraphs: [heading.headingParagraph],
        message: `正文开始后的 ¶${heading.headingParagraph} 不能再作为前置内容`,
      });
      continue;
    }
    headings.push({
      headingParagraph: heading.headingParagraph,
      title: candidateByParagraph.get(heading.headingParagraph)!.text,
      role: heading.role,
      ...(parentHeadingParagraph ? { parentHeadingParagraph } : {}),
    });
  }

  const chapters = headings.filter((heading) => heading.role === "chapter");
  const sections = headings.filter((heading) => heading.role === "section");
  const mainBoundaries = chapters.length > 0 ? chapters : sections;
  const containerBoundaries = headings.filter((heading) => heading.role === "volume");
  const edgeBoundaries = headings.filter(
    (heading) => heading.role === "front_matter" || heading.role === "back_matter",
  );
  const primaryBoundaries = [...containerBoundaries, ...mainBoundaries, ...edgeBoundaries]
    .map((heading) => heading.headingParagraph)
    .sort((left, right) => left - right);
  const splitHints = chapters.length > 0
    ? sections.map((heading) => heading.headingParagraph)
    : [];

  if (primaryBoundaries.length === 0) {
    return {
      status: "fallback",
      headings,
      primaryBoundaries: [],
      splitHints: [],
      tocParagraphs: tocParagraphs.sort((left, right) => left - right),
      issues: [
        ...issues,
        {
          code: "no_usable_boundary",
          severity: "warning",
          paragraphs: [],
          message: "没有可靠的正文结构边界，将按字数安全分块",
        },
      ],
    };
  }

  return {
    status: issues.length > 0 ? "partial" : "resolved",
    headings,
    primaryBoundaries,
    splitHints,
    tocParagraphs: tocParagraphs.sort((left, right) => left - right),
    issues,
  };
}

export function materializeNovelChapters(
  paragraphs: NumberedParagraph[],
  structure: ValidatedChapterStructure,
): NovelChapter[] {
  if (paragraphs.length === 0) return [];

  if (structure.status === "fallback" || structure.primaryBoundaries.length === 0) {
    return [
      {
        id: "chapter_001",
        index: 0,
        title: "正文",
        kind: "fallback",
        paragraphRange: { start: paragraphs[0].n, end: paragraphs.at(-1)!.n },
        charCount: countNumberedParagraphChars(paragraphs),
      },
    ];
  }

  const headingByParagraph = new Map(
    structure.headings.map((heading) => [heading.headingParagraph, heading]),
  );
  const boundaries = [...new Set(structure.primaryBoundaries)].sort(
    (left, right) => left - right,
  );
  const rawRanges: Array<{
    title: string;
    kind: NovelChapter["kind"];
    headingParagraph?: number;
    start: number;
    end: number;
  }> = [];
  if (boundaries[0] > paragraphs[0].n) {
    rawRanges.push({
      title: "开篇",
      kind: "front_matter",
      start: paragraphs[0].n,
      end: boundaries[0] - 1,
    });
  }
  boundaries.forEach((boundary, index) => {
    const heading = headingByParagraph.get(boundary)!;
    rawRanges.push({
      title: heading.title,
      kind: heading.role === "toc" ? "fallback" : heading.role,
      headingParagraph: boundary,
      start: boundary,
      end: (boundaries[index + 1] ?? paragraphs.at(-1)!.n + 1) - 1,
    });
  });

  return rawRanges.map((range, index) => ({
    id: `chapter_${String(index + 1).padStart(3, "0")}`,
    index,
    title: range.title,
    kind: range.kind,
    ...(range.headingParagraph ? { headingParagraph: range.headingParagraph } : {}),
    paragraphRange: { start: range.start, end: range.end },
    charCount: countNumberedParagraphChars(
      paragraphs.filter(
        (paragraph) => paragraph.n >= range.start && paragraph.n <= range.end,
      ),
    ),
  }));
}

const SIGNAL_BITS: Record<HeadingSignal, number> = {
  explicit_volume: 1,
  explicit_chapter: 2,
  explicit_section: 4,
  markdown: 8,
  bracketed: 16,
  special_heading: 32,
  numbered_short_line: 64,
  repeated_later: 128,
  likely_toc: 256,
};

const LEVEL_CODES: Record<HeadingLevelHint, string> = {
  volume: "v",
  chapter: "c",
  section: "s",
  unknown: "u",
};

type SerializedEvidenceRow = Array<
  string | number | null | number[]
>;

export interface SerializedCandidateEvidencePage {
  evidence: string;
  candidateParagraphs: number[];
}

function compactEvidenceText(text: string, maxChars: number): string {
  const collapsed = text.trim().replace(/\s+/gu, " ");
  const characters = Array.from(collapsed);
  if (characters.length <= maxChars) return collapsed;
  return `${characters.slice(0, Math.max(1, maxChars - 1)).join("")}…`;
}

function signalMask(signals: HeadingSignal[]): number {
  return signals.reduce((mask, signal) => mask | SIGNAL_BITS[signal], 0);
}

function evidenceRow(
  candidate: HeadingCandidateEvidence,
  includeText: boolean,
  includeContext: boolean,
): SerializedEvidenceRow {
  const row: SerializedEvidenceRow = [
    candidate.paragraph,
    ...(includeText ? [compactEvidenceText(candidate.text, 160)] : []),
    LEVEL_CODES[candidate.levelHint],
    signalMask(candidate.signals),
    candidate.charsSincePreviousCandidate,
    candidate.charsUntilNextCandidate,
    candidate.duplicateParagraphs,
    candidate.duplicateCount ?? 0,
  ];
  if (includeContext) {
    row.push(
      candidate.contextBefore?.paragraph ?? null,
      candidate.contextBefore
        ? compactEvidenceText(candidate.contextBefore.text, 80)
        : "",
      candidate.contextAfter?.paragraph ?? null,
      candidate.contextAfter
        ? compactEvidenceText(candidate.contextAfter.text, 80)
        : "",
    );
  }
  return row;
}

function evidenceDocument(
  rows: SerializedEvidenceRow[],
  totalCandidates: number,
  retainedCandidates: number,
  page: number,
  pageCount: number,
  includeText: boolean,
  includeContext: boolean,
): string {
  const schema = [
    "paragraph",
    ...(includeText ? ["text"] : []),
    "levelCode",
    "signalMask",
    "charsSincePreviousCandidate",
    "charsUntilNextCandidate",
    "duplicateParagraphs",
    "duplicateCount",
    ...(includeContext
      ? [
          "contextBeforeParagraph",
          "contextBeforeText",
          "contextAfterParagraph",
          "contextAfterText",
        ]
      : []),
  ];
  return JSON.stringify({
    totalCandidates,
    retainedCandidates,
    includedCandidates: rows.length,
    page,
    pageCount,
    sampled: retainedCandidates < totalCandidates,
    schema,
    levelCodes: { v: "volume", c: "chapter", s: "section", u: "unknown" },
    signalBits: SIGNAL_BITS,
    items: rows,
  });
}

function serializeEvidenceRows(
  rows: SerializedEvidenceRow[],
  totalCandidates: number,
  retainedCandidates: number,
  includeText: boolean,
  includeContext: boolean,
): string[] {
  const single = evidenceDocument(
    rows,
    totalCandidates,
    retainedCandidates,
    1,
    1,
    includeText,
    includeContext,
  );
  if (single.length <= MAX_STRUCTURE_EVIDENCE_CHARS) return [single];

  // 元数据远小于 4K；预留固定空间后按已转义 JSON 行长度线性装页，
  // 避免为每个候选反复 stringify 整页造成 O(n²)。
  const itemBudget = MAX_STRUCTURE_EVIDENCE_CHARS - 4_096;
  const pages: SerializedEvidenceRow[][] = [];
  let current: SerializedEvidenceRow[] = [];
  let currentChars = 2;
  for (const row of rows) {
    const rowChars = JSON.stringify(row).length;
    if (rowChars > itemBudget) {
      throw new Error("单条章节候选证据超过硬上限");
    }
    const separatorChars = current.length > 0 ? 1 : 0;
    if (current.length > 0 && currentChars + separatorChars + rowChars > itemBudget) {
      pages.push(current);
      current = [];
      currentChars = 2;
    }
    current.push(row);
    currentChars += (current.length > 1 ? 1 : 0) + rowChars;
  }
  if (current.length > 0 || pages.length === 0) pages.push(current);

  return pages.map((pageRows, index) => {
    const evidence = evidenceDocument(
      pageRows,
      totalCandidates,
      retainedCandidates,
      index + 1,
      pages.length,
      includeText,
      includeContext,
    );
    if (evidence.length > MAX_STRUCTURE_EVIDENCE_CHARS) {
      throw new Error("章节候选证据分页仍超过硬上限");
    }
    return evidence;
  });
}

/**
 * 每个已保留候选恰好进入一个证据页；超预算时分页，绝不再次抽样。
 * 全文已随请求提供时省略候选文字和上下文，段号仍与编号全文一一对应。
 */
export function serializeCandidateEvidencePages(
  candidates: HeadingCandidateEvidence[],
  fullTextAvailable = false,
  totalCandidates = candidates.length,
): SerializedCandidateEvidencePage[] {
  const includeText = !fullTextAvailable;
  const richRows = candidates.map((candidate) =>
    evidenceRow(candidate, includeText, !fullTextAvailable),
  );
  let documents = serializeEvidenceRows(
    richRows,
    totalCandidates,
    candidates.length,
    includeText,
    !fullTextAvailable,
  );

  // 长篇候选过多时优先去掉前后短摘录，保留标题、距离、重复位置和全部候选。
  if (!fullTextAvailable && documents.length > 1) {
    const compactRows = candidates.map((candidate) =>
      evidenceRow(candidate, true, false),
    );
    documents = serializeEvidenceRows(
      compactRows,
      totalCandidates,
      candidates.length,
      true,
      false,
    );
  }

  let offset = 0;
  return documents.map((evidence) => {
    const parsed = JSON.parse(evidence) as { includedCandidates: number };
    const included = candidates.slice(offset, offset + parsed.includedCandidates);
    offset += parsed.includedCandidates;
    return {
      evidence,
      candidateParagraphs: included.map((candidate) => candidate.paragraph),
    };
  });
}

export interface ChapterStructureMessageBatch {
  inputMode: RecognizedChapterStructure["inputMode"];
  messages: ChatMessage[];
  candidateParagraphs: number[];
}

export function buildChapterStructureMessageBatches(
  paragraphs: NumberedParagraph[],
  candidates: HeadingCandidateEvidence[],
  shortNovelChars = 30_000,
): ChapterStructureMessageBatch[] {
  const totalChars = paragraphs.reduce(
    (sum, paragraph) => sum + countTextChars(paragraph.text),
    0,
  );
  const system = `你是小说结构识别器。标题正则只提供候选，不代表真实章节。
你只能从当前证据页列出的真实候选段号中选择，不得输出其他页候选，不得输出标题文字、章节 ID 或起止范围。
区分正文标题、目录重复项和章内编号清单。有卷、章、节时保留层级；无法确定时用 uncertain，不要猜。
证据使用数组 schema；levelCode 和 signalMask 的含义在证据 JSON 中给出。
只输出 JSON：{"headings":[{"headingParagraph":1,"role":"volume|chapter|section|front_matter|back_matter|toc","decision":"selected|uncertain"}]}`;
  const detectedCandidateCount = countHeadingCandidateMatches(paragraphs).total;
  const buildForMode = (
    inputMode: RecognizedChapterStructure["inputMode"],
  ): ChapterStructureMessageBatch[] => {
    const pages = serializeCandidateEvidencePages(
      candidates,
      inputMode === "full_text",
      detectedCandidateCount,
    );
    const numberedText = inputMode === "full_text" ? toNumberedText(paragraphs) : "";
    return pages.map((page) => {
      const source = inputMode === "full_text"
        ? `编号全文：\n${numberedText}\n\n当前标题候选证据页：\n${page.evidence}`
        : `长篇模式：你看到的是当前页标题候选、候选间字数和重复位置，不是全文。只判断本页候选。\n${page.evidence}`;
      return {
        inputMode,
        candidateParagraphs: page.candidateParagraphs,
        messages: [
          { role: "system", content: system },
          { role: "user", content: source },
        ],
      };
    });
  };

  if (totalChars <= shortNovelChars) {
    const fullTextBatches = buildForMode("full_text");
    if (
      fullTextBatches.every(
        (batch) =>
          batch.messages[1].content.length <= MAX_STRUCTURE_USER_MESSAGE_CHARS,
      )
    ) {
      return fullTextBatches;
    }
  }
  const candidateBatches = buildForMode("candidate_evidence");
  if (
    candidateBatches.some(
      (batch) => batch.messages[1].content.length > MAX_STRUCTURE_USER_MESSAGE_CHARS,
    )
  ) {
    throw new Error("章节结构请求超过硬上限");
  }
  return candidateBatches;
}

export function buildChapterStructureMessages(
  paragraphs: NumberedParagraph[],
  candidates: HeadingCandidateEvidence[],
  shortNovelChars = 30_000,
): { inputMode: RecognizedChapterStructure["inputMode"]; messages: ChatMessage[] } {
  const [first] = buildChapterStructureMessageBatches(
    paragraphs,
    candidates,
    shortNovelChars,
  );
  return {
    inputMode: first.inputMode,
    messages: first.messages,
  };
}

export async function recognizeChapterStructure(
  paragraphs: NumberedParagraph[],
  call: ChapterStructureCall,
  options: RecognizeChapterStructureOptions = {},
): Promise<RecognizedChapterStructure> {
  if (options.signal?.aborted) throw new Error("章节结构识别已取消");
  const candidates = collectHeadingCandidates(paragraphs);
  const requests = buildChapterStructureMessageBatches(
    paragraphs,
    candidates,
    options.shortNovelChars,
  );
  const detectedCandidateCount = countHeadingCandidateMatches(paragraphs).total;
  if (detectedCandidateCount > candidates.length) {
    return {
      inputMode: requests[0].inputMode,
      candidates,
      structure: fallbackStructure({
        code: "candidate_limit_exceeded",
        severity: "warning",
        paragraphs: [],
        message: `标题候选共 ${detectedCandidateCount} 个，超过安全保留上限；不以抽样结果生成正式章节`,
      }),
    };
  }
  const responses = await Promise.all(
    requests.map(async (request) => {
      if (options.signal?.aborted) throw new Error("章节结构识别已取消");
      return call(request.messages, options.signal);
    }),
  );
  if (options.signal?.aborted) throw new Error("章节结构识别已取消");

  const mergedHeadings: ModelStructureHeading[] = [];
  for (let index = 0; index < responses.length; index += 1) {
    const parsed = parseModelOutput(responses[index]);
    if (!parsed) {
      return {
        inputMode: requests[0].inputMode,
        candidates,
        structure: invalidOutput(`第 ${index + 1} 页模型返回不是合法的章节结构 JSON`),
      };
    }
    const allowed = new Set(requests[index].candidateParagraphs);
    const outOfPage = parsed.headings.find(
      (heading) => !allowed.has(heading.headingParagraph),
    );
    if (outOfPage) {
      return {
        inputMode: requests[0].inputMode,
        candidates,
        structure: fallbackStructure({
          code: "unknown_candidate",
          severity: "error",
          paragraphs: [outOfPage.headingParagraph],
          message: `第 ${index + 1} 页模型选择了不在本页的候选 ¶${outOfPage.headingParagraph}`,
        }),
      };
    }
    mergedHeadings.push(...parsed.headings);
  }
  return {
    inputMode: requests[0].inputMode,
    candidates,
    structure: parseAndValidateChapterStructure(
      JSON.stringify({ headings: mergedHeadings }),
      paragraphs,
      candidates,
    ),
  };
}
