import { describe, it, expect } from "vitest";
import { extractJSON, safeParseJSON } from "./json";

describe("JSON 容错（extractJSON / safeParseJSON）", () => {
  it("从 ```json 代码块里抠出 JSON", () => {
    const t = '前言\n```json\n{"a":1}\n```\n后记';
    expect(JSON.parse(extractJSON(t))).toEqual({ a: 1 });
  });

  it("从前后带解释文字的对象里抠出 JSON", () => {
    const t = '好的，{"name":"林夏","ok":true} 以上。';
    expect(JSON.parse(extractJSON(t))).toEqual({ name: "林夏", ok: true });
  });

  it("正确处理嵌套花括号", () => {
    const t = '{"a":{"b":{"c":1}},"d":2}';
    expect(JSON.parse(extractJSON(t))).toEqual({ a: { b: { c: 1 } }, d: 2 });
  });

  it("忽略 JSON 字符串内容里的花括号和转义引号", () => {
    const text = '说明 {"statement":"门上写着 {RACHE}，他说 \\\"别碰}\\\"","ok":true} 尾注';
    expect(JSON.parse(extractJSON(text))).toEqual({
      statement: '门上写着 {RACHE}，他说 "别碰}"',
      ok: true,
    });
  });

  it("safeParseJSON 解析成功返回对象", () => {
    expect(safeParseJSON('```json\n{"x":9}\n```', {})).toEqual({ x: 9 });
  });

  it("safeParseJSON 解析失败返回兜底", () => {
    expect(safeParseJSON("模型今天抽风，没给 JSON", { ok: false })).toEqual({ ok: false });
  });
});
