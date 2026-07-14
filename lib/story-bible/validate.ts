import { extractJSON } from "../llm/json";
import type { NovelChunk, ParagraphRange } from "../novel/types";
import type {
  StoryBible,
  StoryBibleDelta,
  StorySourceRef,
} from "./types";
import {
  normalizeStoryText,
  sameStoryFactKey,
  sameStoryFactValue,
  type StoryFactLike,
} from "./facts";
import { MAX_ROLLING_BOUNDARY_STATE_CHARS } from "./prompts";

type Obj = Record<string, unknown>;

export interface StoryBibleValidationIssue {
  path: string;
  message: string;
}

export interface StoryBibleValidationResult {
  valid: boolean;
  issues: StoryBibleValidationIssue[];
}

export class StoryBibleDeltaError extends Error {
  constructor(public readonly issues: StoryBibleValidationIssue[]) {
    super(issues.map((issue) => `${issue.path}: ${issue.message}`).join("；"));
    this.name = "StoryBibleDeltaError";
  }
}

const MAX_STORY_BIBLE_DELTA_CHARS = 200_000;

function isObject(value: unknown): value is Obj {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isRange(value: unknown): value is ParagraphRange {
  return (
    isObject(value) &&
    Number.isInteger(value.start) &&
    Number.isInteger(value.end) &&
    (value.start as number) <= (value.end as number)
  );
}

function inCore(range: ParagraphRange, chunk: NovelChunk): boolean {
  return range.start >= chunk.coreRange.start && range.end <= chunk.coreRange.end;
}

function inspectSourceRef(
  value: unknown,
  path: string,
  chunk: NovelChunk,
  issues: StoryBibleValidationIssue[],
): value is StorySourceRef {
  if (!isObject(value)) {
    issues.push({ path, message: "出处必须是对象" });
    return false;
  }
  let valid = true;
  const chapterRange = isNonEmptyString(value.chapterId)
    ? chunk.chapterRanges.find((chapter) => chapter.chapterId === value.chapterId)
    : undefined;
  if (!chapterRange) {
    issues.push({ path: `${path}.chapterId`, message: "章节不属于当前核心文本" });
    valid = false;
  }
  if (value.chunkId !== chunk.id) {
    issues.push({ path: `${path}.chunkId`, message: `必须是当前文本块 ${chunk.id}` });
    valid = false;
  }
  if (!isRange(value.paragraphRange) || !inCore(value.paragraphRange, chunk)) {
    issues.push({
      path: `${path}.paragraphRange`,
      message: "新事实只能引用当前核心区间，不能引用 overlap",
    });
    valid = false;
  } else if (
    chapterRange &&
    (value.paragraphRange.start < chapterRange.paragraphRange.start ||
      value.paragraphRange.end > chapterRange.paragraphRange.end)
  ) {
    issues.push({
      path: `${path}.chapterId`,
      message: "章节 id 与引用段落不匹配",
    });
    valid = false;
  }
  return valid;
}

function inspectSourceRefs(
  value: unknown,
  path: string,
  chunk: NovelChunk,
  issues: StoryBibleValidationIssue[],
) {
  if (!Array.isArray(value) || value.length === 0) {
    issues.push({ path, message: "必须至少有一个原文出处" });
    return;
  }
  value.forEach((ref, index) => inspectSourceRef(ref, `${path}[${index}]`, chunk, issues));
}

function inspectStringArray(
  value: unknown,
  path: string,
  issues: StoryBibleValidationIssue[],
) {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    issues.push({ path, message: "必须是字符串数组" });
  }
}

function inspectUniqueIds(
  value: unknown,
  path: string,
  issues: StoryBibleValidationIssue[],
) {
  if (!Array.isArray(value)) {
    issues.push({ path, message: "必须是数组" });
    return;
  }
  const ids = new Set<string>();
  value.forEach((item, index) => {
    if (!isObject(item) || !isNonEmptyString(item.id)) {
      issues.push({ path: `${path}[${index}].id`, message: "缺少 id" });
      return;
    }
    if (ids.has(item.id)) {
      issues.push({ path: `${path}[${index}].id`, message: `id 重复：${item.id}` });
    }
    ids.add(item.id);
  });
}

const FACT_KINDS = new Set([
  "character",
  "relationship",
  "timeline",
  "location",
  "object",
  "knowledge",
  "constraint",
]);
const SOURCE_FACT_STATUSES = new Set(["source_fact", "uncertain"]);
const SUPERSESSION_REASONS = new Set(["state_change", "correction", "reveal"]);
const CONFLICT_RESOLUTION_TYPES = new Set([
  "confirmed_existing",
  "confirmed_incoming",
  "state_change",
  "correction",
]);

function inspectOptionalString(
  value: unknown,
  path: string,
  issues: StoryBibleValidationIssue[],
) {
  if (value !== undefined && typeof value !== "string") {
    issues.push({ path, message: "必须是字符串" });
  }
}

function inspectKnownCharacterIds(
  value: unknown,
  path: string,
  knownIds: Set<string>,
  issues: StoryBibleValidationIssue[],
) {
  if (!Array.isArray(value)) return;
  value.forEach((id, index) => {
    if (typeof id === "string" && !knownIds.has(id)) {
      issues.push({ path: `${path}[${index}]`, message: `引用了未知人物：${id}` });
    }
  });
}

export function validateStoryBibleDelta(
  value: unknown,
  bible: StoryBible,
  chunk: NovelChunk,
): StoryBibleValidationResult {
  const issues: StoryBibleValidationIssue[] = [];
  if (!isObject(value)) {
    return { valid: false, issues: [{ path: "(root)", message: "返回值必须是对象" }] };
  }

  if (value.chunkId !== chunk.id) {
    issues.push({ path: "chunkId", message: `必须是当前文本块 ${chunk.id}` });
  }
  const expectedStart = (bible.processedRange?.end ?? 0) + 1;
  if (chunk.coreRange.start !== expectedStart) {
    issues.push({
      path: "processedRange",
      message: `与上一检查点不连续：期待从 ¶${expectedStart} 开始`,
    });
  }
  if (
    !isRange(value.processedRange) ||
    value.processedRange.start !== chunk.coreRange.start ||
    value.processedRange.end !== chunk.coreRange.end
  ) {
    issues.push({ path: "processedRange", message: "必须精确等于当前核心区间" });
  }

  inspectUniqueIds(value.characters, "characters", issues);
  if (Array.isArray(value.characters)) {
    value.characters.forEach((character, index) => {
      if (!isObject(character)) return;
      if (!isNonEmptyString(character.name)) {
        issues.push({ path: `characters[${index}].name`, message: "缺少人物名" });
      }
      const existingCharacter = isNonEmptyString(character.id)
        ? bible.characters.find((item) => item.id === character.id)
        : undefined;
      if (
        existingCharacter &&
        isNonEmptyString(character.name) &&
        normalizeStoryText(existingCharacter.name) !== normalizeStoryText(character.name)
      ) {
        issues.push({
          path: `characters[${index}].name`,
          message: `人物 id ${character.id} 不能从「${existingCharacter.name}」改成「${character.name}」`,
        });
      }
      inspectStringArray(character.aliases, `characters[${index}].aliases`, issues);
      inspectOptionalString(character.description, `characters[${index}].description`, issues);
      if (character.identityStatus !== undefined) {
        issues.push({
          path: `characters[${index}].identityStatus`,
          message: "该字段由合并器维护，模型不能写入",
        });
      }
      inspectSourceRefs(character.sourceRefs, `characters[${index}].sourceRefs`, chunk, issues);
    });
  }
  const knownCharacterIds = new Set([
    ...bible.characters.map((character) => character.id),
    ...(Array.isArray(value.characters)
      ? value.characters.flatMap((character) =>
          isObject(character) && isNonEmptyString(character.id) ? [character.id] : [],
        )
      : []),
  ]);

  inspectUniqueIds(value.newFacts, "newFacts", issues);
  if (Array.isArray(value.newFacts)) {
    const incomingFacts = value.newFacts;
    const supersededIncomingIds = new Set<string>();
    incomingFacts.forEach((fact, index) => {
      if (!isObject(fact)) return;
      for (const field of ["kind", "subjectId", "predicate", "value", "statement", "status"]) {
        if (!isNonEmptyString(fact[field])) {
          issues.push({ path: `newFacts[${index}].${field}`, message: "不能为空" });
        }
      }
      if (!FACT_KINDS.has(String(fact.kind))) {
        issues.push({
          path: `newFacts[${index}].kind`,
          message: "事实类型不在允许范围内",
        });
      }
      if (!SOURCE_FACT_STATUSES.has(String(fact.status))) {
        issues.push({
          path: `newFacts[${index}].status`,
          message: "原著理解阶段只允许 source_fact 或 uncertain",
        });
      }
      if (
        fact.perspectiveCharacterId !== undefined &&
        (!isNonEmptyString(fact.perspectiveCharacterId) ||
          !knownCharacterIds.has(fact.perspectiveCharacterId))
      ) {
        issues.push({
          path: `newFacts[${index}].perspectiveCharacterId`,
          message: "视角人物必须是已知人物",
        });
      }
      if (fact.supersededByFactId !== undefined) {
        issues.push({
          path: `newFacts[${index}].supersededByFactId`,
          message: "该字段由合并器维护，模型不能写入",
        });
      }
      if (fact.supersedesFactId !== undefined) {
        const previousBibleFact = bible.facts.find(
          (oldFact) =>
            oldFact.id === fact.supersedesFactId && !oldFact.supersededByFactId,
        );
        const previousIncomingFact = incomingFacts
          .slice(0, index)
          .find(
            (oldFact) =>
              isObject(oldFact) &&
              oldFact.id === fact.supersedesFactId &&
              !supersededIncomingIds.has(String(oldFact.id)),
          );
        const superseded = previousBibleFact ?? previousIncomingFact;
        if (
          !isNonEmptyString(fact.supersedesFactId) ||
          !superseded ||
          !sameStoryFactKey(fact, superseded) ||
          fact.id === superseded.id
        ) {
          issues.push({
            path: `newFacts[${index}].supersedesFactId`,
            message: "只能用新 id 替代上一版或本块更早的同键生效事实",
          });
        } else {
          supersededIncomingIds.add(fact.supersedesFactId);
        }
        if (!SUPERSESSION_REASONS.has(String(fact.supersessionReason))) {
          issues.push({
            path: `newFacts[${index}].supersessionReason`,
            message: "替代旧事实时必须说明 state_change、correction 或 reveal",
          });
        }
      } else if (fact.supersessionReason !== undefined) {
        issues.push({
          path: `newFacts[${index}].supersessionReason`,
          message: "没有替代旧事实时不能填写替代原因",
        });
      }
      inspectSourceRefs(fact.sourceRefs, `newFacts[${index}].sourceRefs`, chunk, issues);
    });
  }

  inspectUniqueIds(value.timelineEvents, "timelineEvents", issues);
  if (Array.isArray(value.timelineEvents)) {
    value.timelineEvents.forEach((event, index) => {
      if (!isObject(event) || !isNonEmptyString(event.summary)) {
        issues.push({ path: `timelineEvents[${index}].summary`, message: "缺少事件摘要" });
        return;
      }
      if (!Number.isInteger(event.order) || (event.order as number) < 1) {
        issues.push({ path: `timelineEvents[${index}].order`, message: "顺序必须是正整数" });
      }
      inspectStringArray(event.characterIds, `timelineEvents[${index}].characterIds`, issues);
      inspectKnownCharacterIds(
        event.characterIds,
        `timelineEvents[${index}].characterIds`,
        knownCharacterIds,
        issues,
      );
      inspectSourceRefs(event.sourceRefs, `timelineEvents[${index}].sourceRefs`, chunk, issues);
    });
  }

  inspectUniqueIds(value.openedThreads, "openedThreads", issues);
  if (Array.isArray(value.openedThreads)) {
    value.openedThreads.forEach((thread, index) => {
      if (!isObject(thread) || !isNonEmptyString(thread.summary)) {
        issues.push({ path: `openedThreads[${index}].summary`, message: "缺少伏笔摘要" });
        return;
      }
      if (thread.status !== "open") {
        issues.push({ path: `openedThreads[${index}].status`, message: "新伏笔必须是 open" });
      }
      inspectSourceRef(thread.introducedAt, `openedThreads[${index}].introducedAt`, chunk, issues);
    });
  }

  const openedThreadIds = new Set(
    Array.isArray(value.openedThreads)
      ? value.openedThreads.flatMap((thread) =>
          isObject(thread) && isNonEmptyString(thread.id) ? [thread.id] : [],
        )
      : [],
  );
  const resolvableThreadIds = new Set([
    ...bible.threads.filter((thread) => thread.status === "open").map((thread) => thread.id),
    ...openedThreadIds,
  ]);
  if (!Array.isArray(value.resolvedThreads)) {
    issues.push({ path: "resolvedThreads", message: "必须是数组" });
  } else {
    const resolvedIds = new Set<string>();
    value.resolvedThreads.forEach((resolution, index) => {
      if (!isObject(resolution) || !isNonEmptyString(resolution.threadId)) {
        issues.push({ path: `resolvedThreads[${index}].threadId`, message: "缺少伏笔 id" });
        return;
      }
      if (resolvedIds.has(resolution.threadId)) {
        issues.push({
          path: `resolvedThreads[${index}].threadId`,
          message: `重复解决伏笔：${resolution.threadId}`,
        });
      }
      resolvedIds.add(resolution.threadId);
      if (!resolvableThreadIds.has(resolution.threadId)) {
        issues.push({
          path: `resolvedThreads[${index}].threadId`,
          message: "只能解决上一版或本块中仍开放的伏笔",
        });
      }
      inspectSourceRef(resolution.resolvedAt, `resolvedThreads[${index}].resolvedAt`, chunk, issues);
    });
  }

  if (!Array.isArray(value.reportedConflicts)) {
    issues.push({ path: "reportedConflicts", message: "必须是数组" });
  } else {
    value.reportedConflicts.forEach((conflict, index) => {
      if (!isObject(conflict) || !isNonEmptyString(conflict.description)) {
        issues.push({ path: `reportedConflicts[${index}].description`, message: "缺少冲突说明" });
        return;
      }
      inspectSourceRefs(conflict.sourceRefs, `reportedConflicts[${index}].sourceRefs`, chunk, issues);
    });
  }

  if (!Array.isArray(value.resolvedConflicts)) {
    issues.push({ path: "resolvedConflicts", message: "必须是数组" });
  } else {
    const resolvedConflictIds = new Set<string>();
    const openConflictIds = new Set(
      bible.conflicts
        .filter((conflict) => conflict.status === "open")
        .map((conflict) => conflict.id),
    );
    const incomingFacts = Array.isArray(value.newFacts)
      ? value.newFacts.filter(isObject)
      : [];
    const availableFacts: StoryFactLike[] = [...bible.facts, ...incomingFacts];
    const availableFactIds = new Set(
      availableFacts.flatMap((fact) =>
        isNonEmptyString(fact.id) ? [fact.id] : [],
      ),
    );
    value.resolvedConflicts.forEach((resolution, index) => {
      if (!isObject(resolution) || !isNonEmptyString(resolution.conflictId)) {
        issues.push({
          path: `resolvedConflicts[${index}].conflictId`,
          message: "缺少冲突 id",
        });
        return;
      }
      if (resolvedConflictIds.has(resolution.conflictId)) {
        issues.push({
          path: `resolvedConflicts[${index}].conflictId`,
          message: `重复解决冲突：${resolution.conflictId}`,
        });
      }
      resolvedConflictIds.add(resolution.conflictId);
      if (!openConflictIds.has(resolution.conflictId)) {
        issues.push({
          path: `resolvedConflicts[${index}].conflictId`,
          message: "只能解决上一版中仍开放的冲突",
        });
      }
      if (!CONFLICT_RESOLUTION_TYPES.has(String(resolution.resolutionType))) {
        issues.push({
          path: `resolvedConflicts[${index}].resolutionType`,
          message: "冲突解决类型不在允许范围内",
        });
      }
      if (!isNonEmptyString(resolution.explanation)) {
        issues.push({
          path: `resolvedConflicts[${index}].explanation`,
          message: "缺少解决依据",
        });
      }
      if (
        resolution.resolvedByFactId !== undefined &&
        (!isNonEmptyString(resolution.resolvedByFactId) ||
          !availableFactIds.has(resolution.resolvedByFactId))
      ) {
        issues.push({
          path: `resolvedConflicts[${index}].resolvedByFactId`,
          message: "解决依据必须指向已有或本块新增事实",
        });
      }
      if (!isNonEmptyString(resolution.resolvedByFactId)) {
        issues.push({
          path: `resolvedConflicts[${index}].resolvedByFactId`,
          message: "关闭冲突必须指向解决该冲突的事实",
        });
      }
      const targetConflict = bible.conflicts.find(
        (conflict) => conflict.id === resolution.conflictId && conflict.status === "open",
      );
      const existingFact = targetConflict?.existingFactId
        ? bible.facts.find((fact) => fact.id === targetConflict.existingFactId)
        : undefined;
      const resolvedFact = isNonEmptyString(resolution.resolvedByFactId)
        ? availableFacts.find((fact) => fact.id === resolution.resolvedByFactId)
        : undefined;
      if (!targetConflict?.incomingFact || !existingFact) {
        issues.push({
          path: `resolvedConflicts[${index}].conflictId`,
          message: "本阶段只能自动关闭带新旧事实两侧的结构化冲突",
        });
      } else if (resolvedFact) {
        let matchesTarget = sameStoryFactKey(resolvedFact, existingFact);
        if (resolution.resolutionType === "confirmed_existing") {
          matchesTarget =
            matchesTarget && sameStoryFactValue(resolvedFact, existingFact);
        } else if (resolution.resolutionType === "confirmed_incoming") {
          matchesTarget =
            matchesTarget &&
            sameStoryFactValue(resolvedFact, targetConflict.incomingFact) &&
            resolvedFact.supersedesFactId === existingFact.id;
        } else if (
          resolution.resolutionType === "state_change" ||
          resolution.resolutionType === "correction"
        ) {
          matchesTarget =
            matchesTarget && resolvedFact.supersedesFactId === existingFact.id;
        }
        if (!matchesTarget) {
          issues.push({
            path: `resolvedConflicts[${index}].resolvedByFactId`,
            message: "解决事实与目标冲突的新旧事实键或取值无关",
          });
        }
      }
      inspectSourceRefs(
        resolution.sourceRefs,
        `resolvedConflicts[${index}].sourceRefs`,
        chunk,
        issues,
      );
    });
  }

  if (!isObject(value.boundaryState)) {
    issues.push({ path: "boundaryState", message: "缺少块结束状态" });
  } else {
    const boundaryStateChars = JSON.stringify(value.boundaryState).length;
    if (boundaryStateChars > MAX_ROLLING_BOUNDARY_STATE_CHARS) {
      issues.push({
        path: "boundaryState",
        message: `共 ${boundaryStateChars} 字符，超过上限 ${MAX_ROLLING_BOUNDARY_STATE_CHARS}`,
      });
    }
    if (value.boundaryState.chunkId !== chunk.id) {
      issues.push({ path: "boundaryState.chunkId", message: `必须是当前文本块 ${chunk.id}` });
    }
    if (value.boundaryState.asOfParagraph !== chunk.coreRange.end) {
      issues.push({
        path: "boundaryState.asOfParagraph",
        message: "必须落在当前核心区间末段",
      });
    }
    if (!Array.isArray(value.boundaryState.characters)) {
      issues.push({ path: "boundaryState.characters", message: "必须是数组" });
    } else {
      const boundaryCharacterIds = new Set<string>();
      value.boundaryState.characters.forEach((state, index) => {
        if (!isObject(state) || !isNonEmptyString(state.characterId)) {
          issues.push({
            path: `boundaryState.characters[${index}].characterId`,
            message: "缺少人物 id",
          });
          return;
        }
        if (boundaryCharacterIds.has(state.characterId)) {
          issues.push({
            path: `boundaryState.characters[${index}].characterId`,
            message: `人物边界状态重复：${state.characterId}`,
          });
        }
        boundaryCharacterIds.add(state.characterId);
        if (!knownCharacterIds.has(state.characterId)) {
          issues.push({
            path: `boundaryState.characters[${index}].characterId`,
            message: `引用了未知人物：${state.characterId}`,
          });
        }
        inspectOptionalString(state.location, `boundaryState.characters[${index}].location`, issues);
        inspectOptionalString(
          state.physicalState,
          `boundaryState.characters[${index}].physicalState`,
          issues,
        );
        inspectStringArray(state.knowledge, `boundaryState.characters[${index}].knowledge`, issues);
        inspectStringArray(state.activeGoals, `boundaryState.characters[${index}].activeGoals`, issues);
        inspectSourceRefs(
          state.sourceRefs,
          `boundaryState.characters[${index}].sourceRefs`,
          chunk,
          issues,
        );
      });
    }
    if (!Array.isArray(value.boundaryState.objects)) {
      issues.push({ path: "boundaryState.objects", message: "必须是数组" });
    } else {
      const objectIds = new Set<string>();
      value.boundaryState.objects.forEach((state, index) => {
        if (!isObject(state) || !isNonEmptyString(state.objectId)) {
          issues.push({
            path: `boundaryState.objects[${index}].objectId`,
            message: "缺少物品 id",
          });
          return;
        }
        if (objectIds.has(state.objectId)) {
          issues.push({
            path: `boundaryState.objects[${index}].objectId`,
            message: `物品 id 重复：${state.objectId}`,
          });
        }
        objectIds.add(state.objectId);
        if (
          state.holderCharacterId !== undefined &&
          (!isNonEmptyString(state.holderCharacterId) ||
            !knownCharacterIds.has(state.holderCharacterId))
        ) {
          issues.push({
            path: `boundaryState.objects[${index}].holderCharacterId`,
            message: "持有人必须是已知人物",
          });
        }
        inspectOptionalString(state.location, `boundaryState.objects[${index}].location`, issues);
        inspectOptionalString(state.state, `boundaryState.objects[${index}].state`, issues);
        inspectSourceRefs(
          state.sourceRefs,
          `boundaryState.objects[${index}].sourceRefs`,
          chunk,
          issues,
        );
      });
    }
    if (!Array.isArray(value.boundaryState.openReferences)) {
      issues.push({ path: "boundaryState.openReferences", message: "必须是数组" });
    } else {
      value.boundaryState.openReferences.forEach((reference, index) => {
        if (!isObject(reference) || !isNonEmptyString(reference.text)) {
          issues.push({
            path: `boundaryState.openReferences[${index}].text`,
            message: "缺少待消歧称谓",
          });
          return;
        }
        inspectStringArray(
          reference.candidateCharacterIds,
          `boundaryState.openReferences[${index}].candidateCharacterIds`,
          issues,
        );
        inspectKnownCharacterIds(
          reference.candidateCharacterIds,
          `boundaryState.openReferences[${index}].candidateCharacterIds`,
          knownCharacterIds,
          issues,
        );
        inspectSourceRef(
          reference.sourceRef,
          `boundaryState.openReferences[${index}].sourceRef`,
          chunk,
          issues,
        );
      });
    }
    inspectOptionalString(value.boundaryState.timeLabel, "boundaryState.timeLabel", issues);
    inspectOptionalString(value.boundaryState.location, "boundaryState.location", issues);
    inspectSourceRefs(value.boundaryState.sourceRefs, "boundaryState.sourceRefs", chunk, issues);
  }

  return { valid: issues.length === 0, issues };
}

export function parseStoryBibleDelta(
  raw: string,
  bible: StoryBible,
  chunk: NovelChunk,
): StoryBibleDelta {
  if (raw.length > MAX_STORY_BIBLE_DELTA_CHARS) {
    throw new StoryBibleDeltaError([
      {
        path: "(root)",
        message: `模型返回共 ${raw.length} 字符，超过上限 ${MAX_STORY_BIBLE_DELTA_CHARS}`,
      },
    ]);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(extractJSON(raw));
  } catch {
    throw new StoryBibleDeltaError([{ path: "(root)", message: "模型没有返回合法 JSON" }]);
  }
  const validation = validateStoryBibleDelta(parsed, bible, chunk);
  if (!validation.valid) throw new StoryBibleDeltaError(validation.issues);
  return parsed as StoryBibleDelta;
}
