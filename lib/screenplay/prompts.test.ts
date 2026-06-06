import { describe, it, expect } from "vitest";
import { buildUnderstandMessages, buildAdaptMessages, buildRepairMessages } from "./prompts";

describe("prompt 构造器", () => {
  it("Call1 理解：含编号原文，要求只输出 JSON", () => {
    const msgs = buildUnderstandMessages("¶1 林夏走进来。");
    expect(msgs[0].role).toBe("system");
    expect(msgs[1].content).toContain("¶1 林夏走进来。");
    expect(msgs[0].content).toContain("只输出 JSON");
  });

  it("Call2 改编：含人物 id、from_internal、V.O. 技法、描述性 confidence", () => {
    const msgs = buildAdaptMessages(
      [{ id: "char_lin", name: "林夏", aliases: ["小夏"] }],
      [{ number: 1, range: [1, 3], text: "林夏走进来。" }],
    );
    const all = msgs.map((m) => m.content).join("\n");
    expect(all).toContain("char_lin");
    expect(all).toContain("from_internal");
    expect(all).toContain("dramatic_function");
    expect(all).toContain("synopsis");
    expect(all).toContain("画外音"); // 开场 V.O. 技法
    expect(all).toContain("不是对错评分"); // confidence 改为描述性、非评价
    expect(all).toContain("林夏走进来。");
  });

  it("修复：把质检错误逐条喂回 + 附上次输出", () => {
    const msgs = buildRepairMessages('{"bad":1}', [
      { path: "scenes[0].heading.setting", message: "非法值 室内" },
    ]);
    const all = msgs.map((m) => m.content).join("\n");
    expect(all).toContain("scenes[0].heading.setting");
    expect(all).toContain("非法值 室内");
    expect(all).toContain('{"bad":1}');
  });
});
