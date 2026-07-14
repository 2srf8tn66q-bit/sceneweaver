import { describe, expect, it } from "vitest";
import { splitParagraphs } from "../screenplay/paragraphs";
import {
  chunkNovel,
  isChapterHeading,
  renderNovelChunk,
  splitNovelChapters,
} from "./chunking";

describe("章节识别", () => {
  it("识别中文和英文标题，并保留标题前的开篇内容", () => {
    const paragraphs = splitParagraphs(
      "版权说明\n第一章 雨夜\n第一章正文\nChapter 2 The Door\n第二章正文",
    );
    const chapters = splitNovelChapters(paragraphs);
    expect(chapters.map((c) => c.title)).toEqual([
      "开篇",
      "第一章 雨夜",
      "Chapter 2 The Door",
    ]);
    expect(chapters.map((c) => c.paragraphRange)).toEqual([
      { start: 1, end: 1 },
      { start: 2, end: 3 },
      { start: 4, end: 5 },
    ]);
  });

  it("无章节标题时整篇作为正文", () => {
    const paragraphs = splitParagraphs("第一段\n第二段");
    expect(splitNovelChapters(paragraphs)).toMatchObject([
      { title: "正文", paragraphRange: { start: 1, end: 2 } },
    ]);
  });

  it.each([
    "第十二章 雨夜",
    "第3回",
    "一、歇洛克·福尔摩斯先生",
    "序章",
    "番外：旧事",
    "Chapter 7 Return",
  ])(
    "识别标题：%s",
    (title) => expect(isChapterHeading(title)).toBe(true),
  );

  it.each([
    "1．文学知识——无。",
    "5．植物学知识——不全面，但对于莨蓿制剂和鸦片",
    "12. 关于英国法律方面，他具有充分实用的知识。",
  ])("不把正文编号清单误判为章节：%s", (text) => {
    expect(isChapterHeading(text)).toBe(false);
  });

  it("《血字的研究》式章节与章内编号清单可稳定区分", () => {
    const paragraphs = splitParagraphs(
      [
        "一、歇洛克·福尔摩斯先生",
        "第一章正文",
        "二、演绎法",
        "第二章正文",
        "1．文学知识——无。",
        "2．哲学知识——无。",
        "5．植物学知识——不全面，但对于莨蓿制剂和鸦片",
        "12．关于英国法律方面，他具有充分实用的知识。",
        "三、劳瑞斯顿花园街的惨案",
        "第三章正文",
      ].join("\n"),
    );
    const chapters = splitNovelChapters(paragraphs);
    expect(chapters.map((chapter) => chapter.title)).toEqual([
      "一、歇洛克·福尔摩斯先生",
      "二、演绎法",
      "三、劳瑞斯顿花园街的惨案",
    ]);
    expect(chapters[1].paragraphRange).toEqual({ start: 3, end: 8 });
  });
});

describe("长篇分块", () => {
  it("优先按完整章节组合，核心区间连续且不重复", () => {
    const novel = [
      "第一章",
      "甲".repeat(6),
      "第二章",
      "乙".repeat(6),
      "第三章",
      "丙".repeat(6),
    ].join("\n");
    const result = chunkNovel(novel, { targetChars: 33, overlapChars: 0 });
    expect(result.chunks.map((c) => c.coreRange)).toEqual([
      { start: 1, end: 4 },
      { start: 5, end: 6 },
    ]);
    expect(result.chunks[0].chapterIds).toEqual(["chapter_001", "chapter_002"]);

    const covered = result.chunks.flatMap((chunk) => {
      const numbers: number[] = [];
      for (let n = chunk.coreRange.start; n <= chunk.coreRange.end; n++) numbers.push(n);
      return numbers;
    });
    expect(covered).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it("单章超过预算时只在段落边界拆分", () => {
    const novel = ["甲".repeat(6), "乙".repeat(6), "丙".repeat(6)].join("\n");
    const result = chunkNovel(novel, { targetChars: 19, overlapChars: 0 });
    expect(result.chunks.map((c) => c.coreRange)).toEqual([
      { start: 1, end: 2 },
      { start: 3, end: 3 },
    ]);
  });

  it("overlap 只扩大上下文，不改变核心责任区", () => {
    const novel = ["甲".repeat(4), "乙".repeat(4), "丙".repeat(4), "丁".repeat(4), "戊".repeat(4)].join("\n");
    const result = chunkNovel(novel, { targetChars: 15, overlapChars: 7 });
    expect(result.chunks.map((c) => c.coreRange)).toEqual([
      { start: 1, end: 2 },
      { start: 3, end: 4 },
      { start: 5, end: 5 },
    ]);
    expect(result.chunks[1]).toMatchObject({
      overlapBefore: { start: 2, end: 2 },
      overlapAfter: { start: 5, end: 5 },
      contextRange: { start: 2, end: 5 },
      coreCharCount: 15,
      contextCharCount: 29,
    });
  });

  it("渲染时明确区分 overlap 与核心文本，避免重复提取", () => {
    const result = chunkNovel(
      ["甲".repeat(4), "乙".repeat(4), "丙".repeat(4), "丁".repeat(4), "戊".repeat(4)].join("\n"),
      { targetChars: 15, overlapChars: 7 },
    );
    const text = renderNovelChunk(result.paragraphs, result.chunks[1]);
    expect(text).toContain("【重叠上文：只用于理解衔接，不重复提取事实】\n¶2");
    expect(text).toContain("【核心文本：本次只对这个区间提取事实】\n¶3");
    expect(text).toContain("【重叠下文：只用于理解衔接，不重复提取事实】\n¶5");
  });

  it("空文本返回空结构，非法预算明确报错", () => {
    expect(chunkNovel("  \n")).toEqual({
      paragraphs: [],
      chapters: [],
      chunks: [],
      totalChars: 0,
    });
    expect(() => chunkNovel("正文", { targetChars: 0 })).toThrow("targetChars 必须大于 0");
    expect(() => chunkNovel("正文", { overlapChars: -1 })).toThrow("overlapChars 不能小于 0");
    expect(() => chunkNovel("正文", { targetChars: Number.NaN })).toThrow("有限整数");
    expect(() => chunkNovel("正文", { overlapChars: Number.POSITIVE_INFINITY })).toThrow(
      "有限整数",
    );
    expect(() => chunkNovel("正文", { targetChars: 1.5 })).toThrow("有限整数");
  });

  it("接近 50 万字时仍按章节稳定分块", () => {
    const novel = Array.from(
      { length: 20 },
      (_, i) => `第${i + 1}章\n${"字".repeat(24_000)}`,
    ).join("\n");
    const result = chunkNovel(novel);
    expect(result.totalChars).toBeGreaterThan(480_000);
    expect(result.chapters).toHaveLength(20);
    expect(result.chunks).toHaveLength(20);
    expect(result.chunks.every((chunk) => chunk.coreCharCount <= 25_000)).toBe(true);
    expect(result.chunks[0].coreRange.start).toBe(1);
    expect(result.chunks.at(-1)?.coreRange.end).toBe(result.paragraphs.length);
  });
});
