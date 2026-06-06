// 国内排版渲染器：结构化剧本数据 → 国内格式纯文本。
// 体现"数据与表现分离"——数据只存 setting/location/time，这里决定中文排版。
// 国内惯例：场标"时间 内/外景 地点"，动作行首加 △，对白"人物名（语气）：台词"。

import type { Screenplay, Setting } from "./types";

const SETTING_CN: Record<Setting, string> = { INT: "内", EXT: "外", "INT/EXT": "内/外" };
const TIME_CN: Record<string, string> = {
  DAY: "日",
  NIGHT: "夜",
  DUSK: "黄昏",
  DAWN: "黎明",
  CONTINUOUS: "接",
  LATER: "稍后",
};

export function renderCn(sp: Screenplay): string {
  const nameOf = new Map(sp.characters.map((c) => [c.id, c.name] as const));
  const out: string[] = [sp.meta.title, ""];

  for (const s of sp.scenes) {
    const h = s.heading;
    const time = TIME_CN[h.time] ?? h.time;
    const setting = SETTING_CN[h.setting] ?? h.setting;
    out.push(`第${s.number}场　${time}　${setting}　${h.location}`);

    for (const el of s.elements) {
      if (el.type === "action") {
        out.push(`△ ${el.text}`);
      } else if (el.type === "dialogue") {
        const who = nameOf.get(el.character) ?? el.character;
        const mode = el.mode === "voiceover" ? "（画外）" : el.mode === "off_screen" ? "（画外音）" : "";
        const paren = el.parenthetical ? `（${el.parenthetical}）` : "";
        out.push(`${who}${mode}${paren}：${el.line}`);
      } else if (el.type === "dual_dialogue") {
        for (const ln of el.lines) {
          const who = nameOf.get(ln.character) ?? ln.character;
          out.push(`${who}（同时）：${ln.line}`);
        }
      } else if (el.type === "transition") {
        out.push(el.text);
      }
    }
    out.push("");
  }

  return out.join("\n").trimEnd() + "\n";
}
