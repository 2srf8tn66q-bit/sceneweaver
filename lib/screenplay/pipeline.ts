// 生成 pipeline：段落编号 → Call 1 理解 → Call 2【分批+并行】改编 → 质检 → 失败修 1 次。
// 分批的意义：单次调用只写 2-3 场，输出短 → 不超时/不断连；各批并行 → 提速；
// 各批共享 Call 1 的全局人物表 → 跨场一致。LLM 以 LLMCall 注入，便于测试。

import type { ChatMessage } from "../llm/types";
import type { Screenplay, Character } from "./types";
import { splitParagraphs, toNumberedText, sliceParagraphs } from "./paragraphs";
import { buildUnderstandMessages, buildAdaptMessages, buildRepairMessages, type SceneText } from "./prompts";
import { safeParseJSON } from "../llm/json";
import { validateScreenplay, type ValidationResult } from "./validate";

export type LLMCall = (messages: ChatMessage[]) => Promise<string>;

export interface GenerateResult {
  screenplay: Screenplay | null; // 质检通过才有
  validation: ValidationResult;
  scenes: number; // 生成的场数
  batches: number; // Call 2 分了几批
  repaired: boolean;
}

interface UnderstandOutput {
  characters: Character[];
  scenes: { paragraph_range: [number, number]; synopsis?: string }[];
}

/** 把分场按原文字数打包成批：整场不拆，单场超预算则自成一批。 */
export function batchScenes(scenes: SceneText[], charBudget = 2500): SceneText[][] {
  const batches: SceneText[][] = [];
  let cur: SceneText[] = [];
  let curLen = 0;
  for (const s of scenes) {
    if (cur.length > 0 && curLen + s.text.length > charBudget) {
      batches.push(cur);
      cur = [];
      curLen = 0;
    }
    cur.push(s);
    curLen += s.text.length;
  }
  if (cur.length > 0) batches.push(cur);
  return batches;
}

/** 带并发上限的并行 map（不引第三方库的轻量实现）。 */
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length || 1) }, worker));
  return results;
}

export async function generateScreenplay(
  novel: string,
  call: LLMCall,
  opts: { title?: string; concurrency?: number; charBudget?: number } = {},
): Promise<GenerateResult> {
  const paras = splitParagraphs(novel);

  // 1) Call 1：理解（人物表 + 分场）
  const understandRaw = await call(buildUnderstandMessages(toNumberedText(paras)));
  const understand = safeParseJSON<UnderstandOutput>(understandRaw, { characters: [], scenes: [] });

  const sceneTexts: SceneText[] = understand.scenes.map((s, i) => ({
    number: i + 1,
    range: s.paragraph_range,
    text: sliceParagraphs(paras, s.paragraph_range),
  }));

  // 2) Call 2：分批 + 并行改编（每批输出短，不超时；共享人物表保一致）
  const batches = batchScenes(sceneTexts, opts.charBudget ?? 2500);
  const perBatch = await mapLimit(batches, opts.concurrency ?? 12, async (batch) => {
    const raw = await call(buildAdaptMessages(understand.characters, batch));
    return safeParseJSON<{ scenes?: unknown[] }>(raw, { scenes: [] }).scenes ?? [];
  });
  let scenes: unknown[] = renumber(perBatch.flat());

  // 3) 质检 + 修复：代码当裁判，LLM 当修理工（最多 1 次）
  let parsed = assemble(understand.characters, scenes, opts);
  let validation = validateScreenplay(parsed);
  let repairs = 0;
  const MAX_REPAIRS = 2;
  while (!validation.valid && repairs < MAX_REPAIRS) {
    const repairRaw = await call(buildRepairMessages(JSON.stringify({ scenes }), validation.errors));
    scenes = renumber(safeParseJSON<{ scenes?: unknown[] }>(repairRaw, { scenes }).scenes ?? scenes);
    parsed = assemble(understand.characters, scenes, opts);
    validation = validateScreenplay(parsed);
    repairs++;
  }

  // 最大努力返回：即使仍有残留问题，也把剧本交回去（渲染 + 标注），不丢弃整份结果。
  return {
    screenplay: scenes.length > 0 ? (parsed as Screenplay) : null,
    validation,
    scenes: scenes.length,
    batches: batches.length,
    repaired: repairs > 0,
  };
}

/** 各批独立生成会重复 id/场号，合并后统一重编，保证全局唯一且连续。 */
function renumber(scenes: unknown[]): unknown[] {
  return scenes.map((s, i) =>
    s && typeof s === "object"
      ? { ...(s as Record<string, unknown>), id: `scene_${String(i + 1).padStart(3, "0")}`, number: i + 1 }
      : s,
  );
}

/** 把 Call 1 的人物表与各批场景拼成完整 Screenplay 对象。 */
function assemble(characters: Character[], scenes: unknown[], opts: { title?: string }): unknown {
  return {
    meta: { title: opts.title ?? "未命名剧本" },
    characters,
    scenes,
  };
}
