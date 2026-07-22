import { Fragment, useEffect, useRef, useState } from "react";

import {
  dropActPosition,
  dropChapterPosition,
  dropPosition,
  nextActPosition,
  nextChapterPosition,
  nextPosition,
  type Spot,
} from "../lib/binder";
import {
  allChapters,
  allScenes,
  type Act,
  type Chapter,
  type Project,
  type SceneMeta,
} from "../lib/storage";

type Props = {
  project: Project | null;
  currentSceneId: string | null;
  onSelect: (scene: SceneMeta) => void;
  onRename: (scene: SceneMeta, title: string) => void;
  onMove: (scene: SceneMeta, to: Spot) => void;
  onCreate: (chapter: Chapter) => Promise<SceneMeta | null>;
  onDelete: (scene: SceneMeta) => void;
  onCreateChapter: (act: Act) => Promise<Chapter | null>;
  onRenameChapter: (chapter: Chapter, title: string) => void;
  onMoveChapter: (chapter: Chapter, to: Spot) => void;
  onDeleteChapter: (chapter: Chapter) => void;
  onCreateAct: () => Promise<Act | null>;
  onRenameAct: (act: Act, title: string) => void;
  onMoveAct: (act: Act, toIndex: number) => void;
  onDeleteAct: (act: Act) => void;
  /** A scene the binder should open its rename field on, made elsewhere. */
  startRenaming?: string | null;
  onRenameStarted?: () => void;
};

type Level = "scene" | "chapter" | "act";

/** What is in the air, and what it would displace. */
type Dragged = { level: Level; id: string };
type Over = { level: Level; parentId: string; index: number };

type Named = { id: string; title: string };

/**
 * An inline rename field, of which the binder has three — one per level. They
 * behave identically, and the fiddly part is identical too: Escape has to stop
 * the blur that follows it from committing, which needs a ref because state
 * updates land too late.
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

/** Which half of a row the pointer is in decides which gap it means. */
function gap(event: React.DragEvent, index: number): number {
  const box = event.currentTarget.getBoundingClientRect();
  return event.clientY > box.top + box.height / 2 ? index + 1 : index;
}

export function Binder({
  project,
  currentSceneId,
  onSelect,
  onRename,
  onMove,
  onCreate,
  onDelete,
  onCreateChapter,
  onRenameChapter,
  onMoveChapter,
  onDeleteChapter,
  onCreateAct,
  onRenameAct,
  onMoveAct,
  onDeleteAct,
  startRenaming,
  onRenameStarted,
}: Props) {
  const [over, setOver] = useState<Over | null>(null);

  // Kept here rather than on the drag event because dataTransfer cannot be read
  // during dragover, only on drop, and the rows have to react before then.
  const [dragging, setDragging] = useState<Dragged | null>(null);

  const scenes = useInlineRename<SceneMeta>(onRename);
  const chapters = useInlineRename<Chapter>(onRenameChapter);
  const acts = useInlineRename<Act>(onRenameAct);

  // Ids are unique across levels — sc-, ch-, act- — so one map holds them all.
  const buttons = useRef(new Map<string, HTMLButtonElement>());
  const refocus = useRef<string | null>(null);

  // Anything that crosses into another container is unmounted from one list and
  // remounted in another, which drops focus. Without putting it back, holding
  // the key moves a scene exactly one chapter and then stops.
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

  /* -------------------------------------------------------------- keyboard */

  function moveScene(scene: SceneMeta, direction: "up" | "down") {
    const to = nextPosition(project, scene.id, direction);
    if (!to) return;

    refocus.current = scene.id;
    onMove(scene, to);
  }

  function moveChapter(chapter: Chapter, direction: "up" | "down") {
    const to = nextChapterPosition(project, chapter.id, direction);
    if (!to) return;

    refocus.current = chapter.id;
    onMoveChapter(chapter, to);
  }

  function moveAct(act: Act, direction: "up" | "down") {
    const to = nextActPosition(project, act.id, direction);
    if (to === null) return;

    refocus.current = act.id;
    onMoveAct(act, to);
  }

  /* ----------------------------------------------------------- dragging */

  /**
   * What is being dragged decides which drop zones are live. A scene ignores
   * the gaps between chapters, a chapter ignores the gaps between scenes, and
   * a zone that does not answer lets the event bubble to the container that
   * does. Without that, three nested targets fight over every pixel.
   */
  function zone(event: React.DragEvent, level: Level, target: Over) {
    if (dragging?.level !== level) return;

    event.preventDefault();
    // The container underneath would otherwise overwrite this with its own,
    // coarser answer, and every drop would land at the end of something.
    event.stopPropagation();
    setOver(target);
  }

  /**
   * Committed from state rather than from the drop event, because the last
   * dragover already worked out where the pointer was — and dataTransfer is
   * only readable here, too late to have driven the indicator.
   */
  function drop() {
    const dragged = dragging;
    const target = over;

    setDragging(null);
    setOver(null);
    if (!dragged || !target || dragged.level !== target.level) return;

    refocus.current = dragged.id;

    if (dragged.level === "scene") {
      const scene = allScenes(project).find((s) => s.id === dragged.id);
      const to = dropPosition(project, dragged.id, target);
      if (scene && to) onMove(scene, to);
      return;
    }

    if (dragged.level === "chapter") {
      const chapter = allChapters(project).find((c) => c.id === dragged.id);
      const to = dropChapterPosition(project, dragged.id, target);
      if (chapter && to) onMoveChapter(chapter, to);
      return;
    }

    const act = project?.acts.find((a) => a.id === dragged.id);
    const to = dropActPosition(project, dragged.id, target.index);
    if (act && to !== null) onMoveAct(act, to);
  }

  /** The handle attributes every draggable header and row shares. */
  function handle(level: Level, id: string) {
    return {
      draggable: true,
      "data-dragging": dragging?.id === id,
      onDragStart: (event: React.DragEvent) => {
        setDragging({ level, id });
        event.dataTransfer.effectAllowed = "move";
        // Not read back — state carries it — but Firefox will not start a drag
        // without data on the transfer.
        event.dataTransfer.setData("text/plain", id);
      },
      onDragEnd: () => {
        setDragging(null);
        setOver(null);
      },
    };
  }

  const line = (level: Level, parentId: string, index: number) =>
    over?.level === level && over.parentId === parentId && over.index === index ? (
      <div className={`drop-line drop-line-${level}`} />
    ) : null;

  /* -------------------------------------------------------------- making */

  async function createScene(chapter: Chapter) {
    const made = await onCreate(chapter);
    // New things are called "Untitled" until someone says otherwise, so hand
    // them the field rather than making them find it.
    if (made) scenes.start(made);
  }

  async function createChapter(act: Act) {
    const made = await onCreateChapter(act);
    if (made) chapters.start(made);
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
    <nav className="binder" aria-label="Binder" onDrop={() => drop()}>
      {project.acts.map((act, actIndex) => (
        <Fragment key={act.id}>
          {line("act", "", actIndex)}

          <div
            className="act-group"
            onDragOver={(event) => {
              // Anywhere in an act's body means the end of it: past its last
              // chapter, or into it when it has none at all.
              zone(event, "chapter", {
                level: "chapter",
                parentId: act.id,
                index: act.chapters.length,
              });
              zone(event, "act", { level: "act", parentId: "", index: actIndex + 1 });
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
              <div
                className="act"
                onDragOver={(event) =>
                  zone(event, "act", { level: "act", parentId: "", index: gap(event, actIndex) })
                }
              >
                <button
                  className="act-title"
                  ref={(el) => {
                    if (el) buttons.current.set(act.id, el);
                    else buttons.current.delete(act.id);
                  }}
                  {...handle("act", act.id)}
                  onDoubleClick={() => acts.start(act)}
                  onClick={(event) => event.currentTarget.focus()}
                  onKeyDown={(event) => {
                    if (event.key === "F2") acts.start(act);

                    if (event.altKey && event.key === "ArrowUp") {
                      event.preventDefault();
                      moveAct(act, "up");
                    }
                    if (event.altKey && event.key === "ArrowDown") {
                      event.preventDefault();
                      moveAct(act, "down");
                    }
                  }}
                >
                  {act.title}
                </button>

                <button
                  className="act-add"
                  aria-label={`Add a chapter to ${act.title}`}
                  onClick={() => void createChapter(act)}
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

            {act.chapters.map((chapter, chapterIndex) => (
              <Fragment key={chapter.id}>
                {line("chapter", act.id, chapterIndex)}

                <div
                  className="chapter-group"
                  onDragOver={(event) => {
                    zone(event, "scene", {
                      level: "scene",
                      parentId: chapter.id,
                      index: chapter.scenes.length,
                    });
                    zone(event, "chapter", {
                      level: "chapter",
                      parentId: act.id,
                      index: chapterIndex + 1,
                    });
                  }}
                >
                  {chapters.editing === chapter.id ? (
                    <input
                      className="chapter-rename"
                      aria-label="Chapter title"
                      value={chapters.draft}
                      autoFocus
                      onChange={(event) => chapters.setDraft(event.target.value)}
                      onBlur={() => chapters.commit(chapter)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") chapters.commit(chapter);
                        if (event.key === "Escape") chapters.cancel();
                      }}
                    />
                  ) : (
                    <div
                      className="chapter"
                      onDragOver={(event) =>
                        zone(event, "chapter", {
                          level: "chapter",
                          parentId: act.id,
                          index: gap(event, chapterIndex),
                        })
                      }
                    >
                      <button
                        className="chapter-title"
                        ref={(el) => {
                          if (el) buttons.current.set(chapter.id, el);
                          else buttons.current.delete(chapter.id);
                        }}
                        {...handle("chapter", chapter.id)}
                        onDoubleClick={() => chapters.start(chapter)}
                        onClick={(event) => event.currentTarget.focus()}
                        onKeyDown={(event) => {
                          if (event.key === "F2") chapters.start(chapter);

                          if (event.altKey && event.key === "ArrowUp") {
                            event.preventDefault();
                            moveChapter(chapter, "up");
                          }
                          if (event.altKey && event.key === "ArrowDown") {
                            event.preventDefault();
                            moveChapter(chapter, "down");
                          }
                        }}
                      >
                        {chapter.title}
                      </button>

                      <button
                        className="chapter-add"
                        aria-label={`Add a scene to ${chapter.title}`}
                        onClick={() => void createScene(chapter)}
                      >
                        +
                      </button>
                      <button
                        className="chapter-delete"
                        aria-label={`Delete ${chapter.title}`}
                        onClick={() => onDeleteChapter(chapter)}
                      >
                        ×
                      </button>
                    </div>
                  )}

                  {chapter.scenes.map((scene, index) => (
                    <Fragment key={scene.id}>
                      {line("scene", chapter.id, index)}

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
                          onDragOver={(event) =>
                            zone(event, "scene", {
                              level: "scene",
                              parentId: chapter.id,
                              index: gap(event, index),
                            })
                          }
                        >
                          <button
                            ref={(el) => {
                              if (el) buttons.current.set(scene.id, el);
                              else buttons.current.delete(scene.id);
                            }}
                            className="scene"
                            aria-current={currentSceneId === scene.id}
                            {...handle("scene", scene.id)}
                            // Focused explicitly because WebKit — the webview on
                            // Linux and macOS both — does not focus a button on
                            // click the way Chromium does, and Alt+↑/↓ has to
                            // reach something.
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
                                moveScene(scene, "up");
                              }
                              if (event.altKey && event.key === "ArrowDown") {
                                event.preventDefault();
                                moveScene(scene, "down");
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

                  {line("scene", chapter.id, chapter.scenes.length)}
                </div>
              </Fragment>
            ))}

            {line("chapter", act.id, act.chapters.length)}
          </div>
        </Fragment>
      ))}

      {line("act", "", project.acts.length)}

      <button className="act-new" onClick={() => void createAct()}>
        + New act
      </button>
    </nav>
  );
}
