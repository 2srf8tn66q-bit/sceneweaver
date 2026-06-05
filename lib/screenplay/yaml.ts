// YAML 翻译器：内部数据 ⇄ YAML 文本。

import yaml from "js-yaml";
import type { Screenplay } from "./types";

/** 把剧本对象导出成 YAML 文本（给作者下载 / 手改）。 */
export function toYaml(screenplay: Screenplay): string {
  return yaml.dump(screenplay, { lineWidth: 100, noRefs: true });
}

/**
 * 把 YAML 文本读回成数据。
 * 故意返回 unknown —— 读回来的东西未必合格，必须再交给 validateScreenplay 质检。
 */
export function parseYaml(text: string): unknown {
  return yaml.load(text);
}
