//! What the application remembers between runs.
//!
//! Written beside the application in the OS config directory, never in a
//! project folder — a shared project should not carry someone else's font size
//! or their list of other novels.
//!
//! Deliberately not the webview's `localStorage`. That is storage the webview
//! owns, and on Linux it is not reliably kept between runs for a Tauri origin,
//! which turns "reopen what I had open" into a coin toss. A file this
//! application writes is a file this application can count on.

use std::fs;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

use crate::paths::write_atomic;

const FILE: &str = "settings.json";

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Theme {
    pub chrome: String,
    pub editor: String,
}

impl Default for Theme {
    fn default() -> Self {
        Theme {
            chrome: "dark".to_string(),
            editor: "paper".to_string(),
        }
    }
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Recent {
    pub path: String,
    pub title: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    pub theme: Theme,
    /// Most recently opened first.
    pub recent: Vec<Recent>,
    /// Where the last project was created, to save choosing it again.
    pub last_parent: Option<String>,
}

/// Settings as they stand, or the defaults.
///
/// Every failure returns defaults rather than an error. Nothing here is worth
/// refusing to start over, and a settings file that has been corrupted or
/// written by a newer build should cost someone their theme, not their evening.
#[tauri::command]
pub fn load_settings(app: AppHandle) -> Settings {
    let Some(path) = file(&app) else {
        return Settings::default();
    };

    fs::read_to_string(path)
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default()
}

#[tauri::command]
pub fn save_settings(app: AppHandle, settings: Settings) -> Result<(), String> {
    let path = file(&app).ok_or("no config directory on this system")?;

    let mut json = serde_json::to_string_pretty(&settings)
        .map_err(|e| format!("couldn't serialise settings: {e}"))?;
    json.push('\n');

    write_atomic(&path, &json)
}

fn file(app: &AppHandle) -> Option<PathBuf> {
    app.path().app_config_dir().ok().map(|dir| dir.join(FILE))
}
