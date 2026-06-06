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

【分场】按"地点变化或时间跳跃"切场，每场给：
- paragraph_range：[起段号, 止段号]（用下面给的 ¶ 段号）
- synopsis：一句话本场发生了什么

只输出 JSON：{"characters":[...],"scenes":[{"paragraph_range":[1,5],"synopsis":"…"}]}
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

硬性要求：
- 对白 character 只能用给定人物表里的 id，不得新造；
- heading.setting 仅 INT 或 EXT；time 仅 DAY/NIGHT/DUSK/DAWN/CONTINUOUS/LATER；
- elements 有序，每项 type ∈ action / dialogue / dual_dialogue / transition；
- 动作若由原文内心戏外化而来，给该 action 加 "from_internal": true（可选 "note" 说明从哪外化）；
- 每场必须给 synopsis(一句话梗概)、dramatic_function(本场推进了什么、做了哪 2-3 件事)、source(来自原文的段落区间) 与 confidence(0~1)。

confidence 判分（出现任一情况必须扣到 0.7 以下，0.7 是"需人工复核"红线）：
- 原文信息不足、你做了较多脑补/虚构；
- 不确定某句话归谁说、"他/她"指代不清；
- 原文是大段心理/抒情/意识流，缺可视听化动作；
- 地点或时间原文没明说、是你推断的。
分档：0.9~1.0 近乎直译式、很有把握；0.7~0.9 基本可靠少量推断；0.4~0.7 明显不确定→需复核；<0.4 大量虚构、很可能出错。

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
