// A release must embed the frontend instead of loading the Vite development URL.
#[cfg(not(debug_assertions))]
const _: () = assert!(
    !tauri::is_dev(),
    "Release sem interface embutida. Use npm run build:desktop (Tauri CLI)."
);
mod ai;
mod ingest;
mod media;
mod preview;
mod review;
mod source;

use ingest::{reprocess_capture_impl, thumbnail_data_url_impl, Manifest};
use preview::{create_preview_impl, PreviewDescriptor, PreviewState};
use review::{
    list_review_index_impl, list_review_items_impl, save_review_with_category_impl, ReviewItem,
    ReviewSearchEntry,
};
use std::sync::Arc;
use tauri::Emitter;

#[derive(Default)]
struct IngestState(std::sync::Mutex<()>);

#[tauri::command]
async fn get_ollama_status() -> Result<ai::OllamaStatus, String> {
    tauri::async_runtime::spawn_blocking(ai::status_impl)
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
async fn analyze_visual_asset(
    state: tauri::State<'_, Arc<ai::AiState>>,
    destination: String,
    workspace: String,
    capture_id: String,
    asset_id: String,
    force: bool,
    detailed: Option<bool>,
) -> Result<ai::VisualAnalysis, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = state.0.try_lock().map_err(|_| {
            "Já há uma análise visual em andamento. Aguarde este take terminar.".to_string()
        })?;
        ai::analyze_asset_impl(
            &destination,
            &workspace,
            &capture_id,
            &asset_id,
            force,
            detailed.unwrap_or(false),
        )
    })
    .await
    .map_err(|error| format!("Falha na análise visual: {error}"))?
}

#[tauri::command]
async fn get_organization_approval(
    destination: String,
    workspace: String,
    capture_id: String,
) -> Result<Option<review::OrganizationApproval>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        review::get_organization_approval_impl(&destination, &workspace, &capture_id)
    })
    .await
    .map_err(|error| format!("Falha ao ler aprovação: {error}"))?
}

#[tauri::command]
async fn approve_organization(
    destination: String,
    workspace: String,
    capture_id: String,
    expected_event_ids: Vec<String>,
) -> Result<review::OrganizationApproval, String> {
    tauri::async_runtime::spawn_blocking(move || {
        review::approve_organization_impl(&destination, &workspace, &capture_id, expected_event_ids)
    })
    .await
    .map_err(|error| format!("Falha ao aprovar organização: {error}"))?
}

#[tauri::command]
async fn revoke_organization(
    destination: String,
    workspace: String,
    capture_id: String,
    expected_approval_id: String,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        review::revoke_organization_impl(
            &destination,
            &workspace,
            &capture_id,
            &expected_approval_id,
        )
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
async fn restore_previous_review(
    destination: String,
    workspace: String,
    capture_id: String,
    asset_id: String,
) -> Result<ReviewItem, String> {
    tauri::async_runtime::spawn_blocking(move || {
        review::restore_previous_review_impl(&destination, &workspace, &capture_id, &asset_id)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
async fn save_review_batch(
    destination: String,
    workspace: String,
    capture_id: String,
    change: review::BatchReviewChange,
) -> Result<Vec<ReviewItem>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        review::save_review_batch_impl(&destination, &workspace, &capture_id, change)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
async fn plan_organized_export(
    destination: String,
    workspace: String,
    capture_id: String,
) -> Result<review::export::ExportPlan, String> {
    tauri::async_runtime::spawn_blocking(move || {
        review::export::plan(&destination, &workspace, &capture_id)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
async fn export_organized_files(
    app: tauri::AppHandle,
    destination: String,
    workspace: String,
    capture_id: String,
    expected_approval_id: String,
) -> Result<review::export::ExportResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        review::export::export(
            &destination,
            &workspace,
            &capture_id,
            &expected_approval_id,
            |progress| {
                let _ = app.emit("organized-export-progress", progress);
            },
        )
    })
    .await
    .map_err(|error| format!("Falha ao criar pastas: {error}"))?
}

#[tauri::command]
async fn list_source_devices() -> Result<Vec<source::SourceDevice>, String> {
    tauri::async_runtime::spawn_blocking(source::list_source_devices_impl)
        .await
        .map_err(|error| format!("Falha ao detectar dispositivos: {error}"))?
}

#[tauri::command]
async fn inspect_source(source: String) -> Result<source::SourceInventory, String> {
    tauri::async_runtime::spawn_blocking(move || source::inspect_source_impl(&source))
        .await
        .map_err(|error| format!("Falha ao analisar a origem: {error}"))?
}

#[tauri::command]
async fn ingest_capture(
    app: tauri::AppHandle,
    state: tauri::State<'_, Arc<IngestState>>,
    source: String,
    destination: String,
    workspace: String,
    capture_name: String,
    brief: String,
    team: String,
    visited_locations: Vec<String>,
    tools_directory: Option<String>,
) -> Result<Manifest, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = state
            .0
            .try_lock()
            .map_err(|_| "Já há uma ingestão em andamento.".to_string())?;
        ingest::ingest_capture_with_progress_impl(
            &source,
            &destination,
            &workspace,
            &capture_name,
            &brief,
            &team,
            visited_locations,
            tools_directory.as_deref(),
            &|progress| {
                let _ = app.emit("ingest-progress", progress);
            },
        )
    })
    .await
    .map_err(|error| format!("Falha na tarefa de ingestão: {error}"))?
}

#[tauri::command]
async fn resume_ingest(
    app: tauri::AppHandle,
    state: tauri::State<'_, Arc<IngestState>>,
    destination: String,
    workspace: String,
    capture_id: String,
) -> Result<Manifest, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = state
            .0
            .try_lock()
            .map_err(|_| "Já há uma ingestão em andamento.".to_string())?;
        ingest::resume_ingest_with_progress_impl(
            &destination,
            &workspace,
            &capture_id,
            &|progress| {
                let _ = app.emit("ingest-progress", progress);
            },
        )
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
async fn thumbnail_data_url(
    destination: String,
    workspace: String,
    capture_id: String,
    asset_id: String,
) -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        thumbnail_data_url_impl(&destination, &workspace, &capture_id, &asset_id)
    })
    .await
    .map_err(|error| format!("Falha ao abrir miniatura: {error}"))?
}

#[tauri::command]
async fn list_captures(
    destination: String,
    workspace: String,
) -> Result<ingest::CaptureCatalog, String> {
    tauri::async_runtime::spawn_blocking(move || {
        ingest::list_capture_catalog_impl(&destination, &workspace)
    })
    .await
    .map_err(|error| format!("Falha ao listar captações: {error}"))?
}

#[tauri::command]
async fn reprocess_capture(
    destination: String,
    workspace: String,
    capture_id: String,
) -> Result<Manifest, String> {
    tauri::async_runtime::spawn_blocking(move || {
        reprocess_capture_impl(&destination, &workspace, &capture_id)
    })
    .await
    .map_err(|error| format!("Falha ao reprocessar captação: {error}"))?
}

#[tauri::command]
async fn list_review_items(
    destination: String,
    workspace: String,
    capture_id: String,
) -> Result<Vec<ReviewItem>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        list_review_items_impl(&destination, &workspace, &capture_id)
    })
    .await
    .map_err(|error| format!("Falha ao carregar revisão: {error}"))?
}

#[tauri::command]
async fn list_review_index(
    destination: String,
    workspace: String,
) -> Result<Vec<ReviewSearchEntry>, String> {
    tauri::async_runtime::spawn_blocking(move || list_review_index_impl(&destination, &workspace))
        .await
        .map_err(|error| format!("Falha ao indexar revisões: {error}"))?
}

#[tauri::command]
async fn create_preview(
    state: tauri::State<'_, Arc<PreviewState>>,
    destination: String,
    workspace: String,
    capture_id: String,
    asset_id: String,
) -> Result<PreviewDescriptor, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        create_preview_impl(&state, &destination, &workspace, &capture_id, &asset_id)
    })
    .await
    .map_err(|error| format!("Falha ao preparar prévia: {error}"))?
}

#[tauri::command]
async fn save_review(
    destination: String,
    workspace: String,
    capture_id: String,
    asset_id: String,
    status: String,
    location: Option<String>,
    matter: String,
    tags: Vec<String>,
    note: String,
    category: Option<String>,
) -> Result<ReviewItem, String> {
    tauri::async_runtime::spawn_blocking(move || {
        save_review_with_category_impl(
            &destination,
            &workspace,
            &capture_id,
            &asset_id,
            &status,
            location,
            &matter,
            tags,
            &note,
            category.as_deref().unwrap_or(""),
        )
    })
    .await
    .map_err(|error| format!("Falha ao salvar revisão: {error}"))?
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let preview_state = Arc::new(PreviewState::default());
    let protocol_state = preview_state.clone();
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(preview_state)
        .manage(Arc::new(ai::AiState::default()))
        .manage(Arc::new(IngestState::default()))
        .register_asynchronous_uri_scheme_protocol(
            "lumen-media",
            move |_context, request, responder| {
                responder.respond(preview::respond(&protocol_state, request));
            },
        )
        .invoke_handler(tauri::generate_handler![
            get_ollama_status,
            analyze_visual_asset,
            get_organization_approval,
            approve_organization,
            revoke_organization,
            restore_previous_review,
            save_review_batch,
            plan_organized_export,
            export_organized_files,
            list_source_devices,
            inspect_source,
            ingest_capture,
            resume_ingest,
            list_captures,
            reprocess_capture,
            list_review_items,
            list_review_index,
            create_preview,
            save_review,
            thumbnail_data_url
        ])
        .run(tauri::generate_context!())
        .expect("Falha ao iniciar o Lumen Desktop");
}
