import { describe, it, expect } from "vitest";
import { renderCn } from "./render";
import { sampleScreenplay } from "./sample";

describe("国内排版渲染（renderCn）", () => {
  const txt = renderCn(sampleScreenplay);

  it("含剧本标题", () => {
    expect(txt).toContain("咖啡馆的重逢");
  });

  it("场标用国内顺序：时间-内/外景-地点", () => {
    expect(txt).toContain("第1场");
    expect(txt).toContain("日"); // DAY → 日
    expect(txt).toContain("内"); // INT → 内
    expect(txt).toContain("暖咖啡 - 窗边");
  });

  it("动作行首加 △", () => {
    expect(txt).toMatch(/△ .*王志强擦着杯子/);
  });

  it("对白用 人物名（语气）：台词，画外单独标注", () => {
    expect(txt).toContain("林夏（迟疑地）：好久不见。");
    expect(txt).toContain("林夏（画外）：有些话，隔了十年还是说不出口。");
  });
});
