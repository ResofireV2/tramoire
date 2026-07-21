//! The shape of `project.json`.
//!
//! Mirrored by `src/lib/storage.ts` on the frontend. If you change a struct
//! here, change the type there in the same commit.

use serde::{Deserialize, Serialize};

/// Manifest versions this build understands. Bump when the shape changes in a
/// way older builds would misread, and keep the check — opening a project from
/// a newer version should say so rather than silently drop fields.
pub const FORMAT_VERSION: u32 = 1;

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SceneMeta {
    pub id: String,
    pub title: String,
    /// Project-relative, always forward-slashed.
    pub file: String,
    #[serde(default)]
    pub status: String,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Act {
    pub id: String,
    pub title: String,
    #[serde(default)]
    pub scenes: Vec<SceneMeta>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Project {
    pub format_version: u32,
    pub title: String,
    #[serde(default)]
    pub acts: Vec<Act>,
}
