use crate::media::{self, MediaMetadata};
use base64::{engine::general_purpose::STANDARD, Engine as _};
use chrono::Utc;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use uuid::Uuid;
use walkdir::WalkDir;

pub(crate) const EXTENSIONS: &[&str] = &[
    "mp4", "mov", "mxf", "avi", "mts", "m2ts", "mpg", "mpeg", "jpg", "jpeg", "png", "tif", "tiff",
    "dng", "heic", "cr2", "nef", "srt", "gpx", "kml", "csv",
];

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Asset {
    pub(crate) asset_id: String,
    pub(crate) original_name: String,
    pub(crate) original_relative_path: String,
    pub(crate) copy_relative_path: String,
    pub(crate) status: String,
    size_bytes: Option<u64>,
    pub(crate) sha256: Option<String>,
    error: Option<String>,
    #[serde(default)]
    pub(crate) metadata: Option<MediaMetadata>,
    #[serde(default)]
    thumbnail_relative_path: Option<String>,
    #[serde(default)]
    processing_error: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Manifest {
    schema_version: u8,
    pub(crate) capture_id: String,
    pub(crate) workspace_id: String,
    pub(crate) capture_name: String,
    #[serde(default)]
    pub(crate) brief: String,
    #[serde(default)]
    pub(crate) visited_locations: Vec<String>,
    created_at: String,
    source_path: String,
    pub(crate) assets: Vec<Asset>,
    verified_count: usize,
    failed_count: usize,
    warning: String,
    manifest_path: String,
}

fn validate_workspace(value: &str) -> Result<(), String> {
    if value.is_empty()
        || value.len() > 64
        || !value
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
        return Err("O espaço deve conter 1–64 letras, números, hífen ou sublinhado.".into());
    }
    Ok(())
}

fn sha256_file(path: &Path) -> Result<String, String> {
    let mut reader = File::open(path).map_err(|e| e.to_string())?;
    let mut hash = Sha256::new();
    let mut buffer = vec![0u8; 1024 * 1024];
    loop {
        let count = reader.read(&mut buffer).map_err(|e| e.to_string())?;
        if count == 0 {
            break;
        }
        hash.update(&buffer[..count]);
    }
    Ok(format!("{:x}", hash.finalize()))
}

fn copy_verified(
    source: &Path,
    partial: &Path,
    final_path: &Path,
) -> Result<(u64, String), String> {
    let source_size = fs::metadata(source).map_err(|e| e.to_string())?.len();
    let mut reader = File::open(source).map_err(|e| e.to_string())?;
    let mut writer = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(partial)
        .map_err(|e| e.to_string())?;
    let mut hash = Sha256::new();
    let mut buffer = vec![0u8; 1024 * 1024];
    loop {
        let count = reader.read(&mut buffer).map_err(|e| e.to_string())?;
        if count == 0 {
            break;
        }
        writer
            .write_all(&buffer[..count])
            .map_err(|e| e.to_string())?;
        hash.update(&buffer[..count]);
    }
    writer.sync_all().map_err(|e| e.to_string())?;
    drop(writer);
    if fs::metadata(source).map_err(|e| e.to_string())?.len() != source_size
        || fs::metadata(partial).map_err(|e| e.to_string())?.len() != source_size
    {
        return Err("Tamanho mudou durante a cópia".into());
    }
    let digest = format!("{:x}", hash.finalize());
    if sha256_file(source)? != digest {
        return Err("A origem mudou durante a cópia".into());
    }
    if sha256_file(partial)? != digest {
        return Err("Hash da cópia não confere".into());
    }
    fs::rename(partial, final_path).map_err(|e| e.to_string())?;
    Ok((source_size, digest))
}

pub fn ingest_capture_impl(
    source: &str,
    destination: &str,
    workspace: &str,
    capture_name: &str,
    brief: &str,
    visited_locations: Vec<String>,
    tools_directory: Option<&str>,
) -> Result<Manifest, String> {
    validate_workspace(workspace)?;
    if capture_name.trim().is_empty() {
        return Err("Informe o nome da captação.".into());
    }
    if brief.len() > 10_000 {
        return Err("A pauta deve ter até 10 mil caracteres.".into());
    }
    if visited_locations.len() > 30
        || visited_locations
            .iter()
            .any(|location| location.trim().is_empty() || location.len() > 120)
    {
        return Err("Informe até 30 locais, com no máximo 120 caracteres cada.".into());
    }
    let visited_locations: Vec<String> = visited_locations
        .into_iter()
        .map(|location| location.trim().to_string())
        .collect();
    let source_path = fs::canonicalize(source).map_err(|e| format!("Origem indisponível: {e}"))?;
    let destination_path = fs::canonicalize(destination)
        .map_err(|e| format!("Destino indisponível: {e}. Crie a pasta antes de iniciar."))?;
    if !source_path.is_dir() || !destination_path.is_dir() {
        return Err("Origem e destino devem ser pastas existentes.".into());
    }
    if source_path.starts_with(&destination_path) || destination_path.starts_with(&source_path) {
        return Err(
            "Origem e destino precisam ser pastas separadas, sem uma dentro da outra.".into(),
        );
    }

    let mut files: Vec<PathBuf> = Vec::new();
    for entry in WalkDir::new(&source_path).follow_links(false) {
        let entry = entry
            .map_err(|error| format!("Não foi possível inventariar toda a origem: {error}"))?;
        if !entry.file_type().is_file() {
            continue;
        }
        let path = entry.into_path();
        let supported = path
            .extension()
            .and_then(|e| e.to_str())
            .map(|e| EXTENSIONS.contains(&e.to_ascii_lowercase().as_str()))
            .unwrap_or(false);
        if supported {
            files.push(path);
        }
    }
    files.sort();
    if files.is_empty() {
        return Err("Nenhuma mídia suportada encontrada na origem.".into());
    }

    let capture_id = Uuid::new_v4().to_string();
    let capture_dir = destination_path
        .join("workspaces")
        .join(workspace)
        .join("captures")
        .join(&capture_id);
    let originals_dir = capture_dir.join("originals");
    fs::create_dir_all(&originals_dir)
        .map_err(|e| format!("Não foi possível criar destino: {e}"))?;
    let mut assets = Vec::new();
    for path in files {
        let asset_id = Uuid::new_v4().to_string();
        let extension = path
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("")
            .to_ascii_lowercase();
        let copied = originals_dir.join(format!("{asset_id}.{extension}"));
        let partial = originals_dir.join(format!("{asset_id}.partial"));
        let mut asset = Asset {
            asset_id,
            original_name: path
                .file_name()
                .unwrap_or_default()
                .to_string_lossy()
                .to_string(),
            original_relative_path: path
                .strip_prefix(&source_path)
                .unwrap_or(&path)
                .to_string_lossy()
                .to_string(),
            copy_relative_path: copied
                .strip_prefix(&capture_dir)
                .unwrap_or(&copied)
                .to_string_lossy()
                .to_string(),
            status: "failed".into(),
            size_bytes: None,
            sha256: None,
            error: None,
            metadata: None,
            thumbnail_relative_path: None,
            processing_error: None,
        };
        match copy_verified(&path, &partial, &copied) {
            Ok((size, digest)) => {
                asset.status = "verified".into();
                asset.size_bytes = Some(size);
                asset.sha256 = Some(digest);
                let kind = media::kind_for(&copied);
                if kind != "sidecar" {
                    let mut errors = Vec::new();
                    match media::probe(&copied, kind, tools_directory) {
                        Ok(metadata) => asset.metadata = Some(metadata),
                        Err(error) => errors.push(error),
                    }
                    match media::make_thumbnail(
                        &copied,
                        &capture_dir.join("thumbnails"),
                        &asset.asset_id,
                        tools_directory,
                    ) {
                        Ok(relative_path) => asset.thumbnail_relative_path = Some(relative_path),
                        Err(error) => errors.push(error),
                    }
                    if !errors.is_empty() {
                        asset.processing_error = Some(errors.join("; "));
                    }
                }
            }
            Err(error) => {
                let _ = fs::remove_file(&partial);
                asset.error = Some(error);
            }
        }
        assets.push(asset);
    }
    let manifest_path = capture_dir.join("manifest.json");
    let manifest = Manifest {
        schema_version: 1, capture_id, workspace_id: workspace.to_string(), capture_name: capture_name.trim().to_string(),
        brief: brief.trim().to_string(), visited_locations,
        created_at: Utc::now().to_rfc3339(), source_path: source_path.to_string_lossy().to_string(),
        verified_count: assets.iter().filter(|a| a.status == "verified").count(),
        failed_count: assets.iter().filter(|a| a.status == "failed").count(),
        assets,
        warning: "A verificação da cópia não substitui um segundo backup. Não formate o cartão apenas com base neste manifesto.".into(),
        manifest_path: manifest_path.to_string_lossy().to_string(),
    };
    let serialized = serde_json::to_vec_pretty(&manifest).map_err(|e| e.to_string())?;
    let partial_manifest = capture_dir.join("manifest.json.partial");
    let mut writer = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&partial_manifest)
        .map_err(|e| e.to_string())?;
    writer.write_all(&serialized).map_err(|e| e.to_string())?;
    writer.sync_all().map_err(|e| e.to_string())?;
    drop(writer);
    fs::rename(&partial_manifest, &manifest_path).map_err(|e| e.to_string())?;
    Ok(manifest)
}

pub fn list_captures_impl(destination: &str, workspace: &str) -> Result<Vec<Manifest>, String> {
    validate_workspace(workspace)?;
    let destination_path = fs::canonicalize(destination).map_err(|e| e.to_string())?;
    let captures_dir = destination_path
        .join("workspaces")
        .join(workspace)
        .join("captures");
    if !captures_dir.exists() {
        return Ok(Vec::new());
    }
    let mut captures = Vec::new();
    for entry in fs::read_dir(&captures_dir).map_err(|e| e.to_string())? {
        let capture_dir = entry.map_err(|e| e.to_string())?.path();
        if capture_dir.is_dir() {
            if let Ok(manifest) = read_latest_manifest(&capture_dir) {
                if manifest.workspace_id == workspace {
                    captures.push(manifest);
                }
            }
        }
    }
    captures.sort_by(|a, b| b.created_at.cmp(&a.created_at));
    Ok(captures)
}

pub(crate) fn read_latest_manifest(capture_dir: &Path) -> Result<Manifest, String> {
    let mut revisions = fs::read_dir(capture_dir)
        .map_err(|e| e.to_string())?
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| {
            path.file_name()
                .and_then(|name| name.to_str())
                .map(|name| name.starts_with("manifest-reprocess-") && name.ends_with(".json"))
                .unwrap_or(false)
        })
        .collect::<Vec<_>>();
    revisions.sort();
    revisions.reverse();
    revisions.push(capture_dir.join("manifest.json"));
    for path in revisions {
        if let Ok(bytes) = fs::read(&path) {
            if let Ok(mut manifest) = serde_json::from_slice::<Manifest>(&bytes) {
                manifest.manifest_path = path.to_string_lossy().to_string();
                return Ok(manifest);
            }
        }
    }
    Err("Nenhum manifesto válido encontrado nesta captação".into())
}

pub(crate) fn capture_directory(destination: &str, workspace: &str, capture_id: &str) -> Result<PathBuf, String> {
    validate_workspace(workspace)?;
    Uuid::parse_str(capture_id).map_err(|_| "ID de captação inválido".to_string())?;
    let destination_path = fs::canonicalize(destination).map_err(|e| e.to_string())?;
    let capture_dir = fs::canonicalize(
        destination_path.join("workspaces").join(workspace).join("captures").join(capture_id),
    )
    .map_err(|e| e.to_string())?;
    if !capture_dir.starts_with(&destination_path) {
        return Err("Captação fora do destino selecionado".into());
    }
    Ok(capture_dir)
}

pub fn reprocess_capture_impl(
    destination: &str,
    workspace: &str,
    capture_id: &str,
) -> Result<Manifest, String> {
    let capture_dir = capture_directory(destination, workspace, capture_id)?;
    let mut manifest = read_latest_manifest(&capture_dir)?;
    if manifest.workspace_id != workspace || manifest.capture_id != capture_id {
        return Err("Captação fora do espaço selecionado".into());
    }
    let originals_dir = fs::canonicalize(capture_dir.join("originals")).map_err(|e| e.to_string())?;
    let mut attempted = false;
    for asset in &mut manifest.assets {
        if asset.status != "verified" || media::kind_for(Path::new(&asset.original_name)) == "sidecar" {
            continue;
        }
        if Uuid::parse_str(&asset.asset_id).is_err() {
            asset.processing_error = Some("ID de arquivo inválido no manifesto".into());
            attempted = true;
            continue;
        }
        let expected_thumbnail = capture_dir.join("thumbnails").join(format!("{}.jpg", asset.asset_id));
        let needs_metadata = asset.metadata.as_ref().is_none_or(|value| value.metadata_version < media::METADATA_VERSION);
        if !needs_metadata && asset.thumbnail_relative_path.is_some() && expected_thumbnail.is_file() {
            continue;
        }
        attempted = true;
        let relative = Path::new(&asset.copy_relative_path);
        let valid_relative = relative.components().all(|part| matches!(part, std::path::Component::Normal(_)))
            && relative.parent() == Some(Path::new("originals"))
            && relative.file_stem().and_then(|stem| stem.to_str()) == Some(asset.asset_id.as_str());
        let copied = if valid_relative {
            fs::canonicalize(capture_dir.join(relative)).ok().filter(|path| path.starts_with(&originals_dir))
        } else {
            None
        };
        let Some(copied) = copied else {
            asset.processing_error = Some("Cópia ausente ou fora da pasta da captação".into());
            continue;
        };
        let mut errors = Vec::new();
        if needs_metadata {
            match media::probe(&copied, media::kind_for(&copied), None) {
                Ok(metadata) => asset.metadata = Some(metadata),
                Err(error) => errors.push(error),
            }
        }
        if asset.thumbnail_relative_path.is_none() || !expected_thumbnail.is_file() {
            let existing_size = fs::metadata(&expected_thumbnail).map(|meta| meta.len()).unwrap_or(0);
            if existing_size > 0 && existing_size <= 2_000_000 {
                asset.thumbnail_relative_path = Some(format!("thumbnails/{}.jpg", asset.asset_id));
            } else {
                match media::make_thumbnail(&copied, &capture_dir.join("thumbnails"), &asset.asset_id, None) {
                    Ok(path) => asset.thumbnail_relative_path = Some(path),
                    Err(error) => errors.push(error),
                }
            }
        }
        asset.processing_error = if errors.is_empty() { None } else { Some(errors.join("; ")) };
    }
    if !attempted {
        return Ok(manifest);
    }
    // Revisões imutáveis: uma falha de energia não substitui o manifesto anterior.
    let revision = format!("manifest-reprocess-{}-{}.json", Utc::now().format("%Y%m%dT%H%M%S%9fZ"), Uuid::new_v4());
    let final_path = capture_dir.join(revision);
    let partial_path = final_path.with_extension("partial");
    manifest.manifest_path = final_path.to_string_lossy().to_string();
    let serialized = serde_json::to_vec_pretty(&manifest).map_err(|e| e.to_string())?;
    let mut writer = OpenOptions::new().write(true).create_new(true).open(&partial_path).map_err(|e| e.to_string())?;
    writer.write_all(&serialized).map_err(|e| e.to_string())?;
    writer.sync_all().map_err(|e| e.to_string())?;
    drop(writer);
    fs::rename(&partial_path, &final_path).map_err(|e| e.to_string())?;
    Ok(manifest)
}

pub fn thumbnail_data_url_impl(
    destination: &str,
    workspace: &str,
    capture_id: &str,
    asset_id: &str,
) -> Result<Option<String>, String> {
    Uuid::parse_str(asset_id).map_err(|_| "ID de arquivo inválido".to_string())?;
    let capture_dir = capture_directory(destination, workspace, capture_id)?;
    let manifest = read_latest_manifest(&capture_dir)?;
    if manifest.workspace_id != workspace || manifest.capture_id != capture_id {
        return Err("Captação fora do espaço selecionado".into());
    }
    let asset = manifest
        .assets
        .iter()
        .find(|asset| asset.asset_id == asset_id)
        .ok_or("Arquivo não encontrado nesta captação")?;
    let expected = format!("thumbnails/{asset_id}.jpg");
    if asset.thumbnail_relative_path.as_deref() != Some(expected.as_str()) {
        return Ok(None);
    }
    let thumbnail = capture_dir.join(expected);
    let real_capture = fs::canonicalize(&capture_dir).map_err(|e| e.to_string())?;
    let real_thumbnail = fs::canonicalize(&thumbnail).map_err(|e| e.to_string())?;
    if !real_thumbnail.starts_with(real_capture) {
        return Err("Miniatura fora da captação".into());
    }
    let bytes = fs::read(&real_thumbnail).map_err(|e| e.to_string())?;
    if bytes.len() > 2_000_000 {
        return Err("Miniatura excede o limite de tamanho".into());
    }
    Ok(Some(format!(
        "data:image/jpeg;base64,{}",
        STANDARD.encode(bytes)
    )))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn workspace_rejects_path_traversal() {
        assert!(validate_workspace("cliente-a").is_ok());
        assert!(validate_workspace("../outro").is_err());
    }

    #[test]
    fn repeated_camera_filename_does_not_overwrite_previous_capture() {
        let root = std::env::temp_dir().join(format!("lumen-test-{}", Uuid::new_v4()));
        let first = root.join("card-one");
        let second = root.join("card-two");
        let destination = root.join("archive");
        fs::create_dir_all(&first).unwrap();
        fs::create_dir_all(&second).unwrap();
        fs::create_dir_all(&destination).unwrap();
        fs::write(first.join("C001.MP4"), b"first take").unwrap();
        fs::write(second.join("C001.MP4"), b"second take").unwrap();

        let capture_a = ingest_capture_impl(
            first.to_str().unwrap(),
            destination.to_str().unwrap(),
            "client-a",
            "Shopping",
            "Vendas para o Dia das Crianças",
            vec!["Shopping Vitória".into()],
            None,
        )
        .unwrap();
        let capture_b = ingest_capture_impl(
            second.to_str().unwrap(),
            destination.to_str().unwrap(),
            "client-a",
            "Praia",
            "Movimento no fim de semana",
            vec!["Praia do Morro".into()],
            None,
        )
        .unwrap();
        assert_eq!(capture_a.verified_count, 1);
        assert_eq!(capture_b.verified_count, 1);
        assert_ne!(capture_a.capture_id, capture_b.capture_id);
        assert_eq!(capture_a.visited_locations, vec!["Shopping Vitória"]);
        assert_eq!(capture_b.brief, "Movimento no fim de semana");
        assert!(capture_a.assets[0].processing_error.is_some());
        let copy_a = Path::new(&capture_a.manifest_path)
            .parent()
            .unwrap()
            .join(&capture_a.assets[0].copy_relative_path);
        let copy_b = Path::new(&capture_b.manifest_path)
            .parent()
            .unwrap()
            .join(&capture_b.assets[0].copy_relative_path);
        assert_eq!(fs::read(copy_a).unwrap(), b"first take");
        assert_eq!(fs::read(copy_b).unwrap(), b"second take");
        assert_eq!(fs::read(first.join("C001.MP4")).unwrap(), b"first take");
        assert_eq!(
            list_captures_impl(destination.to_str().unwrap(), "client-a")
                .unwrap()
                .len(),
            2
        );
        let listed = list_captures_impl(destination.to_str().unwrap(), "client-a").unwrap();
        assert!(listed
            .iter()
            .any(|capture| capture.visited_locations == vec!["Shopping Vitória"]));
        let retried = reprocess_capture_impl(
            destination.to_str().unwrap(),
            "client-a",
            &capture_a.capture_id,
        )
        .unwrap();
        assert_ne!(retried.manifest_path, capture_a.manifest_path);
        assert_eq!(retried.verified_count, 1);
        assert!(retried.assets[0].processing_error.is_some());
        assert_eq!(fs::read(first.join("C001.MP4")).unwrap(), b"first take");
        let updated = list_captures_impl(destination.to_str().unwrap(), "client-a").unwrap();
        assert!(updated.iter().any(|capture| capture.manifest_path == retried.manifest_path));
        assert!(reprocess_capture_impl(destination.to_str().unwrap(), "client-b", &capture_a.capture_id).is_err());
        fs::remove_dir_all(root).unwrap();
    }
}
