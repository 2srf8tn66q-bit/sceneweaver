// 三段 prompt 构造器（纯函数，返回 ChatMessage[]，不直接调用 LLM）。
// Call 1 理解（人物表 + 分场）、Call 2 改编（生成场景）、修复（把质检错误喂回去）。

import type { ChatMessage } from "../llm/types";
import type { Character } from "./types";
import type { ValidationIssue } from "./validate";

export interface SceneText {
  number: number;
  range: [number, number]; // 段落区间
  text: string; // 该场原文
}

// ── Call 1：理解 ──
export function buildUnderstandMessages(numberedNovel: string): ChatMessage[] {
  const system = `你是资深编剧的改编助手。现在做"小说转剧本"第一步——通读小说，建人物档案 + 规划分场。不要写剧本，只做这两件事。

【人物表】列出所有有戏份的人物：
- id：稳定标识，拼音/英文小写+下划线，如 char_wang
- name：标准名
- aliases：原文出现过的其他称呼（老王/王先生/他），供后续统一
- description：一句话人设
- role：protagonist / supporting / minor

【分场】按"地点变化或时间跳跃"切场，每场只给：
- paragraph_range：[起段号, 止段号]（用下面给的 ¶ 段号）

[判断类型] 根据小说内容判断类型标签，如：悬疑 / 情感 / 都市 / 武侠 / 古装 / 科幻。给 2-4 个中文词。

只输出 JSON：{"genre":["悬疑","都市"],"characters":[...],"scenes":[{"paragraph_range":[1,5]}]}
不要任何解释。`;
  const user = `小说（每段前是 ¶段号）：\n${numberedNovel}`;
  return [
    { role: "system", content: system },
    { role: "user", content: user },
  ];
}

// ── Call 2：改编 ──
export function buildAdaptMessages(characters: Character[], scenes: SceneText[]): ChatMessage[] {
  const system = `你是专业编剧，把给定小说片段改编成结构化剧本场景。牢记三原则：
1. 删内心独白/上帝视角，外化成能被看见的动作、神态、潜台词；
2. 不照搬原句，按人物口吻重写台词；
3. 只保留镜头能拍、观众能看能听的内容。

处理铺垫与过渡：遇到开场或大段内心独白 / 背景交代，不要直接丢弃——可处理成"开场画外音(V.O.) + 蒙太奇"的一场（角色 V.O. 叙述，画面闪过相关场景），或外化进邻近场景。当补一段过渡戏能让剧情更顺时，鼓励你大胆生成，这类由你补足的内容是有价值的。

硬性要求：
- 对白 character 只能用给定人物表里的 id，不得新造；
- heading.setting 仅 INT 或 EXT；time 仅 DAY 或 NIGHT；
- elements 有序，每项 type ∈ action / dialogue / dual_dialogue / transition；
- 动作若由原文内心戏外化而来，给该 action 加 "from_internal": true（可选 "note" 说明从哪外化）；
- 每场必须给 synopsis(一句话梗概)、dramatic_function(本场推进了什么、做了哪 2-3 件事)、source(来自原文的段落区间) 与 confidence(0~1)。

confidence(0~1) 按一个明确标准给：这一场"贴着原文的程度" = 1 − 你自己创造/补足的比例。它不是对错评分，低分只表示"演绎成分高、请作者重点看一眼"，不扣分、不代表错：
- 你的自创/补足 < 30%（基本照原文改编）→ confidence ≥ 0.7；
- 自创/补足约 30%~60%（有明显补足、桥段、合并）→ confidence 0.4~0.7；
- 自创/补足 > 60%（大部分是你的演绎，如纯 V.O. 蒙太奇、原文没有的过渡场）→ confidence < 0.4。
按这个比例如实给分：该补的过渡、该有的开场 V.O. 请照常生成——它们自创比例高、本就该落在低分档，这正是要让作者知道的，不是让你回避。

严格按此 JSON 结构输出，不要解释：
{"scenes":[{"id":"scene_001","number":1,"heading":{"setting":"INT","location":"地点","time":"DAY"},"synopsis":"一句梗概","dramatic_function":"本场推进了什么","source":{"chapter":1,"paragraph_range":[1,5]},"elements":[{"type":"action","text":"…","from_internal":true},{"type":"dialogue","character":"char_lin","line":"…"}],"review":{"status":"generated","confidence":0.8}}]}`;

  const charList = characters
    .map((c) => `- ${c.id}（${c.name}${c.aliases?.length ? "／" + c.aliases.join("、") : ""}）`)
    .join("\n");
  const scenesBlock = scenes
    .map((s) => `第${s.number}场 ¶${s.range[0]}~${s.range[1]}：\n${s.text}`)
    .join("\n\n");
  const user = `人物表（对白只能引用这些 id）：\n${charList}\n\n要改编的分场（含原文）：\n${scenesBlock}\n\n请逐场改编，输出 {"scenes":[...]}。`;
  return [
    { role: "system", content: system },
    { role: "user", content: user },
  ];
}

// ── 修复：把代码质检报出的错误逐条喂回 ──
export function buildRepairMessages(badJson: string, issues: ValidationIssue[]): ChatMessage[] {
  const list = issues.map((i) => `- ${i.path}：${i.message}`).join("\n");
  const system = `你上次输出的剧本 JSON 未通过校验。请只修正下列问题，重新输出完整 JSON，其余保持不变，不要解释。`;
  const user = `问题清单：\n${list}\n\n上次的输出：\n${badJson}`;
  return [
    { role: "system", content: system },
    { role: "user", content: user },
  ];
}
