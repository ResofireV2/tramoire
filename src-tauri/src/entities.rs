//! Characters, locations, items, and whatever else gets named.
//!
//! One record type with a `type` field rather than a table per kind. A
//! character and a location differ only in what that field says, which is what
//! makes adding "magic system" a matter of typing the word rather than building
//! anything.
//!
//! There is no index. `entities/` is read to find out what is in it, so a file
//! dropped into the folder by hand simply appears, and a folder that outlives
//! this application still explains itself. That is the whole reason the
//! metadata lives in each file rather than in `project.json`.

use std::fs;

use serde::{Deserialize, Serialize};

use crate::frontmatter::{join_body, split_body, Document, Section, Value};
use crate::naming::{clean_title, is_derived, slugify};
use crate::paths::{resolve, trash, write_atomic};

const ENTITIES: &str = "entities";

/// What an untyped file becomes. A note is the least presumptuous thing to
/// call something whose author never said what it was.
const DEFAULT_KIND: &str = "note";

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Entity {
    /// Stable across renames, unlike the filename. Nothing points at entities
    /// yet, but links will, and they should not break when something is
    /// retitled.
    pub id: String,
    pub name: String,
    /// `type` in the file and to the frontend; `kind` here because `type` is a
    /// Rust keyword.
    #[serde(rename = "type")]
    pub kind: String,
    pub aliases: Vec<String>,
    /// Every other frontmatter key, in the order it should be written. A
    /// character's age lives here, and so does a key someone added by hand that
    /// this build has never heard of.
    pub fields: Vec<Pair>,
    /// The `## Heading` sections of the body, in order.
    pub sections: Vec<Pair>,
    /// Whatever comes before the first heading.
    pub notes: String,
    /// Project-relative, always forward-slashed.
    pub file: String,
}

/// A key and its value. An ordered list rather than a map, because the order
/// is the frontend's to decide and a map would throw it away.
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Pair {
    pub key: String,
    pub value: String,
}

/// Handled on their own, so they never appear among the loose fields.
const RESERVED: [&str; 4] = ["id", "name", "type", "aliases"];

/// Everything in `entities/`, by name.
///
/// A folder that is not there yet is not an error — it is a project with no
/// entities, which is where every project starts.
#[tauri::command]
pub fn list_entities(project_path: String) -> Result<Vec<Entity>, String> {
    let folder = resolve(&project_path, ENTITIES)?;
    if !folder.is_dir() {
        return Ok(Vec::new());
    }

    let listing =
        fs::read_dir(&folder).map_err(|e| format!("couldn't read {}: {e}", folder.display()))?;

    let mut entities = Vec::new();

    for entry in listing.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("md") {
            continue;
        }

        let Some(stem) = path.file_stem().and_then(|s| s.to_str()) else {
            continue;
        };

        // One unreadable file should not hide every other entity, so it is
        // skipped rather than turned into an error for the whole folder.
        let Ok(raw) = fs::read_to_string(&path) else {
            continue;
        };

        entities.push(read(&raw, stem));
    }

    entities.sort_by(|a, b| {
        a.name
            .to_lowercase()
            .cmp(&b.name.to_lowercase())
            .then_with(|| a.file.cmp(&b.file))
    });

    Ok(entities)
}

/// Make a new entity and return it.
#[tauri::command]
pub fn create_entity(project_path: String, name: String, kind: String) -> Result<Entity, String> {
    let name = clean_title(&name)?;
    let kind = clean_title(&kind).unwrap_or_else(|_| DEFAULT_KIND.to_string());

    let stem = unused_stem(&project_path, &slugify(&name))?;

    let entity = Entity {
        id: format!("en-{stem}"),
        name,
        kind,
        aliases: Vec::new(),
        fields: Vec::new(),
        sections: Vec::new(),
        notes: String::new(),
        file: format!("{ENTITIES}/{stem}.md"),
    };

    write_atomic(&resolve(&project_path, &entity.file)?, &render(&entity))?;
    Ok(entity)
}

/// Save an entity, moving its file to match its name if the app named it.
///
/// The file on disk is read first rather than overwritten wholesale, so fields
/// this build knows nothing about survive being edited by it — the same reason
/// the manifest is re-read before every write.
#[tauri::command]
pub fn write_entity(project_path: String, entity: Entity) -> Result<Entity, String> {
    let mut entity = entity;
    entity.name = clean_title(&entity.name)?;
    entity.kind = clean_title(&entity.kind).unwrap_or_else(|_| DEFAULT_KIND.to_string());

    let from = resolve(&project_path, &entity.file)?;
    let existing = fs::read_to_string(&from).unwrap_or_default();
    let mut doc = Document::parse(&existing);

    let old_name = doc.text("name").unwrap_or_default().to_string();

    // Same rule as a scene file: a name the app derived follows the title, a
    // name someone chose themselves is theirs permanently.
    if !old_name.is_empty()
        && old_name != entity.name
        && is_derived(&entity.file, ENTITIES, &old_name)
        && slugify(&entity.name) != slugify(&old_name)
    {
        let stem = unused_stem(&project_path, &slugify(&entity.name))?;
        let moved = format!("{ENTITIES}/{stem}.md");
        let to = resolve(&project_path, &moved)?;

        if from.exists() && fs::rename(&from, &to).is_ok() {
            entity.file = moved;
        }
    }

    apply(&mut doc, &entity);
    write_atomic(&resolve(&project_path, &entity.file)?, &doc.render())?;

    Ok(entity)
}

/// Move an entity's file to `trash/`. Its prose is as worth keeping as a
/// scene's.
#[tauri::command]
pub fn delete_entity(project_path: String, file: String) -> Result<(), String> {
    trash(&project_path, &file)
}

/* ---------------------------------------------------------------- format */

fn read(raw: &str, stem: &str) -> Entity {
    let doc = Document::parse(raw);
    let (notes, sections) = split_body(&doc.body);

    Entity {
        id: doc
            .text("id")
            .map(str::to_string)
            .unwrap_or_else(|| format!("en-{stem}")),
        // A file someone dropped in without frontmatter is named by its
        // filename, which is the only thing it has said about itself.
        name: doc
            .text("name")
            .map(str::to_string)
            .unwrap_or_else(|| stem.replace('-', " ")),
        kind: doc.text("type").unwrap_or(DEFAULT_KIND).to_string(),
        aliases: doc.list("aliases"),
        fields: doc
            .fields
            .iter()
            .filter(|field| !RESERVED.contains(&field.key.as_str()))
            .filter_map(|field| match &field.value {
                Value::Text(text) => Some(Pair {
                    key: field.key.clone(),
                    value: text.clone(),
                }),
                // A list where a value is expected is not something the record
                // form can show, so it is left alone rather than flattened.
                Value::List(_) => None,
            })
            .collect(),
        sections: sections
            .into_iter()
            .map(|section| Pair {
                key: section.heading,
                value: section.text,
            })
            .collect(),
        notes,
        file: format!("{ENTITIES}/{stem}.md"),
    }
}

fn render(entity: &Entity) -> String {
    let mut doc = Document::default();
    apply(&mut doc, entity);
    doc.render()
}

/// Write an entity's fields over a document, leaving every other field alone.
fn apply(doc: &mut Document, entity: &Entity) {
    doc.set("id", Value::Text(entity.id.clone()));
    doc.set("name", Value::Text(entity.name.clone()));
    doc.set("type", Value::Text(entity.kind.clone()));

    // An empty list would render as a bare `aliases:` with nothing under it,
    // which reads as a mistake in a file meant for humans.
    if entity.aliases.is_empty() {
        doc.remove("aliases");
    } else {
        doc.set("aliases", Value::List(entity.aliases.clone()));
    }

    // A field left blank is removed rather than written empty, so a template
    // offering six boxes does not put six empty keys in everyone's files.
    for pair in &entity.fields {
        if pair.value.trim().is_empty() {
            doc.remove(&pair.key);
        } else {
            doc.set(&pair.key, Value::Text(pair.value.trim().to_string()));
        }
    }

    // Anything the record no longer carries has been deleted from it. Lists are
    // exempt: `read` never surfaced them, so the form cannot have dropped one.
    let kept: Vec<String> = entity.fields.iter().map(|pair| pair.key.clone()).collect();
    doc.fields.retain(|field| {
        RESERVED.contains(&field.key.as_str())
            || kept.contains(&field.key)
            || matches!(field.value, Value::List(_))
    });

    let sections: Vec<Section> = entity
        .sections
        .iter()
        .map(|pair| Section {
            heading: pair.key.clone(),
            text: pair.value.clone(),
        })
        .collect();

    doc.body = join_body(&entity.notes, &sections);
}

/// A filename stem no file in `entities/` has taken.
fn unused_stem(project_path: &str, base: &str) -> Result<String, String> {
    for n in 1..1000 {
        let stem = if n == 1 {
            base.to_string()
        } else {
            format!("{base}-{n}")
        };

        if !resolve(project_path, &format!("{ENTITIES}/{stem}.md"))?.exists() {
            return Ok(stem);
        }
    }

    Err(format!("too many entities named like {base}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::{Path, PathBuf};
    use std::sync::atomic::{AtomicU32, Ordering};

    fn project() -> PathBuf {
        static COUNTER: AtomicU32 = AtomicU32::new(0);
        let n = COUNTER.fetch_add(1, Ordering::Relaxed);

        let dir = std::env::temp_dir().join(format!("tramoire-en-{}-{n}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn path(dir: &Path) -> String {
        dir.to_str().unwrap().to_string()
    }

    #[test]
    fn a_project_with_no_entities_folder_has_no_entities() {
        let dir = project();
        assert!(list_entities(path(&dir)).unwrap().is_empty());
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn creating_one_writes_a_file_that_reads_back() {
        let dir = project();
        let made = create_entity(path(&dir), "Nadia Okonkwo".into(), "character".into()).unwrap();

        assert_eq!(made.file, "entities/nadia-okonkwo.md");
        assert_eq!(made.id, "en-nadia-okonkwo");

        let listed = list_entities(path(&dir)).unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].name, "Nadia Okonkwo");
        assert_eq!(listed[0].kind, "character");

        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn notes_and_aliases_survive_a_round_trip() {
        let dir = project();
        let mut made = create_entity(path(&dir), "Nadia".into(), "character".into()).unwrap();

        made.aliases = vec!["Ms Okonkwo".into(), "the manager".into()];
        made.notes = "Runs the desk at the Sundowner.\n".into();
        write_entity(path(&dir), made).unwrap();

        let listed = list_entities(path(&dir)).unwrap();
        assert_eq!(listed[0].aliases, ["Ms Okonkwo", "the manager"]);
        assert_eq!(listed[0].notes, "Runs the desk at the Sundowner.\n");

        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn renaming_moves_a_file_this_app_named() {
        let dir = project();
        let mut made = create_entity(path(&dir), "Nadia".into(), "character".into()).unwrap();

        made.name = "Nadia Okonkwo".into();
        let saved = write_entity(path(&dir), made).unwrap();

        assert_eq!(saved.file, "entities/nadia-okonkwo.md");
        assert!(!dir.join("entities/nadia.md").exists());
        // The id is identity and does not move with the label.
        assert_eq!(saved.id, "en-nadia");

        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn renaming_leaves_a_hand_named_file_alone() {
        let dir = project();
        fs::create_dir_all(dir.join(ENTITIES)).unwrap();
        fs::write(
            dir.join("entities/cast-01.md"),
            "---\nid: en-cast-01\nname: Nadia\ntype: character\n---\n\nBody.\n",
        )
        .unwrap();

        let mut entity = list_entities(path(&dir)).unwrap().remove(0);
        entity.name = "Nadia Okonkwo".into();
        let saved = write_entity(path(&dir), entity).unwrap();

        assert_eq!(saved.file, "entities/cast-01.md");
        assert!(dir.join("entities/cast-01.md").exists());

        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn saving_keeps_fields_this_build_knows_nothing_about() {
        let dir = project();
        fs::create_dir_all(dir.join(ENTITIES)).unwrap();
        fs::write(
            dir.join("entities/nadia.md"),
            "---\nid: en-nadia\nname: Nadia\ntype: character\nmood: unreadable\n---\n\nBody.\n",
        )
        .unwrap();

        let mut entity = list_entities(path(&dir)).unwrap().remove(0);
        entity.notes = "Rewritten.\n".into();
        write_entity(path(&dir), entity).unwrap();

        // A field a newer version added has to survive an older one saving.
        let raw = fs::read_to_string(dir.join("entities/nadia.md")).unwrap();
        assert!(raw.contains("mood: unreadable"));
        assert!(raw.contains("Rewritten."));

        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn a_file_dropped_in_by_hand_still_appears() {
        let dir = project();
        fs::create_dir_all(dir.join(ENTITIES)).unwrap();
        fs::write(
            dir.join("entities/the-sundowner.md"),
            "A motel off the highway.\n",
        )
        .unwrap();

        let listed = list_entities(path(&dir)).unwrap();

        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].name, "the sundowner");
        assert_eq!(listed[0].kind, DEFAULT_KIND);
        assert_eq!(listed[0].notes, "A motel off the highway.\n");

        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn two_entities_of_the_same_name_get_their_own_files() {
        let dir = project();
        let first = create_entity(path(&dir), "Ray".into(), "character".into()).unwrap();
        let second = create_entity(path(&dir), "Ray".into(), "location".into()).unwrap();

        assert_eq!(first.file, "entities/ray.md");
        assert_eq!(second.file, "entities/ray-2.md");
        assert_ne!(first.id, second.id);

        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn fields_and_sections_survive_a_round_trip() {
        let dir = project();
        let mut made = create_entity(path(&dir), "Nadia".into(), "character".into()).unwrap();

        made.fields = vec![
            Pair {
                key: "age".into(),
                value: "34".into(),
            },
            Pair {
                key: "birthplace".into(),
                value: "Winslow, Arizona".into(),
            },
        ];
        made.sections = vec![Pair {
            key: "Story purpose".into(),
            value: "Knows what happened in room 9.\n".into(),
        }];
        made.notes = "A line before the headings.\n".into();
        write_entity(path(&dir), made).unwrap();

        let raw = fs::read_to_string(dir.join("entities/nadia.md")).unwrap();
        assert!(raw.contains("age: 34"));
        assert!(raw.contains("## Story purpose"));

        let back = list_entities(path(&dir)).unwrap().remove(0);
        assert_eq!(back.fields[0].key, "age");
        assert_eq!(back.fields[1].value, "Winslow, Arizona");
        assert_eq!(back.sections[0].key, "Story purpose");
        assert_eq!(back.notes, "A line before the headings.\n");

        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn a_field_left_blank_is_removed_rather_than_written_empty() {
        let dir = project();
        let mut made = create_entity(path(&dir), "Nadia".into(), "character".into()).unwrap();

        made.fields = vec![Pair {
            key: "age".into(),
            value: "34".into(),
        }];
        let saved = write_entity(path(&dir), made).unwrap();

        let mut cleared = saved;
        cleared.fields = vec![Pair {
            key: "age".into(),
            value: "  ".into(),
        }];
        write_entity(path(&dir), cleared).unwrap();

        // A template offering six boxes must not put six empty keys in the file.
        let raw = fs::read_to_string(dir.join("entities/nadia.md")).unwrap();
        assert!(!raw.contains("age:"));

        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn a_hand_written_section_is_not_lost_by_saving() {
        let dir = project();
        fs::create_dir_all(dir.join(ENTITIES)).unwrap();
        fs::write(
            dir.join("entities/nadia.md"),
            "---\nid: en-nadia\nname: Nadia\ntype: character\n---\n\n## Something I invented\n\nWorth keeping.\n",
        )
        .unwrap();

        let mut entity = list_entities(path(&dir)).unwrap().remove(0);
        entity.notes = "Edited.\n".into();
        write_entity(path(&dir), entity).unwrap();

        let raw = fs::read_to_string(dir.join("entities/nadia.md")).unwrap();
        assert!(raw.contains("## Something I invented"));
        assert!(raw.contains("Worth keeping."));

        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn deleting_moves_the_file_to_trash() {
        let dir = project();
        let made = create_entity(path(&dir), "Nadia".into(), "character".into()).unwrap();

        delete_entity(path(&dir), made.file.clone()).unwrap();

        assert!(list_entities(path(&dir)).unwrap().is_empty());
        assert!(dir.join("trash/nadia.md").exists());

        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn an_entity_needs_a_name_but_not_a_type() {
        let dir = project();

        assert!(create_entity(path(&dir), "  ".into(), "character".into()).is_err());

        let made = create_entity(path(&dir), "Nadia".into(), "  ".into()).unwrap();
        assert_eq!(made.kind, DEFAULT_KIND);

        fs::remove_dir_all(&dir).unwrap();
    }
}
