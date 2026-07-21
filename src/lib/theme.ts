/**
 * Two independent theme axes: the chrome around the manuscript, and the
 * manuscript itself. They are separate settings because the default is a dark
 * shell around a light paper column, and that mix has to survive someone
 * changing one half of it.
 *
 * Theme is a display setting, so it lives with the app, never in the project
 * folder — a shared project should not carry someone else's colour scheme.
 * localStorage is the Phase 1 store; moving it to the OS config directory later
 * means changing `load` and `save` here and nothing else.
 */

export type Chrome = "dark" | "light";
export type EditorTheme = "paper" | "ink";

export type Theme = {
  chrome: Chrome;
  editor: EditorTheme;
};

export const DEFAULT_THEME: Theme = { chrome: "dark", editor: "paper" };

const KEY = "tramoire.theme";

export function loadTheme(): Theme {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return DEFAULT_THEME;
    const parsed = JSON.parse(raw) as Partial<Theme>;
    return {
      chrome: parsed.chrome === "light" ? "light" : "dark",
      editor: parsed.editor === "ink" ? "ink" : "paper",
    };
  } catch {
    return DEFAULT_THEME;
  }
}

export function saveTheme(theme: Theme): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(theme));
  } catch {
    // A theme that fails to persist is not worth interrupting anyone over.
  }
}

export function applyTheme(theme: Theme): void {
  const root = document.documentElement;
  root.dataset.chrome = theme.chrome;
  root.dataset.editor = theme.editor;
}
