import type { ReactNode } from "react";

import { label } from "../lib/entities";

type Props = {
  /** "manuscript", or the entity type being shown. */
  view: string;
  types: string[];
  onChange: (view: string) => void;
};

/**
 * The column of destinations down the far left.
 *
 * One icon per entity type in use, which is why adding "magic system" costs
 * nothing: the rail is built from the words already in the folder rather than
 * a list maintained in here. Only the drawing is looked up by name, and
 * anything unrecognised gets a neutral mark rather than no mark.
 */
export function Rail({ view, types, onChange }: Props) {
  return (
    <nav className="rail" aria-label="Sections">
      <button
        className="rail-item"
        aria-current={view === "manuscript"}
        aria-label="Manuscript"
        title="Manuscript"
        onClick={() => onChange("manuscript")}
      >
        <Icon name="manuscript" />
      </button>

      <div className="rail-rule" />

      {types.map((type) => (
        <button
          key={type}
          className="rail-item"
          aria-current={view === type}
          aria-label={label(type)}
          title={label(type)}
          onClick={() => onChange(type)}
        >
          <Icon name={type} />
        </button>
      ))}
    </nav>
  );
}

/** Line drawings at a common weight, so the rail reads as one set. */
function Icon({ name }: { name: string }) {
  const path = PATHS[name] ?? PATHS.default;

  return (
    <svg
      viewBox="0 0 20 20"
      width="19"
      height="19"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {path}
    </svg>
  );
}

const PATHS: Record<string, ReactNode> = {
  manuscript: (
    <>
      <path d="M4 4h5a2 2 0 0 1 2 2v10a2 2 0 0 0-2-2H4z" />
      <path d="M16 4h-5a2 2 0 0 0-2 2v10a2 2 0 0 1 2-2h5z" />
    </>
  ),
  character: (
    <>
      <circle cx="10" cy="7" r="2.6" />
      <path d="M4.5 16.5a5.5 5.5 0 0 1 11 0" />
    </>
  ),
  location: (
    <>
      <path d="M10 17s5-4.6 5-8a5 5 0 0 0-10 0c0 3.4 5 8 5 8z" />
      <circle cx="10" cy="9" r="1.7" />
    </>
  ),
  item: (
    <>
      <path d="M10 3 17 6.7v6.6L10 17l-7-3.7V6.7z" />
      <path d="M3 6.7 10 10.4l7-3.7M10 10.4V17" />
    </>
  ),
  note: (
    <>
      <path d="M5 3h7l3 3v11H5z" />
      <path d="M12 3v3h3M7.5 10h5M7.5 13h5" />
    </>
  ),
  research: (
    <>
      <circle cx="9" cy="9" r="5" />
      <path d="m13 13 4 4" />
    </>
  ),
  default: (
    <>
      <circle cx="10" cy="10" r="6" />
    </>
  ),
};
