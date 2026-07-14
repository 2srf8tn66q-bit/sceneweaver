import { extractJSON } from "../llm/json";
import type { ChatMessage } from "../llm/types";
import { renderNovelChunk } from "../novel/chunking";
import type { ChunkedNovel, NovelChunk, ParagraphRange } from "../novel/types";
import {
  normalizeStoryText,
  sameStoryFactValue,
  storyFactKey,
} from "./facts";
import { fingerprintStorySource } from "./fingerprint";
import type {
  BoundaryCharacterState,
  BoundaryObjectState,
  StoryBible,
  StoryBoundaryState,
  StoryCharacter,
  StoryConflict,
  StoryFact,
  StorySourceRef,
  StoryThread,
  StoryTimelineEvent,
} from "./types";

export type ParallelStoryBibleStage =
  | "local_extract"
  | "identity_reconcile"
  | "boundary_repair";

export interface ParallelStoryBibleRequest {
  stage: ParallelStoryBibleStage;
  messages: ChatMessage[];
  chunkIds: string[];
}

export type ParallelStoryBibleCall = (
  request: ParallelStoryBibleRequest,
  signal?: AbortSignal,
) => Promise<string>;

export interface LocalThreadObservation {
  id: string;
  summary: string;
  action: "open" | "mentioned" | "resolved";
  sourceRefs: StorySourceRef[];
}

export interface LocalChunkBible {
  chunkId: string;
  coreRange: ParagraphRange;
  characters: StoryCharacter[];
  facts: StoryFact[];
  timelineEvents: StoryTimelineEvent[];
  threadObservations: LocalThreadObservation[];
  entryBoundary: StoryBoundaryState;
  exitBoundary: StoryBoundaryState;
}

export interface ParallelCheckpoint {
  sourceFingerprint: string;
  locals: LocalChunkBible[];
}

export interface IdentityGroupOutput {
  memberIds: string[];
  canonicalName: string;
  aliases: string[];
  decision: "same" | "uncertain";
}

export interface IdentityAssignment {
  canonicalId: string;
  memberIds: string[];
  canonicalName: string;
  aliases: string[];
  decision: "same" | "uncertain";
}

export interface ObjectIdentityAssignment {
  canonicalId: string;
  memberIds: string[];
  canonicalName: string;
  decision: "same" | "uncertain";
}

export interface ThreadIdentityAssignment {
  canonicalId: string;
  memberIds: string[];
  canonicalSummary: string;
  decision: "same" | "uncertain";
}

export interface IdentityPlan {
  assignments: IdentityAssignment[];
  uncertainGroups: string[][];
  objectAssignments: ObjectIdentityAssignment[];
  uncertainObjectGroups: string[][];
  threadAssignments: ThreadIdentityAssignment[];
  uncertainThreadGroups: string[][];
}

export interface BoundaryIssue {
  id: string;
  leftChunkId: string;
  rightChunkId: string;
  entityType: "scene" | "character" | "object";
  entityId: string;
  field: string;
  leftValue: string;
  rightValue: string;
  sourceRefs: StorySourceRef[];
  status: "needs_review" | "resolved";
  resolution?:
    | "continuous"
    | "state_change"
    | "extraction_error"
    | "true_conflict"
    | "unresolved";
  explanation?: string;
  factTransitions?: Array<{
    existingFactId: string;
    incomingFactId: string;
  }>;
}

export interface ParallelStoryBibleOptions {
  /** 必须同时标识模型、prompt 与输出 schema 版本。 */
  checkpointIdentity: string;
  concurrency?: number;
  signal?: AbortSignal;
  repairBoundaries?: boolean;
  initialCheckpoint?: ParallelCheckpoint;
  onLocalCheckpoint?: (
    checkpoint: ParallelCheckpoint,
    completedChunk: NovelChunk,
  ) => void | Promise<void>;
  onProgress?: (progress: {
    stage: ParallelStoryBibleStage | "complete";
    completed: number;
    total: number;
    chunkId?: string;
  }) => void;
}

export interface ParallelStoryBibleResult {
  bible: StoryBible;
  chunkedNovel: ChunkedNovel;
  locals: LocalChunkBible[];
  identityPlan: IdentityPlan;
  boundaryIssues: BoundaryIssue[];
  checkpoint: ParallelCheckpoint;
  stats: {
    mapCalls: number;
    reconcileCalls: number;
    repairCalls: number;
  };
}

export class ParallelStoryBibleError extends Error {
  constructor(
    message: string,
    public readonly checkpoint: ParallelCheckpoint,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ParallelStoryBibleError";
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseObject(raw: string, label: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(extractJSON(raw)) as unknown;
    if (!isObject(parsed)) throw new Error("顶层必须是对象");
    return parsed;
  } catch (error) {
    throw new Error(`${label} JSON 无效：${error instanceof Error ? error.message : "无法解析"}`);
  }
}

function cloneRef(ref: StorySourceRef): StorySourceRef {
  return { ...ref, paragraphRange: { ...ref.paragraphRange } };
}

function refKey(ref: StorySourceRef): string {
  return `${ref.chapterId}:${ref.chunkId}:${ref.paragraphRange.start}-${ref.paragraphRange.end}`;
}

function mergeRefs(...groups: StorySourceRef[][]): StorySourceRef[] {
  const refs = new Map<string, StorySourceRef>();
  for (const ref of groups.flat()) refs.set(refKey(ref), cloneRef(ref));
  return [...refs.values()].sort(
    (left, right) =>
      left.paragraphRange.start - right.paragraphRange.start ||
      left.paragraphRange.end - right.paragraphRange.end ||
      refKey(left).localeCompare(refKey(right)),
  );
}

function firstRefParagraph(refs: StorySourceRef[]): number {
  return Math.min(
    ...refs.map((ref) => ref.paragraphRange.start),
    Number.MAX_SAFE_INTEGER,
  );
}

function sameRange(left: ParagraphRange, right: ParagraphRange): boolean {
  return left.start === right.start && left.end === right.end;
}

function assertSourceRef(ref: StorySourceRef, chunk: NovelChunk, path: string) {
  if (!ref || typeof ref !== "object") throw new Error(`${path} 不是有效出处`);
  if (ref.chunkId !== chunk.id) throw new Error(`${path}.chunkId 必须是 ${chunk.id}`);
  if (
    !ref.paragraphRange ||
    !Number.isInteger(ref.paragraphRange.start) ||
    !Number.isInteger(ref.paragraphRange.end) ||
    ref.paragraphRange.start < chunk.coreRange.start ||
    ref.paragraphRange.end > chunk.coreRange.end ||
    ref.paragraphRange.start > ref.paragraphRange.end
  ) {
    throw new Error(`${path} 只能引用当前 core`);
  }
  const chapter = chunk.chapterRanges.find(
    (item) =>
      item.chapterId === ref.chapterId &&
      ref.paragraphRange.start >= item.paragraphRange.start &&
      ref.paragraphRange.end <= item.paragraphRange.end,
  );
  if (!chapter) throw new Error(`${path}.chapterId 与原文范围不匹配`);
}

function assertRefs(refs: StorySourceRef[], chunk: NovelChunk, path: string) {
  if (!Array.isArray(refs) || refs.length === 0) throw new Error(`${path} 不能为空`);
  refs.forEach((ref, index) => assertSourceRef(ref, chunk, `${path}[${index}]`));
}

function assertUniqueIds(items: Array<{ id: string }>, path: string) {
  const ids = new Set<string>();
  for (const item of items) {
    if (!item || typeof item.id !== "string" || item.id.length === 0) {
      throw new Error(`${path} 存在空 id`);
    }
    if (ids.has(item.id)) throw new Error(`${path} 存在重复 id：${item.id}`);
    ids.add(item.id);
  }
}

const LOCAL_FACT_KINDS = new Set([
  "character",
  "relationship",
  "timeline",
  "location",
  "object",
  "knowledge",
  "constraint",
]);
const LOCAL_SUPERSESSION_REASONS = new Set([
  "state_change",
  "correction",
  "reveal",
]);
const LOCAL_CHARACTER_SUBJECT_FACT_KINDS = new Set([
  "character",
  "relationship",
  "timeline",
  "location",
  "knowledge",
]);

function requireText(value: unknown, path: string) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${path} 不能为空`);
  }
}

function assertStringArray(value: unknown, path: string): asserts value is string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`${path} 必须是字符串数组`);
  }
}

function assertOptionalString(value: unknown, path: string): asserts value is string | undefined {
  if (value !== undefined && typeof value !== "string") {
    throw new Error(`${path} 必须是字符串`);
  }
}

function assertUniqueStringIds(ids: string[], path: string) {
  const seen = new Set<string>();
  for (const id of ids) {
    requireText(id, path);
    if (seen.has(id)) throw new Error(`${path} 存在重复 id：${id}`);
    seen.add(id);
  }
}

function assertBoundary(
  boundary: StoryBoundaryState,
  chunk: NovelChunk,
  expectedParagraph: number,
  path: string,
) {
  if (!boundary || boundary.chunkId !== chunk.id) {
    throw new Error(`${path}.chunkId 必须是 ${chunk.id}`);
  }
  if (boundary.asOfParagraph !== expectedParagraph) {
    throw new Error(`${path}.asOfParagraph 必须是 ${expectedParagraph}`);
  }
  assertOptionalString(boundary.timeLabel, `${path}.timeLabel`);
  assertOptionalString(boundary.location, `${path}.location`);
  if (
    !Array.isArray(boundary.characters) ||
    !Array.isArray(boundary.objects) ||
    !Array.isArray(boundary.openReferences)
  ) {
    throw new Error(`${path} 缺少边界状态数组`);
  }
  assertRefs(boundary.sourceRefs, chunk, `${path}.sourceRefs`);
  assertUniqueStringIds(
    boundary.characters.map((state) => state.characterId),
    `${path}.characters`,
  );
  assertUniqueStringIds(
    boundary.objects.map((state) => state.objectId),
    `${path}.objects`,
  );
  boundary.characters.forEach((state, index) =>
    {
      assertOptionalString(
        state.location,
        `${path}.characters[${index}].location`,
      );
      assertOptionalString(
        state.physicalState,
        `${path}.characters[${index}].physicalState`,
      );
      assertStringArray(
        state.knowledge,
        `${path}.characters[${index}].knowledge`,
      );
      assertStringArray(
        state.activeGoals,
        `${path}.characters[${index}].activeGoals`,
      );
      assertRefs(state.sourceRefs, chunk, `${path}.characters[${index}].sourceRefs`);
    },
  );
  boundary.objects.forEach((state, index) => {
    assertOptionalString(
      state.holderCharacterId,
      `${path}.objects[${index}].holderCharacterId`,
    );
    assertOptionalString(state.location, `${path}.objects[${index}].location`);
    assertOptionalString(state.state, `${path}.objects[${index}].state`);
    assertRefs(state.sourceRefs, chunk, `${path}.objects[${index}].sourceRefs`);
  });
  boundary.openReferences.forEach((reference, index) => {
    requireText(reference.text, `${path}.openReferences[${index}].text`);
    assertStringArray(
      reference.candidateCharacterIds,
      `${path}.openReferences[${index}].candidateCharacterIds`,
    );
    assertSourceRef(reference.sourceRef, chunk, `${path}.openReferences[${index}].sourceRef`);
  });
}

function parseLocalChunkBible(raw: string, chunk: NovelChunk): LocalChunkBible {
  const value = parseObject(raw, `${chunk.id} 局部理解`);
  if (value.chunkId !== chunk.id || !isObject(value.coreRange)) {
    throw new Error(`${chunk.id} 局部结果与当前块不匹配`);
  }
  const coreRange = value.coreRange as unknown as ParagraphRange;
  if (!sameRange(coreRange, chunk.coreRange)) {
    throw new Error(`${chunk.id}.coreRange 必须精确等于当前 core`);
  }
  for (const field of [
    "characters",
    "facts",
    "timelineEvents",
    "threadObservations",
  ] as const) {
    if (!Array.isArray(value[field])) throw new Error(`${chunk.id}.${field} 必须是数组`);
  }
  const local = value as unknown as LocalChunkBible;
  assertUniqueIds(local.characters, `${chunk.id}.characters`);
  assertUniqueIds(local.facts, `${chunk.id}.facts`);
  assertUniqueIds(local.timelineEvents, `${chunk.id}.timelineEvents`);
  assertUniqueIds(local.threadObservations, `${chunk.id}.threadObservations`);
  local.characters.forEach((character, index) => {
    requireText(character.name, `${chunk.id}.characters[${index}].name`);
    assertStringArray(character.aliases, `${chunk.id}.characters[${index}].aliases`);
    assertOptionalString(
      character.description,
      `${chunk.id}.characters[${index}].description`,
    );
    assertRefs(character.sourceRefs, chunk, `${chunk.id}.characters[${index}].sourceRefs`);
  });
  const characterIds = new Set(local.characters.map((character) => character.id));
  const factIndexById = new Map(local.facts.map((fact, index) => [fact.id, index]));
  local.facts.forEach((fact, index) => {
    requireText(fact.kind, `${chunk.id}.facts[${index}].kind`);
    requireText(fact.subjectId, `${chunk.id}.facts[${index}].subjectId`);
    requireText(fact.predicate, `${chunk.id}.facts[${index}].predicate`);
    requireText(fact.value, `${chunk.id}.facts[${index}].value`);
    requireText(fact.statement, `${chunk.id}.facts[${index}].statement`);
    if (!LOCAL_FACT_KINDS.has(fact.kind)) {
      throw new Error(`${chunk.id}.facts[${index}].kind 不在允许范围`);
    }
    if (
      LOCAL_CHARACTER_SUBJECT_FACT_KINDS.has(fact.kind) &&
      !characterIds.has(fact.subjectId)
    ) {
      throw new Error(`${chunk.id}.facts[${index}].subjectId 必须引用本块人物`);
    }
    if (
      fact.kind === "constraint" &&
      !characterIds.has(fact.subjectId) &&
      !globalStorySubjectId(fact)
    ) {
      throw new Error(
        `${chunk.id}.facts[${index}].subjectId 必须引用本块人物或 global:story`,
      );
    }
    assertRefs(fact.sourceRefs, chunk, `${chunk.id}.facts[${index}].sourceRefs`);
    if (fact.status !== "source_fact" && fact.status !== "uncertain") {
      throw new Error(`${chunk.id}.facts[${index}].status 只允许 source_fact 或 uncertain`);
    }
    if (
      fact.perspectiveCharacterId &&
      !characterIds.has(fact.perspectiveCharacterId)
    ) {
      throw new Error(`${chunk.id}.facts[${index}] 引用了未知视角人物`);
    }
    if (fact.supersededByFactId !== undefined) {
      throw new Error(`${chunk.id}.facts[${index}].supersededByFactId 只能由代码写入`);
    }
    if (fact.supersedesFactId) {
      const previousIndex = factIndexById.get(fact.supersedesFactId);
      const previous = previousIndex === undefined ? undefined : local.facts[previousIndex];
      if (
        previousIndex === undefined ||
        previousIndex >= index ||
        !previous ||
        storyFactKey(previous) !== storyFactKey(fact) ||
        firstRefParagraph(previous.sourceRefs) > firstRefParagraph(fact.sourceRefs) ||
        !fact.supersessionReason ||
        !LOCAL_SUPERSESSION_REASONS.has(fact.supersessionReason)
      ) {
        throw new Error(`${chunk.id}.facts[${index}].supersedesFactId 只能指向本块更早的同键事实`);
      }
    } else if (fact.supersessionReason !== undefined) {
      throw new Error(`${chunk.id}.facts[${index}].supersessionReason 缺少 supersedesFactId`);
    }
  });
  local.timelineEvents.forEach((event, index) => {
    requireText(event.summary, `${chunk.id}.timelineEvents[${index}].summary`);
    if (!Number.isInteger(event.order) || event.order < 1) {
      throw new Error(`${chunk.id}.timelineEvents[${index}].order 必须是正整数`);
    }
    assertStringArray(
      event.characterIds,
      `${chunk.id}.timelineEvents[${index}].characterIds`,
    );
    assertRefs(event.sourceRefs, chunk, `${chunk.id}.timelineEvents[${index}].sourceRefs`);
    for (const characterId of event.characterIds) {
      if (!characterIds.has(characterId)) {
        throw new Error(`${chunk.id}.timelineEvents[${index}] 引用了未知人物`);
      }
    }
  });
  local.threadObservations.forEach((thread, index) =>
    {
      requireText(thread.summary, `${chunk.id}.threadObservations[${index}].summary`);
      if (!new Set(["open", "mentioned", "resolved"]).has(thread.action)) {
        throw new Error(`${chunk.id}.threadObservations[${index}].action 无效`);
      }
      assertRefs(thread.sourceRefs, chunk, `${chunk.id}.threadObservations[${index}].sourceRefs`);
    },
  );
  assertBoundary(
    local.entryBoundary,
    chunk,
    chunk.coreRange.start,
    `${chunk.id}.entryBoundary`,
  );
  assertBoundary(
    local.exitBoundary,
    chunk,
    chunk.coreRange.end,
    `${chunk.id}.exitBoundary`,
  );
  for (const [path, boundary] of [
    ["entryBoundary", local.entryBoundary],
    ["exitBoundary", local.exitBoundary],
  ] as const) {
    for (const state of boundary.characters) {
      if (!characterIds.has(state.characterId)) {
        throw new Error(`${chunk.id}.${path} 引用了未知人物：${state.characterId}`);
      }
    }
    for (const object of boundary.objects) {
      if (object.holderCharacterId !== undefined) {
        requireText(
          object.holderCharacterId,
          `${chunk.id}.${path}.objects.holderCharacterId`,
        );
        if (!characterIds.has(object.holderCharacterId)) {
          throw new Error(`${chunk.id}.${path} 引用了未知持有者`);
        }
      }
    }
    for (const reference of boundary.openReferences) {
      if (reference.candidateCharacterIds.some((id) => !characterIds.has(id))) {
        throw new Error(`${chunk.id}.${path} 引用了未知候选人物`);
      }
    }
  }
  return local;
}

function scopedId(chunkId: string, id: string): string {
  return id.startsWith(`${chunkId}::`) ? id : `${chunkId}::${id}`;
}

function globalStorySubjectId(fact: StoryFact): string | undefined {
  if (fact.kind !== "constraint") return undefined;
  const subjectId = normalizeStoryText(fact.subjectId);
  return ["global:story", "story", "novel", "全书", "故事", "小说"].includes(subjectId)
    ? "global:story"
    : undefined;
}

function scopeLocalIds(local: LocalChunkBible): LocalChunkBible {
  const characterIds = new Map(
    local.characters.map((character) => [
      character.id,
      scopedId(local.chunkId, character.id),
    ]),
  );
  const factIds = new Map(
    local.facts.map((fact) => [fact.id, scopedId(local.chunkId, fact.id)]),
  );
  const objectIds = new Map(
    [
      ...local.entryBoundary.objects.map((object) => object.objectId),
      ...local.exitBoundary.objects.map((object) => object.objectId),
      ...local.facts
        .filter((fact) => fact.kind === "object")
        .map((fact) => fact.subjectId),
    ].map((id) => [id, scopedId(local.chunkId, id)]),
  );
  assertUniqueStringIds([...characterIds.values()], `${local.chunkId}.scopedCharacters`);
  assertUniqueStringIds([...factIds.values()], `${local.chunkId}.scopedFacts`);
  assertUniqueStringIds([...objectIds.values()], `${local.chunkId}.scopedObjects`);
  const characterId = (id: string | undefined) =>
    id === undefined ? undefined : characterIds.get(id) ?? id;
  const factSubjectId = (fact: StoryFact) => {
    if (fact.kind === "object") {
      return objectIds.get(fact.subjectId) ?? scopedId(local.chunkId, fact.subjectId);
    }
    return (
      characterIds.get(fact.subjectId) ??
      globalStorySubjectId(fact) ??
      scopedId(local.chunkId, fact.subjectId)
    );
  };
  const factValue = (value: string) => {
    const characterValue = characterIds.get(value);
    const objectValue = objectIds.get(value);
    if (characterValue && objectValue) {
      throw new Error(
        `${local.chunkId}.facts.value 同时引用人物与物品 id：${value}`,
      );
    }
    return characterValue ?? objectValue ?? value;
  };
  const boundary = (state: StoryBoundaryState): StoryBoundaryState => ({
    ...state,
    characters: state.characters.map((character) => ({
      ...character,
      characterId: characterId(character.characterId)!,
      knowledge: [...character.knowledge],
      activeGoals: [...character.activeGoals],
      sourceRefs: mergeRefs(character.sourceRefs),
    })),
    objects: state.objects.map((object) => ({
      ...object,
      objectId: objectIds.get(object.objectId) ?? scopedId(local.chunkId, object.objectId),
      holderCharacterId: characterId(object.holderCharacterId),
      sourceRefs: mergeRefs(object.sourceRefs),
    })),
    openReferences: state.openReferences.map((reference) => ({
      ...reference,
      candidateCharacterIds: reference.candidateCharacterIds.map(
        (id) => characterId(id)!,
      ),
      sourceRef: cloneRef(reference.sourceRef),
    })),
    sourceRefs: mergeRefs(state.sourceRefs),
  });
  const scoped: LocalChunkBible = {
    ...local,
    coreRange: { ...local.coreRange },
    characters: local.characters.map((character) => ({
      ...character,
      id: characterIds.get(character.id)!,
      aliases: [...character.aliases],
      sourceRefs: mergeRefs(character.sourceRefs),
    })),
    facts: local.facts.map((fact) => ({
      ...fact,
      id: factIds.get(fact.id)!,
      subjectId: factSubjectId(fact),
      value: factValue(fact.value),
      perspectiveCharacterId: characterId(fact.perspectiveCharacterId),
      supersedesFactId: fact.supersedesFactId
        ? factIds.get(fact.supersedesFactId) ?? fact.supersedesFactId
        : undefined,
      sourceRefs: mergeRefs(fact.sourceRefs),
    })),
    timelineEvents: local.timelineEvents.map((event) => ({
      ...event,
      id: scopedId(local.chunkId, event.id),
      characterIds: event.characterIds.map((id) => characterId(id)!),
      sourceRefs: mergeRefs(event.sourceRefs),
    })),
    threadObservations: local.threadObservations.map((thread) => ({
      ...thread,
      id: scopedId(local.chunkId, thread.id),
      sourceRefs: mergeRefs(thread.sourceRefs),
    })),
    entryBoundary: boundary(local.entryBoundary),
    exitBoundary: boundary(local.exitBoundary),
  };
  assertUniqueIds(scoped.characters, `${local.chunkId}.scopedCharacters`);
  assertUniqueIds(scoped.facts, `${local.chunkId}.scopedFacts`);
  assertUniqueIds(scoped.timelineEvents, `${local.chunkId}.scopedTimelineEvents`);
  assertUniqueIds(scoped.threadObservations, `${local.chunkId}.scopedThreads`);
  for (const [path, state] of [
    ["entryBoundary", scoped.entryBoundary],
    ["exitBoundary", scoped.exitBoundary],
  ] as const) {
    assertUniqueStringIds(
      state.characters.map((character) => character.characterId),
      `${local.chunkId}.${path}.scopedCharacters`,
    );
    assertUniqueStringIds(
      state.objects.map((object) => object.objectId),
      `${local.chunkId}.${path}.scopedObjects`,
    );
  }
  return scoped;
}

function buildLocalMessages(
  chunkedNovel: ChunkedNovel,
  chunk: NovelChunk,
): ChatMessage[] {
  const chapterAt = (paragraph: number) =>
    chunk.chapterRanges.find(
      (range) =>
        paragraph >= range.paragraphRange.start &&
        paragraph <= range.paragraphRange.end,
    )?.chapterId ?? chunk.chapterIds[0];
  const sourceRef = (paragraph: number) =>
    `{"chapterId":"${chapterAt(paragraph)}","chunkId":"${chunk.id}","paragraphRange":{"start":${paragraph},"end":${paragraph}}}`;
  const entryRef = sourceRef(chunk.coreRange.start);
  const exitRef = sourceRef(chunk.coreRange.end);
  const system = `你是小说局部事实提取器。各文本块并行理解，不能假设自己已看过其他块。
overlap 只用于理解衔接，characters/facts/timelineEvents/threadObservations 及两个 boundary 的出处都必须落在当前 core。
局部 id 只需在本块唯一；系统会在汇总前加 chunk scope。entryBoundary 描述 core 起点可观察状态，exitBoundary 描述 core 结尾状态。
字段契约：
- sourceRef 必须是 ${entryRef} 这种结构，chapterId 必须与段号所在的允许章节一致。
- characters 每项：{id,name,aliases:string[],description?,sourceRefs:sourceRef[]}。
- facts 每项：{id,kind,subjectId,predicate,value,statement,status,sourceRefs}；kind 只允许 character/relationship/timeline/location/object/knowledge/constraint，status 只允许 source_fact/uncertain。除 kind=object 与全书 constraint 外，subjectId 必须使用本块 characters 中的 id；物品事实使用本块物品 id；只有适用于整本小说的 constraint 事实使用固定 subjectId "global:story"。本块内明确状态变化才可增加 supersedesFactId + supersessionReason(state_change/correction/reveal)，且只能指向数组中更早的同键事实。
- timelineEvents 每项：{id,summary,order,characterIds,sourceRefs}。
- threadObservations 每项：{id,summary,action:"open|mentioned|resolved",sourceRefs}；同一伏笔尽量使用稳定、具体的 summary。
- boundary.characters 每项：{characterId,location?,physicalState?,knowledge:string[],activeGoals:string[],sourceRefs}。
- boundary.objects 每项：{objectId,holderCharacterId?,location?,state?,sourceRefs}。
- boundary.openReferences 每项：{text,candidateCharacterIds:string[],sourceRef}。
只输出 JSON，数组不得省略：
{"chunkId":"${chunk.id}","coreRange":{"start":${chunk.coreRange.start},"end":${chunk.coreRange.end}},"characters":[],"facts":[],"timelineEvents":[],"threadObservations":[],"entryBoundary":{"chunkId":"${chunk.id}","asOfParagraph":${chunk.coreRange.start},"location":"","characters":[],"objects":[],"openReferences":[],"sourceRefs":[${entryRef}]},"exitBoundary":{"chunkId":"${chunk.id}","asOfParagraph":${chunk.coreRange.end},"location":"","characters":[],"objects":[],"openReferences":[],"sourceRefs":[${exitRef}]}}`;
  return [
    { role: "system", content: system },
    {
      role: "user",
      content: `允许的章节范围：${JSON.stringify(chunk.chapterRanges)}\n${renderNovelChunk(chunkedNovel.paragraphs, chunk)}`,
    },
  ];
}

interface ScopedObjectCandidate {
  id: string;
  holderCharacterIds: string[];
  locations: string[];
  states: string[];
  sourceRefs: StorySourceRef[];
}

interface IdentityCandidates {
  characters: StoryCharacter[];
  objects: ScopedObjectCandidate[];
  threads: LocalThreadObservation[];
}

const MAX_IDENTITY_CANDIDATES_PER_CALL = 100;
const MAX_IDENTITY_MESSAGE_CHARS = 120_000;
const MAX_IDENTITY_EVIDENCE_REFS = 3;
const MAX_IDENTITY_EVIDENCE_CHARS = 600;
const MAX_BOUNDARY_ISSUES_PER_CALL = 40;
const MAX_BOUNDARY_MESSAGE_CHARS = 120_000;

function collectObjectCandidates(locals: LocalChunkBible[]): ScopedObjectCandidate[] {
  const objects = new Map<string, ScopedObjectCandidate>();
  for (const state of locals.flatMap((local) => [
    ...local.entryBoundary.objects,
    ...local.exitBoundary.objects,
  ])) {
    const existing = objects.get(state.objectId) ?? {
      id: state.objectId,
      holderCharacterIds: [],
      locations: [],
      states: [],
      sourceRefs: [],
    };
    if (state.holderCharacterId) existing.holderCharacterIds.push(state.holderCharacterId);
    if (state.location) existing.locations.push(state.location);
    if (state.state) existing.states.push(state.state);
    existing.sourceRefs = mergeRefs(existing.sourceRefs, state.sourceRefs);
    objects.set(state.objectId, existing);
  }
  for (const fact of locals.flatMap((local) => local.facts)) {
    if (fact.kind !== "object") continue;
    const existing = objects.get(fact.subjectId) ?? {
      id: fact.subjectId,
      holderCharacterIds: [],
      locations: [],
      states: [],
      sourceRefs: [],
    };
    const predicate = normalizeStoryText(fact.predicate);
    if (predicate.includes("location") || predicate.includes("位置")) {
      existing.locations.push(fact.value);
    } else if (predicate.includes("holder") || predicate.includes("持有")) {
      existing.holderCharacterIds.push(fact.value);
    } else {
      existing.states.push(`${fact.predicate}:${fact.value}`);
    }
    existing.sourceRefs = mergeRefs(existing.sourceRefs, fact.sourceRefs);
    objects.set(fact.subjectId, existing);
  }
  return [...objects.values()]
    .map((object) => ({
      ...object,
      holderCharacterIds: [...new Set(object.holderCharacterIds)].sort(),
      locations: [...new Set(object.locations)].sort(),
      states: [...new Set(object.states)].sort(),
    }))
    .sort(
      (left, right) =>
        firstRefParagraph(left.sourceRefs) - firstRefParagraph(right.sourceRefs) ||
        left.id.localeCompare(right.id),
    );
}

function collectIdentityCandidates(locals: LocalChunkBible[]): IdentityCandidates {
  return {
    characters: locals.flatMap((local) => local.characters),
    objects: collectObjectCandidates(locals),
    threads: locals.flatMap((local) => local.threadObservations),
  };
}

function selectIdentityEvidenceRefs(refs: StorySourceRef[]): StorySourceRef[] {
  if (refs.length <= MAX_IDENTITY_EVIDENCE_REFS) return refs;
  const indices = [0, Math.floor((refs.length - 1) / 2), refs.length - 1];
  return [...new Set(indices)].map((index) => refs[index]);
}

function identityEvidenceSnippets(
  refs: StorySourceRef[],
  paragraphTextByNumber: Map<number, string>,
) {
  let remaining = MAX_IDENTITY_EVIDENCE_CHARS;
  return selectIdentityEvidenceRefs(refs).map((ref) => {
    let text = "";
    for (
      let paragraph = ref.paragraphRange.start;
      paragraph <= ref.paragraphRange.end && text.length < remaining;
      paragraph++
    ) {
      const sourceText = paragraphTextByNumber.get(paragraph);
      if (sourceText === undefined) continue;
      text += `${text ? "\n" : ""}¶${paragraph} ${sourceText}`;
    }
    const snippet = text.slice(0, remaining);
    remaining -= snippet.length;
    return { sourceRef: cloneRef(ref), text: snippet };
  });
}

function clippedText(value: string | undefined, maxChars: number) {
  return value === undefined ? undefined : value.slice(0, maxChars);
}

function buildIdentityMessages(
  candidates: IdentityCandidates,
  chunkedNovel: ChunkedNovel,
): ChatMessage[] {
  const paragraphTextByNumber = new Map(
    chunkedNovel.paragraphs.map((paragraph) => [paragraph.n, paragraph.text]),
  );
  const characters = candidates.characters.map((character) => ({
      id: character.id,
      name: clippedText(character.name, 200),
      aliases: character.aliases.slice(0, 20).map((alias) => alias.slice(0, 100)),
      description: clippedText(character.description, 500),
      sourceRefs: selectIdentityEvidenceRefs(character.sourceRefs),
      sourceSnippets: identityEvidenceSnippets(
        character.sourceRefs,
        paragraphTextByNumber,
      ),
    }));
  const objects = candidates.objects.map((object) => ({
    ...object,
    holderCharacterIds: object.holderCharacterIds.slice(0, 20),
    locations: object.locations.slice(0, 20).map((value) => value.slice(0, 100)),
    states: object.states.slice(0, 20).map((value) => value.slice(0, 100)),
    sourceRefs: selectIdentityEvidenceRefs(object.sourceRefs),
    sourceSnippets: identityEvidenceSnippets(object.sourceRefs, paragraphTextByNumber),
  }));
  const threads = candidates.threads.map((thread) => ({
      id: thread.id,
      summary: thread.summary.slice(0, 500),
      action: thread.action,
      sourceRefs: selectIdentityEvidenceRefs(thread.sourceRefs),
      sourceSnippets: identityEvidenceSnippets(
        thread.sourceRefs,
        paragraphTextByNumber,
      ),
    }));
  return [
    {
      role: "system",
      content: `你只负责全书人物、物品身份和伏笔线索归一，不得重写事实。characters、objects、threads 三类中的每个输入 id 都必须在各自分组中恰好出现一次；应根据 sourceSnippets 判断近义表述是否指向同一实体或同一伏笔。无法确定时 decision=uncertain，系统会保留为独立项。只输出 JSON：{"groups":[{"memberIds":[],"canonicalName":"","aliases":[],"decision":"same|uncertain"}],"objectGroups":[{"memberIds":[],"canonicalName":"","decision":"same|uncertain"}],"threadGroups":[{"memberIds":[],"canonicalSummary":"","decision":"same|uncertain"}]}`,
    },
    {
      role: "user",
      content: JSON.stringify({ characters, objects, threads }),
    },
  ];
}

function parseIdentityPlan(
  raw: string,
  candidates: IdentityCandidates,
): IdentityPlan {
  const value = parseObject(raw, "人物归一");
  if (!Array.isArray(value.groups)) throw new Error("人物归一 groups 必须是数组");
  const characterById = new Map(
    candidates.characters.map((character) => [character.id, character] as const),
  );
  const seen = new Set<string>();
  const groups: IdentityGroupOutput[] = value.groups.map((rawGroup, index) => {
    if (!isObject(rawGroup)) throw new Error(`groups[${index}] 必须是对象`);
    const memberIds = rawGroup.memberIds;
    if (
      !Array.isArray(memberIds) ||
      memberIds.length === 0 ||
      memberIds.some((id) => typeof id !== "string")
    ) {
      throw new Error(`groups[${index}].memberIds 不能为空`);
    }
    for (const id of memberIds as string[]) {
      if (!characterById.has(id)) throw new Error(`人物归一引用了未知成员：${id}`);
      if (seen.has(id)) throw new Error(`人物归一重复使用成员：${id}`);
      seen.add(id);
    }
    if (typeof rawGroup.canonicalName !== "string" || !rawGroup.canonicalName.trim()) {
      throw new Error(`groups[${index}].canonicalName 不能为空`);
    }
    if (
      !Array.isArray(rawGroup.aliases) ||
      rawGroup.aliases.some((alias) => typeof alias !== "string")
    ) {
      throw new Error(`groups[${index}].aliases 必须是字符串数组`);
    }
    if (rawGroup.decision !== "same" && rawGroup.decision !== "uncertain") {
      throw new Error(`groups[${index}].decision 无效`);
    }
    return {
      memberIds: [...(memberIds as string[])],
      canonicalName: rawGroup.canonicalName,
      aliases: [...(rawGroup.aliases as string[])],
      decision: rawGroup.decision,
    };
  });
  const missing = [...characterById.keys()].filter((id) => !seen.has(id));
  if (missing.length > 0) throw new Error(`人物归一遗漏成员：${missing.join("、")}`);

  const provisional = groups.flatMap((group) =>
    group.decision === "same"
      ? [group]
      : group.memberIds.map((memberId) => ({
          memberIds: [memberId],
          canonicalName: characterById.get(memberId)!.name,
          aliases: characterById.get(memberId)!.aliases,
          decision: "uncertain" as const,
        })),
  );
  provisional.sort((left, right) => {
    const leftParagraph = Math.min(
      ...left.memberIds.map((id) => firstRefParagraph(characterById.get(id)!.sourceRefs)),
    );
    const rightParagraph = Math.min(
      ...right.memberIds.map((id) => firstRefParagraph(characterById.get(id)!.sourceRefs)),
    );
    return leftParagraph - rightParagraph || left.memberIds[0].localeCompare(right.memberIds[0]);
  });
  const objectById = new Map(
    candidates.objects.map((object) => [object.id, object]),
  );
  if (objectById.size > 0 && value.objectGroups === undefined) {
    throw new Error("物品归一缺少 objectGroups 完整分区");
  }
  const seenObjects = new Set<string>();
  const objectGroups: Array<{
    memberIds: string[];
    canonicalName: string;
    decision: "same" | "uncertain";
  }> = value.objectGroups === undefined
    ? []
    : (() => {
        if (!Array.isArray(value.objectGroups)) {
          throw new Error("物品归一 objectGroups 必须是数组");
        }
        return value.objectGroups.map((rawGroup, index) => {
          if (!isObject(rawGroup)) throw new Error(`objectGroups[${index}] 必须是对象`);
          if (
            !Array.isArray(rawGroup.memberIds) ||
            rawGroup.memberIds.length === 0 ||
            rawGroup.memberIds.some((id) => typeof id !== "string")
          ) {
            throw new Error(`objectGroups[${index}].memberIds 不能为空`);
          }
          for (const id of rawGroup.memberIds as string[]) {
            if (!objectById.has(id)) throw new Error(`物品归一引用了未知成员：${id}`);
            if (seenObjects.has(id)) throw new Error(`物品归一重复使用成员：${id}`);
            seenObjects.add(id);
          }
          if (typeof rawGroup.canonicalName !== "string" || !rawGroup.canonicalName.trim()) {
            throw new Error(`objectGroups[${index}].canonicalName 不能为空`);
          }
          if (rawGroup.decision !== "same" && rawGroup.decision !== "uncertain") {
            throw new Error(`objectGroups[${index}].decision 无效`);
          }
          return {
            memberIds: [...(rawGroup.memberIds as string[])],
            canonicalName: rawGroup.canonicalName,
            decision: rawGroup.decision,
          };
        });
      })();
  if (value.objectGroups !== undefined) {
    const missingObjects = [...objectById.keys()].filter((id) => !seenObjects.has(id));
    if (missingObjects.length > 0) {
      throw new Error(`物品归一遗漏成员：${missingObjects.join("、")}`);
    }
  }
  const provisionalObjects = objectGroups.flatMap((group) =>
    group.decision === "same"
      ? [group]
      : group.memberIds.map((memberId) => ({
          memberIds: [memberId],
          canonicalName: objectById.get(memberId)!.id,
          decision: "uncertain" as const,
        })),
  );
  provisionalObjects.sort((left, right) => {
    const leftParagraph = Math.min(
      ...left.memberIds.map((id) => firstRefParagraph(objectById.get(id)!.sourceRefs)),
    );
    const rightParagraph = Math.min(
      ...right.memberIds.map((id) => firstRefParagraph(objectById.get(id)!.sourceRefs)),
    );
    return leftParagraph - rightParagraph || left.memberIds[0].localeCompare(right.memberIds[0]);
  });

  const threadById = new Map(
    candidates.threads.map((thread) => [thread.id, thread] as const),
  );
  if (threadById.size > 0 && value.threadGroups === undefined) {
    throw new Error("伏笔归一缺少 threadGroups 完整分区");
  }
  const seenThreads = new Set<string>();
  const threadGroups: Array<{
    memberIds: string[];
    canonicalSummary: string;
    decision: "same" | "uncertain";
  }> = value.threadGroups === undefined
    ? []
    : (() => {
        if (!Array.isArray(value.threadGroups)) {
          throw new Error("伏笔归一 threadGroups 必须是数组");
        }
        return value.threadGroups.map((rawGroup, index) => {
          if (!isObject(rawGroup)) throw new Error(`threadGroups[${index}] 必须是对象`);
          if (
            !Array.isArray(rawGroup.memberIds) ||
            rawGroup.memberIds.length === 0 ||
            rawGroup.memberIds.some((id) => typeof id !== "string")
          ) {
            throw new Error(`threadGroups[${index}].memberIds 不能为空`);
          }
          for (const id of rawGroup.memberIds as string[]) {
            if (!threadById.has(id)) throw new Error(`伏笔归一引用了未知成员：${id}`);
            if (seenThreads.has(id)) throw new Error(`伏笔归一重复使用成员：${id}`);
            seenThreads.add(id);
          }
          if (
            typeof rawGroup.canonicalSummary !== "string" ||
            !rawGroup.canonicalSummary.trim()
          ) {
            throw new Error(`threadGroups[${index}].canonicalSummary 不能为空`);
          }
          if (rawGroup.decision !== "same" && rawGroup.decision !== "uncertain") {
            throw new Error(`threadGroups[${index}].decision 无效`);
          }
          return {
            memberIds: [...(rawGroup.memberIds as string[])],
            canonicalSummary: rawGroup.canonicalSummary,
            decision: rawGroup.decision,
          };
        });
      })();
  if (value.threadGroups !== undefined) {
    const missingThreads = [...threadById.keys()].filter((id) => !seenThreads.has(id));
    if (missingThreads.length > 0) {
      throw new Error(`伏笔归一遗漏成员：${missingThreads.join("、")}`);
    }
  }
  const provisionalThreads = threadGroups.flatMap((group) =>
    group.decision === "same"
      ? [group]
      : group.memberIds.map((memberId) => ({
          memberIds: [memberId],
          canonicalSummary: threadById.get(memberId)!.summary,
          decision: "uncertain" as const,
        })),
  );
  provisionalThreads.sort((left, right) => {
    const leftParagraph = Math.min(
      ...left.memberIds.map((id) => firstRefParagraph(threadById.get(id)!.sourceRefs)),
    );
    const rightParagraph = Math.min(
      ...right.memberIds.map((id) => firstRefParagraph(threadById.get(id)!.sourceRefs)),
    );
    return leftParagraph - rightParagraph || left.memberIds[0].localeCompare(right.memberIds[0]);
  });
  return {
    assignments: provisional.map((group, index) => ({
      ...group,
      canonicalId: `char_${String(index + 1).padStart(4, "0")}`,
    })),
    uncertainGroups: groups
      .filter((group) => group.decision === "uncertain" && group.memberIds.length > 1)
      .map((group) => [...group.memberIds]),
    objectAssignments: provisionalObjects.map((group, index) => ({
      ...group,
      canonicalId: `object_${String(index + 1).padStart(4, "0")}`,
    })),
    uncertainObjectGroups: objectGroups
      .filter((group) => group.decision === "uncertain" && group.memberIds.length > 1)
      .map((group) => [...group.memberIds]),
    threadAssignments: provisionalThreads.map((group, index) => ({
      ...group,
      canonicalId: `thread_${String(index + 1).padStart(4, "0")}`,
    })),
    uncertainThreadGroups: threadGroups
      .filter((group) => group.decision === "uncertain" && group.memberIds.length > 1)
      .map((group) => [...group.memberIds]),
  };
}

type IdentityCandidateUnit =
  | { kind: "character"; value: StoryCharacter }
  | { kind: "object"; value: ScopedObjectCandidate }
  | { kind: "thread"; value: LocalThreadObservation };

function identityPageFromUnits(units: IdentityCandidateUnit[]): IdentityCandidates {
  return {
    characters: units.flatMap((unit) => unit.kind === "character" ? [unit.value] : []),
    objects: units.flatMap((unit) => unit.kind === "object" ? [unit.value] : []),
    threads: units.flatMap((unit) => unit.kind === "thread" ? [unit.value] : []),
  };
}

function identityMessageChars(messages: ChatMessage[]) {
  return messages.reduce((total, message) => total + message.content.length, 0);
}

function buildIdentityPages(
  candidates: IdentityCandidates,
  chunkedNovel: ChunkedNovel,
): IdentityCandidates[] {
  const units: IdentityCandidateUnit[] = [
    ...candidates.characters.map((value) => ({ kind: "character" as const, value })),
    ...candidates.objects.map((value) => ({ kind: "object" as const, value })),
    ...candidates.threads.map((value) => ({ kind: "thread" as const, value })),
  ];
  const fit = (pageUnits: IdentityCandidateUnit[]): IdentityCandidates[] => {
    const page = identityPageFromUnits(pageUnits);
    const chars = identityMessageChars(buildIdentityMessages(page, chunkedNovel));
    if (chars <= MAX_IDENTITY_MESSAGE_CHARS) return [page];
    if (pageUnits.length === 1) {
      throw new Error(`identity 候选 ${pageUnits[0].value.id} 单项超过字符预算`);
    }
    const middle = Math.ceil(pageUnits.length / 2);
    return [
      ...fit(pageUnits.slice(0, middle)),
      ...fit(pageUnits.slice(middle)),
    ];
  };
  const pages: IdentityCandidates[] = [];
  for (let index = 0; index < units.length; index += MAX_IDENTITY_CANDIDATES_PER_CALL) {
    pages.push(...fit(units.slice(index, index + MAX_IDENTITY_CANDIDATES_PER_CALL)));
  }
  return pages;
}

function mergeIdentityPlans(
  plans: IdentityPlan[],
  candidates: IdentityCandidates,
): IdentityPlan {
  const characters = new Map(candidates.characters.map((item) => [item.id, item]));
  const objects = new Map(candidates.objects.map((item) => [item.id, item]));
  const threads = new Map(candidates.threads.map((item) => [item.id, item]));
  const assignments = plans.flatMap((plan) => plan.assignments);
  assignments.sort((left, right) =>
    Math.min(...left.memberIds.map((id) => firstRefParagraph(characters.get(id)!.sourceRefs))) -
      Math.min(...right.memberIds.map((id) => firstRefParagraph(characters.get(id)!.sourceRefs))) ||
    left.memberIds[0].localeCompare(right.memberIds[0]),
  );
  const objectAssignments = plans.flatMap((plan) => plan.objectAssignments);
  objectAssignments.sort((left, right) =>
    Math.min(...left.memberIds.map((id) => firstRefParagraph(objects.get(id)!.sourceRefs))) -
      Math.min(...right.memberIds.map((id) => firstRefParagraph(objects.get(id)!.sourceRefs))) ||
    left.memberIds[0].localeCompare(right.memberIds[0]),
  );
  const threadAssignments = plans.flatMap((plan) => plan.threadAssignments);
  threadAssignments.sort((left, right) =>
    Math.min(...left.memberIds.map((id) => firstRefParagraph(threads.get(id)!.sourceRefs))) -
      Math.min(...right.memberIds.map((id) => firstRefParagraph(threads.get(id)!.sourceRefs))) ||
    left.memberIds[0].localeCompare(right.memberIds[0]),
  );
  return {
    assignments: assignments.map((assignment, index) => ({
      ...assignment,
      canonicalId: `char_${String(index + 1).padStart(4, "0")}`,
    })),
    uncertainGroups: plans.flatMap((plan) => plan.uncertainGroups),
    objectAssignments: objectAssignments.map((assignment, index) => ({
      ...assignment,
      canonicalId: `object_${String(index + 1).padStart(4, "0")}`,
    })),
    uncertainObjectGroups: plans.flatMap((plan) => plan.uncertainObjectGroups),
    threadAssignments: threadAssignments.map((assignment, index) => ({
      ...assignment,
      canonicalId: `thread_${String(index + 1).padStart(4, "0")}`,
    })),
    uncertainThreadGroups: plans.flatMap((plan) => plan.uncertainThreadGroups),
  };
}

function identityMap(plan: IdentityPlan): Map<string, string> {
  return new Map(
    plan.assignments.flatMap((assignment) =>
      assignment.memberIds.map((memberId) => [memberId, assignment.canonicalId] as const),
    ),
  );
}

function objectIdentityMap(plan: IdentityPlan): Map<string, string> {
  return new Map(
    plan.objectAssignments.flatMap((assignment) =>
      assignment.memberIds.map((memberId) => [memberId, assignment.canonicalId] as const),
    ),
  );
}

function mergeBoundaryScalar(
  left: string | undefined,
  right: string | undefined,
  path: string,
): string | undefined {
  if (!left) return right;
  if (!right) return left;
  if (normalizeStoryText(left) !== normalizeStoryText(right)) {
    throw new Error(`${path} 在 identity 归一后出现矛盾：${left} / ${right}`);
  }
  return [left, right].sort((a, b) => a.localeCompare(b))[0];
}

function mergeBoundaryStrings(...groups: string[][]): string[] {
  const values = new Map<string, string>();
  for (const value of groups.flat()) {
    const key = normalizeStoryText(value);
    const existing = values.get(key);
    if (!existing || value.localeCompare(existing) < 0) values.set(key, value);
  }
  return [...values.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, value]) => value);
}

function rewriteBoundary(
  boundary: StoryBoundaryState,
  ids: Map<string, string>,
  objectIds: Map<string, string>,
): StoryBoundaryState {
  const characterId = (id: string | undefined) =>
    id === undefined ? undefined : ids.get(id) ?? id;
  const characters = new Map<string, BoundaryCharacterState>();
  for (const rawCharacter of boundary.characters) {
    const canonicalId = characterId(rawCharacter.characterId)!;
    const character: BoundaryCharacterState = {
      ...rawCharacter,
      characterId: canonicalId,
      knowledge: mergeBoundaryStrings(rawCharacter.knowledge),
      activeGoals: mergeBoundaryStrings(rawCharacter.activeGoals),
      sourceRefs: mergeRefs(rawCharacter.sourceRefs),
    };
    const existing = characters.get(canonicalId);
    if (!existing) {
      characters.set(canonicalId, character);
      continue;
    }
    characters.set(canonicalId, {
      characterId: canonicalId,
      location: mergeBoundaryScalar(
        existing.location,
        character.location,
        `${boundary.chunkId}.characters.${canonicalId}.location`,
      ),
      physicalState: mergeBoundaryScalar(
        existing.physicalState,
        character.physicalState,
        `${boundary.chunkId}.characters.${canonicalId}.physicalState`,
      ),
      knowledge: mergeBoundaryStrings(existing.knowledge, character.knowledge),
      activeGoals: mergeBoundaryStrings(existing.activeGoals, character.activeGoals),
      sourceRefs: mergeRefs(existing.sourceRefs, character.sourceRefs),
    });
  }
  const objects = new Map<string, BoundaryObjectState>();
  for (const rawObject of boundary.objects) {
    const canonicalId = objectIds.get(rawObject.objectId) ?? rawObject.objectId;
    const object: BoundaryObjectState = {
      ...rawObject,
      objectId: canonicalId,
      holderCharacterId: characterId(rawObject.holderCharacterId),
      sourceRefs: mergeRefs(rawObject.sourceRefs),
    };
    const existing = objects.get(canonicalId);
    if (!existing) {
      objects.set(canonicalId, object);
      continue;
    }
    objects.set(canonicalId, {
      objectId: canonicalId,
      holderCharacterId: mergeBoundaryScalar(
        existing.holderCharacterId,
        object.holderCharacterId,
        `${boundary.chunkId}.objects.${canonicalId}.holderCharacterId`,
      ),
      location: mergeBoundaryScalar(
        existing.location,
        object.location,
        `${boundary.chunkId}.objects.${canonicalId}.location`,
      ),
      state: mergeBoundaryScalar(
        existing.state,
        object.state,
        `${boundary.chunkId}.objects.${canonicalId}.state`,
      ),
      sourceRefs: mergeRefs(existing.sourceRefs, object.sourceRefs),
    });
  }
  return {
    ...boundary,
    characters: [...characters.values()].sort((left, right) =>
      left.characterId.localeCompare(right.characterId),
    ),
    objects: [...objects.values()].sort((left, right) =>
      left.objectId.localeCompare(right.objectId),
    ),
    openReferences: boundary.openReferences.map((reference) => ({
      ...reference,
      candidateCharacterIds: [...new Set(reference.candidateCharacterIds.map(
        (id) => characterId(id)!,
      ))].sort(),
      sourceRef: cloneRef(reference.sourceRef),
    })),
    sourceRefs: mergeRefs(boundary.sourceRefs),
  };
}

function buildCharacters(
  locals: LocalChunkBible[],
  plan: IdentityPlan,
): StoryCharacter[] {
  const characters = new Map(
    locals.flatMap((local) => local.characters.map((character) => [character.id, character] as const)),
  );
  return plan.assignments.map((assignment) => {
    const members = assignment.memberIds.map((id) => characters.get(id)!);
    const aliases = new Set([
      ...assignment.aliases,
      ...members.flatMap((member) => [member.name, ...member.aliases]),
    ]);
    aliases.delete(assignment.canonicalName);
    return {
      id: assignment.canonicalId,
      name: assignment.canonicalName,
      aliases: [...aliases].sort(),
      description: members.find((member) => member.description)?.description,
      identityStatus:
        assignment.decision === "uncertain" ? "provisional" : "confirmed",
      sourceRefs: mergeRefs(...members.map((member) => member.sourceRefs)),
    };
  });
}

function rewriteFact(
  fact: StoryFact,
  ids: Map<string, string>,
  objectIds: Map<string, string>,
): StoryFact {
  const subjectId = fact.kind === "object"
    ? objectIds.get(fact.subjectId) ?? fact.subjectId
    : ids.get(fact.subjectId) ?? fact.subjectId;
  const characterValue = ids.get(fact.value);
  const objectValue = objectIds.get(fact.value);
  if (characterValue && objectValue && characterValue !== objectValue) {
    throw new Error(`事实 ${fact.id}.value 同时命中人物与物品 identity：${fact.value}`);
  }
  return {
    ...fact,
    subjectId,
    value: characterValue ?? objectValue ?? fact.value,
    perspectiveCharacterId: fact.perspectiveCharacterId
      ? ids.get(fact.perspectiveCharacterId) ?? fact.perspectiveCharacterId
      : undefined,
    sourceRefs: mergeRefs(fact.sourceRefs),
  };
}

function reduceFacts(
  locals: LocalChunkBible[],
  ids: Map<string, string>,
  objectIds: Map<string, string>,
): { facts: StoryFact[]; conflicts: StoryConflict[] } {
  const incoming = locals
    .flatMap((local, localIndex) =>
      local.facts.map((fact, factIndex) => ({
        fact: rewriteFact(fact, ids, objectIds),
        localIndex,
        factIndex,
      })),
    )
    .sort(
      (left, right) =>
        firstRefParagraph(left.fact.sourceRefs) - firstRefParagraph(right.fact.sourceRefs) ||
        left.localIndex - right.localIndex ||
        left.factIndex - right.factIndex ||
        left.fact.id.localeCompare(right.fact.id),
    );
  const facts: StoryFact[] = [];
  const conflicts: StoryConflict[] = [];
  const lastObservedByKey = new Map<string, StoryFact>();
  const factIdAliases = new Map<string, string>();
  const resolveFactId = (id: string) => {
    let current = id;
    const visited = new Set<string>();
    while (factIdAliases.has(current) && !visited.has(current)) {
      visited.add(current);
      current = factIdAliases.get(current)!;
    }
    return current;
  };
  for (const item of incoming) {
    const fact: StoryFact = item.fact.supersedesFactId
      ? {
          ...item.fact,
          supersedesFactId: resolveFactId(item.fact.supersedesFactId),
        }
      : item.fact;
    const key = storyFactKey(fact);
    const previousObserved = lastObservedByKey.get(key);
    if (!previousObserved) {
      const accepted = { ...fact, sourceRefs: mergeRefs(fact.sourceRefs) };
      facts.push(accepted);
      lastObservedByKey.set(key, accepted);
      continue;
    }
    if (sameStoryFactValue(previousObserved, fact)) {
      factIdAliases.set(fact.id, resolveFactId(previousObserved.id));
      previousObserved.sourceRefs = mergeRefs(previousObserved.sourceRefs, fact.sourceRefs);
      if (previousObserved.status === "uncertain" && fact.status === "source_fact") {
        previousObserved.status = "source_fact";
        previousObserved.statement = fact.statement;
      }
      const owningConflict = conflicts.find(
        (conflict) => conflict.incomingFact?.id === previousObserved.id,
      );
      if (owningConflict) {
        owningConflict.sourceRefs = mergeRefs(
          owningConflict.sourceRefs,
          fact.sourceRefs,
        );
      }
      continue;
    }
    const previousAccepted = facts.find(
      (existing) => existing.id === previousObserved.id,
    );
    if (fact.supersedesFactId === previousObserved.id && previousAccepted) {
      previousAccepted.supersededByFactId = fact.id;
      const accepted = { ...fact, sourceRefs: mergeRefs(fact.sourceRefs) };
      facts.push(accepted);
      lastObservedByKey.set(key, accepted);
      continue;
    }
    const incomingFact = { ...fact, sourceRefs: mergeRefs(fact.sourceRefs) };
    const conflict: StoryConflict = {
      id: `conflict_fact_${String(conflicts.length + 1).padStart(3, "0")}`,
      type: "fact_value",
      description: `「${fact.subjectId}.${fact.predicate}」出现不同取值，未按并发完成顺序覆盖。`,
      status: "open",
      existingFactId: previousObserved.id,
      incomingFact,
      sourceRefs: mergeRefs(previousObserved.sourceRefs, fact.sourceRefs),
    };
    conflicts.push(conflict);
    lastObservedByKey.set(key, incomingFact);
  }
  return { facts, conflicts };
}

function boundaryFactPredicate(issue: BoundaryIssue): string | undefined {
  if (issue.entityType === "character" && issue.field === "location") {
    return "current_location";
  }
  if (issue.entityType === "character" && issue.field === "physicalState") {
    return "physical_state";
  }
  if (issue.entityType === "object" && issue.field === "holderCharacterId") {
    return "holder";
  }
  if (issue.entityType === "object" && issue.field === "location") {
    return "current_location";
  }
  if (issue.entityType === "object" && issue.field === "state") return "state";
  if (issue.entityType === "character" && issue.field === "knowledge") {
    return "__knowledge__";
  }
  if (issue.entityType === "character" && issue.field === "activeGoals") {
    return "__active_goals__";
  }
  return undefined;
}

function factPredicate(fact: StoryFact): string {
  return storyFactKey(fact).split(":")[2] ?? "";
}

function factMatchesBoundaryField(fact: StoryFact, predicate: string): boolean {
  const normalizedPredicate = factPredicate(fact);
  // knowledge/activeGoals 是自由文本集合，不能用英文谓词关键词猜测。
  // 这两类只依赖 repair 显式回传并通过校验的 factTransitions id。
  if (predicate.startsWith("__")) return true;
  return normalizedPredicate === predicate;
}

function parseBoundaryStringList(value: string): string[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) && parsed.every((item) => typeof item === "string")
      ? parsed
      : [];
  } catch {
    return [];
  }
}

function factTransitionSemanticallyMatches(
  issue: BoundaryIssue,
  existing: StoryFact,
  incoming: StoryFact,
): boolean {
  if (
    normalizeStoryText(existing.subjectId) !== normalizeStoryText(issue.entityId) ||
    normalizeStoryText(incoming.subjectId) !== normalizeStoryText(issue.entityId) ||
    storyFactKey(existing) !== storyFactKey(incoming)
  ) {
    return false;
  }
  const predicate = boundaryFactPredicate(issue);
  if (!predicate) return false;
  if (predicate === "__knowledge__") {
    if (existing.kind !== "knowledge" || incoming.kind !== "knowledge") return false;
    const left = parseBoundaryStringList(issue.leftValue).map(normalizeStoryText);
    const right = parseBoundaryStringList(issue.rightValue).map(normalizeStoryText);
    const changedTerms = [...new Set([
      ...left.filter((item) => !right.includes(item)),
      ...right.filter((item) => !left.includes(item)),
    ])].filter((item) => item.length >= 2);
    const factText = normalizeStoryText([
      existing.predicate,
      existing.value,
      existing.statement,
      incoming.predicate,
      incoming.value,
      incoming.statement,
    ].join(" "));
    return changedTerms.some((term) => factText.includes(term));
  }
  if (predicate === "__active_goals__") {
    if (
      !new Set(["constraint", "character"]).has(existing.kind) ||
      !new Set(["constraint", "character"]).has(incoming.kind)
    ) {
      return false;
    }
    const leftGoals = parseBoundaryStringList(issue.leftValue).map(normalizeStoryText);
    const rightGoals = parseBoundaryStringList(issue.rightValue).map(normalizeStoryText);
    return (
      leftGoals.includes(normalizeStoryText(existing.value)) &&
      rightGoals.includes(normalizeStoryText(incoming.value)) &&
      normalizeStoryText(existing.value) !== normalizeStoryText(incoming.value)
    );
  }
  return (
    factMatchesBoundaryField(existing, predicate) &&
    factMatchesBoundaryField(incoming, predicate) &&
    normalizeStoryText(existing.value) === normalizeStoryText(issue.leftValue) &&
    normalizeStoryText(incoming.value) === normalizeStoryText(issue.rightValue)
  );
}

function conflictExistingFact(
  conflict: StoryConflict,
  facts: StoryFact[],
  conflicts: StoryConflict[],
): StoryFact | undefined {
  return facts.find((fact) => fact.id === conflict.existingFactId) ??
    conflicts.find(
      (candidate) => candidate.incomingFact?.id === conflict.existingFactId,
    )?.incomingFact;
}

function allowedFactTransitionsForIssue(
  issue: BoundaryIssue,
  facts: StoryFact[],
  candidateConflicts: StoryConflict[],
  allConflicts = candidateConflicts,
) {
  return candidateConflicts.flatMap((conflict) => {
    if (conflict.status !== "open" || !conflict.incomingFact) return [];
    const existing = conflictExistingFact(conflict, facts, allConflicts);
    if (
      !existing ||
      !factTransitionSemanticallyMatches(issue, existing, conflict.incomingFact)
    ) {
      return [];
    }
    return [{
      existingFactId: existing.id,
      incomingFactId: conflict.incomingFact.id,
    }];
  });
}

function applyBoundaryFactTransitions(
  reduced: { facts: StoryFact[]; conflicts: StoryConflict[] },
  issues: BoundaryIssue[],
) {
  for (const issue of issues) {
    if (issue.status !== "resolved" || issue.resolution !== "state_change") continue;
    const predicate = boundaryFactPredicate(issue);
    if (!predicate) continue;
    const explicitTransitions = new Map(
      (issue.factTransitions ?? []).map((transition) => [
        transition.incomingFactId,
        transition.existingFactId,
      ]),
    );
    if (explicitTransitions.size === 0) continue;
    const incomingConflicts = reduced.conflicts.filter((conflict) => {
      if (
        conflict.status !== "open" ||
        !conflict.incomingFact ||
        !conflict.incomingFact.sourceRefs.some(
          (ref) => ref.chunkId === issue.rightChunkId,
        ) ||
        explicitTransitions.get(conflict.incomingFact.id) !== conflict.existingFactId
      ) {
        return false;
      }
      const existing = reduced.facts.find(
        (fact) => fact.id === conflict.existingFactId,
      );
      return !!existing && factTransitionSemanticallyMatches(
        issue,
        existing,
        conflict.incomingFact,
      );
    });
    for (const incomingConflict of incomingConflicts) {
      const incoming = incomingConflict.incomingFact!;
      if (reduced.facts.some((fact) => fact.id === incoming.id)) continue;
      const previous = reduced.facts.find(
        (fact) =>
          fact.id === incomingConflict.existingFactId &&
          !fact.supersededByFactId &&
          normalizeStoryText(fact.subjectId) === normalizeStoryText(issue.entityId) &&
          factMatchesBoundaryField(fact, predicate) &&
          (predicate.startsWith("__") ||
            normalizeStoryText(fact.value) === normalizeStoryText(issue.leftValue)) &&
          storyFactKey(fact) === storyFactKey(incoming),
      );
      if (!previous) continue;
      previous.supersededByFactId = incoming.id;
      const nextFact: StoryFact = {
        ...incoming,
        supersedesFactId: previous.id,
        supersessionReason: "state_change",
        sourceRefs: mergeRefs(incoming.sourceRefs, issue.sourceRefs),
      };
      reduced.facts.push(nextFact);
      incomingConflict.status = "resolved";
      incomingConflict.resolution = "相邻边界核心原文确认为正常状态变化。";
      incomingConflict.resolutionType = "state_change";
      incomingConflict.resolvedByFactId = nextFact.id;
      incomingConflict.resolvedAt = mergeRefs(issue.sourceRefs);
    }
  }
  reduced.facts.sort(
    (left, right) =>
      firstRefParagraph(left.sourceRefs) - firstRefParagraph(right.sourceRefs) ||
      left.id.localeCompare(right.id),
  );
}

function evidenceStartKey(refs: StorySourceRef[]): string {
  const first = mergeRefs(refs)[0];
  return `${first.chunkId}:${first.paragraphRange.start}`;
}

function lastEvidenceParagraph(refs: StorySourceRef[]): number {
  return Math.max(...refs.map((ref) => ref.paragraphRange.end));
}

function timelineSemanticKey(event: StoryTimelineEvent): string {
  return [
    normalizeStoryText(event.summary),
    [...event.characterIds].sort().join(","),
  ].join("|");
}

function reduceTimeline(
  locals: LocalChunkBible[],
  ids: Map<string, string>,
): { timeline: StoryTimelineEvent[]; conflicts: StoryConflict[] } {
  const orderedEvents = locals
    .flatMap((local) => local.timelineEvents)
    .map((event) => ({
      ...event,
      characterIds: event.characterIds.map((id) => ids.get(id) ?? id),
      sourceRefs: mergeRefs(event.sourceRefs),
    }))
    .sort(
      (left, right) =>
        firstRefParagraph(left.sourceRefs) - firstRefParagraph(right.sourceRefs) ||
        left.order - right.order ||
        lastEvidenceParagraph(left.sourceRefs) - lastEvidenceParagraph(right.sourceRefs) ||
        timelineSemanticKey(left).localeCompare(timelineSemanticKey(right)),
    );

  const ambiguousGroups = new Map<string, StoryTimelineEvent[]>();
  for (const event of orderedEvents) {
    const key = `${evidenceStartKey(event.sourceRefs)}\u0000${event.order}`;
    const group = ambiguousGroups.get(key) ?? [];
    group.push(event);
    ambiguousGroups.set(key, group);
  }
  const conflicts = [...ambiguousGroups.values()]
    .filter((group) => new Set(group.map(timelineSemanticKey)).size > 1)
    .sort(
      (left, right) =>
        firstRefParagraph(left[0].sourceRefs) - firstRefParagraph(right[0].sourceRefs) ||
        lastEvidenceParagraph(left[0].sourceRefs) -
          lastEvidenceParagraph(right[0].sourceRefs) ||
        left[0].order - right[0].order,
    )
    .map((group, index): StoryConflict => ({
      id: `conflict_timeline_ambiguous_${String(index + 1).padStart(3, "0")}`,
      type: "timeline",
      description: `同一原文出处与局部 order 对应多个不同事件（${[...new Set(group.map((event) => event.summary))].sort().join("；")}），无法确定是同时发生还是提取顺序冲突。`,
      status: "open",
      sourceRefs: mergeRefs(...group.map((event) => event.sourceRefs)),
    }));

  return {
    timeline: orderedEvents.map((event, index) => ({
      ...event,
      id: `timeline_${String(index + 1).padStart(4, "0")}`,
      order: index + 1,
    })),
    conflicts,
  };
}

function reduceThreads(
  locals: LocalChunkBible[],
  plan: IdentityPlan,
): { threads: StoryThread[]; conflicts: StoryConflict[] } {
  const observations = new Map(
    locals.flatMap((local) =>
      local.threadObservations.map((thread) => [thread.id, thread] as const),
    ),
  );
  const threads: StoryThread[] = [];
  const conflicts: StoryConflict[] = [];
  for (const assignment of plan.threadAssignments) {
    const members = assignment.memberIds.map((id) => observations.get(id)!);
    const grouped = new Map<string, LocalThreadObservation[]>();
    for (const member of members) {
      const key = evidenceStartKey(member.sourceRefs);
      const group = grouped.get(key) ?? [];
      group.push(member);
      grouped.set(key, group);
    }
    const evidenceGroups = [...grouped.values()].sort(
      (left, right) =>
        firstRefParagraph(left[0].sourceRefs) - firstRefParagraph(right[0].sourceRefs) ||
        lastEvidenceParagraph(left[0].sourceRefs) -
          lastEvidenceParagraph(right[0].sourceRefs),
    );
    let status: StoryThread["status"] = "open";
    let lastResolvedRefs: StorySourceRef[] | undefined;
    for (const group of evidenceGroups) {
      const actions = new Set(group.map((member) => member.action));
      const groupRefs = mergeRefs(...group.map((member) => member.sourceRefs));
      if (actions.has("open") && actions.has("resolved")) {
        conflicts.push({
          id: `conflict_thread_same_segment_${String(conflicts.length + 1).padStart(3, "0")}`,
          type: "thread",
          description: `伏笔「${assignment.canonicalSummary}」在同一原文出处同时被标为 open 与 resolved；无法根据局部 id 推断先后，保守保持 open。`,
          status: "open",
          sourceRefs: groupRefs,
        });
        status = "open";
        lastResolvedRefs = undefined;
        continue;
      }
      if (actions.has("resolved")) {
        status = "resolved";
        lastResolvedRefs = groupRefs;
        continue;
      }
      if (actions.has("open")) {
        if (status === "resolved" && lastResolvedRefs) {
          conflicts.push({
            id: `conflict_thread_reopened_${String(conflicts.length + 1).padStart(3, "0")}`,
            type: "thread",
            description: `伏笔「${assignment.canonicalSummary}」在已解决后再次被标为 open；需核实是同一线索重新打开，还是应拆成新伏笔。`,
            status: "open",
            sourceRefs: mergeRefs(lastResolvedRefs, groupRefs),
          });
        }
        status = "open";
        lastResolvedRefs = undefined;
      }
    }
    const introducedRefs = mergeRefs(...evidenceGroups[0].map((member) => member.sourceRefs));
    threads.push({
      id: assignment.canonicalId,
      summary: assignment.canonicalSummary,
      status,
      introducedAt: cloneRef(introducedRefs[0]),
      ...(status === "resolved" && lastResolvedRefs
        ? { resolvedAt: cloneRef(lastResolvedRefs.at(-1)!) }
        : {}),
    });
  }
  return { threads, conflicts };
}

function addBoundaryIssue(
  issues: BoundaryIssue[],
  left: StoryBoundaryState,
  right: StoryBoundaryState,
  entityType: BoundaryIssue["entityType"],
  entityId: string,
  field: string,
  leftValue: string | undefined,
  rightValue: string | undefined,
  sourceRefs: StorySourceRef[],
) {
  if (!leftValue || !rightValue || normalizeStoryText(leftValue) === normalizeStoryText(rightValue)) {
    return;
  }
  issues.push({
    id: `boundary:${left.chunkId}:${right.chunkId}:${entityType}:${entityId}:${field}`,
    leftChunkId: left.chunkId,
    rightChunkId: right.chunkId,
    entityType,
    entityId,
    field,
    leftValue,
    rightValue,
    sourceRefs: mergeRefs(sourceRefs),
    status: "needs_review",
  });
}

function compareBoundaries(
  left: StoryBoundaryState,
  right: StoryBoundaryState,
): BoundaryIssue[] {
  const issues: BoundaryIssue[] = [];
  addBoundaryIssue(
    issues,
    left,
    right,
    "scene",
    "scene",
    "location",
    left.location,
    right.location,
    mergeRefs(left.sourceRefs, right.sourceRefs),
  );
  addBoundaryIssue(
    issues,
    left,
    right,
    "scene",
    "scene",
    "timeLabel",
    left.timeLabel,
    right.timeLabel,
    mergeRefs(left.sourceRefs, right.sourceRefs),
  );

  const rightCharacters = new Map(
    right.characters.map((character) => [character.characterId, character]),
  );
  for (const leftCharacter of left.characters) {
    const rightCharacter = rightCharacters.get(leftCharacter.characterId);
    if (!rightCharacter) continue;
    addBoundaryIssue(
      issues,
      left,
      right,
      "character",
      leftCharacter.characterId,
      "location",
      leftCharacter.location,
      rightCharacter.location,
      mergeRefs(leftCharacter.sourceRefs, rightCharacter.sourceRefs),
    );
    addBoundaryIssue(
      issues,
      left,
      right,
      "character",
      leftCharacter.characterId,
      "physicalState",
      leftCharacter.physicalState,
      rightCharacter.physicalState,
      mergeRefs(leftCharacter.sourceRefs, rightCharacter.sourceRefs),
    );
    addBoundaryIssue(
      issues,
      left,
      right,
      "character",
      leftCharacter.characterId,
      "knowledge",
      JSON.stringify([...new Set(leftCharacter.knowledge)].sort()),
      JSON.stringify([...new Set(rightCharacter.knowledge)].sort()),
      mergeRefs(leftCharacter.sourceRefs, rightCharacter.sourceRefs),
    );
    addBoundaryIssue(
      issues,
      left,
      right,
      "character",
      leftCharacter.characterId,
      "activeGoals",
      JSON.stringify([...new Set(leftCharacter.activeGoals)].sort()),
      JSON.stringify([...new Set(rightCharacter.activeGoals)].sort()),
      mergeRefs(leftCharacter.sourceRefs, rightCharacter.sourceRefs),
    );
  }

  const rightObjects = new Map(right.objects.map((object) => [object.objectId, object]));
  for (const leftObject of left.objects) {
    const rightObject = rightObjects.get(leftObject.objectId);
    if (!rightObject) continue;
    addBoundaryIssue(
      issues,
      left,
      right,
      "object",
      leftObject.objectId,
      "holderCharacterId",
      leftObject.holderCharacterId,
      rightObject.holderCharacterId,
      mergeRefs(leftObject.sourceRefs, rightObject.sourceRefs),
    );
    addBoundaryIssue(
      issues,
      left,
      right,
      "object",
      leftObject.objectId,
      "location",
      leftObject.location,
      rightObject.location,
      mergeRefs(leftObject.sourceRefs, rightObject.sourceRefs),
    );
    addBoundaryIssue(
      issues,
      left,
      right,
      "object",
      leftObject.objectId,
      "state",
      leftObject.state,
      rightObject.state,
      mergeRefs(leftObject.sourceRefs, rightObject.sourceRefs),
    );
  }
  return issues;
}

interface BoundaryRepairTask {
  issues: BoundaryIssue[];
  left: NovelChunk;
  right: NovelChunk;
  allowedTransitionsByIssue: Map<
    string,
    Array<{ existingFactId: string; incomingFactId: string }>
  >;
  messages: ChatMessage[];
}

function compactRepairFact(fact: StoryFact | undefined) {
  if (!fact) return undefined;
  return {
    id: fact.id,
    kind: fact.kind,
    subjectId: fact.subjectId,
    predicate: fact.predicate.slice(0, 200),
    value: fact.value.slice(0, 500),
    statement: fact.statement.slice(0, 500),
    status: fact.status,
    sourceRefs: selectIdentityEvidenceRefs(fact.sourceRefs),
  };
}

function buildBoundaryRepairMessages(
  issueEvidence: unknown[],
  factEvidence: unknown[],
  boundaryText: string,
): ChatMessage[] {
  return [
    {
      role: "system",
      content: `你只判断当前边界批次中的 issue，不得回答其他 issue，也不得用一个结论批量关闭不同性质的差异。decision 只能是 continuous、state_change、extraction_error、true_conflict 或 unresolved。任何要写入事实历史的状态变化都必须逐条写入 factTransitions，并且只能引用该 issue 的 allowedFactTransitions；未列出的事实冲突继续保持 open。不得删除局部事实或重写整份 Bible。只输出 JSON：{"resolutions":[{"issueId":"","decision":"unresolved","explanation":"","sourceRefs":[],"factTransitions":[{"existingFactId":"","incomingFactId":""}]}]}`,
    },
    {
      role: "user",
      content: `${JSON.stringify(issueEvidence)}\n\n可引用的事实冲突：${JSON.stringify(factEvidence)}\n\n${boundaryText}`,
    },
  ];
}

function boundaryMessageChars(messages: ChatMessage[]) {
  return messages.reduce((sum, message) => sum + message.content.length, 0);
}

async function repairBoundaryIssues(
  issues: BoundaryIssue[],
  facts: StoryFact[],
  factConflicts: StoryConflict[],
  chunkedNovel: ChunkedNovel,
  call: ParallelStoryBibleCall,
  signal: AbortSignal | undefined,
  concurrency: number,
  onProgress: ParallelStoryBibleOptions["onProgress"] | undefined,
): Promise<{ issues: BoundaryIssue[]; calls: number }> {
  const byPair = new Map<string, BoundaryIssue[]>();
  for (const issue of issues) {
    const key = `${issue.leftChunkId}:${issue.rightChunkId}`;
    const pair = byPair.get(key) ?? [];
    pair.push(issue);
    byPair.set(key, pair);
  }
  const chunkById = new Map(chunkedNovel.chunks.map((chunk) => [chunk.id, chunk]));
  const tasks: BoundaryRepairTask[] = [];
  for (const pairIssues of byPair.values()) {
    const left = chunkById.get(pairIssues[0].leftChunkId);
    const right = chunkById.get(pairIssues[0].rightChunkId);
    if (!left || !right) throw new Error("边界修复引用了未知文本块");
    const pairFactConflicts = factConflicts.filter(
      (conflict) =>
        conflict.status === "open" &&
        conflict.incomingFact?.sourceRefs.some((ref) => ref.chunkId === right.id) &&
        conflict.sourceRefs.some((ref) => ref.chunkId === left.id),
    );
    const boundaryText = left.id === right.id
      ? renderNovelChunk(chunkedNovel.paragraphs, left)
      : `${renderNovelChunk(chunkedNovel.paragraphs, left)}\n\n${renderNovelChunk(chunkedNovel.paragraphs, right)}`;

    const fitBatch = (batch: BoundaryIssue[]): BoundaryRepairTask[] => {
      const allowedTransitionsByIssue = new Map(
        batch.map((issue) => [
          issue.id,
          allowedFactTransitionsForIssue(
            issue,
            facts,
            pairFactConflicts,
            factConflicts,
          ),
        ]),
      );
      const allowedKeys = new Set(
        [...allowedTransitionsByIssue.values()].flat().map(
          (transition) =>
            `${transition.existingFactId}:${transition.incomingFactId}`,
        ),
      );
      const relevantConflicts = pairFactConflicts.filter(
        (conflict) =>
          !!conflict.incomingFact &&
          allowedKeys.has(
            `${conflict.existingFactId}:${conflict.incomingFact.id}`,
          ),
      );
      const issueEvidence = batch.map((issue) => ({
        ...issue,
        leftValue: issue.leftValue.slice(0, 1_000),
        rightValue: issue.rightValue.slice(0, 1_000),
        sourceRefs: selectIdentityEvidenceRefs(issue.sourceRefs),
        allowedFactTransitions: allowedTransitionsByIssue.get(issue.id) ?? [],
      }));
      const factEvidence = relevantConflicts.map((conflict) => ({
        conflictId: conflict.id,
        existingFact: compactRepairFact(
          conflictExistingFact(conflict, facts, factConflicts),
        ),
        incomingFact: compactRepairFact(conflict.incomingFact),
      }));
      const messages = buildBoundaryRepairMessages(
        issueEvidence,
        factEvidence,
        boundaryText,
      );
      if (boundaryMessageChars(messages) <= MAX_BOUNDARY_MESSAGE_CHARS) {
        return [{
          issues: batch,
          left,
          right,
          allowedTransitionsByIssue,
          messages,
        }];
      }
      if (batch.length === 1) {
        throw new Error(`边界 issue ${batch[0].id} 单项超过字符预算`);
      }
      const middle = Math.ceil(batch.length / 2);
      return [
        ...fitBatch(batch.slice(0, middle)),
        ...fitBatch(batch.slice(middle)),
      ];
    };

    for (
      let index = 0;
      index < pairIssues.length;
      index += MAX_BOUNDARY_ISSUES_PER_CALL
    ) {
      tasks.push(
        ...fitBatch(pairIssues.slice(index, index + MAX_BOUNDARY_ISSUES_PER_CALL)),
      );
    }
  }

  let calls = 0;
  let completedTasks = 0;
  let nextTask = 0;
  let failure: unknown;
  const allowed = new Set([
    "continuous",
    "state_change",
    "extraction_error",
    "true_conflict",
    "unresolved",
  ]);

  const worker = async () => {
    while (true) {
      if (failure || signal?.aborted) return;
      const taskIndex = nextTask++;
      const task = tasks[taskIndex];
      if (!task) return;
      const { issues: pairIssues, left, right, allowedTransitionsByIssue } = task;
      try {
        onProgress?.({
          stage: "boundary_repair",
          completed: completedTasks,
          total: tasks.length,
          chunkId: right.id,
        });
        if (signal?.aborted) throw new Error("Story Bible 任务已取消");
        calls += 1;
        const raw = await call(
          {
            stage: "boundary_repair",
            chunkIds: left.id === right.id ? [left.id] : [left.id, right.id],
            messages: task.messages,
          },
          signal,
        );
        if (signal?.aborted) throw new Error("Story Bible 任务已取消");
        const parsed = parseObject(raw, `边界 ${left.id}/${right.id} 修复`);
        if (!Array.isArray(parsed.resolutions)) {
          throw new Error(`边界 ${left.id}/${right.id} 修复缺少 resolutions 数组`);
        }
        const issueById = new Map(pairIssues.map((issue) => [issue.id, issue]));
        const resolvedIds = new Set<string>();
        for (const [resolutionIndex, rawResolution] of parsed.resolutions.entries()) {
          if (!isObject(rawResolution) || typeof rawResolution.issueId !== "string") {
            throw new Error(`boundaryRepair.resolutions[${resolutionIndex}].issueId 无效`);
          }
          const issue = issueById.get(rawResolution.issueId);
          if (!issue) throw new Error(`边界修复引用了未知 issue：${rawResolution.issueId}`);
          if (resolvedIds.has(issue.id)) throw new Error(`边界修复重复回答 issue：${issue.id}`);
          resolvedIds.add(issue.id);
          if (typeof rawResolution.decision !== "string" || !allowed.has(rawResolution.decision)) {
            throw new Error(`边界修复 ${issue.id} 的 decision 无效`);
          }
          if (!Array.isArray(rawResolution.sourceRefs)) {
            throw new Error(`边界修复 ${issue.id} 的 sourceRefs 必须是数组`);
          }
          const repairRefs = rawResolution.sourceRefs as StorySourceRef[];
          for (const [index, ref] of repairRefs.entries()) {
            const evidenceChunk = ref?.chunkId === left.id
              ? left
              : ref?.chunkId === right.id
                ? right
                : undefined;
            if (!evidenceChunk) {
              throw new Error(`边界修复 sourceRefs[${index}] 越过相邻块权限`);
            }
            assertSourceRef(ref, evidenceChunk, `boundaryRepair.sourceRefs[${index}]`);
          }
          const decision = rawResolution.decision as BoundaryIssue["resolution"];
          const effectiveDecision =
            decision !== "unresolved" && repairRefs.length === 0
              ? "unresolved"
              : decision;
          issue.resolution = effectiveDecision;
          issue.sourceRefs = mergeRefs(issue.sourceRefs, repairRefs);
          if (rawResolution.factTransitions !== undefined) {
            if (!Array.isArray(rawResolution.factTransitions)) {
              throw new Error(`边界修复 ${issue.id} 的 factTransitions 必须是数组`);
            }
            const transitionKeys = new Set<string>();
            issue.factTransitions = rawResolution.factTransitions.map(
              (rawTransition, transitionIndex) => {
                if (
                  !isObject(rawTransition) ||
                  typeof rawTransition.existingFactId !== "string" ||
                  typeof rawTransition.incomingFactId !== "string"
                ) {
                  throw new Error(
                    `boundaryRepair.factTransitions[${transitionIndex}] 结构无效`,
                  );
                }
                const allowedTransition = (
                  allowedTransitionsByIssue.get(issue.id) ?? []
                ).find(
                  (transition) =>
                    transition.existingFactId === rawTransition.existingFactId &&
                    transition.incomingFactId === rawTransition.incomingFactId,
                );
                if (!allowedTransition) {
                  throw new Error(
                    `边界修复 factTransitions[${transitionIndex}] 引用了该 issue 不允许的事实冲突`,
                  );
                }
                const key = `${rawTransition.existingFactId}:${rawTransition.incomingFactId}`;
                if (transitionKeys.has(key)) {
                  throw new Error(`边界修复重复引用事实过渡：${key}`);
                }
                transitionKeys.add(key);
                return {
                  existingFactId: rawTransition.existingFactId,
                  incomingFactId: rawTransition.incomingFactId,
                };
              },
            );
          }
          issue.explanation =
            typeof rawResolution.explanation === "string"
              ? rawResolution.explanation
              : undefined;
          if (effectiveDecision === "continuous" || effectiveDecision === "state_change") {
            issue.status = "resolved";
          }
        }
        completedTasks += 1;
        onProgress?.({
          stage: "boundary_repair",
          completed: completedTasks,
          total: tasks.length,
          chunkId: right.id,
        });
        if (signal?.aborted) throw new Error("Story Bible 任务已取消");
      } catch (error) {
        failure ??= error;
        return;
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(concurrency, tasks.length) }, () => worker()),
  );
  if (failure) throw failure;
  if (signal?.aborted) throw new Error("Story Bible 任务已取消");
  return { issues, calls };
}

function issuesAsConflicts(issues: BoundaryIssue[]): StoryConflict[] {
  return issues
    .filter((issue) => issue.status === "needs_review")
    .map((issue, index) => ({
      id: `conflict_boundary_${String(index + 1).padStart(3, "0")}`,
      type: "reported",
      description: `${issue.leftChunkId}/${issue.rightChunkId} 边界的 ${issue.entityType}.${issue.field} 从「${issue.leftValue}」变为「${issue.rightValue}」，待核实是状态变化还是提取冲突。`,
      status: "open",
      sourceRefs: mergeRefs(issue.sourceRefs),
    }));
}

function openReferenceConflicts(
  boundaries: Array<{ entry: StoryBoundaryState; exit: StoryBoundaryState }>,
): StoryConflict[] {
  const grouped = new Map<
    string,
    { text: string; candidateCharacterIds: string[]; sourceRefs: StorySourceRef[] }
  >();
  for (const boundary of boundaries.flatMap((item) => [item.entry, item.exit])) {
    for (const reference of boundary.openReferences) {
      const candidateCharacterIds = [...new Set(reference.candidateCharacterIds)].sort();
      const key = `${normalizeStoryText(reference.text)}:${candidateCharacterIds.join(",")}`;
      const existing = grouped.get(key) ?? {
        text: reference.text,
        candidateCharacterIds,
        sourceRefs: [],
      };
      existing.sourceRefs = mergeRefs(existing.sourceRefs, [reference.sourceRef]);
      grouped.set(key, existing);
    }
  }
  return [...grouped.values()]
    .sort(
      (left, right) =>
        firstRefParagraph(left.sourceRefs) - firstRefParagraph(right.sourceRefs) ||
        normalizeStoryText(left.text).localeCompare(normalizeStoryText(right.text)),
    )
    .map((reference, index) => ({
      id: `conflict_open_reference_${String(index + 1).padStart(3, "0")}`,
      type: "reported",
      description: `未决指代「${reference.text}」不能因后续边界未重复输出而视为已解决；候选人物：${reference.candidateCharacterIds.join("、") || "无"}。`,
      status: "open",
      sourceRefs: reference.sourceRefs,
    }));
}

function checkpointFrom(
  sourceFingerprint: string,
  locals: Map<string, LocalChunkBible>,
  chunkedNovel: ChunkedNovel,
): ParallelCheckpoint {
  return {
    sourceFingerprint,
    locals: chunkedNovel.chunks.flatMap((chunk) => {
      const local = locals.get(chunk.id);
      return local ? [local] : [];
    }),
  };
}

function assertCheckpointLocal(local: LocalChunkBible, chunk: NovelChunk) {
  if (local.chunkId !== chunk.id || !sameRange(local.coreRange, chunk.coreRange)) {
    throw new Error(`检查点中 ${local.chunkId} 与当前冻结分块不匹配`);
  }
}

export async function buildParallelStoryBibleFromChunks(
  novel: string,
  chunkedNovel: ChunkedNovel,
  call: ParallelStoryBibleCall,
  options: ParallelStoryBibleOptions,
): Promise<ParallelStoryBibleResult> {
  if (
    !options ||
    typeof options.checkpointIdentity !== "string" ||
    options.checkpointIdentity.trim().length === 0
  ) {
    throw new Error("checkpointIdentity 必须标识模型、prompt 与 schema 版本");
  }
  if (
    novel.trim().length === 0 ||
    chunkedNovel.paragraphs.length === 0 ||
    chunkedNovel.chapters.length === 0 ||
    chunkedNovel.chunks.length === 0
  ) {
    throw new Error("冻结长篇小说不能为空");
  }
  const concurrency = options.concurrency ?? 5;
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new Error("concurrency 必须是正整数");
  }
  const sourceFingerprint = fingerprintStorySource(
    novel,
    chunkedNovel,
    `parallel-map-reduce-v4:${options.checkpointIdentity.trim()}`,
  );
  if (
    options.initialCheckpoint &&
    options.initialCheckpoint.sourceFingerprint !== sourceFingerprint
  ) {
    throw new Error("并行 Story Bible 检查点不属于当前小说或冻结分块");
  }

  const chunkById = new Map(chunkedNovel.chunks.map((chunk) => [chunk.id, chunk]));
  const durableLocals = new Map<string, LocalChunkBible>();
  for (const local of options.initialCheckpoint?.locals ?? []) {
    const chunk = chunkById.get(local.chunkId);
    if (!chunk) throw new Error(`检查点包含未知块：${local.chunkId}`);
    if (durableLocals.has(local.chunkId)) throw new Error(`检查点重复包含：${local.chunkId}`);
    assertCheckpointLocal(local, chunk);
    const validated = parseLocalChunkBible(JSON.stringify(local), chunk);
    durableLocals.set(local.chunkId, scopeLocalIds(validated));
  }
  const pending = chunkedNovel.chunks.filter((chunk) => !durableLocals.has(chunk.id));
  let nextIndex = 0;
  let mapCalls = 0;
  let failure: { chunk: NovelChunk; error: unknown } | undefined;
  let checkpointWrites: Promise<void> = Promise.resolve();
  let checkpointFailure: unknown;

  const commitLocal = async (local: LocalChunkBible, chunk: NovelChunk) => {
    const write = checkpointWrites.then(async () => {
      if (checkpointFailure) throw checkpointFailure;
      const candidate = new Map(durableLocals);
      candidate.set(chunk.id, local);
      const snapshot = checkpointFrom(sourceFingerprint, candidate, chunkedNovel);
      try {
        await options.onLocalCheckpoint?.(snapshot, chunk);
      } catch (error) {
        checkpointFailure = error;
        throw error;
      }
      durableLocals.set(chunk.id, local);
    });
    checkpointWrites = write.catch(() => {});
    await write;
  };

  const worker = async () => {
    while (true) {
      if (failure || options.signal?.aborted) return;
      const index = nextIndex++;
      const chunk = pending[index];
      if (!chunk) return;
      try {
        options.onProgress?.({
          stage: "local_extract",
          completed: durableLocals.size,
          total: chunkedNovel.chunks.length,
          chunkId: chunk.id,
        });
        if (options.signal?.aborted) throw new Error("Story Bible 任务已取消");
        mapCalls += 1;
        const raw = await call(
          {
            stage: "local_extract",
            chunkIds: [chunk.id],
            messages: buildLocalMessages(chunkedNovel, chunk),
          },
          options.signal,
        );
        if (options.signal?.aborted) throw new Error("Story Bible 任务已取消");
        const local = scopeLocalIds(parseLocalChunkBible(raw, chunk));
        await commitLocal(local, chunk);
      } catch (error) {
        failure ??= { chunk, error };
      }
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(concurrency, pending.length) }, () => worker()),
  );
  const currentCheckpoint = checkpointFrom(
    sourceFingerprint,
    durableLocals,
    chunkedNovel,
  );
  if (failure) {
    throw new ParallelStoryBibleError(
      `${failure.chunk.id} 局部理解失败：${failure.error instanceof Error ? failure.error.message : "未知错误"}`,
      currentCheckpoint,
      { cause: failure.error },
    );
  }
  if (options.signal?.aborted) {
    throw new ParallelStoryBibleError(
      "Story Bible 任务已取消",
      currentCheckpoint,
    );
  }

  try {
  const locals = chunkedNovel.chunks.map((chunk) => durableLocals.get(chunk.id)!);
  const identityCandidates = collectIdentityCandidates(locals);
  const allCharacters = identityCandidates.characters;
  const allObjects = identityCandidates.objects;
  const allThreads = identityCandidates.threads;
  let reconcileCalls = 0;
  let identityPageCount = 0;
  let identityPlan: IdentityPlan;
  if (allCharacters.length === 0 && allObjects.length === 0 && allThreads.length === 0) {
    identityPlan = {
      assignments: [],
      uncertainGroups: [],
      objectAssignments: [],
      uncertainObjectGroups: [],
      threadAssignments: [],
      uncertainThreadGroups: [],
    };
  } else {
    const pages = buildIdentityPages(identityCandidates, chunkedNovel);
    identityPageCount = pages.length;
    const plans: IdentityPlan[] = [];
    for (const page of pages) {
      options.onProgress?.({
        stage: "identity_reconcile",
        completed: plans.length,
        total: pages.length,
      });
      if (options.signal?.aborted) {
        throw new ParallelStoryBibleError("Story Bible 任务已取消", currentCheckpoint);
      }
      const messages = buildIdentityMessages(page, chunkedNovel);
      if (identityMessageChars(messages) > MAX_IDENTITY_MESSAGE_CHARS) {
        throw new Error("identity 请求超过字符预算");
      }
      reconcileCalls += 1;
      const pageRefs = [
        ...page.characters.flatMap((candidate) => candidate.sourceRefs),
        ...page.objects.flatMap((candidate) => candidate.sourceRefs),
        ...page.threads.flatMap((candidate) => candidate.sourceRefs),
      ];
      const rawIdentity = await call(
        {
          stage: "identity_reconcile",
          chunkIds: [...new Set(pageRefs.map((ref) => ref.chunkId))],
          messages,
        },
        options.signal,
      );
      if (options.signal?.aborted) {
        throw new ParallelStoryBibleError("Story Bible 任务已取消", currentCheckpoint);
      }
      plans.push(parseIdentityPlan(rawIdentity, page));
    }
    options.onProgress?.({
      stage: "identity_reconcile",
      completed: pages.length,
      total: pages.length,
    });
    if (options.signal?.aborted) {
      throw new ParallelStoryBibleError("Story Bible 任务已取消", currentCheckpoint);
    }
    identityPlan = mergeIdentityPlans(plans, identityCandidates);
    if (pages.length > 1) {
      identityPlan = {
        ...identityPlan,
        assignments: identityPlan.assignments.map((assignment) => ({
          ...assignment,
          decision: "uncertain" as const,
        })),
        objectAssignments: identityPlan.objectAssignments.map((assignment) => ({
          ...assignment,
          decision: "uncertain" as const,
        })),
        threadAssignments: identityPlan.threadAssignments.map((assignment) => ({
          ...assignment,
          decision: "uncertain" as const,
        })),
      };
    }
  }
  if (options.signal?.aborted) {
    throw new ParallelStoryBibleError("Story Bible 任务已取消", currentCheckpoint);
  }

  const ids = identityMap(identityPlan);
  const objectIds = objectIdentityMap(identityPlan);
  const characters = buildCharacters(locals, identityPlan);
  const reducedFacts = reduceFacts(locals, ids, objectIds);
  const reducedTimeline = reduceTimeline(locals, ids);
  const reducedThreads = reduceThreads(locals, identityPlan);
  const identityPaginationConflicts: StoryConflict[] = identityPageCount > 1
    ? [{
        id: "conflict_identity_pagination_001",
        type: "identity",
        description: `身份候选因硬预算分成 ${identityPageCount} 页；页内已归一，但跨页候选未强行合并，相关身份保持 provisional。`,
        status: "open",
        sourceRefs: selectIdentityEvidenceRefs(mergeRefs(
          ...allCharacters.map((candidate) => candidate.sourceRefs),
          ...allObjects.map((candidate) => candidate.sourceRefs),
          ...allThreads.map((candidate) => candidate.sourceRefs),
        )),
      }]
    : [];
  const identityConflicts: StoryConflict[] = identityPlan.uncertainGroups.map(
    (members, index) => ({
      id: `conflict_identity_${String(index + 1).padStart(3, "0")}`,
      type: "identity",
      description: `人物候选 ${members.join("、")} 无法确定是否同一人，未自动合并。`,
      status: "open",
      sourceRefs: mergeRefs(
        ...locals.flatMap((local) =>
          local.characters
            .filter((character) => members.includes(character.id))
            .map((character) => character.sourceRefs),
        ),
      ),
    }),
  );
  const objectIdentityConflicts: StoryConflict[] =
    identityPlan.uncertainObjectGroups.map((members, index) => ({
      id: `conflict_object_identity_${String(index + 1).padStart(3, "0")}`,
      type: "identity",
      description: `物品候选 ${members.join("、")} 无法确定是否同一物，未自动合并。`,
      status: "open",
      sourceRefs: mergeRefs(
        ...allObjects
          .filter((object) => members.includes(object.id))
          .map((object) => object.sourceRefs),
      ),
    }));
  const threadIdentityConflicts: StoryConflict[] =
    identityPlan.uncertainThreadGroups.map((members, index) => ({
      id: `conflict_thread_identity_${String(index + 1).padStart(3, "0")}`,
      type: "thread",
      description: `伏笔候选 ${members.join("、")} 无法确定是否同一线索，未自动合并。`,
      status: "open",
      sourceRefs: mergeRefs(
        ...allThreads
          .filter((thread) => members.includes(thread.id))
          .map((thread) => thread.sourceRefs),
      ),
    }));
  const canonicalBoundaries = locals.map((local) => ({
    entry: rewriteBoundary(local.entryBoundary, ids, objectIds),
    exit: rewriteBoundary(local.exitBoundary, ids, objectIds),
  }));
  let boundaryIssues = canonicalBoundaries.flatMap((boundary, index) => {
    const next = canonicalBoundaries[index + 1];
    return [
      ...compareBoundaries(boundary.entry, boundary.exit),
      ...(next ? compareBoundaries(boundary.exit, next.entry) : []),
    ];
  });
  let repairCalls = 0;
  if ((options.repairBoundaries ?? true) && boundaryIssues.length > 0) {
    const repaired = await repairBoundaryIssues(
      boundaryIssues,
      reducedFacts.facts,
      reducedFacts.conflicts,
      chunkedNovel,
      call,
      options.signal,
      concurrency,
      options.onProgress,
    );
    boundaryIssues = repaired.issues;
    repairCalls = repaired.calls;
  }
  applyBoundaryFactTransitions(reducedFacts, boundaryIssues);
  if (options.signal?.aborted) {
    throw new ParallelStoryBibleError("Story Bible 任务已取消", currentCheckpoint);
  }

  const firstChunk = chunkedNovel.chunks[0];
  const lastChunk = chunkedNovel.chunks.at(-1);
  const bible: StoryBible = {
    version: 1,
    sourceFingerprint,
    processedRange:
      firstChunk && lastChunk
        ? { start: firstChunk.coreRange.start, end: lastChunk.coreRange.end }
        : null,
    characters,
    facts: reducedFacts.facts,
    timeline: reducedTimeline.timeline,
    threads: reducedThreads.threads,
    conflicts: [
      ...identityPaginationConflicts,
      ...identityConflicts,
      ...objectIdentityConflicts,
      ...threadIdentityConflicts,
      ...reducedFacts.conflicts,
      ...reducedTimeline.conflicts,
      ...reducedThreads.conflicts,
      ...issuesAsConflicts(boundaryIssues),
      ...openReferenceConflicts(canonicalBoundaries),
    ],
    boundaryState: canonicalBoundaries.at(-1)?.exit ?? null,
  };
  options.onProgress?.({
    stage: "complete",
    completed: chunkedNovel.chunks.length,
    total: chunkedNovel.chunks.length,
  });
  if (options.signal?.aborted) {
    throw new ParallelStoryBibleError("Story Bible 任务已取消", currentCheckpoint);
  }
  return {
    bible,
    chunkedNovel,
    locals,
    identityPlan,
    boundaryIssues,
    checkpoint: currentCheckpoint,
    stats: { mapCalls, reconcileCalls, repairCalls },
  };
  } catch (error) {
    if (error instanceof ParallelStoryBibleError) throw error;
    throw new ParallelStoryBibleError(
      `并行 Story Bible 后处理失败：${error instanceof Error ? error.message : "未知错误"}`,
      currentCheckpoint,
      { cause: error },
    );
  }
}
