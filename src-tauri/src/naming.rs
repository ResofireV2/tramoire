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

#[cfg(test)]
mod tests {
    use super::*;

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
