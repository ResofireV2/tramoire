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

/** Flatten the act tree for anything that needs scenes in reading order. */
export function allScenes(project: Project | null): SceneMeta[] {
  return project?.acts.flatMap((act) => act.scenes) ?? [];
}
