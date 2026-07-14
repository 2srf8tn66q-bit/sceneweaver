import { describe, expect, it } from "vitest";
import { createEmptyStoryBible } from "./merge";
import {
  buildStoryBibleMessages,
  MAX_ROLLING_STORY_BIBLE_REQUEST_CHARS,
} from "./prompts";
import { sourceRef, threeChunks } from "./test-helpers";

describe("Story Bible prompt 衔接上下文", () => {
  it("下一块同时拿到局部边界、相关旧事实和全部未决冲突", () => {
    const [, chunk] = threeChunks();
    const ref = sourceRef(chunk);
    const bible = createEmptyStoryBible("fixture");
    bible.version = 24;
    bible.processedRange = { start: 1, end: chunk.coreRange.start - 1 };
    bible.characters = [
      {
        id: "char_q",
        name: "Q",
        aliases: [],
        description: "单字称谓人物",
        sourceRefs: [ref],
      },
    ];
    bible.facts = [
      {
        id: "fact_old",
        kind: "constraint",
        subjectId: "story",
        predicate: "rule",
        value: "不可见血",
        statement: "全局约束",
        status: "source_fact",
        sourceRefs: [ref],
      },
    ];
    bible.boundaryState = {
      chunkId: "chunk_001",
      asOfParagraph: chunk.coreRange.start - 1,
      location: "门外",
      characters: [
        {
          characterId: "char_q",
          location: "门外",
          knowledge: ["知道门已锁"],
          activeGoals: ["进入房间"],
          sourceRefs: [ref],
        },
      ],
      objects: [],
      openReferences: [],
      sourceRefs: [ref],
    };
    bible.conflicts = Array.from({ length: 25 }, (_, index) => ({
      id: `conflict_${String(index + 1).padStart(3, "0")}`,
      type: "reported" as const,
      description: `未决冲突 ${index + 1}`,
      status: "open" as const,
      sourceRefs: [ref],
    }));

    const messages = buildStoryBibleMessages("Q推了推门。", chunk, bible);
    expect(messages[1].content).toContain('"relevantCharacters":[{"id":"char_q"');
    expect(messages[1].content).toContain('"boundaryState":{"chunkId":"chunk_001"');
    expect(messages[1].content).toContain('"conflict_001"');
    expect(messages[1].content).toContain('"conflict_025"');
  });

  it("输出骨架不含省略号占位符，并明确三类 supersession", () => {
    const [chunk] = threeChunks();
    const [system] = buildStoryBibleMessages("正文", chunk, createEmptyStoryBible());
    expect(system.content).not.toContain("[...]");
    expect(system.content).not.toContain("{...}");
    expect(system.content).toContain("state_change / correction / reveal");
    expect(system.content).toContain('"resolvedConflicts":[]');
  });

  it("长期积累事实时发送相关性有界视图，整个请求不超硬上限", () => {
    const [, chunk] = threeChunks();
    const bible = createEmptyStoryBible("fixture");
    const ref = sourceRef(chunk);
    bible.facts = Array.from({ length: 2_000 }, (_, index) => ({
      id: `fact_${String(index).padStart(4, "0")}`,
      kind: "constraint" as const,
      subjectId: "global:story",
      predicate: `rule_${index}`,
      value: `约束${index}${"甲".repeat(500)}`,
      statement: `全书约束${index}`,
      status: "source_fact" as const,
      sourceRefs: [ref],
    }));

    const messages = buildStoryBibleMessages("正文", chunk, bible);
    const requestChars = messages.reduce(
      (sum, message) => sum + message.content.length,
      0,
    );
    expect(requestChars).toBeLessThanOrEqual(
      MAX_ROLLING_STORY_BIBLE_REQUEST_CHARS,
    );
    expect(messages[1].content).toContain('"omitted":{');
    expect(messages[1].content).toMatch(/"activeFactIndex":[1-9]\d*/);
    expect(messages[1].content).toContain('"fact_1999"');
  });
});
