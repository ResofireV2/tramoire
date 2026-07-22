import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";

export type NewProjectRequest = {
  /** Where the last project was made, if there was one. */
  parent: string | null;
};

export type NewProjectAnswer = {
  parent: string;
  title: string;
};

/**
 * The new project dialog.
 *
 * Same shape as `useConfirm` — `ask` resolves to what they chose, or null if
 * they backed out — and the same native `<dialog>` underneath, so the modal
 * behaviour is the browser's and only the appearance is ours.
 *
 * `chooseParent` is passed in rather than imported. Components here have no
 * filesystem knowledge, and a folder picker is exactly that.
 */
export function useNewProject(chooseParent: () => Promise<string | null>): {
  ask: (request: NewProjectRequest) => Promise<NewProjectAnswer | null>;
  dialog: ReactNode;
} {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [parent, setParent] = useState<string | null>(null);

  const ref = useRef<HTMLDialogElement>(null);
  const answer = useRef<((answer: NewProjectAnswer | null) => void) | null>(null);

  const ask = useCallback((request: NewProjectRequest) => {
    return new Promise<NewProjectAnswer | null>((resolve) => {
      answer.current?.(null);
      answer.current = resolve;

      setTitle("");
      setParent(request.parent);
      setOpen(true);
    });
  }, []);

  const close = useCallback((result: NewProjectAnswer | null) => {
    setOpen(false);

    const resolve = answer.current;
    answer.current = null;
    resolve?.(result);
  }, []);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    if (open && !el.open) el.showModal();
    if (!open && el.open) el.close();
  }, [open]);

  const ready = title.trim().length > 0 && parent !== null;

  function submit() {
    if (!ready || parent === null) return;
    close({ parent, title: title.trim() });
  }

  const dialog = (
    <dialog
      ref={ref}
      className="modal"
      aria-labelledby="new-project-title"
      onCancel={(event) => {
        event.preventDefault();
        close(null);
      }}
      onClick={(event) => {
        if (event.target === ref.current) close(null);
      }}
    >
      {open && (
        <div className="modal-panel">
          <h2 id="new-project-title">New project</h2>

          <label className="field">
            <span>Title</span>
            <input
              autoFocus
              value={title}
              placeholder="The county line"
              onChange={(event) => setTitle(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") submit();
              }}
            />
          </label>

          <div className="field">
            <span>Location</span>
            <div className="field-row">
              <span className="field-path" title={parent ?? undefined}>
                {parent ?? "No folder chosen"}
              </span>
              <button
                className="btn"
                onClick={() => void chooseParent().then((picked) => picked && setParent(picked))}
              >
                Choose…
              </button>
            </div>
          </div>

          {/* Only the parent is shown, not the folder name it will produce.
              Predicting that here would mean a second copy of the rules in
              naming.rs, and two copies drift. */}
          <p className="modal-note">
            A folder named after the title, ending in <code>.tramoire</code>, is made here.
          </p>

          <div className="modal-actions">
            <button className="btn" onClick={() => close(null)}>
              Cancel
            </button>
            <button className="btn btn-primary" disabled={!ready} onClick={submit}>
              Create
            </button>
          </div>
        </div>
      )}
    </dialog>
  );

  return { ask, dialog };
}
