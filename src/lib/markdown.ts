/**
 * Markdown <-> ProseMirror document, for the narrow schema Tramoire allows.
 *
 * The schema is deliberately small: paragraphs, bold, italic. That is the whole
 * grammar, which is why this is hand-written rather than a dependency — the
 * exact bytes that land in a scene file are a design decision, not a library's.
 *
 * Round-trip guarantee: `docToMd(mdToDoc(x))` is stable for anything this
 * writer produces. Markdown it does not understand (headings, lists, links)
 * survives as literal paragraph text rather than being dropped.
 *
 * Known limitation: a hard-wrapped paragraph in a hand-authored file is joined
 * onto one line on the next save. Tramoire never hard-wraps its own output.
 */

export type Mark = "bold" | "italic";

export type TextNode = {
  type: "text";
  text: string;
  marks?: { type: Mark }[];
};

export type Paragraph = {
  type: "paragraph";
  content?: TextNode[];
};

export type Doc = {
  type: "doc";
  content: Paragraph[];
};

/** Characters escaped on the way out so they survive the way back in. */
const ESCAPABLE = new Set(["\\", "*", "_"]);

const EMPTY_DOC: Doc = { type: "doc", content: [{ type: "paragraph" }] };

/* ------------------------------------------------------------------ parse */

export function mdToDoc(md: string): Doc {
  const blocks = md
    .replace(/\r\n?/g, "\n")
    .split(/\n{2,}/)
    .map((block) => block.trim())
    .filter(Boolean);

  const content: Paragraph[] = blocks.map((block) => {
    const inline = parseInline(block.replace(/\n/g, " "));
    return inline.length ? { type: "paragraph", content: inline } : { type: "paragraph" };
  });

  return content.length ? { type: "doc", content } : EMPTY_DOC;
}

/**
 * Recursive-descent over emphasis delimiters. Recursion is what makes nesting
 * work: a run of three opens bold and italic together, and a `*` inside a `_`
 * span is found by the inner call rather than needing a separate pass.
 */
function parseInline(src: string, marks: Mark[] = []): TextNode[] {
  const out: TextNode[] = [];
  let buffer = "";
  let i = 0;

  const flush = () => {
    if (buffer) {
      out.push(makeText(buffer, marks));
      buffer = "";
    }
  };

  while (i < src.length) {
    const ch = src[i];

    if (ch === "\\" && i + 1 < src.length && ESCAPABLE.has(src[i + 1])) {
      buffer += src[i + 1];
      i += 2;
      continue;
    }

    if (ch === "*" || ch === "_") {
      const run = Math.min(runLength(src, i, ch), 3);
      const delimiter = ch.repeat(run);
      const wanted: Mark[] = run === 1 ? ["italic"] : run === 2 ? ["bold"] : ["bold", "italic"];

      const alreadyOpen = wanted.some((m) => marks.includes(m));
      const intraword = ch === "_" && isWordChar(src[i - 1]);

      if (!alreadyOpen && !intraword) {
        const close = findClose(src, i + run, delimiter);
        if (close !== -1) {
          flush();
          out.push(...parseInline(src.slice(i + run, close), [...marks, ...wanted]));
          i = close + run;
          continue;
        }
      }
    }

    buffer += ch;
    i++;
  }

  flush();
  return out;
}

function runLength(src: string, start: number, ch: string): number {
  let n = 0;
  while (src[start + n] === ch) n++;
  return n;
}

/** Find a closing run of exactly `delimiter.length`, skipping escaped chars. */
function findClose(src: string, from: number, delimiter: string): number {
  const ch = delimiter[0];
  const width = delimiter.length;

  for (let i = from; i < src.length; i++) {
    if (src[i] === "\\") {
      i++;
      continue;
    }
    if (src[i] !== ch) continue;

    const run = runLength(src, i, ch);
    if (run !== width) {
      i += run - 1;
      continue;
    }
    // An empty span (`**` with nothing between) is literal text, not a mark.
    if (i === from) return -1;
    if (ch === "_" && isWordChar(src[i + width])) continue;
    return i;
  }

  return -1;
}

function isWordChar(ch: string | undefined): boolean {
  return ch !== undefined && /[\p{L}\p{N}]/u.test(ch);
}

function makeText(text: string, marks: Mark[]): TextNode {
  return marks.length
    ? { type: "text", text, marks: marks.map((type) => ({ type })) }
    : { type: "text", text };
}

/* -------------------------------------------------------------- serialize */

export function docToMd(doc: unknown): string {
  const nodes = (doc as Doc | undefined)?.content ?? [];

  const paragraphs = nodes
    .filter((node) => node?.type === "paragraph")
    .map((p) => serializeInline(p.content ?? []));

  // Always LF, always one trailing newline. Files must be diffable across the
  // two machines this is developed on.
  return paragraphs.join("\n\n").replace(/[ \t]+$/gm, "").trim() + "\n";
}

/** Delimiters nest in this order, outermost first, so output is canonical. */
const MARK_ORDER: Mark[] = ["bold", "italic"];
const DELIMITER: Record<Mark, string> = { bold: "**", italic: "*" };

/**
 * Marks are opened and closed across the run of text nodes that carry them,
 * not around each node. Serialising node by node turns a bold paragraph with
 * one italic word inside it into a thicket of adjacent asterisks that no
 * markdown reader — including this one — parses back to the same document.
 */
function serializeInline(nodes: TextNode[]): string {
  let out = "";
  let open: Mark[] = [];

  for (const node of nodes) {
    const wanted = MARK_ORDER.filter((mark) =>
      (node.marks ?? []).some((m) => m.type === mark)
    );

    // Close from the inside out, back to the deepest shared prefix.
    let shared = 0;
    while (shared < open.length && shared < wanted.length && open[shared] === wanted[shared]) {
      shared++;
    }
    for (let i = open.length - 1; i >= shared; i--) out += DELIMITER[open[i]];

    for (let i = shared; i < wanted.length; i++) out += DELIMITER[wanted[i]];

    open = wanted;
    out += escape(node.text ?? "");
  }

  for (let i = open.length - 1; i >= 0; i--) out += DELIMITER[open[i]];

  return out;
}

function escape(text: string): string {
  return text.replace(/[\\*_]/g, (ch) => `\\${ch}`);
}

/* ------------------------------------------------------------------ counts */

export function countWords(text: string): number {
  const trimmed = text.trim();
  return trimmed ? trimmed.split(/\s+/).length : 0;
}
