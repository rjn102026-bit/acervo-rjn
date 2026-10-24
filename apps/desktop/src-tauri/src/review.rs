use crate::ingest::{capture_directory, list_captures_impl, read_latest_manifest, Asset, Manifest};
use crate::media;
use chrono::Utc;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use uuid::Uuid;

#[derive(Clone, Debug, Serialize)]
pub struct Evidence {
    kind: String,
    label: String,
    value: String,
    source: String,
}

#[derive(Clone, Debug, Serialize)]
pub struct Suggestion {
    location: Option<String>,
    matter: Option<String>,
    tags: Vec<String>,
    confidence: Option<f64>,
    reason: String,
    analyzer_version: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ReviewEvent {
    event_id: String,
    capture_id: String,
    workspace_id: String,
    asset_id: String,
    status: String,
    location: Option<String>,
    matter: String,
    tags: Vec<String>,
    note: String,
    reviewed_at: String,
    #[serde(default)]
    category: String,
}

#[derive(Clone, Debug, Serialize)]
pub struct OrganizationProposal {
    event_id: String,
    category: String,
    matter: String,
    tags: Vec<String>,
    location: Option<String>,
    source: String,
    requires_review: bool,
    reason: String,
}

fn organization_for(asset_id: &str, decision: Option<&ReviewEvent>, analysis: Option<&crate::ai::VisualAnalysis>) -> Option<OrganizationProposal> {
    if let Some(decision) = decision.filter(|event| event.status != "pending") {
        return Some(OrganizationProposal { event_id: decision.event_id.clone(),
            category: if !decision.category.is_empty() { decision.category.clone() } else if !decision.matter.is_empty() { decision.matter.clone() } else { "Organização revisada".into() },
            matter: decision.matter.clone(), tags: decision.tags.clone(), location: decision.location.clone(),
            source: "human".into(), requires_review: false, reason: "Correção ou decisão salva pelo editor.".into() });
    }
    let analysis = analysis?;
    let pending = decision.is_some_and(|event| event.status == "pending");
    Some(OrganizationProposal { event_id: format!("ai:{asset_id}:{}", analysis.analyzed_at),
        category: analysis.category.clone(), matter: analysis.matter.clone(), tags: analysis.tags.clone(), location: analysis.location.clone(),
        source: "ai".into(), requires_review: analysis.needs_review || pending,
        reason: if pending { "O editor manteve este take pendente.".into() } else if analysis.needs_review { analysis.review_reason.clone() } else { "Organizado automaticamente a partir do conteúdo visual.".into() } })
}

#[derive(Clone, Debug, Serialize)]
pub struct ReviewItem {
    asset_id: String,
    original_name: String,
    evidence: Vec<Evidence>,
    suggestion: Option<Suggestion>,
    decision: Option<ReviewEvent>,
    history: Vec<ReviewEvent>,
    visual_analysis: Option<crate::ai::VisualAnalysis>,
    organization: Option<OrganizationProposal>,
}

#[derive(Clone, Debug, Serialize)]
pub struct ReviewSearchEntry {
    capture_id: String,
    asset_id: String,
    status: String,
    location: Option<String>,
    matter: String,
    tags: Vec<String>,
    visual_description: String,
    visual_tags: Vec<String>,
    visible_text: Vec<String>,
}

pub fn list_review_index_impl(destination: &str, workspace: &str) -> Result<Vec<ReviewSearchEntry>, String> {
    let mut index = Vec::new();
    for manifest in list_captures_impl(destination, workspace)? {
        for item in list_review_items_impl(destination, workspace, &manifest.capture_id)? {
            let decision = item.decision.as_ref();
            index.push(ReviewSearchEntry {
                capture_id: manifest.capture_id.clone(), asset_id: item.asset_id,
                status: decision.filter(|event| event.status != "pending").map(|event| event.status.clone()).unwrap_or_else(|| if item.organization.as_ref().is_some_and(|value| !value.requires_review) { "organized".into() } else { "pending".into() }),
                location: item.organization.as_ref().and_then(|value| value.location.clone()),
                matter: item.organization.as_ref().map(|value| value.matter.clone()).unwrap_or_default(),
                tags: item.organization.as_ref().map(|value| value.tags.clone()).unwrap_or_default(),
                visual_description: item.visual_analysis.as_ref().map(|analysis| analysis.description.clone()).unwrap_or_default(),
                visual_tags: item.visual_analysis.as_ref().map(|analysis| analysis.tags.clone()).unwrap_or_default(),
                visible_text: item.visual_analysis.map(|analysis| analysis.visible_text).unwrap_or_default(),
            });
        }
    }
    Ok(index)
}

fn load_capture(destination: &str, workspace: &str, capture_id: &str) -> Result<(PathBuf, Manifest), String> {
    let directory = capture_directory(destination, workspace, capture_id)?;
    let manifest = read_latest_manifest(&directory)?;
    if manifest.capture_id != capture_id || manifest.workspace_id != workspace {
        return Err("Captação fora do espaço selecionado".into());
    }
    Ok((directory, manifest))
}

fn read_events(directory: &Path, manifest: &Manifest) -> Result<HashMap<String, Vec<ReviewEvent>>, String> {
    let reviews_dir = directory.join("reviews");
    if !reviews_dir.exists() {
        return Ok(HashMap::new());
    }
    let mut files = fs::read_dir(&reviews_dir)
        .map_err(|e| e.to_string())?
        .map(|entry| entry.map(|entry| entry.path()).map_err(|e| e.to_string()))
        .collect::<Result<Vec<_>, _>>()?;
    files.retain(|path| path.extension().and_then(|ext| ext.to_str()) == Some("json"));
    files.sort();
    let mut by_asset: HashMap<String, Vec<ReviewEvent>> = HashMap::new();
    for path in files {
        let event: ReviewEvent = serde_json::from_slice(&fs::read(&path).map_err(|e| e.to_string())?)
            .map_err(|e| format!("Histórico de revisão inválido ({}): {e}", path.display()))?;
        if event.capture_id != manifest.capture_id
            || event.workspace_id != manifest.workspace_id
            || !manifest.assets.iter().any(|asset| asset.asset_id == event.asset_id)
        {
            return Err(format!("Revisão fora desta captação: {}", path.display()));
        }
        by_asset.entry(event.asset_id.clone()).or_default().push(event);
    }
    Ok(by_asset)
}

fn evidence_for(asset: &crate::ingest::Asset) -> Vec<Evidence> {
    let mut evidence = Vec::new();
    if let Some(metadata) = &asset.metadata {
        if let Some(value) = &metadata.recorded_at {
            evidence.push(Evidence { kind: "recorded_at".into(), label: "Data registrada".into(), value: value.clone(), source: "FFprobe".into() });
        }
        if let (Some(width), Some(height)) = (metadata.width, metadata.height) {
            evidence.push(Evidence { kind: "resolution".into(), label: "Resolução".into(), value: format!("{width} × {height}"), source: "FFprobe".into() });
        }
        if let Some(duration) = metadata.duration_seconds {
            evidence.push(Evidence { kind: "duration".into(), label: "Duração".into(), value: format!("{duration:.1} s"), source: "FFprobe".into() });
        }
        if let Some(value) = &metadata.video_codec {
            evidence.push(Evidence { kind: "codec".into(), label: "Codec".into(), value: value.clone(), source: "FFprobe".into() });
        }
        if let Some(gps) = &metadata.gps {
            evidence.push(Evidence { kind: "gps".into(), label: "GPS embutido".into(), value: format!("{:.5}, {:.5}", gps.latitude, gps.longitude), source: "Metadados da mídia".into() });
        }
        if let Some(label) = &metadata.location_label {
            evidence.push(Evidence { kind: "location_label".into(), label: "Nome de local embutido".into(), value: label.clone(), source: "Metadados da mídia".into() });
        }
    }
    evidence
}

fn telemetry_values(text: &str, markers: &[&str]) -> Vec<f64> {
    let lower = text.to_ascii_lowercase();
    let mut values = Vec::new();
    for marker in markers {
        let mut offset = 0;
        while let Some(found) = lower[offset..].find(marker) {
            let after = offset + found + marker.len();
            let candidate = lower[after..].trim_start();
            let number = candidate.trim_start_matches(['+', '-']);
            let digits = number.chars().take_while(|c| c.is_ascii_digit() || *c == '.').count();
            let sign = candidate.len() - number.len();
            if let Ok(value) = candidate[..sign + digits].parse::<f64>() {
                values.push(value);
            }
            offset = after;
        }
    }
    values
}

fn telemetry_track(text: &str) -> Option<((f64, f64), (f64, f64), (f64, f64))> {
    let latitudes = telemetry_values(text, &["latitude:", "lat:"]);
    let longitudes = telemetry_values(text, &["longitude:", "lon:"]);
    let valid = latitudes.into_iter().zip(longitudes).filter(|(lat, lon)| media::valid_gps(*lat, *lon).is_some()).collect::<Vec<_>>();
    let first = *valid.first()?;
    let last = *valid.last()?;
    let farthest = *valid.iter().max_by(|left, right| {
        distance_meters(first, **left).total_cmp(&distance_meters(first, **right))
    })?;
    Some((first, last, farthest))
}

fn matching_sidecar<'a>(asset: &Asset, assets: &'a [Asset]) -> Option<&'a Asset> {
    let path = Path::new(&asset.original_relative_path);
    assets.iter().find(|candidate| {
        let sidecar = Path::new(&candidate.original_relative_path);
        candidate.status == "verified"
            && sidecar.extension().and_then(|ext| ext.to_str()).is_some_and(|ext| ext.eq_ignore_ascii_case("srt"))
            && sidecar.file_stem().and_then(|stem| stem.to_str()).zip(path.file_stem().and_then(|stem| stem.to_str()))
                .is_some_and(|(left, right)| left.eq_ignore_ascii_case(right))
            && sidecar.parent().map(|parent| parent.to_string_lossy().to_ascii_lowercase())
                == path.parent().map(|parent| parent.to_string_lossy().to_ascii_lowercase())
    })
}

fn sidecar_track(directory: &Path, asset: &Asset, assets: &[Asset]) -> Option<((f64, f64), (f64, f64), (f64, f64), String)> {
    if media::kind_for(Path::new(&asset.original_name)) != "video" { return None; }
    let sidecar = matching_sidecar(asset, assets)?;
    let originals = fs::canonicalize(directory.join("originals")).ok()?;
    let path = fs::canonicalize(directory.join(&sidecar.copy_relative_path)).ok()?;
    if !path.starts_with(originals) || fs::metadata(&path).ok()?.len() > 8_000_000 { return None; }
    let bytes = fs::read(path).ok()?;
    let (first, last, farthest) = telemetry_track(&String::from_utf8_lossy(&bytes))?;
    Some((first, last, farthest, sidecar.original_name.clone()))
}

fn sidecar_evidence(directory: &Path, asset: &Asset, assets: &[Asset]) -> Option<Evidence> {
    let ((first_lat, first_lon), (last_lat, last_lon), farthest, source) = sidecar_track(directory, asset, assets)?;
    Some(Evidence {
        kind: "drone_track".into(), label: "Trajeto GPS do drone".into(),
        value: format!("início {first_lat:.5}, {first_lon:.5} → fim {last_lat:.5}, {last_lon:.5}; maior afastamento {:.0} m", distance_meters((first_lat, first_lon), farthest)),
        source,
    })
}

fn asset_points(directory: &Path, asset: &Asset, assets: &[Asset]) -> Vec<(f64, f64)> {
    if let Some(gps) = asset.metadata.as_ref().and_then(|metadata| metadata.gps.as_ref()) {
        return vec![(gps.latitude, gps.longitude)];
    }
    sidecar_track(directory, asset, assets)
        .map(|(first, last, farthest, _)| vec![first, farthest, last]).unwrap_or_default()
}

fn distance_meters(a: (f64, f64), b: (f64, f64)) -> f64 {
    let lat_delta = (b.0 - a.0).to_radians();
    let lon_delta = (b.1 - a.1).to_radians();
    let lat_a = a.0.to_radians();
    let lat_b = b.0.to_radians();
    let haversine = (lat_delta / 2.0).sin().powi(2)
        + lat_a.cos() * lat_b.cos() * (lon_delta / 2.0).sin().powi(2);
    6_371_000.0 * 2.0 * haversine.sqrt().asin()
}

fn span_meters(points: &[(f64, f64)]) -> f64 {
    points.first().map(|first| points.iter().map(|point| distance_meters(*first, *point))
        .fold(0.0_f64, f64::max)).unwrap_or(0.0)
}

struct LocationAnchor {
    asset_id: String,
    location: String,
    sha256: Option<String>,
    points: Vec<(f64, f64)>,
}

fn normalized_words(value: &str) -> Vec<String> {
    value.to_lowercase().chars().map(|c| match c {
        'á' | 'à' | 'â' | 'ã' | 'ä' => 'a',
        'é' | 'ê' | 'è' | 'ë' => 'e',
        'í' | 'ì' | 'î' | 'ï' => 'i',
        'ó' | 'ò' | 'ô' | 'õ' | 'ö' => 'o',
        'ú' | 'ù' | 'û' | 'ü' => 'u',
        'ç' => 'c',
        other if other.is_ascii_alphanumeric() => other,
        _ => ' ',
    }).collect::<String>().split_whitespace().map(str::to_owned).collect()
}

fn suggestion_for(asset: &Asset, locations: &[String], anchors: &[LocationAnchor], points: &[(f64, f64)]) -> Option<Suggestion> {
    if let Some(hash) = asset.sha256.as_ref() {
        let matching = anchors.iter().filter(|anchor| anchor.asset_id != asset.asset_id && anchor.sha256.as_ref() == Some(hash)).collect::<Vec<_>>();
        if let Some(first) = matching.first() {
            if matching.iter().all(|anchor| anchor.location == first.location) {
                return Some(Suggestion {
                    location: Some(first.location.clone()), matter: None, tags: Vec::new(), confidence: Some(0.98),
                    reason: "Esta mídia tem o mesmo SHA-256 de outra cópia cujo local foi confirmado por um editor. A decisão ainda precisa ser conferida para este take.".into(),
                    analyzer_version: "local-evidence-v1".into(),
                });
            }
        }
    }
    if let Some(label) = asset.metadata.as_ref().and_then(|metadata| metadata.location_label.as_ref()) {
        return Some(Suggestion {
            location: Some(label.clone()), matter: None, tags: Vec::new(), confidence: Some(0.85),
            reason: "O arquivo contém um nome de local nos metadados. Confirme se a câmera registrou o lugar correto.".into(),
            analyzer_version: "local-evidence-v1".into(),
        });
    }
    let filename = normalized_words(&asset.original_name);
    let matches = locations.iter().filter(|location| {
        let words = normalized_words(location);
        !words.is_empty() && filename.windows(words.len()).any(|window| window == words.as_slice())
    }).collect::<Vec<_>>();
    if matches.len() == 1 {
        return Some(Suggestion {
            location: Some((*matches[0]).clone()), matter: None, tags: Vec::new(), confidence: Some(0.65),
            reason: "O nome deste arquivo menciona exatamente um dos locais informados para a captação. Isso é uma pista textual, não confirmação visual ou por GPS.".into(),
            analyzer_version: "local-evidence-v1".into(),
        });
    }
    if matches.len() > 1 || points.is_empty() || span_meters(points) > 300.0 {
        return None;
    }
    let nearby = anchors.iter().filter_map(|anchor| {
        if anchor.asset_id == asset.asset_id || anchor.points.is_empty()
            || span_meters(&anchor.points) > 300.0 {
            return None;
        }
        let distance = points.iter().map(|point| distance_meters(*point, anchor.points[0]))
            .fold(0.0_f64, f64::max);
        (distance <= 300.0).then_some((anchor, distance))
    }).collect::<Vec<_>>();
    let first = nearby.first()?;
    if nearby.iter().any(|(anchor, _)| anchor.location != first.0.location) { return None; }
    let nearest = nearby.iter().map(|(_, distance)| *distance).fold(f64::INFINITY, f64::min);
    Some(Suggestion {
        location: Some(first.0.location.clone()), matter: None, tags: Vec::new(), confidence: Some(0.8),
        reason: format!("GPS a cerca de {nearest:.0} m de outra mídia da captação cujo local foi confirmado por um editor. Proximidade não prova que as imagens mostram o mesmo lugar."),
        analyzer_version: "local-evidence-v1".into(),
    })
}

pub fn list_review_items_impl(destination: &str, workspace: &str, capture_id: &str) -> Result<Vec<ReviewItem>, String> {
    let (directory, manifest) = load_capture(destination, workspace, capture_id)?;
    let mut events = read_events(&directory, &manifest)?;
    let anchors = manifest.assets.iter().filter_map(|asset| {
        let decision = events.get(&asset.asset_id)?.last()?;
        if decision.status != "confirmed" || asset.status != "verified" { return None; }
        Some(LocationAnchor {
            asset_id: asset.asset_id.clone(), location: decision.location.clone()?,
            sha256: asset.sha256.clone(), points: asset_points(&directory, asset, &manifest.assets),
        })
    }).collect::<Vec<_>>();
    Ok(manifest.assets.iter()
        .filter(|asset| asset.status == "verified" && media::kind_for(Path::new(&asset.original_name)) != "sidecar")
        .map(|asset| {
            let history = events.remove(&asset.asset_id).unwrap_or_default();
            let points = asset_points(&directory, asset, &manifest.assets);
            let visual_result = crate::ai::load_analysis(&directory, &manifest, asset);
            let visual_error = visual_result.as_ref().err().cloned();
            let visual_analysis = visual_result.ok().flatten();
            let suggestion = if history.last().is_some_and(|event| event.status != "pending") {
                None
            } else {
                suggestion_for(asset, &manifest.visited_locations, &anchors, &points).map(|mut suggestion| {
                    if let Some(analysis) = &visual_analysis { suggestion.tags = analysis.tags.clone(); }
                    suggestion
                }).or_else(|| {
                    let analysis = visual_analysis.as_ref()?;
                    Some(Suggestion { location: Some(analysis.location.clone()?), matter: None, tags: analysis.tags.clone(), confidence: None,
                        reason: format!("Sugestão visual do {} em {} quadro(s): {}. Ainda precisa de confirmação humana.", analysis.model, analysis.frame_times_seconds.len(), analysis.location_reason), analyzer_version: "qwen3-vl-local-v1".into() })
                })
            };
            let organization = organization_for(&asset.asset_id, history.last(), visual_analysis.as_ref());
            ReviewItem {
                organization,
                asset_id: asset.asset_id.clone(),
                original_name: asset.original_name.clone(),
                evidence: {
                    let mut evidence = evidence_for(asset);
                    if let Some(sidecar) = sidecar_evidence(&directory, asset, &manifest.assets) {
                        evidence.push(sidecar);
                    }
                    if let Some(analysis) = &visual_analysis {
                        evidence.push(Evidence { kind: "visual_description".into(), label: "Descrição visual (IA local)".into(), value: analysis.description.clone(), source: format!("{} · {} quadro(s)", analysis.model, analysis.frame_times_seconds.len()) });
                        if !analysis.visible_text.is_empty() { evidence.push(Evidence { kind: "visual_text".into(), label: "Texto visível sugerido (OCR)".into(), value: analysis.visible_text.join(" · "), source: analysis.model.clone() }); }
                    }
                    if let Some(error) = visual_error { evidence.push(Evidence { kind: "visual_error".into(), label: "Registro visual indisponível".into(), value: error, source: "Análise local".into() }); }
                    evidence
                },
                visual_analysis,
                suggestion,
                decision: history.last().cloned(),
                history,
            }
        })
        .collect())
}

pub fn save_review_impl(
    destination: &str,
    workspace: &str,
    capture_id: &str,
    asset_id: &str,
    status: &str,
    location: Option<String>,
    matter: &str,
    tags: Vec<String>,
    note: &str,
) -> Result<ReviewItem, String> {
    save_review_with_category_impl(destination, workspace, capture_id, asset_id, status, location, matter, tags, note, "")
}

pub fn save_review_with_category_impl(
    destination: &str,
    workspace: &str,
    capture_id: &str,
    asset_id: &str,
    status: &str,
    location: Option<String>,
    matter: &str,
    tags: Vec<String>,
    note: &str,
    category: &str,
) -> Result<ReviewItem, String> {
    Uuid::parse_str(asset_id).map_err(|_| "ID de arquivo inválido".to_string())?;
    let (directory, manifest) = load_capture(destination, workspace, capture_id)?;
    if !manifest.assets.iter().any(|asset| asset.asset_id == asset_id && asset.status == "verified" && media::kind_for(Path::new(&asset.original_name)) != "sidecar") {
        return Err("Arquivo não revisável nesta captação".into());
    }
    if !matches!(status, "confirmed" | "unidentified" | "pending") {
        return Err("Estado de revisão inválido".into());
    }
    let location = location.map(|value| value.trim().to_string()).filter(|value| !value.is_empty());
    if location.as_ref().is_some_and(|value| value.len() > 120) || matter.trim().len() > 120 || note.trim().len() > 1000 || category.trim().len() > 120 {
        return Err("Local, matéria ou observação excede o limite permitido".into());
    }
    if status == "confirmed" && location.is_none() {
        return Err("Informe um local para confirmar este take".into());
    }
    if status != "confirmed" && location.is_some() {
        return Err("Use confirmação para salvar um local, ou deixe o local vazio".into());
    }
    if tags.len() > 20 || tags.iter().any(|tag| tag.trim().is_empty() || tag.trim().len() > 50) {
        return Err("Informe até 20 tags, com no máximo 50 caracteres cada".into());
    }
    let matter = matter.trim();
    let note = note.trim();
    let tags = tags.into_iter().map(|tag| tag.trim().to_string()).collect::<Vec<_>>();
    if let Some(current) = list_review_items_impl(destination, workspace, capture_id)?
        .into_iter().find(|item| item.asset_id == asset_id)
    {
        if let Some(decision) = &current.decision {
            if decision.status == status && decision.location == location
                && decision.matter == matter && decision.tags == tags && decision.note == note && decision.category == category.trim()
            {
                return Ok(current);
            }
        }
    }
    let event_id = Uuid::new_v4().to_string();
    let now = Utc::now();
    let event = ReviewEvent {
        event_id: event_id.clone(),
        category: category.trim().to_string(),
        capture_id: capture_id.into(),
        workspace_id: workspace.into(),
        asset_id: asset_id.into(),
        status: status.into(),
        location,
        matter: matter.into(),
        tags,
        note: note.into(),
        reviewed_at: now.to_rfc3339(),
    };
    let reviews_dir = directory.join("reviews");
    fs::create_dir_all(&reviews_dir).map_err(|e| e.to_string())?;
    let filename = format!("{}-{event_id}.json", now.format("%Y%m%dT%H%M%S%9fZ"));
    let final_path = reviews_dir.join(filename);
    let partial_path = final_path.with_extension("partial");
    let bytes = serde_json::to_vec_pretty(&event).map_err(|e| e.to_string())?;
    let mut writer = OpenOptions::new().write(true).create_new(true).open(&partial_path).map_err(|e| e.to_string())?;
    writer.write_all(&bytes).map_err(|e| e.to_string())?;
    writer.sync_all().map_err(|e| e.to_string())?;
    drop(writer);
    fs::rename(&partial_path, &final_path).map_err(|e| e.to_string())?;
    list_review_items_impl(destination, workspace, capture_id)?
        .into_iter().find(|item| item.asset_id == asset_id)
        .ok_or_else(|| "Revisão salva, mas o arquivo não foi encontrado na leitura".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ingest::ingest_capture_impl;

    #[test]
    fn review_is_append_only_and_does_not_change_origin() {
        let root = std::env::temp_dir().join(format!("lumen-review-test-{}", Uuid::new_v4()));
        let source = root.join("card");
        let destination = root.join("archive");
        fs::create_dir_all(&source).unwrap();
        fs::create_dir_all(&destination).unwrap();
        fs::write(source.join("C001.MP4"), b"test media").unwrap();
        let capture = ingest_capture_impl(source.to_str().unwrap(), destination.to_str().unwrap(), "personal", "Praias", "Teste", vec![], None).unwrap();
        let asset_id = capture.assets[0].asset_id.clone();
        let initial = list_review_items_impl(destination.to_str().unwrap(), "personal", &capture.capture_id).unwrap();
        assert!(initial[0].suggestion.is_none());
        assert!(initial[0].decision.is_none());
        let first = save_review_impl(destination.to_str().unwrap(), "personal", &capture.capture_id, &asset_id, "confirmed", Some("Praia do Morro".into()), "Verão", vec!["praia".into()], "Confirmado pelo editor").unwrap();
        assert_eq!(first.decision.as_ref().unwrap().location.as_deref(), Some("Praia do Morro"));
        let second = save_review_impl(destination.to_str().unwrap(), "personal", &capture.capture_id, &asset_id, "unidentified", None, "Verão", vec!["mar".into()], "Local incerto").unwrap();
        assert_eq!(second.history.len(), 2);
        assert_eq!(second.decision.as_ref().unwrap().status, "unidentified");
        let same = save_review_impl(destination.to_str().unwrap(), "personal", &capture.capture_id, &asset_id, "unidentified", None, "Verão", vec!["mar".into()], "Local incerto").unwrap();
        assert_eq!(same.history.len(), 2);
        let index = list_review_index_impl(destination.to_str().unwrap(), "personal").unwrap();
        assert_eq!(index.len(), 1);
        assert_eq!(index[0].tags, vec!["mar"]);
        assert_eq!(fs::read(source.join("C001.MP4")).unwrap(), b"test media");
        assert!(save_review_impl(destination.to_str().unwrap(), "personal", &capture.capture_id, &asset_id, "confirmed", None, "", vec![], "").is_err());
        assert!(list_review_items_impl(destination.to_str().unwrap(), "other", &capture.capture_id).is_err());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn suggests_only_when_filename_identifies_one_location_and_shows_drone_track() {
        let root = std::env::temp_dir().join(format!("lumen-evidence-test-{}", Uuid::new_v4()));
        let source = root.join("card");
        let destination = root.join("archive");
        fs::create_dir_all(&source).unwrap();
        fs::create_dir_all(&destination).unwrap();
        fs::write(source.join("Shopping_Vitoria_C001.MP4"), b"video test").unwrap();
        fs::write(source.join("Shopping_Vitoria_C001.SRT"),
            "1\n00:00:00,000 --> 00:00:01,000\n[latitude: -20.29001] [longitude: -40.29002]\n\n2\n00:00:01,000 --> 00:00:02,000\n[latitude: -20.29111] [longitude: -40.29112]").unwrap();
        fs::write(source.join("C001.MP4"), b"another video").unwrap();
        let capture = ingest_capture_impl(source.to_str().unwrap(), destination.to_str().unwrap(), "personal", "Teste", "", vec!["Shopping Vitória".into(), "Praia do Morro".into()], None).unwrap();
        let items = list_review_items_impl(destination.to_str().unwrap(), "personal", &capture.capture_id).unwrap();
        let named = items.iter().find(|item| item.original_name == "Shopping_Vitoria_C001.MP4").unwrap();
        assert_eq!(named.suggestion.as_ref().unwrap().location.as_deref(), Some("Shopping Vitória"));
        assert!(named.evidence.iter().any(|evidence| evidence.kind == "drone_track" && evidence.value.contains("-20.29111")));
        let unnamed = items.iter().find(|item| item.original_name == "C001.MP4").unwrap();
        assert!(unnamed.suggestion.is_none());
        assert!(!unnamed.evidence.iter().any(|evidence| evidence.kind == "drone_track"));
        assert_eq!(fs::read(source.join("Shopping_Vitoria_C001.MP4")).unwrap(), b"video test");
        fs::remove_dir_all(root).unwrap();
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct OrganizationApproval {
    approval_id: String,
    capture_id: String,
    workspace_id: String,
    approved_at: String,
    decisions: Vec<ReviewEvent>,
}

fn current_approval_decisions(destination: &str, workspace: &str, capture_id: &str) -> Result<Vec<ReviewEvent>, String> {
    let (_, manifest) = load_capture(destination, workspace, capture_id)?;
    if manifest.assets.iter().any(|asset| asset.status != "verified" && media::kind_for(Path::new(&asset.original_name)) != "sidecar") {
        return Err("Há mídias com falha de cópia. Resolva essas falhas antes de aprovar a organização.".into());
    }
    let items = list_review_items_impl(destination, workspace, capture_id)?;
    if items.is_empty() { return Err("Não há mídias verificadas para aprovar.".into()); }
    let mut decisions = Vec::new();
    for item in items {
        let proposal = item.organization.as_ref().filter(|value| !value.requires_review)
            .ok_or("Ainda há takes sem organização ou com exceções. Execute a IA e confira somente as exceções antes de aprovar.")?;
        if let Some(decision) = item.decision.filter(|event| event.status != "pending") {
            decisions.push(decision);
        } else {
            // This snapshot records AI organization, never a fabricated human confirmation.
            decisions.push(ReviewEvent { event_id: proposal.event_id.clone(), capture_id: capture_id.into(), workspace_id: workspace.into(),
                asset_id: item.asset_id.clone(), category: proposal.category.clone(), status: "ai_organized".into(), location: proposal.location.clone(), matter: proposal.matter.clone(), tags: proposal.tags.clone(),
                note: format!("Grupo: {}. Organização automática por Qwen3-VL; local não confirmado por pessoa.", proposal.category),
                reviewed_at: item.visual_analysis.as_ref().map(|analysis| analysis.analyzed_at.clone()).unwrap_or_default() });
        }
    }
    decisions.sort_by(|left, right| left.asset_id.cmp(&right.asset_id));
    Ok(decisions)
}

pub fn get_organization_approval_impl(destination: &str, workspace: &str, capture_id: &str) -> Result<Option<OrganizationApproval>, String> {
    let (directory, _) = load_capture(destination, workspace, capture_id)?;
    let approvals = directory.join("organization-approvals");
    if !approvals.exists() { return Ok(None); }
    let current = match current_approval_decisions(destination, workspace, capture_id) {
        Ok(decisions) => decisions,
        Err(_) => return Ok(None),
    };
    let mut paths = fs::read_dir(approvals).map_err(|error| error.to_string())?
        .map(|entry| entry.map(|entry| entry.path()).map_err(|error| error.to_string()))
        .collect::<Result<Vec<_>, _>>()?;
    paths.retain(|path| path.extension().and_then(|extension| extension.to_str()) == Some("json"));
    paths.sort();
    let Some(path) = paths.last() else { return Ok(None); };
    let saved: OrganizationApproval = serde_json::from_slice(&fs::read(path).map_err(|error| error.to_string())?)
        .map_err(|error| format!("Registro de aprovação inválido: {error}"))?;
    if saved.capture_id != capture_id || saved.workspace_id != workspace {
        return Err("A aprovação não pertence a esta captação e espaço.".into());
    }
    let mut saved_ids = saved.decisions.iter().map(|event| event.event_id.as_str()).collect::<Vec<_>>();
    let mut current_ids = current.iter().map(|event| event.event_id.as_str()).collect::<Vec<_>>();
    saved_ids.sort(); current_ids.sort();
    Ok((saved_ids == current_ids).then_some(saved))
}

pub fn approve_organization_impl(destination: &str, workspace: &str, capture_id: &str, mut expected_event_ids: Vec<String>) -> Result<OrganizationApproval, String> {
    let (directory, _) = load_capture(destination, workspace, capture_id)?;
    let decisions = current_approval_decisions(destination, workspace, capture_id)?;
    let mut current_ids = decisions.iter().map(|event| event.event_id.clone()).collect::<Vec<_>>();
    current_ids.sort(); expected_event_ids.sort();
    if current_ids != expected_event_ids {
        return Err("A revisão foi alterada. Atualize os takes e confira antes de aprovar.".into());
    }
    if let Some(saved) = get_organization_approval_impl(destination, workspace, capture_id)? { return Ok(saved); }
    let now = Utc::now();
    let approval = OrganizationApproval {
        approval_id: Uuid::new_v4().to_string(), capture_id: capture_id.into(), workspace_id: workspace.into(),
        approved_at: now.to_rfc3339(), decisions,
    };
    let approvals = directory.join("organization-approvals");
    fs::create_dir_all(&approvals).map_err(|error| error.to_string())?;
    let path = approvals.join(format!("{}-{}.json", now.format("%Y%m%dT%H%M%S%9fZ"), approval.approval_id));
    let partial = path.with_extension("partial");
    let bytes = serde_json::to_vec_pretty(&approval).map_err(|error| error.to_string())?;
    let mut writer = OpenOptions::new().write(true).create_new(true).open(&partial).map_err(|error| error.to_string())?;
    writer.write_all(&bytes).map_err(|error| error.to_string())?;
    writer.sync_all().map_err(|error| error.to_string())?;
    drop(writer);
    fs::rename(partial, path).map_err(|error| error.to_string())?;
    Ok(approval)
}

#[path = "export.rs"]
pub mod export;
