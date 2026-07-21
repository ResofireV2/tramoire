import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useEditor } from "@tiptap/react";

import { Binder } from "./components/Binder";
import { useConfirm } from "./components/Confirm";
import { SceneEditor } from "./components/SceneEditor";
import { StatusBar } from "./components/StatusBar";
import { TopBar } from "./components/TopBar";

import { createSaver, type SaveState, type SaveTarget } from "./lib/autosave";
import type { Position } from "./lib/binder";
import { editorProps, editorText, extensions } from "./lib/editor";
import { countWords, docToMd, mdToDoc } from "./lib/markdown";
import * as storage from "./lib/storage";
import { applyTheme, loadTheme, saveTheme, type Theme } from "./lib/theme";

export default function App() {
  const [project, setProject] = useState<storage.Project | null>(null);
  const [projectPath, setProjectPath] = useState<string | null>(null);
  const [scene, setScene] = useState<storage.SceneMeta | null>(null);

  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [saveError, setSaveError] = useState<string | null>(null);
  const [words, setWords] = useState(0);

  const [theme, setTheme] = useState<Theme>(loadTheme);

  // `ask` is stable; the dialog node is not, so depend on the function alone
  // rather than the pair, or every render invalidates the delete handler.
  const { ask, dialog: confirmDialog } = useConfirm();

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

  const openProject = useCallback(async () => {
    const folder = await storage.pickProjectFolder();
    if (!folder) return;

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
    } catch (error) {
      setSaveState("error");
      setSaveError(String(error));
    }
  }, [editor, saver]);

  const loadScene = useCallback(
    async (meta: storage.SceneMeta) => {
      if (!projectPath || !editor || meta.id === scene?.id) return;

      // Anything still pending belongs to the scene being left.
      await saver.flush();

      try {
        const markdown = await storage.readScene(projectPath, meta.file);

        loadingRef.current = true;
        editor.commands.setContent(mdToDoc(markdown), { emitUpdate: false });
        loadingRef.current = false;

        targetRef.current = { projectPath, file: meta.file };
        setScene(meta);
        setWords(countWords(editorText(editor)));
        setSaveState("idle");
        setSaveError(null);
      } catch (error) {
        setSaveState("error");
        setSaveError(String(error));
      }
    },
    [editor, projectPath, saver, scene?.id]
  );

  const renameScene = useCallback(
    async (meta: storage.SceneMeta, title: string) => {
      if (!projectPath) return;

      try {
        const updated = await storage.renameScene(projectPath, meta.id, title);

        setProject(updated);
        // Take the scene back out of the manifest that was returned rather than
        // patching the one in hand, so state and disk cannot drift apart.
        setScene((current) =>
          current?.id === meta.id
            ? storage.allScenes(updated).find((s) => s.id === meta.id) ?? current
            : current
        );
      } catch (error) {
        setSaveState("error");
        setSaveError(String(error));
      }
    },
    [projectPath]
  );

  const moveScene = useCallback(
    async (meta: storage.SceneMeta, to: Position) => {
      if (!projectPath) return;

      try {
        setProject(await storage.moveScene(projectPath, meta.id, to.actId, to.index));
      } catch (error) {
        setSaveState("error");
        setSaveError(String(error));
      }
    },
    [projectPath]
  );

  const createScene = useCallback(
    async (act: storage.Act) => {
      if (!projectPath) return null;

      try {
        const made = await storage.createScene(
          projectPath,
          act.id,
          "Untitled scene",
          act.scenes.length
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
        confirmLabel: "Move to trash",
        cancelLabel: "Keep",
      });
      if (!go) return;

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
        theme={theme}
        onThemeChange={setTheme}
        onOpenProject={() => void openProject()}
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
    </div>
  );
}
