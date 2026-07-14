import { describe, expect, it, vi } from "vitest";
import { chunkNovel } from "../novel/chunking";
import type { NovelChunk } from "../novel/types";
import {
  buildParallelStoryBibleFromChunks,
  ParallelStoryBibleError,
} from "./parallel";
import {
  sourceRef,
  THREE_CHAPTER_NOVEL,
  threeChunks,
} from "./test-helpers";

type ParallelCall = Parameters<typeof buildParallelStoryBibleFromChunks>[2];
type ParallelOptions = NonNullable<
  Parameters<typeof buildParallelStoryBibleFromChunks>[3]
>;
type ParallelCheckpoint = NonNullable<ParallelOptions["initialCheckpoint"]>;

interface LocalFixtureOptions {
  name?: string;
  aliases?: string[];
  factValue?: string;
  entryLocation?: string;
  exitLocation?: string;
}

function localFixture(
  chunk: NovelChunk,
  {
    name = `人物${chunk.index + 1}`,
    aliases = [],
    factValue,
    entryLocation = "贝克街",
    exitLocation = entryLocation,
  }: LocalFixtureOptions = {},
) {
  const entryRef = sourceRef(chunk, chunk.coreRange.start);
  const exitRef = sourceRef(chunk, chunk.coreRange.end);
  const character = {
    id: "char_001",
    name,
    aliases,
    sourceRefs: [entryRef],
  };
  const boundary = (asOfParagraph: number, location: string, atExit: boolean) => ({
    chunkId: chunk.id,
    asOfParagraph,
    location,
    characters: [
      {
        characterId: "char_001",
        location,
        knowledge: [],
        activeGoals: [],
        sourceRefs: [atExit ? exitRef : entryRef],
      },
    ],
    objects: [],
    openReferences: [],
    sourceRefs: [atExit ? exitRef : entryRef],
  });

  return {
    chunkId: chunk.id,
    coreRange: { ...chunk.coreRange },
    characters: [character],
    facts:
      factValue === undefined
        ? []
        : [
            {
              id: "fact_001",
              kind: "location",
              subjectId: "char_001",
              predicate: "current_location",
              value: factValue,
              statement: `${name}在${factValue}`,
              status: "source_fact",
              sourceRefs: [entryRef],
            },
          ],
    timelineEvents: [],
    threadObservations: [],
    entryBoundary: boundary(chunk.coreRange.start, entryLocation, false),
    exitBoundary: boundary(chunk.coreRange.end, exitLocation, true),
  };
}

function identityPlan(
  groups: Array<{
    memberIds: string[];
    canonicalName: string;
    aliases?: string[];
    decision?: "same" | "uncertain";
  }>,
) {
  return JSON.stringify({
    groups: groups.map((group) => ({
      aliases: [],
      decision: "same",
      ...group,
    })),
    objectGroups: [],
    threadGroups: [],
  });
}

function singletonIdentityPlan(chunks: NovelChunk[]) {
  return identityPlan(
    chunks.map((chunk) => ({
      memberIds: [`${chunk.id}::char_001`],
      canonicalName: `人物${chunk.index + 1}`,
    })),
  );
}

function sameHolmesIdentityPlan(chunks: NovelChunk[]) {
  return identityPlan([
    {
      memberIds: chunks.map((chunk) => `${chunk.id}::char_001`),
      canonicalName: "福尔摩斯",
      aliases: ["歇洛克"],
    },
  ]);
}

function holmesAndObjectIdentityPlan(chunks: NovelChunk[], rawObjectId: string) {
  const parsed = JSON.parse(sameHolmesIdentityPlan(chunks)) as Record<string, unknown>;
  parsed.objectGroups = [
    {
      memberIds: chunks.map((chunk) => `${chunk.id}::${rawObjectId}`),
      canonicalName: "婚戒",
      decision: "same",
    },
  ];
  return JSON.stringify(parsed);
}

function holmesAndSeparateObjectIdentityPlan(
  chunks: NovelChunk[],
  rawObjectId: string,
) {
  const parsed = JSON.parse(sameHolmesIdentityPlan(chunks)) as Record<string, unknown>;
  parsed.objectGroups = chunks.map((chunk) => ({
    memberIds: [`${chunk.id}::${rawObjectId}`],
    canonicalName: `${chunk.id}物品`,
    decision: "same",
  }));
  return JSON.stringify(parsed);
}

function sameThreadIdentityPlan(
  chunks: NovelChunk[],
  canonicalSummary = "凶手身份之谜",
) {
  const parsed = JSON.parse(singletonIdentityPlan(chunks)) as Record<string, unknown>;
  parsed.threadGroups = [
    {
      memberIds: chunks.map((chunk) => `${chunk.id}::thread_001`),
      canonicalSummary,
      decision: "same",
    },
  ];
  return JSON.stringify(parsed);
}

function makeCall({
  chunks,
  localFor,
  identity = singletonIdentityPlan(chunks),
  delayFor = () => 0,
  onIdentityRequest,
}: {
  chunks: NovelChunk[];
  localFor: (chunk: NovelChunk) => unknown;
  identity?: string;
  delayFor?: (chunk: NovelChunk) => number;
  onIdentityRequest?: (serializedRequest: string) => void;
}): ParallelCall {
  return async (request) => {
    if (request.stage === "local_extract") {
      const chunk = chunks.find((item) => item.id === request.chunkIds[0]);
      if (!chunk) throw new Error("未知文本块");
      const delay = delayFor(chunk);
      if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
      return JSON.stringify(localFor(chunk));
    }
    if (request.stage === "identity_reconcile") {
      onIdentityRequest?.(JSON.stringify(request));
      return identity;
    }
    if (request.stage === "boundary_repair") {
      return JSON.stringify({ resolutions: [] });
    }
    throw new Error(`未知阶段: ${String(request.stage)}`);
  };
}

function runParallel(
  call: ParallelCall,
  options: Omit<ParallelOptions, "checkpointIdentity"> & {
    checkpointIdentity?: string;
  } = {},
) {
  return buildParallelStoryBibleFromChunks(
    THREE_CHAPTER_NOVEL,
    chunkNovel(THREE_CHAPTER_NOVEL, { targetChars: 14, overlapChars: 7 }),
    call,
    {
      checkpointIdentity: "deepseek-v4flash:parallel-prompt-v3:schema-v1",
      concurrency: 3,
      repairBoundaries: false,
      ...options,
    },
  );
}

interface InvalidLocalSchemaCase {
  label: string;
  expected: string;
  mutate: (
    local: ReturnType<typeof localFixture>,
    chunk: NovelChunk,
  ) => unknown;
}

const invalidLocalSchemaCases: InvalidLocalSchemaCase[] = [
  {
    label: "人物 aliases 含非字符串",
    expected: "aliases 必须是字符串数组",
    mutate: (local) => ({
      ...local,
      characters: local.characters.map((character) => ({
        ...character,
        aliases: ["合法别名", 42],
      })),
    }),
  },
  {
    label: "timeline summary 为空",
    expected: "summary 不能为空",
    mutate: (local, chunk) => ({
      ...local,
      timelineEvents: [{
        id: "event_001",
        summary: "  ",
        order: 1,
        characterIds: ["char_001"],
        sourceRefs: [sourceRef(chunk)],
      }],
    }),
  },
  {
    label: "timeline order 不是正整数",
    expected: "order 必须是正整数",
    mutate: (local, chunk) => ({
      ...local,
      timelineEvents: [{
        id: "event_001",
        summary: "事件",
        order: 1.5,
        characterIds: ["char_001"],
        sourceRefs: [sourceRef(chunk)],
      }],
    }),
  },
  {
    label: "timeline characterIds 不是 string[]",
    expected: "characterIds 必须是字符串数组",
    mutate: (local, chunk) => ({
      ...local,
      timelineEvents: [{
        id: "event_001",
        summary: "事件",
        order: 1,
        characterIds: "char_001",
        sourceRefs: [sourceRef(chunk)],
      }],
    }),
  },
  {
    label: "timeline 引用未知人物",
    expected: "引用了未知人物",
    mutate: (local, chunk) => ({
      ...local,
      timelineEvents: [{
        id: "event_001",
        summary: "事件",
        order: 1,
        characterIds: ["char_404"],
        sourceRefs: [sourceRef(chunk)],
      }],
    }),
  },
  ...(["timeLabel", "location"] as const).map((field) => ({
    label: `boundary ${field} 不是字符串`,
    expected: `${field} 必须是字符串`,
    mutate: (local: ReturnType<typeof localFixture>) => ({
      ...local,
      entryBoundary: { ...local.entryBoundary, [field]: 42 },
    }),
  })),
  ...(["location", "physicalState"] as const).map((field) => ({
    label: `boundary character ${field} 不是字符串`,
    expected: `${field} 必须是字符串`,
    mutate: (local: ReturnType<typeof localFixture>) => ({
      ...local,
      entryBoundary: {
        ...local.entryBoundary,
        characters: local.entryBoundary.characters.map((character) => ({
          ...character,
          [field]: 42,
        })),
      },
    }),
  })),
  ...(["holderCharacterId", "location", "state"] as const).map((field) => ({
    label: `boundary object ${field} 不是字符串`,
    expected: `${field} 必须是字符串`,
    mutate: (local: ReturnType<typeof localFixture>, chunk: NovelChunk) => ({
      ...local,
      entryBoundary: {
        ...local.entryBoundary,
        objects: [{
          objectId: "object_001",
          [field]: 42,
          sourceRefs: [sourceRef(chunk)],
        }],
      },
    }),
  })),
  {
    label: "openReference text 为空",
    expected: "text 不能为空",
    mutate: (local, chunk) => ({
      ...local,
      entryBoundary: {
        ...local.entryBoundary,
        openReferences: [{
          text: " ",
          candidateCharacterIds: ["char_001"],
          sourceRef: sourceRef(chunk),
        }],
      },
    }),
  },
];

describe("并行 Story Bible baseline", () => {
  it("空冻结输入在模型调用前拒绝", async () => {
    const empty = chunkNovel("", { targetChars: 14, overlapChars: 7 });
    let calls = 0;
    await expect(
      buildParallelStoryBibleFromChunks(
        "",
        empty,
        async () => {
          calls += 1;
          return "";
        },
        { checkpointIdentity: "test-model:parallel-prompt-v4:schema-v1" },
      ),
    ).rejects.toThrow("不能为空");
    expect(calls).toBe(0);
  });

  it.each(invalidLocalSchemaCases)("严格拒绝$label", async ({ mutate, expected }) => {
    const chunks = threeChunks();
    await expect(
      runParallel(
        makeCall({
          chunks,
          localFor: (chunk) => mutate(localFixture(chunk), chunk),
        }),
      ),
    ).rejects.toThrow(expected);
  });

  it("局部 prompt 与严格 parser 共享完整 Schema，边界示例本身带合法出处", async () => {
    const chunks = threeChunks();
    let systemPrompt = "";
    await runParallel(async (request) => {
      if (request.stage === "local_extract") {
        systemPrompt = request.messages[0].content;
        const chunk = chunks.find((item) => item.id === request.chunkIds[0])!;
        return JSON.stringify(localFixture(chunk));
      }
      if (request.stage === "identity_reconcile") return singletonIdentityPlan(chunks);
      return JSON.stringify({ resolutions: [] });
    });

    for (const required of [
      "subjectId",
      "supersedesFactId",
      "threadObservations",
      "candidateCharacterIds",
      "source_fact/uncertain",
    ]) {
      expect(systemPrompt).toContain(required);
    }
    expect(systemPrompt).not.toContain('"sourceRefs":[]}');
  });

  it("严格遵守有界并发，不会一次启动全部文本块", async () => {
    const chunks = threeChunks();
    const releases: Array<() => void> = [];
    let active = 0;
    let maxActive = 0;
    let started = 0;

    const call: ParallelCall = async (request) => {
      if (request.stage === "identity_reconcile") {
        return singletonIdentityPlan(chunks);
      }
      if (request.stage !== "local_extract") {
        return JSON.stringify({ decision: "unresolved", sourceRefs: [] });
      }
      const chunk = chunks.find((item) => item.id === request.chunkIds[0])!;
      started++;
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise<void>((resolve) => releases.push(resolve));
      active--;
      return JSON.stringify(localFixture(chunk));
    };

    const task = runParallel(call, { concurrency: 2 });
    await vi.waitFor(() => expect(started).toBe(2));
    expect(maxActive).toBe(2);

    releases.shift()?.();
    await vi.waitFor(() => expect(started).toBe(3));
    releases.splice(0).forEach((release) => release());
    await task;

    expect(maxActive).toBe(2);
  });

  it("局部请求乱序完成时，最终 Bible 和边界问题仍完全确定", async () => {
    const chunks = threeChunks();
    const run = (delays: number[]) =>
      runParallel(
        makeCall({
          chunks,
          localFor: (chunk) => localFixture(chunk),
          delayFor: (chunk) => delays[chunk.index],
        }),
      );

    const slowFirst = await run([30, 20, 10]);
    const slowLast = await run([10, 20, 30]);

    expect(JSON.stringify(slowFirst.bible)).toBe(JSON.stringify(slowLast.bible));
    expect(JSON.stringify(slowFirst.boundaryIssues)).toBe(
      JSON.stringify(slowLast.boundaryIssues),
    );
  });

  it("三个块都返回 char_001 时先加 chunk scope，不会被误合并", async () => {
    const chunks = threeChunks();
    let reconciliationRequest = "";
    const result = await runParallel(
      makeCall({
        chunks,
        localFor: (chunk) => localFixture(chunk),
        onIdentityRequest: (request) => {
          reconciliationRequest = request;
        },
      }),
    );

    expect(reconciliationRequest).toContain("chunk_001::char_001");
    expect(reconciliationRequest).toContain("chunk_002::char_001");
    expect(reconciliationRequest).toContain("chunk_003::char_001");
    expect(result.bible.characters).toHaveLength(3);
    expect(new Set(result.bible.characters.map((character) => character.id)).size).toBe(3);
  });

  it.each([
    {
      label: "未知成员",
      groups: [
        {
          memberIds: ["chunk_001::char_001", "chunk_999::char_404"],
          canonicalName: "错误人物",
        },
        { memberIds: ["chunk_002::char_001"], canonicalName: "人物2" },
        { memberIds: ["chunk_003::char_001"], canonicalName: "人物3" },
      ],
    },
    {
      label: "遗漏成员",
      groups: [
        { memberIds: ["chunk_001::char_001"], canonicalName: "人物1" },
        { memberIds: ["chunk_002::char_001"], canonicalName: "人物2" },
      ],
    },
    {
      label: "重复成员",
      groups: [
        {
          memberIds: ["chunk_001::char_001", "chunk_002::char_001"],
          canonicalName: "同一人",
        },
        {
          memberIds: ["chunk_002::char_001", "chunk_003::char_001"],
          canonicalName: "另一人",
        },
      ],
    },
  ])("identity partition 拒绝$label", async ({ groups }) => {
    const chunks = threeChunks();
    const call = makeCall({
      chunks,
      localFor: (chunk) => localFixture(chunk),
      identity: identityPlan(groups),
    });

    await expect(runParallel(call)).rejects.toThrow();
  });

  it("同一事实键同值合并出处，不同值则保留 open conflict", async () => {
    const chunks = threeChunks();
    const sameValue = await runParallel(
      makeCall({
        chunks,
        localFor: (chunk) =>
          localFixture(chunk, {
            name: "福尔摩斯",
            aliases: ["歇洛克"],
            factValue: "贝克街",
          }),
        identity: sameHolmesIdentityPlan(chunks),
      }),
    );

    expect(sameValue.bible.facts).toHaveLength(1);
    expect(sameValue.bible.facts[0].sourceRefs).toHaveLength(3);
    expect(sameValue.bible.conflicts).toHaveLength(0);

    const differentValue = await runParallel(
      makeCall({
        chunks,
        localFor: (chunk) =>
          localFixture(chunk, {
            name: "福尔摩斯",
            factValue: chunk.index === 0 ? "贝克街" : "苏格兰场",
          }),
        identity: sameHolmesIdentityPlan(chunks),
      }),
    );

    expect(differentValue.bible.facts[0].value).toBe("贝克街");
    expect(differentValue.bible.conflicts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "fact_value",
          status: "open",
          existingFactId: differentValue.bible.facts[0].id,
        }),
      ]),
    );
  });

  it("非人物的局部 id 也先加 scope，宁可暂不跨块归一也不误合并", async () => {
    const chunks = threeChunks();
    const result = await runParallel(
      makeCall({
        chunks,
        localFor: (chunk) => {
          const base = localFixture(chunk, { name: "福尔摩斯" });
          const ref = sourceRef(chunk);
          const object = {
            objectId: "obj_001",
            state: `本块物品${chunk.index + 1}`,
            sourceRefs: [ref],
          };
          return {
            ...base,
            facts: [
              {
                id: "fact_object",
                kind: "object",
                subjectId: "obj_001",
                predicate: "state",
                value: `本块取值${chunk.index + 1}`,
                statement: "局部物品状态",
                status: "source_fact",
                sourceRefs: [ref],
              },
            ],
            entryBoundary: { ...base.entryBoundary, objects: [object] },
            exitBoundary: { ...base.exitBoundary, objects: [object] },
          };
        },
        identity: holmesAndSeparateObjectIdentityPlan(chunks, "obj_001"),
      }),
    );

    expect(result.bible.facts).toHaveLength(3);
    expect(new Set(result.bible.facts.map((fact) => fact.subjectId)).size).toBe(3);
    expect(result.boundaryIssues.some((issue) => issue.entityType === "object")).toBe(false);
  });

  it("全书 constraint 使用稳定 subject，跨块同值合并且异值显式冲突", async () => {
    const chunks = threeChunks();
    const result = await runParallel(
      makeCall({
        chunks,
        localFor: (chunk) => {
          const base = localFixture(chunk, { name: "福尔摩斯" });
          return {
            ...base,
            facts: [
              {
                id: "fact_tone",
                kind: "constraint",
                subjectId: chunk.index === 0 ? "story" : "global:story",
                predicate: "narrative_tone",
                value: chunk.index < 2 ? "noir" : "comedy",
                statement: "全书叙事语调",
                status: "source_fact",
                sourceRefs: [sourceRef(chunk)],
              },
            ],
          };
        },
        identity: sameHolmesIdentityPlan(chunks),
      }),
    );

    expect(result.bible.facts).toHaveLength(1);
    expect(result.bible.facts[0]).toMatchObject({
      subjectId: "global:story",
      value: "noir",
    });
    expect(result.bible.facts[0].sourceRefs).toHaveLength(2);
    expect(result.bible.conflicts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "fact_value",
          status: "open",
          incomingFact: expect.objectContaining({
            subjectId: "global:story",
            value: "comedy",
          }),
        }),
      ]),
    );
  });

  it("明确的物品 identity plan 能恢复跨块 holder/location/state 连续性检查", async () => {
    const chunks = threeChunks();
    const result = await runParallel(
      makeCall({
        chunks,
        localFor: (chunk) => {
          const base = localFixture(chunk, { name: "福尔摩斯" });
          const object = {
            objectId: "wedding_ring",
            state: chunk.index === 0 ? "完整" : "损坏",
            sourceRefs: [sourceRef(chunk)],
          };
          return {
            ...base,
            entryBoundary: { ...base.entryBoundary, objects: [object] },
            exitBoundary: { ...base.exitBoundary, objects: [object] },
          };
        },
        identity: holmesAndObjectIdentityPlan(chunks, "wedding_ring"),
      }),
    );

    expect(result.identityPlan.objectAssignments).toHaveLength(1);
    expect(result.boundaryIssues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          entityType: "object",
          field: "state",
          leftValue: "完整",
          rightValue: "损坏",
        }),
      ]),
    );
  });

  it("同键同值的后续确证证据会把 uncertain 升级为 source_fact", async () => {
    const chunks = threeChunks();
    const result = await runParallel(
      makeCall({
        chunks,
        localFor: (chunk) => {
          const base = localFixture(chunk, {
            name: "福尔摩斯",
            factValue: "贝克街",
          });
          return {
            ...base,
            facts: base.facts.map((fact) => ({
              ...fact,
              status: chunk.index === 0 ? "uncertain" : "source_fact",
            })),
          };
        },
        identity: sameHolmesIdentityPlan(chunks),
      }),
    );

    expect(result.bible.facts).toHaveLength(1);
    expect(result.bible.facts[0].status).toBe("source_fact");
  });

  it("跨块地点变化被边界证据确认后，写入事实历史并关闭误报冲突", async () => {
    const chunks = threeChunks();
    const base = makeCall({
      chunks,
      localFor: (chunk) =>
        localFixture(chunk, {
          name: "福尔摩斯",
          factValue: chunk.index === 0 ? "贝克街" : "苏格兰场",
          entryLocation: chunk.index === 0 ? "贝克街" : "苏格兰场",
          exitLocation: chunk.index === 0 ? "贝克街" : "苏格兰场",
        }),
      identity: sameHolmesIdentityPlan(chunks),
    });
    const result = await runParallel(
      async (request, signal) => {
        if (request.stage !== "boundary_repair") return base(request, signal);
        const issues = JSON.parse(
          request.messages[1].content.split("\n\n", 1)[0],
        ) as Array<{ id: string; entityType: string; field: string }>;
        return JSON.stringify({
          resolutions: issues.map((issue) => ({
            issueId: issue.id,
            decision: "state_change",
            explanation: "原文明确移动",
            sourceRefs: [sourceRef(chunks[1], chunks[1].coreRange.start)],
            factTransitions:
              issue.entityType === "character" && issue.field === "location"
                ? [
                    {
                      existingFactId: "chunk_001::fact_001",
                      incomingFactId: "chunk_002::fact_001",
                    },
                  ]
                : [],
          })),
        });
      },
      { repairBoundaries: true },
    );

    expect(result.bible.facts).toHaveLength(2);
    expect(result.bible.facts[0].supersededByFactId).toBe(result.bible.facts[1].id);
    expect(result.bible.facts[1]).toMatchObject({
      value: "苏格兰场",
      supersedesFactId: result.bible.facts[0].id,
      supersessionReason: "state_change",
    });
    expect(result.bible.conflicts.filter((conflict) => conflict.status === "open")).toHaveLength(0);
  });

  it("连续两次跨块状态变化按原文顺序形成三段事实链", async () => {
    const chunks = threeChunks();
    const locations = ["贝克街", "苏格兰场", "车站"];
    const base = makeCall({
      chunks,
      localFor: (chunk) =>
        localFixture(chunk, {
          name: "福尔摩斯",
          factValue: locations[chunk.index],
          entryLocation: locations[chunk.index],
          exitLocation: locations[chunk.index],
        }),
      identity: sameHolmesIdentityPlan(chunks),
    });
    const result = await runParallel(
      async (request, signal) => {
        if (request.stage !== "boundary_repair") return base(request, signal);
        const issues = JSON.parse(
          request.messages[1].content.split("\n\n", 1)[0],
        ) as Array<{ id: string; entityType: string; field: string }>;
        const leftIndex = chunks.findIndex((chunk) => chunk.id === request.chunkIds[0]);
        const rightIndex = leftIndex + 1;
        return JSON.stringify({
          resolutions: issues.map((issue) => ({
            issueId: issue.id,
            decision: "state_change",
            explanation: "原文明确移动",
            sourceRefs: [sourceRef(chunks[rightIndex])],
            factTransitions:
              issue.entityType === "character" && issue.field === "location"
                ? [
                    {
                      existingFactId: `${chunks[leftIndex].id}::fact_001`,
                      incomingFactId: `${chunks[rightIndex].id}::fact_001`,
                    },
                  ]
                : [],
          })),
        });
      },
      { repairBoundaries: true },
    );

    expect(result.bible.facts.map((fact) => fact.value)).toEqual(locations);
    expect(result.bible.facts[0].supersededByFactId).toBe(result.bible.facts[1].id);
    expect(result.bible.facts[1].supersededByFactId).toBe(result.bible.facts[2].id);
    expect(result.bible.facts[2].supersessionReason).toBe("state_change");
    expect(result.bible.conflicts.filter((conflict) => conflict.status === "open")).toHaveLength(0);
  });

  it("人物新知识与活动目标的跨块变化也会进入边界修复和事实历史", async () => {
    const chunks = threeChunks();
    const base = makeCall({
      chunks,
      localFor: (chunk) => {
        const local = localFixture(chunk, { name: "华生" });
        const learned = chunk.index > 0;
        const ref = sourceRef(chunk);
        const facts = [
          {
            id: "fact_knows_killer",
            kind: "knowledge",
            subjectId: "char_001",
            predicate: "knows_killer",
            value: learned ? "yes" : "no",
            statement: learned ? "华生已知道凶手身份" : "华生尚不知凶手身份",
            status: "source_fact",
            sourceRefs: [ref],
          },
          {
            id: "fact_belief_alibi",
            kind: "knowledge",
            subjectId: "char_001",
            predicate: "belief_about_alibi",
            value: learned ? "B" : "A",
            statement: learned ? "华生相信不在场证明 B" : "华生相信不在场证明 A",
            status: "source_fact",
            sourceRefs: [ref],
          },
        ];
        const patchBoundary = (boundary: ReturnType<typeof localFixture>["entryBoundary"]) => ({
          ...boundary,
          characters: boundary.characters.map((character) => ({
            ...character,
            knowledge: learned ? ["凶手身份"] : [],
            activeGoals: learned ? ["逮捕凶手"] : ["查明凶手"],
          })),
        });
        return {
          ...local,
          facts,
          entryBoundary: patchBoundary(local.entryBoundary),
          exitBoundary: patchBoundary(local.exitBoundary),
        };
      },
      identity: sameHolmesIdentityPlan(chunks).replace("福尔摩斯", "华生"),
    });
    const result = await runParallel(
      async (request, signal) => {
        if (request.stage !== "boundary_repair") return base(request, signal);
        const issues = JSON.parse(
          request.messages[1].content.split("\n\n", 1)[0],
        ) as Array<{ id: string; field: string }>;
        return JSON.stringify({
          resolutions: issues.map((issue) => ({
            issueId: issue.id,
            decision: "state_change",
            explanation: "当前 core 明确出现了获知与目标变化",
            sourceRefs: [sourceRef(chunks[1], chunks[1].coreRange.start)],
            factTransitions:
              issue.field === "knowledge"
                ? [
                    {
                      existingFactId: "chunk_001::fact_knows_killer",
                      incomingFactId: "chunk_002::fact_knows_killer",
                    },
                  ]
                : [],
          })),
        });
      },
      { repairBoundaries: true },
    );

    expect(result.boundaryIssues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ field: "knowledge", status: "resolved" }),
        expect.objectContaining({ field: "activeGoals", status: "resolved" }),
      ]),
    );
    const killerFacts = result.bible.facts.filter(
      (fact) => fact.predicate === "knows_killer",
    );
    expect(killerFacts).toHaveLength(2);
    expect(killerFacts[0].supersededByFactId).toBe(killerFacts[1].id);
    expect(killerFacts[1]).toMatchObject({
      value: "yes",
      supersessionReason: "state_change",
    });
    expect(
      result.bible.conflicts.filter(
        (conflict) =>
          conflict.status === "open" &&
          conflict.incomingFact?.predicate === "belief_about_alibi",
      ).length,
    ).toBeGreaterThan(0);
    expect(
      result.bible.conflicts.some(
        (conflict) =>
          conflict.status === "open" &&
          conflict.incomingFact?.predicate === "knows_killer",
      ),
    ).toBe(false);
  });

  it("跨块同一伏笔的 open/mentioned/resolved 归并为一条已解决线索", async () => {
    const chunks = threeChunks();
    const result = await runParallel(
      makeCall({
        chunks,
        localFor: (chunk) => {
          const base = localFixture(chunk);
          const summaries = ["谁杀了受害者", "凶手究竟是谁", "凶手身份之谜"];
          return {
            ...base,
            threadObservations: [
              {
                id: "thread_001",
                summary: summaries[chunk.index],
                action: (["open", "mentioned", "resolved"] as const)[chunk.index],
                sourceRefs: [sourceRef(chunk)],
              },
            ],
          };
        },
        identity: sameThreadIdentityPlan(chunks),
      }),
    );

    expect(result.bible.threads).toHaveLength(1);
    expect(result.bible.threads[0]).toMatchObject({
      summary: "凶手身份之谜",
      status: "resolved",
      introducedAt: { chunkId: "chunk_001" },
      resolvedAt: { chunkId: "chunk_003" },
    });
  });

  it.each(["character", "relationship", "timeline", "location", "knowledge"] as const)(
    "%s fact 的 subjectId 必须引用本块人物",
    async (kind) => {
      const chunks = threeChunks();
      await expect(
        runParallel(
          makeCall({
            chunks,
            localFor: (chunk) => ({
              ...localFixture(chunk),
              facts: [{
                id: "fact_orphan",
                kind,
                subjectId: "char_404",
                predicate: "test",
                value: "value",
                statement: "孤儿人物事实",
                status: "source_fact",
                sourceRefs: [sourceRef(chunk)],
              }],
            }),
          }),
        ),
      ).rejects.toThrow("subjectId 必须引用本块人物");
    },
  );

  it("constraint 仅允许人物或全书 subject", async () => {
    const chunks = threeChunks();
    await expect(
      runParallel(
        makeCall({
          chunks,
          localFor: (chunk) => ({
            ...localFixture(chunk),
            facts: [{
              id: "fact_constraint",
              kind: "constraint",
              subjectId: "unknown_scope",
              predicate: "tone",
              value: "dark",
              statement: "错误的全书范围",
              status: "source_fact",
              sourceRefs: [sourceRef(chunk)],
            }],
          }),
        }),
      ),
    ).rejects.toThrow("本块人物或 global:story");

  });

  it.each([
    {
      label: "非法事实类型",
      mutate: (chunk: NovelChunk) => {
        const base = localFixture(chunk, { factValue: "贝克街" });
        return { ...base, facts: base.facts.map((fact) => ({ ...fact, kind: "banana" })) };
      },
    },
    {
      label: "逆原文时间的 supersession",
      mutate: (chunk: NovelChunk) => {
        const base = localFixture(chunk);
        const later = sourceRef(chunk, chunk.coreRange.end);
        const earlier = sourceRef(chunk, chunk.coreRange.start);
        return {
          ...base,
          facts: [
            {
              id: "fact_later",
              kind: "location",
              subjectId: "char_001",
              predicate: "current_location",
              value: "贝克街",
              statement: "后一处证据",
              status: "source_fact",
              sourceRefs: [later],
            },
            {
              id: "fact_earlier",
              kind: "location",
              subjectId: "char_001",
              predicate: "current_location",
              value: "苏格兰场",
              statement: "前一处证据却声称替代后文",
              status: "source_fact",
              supersedesFactId: "fact_later",
              supersessionReason: "state_change",
              sourceRefs: [earlier],
            },
          ],
        };
      },
    },
  ])("局部 validator 拒绝$label", async ({ mutate }) => {
    const chunks = threeChunks();
    await expect(
      runParallel(
        makeCall({
          chunks,
          localFor: (chunk) => (chunk.index === 0 ? mutate(chunk) : localFixture(chunk)),
        }),
      ),
    ).rejects.toThrow();
  });

  it("相邻 exit/entry 的具体状态差异生成稳定 boundary issue", async () => {
    const chunks = threeChunks();
    const run = (delays: number[]) =>
      runParallel(
        makeCall({
          chunks,
          localFor: (chunk) =>
            localFixture(chunk, {
              name: "福尔摩斯",
              entryLocation: chunk.index === 0 ? "贝克街" : "苏格兰场",
              exitLocation: chunk.index === 0 ? "贝克街" : "苏格兰场",
            }),
          identity: sameHolmesIdentityPlan(chunks),
          delayFor: (chunk) => delays[chunk.index],
        }),
      );

    const first = await run([20, 10, 1]);
    const second = await run([1, 10, 20]);
    const issue = first.boundaryIssues.find(
      (item) => item.leftChunkId === "chunk_001" && item.rightChunkId === "chunk_002",
    );

    expect(issue).toMatchObject({
      field: "location",
      leftValue: "贝克街",
      rightValue: "苏格兰场",
      status: "needs_review",
    });
    expect(issue?.id).toContain("chunk_001");
    expect(issue?.id).toContain("chunk_002");
    expect(second.boundaryIssues.map((item) => item.id)).toEqual(
      first.boundaryIssues.map((item) => item.id),
    );
  });

  it("同一对边界的多个差异只修复一次，有相邻 core 证据才能关闭", async () => {
    const chunks = threeChunks();
    let repairCalls = 0;
    const base = makeCall({
      chunks,
      localFor: (chunk) =>
        localFixture(chunk, {
          name: "福尔摩斯",
          entryLocation: chunk.index === 0 ? "贝克街" : "苏格兰场",
          exitLocation: chunk.index === 0 ? "贝克街" : "苏格兰场",
        }),
      identity: sameHolmesIdentityPlan(chunks),
    });
    const result = await runParallel(
      async (request, signal) => {
        if (request.stage !== "boundary_repair") return base(request, signal);
        repairCalls += 1;
        const issues = JSON.parse(
          request.messages[1].content.split("\n\n", 1)[0],
        ) as Array<{ id: string }>;
        return JSON.stringify({
          resolutions: issues.map((issue) => ({
            issueId: issue.id,
            decision: "state_change",
            explanation: "相邻文本明确写了移动",
            sourceRefs: [sourceRef(chunks[0], chunks[0].coreRange.end)],
          })),
        });
      },
      { repairBoundaries: true },
    );

    const firstPair = result.boundaryIssues.filter(
      (issue) =>
        issue.leftChunkId === "chunk_001" && issue.rightChunkId === "chunk_002",
    );
    expect(firstPair.length).toBeGreaterThan(1);
    expect(firstPair.every((issue) => issue.status === "resolved")).toBe(true);
    expect(repairCalls).toBe(1);
    expect(result.stats.repairCalls).toBe(1);
  });

  it("一次边界修复仍逐 issue 决策，未回答项保持待核实", async () => {
    const chunks = threeChunks();
    const base = makeCall({
      chunks,
      localFor: (chunk) =>
        localFixture(chunk, {
          name: "福尔摩斯",
          entryLocation: chunk.index === 0 ? "贝克街" : "苏格兰场",
          exitLocation: chunk.index === 0 ? "贝克街" : "苏格兰场",
        }),
      identity: sameHolmesIdentityPlan(chunks),
    });
    const result = await runParallel(
      async (request, signal) => {
        if (request.stage !== "boundary_repair") return base(request, signal);
        const issues = JSON.parse(
          request.messages[1].content.split("\n\n", 1)[0],
        ) as Array<{ id: string }>;
        return JSON.stringify({
          resolutions: [
            {
              issueId: issues[0].id,
              decision: "state_change",
              explanation: "只能证明这一项",
              sourceRefs: [sourceRef(chunks[0], chunks[0].coreRange.end)],
            },
          ],
        });
      },
      { repairBoundaries: true },
    );

    const firstPair = result.boundaryIssues.filter(
      (issue) => issue.leftChunkId === "chunk_001" && issue.rightChunkId === "chunk_002",
    );
    expect(firstPair.filter((issue) => issue.status === "resolved")).toHaveLength(1);
    expect(firstPair.some((issue) => issue.status === "needs_review")).toBe(true);
  });

  it("边界修复引用非相邻块证据时直接拒绝", async () => {
    const chunks = threeChunks();
    const base = makeCall({
      chunks,
      localFor: (chunk) =>
        localFixture(chunk, {
          name: "福尔摩斯",
          entryLocation: chunk.index === 0 ? "贝克街" : "苏格兰场",
          exitLocation: chunk.index === 0 ? "贝克街" : "苏格兰场",
        }),
      identity: sameHolmesIdentityPlan(chunks),
    });
    await expect(
      runParallel(
        async (request, signal) => {
          if (request.stage !== "boundary_repair") return base(request, signal);
          const issues = JSON.parse(
            request.messages[1].content.split("\n\n", 1)[0],
          ) as Array<{ id: string }>;
          return JSON.stringify({
            resolutions: [
              {
                issueId: issues[0].id,
                decision: "state_change",
                explanation: "伪造证据",
                sourceRefs: [sourceRef(chunks[2])],
              },
            ],
          });
        },
        { repairBoundaries: true },
      ),
    ).rejects.toThrow("越过相邻块权限");
  });

  it("取消后把同一 signal 传给在途请求，且不再启动新块", async () => {
    const controller = new AbortController();
    const started: string[] = [];
    let receivedSignal: AbortSignal | undefined;

    const call: ParallelCall = async (request, signal) => {
      if (request.stage !== "local_extract") {
        throw new Error("取消后不应进入后续阶段");
      }
      started.push(request.chunkIds[0]);
      receivedSignal = signal;
      return new Promise<string>((_resolve, reject) => {
        signal?.addEventListener(
          "abort",
          () => reject(new DOMException("Request aborted", "AbortError")),
          { once: true },
        );
      });
    };

    const task = runParallel(call, { concurrency: 1, signal: controller.signal });
    await vi.waitFor(() => expect(started).toEqual(["chunk_001"]));
    controller.abort();

    await expect(task).rejects.toThrow();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(receivedSignal).toBe(controller.signal);
    expect(started).toEqual(["chunk_001"]);
  });

  it("边界修复也遵守并发上限，取消后即使请求忽略 signal 也不返回成功", async () => {
    const chunks = threeChunks();
    const controller = new AbortController();
    const startedRepairs: string[] = [];
    let releaseRepair!: () => void;
    const release = new Promise<void>((resolve) => {
      releaseRepair = resolve;
    });
    const base = makeCall({
      chunks,
      localFor: (chunk) =>
        localFixture(chunk, {
          name: "福尔摩斯",
          entryLocation: ["贝克街", "苏格兰场", "车站"][chunk.index],
          exitLocation: ["贝克街", "苏格兰场", "车站"][chunk.index],
        }),
      identity: sameHolmesIdentityPlan(chunks),
    });
    const task = runParallel(
      async (request, signal) => {
        if (request.stage !== "boundary_repair") return base(request, signal);
        startedRepairs.push(request.chunkIds.join("/"));
        await release;
        return JSON.stringify({ resolutions: [] });
      },
      {
        concurrency: 1,
        repairBoundaries: true,
        signal: controller.signal,
      },
    );

    await vi.waitFor(() => expect(startedRepairs).toHaveLength(1));
    controller.abort();
    releaseRepair();
    await expect(task).rejects.toThrow("已取消");
    expect(startedRepairs).toHaveLength(1);
  });

  it("失败后保留其他已成功局部检查点，续跑时只补缺块", async () => {
    const chunks = threeChunks();
    let checkpoint: ParallelCheckpoint | undefined;
    let completed = 0;
    let rejectSecond!: () => void;
    const otherChunksFinished = new Promise<void>((resolve) => {
      rejectSecond = resolve;
    });
    const firstCall: ParallelCall = async (request) => {
      if (request.stage !== "local_extract") {
        throw new Error("局部失败时不应进入归并阶段");
      }
      const chunk = chunks.find((item) => item.id === request.chunkIds[0])!;
      if (chunk.id === "chunk_002") {
        await otherChunksFinished;
        throw new Error("块2模型返回失败");
      }
      completed++;
      if (completed === 2) rejectSecond();
      return JSON.stringify(localFixture(chunk));
    };

    await expect(
      runParallel(firstCall, {
        concurrency: 3,
        onLocalCheckpoint: (nextCheckpoint) => {
          checkpoint = nextCheckpoint;
        },
      }),
    ).rejects.toThrow("块2模型返回失败");

    expect(checkpoint).toBeDefined();
    expect(checkpoint!.locals.map((local) => local.chunkId).sort()).toEqual([
      "chunk_001",
      "chunk_003",
    ]);

    const resumedLocalCalls: string[] = [];
    const resumed = await runParallel(
      async (request) => {
        if (request.stage === "local_extract") {
          resumedLocalCalls.push(request.chunkIds[0]);
          return JSON.stringify(localFixture(chunks[1]));
        }
        if (request.stage === "identity_reconcile") {
          return singletonIdentityPlan(chunks);
        }
        return JSON.stringify({ decision: "unresolved", sourceRefs: [] });
      },
      { initialCheckpoint: checkpoint },
    );

    expect(resumedLocalCalls).toEqual(["chunk_002"]);
    expect(resumed.locals).toHaveLength(3);
  });

  it("检查点回调失败时不提交该块，错误检查点可安全重跑", async () => {
    const chunks = threeChunks();
    let failure: ParallelStoryBibleError | undefined;
    try {
      await runParallel(
        makeCall({ chunks, localFor: (chunk) => localFixture(chunk) }),
        {
          concurrency: 1,
          onLocalCheckpoint: () => {
            throw new Error("持久化失败");
          },
        },
      );
    } catch (error) {
      if (error instanceof ParallelStoryBibleError) failure = error;
    }

    expect(failure).toBeDefined();
    expect(failure!.checkpoint.locals).toHaveLength(0);
    const resumedCalls: string[] = [];
    await runParallel(
      async (request) => {
        if (request.stage === "local_extract") {
          resumedCalls.push(request.chunkIds[0]);
          return JSON.stringify(localFixture(chunks[resumedCalls.length - 1]));
        }
        if (request.stage === "identity_reconcile") return singletonIdentityPlan(chunks);
        return JSON.stringify({ resolutions: [] });
      },
      { initialCheckpoint: failure!.checkpoint },
    );
    expect(resumedCalls).toEqual(["chunk_001", "chunk_002", "chunk_003"]);
  });

  it("人物归一或边界修复失败时，错误仍携带已完成的局部检查点", async () => {
    const chunks = threeChunks();
    let failure: ParallelStoryBibleError | undefined;
    try {
      await runParallel(async (request) => {
        if (request.stage === "local_extract") {
          const chunk = chunks.find((item) => item.id === request.chunkIds[0])!;
          return JSON.stringify(localFixture(chunk));
        }
        throw new Error("identity timeout");
      });
    } catch (error) {
      if (error instanceof ParallelStoryBibleError) failure = error;
    }

    expect(failure?.message).toContain("identity timeout");
    expect(failure?.checkpoint.locals).toHaveLength(3);
  });

  it("恢复前重新校验检查点局部内容，拒绝未知外键", async () => {
    const chunks = threeChunks();
    const completed = await runParallel(
      makeCall({ chunks, localFor: (chunk) => localFixture(chunk) }),
    );
    const poisoned = JSON.parse(
      JSON.stringify(completed.checkpoint),
    ) as ParallelCheckpoint;
    poisoned.locals[0].entryBoundary.characters[0].characterId = "unknown_character";
    let calls = 0;
    await expect(
      runParallel(
        async () => {
          calls += 1;
          return "";
        },
        { initialCheckpoint: poisoned },
      ),
    ).rejects.toThrow("未知人物");
    expect(calls).toBe(0);
  });

  it.each(["knowledge", "activeGoals"] as const)(
    "局部边界严格拒绝非 string[] 的 %s",
    async (field) => {
      const chunks = threeChunks();
      await expect(
        runParallel(
          makeCall({
            chunks,
            localFor: (chunk) => {
              const local = localFixture(chunk);
              return {
                ...local,
                entryBoundary: {
                  ...local.entryBoundary,
                  characters: local.entryBoundary.characters.map((character) => ({
                    ...character,
                    [field]: ["valid", 42],
                  })),
                },
              };
            },
          }),
        ),
      ).rejects.toThrow("必须是字符串数组");
    },
  );

  it("同一 local 的 entry→exit 变化也生成 issue，repair 仅获得该块权限", async () => {
    const chunks = threeChunks();
    const repairChunkIds: string[][] = [];
    const base = makeCall({
      chunks,
      localFor: (chunk) =>
        localFixture(chunk, {
          name: "福尔摩斯",
          entryLocation: chunk.index === 0 ? "贝克街" : "苏格兰场",
          exitLocation: "苏格兰场",
        }),
      identity: sameHolmesIdentityPlan(chunks),
    });
    const result = await runParallel(
      async (request, signal) => {
        if (request.stage !== "boundary_repair") return base(request, signal);
        repairChunkIds.push(request.chunkIds);
        const issues = JSON.parse(
          request.messages[1].content.split("\n\n", 1)[0],
        ) as Array<{ id: string }>;
        return JSON.stringify({
          resolutions: issues.map((issue) => ({
            issueId: issue.id,
            decision: "state_change",
            explanation: "同块 core 明确写出移动",
            sourceRefs: [sourceRef(chunks[0])],
          })),
        });
      },
      { repairBoundaries: true },
    );

    expect(repairChunkIds).toEqual([["chunk_001"]]);
    expect(result.boundaryIssues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          leftChunkId: "chunk_001",
          rightChunkId: "chunk_001",
          field: "location",
          status: "resolved",
        }),
      ]),
    );
  });

  it("活动目标使用中文自由谓词时，仍可仅凭显式 factTransitions 写入状态链", async () => {
    const chunks = threeChunks();
    const base = makeCall({
      chunks,
      localFor: (chunk) => {
        const local = localFixture(chunk, { name: "华生" });
        const changed = chunk.index > 0;
        const ref = sourceRef(chunk);
        const patchBoundary = (boundary: typeof local.entryBoundary) => ({
          ...boundary,
          characters: boundary.characters.map((character) => ({
            ...character,
            activeGoals: [changed ? "抓捕凶手" : "找到线索"],
          })),
        });
        return {
          ...local,
          facts: [
            {
              id: "fact_mission",
              kind: "constraint",
              subjectId: "char_001",
              predicate: "当前任务",
              value: changed ? "抓捕凶手" : "找到线索",
              statement: changed ? "华生转而抓捕凶手" : "华生正在找线索",
              status: "source_fact",
              sourceRefs: [ref],
            },
          ],
          entryBoundary: patchBoundary(local.entryBoundary),
          exitBoundary: patchBoundary(local.exitBoundary),
        };
      },
      identity: sameHolmesIdentityPlan(chunks).replace("福尔摩斯", "华生"),
    });
    const result = await runParallel(
      async (request, signal) => {
        if (request.stage !== "boundary_repair") return base(request, signal);
        const issues = JSON.parse(
          request.messages[1].content.split("\n\n", 1)[0],
        ) as Array<{ id: string; field: string }>;
        return JSON.stringify({
          resolutions: issues.map((issue) => ({
            issueId: issue.id,
            decision: "state_change",
            explanation: "目标已明确变化",
            sourceRefs: [sourceRef(chunks[1])],
            factTransitions:
              issue.field === "activeGoals"
                ? [
                    {
                      existingFactId: "chunk_001::fact_mission",
                      incomingFactId: "chunk_002::fact_mission",
                    },
                  ]
                : [],
          })),
        });
      },
      { repairBoundaries: true },
    );

    const missionFacts = result.bible.facts.filter(
      (fact) => fact.predicate === "当前任务",
    );
    expect(missionFacts).toHaveLength(2);
    expect(missionFacts[0].supersededByFactId).toBe(missionFacts[1].id);
    expect(
      result.bible.conflicts.some(
        (conflict) =>
          conflict.status === "open" &&
          conflict.incomingFact?.predicate === "当前任务",
      ),
    ).toBe(false);
  });

  it("检查点指纹绑定非空 checkpointIdentity，版本变化不得复用", async () => {
    const chunks = threeChunks();
    const completed = await runParallel(
      makeCall({ chunks, localFor: (chunk) => localFixture(chunk) }),
      { checkpointIdentity: "model-a:prompt-v1:schema-v1" },
    );
    let calls = 0;
    await expect(
      runParallel(
        async () => {
          calls += 1;
          return "";
        },
        {
          checkpointIdentity: "model-a:prompt-v2:schema-v1",
          initialCheckpoint: completed.checkpoint,
        },
      ),
    ).rejects.toThrow("检查点不属于当前小说");
    await expect(
      runParallel(async () => "", { checkpointIdentity: "   " }),
    ).rejects.toThrow("checkpointIdentity");
    expect(calls).toBe(0);
  });

  it("onProgress 内取消后重新检查 signal，不发出新的 local call", async () => {
    const controller = new AbortController();
    const call = vi.fn<ParallelCall>(async () => {
      throw new Error("不应被调用");
    });
    await expect(
      runParallel(call, {
        concurrency: 1,
        signal: controller.signal,
        onProgress: () => controller.abort(),
      }),
    ).rejects.toThrow("已取消");
    expect(call).not.toHaveBeenCalled();
  });

  it("identity_reconcile 进度回调内取消后不发出 identity call", async () => {
    const chunks = threeChunks();
    const controller = new AbortController();
    const base = makeCall({
      chunks,
      localFor: (chunk) => localFixture(chunk),
    });
    let identityCalls = 0;
    await expect(
      runParallel(
        async (request, signal) => {
          if (request.stage === "identity_reconcile") identityCalls += 1;
          return base(request, signal);
        },
        {
          signal: controller.signal,
          onProgress: (progress) => {
            if (progress.stage === "identity_reconcile") controller.abort();
          },
        },
      ),
    ).rejects.toThrow("已取消");
    expect(identityCalls).toBe(0);
  });

  it("identity call 忽略 abort 并返回坏 JSON 时仍优先报告取消", async () => {
    const chunks = threeChunks();
    const controller = new AbortController();
    const base = makeCall({
      chunks,
      localFor: (chunk) => localFixture(chunk),
    });
    await expect(
      runParallel(
        async (request, signal) => {
          if (request.stage !== "identity_reconcile") return base(request, signal);
          controller.abort();
          return "不是 JSON";
        },
        { signal: controller.signal },
      ),
    ).rejects.toThrow("已取消");
  });

  it("boundary_repair 进度回调内取消后不发出 repair call", async () => {
    const chunks = threeChunks();
    const controller = new AbortController();
    const base = makeCall({
      chunks,
      identity: sameHolmesIdentityPlan(chunks),
      localFor: (chunk) =>
        localFixture(chunk, {
          name: "福尔摩斯",
          entryLocation: chunk.index === 0 ? "贝克街" : "苏格兰场",
          exitLocation: chunk.index === 0 ? "贝克街" : "苏格兰场",
        }),
    });
    let repairCalls = 0;
    await expect(
      runParallel(
        async (request, signal) => {
          if (request.stage === "boundary_repair") repairCalls += 1;
          return base(request, signal);
        },
        {
          repairBoundaries: true,
          signal: controller.signal,
          onProgress: (progress) => {
            if (progress.stage === "boundary_repair") controller.abort();
          },
        },
      ),
    ).rejects.toThrow("已取消");
    expect(repairCalls).toBe(0);
  });

  it("onProgress 异常纳入 worker 错误且不发出 local call", async () => {
    const call = vi.fn<ParallelCall>(async () => {
      throw new Error("不应被调用");
    });
    await expect(
      runParallel(call, {
        concurrency: 1,
        onProgress: () => {
          throw new Error("进度接收器崩溃");
        },
      }),
    ).rejects.toThrow("进度接收器崩溃");
    expect(call).not.toHaveBeenCalled();
  });

  it("有物品候选时 objectGroups 必须完整分区，prompt 同时提供原文 snippet", async () => {
    const chunks = threeChunks();
    const localFor = (chunk: NovelChunk) => {
      const local = localFixture(chunk, { name: "福尔摩斯" });
      const object = {
        objectId: "ring",
        state: "完整",
        sourceRefs: [sourceRef(chunk)],
      };
      return {
        ...local,
        entryBoundary: { ...local.entryBoundary, objects: [object] },
        exitBoundary: { ...local.exitBoundary, objects: [object] },
      };
    };
    const missingObjects = JSON.parse(sameHolmesIdentityPlan(chunks)) as Record<
      string,
      unknown
    >;
    delete missingObjects.objectGroups;
    await expect(
      runParallel(
        makeCall({
          chunks,
          localFor,
          identity: JSON.stringify(missingObjects),
        }),
      ),
    ).rejects.toThrow("缺少 objectGroups");

    let identityRequest = "";
    await runParallel(
      makeCall({
        chunks,
        localFor,
        identity: holmesAndObjectIdentityPlan(chunks, "ring"),
        onIdentityRequest: (request) => {
          identityRequest = request;
        },
      }),
    );
    expect(identityRequest).toContain("sourceSnippets");
    expect(identityRequest).toContain("¶1 第一章");
  });

  it("同 local 旧值先与前块合并时，新值 supersedes 会改写到保留的 fact id", async () => {
    const chunks = threeChunks();
    const result = await runParallel(
      makeCall({
        chunks,
        localFor: (chunk) => {
          if (chunk.index !== 1) {
            return localFixture(chunk, {
              name: "福尔摩斯",
              factValue: chunk.index === 0 ? "贝克街" : "苏格兰场",
              entryLocation: chunk.index === 0 ? "贝克街" : "苏格兰场",
              exitLocation: chunk.index === 0 ? "贝克街" : "苏格兰场",
            });
          }
          const local = localFixture(chunk, {
            name: "福尔摩斯",
            entryLocation: "贝克街",
            exitLocation: "苏格兰场",
          });
          return {
            ...local,
            facts: [
              {
                id: "fact_old",
                kind: "location",
                subjectId: "char_001",
                predicate: "current_location",
                value: "贝克街",
                statement: "福尔摩斯仍在贝克街",
                status: "source_fact",
                sourceRefs: [sourceRef(chunk, chunk.coreRange.start)],
              },
              {
                id: "fact_new",
                kind: "location",
                subjectId: "char_001",
                predicate: "current_location",
                value: "苏格兰场",
                statement: "福尔摩斯到达苏格兰场",
                status: "source_fact",
                supersedesFactId: "fact_old",
                supersessionReason: "state_change",
                sourceRefs: [sourceRef(chunk, chunk.coreRange.end)],
              },
            ],
          };
        },
        identity: sameHolmesIdentityPlan(chunks),
      }),
    );

    expect(result.bible.facts.map((fact) => fact.value)).toEqual([
      "贝克街",
      "苏格兰场",
    ]);
    expect(result.bible.facts[0].supersededByFactId).toBe(
      result.bible.facts[1].id,
    );
    expect(result.bible.facts[1].supersedesFactId).toBe(
      result.bible.facts[0].id,
    );
    expect(
      result.bible.conflicts.some(
        (conflict) => conflict.type === "fact_value" && conflict.status === "open",
      ),
    ).toBe(false);
  });

  it("早期 boundary.openReferences 不会因后续边界未重复输出而消失", async () => {
    const chunks = threeChunks();
    const result = await runParallel(
      makeCall({
        chunks,
        localFor: (chunk) => {
          const local = localFixture(chunk, { name: "福尔摩斯" });
          if (chunk.index !== 0) return local;
          return {
            ...local,
            exitBoundary: {
              ...local.exitBoundary,
              openReferences: [
                {
                  text: "那个戴帽子的人",
                  candidateCharacterIds: ["char_001"],
                  sourceRef: sourceRef(chunk, chunk.coreRange.end),
                },
              ],
            },
          };
        },
        identity: sameHolmesIdentityPlan(chunks),
      }),
    );

    expect(result.bible.boundaryState?.openReferences).toHaveLength(0);
    expect(result.bible.conflicts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "reported",
          status: "open",
          description: expect.stringContaining("那个戴帽子的人"),
        }),
      ]),
    );
  });

  it("有伏笔候选时 threadGroups 必须对每个 scoped id 完整分区", async () => {
    const chunks = threeChunks();
    await expect(
      runParallel(
        makeCall({
          chunks,
          localFor: (chunk) => {
            const local = localFixture(chunk);
            return {
              ...local,
              threadObservations: [
                {
                  id: "thread_001",
                  summary: "凶手身份",
                  action: "open",
                  sourceRefs: [sourceRef(chunk)],
                },
              ],
            };
          },
          identity: singletonIdentityPlan(chunks),
        }),
      ),
    ).rejects.toThrow("伏笔归一遗漏成员");
  });

  it("knowledge issue 不能借用语义无关的 belief 冲突 id 越权改写事实", async () => {
    const chunks = threeChunks();
    const base = makeCall({
      chunks,
      localFor: (chunk) => {
        const local = localFixture(chunk, { name: "华生" });
        const changed = chunk.index > 0;
        const patchBoundary = (boundary: typeof local.entryBoundary) => ({
          ...boundary,
          characters: boundary.characters.map((character) => ({
            ...character,
            knowledge: changed ? ["凶手身份"] : [],
          })),
        });
        return {
          ...local,
          facts: [
            {
              id: "fact_belief",
              kind: "knowledge",
              subjectId: "char_001",
              predicate: "belief_about_alibi",
              value: changed ? "B" : "A",
              statement: changed ? "华生相信证明 B" : "华生相信证明 A",
              status: "source_fact",
              sourceRefs: [sourceRef(chunk)],
            },
          ],
          entryBoundary: patchBoundary(local.entryBoundary),
          exitBoundary: patchBoundary(local.exitBoundary),
        };
      },
      identity: sameHolmesIdentityPlan(chunks).replace("福尔摩斯", "华生"),
    });

    await expect(
      runParallel(
        async (request, signal) => {
          if (request.stage !== "boundary_repair") return base(request, signal);
          const issues = JSON.parse(
            request.messages[1].content.split("\n\n", 1)[0],
          ) as Array<{ id: string; field: string }>;
          return JSON.stringify({
            resolutions: issues.map((issue) => ({
              issueId: issue.id,
              decision: "state_change",
              explanation: "恶意引用无关事实",
              sourceRefs: [sourceRef(chunks[1])],
              factTransitions:
                issue.field === "knowledge"
                  ? [
                      {
                        existingFactId: "chunk_001::fact_belief",
                        incomingFactId: "chunk_002::fact_belief",
                      },
                    ]
                  : [],
            })),
          });
        },
        { repairBoundaries: true },
      ),
    ).rejects.toThrow("该 issue 不允许");
  });

  it("局部 boundary 原始 id 重复时在 identity 前拒绝", async () => {
    const chunks = threeChunks();
    await expect(
      runParallel(
        makeCall({
          chunks,
          localFor: (chunk) => {
            const local = localFixture(chunk);
            if (chunk.index !== 0) return local;
            return {
              ...local,
              entryBoundary: {
                ...local.entryBoundary,
                characters: [
                  ...local.entryBoundary.characters,
                  { ...local.entryBoundary.characters[0] },
                ],
              },
            };
          },
        }),
      ),
    ).rejects.toThrow("存在重复 id");
  });

  it("identity 把两个局部人物合并后，矛盾 boundary 标量必须报错而非 last-wins", async () => {
    const chunks = threeChunks();
    const mergedIdentity = identityPlan([
      {
        memberIds: ["chunk_001::char_001", "chunk_001::char_002"],
        canonicalName: "同一人",
      },
      {
        memberIds: ["chunk_002::char_001"],
        canonicalName: "人物2",
      },
      {
        memberIds: ["chunk_003::char_001"],
        canonicalName: "人物3",
      },
    ]);
    await expect(
      runParallel(
        makeCall({
          chunks,
          identity: mergedIdentity,
          localFor: (chunk) => {
            const local = localFixture(chunk);
            if (chunk.index !== 0) return local;
            const ref = sourceRef(chunk);
            const secondCharacter = {
              id: "char_002",
              name: "另一个称呼",
              aliases: [],
              sourceRefs: [ref],
            };
            const secondState = {
              characterId: "char_002",
              location: "苏格兰场",
              knowledge: [],
              activeGoals: [],
              sourceRefs: [ref],
            };
            return {
              ...local,
              characters: [...local.characters, secondCharacter],
              entryBoundary: {
                ...local.entryBoundary,
                characters: [
                  ...local.entryBoundary.characters,
                  secondState,
                ],
              },
              exitBoundary: {
                ...local.exitBoundary,
                characters: [
                  ...local.exitBoundary.characters,
                  secondState,
                ],
              },
            };
          },
        }),
      ),
    ).rejects.toThrow("identity 归一后出现矛盾");
  });

  it("只在 object fact 中出现的物品也进入 objectGroups 并跨块归一", async () => {
    const chunks = threeChunks();
    let identityRequest = "";
    const result = await runParallel(
      makeCall({
        chunks,
        identity: holmesAndObjectIdentityPlan(chunks, "ring"),
        onIdentityRequest: (request) => {
          identityRequest = request;
        },
        localFor: (chunk) => {
          const local = localFixture(chunk, { name: "福尔摩斯" });
          return {
            ...local,
            facts: [
              {
                id: "fact_ring",
                kind: "object",
                subjectId: "ring",
                predicate: "state",
                value: "完整",
                statement: "婚戒保持完整",
                status: "source_fact",
                sourceRefs: [sourceRef(chunk)],
              },
            ],
          };
        },
      }),
    );

    expect(identityRequest).toContain("chunk_001::ring");
    expect(result.identityPlan.objectAssignments).toHaveLength(1);
    expect(result.bible.facts).toHaveLength(1);
    expect(result.bible.facts[0]).toMatchObject({
      kind: "object",
      subjectId: "object_0001",
    });
    expect(result.bible.facts[0].sourceRefs).toHaveLength(3);
  });

  it("scope 后 id 碰撞会被拒绝；object subject 按 kind 映射而不是人物优先", async () => {
    const chunks = threeChunks();
    await expect(
      runParallel(
        makeCall({
          chunks,
          localFor: (chunk) => {
            const local = localFixture(chunk);
            if (chunk.index !== 0) return local;
            const ref = sourceRef(chunk);
            return {
              ...local,
              facts: [
                {
                  id: "fact_x",
                  kind: "location",
                  subjectId: "char_001",
                  predicate: "p1",
                  value: "v1",
                  statement: "事实一",
                  status: "source_fact",
                  sourceRefs: [ref],
                },
                {
                  id: `${chunk.id}::fact_x`,
                  kind: "location",
                  subjectId: "char_001",
                  predicate: "p2",
                  value: "v2",
                  statement: "事实二",
                  status: "source_fact",
                  sourceRefs: [ref],
                },
              ],
            };
          },
        }),
      ),
    ).rejects.toThrow("scopedFacts");

    const sharedIdentity = JSON.parse(
      identityPlan([
        {
          memberIds: chunks.map((chunk) => `${chunk.id}::shared`),
          canonicalName: "人物 shared",
        },
      ]),
    ) as Record<string, unknown>;
    sharedIdentity.objectGroups = [
      {
        memberIds: chunks.map((chunk) => `${chunk.id}::shared`),
        canonicalName: "物品 shared",
        decision: "same",
      },
    ];
    const result = await runParallel(
      makeCall({
        chunks,
        identity: JSON.stringify(sharedIdentity),
        localFor: (chunk) => {
          const local = localFixture(chunk);
          const ref = sourceRef(chunk);
          const character = {
            id: "shared",
            name: "人物 shared",
            aliases: [],
            sourceRefs: [ref],
          };
          const state = {
            characterId: "shared",
            knowledge: [],
            activeGoals: [],
            sourceRefs: [ref],
          };
          return {
            ...local,
            characters: [character],
            facts: [
              {
                id: "fact_object",
                kind: "object",
                subjectId: "shared",
                predicate: "state",
                value: "完整",
                statement: "物品状态完整",
                status: "source_fact",
                sourceRefs: [ref],
              },
            ],
            entryBoundary: { ...local.entryBoundary, characters: [state] },
            exitBoundary: { ...local.exitBoundary, characters: [state] },
          };
        },
      }),
    );
    expect(result.bible.facts[0].subjectId).toBe("object_0001");

    await expect(
      runParallel(
        makeCall({
          chunks,
          identity: JSON.stringify(sharedIdentity),
          localFor: (chunk) => {
            const local = localFixture(chunk);
            const ref = sourceRef(chunk);
            const character = {
              id: "shared",
              name: "人物 shared",
              aliases: [],
              sourceRefs: [ref],
            };
            const state = {
              characterId: "shared",
              knowledge: [],
              activeGoals: [],
              sourceRefs: [ref],
            };
            return {
              ...local,
              characters: [character],
              facts: [
                {
                  id: "fact_ambiguous_value",
                  kind: "object",
                  subjectId: "shared",
                  predicate: "related_entity",
                  value: "shared",
                  statement: "同一值同时像人物和物品 id",
                  status: "source_fact",
                  sourceRefs: [ref],
                },
              ],
              entryBoundary: { ...local.entryBoundary, characters: [state] },
              exitBoundary: { ...local.exitBoundary, characters: [state] },
            };
          },
        }),
      ),
    ).rejects.toThrow("同时引用人物与物品 id");
  });

  it("已解决伏笔被后文重新 open 时保持 open 并显式记录冲突", async () => {
    const chunks = threeChunks();
    const result = await runParallel(
      makeCall({
        chunks,
        identity: sameThreadIdentityPlan(chunks),
        localFor: (chunk) => {
          const local = localFixture(chunk);
          return {
            ...local,
            threadObservations: [
              {
                id: "thread_001",
                summary: "凶手身份之谜",
                action: (["open", "resolved", "open"] as const)[chunk.index],
                sourceRefs: [sourceRef(chunk)],
              },
            ],
          };
        },
      }),
    );

    expect(result.bible.threads).toMatchObject([{ status: "open" }]);
    expect("resolvedAt" in result.bible.threads[0]).toBe(false);
    expect(result.bible.conflicts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "thread",
          status: "open",
          description: expect.stringContaining("已解决后再次"),
        }),
      ]),
    );
  });

  it("同段 timeline 使用局部 order 排序，交换局部 id 不改变结果", async () => {
    const chunks = threeChunks();
    const run = (swapIds: boolean) =>
      runParallel(
        makeCall({
          chunks,
          identity: sameHolmesIdentityPlan(chunks),
          localFor: (chunk) => {
            const local = localFixture(chunk, { name: "福尔摩斯" });
            if (chunk.index !== 0) return local;
            const ref = sourceRef(chunk);
            return {
              ...local,
              timelineEvents: [
                {
                  id: swapIds ? "event_z" : "event_a",
                  summary: "第一件事",
                  order: 1,
                  characterIds: ["char_001"],
                  sourceRefs: [ref],
                },
                {
                  id: swapIds ? "event_a" : "event_z",
                  summary: "第二件事",
                  order: 2,
                  characterIds: ["char_001"],
                  sourceRefs: [ref],
                },
              ],
            };
          },
        }),
      );

    const first = await run(false);
    const renamed = await run(true);
    expect(first.bible.timeline.map((event) => event.summary)).toEqual([
      "第一件事",
      "第二件事",
    ]);
    expect(JSON.stringify(first.bible)).toBe(JSON.stringify(renamed.bible));
  });

  it("同首段且同 order 的不同 timeline 事件显式冲突，结果不依赖局部 id", async () => {
    const chunks = threeChunks();
    const run = (swapIds: boolean) =>
      runParallel(
        makeCall({
          chunks,
          identity: sameHolmesIdentityPlan(chunks),
          localFor: (chunk) => {
            const local = localFixture(chunk, { name: "福尔摩斯" });
            if (chunk.index !== 0) return local;
            const narrow = sourceRef(chunk);
            const broad = {
              ...narrow,
              paragraphRange: {
                start: narrow.paragraphRange.start,
                end: Math.min(chunk.coreRange.end, narrow.paragraphRange.start + 1),
              },
            };
            return {
              ...local,
              timelineEvents: [
                {
                  id: swapIds ? "event_z" : "event_a",
                  summary: "A 事件",
                  order: 1,
                  characterIds: ["char_001"],
                  sourceRefs: [narrow],
                },
                {
                  id: swapIds ? "event_a" : "event_z",
                  summary: "B 事件",
                  order: 1,
                  characterIds: ["char_001"],
                  sourceRefs: [broad],
                },
              ],
            };
          },
        }),
      );

    const first = await run(false);
    const renamed = await run(true);
    expect(JSON.stringify(first.bible)).toBe(JSON.stringify(renamed.bible));
    expect(first.bible.conflicts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "timeline",
          status: "open",
          description: expect.stringContaining("同一原文出处与局部 order"),
        }),
      ]),
    );
  });

  it("同首段 thread 同时 open/resolved 时保守保持 open，交换局部 id 不改变结果", async () => {
    const chunks = threeChunks();
    const run = (swapIds: boolean) => {
      const openId = swapIds ? "thread_z" : "thread_a";
      const resolvedId = swapIds ? "thread_a" : "thread_z";
      const parsed = JSON.parse(singletonIdentityPlan(chunks)) as Record<string, unknown>;
      parsed.threadGroups = [{
        memberIds: [
          `${chunks[0].id}::${openId}`,
          `${chunks[0].id}::${resolvedId}`,
        ],
        canonicalSummary: "同段歧义线索",
        decision: "same",
      }];
      return runParallel(
        makeCall({
          chunks,
          identity: JSON.stringify(parsed),
          localFor: (chunk) => {
            const local = localFixture(chunk);
            if (chunk.index !== 0) return local;
            const narrow = sourceRef(chunk);
            const broad = {
              ...narrow,
              paragraphRange: {
                start: narrow.paragraphRange.start,
                end: Math.min(chunk.coreRange.end, narrow.paragraphRange.start + 1),
              },
            };
            return {
              ...local,
              threadObservations: [
                {
                  id: openId,
                  summary: "线索出现",
                  action: "open",
                  sourceRefs: [narrow],
                },
                {
                  id: resolvedId,
                  summary: "线索解决",
                  action: "resolved",
                  sourceRefs: [broad],
                },
              ],
            };
          },
        }),
      );
    };

    const first = await run(false);
    const renamed = await run(true);
    expect(JSON.stringify(first.bible)).toBe(JSON.stringify(renamed.bible));
    expect(first.bible.threads).toMatchObject([{ status: "open" }]);
    expect(first.bible.conflicts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "thread",
          status: "open",
          description: expect.stringContaining("同一原文出处同时"),
        }),
      ]),
    );
  });

  it("确认 A→B 只关闭明确引用的冲突，不会误关后续 C→B", async () => {
    const chunks = threeChunks();
    const base = makeCall({
      chunks,
      identity: sameHolmesIdentityPlan(chunks),
      localFor: (chunk) => {
        const entryValue = (["A", "B", "C"] as const)[chunk.index];
        const exitValue = chunk.index === 2 ? "B" : entryValue;
        const local = localFixture(chunk, {
          name: "福尔摩斯",
          entryLocation: entryValue,
          exitLocation: exitValue,
        });
        const fact = (id: string, value: string, paragraph: number) => ({
          id,
          kind: "location",
          subjectId: "char_001",
          predicate: "current_location",
          value,
          statement: `福尔摩斯位于${value}`,
          status: "source_fact",
          sourceRefs: [sourceRef(chunk, paragraph)],
        });
        return {
          ...local,
          facts: chunk.index === 2
            ? [
                fact("fact_c", "C", chunk.coreRange.start),
                fact("fact_b_later", "B", chunk.coreRange.end),
              ]
            : [fact("fact_state", entryValue, chunk.coreRange.start)],
        };
      },
    });
    const result = await runParallel(
      async (request, signal) => {
        if (request.stage !== "boundary_repair") return base(request, signal);
        const issues = JSON.parse(
          request.messages[1].content.split("\n\n", 1)[0],
        ) as Array<{
          id: string;
          leftValue: string;
          rightValue: string;
          allowedFactTransitions: Array<{
            existingFactId: string;
            incomingFactId: string;
          }>;
        }>;
        return JSON.stringify({
          resolutions: issues
            .filter((issue) => issue.leftValue === "A" && issue.rightValue === "B")
            .map((issue) => ({
              issueId: issue.id,
              decision: "state_change",
              explanation: "只确认第一次 A 到 B",
              sourceRefs: [sourceRef(chunks[1])],
              factTransitions: issue.allowedFactTransitions,
            })),
        });
      },
      { repairBoundaries: true },
    );

    expect(result.bible.conflicts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          status: "open",
          incomingFact: expect.objectContaining({
            id: "chunk_003::fact_b_later",
            value: "B",
          }),
        }),
      ]),
    );
  });

  it("identity 候选超过单页时完整分页、每页守预算，并显式标记跨页未比较", async () => {
    const chunks = threeChunks();
    const locals = new Map(
      chunks.map((chunk) => {
        const local = localFixture(chunk);
        const characters = Array.from({ length: 40 }, (_, index) => ({
          id: `char_${String(index + 1).padStart(3, "0")}`,
          name: `候选人物${chunk.index + 1}-${index + 1}`,
          aliases: [],
          sourceRefs: [sourceRef(chunk)],
        }));
        return [
          chunk.id,
          {
            ...local,
            characters,
            entryBoundary: { ...local.entryBoundary, characters: [] },
            exitBoundary: { ...local.exitBoundary, characters: [] },
          },
        ] as const;
      }),
    );
    const identityMessageLengths: number[] = [];
    const identityProgress: number[] = [];
    const seenIds: string[] = [];
    const result = await runParallel(
      async (request) => {
        if (request.stage === "local_extract") {
          return JSON.stringify(locals.get(request.chunkIds[0]));
        }
        if (request.stage === "identity_reconcile") {
          identityMessageLengths.push(
            request.messages.reduce((sum, message) => sum + message.content.length, 0),
          );
          const payload = JSON.parse(request.messages[1].content) as {
            characters: Array<{ id: string; name: string }>;
          };
          seenIds.push(...payload.characters.map((character) => character.id));
          return JSON.stringify({
            groups: payload.characters.map((character) => ({
              memberIds: [character.id],
              canonicalName: character.name,
              aliases: [],
              decision: "same",
            })),
            objectGroups: [],
            threadGroups: [],
          });
        }
        return JSON.stringify({ resolutions: [] });
      },
      {
        onProgress: (progress) => {
          if (progress.stage === "identity_reconcile") {
            identityProgress.push(progress.completed);
          }
        },
      },
    );

    expect(result.stats.reconcileCalls).toBe(2);
    expect(identityProgress).toEqual([0, 1, 2]);
    expect(identityMessageLengths).toHaveLength(2);
    expect(identityMessageLengths.every((length) => length <= 120_000)).toBe(true);
    expect(seenIds).toHaveLength(120);
    expect(new Set(seenIds).size).toBe(120);
    expect(result.bible.characters).toHaveLength(120);
    expect(
      result.bible.characters.every(
        (character) => character.identityStatus === "provisional",
      ),
    ).toBe(true);
    expect(result.bible.conflicts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "conflict_identity_pagination_001",
          status: "open",
        }),
      ]),
    );
  });

  it("同一边界超过 40 个 issue 时完整分批，repair 每批都守字符预算", async () => {
    const chunks = threeChunks();
    const characterCount = 45;
    const locals = new Map(
      chunks.map((chunk) => {
        const local = localFixture(chunk);
        const location = chunk.index === 0 ? "贝克街" : "苏格兰场";
        const characters = Array.from({ length: characterCount }, (_, index) => ({
          id: `char_${String(index + 1).padStart(3, "0")}`,
          name: `人物${index + 1}`,
          aliases: [],
          sourceRefs: [sourceRef(chunk)],
        }));
        const states = characters.map((character) => ({
          characterId: character.id,
          location,
          knowledge: [],
          activeGoals: [],
          sourceRefs: [sourceRef(chunk)],
        }));
        return [
          chunk.id,
          {
            ...local,
            characters,
            entryBoundary: {
              ...local.entryBoundary,
              characters: states,
            },
            exitBoundary: {
              ...local.exitBoundary,
              characters: states,
            },
          },
        ] as const;
      }),
    );
    const repairIssueCounts: number[] = [];
    const repairMessageLengths: number[] = [];
    const repairProgress: number[] = [];
    const result = await runParallel(
      async (request) => {
        if (request.stage === "local_extract") {
          return JSON.stringify(locals.get(request.chunkIds[0]));
        }
        if (request.stage === "identity_reconcile") {
          const payload = JSON.parse(request.messages[1].content) as {
            characters: Array<{ id: string; name: string }>;
          };
          const bySuffix = new Map<string, Array<{ id: string; name: string }>>();
          for (const character of payload.characters) {
            const suffix = character.id.split("::").at(-1)!;
            const group = bySuffix.get(suffix) ?? [];
            group.push(character);
            bySuffix.set(suffix, group);
          }
          return JSON.stringify({
            groups: [...bySuffix.values()].map((group) => ({
              memberIds: group.map((character) => character.id),
              canonicalName: group[0].name,
              aliases: [],
              decision: "same",
            })),
            objectGroups: [],
            threadGroups: [],
          });
        }
        repairMessageLengths.push(
          request.messages.reduce((sum, message) => sum + message.content.length, 0),
        );
        const batch = JSON.parse(
          request.messages[1].content.split("\n\n", 1)[0],
        ) as Array<{ id: string }>;
        repairIssueCounts.push(batch.length);
        return JSON.stringify({ resolutions: [] });
      },
      {
        repairBoundaries: true,
        onProgress: (progress) => {
          if (progress.stage === "boundary_repair") {
            repairProgress.push(progress.completed);
          }
        },
      },
    );

    expect(result.boundaryIssues).toHaveLength(characterCount);
    expect(result.stats.repairCalls).toBe(2);
    expect(repairProgress).toContain(0);
    expect(
      repairProgress.filter((completed) => completed > 0).sort((left, right) => left - right),
    ).toEqual([1, 2]);
    expect(repairIssueCounts.sort((left, right) => left - right)).toEqual([5, 40]);
    expect(repairMessageLengths.every((length) => length <= 120_000)).toBe(true);
  });
});
