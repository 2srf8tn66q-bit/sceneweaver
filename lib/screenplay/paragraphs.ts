// 把小说原文切成带编号的段落。
// 用途：Call 1 喂编号全文、Call 2 取某一场的原文、以及每场的源文映射（paragraph_range）。

export interface NumberedParagraph {
  n: number; // 段号，从 1 开始
  text: string;
}

/** 按换行切段，去掉空行，从 1 编号。 */
export function splitParagraphs(novel: string): NumberedParagraph[] {
  return novel
    .split(/\r\n|\n|\r/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .map((text, i) => ({ n: i + 1, text }));
}

/** 渲染成喂给 LLM 的编号文本：每段前缀 ¶段号。 */
export function toNumberedText(paras: NumberedParagraph[]): string {
  return paras.map((p) => `¶${p.n} ${p.text}`).join("\n");
}

/** 取某段落区间 [a, b]（含端点）的原文，供 Call 2 喂某一场原文。 */
export function sliceParagraphs(paras: NumberedParagraph[], range: [number, number]): string {
  const [a, b] = range;
  return paras
    .filter((p) => p.n >= a && p.n <= b)
    .map((p) => p.text)
    .join("\n");
}
