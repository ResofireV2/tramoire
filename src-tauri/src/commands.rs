//! Every command the frontend can call. Nothing else touches the filesystem.

use std::fs;
use std::path::Path;

use crate::model::{Project, FORMAT_VERSION};
use crate::paths::{resolve, write_atomic};

const MANIFEST: &str = "project.json";

#[tauri::command]
pub fn open_project(path: String) -> Result<Project, String> {
    let manifest = Path::new(&path).join(MANIFEST);

    let raw = fs::read_to_string(&manifest).map_err(|e| {
        format!("couldn't read {MANIFEST} — is {path} a Tramoire project folder? ({e})")
    })?;

    let project: Project =
        serde_json::from_str(&raw).map_err(|e| format!("{MANIFEST} is malformed: {e}"))?;

    if project.format_version > FORMAT_VERSION {
        return Err(format!(
            "this project was made by a newer version of Tramoire (format {} vs {})",
            project.format_version, FORMAT_VERSION
        ));
    }

    Ok(project)
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
