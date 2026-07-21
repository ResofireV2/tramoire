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

export type Act = {
  id: string;
  title: string;
  scenes: SceneMeta[];
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

export function openProject(path: string): Promise<Project> {
  return invoke("open_project", { path });
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
  toActId: string,
  toIndex: number
): Promise<Project> {
  return invoke("move_scene", { projectPath, sceneId, toActId, toIndex });
}

/** What `createScene` gives back. Mirrors `Created` in `model.rs`. */
export type Created = {
  project: Project;
  scene: SceneMeta;
};

/** Add an empty scene to an act, at `toIndex` within it. */
export function createScene(
  projectPath: string,
  actId: string,
  title: string,
  toIndex: number
): Promise<Created> {
  return invoke("create_scene", { projectPath, actId, title, toIndex });
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

/** Flatten the act tree for anything that needs scenes in reading order. */
export function allScenes(project: Project | null): SceneMeta[] {
  return project?.acts.flatMap((act) => act.scenes) ?? [];
}
