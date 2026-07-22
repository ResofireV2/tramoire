import { describe, expect, it } from "vitest";

import { label, ofType, types } from "./entities";
import type { Entity } from "./storage";

const entity = (name: string, type: string): Entity => ({
  id: `en-${name}`,
  name,
  type,
  aliases: [],
  fields: [],
  sections: [],
  notes: "",
  file: `entities/${name}.md`,
});

describe("types", () => {
  it("always offers the starters, so an empty project has a way in", () => {
    expect(types([])).toEqual(["character", "location", "item"]);
  });

  it("adds whatever else the folder turns out to hold", () => {
    const found = types([entity("nadia", "character"), entity("blood-magic", "magic system")]);
    expect(found).toEqual(["character", "location", "item", "magic system"]);
  });

  it("lists each type once, however many use it", () => {
    const found = types([entity("a", "research"), entity("b", "research")]);
    expect(found.filter((t) => t === "research")).toHaveLength(1);
  });
});

describe("label", () => {
  it("pluralises and capitalises", () => {
    expect(label("character")).toBe("Characters");
    expect(label("magic system")).toBe("Magic systems");
  });

  it("copes with the endings that need more than an s", () => {
    expect(label("prophecy")).toBe("Prophecies");
    expect(label("witness")).toBe("Witnesses");
    expect(label("church")).toBe("Churches");
  });

  it("leaves a vowel before the y alone", () => {
    expect(label("journey")).toBe("Journeys");
  });

  it("names the untyped rather than showing a blank heading", () => {
    expect(label("")).toBe("Everything else");
  });
});

describe("ofType", () => {
  it("keeps only the matching ones", () => {
    const all = [entity("nadia", "character"), entity("sundowner", "location")];
    expect(ofType(all, "character").map((e) => e.name)).toEqual(["nadia"]);
  });
});
