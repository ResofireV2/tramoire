//! The shape of `project.json`, including the shapes it used to have.
//!
//! Mirrored by `src/lib/storage.ts` on the frontend. If you change a struct
//! here, change the type there in the same commit.

use serde::{Deserialize, Serialize};

/// Manifest versions this build understands. Bump when the shape changes in a
/// way older builds would misread, and keep the check — opening a project from
/// a newer version should say so rather than silently drop fields.
///
/// 1 — acts held scenes directly.
/// 2 — chapters sit between them.
pub const FORMAT_VERSION: u32 = 2;

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
pub struct Chapter {
    pub id: String,
    pub title: String,
    #[serde(default)]
    pub scenes: Vec<SceneMeta>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Act {
    pub id: String,
    pub title: String,
    #[serde(default)]
    pub chapters: Vec<Chapter>,
}

/// What `create_scene` gives back: the manifest as it now stands, plus the
/// scene that was just made, so the frontend can open it without having to
/// work out which entry is new.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Created {
    pub project: Project,
    pub scene: SceneMeta,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Project {
    pub format_version: u32,
    pub title: String,
    #[serde(default)]
    pub acts: Vec<Act>,
}

impl Project {
    /// Every scene in the book, in reading order.
    pub fn scenes(&self) -> impl Iterator<Item = &SceneMeta> {
        self.acts
            .iter()
            .flat_map(|act| act.chapters.iter())
            .flat_map(|chapter| chapter.scenes.iter())
    }
}

/// The manifest as version 1 wrote it, kept only to read one.
///
/// A format that promises to outlive the application has to be able to read
/// what it wrote last year, so old shapes are never deleted from here — they
/// are converted on the way in and disappear on the next write.
pub mod v1 {
    use serde::Deserialize;

    use super::SceneMeta;

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    pub struct Act {
        pub id: String,
        pub title: String,
        #[serde(default)]
        pub scenes: Vec<SceneMeta>,
    }

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    pub struct Project {
        pub title: String,
        #[serde(default)]
        pub acts: Vec<Act>,
    }
}

impl From<v1::Project> for Project {
    /// Each scene becomes a chapter of its own.
    ///
    /// Version 1 had no chapter level, and a scene in it stood for what a
    /// reader would call a chapter — the sample kept chapter numbers in scene
    /// status strings to prove it. Grouping several scenes under one chapter
    /// here would be inventing an editorial decision nobody made; splitting
    /// them is reversible by moving a scene and deleting the empty chapter.
    fn from(old: v1::Project) -> Self {
        let mut n = 0;

        let acts = old
            .acts
            .into_iter()
            .map(|act| Act {
                id: act.id,
                title: act.title,
                chapters: act
                    .scenes
                    .into_iter()
                    .map(|scene| {
                        n += 1;
                        Chapter {
                            id: format!("ch-{n}"),
                            title: format!("Chapter {n}"),
                            scenes: vec![scene],
                        }
                    })
                    .collect(),
            })
            .collect();

        Project {
            format_version: FORMAT_VERSION,
            title: old.title,
            acts,
        }
    }
}
