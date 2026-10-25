use crate::media::{self, MediaMetadata};
use base64::{engine::general_purpose::STANDARD, Engine as _};
use chrono::Utc;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use uuid::Uuid;

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
    #[serde(default)]
    source_size_bytes: Option<u64>,
    #[serde(default)]
    source_modified: Option<String>,
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
    pub(crate) team: String,
    #[serde(default)]
    pub(crate) visited_locations: Vec<String>,
    created_at: String,
    source_path: String,
    pub(crate) assets: Vec<Asset>,
    verified_count: usize,
    failed_count: usize,
    warning: String,
    manifest_path: String,
    #[serde(default)]
    pending_count: usize,
    #[serde(default)]
    load_warnings: Vec<String>,
}

#[derive(Clone, Serialize)]
pub struct IngestProgress {
    pub capture_id: String,
    pub done: usize,
    pub total: usize,
    pub verified: usize,
    pub failed: usize,
    pub current: String,
    pub stage: String,
}

fn modified_key(metadata: &fs::Metadata) -> Option<String> {
    metadata
        .modified()
        .ok()?
        .duration_since(std::time::UNIX_EPOCH)
        .ok()
        .map(|value| value.as_nanos().to_string())
}

fn destination_child(parent: &Path, name: &str) -> Result<PathBuf, String> {
    let path = parent.join(name);
    match fs::create_dir(&path) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
        Err(error) => return Err(error.to_string()),
    }
    let real = fs::canonicalize(path).map_err(|error| error.to_string())?;
    if !real.is_dir() || !real.starts_with(parent) {
        return Err("Pasta redirecionada para fora do destino autorizado.".into());
    }
    Ok(real)
}

fn save_checkpoint(directory: &Path, manifest: &mut Manifest, initial: bool) -> Result<(), String> {
    manifest.verified_count = manifest
        .assets
        .iter()
        .filter(|asset| asset.status == "verified")
        .count();
    manifest.failed_count = manifest
        .assets
        .iter()
        .filter(|asset| asset.status == "failed")
        .count();
    manifest.pending_count = manifest
        .assets
        .iter()
        .filter(|asset| asset.status == "pending")
        .count();
    let name = if initial {
        "manifest.json".into()
    } else {
        format!(
            "manifest-reprocess-{}-{}.json",
            Utc::now().format("%Y%m%dT%H%M%S%9fZ"),
            Uuid::new_v4()
        )
    };
    let final_path = directory.join(name);
    let partial = final_path.with_extension("partial");
    manifest.manifest_path = final_path.to_string_lossy().into_owned();
    let bytes = serde_json::to_vec_pretty(manifest).map_err(|error| error.to_string())?;
    let mut writer = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&partial)
        .map_err(|error| error.to_string())?;
    writer
        .write_all(&bytes)
        .map_err(|error| error.to_string())?;
    writer.sync_all().map_err(|error| error.to_string())?;
    drop(writer);
    fs::rename(partial, final_path).map_err(|error| error.to_string())
}

fn process_pending_assets(
    directory: &Path,
    source: &Path,
    manifest: &mut Manifest,
    tools: Option<&str>,
    progress: &dyn Fn(IngestProgress),
) -> Result<(), String> {
    let originals =
        fs::canonicalize(directory.join("originals")).map_err(|error| error.to_string())?;
    if !originals.starts_with(directory) || originals.starts_with(source) {
        return Err("Pasta de cópias fora da captação.".into());
    }
    for index in 0..manifest.assets.len() {
        if manifest.assets[index].status == "verified" {
            continue;
        }
        let notify = |manifest: &Manifest, done: usize, stage: &str| {
            progress(IngestProgress {
                capture_id: manifest.capture_id.clone(),
                done,
                total: manifest.assets.len(),
                verified: manifest.verified_count,
                failed: manifest.failed_count,
                current: manifest.assets[index].original_name.clone(),
                stage: stage.into(),
            })
        };
        notify(manifest, index, "copying");
        let asset = &mut manifest.assets[index];
        let result = (|| {
            Uuid::parse_str(&asset.asset_id).map_err(|_| "ID de mídia inválido")?;
            let relative = Path::new(&asset.original_relative_path);
            let copy_relative = Path::new(&asset.copy_relative_path);
            if !relative
                .components()
                .all(|part| matches!(part, std::path::Component::Normal(_)))
                || !copy_relative
                    .components()
                    .all(|part| matches!(part, std::path::Component::Normal(_)))
                || copy_relative.parent() != Some(Path::new("originals"))
                || copy_relative.file_stem().and_then(|stem| stem.to_str())
                    != Some(asset.asset_id.as_str())
            {
                return Err("Caminho de mídia inválido no inventário.".into());
            }
            let input = fs::canonicalize(source.join(relative))
                .map_err(|error| format!("Origem indisponível: {error}"))?;
            if !input.starts_with(source) {
                return Err("Mídia fora da origem autorizada.".into());
            }
            let metadata = fs::metadata(&input).map_err(|error| error.to_string())?;
            if asset
                .source_size_bytes
                .is_some_and(|size| metadata.len() != size)
                || asset
                    .source_modified
                    .as_ref()
                    .is_some_and(|modified| modified_key(&metadata).as_ref() != Some(modified))
            {
                return Err("O arquivo da origem mudou desde o inventário. Reconecte a origem original ou faça uma nova captação.".into());
            }
            let copied = directory.join(copy_relative);
            if copied.exists() {
                // A crash may happen after the final rename and before the checkpoint.
                let real = fs::canonicalize(&copied).map_err(|error| error.to_string())?;
                if !real.starts_with(&originals) {
                    return Err("Cópia fora da captação.".into());
                }
                let digest = sha256_file(&real)?;
                if fs::metadata(&real)
                    .map_err(|error| error.to_string())?
                    .len()
                    != metadata.len()
                    || sha256_file(&input)? != digest
                {
                    return Err("Já existe uma cópia diferente. Ela foi preservada; confira a captação antes de continuar.".into());
                }
                return Ok((metadata.len(), digest));
            }
            // Each attempt owns its temporary file; another instance is never deleted.
            let partial = originals.join(format!("{}-{}.partial", asset.asset_id, Uuid::new_v4()));
            let result = copy_verified(&input, &partial, &copied);
            if result.is_err() {
                let _ = fs::remove_file(&partial);
            }
            result
        })();
        match result {
            Ok((size, digest)) => {
                asset.status = "verified".into();
                asset.size_bytes = Some(size);
                asset.sha256 = Some(digest);
                asset.error = None;
            }
            Err(error) => {
                asset.status = "failed".into();
                asset.error = Some(error);
            }
        }
        // Persist the verified copy before invoking any external processing tool.
        save_checkpoint(directory, manifest, false).map_err(|error| {
            format!("Não foi possível salvar o progresso: {error}. Retome esta captação no acervo.")
        })?;
        notify(
            manifest,
            index,
            if manifest.assets[index].status == "verified" {
                "processing"
            } else {
                "failed"
            },
        );
        let asset = &mut manifest.assets[index];
        let copied = directory.join(&asset.copy_relative_path);
        let kind = media::kind_for(&copied);
        if asset.status == "verified" && kind != "sidecar" {
            let mut errors = Vec::new();
            match media::probe(&copied, kind, tools) {
                Ok(metadata) => asset.metadata = Some(metadata),
                Err(error) => errors.push(error),
            }
            match media::make_thumbnail(
                &copied,
                &directory.join("thumbnails"),
                &asset.asset_id,
                tools,
            ) {
                Ok(path) => asset.thumbnail_relative_path = Some(path),
                Err(error) => errors.push(error),
            }
            asset.processing_error = (!errors.is_empty()).then(|| errors.join("; "));
            save_checkpoint(directory, manifest, false)?;
        }
        notify(manifest, index + 1, "saved");
    }
    progress(IngestProgress {
        capture_id: manifest.capture_id.clone(),
        done: manifest.assets.len(),
        total: manifest.assets.len(),
        verified: manifest.verified_count,
        failed: manifest.failed_count,
        current: String::new(),
        stage: "complete".into(),
    });
    Ok(())
}

#[cfg(test)]
pub fn resume_ingest_impl(
    destination: &str,
    workspace: &str,
    capture_id: &str,
) -> Result<Manifest, String> {
    resume_ingest_with_progress_impl(destination, workspace, capture_id, &|_| {})
}

pub fn resume_ingest_with_progress_impl(
    destination: &str,
    workspace: &str,
    capture_id: &str,
    progress: &dyn Fn(IngestProgress),
) -> Result<Manifest, String> {
    let directory = capture_directory(destination, workspace, capture_id)?;
    let mut manifest = read_latest_manifest(&directory)?;
    if manifest.capture_id != capture_id || manifest.workspace_id != workspace {
        return Err("Captação fora do espaço selecionado.".into());
    }
    let source = fs::canonicalize(&manifest.source_path)
        .map_err(|error| format!("Reconecte a origem original para retomar: {error}"))?;
    if source.starts_with(&directory) || directory.starts_with(&source) {
        return Err("Origem e destino devem permanecer separados.".into());
    }
    process_pending_assets(&directory, &source, &mut manifest, None, progress)?;
    Ok(manifest)
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

#[cfg(test)]
pub fn ingest_capture_impl(
    source: &str,
    destination: &str,
    workspace: &str,
    capture_name: &str,
    brief: &str,
    visited_locations: Vec<String>,
    tools_directory: Option<&str>,
) -> Result<Manifest, String> {
    ingest_capture_with_progress_impl(
        source,
        destination,
        workspace,
        capture_name,
        brief,
        "",
        visited_locations,
        tools_directory,
        &|_| {},
    )
}

pub fn ingest_capture_with_progress_impl(
    source: &str,
    destination: &str,
    workspace: &str,
    capture_name: &str,
    brief: &str,
    team: &str,
    visited_locations: Vec<String>,
    tools_directory: Option<&str>,
    progress: &dyn Fn(IngestProgress),
) -> Result<Manifest, String> {
    validate_workspace(workspace)?;
    if capture_name.trim().is_empty() {
        return Err("Informe o nome da captação.".into());
    }
    if brief.len() > 10_000 {
        return Err("A pauta deve ter até 10 mil caracteres.".into());
    }
    if team.chars().count() > 240 {
        return Err("A equipe deve ter até 240 caracteres.".into());
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
    for entry in crate::source::source_entries(&source_path) {
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
    let workspaces = destination_child(&destination_path, "workspaces")?;
    let workspace_directory = destination_child(&workspaces, workspace)?;
    let captures = destination_child(&workspace_directory, "captures")?;
    let capture_dir = destination_child(&captures, &capture_id)?;
    let originals_dir = destination_child(&capture_dir, "originals")?;
    if !capture_dir.starts_with(&destination_path) || capture_dir.starts_with(&source_path) {
        return Err("Captação fora do destino autorizado.".into());
    }
    let mut assets = Vec::new();
    for path in files {
        let asset_id = Uuid::new_v4().to_string();
        let extension = path
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("")
            .to_ascii_lowercase();
        let copied = originals_dir.join(format!("{asset_id}.{extension}"));
        let metadata = fs::metadata(&path).map_err(|error| error.to_string())?;
        let asset = Asset {
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
            status: "pending".into(),
            size_bytes: None,
            sha256: None,
            error: None,
            metadata: None,
            thumbnail_relative_path: None,
            processing_error: None,
            source_size_bytes: Some(metadata.len()),
            source_modified: modified_key(&metadata),
        };
        assets.push(asset);
    }
    let manifest_path = capture_dir.join("manifest.json");
    let mut manifest = Manifest {
        schema_version: 1, capture_id, workspace_id: workspace.to_string(), capture_name: capture_name.trim().to_string(),
        brief: brief.trim().to_string(), team: team.trim().to_string(), visited_locations,
        created_at: Utc::now().to_rfc3339(), source_path: source_path.to_string_lossy().to_string(),
        verified_count: assets.iter().filter(|a| a.status == "verified").count(),
        failed_count: assets.iter().filter(|a| a.status == "failed").count(),
        assets,
        warning: "A verificação da cópia não substitui um segundo backup. Não formate o cartão apenas com base neste manifesto.".into(),
        manifest_path: manifest_path.to_string_lossy().to_string(),
        pending_count: 0, load_warnings: Vec::new(),
    };
    save_checkpoint(&capture_dir, &mut manifest, true)?;
    process_pending_assets(
        &capture_dir,
        &source_path,
        &mut manifest,
        tools_directory,
        progress,
    )?;
    Ok(manifest)
}

pub fn list_captures_impl(destination: &str, workspace: &str) -> Result<Vec<Manifest>, String> {
    Ok(list_capture_catalog_impl(destination, workspace)?.captures)
}

#[derive(Serialize)]
pub struct CaptureCatalog {
    pub captures: Vec<Manifest>,
    pub warnings: Vec<String>,
}

pub fn list_capture_catalog_impl(
    destination: &str,
    workspace: &str,
) -> Result<CaptureCatalog, String> {
    validate_workspace(workspace)?;
    let destination_path = fs::canonicalize(destination).map_err(|e| e.to_string())?;
    let captures_dir = destination_path
        .join("workspaces")
        .join(workspace)
        .join("captures");
    if !captures_dir.exists() {
        return Ok(CaptureCatalog {
            captures: Vec::new(),
            warnings: Vec::new(),
        });
    }
    let mut captures = Vec::new();
    let mut warnings = Vec::new();
    for entry in fs::read_dir(&captures_dir).map_err(|e| e.to_string())? {
        let capture_dir = entry.map_err(|e| e.to_string())?.path();
        if capture_dir.is_dir() {
            match read_latest_manifest(&capture_dir) {
                Ok(manifest) if manifest.workspace_id == workspace => captures.push(manifest),
                Ok(_) => warnings.push(format!(
                    "A pasta {} contém um manifesto de outro espaço e não foi carregada.",
                    capture_dir.display()
                )),
                Err(error) => warnings.push(format!(
                    "Captação {} não pôde ser lida: {error}",
                    capture_dir.display()
                )),
            }
        }
    }
    captures.sort_by(|a, b| b.created_at.cmp(&a.created_at));
    Ok(CaptureCatalog { captures, warnings })
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
    let mut warnings = Vec::new();
    for path in revisions {
        if let Ok(bytes) = fs::read(&path) {
            if let Ok(mut manifest) = serde_json::from_slice::<Manifest>(&bytes) {
                manifest.manifest_path = path.to_string_lossy().to_string();
                manifest.pending_count = manifest
                    .assets
                    .iter()
                    .filter(|asset| asset.status == "pending")
                    .count();
                manifest.load_warnings = warnings;
                return Ok(manifest);
            }
        }
        warnings.push(format!(
            "Registro {} indisponível ou inválido; foi necessário procurar uma versão anterior.",
            path.file_name().unwrap_or_default().to_string_lossy()
        ));
    }
    Err("Nenhum manifesto válido encontrado nesta captação".into())
}

pub(crate) fn capture_directory(
    destination: &str,
    workspace: &str,
    capture_id: &str,
) -> Result<PathBuf, String> {
    validate_workspace(workspace)?;
    Uuid::parse_str(capture_id).map_err(|_| "ID de captação inválido".to_string())?;
    let destination_path = fs::canonicalize(destination).map_err(|e| e.to_string())?;
    let capture_dir = fs::canonicalize(
        destination_path
            .join("workspaces")
            .join(workspace)
            .join("captures")
            .join(capture_id),
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
    let originals_dir =
        fs::canonicalize(capture_dir.join("originals")).map_err(|e| e.to_string())?;
    let mut attempted = false;
    for asset in &mut manifest.assets {
        if asset.status != "verified"
            || media::kind_for(Path::new(&asset.original_name)) == "sidecar"
        {
            continue;
        }
        if Uuid::parse_str(&asset.asset_id).is_err() {
            asset.processing_error = Some("ID de arquivo inválido no manifesto".into());
            attempted = true;
            continue;
        }
        let expected_thumbnail = capture_dir
            .join("thumbnails")
            .join(format!("{}.jpg", asset.asset_id));
        let needs_metadata = asset
            .metadata
            .as_ref()
            .is_none_or(|value| value.metadata_version < media::METADATA_VERSION);
        let relative = Path::new(&asset.copy_relative_path);
        let valid_relative = relative
            .components()
            .all(|part| matches!(part, std::path::Component::Normal(_)))
            && relative.parent() == Some(Path::new("originals"))
            && relative.file_stem().and_then(|stem| stem.to_str()) == Some(asset.asset_id.as_str());
        let copied = if valid_relative {
            fs::canonicalize(capture_dir.join(relative))
                .ok()
                .filter(|path| path.starts_with(&originals_dir))
        } else {
            None
        };
        let Some(copied) = copied else {
            asset.processing_error = Some("Cópia ausente ou fora da pasta da captação".into());
            attempted = true;
            continue;
        };
        if !needs_metadata
            && asset.thumbnail_relative_path.is_some()
            && expected_thumbnail.is_file()
        {
            if asset.processing_error.take().is_some() {
                attempted = true;
            }
            continue;
        }
        attempted = true;
        let mut errors = Vec::new();
        if needs_metadata {
            match media::probe(&copied, media::kind_for(&copied), None) {
                Ok(metadata) => asset.metadata = Some(metadata),
                Err(error) => errors.push(error),
            }
        }
        if asset.thumbnail_relative_path.is_none() || !expected_thumbnail.is_file() {
            let existing_size = fs::metadata(&expected_thumbnail)
                .map(|meta| meta.len())
                .unwrap_or(0);
            if existing_size > 0 && existing_size <= 2_000_000 {
                asset.thumbnail_relative_path = Some(format!("thumbnails/{}.jpg", asset.asset_id));
            } else {
                match media::make_thumbnail(
                    &copied,
                    &capture_dir.join("thumbnails"),
                    &asset.asset_id,
                    None,
                ) {
                    Ok(path) => asset.thumbnail_relative_path = Some(path),
                    Err(error) => errors.push(error),
                }
            }
        }
        asset.processing_error = if errors.is_empty() {
            None
        } else {
            Some(errors.join("; "))
        };
    }
    if !attempted {
        return Ok(manifest);
    }
    // Revisões imutáveis: uma falha de energia não substitui o manifesto anterior.
    let revision = format!(
        "manifest-reprocess-{}-{}.json",
        Utc::now().format("%Y%m%dT%H%M%S%9fZ"),
        Uuid::new_v4()
    );
    let final_path = capture_dir.join(revision);
    let partial_path = final_path.with_extension("partial");
    manifest.manifest_path = final_path.to_string_lossy().to_string();
    let serialized = serde_json::to_vec_pretty(&manifest).map_err(|e| e.to_string())?;
    let mut writer = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&partial_path)
        .map_err(|e| e.to_string())?;
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
    if fs::metadata(&real_thumbnail)
        .map_err(|error| error.to_string())?
        .len()
        > 2_000_000
    {
        return Err("Miniatura excede o limite de tamanho".into());
    }
    let mut bytes = Vec::new();
    File::open(&real_thumbnail)
        .map_err(|error| error.to_string())?
        .take(2_000_001)
        .read_to_end(&mut bytes)
        .map_err(|error| error.to_string())?;
    if bytes.is_empty() || bytes.len() > 2_000_000 {
        return Err("Miniatura vazia ou excedendo o limite".into());
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
    fn checkpoints_recover_a_renamed_copy_and_report_invalid_records() {
        let root = std::env::temp_dir().join(format!("lumen-checkpoint-{}", Uuid::new_v4()));
        let source = root.join("card");
        let destination = root.join("archive");
        fs::create_dir_all(&source).unwrap();
        fs::create_dir_all(&destination).unwrap();
        fs::write(source.join("C001.MP4"), b"verified take").unwrap();
        fs::create_dir_all(source.join("System Volume Information")).unwrap();
        fs::write(
            source.join("System Volume Information/ignored.mp4"),
            b"not camera media",
        )
        .unwrap();
        let mut manifest = ingest_capture_impl(
            source.to_str().unwrap(),
            destination.to_str().unwrap(),
            "personal",
            "Test",
            "",
            vec![],
            Some(root.to_str().unwrap()),
        )
        .unwrap();
        assert_eq!(manifest.assets.len(), 1);
        let directory = Path::new(&manifest.manifest_path)
            .parent()
            .unwrap()
            .to_path_buf();
        let expected_hash = manifest.assets[0].sha256.clone();
        manifest.assets[0].status = "pending".into();
        manifest.assets[0].sha256 = None;
        save_checkpoint(&directory, &mut manifest, false).unwrap();
        let resumed = resume_ingest_impl(
            destination.to_str().unwrap(),
            "personal",
            &manifest.capture_id,
        )
        .unwrap();
        assert_eq!(resumed.pending_count, 0);
        assert_eq!(resumed.verified_count, 1);
        assert_eq!(resumed.assets[0].sha256, expected_hash);
        fs::write(
            directory.join("manifest-reprocess-99999999-invalid.json"),
            b"broken",
        )
        .unwrap();
        assert_eq!(
            read_latest_manifest(&directory)
                .unwrap()
                .load_warnings
                .len(),
            1
        );
        fs::create_dir_all(destination.join("workspaces/personal/captures/broken-capture"))
            .unwrap();
        let catalog = list_capture_catalog_impl(destination.to_str().unwrap(), "personal").unwrap();
        assert_eq!(catalog.captures.len(), 1);
        assert_eq!(catalog.warnings.len(), 1);
        assert_eq!(fs::read(source.join("C001.MP4")).unwrap(), b"verified take");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn resume_does_not_overwrite_a_different_copy_or_accept_a_changed_source() {
        let root = std::env::temp_dir().join(format!("lumen-resume-{}", Uuid::new_v4()));
        let source = root.join("card");
        let destination = root.join("archive");
        fs::create_dir_all(&source).unwrap();
        fs::create_dir_all(&destination).unwrap();
        fs::write(source.join("C001.MP4"), b"original").unwrap();
        let mut manifest = ingest_capture_impl(
            source.to_str().unwrap(),
            destination.to_str().unwrap(),
            "personal",
            "Test",
            "",
            vec![],
            Some(root.to_str().unwrap()),
        )
        .unwrap();
        let directory = Path::new(&manifest.manifest_path)
            .parent()
            .unwrap()
            .to_path_buf();
        let copied = directory.join(&manifest.assets[0].copy_relative_path);
        fs::write(&copied, b"other existing copy").unwrap();
        manifest.assets[0].status = "pending".into();
        save_checkpoint(&directory, &mut manifest, false).unwrap();
        let resumed = resume_ingest_impl(
            destination.to_str().unwrap(),
            "personal",
            &manifest.capture_id,
        )
        .unwrap();
        assert_eq!(resumed.failed_count, 1);
        assert_eq!(fs::read(&copied).unwrap(), b"other existing copy");
        fs::write(source.join("C001.MP4"), b"changed and larger source").unwrap();
        let resumed = resume_ingest_impl(
            destination.to_str().unwrap(),
            "personal",
            &manifest.capture_id,
        )
        .unwrap();
        assert!(resumed.assets[0]
            .error
            .as_deref()
            .unwrap()
            .contains("mudou"));
        assert_eq!(fs::read(copied).unwrap(), b"other existing copy");
        fs::remove_dir_all(root).unwrap();
    }

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
        assert!(updated
            .iter()
            .any(|capture| capture.manifest_path == retried.manifest_path));
        assert!(reprocess_capture_impl(
            destination.to_str().unwrap(),
            "client-b",
            &capture_a.capture_id
        )
        .is_err());
        fs::remove_dir_all(root).unwrap();
    }
}
