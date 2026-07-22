/**
 * What each kind of entity is asked about.
 *
 * A template is only what the form *offers*. Every entity is the same record on
 * disk — frontmatter plus a body — so a type with no template still works, a
 * key added by hand in a text editor still shows, and a field left blank is not
 * written at all. Nothing here is load-bearing for the format; it decides which
 * boxes appear and in what order.
 *
 * Short facts go in frontmatter. Anything paragraph-length becomes a `##`
 * section in the body instead, because a paragraph on one unwrapped line is
 * unpleasant in the text editor someone opens this folder with in ten years.
 */

export type Template = {
  /** Frontmatter keys, in the order the form shows them. */
  fields: { key: string; label: string; placeholder?: string }[];
  /** Body headings, written verbatim into the markdown. */
  sections: string[];
  /**
   * The field shown under the name in the list. A long list wants the thing
   * that tells them apart at a glance — what a character is *for*, not what
   * they are called a second time.
   */
  subtitle: string;
};

const TEMPLATES: Record<string, Template> = {
  character: {
    fields: [
      { key: "role", label: "Role", placeholder: "Protagonist" },
      { key: "age", label: "Age", placeholder: "34" },
      { key: "birthplace", label: "Birthplace", placeholder: "Winslow, Arizona" },
      { key: "occupation", label: "Occupation", placeholder: "Night manager" },
    ],
    sections: ["Physical traits", "Personality", "Story purpose"],
    subtitle: "role",
  },

  location: {
    fields: [
      { key: "city", label: "City", placeholder: "Winslow" },
      { key: "state", label: "State or region", placeholder: "Arizona" },
      { key: "country", label: "Country", placeholder: "United States" },
    ],
    sections: ["Description", "Importance to the story"],
    subtitle: "city",
  },

  item: {
    fields: [
      { key: "owner", label: "Owner", placeholder: "Nadia Okonkwo" },
      { key: "origin", label: "Origin", placeholder: "Left in room 9" },
    ],
    sections: ["Description", "Importance to the story"],
    subtitle: "owner",
  },
};

/** A type nobody has written a template for still gets somewhere to write. */
const FALLBACK: Template = { fields: [], sections: ["Description"], subtitle: "role" };

export function templateFor(type: string): Template {
  return TEMPLATES[type] ?? FALLBACK;
}

/**
 * The template's fields, plus any key already in the file that it does not
 * mention — so something added by hand is shown rather than quietly dropped on
 * the next save.
 */
export function fieldsFor(
  type: string,
  present: { key: string }[]
): Template["fields"] {
  const template = templateFor(type);
  const known = new Set(template.fields.map((field) => field.key));

  const extra = present
    .filter((pair) => !known.has(pair.key))
    .map((pair) => ({ key: pair.key, label: sentence(pair.key) }));

  return [...template.fields, ...extra];
}

/** The same for body sections. */
export function sectionsFor(type: string, present: { key: string }[]) {
  const template = templateFor(type);
  const extra = present
    .map((pair) => pair.key)
    .filter((heading) => !template.sections.includes(heading));

  return [...template.sections, ...extra];
}

/** `birthplace` as a label, for a key nobody wrote a label for. */
function sentence(key: string): string {
  const words = key.replace(/[-_]+/g, " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * What to show under a name in the list, if anything.
 *
 * The type's own subtitle field first — a character's role is what tells a long
 * list apart. Failing that, what it is also called, which is often where a name
 * ends up before anyone fills the rest in.
 */
export function subtitleOf(entity: {
  type: string;
  aliases?: string[];
  fields: { key: string; value: string }[];
}) {
  const key = templateFor(entity.type).subtitle;
  const value = entity.fields.find((pair) => pair.key === key)?.value ?? "";

  return value || (entity.aliases ?? []).join(", ");
}
