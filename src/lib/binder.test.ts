import { describe, expect, it } from "vitest";

import {
  dropActPosition,
  dropChapterPosition,
  dropPosition,
  nextActPosition,
  nextChapterPosition,
  nextPosition,
} from "./binder";
import type { Project } from "./storage";

const scene = (id: string) => ({ id, title: id, file: `scenes/${id}.md`, status: "" });

/**
 * Two acts and three chapters, so every kind of boundary is present: within a
 * chapter, between chapters of one act, and across acts.
 *
 *   act-1  ch-1  one, two
 *          ch-2  three
 *   act-2  ch-3  four
 */
const project: Project = {
  formatVersion: 2,
  title: "The county line",
  acts: [
    {
      id: "act-1",
      title: "Act one",
      chapters: [
        { id: "ch-1", title: "Chapter one", scenes: [scene("one"), scene("two")] },
        { id: "ch-2", title: "Chapter two", scenes: [scene("three")] },
      ],
    },
    {
      id: "act-2",
      title: "Act two",
      chapters: [{ id: "ch-3", title: "Chapter three", scenes: [scene("four")] }],
    },
  ],
};

describe("moving a scene", () => {
  it("targets index + 1 moving down, not index + 2", () => {
    // Lifting the scene out shifts its successor up first, so this is the slot
    // after it once it is gone. The off-by-one lives here.
    expect(nextPosition(project, "one", "down")).toEqual({ parentId: "ch-1", index: 1 });
  });

  it("targets index - 1 moving up", () => {
    expect(nextPosition(project, "two", "up")).toEqual({ parentId: "ch-1", index: 0 });
  });

  it("steps off the end of a chapter into the top of the next", () => {
    expect(nextPosition(project, "two", "down")).toEqual({ parentId: "ch-2", index: 0 });
  });

  it("steps off the top of a chapter onto the end of the previous", () => {
    expect(nextPosition(project, "three", "up")).toEqual({ parentId: "ch-1", index: 2 });
  });

  it("crosses an act boundary without being told about acts", () => {
    // ch-2 is the last chapter of act one and ch-3 the first of act two. In
    // reading order they are neighbours, which is all this has to know.
    expect(nextPosition(project, "three", "down")).toEqual({ parentId: "ch-3", index: 0 });
    expect(nextPosition(project, "four", "up")).toEqual({ parentId: "ch-2", index: 1 });
  });

  it("stops at the ends of the manuscript", () => {
    expect(nextPosition(project, "one", "up")).toBeNull();
    expect(nextPosition(project, "four", "down")).toBeNull();
  });

  it("returns null for a scene or project that is not there", () => {
    expect(nextPosition(project, "nope", "down")).toBeNull();
    expect(nextPosition(null, "one", "down")).toBeNull();
  });
});

describe("moving a chapter", () => {
  it("steps within its act", () => {
    expect(nextChapterPosition(project, "ch-1", "down")).toEqual({ parentId: "act-1", index: 1 });
    expect(nextChapterPosition(project, "ch-2", "up")).toEqual({ parentId: "act-1", index: 0 });
  });

  it("steps off the end of an act into the next", () => {
    expect(nextChapterPosition(project, "ch-2", "down")).toEqual({ parentId: "act-2", index: 0 });
    expect(nextChapterPosition(project, "ch-3", "up")).toEqual({ parentId: "act-1", index: 2 });
  });

  it("stops at the ends of the book", () => {
    expect(nextChapterPosition(project, "ch-1", "up")).toBeNull();
    expect(nextChapterPosition(project, "ch-3", "down")).toBeNull();
  });

  it("moves into an act with no chapters in it", () => {
    const empty: Project = {
      ...project,
      acts: [project.acts[0], { id: "act-2", title: "Act two", chapters: [] }],
    };
    expect(nextChapterPosition(empty, "ch-2", "down")).toEqual({ parentId: "act-2", index: 0 });
  });
});

describe("moving an act", () => {
  it("steps one place in each direction", () => {
    expect(nextActPosition(project, "act-1", "down")).toBe(1);
    expect(nextActPosition(project, "act-2", "up")).toBe(0);
  });

  it("stops at the ends of the book", () => {
    expect(nextActPosition(project, "act-1", "up")).toBeNull();
    expect(nextActPosition(project, "act-2", "down")).toBeNull();
  });

  it("returns null for an act or project that is not there", () => {
    expect(nextActPosition(project, "act-9", "up")).toBeNull();
    expect(nextActPosition(null, "act-1", "up")).toBeNull();
  });
});

describe("dropping", () => {
  it("shifts a slot below the scene up by one", () => {
    // Slot 2 is the end of ch-1. Once "one" is lifted out there is only "two"
    // left, so the scene lands at 1.
    expect(dropPosition(project, "one", { parentId: "ch-1", index: 2 })).toEqual({
      parentId: "ch-1",
      index: 1,
    });
  });

  it("leaves a slot above the scene alone", () => {
    expect(dropPosition(project, "two", { parentId: "ch-1", index: 0 })).toEqual({
      parentId: "ch-1",
      index: 0,
    });
  });

  it("treats both slots around a scene as no move at all", () => {
    expect(dropPosition(project, "one", { parentId: "ch-1", index: 0 })).toBeNull();
    expect(dropPosition(project, "one", { parentId: "ch-1", index: 1 })).toBeNull();
  });

  it("does not shift when the slot is in another chapter", () => {
    expect(dropPosition(project, "one", { parentId: "ch-2", index: 1 })).toEqual({
      parentId: "ch-2",
      index: 1,
    });
  });

  it("applies the same rules one level up, to chapters", () => {
    expect(dropChapterPosition(project, "ch-1", { parentId: "act-1", index: 2 })).toEqual({
      parentId: "act-1",
      index: 1,
    });
    expect(dropChapterPosition(project, "ch-1", { parentId: "act-1", index: 1 })).toBeNull();
    expect(dropChapterPosition(project, "ch-1", { parentId: "act-2", index: 0 })).toEqual({
      parentId: "act-2",
      index: 0,
    });
  });

  it("applies them again to acts, which have no container", () => {
    expect(dropActPosition(project, "act-1", 2)).toBe(1);
    expect(dropActPosition(project, "act-2", 0)).toBe(0);

    // Both slots around an act leave it where it was.
    expect(dropActPosition(project, "act-1", 0)).toBeNull();
    expect(dropActPosition(project, "act-1", 1)).toBeNull();
  });

  it("returns null for a scene or project that is not there", () => {
    expect(dropPosition(project, "nope", { parentId: "ch-1", index: 0 })).toBeNull();
    expect(dropPosition(null, "one", { parentId: "ch-1", index: 0 })).toBeNull();
    expect(dropActPosition(project, "act-9", 0)).toBeNull();
  });
});
