/**
 * The storage boundary.
 *
 * This is the only module in the frontend that calls `invoke`, and the only one
 * that knows a filesystem exists. No component imports `@tauri-apps/api`
 * directly. Keep that rule and a browser or cloud backend later means
 * rewriting this one file instead of hunting through the UI.
 *
 * Tauri maps camelCase arguments here to snake_case parameters in Rust, which
 * is why `projectPath` arrives as `project_path`.
 */

import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";

/** Mirrors `src-tauri/src/model.rs`. Change both together. */
export type SceneMeta = {
  id: string;
  title: string;
  file: string;
  status: string;
};

export type Chapter = {
  id: string;
  title: string;
  scenes: SceneMeta[];
};

export type Act = {
  id: string;
  title: string;
  chapters: Chapter[];
};

export type Project = {
  formatVersion: number;
  title: string;
  acts: Act[];
};

/** Ask the user for a project folder. Returns null if they cancelled. */
export async function pickProjectFolder(): Promise<string | null> {
  const chosen = await open({
    directory: true,
    multiple: false,
    title: "Open a Tramoire project",
  });
  return typeof chosen === "string" ? chosen : null;
}

/** Ask where a new project should be put. Returns null if they cancelled. */
export async function pickParentFolder(): Promise<string | null> {
  const chosen = await open({
    directory: true,
    multiple: false,
    title: "Where should the project go?",
  });
  return typeof chosen === "string" ? chosen : null;
}

export function openProject(path: string): Promise<Project> {
  return invoke("open_project", { path });
}

/**
 * Make a project folder under `parentPath` and resolve to its path.
 *
 * Deliberately does not return the project: the caller opens the result like
 * any other folder, so there is one definition of what opening means and
 * creation cannot drift away from it.
 */
export function createProject(parentPath: string, title: string): Promise<string> {
  return invoke("create_project", { parentPath, title });
}

export function readScene(projectPath: string, file: string): Promise<string> {
  return invoke("read_scene", { projectPath, file });
}

export function writeScene(projectPath: string, file: string, content: string): Promise<void> {
  return invoke("write_scene", { projectPath, file, content });
}

/**
 * Retitle a scene.
 *
 * Resolves to the manifest as it now stands on disk. Replace the whole project
 * in state with what comes back rather than patching the copy you already have:
 * the folder may be in a sync client, and Rust re-reads before it writes, so the
 * return value is the only thing guaranteed to match the file.
 */
export function renameScene(
  projectPath: string,
  sceneId: string,
  title: string
): Promise<Project> {
  return invoke("rename_scene", { projectPath, sceneId, title });
}

/**
 * Move a scene to a position in an act, which may be the one it is already in.
 *
 * `index` is a position in the destination act once the scene has been lifted
 * out of wherever it was — see `nextPosition` in `binder.ts`, which is the only
 * thing that should be computing one.
 */
export function moveScene(
  projectPath: string,
  sceneId: string,
  toChapterId: string,
  toIndex: number
): Promise<Project> {
  return invoke("move_scene", { projectPath, sceneId, toChapterId, toIndex });
}

/** What `createScene` gives back. Mirrors `Created` in `model.rs`. */
export type Created = {
  project: Project;
  scene: SceneMeta;
};

/** Add an empty scene to a chapter, at `toIndex` within it. */
export function createScene(
  projectPath: string,
  chapterId: string,
  title: string,
  toIndex: number
): Promise<Created> {
  return invoke("create_scene", { projectPath, chapterId, title, toIndex });
}

/**
 * Take a scene out of the book.
 *
 * The markdown file moves to `trash/` inside the project folder rather than
 * being destroyed, so this is undoable by hand. Callers still confirm first —
 * see `components/Confirm.tsx` — because a scene vanishing from the binder is
 * alarming even when the prose is safe.
 */
export function deleteScene(projectPath: string, sceneId: string): Promise<Project> {
  return invoke("delete_scene", { projectPath, sceneId });
}

/* ------------------------------------------------------------------ acts */

export function createAct(projectPath: string, title: string, toIndex: number): Promise<Project> {
  return invoke("create_act", { projectPath, title, toIndex });
}

export function renameAct(projectPath: string, actId: string, title: string): Promise<Project> {
  return invoke("rename_act", { projectPath, actId, title });
}

export function moveAct(projectPath: string, actId: string, toIndex: number): Promise<Project> {
  return invoke("move_act", { projectPath, actId, toIndex });
}

/** What becomes of what a container holds. Mirrors `Contents` in Rust. */
export type Contents = "move" | "trash";

/**
 * Delete an act, moving its chapters into the neighbouring act or sending
 * every scene file inside it to `trash/`. The last act cannot be deleted — a
 * project with no acts has nowhere to put a chapter.
 */
export function deleteAct(
  projectPath: string,
  actId: string,
  contents: Contents
): Promise<Project> {
  return invoke("delete_act", { projectPath, actId, contents });
}

/* -------------------------------------------------------------- chapters */

export function createChapter(
  projectPath: string,
  actId: string,
  title: string,
  toIndex: number
): Promise<Project> {
  return invoke("create_chapter", { projectPath, actId, title, toIndex });
}

export function renameChapter(
  projectPath: string,
  chapterId: string,
  title: string
): Promise<Project> {
  return invoke("rename_chapter", { projectPath, chapterId, title });
}

export function moveChapter(
  projectPath: string,
  chapterId: string,
  toActId: string,
  toIndex: number
): Promise<Project> {
  return invoke("move_chapter", { projectPath, chapterId, toActId, toIndex });
}

/**
 * Delete a chapter, moving its scenes into the chapter before it in reading
 * order or sending their files to `trash/`. Moving is impossible when it is
 * the only chapter in the project.
 */
export function deleteChapter(
  projectPath: string,
  chapterId: string,
  contents: Contents
): Promise<Project> {
  return invoke("delete_chapter", { projectPath, chapterId, contents });
}

/** Flatten the tree for anything that needs chapters in reading order. */
export function allChapters(project: Project | null): Chapter[] {
  return project?.acts.flatMap((act) => act.chapters) ?? [];
}

/** Flatten the tree for anything that needs scenes in reading order. */
export function allScenes(project: Project | null): SceneMeta[] {
  return allChapters(project).flatMap((chapter) => chapter.scenes);
}
