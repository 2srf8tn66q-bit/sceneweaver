import type { Screenplay } from "./types";

// 一份合格的样例剧本（咖啡馆重逢），用于测试与早期演示。
export const sampleScreenplay: Screenplay = {
  meta: {
    title: "咖啡馆的重逢",
    logline: "多年后，林夏回到故城，与旧友王志强在他的咖啡馆重逢。",
    adapted_from: { novel_title: "示例小说", chapters: [1, 2, 3] },
    genre: ["都市", "情感"],
    render_format: "cn",
  },
  characters: [
    {
      id: "char_wang",
      name: "王志强",
      aliases: ["老王", "王先生"],
      description: "35岁，咖啡馆老板，沉默寡言",
      role: "protagonist",
    },
    {
      id: "char_lin",
      name: "林夏",
      aliases: ["小夏"],
      description: "28岁，回国的设计师",
      role: "protagonist",
    },
  ],
  structure: [{ act: 1, title: "重逢", scene_ids: ["scene_001", "scene_002"] }],
  scenes: [
    {
      id: "scene_001",
      number: 1,
      act: 1,
      heading: { setting: "INT", location: "暖咖啡 - 窗边", time: "DAY" },
      synopsis: "王志强与林夏多年后重逢",
      dramatic_function: "建立两人的疏离，埋下未解的过往",
      source: { chapter: 1, paragraph_range: [12, 18] },
      elements: [
        {
          type: "action",
          text: "午后的阳光斜照进暖咖啡。王志强擦着杯子，门铃响了，林夏走进来。",
        },
        {
          type: "action",
          text: "林夏的手指绞着衣角。",
          from_internal: true,
          note: "原文：林夏心里七上八下",
        },
        { type: "dialogue", character: "char_lin", mode: "in_scene", parenthetical: "迟疑地", line: "好久不见。" },
        { type: "dialogue", character: "char_wang", line: "……你回来了。" },
        { type: "transition", text: "CUT TO" },
      ],
      review: { status: "generated", confidence: 0.82 },
    },
    {
      id: "scene_002",
      number: 2,
      act: 1,
      heading: { setting: "INT", location: "林夏的出租屋", time: "NIGHT" },
      synopsis: "林夏独自翻看旧照片",
      source: { chapter: 1, paragraph_range: [19, 23] },
      elements: [
        { type: "action", text: "夜里，林夏回到出租屋，翻出一张旧合影，怔怔出神。" },
        { type: "dialogue", character: "char_lin", mode: "voiceover", line: "有些话，隔了十年还是说不出口。" },
      ],
      review: { status: "generated", confidence: 0.58 },
    },
  ],
};
