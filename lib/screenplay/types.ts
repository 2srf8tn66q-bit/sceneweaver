// 剧本的"标准表头" —— 用 TypeScript 类型表达 Schema v0.2。
// 字段名刻意与 YAML / Schema 设计文档保持 1:1（含下划线命名），
// 这样 YAML 导出就是把对象直接 dump，无需额外的映射层。

export type RenderFormat = "cn" | "us";
export type Setting = "INT" | "EXT";
export type TimeOfDay = "DAY" | "NIGHT" | "DUSK" | "DAWN" | "CONTINUOUS" | "LATER";
export type CharacterRole = "protagonist" | "supporting" | "minor";
export type DialogueMode = "in_scene" | "voiceover" | "off_screen";
export type ReviewStatus = "generated" | "edited" | "confirmed";

export interface Meta {
  title: string;
  logline?: string;
  adapted_from?: { novel_title?: string; chapters?: number[] };
  genre?: string[];
  render_format?: RenderFormat;
}

export interface Character {
  id: string;
  name: string;
  aliases?: string[];
  description?: string;
  role?: CharacterRole;
}

export interface Heading {
  setting: Setting;
  location: string;
  time: TimeOfDay;
}

export interface SourceRef {
  chapter: number;
  paragraph_range?: [number, number];
}

export interface ActionElement {
  type: "action";
  text: string;
  from_internal?: boolean; // true = 由原文内心戏外化而来（界面以 ✦ 标记）
  note?: string; // 可选：外化说明，悬停显示
}
export interface DialogueElement {
  type: "dialogue";
  character: string; // 人物 id
  mode?: DialogueMode;
  parenthetical?: string;
  line: string;
}
export interface DualDialogueElement {
  type: "dual_dialogue";
  lines: { character: string; line: string }[];
}
export interface TransitionElement {
  type: "transition";
  text: string;
}
export type SceneElement =
  | ActionElement
  | DialogueElement
  | DualDialogueElement
  | TransitionElement;

export interface Review {
  status: ReviewStatus;
  confidence: number; // 0~1
}

export interface Scene {
  id: string;
  number: number;
  act?: number;
  heading: Heading;
  synopsis?: string;
  dramatic_function?: string;
  source?: SourceRef;
  elements: SceneElement[];
  review?: Review;
}

export interface ActStructure {
  act: number;
  title?: string;
  scene_ids: string[];
}

export interface Screenplay {
  meta: Meta;
  characters: Character[];
  structure?: ActStructure[];
  scenes: Scene[];
}
