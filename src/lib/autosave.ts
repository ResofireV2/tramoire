/**
 * Debounced writes with an explicit flush.
 *
 * The subtle part: the file a save is destined for is captured when the save is
 * *queued*, not when the timer fires. Reading "the current scene" at fire time
 * is how a debounced editor writes one scene's prose into another scene's file
 * when you switch fast. Flush before switching scenes and before the window
 * goes away, and no keystroke is ever lost.
 */

export type SaveState = "idle" | "saving" | "saved" | "error";

export type SaveTarget = {
  projectPath: string;
  file: string;
};

type Writer = (target: SaveTarget, content: string) => Promise<void>;

export type Saver = {
  /** Queue a write. Replaces any pending write for the same target. */
  queue(target: SaveTarget, content: string): void;
  /** Write anything pending right now and wait for it to land. */
  flush(): Promise<void>;
  /** Drop pending work without writing. For closing a project. */
  cancel(): void;
};

export function createSaver(
  write: Writer,
  onState: (state: SaveState, detail?: string) => void,
  delay = 600
): Saver {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let pending: { target: SaveTarget; content: string } | null = null;
  // Writes are chained so two flushes can never race onto the same file.
  let chain: Promise<void> = Promise.resolve();

  function run(): Promise<void> {
    if (!pending) return chain;

    const { target, content } = pending;
    pending = null;

    chain = chain
      .then(() => write(target, content))
      .then(() => onState("saved"))
      .catch((error: unknown) => onState("error", String(error)));

    return chain;
  }

  return {
    queue(target, content) {
      pending = { target, content };
      onState("saving");
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        void run();
      }, delay);
    },

    flush() {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      return run();
    },

    cancel() {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      pending = null;
    },
  };
}
