import { Fragment, useEffect, useRef, useState } from "react";

import {
  dropPosition,
  nextActPosition,
  nextPosition,
  type Position,
  type Slot,
} from "../lib/binder";
import { allScenes, type Act, type Project, type SceneMeta } from "../lib/storage";

type Props = {
  project: Project | null;
  currentSceneId: string | null;
  onSelect: (scene: SceneMeta) => void;
  onRename: (scene: SceneMeta, title: string) => void;
  onMove: (scene: SceneMeta, to: Position) => void;
  onCreate: (act: Act) => Promise<SceneMeta | null>;
  onDelete: (scene: SceneMeta) => void;
  onCreateAct: () => Promise<Act | null>;
  onRenameAct: (act: Act, title: string) => void;
  onMoveAct: (act: Act, toIndex: number) => void;
  onDeleteAct: (act: Act) => void;
  /** A scene the binder should open its rename field on, made elsewhere. */
  startRenaming?: string | null;
  onRenameStarted?: () => void;
};

type Named = { id: string; title: string };

/**
 * An inline rename field, of which the binder has two — one for scenes and one
 * for acts. They behave identically, and the fiddly part is identical too:
 * Escape has to stop the blur that follows it from committing, which needs a
 * ref because state updates land too late.
 */
function useInlineRename<T extends Named>(commitTitle: (item: T, title: string) => void) {
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const live = useRef<string | null>(null);

  function start(item: T) {
    live.current = item.id;
    setEditing(item.id);
    setDraft(item.title);
  }

  function commit(item: T) {
    if (live.current !== item.id) return;
    live.current = null;
    setEditing(null);

    const title = draft.trim();
    if (title && title !== item.title) commitTitle(item, title);
  }

  function cancel() {
    live.current = null;
    setEditing(null);
  }

  return { editing, draft, setDraft, start, commit, cancel };
}

export function Binder({
  project,
  currentSceneId,
  onSelect,
  onRename,
  onMove,
  onCreate,
  onDelete,
  onCreateAct,
  onRenameAct,
  onMoveAct,
  onDeleteAct,
  startRenaming,
  onRenameStarted,
}: Props) {
  const [over, setOver] = useState<Slot | null>(null);

  // Kept here rather than on the drag event because dataTransfer cannot be read
  // during dragover, only on drop, and the row has to look lifted before then.
  const [dragging, setDragging] = useState<string | null>(null);

  const scenes = useInlineRename<SceneMeta>(onRename);
  const acts = useInlineRename<Act>(onRenameAct);

  const buttons = useRef(new Map<string, HTMLButtonElement>());
  const refocus = useRef<string | null>(null);

  // A scene that crosses an act boundary is unmounted from one list and
  // remounted in another, which drops focus. Without putting it back, holding
  // the key moves a scene exactly one act and then stops.
  useEffect(() => {
    const id = refocus.current;
    if (!id) return;

    refocus.current = null;
    buttons.current.get(id)?.focus();
  }, [project]);

  // A scene created by the project dialog rather than by the + button: the
  // binder still owns the rename field, so it is asked to open one.
  useEffect(() => {
    if (!startRenaming) return;

    const scene = allScenes(project).find((s) => s.id === startRenaming);
    if (scene) scenes.start(scene);
    onRenameStarted?.();
  }, [startRenaming]); // eslint-disable-line react-hooks/exhaustive-deps

  /* --------------------------------------------------------------- moving */

  function move(scene: SceneMeta, direction: "up" | "down") {
    const to = nextPosition(project, scene.id, direction);
    if (!to) return;

    refocus.current = scene.id;
    onMove(scene, to);
  }

  function drop(slot: Slot) {
    setDragging(null);
    setOver(null);
    if (!dragging) return;

    const id = dragging;
    const scene = allScenes(project).find((s) => s.id === id);
    const to = dropPosition(project, id, slot);
    if (!scene || !to) return;

    refocus.current = id;
    onMove(scene, to);
  }

  /** Which side of a row the pointer is on decides which gap it means. */
  function slotUnder(event: React.DragEvent, actId: string, index: number): Slot {
    const box = event.currentTarget.getBoundingClientRect();
    const below = event.clientY > box.top + box.height / 2;
    return { actId, index: index + (below ? 1 : 0) };
  }

  /* -------------------------------------------------------------- making */

  async function create(act: Act) {
    const made = await onCreate(act);
    // A new scene is called "Untitled scene" until someone says otherwise, so
    // hand them the field rather than making them find it.
    if (made) scenes.start(made);
  }

  async function createAct() {
    const made = await onCreateAct();
    if (made) acts.start(made);
  }

  /* ----------------------------------------------------------------- view */

  if (!project) {
    return (
      <nav className="binder" aria-label="Binder">
        <p className="binder-empty">
          No project open. Choose a <code>.tramoire</code> folder to begin.
        </p>
      </nav>
    );
  }

  return (
    <nav className="binder" aria-label="Binder">
      {project.acts.map((act) => (
        <div
          key={act.id}
          // The act itself is the drop target for everything below its last
          // scene, which is the only way into an act that has been emptied.
          onDragOver={(event) => {
            event.preventDefault();
            setOver({ actId: act.id, index: act.scenes.length });
          }}
          onDrop={(event) => {
            event.preventDefault();
            drop({ actId: act.id, index: act.scenes.length });
          }}
        >
          {acts.editing === act.id ? (
            <input
              className="act-rename"
              aria-label="Act title"
              value={acts.draft}
              autoFocus
              onChange={(event) => acts.setDraft(event.target.value)}
              onBlur={() => acts.commit(act)}
              onKeyDown={(event) => {
                if (event.key === "Enter") acts.commit(act);
                if (event.key === "Escape") acts.cancel();
              }}
            />
          ) : (
            <div className="act">
              <button
                className="act-title"
                onDoubleClick={() => acts.start(act)}
                onClick={(event) => event.currentTarget.focus()}
                onKeyDown={(event) => {
                  if (event.key === "F2") acts.start(act);

                  if (event.altKey && (event.key === "ArrowUp" || event.key === "ArrowDown")) {
                    event.preventDefault();
                    const to = nextActPosition(project, act.id, event.key === "ArrowUp" ? "up" : "down");
                    if (to !== null) onMoveAct(act, to);
                  }
                }}
              >
                {act.title}
              </button>

              <button
                className="act-add"
                aria-label={`Add a scene to ${act.title}`}
                onClick={() => void create(act)}
              >
                +
              </button>
              <button
                className="act-delete"
                aria-label={`Delete ${act.title}`}
                onClick={() => onDeleteAct(act)}
              >
                ×
              </button>
            </div>
          )}

          {act.scenes.map((scene, index) => (
            <Fragment key={scene.id}>
              {over?.actId === act.id && over.index === index && <div className="drop-line" />}

              {scenes.editing === scene.id ? (
                <input
                  className="scene-rename"
                  aria-label="Scene title"
                  value={scenes.draft}
                  autoFocus
                  onChange={(event) => scenes.setDraft(event.target.value)}
                  onBlur={() => scenes.commit(scene)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") scenes.commit(scene);
                    if (event.key === "Escape") scenes.cancel();
                  }}
                />
              ) : (
                <div
                  className="scene-row"
                  onDragOver={(event) => {
                    event.preventDefault();
                    // Without this the act underneath overwrites the precise
                    // slot with "the end", and every drop lands at the bottom.
                    event.stopPropagation();
                    setOver(slotUnder(event, act.id, index));
                  }}
                  onDrop={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    drop(slotUnder(event, act.id, index));
                  }}
                >
                  <button
                    ref={(el) => {
                      if (el) buttons.current.set(scene.id, el);
                      else buttons.current.delete(scene.id);
                    }}
                    className="scene"
                    aria-current={currentSceneId === scene.id}
                    draggable
                    data-dragging={dragging === scene.id}
                    onDragStart={(event) => {
                      setDragging(scene.id);
                      event.dataTransfer.effectAllowed = "move";
                      // Not read back — state carries it — but Firefox will
                      // not start a drag without data on the transfer.
                      event.dataTransfer.setData("text/plain", scene.id);
                    }}
                    onDragEnd={() => {
                      setDragging(null);
                      setOver(null);
                    }}
                    // Focused explicitly because WebKit — the webview on Linux and
                    // macOS both — does not focus a button on click the way
                    // Chromium does, and Alt+↑/↓ has to reach something.
                    onClick={(event) => {
                      event.currentTarget.focus();
                      onSelect(scene);
                    }}
                    onDoubleClick={() => scenes.start(scene)}
                    onKeyDown={(event) => {
                      if (event.key === "F2") scenes.start(scene);
                      if (event.key === "Delete") onDelete(scene);

                      if (event.altKey && event.key === "ArrowUp") {
                        event.preventDefault();
                        move(scene, "up");
                      }
                      if (event.altKey && event.key === "ArrowDown") {
                        event.preventDefault();
                        move(scene, "down");
                      }
                    }}
                  >
                    <span className="t">{scene.title}</span>
                    <span className="m">{scene.status}</span>
                  </button>

                  <button
                    className="scene-delete"
                    aria-label={`Move ${scene.title} to trash`}
                    onClick={() => onDelete(scene)}
                  >
                    ×
                  </button>
                </div>
              )}
            </Fragment>
          ))}

          {over?.actId === act.id && over.index === act.scenes.length && (
            <div className="drop-line" />
          )}
        </div>
      ))}

      <button className="act-new" onClick={() => void createAct()}>
        + New act
      </button>
    </nav>
  );
}
