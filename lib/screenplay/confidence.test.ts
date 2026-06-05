import { describe, it, expect } from "vitest";
import { confidenceTier } from "./confidence";

describe("置信度分档（confidenceTier）", () => {
  it.each([
    [1, "reliable"],
    [0.7, "reliable"],
    [0.69, "review"],
    [0.4, "review"],
    [0.39, "doubtful"],
    [0, "doubtful"],
  ] as const)("%s → %s", (c, tier) => {
    expect(confidenceTier(c)).toBe(tier);
  });
});
