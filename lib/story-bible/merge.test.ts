import { describe, expect, it } from "vitest";
import { chunkNovel } from "../novel/chunking";
import { createEmptyStoryBible, mergeStoryBible } from "./merge";
import { makeDelta, sourceRef, THREE_CHAPTER_NOVEL, threeChunks } from "./test-helpers";
import type { StoryBible } from "./types";
import { validateStoryBibleDelta } from "./validate";

function bibleWithHolmesAtHome(): StoryBible {
  const [chunk] = threeChunks();
  const ref = sourceRef(chunk, chunk.coreRange.end);
  const delta = makeDelta(chunk, {
    characters: [
      {
        id: "char_holmes",
        name: "福尔摩斯",
        aliases: ["歇洛克"],
        description: "侦探",
        sourceRefs: [ref],
      },
    ],
    newFacts: [
      {
        id: "fact_location_1",
        kind: "location",
        subjectId: "char_holmes",
        predicate: "current_location",
        value: "贝克街",
        statement: "福尔摩斯在贝克街",
        status: "source_fact",
        sourceRefs: [ref],
      },
    ],
    boundaryState: {
      chunkId: chunk.id,
      asOfParagraph: chunk.coreRange.end,
      location: "贝克街",
      characters: [
        {
          characterId: "char_holmes",
          location: "贝克街",
          knowledge: [],
          activeGoals: [],
          sourceRefs: [ref],
        },
      ],
      objects: [],
      openReferences: [],
      sourceRefs: [ref],
    },
  });
  return mergeStoryBible(createEmptyStoryBible("fixture"), delta, chunk);
}

describe("Story Bible 确定性合并", () => {
  it("正常状态变化显式 supersede，保留历史且不制造冲突", () => {
    const [, chunk] = threeChunks();
    const bible = bibleWithHolmesAtHome();
    const ref = sourceRef(chunk, chunk.coreRange.end);
    const delta = makeDelta(chunk, {
      newFacts: [
        {
          id: "fact_location_2",
          kind: "location",
          subjectId: "char_holmes",
          predicate: "currently_at",
          value: "命案现场",
          statement: "福尔摩斯到达命案现场",
          status: "source_fact",
          supersedesFactId: "fact_location_1",
          supersessionReason: "state_change",
          sourceRefs: [ref],
        },
      ],
    });

    expect(validateStoryBibleDelta(delta, bible, chunk).valid).toBe(true);
    const result = mergeStoryBible(bible, delta, chunk);
    expect(result.facts).toHaveLength(2);
    expect(result.facts[0].supersededByFactId).toBe("fact_location_2");
    expect(result.facts[1].supersedesFactId).toBe("fact_location_1");
    expect(result.conflicts).toHaveLength(0);
    expect(result.processedRange).toEqual({ start: 1, end: chunk.coreRange.end });
  });

  it("同一事实键出现不同值但未明确替代时，不采用后文覆盖前文", () => {
    const [, chunk] = threeChunks();
    const bible = bibleWithHolmesAtHome();
    const ref = sourceRef(chunk);
    const delta = makeDelta(chunk, {
      newFacts: [
        {
          id: "fact_location_claim",
          kind: "location",
          subjectId: "char_holmes",
          predicate: "location",
          value: "苏格兰场",
          statement: "另一处文字称他在苏格兰场",
          status: "uncertain",
          sourceRefs: [ref],
        },
      ],
    });

    const result = mergeStoryBible(bible, delta, chunk);
    expect(result.facts).toHaveLength(1);
    expect(result.facts[0].value).toBe("贝克街");
    expect(result.conflicts).toMatchObject([
      { type: "fact_value", status: "open", existingFactId: "fact_location_1" },
    ]);
    expect(result.conflicts[0].incomingFact?.value).toBe("苏格兰场");
  });

  it("人物视角不同的说法分别保存，不误判成客观事实冲突", () => {
    const [chunk] = threeChunks();
    const ref = sourceRef(chunk);
    const delta = makeDelta(chunk, {
      characters: [
        { id: "char_holmes", name: "福尔摩斯", aliases: [], sourceRefs: [ref] },
        { id: "char_watson", name: "华生", aliases: [], sourceRefs: [ref] },
      ],
      newFacts: [
        {
          id: "fact_belief_h",
          kind: "knowledge",
          subjectId: "case_1",
          predicate: "culprit",
          value: "园丁",
          statement: "福尔摩斯认为园丁是凶手",
          status: "source_fact",
          perspectiveCharacterId: "char_holmes",
          sourceRefs: [ref],
        },
        {
          id: "fact_belief_w",
          kind: "knowledge",
          subjectId: "case_1",
          predicate: "culprit",
          value: "管家",
          statement: "华生认为管家是凶手",
          status: "source_fact",
          perspectiveCharacterId: "char_watson",
          sourceRefs: [ref],
        },
      ],
    });

    expect(validateStoryBibleDelta(delta, createEmptyStoryBible(), chunk).valid).toBe(true);
    const result = mergeStoryBible(createEmptyStoryBible(), delta, chunk);
    expect(result.facts).toHaveLength(2);
    expect(result.conflicts).toHaveLength(0);
  });

  it("人物别名碰撞时保留 provisional 人物和其依赖，不产生悬空引用", () => {
    const [, chunk] = threeChunks();
    const bible = bibleWithHolmesAtHome();
    const ref = sourceRef(chunk);
    const delta = makeDelta(chunk, {
      characters: [
        {
          id: "char_detective",
          name: "夏洛克",
          aliases: ["福尔摩斯"],
          sourceRefs: [ref],
        },
      ],
      newFacts: [
        {
          id: "fact_detective_job",
          kind: "character",
          subjectId: "char_detective",
          predicate: "occupation",
          value: "侦探",
          statement: "夏洛克是侦探",
          status: "source_fact",
          sourceRefs: [ref],
        },
      ],
    });

    const result = mergeStoryBible(bible, delta, chunk);
    expect(result.characters.find((item) => item.id === "char_detective")).toMatchObject({
      identityStatus: "provisional",
    });
    expect(result.facts.some((fact) => fact.subjectId === "char_detective")).toBe(true);
    expect(result.conflicts.some((conflict) => conflict.type === "identity")).toBe(true);
  });

  it("后文证据可结构化关闭旧冲突", () => {
    const [, second, third] = threeChunks();
    const firstBible = bibleWithHolmesAtHome();
    const conflictDelta = makeDelta(second, {
      newFacts: [
        {
          id: "fact_location_claim",
          kind: "location",
          subjectId: "char_holmes",
          predicate: "current_location",
          value: "苏格兰场",
          statement: "文字称他在苏格兰场",
          status: "uncertain",
          sourceRefs: [sourceRef(second)],
        },
      ],
    });
    const conflicted = mergeStoryBible(firstBible, conflictDelta, second);
    const conflictId = conflicted.conflicts[0].id;
    const ref = sourceRef(third);
    const resolutionDelta = makeDelta(third, {
      newFacts: [
        {
          id: "fact_location_3",
          kind: "location",
          subjectId: "char_holmes",
          predicate: "current_location",
          value: "苏格兰场",
          statement: "后文确认他已前往苏格兰场",
          status: "source_fact",
          supersedesFactId: "fact_location_1",
          supersessionReason: "correction",
          sourceRefs: [ref],
        },
      ],
      resolvedConflicts: [
        {
          conflictId,
          resolutionType: "confirmed_incoming",
          resolvedByFactId: "fact_location_3",
          explanation: "后文给出明确地点",
          sourceRefs: [ref],
        },
      ],
    });

    expect(validateStoryBibleDelta(resolutionDelta, conflicted, third).valid).toBe(true);
    const result = mergeStoryBible(conflicted, resolutionDelta, third);
    expect(result.conflicts.find((item) => item.id === conflictId)).toMatchObject({
      status: "resolved",
      resolutionType: "confirmed_incoming",
      resolvedByFactId: "fact_location_3",
    });
  });

  it("合并结果不与输入共享出处对象", () => {
    const [, chunk] = threeChunks();
    const bible = bibleWithHolmesAtHome();
    const delta = makeDelta(chunk);
    const bibleBefore = JSON.stringify(bible);
    const deltaBefore = JSON.stringify(delta);
    const result = mergeStoryBible(bible, delta, chunk);

    result.facts[0].sourceRefs[0].paragraphRange.start = 999;
    result.boundaryState!.sourceRefs[0].paragraphRange.start = 999;
    expect(JSON.stringify(bible)).toBe(bibleBefore);
    expect(JSON.stringify(delta)).toBe(deltaBefore);
  });
});

describe("Story Bible 增量硬校验", () => {
  it("拒绝无法完整带入下一块的过大边界状态", () => {
    const [chunk] = threeChunks();
    const delta = makeDelta(chunk);
    delta.boundaryState.location = "甲".repeat(25_000);

    const result = validateStoryBibleDelta(
      delta,
      createEmptyStoryBible(),
      chunk,
    );
    expect(result.valid).toBe(false);
    expect(result.issues.some((issue) => issue.path === "boundaryState")).toBe(true);
  });

  it("同一人物 id 不能在后续块被模型改成另一个姓名", () => {
    const [, chunk] = threeChunks();
    const bible = bibleWithHolmesAtHome();
    const delta = makeDelta(chunk, {
      characters: [
        {
          id: "char_holmes",
          name: "华生",
          aliases: [],
          sourceRefs: [sourceRef(chunk)],
        },
      ],
    });
    const result = validateStoryBibleDelta(delta, bible, chunk);
    expect(result.valid).toBe(false);
    expect(result.issues).toContainEqual({
      path: "characters[0].name",
      message: "人物 id char_holmes 不能从「福尔摩斯」改成「华生」",
    });
  });

  it("非空 openReference 可通过，但引用 overlap 会被拒绝", () => {
    const [, chunk] = threeChunks();
    const bible = bibleWithHolmesAtHome();
    const coreRef = sourceRef(chunk);
    const valid = makeDelta(chunk);
    valid.boundaryState.openReferences = [
      { text: "那位侦探", candidateCharacterIds: ["char_holmes"], sourceRef: coreRef },
    ];
    expect(validateStoryBibleDelta(valid, bible, chunk).valid).toBe(true);

    const overlapParagraph = chunk.coreRange.start - 1;
    valid.boundaryState.openReferences[0].sourceRef = {
      chapterId: "chapter_001",
      chunkId: chunk.id,
      paragraphRange: { start: overlapParagraph, end: overlapParagraph },
    };
    const result = validateStoryBibleDelta(valid, bible, chunk);
    expect(result.valid).toBe(false);
    expect(result.issues.some((issue) => issue.path.includes("openReferences[0].sourceRef"))).toBe(true);
  });

  it("拒绝替代不同事实键、模型写服务端字段和未知人物外键", () => {
    const [, chunk] = threeChunks();
    const bible = bibleWithHolmesAtHome();
    const ref = sourceRef(chunk);
    const delta = makeDelta(chunk, {
      newFacts: [
        {
          id: "fact_wrong",
          kind: "knowledge",
          subjectId: "char_holmes",
          predicate: "knows",
          value: "线索",
          statement: "知道线索",
          status: "source_fact",
          supersedesFactId: "fact_location_1",
          supersessionReason: "reveal",
          supersededByFactId: "model_owned",
          sourceRefs: [ref],
        },
      ],
      timelineEvents: [
        {
          id: "event_unknown",
          summary: "幽灵出现",
          order: 1,
          characterIds: ["char_ghost"],
          sourceRefs: [ref],
        },
      ],
      boundaryState: {
        ...makeDelta(chunk).boundaryState,
        objects: [
          {
            objectId: "obj_letter",
            holderCharacterId: "char_ghost",
            sourceRefs: [ref],
          },
        ],
      },
    });

    const result = validateStoryBibleDelta(delta, bible, chunk);
    expect(result.valid).toBe(false);
    expect(result.issues.map((issue) => issue.path)).toEqual(
      expect.arrayContaining([
        "newFacts[0].supersedesFactId",
        "newFacts[0].supersededByFactId",
        "timelineEvents[0].characterIds[0]",
        "boundaryState.objects[0].holderCharacterId",
      ]),
    );
  });

  it("跨章节块中，chapterId 必须与引用段落精确对应", () => {
    const chunk = chunkNovel(THREE_CHAPTER_NOVEL, {
      targetChars: 29,
      overlapChars: 0,
    }).chunks[0];
    const delta = makeDelta(chunk);
    delta.reportedConflicts = [
      {
        description: "错误章节标注",
        sourceRefs: [
          {
            chapterId: "chapter_001",
            chunkId: chunk.id,
            paragraphRange: { start: 3, end: 3 },
          },
        ],
      },
    ];
    const result = validateStoryBibleDelta(delta, createEmptyStoryBible(), chunk);
    expect(result.valid).toBe(false);
    expect(result.issues).toContainEqual({
      path: "reportedConflicts[0].sourceRefs[0].chapterId",
      message: "章节 id 与引用段落不匹配",
    });
  });

  it("无关事实不能关闭旧冲突", () => {
    const [, second, third] = threeChunks();
    const bible = bibleWithHolmesAtHome();
    const conflicted = mergeStoryBible(
      bible,
      makeDelta(second, {
        newFacts: [
          {
            id: "fact_location_claim",
            kind: "location",
            subjectId: "char_holmes",
            predicate: "current_location",
            value: "苏格兰场",
            statement: "文字称他在苏格兰场",
            status: "uncertain",
            sourceRefs: [sourceRef(second)],
          },
        ],
      }),
      second,
    );
    const ref = sourceRef(third);
    const delta = makeDelta(third, {
      newFacts: [
        {
          id: "fact_unrelated",
          kind: "knowledge",
          subjectId: "char_holmes",
          predicate: "knows",
          value: "天气晴朗",
          statement: "福尔摩斯知道天气晴朗",
          status: "source_fact",
          sourceRefs: [ref],
        },
      ],
      resolvedConflicts: [
        {
          conflictId: conflicted.conflicts[0].id,
          resolutionType: "correction",
          resolvedByFactId: "fact_unrelated",
          explanation: "用无关事实尝试关闭地点冲突",
          sourceRefs: [ref],
        },
      ],
    });
    const result = validateStoryBibleDelta(delta, conflicted, third);
    expect(result.valid).toBe(false);
    expect(result.issues).toContainEqual({
      path: "resolvedConflicts[0].resolvedByFactId",
      message: "解决事实与目标冲突的新旧事实键或取值无关",
    });
  });
});
