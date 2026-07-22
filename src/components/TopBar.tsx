import { Menu } from "./Menu";
import type { Recent } from "../lib/settings";
import type { Chrome, EditorTheme, Theme } from "../lib/theme";

type Props = {
  projectTitle: string | null;
  projectPath: string | null;
  recent: Recent[];
  theme: Theme;
  onThemeChange: (theme: Theme) => void;
  onNewProject: () => void;
  onOpenProject: () => void;
  onOpenRecent: (entry: Recent) => void;
};

export function TopBar({
  projectTitle,
  projectPath,
  recent,
  theme,
  onThemeChange,
  onNewProject,
  onOpenProject,
  onOpenRecent,
}: Props) {
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

        <div style={{ marginLeft: 8 }}>
          <Menu
            recent={recent}
            currentPath={projectPath}
            onNewProject={onNewProject}
            onOpenProject={onOpenProject}
            onOpenRecent={onOpenRecent}
          />
        </div>
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
