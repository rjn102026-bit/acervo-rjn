use crate::ingest::{capture_directory, read_latest_manifest};
use serde::Serialize;
use std::collections::HashMap;
use std::fs::{self, File};
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use tauri::http::{header, Request, Response, StatusCode};
use uuid::Uuid;

const VIDEO_CHUNK: u64 = 2 * 1024 * 1024;
const MAX_IMAGE_SIZE: u64 = 80 * 1024 * 1024;

#[derive(Clone)]
struct PreviewEntry {
    path: PathBuf,
    originals_dir: PathBuf,
    mime: &'static str,
    kind: &'static str,
}

#[derive(Default)]
pub struct PreviewState {
    entries: Mutex<HashMap<String, PreviewEntry>>,
}

#[derive(Serialize)]
pub struct PreviewDescriptor {
    url: String,
    kind: &'static str,
}

fn supported_media(path: &Path) -> Option<(&'static str, &'static str)> {
    match path.extension()?.to_str()?.to_ascii_lowercase().as_str() {
        "jpg" | "jpeg" => Some(("image/jpeg", "image")),
        "png" => Some(("image/png", "image")),
        "mp4" | "m4v" => Some(("video/mp4", "video")),
        _ => None,
    }
}

pub fn create_preview_impl(
    state: &Arc<PreviewState>,
    destination: &str,
    workspace: &str,
    capture_id: &str,
    asset_id: &str,
) -> Result<PreviewDescriptor, String> {
    Uuid::parse_str(asset_id).map_err(|_| "ID de arquivo inválido".to_string())?;
    let capture_dir = capture_directory(destination, workspace, capture_id)?;
    let manifest = read_latest_manifest(&capture_dir)?;
    if manifest.capture_id != capture_id || manifest.workspace_id != workspace {
        return Err("Captação fora do espaço selecionado".into());
    }
    let asset = manifest.assets.iter()
        .find(|asset| asset.asset_id == asset_id && asset.status == "verified")
        .ok_or("Cópia verificada não encontrada nesta captação")?;
    let (mime, kind) = supported_media(Path::new(&asset.original_name))
        .ok_or("Prévia completa ainda não disponível para este formato; a miniatura continua visível")?;
    let originals_dir = fs::canonicalize(capture_dir.join("originals")).map_err(|e| e.to_string())?;
    let path = fs::canonicalize(capture_dir.join(&asset.copy_relative_path)).map_err(|e| e.to_string())?;
    if !path.starts_with(&originals_dir) || !path.is_file() {
        return Err("Arquivo fora da área de cópias verificadas".into());
    }
    let size = fs::metadata(&path).map_err(|e| e.to_string())?.len();
    if size == 0 || (kind == "image" && size > MAX_IMAGE_SIZE) {
        return Err("Arquivo vazio ou imagem grande demais para prévia no aplicativo".into());
    }
    let token = Uuid::new_v4().to_string();
    let mut entries = state.entries.lock().map_err(|_| "Prévia indisponível".to_string())?;
    if entries.len() >= 32 {
        entries.clear();
    }
    entries.insert(token.clone(), PreviewEntry { path, originals_dir, mime, kind });
    let url = if cfg!(windows) {
        format!("http://lumen-media.localhost/{token}")
    } else {
        format!("lumen-media://localhost/{token}")
    };
    Ok(PreviewDescriptor { url, kind })
}

fn error_response(status: StatusCode) -> Response<Vec<u8>> {
    Response::builder().status(status).body(Vec::new()).expect("resposta HTTP válida")
}

fn parse_range(value: &str, len: u64) -> Option<(u64, u64)> {
    let range = value.strip_prefix("bytes=")?;
    if range.contains(',') { return None; }
    let (start, end) = range.split_once('-')?;
    if start.is_empty() {
        let suffix = end.parse::<u64>().ok()?;
        if suffix == 0 { return None; }
        return Some((len.saturating_sub(suffix), len - 1));
    }
    let start = start.parse::<u64>().ok()?;
    if start >= len { return None; }
    let end = if end.is_empty() { len - 1 } else { end.parse::<u64>().ok()?.min(len - 1) };
    if end < start { return None; }
    Some((start, end))
}

fn serve_entry(entry: &PreviewEntry, range: Option<&str>) -> Response<Vec<u8>> {
    let current = match fs::canonicalize(&entry.path) {
        Ok(path) if path.starts_with(&entry.originals_dir) && path.is_file() => path,
        _ => return error_response(StatusCode::NOT_FOUND),
    };
    let mut file = match File::open(current) { Ok(file) => file, Err(_) => return error_response(StatusCode::NOT_FOUND) };
    let len = match file.metadata() { Ok(meta) if meta.len() > 0 => meta.len(), _ => return error_response(StatusCode::NOT_FOUND) };
    let (start, end, partial) = if entry.kind == "image" {
        if len > MAX_IMAGE_SIZE { return error_response(StatusCode::PAYLOAD_TOO_LARGE); }
        (0, len - 1, false)
    } else if let Some(value) = range {
        match parse_range(value, len) {
            Some((start, requested_end)) => (start, requested_end.min(start.saturating_add(VIDEO_CHUNK - 1)), true),
            None => return Response::builder().status(StatusCode::RANGE_NOT_SATISFIABLE)
                .header(header::CONTENT_RANGE, format!("bytes */{len}"))
                .body(Vec::new()).expect("resposta HTTP válida"),
        }
    } else {
        (0, (len - 1).min(VIDEO_CHUNK - 1), len > VIDEO_CHUNK)
    };
    let count = (end - start + 1) as usize;
    if file.seek(SeekFrom::Start(start)).is_err() { return error_response(StatusCode::INTERNAL_SERVER_ERROR); }
    let mut bytes = vec![0; count];
    if file.read_exact(&mut bytes).is_err() { return error_response(StatusCode::INTERNAL_SERVER_ERROR); }
    let mut response = Response::builder()
        .status(if partial { StatusCode::PARTIAL_CONTENT } else { StatusCode::OK })
        .header(header::CONTENT_TYPE, entry.mime)
        .header(header::CONTENT_LENGTH, count.to_string())
        .header(header::ACCEPT_RANGES, "bytes")
        .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*");
    if partial {
        response = response.header(header::CONTENT_RANGE, format!("bytes {start}-{end}/{len}"));
    }
    response.body(bytes).expect("resposta HTTP válida")
}

pub fn respond(state: &Arc<PreviewState>, request: Request<Vec<u8>>) -> Response<Vec<u8>> {
    let token = request.uri().path().trim_start_matches('/');
    if Uuid::parse_str(token).is_err() { return error_response(StatusCode::NOT_FOUND); }
    let entry = match state.entries.lock() {
        Ok(entries) => entries.get(token).cloned(),
        Err(_) => None,
    };
    let Some(entry) = entry else { return error_response(StatusCode::NOT_FOUND); };
    let range = request.headers().get(header::RANGE).and_then(|value| value.to_str().ok());
    serve_entry(&entry, range)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ingest::ingest_capture_impl;

    #[test]
    fn serves_bounded_video_ranges_and_rejects_unknown_tokens() {
        let root = std::env::temp_dir().join(format!("lumen-preview-test-{}", Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let file = root.join("test.mp4");
        fs::write(&file, b"abcdefghij").unwrap();
        let entry = PreviewEntry { path: file, originals_dir: fs::canonicalize(&root).unwrap(), mime: "video/mp4", kind: "video" };
        let response = serve_entry(&entry, Some("bytes=2-5"));
        assert_eq!(response.status(), StatusCode::PARTIAL_CONTENT);
        assert_eq!(response.body(), b"cdef");
        assert_eq!(response.headers()[header::CONTENT_RANGE], "bytes 2-5/10");
        assert_eq!(serve_entry(&entry, Some("bytes=20-")).status(), StatusCode::RANGE_NOT_SATISFIABLE);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn preview_token_only_opens_a_verified_copy_in_its_workspace() {
        let root = std::env::temp_dir().join(format!("lumen-preview-access-test-{}", Uuid::new_v4()));
        let source = root.join("card");
        let destination = root.join("archive");
        fs::create_dir_all(&source).unwrap();
        fs::create_dir_all(&destination).unwrap();
        fs::write(source.join("C001.MP4"), b"sample video bytes").unwrap();
        let capture = ingest_capture_impl(source.to_str().unwrap(), destination.to_str().unwrap(), "personal", "Teste", "", vec![], None).unwrap();
        let asset_id = &capture.assets[0].asset_id;
        let state = Arc::new(PreviewState::default());
        assert!(create_preview_impl(&state, destination.to_str().unwrap(), "other", &capture.capture_id, asset_id).is_err());
        let preview = create_preview_impl(&state, destination.to_str().unwrap(), "personal", &capture.capture_id, asset_id).unwrap();
        let request = Request::builder().uri(preview.url).header(header::RANGE, "bytes=0-5").body(Vec::new()).unwrap();
        let response = respond(&state, request);
        assert_eq!(response.status(), StatusCode::PARTIAL_CONTENT);
        assert_eq!(response.body(), b"sample");
        assert_eq!(fs::read(source.join("C001.MP4")).unwrap(), b"sample video bytes");
        fs::remove_dir_all(root).unwrap();
    }
}
