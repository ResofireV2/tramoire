import { useEffect, useRef, useState } from "react";

import { label, ofType } from "../lib/entities";
import { fieldsFor, sectionsFor, subtitleOf } from "../lib/fields";
import type { Entity, Pair } from "../lib/storage";

type Props = {
  type: string;
  entities: Entity[];
  selectedId: string | null;
  hasProject: boolean;
  onSelect: (entity: Entity) => void;
  onCreate: () => void;
  /** A name or type changed — worth writing straight away, since the file moves. */
  onChange: (entity: Entity) => void;
  /** Anything else changed — debounced, like scene prose. */
  onEdit: (entity: Entity) => void;
  /** Leaving a field: write what is pending now rather than on a timer. */
  onFlush: () => void;
  onDelete: (entity: Entity) => void;
  /** A record just made, whose name should be waiting to be typed over. */
  naming?: string | null;
  onNamed?: () => void;
};

/** Comma-separated, with whatever spacing someone finds readable. */
function aliases(text: string): string[] {
  return text
    .split(",")
    .map((alias) => alias.trim())
    .filter(Boolean);
}

/**
 * The list of one kind of entity, and the record for whichever is selected.
 *
 * The notes are a plain textarea rather than the manuscript's editor. They are
 * markdown someone reads in a text editor as often as here, and the rich editor
 * exists to make prose decisions the exporter honours — decisions a note about
 * a character does not need.
 */
export function Entities({
  type,
  entities,
  selectedId,
  hasProject,
  onSelect,
  onCreate,
  onChange,
  onEdit,
  onFlush,
  onDelete,
  naming,
  onNamed,
}: Props) {
  const shown = ofType(entities, type);
  const selected = shown.find((entity) => entity.id === selectedId) ?? null;

  return (
    <>
      <nav className="binder" aria-label={label(type)}>
        <div className="act">
          <span className="act-title">{label(type)}</span>
          <button
            className="act-add"
            aria-label={`New ${type}`}
            disabled={!hasProject}
            onClick={onCreate}
          >
            +
          </button>
        </div>

        {shown.map((entity) => (
          <div className="scene-row" key={entity.id}>
            <button
              className="scene"
              aria-current={entity.id === selectedId}
              onClick={() => onSelect(entity)}
            >
              <span className="t">{entity.name}</span>
              {subtitleOf(entity) && <span className="m">{subtitleOf(entity)}</span>}
            </button>

            <button
              className="scene-delete"
              aria-label={`Move ${entity.name} to trash`}
              onClick={() => onDelete(entity)}
            >
              ×
            </button>
          </div>
        ))}

        {hasProject && shown.length === 0 && (
          <p className="binder-empty">
            No {label(type).toLowerCase()} yet. Press <b>+</b> to make one.
          </p>
        )}

        {!hasProject && <p className="binder-empty">Open a project first.</p>}
      </nav>

      {selected ? (
        <Record
          key={selected.id}
          entity={selected}
          onChange={onChange}
          onEdit={onEdit}
          onFlush={onFlush}
          naming={naming === selected.id}
          onNamed={onNamed}
        />
      ) : (
        <div className="editor-wrap">
          <div className="editor">
            <p className="empty">
              {hasProject ? "Pick one from the list." : "Open a project to start."}
            </p>
          </div>
        </div>
      )}
    </>
  );
}

/**
 * One entity's record.
 *
 * The fields shown come from the type, not from the file: a character is asked
 * its age, a location its city. Nothing here is required — a blank field is
 * removed from the file rather than written empty — and a key someone added by
 * hand appears alongside the template's own rather than being dropped.
 *
 * Keyed by id by the caller, so switching entities remounts rather than leaving
 * a half-typed field pointing at the wrong record.
 */
function Record({
  entity,
  onChange,
  onEdit,
  onFlush,
  naming,
  onNamed,
}: {
  entity: Entity;
  onChange: (entity: Entity) => void;
  onEdit: (entity: Entity) => void;
  onFlush: () => void;
  naming?: boolean;
  onNamed?: () => void;
}) {
  const [draft, setDraft] = useState(entity);
  const [changingType, setChangingType] = useState(false);

  // The aliases box keeps its own raw text. Rebuilding it from the parsed list
  // on every keystroke would trim the space out of "Day Walker" as fast as it
  // could be typed — a field that normalises what you are still typing is a
  // field you cannot type in.
  const [aliasText, setAliasText] = useState(entity.aliases.join(", "));

  // The file may have moved under this record when its name was saved, so what
  // is sent next has to build on whatever came back last.
  const saved = useRef(entity);
  useEffect(() => {
    saved.current = entity;
    setDraft((current) => ({ ...current, file: entity.file }));
  }, [entity]);

  // A record called "New character" in a long list is no use to anyone, so a
  // new one hands over its name field with the placeholder text selected.
  const nameBox = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!naming) return;

    nameBox.current?.focus();
    nameBox.current?.select();
    onNamed?.();
  }, [naming]); // eslint-disable-line react-hooks/exhaustive-deps

  const fields = fieldsFor(draft.type, entity.fields);
  const sections = sectionsFor(draft.type, entity.sections);

  const valueOf = (pairs: Pair[], key: string) =>
    pairs.find((pair) => pair.key === key)?.value ?? "";

  /** Replace one key's value, keeping the order the form is showing. */
  function withPair(pairs: Pair[], keys: string[], key: string, value: string): Pair[] {
    const next = new Map(pairs.map((pair) => [pair.key, pair.value]));
    next.set(key, value);

    return keys
      .map((k) => ({ key: k, value: next.get(k) ?? "" }))
      .filter((pair) => pair.value !== "" || pairs.some((p) => p.key === pair.key));
  }

  function edit(changes: Partial<Entity>) {
    const next = { ...draft, ...changes };
    setDraft(next);
    onEdit(next);
  }

  return (
    <div className="editor-wrap">
      <div className="editor record">
        <input
          ref={nameBox}
          className="record-name"
          aria-label="Name"
          placeholder="Name"
          value={draft.name}
          onChange={(event) => setDraft({ ...draft, name: event.target.value })}
          onBlur={() => {
            const name = draft.name.trim() || saved.current.name;
            setDraft({ ...draft, name });
            if (name !== saved.current.name) onChange({ ...draft, name });
          }}
          onKeyDown={(event) => event.key === "Enter" && event.currentTarget.blur()}
        />

        <label className="field record-aliases">
          <span>Also called</span>
          <input
            value={aliasText}
            placeholder="Day Walker, Ms Okonkwo"
            onChange={(event) => {
              setAliasText(event.target.value);
              edit({ aliases: aliases(event.target.value) });
            }}
            onBlur={() => {
              // Tidied only once they have finished, never while typing.
              setAliasText(aliases(aliasText).join(", "));
              onFlush();
            }}
          />
        </label>

        {fields.length > 0 && (
          <div className="record-fields">
            {fields.map((field) => (
              <label className="field" key={field.key}>
                <span>{field.label}</span>
                <input
                  value={valueOf(draft.fields, field.key)}
                  placeholder={field.placeholder}
                  onBlur={onFlush}
                  onChange={(event) =>
                    edit({
                      fields: withPair(
                        draft.fields,
                        fields.map((f) => f.key),
                        field.key,
                        event.target.value
                      ),
                    })
                  }
                />
              </label>
            ))}
          </div>
        )}

        {sections.map((heading) => (
          <label className="record-section" key={heading}>
            <span>{heading}</span>
            <textarea
              value={valueOf(draft.sections, heading)}
              onBlur={onFlush}
              onChange={(event) =>
                edit({
                  sections: withPair(draft.sections, sections, heading, event.target.value),
                })
              }
            />
          </label>
        ))}

        <div className="record-type">
          {changingType ? (
            <input
              autoFocus
              aria-label="Type"
              defaultValue={draft.type}
              onBlur={(event) => {
                setChangingType(false);
                const type = event.target.value.trim();
                if (type && type !== saved.current.type) onChange({ ...draft, type });
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter") event.currentTarget.blur();
                if (event.key === "Escape") setChangingType(false);
              }}
            />
          ) : (
            // Quiet and at the foot, because what something is gets decided
            // once and changed almost never.
            <button onClick={() => setChangingType(true)}>Type: {draft.type}</button>
          )}
        </div>
      </div>
    </div>
  );
}
