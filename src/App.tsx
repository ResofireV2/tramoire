import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useEditor } from "@tiptap/react";

import { Binder } from "./components/Binder";
import { SceneEditor } from "./components/SceneEditor";
import { StatusBar } from "./components/StatusBar";
import { TopBar } from "./components/TopBar";

import { createSaver, type SaveState, type SaveTarget } from "./lib/autosave";
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
        />
        <SceneEditor editor={editor} scene={scene} hasProject={project !== null} />
      </div>

      <StatusBar
        file={scene?.file ?? null}
        words={words}
        saveState={saveState}
        saveError={saveError}
      />
    </div>
  );
}
