import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useEditor } from "@tiptap/react";

import { Binder } from "./components/Binder";
import { useConfirm } from "./components/Confirm";
import { useNewProject } from "./components/NewProject";
import { SceneEditor } from "./components/SceneEditor";
import { StatusBar } from "./components/StatusBar";
import { TopBar } from "./components/TopBar";

import { createSaver, type SaveState, type SaveTarget } from "./lib/autosave";
import type { Spot } from "./lib/binder";
import { editorProps, editorText, extensions } from "./lib/editor";
import { countWords, docToMd, mdToDoc } from "./lib/markdown";
import * as recent from "./lib/recent";
import * as storage from "./lib/storage";
import { applyTheme, loadTheme, saveTheme, type Theme } from "./lib/theme";

const count = (n: number, noun: string) => `${n} ${noun}${n === 1 ? "" : "s"}`;

export default function App() {
  const [project, setProject] = useState<storage.Project | null>(null);
  const [projectPath, setProjectPath] = useState<string | null>(null);
  const [scene, setScene] = useState<storage.SceneMeta | null>(null);

  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [saveError, setSaveError] = useState<string | null>(null);
  const [words, setWords] = useState(0);

  const [theme, setTheme] = useState<Theme>(loadTheme);
  const [recentProjects, setRecent] = useState<recent.Recent[]>(recent.loadRecent);

  // The scene the binder should open its rename field on, set when a scene is
  // made rather than chosen. Cleared once the binder has acted on it.
  const [renaming, setRenaming] = useState<string | null>(null);

  // `ask` is stable; the dialog node is not, so depend on the function alone
  // rather than the pair, or every render invalidates the delete handler.
  const { ask, dialog: confirmDialog } = useConfirm();
  const { ask: askNewProject, dialog: newProjectDialog } = useNewProject(storage.pickParentFolder);

  useEffect(() => {
    applyTheme(theme);
    saveTheme(theme);
  }, [theme]);

  // The save target is captured when a write is queued, not when it fires.
  const targetRef = useRef<SaveTarget | null>(null);
  // Set while content is being replaced programmatically, so a load can never
  // look like a keystroke.
  const loadingRef = useRef(false);

  const saver = useMemo(
    () =>
      createSaver(
        (target, content) => storage.writeScene(target.projectPath, target.file, content),
        (state, detail) => {
          setSaveState(state);
          setSaveError(detail ?? null);
        }
      ),
    []
  );

  const editor = useEditor({
    extensions,
    editorProps,
    content: "",
    onUpdate: ({ editor }) => {
      setWords(countWords(editorText(editor)));
      if (loadingRef.current) return;

      const target = targetRef.current;
      if (!target) return;

      saver.queue(target, docToMd(editor.getJSON()));
    },
  });

  /* --------------------------------------------------------------- actions */

  /**
   * The one way a project becomes the open one, whichever route asked for it —
   * the picker, the recent list, a project just created, or the last one at
   * launch. `quiet` is for that last case: a folder that has been moved or
   * deleted since the previous session should drop off the list, not greet
   * someone with an error they did not ask for.
   */
  const open = useCallback(
    async (folder: string, quiet = false) => {
      try {
        const opened = await storage.openProject(folder);
        await saver.flush();
        saver.cancel();

        setProject(opened);
        setProjectPath(folder);
        setScene(null);
        targetRef.current = null;
        setSaveState("idle");
        setSaveError(null);
        setWords(0);
        editor?.commands.clearContent();

        setRecent(recent.remember({ path: folder, title: opened.title }));
        return opened;
      } catch (error) {
        setRecent(recent.forget(folder));

        if (!quiet) {
          setSaveState("error");
          setSaveError(String(error));
        }
        return null;
      }
    },
    [editor, saver]
  );

  const openProject = useCallback(async () => {
    const folder = await storage.pickProjectFolder();
    if (folder) await open(folder);
  }, [open]);


  /**
   * Takes the project path rather than reading it from state, because opening a
   * project and loading its first scene happen in the same tick: `projectPath`
   * is still the previous value at that point, and a new project would load
   * nothing at all.
   */
  const loadSceneFrom = useCallback(
    async (path: string, meta: storage.SceneMeta) => {
      if (!editor) return;

      // Anything still pending belongs to the scene being left.
      await saver.flush();

      try {
        const markdown = await storage.readScene(path, meta.file);

        loadingRef.current = true;
        editor.commands.setContent(mdToDoc(markdown), { emitUpdate: false });
        loadingRef.current = false;

        targetRef.current = { projectPath: path, file: meta.file };
        setScene(meta);
        setWords(countWords(editorText(editor)));
        setSaveState("idle");
        setSaveError(null);
      } catch (error) {
        setSaveState("error");
        setSaveError(String(error));
      }
    },
    [editor, saver]
  );

  const loadScene = useCallback(
    async (meta: storage.SceneMeta) => {
      if (!projectPath || meta.id === scene?.id) return;
      await loadSceneFrom(projectPath, meta);
    },
    [loadSceneFrom, projectPath, scene?.id]
  );

  const newProject = useCallback(async () => {
    const answer = await askNewProject({ parent: recent.loadLastParent() });
    if (!answer) return;

    try {
      const folder = await storage.createProject(answer.parent, answer.title);
      recent.saveLastParent(answer.parent);

      const opened = await open(folder);

      // Straight into the scene it was given, with the name selected: a new
      // project should put a cursor somewhere, not ask what to do next.
      const [first] = storage.allScenes(opened);
      if (first) {
        await loadSceneFrom(folder, first);
        setRenaming(first.id);
      }
    } catch (error) {
      setSaveState("error");
      setSaveError(String(error));
    }
  }, [askNewProject, loadSceneFrom, open]);

  const renameScene = useCallback(
    async (meta: storage.SceneMeta, title: string) => {
      if (!projectPath) return;

      // Retitling can move the file underneath this scene. Anything queued
      // belongs to the name it had a moment ago, so it goes out first.
      if (targetRef.current?.file === meta.file) await saver.flush();

      try {
        const updated = await storage.renameScene(projectPath, meta.id, title);
        const fresh = storage.allScenes(updated).find((s) => s.id === meta.id);

        setProject(updated);
        // Take the scene back out of the manifest that was returned rather than
        // patching the one in hand, so state and disk cannot drift apart.
        setScene((current) => (current?.id === meta.id ? fresh ?? current : current));

        // And point the next save at wherever the file ended up, or it would
        // write the scene back out under its old name.
        if (fresh && targetRef.current?.file === meta.file) {
          targetRef.current = { projectPath, file: fresh.file };
        }
      } catch (error) {
        setSaveState("error");
        setSaveError(String(error));
      }
    },
    [projectPath, saver]
  );

  const moveScene = useCallback(
    async (meta: storage.SceneMeta, to: Spot) => {
      if (!projectPath) return;

      try {
        setProject(await storage.moveScene(projectPath, meta.id, to.parentId, to.index));
      } catch (error) {
        setSaveState("error");
        setSaveError(String(error));
      }
    },
    [projectPath]
  );

  const createScene = useCallback(
    async (chapter: storage.Chapter) => {
      if (!projectPath) return null;

      try {
        const made = await storage.createScene(
          projectPath,
          chapter.id,
          "Untitled scene",
          chapter.scenes.length
        );

        setProject(made.project);
        await loadScene(made.scene);
        return made.scene;
      } catch (error) {
        setSaveState("error");
        setSaveError(String(error));
        return null;
      }
    },
    [loadScene, projectPath]
  );

  const deleteScene = useCallback(
    async (meta: storage.SceneMeta) => {
      if (!projectPath) return;

      const go = await ask({
        title: `Move “${meta.title}” to trash?`,
        body:
          "The markdown file moves to the trash folder inside the project. " +
          "It stays on disk, and moving it back restores the scene.",
        choices: [{ key: "trash", label: "Move to trash", danger: true }],
        cancelLabel: "Keep",
      });
      if (go !== "trash") return;

      // A queued write belonging to this scene would recreate the file that is
      // about to move to trash, leaving an orphan nothing points at.
      if (targetRef.current?.file === meta.file) {
        saver.cancel();
        targetRef.current = null;
      }

      try {
        setProject(await storage.deleteScene(projectPath, meta.id));

        if (scene?.id === meta.id) {
          setScene(null);
          editor?.commands.clearContent();
          setWords(0);
          setSaveState("idle");
          setSaveError(null);
        }
      } catch (error) {
        setSaveState("error");
        setSaveError(String(error));
      }
    },
    [ask, editor, projectPath, saver, scene?.id]
  );

  /* ------------------------------------------------------------- chapters */

  const createChapter = useCallback(
    async (act: storage.Act) => {
      if (!projectPath) return null;

      try {
        const updated = await storage.createChapter(
          projectPath,
          act.id,
          "Untitled chapter",
          act.chapters.length
        );

        setProject(updated);

        const fresh = updated.acts.find((a) => a.id === act.id);
        return fresh?.chapters[fresh.chapters.length - 1] ?? null;
      } catch (error) {
        setSaveState("error");
        setSaveError(String(error));
        return null;
      }
    },
    [projectPath]
  );

  const renameChapter = useCallback(
    async (chapter: storage.Chapter, title: string) => {
      if (!projectPath) return;

      try {
        setProject(await storage.renameChapter(projectPath, chapter.id, title));
      } catch (error) {
        setSaveState("error");
        setSaveError(String(error));
      }
    },
    [projectPath]
  );

  const moveChapter = useCallback(
    async (chapter: storage.Chapter, to: Spot) => {
      if (!projectPath) return;

      try {
        setProject(await storage.moveChapter(projectPath, chapter.id, to.parentId, to.index));
      } catch (error) {
        setSaveState("error");
        setSaveError(String(error));
      }
    },
    [projectPath]
  );

  const deleteChapter = useCallback(
    async (chapter: storage.Chapter) => {
      if (!projectPath || !project) return;

      let contents: storage.Contents = "move";

      if (chapter.scenes.length > 0) {
        // The chapter before it in reading order, which may be in another act.
        const all = storage.allChapters(project);
        const at = all.findIndex((c) => c.id === chapter.id);
        const into: storage.Chapter | undefined = all[at - 1] ?? all[at + 1];

        const answer = await ask({
          title: `Delete “${chapter.title}”?`,
          body: into
            ? `It holds ${count(chapter.scenes.length, "scene")}. They can join ` +
              `“${into.title}” instead, or go to the trash folder with their files.`
            : `It holds ${count(chapter.scenes.length, "scene")}, and it is the only ` +
              `chapter in the project, so there is nowhere for them to move to.`,
          choices: [
            ...(into ? [{ key: "move", label: `Move scenes to “${into.title}”` }] : []),
            { key: "trash", label: "Move everything to trash", danger: true },
          ],
          cancelLabel: "Cancel",
        });

        if (answer !== "move" && answer !== "trash") return;
        contents = answer;
      }

      if (chapter.scenes.some((s) => s.file === targetRef.current?.file)) {
        saver.cancel();
        targetRef.current = null;
      }

      try {
        setProject(await storage.deleteChapter(projectPath, chapter.id, contents));

        // Only trashing removes scenes; moving keeps every one of them.
        if (contents === "trash" && chapter.scenes.some((s) => s.id === scene?.id)) {
          setScene(null);
          editor?.commands.clearContent();
          setWords(0);
          setSaveState("idle");
          setSaveError(null);
        }
      } catch (error) {
        setSaveState("error");
        setSaveError(String(error));
      }
    },
    [ask, editor, project, projectPath, saver, scene?.id]
  );

  /* ----------------------------------------------------------------- acts */

  const createAct = useCallback(async () => {
    if (!projectPath) return null;

    try {
      const updated = await storage.createAct(projectPath, "Untitled act", project?.acts.length ?? 0);
      setProject(updated);
      return updated.acts[updated.acts.length - 1] ?? null;
    } catch (error) {
      setSaveState("error");
      setSaveError(String(error));
      return null;
    }
  }, [project?.acts.length, projectPath]);

  const renameAct = useCallback(
    async (act: storage.Act, title: string) => {
      if (!projectPath) return;

      try {
        setProject(await storage.renameAct(projectPath, act.id, title));
      } catch (error) {
        setSaveState("error");
        setSaveError(String(error));
      }
    },
    [projectPath]
  );

  const moveAct = useCallback(
    async (act: storage.Act, toIndex: number) => {
      if (!projectPath) return;

      try {
        setProject(await storage.moveAct(projectPath, act.id, toIndex));
      } catch (error) {
        setSaveState("error");
        setSaveError(String(error));
      }
    },
    [projectPath]
  );

  const deleteAct = useCallback(
    async (act: storage.Act) => {
      if (!projectPath || !project) return;

      if (project.acts.length < 2) {
        setSaveState("error");
        setSaveError("A project needs at least one act.");
        return;
      }

      const inside = act.chapters.flatMap((chapter) => chapter.scenes);
      let contents: storage.Contents = "move";

      if (act.chapters.length > 0) {
        // Where "move" would put them, so the button can say so rather than
        // making someone guess which neighbour it means.
        const index = project.acts.indexOf(act);
        const into: storage.Act | undefined = project.acts[index - 1] ?? project.acts[index + 1];

        const answer = await ask({
          title: `Delete “${act.title}”?`,
          body:
            `It holds ${count(act.chapters.length, "chapter")} and ` +
            `${count(inside.length, "scene")}. The chapters can join “${into.title}” ` +
            `instead, or every scene file can go to the trash folder.`,
          choices: [
            { key: "move", label: `Move chapters to “${into.title}”` },
            { key: "trash", label: "Move everything to trash", danger: true },
          ],
          cancelLabel: "Cancel",
        });

        if (answer !== "move" && answer !== "trash") return;
        contents = answer;
      }

      // A queued write for a scene inside this act would recreate a file that
      // is on its way to trash.
      if (inside.some((s) => s.file === targetRef.current?.file)) {
        saver.cancel();
        targetRef.current = null;
      }

      try {
        const updated = await storage.deleteAct(projectPath, act.id, contents);
        setProject(updated);

        // Only trashing removes scenes; moving keeps every one of them.
        if (contents === "trash" && inside.some((s) => s.id === scene?.id)) {
          setScene(null);
          editor?.commands.clearContent();
          setWords(0);
          setSaveState("idle");
          setSaveError(null);
        }
      } catch (error) {
        setSaveState("error");
        setSaveError(String(error));
      }
    },
    [ask, editor, project, projectPath, saver, scene?.id]
  );

  /* --------------------------------------------------------------- launch */

  const restored = useRef(false);

  // Reopen whatever was open last. Guarded by a ref rather than an empty
  // dependency list because StrictMode runs effects twice in development, and
  // opening a project twice is not free.
  useEffect(() => {
    if (restored.current) return;
    restored.current = true;

    const [last] = recent.loadRecent();
    if (last) void open(last.path, true);
  }, [open]);

  useEffect(() => {
    const shortcut = (event: KeyboardEvent) => {
      if (!event.ctrlKey && !event.metaKey) return;

      const key = event.key.toLowerCase();
      if (key !== "n" && key !== "o") return;

      event.preventDefault();
      void (key === "n" ? newProject() : openProject());
    };

    window.addEventListener("keydown", shortcut);
    return () => window.removeEventListener("keydown", shortcut);
  }, [newProject, openProject]);

  /* ---------------------------------------------------------------- flush */

  useEffect(() => {
    const flush = () => void saver.flush();

    // Losing focus is the moment someone alt-tabs away believing it is saved.
    window.addEventListener("blur", flush);
    document.addEventListener("visibilitychange", flush);

    return () => {
      window.removeEventListener("blur", flush);
      document.removeEventListener("visibilitychange", flush);
      void saver.flush();
    };
  }, [saver]);

  /* ----------------------------------------------------------------- view */

  return (
    <div className="app">
      <TopBar
        projectTitle={project?.title ?? null}
        projectPath={projectPath}
        recent={recentProjects}
        theme={theme}
        onThemeChange={setTheme}
        onNewProject={() => void newProject()}
        onOpenProject={() => void openProject()}
        onOpenRecent={(entry) => void open(entry.path)}
      />

      <div className="main">
        <Binder
          project={project}
          currentSceneId={scene?.id ?? null}
          onSelect={(meta) => void loadScene(meta)}
          onRename={(meta, title) => void renameScene(meta, title)}
          onMove={(meta, to) => void moveScene(meta, to)}
          onCreate={createScene}
          onDelete={(meta) => void deleteScene(meta)}
          onCreateChapter={createChapter}
          onRenameChapter={(chapter, title) => void renameChapter(chapter, title)}
          onMoveChapter={(chapter, to) => void moveChapter(chapter, to)}
          onDeleteChapter={(chapter) => void deleteChapter(chapter)}
          onCreateAct={createAct}
          onRenameAct={(act, title) => void renameAct(act, title)}
          onMoveAct={(act, to) => void moveAct(act, to)}
          onDeleteAct={(act) => void deleteAct(act)}
          startRenaming={renaming}
          onRenameStarted={() => setRenaming(null)}
        />
        <SceneEditor editor={editor} scene={scene} hasProject={project !== null} />
      </div>

      <StatusBar
        file={scene?.file ?? null}
        words={words}
        saveState={saveState}
        saveError={saveError}
      />

      {confirmDialog}
      {newProjectDialog}
    </div>
  );
}
