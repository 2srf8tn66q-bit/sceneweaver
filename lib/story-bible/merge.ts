import type { NovelChunk } from "../novel/types";
import type {
  StoryBible,
  StoryBibleDelta,
  StoryCharacter,
  StoryConflict,
  StoryConflictType,
  StoryFact,
  StorySourceRef,
  StoryThread,
} from "./types";
import { sameStoryFactValue, storyFactKey } from "./facts";

const GENERIC_ALIASES = new Set(["他", "她", "它", "他们", "她们", "其", "此人"]);

export function createEmptyStoryBible(sourceFingerprint: string | null = null): StoryBible {
  return {
    version: 0,
    sourceFingerprint,
    processedRange: null,
    characters: [],
    facts: [],
    timeline: [],
    threads: [],
    conflicts: [],
    boundaryState: null,
  };
}

function refKey(ref: StorySourceRef): string {
  return `${ref.chapterId}:${ref.chunkId}:${ref.paragraphRange.start}-${ref.paragraphRange.end}`;
}

function cloneRef(ref: StorySourceRef): StorySourceRef {
  return { ...ref, paragraphRange: { ...ref.paragraphRange } };
}

function mergeRefs(a: StorySourceRef[], b: StorySourceRef[]): StorySourceRef[] {
  const refs = new Map<string, StorySourceRef>();
  for (const ref of [...a, ...b]) refs.set(refKey(ref), cloneRef(ref));
  return [...refs.values()];
}

function normalize(value: string): string {
  return value.trim().toLocaleLowerCase().replace(/\s+/g, "");
}

function meaningfulNames(character: StoryCharacter): Set<string> {
  const names = [character.name, ...character.aliases]
    .map(normalize)
    .filter((name) => name && !GENERIC_ALIASES.has(name));
  return new Set(names);
}

function charactersMayCollide(a: StoryCharacter, b: StoryCharacter): boolean {
  if (normalize(a.name) === normalize(b.name)) return true;
  const namesA = meaningfulNames(a);
  return [...meaningfulNames(b)].some((name) => namesA.has(name));
}

function conflictSourceRefs(
  existing: StoryFact | undefined,
  incoming: StoryFact | undefined,
): StorySourceRef[] {
  return mergeRefs(existing?.sourceRefs ?? [], incoming?.sourceRefs ?? []);
}

export function mergeStoryBible(
  bible: StoryBible,
  delta: StoryBibleDelta,
  chunk: NovelChunk,
): StoryBible {
  const version = bible.version + 1;
  const characters = bible.characters.map((character) => ({
    ...character,
    identityStatus: character.identityStatus ?? "confirmed",
    aliases: [...character.aliases],
    sourceRefs: mergeRefs([], character.sourceRefs),
  }));
  const facts = bible.facts.map((fact) => ({
    ...fact,
    sourceRefs: mergeRefs([], fact.sourceRefs),
  }));
  let timeline = bible.timeline.map((event) => ({
    ...event,
    characterIds: [...event.characterIds],
    sourceRefs: mergeRefs([], event.sourceRefs),
  }));
  const threads: StoryThread[] = bible.threads.map((thread) => ({
    ...thread,
    introducedAt: cloneRef(thread.introducedAt),
    resolvedAt: thread.resolvedAt ? cloneRef(thread.resolvedAt) : undefined,
  }));
  const conflicts: StoryConflict[] = bible.conflicts.map((conflict) => ({
    ...conflict,
    incomingFact: conflict.incomingFact
      ? {
          ...conflict.incomingFact,
          sourceRefs: mergeRefs([], conflict.incomingFact.sourceRefs),
        }
      : undefined,
    sourceRefs: mergeRefs([], conflict.sourceRefs),
    resolvedAt: conflict.resolvedAt
      ? mergeRefs([], conflict.resolvedAt)
      : undefined,
  }));
  let conflictIndex = 0;

  function addConflict(
    type: StoryConflictType,
    description: string,
    options: {
      existingFact?: StoryFact;
      incomingFact?: StoryFact;
      sourceRefs?: StorySourceRef[];
    } = {},
  ) {
    conflictIndex++;
    const conflict: StoryConflict = {
      id: `conflict_v${version}_${String(conflictIndex).padStart(3, "0")}`,
      type,
      description,
      status: "open",
      existingFactId: options.existingFact?.id,
      incomingFact: options.incomingFact
        ? {
            ...options.incomingFact,
            sourceRefs: mergeRefs([], options.incomingFact.sourceRefs),
          }
        : undefined,
      sourceRefs:
        options.sourceRefs ?? conflictSourceRefs(options.existingFact, options.incomingFact),
    };
    conflicts.push(conflict);
  }

  for (const incoming of delta.characters) {
    const byId = characters.find((character) => character.id === incoming.id);
    if (byId) {
      const identityChanged = normalize(byId.name) !== normalize(incoming.name);
      const aliasesCollide = characters.some(
        (character) => character.id !== incoming.id && charactersMayCollide(character, incoming),
      );
      if (identityChanged || aliasesCollide) {
        addConflict(
          "identity",
          identityChanged
            ? `人物 id「${incoming.id}」对应了不同姓名「${byId.name}」与「${incoming.name}」，未覆盖旧人物。`
            : `人物「${incoming.name}」的新别名与其他已有角色冲突，未自动合并。`,
          { sourceRefs: mergeRefs(byId.sourceRefs, incoming.sourceRefs) },
        );
        continue;
      }
      byId.aliases = [...new Set([...byId.aliases, ...incoming.aliases])];
      byId.description = byId.description || incoming.description;
      byId.sourceRefs = mergeRefs(byId.sourceRefs, incoming.sourceRefs);
      continue;
    }
    const possibleMatch = characters.find((character) => charactersMayCollide(character, incoming));
    if (possibleMatch) {
      addConflict(
        "identity",
        `人物「${incoming.name}」可能与已有角色「${possibleMatch.name}」重复，未自动合并。`,
        { sourceRefs: mergeRefs(possibleMatch.sourceRefs, incoming.sourceRefs) },
      );
      characters.push({
        ...incoming,
        identityStatus: "provisional",
        aliases: [...incoming.aliases],
        sourceRefs: mergeRefs([], incoming.sourceRefs),
      });
      continue;
    }
    characters.push({
      ...incoming,
      identityStatus: "confirmed",
      aliases: [...incoming.aliases],
      sourceRefs: mergeRefs([], incoming.sourceRefs),
    });
  }

  for (const incoming of delta.newFacts) {
    const sameId = facts.find((fact) => fact.id === incoming.id);
    if (sameId) {
      if (
        storyFactKey(sameId) === storyFactKey(incoming) &&
        sameStoryFactValue(sameId, incoming)
      ) {
        sameId.sourceRefs = mergeRefs(sameId.sourceRefs, incoming.sourceRefs);
      } else {
        addConflict("fact_id", `事实 id「${incoming.id}」对应了不同内容，未覆盖旧事实。`, {
          existingFact: sameId,
          incomingFact: incoming,
        });
      }
      continue;
    }

    const activeSameKey = facts.find(
      (fact) =>
        !fact.supersededByFactId &&
        storyFactKey(fact) === storyFactKey(incoming),
    );
    if (activeSameKey && sameStoryFactValue(activeSameKey, incoming)) {
      activeSameKey.sourceRefs = mergeRefs(activeSameKey.sourceRefs, incoming.sourceRefs);
      continue;
    }
    if (activeSameKey) {
      if (incoming.supersedesFactId === activeSameKey.id) {
        activeSameKey.supersededByFactId = incoming.id;
        facts.push({ ...incoming, sourceRefs: mergeRefs([], incoming.sourceRefs) });
      } else {
        addConflict(
          "fact_value",
          `「${incoming.subjectId}.${incoming.predicate}」出现不同取值，未采用“后文覆盖前文”。`,
          { existingFact: activeSameKey, incomingFact: incoming },
        );
      }
      continue;
    }
    facts.push({ ...incoming, sourceRefs: mergeRefs([], incoming.sourceRefs) });
  }

  for (const incoming of delta.timelineEvents) {
    const existing = timeline.find((event) => event.id === incoming.id);
    if (!existing) {
      timeline.push({
        ...incoming,
        characterIds: [...incoming.characterIds],
        sourceRefs: mergeRefs([], incoming.sourceRefs),
      });
      continue;
    }
    if (normalize(existing.summary) === normalize(incoming.summary)) {
      existing.sourceRefs = mergeRefs(existing.sourceRefs, incoming.sourceRefs);
    } else {
      addConflict("timeline", `时间线事件 id「${incoming.id}」对应了不同事件。`, {
        sourceRefs: mergeRefs(existing.sourceRefs, incoming.sourceRefs),
      });
    }
  }
  timeline = timeline
    .sort(
      (a, b) =>
        (a.sourceRefs[0]?.paragraphRange.start ?? Number.MAX_SAFE_INTEGER) -
        (b.sourceRefs[0]?.paragraphRange.start ?? Number.MAX_SAFE_INTEGER),
    )
    .map((event, index) => ({ ...event, order: index + 1 }));

  for (const incoming of delta.openedThreads) {
    const existing = threads.find((thread) => thread.id === incoming.id);
    if (!existing) {
      threads.push({ ...incoming, introducedAt: cloneRef(incoming.introducedAt) });
    } else if (normalize(existing.summary) !== normalize(incoming.summary)) {
      addConflict("thread", `伏笔 id「${incoming.id}」对应了不同内容。`, {
        sourceRefs: [existing.introducedAt, incoming.introducedAt],
      });
    }
  }
  for (const resolution of delta.resolvedThreads) {
    const thread = threads.find((item) => item.id === resolution.threadId);
    if (!thread) {
      addConflict("thread", `尝试解决不存在的伏笔「${resolution.threadId}」。`, {
        sourceRefs: [resolution.resolvedAt],
      });
      continue;
    }
    thread.status = "resolved";
    thread.resolvedAt = cloneRef(resolution.resolvedAt);
  }

  for (const reported of delta.reportedConflicts) {
    addConflict("reported", reported.description, { sourceRefs: reported.sourceRefs });
  }
  for (const resolution of delta.resolvedConflicts) {
    const conflict = conflicts.find((item) => item.id === resolution.conflictId);
    if (!conflict) continue;
    conflict.status = "resolved";
    conflict.resolution = resolution.explanation;
    conflict.resolutionType = resolution.resolutionType;
    conflict.resolvedByFactId = resolution.resolvedByFactId;
    conflict.resolvedAt = mergeRefs([], resolution.sourceRefs);
  }

  return {
    version,
    sourceFingerprint: bible.sourceFingerprint,
    processedRange: {
      start: bible.processedRange?.start ?? chunk.coreRange.start,
      end: chunk.coreRange.end,
    },
    characters,
    facts,
    timeline,
    threads,
    conflicts,
    boundaryState: {
      ...delta.boundaryState,
      characters: delta.boundaryState.characters.map((state) => ({
        ...state,
        knowledge: [...state.knowledge],
        activeGoals: [...state.activeGoals],
        sourceRefs: mergeRefs([], state.sourceRefs),
      })),
      objects: delta.boundaryState.objects.map((state) => ({
        ...state,
        sourceRefs: mergeRefs([], state.sourceRefs),
      })),
      openReferences: delta.boundaryState.openReferences.map((reference) => ({
        ...reference,
        candidateCharacterIds: [...reference.candidateCharacterIds],
        sourceRef: cloneRef(reference.sourceRef),
      })),
      sourceRefs: mergeRefs([], delta.boundaryState.sourceRefs),
    },
  };
}
