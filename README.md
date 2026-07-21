# Tramoire

A local-first desktop application for planning and writing novels.

No server, no account, no network. A project is a folder of plain markdown that
stays readable, greppable and recoverable long after this application stops
being maintained. Cross-device sync is the user's business — put the folder in
Dropbox, iCloud Drive or Syncthing.

**Status: Phase 1.** Open a project folder, list its scenes, edit one in a rich
text editor, and watch the markdown file on disk change. That single loop
exercises the file format, the storage boundary, the editor and the markdown
round-trip at the same time, which is why it comes first.

---

## Running it

Prerequisites: Rust (stable), Node 20+, and native build tools.

<details>
<summary>Ubuntu / Debian (incl. Zorin OS)</summary>

```bash
sudo apt install libwebkit2gtk-4.1-dev build-essential curl wget file \
  libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev \
  pkg-config git unzip
```
</details>

<details>
<summary>Windows</summary>

Visual Studio 2022 Build Tools with the **Desktop development with C++**
workload — Tauri cannot link without it. WebView2 ships with Windows 11; on
Windows 10 install the Evergreen Bootstrapper.
</details>

```bash
npm install
npm run tauri dev
```

The first run compiles the whole Rust dependency tree and takes a few minutes.
After that it is seconds, with hot reload on the frontend.

Then click **Open project** and choose `sample/TestNovel.tramoire`.

## Verifying the loop

The sample project is committed to this repository on purpose: editing it makes
`git diff` the check.

1. Open `sample/TestNovel.tramoire`. The binder fills with two acts.
2. Click **Six hours out**. Prose loads in serif on the paper column and
   *angry about his neck* is italic — markdown parsed into marks correctly.
3. Type a sentence. The status bar shows Saving… then Saved.
4. `git diff sample/` — the sentence is there, paragraphs are separated by blank
   lines, and the italic is still `*angry about his neck*`.
5. Select a word, press Ctrl+B, and diff again. It is now `**word**`.
6. Click the other scene and back. The edit persisted.
7. `git checkout sample/` to reset.

## Scripts

| Command | Does |
|---|---|
| `npm run tauri dev` | Run the app with hot reload |
| `npm run tauri build` | Build an installer for the current platform |
| `npm test` | Markdown round-trip tests |
| `npm run typecheck` | `tsc --noEmit` |
| `cargo fmt --manifest-path src-tauri/Cargo.toml` | Format the Rust |

---

## Layout

```
src/
  lib/
    storage.ts      the storage boundary — the only file that calls invoke
    markdown.ts     markdown <-> document, both directions
    autosave.ts     debounced writes with an explicit flush
    editor.ts       schema, smart typography, paste handling
    theme.ts        the two theme axes
  components/       presentational only, no filesystem knowledge
  styles/
    tokens.css      the only file allowed to contain a hex value
    app.css         chrome
    editor.css      the manuscript column

src-tauri/src/
  commands.rs       every command the frontend can call
  model.rs          the shape of project.json — mirrors storage.ts
  paths.rs          path containment and atomic writes

sample/             a project to open, so the app is runnable on clone
```

## On-disk format

```
MyNovel.tramoire/
  project.json      manifest: ordering tree, metadata
  scenes/
    six-hours-out.md
```

Scene files are pure markdown with no frontmatter — all metadata lives in
`project.json`, which keeps the Rust side dependency-free. Adding frontmatter
later is additive.

`formatVersion` is checked on open. A project written by a newer build refuses
to open rather than silently dropping fields it does not understand.

---

## Rules that hold the design together

These are load-bearing. Breaking one is cheap now and expensive in a year.

**No component calls `invoke`.** Everything filesystem-shaped goes through
`src/lib/storage.ts`. Keep that and a browser or cloud backend later means
rewriting one file instead of auditing the whole UI.

**The editor's schema is semantic only.** Italic, bold, and eventually scene
breaks and blockquote. No fonts, sizes, colours or alignment — those are
compile-time decisions the exporter makes. Direct formatting is not restricted,
it is *unrepresentable*, which is why pasted text cannot smuggle foreign
formatting into a DOCX. Paste is stripped to plain text for the same reason.

**Anything the editor can produce, `markdown.ts` can serialise.** Adding a node
or mark to `lib/editor.ts` without adding it to `lib/markdown.ts` means that
formatting is silently discarded on the next save. Add a round-trip test in the
same commit; that is what `markdown.test.ts` is for.

**Display settings never touch the document.** Theme, font size, line height
and measure are CSS on a container and are stored with the application, never in
the project folder — a shared project should not carry someone else's font size.

**One hex value, one place.** `src/styles/tokens.css`. One grep proves it:

```bash
grep -rn "#[0-9a-fA-F]\{3,8\}" src --include="*.css" --include="*.tsx" | grep -v tokens.css
```

**Writes are atomic.** `paths.rs` writes to a temp file and renames over the
target, so a crash or a sync client reading mid-write sees the old file or the
new one, never half of one.

---

## Next, in order

Each is additive. None require changing what is already here.

1. **Reordering** — drag scenes in the binder, write the new order back to
   `project.json`. Needs one more command and a checkpoint before the write.
2. **Entities** — `entities/*.md` with frontmatter, one table with a `type`
   column, one link table. Characters, locations and items are the same noun.
3. **Decorations** — the ProseMirror plugin that underlines entity names.
   Decorations, not marks: nothing is written into the document, so renaming an
   entity updates every highlight with no migration.
4. **Snapshots** — copy a scene into `snapshots/{sceneId}/{timestamp}.md`
   before a rewrite. Files, not a database, so nothing in the project folder is
   a binary blob a sync client can corrupt.
5. **Images** — the Rust import pipeline: hash the original bytes, apply EXIF
   orientation then strip metadata, downscale, encode WebP, discard the original.

## Known limitations in Phase 1

- Markdown outside the schema (headings, lists, links) survives as literal
  paragraph text rather than being dropped, but a hard-wrapped paragraph in a
  hand-authored file is joined onto one line on the next save. Tramoire never
  hard-wraps its own output.
- There is no prompt on quit if a save is still pending. Writes flush on window
  blur, on visibility change and before switching scenes, which covers
  everything short of a hard kill.
- No reordering, no entities, no snapshots, no images, no export. On purpose.

## Distribution

Local `npm run tauri build` on each platform is the normal path — Tauri cannot
meaningfully cross-compile, because each platform's installer tooling and
webview are native.

CI does two things and no more. `check.yml` typechecks, tests and lints on every
push, so a broken commit is caught without waiting for a build. `release.yml`
runs on a version tag only and produces a draft release with installers for
Windows, Linux and both macOS architectures. Installers are unsigned; signing
costs real money and this is software for one person.

## Licence

Not yet chosen. Without a licence file, default copyright applies and nobody
else may use this — the correct default for a personal project, but worth
deciding deliberately if that ever changes.
