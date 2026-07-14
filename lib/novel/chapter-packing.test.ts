import { describe, expect, it } from "vitest";
import { buildChapterFirstChunks } from "./chapter-pipeline";
import {
  chunkPreparedNovel,
  countNumberedParagraphChars,
  countTextChars,
  prepareNovelParagraphs,
  validateNovelInput,
} from "./chunking";
import { collectHeadingCandidates } from "./structure";
import type { ChunkedNovel, ParagraphRange } from "./types";

function modelOutput(
  headings: Array<{
    headingParagraph: number;
    role: "volume" | "chapter" | "section";
    decision: "selected" | "uncertain";
  }>,
) {
  return JSON.stringify({ headings });
}

function paragraphsInRange(result: ChunkedNovel, range: ParagraphRange) {
  return result.paragraphs.filter(
    (paragraph) => paragraph.n >= range.start && paragraph.n <= range.end,
  );
}

function expectSafeCompletePacking(
  result: ChunkedNovel,
  source: string,
  targetChars: number,
) {
  const coreNumbers = result.chunks.flatMap((chunk) =>
    paragraphsInRange(result, chunk.coreRange).map((paragraph) => paragraph.n),
  );
  expect(coreNumbers).toEqual(result.paragraphs.map((paragraph) => paragraph.n));
  expect(new Set(coreNumbers).size).toBe(coreNumbers.length);
  expect(
    result.chunks
      .flatMap((chunk) => paragraphsInRange(result, chunk.coreRange))
      .map((paragraph) => paragraph.text)
      .join("")
      .replace(/\s/g, ""),
  ).toBe(source.replace(/\s/g, ""));
  expect(result.chunks.every((chunk) => chunk.coreCharCount <= targetChars)).toBe(true);
}

describe("章节优先装箱", () => {
  it("完整小章可以合并进一块，但不拆章也不突破预算", async () => {
    const source = [
      "# 第一章 雨夜",
      "甲".repeat(6),
      "# 第二章 清晨",
      "乙".repeat(6),
      "# 第三章 归途",
      "丙".repeat(6),
    ].join("\n");
    const result = await buildChapterFirstChunks(
      source,
      async () =>
        modelOutput([
          { headingParagraph: 1, role: "chapter", decision: "selected" },
          { headingParagraph: 3, role: "chapter", decision: "selected" },
          { headingParagraph: 5, role: "chapter", decision: "selected" },
        ]),
      { targetChars: 43, overlapChars: 0 },
    );

    expect(result.structure.status).toBe("resolved");
    expect(result.chunkedNovel.chunks.map((chunk) => chunk.chapterIds)).toEqual([
      ["chapter_001", "chapter_002"],
      ["chapter_003"],
    ]);
    expect(result.chunkedNovel.chunks.map((chunk) => chunk.coreRange)).toEqual([
      { start: 1, end: 4 },
      { start: 5, end: 6 },
    ]);
    expectSafeCompletePacking(result.chunkedNovel, source, 43);
  });

  it("超长章先在节边界分开，不把节标题与本节正文拆散", async () => {
    const source = [
      "第一章",
      "引".repeat(5),
      "第一节",
      "甲".repeat(7),
      "第二节",
      "乙".repeat(7),
    ].join("\n");
    const result = await buildChapterFirstChunks(
      source,
      async () =>
        modelOutput([
          { headingParagraph: 1, role: "chapter", decision: "selected" },
          { headingParagraph: 3, role: "section", decision: "selected" },
          { headingParagraph: 5, role: "section", decision: "selected" },
        ]),
      { targetChars: 17, overlapChars: 0 },
    );

    expect(result.structure.splitHints).toEqual([3, 5]);
    expect(result.chunkedNovel.chunks.map((chunk) => chunk.coreRange)).toEqual([
      { start: 1, end: 2 },
      { start: 3, end: 4 },
      { start: 5, end: 6 },
    ]);
    expectSafeCompletePacking(result.chunkedNovel, source, 17);
  });

  it("单个节仍超预算时，再逐级降到段落、句子和字符硬切", async () => {
    const source = ["第一章", "第一节", "无标点甲乙丙丁戊".repeat(20)].join("\n");
    const targetChars = 24;
    const result = await buildChapterFirstChunks(
      source,
      async () =>
        modelOutput([
          { headingParagraph: 1, role: "chapter", decision: "selected" },
          { headingParagraph: 2, role: "section", decision: "selected" },
        ]),
      { targetChars, overlapChars: 6 },
    );

    expect(result.chunkedNovel.paragraphs.length).toBeGreaterThan(3);
    expect(result.chunkedNovel.chunks.length).toBeGreaterThan(1);
    expectSafeCompletePacking(result.chunkedNovel, source, targetChars);
  });

  it("结构不可靠时退回全文安全分块，仍然不丢不重", async () => {
    const source = "没有标题的连续正文".repeat(80);
    const result = await buildChapterFirstChunks(
      source,
      async () => JSON.stringify({ headings: [] }),
      { targetChars: 50, overlapChars: 10 },
    );

    expect(result.structure.status).toBe("fallback");
    expect(result.chunkedNovel.chapters).toMatchObject([
      { title: "正文", kind: "fallback" },
    ]);
    expectSafeCompletePacking(result.chunkedNovel, source, 50);
  });
});

describe("结构段号与装箱段号一致", () => {
  it("超长段落造成重编号时，识别和装箱复用同一份段落表", async () => {
    const source = ["第一章", "甲".repeat(70), "第二章", "乙".repeat(10)].join("\n");
    const options = { targetChars: 20, overlapChars: 5 };
    const prepared = prepareNovelParagraphs(source, options);
    const candidates = collectHeadingCandidates(prepared);
    const secondHeading = candidates.find((candidate) => candidate.text === "第二章")!;
    expect(secondHeading.paragraph).toBeGreaterThan(3);

    const call = async () =>
      modelOutput([
        { headingParagraph: 1, role: "chapter", decision: "selected" },
        {
          headingParagraph: secondHeading.paragraph,
          role: "chapter",
          decision: "selected",
        },
      ]);
    const first = await buildChapterFirstChunks(source, call, options);
    const second = await buildChapterFirstChunks(source, call, options);

    expect(first).toEqual(second);
    expect(first.chunkedNovel.paragraphs).toEqual(prepared);
    expect(first.chunkedNovel.chapters[1].headingParagraph).toBe(secondHeading.paragraph);
    expectSafeCompletePacking(first.chunkedNovel, source, 20);
  });

  it("拒绝不连续的外部章节表，不带病装箱", () => {
    const paragraphs = prepareNovelParagraphs("第一段\n第二段\n第三段", {
      targetChars: 20,
      overlapChars: 0,
    });
    expect(() =>
      chunkPreparedNovel(
        paragraphs,
        [
          {
            id: "chapter_001",
            index: 0,
            title: "坏章节",
            paragraphRange: { start: 2, end: 3 },
            charCount: paragraphs
              .slice(1)
              .reduce((sum, paragraph) => sum + countTextChars(paragraph.text), 0),
          },
        ],
        { targetChars: 20, overlapChars: 0 },
      ),
    ).toThrow("章节范围不连续");
  });

  it("拒绝小数章节端点和小数切分提示，不能绕过核心硬预算", () => {
    const paragraphs = prepareNovelParagraphs("甲甲甲甲甲甲\n乙乙乙乙乙乙\n丙丙丙丙丙丙", {
      targetChars: 10,
      overlapChars: 0,
    });
    const validChapter = {
      id: "chapter_001",
      index: 0,
      title: "正文",
      paragraphRange: { start: 1, end: 3 },
      charCount: countNumberedParagraphChars(paragraphs),
    };

    expect(() =>
      chunkPreparedNovel(
        paragraphs,
        [
          {
            ...validChapter,
            paragraphRange: { start: 1, end: 1.5 },
            charCount: 6,
          },
          {
            ...validChapter,
            id: "chapter_002",
            index: 1,
            paragraphRange: { start: 2.5, end: 3 },
            charCount: 6,
          },
        ],
        { targetChars: 10, overlapChars: 0 },
      ),
    ).toThrow("真实整数段号");

    expect(() =>
      chunkPreparedNovel(paragraphs, [validChapter], {
        targetChars: 10,
        overlapChars: 0,
        splitHints: [1.5],
      }),
    ).toThrow("切分提示 1.5 不是真实整数段号");
  });

  it("在任何模型调用前执行 50 万字符与 10MB 单文件硬限制", async () => {
    let calls = 0;
    await expect(
      buildChapterFirstChunks("甲".repeat(500_001), async () => {
        calls += 1;
        return modelOutput([]);
      }),
    ).rejects.toThrow("最多 500000");
    expect(calls).toBe(0);

    expect(() => validateNovelInput("甲" + " ".repeat(10 * 1024 * 1024) + "乙"))
      .toThrow("最大 10485760 字节");
  });

  it.each(["", " \n\t\r\n "])(
    "空或全空白小说在任何模型调用前拒绝：%j",
    async (source) => {
      let calls = 0;
      await expect(
        buildChapterFirstChunks(source, async () => {
          calls += 1;
          return modelOutput([]);
        }),
      ).rejects.toThrow("长篇小说不能为空");
      expect(calls).toBe(0);
    },
  );
});
