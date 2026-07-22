//! Turning what someone typed into a filename.
//!
//! Titles are unicode and belong to the writer. Filenames are not: they cross
//! machines, sync clients and archive formats, and macOS normalises them behind
//! your back. So a slug is plain lowercase ASCII, and a title that produces
//! nothing usable falls back to a generic stem rather than an exotic filename.
//! The real title is in `project.json` either way.

/// The filename stem for a title: lowercase ASCII, one hyphen between runs.
pub fn slugify(title: &str) -> String {
    let mut slug = String::new();

    for ch in title.chars() {
        if ch.is_ascii_alphanumeric() {
            slug.push(ch.to_ascii_lowercase());
        } else if !slug.ends_with('-') {
            slug.push('-');
        }
    }

    let slug = slug.trim_matches('-');

    if slug.is_empty() {
        "scene".to_string()
    } else {
        // Long enough for any real title, short enough to survive the path
        // limits of every filesystem this ships to.
        slug.chars()
            .take(60)
            .collect::<String>()
            .trim_end_matches('-')
            .to_string()
    }
}

/// Windows refuses these whatever extension follows them.
const RESERVED: [&str; 22] = [
    "con", "prn", "aux", "nul", "com1", "com2", "com3", "com4", "com5", "com6", "com7", "com8",
    "com9", "lpt1", "lpt2", "lpt3", "lpt4", "lpt5", "lpt6", "lpt7", "lpt8", "lpt9",
];

/// A project folder name, or None if nothing usable is left of the title.
///
/// Not a slug. A scene file is internal plumbing, but this folder is the thing
/// someone sees in Finder or Explorer and typed the name of themselves, so
/// spaces, capitals and accents survive. Only what the filesystems actually
/// refuse comes out: the characters Windows reserves, control characters, and
/// the leading dots and trailing dots and spaces that get silently stripped.
pub fn folder_name(title: &str) -> Option<String> {
    let cleaned: String = title
        .chars()
        .map(|ch| match ch {
            '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*' => ' ',
            ch if ch.is_control() => ' ',
            ch => ch,
        })
        .collect();

    // Collapse the runs the substitutions above just created.
    let name = cleaned.split_whitespace().collect::<Vec<_>>().join(" ");
    let name = name.trim_matches('.').trim();
    let name: String = name.chars().take(80).collect();
    let name = name.trim_end_matches(['.', ' ']).trim().to_string();

    if name.is_empty() || RESERVED.contains(&name.to_ascii_lowercase().as_str()) {
        return None;
    }

    Some(name)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_folder_keeps_what_a_person_typed() {
        assert_eq!(folder_name("The county line").unwrap(), "The county line");
        assert_eq!(folder_name("Café Nocturne").unwrap(), "Café Nocturne");
    }

    #[test]
    fn a_folder_drops_what_a_filesystem_refuses() {
        assert_eq!(folder_name("Act 1: the drive").unwrap(), "Act 1 the drive");
        assert_eq!(folder_name("what/now?").unwrap(), "what now");
        assert_eq!(folder_name("  spaced  out  ").unwrap(), "spaced out");
    }

    #[test]
    fn a_folder_cannot_be_hidden_or_trailing_dotted() {
        // Windows strips these silently, which would leave the folder on disk
        // under a different name than the one that went into project.json.
        assert_eq!(folder_name(".hidden").unwrap(), "hidden");
        assert_eq!(folder_name("Chapter one...").unwrap(), "Chapter one");
    }

    #[test]
    fn a_folder_refuses_reserved_and_empty_names() {
        assert!(folder_name("   ").is_none());
        assert!(folder_name("???").is_none());
        assert!(folder_name("CON").is_none());
        assert!(folder_name("nul").is_none());
    }

    #[test]
    fn makes_a_filename_out_of_a_title() {
        assert_eq!(slugify("Six hours out"), "six-hours-out");
        assert_eq!(slugify("The Sundowner"), "the-sundowner");
    }

    #[test]
    fn collapses_and_trims_punctuation() {
        assert_eq!(slugify("  What Nadia knew!!  "), "what-nadia-knew");
        assert_eq!(slugify("Act 2 — the drive"), "act-2-the-drive");
        assert_eq!(slugify("...",), "scene");
    }

    #[test]
    fn falls_back_when_a_title_has_no_ascii() {
        // The title stays unicode in the manifest; only the filename is plain.
        assert_eq!(slugify("夜明け"), "scene");
        assert_eq!(slugify("Café"), "caf");
    }

    #[test]
    fn truncates_without_leaving_a_trailing_hyphen() {
        let long = slugify(&"word ".repeat(40));
        assert!(long.len() <= 60);
        assert!(!long.ends_with('-'));
    }
}
