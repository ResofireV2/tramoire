/**
 * Two independent theme axes: the chrome around the manuscript, and the
 * manuscript itself. They are separate settings because the default is a dark
 * shell around a light paper column, and that mix has to survive someone
 * changing one half of it.
 *
 * Theme is a display setting, so it lives with the app, never in the project
 * folder — a shared project should not carry someone else's colour scheme. It
 * is persisted with the rest of the settings, in the OS config directory; all
 * that is left here is the shape and how it reaches the page.
 */

export type Chrome = "dark" | "light";
export type EditorTheme = "paper" | "ink";

export type Theme = {
  chrome: Chrome;
  editor: EditorTheme;
};

export const DEFAULT_THEME: Theme = { chrome: "dark", editor: "paper" };

export function applyTheme(theme: Theme): void {
  const root = document.documentElement;
  root.dataset.chrome = theme.chrome;
  root.dataset.editor = theme.editor;
}
