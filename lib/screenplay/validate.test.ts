import { describe, it, expect } from "vitest";
import { validateScreenplay } from "./validate";
import { toYaml, parseYaml } from "./yaml";
import { sampleScreenplay } from "./sample";
import type { Screenplay } from "./types";

// 深拷贝，避免改坏共享样例
const clone = (s: Screenplay): Screenplay => JSON.parse(JSON.stringify(s)) as Screenplay;

describe("剧本数据质检（validateScreenplay）", () => {
  it("合格剧本：通过校验，零错误", () => {
    const r = validateScreenplay(sampleScreenplay);
    expect(r.valid).toBe(true);
    expect(r.errors).toHaveLength(0);
  });

  it("尺子②引用：对白挂到不存在的人物 → 被拦下（硬错误）", () => {
    const bad = clone(sampleScreenplay);
    const dlg = bad.scenes[0].elements.find((e) => e.type === "dialogue");
    if (dlg && dlg.type === "dialogue") dlg.character = "char_ghost";
    const r = validateScreenplay(bad);
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => e.message.includes("不存在的人物"))).toBe(true);
  });

  it("尺子①形状：内/外景填了非法值 → 被拦下（硬错误）", () => {
    const bad = clone(sampleScreenplay);
    (bad.scenes[0].heading as { setting: string }).setting = "室内";
    expect(validateScreenplay(bad).valid).toBe(false);
  });

  it("尺子①形状：人物表为空 → 被拦下", () => {
    const bad = clone(sampleScreenplay);
    bad.characters = [];
    expect(validateScreenplay(bad).valid).toBe(false);
  });

  it("尺子③常识：空场 → 出警告，但不打回（仍 valid）", () => {
    const bad = clone(sampleScreenplay);
    bad.scenes[0].elements = [];
    const r = validateScreenplay(bad);
    expect(r.warnings.some((w) => w.message.includes("空场"))).toBe(true);
    expect(r.valid).toBe(true);
  });

  it("YAML 往返：导出成文本再读回，仍然合格", () => {
    const text = toYaml(sampleScreenplay);
    const back = parseYaml(text);
    expect(validateScreenplay(back).valid).toBe(true);
  });
});
