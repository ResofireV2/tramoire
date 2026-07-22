import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";

export type Choice = {
  /** What `ask` resolves to when this one is picked. */
  key: string;
  label: string;
  /** Styled as the destructive answer. */
  danger?: boolean;
};

export type Request = {
  title: string;
  body: string;
  choices: Choice[];
  cancelLabel: string;
};

/**
 * A confirmation that looks like the rest of the application.
 *
 * Built on the native `<dialog>` element rather than a div with a high z-index,
 * which is what buys the modal behaviour: the top layer, a focus trap, Escape,
 * and the background going inert. Only the appearance is ours.
 *
 * Answers are a list rather than yes and no, because some questions genuinely
 * have three answers — deleting an act asks whether its scenes should move or
 * be trashed, and forcing that into two dialogs would be worse than asking it
 * once. `ask` resolves to the key that was picked, or null if they backed out.
 */
export function useConfirm(): {
  ask: (request: Request) => Promise<string | null>;
  dialog: ReactNode;
} {
  const [request, setRequest] = useState<Request | null>(null);
  const ref = useRef<HTMLDialogElement>(null);

  // Held across the await. Cleared as it is called, so a stray second close
  // cannot answer a question that has already been answered.
  const answer = useRef<((choice: string | null) => void) | null>(null);

  const ask = useCallback((next: Request) => {
    return new Promise<string | null>((resolve) => {
      answer.current?.(null);
      answer.current = resolve;
      setRequest(next);
    });
  }, []);

  const close = useCallback((choice: string | null) => {
    setRequest(null);

    const resolve = answer.current;
    answer.current = null;
    resolve?.(choice);
  }, []);

  // showModal is imperative — there is no open prop that puts an element in the
  // top layer — so opening is an effect on the request rather than a render.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    if (request && !el.open) el.showModal();
    if (!request && el.open) el.close();
  }, [request]);

  const dialog = (
    <dialog
      ref={ref}
      className="modal"
      aria-labelledby="confirm-title"
      // Escape and the window close button both arrive here.
      onCancel={(event) => {
        event.preventDefault();
        close(null);
      }}
      // A click landing on the dialog itself is a click on the backdrop: the
      // panel inside it swallows anything aimed at the content.
      onClick={(event) => {
        if (event.target === ref.current) close(null);
      }}
    >
      {request && (
        <div className="modal-panel">
          <h2 id="confirm-title">{request.title}</h2>
          <p>{request.body}</p>

          <div className="modal-actions">
            {/* Focused first on purpose. Backing out should never be what a
                reflexive Enter or Space lands on the far side of. */}
            <button className="btn" autoFocus onClick={() => close(null)}>
              {request.cancelLabel}
            </button>

            {request.choices.map((choice) => (
              <button
                key={choice.key}
                className={choice.danger ? "btn btn-danger" : "btn btn-primary"}
                onClick={() => close(choice.key)}
              >
                {choice.label}
              </button>
            ))}
          </div>
        </div>
      )}
    </dialog>
  );

  return { ask, dialog };
}
