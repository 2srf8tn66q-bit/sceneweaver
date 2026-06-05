import { describe, it, expect } from "vitest";
import { splitParagraphs, toNumberedText, sliceParagraphs } from "./paragraphs";

const novel = "  第一段。  \n\n第二段。\n\n\n第三段。\n   ";

describe("段落编号（paragraphs）", () => {
  it("按行切段、去空行、从 1 编号", () => {
    expect(splitParagraphs(novel)).toEqual([
      { n: 1, text: "第一段。" },
      { n: 2, text: "第二段。" },
      { n: 3, text: "第三段。" },
    ]);
  });

  it("渲染成 ¶ 编号文本喂 LLM", () => {
    expect(toNumberedText(splitParagraphs(novel))).toBe("¶1 第一段。\n¶2 第二段。\n¶3 第三段。");
  });

  it("按区间取原文（含端点）", () => {
    expect(sliceParagraphs(splitParagraphs(novel), [2, 3])).toBe("第二段。\n第三段。");
  });
});
