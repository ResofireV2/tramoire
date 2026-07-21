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

use crate::model::{Created, Project, SceneMeta, FORMAT_VERSION};
use crate::naming::slugify;
use crate::paths::{checkpoint, resolve, write_atomic};

const MANIFEST: &str = "project.json";
const SCENES: &str = "scenes";
const TRASH: &str = "trash";

#[tauri::command]
pub fn open_project(path: String) -> Result<Project, String> {
    read_manifest(&path)
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

/// Retitle a scene. Returns the manifest as it now stands on disk, so the
/// frontend replaces its copy rather than patching one that may be stale.
#[tauri::command]
pub fn rename_scene(
    project_path: String,
    scene_id: String,
    title: String,
) -> Result<Project, String> {
    let title = clean_title(&title)?;

    let mut project = read_manifest(&project_path)?;

    let mut changed = false;
    {
        let scene = project
            .acts
            .iter_mut()
            .flat_map(|act| act.scenes.iter_mut())
            .find(|scene| scene.id == scene_id)
            .ok_or_else(|| format!("no scene {scene_id} in this project"))?;

        if scene.title != title {
            scene.title = title;
            changed = true;
        }
    }

    // Nothing to write means nothing to check point. Retitling a scene to what
    // it already says should not consume the one backup slot.
    if changed {
        write_manifest(&project_path, &project)?;
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
    to_act_id: String,
    to_index: usize,
) -> Result<Project, String> {
    let mut project = read_manifest(&project_path)?;

    let (from_act, from_index) = project
        .acts
        .iter()
        .enumerate()
        .find_map(|(act, a)| {
            a.scenes
                .iter()
                .position(|s| s.id == scene_id)
                .map(|i| (act, i))
        })
        .ok_or_else(|| format!("no scene {scene_id} in this project"))?;

    let to_act = project
        .acts
        .iter()
        .position(|act| act.id == to_act_id)
        .ok_or_else(|| format!("no act {to_act_id} in this project"))?;

    let scene = project.acts[from_act].scenes.remove(from_index);
    let to_index = to_index.min(project.acts[to_act].scenes.len());
    project.acts[to_act].scenes.insert(to_index, scene);

    // Dropping a scene back where it came from is a real gesture — a drag that
    // ends where it started — and it should cost nothing.
    if to_act != from_act || to_index != from_index {
        write_manifest(&project_path, &project)?;
    }

    Ok(project)
}

/// Add an empty scene to an act.
///
/// The file is written before the manifest that names it. Both orders can fail
/// halfway, and this is the harmless half: an entry pointing at a file that does
/// not exist breaks the project, while a file nothing points at is invisible.
/// Same invariant from the other end in `delete_scene`.
#[tauri::command]
pub fn create_scene(
    project_path: String,
    act_id: String,
    title: String,
    to_index: usize,
) -> Result<Created, String> {
    let title = clean_title(&title)?;
    let mut project = read_manifest(&project_path)?;

    let act = project
        .acts
        .iter()
        .position(|act| act.id == act_id)
        .ok_or_else(|| format!("no act {act_id} in this project"))?;

    let stem = unused_stem(&project_path, &project, &slugify(&title))?;
    let scene = SceneMeta {
        id: format!("sc-{stem}"),
        title,
        file: format!("{SCENES}/{stem}.md"),
        status: String::new(),
    };

    let file = resolve(&project_path, &scene.file)?;
    write_atomic(&file, "")?;

    let to_index = to_index.min(project.acts[act].scenes.len());
    project.acts[act].scenes.insert(to_index, scene.clone());

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

    let (act, index) = project
        .acts
        .iter()
        .enumerate()
        .find_map(|(act, a)| {
            a.scenes
                .iter()
                .position(|s| s.id == scene_id)
                .map(|i| (act, i))
        })
        .ok_or_else(|| format!("no scene {scene_id} in this project"))?;

    let scene = project.acts[act].scenes.remove(index);
    let from = resolve(&project_path, &scene.file)?;

    write_manifest(&project_path, &project)?;

    // An entry whose file has already gone is still worth removing from the
    // binder — there is simply nothing left to move.
    if from.exists() {
        let name = Path::new(&scene.file)
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("scene.md");

        let to = resolve(&project_path, &unused_trash_file(&project_path, name)?)?;

        if let Some(parent) = to.parent() {
            fs::create_dir_all(parent)
                .map_err(|e| format!("couldn't create {}: {e}", parent.display()))?;
        }

        fs::rename(&from, &to)
            .map_err(|e| format!("couldn't move {} to {TRASH}: {e}", from.display()))?;
    }

    Ok(project)
}

/* --------------------------------------------------------------- naming */

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
            .acts
            .iter()
            .flat_map(|act| act.scenes.iter())
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

    let project: Project =
        serde_json::from_str(&raw).map_err(|e| format!("{MANIFEST} is malformed: {e}"))?;

    // Checked on every read, not just on open: the folder may have been
    // upgraded by a newer build on another device while this window was open,
    // and writing to it would drop whatever that version added.
    if project.format_version > FORMAT_VERSION {
        return Err(format!(
            "this project was made by a newer version of Tramoire (format {} vs {})",
            project.format_version, FORMAT_VERSION
        ));
    }

    Ok(project)
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
  "formatVersion": 1,
  "title": "The county line",
  "acts": [
    {
      "id": "act-1",
      "title": "Act one",
      "scenes": [
        { "id": "sc-one", "title": "Six hours out", "file": "scenes/one.md", "status": "draft" },
        { "id": "sc-two", "title": "The Sundowner", "file": "scenes/two.md", "status": "" }
      ]
    }
  ]
}
"#;

    /// Two acts, because the interesting moves are the ones that cross.
    const TWO_ACTS: &str = r#"{
  "formatVersion": 1,
  "title": "The county line",
  "acts": [
    {
      "id": "act-1",
      "title": "Act one",
      "scenes": [
        { "id": "sc-one", "title": "One", "file": "scenes/one.md", "status": "" },
        { "id": "sc-two", "title": "Two", "file": "scenes/two.md", "status": "" }
      ]
    },
    {
      "id": "act-2",
      "title": "Act two",
      "scenes": [
        { "id": "sc-three", "title": "Three", "file": "scenes/three.md", "status": "" }
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

    fn titles(project: &Project) -> Vec<&str> {
        project
            .acts
            .iter()
            .flat_map(|act| act.scenes.iter())
            .map(|scene| scene.title.as_str())
            .collect()
    }

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
    fn rename_leaves_the_rest_of_the_manifest_alone() {
        let dir = project();
        rename_scene(path(&dir), "sc-two".into(), "The Sundowner Motel".into()).unwrap();

        let on_disk = read_manifest(&path(&dir)).unwrap();
        let scene = &on_disk.acts[0].scenes[1];
        assert_eq!(on_disk.title, "The county line");
        assert_eq!(on_disk.format_version, 1);
        assert_eq!(scene.file, "scenes/two.md");
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

    /// Scene ids per act, which is the whole of what a move is allowed to change.
    fn shape(project: &Project) -> Vec<Vec<&str>> {
        project
            .acts
            .iter()
            .map(|act| act.scenes.iter().map(|s| s.id.as_str()).collect())
            .collect()
    }

    #[test]
    fn move_down_within_an_act() {
        let dir = project_with(TWO_ACTS);

        // The off-by-one case: sc-one is at 0, and landing after sc-two means
        // targeting 1, not 2, because the removal shifts sc-two up first.
        let p = move_scene(path(&dir), "sc-one".into(), "act-1".into(), 1).unwrap();

        assert_eq!(shape(&p), [vec!["sc-two", "sc-one"], vec!["sc-three"]]);
        assert_eq!(shape(&read_manifest(&path(&dir)).unwrap()), shape(&p));

        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn move_up_within_an_act() {
        let dir = project_with(TWO_ACTS);
        let p = move_scene(path(&dir), "sc-two".into(), "act-1".into(), 0).unwrap();

        assert_eq!(shape(&p), [vec!["sc-two", "sc-one"], vec!["sc-three"]]);

        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn move_across_an_act_boundary() {
        let dir = project_with(TWO_ACTS);

        // Down off the end of act one is the top of act two.
        let p = move_scene(path(&dir), "sc-two".into(), "act-2".into(), 0).unwrap();
        assert_eq!(shape(&p), [vec!["sc-one"], vec!["sc-two", "sc-three"]]);

        // And back up off the top of act two is the end of act one.
        let p = move_scene(path(&dir), "sc-two".into(), "act-1".into(), 1).unwrap();
        assert_eq!(shape(&p), [vec!["sc-one", "sc-two"], vec!["sc-three"]]);

        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn move_can_empty_an_act() {
        let dir = project_with(TWO_ACTS);
        let p = move_scene(path(&dir), "sc-three".into(), "act-1".into(), 2).unwrap();

        assert_eq!(
            shape(&p),
            [vec!["sc-one", "sc-two", "sc-three"], Vec::new()]
        );

        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn move_clamps_an_index_past_the_end() {
        let dir = project_with(TWO_ACTS);

        // What a frontend working from a stale copy would send. The scene ends
        // up last rather than the move being lost.
        let p = move_scene(path(&dir), "sc-one".into(), "act-2".into(), 99).unwrap();

        assert_eq!(shape(&p), [vec!["sc-two"], vec!["sc-three", "sc-one"]]);

        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn moving_a_scene_nowhere_writes_nothing() {
        let dir = project_with(TWO_ACTS);
        move_scene(path(&dir), "sc-one".into(), "act-1".into(), 0).unwrap();

        assert!(!dir.join(".project.json.bak").exists());

        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn move_rejects_unknown_ids_without_losing_a_scene() {
        let dir = project_with(TWO_ACTS);
        let p = path(&dir);

        assert!(move_scene(p.clone(), "sc-nope".into(), "act-1".into(), 0).is_err());
        assert!(move_scene(p.clone(), "sc-one".into(), "act-nope".into(), 0).is_err());

        // The unknown-act path removes the scene before it discovers the act is
        // not there. Nothing may reach the file.
        assert_eq!(fs::read_to_string(dir.join(MANIFEST)).unwrap(), TWO_ACTS);

        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn create_writes_a_file_and_an_entry() {
        let dir = project_with(TWO_ACTS);
        let made = create_scene(path(&dir), "act-2".into(), "What Nadia knew".into(), 0).unwrap();

        assert_eq!(made.scene.id, "sc-what-nadia-knew");
        assert_eq!(made.scene.file, "scenes/what-nadia-knew.md");
        assert_eq!(
            shape(&made.project),
            [
                vec!["sc-one", "sc-two"],
                vec!["sc-what-nadia-knew", "sc-three"]
            ]
        );

        // The invariant: an entry in the manifest always has a file behind it.
        let file = dir.join("scenes/what-nadia-knew.md");
        assert_eq!(fs::read_to_string(&file).unwrap(), "");

        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn create_never_reuses_a_name() {
        let dir = project_with(TWO_ACTS);
        let p = path(&dir);

        let first = create_scene(p.clone(), "act-1".into(), "The drive".into(), 0).unwrap();
        let second = create_scene(p.clone(), "act-1".into(), "The drive".into(), 0).unwrap();

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

        let made = create_scene(path(&dir), "act-1".into(), "Orphan".into(), 0).unwrap();

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

        assert_eq!(shape(&p), [vec!["sc-one"], vec!["sc-three"]]);
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

        assert_eq!(shape(&p), [vec!["sc-one"], vec!["sc-three"]]);

        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn create_and_delete_reject_unknown_ids() {
        let dir = project_with(TWO_ACTS);
        let p = path(&dir);

        assert!(create_scene(p.clone(), "act-nope".into(), "A scene".into(), 0).is_err());
        assert!(create_scene(p.clone(), "act-1".into(), "  ".into(), 0).is_err());
        assert!(delete_scene(p.clone(), "sc-nope".into()).is_err());

        assert_eq!(fs::read_to_string(dir.join(MANIFEST)).unwrap(), TWO_ACTS);

        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn rename_refuses_a_newer_format() {
        let dir = project_with(&SAMPLE.replace("\"formatVersion\": 1", "\"formatVersion\": 99"));

        assert!(rename_scene(path(&dir), "sc-one".into(), "Renamed".into()).is_err());
        assert!(!dir.join(".project.json.bak").exists());

        fs::remove_dir_all(&dir).unwrap();
    }
}
