import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useEditor } from "@tiptap/react";

import { Binder } from "./components/Binder";
import { useConfirm } from "./components/Confirm";
import { Entities } from "./components/Entities";
import { useNewProject } from "./components/NewProject";
import { Rail } from "./components/Rail";
import { SceneEditor } from "./components/SceneEditor";
import { StatusBar } from "./components/StatusBar";
import { TopBar } from "./components/TopBar";

import { createSaver, type SaveState, type SaveTarget } from "./lib/autosave";
import type { Spot } from "./lib/binder";
import * as entityTypes from "./lib/entities";
import { editorProps, editorText, extensions } from "./lib/editor";
import { countWords, docToMd, mdToDoc } from "./lib/markdown";
import * as settings from "./lib/settings";
import * as storage from "./lib/storage";
import { applyTheme } from "./lib/theme";

const count = (n: number, noun: string) => `${n} ${noun}${n === 1 ? "" : "s"}`;

export default function App() {
  const [project, setProject] = useState<storage.Project | null>(null);
  const [projectPath, setProjectPath] = useState<string | null>(null);
  const [scene, setScene] = useState<storage.SceneMeta | null>(null);

  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [saveError, setSaveError] = useState<string | null>(null);
  const [words, setWords] = useState(0);

  // Loaded from the config directory on launch, and written back on every
  // change. Held whole rather than as separate pieces so one write covers it.
  const [prefs, setPrefs] = useState<settings.Settings>(settings.DEFAULTS);
  const theme = prefs.theme;

  // "manuscript", or the entity type being shown.
  const [view, setView] = useState("manuscript");
  const [entities, setEntities] = useState<storage.Entity[]>([]);
  const [entityId, setEntityId] = useState<string | null>(null);
  const [namingEntity, setNamingEntity] = useState<string | null>(null);

  // The scene the binder should open its rename field on, set when a scene is
  // made rather than chosen. Cleared once the binder has acted on it.
  const [renaming, setRenaming] = useState<string | null>(null);

  // `ask` is stable; the dialog node is not, so depend on the function alone
  // rather than the pair, or every render invalidates the delete handler.
  const { ask, dialog: confirmDialog } = useConfirm();
  const { ask: askNewProject, dialog: newProjectDialog } = useNewProject(storage.pickParentFolder);

  useEffect(() => {
    applyTheme(theme);
  }, [theme]);

  /** Change what is remembered, and write it. */
  const remember = useCallback((change: Partial<settings.Settings>) => {
    setPrefs((current) => {
      const next = { ...current, ...change };
      void storage.saveSettings(next);
      return next;
    });
  }, []);

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

  /**
   * Entity records get their own saver, with the same guarantee: what a write
   * belongs to is captured when it is queued, so typing and then switching
   * cannot put one character's notes into another's file. Only one write is
   * ever pending, so switching records flushes first.
   */
  const recordSaver = useMemo(
    () =>
      createSaver<{ projectPath: string }, storage.Entity>(
        async ({ projectPath }, entity) => {
          const saved = await storage.writeEntity(projectPath, entity);

          // Put what came back into state. Without this the list keeps the
          // record as it was before the edit, and the next thing typed into a
          // remounted form is built on stale values and overwrites the file.
          setEntities((current) =>
            current.map((one) => (one.id === saved.id ? saved : one))
          );
        },
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

  const reloadEntities = useCallback(async (path: string) => {
    try {
      setEntities(await storage.listEntities(path));
    } catch (error) {
      setSaveState("error");
      setSaveError(String(error));
    }
  }, []);

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

        setEntityId(null);

        setPrefs((current) => {
          const next = {
            ...current,
            recent: settings.remember(current.recent, { path: folder, title: opened.title }),
          };
          void storage.saveSettings(next);
          return next;
        });

        return opened;
      } catch (error) {
        // Only forget when someone asked for this folder by name. A restore at
        // launch that fails for any passing reason used to erase the entry, so
        // one bad start meant never reopening anything again.
        if (!quiet) {
          setPrefs((current) => {
            const next = { ...current, recent: settings.forget(current.recent, folder) };
            void storage.saveSettings(next);
            return next;
          });

          setSaveState("error");
          setSaveError(String(error));
        }
        return null;
      }
    },
    [editor, reloadEntities, saver]
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
    const answer = await askNewProject({ parent: prefs.lastParent });
    if (!answer) return;

    try {
      const folder = await storage.createProject(answer.parent, answer.title);
      remember({ lastParent: answer.parent });

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
  }, [askNewProject, loadSceneFrom, open, prefs.lastParent, remember]);

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

  /* ------------------------------------------------------------- entities */

  const createEntity = useCallback(async () => {
    if (!projectPath || view === "manuscript") return;

    try {
      const made = await storage.createEntity(projectPath, `New ${view}`, view);

      setEntities(await storage.listEntities(projectPath));
      setEntityId(made.id);
      setNamingEntity(made.id);
    } catch (error) {
      setSaveState("error");
      setSaveError(String(error));
    }
  }, [projectPath, view]);

  /**
   * Anything still pending belongs to the record being left, and only one write
   * is ever pending — so it goes out before the next record can replace it.
   */
  const selectEntity = useCallback(
    async (entity: storage.Entity) => {
      await recordSaver.flush();
      setEntityId(entity.id);
    },
    [recordSaver]
  );

  const changeEntity = useCallback(
    async (entity: storage.Entity) => {
      if (!projectPath) return;

      // A pending note belongs to the file this entity is about to move away
      // from, so it goes out first.
      await recordSaver.flush();

      try {
        await storage.writeEntity(projectPath, entity);
        setEntities(await storage.listEntities(projectPath));
        setSaveState("saved");
      } catch (error) {
        setSaveState("error");
        setSaveError(String(error));
      }
    },
    [recordSaver, projectPath]
  );

  const deleteEntity = useCallback(
    async (entity: storage.Entity) => {
      if (!projectPath) return;

      const go = await ask({
        title: `Move “${entity.name}” to trash?`,
        body:
          "The markdown file moves to the trash folder inside the project. " +
          "It stays on disk, and moving it back restores the record.",
        choices: [{ key: "trash", label: "Move to trash", danger: true }],
        cancelLabel: "Keep",
      });
      if (go !== "trash") return;

      recordSaver.cancel();

      try {
        await storage.deleteEntity(projectPath, entity.file);
        setEntities(await storage.listEntities(projectPath));
        if (entityId === entity.id) setEntityId(null);
      } catch (error) {
        setSaveState("error");
        setSaveError(String(error));
      }
    },
    [ask, entityId, recordSaver, projectPath]
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

  // Tied to the project being open rather than to opening it, so every route in
  // is covered — and so a hot reload in development refills the list instead of
  // leaving it empty until something else happens to write to it.
  useEffect(() => {
    if (projectPath) void reloadEntities(projectPath);
  }, [projectPath, reloadEntities]);

  /* --------------------------------------------------------------- launch */

  const restored = useRef(false);

  // Read the settings, then reopen whatever was open last. Guarded by a ref
  // rather than an empty dependency list because StrictMode runs effects twice
  // in development, and opening a project twice is not free.
  useEffect(() => {
    if (restored.current) return;
    restored.current = true;

    void (async () => {
      const loaded = settings.sane(await storage.loadSettings());
      setPrefs(loaded);

      const [last] = loaded.recent;
      if (last) await open(last.path, true);
    })();
  }, [open]);

  useEffect(() => {
    const shortcut = (event: KeyboardEvent) => {
      if (!event.ctrlKey && !event.metaKey) return;

      const key = event.key.toLowerCase();

      // Everything saves itself, but a writer who has just typed something they
      // care about should not have to believe that. Ctrl+S writes now.
      if (key === "s") {
        event.preventDefault();
        void saver.flush();
        void recordSaver.flush();
        return;
      }

      if (key !== "n" && key !== "o") return;

      event.preventDefault();
      void (key === "n" ? newProject() : openProject());
    };

    window.addEventListener("keydown", shortcut);
    return () => window.removeEventListener("keydown", shortcut);
  }, [newProject, openProject, recordSaver, saver]);

  /* ---------------------------------------------------------------- flush */

  useEffect(() => {
    const flush = () => {
      void saver.flush();
      void recordSaver.flush();
    };

    // Losing focus is the moment someone alt-tabs away believing it is saved.
    window.addEventListener("blur", flush);
    document.addEventListener("visibilitychange", flush);

    return () => {
      window.removeEventListener("blur", flush);
      document.removeEventListener("visibilitychange", flush);
      flush();
    };
  }, [recordSaver, saver]);

  /* ----------------------------------------------------------------- view */

  const currentEntity = entities.find((entity) => entity.id === entityId) ?? null;

  return (
    <div className="app">
      <TopBar
        projectTitle={project?.title ?? null}
        projectPath={projectPath}
        recent={prefs.recent}
        theme={theme}
        onThemeChange={(next) => remember({ theme: next })}
        onNewProject={() => void newProject()}
        onOpenProject={() => void openProject()}
        onOpenRecent={(entry) => void open(entry.path)}
      />

      <div className="main">
        <Rail
          view={view}
          types={entityTypes.types(entities)}
          onChange={(next) => {
            void recordSaver.flush();
            setView(next);
          }}
        />

        {view === "manuscript" ? (
          <>
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
          </>
        ) : (
          <Entities
            type={view}
            entities={entities}
            selectedId={entityId}
            hasProject={project !== null}
            onSelect={(entity) => void selectEntity(entity)}
            onCreate={() => void createEntity()}
            onChange={(entity) => void changeEntity(entity)}
            onEdit={(entity) => projectPath && recordSaver.queue({ projectPath }, entity)}
            onFlush={() => void recordSaver.flush()}
            naming={namingEntity}
            onNamed={() => setNamingEntity(null)}
            onDelete={(entity) => void deleteEntity(entity)}
          />
        )}
      </div>

      <StatusBar
        file={view === "manuscript" ? (scene?.file ?? null) : currentEntity?.file ?? null}
        words={view === "manuscript" ? words : 0}
        saveState={saveState}
        saveError={saveError}
      />

      {confirmDialog}
      {newProjectDialog}
    </div>
  );
}
