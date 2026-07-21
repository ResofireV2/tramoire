/**
 * Editor configuration.
 *
 * The schema is the point. Everything a writer can express here has a meaning —
 * emphasis, strong emphasis — and nothing has an appearance. Fonts, sizes,
 * colours and alignment are compile-time decisions and are unrepresentable in
 * the document by construction, so pasted text cannot smuggle them into an
 * export. Removing the escape hatch is cheaper than policing it.
 */

import { textInputRule, Extension, type Editor } from "@tiptap/core";
import { Fragment, Slice } from "@tiptap/pm/model";
import StarterKit from "@tiptap/starter-kit";

/**
 * Smart typography, hand-rolled rather than pulled from an extension, because
 * the off-the-shelf one also converts (c) to a copyright sign and 1/2 to a
 * vulgar fraction, which is not something a novel wants. Each rule is undone
 * individually by Backspace immediately after it fires.
 */
const typography = Extension.create({
  name: "tramoireTypography",
  addInputRules() {
    return [
      textInputRule({ find: /\.\.\.$/, replace: "…" }),
      textInputRule({ find: /--$/, replace: "—" }),
      // Opening quotes: only after a break, bracket or dash.
      textInputRule({ find: /(?:^|[\s([{<—–])(")$/, replace: "\u201C" }),
      textInputRule({ find: /(?:^|[\s([{<—–])(')$/, replace: "\u2018" }),
      // Anything else is a closing quote or an apostrophe.
      textInputRule({ find: /(")$/, replace: "\u201D" }),
      textInputRule({ find: /(')$/, replace: "\u2019" }),
    ];
  },
});

export const extensions = [
  StarterKit.configure({
    // Kept: document, paragraph, text, bold, italic, dropcursor, gapcursor,
    // undoRedo. Everything below has no markdown representation in the Phase 1
    // schema, so allowing it would mean silently dropping it on save.
    heading: false,
    blockquote: false,
    bulletList: false,
    orderedList: false,
    listItem: false,
    listKeymap: false,
    code: false,
    codeBlock: false,
    horizontalRule: false,
    strike: false,
    link: false,
    underline: false,
    hardBreak: false,
    trailingNode: false,
  }),
  typography,
];

export const editorProps = {
  attributes: {
    class: "prose",
    spellcheck: "true",
    // Off by default: autocorrect mangles invented names.
    autocorrect: "off",
    autocapitalize: "off",
  },

  /**
   * Paste arrives as plain text, always. Blank lines become paragraphs; single
   * newlines are treated as soft wrapping and collapse to spaces.
   */
  handlePaste(view: import("@tiptap/pm/view").EditorView, event: ClipboardEvent) {
    const text = event.clipboardData?.getData("text/plain");
    if (!text) return false;

    const paragraphs = text
      .replace(/\r\n?/g, "\n")
      .split(/\n{2,}/)
      .map((block) => block.replace(/\n/g, " ").trim())
      .filter(Boolean);

    if (!paragraphs.length) return true;

    const { schema, tr } = view.state;
    const nodes = paragraphs.map((body) =>
      schema.nodes.paragraph.create(null, schema.text(body))
    );

    // openStart/openEnd of 1 lets the first pasted paragraph merge into the one
    // the caret is already in, which is what pasting mid-sentence should do.
    view.dispatch(tr.replaceSelection(new Slice(Fragment.from(nodes), 1, 1)).scrollIntoView());
    return true;
  },
};

export function editorText(editor: Editor | null): string {
  return editor?.getText({ blockSeparator: " " }) ?? "";
}
