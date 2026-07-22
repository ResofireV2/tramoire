import { useEffect, useRef, useState } from "react";

import type { Recent } from "../lib/settings";

type Props = {
  recent: Recent[];
  currentPath: string | null;
  onNewProject: () => void;
  onOpenProject: () => void;
  onOpenRecent: (entry: Recent) => void;
};

/**
 * The project menu.
 *
 * In the window rather than a native menu bar, for the same reason the confirm
 * dialog is: a system menu would not follow the two themes, and the shell is
 * the thing this application is most particular about.
 */
export function Menu({ recent, currentPath, onNewProject, onOpenProject, onOpenRecent }: Props) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);

  // Closing on any click outside is what makes this behave like a menu rather
  // than a panel that happens to be dismissible.
  useEffect(() => {
    if (!open) return;

    const dismiss = (event: MouseEvent) => {
      if (!wrap.current?.contains(event.target as Node)) setOpen(false);
    };

    document.addEventListener("mousedown", dismiss);
    return () => document.removeEventListener("mousedown", dismiss);
  }, [open]);

  function run(action: () => void) {
    setOpen(false);
    action();
  }

  return (
    <div
      className="menu"
      ref={wrap}
      onKeyDown={(event) => {
        if (event.key === "Escape") setOpen(false);
      }}
    >
      <button className="btn" aria-expanded={open} aria-haspopup="menu" onClick={() => setOpen(!open)}>
        Project
      </button>

      {open && (
        <div className="menu-popup" role="menu">
          <button role="menuitem" onClick={() => run(onNewProject)}>
            New project… <kbd>Ctrl N</kbd>
          </button>
          <button role="menuitem" onClick={() => run(onOpenProject)}>
            Open project… <kbd>Ctrl O</kbd>
          </button>

          {recent.length > 0 && (
            <>
              <div className="menu-label">Recent</div>
              {recent.map((entry) => (
                <button
                  key={entry.path}
                  role="menuitem"
                  className="menu-recent"
                  aria-current={entry.path === currentPath}
                  title={entry.path}
                  onClick={() => run(() => onOpenRecent(entry))}
                >
                  {entry.title}
                  <span className="menu-path">{entry.path}</span>
                </button>
              ))}
            </>
          )}
        </div>
      )}
    </div>
  );
}
