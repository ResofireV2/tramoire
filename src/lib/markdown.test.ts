import { describe, expect, it } from "vitest";

import { countWords, docToMd, mdToDoc } from "./markdown";

/** What a scene file goes through on every save: disk -> editor -> disk. */
const roundTrip = (md: string) => docToMd(mdToDoc(md));

describe("parsing", () => {
  it("splits paragraphs on blank lines", () => {
    const doc = mdToDoc("One.\n\nTwo.\n");
    expect(doc.content).toHaveLength(2);
  });

  it("joins soft-wrapped lines within a paragraph", () => {
    const doc = mdToDoc("One line\nand its wrap.");
    expect(doc.content[0].content?.[0].text).toBe("One line and its wrap.");
  });

  it("reads italic and bold", () => {
    const doc = mdToDoc("plain *soft* and **hard**");
    const marks = doc.content[0].content?.map((n) => n.marks?.[0]?.type ?? null);
    expect(marks).toEqual([null, "italic", null, "bold"]);
  });

  it("reads nested emphasis", () => {
    const doc = mdToDoc("***both***");
    expect(doc.content[0].content?.[0].marks?.map((m) => m.type).sort()).toEqual([
      "bold",
      "italic",
    ]);
  });

  it("reads emphasis inside emphasis", () => {
    const doc = mdToDoc("**hard *and soft* again**");
    const nodes = doc.content[0].content ?? [];
    expect(nodes[1].text).toBe("and soft");
    expect(nodes[1].marks?.map((m) => m.type).sort()).toEqual(["bold", "italic"]);
  });

  it("leaves an unclosed delimiter alone", () => {
    const doc = mdToDoc("a lone * asterisk");
    expect(doc.content[0].content?.[0].text).toBe("a lone * asterisk");
  });

  it("does not emphasise inside a word", () => {
    const doc = mdToDoc("snake_case_name");
    expect(doc.content[0].content?.[0].text).toBe("snake_case_name");
  });

  it("honours escapes", () => {
    const doc = mdToDoc("a \\*literal\\* star");
    expect(doc.content[0].content?.[0].text).toBe("a *literal* star");
  });

  it("normalises CRLF", () => {
    const doc = mdToDoc("One.\r\n\r\nTwo.\r\n");
    expect(doc.content).toHaveLength(2);
  });

  it("produces one empty paragraph for an empty file", () => {
    expect(mdToDoc("")).toEqual({ type: "doc", content: [{ type: "paragraph" }] });
  });
});

describe("serialising", () => {
  it("separates paragraphs with a blank line and ends with a newline", () => {
    expect(docToMd(mdToDoc("One.\n\nTwo."))).toBe("One.\n\nTwo.\n");
  });

  it("escapes characters that would otherwise be read as emphasis", () => {
    const doc = mdToDoc("a \\*literal\\* star");
    expect(docToMd(doc)).toBe("a \\*literal\\* star\n");
  });

  it("drops nothing when the doc is empty", () => {
    expect(docToMd({ type: "doc", content: [{ type: "paragraph" }] })).toBe("\n");
  });
});

describe("round trip", () => {
  const cases = [
    "Plain prose with nothing in it.\n",
    "She was *angry about his neck* and pretended otherwise.\n",
    "Two paragraphs.\n\nAnd a **second** one.\n",
    "***Everything*** at once.\n",
    "**hard *and soft* again**\n",
    "An escaped \\*star\\* and an \\_underscore\\_.\n",
    "Curly quotes \u201Clike this\u201D and an em dash — held.\n",
    "Unknown markdown such as # a heading survives as text.\n",
  ];

  for (const md of cases) {
    it(`is stable for: ${md.trim().slice(0, 40)}`, () => {
      expect(roundTrip(md)).toBe(md);
      // And stable again, which is what actually matters across many saves.
      expect(roundTrip(roundTrip(md))).toBe(md);
    });
  }
});

describe("word count", () => {
  it("counts whitespace-separated runs", () => {
    expect(countWords("  one two   three ")).toBe(3);
    expect(countWords("   ")).toBe(0);
  });
});
