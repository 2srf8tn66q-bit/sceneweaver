import { describe, expect, it } from "vitest";
import { splitParagraphs } from "../screenplay/paragraphs";
import {
  collectHeadingCandidates,
  buildChapterStructureMessageBatches,
  buildChapterStructureMessages,
  MAX_STRUCTURE_EVIDENCE_CHARS,
  materializeNovelChapters,
  parseAndValidateChapterStructure,
  recognizeChapterStructure,
} from "./structure";

function modelOutput(
  headings: Array<{
    headingParagraph: number;
    role: "front_matter" | "volume" | "chapter" | "section" | "back_matter" | "toc";
    decision: "selected" | "uncertain";
  }>,
): string {
  return JSON.stringify({ headings });
}

function candidateAt(
  candidates: ReturnType<typeof collectHeadingCandidates>,
  paragraph: number,
) {
  const candidate = candidates.find((item) => item.paragraph === paragraph);
  expect(candidate, `应收集 ¶${paragraph} 的标题候选`).toBeDefined();
  return candidate!;
}

function expectExactCoverage(
  chapters: ReturnType<typeof materializeNovelChapters>,
  paragraphCount: number,
) {
  const covered = chapters.flatMap((chapter) => {
    const numbers: number[] = [];
    for (
      let paragraph = chapter.paragraphRange.start;
      paragraph <= chapter.paragraphRange.end;
      paragraph += 1
    ) {
      numbers.push(paragraph);
    }
    return numbers;
  });
  expect(covered).toEqual(
    Array.from({ length: paragraphCount }, (_, index) => index + 1),
  );
  expect(new Set(covered).size).toBe(covered.length);
}

describe("标题候选证据", () => {
  it.each([
    {
      text: "# 第一章 雨夜",
      levelHint: "chapter",
      signals: ["markdown", "explicit_chapter"],
    },
    {
      text: "【第一章】雨夜",
      levelHint: "chapter",
      signals: ["bracketed", "explicit_chapter"],
    },
    {
      text: "第一章雨夜",
      levelHint: "chapter",
      signals: ["explicit_chapter"],
    },
    {
      text: "第 一 章 雨夜",
      levelHint: "chapter",
      signals: ["explicit_chapter"],
    },
    {
      text: "第壹章 雨夜",
      levelHint: "chapter",
      signals: ["explicit_chapter"],
    },
    {
      text: "卷一 风云",
      levelHint: "volume",
      signals: ["explicit_volume"],
    },
    {
      text: "Chapter One Return",
      levelHint: "chapter",
      signals: ["explicit_chapter"],
    },
    {
      text: "Chapter Thirty Return",
      levelHint: "chapter",
      signals: ["explicit_chapter"],
    },
    {
      text: "BOOK ONE",
      levelHint: "volume",
      signals: ["explicit_volume"],
    },
    {
      text: "第廿一章 重逢",
      levelHint: "chapter",
      signals: ["explicit_chapter"],
    },
    {
      text: "Prologue",
      levelHint: "unknown",
      signals: ["special_heading"],
    },
    {
      text: "Epilogue",
      levelHint: "unknown",
      signals: ["special_heading"],
    },
    {
      text: "1. The Arrival",
      levelHint: "unknown",
      signals: ["numbered_short_line"],
    },
  ] as const)("收集常见变体：$text", ({ text, levelHint, signals }) => {
    const paragraphs = splitParagraphs(`普通正文\n${text}\n后续正文`);
    const candidate = candidateAt(collectHeadingCandidates(paragraphs), 2);

    expect(candidate).toMatchObject({
      paragraph: 2,
      text,
      levelHint,
    });
    expect(candidate.normalizedText.length).toBeGreaterThan(0);
    expect(candidate.signals).toEqual(expect.arrayContaining([...signals]));
  });

  it("开头密集目录与后文同序标题重复时，提供目录证据但不直接造章节", () => {
    const paragraphs = splitParagraphs(
      [
        "目录",
        "第一章 雨夜",
        "第二章 清晨",
        "出版说明",
        "第一章 雨夜",
        "甲".repeat(400),
        "第二章 清晨",
        "乙".repeat(400),
      ].join("\n"),
    );
    const candidates = collectHeadingCandidates(paragraphs);

    expect(candidateAt(candidates, 2)).toMatchObject({
      duplicateParagraphs: [5],
    });
    expect(candidateAt(candidates, 2).signals).toEqual(
      expect.arrayContaining(["repeated_later", "likely_toc"]),
    );
    expect(candidateAt(candidates, 3)).toMatchObject({
      duplicateParagraphs: [7],
    });
    expect(candidateAt(candidates, 3).signals).toEqual(
      expect.arrayContaining(["repeated_later", "likely_toc"]),
    );

    const structure = parseAndValidateChapterStructure(
      modelOutput([
        { headingParagraph: 2, role: "toc", decision: "selected" },
        { headingParagraph: 3, role: "toc", decision: "selected" },
        { headingParagraph: 5, role: "chapter", decision: "selected" },
        { headingParagraph: 7, role: "chapter", decision: "selected" },
      ]),
      paragraphs,
      candidates,
    );

    expect(structure.status).toBe("resolved");
    expect(structure.primaryBoundaries).toEqual([5, 7]);
    expect(structure.tocParagraphs).toEqual([2, 3]);
    expect(structure.issues).toEqual([]);

    const chapters = materializeNovelChapters(paragraphs, structure);
    expect(chapters.map((chapter) => chapter.title)).toEqual([
      "开篇",
      "第一章 雨夜",
      "第二章 清晨",
    ]);
    expectExactCoverage(chapters, paragraphs.length);
  });

  it("likely_toc 始终只是证据，模型明确选为正文时代码不得强制剔除", () => {
    const paragraphs = splitParagraphs(
      [
        "第一章 重逢",
        "短章正文",
        "第二章 过渡",
        "正文",
        "第一章 重逢",
        "后卷同名章正文",
      ].join("\n"),
    );
    const candidates = collectHeadingCandidates(paragraphs);
    expect(candidateAt(candidates, 1).signals).toContain("likely_toc");
    const structure = parseAndValidateChapterStructure(
      modelOutput([
        { headingParagraph: 1, role: "chapter", decision: "selected" },
        { headingParagraph: 3, role: "chapter", decision: "selected" },
        { headingParagraph: 5, role: "chapter", decision: "selected" },
      ]),
      paragraphs,
      candidates,
    );
    expect(structure.primaryBoundaries).toEqual([1, 3, 5]);
    expect(materializeNovelChapters(paragraphs, structure)[0].title).toBe(
      "第一章 重逢",
    );
  });

  it("章内中文一、二、清单只是弱候选，模型可以不选", () => {
    const paragraphs = splitParagraphs(
      [
        "第一章 人物介绍",
        "正文",
        "一、身体状况",
        "说明",
        "二、经济状况",
        "说明",
        "第二章 命案",
        "正文",
      ].join("\n"),
    );
    const candidates = collectHeadingCandidates(paragraphs);

    for (const paragraph of [3, 5]) {
      const candidate = candidateAt(candidates, paragraph);
      expect(candidate.levelHint).toBe("unknown");
      expect(candidate.signals).toContain("numbered_short_line");
      expect(candidate.signals).not.toContain("explicit_chapter");
    }

    const structure = parseAndValidateChapterStructure(
      modelOutput([
        { headingParagraph: 1, role: "chapter", decision: "selected" },
        { headingParagraph: 7, role: "chapter", decision: "selected" },
      ]),
      paragraphs,
      candidates,
    );
    expect(structure.status).toBe("resolved");
    expect(structure.primaryBoundaries).toEqual([1, 7]);

    const chapters = materializeNovelChapters(paragraphs, structure);
    expect(chapters.map((chapter) => chapter.title)).toEqual([
      "第一章 人物介绍",
      "第二章 命案",
    ]);
    expect(chapters.map((chapter) => chapter.paragraphRange)).toEqual([
      { start: 1, end: 6 },
      { start: 7, end: 8 },
    ]);
  });
});

describe("结构层级", () => {
  it("卷和章是主要边界，节归入最近章节并只作为章内切分提示", () => {
    const paragraphs = splitParagraphs(
      [
        "第一卷 风起",
        "第一章 雨夜",
        "正文",
        "第一节 访客",
        "正文",
        "第二章 清晨",
        "正文",
        "第二卷 风止",
        "第三章 归来",
        "正文",
      ].join("\n"),
    );
    const candidates = collectHeadingCandidates(paragraphs);
    const structure = parseAndValidateChapterStructure(
      modelOutput([
        { headingParagraph: 1, role: "volume", decision: "selected" },
        { headingParagraph: 2, role: "chapter", decision: "selected" },
        { headingParagraph: 4, role: "section", decision: "selected" },
        { headingParagraph: 6, role: "chapter", decision: "selected" },
        { headingParagraph: 8, role: "volume", decision: "selected" },
        { headingParagraph: 9, role: "chapter", decision: "selected" },
      ]),
      paragraphs,
      candidates,
    );

    expect(structure.status).toBe("resolved");
    expect(structure.primaryBoundaries).toEqual([1, 2, 6, 8, 9]);
    expect(structure.splitHints).toEqual([4]);
    expect(structure.headings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          headingParagraph: 2,
          role: "chapter",
          parentHeadingParagraph: 1,
        }),
        expect.objectContaining({
          headingParagraph: 4,
          role: "section",
          parentHeadingParagraph: 2,
        }),
        expect.objectContaining({
          headingParagraph: 9,
          role: "chapter",
          parentHeadingParagraph: 8,
        }),
      ]),
    );
  });

  it("全书没有章、只有稳定小节时，小节升级为主要边界", () => {
    const paragraphs = splitParagraphs(
      ["第一节 雨夜", "正文甲", "第二节 清晨", "正文乙"].join("\n"),
    );
    const candidates = collectHeadingCandidates(paragraphs);
    const structure = parseAndValidateChapterStructure(
      modelOutput([
        { headingParagraph: 1, role: "section", decision: "selected" },
        { headingParagraph: 3, role: "section", decision: "selected" },
      ]),
      paragraphs,
      candidates,
    );

    expect(structure.status).toBe("resolved");
    expect(structure.primaryBoundaries).toEqual([1, 3]);
    expect(structure.splitHints).toEqual([]);
    const chapters = materializeNovelChapters(paragraphs, structure);
    expect(chapters.map((chapter) => chapter.title)).toEqual([
      "第一节 雨夜",
      "第二节 清晨",
    ]);
    expectExactCoverage(chapters, paragraphs.length);
  });
});

describe("模型结构输出校验与安全降级", () => {
  const source = ["第一章 雨夜", "正文甲", "第二章 清晨", "正文乙"].join("\n");

  it("模型输出乱序时由代码按真实段号稳定排序", () => {
    const paragraphs = splitParagraphs(source);
    const candidates = collectHeadingCandidates(paragraphs);
    const structure = parseAndValidateChapterStructure(
      modelOutput([
        { headingParagraph: 3, role: "chapter", decision: "selected" },
        { headingParagraph: 1, role: "chapter", decision: "selected" },
      ]),
      paragraphs,
      candidates,
    );

    expect(structure.status).toBe("resolved");
    expect(structure.headings.map((heading) => heading.headingParagraph)).toEqual([1, 3]);
    expect(structure.primaryBoundaries).toEqual([1, 3]);
  });

  it.each([
    {
      name: "引用不存在的候选段号",
      raw: modelOutput([
        { headingParagraph: 999, role: "chapter", decision: "selected" },
      ]),
      issue: "unknown_candidate",
    },
    {
      name: "同一候选段号输出两次",
      raw: modelOutput([
        { headingParagraph: 1, role: "chapter", decision: "selected" },
        { headingParagraph: 1, role: "chapter", decision: "selected" },
      ]),
      issue: "duplicate_heading",
    },
    {
      name: "JSON Schema 非法",
      raw: "{not valid json",
      issue: "invalid_model_output",
    },
  ])("$name 时不猜测修复，回退为安全字数分块", ({ raw, issue }) => {
    const paragraphs = splitParagraphs(source);
    const candidates = collectHeadingCandidates(paragraphs);
    const structure = parseAndValidateChapterStructure(raw, paragraphs, candidates);

    expect(structure.status).toBe("fallback");
    expect(structure.primaryBoundaries).toEqual([]);
    expect(structure.issues).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: issue })]),
    );
    const chapters = materializeNovelChapters(paragraphs, structure);
    expect(chapters).toMatchObject([
      {
        id: "chapter_001",
        index: 0,
        title: "正文",
        kind: "fallback",
        paragraphRange: { start: 1, end: 4 },
      },
    ]);
  });

  it("uncertain 条目不进入正式边界，可靠条目仍可形成 partial 结构", () => {
    const paragraphs = splitParagraphs(source);
    const candidates = collectHeadingCandidates(paragraphs);
    const structure = parseAndValidateChapterStructure(
      modelOutput([
        { headingParagraph: 1, role: "chapter", decision: "selected" },
        { headingParagraph: 3, role: "chapter", decision: "uncertain" },
      ]),
      paragraphs,
      candidates,
    );

    expect(structure.status).toBe("partial");
    expect(structure.primaryBoundaries).toEqual([1]);
    expect(structure.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "uncertain_heading",
          paragraphs: [3],
        }),
      ]),
    );
  });

  it("没有可靠边界时 fallback 为覆盖全文的正文", () => {
    const paragraphs = splitParagraphs("普通正文一\n普通正文二\n普通正文三");
    const candidates = collectHeadingCandidates(paragraphs);
    const structure = parseAndValidateChapterStructure(
      modelOutput([]),
      paragraphs,
      candidates,
    );

    expect(structure.status).toBe("fallback");
    expect(structure.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "no_usable_boundary" }),
      ]),
    );
    const chapters = materializeNovelChapters(paragraphs, structure);
    expect(chapters).toMatchObject([
      {
        title: "正文",
        kind: "fallback",
        paragraphRange: { start: 1, end: 3 },
      },
    ]);
    expectExactCoverage(chapters, paragraphs.length);
  });
});

describe("正式章节范围与溯源", () => {
  it("范围恰好覆盖全文、标题逐字取原文，正式 ID 可重复得到", () => {
    const paragraphs = splitParagraphs(
      [
        "版权说明",
        "# 第一章 雨夜",
        "正文甲",
        "【第二章】清晨",
        "正文乙",
      ].join("\n"),
    );
    const candidates = collectHeadingCandidates(paragraphs);
    const structure = parseAndValidateChapterStructure(
      modelOutput([
        { headingParagraph: 2, role: "chapter", decision: "selected" },
        { headingParagraph: 4, role: "chapter", decision: "selected" },
      ]),
      paragraphs,
      candidates,
    );

    const first = materializeNovelChapters(paragraphs, structure);
    const second = materializeNovelChapters(paragraphs, structure);

    expect(first).toEqual(second);
    expect(first.map((chapter) => chapter.id)).toEqual([
      "chapter_001",
      "chapter_002",
      "chapter_003",
    ]);
    expect(first.map((chapter) => chapter.index)).toEqual([0, 1, 2]);
    expect(first.map((chapter) => chapter.title)).toEqual([
      "开篇",
      "# 第一章 雨夜",
      "【第二章】清晨",
    ]);
    expect(first.map((chapter) => chapter.paragraphRange)).toEqual([
      { start: 1, end: 1 },
      { start: 2, end: 3 },
      { start: 4, end: 5 },
    ]);
    expect(first.map((chapter) => chapter.headingParagraph)).toEqual([
      undefined,
      2,
      4,
    ]);
    expectExactCoverage(first, paragraphs.length);
  });
});

describe("结构识别调用边界", () => {
  it("短篇给模型编号全文，长篇只给压缩候选证据", () => {
    const shortParagraphs = splitParagraphs("第一章 雨夜\n短正文");
    const shortCandidates = collectHeadingCandidates(shortParagraphs);
    const shortRequest = buildChapterStructureMessages(
      shortParagraphs,
      shortCandidates,
      100,
    );
    expect(shortRequest.inputMode).toBe("full_text");
    expect(shortRequest.messages[1].content).toContain("¶2 短正文");

    const uniqueBody = "只应存在于长篇正文的秘密".repeat(40);
    const longParagraphs = splitParagraphs(`第一章 雨夜\n${uniqueBody}`);
    const longCandidates = collectHeadingCandidates(longParagraphs);
    const longRequest = buildChapterStructureMessages(
      longParagraphs,
      longCandidates,
      100,
    );
    expect(longRequest.inputMode).toBe("candidate_evidence");
    expect(longRequest.messages[1].content).not.toContain(uniqueBody);
    expect(longRequest.messages[1].content).toContain("第一章 雨夜");
  });

  it("列表/OCR 型长文的候选数、重复证据和 prompt 都有硬上限", () => {
    const uniqueParagraphs = splitParagraphs(
      Array.from({ length: 8_000 }, (_, index) => `一、条目${index}`).join("\n"),
    );
    const uniqueCandidates = collectHeadingCandidates(uniqueParagraphs);
    const uniqueRequest = buildChapterStructureMessages(
      uniqueParagraphs,
      uniqueCandidates,
      30_000,
    );
    expect(uniqueCandidates.length).toBeLessThanOrEqual(1_200);
    expect(uniqueRequest.inputMode).toBe("candidate_evidence");
    expect(uniqueRequest.messages[1].content.length).toBeLessThan(310_000);

    const repeatedParagraphs = splitParagraphs(
      Array.from({ length: 100_000 }, () => "一、同一标题").join("\n"),
    );
    const repeatedCandidates = collectHeadingCandidates(repeatedParagraphs);
    expect(repeatedCandidates.length).toBeLessThanOrEqual(1_200);
    expect(
      repeatedCandidates.every(
        (candidate) =>
          candidate.duplicateParagraphs.length <= 4 &&
          candidate.duplicateCount === 99_999,
      ),
    ).toBe(true);
    const repeatedRequest = buildChapterStructureMessages(
      repeatedParagraphs,
      repeatedCandidates,
      30_000,
    );
    expect(repeatedRequest.messages[1].content.length).toBeLessThan(310_000);
  });

  it("1300 个强标题全部进入模型证据并可被物化，不再按证据预算丢章", async () => {
    const source = Array.from(
      { length: 1_300 },
      (_, index) => `第${index + 1}章 ${"标题".repeat(55)}`,
    ).join("\n");
    const paragraphs = splitParagraphs(source);
    const candidates = collectHeadingCandidates(paragraphs);
    expect(candidates).toHaveLength(1_300);
    const batches = buildChapterStructureMessageBatches(paragraphs, candidates, 1);
    const supplied = batches.flatMap((batch) => batch.candidateParagraphs);
    expect(supplied).toEqual(candidates.map((candidate) => candidate.paragraph));
    expect(new Set(supplied).size).toBe(1_300);
    expect(
      batches.every(
        (batch) =>
          batch.messages[1].content.length < MAX_STRUCTURE_EVIDENCE_CHARS + 1_000,
      ),
    ).toBe(true);

    let callIndex = 0;
    const result = await recognizeChapterStructure(
      paragraphs,
      async () => {
        const page = batches[callIndex++];
        return modelOutput(
          page.candidateParagraphs.map((headingParagraph) => ({
            headingParagraph,
            role: "chapter",
            decision: "selected",
          })),
        );
      },
      { shortNovelChars: 1 },
    );
    expect(callIndex).toBe(batches.length);
    expect(result.structure.status).toBe("resolved");
    expect(result.structure.primaryBoundaries).toHaveLength(1_300);
    expect(materializeNovelChapters(paragraphs, result.structure)).toHaveLength(1_300);
  });

  it("证据超过单页时连续分页，每个候选仍恰好出现一次", () => {
    const paragraphs = splitParagraphs(
      Array.from(
        { length: 3_000 },
        (_, index) => `第${index + 1}章 ${"长标题".repeat(42)}`,
      ).join("\n"),
    );
    const candidates = collectHeadingCandidates(paragraphs);
    const batches = buildChapterStructureMessageBatches(paragraphs, candidates, 1);
    const supplied = batches.flatMap((batch) => batch.candidateParagraphs);

    expect(batches.length).toBeGreaterThan(1);
    expect(supplied).toEqual(candidates.map((candidate) => candidate.paragraph));
    expect(new Set(supplied).size).toBe(candidates.length);
    expect(
      batches.every(
        (batch) =>
          batch.messages[1].content.length < MAX_STRUCTURE_EVIDENCE_CHARS + 1_000,
      ),
    ).toBe(true);
  });

  it("强标题超过 5000 个时显式标记截断并安全降级，不能静默漏章", async () => {
    const paragraphs = splitParagraphs(
      Array.from(
        { length: 5_001 },
        (_, index) => `第${index + 1}章 ${"标题".repeat(30)}`,
      ).join("\n"),
    );
    const candidates = collectHeadingCandidates(paragraphs);
    expect(candidates).toHaveLength(5_000);
    const batches = buildChapterStructureMessageBatches(paragraphs, candidates, 1);
    const firstEvidenceText = batches[0].messages[1].content;
    const firstEvidence = JSON.parse(
      firstEvidenceText.slice(firstEvidenceText.indexOf("{")),
    ) as {
      totalCandidates: number;
      retainedCandidates: number;
      sampled: boolean;
    };
    expect(firstEvidence).toMatchObject({
      totalCandidates: 5_001,
      retainedCandidates: 5_000,
      sampled: true,
    });

    let calls = 0;
    const result = await recognizeChapterStructure(
      paragraphs,
      async () => {
        calls += 1;
        return modelOutput([]);
      },
      { shortNovelChars: 1 },
    );
    expect(calls).toBe(0);
    expect(result.structure.status).toBe("fallback");
    expect(result.structure.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "candidate_limit_exceeded" }),
      ]),
    );
  });

  it("候选原文含几十万内部空格时先压缩再序列化，不能撑破证据上限", () => {
    const paragraphs = splitParagraphs(`第${" ".repeat(400_000)}一章 雨夜\n正文`);
    const candidates = collectHeadingCandidates(paragraphs);
    expect(candidates).toHaveLength(1);
    const batches = buildChapterStructureMessageBatches(paragraphs, candidates);

    expect(batches).toHaveLength(1);
    expect(batches[0].inputMode).toBe("candidate_evidence");
    expect(batches[0].messages[1].content.length).toBeLessThan(
      MAX_STRUCTURE_EVIDENCE_CHARS + 1_000,
    );
    expect(batches[0].messages[1].content).not.toContain(" ".repeat(10_000));
  });

  it("模型只选真实候选段号，代码回填标题并派生范围", async () => {
    const paragraphs = splitParagraphs("第一章 雨夜\n正文\n第二章 清晨\n正文");
    const result = await recognizeChapterStructure(
      paragraphs,
      async () =>
        modelOutput([
          { headingParagraph: 1, role: "chapter", decision: "selected" },
          { headingParagraph: 3, role: "chapter", decision: "selected" },
        ]),
    );
    const chapters = materializeNovelChapters(paragraphs, result.structure);

    expect(result.inputMode).toBe("full_text");
    expect(chapters.map((chapter) => chapter.title)).toEqual([
      "第一章 雨夜",
      "第二章 清晨",
    ]);
    expect(chapters.map((chapter) => chapter.paragraphRange)).toEqual([
      { start: 1, end: 2 },
      { start: 3, end: 4 },
    ]);
  });

  it("进入时 signal 已取消则不发起任何结构识别调用", async () => {
    const controller = new AbortController();
    controller.abort();
    let calls = 0;

    await expect(
      recognizeChapterStructure(
        splitParagraphs("第一章\n正文"),
        async () => {
          calls += 1;
          return modelOutput([]);
        },
        { signal: controller.signal },
      ),
    ).rejects.toThrow("章节结构识别已取消");
    expect(calls).toBe(0);
  });

  it("分页发起期间取消后不再启动后续页", async () => {
    const paragraphs = splitParagraphs(
      Array.from(
        { length: 3_000 },
        (_, index) => `第${index + 1}章 ${"长标题".repeat(42)}`,
      ).join("\n"),
    );
    const candidates = collectHeadingCandidates(paragraphs);
    expect(
      buildChapterStructureMessageBatches(paragraphs, candidates, 1).length,
    ).toBeGreaterThan(1);
    const controller = new AbortController();
    let calls = 0;

    await expect(
      recognizeChapterStructure(
        paragraphs,
        async () => {
          calls += 1;
          controller.abort();
          return modelOutput([]);
        },
        { shortNovelChars: 1, signal: controller.signal },
      ),
    ).rejects.toThrow("章节结构识别已取消");
    expect(calls).toBe(1);
  });
});
