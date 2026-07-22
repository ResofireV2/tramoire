//! Every command the frontend can call. Nothing else touches the filesystem.
//!
//! Commands that change the manifest are narrow on purpose — `rename_scene`,
//! not `save_project`. Each one re-reads `project.json`, applies one change and
//! writes it back, so the file on disk stays the source of truth. A generic
//! "here is the whole project, save it" command would mean a window open since
//! this morning can overwrite structure it has never seen, which matters when
//! the folder is sitting in a sync client.

use std::fs;
use std::path::{Path, PathBuf};

use serde::Deserialize;

use crate::model::{v1, Act, Chapter, Created, Project, SceneMeta, FORMAT_VERSION};
use crate::naming::{folder_name, slugify};
use crate::paths::{checkpoint, resolve, write_atomic};

const MANIFEST: &str = "project.json";
const SCENES: &str = "scenes";
const TRASH: &str = "trash";
const EXTENSION: &str = "tramoire";

#[tauri::command]
pub fn open_project(path: String) -> Result<Project, String> {
    read_manifest(&path)
}

/// Make a new project folder under `parent_path` and return its path.
///
/// It starts with one act holding one chapter holding one empty scene, rather
/// than nothing at all: every level of the binder hangs its add button off the
/// level above, so an empty project would be a dead end.
///
/// The caller opens the result like any other project, which is deliberate —
/// creation and opening then agree by construction about what a valid project
/// on disk looks like.
#[tauri::command]
pub fn create_project(parent_path: String, title: String) -> Result<String, String> {
    let title = clean_title(&title)?;

    let name =
        folder_name(&title).ok_or_else(|| format!("“{title}” cannot be used as a folder name"))?;

    // Not `resolve`: the parent comes from the system folder picker, so it is
    // absolute by definition and there is no project root to stay inside of yet.
    let root = Path::new(&parent_path).join(format!("{name}.{EXTENSION}"));

    if root.exists() {
        return Err(format!(
            "there is already something called {name}.{EXTENSION} in that folder"
        ));
    }

    let scene = SceneMeta {
        id: "sc-untitled-scene".to_string(),
        title: "Untitled scene".to_string(),
        file: format!("{SCENES}/untitled-scene.md"),
        status: String::new(),
    };

    let project = Project {
        format_version: FORMAT_VERSION,
        title,
        acts: vec![Act {
            id: "act-1".to_string(),
            title: "Act one".to_string(),
            chapters: vec![Chapter {
                id: "ch-1".to_string(),
                title: "Chapter one".to_string(),
                scenes: vec![scene.clone()],
            }],
        }],
    };

    let path = root
        .to_str()
        .ok_or_else(|| format!("{} is not a usable path", root.display()))?
        .to_string();

    let made =
        write_atomic(&root.join(&scene.file), "").and_then(|_| write_manifest(&path, &project));

    if let Err(e) = made {
        // Only ever the folder this call just made — the check above refused to
        // touch an existing one.
        let _ = fs::remove_dir_all(&root);
        return Err(e);
    }

    Ok(path)
}

#[tauri::command]
pub fn read_scene(project_path: String, file: String) -> Result<String, String> {
    let full = resolve(&project_path, &file)?;
    fs::read_to_string(&full).map_err(|e| format!("couldn't read {}: {e}", full.display()))
}

#[tauri::command]
pub fn write_scene(project_path: String, file: String, content: String) -> Result<(), String> {
    let full = resolve(&project_path, &file)?;
    write_atomic(&full, &content)
}

/// Retitle a scene, and rename its file to match if the file is one this
/// application named.
///
/// A folder of `untitled-scene-4.md` is not the readable, greppable thing this
/// format promises, so a name the app derived from a title follows that title.
/// A name someone chose themselves — `ch09-six-hours.md` — is theirs, and is
/// never touched. The id never changes either way: that is the identity, and
/// the filename is only a label.
///
/// Returns the manifest as it now stands on disk, so the frontend replaces its
/// copy rather than patching one that may be stale.
#[tauri::command]
pub fn rename_scene(
    project_path: String,
    scene_id: String,
    title: String,
) -> Result<Project, String> {
    let title = clean_title(&title)?;
    let mut project = read_manifest(&project_path)?;

    let (act, chapter, index) = locate(&project, &scene_id)?;
    let old_title = project.acts[act].chapters[chapter].scenes[index]
        .title
        .clone();
    let old_file = project.acts[act].chapters[chapter].scenes[index]
        .file
        .clone();

    // Nothing to write means nothing to check point. Retitling a scene to what
    // it already says should not consume the one backup slot.
    if old_title == title {
        return Ok(project);
    }

    // Worked out before the manifest is touched, so `unused_stem` compares
    // against the project as it actually stands on disk. Punctuation-only edits
    // produce the same slug and so move nothing.
    let new_file = if is_app_named(&old_file, &old_title) && slugify(&title) != slugify(&old_title)
    {
        let stem = unused_stem(&project_path, &project, &slugify(&title))?;
        Some(format!("{SCENES}/{stem}.md"))
    } else {
        None
    };

    project.acts[act].chapters[chapter].scenes[index].title = title;

    // Unlike creating or deleting, a rename can break the entry-has-a-file
    // invariant whichever order it is done in. So the file moves first and is
    // moved back if the manifest write then fails.
    let mut moved = None;

    if let Some(new_file) = new_file {
        let from = resolve(&project_path, &old_file)?;
        let to = resolve(&project_path, &new_file)?;

        // A move that cannot happen — a missing file, a sync client holding a
        // lock — is not worth failing the retitle over. The entry keeps
        // pointing at the file that is still there.
        if from.exists() && fs::rename(&from, &to).is_ok() {
            project.acts[act].chapters[chapter].scenes[index].file = new_file;
            moved = Some((from, to));
        }
    }

    if let Err(e) = write_manifest(&project_path, &project) {
        if let Some((from, to)) = moved {
            let _ = fs::rename(&to, &from);
        }
        return Err(e);
    }

    Ok(project)
}

/// Move a scene to a position in an act, which may be the act it is already in.
///
/// `to_index` is a position in the destination act *after* the scene has been
/// lifted out of wherever it was. That is the only definition that stays
/// consistent when a scene moves down within its own act, where removing it
/// first shifts everything after it up by one.
///
/// An index past the end is clamped rather than refused: a frontend working
/// from a stale copy should land the scene at the end of the act, not lose the
/// move. Returns the manifest as it now stands on disk.
#[tauri::command]
pub fn move_scene(
    project_path: String,
    scene_id: String,
    to_chapter_id: String,
    to_index: usize,
) -> Result<Project, String> {
    let mut project = read_manifest(&project_path)?;

    let (from_act, from_chapter, from_index) = locate(&project, &scene_id)?;
    let (to_act, to_chapter) = locate_chapter(&project, &to_chapter_id)?;

    let scene = project.acts[from_act].chapters[from_chapter]
        .scenes
        .remove(from_index);

    let to_index = to_index.min(project.acts[to_act].chapters[to_chapter].scenes.len());
    project.acts[to_act].chapters[to_chapter]
        .scenes
        .insert(to_index, scene);

    // Dropping a scene back where it came from is a real gesture — a drag that
    // ends where it started — and it should cost nothing.
    let same = (to_act, to_chapter, to_index) == (from_act, from_chapter, from_index);
    if !same {
        write_manifest(&project_path, &project)?;
    }

    Ok(project)
}

/// Add an empty scene to a chapter.
///
/// The file is written before the manifest that names it. Both orders can fail
/// halfway, and this is the harmless half: an entry pointing at a file that does
/// not exist breaks the project, while a file nothing points at is invisible.
/// Same invariant from the other end in `delete_scene`.
#[tauri::command]
pub fn create_scene(
    project_path: String,
    chapter_id: String,
    title: String,
    to_index: usize,
) -> Result<Created, String> {
    let title = clean_title(&title)?;
    let mut project = read_manifest(&project_path)?;

    let (act, chapter) = locate_chapter(&project, &chapter_id)?;

    let stem = unused_stem(&project_path, &project, &slugify(&title))?;
    let scene = SceneMeta {
        id: format!("sc-{stem}"),
        title,
        file: format!("{SCENES}/{stem}.md"),
        status: String::new(),
    };

    let file = resolve(&project_path, &scene.file)?;
    write_atomic(&file, "")?;

    let to_index = to_index.min(project.acts[act].chapters[chapter].scenes.len());
    project.acts[act].chapters[chapter]
        .scenes
        .insert(to_index, scene.clone());

    if let Err(e) = write_manifest(&project_path, &project) {
        // Leaving the file would burn its name: the next create would skip to
        // `-2` to avoid a file that nothing refers to.
        let _ = fs::remove_file(&file);
        return Err(e);
    }

    Ok(Created { project, scene })
}

/// Take a scene out of the book and move its file to `trash/`.
///
/// Deleting prose outright is not something this can offer without a snapshots
/// feature behind it, so the file stays readable in the project folder and
/// recovery is moving it back by hand.
///
/// The manifest is written before the file moves — the reverse of `create_scene`
/// and for the same reason. A failed move then leaves an orphan in `scenes/`
/// rather than an entry pointing into thin air.
#[tauri::command]
pub fn delete_scene(project_path: String, scene_id: String) -> Result<Project, String> {
    let mut project = read_manifest(&project_path)?;

    let (act, chapter, index) = locate(&project, &scene_id)?;
    let scene = project.acts[act].chapters[chapter].scenes.remove(index);

    write_manifest(&project_path, &project)?;
    trash(&project_path, &scene.file)?;

    Ok(project)
}

/// Move a project file into `trash/`, without overwriting anything already
/// there. A file that has already gone is not an error — there is simply
/// nothing left to move.
fn trash(project_path: &str, file: &str) -> Result<(), String> {
    let from = resolve(project_path, file)?;
    if !from.exists() {
        return Ok(());
    }

    let name = Path::new(file)
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("scene.md");

    let to = resolve(project_path, &unused_trash_file(project_path, name)?)?;

    if let Some(parent) = to.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("couldn't create {}: {e}", parent.display()))?;
    }

    fs::rename(&from, &to).map_err(|e| format!("couldn't move {} to {TRASH}: {e}", from.display()))
}

/* ----------------------------------------------------------------- acts */

/// Add an act. `to_index` is a position in the act list, clamped to its end.
#[tauri::command]
pub fn create_act(project_path: String, title: String, to_index: usize) -> Result<Project, String> {
    let title = clean_title(&title)?;
    let mut project = read_manifest(&project_path)?;

    let act = Act {
        id: unused_act_id(&project),
        title,
        chapters: Vec::new(),
    };

    let to_index = to_index.min(project.acts.len());
    project.acts.insert(to_index, act);

    write_manifest(&project_path, &project)?;
    Ok(project)
}

/// Retitle an act. Nothing on disk is named after it, so unlike a scene this
/// is only ever a change of label.
#[tauri::command]
pub fn rename_act(project_path: String, act_id: String, title: String) -> Result<Project, String> {
    let title = clean_title(&title)?;
    let mut project = read_manifest(&project_path)?;

    let index = locate_act(&project, &act_id)?;

    if project.acts[index].title == title {
        return Ok(project);
    }

    project.acts[index].title = title;

    write_manifest(&project_path, &project)?;
    Ok(project)
}

/// Move an act, and everything in it, to a position in the act list.
///
/// `to_index` is a position after the act has been lifted out, matching
/// `move_scene` — the same off-by-one lives here for the same reason.
#[tauri::command]
pub fn move_act(project_path: String, act_id: String, to_index: usize) -> Result<Project, String> {
    let mut project = read_manifest(&project_path)?;

    let from = locate_act(&project, &act_id)?;
    let act = project.acts.remove(from);

    let to_index = to_index.min(project.acts.len());
    project.acts.insert(to_index, act);

    if to_index != from {
        write_manifest(&project_path, &project)?;
    }

    Ok(project)
}

/// What to do with whatever a container still holds when it is deleted.
#[derive(Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum Contents {
    /// Into the neighbour above, or the one below if this was the first.
    Move,
    /// Every scene file to `trash/`, like deleting them one by one.
    Trash,
}

/// Delete an act, moving or trashing the chapters inside it.
///
/// The last act cannot go: a project with no acts has nowhere to put a chapter,
/// and nothing in the binder to hang the button on.
#[tauri::command]
pub fn delete_act(
    project_path: String,
    act_id: String,
    contents: Contents,
) -> Result<Project, String> {
    let mut project = read_manifest(&project_path)?;

    if project.acts.len() < 2 {
        return Err("a project needs at least one act".to_string());
    }

    let index = locate_act(&project, &act_id)?;
    let act = project.acts.remove(index);

    if contents == Contents::Move {
        // Above if there is an above, otherwise the front of what is now first,
        // because these chapters came before it in reading order.
        match index.checked_sub(1) {
            Some(previous) => project.acts[previous].chapters.extend(act.chapters),
            None => {
                for (at, chapter) in act.chapters.into_iter().enumerate() {
                    project.acts[0].chapters.insert(at, chapter);
                }
            }
        }

        write_manifest(&project_path, &project)?;
        return Ok(project);
    }

    // Manifest first, then the files — the same order as deleting one scene,
    // so a failure halfway leaves orphans rather than entries pointing nowhere.
    write_manifest(&project_path, &project)?;

    for scene in act
        .chapters
        .iter()
        .flat_map(|chapter| chapter.scenes.iter())
    {
        trash(&project_path, &scene.file)?;
    }

    Ok(project)
}

/* ------------------------------------------------------------- chapters */

/// Add a chapter to an act.
#[tauri::command]
pub fn create_chapter(
    project_path: String,
    act_id: String,
    title: String,
    to_index: usize,
) -> Result<Project, String> {
    let title = clean_title(&title)?;
    let mut project = read_manifest(&project_path)?;

    let act = locate_act(&project, &act_id)?;

    let chapter = Chapter {
        id: unused_chapter_id(&project),
        title,
        scenes: Vec::new(),
    };

    let to_index = to_index.min(project.acts[act].chapters.len());
    project.acts[act].chapters.insert(to_index, chapter);

    write_manifest(&project_path, &project)?;
    Ok(project)
}

/// Retitle a chapter. Like an act and unlike a scene, nothing on disk is named
/// after it, so this is only ever a change of label.
#[tauri::command]
pub fn rename_chapter(
    project_path: String,
    chapter_id: String,
    title: String,
) -> Result<Project, String> {
    let title = clean_title(&title)?;
    let mut project = read_manifest(&project_path)?;

    let (act, chapter) = locate_chapter(&project, &chapter_id)?;

    if project.acts[act].chapters[chapter].title == title {
        return Ok(project);
    }

    project.acts[act].chapters[chapter].title = title;

    write_manifest(&project_path, &project)?;
    Ok(project)
}

/// Move a chapter, and its scenes, to a position in an act.
///
/// `to_index` is a position after the chapter has been lifted out, the same
/// convention `move_scene` uses one level down.
#[tauri::command]
pub fn move_chapter(
    project_path: String,
    chapter_id: String,
    to_act_id: String,
    to_index: usize,
) -> Result<Project, String> {
    let mut project = read_manifest(&project_path)?;

    let (from_act, from_index) = locate_chapter(&project, &chapter_id)?;
    let to_act = locate_act(&project, &to_act_id)?;

    let chapter = project.acts[from_act].chapters.remove(from_index);
    let to_index = to_index.min(project.acts[to_act].chapters.len());
    project.acts[to_act].chapters.insert(to_index, chapter);

    if (to_act, to_index) != (from_act, from_index) {
        write_manifest(&project_path, &project)?;
    }

    Ok(project)
}

/// Delete a chapter, moving or trashing the scenes inside it.
///
/// Moving means the chapter immediately before it in reading order, crossing
/// into the previous act if it was the first of its own, or the one after when
/// it was the very first chapter in the book. With no other chapter anywhere,
/// there is nowhere to move to and only trashing is possible.
#[tauri::command]
pub fn delete_chapter(
    project_path: String,
    chapter_id: String,
    contents: Contents,
) -> Result<Project, String> {
    let mut project = read_manifest(&project_path)?;

    let (act, index) = locate_chapter(&project, &chapter_id)?;

    // Worked out before the removal, while the neighbours are still where the
    // caller saw them.
    let destination = match contents {
        Contents::Move => Some(neighbour_chapter(&project, act, index).ok_or_else(|| {
            "this is the only chapter in the project — its scenes have nowhere to go".to_string()
        })?),
        Contents::Trash => None,
    };

    let chapter = project.acts[act].chapters.remove(index);

    if let Some((into_act, into_chapter, at_front)) = destination {
        // Indices were taken before the removal, so anything after the hole in
        // the same act has shifted up by one.
        let into_chapter = if into_act == act && into_chapter > index {
            into_chapter - 1
        } else {
            into_chapter
        };

        let scenes = &mut project.acts[into_act].chapters[into_chapter].scenes;

        if at_front {
            for (at, scene) in chapter.scenes.into_iter().enumerate() {
                scenes.insert(at, scene);
            }
        } else {
            scenes.extend(chapter.scenes);
        }

        write_manifest(&project_path, &project)?;
        return Ok(project);
    }

    write_manifest(&project_path, &project)?;

    for scene in &chapter.scenes {
        trash(&project_path, &scene.file)?;
    }

    Ok(project)
}

/// The chapter a deleted one's scenes should join, and whether they go to its
/// front. `(act, chapter, at_front)`, in indices from before the removal.
fn neighbour_chapter(project: &Project, act: usize, index: usize) -> Option<(usize, usize, bool)> {
    // The chapter above, in this act or the last one of an earlier act.
    if index > 0 {
        return Some((act, index - 1, false));
    }
    if let Some((a, earlier)) = project.acts[..act]
        .iter()
        .enumerate()
        .rev()
        .find(|(_, act)| !act.chapters.is_empty())
    {
        return Some((a, earlier.chapters.len() - 1, false));
    }

    // Nothing above, so the one below, and these scenes go in front of its own.
    if index + 1 < project.acts[act].chapters.len() {
        return Some((act, index + 1, true));
    }
    project.acts[act + 1..]
        .iter()
        .enumerate()
        .find(|(_, act)| !act.chapters.is_empty())
        .map(|(offset, _)| (act + 1 + offset, 0, true))
}

/* --------------------------------------------------------------- naming */

fn locate_act(project: &Project, act_id: &str) -> Result<usize, String> {
    project
        .acts
        .iter()
        .position(|act| act.id == act_id)
        .ok_or_else(|| format!("no act {act_id} in this project"))
}

/// An act id nothing is using. Ids are never shown, so a counter is enough —
/// and they say nothing about order, which is what the array is for.
fn unused_act_id(project: &Project) -> String {
    (1..)
        .map(|n| format!("act-{n}"))
        .find(|id| !project.acts.iter().any(|act| &act.id == id))
        .expect("an unused id exists in an unbounded sequence")
}

fn unused_chapter_id(project: &Project) -> String {
    (1..)
        .map(|n| format!("ch-{n}"))
        .find(|id| !chapters(project).any(|chapter| &chapter.id == id))
        .expect("an unused id exists in an unbounded sequence")
}

fn chapters(project: &Project) -> impl Iterator<Item = &Chapter> {
    project.acts.iter().flat_map(|act| act.chapters.iter())
}

fn locate_chapter(project: &Project, chapter_id: &str) -> Result<(usize, usize), String> {
    project
        .acts
        .iter()
        .enumerate()
        .find_map(|(act, a)| {
            a.chapters
                .iter()
                .position(|chapter| chapter.id == chapter_id)
                .map(|index| (act, index))
        })
        .ok_or_else(|| format!("no chapter {chapter_id} in this project"))
}

/// Which act, chapter and position a scene sits at.
fn locate(project: &Project, scene_id: &str) -> Result<(usize, usize, usize), String> {
    project
        .acts
        .iter()
        .enumerate()
        .find_map(|(act, a)| {
            a.chapters.iter().enumerate().find_map(|(chapter, c)| {
                c.scenes
                    .iter()
                    .position(|s| s.id == scene_id)
                    .map(|index| (act, chapter, index))
            })
        })
        .ok_or_else(|| format!("no scene {scene_id} in this project"))
}

/// Whether a file name is one this application derived from a title, rather
/// than one someone chose.
///
/// True for the slug of the title, and for the numbered forms `unused_stem`
/// hands out when that slug is taken. Anything else — a different folder, a
/// different extension, a name of their own — is theirs.
fn is_app_named(file: &str, title: &str) -> bool {
    let Some(stem) = file
        .strip_prefix(&format!("{SCENES}/"))
        .and_then(|name| name.strip_suffix(".md"))
    else {
        return false;
    };

    let base = slugify(title);

    stem == base
        || stem
            .strip_prefix(&base)
            .and_then(|rest| rest.strip_prefix('-'))
            .is_some_and(|n| !n.is_empty() && n.chars().all(|c| c.is_ascii_digit()))
}

/// A filename stem that no scene is using and no file on disk has taken.
///
/// Both are checked: an id can outlive its file, and an orphaned file can
/// outlive its entry. Reusing either would have a new scene quietly adopt the
/// contents of an old one.
fn unused_stem(project_path: &str, project: &Project, base: &str) -> Result<String, String> {
    for n in 1..1000 {
        let stem = if n == 1 {
            base.to_string()
        } else {
            format!("{base}-{n}")
        };

        let file = format!("{SCENES}/{stem}.md");
        let id = format!("sc-{stem}");

        let taken = project
            .scenes()
            .any(|scene| scene.file == file || scene.id == id);

        if !taken && !resolve(project_path, &file)?.exists() {
            return Ok(stem);
        }
    }

    Err(format!("too many scenes named like {base}"))
}

fn unused_trash_file(project_path: &str, name: &str) -> Result<String, String> {
    let (stem, extension) = match name.rsplit_once('.') {
        Some((stem, extension)) => (stem, format!(".{extension}")),
        None => (name, String::new()),
    };

    for n in 1..1000 {
        let candidate = if n == 1 {
            format!("{TRASH}/{stem}{extension}")
        } else {
            format!("{TRASH}/{stem}-{n}{extension}")
        };

        if !resolve(project_path, &candidate)?.exists() {
            return Ok(candidate);
        }
    }

    Err(format!("{TRASH} already holds too many copies of {name}"))
}

/* ------------------------------------------------------------- manifest */

fn manifest_path(project_path: &str) -> PathBuf {
    Path::new(project_path).join(MANIFEST)
}

fn read_manifest(project_path: &str) -> Result<Project, String> {
    let manifest = manifest_path(project_path);

    let raw = fs::read_to_string(&manifest).map_err(|e| {
        format!("couldn't read {MANIFEST} — is {project_path} a Tramoire project folder? ({e})")
    })?;

    let value: serde_json::Value =
        serde_json::from_str(&raw).map_err(|e| format!("{MANIFEST} is malformed: {e}"))?;

    let version = value
        .get("formatVersion")
        .and_then(|v| v.as_u64())
        .unwrap_or(0);

    // Checked on every read, not just on open: the folder may have been
    // upgraded by a newer build on another device while this window was open,
    // and writing to it would drop whatever that version added.
    if version > u64::from(FORMAT_VERSION) {
        return Err(format!(
            "this project was made by a newer version of Tramoire (format {version} vs {FORMAT_VERSION})"
        ));
    }

    // Converted on the way in, never on disk. Nothing is rewritten until the
    // next real change, and that write takes a checkpoint like any other — so
    // opening an old project in a new build cannot damage it on its own.
    if version < 2 {
        let old: v1::Project =
            serde_json::from_value(value).map_err(|e| format!("{MANIFEST} is malformed: {e}"))?;
        return Ok(old.into());
    }

    serde_json::from_value(value).map_err(|e| format!("{MANIFEST} is malformed: {e}"))
}

fn write_manifest(project_path: &str, project: &Project) -> Result<(), String> {
    let manifest = manifest_path(project_path);
    checkpoint(&manifest)?;

    // Pretty-printed with a trailing newline, because a project folder is meant
    // to be read and diffed by hand.
    let mut json = serde_json::to_string_pretty(project)
        .map_err(|e| format!("couldn't serialise {MANIFEST}: {e}"))?;
    json.push('\n');

    write_atomic(&manifest, &json)
}

/// Titles are shown in the binder and nowhere else — they are not filenames, so
/// the only rules are that one exists and that it cannot smuggle in line breaks.
fn clean_title(title: &str) -> Result<String, String> {
    let title = title.trim();

    if title.is_empty() {
        return Err("a scene needs a title".into());
    }

    if title.contains(['\n', '\r']) {
        return Err("a title cannot span lines".into());
    }

    Ok(title.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU32, Ordering};

    const SAMPLE: &str = r#"{
  "formatVersion": 2,
  "title": "The county line",
  "acts": [
    {
      "id": "act-1",
      "title": "Act one",
      "chapters": [
        {
          "id": "ch-1",
          "title": "Chapter one",
          "scenes": [
            { "id": "sc-one", "title": "Six hours out", "file": "scenes/one.md", "status": "draft" },
            { "id": "sc-two", "title": "The Sundowner", "file": "scenes/two.md", "status": "" }
          ]
        }
      ]
    }
  ]
}
"#;

    /// Two acts and three chapters, because the interesting moves are the ones
    /// that cross a boundary of one kind or the other.
    const TWO_ACTS: &str = r#"{
  "formatVersion": 2,
  "title": "The county line",
  "acts": [
    {
      "id": "act-1",
      "title": "Act one",
      "chapters": [
        {
          "id": "ch-1",
          "title": "Chapter one",
          "scenes": [
            { "id": "sc-one", "title": "One", "file": "scenes/one.md", "status": "" },
            { "id": "sc-two", "title": "Two", "file": "scenes/two.md", "status": "" }
          ]
        },
        {
          "id": "ch-2",
          "title": "Chapter two",
          "scenes": [
            { "id": "sc-three", "title": "Three", "file": "scenes/three.md", "status": "" }
          ]
        }
      ]
    },
    {
      "id": "act-2",
      "title": "Act two",
      "chapters": [
        {
          "id": "ch-3",
          "title": "Chapter three",
          "scenes": [
            { "id": "sc-four", "title": "Four", "file": "scenes/four.md", "status": "" }
          ]
        }
      ]
    }
  ]
}
"#;

    /// The shape version 1 wrote, kept as a fixture so the reader that copes
    /// with it stays honest.
    const VERSION_ONE: &str = r#"{
  "formatVersion": 1,
  "title": "The county line",
  "acts": [
    {
      "id": "act-1",
      "title": "Act one",
      "scenes": [
        { "id": "sc-one", "title": "Six hours out", "file": "scenes/one.md", "status": "Chapter 9" },
        { "id": "sc-two", "title": "The Sundowner", "file": "scenes/two.md", "status": "" }
      ]
    },
    {
      "id": "act-2",
      "title": "Act two",
      "scenes": [
        { "id": "sc-three", "title": "What Nadia knew", "file": "scenes/three.md", "status": "" }
      ]
    }
  ]
}
"#;

    /// A project folder of its own per test, so they can run in parallel.
    fn project_with(manifest: &str) -> PathBuf {
        static COUNTER: AtomicU32 = AtomicU32::new(0);
        let n = COUNTER.fetch_add(1, Ordering::Relaxed);

        let dir = std::env::temp_dir().join(format!("tramoire-{}-{n}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join(MANIFEST), manifest).unwrap();
        dir
    }

    fn project() -> PathBuf {
        project_with(SAMPLE)
    }

    fn path(dir: &Path) -> String {
        dir.to_str().unwrap().to_string()
    }

    /// Acts, each holding chapters, each holding scene ids — the whole tree,
    /// which is what the structural commands are allowed to rearrange.
    fn shape(project: &Project) -> Vec<Vec<Vec<&str>>> {
        project
            .acts
            .iter()
            .map(|act| {
                act.chapters
                    .iter()
                    .map(|chapter| chapter.scenes.iter().map(|s| s.id.as_str()).collect())
                    .collect()
            })
            .collect()
    }

    /// Every scene in reading order, for the cases where nesting is not the point.
    fn order(project: &Project) -> Vec<&str> {
        project.scenes().map(|s| s.id.as_str()).collect()
    }

    fn titles(project: &Project) -> Vec<&str> {
        project.scenes().map(|s| s.title.as_str()).collect()
    }

    /* ------------------------------------------------------------ version */

    #[test]
    fn a_version_one_project_becomes_one_chapter_per_scene() {
        let dir = project_with(VERSION_ONE);
        let p = open_project(path(&dir)).unwrap();

        assert_eq!(p.format_version, 2);
        assert_eq!(
            shape(&p),
            [vec![vec!["sc-one"], vec!["sc-two"]], vec![vec!["sc-three"]]]
        );

        // Numbered across the book, not per act.
        assert_eq!(p.acts[0].chapters[0].title, "Chapter 1");
        assert_eq!(p.acts[1].chapters[0].title, "Chapter 3");

        // Reading it changed nothing on disk.
        assert_eq!(fs::read_to_string(dir.join(MANIFEST)).unwrap(), VERSION_ONE);

        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn a_version_one_project_upgrades_on_the_first_change() {
        let dir = project_with(VERSION_ONE);
        rename_scene(path(&dir), "sc-one".into(), "Renamed".into()).unwrap();

        let raw = fs::read_to_string(dir.join(MANIFEST)).unwrap();
        assert!(raw.contains("\"formatVersion\": 2"));
        assert!(raw.contains("chapters"));

        // And the version 1 manifest is still there to go back to.
        let backup = fs::read_to_string(dir.join(".project.json.bak")).unwrap();
        assert_eq!(backup, VERSION_ONE);

        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn rename_refuses_a_newer_format() {
        let dir = project_with(&SAMPLE.replace("\"formatVersion\": 2", "\"formatVersion\": 99"));

        assert!(rename_scene(path(&dir), "sc-one".into(), "Renamed".into()).is_err());
        assert!(!dir.join(".project.json.bak").exists());

        fs::remove_dir_all(&dir).unwrap();
    }

    /* ------------------------------------------------------------- scenes */

    #[test]
    fn rename_writes_through_to_disk() {
        let dir = project();
        let returned = rename_scene(path(&dir), "sc-one".into(), "Six hours later".into()).unwrap();

        // What came back and what landed on disk have to agree — the frontend
        // trusts the return value instead of re-opening the project.
        let on_disk = read_manifest(&path(&dir)).unwrap();
        assert_eq!(titles(&returned), ["Six hours later", "The Sundowner"]);
        assert_eq!(titles(&on_disk), ["Six hours later", "The Sundowner"]);

        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn retitling_moves_a_file_this_app_named() {
        let dir = project_with(TWO_ACTS);
        fs::create_dir_all(dir.join(SCENES)).unwrap();

        // TWO_ACTS calls this scene "One", so scenes/one.md is a name the app
        // would have produced itself.
        fs::write(dir.join("scenes/one.md"), "the prose").unwrap();

        let p = rename_scene(path(&dir), "sc-one".into(), "Six hours out".into()).unwrap();
        let scene = &p.acts[0].chapters[0].scenes[0];

        assert_eq!(scene.file, "scenes/six-hours-out.md");
        assert_eq!(
            fs::read_to_string(dir.join("scenes/six-hours-out.md")).unwrap(),
            "the prose"
        );
        assert!(!dir.join("scenes/one.md").exists());

        // The id is identity and never moves with the label.
        assert_eq!(scene.id, "sc-one");

        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn retitling_leaves_a_hand_named_file_alone() {
        let dir = project_with(&TWO_ACTS.replace("scenes/one.md", "scenes/ch09-six-hours.md"));
        fs::create_dir_all(dir.join(SCENES)).unwrap();
        fs::write(dir.join("scenes/ch09-six-hours.md"), "the prose").unwrap();

        let p = rename_scene(path(&dir), "sc-one".into(), "Six hours out".into()).unwrap();

        assert_eq!(
            p.acts[0].chapters[0].scenes[0].file,
            "scenes/ch09-six-hours.md"
        );
        assert!(dir.join("scenes/ch09-six-hours.md").exists());

        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn retitling_does_not_move_a_file_onto_another_one() {
        let dir = project_with(TWO_ACTS);
        fs::create_dir_all(dir.join(SCENES)).unwrap();
        fs::write(dir.join("scenes/one.md"), "the first").unwrap();
        fs::write(dir.join("scenes/two.md"), "the second").unwrap();

        // "Two" already owns scenes/two.md, so this has to land beside it.
        let p = rename_scene(path(&dir), "sc-one".into(), "Two".into()).unwrap();

        assert_eq!(p.acts[0].chapters[0].scenes[0].file, "scenes/two-2.md");
        assert_eq!(
            fs::read_to_string(dir.join("scenes/two.md")).unwrap(),
            "the second"
        );
        assert_eq!(
            fs::read_to_string(dir.join("scenes/two-2.md")).unwrap(),
            "the first"
        );

        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn retitling_within_the_same_slug_moves_nothing() {
        let dir = project_with(TWO_ACTS);
        fs::create_dir_all(dir.join(SCENES)).unwrap();
        fs::write(dir.join("scenes/one.md"), "the prose").unwrap();

        let p = rename_scene(path(&dir), "sc-one".into(), "  One!  ".into()).unwrap();
        let scene = &p.acts[0].chapters[0].scenes[0];

        assert_eq!(scene.title, "One!");
        assert_eq!(scene.file, "scenes/one.md");

        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn retitling_survives_a_missing_file() {
        let dir = project_with(TWO_ACTS);

        // Nothing on disk to move. The retitle is still what was asked for.
        let p = rename_scene(path(&dir), "sc-one".into(), "Six hours out".into()).unwrap();
        let scene = &p.acts[0].chapters[0].scenes[0];

        assert_eq!(scene.title, "Six hours out");
        assert_eq!(scene.file, "scenes/one.md");

        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn rename_leaves_the_rest_of_the_manifest_alone() {
        let dir = project();
        rename_scene(path(&dir), "sc-two".into(), "The Sundowner Motel".into()).unwrap();

        let on_disk = read_manifest(&path(&dir)).unwrap();
        let scene = &on_disk.acts[0].chapters[0].scenes[1];

        assert_eq!(on_disk.title, "The county line");
        assert_eq!(on_disk.format_version, 2);
        assert_eq!(on_disk.acts[0].chapters[0].title, "Chapter one");
        assert_eq!(scene.id, "sc-two");

        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn rename_keeps_the_previous_manifest() {
        let dir = project();
        rename_scene(path(&dir), "sc-one".into(), "Renamed".into()).unwrap();

        let backup = fs::read_to_string(dir.join(".project.json.bak")).unwrap();
        assert!(backup.contains("Six hours out"));

        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn renaming_to_the_same_title_writes_nothing() {
        let dir = project();
        rename_scene(path(&dir), "sc-one".into(), "  Six hours out  ".into()).unwrap();

        // A no-op that still took a checkpoint would spend the one backup slot
        // and lose the copy that is actually worth keeping.
        assert!(!dir.join(".project.json.bak").exists());

        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn rename_rejects_bad_input() {
        let dir = project();
        let p = path(&dir);

        assert!(rename_scene(p.clone(), "sc-one".into(), "   ".into()).is_err());
        assert!(rename_scene(p.clone(), "sc-one".into(), "two\nlines".into()).is_err());
        assert!(rename_scene(p.clone(), "sc-nope".into(), "Fine".into()).is_err());

        // A rejected rename must not have touched the file.
        assert_eq!(fs::read_to_string(dir.join(MANIFEST)).unwrap(), SAMPLE);

        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn move_within_a_chapter() {
        let dir = project_with(TWO_ACTS);

        // The off-by-one case: sc-one is at 0, and landing after sc-two means
        // targeting 1, not 2, because the removal shifts sc-two up first.
        let p = move_scene(path(&dir), "sc-one".into(), "ch-1".into(), 1).unwrap();
        assert_eq!(order(&p), ["sc-two", "sc-one", "sc-three", "sc-four"]);

        let p = move_scene(path(&dir), "sc-one".into(), "ch-1".into(), 0).unwrap();
        assert_eq!(order(&p), ["sc-one", "sc-two", "sc-three", "sc-four"]);

        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn move_across_a_chapter_and_an_act() {
        let dir = project_with(TWO_ACTS);

        // Into the chapter next door, still inside act one.
        let p = move_scene(path(&dir), "sc-two".into(), "ch-2".into(), 0).unwrap();
        assert_eq!(
            shape(&p),
            [
                vec![vec!["sc-one"], vec!["sc-two", "sc-three"]],
                vec![vec!["sc-four"]]
            ]
        );

        // And on into a chapter of the next act.
        let p = move_scene(path(&dir), "sc-two".into(), "ch-3".into(), 1).unwrap();
        assert_eq!(
            shape(&p),
            [
                vec![vec!["sc-one"], vec!["sc-three"]],
                vec![vec!["sc-four", "sc-two"]]
            ]
        );

        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn move_can_empty_a_chapter() {
        let dir = project_with(TWO_ACTS);
        let p = move_scene(path(&dir), "sc-three".into(), "ch-1".into(), 2).unwrap();

        assert_eq!(
            shape(&p),
            [
                vec![vec!["sc-one", "sc-two", "sc-three"], Vec::new()],
                vec![vec!["sc-four"]]
            ]
        );

        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn move_clamps_an_index_past_the_end() {
        let dir = project_with(TWO_ACTS);

        // What a frontend working from a stale copy would send. The scene ends
        // up last rather than the move being lost.
        let p = move_scene(path(&dir), "sc-one".into(), "ch-3".into(), 99).unwrap();

        assert_eq!(
            shape(&p),
            [
                vec![vec!["sc-two"], vec!["sc-three"]],
                vec![vec!["sc-four", "sc-one"]]
            ]
        );

        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn moving_a_scene_nowhere_writes_nothing() {
        let dir = project_with(TWO_ACTS);
        move_scene(path(&dir), "sc-one".into(), "ch-1".into(), 0).unwrap();

        assert!(!dir.join(".project.json.bak").exists());

        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn move_rejects_unknown_ids_without_losing_a_scene() {
        let dir = project_with(TWO_ACTS);
        let p = path(&dir);

        assert!(move_scene(p.clone(), "sc-nope".into(), "ch-1".into(), 0).is_err());
        assert!(move_scene(p.clone(), "sc-one".into(), "ch-nope".into(), 0).is_err());

        // The unknown-chapter path locates before it removes. Nothing may reach
        // the file.
        assert_eq!(fs::read_to_string(dir.join(MANIFEST)).unwrap(), TWO_ACTS);

        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn create_writes_a_file_and_an_entry() {
        let dir = project_with(TWO_ACTS);
        let made = create_scene(path(&dir), "ch-3".into(), "What Nadia knew".into(), 0).unwrap();

        assert_eq!(made.scene.id, "sc-what-nadia-knew");
        assert_eq!(made.scene.file, "scenes/what-nadia-knew.md");
        assert_eq!(
            shape(&made.project),
            [
                vec![vec!["sc-one", "sc-two"], vec!["sc-three"]],
                vec![vec!["sc-what-nadia-knew", "sc-four"]]
            ]
        );

        // The invariant: an entry in the manifest always has a file behind it.
        assert_eq!(
            fs::read_to_string(dir.join("scenes/what-nadia-knew.md")).unwrap(),
            ""
        );

        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn create_never_reuses_a_name() {
        let dir = project_with(TWO_ACTS);
        let p = path(&dir);

        let first = create_scene(p.clone(), "ch-1".into(), "The drive".into(), 0).unwrap();
        let second = create_scene(p.clone(), "ch-2".into(), "The drive".into(), 0).unwrap();

        // Different chapters, same title — the folder is flat, so the second
        // still has to find its own name.
        assert_eq!(first.scene.file, "scenes/the-drive.md");
        assert_eq!(second.scene.file, "scenes/the-drive-2.md");
        assert_ne!(first.scene.id, second.scene.id);

        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn create_steps_over_a_file_no_entry_points_at() {
        let dir = project_with(TWO_ACTS);
        fs::create_dir_all(dir.join(SCENES)).unwrap();
        fs::write(dir.join("scenes/orphan.md"), "prose from a deleted entry").unwrap();

        let made = create_scene(path(&dir), "ch-1".into(), "Orphan".into(), 0).unwrap();

        // Adopting the orphan's contents would be the worst possible outcome.
        assert_eq!(made.scene.file, "scenes/orphan-2.md");
        assert_eq!(
            fs::read_to_string(dir.join("scenes/orphan.md")).unwrap(),
            "prose from a deleted entry"
        );

        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn delete_moves_the_file_to_trash() {
        let dir = project_with(TWO_ACTS);
        fs::create_dir_all(dir.join(SCENES)).unwrap();
        fs::write(dir.join("scenes/two.md"), "the prose").unwrap();

        let p = delete_scene(path(&dir), "sc-two".into()).unwrap();

        assert_eq!(order(&p), ["sc-one", "sc-three", "sc-four"]);
        assert!(!dir.join("scenes/two.md").exists());
        assert_eq!(
            fs::read_to_string(dir.join("trash/two.md")).unwrap(),
            "the prose"
        );

        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn delete_does_not_overwrite_something_already_in_trash() {
        let dir = project_with(TWO_ACTS);
        fs::create_dir_all(dir.join(SCENES)).unwrap();
        fs::create_dir_all(dir.join(TRASH)).unwrap();
        fs::write(dir.join("scenes/two.md"), "the second draft").unwrap();
        fs::write(dir.join("trash/two.md"), "an older scene, same name").unwrap();

        delete_scene(path(&dir), "sc-two".into()).unwrap();

        assert_eq!(
            fs::read_to_string(dir.join("trash/two.md")).unwrap(),
            "an older scene, same name"
        );
        assert_eq!(
            fs::read_to_string(dir.join("trash/two-2.md")).unwrap(),
            "the second draft"
        );

        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn delete_removes_an_entry_whose_file_is_gone() {
        let dir = project_with(TWO_ACTS);

        // No scenes/ directory at all — the entry should still leave the binder.
        let p = delete_scene(path(&dir), "sc-two".into()).unwrap();
        assert_eq!(order(&p), ["sc-one", "sc-three", "sc-four"]);

        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn create_and_delete_reject_unknown_ids() {
        let dir = project_with(TWO_ACTS);
        let p = path(&dir);

        assert!(create_scene(p.clone(), "ch-nope".into(), "A scene".into(), 0).is_err());
        assert!(create_scene(p.clone(), "ch-1".into(), "  ".into(), 0).is_err());
        assert!(delete_scene(p.clone(), "sc-nope".into()).is_err());

        assert_eq!(fs::read_to_string(dir.join(MANIFEST)).unwrap(), TWO_ACTS);

        fs::remove_dir_all(&dir).unwrap();
    }

    /* ----------------------------------------------------------- projects */

    #[test]
    fn a_new_project_opens_like_any_other() {
        let dir = project_with(TWO_ACTS);
        let parent = dir.join("somewhere");
        fs::create_dir_all(&parent).unwrap();

        let made = create_project(path(&parent), "The county line".into()).unwrap();

        // The strongest thing to assert: whatever create wrote, open accepts.
        let p = open_project(made.clone()).unwrap();
        assert!(made.ends_with("The county line.tramoire"));
        assert_eq!(p.title, "The county line");
        assert_eq!(shape(&p), [vec![vec!["sc-untitled-scene"]]]);

        // Every level exists, or the binder would have nowhere to add anything.
        assert_eq!(p.acts[0].title, "Act one");
        assert_eq!(p.acts[0].chapters[0].title, "Chapter one");

        let scene = &p.acts[0].chapters[0].scenes[0];
        assert_eq!(
            fs::read_to_string(Path::new(&made).join(&scene.file)).unwrap(),
            ""
        );

        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn a_new_project_refuses_to_land_on_an_existing_folder() {
        let dir = project_with(TWO_ACTS);
        let parent = dir.join("somewhere");
        fs::create_dir_all(parent.join("Taken.tramoire")).unwrap();

        let err = create_project(path(&parent), "Taken".into()).unwrap_err();
        assert!(err.contains("already"));

        // Refusing has to mean untouched, not merged into.
        assert!(!parent.join("Taken.tramoire").join(MANIFEST).exists());

        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn a_new_project_refuses_an_unusable_title() {
        let dir = project_with(TWO_ACTS);
        let parent = dir.join("somewhere");
        fs::create_dir_all(&parent).unwrap();

        assert!(create_project(path(&parent), "   ".into()).is_err());
        assert!(create_project(path(&parent), "???".into()).is_err());
        assert!(create_project(path(&parent), "NUL".into()).is_err());

        fs::remove_dir_all(&dir).unwrap();
    }

    /* --------------------------------------------------------------- acts */

    fn act_titles(project: &Project) -> Vec<(&str, &str)> {
        project
            .acts
            .iter()
            .map(|act| (act.id.as_str(), act.title.as_str()))
            .collect()
    }

    #[test]
    fn acts_can_be_added_renamed_and_moved() {
        let dir = project_with(TWO_ACTS);
        let p = path(&dir);

        let made = create_act(p.clone(), "Act three".into(), 99).unwrap();
        assert_eq!(
            act_titles(&made),
            [
                ("act-1", "Act one"),
                ("act-2", "Act two"),
                ("act-3", "Act three")
            ]
        );

        let renamed = rename_act(p.clone(), "act-3".into(), "The reckoning".into()).unwrap();
        assert_eq!(renamed.acts[2].title, "The reckoning");

        // Moving an act carries its chapters, and their scenes, with it.
        let moved = move_act(p.clone(), "act-2".into(), 0).unwrap();
        assert_eq!(order(&moved), ["sc-four", "sc-one", "sc-two", "sc-three"]);

        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn deleting_an_act_can_keep_its_chapters() {
        let dir = project_with(TWO_ACTS);

        let p = delete_act(path(&dir), "act-2".into(), Contents::Move).unwrap();

        // Act two's chapter joins the end of act one, whole.
        assert_eq!(act_titles(&p), [("act-1", "Act one")]);
        assert_eq!(
            shape(&p),
            [vec![
                vec!["sc-one", "sc-two"],
                vec!["sc-three"],
                vec!["sc-four"]
            ]]
        );

        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn deleting_the_first_act_puts_its_chapters_in_front() {
        let dir = project_with(TWO_ACTS);

        // There is no act above, so they go to the top of the one below —
        // they came before it in the manuscript.
        let p = delete_act(path(&dir), "act-1".into(), Contents::Move).unwrap();

        assert_eq!(order(&p), ["sc-one", "sc-two", "sc-three", "sc-four"]);
        assert_eq!(act_titles(&p), [("act-2", "Act two")]);

        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn deleting_an_act_can_trash_every_scene_inside_it() {
        let dir = project_with(TWO_ACTS);
        fs::create_dir_all(dir.join(SCENES)).unwrap();
        fs::write(dir.join("scenes/one.md"), "the first").unwrap();
        fs::write(dir.join("scenes/two.md"), "the second").unwrap();
        fs::write(dir.join("scenes/three.md"), "the third").unwrap();

        // Two chapters deep — every scene under the act has to be found.
        let p = delete_act(path(&dir), "act-1".into(), Contents::Trash).unwrap();

        assert_eq!(order(&p), ["sc-four"]);
        assert_eq!(
            fs::read_to_string(dir.join("trash/one.md")).unwrap(),
            "the first"
        );
        assert_eq!(
            fs::read_to_string(dir.join("trash/three.md")).unwrap(),
            "the third"
        );

        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn the_last_act_cannot_be_deleted() {
        let dir = project();

        let err = delete_act(path(&dir), "act-1".into(), Contents::Move).unwrap_err();
        assert!(err.contains("at least one act"));
        assert_eq!(fs::read_to_string(dir.join(MANIFEST)).unwrap(), SAMPLE);

        fs::remove_dir_all(&dir).unwrap();
    }

    /* ----------------------------------------------------------- chapters */

    #[test]
    fn chapters_can_be_added_renamed_and_moved() {
        let dir = project_with(TWO_ACTS);
        let p = path(&dir);

        let made = create_chapter(p.clone(), "act-2".into(), "Chapter four".into(), 0).unwrap();
        assert_eq!(made.acts[1].chapters[0].id, "ch-4");
        assert_eq!(made.acts[1].chapters[0].title, "Chapter four");

        let renamed = rename_chapter(p.clone(), "ch-4".into(), "The drive".into()).unwrap();
        assert_eq!(renamed.acts[1].chapters[0].title, "The drive");

        // Into another act, carrying its scenes.
        let moved = move_chapter(p.clone(), "ch-1".into(), "act-2".into(), 0).unwrap();
        assert_eq!(
            shape(&moved),
            [
                vec![vec!["sc-three"]],
                vec![vec!["sc-one", "sc-two"], Vec::new(), vec!["sc-four"]]
            ]
        );

        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn deleting_a_chapter_can_keep_its_scenes() {
        let dir = project_with(TWO_ACTS);

        // ch-2 sits below ch-1 in the same act, so its scenes join the end of it.
        let p = delete_chapter(path(&dir), "ch-2".into(), Contents::Move).unwrap();

        assert_eq!(
            shape(&p),
            [
                vec![vec!["sc-one", "sc-two", "sc-three"]],
                vec![vec!["sc-four"]]
            ]
        );

        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn deleting_a_chapter_crosses_into_the_previous_act() {
        let dir = project_with(TWO_ACTS);

        // ch-3 is the first chapter of act two, so the chapter above it is the
        // last one of act one.
        let p = delete_chapter(path(&dir), "ch-3".into(), Contents::Move).unwrap();

        assert_eq!(
            shape(&p),
            [
                vec![vec!["sc-one", "sc-two"], vec!["sc-three", "sc-four"]],
                Vec::new()
            ]
        );

        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn deleting_the_first_chapter_puts_its_scenes_in_front() {
        let dir = project_with(TWO_ACTS);

        // Nothing above ch-1 anywhere, so its scenes go to the top of ch-2.
        let p = delete_chapter(path(&dir), "ch-1".into(), Contents::Move).unwrap();

        assert_eq!(
            shape(&p),
            [
                vec![vec!["sc-one", "sc-two", "sc-three"]],
                vec![vec!["sc-four"]]
            ]
        );

        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn deleting_a_chapter_can_trash_its_scenes() {
        let dir = project_with(TWO_ACTS);
        fs::create_dir_all(dir.join(SCENES)).unwrap();
        fs::write(dir.join("scenes/one.md"), "the first").unwrap();
        fs::write(dir.join("scenes/two.md"), "the second").unwrap();

        let p = delete_chapter(path(&dir), "ch-1".into(), Contents::Trash).unwrap();

        assert_eq!(order(&p), ["sc-three", "sc-four"]);
        assert_eq!(
            fs::read_to_string(dir.join("trash/one.md")).unwrap(),
            "the first"
        );

        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn the_only_chapter_has_nowhere_to_move_its_scenes() {
        let dir = project();

        // SAMPLE has one chapter. Moving is impossible; trashing still works.
        let err = delete_chapter(path(&dir), "ch-1".into(), Contents::Move).unwrap_err();
        assert!(err.contains("nowhere to go"));
        assert_eq!(fs::read_to_string(dir.join(MANIFEST)).unwrap(), SAMPLE);

        let p = delete_chapter(path(&dir), "ch-1".into(), Contents::Trash).unwrap();
        assert!(p.acts[0].chapters.is_empty());

        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn ids_are_never_shared_by_two_things_at_once() {
        let dir = project_with(TWO_ACTS);
        let p = path(&dir);

        create_act(p.clone(), "Third".into(), 99).unwrap();
        delete_act(p.clone(), "act-2".into(), Contents::Move).unwrap();
        create_act(p.clone(), "Fourth".into(), 99).unwrap();

        create_chapter(p.clone(), "act-1".into(), "A".into(), 99).unwrap();
        delete_chapter(p.clone(), "ch-2".into(), Contents::Move).unwrap();
        let after = create_chapter(p.clone(), "act-1".into(), "B".into(), 99).unwrap();

        // Freed ids get reused; what matters is that nothing holds one twice.
        let mut ids: Vec<&str> = after.acts.iter().map(|a| a.id.as_str()).collect();
        ids.extend(chapters(&after).map(|c| c.id.as_str()));

        let mut unique = ids.clone();
        unique.sort_unstable();
        unique.dedup();
        assert_eq!(ids.len(), unique.len());

        fs::remove_dir_all(&dir).unwrap();
    }
}
