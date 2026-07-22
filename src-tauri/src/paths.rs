//! Path handling for project-relative files.
//!
//! Every path that arrives from the frontend is untrusted. `resolve` is the
//! only way a command is allowed to turn one into something it opens.

use std::fs;
use std::path::{Component, Path, PathBuf};

pub const TRASH: &str = "trash";

/// Join a project-relative path onto the project root.
///
/// Rejects absolute paths, `..`, drive prefixes, and root components — so a
/// malformed or malicious `project.json` cannot reach outside the project
/// folder. Checked structurally rather than by string matching, because
/// `"foo/..bar"` is a legal filename and `"foo/../../etc"` is not.
pub fn resolve(project_path: &str, rel: &str) -> Result<PathBuf, String> {
    let rel = Path::new(rel);

    if rel.as_os_str().is_empty() {
        return Err("empty path".into());
    }

    for component in rel.components() {
        match component {
            Component::Normal(_) => {}
            _ => {
                return Err(format!(
                    "path must stay inside the project: {}",
                    rel.display()
                ))
            }
        }
    }

    Ok(Path::new(project_path).join(rel))
}

/// Keep a copy of a file next to it before it is overwritten.
///
/// `project.json` is the one thing in a project folder that cannot be
/// reconstructed from the scene files — it holds every title, ordering and act
/// membership. An atomic write rules out a half-written manifest, but not a
/// well-formed wrong one, so the last good copy stays beside it under a name a
/// human can rename back by hand.
///
/// A missing target is not an error: the first write has nothing to keep.
pub fn checkpoint(path: &Path) -> Result<(), String> {
    if !path.exists() {
        return Ok(());
    }

    let (parent, name) = split(path)?;
    let backup = parent.join(format!(".{name}.bak"));

    fs::copy(path, &backup)
        .map(|_| ())
        .map_err(|e| format!("couldn't back up {}: {e}", path.display()))
}

/// Write a file the way a writing app has to write files.
///
/// Write to a sibling temp file, then rename over the target. Rename is atomic
/// on every platform we ship to, so a crash — or a sync client reading the
/// folder mid-write — sees either the old file or the new one, never a
/// half-written one. `fs::rename` replaces an existing file on Windows too.
pub fn write_atomic(path: &Path, contents: &str) -> Result<(), String> {
    let (parent, name) = split(path)?;

    fs::create_dir_all(parent).map_err(|e| format!("couldn't create {}: {e}", parent.display()))?;

    let tmp = parent.join(format!(".{name}.tmp"));

    fs::write(&tmp, contents).map_err(|e| format!("couldn't write {}: {e}", tmp.display()))?;

    fs::rename(&tmp, path).map_err(|e| {
        let _ = fs::remove_file(&tmp);
        format!("couldn't save {}: {e}", path.display())
    })
}

/// The directory and filename a sibling file has to be built from.
fn split(path: &Path) -> Result<(&Path, &str), String> {
    let parent = path
        .parent()
        .ok_or_else(|| format!("no parent directory for {}", path.display()))?;

    let name = path
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or_else(|| format!("bad filename: {}", path.display()))?;

    Ok((parent, name))
}

/// Move a project file into `trash/`, without overwriting anything already
/// there.
///
/// Deleting prose outright is not something a writing application should
/// offer, so anything it removes stays readable in the project folder and
/// recovery is moving the file back by hand. A file that has already gone is
/// not an error — there is simply nothing left to move.
pub fn trash(project_path: &str, file: &str) -> Result<(), String> {
    let from = resolve(project_path, file)?;
    if !from.exists() {
        return Ok(());
    }

    let name = Path::new(file)
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("untitled.md");

    let to = resolve(project_path, &unused_trash_file(project_path, name)?)?;

    if let Some(parent) = to.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("couldn't create {}: {e}", parent.display()))?;
    }

    fs::rename(&from, &to).map_err(|e| format!("couldn't move {} to {TRASH}: {e}", from.display()))
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_normal_relative_paths() {
        assert!(resolve("/projects/novel", "scenes/one.md").is_ok());
        assert!(resolve("/projects/novel", "scenes/..dotted.md").is_ok());
    }

    #[test]
    fn rejects_escapes() {
        assert!(resolve("/projects/novel", "../secrets").is_err());
        assert!(resolve("/projects/novel", "scenes/../../secrets").is_err());
        assert!(resolve("/projects/novel", "/etc/passwd").is_err());
        assert!(resolve("/projects/novel", "").is_err());
    }
}
