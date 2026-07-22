/**
 * Which projects were open lately, and where the last one was made.
 *
 * An application setting, not project data — the same rule that keeps font size
 * out of the project folder. localStorage is the Phase 1 store, as it is for
 * the theme; moving both to the OS config directory later means changing these
 * functions and nothing else.
 *
 * Every read is defensive. This is the one piece of state that survives a
 * version change, so it has to cope with whatever an older or half-written
 * entry left behind rather than taking the window down on launch.
 */

export type Recent = {
  path: string;
  title: string;
};

const PROJECTS = "tramoire.recent";
const PARENT = "tramoire.lastParent";

/** Long enough to cover what someone is actually working on, short enough to read. */
const LIMIT = 8;

export function loadRecent(): Recent[] {
  try {
    const raw = localStorage.getItem(PROJECTS);
    if (!raw) return [];

    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];

    return parsed
      .filter(
        (entry): entry is Recent =>
          typeof entry?.path === "string" && typeof entry?.title === "string"
      )
      .slice(0, LIMIT);
  } catch {
    return [];
  }
}

/** Put a project at the top of the list, keeping one entry per path. */
export function remember(entry: Recent): Recent[] {
  const next = [entry, ...loadRecent().filter((old) => old.path !== entry.path)].slice(0, LIMIT);
  save(PROJECTS, JSON.stringify(next));
  return next;
}

/** Drop a project — used when one turns out to have moved or been deleted. */
export function forget(path: string): Recent[] {
  const next = loadRecent().filter((entry) => entry.path !== path);
  save(PROJECTS, JSON.stringify(next));
  return next;
}

/** Where the last project was created, to save choosing it again. */
export function loadLastParent(): string | null {
  try {
    return localStorage.getItem(PARENT);
  } catch {
    return null;
  }
}

export function saveLastParent(path: string): void {
  save(PARENT, path);
}

function save(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // A list of recent projects that fails to persist is not worth
    // interrupting anyone over.
  }
}
