import { describe, expect, it } from "vitest";
import { buildShortNovelUnderstanding } from "./short-pipeline";

function rawRef(start: number, end = start) {
  return {
    chapterId: "model_must_not_control_this",
    chunkId: "chunk_001",
    paragraphRange: { start, end },
  };
}

function combinedFixture() {
  return JSON.stringify({
    headings: [
      { headingParagraph: 1, role: "chapter", decision: "selected" },
      { headingParagraph: 3, role: "chapter", decision: "selected" },
    ],
    storyBibleDelta: {
      chunkId: "chunk_001",
      processedRange: { start: 1, end: 4 },
      characters: [
        {
          id: "char_001",
          name: "福尔摩斯",
          aliases: ["歇洛克"],
          sourceRefs: [rawRef(2)],
        },
      ],
      newFacts: [
        {
          id: "fact_001",
          kind: "location",
          subjectId: "char_001",
          predicate: "current_location",
          value: "苏格兰场",
          statement: "福尔摩斯到了苏格兰场",
          status: "source_fact",
          sourceRefs: [rawRef(4)],
        },
      ],
      timelineEvents: [],
      openedThreads: [],
      resolvedThreads: [],
      reportedConflicts: [],
      resolvedConflicts: [],
      boundaryState: {
        chunkId: "chunk_001",
        asOfParagraph: 4,
        timeLabel: "",
        location: "苏格兰场",
        characters: [
          {
            characterId: "char_001",
            location: "苏格兰场",
            knowledge: [],
            activeGoals: [],
            sourceRefs: [rawRef(4)],
          },
        ],
        objects: [],
        openReferences: [],
        sourceRefs: [rawRef(4)],
      },
    },
  });
}

describe("短篇结构 + Story Bible 单次理解", () => {
  it("只调用一次模型，结构校验后由代码回填真实 chapterId", async () => {
    const novel = ["第一章 雨夜", "福尔摩斯出场", "第二章 清晨", "他到了苏格兰场"].join("\n");
    let calls = 0;
    const result = await buildShortNovelUnderstanding(novel, async (messages) => {
      calls += 1;
      expect(messages[1].content).toContain("¶4 他到了苏格兰场");
      return combinedFixture();
    });

    expect(calls).toBe(1);
    expect(result.modelCalls).toBe(1);
    expect(result.chunkedNovel.chunks).toHaveLength(1);
    expect(result.chunkedNovel.chapters.map((chapter) => chapter.title)).toEqual([
      "第一章 雨夜",
      "第二章 清晨",
    ]);
    expect(result.bible.characters[0].sourceRefs[0].chapterId).toBe("chapter_001");
    expect(result.bible.facts[0].sourceRefs[0].chapterId).toBe("chapter_002");
    expect(result.bible.boundaryState?.sourceRefs[0].chapterId).toBe("chapter_002");
    expect(JSON.stringify(result.bible)).not.toContain("model_must_not_control_this");
  });

  it("单次通读也能在同一 delta 内保留前后状态历史", async () => {
    const novel = ["第一章 雨夜", "他在贝克街", "第二章 清晨", "他到了苏格兰场"].join("\n");
    const fixture = JSON.parse(combinedFixture()) as {
      storyBibleDelta: { newFacts: Array<Record<string, unknown>> };
    };
    fixture.storyBibleDelta.newFacts = [
      {
        id: "fact_old",
        kind: "location",
        subjectId: "char_001",
        predicate: "current_location",
        value: "贝克街",
        statement: "福尔摩斯在贝克街",
        status: "source_fact",
        sourceRefs: [rawRef(2)],
      },
      {
        id: "fact_new",
        kind: "location",
        subjectId: "char_001",
        predicate: "current_location",
        value: "苏格兰场",
        statement: "福尔摩斯到了苏格兰场",
        status: "source_fact",
        supersedesFactId: "fact_old",
        supersessionReason: "state_change",
        sourceRefs: [rawRef(4)],
      },
    ];

    const result = await buildShortNovelUnderstanding(
      novel,
      async (messages) => {
        expect(messages[0].content).toContain("supersedesFactId");
        return JSON.stringify(fixture);
      },
    );
    expect(result.bible.facts).toHaveLength(2);
    expect(result.bible.facts[0].supersededByFactId).toBe("fact_new");
    expect(result.bible.facts[1]).toMatchObject({
      supersedesFactId: "fact_old",
      supersessionReason: "state_change",
    });
  });

  it("超过短篇上限时在发起模型请求前拒绝", async () => {
    let calls = 0;
    await expect(
      buildShortNovelUnderstanding(
        "长".repeat(101),
        async () => {
          calls += 1;
          return "";
        },
        { shortNovelChars: 100 },
      ),
    ).rejects.toThrow("超过短篇单次理解上限");
    expect(calls).toBe(0);
  });

  it("正好 30000 个有效字即使因段号预算被安全切段，仍是一轮调用和一个冻结块", async () => {
    let calls = 0;
    const result = await buildShortNovelUnderstanding(
      "甲".repeat(30_000),
      async () => {
        calls += 1;
        return JSON.stringify({
          headings: [],
          storyBibleDelta: {
            chunkId: "chunk_001",
            processedRange: { start: 1, end: 2 },
            characters: [],
            newFacts: [],
            timelineEvents: [],
            openedThreads: [],
            resolvedThreads: [],
            reportedConflicts: [],
            resolvedConflicts: [],
            boundaryState: {
              chunkId: "chunk_001",
              asOfParagraph: 2,
              timeLabel: "",
              location: "",
              characters: [],
              objects: [],
              openReferences: [],
              sourceRefs: [rawRef(2)],
            },
          },
        });
      },
    );

    expect(calls).toBe(1);
    expect(result.modelCalls).toBe(1);
    expect(result.chunkedNovel.paragraphs).toHaveLength(2);
    expect(result.chunkedNovel.chunks).toHaveLength(1);
  });

  it("非空白字数很少但原始请求被内部空格撑大时，改走长篇而不调用模型", async () => {
    let calls = 0;
    await expect(
      buildShortNovelUnderstanding(
        `第${" ".repeat(400_000)}一章 雨夜\n正文`,
        async () => {
          calls += 1;
          return "";
        },
      ),
    ).rejects.toThrow("请改用长篇分块路径");
    expect(calls).toBe(0);
  });

  it("进入时 signal 已取消则不发起短篇理解调用", async () => {
    const controller = new AbortController();
    controller.abort();
    let calls = 0;

    await expect(
      buildShortNovelUnderstanding(
        "第一章\n正文",
        async () => {
          calls += 1;
          return combinedFixture();
        },
        { signal: controller.signal },
      ),
    ).rejects.toThrow("Story Bible 任务已取消");
    expect(calls).toBe(0);
  });
});
