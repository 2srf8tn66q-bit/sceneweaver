import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { serverChatDetailed, type ServerChatUsage } from "../llm/serverCall";
import type { ChatMessage, LLMConfig } from "../llm/types";
import { buildChapterFirstChunks } from "../novel/chapter-pipeline";
import {
  buildParallelStoryBibleFromChunks,
  ParallelStoryBibleError,
  type ParallelStoryBibleStage,
} from "./parallel";
import {
  buildRollingStoryBibleFromChunks,
  StoryBiblePipelineError,
} from "./pipeline";
import type { StoryBible } from "./types";

const enabled =
  process.env.RUN_STORY_BIBLE_DEEPSEEK === "1" &&
  Boolean(process.env.DEEPSEEK_API_KEY);

type ExperimentRoute = "structure" | "rolling" | "parallel";
type ExperimentStage = "chapter_structure" | "rolling_chunk" | ParallelStoryBibleStage;

interface CallMetric {
  requestId: number;
  route: ExperimentRoute;
  stage: ExperimentStage;
  chunkIds: string[];
  coreChars: number;
  contextChars: number;
  promptChars: number;
  durationMs: number;
  usage?: ServerChatUsage;
  error?: string;
}

function errorSummary(error: unknown) {
  return error instanceof Error
    ? { name: error.name, message: error.message }
    : error
      ? { name: "Unknown", message: String(error) }
      : null;
}

function bibleSummary(bible: StoryBible | undefined) {
  if (!bible) return null;
  return {
    version: bible.version,
    processedRange: bible.processedRange,
    characters: bible.characters.length,
    facts: bible.facts.length,
    timelineEvents: bible.timeline.length,
    openThreads: bible.threads.filter((thread) => thread.status === "open").length,
    openConflicts: bible.conflicts.filter((conflict) => conflict.status === "open").length,
  };
}

function usageSummary(metrics: CallMetric[]) {
  const values = metrics.flatMap((metric) => (metric.usage ? [metric.usage] : []));
  const sum = (field: keyof ServerChatUsage) => {
    const numbers = values.flatMap((usage) =>
      typeof usage[field] === "number" ? [usage[field]] : [],
    );
    return numbers.length > 0
      ? numbers.reduce((total, value) => total + value, 0)
      : undefined;
  };
  return {
    inputTokens: sum("inputTokens"),
    outputTokens: sum("outputTokens"),
    totalTokens: sum("totalTokens"),
  };
}

function normalizedNames(bible: StoryBible | undefined) {
  if (!bible) return new Set<string>();
  return new Set(
    bible.characters.flatMap((character) =>
      [character.name, ...character.aliases]
        .map((name) => name.trim().toLocaleLowerCase().replace(/\s+/g, ""))
        .filter(Boolean),
    ),
  );
}

function nameComparison(rolling: StoryBible | undefined, parallel: StoryBible | undefined) {
  const rollingNames = normalizedNames(rolling);
  const parallelNames = normalizedNames(parallel);
  return {
    shared: [...rollingNames].filter((name) => parallelNames.has(name)).sort(),
    rollingOnly: [...rollingNames].filter((name) => !parallelNames.has(name)).sort(),
    parallelOnly: [...parallelNames].filter((name) => !rollingNames.has(name)).sort(),
  };
}

function assertNoConfirmedNameDrift(bible: StoryBible) {
  const confirmedNameOwners = new Map<string, string>();
  for (const character of bible.characters.filter(
    (item) => (item.identityStatus ?? "confirmed") === "confirmed",
  )) {
    for (const name of [character.name, ...character.aliases]) {
      const normalized = name.trim().toLocaleLowerCase().replace(/\s+/g, "");
      const existing = confirmedNameOwners.get(normalized);
      expect(
        existing === undefined || existing === character.id,
        `称谓「${name}」漂移到多个已确认人物 id`,
      ).toBe(true);
      confirmedNameOwners.set(normalized, character.id);
    }
  }
}

describe.skipIf(!enabled)("真实 DeepSeek · 三章 rolling/parallel 资格赛", () => {
  it(
    "同一冻结分块各跑一次并留下可复核对照产物",
    async () => {
      const samplePath = process.env.STORY_BIBLE_SAMPLE_PATH;
      const model = process.env.DEEPSEEK_MODEL;
      if (!samplePath) throw new Error("缺少 STORY_BIBLE_SAMPLE_PATH");
      if (!model) {
        throw new Error("缺少 DEEPSEEK_MODEL，请填写设置页中已验证的模型 ID");
      }

      const novel = await readFile(samplePath, "utf8");
      const chunkOptions = { targetChars: 8_000, overlapChars: 800 } as const;
      const config: LLMConfig = {
        provider: "deepseek",
        baseUrl: process.env.DEEPSEEK_BASE_URL ?? "https://api.deepseek.com/v1",
        apiKey: process.env.DEEPSEEK_API_KEY!,
        model,
      };
      const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
      const outputDir = path.join("/tmp/sceneweaver-story-bible-eval", timestamp);
      await mkdir(outputDir, { recursive: true });

      const metrics: CallMetric[] = [];
      let requestSequence = 0;
      const frozenChunks = new Map<
        string,
        { coreCharCount: number; contextCharCount: number }
      >();
      const callModel = async ({
        route,
        stage,
        chunkIds,
        messages,
        signal,
        maxTokens,
      }: {
        route: ExperimentRoute;
        stage: ExperimentStage;
        chunkIds: string[];
        messages: ChatMessage[];
        signal?: AbortSignal;
        maxTokens: number;
      }) => {
        const requestId = ++requestSequence;
        const relevantChunks = chunkIds.flatMap((chunkId) => {
          const chunk = frozenChunks.get(chunkId);
          return chunk ? [chunk] : [];
        });
        const baseMetric = {
          requestId,
          route,
          stage,
          chunkIds,
          coreChars: relevantChunks.reduce((sum, chunk) => sum + chunk.coreCharCount, 0),
          contextChars: relevantChunks.reduce(
            (sum, chunk) => sum + chunk.contextCharCount,
            0,
          ),
          promptChars: messages.reduce(
            (sum, message) => sum + message.content.length,
            0,
          ),
        };
        const startedAt = Date.now();
        try {
          const response = await serverChatDetailed(config, messages, {
            signal,
            timeoutMs: 240_000,
            maxTokens,
          });
          const metric: CallMetric = {
            ...baseMetric,
            durationMs: Date.now() - startedAt,
            usage: response.usage,
          };
          metrics.push(metric);
          await writeFile(
            path.join(
              outputDir,
              `${String(requestId).padStart(3, "0")}-${route}-${stage}.raw.txt`,
            ),
            response.content,
            "utf8",
          );
          return response.content;
        } catch (error) {
          metrics.push({
            ...baseMetric,
            durationMs: Date.now() - startedAt,
            error: errorSummary(error)?.message ?? "未知错误",
          });
          throw error;
        }
      };

      const structureStartedAt = Date.now();
      const chaptered = await buildChapterFirstChunks(
        novel,
        (messages, signal) =>
          callModel({
            route: "structure",
            stage: "chapter_structure",
            chunkIds: [],
            messages,
            signal,
            maxTokens: 4_096,
          }),
        chunkOptions,
      );
      const structureWallMs = Date.now() - structureStartedAt;
      const frozen = chaptered.chunkedNovel;
      for (const chunk of frozen.chunks) frozenChunks.set(chunk.id, chunk);
      expect(frozen.chapters).toHaveLength(3);
      expect(frozen.chunks).toHaveLength(3);
      await writeFile(
        path.join(outputDir, "frozen-chunks.json"),
        JSON.stringify(frozen, null, 2),
        "utf8",
      );

      const rollingLogs: string[] = [];
      let rollingBible: StoryBible | undefined;
      let rollingFailure: unknown;
      let rollingCallIndex = 0;
      let rollingFirstResultMs: number | undefined;
      const rollingStartedAt = Date.now();
      try {
        const result = await buildRollingStoryBibleFromChunks(
          novel,
          frozen,
          async (messages, signal) => {
            const chunk = frozen!.chunks[rollingCallIndex++];
            const raw = await callModel({
              route: "rolling",
              stage: "rolling_chunk",
              chunkIds: [chunk.id],
              messages,
              signal,
              maxTokens: 8_192,
            });
            rollingFirstResultMs ??= Date.now() - rollingStartedAt;
            return raw;
          },
          {
            checkpointIdentity: `deepseek:${model}:rolling-prompt-v4:schema-v1`,
            onLog: (message) => rollingLogs.push(message),
            onCheckpoint: async (bible, chunk) => {
              await writeFile(
                path.join(outputDir, `rolling-${chunk.id}.bible.json`),
                JSON.stringify(bible, null, 2),
                "utf8",
              );
            },
          },
        );
        rollingBible = result.bible;
      } catch (error) {
        rollingFailure = error;
        if (error instanceof StoryBiblePipelineError) {
          rollingBible = error.completedBible;
        }
      }
      const rollingWallMs = Date.now() - rollingStartedAt;

      const parallelProgress: Array<{
        stage: string;
        completed: number;
        total: number;
        chunkId?: string;
      }> = [];
      let parallelBible: StoryBible | undefined;
      let parallelFailure: unknown;
      let parallelStats: {
        mapCalls: number;
        reconcileCalls: number;
        repairCalls: number;
      } | undefined;
      let parallelFirstResultMs: number | undefined;
      const parallelStartedAt = Date.now();
      try {
        const result = await buildParallelStoryBibleFromChunks(
          novel,
          frozen,
          async (request, signal) => {
            const raw = await callModel({
              route: "parallel",
              stage: request.stage,
              chunkIds: request.chunkIds,
              messages: request.messages,
              signal,
              maxTokens: 8_192,
            });
            if (request.stage === "local_extract") {
              parallelFirstResultMs ??= Date.now() - parallelStartedAt;
            }
            return raw;
          },
          {
            checkpointIdentity: `deepseek:${model}:parallel-prompt-v4:schema-v1`,
            concurrency: 5,
            onProgress: (progress) => parallelProgress.push(progress),
            onLocalCheckpoint: async (checkpoint, chunk) => {
              await writeFile(
                path.join(outputDir, `parallel-${chunk.id}.checkpoint.json`),
                JSON.stringify(checkpoint, null, 2),
                "utf8",
              );
            },
          },
        );
        parallelBible = result.bible;
        parallelStats = result.stats;
        await writeFile(
          path.join(outputDir, "parallel-final.bible.json"),
          JSON.stringify(result.bible, null, 2),
          "utf8",
        );
      } catch (error) {
        parallelFailure = error;
        if (error instanceof ParallelStoryBibleError) {
          await writeFile(
            path.join(outputDir, "parallel-failed.checkpoint.json"),
            JSON.stringify(error.checkpoint, null, 2),
            "utf8",
          );
        }
      }
      const parallelWallMs = Date.now() - parallelStartedAt;

      const rollingMetrics = metrics.filter((metric) => metric.route === "rolling");
      const parallelMetrics = metrics.filter((metric) => metric.route === "parallel");
      const report = {
        createdAt: new Date().toISOString(),
        qualificationRun: true,
        model,
        baseUrl: config.baseUrl,
        samplePath,
        sampleSha256: createHash("sha256").update(novel).digest("hex"),
        gitSha: execFileSync("git", ["rev-parse", "HEAD"], {
          cwd: process.cwd(),
          encoding: "utf8",
        }).trim(),
        gitDirty:
          execFileSync("git", ["status", "--short"], {
            cwd: process.cwd(),
            encoding: "utf8",
          }).trim().length > 0,
        chunkOptions,
        chapterStructure: {
          wallMs: structureWallMs,
          inputMode: chaptered.inputMode,
          issues: chaptered.structure.issues,
        },
        chapters: frozen.chapters.map((chapter) => ({
          id: chapter.id,
          title: chapter.title,
          chars: chapter.charCount,
        })),
        chunks: frozen.chunks.map((chunk) => ({
          id: chunk.id,
          coreRange: chunk.coreRange,
          contextRange: chunk.contextRange,
          coreChars: chunk.coreCharCount,
          contextChars: chunk.contextCharCount,
        })),
        rolling: {
          wallMs: rollingWallMs,
          firstResultMs: rollingFirstResultMs,
          calls: rollingMetrics.length,
          usage: usageSummary(rollingMetrics),
          result: bibleSummary(rollingBible),
          failure: errorSummary(rollingFailure),
          logs: rollingLogs,
        },
        parallel: {
          concurrency: 5,
          wallMs: parallelWallMs,
          firstResultMs: parallelFirstResultMs,
          calls: parallelMetrics.length,
          usage: usageSummary(parallelMetrics),
          stats: parallelStats,
          result: bibleSummary(parallelBible),
          failure: errorSummary(parallelFailure),
          progress: parallelProgress,
        },
        comparison: {
          names: nameComparison(rollingBible, parallelBible),
          exactPrice: null,
          exactPriceNote: "报告仅记录 API 返回的 token；未知当前模型计价时不自行估算金额。",
        },
        metrics: [...metrics].sort((left, right) => left.requestId - right.requestId),
        manualReview: [
          "华生身份、负伤、患病和归国是否跨块保持一致",
          "福尔摩斯、歇洛克等称谓是否复用同一人物 id",
          "相识、合租、验血发现、命案与 RACHE 是否有 core 原文出处",
          "章节边界 overlap 是否造成重复人物、事实或事件",
          "状态变化是否显式 supersede，冲突是否没有静默覆盖",
          "rolling 与 parallel 的人物/事实差异是真正遗漏，还是仅仅表达不同",
        ],
      };
      await writeFile(
        path.join(outputDir, "report.json"),
        JSON.stringify(report, null, 2),
        "utf8",
      );
      console.info(`[story-bible-eval] ${outputDir}`);

      if (rollingFailure) throw rollingFailure;
      if (parallelFailure) throw parallelFailure;
      expect(rollingBible).toMatchObject({
        processedRange: { start: 1, end: frozen.paragraphs.length },
        boundaryState: { chunkId: frozen.chunks.at(-1)?.id },
      });
      expect(parallelBible).toMatchObject({
        processedRange: { start: 1, end: frozen.paragraphs.length },
        boundaryState: { chunkId: frozen.chunks.at(-1)?.id },
      });
      assertNoConfirmedNameDrift(rollingBible!);
      assertNoConfirmedNameDrift(parallelBible!);
    },
    1_200_000,
  );
});
