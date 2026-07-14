import { describe, expect, it } from "vitest";
import {
  countPromptChars,
  countNumberedParagraphChars,
  countTextChars,
  chunkNovel,
  renderNovelChunk,
} from "./chunking";
import type { ChunkedNovel, ParagraphRange } from "./types";

function paragraphsInRange(result: ChunkedNovel, range?: ParagraphRange) {
  if (!range) return [];
  return result.paragraphs.filter(
    (paragraph) => paragraph.n >= range.start && paragraph.n <= range.end,
  );
}

function charsInRange(result: ChunkedNovel, range?: ParagraphRange): number {
  return countNumberedParagraphChars(paragraphsInRange(result, range));
}

function expectHardBudgets(
  result: ChunkedNovel,
  targetChars: number,
  overlapChars: number,
) {
  for (const chunk of result.chunks) {
    expect(chunk.coreCharCount, `${chunk.id} core`).toBeLessThanOrEqual(targetChars);
    expect(charsInRange(result, chunk.overlapBefore), `${chunk.id} overlapBefore`).toBeLessThanOrEqual(
      overlapChars,
    );
    expect(charsInRange(result, chunk.overlapAfter), `${chunk.id} overlapAfter`).toBeLessThanOrEqual(
      overlapChars,
    );
    expect(chunk.contextCharCount, `${chunk.id} context`).toBeLessThanOrEqual(
      targetChars + overlapChars * 2,
    );
  }
}

function expectCoreCoversSourceExactlyOnce(result: ChunkedNovel, source: string) {
  const coreParagraphNumbers = result.chunks.flatMap((chunk) =>
    paragraphsInRange(result, chunk.coreRange).map((paragraph) => paragraph.n),
  );
  const allParagraphNumbers = result.paragraphs.map((paragraph) => paragraph.n);

  expect(coreParagraphNumbers).toEqual(allParagraphNumbers);
  expect(new Set(coreParagraphNumbers).size).toBe(coreParagraphNumbers.length);

  const reconstructed = result.chunks
    .flatMap((chunk) => paragraphsInRange(result, chunk.coreRange))
    .map((paragraph) => paragraph.text)
    .join("");
  expect(reconstructed.replace(/\s/g, "")).toBe(source.replace(/\s/g, ""));
  expect(result.totalChars).toBe(countTextChars(source));
}

describe("安全切分器：换行与超长输入陷阱", () => {
  it("把仅使用 CR 的文本识别为多段，并完整覆盖", () => {
    const source = [
      "第一段甲甲甲甲",
      "第二段乙乙乙乙",
      "第三段丙丙丙丙",
      "第四段丁丁丁丁",
    ].join("\r");

    const result = chunkNovel(source, { targetChars: 12, overlapChars: 3 });

    expect(result.paragraphs.map((paragraph) => paragraph.text)).toEqual([
      "第一段甲甲甲甲",
      "第二段乙乙乙乙",
      "第三段丙丙丙丙",
      "第四段丁丁丁丁",
    ]);
    expectCoreCoversSourceExactlyOnce(result, source);
    expectHardBudgets(result, 12, 3);
  });

  it("10 万字无换行、无标点文本仍不突破核心硬上限", () => {
    const source = "甲乙丙丁戊".repeat(20_000);
    const targetChars = 10_000;
    const overlapChars = 800;

    const result = chunkNovel(source, { targetChars, overlapChars });

    expect(result.totalChars).toBe(100_000);
    expect(result.chunks.length).toBeGreaterThan(1);
    expectCoreCoversSourceExactlyOnce(result, source);
    expectHardBudgets(result, targetChars, overlapChars);
  });

  it("粗长段落不会让核心或 overlap 随整段一起膨胀", () => {
    const source = [
      `甲段开${"甲".repeat(18_000)}甲段末。`,
      `乙段开${"乙".repeat(22_000)}乙段末。`,
      `丙段开${"丙".repeat(16_000)}丙段末。`,
    ].join("\n");
    const targetChars = 8_000;
    const overlapChars = 600;

    const result = chunkNovel(source, { targetChars, overlapChars });

    expectCoreCoversSourceExactlyOnce(result, source);
    expectHardBudgets(result, targetChars, overlapChars);
  });

  it("未超 core 但远大于 overlap 的粗段会先变成可重叠原子", () => {
    const source = ["甲".repeat(6_000), "乙".repeat(20_000), "丙".repeat(6_000)].join("\n");

    for (const overlapChars of [400, 800, 1_000]) {
      const result = chunkNovel(source, { targetChars: 25_000, overlapChars });
      expect(result.chunks.length).toBeGreaterThan(1);
      expect(
        result.chunks.some(
          (chunk) => chunk.overlapBefore !== undefined || chunk.overlapAfter !== undefined,
        ),
      ).toBe(true);
      expectCoreCoversSourceExactlyOnce(result, source);
      expectHardBudgets(result, 25_000, overlapChars);
    }
  });

  it("多段 900 字正文跨块时仍有真实 overlap，不会因旧阈值变成零衔接", () => {
    const source = Array.from(
      { length: 30 },
      (_, index) => `${String(index).padStart(2, "0")}${"甲".repeat(898)}`,
    ).join("\n");
    const result = chunkNovel(source, {
      targetChars: 25_000,
      overlapChars: 800,
    });

    expect(result.chunks.length).toBeGreaterThan(1);
    expect(result.chunks[0].overlapAfter).toBeDefined();
    expect(result.chunks[1].overlapBefore).toBeDefined();
    expect(charsInRange(result, result.chunks[0].overlapAfter)).toBeGreaterThan(0);
    expect(charsInRange(result, result.chunks[1].overlapBefore)).toBeGreaterThan(0);
    expectCoreCoversSourceExactlyOnce(result, source);
    expectHardBudgets(result, 25_000, 800);
  });

  it("内部空格同样计入模型请求预算，长篇渲染不能被放大到几十万字符", () => {
    const source = `甲${" ".repeat(400_000)}乙`;
    const targetChars = 25_000;
    const overlapChars = 800;
    const result = chunkNovel(source, { targetChars, overlapChars });

    expect(result.totalChars).toBe(2);
    expect(result.chunks.length).toBeGreaterThan(1);
    expectCoreCoversSourceExactlyOnce(result, source);
    expect(
      result.chunks
        .flatMap((chunk) => paragraphsInRange(result, chunk.coreRange))
        .map((paragraph) => paragraph.text)
        .join(""),
    ).toBe(source);
    expectHardBudgets(result, targetChars, overlapChars);
    expect(
      result.chunks.every(
        (chunk) =>
          Array.from(renderNovelChunk(result.paragraphs, chunk)).length <=
          targetChars + overlapChars * 2 + 1_000,
      ),
    ).toBe(true);
  });

  it("十万行短段把段号开销计入装箱，实际渲染仍守住上下文预算", () => {
    const source = Array.from({ length: 100_000 }, () => "甲").join("\n");
    const targetChars = 25_000;
    const overlapChars = 800;
    const result = chunkNovel(source, { targetChars, overlapChars });

    expect(result.chunks.length).toBeGreaterThan(4);
    expectHardBudgets(result, targetChars, overlapChars);
    expect(
      result.chunks.every(
        (chunk) =>
          countPromptChars(renderNovelChunk(result.paragraphs, chunk)) <=
          targetChars + overlapChars * 2 + 1_000,
      ),
    ).toBe(true);
  });

  it("恰好 10MB 的合法极限输入可流式切分，不靠千万元素字符数组", () => {
    const maxBytes = 10 * 1024 * 1024;
    const source = `甲${" ".repeat(maxBytes - 6)}乙`;
    const targetChars = 25_000;
    const overlapChars = 800;
    const result = chunkNovel(source, { targetChars, overlapChars });

    expect(result.chunks.length).toBeGreaterThan(400);
    expect(result.paragraphs.map((paragraph) => paragraph.text).join("")).toBe(source);
    expectHardBudgets(result, targetChars, overlapChars);
    expect(
      result.chunks.every(
        (chunk) =>
          countPromptChars(renderNovelChunk(result.paragraphs, chunk)) <=
          targetChars + overlapChars * 2 + 1_000,
      ),
    ).toBe(true);
  }, 10_000);
});

describe("安全切分器：核心责任区属性", () => {
  it.each([
    {
      name: "大量短段",
      source: Array.from({ length: 137 }, (_, index) =>
        `${String(index).padStart(3, "0")}${"短".repeat((index % 11) + 1)}`,
      ).join("\n"),
      targetChars: 97,
      overlapChars: 13,
    },
    {
      name: "章节标题与长短正文混合",
      source: [
        "第一章 雨夜",
        "甲".repeat(73),
        "第二章 归途",
        "乙".repeat(211),
        "第三章 清晨",
        "丙".repeat(19),
      ].join("\n"),
      targetChars: 80,
      overlapChars: 17,
    },
    {
      name: "中英文和 emoji 按 Unicode 字符计数",
      source: ["Sherlock福尔摩斯🕵️".repeat(41), "Watson华生🩺".repeat(37)].join("\r\n"),
      targetChars: 127,
      overlapChars: 23,
    },
  ])("$name：全文 core 按原顺序覆盖且只覆盖一次", ({
    source,
    targetChars,
    overlapChars,
  }) => {
    const result = chunkNovel(source, { targetChars, overlapChars });

    expectCoreCoversSourceExactlyOnce(result, source);
    expectHardBudgets(result, targetChars, overlapChars);
  });

  it("相同输入与参数总是产生完全相同的切分", () => {
    const source = Array.from(
      { length: 40 },
      (_, index) => `段落${index}${"内容".repeat((index % 9) + 1)}`,
    ).join("\n");
    const options = { targetChars: 120, overlapChars: 20 };

    expect(chunkNovel(source, options)).toEqual(chunkNovel(source, options));
  });
});
