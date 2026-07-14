import type { ChatMessage } from "../llm/types";
import { renderNovelChunk } from "../novel/chunking";
import type { ChunkedNovel, NovelChunk } from "../novel/types";
import { fingerprintStorySource } from "./fingerprint";
import { createEmptyStoryBible, mergeStoryBible } from "./merge";
import { buildStoryBibleMessages } from "./prompts";
import type { StoryBible } from "./types";
import { parseStoryBibleDelta } from "./validate";

export type StoryBibleCall = (
  messages: ChatMessage[],
  signal?: AbortSignal,
) => Promise<string>;

export interface StoryBibleProgress {
  stage: "understanding" | "complete";
  completed: number;
  total: number;
  chunkId?: string;
  message: string;
}

export interface StoryBiblePipelineOptions {
  /** 必须同时标识模型、prompt 与输出 schema 版本。 */
  checkpointIdentity: string;
  initialBible?: StoryBible;
  signal?: AbortSignal;
  onLog?: (message: string) => void;
  onProgress?: (progress: StoryBibleProgress) => void;
  onCheckpoint?: (bible: StoryBible, chunk: NovelChunk) => void | Promise<void>;
}

export interface StoryBiblePipelineResult {
  bible: StoryBible;
  chunkedNovel: ChunkedNovel;
  completedChunks: number;
}

export class StoryBiblePipelineError extends Error {
  constructor(
    message: string,
    public readonly failedChunk: NovelChunk,
    public readonly completedBible: StoryBible,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "StoryBiblePipelineError";
  }
}

function pendingChunks(chunked: ChunkedNovel, bible: StoryBible): NovelChunk[] {
  if (!bible.processedRange) return chunked.chunks;
  const checkpointIndex = chunked.chunks.findIndex(
    (chunk) =>
      chunk.coreRange.end === bible.processedRange?.end &&
      bible.processedRange.start === chunked.chunks[0]?.coreRange.start,
  );
  if (checkpointIndex < 0) {
    throw new Error("Story Bible 检查点不在当前小说的文本块边界上");
  }
  const checkpointChunk = chunked.chunks[checkpointIndex];
  if (
    !bible.boundaryState ||
    bible.boundaryState.chunkId !== checkpointChunk.id ||
    bible.boundaryState.asOfParagraph !== checkpointChunk.coreRange.end
  ) {
    throw new Error("Story Bible 检查点缺少对应文本块的边界状态");
  }
  return chunked.chunks.slice(checkpointIndex + 1);
}

function ensureNextChunkIsContinuous(bible: StoryBible, chunk: NovelChunk) {
  const expectedStart = (bible.processedRange?.end ?? 0) + 1;
  if (chunk.coreRange.start !== expectedStart) {
    throw new Error(
      `Story Bible 衔接断裂：期待从 ¶${expectedStart} 开始，实际是 ¶${chunk.coreRange.start}`,
    );
  }
}

export async function buildRollingStoryBibleFromChunks(
  novel: string,
  chunkedNovel: ChunkedNovel,
  call: StoryBibleCall,
  options: StoryBiblePipelineOptions,
): Promise<StoryBiblePipelineResult> {
  if (
    !options ||
    typeof options.checkpointIdentity !== "string" ||
    options.checkpointIdentity.trim().length === 0
  ) {
    throw new Error("checkpointIdentity 必须标识模型、prompt 与 schema 版本");
  }
  if (
    novel.trim().length === 0 ||
    chunkedNovel.paragraphs.length === 0 ||
    chunkedNovel.chapters.length === 0 ||
    chunkedNovel.chunks.length === 0
  ) {
    throw new Error("冻结长篇小说不能为空");
  }
  const sourceFingerprint = fingerprintStorySource(
    novel,
    chunkedNovel,
    `rolling-v4:${options.checkpointIdentity.trim()}`,
  );
  if (
    options.initialBible &&
    options.initialBible.sourceFingerprint !== sourceFingerprint
  ) {
    throw new Error("Story Bible 检查点不属于当前小说或当前分块配置");
  }
  let bible = options.initialBible ?? createEmptyStoryBible(sourceFingerprint);
  const chunks = pendingChunks(chunkedNovel, bible);
  const alreadyCompleted = chunkedNovel.chunks.length - chunks.length;
  const log = options.onLog ?? (() => {});
  const progress = options.onProgress ?? (() => {});

  for (let index = 0; index < chunks.length; index++) {
    const chunk = chunks[index];
    const completedBefore = alreadyCompleted + index;
    const startedAt = Date.now();

    try {
      if (options.signal?.aborted) throw new Error("Story Bible 任务已取消");
      ensureNextChunkIsContinuous(bible, chunk);
      progress({
        stage: "understanding",
        completed: completedBefore,
        total: chunkedNovel.chunks.length,
        chunkId: chunk.id,
        message: `正在理解第 ${completedBefore + 1}/${chunkedNovel.chunks.length} 块`,
      });
      if (options.signal?.aborted) throw new Error("Story Bible 任务已取消");
      log(
        `${chunk.id} 开始：核心 ¶${chunk.coreRange.start}—¶${chunk.coreRange.end}，上下文 ¶${chunk.contextRange.start}—¶${chunk.contextRange.end}`,
      );
      if (options.signal?.aborted) throw new Error("Story Bible 任务已取消");
      const chunkText = renderNovelChunk(chunkedNovel.paragraphs, chunk);
      const raw = await call(
        buildStoryBibleMessages(chunkText, chunk, bible),
        options.signal,
      );
      if (options.signal?.aborted) throw new Error("Story Bible 任务已取消");
      const delta = parseStoryBibleDelta(raw, bible, chunk);
      const nextBible = mergeStoryBible(bible, delta, chunk);
      await options.onCheckpoint?.(nextBible, chunk);
      bible = nextBible;
      log(
        `${chunk.id} 完成 ${Date.now() - startedAt}ms：${delta.characters.length} 人物 / ${delta.newFacts.length} 事实 / ${delta.reportedConflicts.length} 冲突`,
      );
      progress({
        stage: "understanding",
        completed: completedBefore + 1,
        total: chunkedNovel.chunks.length,
        chunkId: chunk.id,
        message: `已完成第 ${completedBefore + 1}/${chunkedNovel.chunks.length} 块`,
      });
    } catch (error) {
      throw new StoryBiblePipelineError(
        `${chunk.id} 理解失败：${error instanceof Error ? error.message : "未知错误"}`,
        chunk,
        bible,
        { cause: error },
      );
    }
  }

  progress({
    stage: "complete",
    completed: chunkedNovel.chunks.length,
    total: chunkedNovel.chunks.length,
    message: "Story Bible 理解完成",
  });
  return { bible, chunkedNovel, completedChunks: chunkedNovel.chunks.length };
}
