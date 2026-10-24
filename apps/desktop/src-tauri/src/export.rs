use super::get_organization_approval_impl;
use crate::{ingest::{capture_directory, read_latest_manifest}, media};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::{fs::{self, File, OpenOptions}, io::Read, path::{Component, Path, PathBuf}};
use uuid::Uuid;

#[derive(Clone, Serialize)]
pub struct ExportEntry {
    pub asset_id: String,
    pub original_name: String,
    pub relative_path: String,
    pub bytes: u64,
    pub sha256: String,
    #[serde(skip)]
    source: PathBuf,
}
#[derive(Serialize)]
pub struct ExportPlan {
    pub approval_id: String,
    pub output_directory: String,
    pub total_bytes: u64,
    pub files: Vec<ExportEntry>,
}
#[derive(Serialize)]
pub struct ExportResult {
    pub approval_id: String,
    pub output_directory: String,
    pub copied: usize,
    pub reused: usize,
    pub errors: Vec<String>,
    pub report_path: String,
    pub approval_current: bool,
}
#[derive(Clone, Serialize)]
pub struct ExportProgress { pub approval_id: String, pub done: usize, pub total: usize, pub current: String }

fn label(raw: &str, fallback: &str) -> String {
    let text: String = raw.chars().map(|c| if c.is_control() || "<>:\"/\\|?*".contains(c) { '_' } else { c }).take(28).collect();
    let text = text.trim().trim_matches('.').trim();
    let text = if text.is_empty() { fallback } else { text };
    // The suffix separates labels that differ only by case or invalid Windows characters.
    let digest = format!("{:x}", Sha256::digest(raw.as_bytes()));
    format!("{}-{}", text, &digest[..8])
}
fn no_link(path: &Path) -> Result<(), String> {
    let meta = fs::symlink_metadata(path).map_err(|e| e.to_string())?;
    #[cfg(windows)]
    { use std::os::windows::fs::MetadataExt;
      if meta.file_attributes() & 0x400 != 0 { return Err("Atalho ou junction não permitido na exportação.".into()); }
    }
    if meta.file_type().is_symlink() { return Err("Link não permitido na exportação.".into()); }
    Ok(())
}
fn ensure_directory(root: &Path, relative: &Path) -> Result<PathBuf, String> {
    let mut current = root.to_path_buf();
    for part in relative.components() {
        if !matches!(part, Component::Normal(_)) { return Err("Pasta de exportação inválida.".into()); }
        current.push(part);
        if !current.exists() { fs::create_dir(&current).or_else(|e| if e.kind() == std::io::ErrorKind::AlreadyExists { Ok(()) } else { Err(e) }).map_err(|e| e.to_string())?; }
        no_link(&current)?;
        if !fs::canonicalize(&current).map_err(|e| e.to_string())?.starts_with(root) { return Err("Exportação fora da captação.".into()); }
    }
    Ok(current)
}
fn digest(path: &Path) -> Result<String, String> {
    let mut reader = File::open(path).map_err(|e| e.to_string())?;
    let mut hash = Sha256::new();
    let mut buffer = vec![0u8; 1024 * 1024];
    loop { let count = reader.read(&mut buffer).map_err(|e| e.to_string())?; if count == 0 { break; } hash.update(&buffer[..count]); }
    Ok(format!("{:x}", hash.finalize()))
}
pub fn plan(destination: &str, workspace: &str, capture_id: &str) -> Result<ExportPlan, String> {
    let directory = capture_directory(destination, workspace, capture_id)?;
    let manifest = read_latest_manifest(&directory)?;
    if manifest.workspace_id != workspace || manifest.capture_id != capture_id { return Err("Captação fora do espaço selecionado.".into()); }
    let approval = get_organization_approval_impl(destination, workspace, capture_id)?.ok_or("Aprove a revisão atual antes de criar as pastas.")?;
    Uuid::parse_str(&approval.approval_id).map_err(|_| "Aprovação inválida")?;
    let originals = fs::canonicalize(directory.join("originals")).map_err(|e| e.to_string())?;
    let mut files = Vec::new();
    for asset in &manifest.assets {
        if asset.status != "verified" { return Err(format!("{}: cópia não verificada; resolva a ingestão antes de exportar.", asset.original_name)); }
        Uuid::parse_str(&asset.asset_id).map_err(|_| "ID de arquivo inválido")?;
        let relative = Path::new(&asset.copy_relative_path);
        if !relative.components().all(|part| matches!(part, Component::Normal(_))) || relative.parent() != Some(Path::new("originals")) || relative.file_stem().and_then(|s| s.to_str()) != Some(asset.asset_id.as_str()) { return Err("Caminho da cópia inválido.".into()); }
        let source = fs::canonicalize(directory.join(relative)).map_err(|e| e.to_string())?;
        if !source.starts_with(&originals) { return Err("Arquivo fora da pasta originals.".into()); }
        let decision = approval.decisions.iter().find(|d| d.asset_id == asset.asset_id);
        let folder = if let Some(decision) = decision {
            let category = if decision.category.trim().is_empty() { &decision.matter } else { &decision.category };
            PathBuf::from(label(category, "Sem categoria")).join(label(&decision.matter, "Sem assunto"))
        } else if media::kind_for(Path::new(&asset.original_name)) == "sidecar" {
            PathBuf::from("Arquivos auxiliares")
        } else { return Err(format!("{} não consta na aprovação.", asset.original_name)); };
        let original = Path::new(&asset.original_name);
        let stem: String = original.file_stem().and_then(|v| v.to_str()).unwrap_or("take").chars().map(|c| if c.is_control() || "<>:\"/\\|?*".contains(c) { '_' } else { c }).take(36).collect();
        let extension = relative.extension().and_then(|v| v.to_str()).unwrap_or("");
        if !extension.chars().all(|c| c.is_ascii_alphanumeric()) { return Err("Extensão inválida.".into()); }
        let name = format!("{}--{}.{}", stem.trim().trim_matches('.'), asset.asset_id, extension);
        files.push(ExportEntry { asset_id: asset.asset_id.clone(), original_name: asset.original_name.clone(), relative_path: folder.join(name).to_string_lossy().into_owned(), bytes: fs::metadata(&source).map_err(|e| e.to_string())?.len(), sha256: asset.sha256.clone().filter(|s| s.len() == 64 && s.chars().all(|c| c.is_ascii_hexdigit())).ok_or("Cópia sem hash válido")?, source });
    }
    let total_bytes = files.iter().try_fold(0u64, |total, file| total.checked_add(file.bytes)).ok_or("Tamanho total inválido")?;
    Ok(ExportPlan { output_directory: directory.join("organized").join(&approval.approval_id).to_string_lossy().into_owned(), approval_id: approval.approval_id, total_bytes, files })
}
fn copy_one(root: &Path, entry: &ExportEntry) -> Result<bool, String> {
    let relative = Path::new(&entry.relative_path);
    let parent = ensure_directory(root, relative.parent().ok_or("Pasta de saída inválida")?)?;
    let target = parent.join(relative.file_name().ok_or("Nome de saída inválido")?);
    if target.exists() {
        no_link(&target)?;
        if fs::metadata(&target).map_err(|e| e.to_string())?.len() == entry.bytes && digest(&target)? == entry.sha256 { return Ok(false); }
        return Err("O destino já existe com conteúdo diferente ou incompleto. Nenhum arquivo foi sobrescrito; remova ou renomeie essa cópia antes de retomar.".into());
    }
    // create_new guarantees that even two application instances cannot overwrite a file.
    let mut writer = OpenOptions::new().write(true).create_new(true).open(&target).map_err(|e| e.to_string())?;
    let result = (|| {
        let mut reader = File::open(&entry.source).map_err(|e| e.to_string())?;
        let bytes = std::io::copy(&mut reader, &mut writer).map_err(|e| e.to_string())?;
        writer.sync_all().map_err(|e| e.to_string())?;
        if bytes != entry.bytes || digest(&target)? != entry.sha256 { return Err("A cópia não confere com o hash da ingestão.".into()); }
        Ok(true)
    })();
    drop(writer);
    // Only remove the new output created by this call, never an input or pre-existing file.
    if result.is_err() { let _ = fs::remove_file(&target); }
    result
}
pub fn export(destination: &str, workspace: &str, capture_id: &str, expected_approval_id: &str, progress: impl Fn(ExportProgress)) -> Result<ExportResult, String> {
    let plan = plan(destination, workspace, capture_id)?;
    if plan.approval_id != expected_approval_id { return Err("A aprovação mudou. Atualize a prévia antes de criar as pastas.".into()); }
    let capture = capture_directory(destination, workspace, capture_id)?;
    let root = ensure_directory(&capture, &PathBuf::from("organized").join(&plan.approval_id))?;
    let mut result = ExportResult { approval_id: plan.approval_id.clone(), output_directory: plan.output_directory.clone(), copied: 0, reused: 0, errors: Vec::new(), report_path: String::new(), approval_current: true };
    for (index, file) in plan.files.iter().enumerate() {
        progress(ExportProgress { approval_id: plan.approval_id.clone(), done: index, total: plan.files.len(), current: file.original_name.clone() });
        match copy_one(&root, file) { Ok(true) => result.copied += 1, Ok(false) => result.reused += 1, Err(error) => result.errors.push(format!("{}: {error}", file.original_name)) }
        progress(ExportProgress { approval_id: plan.approval_id.clone(), done: index + 1, total: plan.files.len(), current: file.original_name.clone() });
    }
    result.approval_current = get_organization_approval_impl(destination, workspace, capture_id)?.is_some_and(|a| a.approval_id == plan.approval_id);
    let report = root.join(format!("export-{}.json", Uuid::new_v4()));
    result.report_path = report.to_string_lossy().into_owned();
    let mut writer = OpenOptions::new().write(true).create_new(true).open(&report).map_err(|e| e.to_string())?;
    serde_json::to_writer_pretty(&mut writer, &serde_json::json!({"created_at":chrono::Utc::now().to_rfc3339(),"capture_id":capture_id,"workspace_id":workspace,"result":result,"files":plan.files})).map_err(|e| e.to_string())?;
    writer.sync_all().map_err(|e| e.to_string())?;
    Ok(result)
}

