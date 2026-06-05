// 质检员（纯代码，不依赖 LLM）。三把尺子量剧本：
//  ① 形状：对照 Schema（必填字段、合法取值）—— 硬错误，打回
//  ② 引用：对白指向的人物必须在人物表里、引用的场次要存在 —— 硬错误，打回
//  ③ 常识：空场、缺源文、角色未登场却说话 —— 软问题，警告（标红），不打回
//
// errors 为空即 valid；warnings 不影响 valid，用来喂工作台的"置信度标红"。

type Obj = Record<string, unknown>;

export interface ValidationIssue {
  path: string; // 位置，如 scenes[2].elements[1]
  message: string; // 中文说明
}
export interface ValidationResult {
  valid: boolean;
  errors: ValidationIssue[]; // 尺子①② → 打回
  warnings: ValidationIssue[]; // 尺子③ → 标红
}

const SETTINGS = ["INT", "EXT"];
const TIMES = ["DAY", "NIGHT", "DUSK", "DAWN", "CONTINUOUS", "LATER"];
const ELEMENT_TYPES = ["action", "dialogue", "dual_dialogue", "transition"];
const DIALOGUE_MODES = ["in_scene", "voiceover", "off_screen"];

function isObject(v: unknown): v is Obj {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.trim().length > 0;
}

export function validateScreenplay(data: unknown): ValidationResult {
  const errors: ValidationIssue[] = [];
  const warnings: ValidationIssue[] = [];
  const err = (path: string, message: string) => errors.push({ path, message });
  const warn = (path: string, message: string) => warnings.push({ path, message });

  if (!isObject(data)) {
    err("(root)", "剧本必须是一个对象");
    return { valid: false, errors, warnings };
  }

  // ── meta ──
  if (!isObject(data.meta) || !isNonEmptyString(data.meta.title)) {
    err("meta.title", "缺少剧本标题 meta.title");
  }

  // ── 人物表 ──（同时收集所有人物 id 供尺子②用）
  const charIds = new Set<string>();
  if (!Array.isArray(data.characters) || data.characters.length === 0) {
    err("characters", "缺少人物表，或人物表为空");
  } else {
    data.characters.forEach((c, i) => {
      if (!isObject(c)) {
        err(`characters[${i}]`, "人物必须是对象");
        return;
      }
      if (!isNonEmptyString(c.id)) {
        err(`characters[${i}].id`, "人物缺少 id");
      } else {
        if (charIds.has(c.id)) err(`characters[${i}].id`, `人物 id 重复：${c.id}`);
        charIds.add(c.id);
      }
      if (!isNonEmptyString(c.name)) err(`characters[${i}].name`, "人物缺少 name");
    });
  }

  // ── 场次 ──
  const sceneIds = new Set<string>();
  if (!Array.isArray(data.scenes) || data.scenes.length === 0) {
    err("scenes", "缺少场次，或场次为空");
  } else {
    const firstAppear = computeFirstAppearance(data.characters, data.scenes);

    data.scenes.forEach((s, i) => {
      const p = `scenes[${i}]`;
      if (!isObject(s)) {
        err(p, "场次必须是对象");
        return;
      }
      if (isNonEmptyString(s.id)) sceneIds.add(s.id);
      else err(`${p}.id`, "场次缺少 id");
      if (typeof s.number !== "number") err(`${p}.number`, "场次缺少场号 number");

      // 尺子①：场标
      if (!isObject(s.heading)) {
        err(`${p}.heading`, "场次缺少场标 heading");
      } else {
        const h = s.heading;
        if (!SETTINGS.includes(h.setting as string))
          err(`${p}.heading.setting`, `内/外景只能是 INT 或 EXT，收到：${String(h.setting)}`);
        if (!isNonEmptyString(h.location)) err(`${p}.heading.location`, "场标缺少地点 location");
        if (!TIMES.includes(h.time as string))
          err(`${p}.heading.time`, `时间取值非法：${String(h.time)}`);
      }

      // 尺子①②：场内元素
      if (!Array.isArray(s.elements)) {
        err(`${p}.elements`, "场次缺少 elements 列表");
      } else {
        if (s.elements.length === 0) warn(`${p}.elements`, "空场：这一场没有任何动作或对白");
        s.elements.forEach((el, j) => validateElement(el, `${p}.elements[${j}]`, charIds, err));
      }

      // 尺子③：源文映射缺失
      if (!isObject(s.source)) warn(`${p}.source`, "缺少源文映射，无法溯源到原文");

      // 尺子③：角色未登场却说话
      const order = typeof s.number === "number" ? s.number : i + 1;
      for (const cid of speakersIn(s)) {
        const appear = firstAppear.get(cid);
        if (appear === undefined || appear > order) {
          const nm = nameOf(data.characters, cid) ?? cid;
          warn(p, `角色「${nm}」在登场前就有台词（可能 LLM 搞混了人物）`);
        }
      }
    });
  }

  // 尺子②：structure 引用的场次必须存在
  if (Array.isArray(data.structure)) {
    data.structure.forEach((st, i) => {
      if (isObject(st) && Array.isArray(st.scene_ids)) {
        st.scene_ids.forEach((sid) => {
          if (!sceneIds.has(sid as string))
            err(`structure[${i}].scene_ids`, `引用了不存在的场次：${String(sid)}`);
        });
      }
    });
  }

  return { valid: errors.length === 0, errors, warnings };
}

function validateElement(
  el: unknown,
  path: string,
  charIds: Set<string>,
  err: (p: string, m: string) => void,
) {
  if (!isObject(el)) {
    err(path, "元素必须是对象");
    return;
  }
  if (!ELEMENT_TYPES.includes(el.type as string)) {
    err(`${path}.type`, `元素类型非法：${String(el.type)}`);
    return;
  }
  if (el.type === "action") {
    if (!isNonEmptyString(el.text)) err(`${path}.text`, "动作元素缺少 text");
  } else if (el.type === "dialogue") {
    if (!isNonEmptyString(el.character)) err(`${path}.character`, "对白缺少说话人 character");
    else if (!charIds.has(el.character))
      err(`${path}.character`, `对白指向不存在的人物：${el.character}`); // 尺子②
    if (!isNonEmptyString(el.line)) err(`${path}.line`, "对白缺少台词 line");
    if (el.mode !== undefined && !DIALOGUE_MODES.includes(el.mode as string))
      err(`${path}.mode`, `对白 mode 非法：${String(el.mode)}`);
  } else if (el.type === "dual_dialogue") {
    if (!Array.isArray(el.lines) || el.lines.length === 0) {
      err(`${path}.lines`, "双人对白缺少 lines");
    } else {
      el.lines.forEach((ln, k) => {
        if (!isObject(ln) || !isNonEmptyString(ln.character))
          err(`${path}.lines[${k}].character`, "双人对白缺少说话人");
        else if (!charIds.has(ln.character))
          err(`${path}.lines[${k}].character`, `指向不存在的人物：${ln.character}`);
        if (!isObject(ln) || !isNonEmptyString(ln.line))
          err(`${path}.lines[${k}].line`, "双人对白缺少台词");
      });
    }
  } else if (el.type === "transition") {
    if (!isNonEmptyString(el.text)) err(`${path}.text`, "转场缺少 text");
  }
}

/** 收集一场戏里所有"说话人"的人物 id。 */
function speakersIn(scene: Obj): string[] {
  const ids: string[] = [];
  if (!Array.isArray(scene.elements)) return ids;
  for (const el of scene.elements) {
    if (!isObject(el)) continue;
    if (el.type === "dialogue" && isNonEmptyString(el.character)) ids.push(el.character);
    if (el.type === "dual_dialogue" && Array.isArray(el.lines)) {
      for (const ln of el.lines) if (isObject(ln) && isNonEmptyString(ln.character)) ids.push(ln.character);
    }
  }
  return ids;
}

/** 把一场戏里所有动作描述文字拼起来（用来判断角色是否"被描述/登场"）。 */
function collectActionText(scene: Obj): string {
  if (!Array.isArray(scene.elements)) return "";
  return scene.elements
    .filter((el): el is Obj => isObject(el) && el.type === "action" && isNonEmptyString(el.text))
    .map((el) => el.text as string)
    .join(" ");
}

/** 算出每个角色"首次登场"的场号：名字或别名首次出现在某场动作描述里。 */
function computeFirstAppearance(characters: unknown, scenes: unknown[]): Map<string, number> {
  const map = new Map<string, number>();
  const chars: { id: string; needles: string[] }[] = [];
  if (Array.isArray(characters)) {
    for (const c of characters) {
      if (isObject(c) && isNonEmptyString(c.id)) {
        const needles: string[] = [];
        if (isNonEmptyString(c.name)) needles.push(c.name);
        if (Array.isArray(c.aliases)) for (const a of c.aliases) if (isNonEmptyString(a)) needles.push(a);
        chars.push({ id: c.id, needles });
      }
    }
  }
  scenes.forEach((s, i) => {
    if (!isObject(s)) return;
    const order = typeof s.number === "number" ? s.number : i + 1;
    const text = collectActionText(s);
    for (const c of chars) {
      if (map.has(c.id)) continue;
      if (c.needles.some((n) => text.includes(n))) map.set(c.id, order);
    }
  });
  return map;
}

function nameOf(characters: unknown, id: string): string | undefined {
  if (!Array.isArray(characters)) return undefined;
  for (const c of characters) {
    if (isObject(c) && c.id === id && isNonEmptyString(c.name)) return c.name;
  }
  return undefined;
}
