import { describe, it, expect } from "vitest";
import { generateScreenplay, type LLMCall } from "./pipeline";

// 假 LLM：根据系统提示词内容判断是 Call1 / Call2 / 修复，返回预设 JSON
function makeFakeLLM(call1: string, call2: string, repair?: string): LLMCall {
  return async (messages) => {
    const sys = messages[0].content;
    if (sys.includes("建人物档案")) return call1; // Call 1 理解
    if (sys.includes("未通过校验")) return repair ?? call2; // 修复
    return call2; // Call 2 改编
  };
}

const novel = "林夏推开咖啡馆的门。\n王志强正在擦杯子。";

describe("生成 pipeline（generateScreenplay）", () => {
  it("正常路径：Call1 + Call2 产出合格剧本，无需修复", async () => {
    const call1 = JSON.stringify({
      characters: [
        { id: "char_lin", name: "林夏" },
        { id: "char_wang", name: "王志强" },
      ],
      scenes: [{ paragraph_range: [1, 2], synopsis: "重逢" }],
    });
    const call2 = JSON.stringify({
      scenes: [
        {
          id: "scene_001",
          number: 1,
          heading: { setting: "INT", location: "咖啡馆", time: "DAY" },
          source: { chapter: 1, paragraph_range: [1, 2] },
          elements: [
            { type: "action", text: "林夏推开门，王志强擦着杯子。" },
            { type: "dialogue", character: "char_lin", line: "好久不见。" },
          ],
          review: { status: "generated", confidence: 0.8 },
        },
      ],
    });
    const r = await generateScreenplay(novel, makeFakeLLM(call1, call2), { title: "重逢" });
    expect(r.validation.valid).toBe(true);
    expect(r.repaired).toBe(false);
    expect(r.screenplay?.scenes).toHaveLength(1);
    expect(r.screenplay?.meta.title).toBe("重逢");
  });

  it("坏输出触发修复：Call2 引用不存在人物 → 修复后通过", async () => {
    const call1 = JSON.stringify({
      characters: [{ id: "char_lin", name: "林夏" }],
      scenes: [{ paragraph_range: [1, 2] }],
    });
    const badCall2 = JSON.stringify({
      scenes: [
        {
          id: "s1",
          number: 1,
          heading: { setting: "INT", location: "咖啡馆", time: "DAY" },
          elements: [{ type: "dialogue", character: "char_ghost", line: "嗨" }],
          review: { status: "generated", confidence: 0.7 },
        },
      ],
    });
    const fixed = JSON.stringify({
      scenes: [
        {
          id: "s1",
          number: 1,
          heading: { setting: "INT", location: "咖啡馆", time: "DAY" },
          elements: [{ type: "dialogue", character: "char_lin", line: "嗨" }],
          review: { status: "generated", confidence: 0.7 },
        },
      ],
    });
    const r = await generateScreenplay(novel, makeFakeLLM(call1, badCall2, fixed));
    expect(r.repaired).toBe(true);
    expect(r.validation.valid).toBe(true);
  });
});
