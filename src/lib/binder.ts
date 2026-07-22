/**
 * Where something lands when it moves.
 *
 * Pure arithmetic over the tree — no filesystem, no React. Indices mean what
 * they mean in Rust: a position in the destination *after* the thing being
 * moved has been lifted out of wherever it was.
 *
 * A scene inside a chapter and a chapter inside an act are the same problem, so
 * they share one implementation. The off-by-one that makes a downward move
 * different from an upward one is subtle enough that having it written twice
 * would be having it wrong once.
 */

import { allChapters, type Project } from "./storage";

/** A destination: something to go into, and where inside it. */
export type Spot = {
  /** A chapter id when moving a scene, an act id when moving a chapter. */
  parentId: string;
  index: number;
};

/** A gap in the binder, measured against the tree as it looks now. */
export type Slot = Spot;

/** A container and what is in it, which is all the arithmetic needs to know. */
type Level = {
  id: string;
  items: { id: string }[];
};

const chapterLevels = (project: Project | null): Level[] =>
  allChapters(project).map((chapter) => ({ id: chapter.id, items: chapter.scenes }));

const actLevels = (project: Project | null): Level[] =>
  project?.acts.map((act) => ({ id: act.id, items: act.chapters })) ?? [];

/* --------------------------------------------------------------- stepping */

/**
 * One step up or down, crossing into the neighbouring container at the ends.
 * Null when there is nowhere left to go.
 */
function step(levels: Level[], childId: string, direction: "up" | "down"): Spot | null {
  const at = levels.findIndex((level) => level.items.some((item) => item.id === childId));
  if (at === -1) return null;

  const level = levels[at];
  const index = level.items.findIndex((item) => item.id === childId);

  if (direction === "up") {
    // Within the container the slot above is index - 1: everything above keeps
    // its position when the item is lifted out, so no adjustment.
    if (index > 0) return { parentId: level.id, index: index - 1 };

    const previous = levels[at - 1];
    return previous ? { parentId: previous.id, index: previous.items.length } : null;
  }

  // Downward is the one that needs care: index + 1 rather than index + 2,
  // because lifting the item out shifts its successor up into its place.
  if (index < level.items.length - 1) return { parentId: level.id, index: index + 1 };

  const next = levels[at + 1];
  return next ? { parentId: next.id, index: 0 } : null;
}

/** Where a scene goes when nudged. `parentId` is a chapter. */
export function nextPosition(
  project: Project | null,
  sceneId: string,
  direction: "up" | "down"
): Spot | null {
  return step(chapterLevels(project), sceneId, direction);
}

/** Where a chapter goes when nudged. `parentId` is an act. */
export function nextChapterPosition(
  project: Project | null,
  chapterId: string,
  direction: "up" | "down"
): Spot | null {
  return step(actLevels(project), chapterId, direction);
}

/**
 * Where an act goes when nudged. Acts sit in no container, so this is an index
 * on its own rather than a spot.
 */
export function nextActPosition(
  project: Project | null,
  actId: string,
  direction: "up" | "down"
): number | null {
  if (!project) return null;

  const index = project.acts.findIndex((act) => act.id === actId);
  if (index === -1) return null;

  if (direction === "up") return index > 0 ? index - 1 : null;
  return index < project.acts.length - 1 ? index + 1 : null;
}

/* --------------------------------------------------------------- dropping */

/**
 * Where a dragged item lands when dropped into a slot, or null if the drop
 * would not move it.
 *
 * A slot is measured against the tree as it looks during the drag, with the
 * item still in it, so a slot below the item's own position in its own
 * container is one too high.
 */
function land(levels: Level[], childId: string, slot: Slot): Spot | null {
  const level = levels.find((l) => l.items.some((item) => item.id === childId));
  if (!level) return null;

  const from = level.items.findIndex((item) => item.id === childId);
  const same = slot.parentId === level.id;

  const index = same && slot.index > from ? slot.index - 1 : slot.index;

  // Both slots either side of an item leave it exactly where it was. A drag
  // that ends where it started should cost nothing, not a manifest write.
  if (same && index === from) return null;

  return { parentId: slot.parentId, index };
}

export function dropPosition(
  project: Project | null,
  sceneId: string,
  slot: Slot
): Spot | null {
  return land(chapterLevels(project), sceneId, slot);
}

export function dropChapterPosition(
  project: Project | null,
  chapterId: string,
  slot: Slot
): Spot | null {
  return land(actLevels(project), chapterId, slot);
}
