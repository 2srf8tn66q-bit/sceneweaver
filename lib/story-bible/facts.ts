export interface StoryFactLike {
  id?: unknown;
  kind?: unknown;
  subjectId?: unknown;
  predicate?: unknown;
  value?: unknown;
  perspectiveCharacterId?: unknown;
  supersedesFactId?: unknown;
}

const PREDICATE_ALIASES = new Map<string, string>([
  ["location", "current_location"],
  ["currently_at", "current_location"],
  ["位于", "current_location"],
  ["位置", "current_location"],
  ["physical_condition", "physical_state"],
  ["health_status", "physical_state"],
  ["身体状态", "physical_state"],
  ["alive_status", "life_status"],
  ["is_alive", "life_status"],
  ["生死", "life_status"],
  ["held_by", "holder"],
  ["owner", "holder"],
  ["持有人", "holder"],
  ["relation", "relationship"],
  ["关系", "relationship"],
  ["knowledge_state", "knows"],
  ["is_aware", "knows"],
  ["知情", "knows"],
]);

export function normalizeStoryText(value: unknown): string {
  return typeof value === "string"
    ? value.trim().toLocaleLowerCase().replace(/\s+/g, "")
    : "";
}

function canonicalPredicate(value: unknown): string {
  const normalized = normalizeStoryText(value).replace(/-/g, "_");
  return PREDICATE_ALIASES.get(normalized) ?? normalized;
}

export function storyFactKey(fact: StoryFactLike): string {
  return [
    normalizeStoryText(fact.kind),
    normalizeStoryText(fact.subjectId),
    canonicalPredicate(fact.predicate),
    normalizeStoryText(fact.perspectiveCharacterId),
  ].join(":");
}

export function sameStoryFactKey(
  first: StoryFactLike,
  second: StoryFactLike,
): boolean {
  return storyFactKey(first) === storyFactKey(second);
}

export function sameStoryFactValue(
  first: StoryFactLike,
  second: StoryFactLike,
): boolean {
  return normalizeStoryText(first.value) === normalizeStoryText(second.value);
}
