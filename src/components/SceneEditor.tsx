import { EditorContent, type Editor } from "@tiptap/react";
import type { SceneMeta } from "../lib/storage";

type Props = {
  editor: Editor | null;
  scene: SceneMeta | null;
  hasProject: boolean;
};

export function SceneEditor({ editor, scene, hasProject }: Props) {
  return (
    <div className="editor-wrap">
      <div className="editor">
        {scene ? (
          <>
            <h1 className="scene-title">{scene.title}</h1>
            <div className="scene-sub">{scene.status}</div>
            <EditorContent editor={editor} />
          </>
        ) : (
          <p className="empty">
            {hasProject ? "Pick a scene from the binder." : "Open a project to start writing."}
          </p>
        )}
      </div>
    </div>
  );
}
