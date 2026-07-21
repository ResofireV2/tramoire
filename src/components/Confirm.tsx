import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";

export type Request = {
  title: string;
  body: string;
  confirmLabel: string;
  cancelLabel: string;
};

/**
 * A confirmation that looks like the rest of the application.
 *
 * Built on the native `<dialog>` element rather than a div with a high z-index,
 * which is what buys the modal behaviour: the top layer, a focus trap, Escape,
 * and the background going inert. Only the appearance is ours.
 *
 * `ask` resolves to what they chose, so a caller reads as one line and no
 * decision has to be split across a callback:
 *
 *     if (!(await confirm.ask({ ... }))) return;
 */
export function useConfirm(): { ask: (request: Request) => Promise<boolean>; dialog: ReactNode } {
  const [request, setRequest] = useState<Request | null>(null);
  const ref = useRef<HTMLDialogElement>(null);

  // Held across the await. Cleared as it is called, so a stray second close
  // cannot answer a question that has already been answered.
  const answer = useRef<((ok: boolean) => void) | null>(null);

  const ask = useCallback((next: Request) => {
    return new Promise<boolean>((resolve) => {
      answer.current?.(false);
      answer.current = resolve;
      setRequest(next);
    });
  }, []);

  const close = useCallback((ok: boolean) => {
    setRequest(null);

    const resolve = answer.current;
    answer.current = null;
    resolve?.(ok);
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
      className="confirm"
      aria-labelledby="confirm-title"
      // Escape and the window close button both arrive here.
      onCancel={(event) => {
        event.preventDefault();
        close(false);
      }}
      // A click landing on the dialog itself is a click on the backdrop: the
      // panel inside it swallows anything aimed at the content.
      onClick={(event) => {
        if (event.target === ref.current) close(false);
      }}
    >
      {request && (
        <div className="confirm-panel">
          <h2 id="confirm-title">{request.title}</h2>
          <p>{request.body}</p>

          <div className="confirm-actions">
            {/* Focused first on purpose. The destructive button should never be
                what a reflexive Enter or Space lands on. */}
            <button className="btn" autoFocus onClick={() => close(false)}>
              {request.cancelLabel}
            </button>
            <button className="btn btn-danger" onClick={() => close(true)}>
              {request.confirmLabel}
            </button>
          </div>
        </div>
      )}
    </dialog>
  );

  return { ask, dialog };
}
