// 置信度分档：把模型自评的 confidence(0~1) 映射到三档，供工作台决定场卡标记。
// ≥0.7 可靠（留白）/ 0.4–0.7 需复核（琥珀）/ <0.4 存疑（陶土）。

export type ConfidenceTier = "reliable" | "review" | "doubtful";

export function confidenceTier(confidence: number): ConfidenceTier {
  if (confidence >= 0.7) return "reliable";
  if (confidence >= 0.4) return "review";
  return "doubtful";
}
