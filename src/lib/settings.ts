/**
 * What the application remembers between runs.
 *
 * Kept with the application, never in a project folder — the same rule that
 * keeps font size out of a shared project. The file itself is written by Rust
 * into the OS config directory; everything here is the pure part: what the
 * shape is, and what happens to a list of recent projects when one is opened
 * or turns out to have gone.
 */

import type { Chrome, EditorTheme, Theme } from "./theme";

export type Recent = {
  path: string;
  title: string;
};

export type Settings = {
  theme: Theme;
  /** Most recently opened first. */
  recent: Recent[];
  lastParent: string | null;
};

/** Long enough to cover what someone is working on, short enough to read. */
const LIMIT = 8;

export const DEFAULTS: Settings = {
  theme: { chrome: "dark", editor: "paper" },
  recent: [],
  lastParent: null,
};

/**
 * Settings that came from somewhere else, made safe to use.
 *
 * Every read is defensive: this is the one piece of state that outlives a
 * version, so it has to cope with whatever an older build, a newer build, or a
 * half-written file left behind rather than taking the window down on launch.
 */
export function sane(value: unknown): Settings {
  const raw = (value ?? {}) as Partial<Settings>;
  const theme = (raw.theme ?? {}) as Partial<Theme>;

  return {
    theme: {
      chrome: (theme.chrome === "light" ? "light" : "dark") as Chrome,
      editor: (theme.editor === "ink" ? "ink" : "paper") as EditorTheme,
    },
    recent: Array.isArray(raw.recent)
      ? raw.recent
          .filter(
            (entry): entry is Recent =>
              typeof entry?.path === "string" && typeof entry?.title === "string"
          )
          .slice(0, LIMIT)
      : [],
    lastParent: typeof raw.lastParent === "string" ? raw.lastParent : null,
  };
}

/** Put a project at the top of the list, keeping one entry per path. */
export function remember(recent: Recent[], entry: Recent): Recent[] {
  return [entry, ...recent.filter((old) => old.path !== entry.path)].slice(0, LIMIT);
}

/** Drop a project, for one that turns out to have moved or been deleted. */
export function forget(recent: Recent[], path: string): Recent[] {
  return recent.filter((entry) => entry.path !== path);
}
