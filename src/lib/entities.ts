/**
 * Grouping entities by what they are.
 *
 * A type is just a word someone typed, so the rail is built from the words in
 * use rather than a list in the code. Three starters are always offered — a
 * project with no entities still needs somewhere to make the first one — and
 * anything else found in the folder joins them.
 */

import type { Entity } from "./storage";

/** Offered even when empty, because every novel has some of these. */
const STARTERS = ["character", "location", "item"];

/** Every type worth a place in the rail, starters first. */
export function types(entities: Entity[]): string[] {
  const found = entities.map((entity) => entity.type).filter(Boolean);
  const extra = [...new Set(found)].filter((type) => !STARTERS.includes(type)).sort();

  return [...STARTERS, ...extra];
}

export function ofType(entities: Entity[], type: string): Entity[] {
  return entities.filter((entity) => entity.type === type);
}

/**
 * A type as a heading: plural and capitalised.
 *
 * Deliberately naive. It is a label over a list, not prose, and the cost of
 * getting an unusual word wrong is that a heading reads oddly.
 */
export function label(type: string): string {
  if (!type) return "Everything else";

  const plural = /(s|x|z|ch|sh)$/.test(type)
    ? `${type}es`
    : /[^aeiou]y$/.test(type)
      ? `${type.slice(0, -1)}ies`
      : `${type}s`;

  return plural.charAt(0).toUpperCase() + plural.slice(1);
}
