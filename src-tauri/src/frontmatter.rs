//! A deliberately small frontmatter format, and the only parser for it.
//!
//! ```text
//! ---
//! id: en-nadia-okonkwo
//! name: Nadia Okonkwo
//! type: character
//! aliases:
//!   - Nadia
//! ---
//!
//! Runs the desk at the Sundowner.
//! ```
//!
//! It looks like YAML so editors colour it, but it is a fixed subset with no
//! quoting, escapes or nesting: `key: value` lines, and lists of `- item`
//! lines under a bare key. That is enough for what an entity is, and it keeps
//! the Rust side free of a parser dependency for a format this project has to
//! be able to read in ten years.
//!
//! Two properties matter more than features. A file with no frontmatter at all
//! is still readable — it is simply all body, which is what a hand-dropped note
//! should be. And keys this build does not recognise are kept and written back
//! untouched, so a newer version's fields survive a round trip through an older
//! one rather than being silently dropped.

const FENCE: &str = "---";

#[derive(Clone, Debug, PartialEq)]
pub enum Value {
    Text(String),
    List(Vec<String>),
}

#[derive(Clone, Debug, PartialEq)]
pub struct Field {
    pub key: String,
    pub value: Value,
}

/// Frontmatter fields in the order they were written, and everything after.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Document {
    pub fields: Vec<Field>,
    pub body: String,
}

impl Document {
    pub fn parse(raw: &str) -> Document {
        let raw = raw.strip_prefix('\u{feff}').unwrap_or(raw);

        let Some(rest) = strip_fence(raw) else {
            return Document {
                fields: Vec::new(),
                body: raw.trim_start_matches('\n').to_string(),
            };
        };

        let mut fields: Vec<Field> = Vec::new();
        let mut lines = rest.lines();
        let mut body = String::new();

        for line in lines.by_ref() {
            if line.trim_end() == FENCE {
                body = lines.collect::<Vec<_>>().join("\n");
                break;
            }

            let trimmed = line.trim();
            if trimmed.is_empty() {
                continue;
            }

            // A list item belongs to the key above it. One with nothing above
            // is not something this format can express, so it is dropped rather
            // than guessed at.
            if let Some(item) = trimmed.strip_prefix("- ") {
                if let Some(Field { value, .. }) = fields.last_mut() {
                    match value {
                        Value::List(items) => items.push(item.trim().to_string()),
                        Value::Text(text) if text.is_empty() => {
                            *value = Value::List(vec![item.trim().to_string()]);
                        }
                        Value::Text(_) => {}
                    }
                }
                continue;
            }

            // Split on the first colon only, so a value may contain more.
            if let Some((key, value)) = trimmed.split_once(':') {
                fields.push(Field {
                    key: key.trim().to_string(),
                    value: Value::Text(value.trim().to_string()),
                });
            }
        }

        let mut body = body.trim_start_matches('\n').to_string();

        // `lines` drops the final newline. Putting it back keeps the body a
        // faithful copy of the rest of the file rather than one character short
        // of it.
        if !body.is_empty() && !body.ends_with('\n') {
            body.push('\n');
        }

        Document { fields, body }
    }

    pub fn text(&self, key: &str) -> Option<&str> {
        match self.field(key)? {
            Value::Text(text) if !text.is_empty() => Some(text),
            _ => None,
        }
    }

    pub fn list(&self, key: &str) -> Vec<String> {
        match self.field(key) {
            Some(Value::List(items)) => items.clone(),
            // A single value where a list is expected is a list of one, which
            // is what someone writing `aliases: Nadia` by hand clearly meant.
            Some(Value::Text(text)) if !text.is_empty() => vec![text.clone()],
            _ => Vec::new(),
        }
    }

    fn field(&self, key: &str) -> Option<&Value> {
        self.fields
            .iter()
            .find(|field| field.key == key)
            .map(|field| &field.value)
    }

    /// Set a key, keeping its position if it is already there so that a file
    /// someone has arranged by hand stays arranged.
    pub fn set(&mut self, key: &str, value: Value) {
        match self.fields.iter_mut().find(|field| field.key == key) {
            Some(field) => field.value = value,
            None => self.fields.push(Field {
                key: key.to_string(),
                value,
            }),
        }
    }

    pub fn remove(&mut self, key: &str) {
        self.fields.retain(|field| field.key != key);
    }

    /// Render back to a file. Frontmatter is omitted entirely when there are no
    /// fields, so a plain note stays a plain note.
    pub fn render(&self) -> String {
        let mut out = String::new();

        if !self.fields.is_empty() {
            out.push_str(FENCE);
            out.push('\n');

            for Field { key, value } in &self.fields {
                match value {
                    Value::Text(text) => {
                        out.push_str(key);
                        out.push_str(": ");
                        out.push_str(text);
                        out.push('\n');
                    }
                    Value::List(items) => {
                        out.push_str(key);
                        out.push_str(":\n");
                        for item in items {
                            out.push_str("  - ");
                            out.push_str(item);
                            out.push('\n');
                        }
                    }
                }
            }

            out.push_str(FENCE);
            out.push_str("\n\n");
        }

        out.push_str(self.body.trim_end());
        out.push('\n');
        out
    }
}

/// A `## Heading` in the body and the prose under it.
#[derive(Clone, Debug, PartialEq)]
pub struct Section {
    pub heading: String,
    pub text: String,
}

/// Split a body into what comes before the first heading, and the sections.
///
/// Short facts belong in frontmatter, but a paragraph on one unwrapped line is
/// unpleasant in any text editor — which is the folder's whole promise — so
/// anything longer lives under a heading instead. Headings this build knows
/// nothing about are still returned, so they survive being rewritten.
pub fn split_body(body: &str) -> (String, Vec<Section>) {
    let mut preamble = String::new();
    let mut sections: Vec<Section> = Vec::new();

    for line in body.lines() {
        match line.strip_prefix("## ") {
            Some(heading) => sections.push(Section {
                heading: heading.trim().to_string(),
                text: String::new(),
            }),
            None => {
                let target = match sections.last_mut() {
                    Some(section) => &mut section.text,
                    None => &mut preamble,
                };
                target.push_str(line);
                target.push('\n');
            }
        }
    }

    let tidy = |text: &str| {
        let trimmed = text.trim();
        if trimmed.is_empty() {
            String::new()
        } else {
            format!("{trimmed}\n")
        }
    };

    let sections = sections
        .into_iter()
        .map(|section| Section {
            heading: section.heading,
            text: tidy(&section.text),
        })
        .collect();

    (tidy(&preamble), sections)
}

/// The inverse, with one blank line between everything.
pub fn join_body(preamble: &str, sections: &[Section]) -> String {
    let mut out = String::new();

    if !preamble.trim().is_empty() {
        out.push_str(preamble.trim());
        out.push('\n');
    }

    for section in sections {
        // A heading with nothing under it is noise in a file meant to be read.
        if section.text.trim().is_empty() {
            continue;
        }

        if !out.is_empty() {
            out.push('\n');
        }

        out.push_str("## ");
        out.push_str(section.heading.trim());
        out.push_str("\n\n");
        out.push_str(section.text.trim());
        out.push('\n');
    }

    out
}

/// The text after an opening fence, or None if the file does not start with one.
fn strip_fence(raw: &str) -> Option<&str> {
    let rest = raw.strip_prefix(FENCE)?;

    match rest.strip_prefix('\n') {
        Some(rest) => Some(rest),
        // Tolerates a stray carriage return from a file written on Windows.
        None => rest.strip_prefix("\r\n"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const NADIA: &str = "---\nid: en-nadia\nname: Nadia Okonkwo\ntype: character\naliases:\n  - Nadia\n  - Ms Okonkwo\n---\n\nRuns the desk at the Sundowner.\n";

    #[test]
    fn reads_values_and_lists() {
        let doc = Document::parse(NADIA);

        assert_eq!(doc.text("name"), Some("Nadia Okonkwo"));
        assert_eq!(doc.text("type"), Some("character"));
        assert_eq!(doc.list("aliases"), ["Nadia", "Ms Okonkwo"]);
        assert_eq!(doc.body, "Runs the desk at the Sundowner.\n");
    }

    #[test]
    fn round_trips_unchanged() {
        // The property that matters most: reading and writing a file nobody
        // edited must not rewrite it.
        assert_eq!(Document::parse(NADIA).render(), NADIA);
    }

    #[test]
    fn keeps_fields_it_does_not_understand() {
        let raw = "---\nname: Nadia\nmood: unreadable\ntags:\n  - staff\n---\n\nBody.\n";
        let mut doc = Document::parse(raw);
        doc.set("name", Value::Text("Nadia Okonkwo".into()));

        // A field a newer version added has to survive an older one saving.
        let out = doc.render();
        assert!(out.contains("mood: unreadable"));
        assert!(out.contains("  - staff"));
        assert!(out.contains("name: Nadia Okonkwo"));
    }

    #[test]
    fn setting_a_field_keeps_its_place() {
        let doc = Document::parse(NADIA);
        let mut edited = doc.clone();
        edited.set("name", Value::Text("Nadia O.".into()));

        let keys: Vec<&str> = edited.fields.iter().map(|f| f.key.as_str()).collect();
        assert_eq!(keys, ["id", "name", "type", "aliases"]);

        fn nth(doc: &Document, n: usize) -> &str {
            doc.fields[n].key.as_str()
        }
        assert_eq!(nth(&edited, 1), "name");
    }

    #[test]
    fn a_file_with_no_frontmatter_is_all_body() {
        let doc = Document::parse("Just a note.\n\nWith two paragraphs.\n");

        assert!(doc.fields.is_empty());
        assert_eq!(doc.text("name"), None);
        assert_eq!(doc.body, "Just a note.\n\nWith two paragraphs.\n");

        // And rendering it does not invent a frontmatter block.
        assert_eq!(doc.render(), "Just a note.\n\nWith two paragraphs.\n");
    }

    #[test]
    fn values_may_contain_colons() {
        let doc = Document::parse("---\nname: Room 9: the long way round\n---\n\nBody.\n");
        assert_eq!(doc.text("name"), Some("Room 9: the long way round"));
    }

    #[test]
    fn a_lone_value_reads_as_a_list_of_one() {
        // What someone writing the file by hand would naturally type.
        let doc = Document::parse("---\naliases: Nadia\n---\n\nBody.\n");
        assert_eq!(doc.list("aliases"), ["Nadia"]);
    }

    #[test]
    fn copes_with_what_a_person_might_type() {
        let doc = Document::parse(
            "---\r\nname: Nadia\r\n\r\ntype:   character  \r\n---\r\n\r\nBody.\r\n",
        );

        assert_eq!(doc.text("name"), Some("Nadia"));
        assert_eq!(doc.text("type"), Some("character"));
    }

    #[test]
    fn an_unclosed_fence_does_not_eat_the_file() {
        let doc = Document::parse("---\nname: Nadia\n\nAnd then prose, with no closing fence.\n");

        assert_eq!(doc.text("name"), Some("Nadia"));
        // The body is lost rather than guessed at, but nothing panics and the
        // fields still read — which is what matters when a file is half-typed.
        assert_eq!(doc.body, "");
    }

    #[test]
    fn splits_a_body_into_sections() {
        let (preamble, sections) = split_body(
            "A line before any heading.\n\n## Physical traits\n\nTall, cropped hair.\n\n## Story purpose\n\nKnows what happened.\n",
        );

        assert_eq!(preamble, "A line before any heading.\n");
        assert_eq!(sections.len(), 2);
        assert_eq!(sections[0].heading, "Physical traits");
        assert_eq!(sections[0].text, "Tall, cropped hair.\n");
        assert_eq!(sections[1].heading, "Story purpose");
    }

    #[test]
    fn a_body_rebuilds_to_what_it_came_from() {
        let raw = "A line before any heading.\n\n## Physical traits\n\nTall, cropped hair.\n\n## Story purpose\n\nKnows what happened.\n";
        let (preamble, sections) = split_body(raw);

        assert_eq!(join_body(&preamble, &sections), raw);
    }

    #[test]
    fn an_empty_section_is_not_written_at_all() {
        let sections = [
            Section {
                heading: "Personality".into(),
                text: "  \n".into(),
            },
            Section {
                heading: "Story purpose".into(),
                text: "To be the one who knows.\n".into(),
            },
        ];

        let out = join_body("", &sections);
        assert!(!out.contains("Personality"));
        assert!(out.starts_with("## Story purpose"));
    }

    #[test]
    fn deeper_headings_stay_in_the_prose() {
        // Only `## ` divides a record. Anything else is the writer's own
        // markdown and has to survive untouched.
        let (preamble, sections) = split_body("## Notes\n\nA list:\n\n### Later\n\nMore.\n");

        assert_eq!(preamble, "");
        assert_eq!(sections.len(), 1);
        assert!(sections[0].text.contains("### Later"));
    }

    #[test]
    fn missing_keys_are_absent_rather_than_empty() {
        let doc = Document::parse("---\nname:\n---\n\nBody.\n");

        assert_eq!(doc.text("name"), None);
        assert_eq!(doc.list("nothing"), Vec::<String>::new());
    }
}
