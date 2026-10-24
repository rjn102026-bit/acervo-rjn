import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import navIdle from "./assets/nav-idle.svg";
import navActive from "./assets/nav-active.svg";

type OllamaStatus = { running: boolean; model_ready: boolean; model: string; message: string };
type OrganizationProposal = { event_id: string; category: string; matter: string; tags: string[]; location: string | null; source: "ai" | "human"; requires_review: boolean; reason: string };
type VisualAnalysis = { model: string; analyzed_at: string; description: string; category: string; matter: string; needs_review: boolean; review_reason: string; visible_text: string[]; tags: string[]; location: string | null; location_reason: string; frame_times_seconds: number[] };
type AiProgress = { total: number; done: number; succeeded: number; current: string; errors: string[]; cancelled: boolean };

type SourceDevice = { path: string; label: string; capacity_bytes: number; free_bytes: number };
type SourceInventory = { path: string; videos: number; images: number; sidecars: number; total_bytes: number; ignored_files: number; unreadable_entries: number; partial: boolean };

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length);
  return `${(bytes / 1024 ** exponent).toLocaleString("pt-BR", { maximumFractionDigits: 1 })} ${units[exponent - 1]}`;
}

type Asset = {
  asset_id: string;
  original_name: string;
  original_relative_path: string;
  copy_relative_path: string;
  status: string;
  size_bytes?: number;
  error?: string;
  metadata?: {
    kind: string;
    duration_seconds?: number;
    width?: number;
    height?: number;
    video_codec?: string;
    recorded_at?: string;
  };
  thumbnail_relative_path?: string;
  processing_error?: string;
};

type Manifest = {
  capture_id: string;
  workspace_id: string;
  capture_name: string;
  brief: string;
  visited_locations: string[];
  created_at: string;
  verified_count: number;
  failed_count: number;
  assets: Asset[];
  manifest_path: string;
};

type ReviewEvent = {
  event_id: string;
  status: "confirmed" | "unidentified" | "pending";
  location: string | null;
  matter: string;
  tags: string[];
  note: string;
  reviewed_at: string;
  category?: string;
};

type ReviewItem = {
  asset_id: string;
  original_name: string;
  evidence: { kind: string; label: string; value: string; source: string }[];
  suggestion: { location: string | null; matter: string | null; tags: string[]; confidence: number | null; reason: string } | null;
  decision: ReviewEvent | null;
  history: ReviewEvent[];
  visual_analysis?: VisualAnalysis | null;
  organization?: OrganizationProposal | null;
};

type ReviewSearchEntry = {
  capture_id: string;
  asset_id: string;
  status: ReviewEvent["status"] | "organized";
  location: string | null;
  matter: string;
  tags: string[];
  visual_description?: string;
  visual_tags?: string[];
  visible_text?: string[];
};

type OrganizationApproval = { approval_id: string; approved_at: string; decisions: ReviewEvent[] };

type ExportPlan = { approval_id: string; output_directory: string; total_bytes: number; files: { asset_id: string; original_name: string; relative_path: string; bytes: number }[] };
type ExportResult = { approval_id: string; output_directory: string; copied: number; reused: number; errors: string[]; report_path: string; approval_current: boolean };
type ExportProgress = { approval_id: string; done: number; total: number; current: string };

type PreviewDescriptor = { url: string; kind: "image" | "video" };

type Page = "Acervo" | "Nova ingestão" | "Processamento" | "Revisão";
const pages: Page[] = ["Acervo", "Nova ingestão", "Processamento", "Revisão"];
const mediaExtension = /\.(mp4|mov|mxf|avi|mts|m2ts|mpg|mpeg|jpg|jpeg|png|tif|tiff|dng|heic|cr2|nef)$/i;

function readableLocalPath(path: string) {
  const windowsPath = path.replace(/\//g, "\\");
  if (windowsPath.startsWith("\\\\?\\UNC\\")) return "\\\\" + windowsPath.slice(8);
  if (windowsPath.startsWith("\\\\?\\")) return windowsPath.slice(4);
  return windowsPath;
}

function Thumbnail({ destination, workspace, captureId, asset }: { destination: string; workspace: string; captureId: string; asset: Asset }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    if (!asset.thumbnail_relative_path || !window.__TAURI_INTERNALS__) return;
    invoke<string | null>("thumbnail_data_url", { destination, workspace, captureId, assetId: asset.asset_id })
      .then(result => { if (active) setUrl(result); })
      .catch(() => { if (active) setUrl(null); });
    return () => { active = false; };
  }, [destination, workspace, captureId, asset.asset_id, asset.thumbnail_relative_path]);
  return url ? <img className="thumbnail" src={url} alt={`Miniatura de ${asset.original_name}`} /> : <div className="thumbnail placeholder">Sem miniatura</div>;
}

export default function App() {
  const [page, setPage] = useState<Page>("Nova ingestão");
  const [reviewFilter, setReviewFilter] = useState<"all" | "pending" | "confirmed" | "high">("all");
  const [workspace, setWorkspace] = useState("pessoal");
  const [captureName, setCaptureName] = useState("");
  const [brief, setBrief] = useState("");
  const [locationsText, setLocationsText] = useState("");
  const [source, setSource] = useState("");
  const [destination, setDestination] = useState("");
  const [devices, setDevices] = useState<SourceDevice[]>([]);
  const [deviceError, setDeviceError] = useState("");
  const [deviceChecking, setDeviceChecking] = useState(false);
  const [deviceRefresh, setDeviceRefresh] = useState(0);
  const [autoSourceRoot, setAutoSourceRoot] = useState("");
  const [sourceInventory, setSourceInventory] = useState<SourceInventory | null>(null);
  const [sourceScanning, setSourceScanning] = useState(false);
  const [sourceError, setSourceError] = useState("");
  const [sourceRefresh, setSourceRefresh] = useState(0);
  const sourceRef = useRef(source);
  sourceRef.current = source;

  const [searchQuery, setSearchQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [latest, setLatest] = useState<Manifest | null>(null);
  const [captures, setCaptures] = useState<Manifest[]>([]);
  const [reviewIndex, setReviewIndex] = useState<ReviewSearchEntry[]>([]);
  const [processingCaptureId, setProcessingCaptureId] = useState("");
  const [reviewCaptureId, setReviewCaptureId] = useState("");
  const [reviewItems, setReviewItems] = useState<ReviewItem[]>([]);
  const [selectedAssetId, setSelectedAssetId] = useState("");
  const [reviewStatus, setReviewStatus] = useState<ReviewEvent["status"]>("pending");
  const [reviewLocation, setReviewLocation] = useState("");
  const [reviewMatter, setReviewMatter] = useState("");
  const [reviewCategory, setReviewCategory] = useState("");
  const [reviewTags, setReviewTags] = useState("");
  const [reviewNote, setReviewNote] = useState("");
  const [preview, setPreview] = useState<PreviewDescriptor | null>(null);
  const [previewError, setPreviewError] = useState("");
  const [organizationApproval, setOrganizationApproval] = useState<OrganizationApproval | null>(null);
  const [approvalError, setApprovalError] = useState("");
  const [exportPlan, setExportPlan] = useState<ExportPlan | null>(null);
  const [exportResult, setExportResult] = useState<ExportResult | null>(null);
  const [exportProgress, setExportProgress] = useState<ExportProgress | null>(null);
  const [exportError, setExportError] = useState("");
  const [exportPlanning, setExportPlanning] = useState(false);
  const [exportRunning, setExportRunning] = useState(false);
  const [approvalLoading, setApprovalLoading] = useState(false);
  const [ollamaStatus, setOllamaStatus] = useState<OllamaStatus | null>(null);
  const [ollamaChecking, setOllamaChecking] = useState(false);
  const [aiAfterIngest, setAiAfterIngest] = useState(true);
  const [aiDetailed, setAiDetailed] = useState(false);
  const [aiRunning, setAiRunning] = useState(false);
  const [aiProgress, setAiProgress] = useState<AiProgress | null>(null);
  const aiActive = useRef(false);
  const aiCancel = useRef(false);
  const aiContext = useRef("");
  aiContext.current = `${destination}\u0000${workspace}`;
  const reviewCaptureRef = useRef(reviewCaptureId);
  reviewCaptureRef.current = reviewCaptureId;



  useEffect(() => {
    setLatest(null);
    setCaptures([]);
    setReviewIndex([]);
    setProcessingCaptureId("");
    setReviewCaptureId("");
    setReviewItems([]);
    setSelectedAssetId("");
  }, [destination, workspace]);

  useEffect(() => {
    const item = reviewItems.find(item => item.asset_id === selectedAssetId);
    const decision = item?.decision;
    const organization = item?.organization;
    setReviewStatus(decision?.status || (organization?.location ? "confirmed" : organization ? "unidentified" : "pending"));
    setReviewLocation(decision?.location || organization?.location || "");
    setReviewMatter(decision?.matter ?? organization?.matter ?? "");
    setReviewCategory(decision?.category || organization?.category || "");
    setReviewTags((decision?.tags || organization?.tags || []).join(", "));
    setReviewNote(decision?.note || "");
  }, [reviewItems, selectedAssetId]);

  useEffect(() => {
    setPreview(null);
    setPreviewError("");
    if (page !== "Revisão" || !selectedAssetId || !reviewCaptureId || !destination || !workspace || !window.__TAURI_INTERNALS__) return;
    let active = true;
    invoke<PreviewDescriptor>("create_preview", { destination, workspace, captureId: reviewCaptureId, assetId: selectedAssetId })
      .then(result => { if (active) setPreview(result); })
      .catch(error => { if (active) setPreviewError(String(error)); });
    return () => { active = false; };
  }, [page, destination, workspace, reviewCaptureId, selectedAssetId]);

  // Poll only the device list. Media are counted once when an origin is chosen,
  // reconnected, or explicitly refreshed; the original files are never opened.
  useEffect(() => {
    if (page !== "Nova ingestão" || busy || !window.__TAURI_INTERNALS__) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    async function refresh() {
      setDeviceChecking(true);
      try {
        const result = await invoke<SourceDevice[]>("list_source_devices");
        if (!active) return;
        setDevices(result);
        setDeviceError("");
        if (!sourceRef.current.trim() && result.length === 1) {
          sourceRef.current = result[0].path;
          setAutoSourceRoot(result[0].path);
          setSource(result[0].path);
        }
      } catch (error) {
        if (active) setDeviceError(String(error));
      } finally {
        if (active) {
          setDeviceChecking(false);
          timer = setTimeout(() => void refresh(), 10000);
        }
      }
    }
    void refresh();
    return () => { active = false; clearTimeout(timer); };
  }, [page, busy, deviceRefresh]);

  useEffect(() => {
    const device = devices.find(device => source.toLocaleLowerCase().startsWith(device.path.toLocaleLowerCase()));
    if (device) setAutoSourceRoot(device.path);
  }, [devices, source]);

  const sourceAttached = !autoSourceRoot || devices.some(device => device.path === autoSourceRoot);
  useEffect(() => {
    if (page !== "Nova ingestão" || busy) return;
    setSourceInventory(null);
    setSourceError("");
    if (!source.trim()) { setSourceScanning(false); return; }
    if (!sourceAttached) {
      setSourceError("Dispositivo desconectado. Reconecte o pendrive ou escolha outra origem.");
      setSourceScanning(false);
      return;
    }
    if (!window.__TAURI_INTERNALS__) {
      setSourceError("A análise da origem está disponível no aplicativo Lumen Desktop.");
      setSourceScanning(false);
      return;
    }
    let active = true;
    setSourceScanning(true);
    const timer = setTimeout(() => {
      invoke<SourceInventory>("inspect_source", { source: source.trim() })
        .then(result => { if (active) setSourceInventory(result); })
        .catch(error => { if (active) setSourceError(String(error)); })
        .finally(() => { if (active) setSourceScanning(false); });
    }, 500);
    return () => { active = false; clearTimeout(timer); };
  }, [source, sourceRefresh, sourceAttached, page, busy]);

  const sourceFileCount = sourceInventory ? sourceInventory.videos + sourceInventory.images + sourceInventory.sidecars : 0;
  const sourceReady = !!sourceInventory && sourceInventory.path === source.trim() && sourceFileCount > 0 && !sourceScanning && !sourceError && sourceAttached;
  const sourceDevice = devices.find(device => source.toLocaleLowerCase().startsWith(device.path.toLocaleLowerCase()));

  const reviewRevision = reviewItems.map(item => item.organization?.event_id || item.decision?.event_id || item.asset_id).join(",");
  useEffect(() => {
    setOrganizationApproval(null);
    setApprovalError("");
    if (!reviewCaptureId || !window.__TAURI_INTERNALS__) return;
    let active = true;
    setApprovalLoading(true);
    invoke<OrganizationApproval | null>("get_organization_approval", { destination, workspace, captureId: reviewCaptureId })
      .then(value => { if (active) setOrganizationApproval(value); })
      .catch(error => { if (active) setApprovalError(String(error)); })
      .finally(() => { if (active) setApprovalLoading(false); });
    return () => { active = false; };
  }, [destination, workspace, reviewCaptureId, reviewRevision]);

  useEffect(() => {
    if (page === "Revisão" && !reviewCaptureId && captures.length > 0) void loadReviewItems(captures[0].capture_id);
  }, [page, captures, reviewCaptureId]);

  async function approveOrganization() {
    if (!reviewCaptureId || busy || reviewHasChanges || pendingReviews || !reviewItems.length) return;
    setBusy(true);
    setApprovalError("");
    try {
      const approval = await invoke<OrganizationApproval>("approve_organization", {
        destination, workspace, captureId: reviewCaptureId,
        expectedEventIds: reviewItems.flatMap(item => item.organization ? [item.organization.event_id] : []),
      });
      setOrganizationApproval(approval);
      setMessage(`Organização aprovada: ${approval.decisions.length} take(s). O registro foi salvo e os originais permanecem preservados.`);
    } catch (error) {
      setApprovalError(String(error));
    } finally { setBusy(false); }
  }

  useEffect(() => {
    setExportPlan(null); setExportResult(null); setExportProgress(null); setExportError("");
    if (!organizationApproval || !reviewCaptureId || !window.__TAURI_INTERNALS__) { setExportPlanning(false); return; }
    let active = true;
    setExportPlanning(true);
    invoke<ExportPlan>("plan_organized_export", { destination, workspace, captureId: reviewCaptureId })
      .then(plan => { if (active && plan.approval_id === organizationApproval.approval_id) setExportPlan(plan); })
      .catch(error => { if (active) setExportError(String(error)); })
      .finally(() => { if (active) setExportPlanning(false); });
    return () => { active = false; };
  }, [destination, workspace, reviewCaptureId, organizationApproval?.approval_id]);

  async function exportOrganizedFiles() {
    if (!exportPlan || busy || reviewHasChanges || exportPlan.approval_id !== organizationApproval?.approval_id) return;
    setBusy(true); setExportRunning(true); setExportError(""); setExportResult(null);
    setExportProgress({ approval_id: exportPlan.approval_id, done: 0, total: exportPlan.files.length, current: "Preparando cópias…" });
    let unlisten: (() => void) | undefined;
    try {
      unlisten = await listen<ExportProgress>("organized-export-progress", event => {
        if (event.payload.approval_id === exportPlan.approval_id) setExportProgress(event.payload);
      });
      const result = await invoke<ExportResult>("export_organized_files", { destination, workspace, captureId: reviewCaptureId, expectedApprovalId: exportPlan.approval_id });
      setExportResult(result);
      setMessage(result.errors.length ? `Pastas criadas parcialmente: ${result.errors.length} falha(s). Confira os detalhes e retome a cópia.` : `Pastas organizadas: ${result.copied} arquivo(s) copiados e ${result.reused} já verificados.`);
    } catch (error) { setExportError(String(error)); }
    finally { unlisten?.(); setExportRunning(false); setBusy(false); }
  }

  async function refreshOllama() {
    if (!window.__TAURI_INTERNALS__) return;
    setOllamaChecking(true);
    try { setOllamaStatus(await invoke<OllamaStatus>("get_ollama_status")); }
    catch (error) { setOllamaStatus({ running: false, model_ready: false, model: "qwen3-vl:4b-instruct", message: String(error) }); }
    finally { setOllamaChecking(false); }
  }
  useEffect(() => { void refreshOllama(); }, []);
  useEffect(() => { aiCancel.current = true; }, [destination, workspace]);

  async function runVisualAnalysis(capture: Manifest, assetId?: string, force = false) {
    if (aiActive.current || !window.__TAURI_INTERNALS__) return;
    const currentContext = `${destination}\u0000${workspace}`;
    const assets = capture.assets.filter(asset => asset.status === "verified" && mediaExtension.test(asset.original_name) && (!assetId || asset.asset_id === assetId));
    if (!assets.length) return;
    aiActive.current = true;
    aiCancel.current = false;
    setAiRunning(true);
    setBusy(true);
    let consecutiveOutputFailures = 0;
    const progress: AiProgress = { total: assets.length, done: 0, succeeded: 0, current: "Conectando ao Ollama…", errors: [], cancelled: false };
    setAiProgress({ ...progress });
    try {
      const status = await invoke<OllamaStatus>("get_ollama_status");
      setOllamaStatus(status);
      if (!status.model_ready) throw new Error(status.message);
      for (const asset of assets) {
        if (aiCancel.current || aiContext.current !== currentContext) { progress.cancelled = true; break; }
        progress.current = asset.original_name;
        setAiProgress({ ...progress, errors: [...progress.errors] });
        try {
          await invoke<VisualAnalysis>("analyze_visual_asset", { destination, workspace, captureId: capture.capture_id, assetId: asset.asset_id, force, detailed: aiDetailed });
          progress.succeeded += 1;
          consecutiveOutputFailures = 0;
        } catch (error) {
          const detail = String(error);
          progress.errors.push(`${asset.original_name}: ${detail}`);
          consecutiveOutputFailures = detail.includes("AI_INVALID_OUTPUT:") ? consecutiveOutputFailures + 1 : 0;
          if (detail.includes("AI_MODEL_THINKING_ONLY:") || consecutiveOutputFailures >= 2) {
            progress.done += 1;
            progress.cancelled = true;
            progress.errors.push("Fila interrompida por falha repetida na resposta do modelo. Os arquivos restantes não foram enviados; resultados anteriores foram preservados.");
            break;
          }
        }
        progress.done += 1;
        setAiProgress({ ...progress, errors: [...progress.errors] });
      }
      if (aiContext.current === currentContext) {
        setReviewIndex(await invoke<ReviewSearchEntry[]>("list_review_index", { destination, workspace }));
        if (reviewCaptureRef.current === capture.capture_id || (!assetId && progress.succeeded > 0)) {
          if (!assetId && progress.succeeded > 0) { setReviewCaptureId(capture.capture_id); setReviewFilter("all"); setPage("Revisão"); }

          const items = await invoke<ReviewItem[]>("list_review_items", { destination, workspace, captureId: capture.capture_id });
          setReviewItems(items);
          setSelectedAssetId(current => items.some(item => item.asset_id === current) ? current : items[0]?.asset_id || "");
        }
        setMessage(`IA local: ${progress.succeeded} de ${progress.done} take(s) com análise disponível.${progress.cancelled ? " A fila foi interrompida; os resultados concluídos foram preservados." : progress.errors.length ? " Confira as falhas antes de aprovar o conjunto." : " A organização está pronta para aprovação na Revisão."}`);
      }
    } catch (error) {
      progress.errors.push(String(error));
      setMessage(`Análise visual não concluída: ${String(error)}`);
    } finally {
      progress.cancelled = progress.cancelled || aiCancel.current;
      progress.current = "";
      setAiProgress({ ...progress, errors: [...progress.errors] });
      aiActive.current = false;
      setAiRunning(false);
      setBusy(false);
    }
  }

  async function selectFolder(which: "source" | "destination") {
    if (!window.__TAURI_INTERNALS__) {
      setMessage("A seleção de pastas só funciona no aplicativo Lumen Desktop.");
      return;
    }
    try {
      const selected = await open({ directory: true, multiple: false });
      if (selected) {
        if (which === "source") { setAutoSourceRoot(devices.find(device => selected.toLocaleLowerCase().startsWith(device.path.toLocaleLowerCase()))?.path || ""); setSource(selected); setSourceRefresh(value => value + 1); }
        else setDestination(selected);
      }
    } catch (error) {
      setMessage(`Não foi possível selecionar a pasta: ${String(error)}`);
    }
  }

  async function ingest() {
    if (!window.__TAURI_INTERNALS__) {
      setMessage(
        "A cópia só funciona no aplicativo Lumen Desktop, não na prévia do navegador.",
      );
      return;
    }
    if (!sourceReady) {
      setMessage("Aguarde a análise da origem ou escolha uma pasta com arquivos suportados.");
      return;
    }
    if (
      !window.confirm(
        `Confirmar ingestão no espaço “${workspace}”? A origem não será alterada.`,
      )
    )
      return;
    let ingested: Manifest | null = null;
    setBusy(true);
    setMessage("Copiando e verificando os arquivos. Não remova o cartão.");
    try {
      const result = await invoke<Manifest>("ingest_capture", {
        source: source.trim(),
        destination,
        workspace,
        captureName,
        brief,
        visitedLocations: locationsText.split(/\r?\n/).map(item => item.trim()).filter(Boolean),
        toolsDirectory: null,
      });
      ingested = result;
      setLatest(result);
      setCaptures(current => [result, ...current.filter(item => item.capture_id !== result.capture_id)]);
      setProcessingCaptureId(result.capture_id);
      setMessage(
        `${result.verified_count} arquivo(s) verificado(s); ${result.failed_count} falha(s). Confira o manifesto antes de liberar o cartão.`,
      );
    } catch (error) {
      setMessage(`Ingestão não concluída: ${String(error)}`);
    } finally {
      setBusy(false);
    }
    if (ingested && aiAfterIngest && ollamaStatus?.model_ready && aiContext.current === `${destination}\u0000${workspace}`) {
      setPage("Processamento");
      await runVisualAnalysis(ingested);
    }
  }

  async function loadCaptures() {
    if (!window.__TAURI_INTERNALS__) {
      setMessage("O acervo local só fica disponível no aplicativo instalado.");
      return;
    }
    try {
      const result = await invoke<Manifest[]>("list_captures", {
        destination,
        workspace,
      });
      setCaptures(result);
      setProcessingCaptureId(current => result.some(capture => capture.capture_id === current) ? current : result[0]?.capture_id || "");
      try {
        setReviewIndex(await invoke<ReviewSearchEntry[]>("list_review_index", { destination, workspace }));
        setMessage(`${result.length} captação(ões) encontrada(s) neste espaço e destino.`);
      } catch (error) {
        setReviewIndex([]);
        setMessage(`${result.length} captação(ões) encontrada(s), mas a busca por revisões não carregou: ${String(error)}`);
      }
    } catch (error) {
      setMessage(`Não foi possível abrir o acervo: ${String(error)}`);
    }
  }

  async function retryProcessing(capture: Manifest) {
    if (!window.__TAURI_INTERNALS__) return;
    setBusy(true);
    setMessage(`Verificando novamente as prévias de “${capture.capture_name}”…`);
    try {
      const updated = await invoke<Manifest>("reprocess_capture", {
        destination, workspace, captureId: capture.capture_id,
      });
      setCaptures(current => current.map(item => item.capture_id === updated.capture_id ? updated : item));
      setLatest(current => current?.capture_id === updated.capture_id ? updated : current);
      const pending = updated.assets.filter(asset => asset.status === "verified" && mediaExtension.test(asset.original_name) && (!asset.metadata || !asset.thumbnail_relative_path || asset.processing_error)).length;
      setMessage(pending ? `Nova tentativa concluída. ${pending} arquivo(s) ainda precisam de metadados ou miniatura.` : "Processamento local concluído. As cópias e os originais não foram alterados.");
    } catch (error) {
      setMessage(`Não foi possível reprocessar: ${String(error)}`);
    } finally {
      setBusy(false);
    }
  }

  async function loadReviewItems(captureId: string, preferredAssetId?: string) {
    setReviewCaptureId(captureId);
    setReviewFilter("all");
    setReviewItems([]);
    setSelectedAssetId("");
    if (!captureId || !window.__TAURI_INTERNALS__) return;
    try {
      const result = await invoke<ReviewItem[]>("list_review_items", { destination, workspace, captureId });
      setReviewItems(result);
      setSelectedAssetId(result.find(item => item.asset_id === preferredAssetId)?.asset_id || result[0]?.asset_id || "");
      setMessage(`${result.length} mídia(s) disponíveis para revisão nesta captação.`);
    } catch (error) {
      setMessage(`Não foi possível carregar a revisão: ${String(error)}`);
    }
  }

  async function saveReview(validateException = false) {
    if (!reviewCaptureId || !selectedAssetId || !window.__TAURI_INTERNALS__) return;
    const statusToSave = validateException && reviewStatus === "pending" ? (reviewLocation.trim() ? "confirmed" : "unidentified") : reviewStatus;
    setBusy(true);
    try {
      const updated = await invoke<ReviewItem>("save_review", {
        destination, workspace, captureId: reviewCaptureId, assetId: selectedAssetId,
        status: statusToSave,
        location: statusToSave === "confirmed" ? reviewLocation.trim() : null,
        matter: reviewMatter,
        category: reviewCategory,
        tags: reviewTags.split(/[,\n]/).map(tag => tag.trim()).filter(Boolean),
        note: reviewNote,
      });
      let refreshed: ReviewItem[] | null = null;
      try {
        refreshed = await invoke<ReviewItem[]>("list_review_items", { destination, workspace, captureId: reviewCaptureId });
      } catch {
        // A revisão já foi salva; preserve o resultado mesmo se a atualização das sugestões falhar.
      }
      setReviewItems(current => refreshed || current.map(item => item.asset_id === updated.asset_id ? updated : item));
      if (updated.decision) {
        const decision = updated.decision;
        setReviewIndex(current => [
          ...current.filter(item => item.capture_id !== reviewCaptureId || item.asset_id !== updated.asset_id),
          { capture_id: reviewCaptureId, asset_id: updated.asset_id, status: decision.status, location: decision.location, matter: decision.matter, tags: decision.tags, visual_description: updated.visual_analysis?.description, visual_tags: updated.visual_analysis?.tags, visible_text: updated.visual_analysis?.visible_text },
        ]);
      }
      const suggested = refreshed?.filter(item => item.suggestion && (!item.decision || item.decision.status === "pending")).length;
      setMessage(`Revisão de “${updated.original_name}” salva. Os originais não foram alterados.${suggested ? ` ${suggested} take(s) têm pistas para conferir.` : ""}`);
    } catch (error) {
      setMessage(`Não foi possível salvar a revisão: ${String(error)}`);
    } finally {
      setBusy(false);
    }
  }

  const query = searchQuery.trim().toLocaleLowerCase("pt-BR");
  const hasReviewMatch = !!query && reviewIndex.some(item =>
    [item.location || "", item.matter, ...item.tags, item.visual_description || "", ...(item.visual_tags || []), ...(item.visible_text || [])].join(" ").toLocaleLowerCase("pt-BR").includes(query),
  );
  const visibleCaptures = captures.flatMap((capture) => {
    const captureText = [capture.capture_name, capture.brief]
      .join(" ").toLocaleLowerCase("pt-BR");
    const captureMatches = !query || (!hasReviewMatch && captureText.includes(query));
    const assets = captureMatches
      ? capture.assets
      : capture.assets.filter((asset) =>
          [asset.original_name, asset.original_relative_path, asset.metadata?.kind || "",
            ...reviewIndex.filter(item => item.capture_id === capture.capture_id && item.asset_id === asset.asset_id)
              .flatMap(item => [item.location || "", item.matter, ...item.tags, item.visual_description || "", ...(item.visual_tags || []), ...(item.visible_text || [])])]
            .join(" ").toLocaleLowerCase("pt-BR").includes(query),
        );
    return assets.length > 0 || captureMatches ? [{ capture, assets }] : [];
  });
  const selectedReview = reviewItems.find(item => item.asset_id === selectedAssetId);
  const selectedReviewIndex = reviewItems.findIndex(item => item.asset_id === selectedAssetId);
  const reviewTagsList = reviewTags.split(/[,\n]/).map(tag => tag.trim()).filter(Boolean);
  const baselineDecision = selectedReview?.decision;
  const baselineOrganization = selectedReview?.organization;
  const baselineStatus = baselineDecision?.status || (baselineOrganization?.location ? "confirmed" : baselineOrganization ? "unidentified" : "pending");
  const reviewHasChanges = !!selectedReview && (
    baselineStatus !== reviewStatus
      || (baselineDecision?.category || baselineOrganization?.category || "") !== reviewCategory.trim()
      || (reviewStatus === "confirmed" && reviewLocation.trim() !== (baselineDecision?.location || baselineOrganization?.location || ""))
      || (baselineDecision?.matter ?? baselineOrganization?.matter ?? "") !== reviewMatter.trim()
      || (baselineDecision?.note || "") !== reviewNote.trim()
      || JSON.stringify(baselineDecision?.tags || baselineOrganization?.tags || []) !== JSON.stringify(reviewTagsList)
  );
  const reviewCapture = captures.find(item => item.capture_id === reviewCaptureId);

  const titles: Record<Page, [string, string]> = {
    Acervo: ["Seu acervo em um só lugar", "Encontre arquivos, acompanhe captações e retome revisões pendentes."],
    "Nova ingestão": ["Nova ingestão", "Reúna o contexto da captação e crie uma cópia verificada dos arquivos."],
    Processamento: ["Processando captação", "Metadados e miniaturas locais, com os originais preservados."],
    Revisão: ["Organização feita pela IA", "Confira os grupos prontos, corrija somente exceções e aprove a organização."],
  };
  const pendingReviews = reviewItems.filter(item => !item.organization || item.organization.requires_review).length;
  const aiOrganized = (item: ReviewItem) => item.organization?.source === "ai" && !item.organization.requires_review;
  const filteredReviewItems = reviewItems.filter(item => reviewFilter === "all" || (reviewFilter === "high" ? aiOrganized(item) : reviewFilter === "pending" ? !item.organization || item.organization.requires_review : item.decision?.status === "confirmed"));
  const reviewGroups = new Map<string, { location: string; matter: string; state: string; items: ReviewItem[] }>();
  for (const item of filteredReviewItems) {
    const organization = item.organization;
    const state = organization ? organization.requires_review ? "pending" : organization.source === "ai" ? "ai" : "confirmed" : "pending";
    const location = organization?.category || item.suggestion?.location || "Aguardando organização";
    const matter = organization?.matter || reviewCapture?.capture_name || "Sem assunto identificado";
    const key = JSON.stringify([location.toLocaleLowerCase("pt-BR"), organization?.location?.toLocaleLowerCase("pt-BR") || "", state]);
    const group = reviewGroups.get(key) || { location, matter, state, items: [] };
    if (group.items.length && group.matter !== matter) group.matter = "Assuntos relacionados";
    group.items.push(item);
    reviewGroups.set(key, group);
  }
  const selectedFilteredIndex = filteredReviewItems.findIndex(item => item.asset_id === selectedAssetId);
  useEffect(() => {
    if (reviewFilter !== "all" && !filteredReviewItems.some(item => item.asset_id === selectedAssetId)) {
      setSelectedAssetId(filteredReviewItems[0]?.asset_id || "");
    } else if (!selectedAssetId && filteredReviewItems.length) {
      setSelectedAssetId(filteredReviewItems[0].asset_id);
    }
  }, [reviewFilter, reviewRevision, selectedAssetId]);
  const canApproveOrganization = reviewItems.length > 0 && pendingReviews === 0 && !reviewHasChanges && !busy && !approvalLoading && !organizationApproval;


  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark">L</span>
          <div>
            <strong>LUMEN</strong>
            <small>DESKTOP</small>
          </div>
        </div>
        <nav aria-label="Navegação principal">
          {pages.map((item) => (
            <button
              key={item}
              className={page === item ? "active" : ""}
              aria-current={page === item ? "page" : undefined}
              onClick={() => { setPage(item); if ((item === "Acervo" || item === "Processamento" || item === "Revisão") && destination && workspace) void loadCaptures(); }}
            >
              <img src={page === item ? navActive : navIdle} alt="" width={10} height={10} />{item}
            </button>
          ))}
        </nav>
        <div className="sidebar-note">
          <span className="device-label">ESTE COMPUTADOR</span>
          <strong>Acervo local</strong>
          <span className="badge">{window.__TAURI_INTERNALS__ ? "● Desktop ativo" : "● Prévia no navegador"}</span>
          <small>Originais sob seu controle</small>
        </div>
      </aside>
      <main className="main">
        <div className="topbar">
          <span className="eyebrow">LUMEN / {page.toLocaleUpperCase("pt-BR")}</span>
          <div className="top-statuses"><span className="badge">{window.__TAURI_INTERNALS__ ? "● Aplicativo local ativo" : "● Prévia no navegador"}</span><span className="badge neutral">{ollamaStatus?.model_ready ? "Qwen3-VL 4B · local" : "IA local não pronta"}</span></div>
        </div>
        <header className="page-header">
          <div><h1>{titles[page][0]}</h1><p className="intro">{titles[page][1]}</p></div>
          {page === "Revisão" && <button className="primary" disabled={!canApproveOrganization} onClick={() => void approveOrganization()}>{organizationApproval ? "Organização aprovada" : "Aprovar organização"}</button>}
          {(page === "Acervo" || page === "Nova ingestão") && <button className={page === "Acervo" ? "primary" : "secondary"} onClick={() => { const target = page === "Acervo" ? "Nova ingestão" : "Acervo"; setPage(target); if (target === "Acervo" && destination && workspace) void loadCaptures(); }}>{page === "Acervo" ? "Nova ingestão" : "Voltar ao acervo"}</button>}
        </header>
        {message && (
          <div className="notice" role="status">
            {message}
          </div>
        )}
        {(page === "Nova ingestão" || page === "Processamento" || page === "Revisão") && <section className="card ai-panel" aria-label="IA visual local">
          <div className="ai-panel-heading"><div><h2>IA visual local · Qwen3-VL 4B Instruct</h2><p role="status">{ollamaChecking ? "Consultando o Ollama…" : ollamaStatus?.message || "Abra o aplicativo Desktop para conectar ao Ollama."}</p></div><span className={`badge ${ollamaStatus?.model_ready ? "" : "neutral"}`}>{ollamaStatus?.model_ready ? "● Modelo pronto" : ollamaStatus?.running ? "Modelo não instalado" : "Ollama desconectado"}</span><button className="secondary" disabled={busy || ollamaChecking} onClick={() => void refreshOllama()}>Atualizar conexão</button></div>
          {!ollamaStatus?.model_ready && <p className="hint">No Ollama deste computador, instale o modelo: <code>ollama pull qwen3-vl:4b-instruct</code>. Depois, atualize a conexão.</p>}
          <p className="hint">Imagens e quadros amostrados são analisados no próprio computador. A IA organiza grupos, assuntos e tags. Você revisa exceções; não há transcrição de áudio.</p>
          <label className="ai-toggle"><input type="checkbox" checked={aiDetailed} disabled={busy} onChange={event => setAiDetailed(event.target.checked)} />Análise detalhada de vídeos (3 quadros; mais demorada)</label>
          <p className="hint">{aiDetailed ? "Vídeos: três amostras para cobrir mais cenas." : "Modo rápido: imagens reduzidas e um quadro central por vídeo; cenas fora da amostra e textos pequenos podem passar despercebidos."} Resultados já concluídos são reaproveitados. Para aplicar outro modo a um take já analisado, use Reanalisar.</p>
          {page === "Nova ingestão" && <label className="ai-toggle"><input type="checkbox" checked={aiAfterIngest} disabled={busy} onChange={event => setAiAfterIngest(event.target.checked)} />Analisar com IA após a cópia, quando o modelo estiver pronto</label>}
          {aiProgress && <div className={`ai-progress ${aiProgress.errors.length ? "has-errors" : ""}`} role="status"><div><strong>{aiRunning ? `Analisando: ${aiProgress.current}` : aiProgress.cancelled ? "Fila interrompida" : aiProgress.succeeded === 0 && aiProgress.errors.length > 0 ? "Organização não concluída" : aiProgress.errors.length > 0 ? "Organização parcial — confira as falhas" : "Organização automática concluída"}</strong><span>{aiProgress.done}/{aiProgress.total} processados · {aiProgress.succeeded} organizados</span></div><progress max={aiProgress.total || 1} value={aiProgress.done} aria-label="Progresso da análise visual" />{aiRunning && <button className="secondary" onClick={() => { aiCancel.current = true; }}>Parar após o take atual</button>}{aiProgress.errors.length > 0 && <details><summary>{aiProgress.errors.length} falha(s) na análise</summary><ul>{aiProgress.errors.map((error, index) => <li key={index}>{error}</li>)}</ul></details>}</div>}
        </section>}
        {page === "Nova ingestão" && <section className="card source-detection" aria-label="Origem para ingestão" aria-busy={sourceScanning}>
          <div className="source-detection-row">
            <span className="source-device-icon" aria-hidden="true">USB</span>
            <div className="source-detection-copy" role="status" aria-live="polite">
              <h2>{source ? sourceDevice ? `${sourceDevice.label} detectado em ${sourceDevice.path}` : "Pasta de origem selecionada" : deviceChecking ? "Procurando pendrives e cartões…" : devices.length ? "Escolha um dispositivo para analisar" : "Nenhum pendrive ou cartão detectado"}</h2>
              {source && <p className="source-path">{source}</p>}
              {sourceScanning ? <p>Contando vídeos, fotos e arquivos auxiliares nas subpastas…</p> : sourceInventory ? <p>{sourceInventory.videos} vídeo(s) · {sourceInventory.images} foto(s) · {sourceInventory.sidecars} auxiliar(es) · {formatBytes(sourceInventory.total_bytes)} · somente leitura</p> : !sourceError && <p>Conecte o dispositivo ou escolha a pasta de origem abaixo.</p>}
              {sourceError && <p className="source-feedback" role="alert">{sourceError}</p>}
              {sourceInventory && sourceFileCount === 0 && <p className="source-feedback">Nenhum arquivo suportado encontrado. Escolha a pasta com vídeos ou fotos, incluindo suas subpastas.</p>}
              {sourceInventory?.partial && <p className="source-feedback">Contagem parcial: a origem é muito grande ou lenta. A ingestão fará o inventário completo antes de copiar.</p>}
              {!!sourceInventory?.unreadable_entries && <p className="source-feedback">{sourceInventory.unreadable_entries} entrada(s) não puderam ser lidas. Confira o acesso à unidade.</p>}
              {!!sourceInventory?.ignored_files && <p>{sourceInventory.ignored_files} arquivo(s) de outros formatos fora da ingestão.</p>}
            </div>
            <span className={`source-state ${sourceReady ? "ready" : ""}`}>{busy ? "Cópia em andamento" : sourceScanning ? "◌ Analisando" : sourceReady ? "● Pronto para ingerir" : sourceError ? "Atenção à origem" : "Aguardando mídia"}</span>
          </div>
          <div className="source-device-actions">
            <button className="secondary" type="button" disabled={busy || deviceChecking} onClick={() => setDeviceRefresh(value => value + 1)}>{deviceChecking ? "Buscando dispositivos…" : "Atualizar dispositivos"}</button>
            <button className="secondary" type="button" disabled={busy} onClick={() => void selectFolder("source")}>Escolher pasta</button>
            {source && <button className="secondary" type="button" disabled={busy || sourceScanning} onClick={() => setSourceRefresh(value => value + 1)}>Analisar origem novamente</button>}
          </div>
          {devices.length > 0 && <div className="source-device-list" aria-label="Dispositivos conectados">{devices.map(device => <button className="source-device-choice" type="button" key={device.path} disabled={busy} aria-pressed={source === device.path} onClick={() => { setAutoSourceRoot(device.path); setSource(device.path); setSourceRefresh(value => value + 1); }}><strong>{device.label} · {device.path}</strong><span>{formatBytes(device.free_bytes)} livres de {formatBytes(device.capacity_bytes)}</span></button>)}</div>}
          {deviceError && <p className="source-feedback" role="status">{deviceError}</p>}
          <p className="hint">A detecção apenas lê a lista de arquivos. A cópia só começa quando você confirma a ingestão.</p>
        </section>}
        {(page === "Nova ingestão" || page === "Acervo" || page === "Processamento" || page === "Revisão") && (
          <details className="card settings" open={page === "Nova ingestão" || !destination}>
            <summary>Pastas e espaço de trabalho <span>{workspace || "não definido"}</span></summary>
            <h2>{page === "Nova ingestão" ? "De onde vêm e onde ficam os arquivos" : "Acervo local"}</h2>
            <p>
              {page === "Nova ingestão"
                ? "O Lumen lê o cartão ou pendrive e guarda uma cópia verificada em uma pasta permanente."
                : "Escolha o espaço de trabalho e a pasta permanente onde as cópias foram guardadas."}
            </p>
            <div className="field-grid workspace-grid">
              <label>
                Espaço de trabalho{" "}
                <input
                  value={workspace}
                  disabled={busy}
                  onChange={(e) => setWorkspace(e.target.value)}
                  placeholder="ex.: pessoal ou cliente-a"
                />
              </label>
            </div>
            {page === "Nova ingestão" && (
              <div className="transfer-grid">
                <label>
                  1. Origem — cartão ou pendrive com fotos e vídeos
                  <span className="input-action">
                    <input
                      value={source}
                      disabled={busy}
                      onChange={(e) => { setAutoSourceRoot(""); setSource(e.target.value); }}
                      placeholder="Ex.: G:\\DCIM"
                    />
                    <button className="secondary" type="button" disabled={busy} onClick={() => selectFolder("source")}>Escolher</button>
                  </span>
                </label>
                <span className="transfer-arrow" aria-hidden="true">→</span>
                <label>
                  2. Destino — pasta permanente das cópias
                  <span className="input-action">
                    <input
                      value={destination}
                      disabled={busy}
                      onChange={(e) => setDestination(e.target.value)}
                      placeholder="Ex.: D:\\Lumen\\Acervo"
                    />
                    <button className="secondary" type="button" disabled={busy} onClick={() => selectFolder("destination")}>Escolher</button>
                  </span>
                </label>
              </div>
            )}
            {page !== "Nova ingestão" && <div className="field-grid workspace-grid"><label>
                Pasta permanente das cópias{" "}
                <span className="input-action">
                  <input
                    value={destination}
                    disabled={busy}
                    onChange={(e) => setDestination(e.target.value)}
                    placeholder="Ex.: D:\\Lumen\\Acervo"
                  />
                  <button className="secondary" type="button" disabled={busy} onClick={() => selectFolder("destination")}>Escolher</button>
                </span>
              </label></div>}
            {page === "Nova ingestão" && <p className="hint">Escolha uma pasta de destino fora do cartão ou pendrive. Os originais permanecem na origem.</p>}
            <p className="hint">
              Nesta fase, o espaço é local. Contas e permissões compartilhadas
              virão com a API autenticada.
            </p>
          </details>
        )}
        {page === "Nova ingestão" && <>
          <div className="ingestion-grid">
            <section className="card context-card">
              <h2>O que você sabe sobre a captação?</h2>
              <p className="hint">Esse contexto orienta a revisão. Você não precisa localizar cada take agora.</p>
              <div className="context-fields">
                <label>Retranca ou matéria<input value={captureName} onChange={e => setCaptureName(e.target.value)} placeholder="Ex.: Dia das Crianças · Comércio" /></label>
                <label>Pauta ou briefing<textarea value={brief} onChange={e => setBrief(e.target.value)} maxLength={10000} rows={3} placeholder="Descreva o que foi gravado e o objetivo da matéria." /></label>
                <label>Locais visitados (opcional, um por linha)<textarea value={locationsText} onChange={e => setLocationsText(e.target.value)} rows={2} placeholder={"Shopping Vitória\nPraia do Morro"} /></label>
              </div>
              <p className="hint">Os locais são contexto da captação; a confirmação é feita na revisão de cada take.</p>
            </section>
            <aside className="card discovery-card">
              <h2>O Lumen vai reunir</h2><p className="hint">Pistas disponíveis de cada vídeo e imagem</p>
              <div className="signal"><strong>✓ Metadados</strong><p>Data, duração, resolução e codec, quando disponíveis.</p></div>
              <div className="signal"><strong>✓ Miniaturas e prévias</strong><p>Imagens e vídeos compatíveis para sua conferência.</p></div>
              <div className="signal"><strong>✓ Pistas de localização</strong><p>GPS, SRT e regras locais. Você confirma o local por take.</p></div>
              <div className="signal"><strong>✓ Análise visual por IA local</strong><p>Qwen3-VL 4B via Ollama: cenas, texto visível e tags para conferência.</p></div>
            </aside>
          </div>
          <section className="action-banner"><div><h2>Seus originais ficam preservados</h2><p>O Lumen apenas copia. Cada cópia é verificada por tamanho e SHA-256.</p></div><button className="primary" disabled={busy || !sourceReady || !destination || !workspace || !captureName} onClick={ingest}>{busy ? "Copiando e verificando…" : sourceReady ? `Ingerir ${sourceFileCount} arquivo(s)` : sourceScanning ? "Analisando origem…" : "Iniciar ingestão"}</button></section>
        </>}
        {page === "Nova ingestão" && latest && (
          <section className="card">
            <h2>Resultado da captação</h2>
            <p>
              {latest.capture_name} · {latest.verified_count} verificados ·{" "}
              {latest.failed_count} falhas
            </p>
            {latest.visited_locations.length > 0 && <p className="hint">Locais informados: {latest.visited_locations.join(" · ")}</p>}
            <div className="asset-list">
              {latest.assets.map((asset) => (
                <div key={asset.asset_id} className="asset media-asset">
                  <Thumbnail destination={destination} workspace={workspace} captureId={latest.capture_id} asset={asset} />
                  <div className="asset-info">
                    <strong>{asset.original_name}</strong>
                    <small>{asset.status === "verified" ? "Cópia verificada" : asset.error || "Falha na cópia"}</small>
                    {asset.metadata && <small>{asset.metadata.kind === "video" ? "Vídeo" : "Imagem"}{asset.metadata.duration_seconds != null ? ` · ${asset.metadata.duration_seconds.toFixed(1)} s` : ""}{asset.metadata.width && asset.metadata.height ? ` · ${asset.metadata.width}×${asset.metadata.height}` : ""}{asset.metadata.video_codec ? ` · ${asset.metadata.video_codec}` : ""}</small>}
                    {asset.processing_error && <small className="processing-warning">Metadados/miniatura não concluídos: {asset.processing_error}</small>}
                  </div>
                </div>
              ))}
            </div>
            <p className="hint">Manifesto: {latest.manifest_path}</p>
            <button className="secondary" type="button" onClick={() => { setPage("Acervo"); void loadCaptures(); }}>Ver arquivos no Acervo</button>
            <button className="secondary result-next" type="button" onClick={() => { setPage("Processamento"); void loadCaptures(); }}>Conferir processamento</button>
            <button className="secondary result-next" type="button" onClick={() => { setPage("Revisão"); void loadCaptures(); void loadReviewItems(latest.capture_id); }}>Revisar takes</button>
          </section>
        )}
        {page === "Acervo" && <>
            <label className="search-field">Pesquisar no acervo local
              <input value={searchQuery} onChange={e => setSearchQuery(e.target.value)} placeholder="Ex.: C001, Praia do Morro, comércio, pessoas" />
            </label>
          <div className="metrics">
            <div className="card metric"><span>Arquivos catalogados</span><strong>{captures.reduce((total, capture) => total + capture.verified_count, 0).toLocaleString("pt-BR")}</strong><small>Cópias verificadas no acervo carregado</small></div>
            <div className="card metric"><span>Captações carregadas</span><strong>{captures.length}</strong><small>{reviewIndex.filter(item => item.status === "pending").length} revisões pendentes registradas</small></div>
            <div className="card metric"><span>Origem selecionada</span><strong>{source ? "1" : "0"}</strong><small>{source ? "Pasta informada para ingestão" : "Selecione uma pasta para começar"}</small></div>
          </div>
          <div className="archive-grid"><section className="card archive-captures">
            <div className="section-heading">
              <div>
                <h2>Captações neste computador</h2>
                <p>Pesquise por arquivo, captação, pauta, local confirmado, matéria ou tags da revisão.</p>
              </div>
              <button
                className="secondary"
                disabled={!destination || !workspace}
                onClick={loadCaptures}
              >
                Atualizar
              </button>
            </div>

            {captures.length ? (
              visibleCaptures.length ? visibleCaptures.map(({ capture, assets }) => (
                <details className="capture-detail" key={capture.capture_id} open={Boolean(query)}>
                  <summary className="capture">
                    {capture.assets.find(asset => asset.thumbnail_relative_path) && <Thumbnail destination={destination} workspace={workspace} captureId={capture.capture_id} asset={capture.assets.find(asset => asset.thumbnail_relative_path)!} />}
                    <div className="asset-info"><strong>{capture.capture_name}</strong><span>{capture.verified_count} arquivos verificados · {capture.failed_count} falhas</span><small>{assets.length} arquivo(s) nesta visualização</small>{capture.visited_locations?.length > 0 && <small>Locais informados: {capture.visited_locations.join(" · ")}</small>}</div>
                  </summary>
                  <div className="asset-list">
                    {assets.map(asset => <div className="asset media-asset" key={asset.asset_id}>
                      <Thumbnail destination={destination} workspace={workspace} captureId={capture.capture_id} asset={asset} />
                      <div className="asset-info"><strong>{asset.original_name}</strong><small>{asset.original_relative_path}</small><small>{asset.status === "verified" ? "Cópia verificada" : asset.error || "Falha na cópia"}{asset.metadata?.duration_seconds != null ? ` · ${asset.metadata.duration_seconds.toFixed(1)} s` : ""}{asset.metadata?.width && asset.metadata.height ? ` · ${asset.metadata.width}×${asset.metadata.height}` : ""}</small>
                        {(() => { const entry = reviewIndex.find(item => item.capture_id === capture.capture_id && item.asset_id === asset.asset_id); return entry ? <small className="review-search-meta">{entry.status === "confirmed" ? `Local: ${entry.location}` : entry.status === "unidentified" ? "Local não identificado" : entry.status === "organized" ? "Organizado pela IA" : "Exceção ou análise pendente"}{entry.matter ? ` · Matéria: ${entry.matter}` : ""}{entry.tags.length ? ` · Tags: ${entry.tags.join(", ")}` : ""}</small> : null; })()}
                        {asset.processing_error && <small className="processing-warning">Prévia não concluída: {asset.processing_error}</small>}</div>
                      {asset.status === "verified" && mediaExtension.test(asset.original_name) && <button className="secondary open-review" type="button" onClick={() => { setPage("Revisão"); void loadReviewItems(capture.capture_id, asset.asset_id); }}>Abrir na Revisão</button>}
                    </div>)}
                  </div>
                </details>
              )) : <p className="empty">Nenhum arquivo encontrado para “{searchQuery}”. A busca usa nomes, contexto, decisões humanas e descrições ou tags visuais já analisadas.</p>
            ) : (
              <p className="empty">
                Nenhuma captação carregada. Informe o destino e clique em
                Atualizar.
              </p>
            )}
          </section>
          <aside className="card sources-card"><h2>Fontes locais</h2><p className="hint">Pastas escolhidas neste aplicativo.</p><div className="signal"><strong>Origem</strong><p className="path-text">{source || "Nenhuma pasta selecionada"}</p></div><div className="signal"><strong>Destino das cópias</strong><p className="path-text">{destination || "Escolha a pasta permanente acima"}</p></div><button className="secondary" onClick={() => setPage("Nova ingestão")}>Selecionar origem</button></aside></div>
          <section className="action-banner"><span className="protection-mark" aria-hidden="true">✓</span><div><h2>Seus originais continuam aqui</h2><p>A ingestão cria cópias verificadas, metadados e miniaturas. Os arquivos de origem são preservados.</p></div></section>
        </>}
        {page === "Processamento" && (
          <section className="card">
            <div className="section-heading">
              <div><span className="step">02 / 04</span><h2 className="processing-title">Processamento local</h2>
                <p>Confira metadados e miniaturas de cada arquivo. Se uma prévia falhou, tente novamente sem copiar os originais outra vez.</p></div>
              <button className="secondary" disabled={!destination || !workspace || busy} onClick={loadCaptures}>Atualizar</button>
            </div>
            <p className="hint">Metadados e miniaturas são processados localmente. As pistas de localização ficam disponíveis para conferência na Revisão.</p>
            {captures.length > 0 && <label className="processing-selector">Captação para conferir
              <select value={processingCaptureId} onChange={event => setProcessingCaptureId(event.target.value)}>
                {captures.map(capture => <option key={capture.capture_id} value={capture.capture_id}>{capture.capture_name} · {new Date(capture.created_at).toLocaleString("pt-BR")} · {capture.verified_count} arquivo(s)</option>)}
              </select>
            </label>}
            {captures.length ? captures.filter(capture => capture.capture_id === processingCaptureId).map(capture => {
              const media = capture.assets.filter(asset => asset.status === "verified" && mediaExtension.test(asset.original_name));
              const pending = media.filter(asset => !asset.metadata || !asset.thumbnail_relative_path || asset.processing_error);
              return <div className="processing-capture" key={capture.capture_id}>
                <div className="processing-heading"><div><h3>{capture.capture_name}</h3><p>{capture.verified_count} cópia(s) verificada(s) · {media.filter(asset => asset.metadata).length}/{media.length} com metadados · {media.filter(asset => asset.thumbnail_relative_path).length}/{media.length} com miniatura</p></div>
                  <button className="secondary" disabled={busy || media.length === 0} onClick={() => void retryProcessing(capture)}>{busy ? "Processando…" : pending.length ? `Tentar novamente (${pending.length})` : "Verificar arquivos"}</button>
                </div>
                {capture.failed_count > 0 && <p className="processing-warning">{capture.failed_count} cópia(s) falharam na ingestão. Esta ação tenta apenas metadados e miniaturas de cópias verificadas.</p>}
                <div className="progress-summary"><div><strong>{pending.length ? "Prévias precisam de atenção" : media.length ? "Prévias concluídas" : "Nenhuma mídia para processar"}</strong><span>{media.length - pending.length} de {media.length} mídias prontas</span></div><progress max={media.length || 1} value={media.length - pending.length} aria-label="Mídias com metadados e miniatura concluídos" /></div>
                <div className="pipeline-grid">
                  <section className="pipeline-panel"><span className="eyebrow">NO SEU COMPUTADOR</span><h2>Leitura e proteção dos originais</h2><div className="signal"><strong>Inventário</strong><p>{capture.assets.length} arquivos registrados · {capture.verified_count} cópias verificadas · {capture.failed_count} falhas</p></div><div className="signal"><strong>Metadados</strong><p>{media.filter(asset => asset.metadata).length} de {media.length} mídias com metadados</p></div><div className="signal"><strong>Miniaturas</strong><p>{media.filter(asset => asset.thumbnail_relative_path).length} de {media.length} mídias com miniatura</p></div><div className="signal"><strong>Segurança</strong><p>Os arquivos da origem não são movidos nem renomeados.</p></div></section>
                  <section className="pipeline-panel"><span className="eyebrow">EVIDÊNCIAS E REVISÃO</span><h2>Organização com sua conferência</h2><div className="signal"><strong>Pistas de localização</strong><p>GPS, telemetria SRT e regras locais, quando disponíveis.</p></div><div className="signal"><strong>Decisão por take</strong><p>Confirme um local, marque como não identificado ou mantenha pendente.</p></div><div className="signal"><strong>Busca local</strong><p>Nomes, pauta, matéria, locais confirmados e tags salvas.</p></div><div className="signal"><strong>IA visual no computador</strong><p>Qwen3-VL 4B via Ollama. A nuvem e a transcrição de áudio não são usadas.</p></div></section>
                </div>
                <section className="action-banner"><div><h2>Pronto para sua conferência</h2><p>Confira as pistas e salve a decisão para cada take.</p></div><button className="primary" disabled={busy || !media.length} onClick={() => { setPage("Revisão"); void loadReviewItems(capture.capture_id); }}>Revisar takes</button></section>
                <div className="ai-capture-action"><button className="primary" disabled={busy || !ollamaStatus?.model_ready || !media.length} onClick={() => void runVisualAnalysis(capture)}>Organizar automaticamente com IA</button><p className="hint">A IA define grupos, assuntos e tags. Resultados válidos são reaproveitados e imagens duplicadas reutilizam a análise; você aprova o conjunto.</p></div>
                <h3 className="asset-section-title">Arquivos da captação</h3>
                <div className="processing-assets">{capture.assets.map(asset => <div className="processing-asset" key={asset.asset_id}>
                  <Thumbnail destination={destination} workspace={workspace} captureId={capture.capture_id} asset={asset} />
                  <div className="asset-info"><strong>{asset.original_name}</strong><small>{asset.status !== "verified" ? "Falha na cópia" : !mediaExtension.test(asset.original_name) ? "Arquivo auxiliar preservado" : asset.processing_error ? "Prévia com falha" : asset.metadata && asset.thumbnail_relative_path ? "Metadados e miniatura prontos" : "Prévia pendente"}</small>
                    {asset.metadata && <small>{asset.metadata.width && asset.metadata.height ? `${asset.metadata.width}×${asset.metadata.height}` : "Dimensões indisponíveis"}{asset.metadata.duration_seconds != null ? ` · ${asset.metadata.duration_seconds.toFixed(1)} s` : ""}{asset.metadata.video_codec ? ` · ${asset.metadata.video_codec}` : ""}</small>}
                    {asset.processing_error && <small className="processing-warning">{asset.processing_error}</small>}</div>
                </div>)}</div>
              </div>;
            }) : <p className="empty">Nenhuma captação carregada. Informe a pasta do acervo acima e clique em Atualizar.</p>}
          </section>
        )}
        {page === "Revisão" && (
          <section className="review-section">
            <div className="section-heading"><div><span className="step">03 / 04</span><h2 className="processing-title">Revisão por take</h2>
              <p>A IA organiza cada mídia. Revise somente exceções ou use a edição opcional para corrigir algo. Os originais são preservados.</p></div>
              <button className="secondary" disabled={!destination || !workspace || busy} onClick={() => { void loadCaptures(); if (reviewCaptureId) void loadReviewItems(reviewCaptureId); }}>Atualizar</button>
            </div>
            <div className="review-context">
              <label>Captação para revisar
                <select disabled={busy} value={reviewCaptureId} onChange={event => void loadReviewItems(event.target.value)}>
                  <option value="">Selecione uma captação</option>
                  {captures.map(capture => <option key={capture.capture_id} value={capture.capture_id}>{capture.capture_name} · {new Date(capture.created_at).toLocaleDateString("pt-BR")}</option>)}
                </select>
              </label>
              {reviewCapture && <p className="hint">Contexto da captação: {reviewCapture.brief || "sem pauta informada"}. Locais visitados: {reviewCapture.visited_locations.length ? reviewCapture.visited_locations.join(" · ") : "não informados"}. Isso não define automaticamente o local de cada take.</p>}
            </div>
            {reviewItems.length > 0 && <div className="review-filters" aria-label="Filtrar takes">{([ ["all", "Todos", reviewItems.length], ["high", "Organizados pela IA", reviewItems.filter(aiOrganized).length], ["pending", "Precisa revisar", pendingReviews], ["confirmed", "Confirmados", reviewItems.filter(item => item.decision?.status === "confirmed").length] ] as const).map(([value, label, count]) => <button key={value} aria-pressed={reviewFilter === value} className={value === "pending" ? "filter-warning" : ""} onClick={() => setReviewFilter(value)}>{label} · {count}</button>)}<span>{reviewGroups.size} grupo(s) nesta visualização · originais preservados</span></div>}
            {reviewCaptureId && reviewItems.length > 0 ? <div className="review-layout">
              <div className="review-group-list" aria-label="Grupos de takes">
                {reviewGroups.size === 0 && <div className="card empty">Nenhum take neste filtro.</div>}
                {[...reviewGroups.entries()].map(([key, group]) => {
                  const strengths = group.items.flatMap(item => item.suggestion?.confidence == null ? [] : [item.suggestion.confidence]);
                  const reasons = [...new Set(group.items.flatMap(item => item.suggestion?.reason ? [item.suggestion.reason] : []))];
                  return <section className={`review-gallery review-group ${group.state === "pending" || group.state === "unidentified" ? "unknown-group" : ""}`} key={key}>
                    <div className="review-gallery-heading"><div><h3>{group.location}</h3><p className="hint">{group.matter} · {group.items.length} take(s)</p></div><span className={`step ${group.state === "pending" || group.state === "unidentified" ? "unknown-badge" : ""}`}>{group.state === "ai" ? "Organizado pela IA" : group.state === "confirmed" ? "Revisado" : group.state === "unidentified" ? "Sem local confirmado" : strengths.length ? `${Math.round(Math.min(...strengths) * 100)}% · força da pista` : "Precisa revisar"}</span></div>
                    <div className="review-take-grid">{group.items.map(item => {
                      const asset = reviewCapture?.assets.find(value => value.asset_id === item.asset_id);
                      return <button type="button" key={item.asset_id} aria-pressed={selectedAssetId === item.asset_id} className={`review-take ${selectedAssetId === item.asset_id ? "selected" : ""}`} onClick={() => setSelectedAssetId(item.asset_id)}>
                        <div className="review-take-visual">{asset && <Thumbnail destination={destination} workspace={workspace} captureId={reviewCaptureId} asset={asset} />}<span className="take-state-icon" aria-hidden="true">{item.decision?.status === "confirmed" ? "✓" : asset?.metadata?.kind === "video" ? "▶" : "▧"}</span></div>
                        <span><strong>{item.original_name}</strong><small>{asset?.metadata?.duration_seconds != null ? `${asset.metadata.duration_seconds.toFixed(1)} s · ` : ""}{asset?.metadata?.width && asset.metadata.height ? `${asset.metadata.width}×${asset.metadata.height}` : item.decision?.status === "confirmed" ? "Local confirmado" : item.decision?.status === "unidentified" ? "Local não identificado" : "Pendente de revisão"}</small></span>
                      </button>;
                    })}</div>
                    <div className={`group-explanation ${group.state === "pending" || group.state === "unidentified" ? "unknown-explanation" : ""}`}><strong>{group.state === "ai" ? "Agrupamento automático" : group.state === "suggested" ? "Por que este grupo?" : group.state === "confirmed" ? "Organização confirmada por você" : "Local não identificado"}</strong>
                      {group.state === "ai" ? <p>A IA classificou os takes por conteúdo e preparou assunto e tags. Você pode aprovar este resultado sem editar cada arquivo. Local desconhecido permanece sem identificação.</p> : group.state === "suggested" ? <>{reasons.map(reason => <p key={reason}>{reason}</p>)}<p className="hint">A força da pista ainda não é uma confiança calibrada. Confira cada take e salve sua decisão.</p></> : <p>{group.state === "confirmed" ? "Estes takes compartilham o local e a matéria registrados na revisão. Você pode editar as decisões ao lado." : group.state === "unidentified" ? "A revisão registrou que o local não foi identificado. Essa decisão permite concluir a organização sem inventar uma localização." : "Estes takes têm uma exceção ou análise ainda pendente. Execute a organização automática ou corrija somente os casos necessários."}</p>}
                    </div>
                  </section>;
                })}
              </div>
              {selectedReview && <div className="review-editor">
                <div className="review-editor-heading"><div><span className="step">Take {selectedReviewIndex + 1} de {reviewItems.length}</span><h3>{selectedReview.original_name}</h3></div><div className="review-navigation"><button type="button" className="secondary" disabled={selectedFilteredIndex <= 0} onClick={() => setSelectedAssetId(filteredReviewItems[selectedFilteredIndex - 1].asset_id)}>Anterior</button><button type="button" className="secondary" disabled={selectedFilteredIndex < 0 || selectedFilteredIndex >= filteredReviewItems.length - 1} onClick={() => setSelectedAssetId(filteredReviewItems[selectedFilteredIndex + 1].asset_id)}>Próximo</button></div></div>
                <p className="hint selected-take-meta">{(() => { const asset = reviewCapture?.assets.find(value => value.asset_id === selectedReview.asset_id); return [asset?.metadata?.duration_seconds != null ? `${asset.metadata.duration_seconds.toFixed(1)} s` : null, asset?.metadata?.width && asset.metadata.height ? `${asset.metadata.width}×${asset.metadata.height}` : null, asset?.metadata?.video_codec, asset?.metadata?.recorded_at].filter(Boolean).join(" · ") || "Metadados indisponíveis"; })()}</p>
                <div className="review-preview" aria-label={`Prévia de ${selectedReview.original_name}`}>
                  {preview?.kind === "image" && <img key={preview.url} src={preview.url} alt={selectedReview.original_name} onError={() => setPreviewError("Não foi possível abrir a imagem completa.")} />}
                  {preview?.kind === "video" && <video key={preview.url} src={preview.url} controls preload="metadata" onError={() => setPreviewError("Este vídeo não pôde ser reproduzido pelo player do sistema. A cópia verificada continua disponível no caminho abaixo.")}>Seu sistema não suporta a reprodução deste vídeo.</video>}
                  {!preview && !previewError && <p>Carregando prévia da cópia verificada…</p>}
                  {previewError && <p>{previewError}</p>}
                </div>
                {selectedReview.organization && <section className="review-evidence auto-organization"><strong>{selectedReview.organization.source === "ai" ? "Organização automática" : "Organização revisada"}</strong><h3>{selectedReview.organization.category}</h3><p><b>Assunto:</b> {selectedReview.organization.matter || "Não identificado"}</p><p><b>Local:</b> {selectedReview.organization.location || "Não identificado — organizado por conteúdo"}</p><div className="review-tag-chips">{selectedReview.organization.tags.map(tag => <span key={tag}>{tag}</span>)}</div><p className="hint">{selectedReview.organization.reason}</p></section>}
                <section className="review-evidence ai-result" aria-label="Análise visual do take"><strong>Qwen3-VL 4B · análise visual</strong>
                  {selectedReview.visual_analysis ? <><p>{selectedReview.visual_analysis.description}</p>{selectedReview.visual_analysis.visible_text.length > 0 && <p><b>Texto visível:</b> {selectedReview.visual_analysis.visible_text.join(" · ")}</p>}<p className="hint">{selectedReview.visual_analysis.frame_times_seconds.length} quadro(s) · {selectedReview.visual_analysis.frame_times_seconds.map(time => `${time.toFixed(1)} s`).join(" · ")} · {new Date(selectedReview.visual_analysis.analyzed_at).toLocaleString("pt-BR")}</p><div className="review-tag-chips">{selectedReview.visual_analysis.tags.map(tag => <span key={tag}>{tag}</span>)}</div>{selectedReview.visual_analysis.tags.length > 0 && <button className="secondary" disabled={busy} onClick={() => setReviewTags([...new Set([...reviewTagsList, ...(selectedReview.visual_analysis?.tags || [])])].slice(0, 20).join(", "))}>Preencher tags para conferir</button>}<p className="hint">A análise cobre as imagens amostradas e pode conter erros. Nada é confirmado automaticamente.</p></> : <p className="hint">Este take ainda não tem análise visual. As evidências técnicas e a revisão manual continuam disponíveis.</p>}
                  <button className="secondary ai-take-button" disabled={busy || !ollamaStatus?.model_ready || !reviewCapture || reviewHasChanges} onClick={() => { if (reviewCapture) void runVisualAnalysis(reviewCapture, selectedReview.asset_id, !!selectedReview.visual_analysis); }}>{selectedReview.visual_analysis ? "Reanalisar este take" : "Analisar este take com IA"}</button>
                  {reviewHasChanges && <p className="hint">Salve as alterações do take antes de solicitar uma nova análise.</p>}
                </section>
                {selectedReview.suggestion ? <div className="review-evidence" aria-label="Sugestão para conferência">
                  <strong>Local sugerido: {selectedReview.suggestion.location}</strong>
                  <p>{selectedReview.suggestion.reason}</p>
                  <p className="hint">Força indicativa da pista: {selectedReview.suggestion.confidence == null ? "não calculada" : `${Math.round(selectedReview.suggestion.confidence * 100)}%`}. Esse percentual ainda não foi calibrado em captações reais; o editor decide abaixo.</p>
                  {selectedReview.suggestion.location && <button type="button" className="secondary" onClick={() => { setReviewStatus("confirmed"); setReviewLocation(selectedReview.suggestion?.location || ""); }}>Preencher local para conferir</button>}
                </div> : <p className="hint">Nenhum local sugerido com segurança para este take. A pauta e os locais visitados, sozinhos, não definem onde ele foi gravado.</p>}
                <div className="review-evidence"><strong>Pistas disponíveis</strong>
                  {selectedReview.evidence.length ? <ul>{selectedReview.evidence.map(item => <li key={item.kind}><span>{item.label}:</span> {item.value} <small>({item.source})</small></li>)}</ul> : <p className="hint">Nenhum metadado útil para esta mídia.</p>}
                  <p className="hint">Coordenadas GPS ajudam a verificar o take, mas ainda não são convertidas automaticamente em nome de praia, loja ou bairro. As descrições visuais da IA são pistas adicionais e precisam de conferência.</p>
                </div>
                {(() => { const asset = reviewCapture?.assets.find(value => value.asset_id === selectedReview.asset_id); return asset && reviewCapture ? <p className="hint">Cópia verificada: <code className="copy-path">{readableLocalPath(reviewCapture.manifest_path.replace(/[\\/][^\\/]+$/, "") + "\\" + asset.copy_relative_path)}</code></p> : null; })()}
                <details className="optional-correction"><summary>Corrigir organização deste take (opcional)</summary><fieldset className="review-fields" disabled={aiRunning}>
                  <label>Grupo / categoria corrigida<input value={reviewCategory} maxLength={100} onChange={event => setReviewCategory(event.target.value)} placeholder="A categoria já vem preenchida pela IA" /></label>
                  <fieldset className="decision-options"><legend>Decisão sobre o local</legend>
                    <button type="button" aria-pressed={reviewStatus === "confirmed"} onClick={() => setReviewStatus("confirmed")}>Confirmar local</button>
                    <button type="button" aria-pressed={reviewStatus === "unidentified"} onClick={() => setReviewStatus("unidentified")}>Local não identificado</button>
                    <button type="button" aria-pressed={reviewStatus === "pending"} onClick={() => setReviewStatus("pending")}>Manter pendente</button>
                  </fieldset>
                  {reviewStatus === "pending" && <p className="hint">Matéria e tags podem ser salvas agora, mas este take continuará pendente até você confirmar um local ou marcar “Local não identificado”.</p>}
                  {reviewStatus === "confirmed" && <label>Local confirmado
                    <input list="review-location-options" value={reviewLocation} maxLength={120} onChange={event => setReviewLocation(event.target.value)} placeholder="Ex.: Praia do Morro" />
                  </label>}
                  <datalist id="review-location-options">{[...new Set([...(reviewCapture?.visited_locations || []), ...reviewItems.flatMap(item => [item.decision?.location, item.suggestion?.location].filter((value): value is string => !!value))])].map(location => <option key={location} value={location} />)}</datalist>
                  <label>Matéria / retranca deste take
                    <input value={reviewMatter} maxLength={120} onChange={event => setReviewMatter(event.target.value)} placeholder="Ex.: Movimento nas praias" />
                  </label>
                  <label>Tags (separadas por vírgula)
                    <input value={reviewTags} onChange={event => setReviewTags(event.target.value)} placeholder="Ex.: pessoas, praia, comércio" />
                  </label>
                  <label>Observação da revisão
                    <textarea value={reviewNote} maxLength={1000} onChange={event => setReviewNote(event.target.value)} rows={3} placeholder="Como você confirmou ou por que o local ficou incerto?" />
                  </label>
                </fieldset></details>
                {reviewTagsList.length > 0 && <div className="review-tag-chips" aria-label="Tags deste take">{reviewTagsList.map((tag, index) => <span key={`${tag}-${index}`}>{tag}</span>)}</div>}
                <button className="primary" type="button" disabled={busy || (!reviewHasChanges && !selectedReview.organization?.requires_review) || (reviewStatus === "confirmed" && !reviewLocation.trim())} onClick={() => void saveReview(!!selectedReview.organization?.requires_review && !reviewHasChanges)}>{busy ? "Salvando…" : reviewHasChanges ? "Salvar correção deste take" : selectedReview.organization?.requires_review ? "Validar esta exceção" : "Organização pronta para aprovação"}</button>
                <div className="review-history"><strong>Histórico local</strong>
                  {selectedReview.history.length ? <ul>{[...selectedReview.history].reverse().map(event => <li key={event.event_id}>{new Date(event.reviewed_at).toLocaleString("pt-BR")} · {event.status === "confirmed" ? `Local confirmado: ${event.location}` : event.status === "unidentified" ? "Local não identificado" : "Pendente"}{event.note ? ` · ${event.note}` : ""}</li>)}</ul> : <p className="hint">Ainda não há decisões salvas para este take.</p>}
                </div>
              </div>}
            </div> : <p className="empty">{reviewCaptureId ? "Esta captação não tem mídia verificada para revisar." : "Selecione uma captação. Se a lista estiver vazia, informe o acervo acima e clique em Atualizar."}</p>}
            {organizationApproval && <section className="card export-panel" aria-label="Criar pastas organizadas" aria-busy={exportPlanning || exportRunning}>
              <h2>Criar pastas com a organização aprovada</h2>
              <p>O Lumen copia os arquivos por categoria e assunto. Os originais e a revisão são preservados.</p>
              {exportPlanning && <p role="status">Preparando a prévia das pastas…</p>}
              {exportPlan && <>
                <label>Pasta de saída<input readOnly value={readableLocalPath(exportPlan.output_directory)} /></label>
                <p className="hint">{exportPlan.files.length} arquivo(s) · até {formatBytes(exportPlan.total_bytes)} adicionais. Identificadores nos nomes evitam colisões. Arquivos auxiliares ficam em uma pasta separada.</p>
                <details><summary>Ver a estrutura antes de copiar</summary><ul>{exportPlan.files.map(file => <li key={file.asset_id}><strong>{file.original_name}</strong><span>{file.relative_path}</span></li>)}</ul></details>
                {exportRunning && exportProgress && <div role="status"><p>Copiando e verificando {exportProgress.done}/{exportProgress.total}: {exportProgress.current}</p><progress max={exportProgress.total || 1} value={exportProgress.done} /></div>}
                <button className="primary" disabled={busy || reviewHasChanges || exportPlan.approval_id !== organizationApproval.approval_id} onClick={() => void exportOrganizedFiles()}>{exportRunning ? "Copiando e verificando…" : exportResult?.errors.length ? "Retomar cópias pendentes" : exportResult ? "Conferir arquivos exportados" : "Copiar arquivos para essas pastas"}</button>
              </>}
              {reviewHasChanges && <p className="hint">Salve a correção e aprove novamente antes de criar as pastas.</p>}
              {exportError && <p role="alert" className="approval-error">{exportError}</p>}
              {exportResult && <div role="status"><h3>{exportResult.errors.length ? "Exportação parcial" : "Pastas organizadas"}</h3><p>{exportResult.copied} copiado(s) · {exportResult.reused} já verificado(s) · {exportResult.errors.length} falha(s).</p><p className="hint">Relatório: {readableLocalPath(exportResult.report_path)}</p>{!exportResult.approval_current && <p>A revisão mudou durante a cópia. Estas pastas correspondem à aprovação anterior; aprove novamente para gerar a versão atualizada.</p>}{exportResult.errors.length > 0 && <ul>{exportResult.errors.map((error, index) => <li key={index}>{error}</li>)}</ul>}</div>}
            </section>}
            {reviewItems.length > 0 && <section className="action-banner approval-banner"><span aria-hidden="true">✓</span><div><h2>{organizationApproval ? "Organização aprovada" : "A IA organiza; você aprova"}</h2><p>{organizationApproval ? `Aprovação registrada em ${new Date(organizationApproval.approved_at).toLocaleString("pt-BR")}. Alterar uma decisão exigirá uma nova aprovação.` : reviewHasChanges ? "Salve as alterações do take antes de aprovar." : pendingReviews ? `${pendingReviews} take(s) precisam de atenção: falta análise ou há uma exceção. Os demais já estão organizados.` : "Os grupos, assuntos e tags já estão preparados. Aprove o conjunto sem preencher cada take."}</p><p>Os originais não são movidos. As decisões e o histórico continuam disponíveis para edição.</p>{approvalError && <p className="approval-error" role="alert">{approvalError}</p>}</div><button className="primary" disabled={!canApproveOrganization} onClick={() => void approveOrganization()}>{organizationApproval ? "Aprovado" : "Aprovar organização"}</button></section>}
          </section>
        )}
      </main>
    </div>
  );
}

declare global {
  interface Window {
    __TAURI_INTERNALS__?: unknown;
  }
}
