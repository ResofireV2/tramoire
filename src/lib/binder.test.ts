import { describe, expect, it } from "vitest";

import { dropPosition, nextPosition } from "./binder";
import type { Project } from "./storage";

const scene = (id: string) => ({ id, title: id, file: `scenes/${id}.md`, status: "" });

/** Two acts, because the interesting moves are the ones that cross. */
const project: Project = {
  formatVersion: 1,
  title: "The county line",
  acts: [
    { id: "act-1", title: "Act one", scenes: [scene("one"), scene("two")] },
    { id: "act-2", title: "Act two", scenes: [scene("three")] },
  ],
};

describe("within an act", () => {
  it("targets index + 1 moving down, not index + 2", () => {
    // Lifting the scene out shifts its successor up first, so this is the slot
    // after it once it is gone. The off-by-one lives here.
    expect(nextPosition(project, "one", "down")).toEqual({ actId: "act-1", index: 1 });
  });

  it("targets index - 1 moving up", () => {
    expect(nextPosition(project, "two", "up")).toEqual({ actId: "act-1", index: 0 });
  });
});

describe("across acts", () => {
  it("steps off the end of an act into the top of the next", () => {
    expect(nextPosition(project, "two", "down")).toEqual({ actId: "act-2", index: 0 });
  });

  it("steps off the top of an act onto the end of the previous", () => {
    expect(nextPosition(project, "three", "up")).toEqual({ actId: "act-1", index: 2 });
  });

  it("appends to an empty destination act", () => {
    const empty: Project = {
      ...project,
      acts: [project.acts[0], { id: "act-2", title: "Act two", scenes: [] }],
    };
    expect(nextPosition(empty, "two", "down")).toEqual({ actId: "act-2", index: 0 });
  });
});

describe("dropping", () => {
  it("shifts a slot below the scene up by one", () => {
    // Slot 2 is the end of act one. Once "one" is lifted out there is only
    // "two" left, so the scene lands at 1.
    expect(dropPosition(project, "one", { actId: "act-1", index: 2 })).toEqual({
      actId: "act-1",
      index: 1,
    });
  });

  it("leaves a slot above the scene alone", () => {
    expect(dropPosition(project, "two", { actId: "act-1", index: 0 })).toEqual({
      actId: "act-1",
      index: 0,
    });
  });

  it("treats both slots around a scene as no move at all", () => {
    expect(dropPosition(project, "one", { actId: "act-1", index: 0 })).toBeNull();
    expect(dropPosition(project, "one", { actId: "act-1", index: 1 })).toBeNull();
  });

  it("does not shift when the slot is in another act", () => {
    expect(dropPosition(project, "one", { actId: "act-2", index: 1 })).toEqual({
      actId: "act-2",
      index: 1,
    });
  });

  it("returns null for a scene or project that is not there", () => {
    expect(dropPosition(project, "nope", { actId: "act-1", index: 0 })).toBeNull();
    expect(dropPosition(null, "one", { actId: "act-1", index: 0 })).toBeNull();
  });
});

describe("the ends of the manuscript", () => {
  it("will not move the first scene up", () => {
    expect(nextPosition(project, "one", "up")).toBeNull();
  });

  it("will not move the last scene down", () => {
    expect(nextPosition(project, "three", "down")).toBeNull();
  });

  it("returns null for a scene or project that is not there", () => {
    expect(nextPosition(project, "nope", "down")).toBeNull();
    expect(nextPosition(null, "one", "down")).toBeNull();
  });
});
