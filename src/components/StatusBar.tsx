import type { SaveState } from "../lib/autosave";

type Props = {
  file: string | null;
  words: number;
  saveState: SaveState;
  saveError: string | null;
};

const LABEL: Record<SaveState, string> = {
  idle: "",
  saving: "Saving…",
  saved: "Saved",
  error: "Could not save",
};

export function StatusBar({ file, words, saveState, saveError }: Props) {
  return (
    <footer className="status">
      <span className="path" title={file ?? undefined}>
        {file ?? ""}
      </span>
      <span>{file ? `${words.toLocaleString()} words in this scene` : ""}</span>
      <span className={saveState === "error" ? "save-error" : undefined} title={saveError ?? undefined}>
        {LABEL[saveState]}
      </span>
    </footer>
  );
}
