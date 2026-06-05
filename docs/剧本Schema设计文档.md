# 剧本 YAML Schema 设计文档

> SceneWeaver 的核心数据契约。本文定义把小说改编成剧本时使用的 YAML 结构，并**逐条说明每个设计决策的原因**。版本：v0.2（2026-06-05）。

---

## 1. 概述

SceneWeaver 把小说自动改编成剧本。剧本不是给人随便读的散文，而是一份**有严格结构、要被反复编辑、还要能追溯来源**的工程化数据。因此我们不直接输出纯文本剧本，而是先输出一份**结构化的 YAML 中间产物**，再由它渲染成各种排版的成品剧本。

这份 YAML 的"形状"就是本文档定义的 Schema。

## 2. 设计目标

| 目标 | 含义 |
|---|---|
| **结构化可编辑** | 场、动作、对白、转场都是独立字段，能被程序和人精确读写，而不是一坨文本。 |
| **跨章人物一致** | 一个角色在全篇有唯一身份，"老王 / 王先生 / 他"指向同一人。 |
| **可溯源** | 每场戏能回指到原著的章节段落，支撑"可编辑、可进一步打磨"。 |
| **人机协作** | 标注哪些是机器生成、置信度多少，让作者知道该重点改哪里。 |
| **数据与表现分离** | 结构数据只描述"是什么"，排版（国内 △ / 好莱坞大写、场标顺序）是渲染层的事。 |
| **可扩展** | 新增剧本元素（旁白、双人对白、闪回…）不破坏已有结构。 |

## 3. 为什么用 YAML（而不是 JSON / 纯文本 / Fountain）

- **vs 纯文本**：纯文本剧本（多数竞品的输出）人能读，但程序无法精确定位"第 3 场第 2 句谁说的话"，无法挂溯源和置信度元数据，无法做结构化编辑。改编初稿的价值恰恰在"可继续打磨"，纯文本把这条路堵死了。
- **vs JSON**：JSON 同样结构化，但**括号引号逗号多、不能写注释、对人不友好**。剧本要交给作者手动打磨，YAML 的缩进式层级更适合人直接读写。
- **vs [Fountain](https://fountain.io/syntax/)**：Fountain 是成熟的纯文本剧本标记格式，但它是**给人写、给排版引擎用**的；我们要的是**给程序读写、能结构化编辑、能挂溯源/置信度元数据**的载体。我们借鉴 Fountain 的**元素分类**（见 §7），但用 YAML 承载。

> 一句话：YAML = JSON 的结构化 + 纯文本的可读可手编 + 可注释，正好匹配"机器生成、作者打磨"的协作场景。

## 4. 顶层结构

一个剧本文件由四部分组成：

```
meta         # 元数据：标题、改编来源、渲染偏好
characters   # 全局人物表：一处定义，全篇引用
structure    # 幕 / 场分层（可选，长篇用）
scenes       # 场次列表：剧本主体，scene 是最小结构单元
```

## 5. 完整 Schema（v0.2，带注释）

```yaml
meta:
  title: 咖啡馆的重逢
  logline: 一句话故事梗概               # 行业惯例：一句话讲清整个故事
  adapted_from:
    novel_title: 小说原名
    chapters: [1, 2, 3]                # 本剧本覆盖原著哪几章
  genre: [都市, 爱情]                   # 可选
  render_format: cn                    # cn=国内(时间-内外景-地点, △) / us=好莱坞(INT.-地点-时间)
                                       # 只影响导出排版，不影响下面的结构数据

characters:
  - id: char_wang                      # 全局唯一 id；下文一律引用 id，不写名字
    name: 王志强                        # 标准名(canonical name)
    aliases: [老王, 王先生, 小强]         # 原著出现过的各种称呼，做实体归一
    description: 35岁，咖啡馆老板，沉默寡言  # 人物小传，给选角/表演参考
    role: protagonist                  # protagonist / supporting / minor
  - id: char_lin
    name: 林夏
    aliases: [小夏, 她]
    description: 28岁，回国的设计师
    role: protagonist

structure:                             # 幕/场分层（可选，对标 Fountain section）
  - act: 1
    title: 重逢
    scene_ids: [scene_001]

scenes:
  - id: scene_001
    number: 1                          # 场号，给人读
    act: 1                             # 归属哪一幕，可选

    heading:                           # 场标(slug line)：三要素，只存结构
      setting: INT                     # INT 内景 / EXT 外景
      location: 咖啡馆 - 窗边            # 地点
      time: DAY                        # DAY/NIGHT/DUSK/DAWN/CONTINUOUS/LATER

    synopsis: 王志强与林夏多年后重逢        # 本场一句话梗概，便于浏览/检索
    dramatic_function: 建立两人的疏离，埋下未解的过往   # 本场推进了什么（呼应"每场至少做 2-3 件事"）

    source:                            # 溯源：对应原著位置，支撑可编辑可打磨
      chapter: 1
      paragraph_range: [12, 18]        # 来自第 1 章第 12~18 段

    adaptation_note: 原文大段写林夏忐忑心理，已外化为"迟疑地"开口 + 手指绞衣角  # 内心戏如何外化

    elements:                          # 场内元素：有序异构列表，保留动作与对白的交错顺序
      - type: action                   # ① 动作 / 场景描述
        text: 午后的阳光斜照进咖啡馆。王志强擦着杯子，门铃响了。

      - type: dialogue                 # ② 对白
        character: char_lin            # 引用人物 id
        mode: in_scene                 # in_scene 实拍 / voiceover 画外音(V.O.) / off_screen(O.S.)
        parenthetical: 迟疑地           # 表演/语气提示，可选
        line: 好久不见。

      - type: dialogue
        character: char_wang
        line: ……你回来了。

      - type: dual_dialogue            # ③ 双人同时说（并列呈现）
        lines:
          - { character: char_wang, line: 你先说。 }
          - { character: char_lin,  line: 你先说。 }

      - type: transition               # ④ 转场
        text: CUT TO

    review:                            # 编辑状态：人机协作元信息
      status: generated                # generated 自动生成 / edited 已修改 / confirmed 已确认
      confidence: 0.82                 # 模型对本场的置信度，低的→编辑器标红提示重点检查
```

## 6. 字段详解

### meta
- `render_format`：渲染偏好。**关键**——它不改变任何结构数据，只决定导出时按国内还是好莱坞排版（见 §8）。
- `adapted_from`：记录改编自哪部小说的哪几章，满足赛题"3 章以上"的可追溯性。

### characters（全局人物表）
- `id`：全局唯一标识，场内对白只引用 id。
- `aliases`：实体归一的关键。理解阶段先扫全文建好别名表，后续所有"他 / 老王 / 王先生"都解析到同一个 id。

### structure（幕/场分层，可选）
- 长篇剧本用幕(act)/序列组织；短篇可省略。对标 Fountain 的 `#`(幕)/`##`(场) section。

### scenes（场次，剧本主体）
- `heading`：场标三要素 `setting / location / time`，**只存结构值**（INT/EXT、地点串、时间枚举），不含任何排版符号。
- `synopsis` / `dramatic_function`：前者是"讲了什么"，后者是"推进了什么"——后者用来对齐编剧专业要求（每场至少推进 2-3 件事），也是别的工具不会做的设计深度。
- `source`：本场对应原文段落区间，支撑编辑器"跳回原文对照"和"重新生成本场"。
- `adaptation_note`：记录改编时把哪段内心戏外化成了什么动作，既是可解释性，也方便作者核对。
- `elements`：见 §7。
- `review`：`status` + `confidence`，把工具从"一次性生成"变成"可持续打磨的协作对象"。

## 7. 核心设计决策与理由

### 决策 1：对白只引用人物 `id`，不直接写名字
**理由**：解决跨章人物一致性。先在理解阶段建好含别名的人物表，之后改名、统计某角色台词量、校验"角色未登场就说话"，全靠 id。把人物从场次里抽成全局表，也让作者改人设只改一处。

### 决策 2：场内用**有序的 `elements` 列表**，而非分开的 `action[]` / `dialogue[]`
**理由**：剧本的本质是**动作和对白交错推进**（擦杯子 → 门铃响 → 她开口 → 他回应）。拆成两个数组会丢失这个先后顺序。用一个有序异构列表、每项带 `type`，叙事顺序天然保留，渲染时顺着读即可。

### 决策 3：每个元素用 `type` 标记
**理由**：可无痛扩展。目前有 `action / dialogue / dual_dialogue / transition`，预留 `voiceover / subheading / flashback` 等——新增剧本元素只是多一种 type，不改结构。元素分类参照 Fountain 的成熟实践。

### 决策 4：`source` 溯源字段
**理由**：直接命中赛题"可编辑、可进一步打磨"。作者点一场戏能跳回原文对照、可"重新生成本场"。这是把"一次性黑盒输出"变成"可追溯协作"的关键，也是与竞品最大的差异点之一。

### 决策 5：`review.status` / `confidence` 人机协作字段
**理由**：机器改编必然有不确定。显式告诉作者"这场是机器生成的、置信度多少"，让编辑器**把低置信场景标红**，把作者的注意力引到最该改的地方。

### 决策 6：`render_format` + 场标只存结构 = **数据与表现分离**
**理由**：国内剧本场标是"时间—内外景—地点"、动作行首加 △、人物名加粗；好莱坞是"INT.—地点—时间"、全大写。这些**全是排版差异，底层结构一致**。所以结构数据只存 `setting/location/time` 等语义值，排版交给渲染层按 `render_format` 决定。好处：**同一份数据可导出国内或好莱坞两种格式**，互不污染。

### 决策 7：`adaptation_note` / `dramatic_function` 记录改编意图
**理由**：改编最核心的动作是"把不可见的内心戏外化"（show, don't tell）。把"原文是心理描写、已外化为 XX 动作"显式记下来，既提升可解释性，也让作者一眼看出改编是否到位。

## 8. 中外剧本格式与渲染层

同一份 Schema 数据，按 `render_format` 渲染成两种排版：

| 元素 | 结构数据（存这个） | 国内渲染(cn) | 好莱坞渲染(us) |
|---|---|---|---|
| 场标 | `setting/location/time` | 日 内 咖啡馆 | INT. 咖啡馆 - DAY |
| 动作 | `action.text` | △ 行首标记 | 普通段落 |
| 人物名 | `character` → name | 加粗 | 全大写 |
| 转场 | `transition.text` | 加粗大写 | 右对齐大写 |

渲染层是纯函数：`(scene 数据, render_format) → 排版文本`，不回写数据。

## 9. 扩展性（预留元素类型）

`elements[].type` 当前实现 `action / dialogue / dual_dialogue / transition`，按需扩展（不破坏现有结构）：
- `voiceover`：整段旁白（区别于 dialogue 的 `mode: voiceover`）。
- `subheading`：场内子场标（同一大场景下的局部切换）。
- `flashback` / `montage`：闪回 / 蒙太奇段落标记。

## 10. 已知取舍

- `confidence` 当前是模型自评，可靠性有限；后续可叠加规则校验（如"角色未在本场登场却有台词"自动降分）。
- `source.paragraph_range` 依赖输入小说能稳定切段；对无明显分段的文本需先做段落归一。
- 幕/场分层 `structure` 对短篇是冗余，故设为可选。

---

*版本历史：v0.1 初版（meta/characters/scenes + 有序 elements + source + review）→ v0.2 增补旁白 mode、dual_dialogue、幕分层、dramatic_function、adaptation_note、render_format，并明确数据与表现分离。*
