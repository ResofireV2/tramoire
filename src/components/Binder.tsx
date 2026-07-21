import type { Project, SceneMeta } from "../lib/storage";

type Props = {
  project: Project | null;
  currentSceneId: string | null;
  onSelect: (scene: SceneMeta) => void;
};

export function Binder({ project, currentSceneId, onSelect }: Props) {
  return (
    <nav className="binder" aria-label="Binder">
      {project ? (
        project.acts.map((act) => (
          <div key={act.id}>
            <div className="act">{act.title}</div>
            {act.scenes.map((scene) => (
              <button
                key={scene.id}
                className="scene"
                aria-current={currentSceneId === scene.id}
                onClick={() => onSelect(scene)}
              >
                <span className="t">{scene.title}</span>
                <span className="m">{scene.status}</span>
              </button>
            ))}
          </div>
        ))
      ) : (
        <p className="binder-empty">
          No project open. Choose a <code>.tramoire</code> folder to begin.
        </p>
      )}
    </nav>
  );
}
