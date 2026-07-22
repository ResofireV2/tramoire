/**
 * Where a scene lands when it moves.
 *
 * Pure arithmetic over the act tree — no filesystem, no React. The index this
 * produces means the same thing `move_scene` means in Rust: a position in the
 * destination act *after* the scene has been lifted out of wherever it was.
 */

import type { Project } from "./storage";

export type Position = { actId: string; index: number };

/**
 * Where an act lands when nudged one step, or null at the ends of the book.
 *
 * Same post-removal convention as everything else here: the index is a position
 * in the act list once the act has been lifted out of it.
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

/** A gap between rows in the binder: `index` scenes sit above it. */
export type Slot = { actId: string; index: number };

/**
 * Where a dragged scene lands when dropped into a slot, or null if the drop
 * would not move it.
 *
 * A slot is measured against the tree as it looks during the drag, with the
 * scene still in it. `move_scene` wants the index after the scene is lifted
 * out, so a slot below the scene's own position in its own act is one too high.
 */
export function dropPosition(
  project: Project | null,
  sceneId: string,
  slot: Slot
): Position | null {
  if (!project) return null;

  const act = project.acts.find((a) => a.scenes.some((scene) => scene.id === sceneId));
  if (!act) return null;

  const from = act.scenes.findIndex((scene) => scene.id === sceneId);
  const sameAct = slot.actId === act.id;

  const index = sameAct && slot.index > from ? slot.index - 1 : slot.index;

  // Both slots either side of a scene leave it exactly where it was. A drag
  // that ends where it started should cost nothing, not a manifest write.
  if (sameAct && index === from) return null;

  return { actId: slot.actId, index };
}

/**
 * The position a scene moves to when nudged one step, or null if there is
 * nowhere left to go — the top of the first act or the end of the last.
 *
 * Stepping off the end of an act carries into the next one, so holding the key
 * walks a scene through the whole manuscript rather than stopping at a boundary.
 */
export function nextPosition(
  project: Project | null,
  sceneId: string,
  direction: "up" | "down"
): Position | null {
  if (!project) return null;

  const actIndex = project.acts.findIndex((act) =>
    act.scenes.some((scene) => scene.id === sceneId)
  );
  if (actIndex === -1) return null;

  const act = project.acts[actIndex];
  const index = act.scenes.findIndex((scene) => scene.id === sceneId);

  if (direction === "up") {
    // Within the act, the slot above is index - 1. Removal happens first, but
    // everything above the scene keeps its position, so no adjustment.
    if (index > 0) return { actId: act.id, index: index - 1 };

    const previous = project.acts[actIndex - 1];
    return previous ? { actId: previous.id, index: previous.scenes.length } : null;
  }

  // Downward is the one that needs care: index + 1 rather than index + 2,
  // because lifting the scene out shifts its successor up into its place.
  if (index < act.scenes.length - 1) return { actId: act.id, index: index + 1 };

  const next = project.acts[actIndex + 1];
  return next ? { actId: next.id, index: 0 } : null;
}
