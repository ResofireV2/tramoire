/**
 * Debounced writes with an explicit flush.
 *
 * The subtle part: what a save is destined for is captured when the save is
 * *queued*, not when the timer fires. Reading "the current scene" at fire time
 * is how a debounced editor writes one scene's prose into another scene's file
 * when you switch fast. Flush before switching scenes and before the window
 * goes away, and no keystroke is ever lost.
 *
 * Generic in what it writes and what it writes to, because an entity record
 * needs the same guarantee as a scene and getting it right twice is getting it
 * wrong once.
 */

export type SaveState = "idle" | "saving" | "saved" | "error";

export type SaveTarget = {
  projectPath: string;
  file: string;
};

type Writer<T, C> = (target: T, content: C) => Promise<void>;

export type Saver<T = SaveTarget, C = string> = {
  /** Queue a write. Replaces any pending write, so flush before switching. */
  queue(target: T, content: C): void;
  /** Write anything pending right now and wait for it to land. */
  flush(): Promise<void>;
  /** Drop pending work without writing. For closing a project. */
  cancel(): void;
};

export function createSaver<T = SaveTarget, C = string>(
  write: Writer<T, C>,
  onState: (state: SaveState, detail?: string) => void,
  delay = 600
): Saver<T, C> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let pending: { target: T; content: C } | null = null;
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
