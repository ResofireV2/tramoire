import type { Chrome, EditorTheme, Theme } from "../lib/theme";

type Props = {
  projectTitle: string | null;
  theme: Theme;
  onThemeChange: (theme: Theme) => void;
  onOpenProject: () => void;
};

export function TopBar({ projectTitle, theme, onThemeChange, onOpenProject }: Props) {
  return (
    <header className="topbar">
      <div className="brand">
        <b>Tramoire</b>
        <span>{projectTitle ?? "No project open"}</span>
      </div>

      <div className="toggles">
        <span className="seg-label">Chrome</span>
        <Segmented<Chrome>
          value={theme.chrome}
          options={[
            ["dark", "Dark"],
            ["light", "Light"],
          ]}
          onChange={(chrome) => onThemeChange({ ...theme, chrome })}
        />

        <span className="seg-label" style={{ marginLeft: 8 }}>
          Editor
        </span>
        <Segmented<EditorTheme>
          value={theme.editor}
          options={[
            ["paper", "Paper"],
            ["ink", "Ink"],
          ]}
          onChange={(editor) => onThemeChange({ ...theme, editor })}
        />

        <button className="btn" style={{ marginLeft: 8 }} onClick={onOpenProject}>
          Open project
        </button>
      </div>
    </header>
  );
}

function Segmented<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: [T, string][];
  onChange: (value: T) => void;
}) {
  return (
    <div className="seg">
      {options.map(([key, label]) => (
        <button key={key} aria-pressed={value === key} onClick={() => onChange(key)}>
          {label}
        </button>
      ))}
    </div>
  );
}
