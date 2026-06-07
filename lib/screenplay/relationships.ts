// 从剧本数据计算人物共现关系，供人物图谱使用。
// 关系强度 = 两人在同一场出现的次数；标签暂用共现场数表达。

import type { Screenplay } from "./types";

export interface RelationEdge {
  source: string;
  target: string;
  weight: number; // 共现场数
  label: string; // 关系标签（暂为「N 场同框」）
}

/** 返回有出场的角色 id 集合 + 共现边。人物表全员都在集合里（含无对白、仅出现于动作描写者）。 */
export function buildRelations(sp: Screenplay): {
  appeared: Set<string>;
  edges: RelationEdge[];
} {
  const appeared = new Set<string>();
  const cooccur = new Map<string, number>();

  // 预建名字→id 索引，供动作描写模糊匹配
  const nameToId = new Map<string, string>();
  for (const c of sp.characters) {
    nameToId.set(c.name, c.id);
    for (const a of c.aliases ?? []) nameToId.set(a, c.id);
  }

  for (const scene of sp.scenes) {
    const chars = new Set<string>();
    for (const el of scene.elements) {
      if (el.type === "dialogue" && el.character) chars.add(el.character);
      if (el.type === "dual_dialogue") {
        for (const ln of el.lines) if (ln.character) chars.add(ln.character);
      }
      // 动作描写中可能提及人物名
      if (el.type === "action" && el.text) {
        for (const [name, id] of nameToId) {
          if (el.text.includes(name)) chars.add(id);
        }
      }
    }
    for (const cid of chars) appeared.add(cid);
    const ids = [...chars].sort();
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        const key = `${ids[i]}|${ids[j]}`;
        cooccur.set(key, (cooccur.get(key) ?? 0) + 1);
      }
    }
  }

  // 人物表全员至少出现在集合里（即使没台词没动作提及，也显示为孤立节点）
  for (const c of sp.characters) appeared.add(c.id);

  const edges: RelationEdge[] = [];
  for (const [key, w] of cooccur) {
    const [source, target] = key.split("|");
    edges.push({ source, target, weight: w, label: `${w} 场同框` });
  }

  return { appeared, edges };
}
