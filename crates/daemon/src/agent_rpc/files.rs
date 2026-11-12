use std::{
    io::{Read, Seek, SeekFrom},
    path::{Path, PathBuf},
};

use serde_json::{Value, json};

fn resolve_base_dir(path: &str, cwd: Option<&Path>) -> Result<PathBuf, String> {
    let current_dir = std::env::current_dir()
        .map_err(|err| format!("Failed to resolve current directory: {err}"))?;
    if path.trim_start().starts_with('~') {
        Ok(dirs::home_dir().unwrap_or(current_dir))
    } else {
        Ok(cwd
            .map(Path::to_path_buf)
            .or_else(dirs::home_dir)
            .unwrap_or(current_dir))
    }
}

pub(super) fn complete_directories(
    input: &str,
    cwd: Option<&Path>,
    limit: usize,
) -> Result<Value, String> {
    let input = input.trim();
    let base_dir = resolve_base_dir(input, cwd)?;
    let path = resolve_directory_path(input, &base_dir);
    let is_directory = path.is_dir();
    let (directory, prefix) = if is_directory {
        (path.clone(), String::new())
    } else {
        let directory = path
            .parent()
            .filter(|path| !path.as_os_str().is_empty())
            .unwrap_or(&base_dir)
            .to_path_buf();
        let prefix = path
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_default();
        (directory, prefix)
    };

    let prefix = prefix.to_lowercase();
    let mut directories = std::fs::read_dir(&directory)
        .map_err(|err| format!("Failed to read {}: {err}", directory.display()))?
        .filter_map(|entry| entry.ok())
        .filter(|entry| entry.path().is_dir())
        .filter(|entry| {
            prefix.is_empty()
                || entry
                    .file_name()
                    .to_string_lossy()
                    .to_lowercase()
                    .starts_with(&prefix)
        })
        .map(|entry| entry.path().to_string_lossy().into_owned())
        .collect::<Vec<_>>();

    directories.sort_by_key(|path| path.to_lowercase());
    directories.truncate(limit);

    Ok(json!({
        "value": path.to_string_lossy(),
        "isDirectory": is_directory,
        "directories": directories,
    }))
}

pub(super) fn browse_files(
    path: &str,
    cwd: Option<&Path>,
    filter_type: Option<&str>,
    limit: usize,
) -> Result<Value, String> {
    let base_dir = resolve_base_dir(path, cwd)?;
    let target = resolve_directory_path(path.trim(), &base_dir);
    if !target.is_dir() {
        return Err(format!("{} is not a directory", target.display()));
    }

    let filter_dirs = !matches!(filter_type, Some("file" | "files"));
    let filter_files = !matches!(filter_type, Some("directory" | "directories" | "dir"));

    struct Entry {
        name: String,
        path: String,
        is_directory: bool,
    }

    let mut entries = Vec::new();
    let read_entries = std::fs::read_dir(&target)
        .map_err(|err| format!("Failed to read {}: {err}", target.display()))?;

    for entry in read_entries.filter_map(|entry| entry.ok()) {
        let entry_path = entry.path();
        let is_dir = entry_path.is_dir();
        if is_dir && !filter_dirs {
            continue;
        }
        if !is_dir && !filter_files {
            continue;
        }
        let name = entry.file_name().to_string_lossy().into_owned();
        let path_str = entry_path.to_string_lossy().into_owned();
        entries.push(Entry {
            name,
            path: path_str,
            is_directory: is_dir,
        });
    }

    entries.sort_by(|a, b| {
        let dir_order = (!a.is_directory).cmp(&(!b.is_directory));
        if dir_order != std::cmp::Ordering::Equal {
            return dir_order;
        }
        let a_dot = a.name.starts_with('.');
        let b_dot = b.name.starts_with('.');
        if a_dot != b_dot {
            return a_dot.cmp(&b_dot);
        }
        a.name.to_lowercase().cmp(&b.name.to_lowercase())
    });
    entries.truncate(limit);

    let home = dirs::home_dir().map(|h| h.to_string_lossy().into_owned());
    let entries_json = entries
        .into_iter()
        .map(|e| {
            json!({
                "name": e.name,
                "path": e.path,
                "isDirectory": e.is_directory,
            })
        })
        .collect::<Vec<_>>();

    Ok(json!({
        "path": target.to_string_lossy(),
        "home": home,
        "entries": entries_json,
    }))
}

const FILE_READ_MAX_BYTES: u64 = 8 * 1024 * 1024;
/// A regular file under the size limit, or an error naming why it can't be read.
fn resolve_file(path: &str, cwd: Option<&Path>, len_limit: bool) -> Result<(PathBuf, u64), String> {
    let base_dir = resolve_base_dir(path, cwd)?;
    let resolved = resolve_directory_path(path.trim(), &base_dir);
    let metadata = std::fs::metadata(&resolved)
        .map_err(|err| format!("Failed to read {}: {err}", resolved.display()))?;
    if metadata.is_dir() {
        return Err(format!("{} is a directory", resolved.display()));
    }
    if len_limit && metadata.len() > FILE_READ_MAX_BYTES {
        return Err(format!(
            "{} is too large ({} bytes, limit is {FILE_READ_MAX_BYTES})",
            resolved.display(),
            metadata.len()
        ));
    }
    Ok((resolved, metadata.len()))
}

/// Any file's bytes for clients serving files verbatim, like the App's preview
/// protocol. `range` (offset, length) reads one slice, so large media can be
/// streamed by HTTP Range requests; the result carries the full `size`.
pub(super) fn read_raw_file(
    path: &str,
    cwd: Option<&Path>,
    range: Option<(u64, u64)>,
) -> Result<(Value, Option<Vec<u8>>), String> {
    let (resolved, size) = resolve_file(path, cwd, range.is_none())?;
    let read_err = |err: std::io::Error| format!("Failed to read {}: {err}", resolved.display());
    let bytes = match range {
        None => std::fs::read(&resolved).map_err(read_err)?,
        Some((_, length)) if length > FILE_READ_MAX_BYTES => {
            return Err(format!(
                "Range of {length} bytes is too large (limit is {FILE_READ_MAX_BYTES})"
            ));
        }
        Some((offset, length)) => {
            let mut file = std::fs::File::open(&resolved).map_err(read_err)?;
            file.seek(SeekFrom::Start(offset)).map_err(read_err)?;
            let mut bytes = Vec::new();
            file.take(length)
                .read_to_end(&mut bytes)
                .map_err(read_err)?;
            bytes
        }
    };
    let path = resolved.to_string_lossy();
    Ok((
        json!({ "path": path, "type": "binary", "size": size }),
        Some(bytes),
    ))
}

/// Images return their bytes next to the result; other files are text.
pub(super) fn read_remote_file(
    path: &str,
    cwd: Option<&Path>,
) -> Result<(Value, Option<Vec<u8>>), String> {
    let (resolved, _) = resolve_file(path, cwd, true)?;
    let bytes = std::fs::read(&resolved)
        .map_err(|err| format!("Failed to read {}: {err}", resolved.display()))?;
    let path = resolved.to_string_lossy().into_owned();
    let mime_type = mime_from_extension(&resolved);
    match mime_type {
        Some(mime_type) => Ok((
            json!({ "path": path, "type": "image", "mimeType": mime_type }),
            Some(bytes),
        )),
        // Text files are rejected if they contain a NUL byte within the first
        // 8 KB, a cheap heuristic against serving binary blobs as text.
        None if bytes.contains(&0) => {
            Err(format!("Unsupported binary file: {}", resolved.display()))
        }
        None => Ok((
            json!({
                "path": path,
                "type": "text",
                "text": String::from_utf8_lossy(&bytes),
            }),
            None,
        )),
    }
}

fn mime_from_extension(path: &Path) -> Option<&'static str> {
    let extension = path.extension()?.to_string_lossy().to_lowercase();
    match extension.as_str() {
        "png" => Some("image/png"),
        "jpg" | "jpeg" => Some("image/jpeg"),
        "gif" => Some("image/gif"),
        "webp" => Some("image/webp"),
        "svg" => Some("image/svg+xml"),
        "bmp" => Some("image/bmp"),
        "ico" => Some("image/x-icon"),
        _ => None,
    }
}

fn resolve_directory_path(input: &str, base_dir: &Path) -> PathBuf {
    if input.is_empty() || input == "~" {
        base_dir.to_path_buf()
    } else if let Some(relative) = input
        .strip_prefix("~/")
        .or_else(|| input.strip_prefix("~\\"))
    {
        base_dir.join(relative)
    } else {
        let path = PathBuf::from(input);
        if path.is_absolute() {
            path
        } else {
            base_dir.join(path)
        }
    }
}

#[cfg(test)]
mod tests {
    use std::time::{SystemTime, UNIX_EPOCH};

    use super::*;

    #[test]
    fn completes_and_validates_directories() {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock should be after unix epoch")
            .as_nanos();
        let root = std::env::temp_dir().join(format!("agentdeck-cwd-{unique}"));
        let alpha = root.join("alpha");
        let alpine = root.join("alpine");
        std::fs::create_dir_all(&alpha).expect("create alpha directory");
        std::fs::create_dir_all(&alpine).expect("create alpine directory");
        let note = alpha.join("note.txt");
        std::fs::write(&note, b"hello").expect("write note file");

        let prefix = root.join("al").to_string_lossy().into_owned();
        let completion =
            complete_directories(&prefix, None, 100).expect("complete directory prefix");
        let exact = complete_directories(&alpha.to_string_lossy(), None, 100)
            .expect("validate exact directory");

        let rel_completion =
            complete_directories("al", Some(&root), 100).expect("complete relative prefix");
        assert_eq!(rel_completion["isDirectory"], false);
        assert_eq!(
            rel_completion["directories"].as_array().map(Vec::len),
            Some(2)
        );

        assert_eq!(completion["isDirectory"], false);
        assert_eq!(completion["directories"].as_array().map(Vec::len), Some(2));
        assert!(completion.get("files").is_none());
        assert_eq!(exact["isDirectory"], true);
        assert!(exact.get("files").is_none());

        let browsed =
            browse_files(&alpha.to_string_lossy(), None, None, 100).expect("browse directory");
        assert_eq!(browsed["path"], alpha.to_string_lossy().as_ref());
        assert!(browsed["home"].is_string());
        let entries = browsed["entries"].as_array().expect("entries array");
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0]["name"], "note.txt");
        assert_eq!(entries[0]["isDirectory"], false);

        let dirs_only = browse_files(&root.to_string_lossy(), None, Some("directory"), 100)
            .expect("browse directories only");
        let dir_entries = dirs_only["entries"].as_array().expect("dir entries array");
        assert_eq!(dir_entries.len(), 2);
        assert!(dir_entries.iter().all(|e| e["isDirectory"] == true));

        let files_only = browse_files(&root.to_string_lossy(), None, Some("file"), 100)
            .expect("browse files only");
        let file_entries = files_only["entries"]
            .as_array()
            .expect("file entries array");
        assert_eq!(file_entries.len(), 0);

        std::fs::remove_dir_all(&root).expect("remove test directory");
    }

    #[test]
    fn expands_home_directory_shorthand() {
        let home = PathBuf::from("home").join("user");

        assert_eq!(resolve_directory_path("~", &home), home);
        assert_eq!(resolve_directory_path("~/test", &home), home.join("test"));
        assert_eq!(resolve_directory_path("~\\test", &home), home.join("test"));
    }

    #[test]
    fn reads_text_and_image_files() {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock should be after unix epoch")
            .as_nanos();
        let root = std::env::temp_dir().join(format!("agentdeck-file-{unique}"));
        std::fs::create_dir_all(&root).expect("create test directory");
        let text_path = root.join("note.txt");
        std::fs::write(&text_path, b"hello").expect("write text file");
        let png_path = root.join("pixel.png");
        std::fs::write(&png_path, [0x89, b'P', b'N', b'G', 0, 0, 0, 0]).expect("write png file");
        let binary_path = root.join("blob.bin");
        std::fs::write(&binary_path, [0x00, 0x01, 0x02]).expect("write binary file");

        let (text, text_bytes) =
            read_remote_file(&text_path.to_string_lossy(), None).expect("read text file");
        let (image, image_bytes) =
            read_remote_file(&png_path.to_string_lossy(), None).expect("read image file");
        let err =
            read_remote_file(&binary_path.to_string_lossy(), None).expect_err("reject binary file");
        let (raw, raw_bytes) = read_raw_file(&binary_path.to_string_lossy(), None, None)
            .expect("read raw binary file");
        let (slice, slice_bytes) =
            read_raw_file(&binary_path.to_string_lossy(), None, Some((1, 5)))
                .expect("read raw binary range");
        let missing = read_remote_file(&root.join("missing.txt").to_string_lossy(), None)
            .expect_err("reject missing file");
        std::fs::remove_dir_all(&root).expect("remove test directory");

        assert_eq!(text["type"], "text");
        assert_eq!(text["text"], "hello");
        assert!(text_bytes.is_none());
        assert_eq!(image["type"], "image");
        assert_eq!(image["mimeType"], "image/png");
        assert_eq!(image_bytes.unwrap()[..4], [0x89, b'P', b'N', b'G']);
        assert!(err.contains("Unsupported binary file"));
        assert_eq!(raw["type"], "binary");
        assert!(raw.get("data").is_none());
        assert_eq!(raw_bytes.unwrap(), [0x00, 0x01, 0x02]);
        assert_eq!(slice["size"], 3);
        assert_eq!(slice_bytes.unwrap(), [0x01, 0x02]);
        assert!(missing.contains("Failed to read"));
    }

    #[test]
    fn resolves_relative_path_against_cwd() {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock should be after unix epoch")
            .as_nanos();
        let root = std::env::temp_dir().join(format!("agentdeck-cwd-file-{unique}"));
        std::fs::create_dir_all(&root).expect("create test directory");
        std::fs::write(root.join("note.md"), b"# hi").expect("write file");

        let (file, _) = read_remote_file("note.md", Some(&root)).expect("read relative file");
        std::fs::remove_dir_all(&root).expect("remove test directory");

        assert_eq!(file["type"], "text");
        assert_eq!(file["text"], "# hi");
        assert!(file["path"].as_str().unwrap().ends_with("note.md"));
    }
}
