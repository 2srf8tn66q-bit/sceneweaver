import type { ParagraphRange } from "../novel/types";

export interface StorySourceRef {
  chapterId: string;
  chunkId: string;
  paragraphRange: ParagraphRange;
}

export type StoryFactKind =
  | "character"
  | "relationship"
  | "timeline"
  | "location"
  | "object"
  | "knowledge"
  | "constraint";

export type StoryFactStatus =
  | "source_fact"
  | "adaptation_decision"
  | "uncertain"
  | "conflict";

export interface StoryFact {
  id: string;
  kind: StoryFactKind;
  subjectId: string;
  predicate: string;
  value: string;
  statement: string;
  status: StoryFactStatus;
  perspectiveCharacterId?: string;
  supersedesFactId?: string;
  supersessionReason?: "state_change" | "correction" | "reveal";
  supersededByFactId?: string;
  sourceRefs: StorySourceRef[];
}

export interface StoryCharacter {
  id: string;
  name: string;
  aliases: string[];
  description?: string;
  identityStatus?: "confirmed" | "provisional";
  sourceRefs: StorySourceRef[];
}

export interface StoryTimelineEvent {
  id: string;
  summary: string;
  order: number;
  characterIds: string[];
  sourceRefs: StorySourceRef[];
}

export interface StoryThread {
  id: string;
  summary: string;
  status: "open" | "resolved";
  introducedAt: StorySourceRef;
  resolvedAt?: StorySourceRef;
}

export interface StoryThreadResolution {
  threadId: string;
  resolvedAt: StorySourceRef;
}

export interface BoundaryCharacterState {
  characterId: string;
  location?: string;
  physicalState?: string;
  knowledge: string[];
  activeGoals: string[];
  sourceRefs: StorySourceRef[];
}

export interface BoundaryObjectState {
  objectId: string;
  holderCharacterId?: string;
  location?: string;
  state?: string;
  sourceRefs: StorySourceRef[];
}

export interface BoundaryOpenReference {
  text: string;
  candidateCharacterIds: string[];
  sourceRef: StorySourceRef;
}

export interface StoryBoundaryState {
  chunkId: string;
  asOfParagraph: number;
  timeLabel?: string;
  location?: string;
  characters: BoundaryCharacterState[];
  objects: BoundaryObjectState[];
  openReferences: BoundaryOpenReference[];
  sourceRefs: StorySourceRef[];
}

export type StoryConflictType =
  | "fact_value"
  | "fact_id"
  | "identity"
  | "timeline"
  | "thread"
  | "reported";

export interface StoryReportedConflict {
  description: string;
  sourceRefs: StorySourceRef[];
}

export interface StoryConflict {
  id: string;
  type: StoryConflictType;
  description: string;
  status: "open" | "resolved";
  existingFactId?: string;
  incomingFact?: StoryFact;
  sourceRefs: StorySourceRef[];
  resolution?: string;
  resolutionType?: StoryConflictResolutionType;
  resolvedByFactId?: string;
  resolvedAt?: StorySourceRef[];
}

export type StoryConflictResolutionType =
  | "confirmed_existing"
  | "confirmed_incoming"
  | "state_change"
  | "correction";

export interface StoryConflictResolution {
  conflictId: string;
  resolutionType: StoryConflictResolutionType;
  resolvedByFactId?: string;
  explanation: string;
  sourceRefs: StorySourceRef[];
}

export interface StoryBible {
  version: number;
  sourceFingerprint: string | null;
  processedRange: ParagraphRange | null;
  characters: StoryCharacter[];
  facts: StoryFact[];
  timeline: StoryTimelineEvent[];
  threads: StoryThread[];
  conflicts: StoryConflict[];
  boundaryState: StoryBoundaryState | null;
}

export interface StoryBibleDelta {
  chunkId: string;
  processedRange: ParagraphRange;
  characters: StoryCharacter[];
  newFacts: StoryFact[];
  timelineEvents: StoryTimelineEvent[];
  openedThreads: StoryThread[];
  resolvedThreads: StoryThreadResolution[];
  reportedConflicts: StoryReportedConflict[];
  resolvedConflicts: StoryConflictResolution[];
  boundaryState: StoryBoundaryState;
}
