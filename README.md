# SceneWeaver · 小说转剧本助手

把 3 章以上小说自动改编成**结构化、可溯源、可打磨**的剧本。

> 七牛云 × XEngineer 暑期实训营 · 第三批次 题三 参赛作品

![SceneWeaver 首页](./public/screenshot-home.png)

---

## 一句话

不是黑盒一键生成器。是给作者用的**改编工作台**——导入小说 → 对照原文逐场打磨 → 导出结构化剧本。

---

## 核心差异化

| | 现有工具 | SceneWeaver |
|---|---|---|
| 输出 | 纯文本初稿 | **结构化 YAML**（场/动作/对白/转场都是可编辑字段） |
| 人物 | 无或仅列表 | **全局人物表 + 别名归一 + 跨章一致** |
| 溯源 | 无 | **每场标原文段落**，点击场卡 → 原文高亮跳转 |
| 可信度 | 无 | **每场置信度三档**（绿·黄·红），低置信标红提示 |
| 可编辑 | 重新生成 | **就地改字**，对白/动作/梗概点一下即改，自动存 |
| 过程 | 黑盒 | **双阶段可解释**：理解(人物+分场) → 改编(视听化+对白) |
| 进度 | 干等 | **实时 SSE 进度流**：百分比+阶段+日志 |

---

## 产品形态

一个单页 **改编工作台**，不是一键生成器——生成只是工作台里的一个动作，重心在对照打磨。

**用户旅程**：  导入小说 → 机器自动切场景+抽人物 → 一键生成 → 左原文右剧本对照打磨 → 导出

**功能地图**：

| 页面 | 功能 |
|---|---|
| 启动页 | 暗底品牌页（首次访问），之后不再出现 |
| 项目库 | 网格卡片、重命名、删除、字数统计、两列布局 |
| 导入页 | 粘贴/上传 .txt/.md/.docx |
| 生成页 | SSE 实时进度（理解→改编→质检三阶段，百分比+进度条） |
| 工作台 | 左原文中剧本对照、点场景跳原文高亮、场卡就地编辑、置信环、导出（国内排版/YAML） |
| 人物图谱 | Canvas 力导向图、悬停高亮关联、拖拽缩放 |

---

## 技术架构

```
前端 (Next.js App Router)
  ├─ 启动页 / 项目库 / 导入页 / 生成页 / 工作台
  ├─ IndexedDB 持久化（idb-keyval，刷新不丢）
  └─ SSE 流式消费（ReadableStream → 实时进度）

API 路由 (/api/generate)
  ├─ SSE text/event-stream 推送进度
  └─ 服务端编排（Node.js，20 并发，无浏览器连接限制）

Pipeline (lib/screenplay/)
  ├─ Call 1：理解（人物表 + 分场 + 类型识别）
  ├─ Call 2：分批并行改编（整场不拆、共享人物表）
  └─ Calibration：代码质检（5 条规则）+ LLM 修复（最多 1 次）
```

**设计原则**：「什么时候做」用确定性代码，「做什么」才给 LLM。LLM 决定人物/场景/对白；代码负责分章分段、调度并发、校验格式、序列化 YAML、渲染排版。

---

## 技术栈

- **全栈框架**：Next.js 16 (TypeScript, App Router, Turbopack)
- **前端**：React + Tailwind CSS, contentEditable 就地编辑, Canvas 力导向图
- **持久化**：IndexedDB (idb-keyval)
- **LLM 接入**：OpenAI 兼容协议，支持 DeepSeek / Claude / Kimi / 智谱等 9 家
- **流式进度**：Server-Sent Events (ReadableStream)
- **测试**：Vitest（35 用例覆盖 pipeline / 质检 / JSON 容错 / 渲染）
- **CI**：GitHub Actions（每 PR 自动 lint + typecheck + build + test）

---

## 工程过程

38 个 feature-branch PR，每个 PR 遵循四段描述规范（功能 · 实现 · 测试 · 复用来源），CI 绿后合并入 main，main 始终可运行。

```
PR #1–#2   脚手架 + CI
PR #3–#4   数据层（Schema → TS 类型 + YAML 序列化 + 质检）
PR #5–#21  端到端骨架 → 加深理解层 → 改编层 → 工作台对照 → 导出
PR #22–#28 导出下载 / 点场景跳原文 / 场卡微调 / IDB 持久化 / 就地编辑
PR #29–#35 设计系统（启动页/项目库/导入页/生成页/工作台 UI/类型识别）
PR #36–#38 人物关系图谱
```

---

## 剧本 Schema（YAML 数据契约）

> 完整设计文档：[docs/剧本Schema设计文档.md](docs/剧本Schema设计文档.md)

```yaml
meta:
  title: "咖啡馆的重逢"          # 剧本标题
  logline: "多年后，林夏回到故城…" # 一句话梗概（可选）
  genre: ["都市", "情感"]        # 类型标签
  adapted_from:                  # 原著信息（可选）
    novel_title: "示例小说"
    chapters: [1, 2, 3]

characters:                      # 全局人物表
  - id: char_wang                # 唯一标识（拼音_名，LLM 稳定输出）
    name: 王志强
    aliases: ["老王", "王先生"]   # 别名归一
    description: "35岁，咖啡馆老板"
    role: protagonist            # protagonist / supporting / minor

scenes:                          # 场次列表
  - id: scene_001
    number: 1                    # 场号（全局连续）
    act: 1                       # 幕（可选）
    heading:                     # 场标
      setting: INT               # INT / EXT
      location: 暖咖啡 - 窗边
      time: DAY                  # DAY / NIGHT
    synopsis: "王志强与林夏多年后重逢"  # 一句话梗概
    dramatic_function: "建立两人的疏离，埋下未解的过往"  # 本场推进了什么
    source:                      # 源文映射（← 可溯源的关键）
      chapter: 1
      paragraph_range: [12, 18]  # 对应原文 ¶12–¶18
    elements:                    # 场内元素（有序）
      - type: action
        text: "午后的阳光斜照进暖咖啡。王志强擦着杯子…"
        from_internal: true      # 由原文内心戏外化而来（可选）
        note: "原文：林夏心里七上八下"
      - type: dialogue
        character: char_lin      # 引用人物表 id
        mode: in_scene           # in_scene / voiceover / off_screen
        parenthetical: "迟疑地"  # 表演提示（可选）
        line: "好久不见。"
      - type: dual_dialogue      # 双人同时说
        lines:
          - { character: char_wang, line: "你…" }
          - { character: char_lin, line: "我…" }
      - type: transition
        text: CUT TO
    review:                      # 审阅状态
      status: generated          # generated / edited / confirmed
      confidence: 0.82           # 0~1，自创比例越低越接近 1
```

---

## 本地运行

```bash
git clone https://github.com/2srf8tn66q-bit/sceneweaver.git
cd sceneweaver
npm install
npm run dev        # http://localhost:3000
npm test           # 35 用例
npm run build      # 生产构建
```

需要配置 LLM API Key（设置页 → 选提供方 → 填 Key，存于浏览器本地，永不入库）。推荐 DeepSeek（`deepseek-chat`，速度快）。

Demo 用《血字的研究》前 3 章（公版、对白多、知名）。

---

## 文档

- [产品需求文档](docs/PRD.md)
- [剧本 YAML Schema 设计文档](docs/剧本Schema设计文档.md)
- [项目计划与进度](Plan.md)
