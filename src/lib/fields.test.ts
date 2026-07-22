import { describe, expect, it } from "vitest";

import { fieldsFor, sectionsFor, subtitleOf, templateFor } from "./fields";

describe("templates", () => {
  it("asks a character and a location different things", () => {
    expect(templateFor("character").fields.map((f) => f.key)).toEqual([
      "role",
      "age",
      "birthplace",
      "occupation",
    ]);
    expect(templateFor("location").fields.map((f) => f.key)).toEqual([
      "city",
      "state",
      "country",
    ]);
  });

  it("still gives an unknown type somewhere to write", () => {
    const template = templateFor("magic system");
    expect(template.fields).toEqual([]);
    expect(template.sections).toEqual(["Description"]);
  });
});

describe("what the form shows", () => {
  it("keeps a key someone added by hand", () => {
    const shown = fieldsFor("character", [{ key: "age" }, { key: "eye colour" }]);

    // Dropping it from the form would delete it from the file on the next save.
    expect(shown.map((f) => f.key)).toEqual([
      "role",
      "age",
      "birthplace",
      "occupation",
      "eye colour",
    ]);
    expect(shown[4].label).toBe("Eye colour");
  });

  it("labels an unlabelled key readably", () => {
    const [extra] = fieldsFor("magic system", [{ key: "power_source" }]);
    expect(extra.label).toBe("Power source");
  });

  it("keeps a heading someone invented, after the template's own", () => {
    const shown = sectionsFor("location", [{ key: "Rumours" }, { key: "Description" }]);
    expect(shown).toEqual(["Description", "Importance to the story", "Rumours"]);
  });
});

describe("what the list shows under a name", () => {
  it("shows a character's role, which is what tells a long list apart", () => {
    const nadia = { type: "character", fields: [{ key: "role", value: "Protagonist" }] };
    expect(subtitleOf(nadia)).toBe("Protagonist");
  });

  it("shows nothing rather than a stray label when it is unset", () => {
    expect(subtitleOf({ type: "character", fields: [] })).toBe("");
  });

  it("picks something else for a location", () => {
    const motel = { type: "location", fields: [{ key: "city", value: "Winslow" }] };
    expect(subtitleOf(motel)).toBe("Winslow");
  });
});
