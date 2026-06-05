// 生成 pipeline：段落编号 → Call 1 理解 → Call 2 改编 → 代码质检 → 失败把错误喂回 LLM 修 1 次。
// LLM 以参数注入（LLMCall），pipeline 本身不依赖具体模型，便于测试 mock 与替换。

import type { ChatMessage } from "../llm/types";
import type { Screenplay, Character } from "./types";
import { splitParagraphs, toNumberedText, sliceParagraphs } from "./paragraphs";
import { buildUnderstandMessages, buildAdaptMessages, buildRepairMessages, type SceneText } from "./prompts";
import { safeParseJSON, extractJSON } from "../llm/json";
import { validateScreenplay, type ValidationResult } from "./validate";

/** 注入的 LLM 调用：给一组消息，返回回复文本。 */
export type LLMCall = (messages: ChatMessage[]) => Promise<string>;

export interface GenerateResult {
  screenplay: Screenplay | null; // 质检通过才有
  validation: ValidationResult;
  raw: string; // 最后一次 Call 2 / 修复的原始文本（调试用）
  repaired: boolean; // 是否经过一次修复
}

interface UnderstandOutput {
  characters: Character[];
  scenes: { paragraph_range: [number, number]; synopsis?: string }[];
}

export async function generateScreenplay(
  novel: string,
  call: LLMCall,
  opts: { title?: string } = {},
): Promise<GenerateResult> {
  // 1) 段落编号
  const paras = splitParagraphs(novel);

  // 2) Call 1：理解（人物表 + 分场）
  const understandRaw = await call(buildUnderstandMessages(toNumberedText(paras)));
  const understand = safeParseJSON<UnderstandOutput>(understandRaw, { characters: [], scenes: [] });

  // 3) 组装每场原文
  const sceneTexts: SceneText[] = understand.scenes.map((s, i) => ({
    number: i + 1,
    range: s.paragraph_range,
    text: sliceParagraphs(paras, s.paragraph_range),
  }));

  // 4) Call 2：改编
  let raw = await call(buildAdaptMessages(understand.characters, sceneTexts));
  let parsed = assemble(understand.characters, raw, opts);
  let validation = validateScreenplay(parsed);
  let repaired = false;

  // 5) 自检 + 修复：代码当裁判找出硬错误 → LLM 当修理工只修这些（最多 1 次）
  if (!validation.valid) {
    raw = await call(buildRepairMessages(extractJSON(raw), validation.errors));
    parsed = assemble(understand.characters, raw, opts);
    validation = validateScreenplay(parsed);
    repaired = true;
  }

  return {
    screenplay: validation.valid ? (parsed as Screenplay) : null,
    validation,
    raw,
    repaired,
  };
}

/** 把 Call 1 的人物表与 Call 2 的 {scenes:[...]} 拼成完整 Screenplay 对象。 */
function assemble(characters: Character[], adaptRaw: string, opts: { title?: string }): unknown {
  const adapt = safeParseJSON<{ scenes?: unknown[] }>(adaptRaw, { scenes: [] });
  return {
    meta: { title: opts.title ?? "未命名剧本" },
    characters,
    scenes: adapt.scenes ?? [],
  };
}
