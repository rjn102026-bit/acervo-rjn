import { useEffect, useId, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import navIdle from "./assets/nav-idle.svg";
import navActive from "./assets/nav-active.svg";
import rjnMark from "./assets/rjn-mark.svg";
import interLicenseUrl from "./assets/fonts/LICENSE.txt?url";
import SetupDialog from "./SetupDialog";
import {
  aiOrganized,
  filterReviewItems,
  groupReviewItems,
  reviewBaseline,
  reviewDraftChanged,
  searchCatalog,
  searchCaptures,
} from "./catalog";
import type {
  Asset,
  CatalogSearchFilters,
  Manifest,
  ReviewDraft,
  ReviewEvent,
  ReviewItem,
  ReviewSearchEntry,
  VisualAnalysis,
} from "./catalog";

type OllamaStatus = {
  running: boolean;
  model_ready: boolean;
  model: string;
  message: string;
};
type AiProgress = {
  total: number;
  done: number;
  succeeded: number;
  current: string;
  errors: string[];
  cancelled: boolean;
};
type AiJob = {
  destination: string;
  workspace: string;
  captureId: string;
  detailed: boolean;
};
type IngestProgress = {
  capture_id: string;
  done: number;
  total: number;
  verified: number;
  failed: number;
  current: string;
  stage: string;
};

type SourceDevice = {
  path: string;
  label: string;
  capacity_bytes: number;
  free_bytes: number;
};
type SourceInventory = {
  path: string;
  videos: number;
  images: number;
  sidecars: number;
  total_bytes: number;
  ignored_files: number;
  unreadable_entries: number;
  partial: boolean;
};

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  const exponent = Math.min(
    Math.floor(Math.log(bytes) / Math.log(1024)),
    units.length,
  );
  return `${(bytes / 1024 ** exponent).toLocaleString("pt-BR", { maximumFractionDigits: 1 })} ${units[exponent - 1]}`;
}

type CaptureCatalog = { captures: Manifest[]; warnings: string[] };

type OrganizationApproval = {
  approval_id: string;
  approved_at: string;
  decisions: (Omit<ReviewEvent, "status"> & {
    status: ReviewEvent["status"] | "ai_organized";
  })[];
};
type LocalSettings = { workspace: string; destination: string; source: string };
function readStored<T>(key: string, fallback: T): T {
  try {
    return JSON.parse(localStorage.getItem(key) || "null") ?? fallback;
  } catch {
    return fallback;
  }
}
function writeStored(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}
function initialSettings(): LocalSettings {
  const saved = readStored<Partial<LocalSettings>>("lumen.settings.v1", {});
  return {
    workspace:
      typeof saved?.workspace === "string" ? saved.workspace : "pessoal",
    destination:
      typeof saved?.destination === "string" ? saved.destination : "",
    source: typeof saved?.source === "string" ? saved.source : "",
  };
}
function initialDrafts(): Record<string, ReviewDraft> {
  const saved = readStored<unknown>("lumen.review-drafts.v1", {});
  if (!saved || typeof saved !== "object" || Array.isArray(saved)) return {};
  return Object.fromEntries(
    Object.entries(saved).filter(
      ([, value]) =>
        value &&
        typeof value === "object" &&
        ["pending", "confirmed", "unidentified"].includes(value.status) &&
        ["location", "matter", "category", "tags", "note"].every(
          (field) => typeof value[field] === "string",
        ),
    ),
  );
}

type ExportPlan = {
  approval_id: string;
  output_directory: string;
  total_bytes: number;
  files: {
    asset_id: string;
    original_name: string;
    relative_path: string;
    bytes: number;
  }[];
};
type ExportResult = {
  approval_id: string;
  output_directory: string;
  copied: number;
  reused: number;
  errors: string[];
  report_path: string;
  approval_current: boolean;
};
type ExportProgress = {
  approval_id: string;
  done: number;
  total: number;
  current: string;
};

type PreviewDescriptor = { url: string; kind: "image" | "video" };

type Page = "Acervo" | "Nova ingestão" | "Processamento" | "Revisão";
const pages: Page[] = ["Acervo", "Nova ingestão", "Processamento", "Revisão"];
const mediaExtension =
  /\.(mp4|mov|mxf|avi|mts|m2ts|mpg|mpeg|jpg|jpeg|png|tif|tiff|dng|heic|cr2|nef)$/i;
const noCatalogFilters: CatalogSearchFilters = {
  location: "",
  matter: "",
  date: "",
  tag: "",
  status: "all",
};
const catalogSearchExamples = [
  "pessoas em lojas no Shopping Vitória",
  "Praia do Morro",
  "C001",
];
function closeCatalogFilterPanels(except: Element | null = null) {
  document.querySelectorAll<HTMLDetailsElement>(".catalog-filter[open]")
    .forEach((filter) => { if (filter !== except) filter.open = false; });
}

const normalizeFilterText = (value: string) =>
  value.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLocaleLowerCase("pt-BR");

function CatalogFilterOptions({
  label,
  value,
  options,
  onChange,
  searchable = true,
}: {
  label: string;
  value: string;
  options: { value: string; label: string }[];
  onChange: (value: string) => void;
  searchable?: boolean;
}) {
  const [query, setQuery] = useState("");
  const panelRef = useRef<HTMLDivElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const listId = useId();
  const visibleOptions = options.filter((option) =>
    normalizeFilterText(option.label).includes(normalizeFilterText(query.trim())),
  );
  useEffect(() => {
    const details = panelRef.current?.closest("details");
    if (!details) return;
    const onToggle = () => {
      if (details.open) {
        if (searchable) searchRef.current?.focus({ preventScroll: true });
        else listRef.current?.querySelector<HTMLButtonElement>('[aria-selected="true"]')?.focus({ preventScroll: true });
      } else setQuery("");
    };
    details.addEventListener("toggle", onToggle);
    return () => details.removeEventListener("toggle", onToggle);
  }, [searchable]);
  return (
    <div className="catalog-filter-content" ref={panelRef}>
      <strong className="catalog-filter-title">{label}</strong>
      {searchable && (
        <input
          ref={searchRef}
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={`Buscar ${label.toLocaleLowerCase("pt-BR")}…`}
          aria-label={`Buscar opções de ${label.toLocaleLowerCase("pt-BR")}`}
          aria-controls={listId}
          onKeyDown={(event) => {
            if (event.key === "ArrowDown" || event.key === "ArrowUp") {
              event.preventDefault();
              const buttons = listRef.current?.querySelectorAll<HTMLButtonElement>('[role="option"]');
              if (buttons?.length) buttons[event.key === "ArrowDown" ? 0 : buttons.length - 1].focus();
            }
          }}
        />
      )}
      <div
        className="catalog-filter-options"
        ref={listRef}
        id={listId}
        role="listbox"
        aria-label={label}
        onKeyDown={(event) => {
          const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="option"]'));
          const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
          let next = index;
          if (event.key === "ArrowDown") next = Math.min(index + 1, buttons.length - 1);
          else if (event.key === "ArrowUp") next = Math.max(index - 1, 0);
          else if (event.key === "Home") next = 0;
          else if (event.key === "End") next = buttons.length - 1;
          else return;
          event.preventDefault();
          buttons[next]?.focus();
        }}
      >
        {visibleOptions.map((option, index) => (
          <button
            key={option.value}
            type="button"
            role="option"
            aria-selected={value === option.value}
            tabIndex={value === option.value || (!visibleOptions.some((item) => item.value === value) && index === 0) ? 0 : -1}
            onClick={(event) => {
              const summary = event.currentTarget.closest("details")?.querySelector("summary");
              onChange(option.value);
              summary?.focus({ preventScroll: true });
            }}
          >
            <span>{option.label}</span>
            {value === option.value && <span aria-hidden="true">✓</span>}
          </button>
        ))}
      </div>
      {!visibleOptions.length && <p className="catalog-filter-empty" role="status">Nenhuma opção encontrada.</p>}
    </div>
  );
}

function readableLocalPath(path: string) {
  const windowsPath = path.replace(/\//g, "\\");
  if (windowsPath.startsWith("\\\\?\\UNC\\"))
    return "\\\\" + windowsPath.slice(8);
  if (windowsPath.startsWith("\\\\?\\")) return windowsPath.slice(4);
  return windowsPath;
}

function Thumbnail({
  destination,
  workspace,
  captureId,
  asset,
}: {
  destination: string;
  workspace: string;
  captureId: string;
  asset: Asset;
}) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    if (!asset.thumbnail_relative_path || !window.__TAURI_INTERNALS__) return;
    invoke<string | null>("thumbnail_data_url", {
      destination,
      workspace,
      captureId,
      assetId: asset.asset_id,
    })
      .then((result) => {
        if (active) setUrl(result);
      })
      .catch(() => {
        if (active) setUrl(null);
      });
    return () => {
      active = false;
    };
  }, [
    destination,
    workspace,
    captureId,
    asset.asset_id,
    asset.thumbnail_relative_path,
  ]);
  return url ? (
    <img
      className="thumbnail"
      src={url}
      alt={`Miniatura de ${asset.original_name}`}
    />
  ) : (
    <div className="thumbnail placeholder">Sem miniatura</div>
  );
}

export default function App() {
  const [setupOpen, setSetupOpen] = useState(() =>
    !!window.__TAURI_INTERNALS__ && !readStored<boolean>("lumen.setup.v1", false));
  const [initial] = useState(initialSettings);
  const [page, setPage] = useState<Page>(
    initial.destination ? "Acervo" : "Nova ingestão",
  );
  const [settingsOpen, setSettingsOpen] = useState(!initial.destination);
  const settingsRef = useRef<HTMLDetailsElement>(null);
  const aiSettingsRef = useRef<HTMLDetailsElement>(null);
  const [reviewFilter, setReviewFilter] = useState<
    "all" | "pending" | "confirmed" | "high" | "unlocated"
  >("all");
  const [workspace, setWorkspace] = useState(initial.workspace);
  const [captureName, setCaptureName] = useState("");
  const [brief, setBrief] = useState("");
  const [locationsText, setLocationsText] = useState("");
  const [team, setTeam] = useState("");
  const [source, setSource] = useState(initial.source);
  const [destination, setDestination] = useState(initial.destination);
  const [devices, setDevices] = useState<SourceDevice[]>([]);
  const [deviceError, setDeviceError] = useState("");
  const [deviceChecking, setDeviceChecking] = useState(false);
  const [deviceRefresh, setDeviceRefresh] = useState(0);
  const [autoSourceRoot, setAutoSourceRoot] = useState("");
  const [sourceInventory, setSourceInventory] =
    useState<SourceInventory | null>(null);
  const [sourceScanning, setSourceScanning] = useState(false);
  const [sourceError, setSourceError] = useState("");
  const [sourceRefresh, setSourceRefresh] = useState(0);
  const sourceRef = useRef(source);
  sourceRef.current = source;

  const [searchQuery, setSearchQuery] = useState("");
  const [submittedSearch, setSubmittedSearch] = useState("");
  const [searchFilters, setSearchFilters] = useState<CatalogSearchFilters>({
    ...noCatalogFilters,
  });
  const [searchFocused, setSearchFocused] = useState(false);
  const [recentSearches, setRecentSearches] = useState<string[]>(() => {
    const saved = readStored<unknown>("lumen.catalog-searches.v1", []);
    return Array.isArray(saved)
      ? saved
          .filter((value): value is string => typeof value === "string")
          .slice(0, 5)
      : [];
  });
  const [showFullCatalog, setShowFullCatalog] = useState(false);
  const [capturesLoading, setCapturesLoading] = useState(false);
  const [catalogSelection, setCatalogSelection] = useState<{
    captureId: string;
    assetId: string;
  } | null>(null);
  const [catalogSelectedReview, setCatalogSelectedReview] =
    useState<ReviewItem | null>(null);
  const [catalogPreview, setCatalogPreview] =
    useState<PreviewDescriptor | null>(null);
  const [catalogPreviewError, setCatalogPreviewError] = useState("");
  const [catalogPreviewLoading, setCatalogPreviewLoading] = useState(false);
  const catalogPreviewRequest = useRef(0);
  const catalogResultsRef = useRef<HTMLElement | null>(null);
  const catalogPreviewPanelRef = useRef<HTMLElement | null>(null);
  const [busy, setBusy] = useState(false);
  const [ingesting, setIngesting] = useState(false);
  const [ingestProgress, setIngestProgress] = useState<IngestProgress | null>(
    null,
  );
  const [message, setMessage] = useState("");
  const [latest, setLatest] = useState<Manifest | null>(null);
  const [captures, setCaptures] = useState<Manifest[]>([]);
  const [reviewIndex, setReviewIndex] = useState<ReviewSearchEntry[]>([]);
  const [processingCaptureId, setProcessingCaptureId] = useState("");
  const [reviewCaptureId, setReviewCaptureId] = useState("");
  const [reviewItems, setReviewItems] = useState<ReviewItem[]>([]);
  const [selectedAssetId, setSelectedAssetId] = useState("");
  const [reviewStatus, setReviewStatus] =
    useState<ReviewEvent["status"]>("pending");
  const [reviewLocation, setReviewLocation] = useState("");
  const [reviewMatter, setReviewMatter] = useState("");
  const [reviewCategory, setReviewCategory] = useState("");
  const [reviewTags, setReviewTags] = useState("");
  const [reviewNote, setReviewNote] = useState("");
  const [preview, setPreview] = useState<PreviewDescriptor | null>(null);
  const [previewError, setPreviewError] = useState("");
  const [organizationApproval, setOrganizationApproval] =
    useState<OrganizationApproval | null>(null);
  const [approvalError, setApprovalError] = useState("");
  const [exportPlan, setExportPlan] = useState<ExportPlan | null>(null);
  const [exportResult, setExportResult] = useState<ExportResult | null>(null);
  const [exportProgress, setExportProgress] = useState<ExportProgress | null>(
    null,
  );
  const [exportError, setExportError] = useState("");
  const [exportPlanning, setExportPlanning] = useState(false);
  const [exportRunning, setExportRunning] = useState(false);
  const [approvalLoading, setApprovalLoading] = useState(false);
  const [ollamaStatus, setOllamaStatus] = useState<OllamaStatus | null>(null);
  const [ollamaChecking, setOllamaChecking] = useState(false);
  const [aiDetailed, setAiDetailed] = useState(false);
  const [aiRunning, setAiRunning] = useState(false);
  const [aiProgress, setAiProgress] = useState<AiProgress | null>(null);
  const [queuedAi, setQueuedAi] = useState<AiJob | null>(() =>
    readStored("lumen.ai-job.v1", null),
  );
  const [batchIds, setBatchIds] = useState<string[]>([]);
  const [batchStatus, setBatchStatus] = useState("");
  const [batchLocation, setBatchLocation] = useState("");
  const [batchMatter, setBatchMatter] = useState("");
  const [batchTags, setBatchTags] = useState("");
  const [batchMatterEnabled, setBatchMatterEnabled] = useState(false);
  const [batchTagsEnabled, setBatchTagsEnabled] = useState(false);
  const aiActive = useRef(false);
  const aiCancel = useRef(false);
  const aiContext = useRef("");
  aiContext.current = `${destination}\u0000${workspace}`;
  const reviewCaptureRef = useRef(reviewCaptureId);
  reviewCaptureRef.current = reviewCaptureId;
  const captureRequest = useRef(0);
  const reviewRequest = useRef(0);
  const [storedDrafts] = useState(initialDrafts);
  const draftCache = useRef(storedDrafts);
  const draftKey = (captureId = reviewCaptureId, assetId = selectedAssetId) =>
    JSON.stringify([destination, workspace, captureId, assetId]);
  function editReview(changes: Partial<ReviewDraft>) {
    const draft = {
      status: reviewStatus,
      location: reviewLocation,
      matter: reviewMatter,
      category: reviewCategory,
      tags: reviewTags,
      note: reviewNote,
      ...changes,
    };
    draftCache.current[draftKey()] = draft;
    if (!writeStored("lumen.review-drafts.v1", draftCache.current))
      setMessage(
        "Rascunho preservado nesta sessão, mas o armazenamento local está cheio. Salve a revisão antes de fechar.",
      );
    setReviewStatus(draft.status);
    setReviewLocation(draft.location);
    setReviewMatter(draft.matter);
    setReviewCategory(draft.category);
    setReviewTags(draft.tags);
    setReviewNote(draft.note);
  }
  useEffect(() => {
    writeStored("lumen.settings.v1", { workspace, destination, source });
  }, [workspace, destination, source]);

  useEffect(() => {
    const timer = window.setTimeout(
      () => setSubmittedSearch(searchQuery.trim()),
      350,
    );
    return () => window.clearTimeout(timer);
  }, [searchQuery]);

  useEffect(() => {
    const closeControls = (event: MouseEvent | KeyboardEvent) => {
      if (event instanceof KeyboardEvent && event.key !== "Escape") return;
      if (event instanceof MouseEvent && event.target instanceof Element &&
          event.target.closest(".catalog-search-wrap, .catalog-search-filters")) return;
      setSearchFocused(false);
      if (event instanceof KeyboardEvent) {
        const filter = document.querySelector<HTMLDetailsElement>(".catalog-filter[open]");
        if (filter) {
          closeCatalogFilterPanels();
          filter.querySelector("summary")?.focus({ preventScroll: true });
          return;
        }
        catalogPreviewRequest.current += 1;
        document.querySelector<HTMLButtonElement>(".catalog-result-main[aria-pressed='true']")?.focus();
        setCatalogSelection(null);
      }
      closeCatalogFilterPanels();
    };
    document.addEventListener("click", closeControls);
    document.addEventListener("keydown", closeControls);
    return () => {
      document.removeEventListener("click", closeControls);
      document.removeEventListener("keydown", closeControls);
    };
  }, []);

  useEffect(() => {
    captureRequest.current += 1;
    reviewRequest.current += 1;
    setLatest(null);
    setCaptures([]);
    setReviewIndex([]);
    setProcessingCaptureId("");
    setReviewCaptureId("");
    setReviewItems([]);
    setSelectedAssetId("");
  }, [destination, workspace]);
  useEffect(() => {
    if (destination && workspace && window.__TAURI_INTERNALS__)
      void loadCaptures();
  }, [destination, workspace]);
  useEffect(() => {
    setBatchIds([]);
    setBatchStatus("");
    setBatchLocation("");
    setBatchMatter("");
    setBatchTags("");
    setBatchMatterEnabled(false);
    setBatchTagsEnabled(false);
  }, [reviewCaptureId, destination, workspace]);

  useEffect(() => {
    const item = reviewItems.find((item) => item.asset_id === selectedAssetId);
    const draft = draftCache.current[draftKey()] || reviewBaseline(item);
    setReviewStatus(draft.status);
    setReviewLocation(draft.location);
    setReviewMatter(draft.matter);
    setReviewCategory(draft.category);
    setReviewTags(draft.tags);
    setReviewNote(draft.note);
  }, [reviewItems, selectedAssetId, reviewCaptureId, destination, workspace]);

  useEffect(() => {
    setPreview(null);
    setPreviewError("");
    if (
      page !== "Revisão" ||
      !selectedAssetId ||
      !reviewCaptureId ||
      !destination ||
      !workspace ||
      !window.__TAURI_INTERNALS__
    )
      return;
    let active = true;
    invoke<PreviewDescriptor>("create_preview", {
      destination,
      workspace,
      captureId: reviewCaptureId,
      assetId: selectedAssetId,
    })
      .then((result) => {
        if (active) setPreview(result);
      })
      .catch((error) => {
        if (active) setPreviewError(String(error));
      });
    return () => {
      active = false;
    };
  }, [page, destination, workspace, reviewCaptureId, selectedAssetId]);

  // Poll only the device list. Media are counted once when an origin is chosen,
  // reconnected, or explicitly refreshed; the original files are never opened.
  useEffect(() => {
    if (
      (page !== "Nova ingestão" && page !== "Acervo") ||
      busy ||
      !window.__TAURI_INTERNALS__
    )
      return;
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    async function refresh() {
      setDeviceChecking(true);
      try {
        const result = await invoke<SourceDevice[]>("list_source_devices");
        if (!active) return;
        setDevices(result);
        setDeviceError("");
        if (
          page === "Nova ingestão" &&
          !sourceRef.current.trim() &&
          result.length === 1
        ) {
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
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [page, busy, deviceRefresh]);

  useEffect(() => {
    const device = devices.find((device) =>
      source.toLocaleLowerCase().startsWith(device.path.toLocaleLowerCase()),
    );
    if (device) setAutoSourceRoot(device.path);
  }, [devices, source]);

  const sourceAttached =
    !autoSourceRoot || devices.some((device) => device.path === autoSourceRoot);
  useEffect(() => {
    if (page !== "Nova ingestão" || busy) return;
    setSourceInventory(null);
    setSourceError("");
    if (!source.trim()) {
      setSourceScanning(false);
      return;
    }
    if (!sourceAttached) {
      setSourceError(
        "Dispositivo desconectado. Reconecte o pendrive ou escolha outra origem.",
      );
      setSourceScanning(false);
      return;
    }
    if (!window.__TAURI_INTERNALS__) {
      setSourceError(
        "A análise da origem está disponível no aplicativo Lumen Desktop.",
      );
      setSourceScanning(false);
      return;
    }
    let active = true;
    setSourceScanning(true);
    const timer = setTimeout(() => {
      invoke<SourceInventory>("inspect_source", { source: source.trim() })
        .then((result) => {
          if (active) setSourceInventory(result);
        })
        .catch((error) => {
          if (active) setSourceError(String(error));
        })
        .finally(() => {
          if (active) setSourceScanning(false);
        });
    }, 500);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [source, sourceRefresh, sourceAttached, page, busy]);

  const sourceFileCount = sourceInventory
    ? sourceInventory.videos + sourceInventory.images + sourceInventory.sidecars
    : 0;
  const sourceReady =
    !!sourceInventory &&
    sourceInventory.path === source.trim() &&
    sourceFileCount > 0 &&
    !sourceScanning &&
    !sourceError &&
    sourceAttached;
  const sourceDevice = devices.find((device) =>
    source.toLocaleLowerCase().startsWith(device.path.toLocaleLowerCase()),
  );

  const reviewRevision = reviewItems
    .map(
      (item) =>
        item.organization?.event_id || item.decision?.event_id || item.asset_id,
    )
    .join(",");
  useEffect(() => {
    setOrganizationApproval(null);
    setApprovalError("");
    if (!reviewCaptureId || !window.__TAURI_INTERNALS__) return;
    let active = true;
    setApprovalLoading(true);
    invoke<OrganizationApproval | null>("get_organization_approval", {
      destination,
      workspace,
      captureId: reviewCaptureId,
    })
      .then((value) => {
        if (active) setOrganizationApproval(value);
      })
      .catch((error) => {
        if (active) setApprovalError(String(error));
      })
      .finally(() => {
        if (active) setApprovalLoading(false);
      });
    return () => {
      active = false;
    };
  }, [destination, workspace, reviewCaptureId, reviewRevision]);

  useEffect(() => {
    if (page === "Revisão" && !reviewCaptureId && captures.length > 0)
      void loadReviewItems(captures[0].capture_id);
  }, [page, captures, reviewCaptureId]);

  async function approveOrganization() {
    if (
      !reviewCaptureId ||
      busy ||
      captureHasDrafts ||
      pendingReviews ||
      !reviewItems.length
    )
      return;
    setBusy(true);
    setApprovalError("");
    try {
      const approval = await invoke<OrganizationApproval>(
        "approve_organization",
        {
          destination,
          workspace,
          captureId: reviewCaptureId,
          expectedEventIds: reviewItems.flatMap((item) =>
            item.organization ? [item.organization.event_id] : [],
          ),
        },
      );
      setOrganizationApproval(approval);
      setMessage(
        `Organização aprovada: ${approval.decisions.length} take(s). O registro foi salvo e os originais permanecem preservados.`,
      );
    } catch (error) {
      setApprovalError(String(error));
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    setExportPlan(null);
    setExportResult(null);
    setExportProgress(null);
    setExportError("");
    if (
      !organizationApproval ||
      !reviewCaptureId ||
      !window.__TAURI_INTERNALS__
    ) {
      setExportPlanning(false);
      return;
    }
    let active = true;
    setExportPlanning(true);
    invoke<ExportPlan>("plan_organized_export", {
      destination,
      workspace,
      captureId: reviewCaptureId,
    })
      .then((plan) => {
        if (active && plan.approval_id === organizationApproval.approval_id)
          setExportPlan(plan);
      })
      .catch((error) => {
        if (active) setExportError(String(error));
      })
      .finally(() => {
        if (active) setExportPlanning(false);
      });
    return () => {
      active = false;
    };
  }, [
    destination,
    workspace,
    reviewCaptureId,
    organizationApproval?.approval_id,
  ]);

  async function exportOrganizedFiles() {
    if (
      !exportPlan ||
      busy ||
      captureHasDrafts ||
      exportPlan.approval_id !== organizationApproval?.approval_id
    )
      return;
    setBusy(true);
    setExportRunning(true);
    setExportError("");
    setExportResult(null);
    setExportProgress({
      approval_id: exportPlan.approval_id,
      done: 0,
      total: exportPlan.files.length,
      current: "Preparando cópias…",
    });
    let unlisten: (() => void) | undefined;
    try {
      unlisten = await listen<ExportProgress>(
        "organized-export-progress",
        (event) => {
          if (event.payload.approval_id === exportPlan.approval_id)
            setExportProgress(event.payload);
        },
      );
      const result = await invoke<ExportResult>("export_organized_files", {
        destination,
        workspace,
        captureId: reviewCaptureId,
        expectedApprovalId: exportPlan.approval_id,
      });
      setExportResult(result);
      setMessage(
        result.errors.length
          ? `Pastas criadas parcialmente: ${result.errors.length} falha(s). Confira os detalhes e retome a cópia.`
          : `Pastas organizadas: ${result.copied} arquivo(s) copiados e ${result.reused} já verificados.`,
      );
    } catch (error) {
      setExportError(String(error));
    } finally {
      unlisten?.();
      setExportRunning(false);
      setBusy(false);
    }
  }

  async function refreshOllama() {
    if (!window.__TAURI_INTERNALS__) return;
    setOllamaChecking(true);
    try {
      setOllamaStatus(await invoke<OllamaStatus>("get_ollama_status"));
    } catch (error) {
      setOllamaStatus({
        running: false,
        model_ready: false,
        model: "qwen3-vl:4b-instruct",
        message: String(error),
      });
    } finally {
      setOllamaChecking(false);
    }
  }
  useEffect(() => {
    void refreshOllama();
  }, []);
  useEffect(() => {
    aiCancel.current = true;
  }, [destination, workspace]);

  async function runVisualAnalysis(
    capture: Manifest,
    assetId?: string,
    force = false,
    detailed = aiDetailed,
  ) {
    if (aiActive.current || !window.__TAURI_INTERNALS__) return;
    const currentContext = `${destination}\u0000${workspace}`;
    const assets = capture.assets.filter(
      (asset) =>
        asset.status === "verified" &&
        mediaExtension.test(asset.original_name) &&
        (!assetId || asset.asset_id === assetId),
    );
    if (!assets.length) return;
    aiActive.current = true;
    aiCancel.current = false;
    setAiRunning(true);
    setBusy(true);
    let consecutiveOutputFailures = 0;
    const progress: AiProgress = {
      total: assets.length,
      done: 0,
      succeeded: 0,
      current: "Conectando ao Ollama…",
      errors: [],
      cancelled: false,
    };
    const job: AiJob | null = assetId
      ? null
      : { destination, workspace, captureId: capture.capture_id, detailed };
    if (job) {
      setQueuedAi(job);
      writeStored("lumen.ai-job.v1", job);
    }
    setAiProgress({ ...progress });
    try {
      const status = await invoke<OllamaStatus>("get_ollama_status");
      setOllamaStatus(status);
      if (!status.model_ready) throw new Error(status.message);
      for (const asset of assets) {
        if (aiCancel.current || aiContext.current !== currentContext) {
          progress.cancelled = true;
          break;
        }
        progress.current = asset.original_name;
        setAiProgress({ ...progress, errors: [...progress.errors] });
        try {
          await invoke<VisualAnalysis>("analyze_visual_asset", {
            destination,
            workspace,
            captureId: capture.capture_id,
            assetId: asset.asset_id,
            force,
            detailed,
          });
          progress.succeeded += 1;
          consecutiveOutputFailures = 0;
        } catch (error) {
          const detail = String(error);
          progress.errors.push(`${asset.original_name}: ${detail}`);
          consecutiveOutputFailures = detail.includes("AI_INVALID_OUTPUT:")
            ? consecutiveOutputFailures + 1
            : 0;
          if (
            detail.includes("AI_MODEL_THINKING_ONLY:") ||
            consecutiveOutputFailures >= 2
          ) {
            progress.done += 1;
            progress.cancelled = true;
            progress.errors.push(
              "Fila interrompida por falha repetida na resposta do modelo. Os arquivos restantes não foram enviados; resultados anteriores foram preservados.",
            );
            break;
          }
        }
        progress.done += 1;
        setAiProgress({ ...progress, errors: [...progress.errors] });
      }
      if (aiContext.current === currentContext) {
        setReviewIndex(
          await invoke<ReviewSearchEntry[]>("list_review_index", {
            destination,
            workspace,
          }),
        );
        if (
          reviewCaptureRef.current === capture.capture_id ||
          (!assetId && progress.succeeded > 0)
        ) {
          if (!assetId && progress.succeeded > 0) {
            reviewCaptureRef.current = capture.capture_id;
            setReviewCaptureId(capture.capture_id);
            setReviewFilter("all");
          }

          const items = await invoke<ReviewItem[]>("list_review_items", {
            destination,
            workspace,
            captureId: capture.capture_id,
          });
          setReviewItems(items);
          setSelectedAssetId((current) =>
            items.some((item) => item.asset_id === current)
              ? current
              : items[0]?.asset_id || "",
          );
        }
        setMessage(
          `IA local: ${progress.succeeded} de ${progress.done} take(s) com análise disponível.${progress.cancelled ? " A fila foi interrompida; os resultados concluídos foram preservados." : progress.errors.length ? " Confira as falhas antes de aprovar o conjunto." : " A organização está pronta para aprovação na Revisão."}`,
        );
      }
    } catch (error) {
      progress.errors.push(String(error));
      setMessage(`Análise visual não concluída: ${String(error)}`);
    } finally {
      if (
        job &&
        progress.done === progress.total &&
        progress.errors.length === 0
      ) {
        setQueuedAi(null);
        writeStored("lumen.ai-job.v1", null);
      }
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
      setMessage(
        "A seleção de pastas só funciona no aplicativo Lumen Desktop.",
      );
      return;
    }
    try {
      const selected = await open({ directory: true, multiple: false });
      if (selected) {
        if (which === "source") {
          setAutoSourceRoot(
            devices.find((device) =>
              selected
                .toLocaleLowerCase()
                .startsWith(device.path.toLocaleLowerCase()),
            )?.path || "",
          );
          setSource(selected);
          setSourceRefresh((value) => value + 1);
        } else setDestination(selected);
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
      setMessage(
        "Aguarde a análise da origem ou escolha uma pasta com arquivos suportados.",
      );
      return;
    }
    if (
      !window.confirm(
        `Confirmar ingestão no espaço “${workspace}”? A origem não será alterada.`,
      )
    )
      return;
    const captureNameForIngest =
      captureName.trim() ||
      `Captação ${new Date().toLocaleString("pt-BR")}`;
    let ingested: Manifest | null = null;
    const context = `${destination}\u0000${workspace}`;
    let unlisten: (() => void) | undefined;
    setBusy(true);
    setIngesting(true);
    setIngestProgress(null);
    setMessage("Copiando e verificando os arquivos. Não remova o cartão.");
    try {
      unlisten = await listen<IngestProgress>("ingest-progress", (event) => {
        if (aiContext.current === context) setIngestProgress(event.payload);
      });
      const result = await invoke<Manifest>("ingest_capture", {
        source: source.trim(),
        destination,
        workspace,
        captureName: captureNameForIngest,
        brief,
        team,
        visitedLocations: locationsText
          .split(/\r?\n/)
          .map((item) => item.trim())
          .filter(Boolean),
        toolsDirectory: null,
      });
      ingested = result;
      setLatest(result);
      setCaptures((current) => [
        result,
        ...current.filter((item) => item.capture_id !== result.capture_id),
      ]);
      setProcessingCaptureId(result.capture_id);
      setMessage(
        `${result.verified_count} arquivo(s) verificado(s); ${result.failed_count} falha(s). Confira o manifesto antes de liberar o cartão.`,
      );
    } catch (error) {
      await loadCaptures();
      setMessage(`Ingestão não concluída: ${String(error)}`);
    } finally {
      unlisten?.();
      setIngesting(false);
      setBusy(false);
    }
    if (ingested && aiContext.current === context) {
      setPage("Processamento");
      let aiReady = ollamaStatus?.model_ready === true;
      if (!aiReady) {
        try {
          const currentStatus = await invoke<OllamaStatus>("get_ollama_status");
          setOllamaStatus(currentStatus);
          aiReady = currentStatus.model_ready;
        } catch {
          aiReady = false;
        }
      }
      if (aiReady) {
        await runVisualAnalysis(ingested);
      } else {
        setMessage(
          "Cópia concluída. A IA não está pronta neste computador; configure a IA local e depois inicie a organização em Processamento.",
        );
      }
    }
  }

  async function loadCaptures() {
    if (!window.__TAURI_INTERNALS__) {
      setMessage("O acervo local só fica disponível no aplicativo instalado.");
      return;
    }
    const request = ++captureRequest.current;
    const context = `${destination}\u0000${workspace}`;
    const isCurrent = () =>
      request === captureRequest.current && aiContext.current === context;
    setCapturesLoading(true);
    try {
      const catalog = await invoke<CaptureCatalog>("list_captures", {
        destination,
        workspace,
      });
      if (!isCurrent()) return;
      const result = catalog.captures;
      setCaptures(result);
      setProcessingCaptureId((current) =>
        result.some((capture) => capture.capture_id === current)
          ? current
          : result[0]?.capture_id || "",
      );
      try {
        const index = await invoke<ReviewSearchEntry[]>("list_review_index", {
          destination,
          workspace,
        });
        if (!isCurrent()) return;
        setReviewIndex(index);
        const warnings = [
          ...catalog.warnings,
          ...result.flatMap((capture) => capture.load_warnings || []),
        ];
        setMessage(warnings.length ? `Atenção: ${warnings.join(" ")}` : "");
      } catch (error) {
        if (!isCurrent()) return;
        setReviewIndex([]);
        setMessage(
          `${result.length} captação(ões) encontrada(s), mas a busca por revisões não carregou: ${String(error)}`,
        );
      }
    } catch (error) {
      if (!isCurrent()) return;
      setMessage(`Não foi possível abrir o acervo: ${String(error)}`);
    } finally {
      if (isCurrent()) setCapturesLoading(false);
    }
  }

  async function retryProcessing(capture: Manifest) {
    if (!window.__TAURI_INTERNALS__) return;
    setBusy(true);
    setMessage(
      `Verificando novamente as prévias de “${capture.capture_name}”…`,
    );
    try {
      const updated = await invoke<Manifest>("reprocess_capture", {
        destination,
        workspace,
        captureId: capture.capture_id,
      });
      setCaptures((current) =>
        current.map((item) =>
          item.capture_id === updated.capture_id ? updated : item,
        ),
      );
      setLatest((current) =>
        current?.capture_id === updated.capture_id ? updated : current,
      );
      const pending = updated.assets.filter(
        (asset) =>
          asset.status === "verified" &&
          mediaExtension.test(asset.original_name) &&
          (!asset.metadata ||
            !asset.thumbnail_relative_path ||
            asset.processing_error),
      ).length;
      setMessage(
        pending
          ? `Nova tentativa concluída. ${pending} arquivo(s) ainda precisam de metadados ou miniatura.`
          : "Processamento local concluído. As cópias e os originais não foram alterados.",
      );
    } catch (error) {
      setMessage(`Não foi possível reprocessar: ${String(error)}`);
    } finally {
      setBusy(false);
    }
  }

  async function loadReviewItems(captureId: string, preferredAssetId?: string) {
    const request = ++reviewRequest.current;
    const context = `${destination}\u0000${workspace}`;
    reviewCaptureRef.current = captureId;
    setReviewCaptureId(captureId);
    setReviewFilter("all");
    setReviewItems([]);
    setSelectedAssetId("");
    if (!captureId || !window.__TAURI_INTERNALS__) return;
    try {
      const result = await invoke<ReviewItem[]>("list_review_items", {
        destination,
        workspace,
        captureId,
      });
      if (
        request !== reviewRequest.current ||
        aiContext.current !== context ||
        reviewCaptureRef.current !== captureId
      )
        return;
      setReviewItems(result);
      setSelectedAssetId(
        result.find((item) => item.asset_id === preferredAssetId)?.asset_id ||
          result[0]?.asset_id ||
          "",
      );
      setMessage(
        `${result.length} mídia(s) disponíveis para revisão nesta captação.`,
      );
    } catch (error) {
      if (request !== reviewRequest.current || aiContext.current !== context)
        return;
      setMessage(`Não foi possível carregar a revisão: ${String(error)}`);
    }
  }

  async function saveReview(validateException = false) {
    if (!reviewCaptureId || !selectedAssetId || !window.__TAURI_INTERNALS__)
      return;
    const statusToSave =
      validateException && reviewStatus === "pending"
        ? reviewLocation.trim()
          ? "confirmed"
          : "unidentified"
        : reviewStatus;
    setBusy(true);
    const context = `${destination}\u0000${workspace}`;
    const savingCapture = reviewCaptureId;
    const savingDraftKey = draftKey();
    try {
      const updated = await invoke<ReviewItem>("save_review", {
        destination,
        workspace,
        captureId: reviewCaptureId,
        assetId: selectedAssetId,
        status: statusToSave,
        location: statusToSave === "confirmed" ? reviewLocation.trim() : null,
        matter: reviewMatter,
        category: reviewCategory,
        tags: reviewTags
          .split(/[,\n]/)
          .map((tag) => tag.trim())
          .filter(Boolean),
        note: reviewNote,
      });
      delete draftCache.current[savingDraftKey];
      writeStored("lumen.review-drafts.v1", draftCache.current);
      if (
        aiContext.current !== context ||
        reviewCaptureRef.current !== savingCapture
      )
        return;
      let refreshed: ReviewItem[] | null = null;
      try {
        refreshed = await invoke<ReviewItem[]>("list_review_items", {
          destination,
          workspace,
          captureId: reviewCaptureId,
        });
      } catch {
        // A revisão já foi salva; preserve o resultado mesmo se a atualização das sugestões falhar.
      }
      if (
        aiContext.current !== context ||
        reviewCaptureRef.current !== savingCapture
      )
        return;
      setReviewItems(
        (current) =>
          refreshed ||
          current.map((item) =>
            item.asset_id === updated.asset_id ? updated : item,
          ),
      );
      if (updated.decision) {
        const decision = updated.decision;
        setReviewIndex((current) => [
          ...current.filter(
            (item) =>
              item.capture_id !== reviewCaptureId ||
              item.asset_id !== updated.asset_id,
          ),
          {
            capture_id: reviewCaptureId,
            asset_id: updated.asset_id,
            status: decision.status,
            location: decision.location,
            matter: decision.matter,
            tags: decision.tags,
            visual_description: updated.visual_analysis?.description,
            visual_tags: updated.visual_analysis?.tags,
            visible_text: updated.visual_analysis?.visible_text,
          },
        ]);
      }
      const suggested = refreshed?.filter(
        (item) =>
          item.suggestion &&
          (!item.decision || item.decision.status === "pending"),
      ).length;
      setMessage(
        `Revisão de “${updated.original_name}” salva. Os originais não foram alterados.${suggested ? ` ${suggested} take(s) têm pistas para conferir.` : ""}`,
      );
    } catch (error) {
      setMessage(`Não foi possível salvar a revisão: ${String(error)}`);
    } finally {
      setBusy(false);
    }
  }

  async function resumeIngest(capture: Manifest) {
    if (busy) return;
    if (
      !window.confirm(
        `Retomar “${capture.capture_name}”? Reconecte o mesmo cartão ou pasta original: ${capture.source_path || "origem registrada no manifesto"}. Apenas arquivos pendentes ou com falha serão tentados.`,
      )
    )
      return;
    setBusy(true);
    setIngesting(true);
    setIngestProgress(null);
    let unlisten: (() => void) | undefined;
    try {
      unlisten = await listen<IngestProgress>("ingest-progress", (event) => {
        if (event.payload.capture_id === capture.capture_id)
          setIngestProgress(event.payload);
      });
      const updated = await invoke<Manifest>("resume_ingest", {
        destination,
        workspace,
        captureId: capture.capture_id,
      });
      setCaptures((current) =>
        current.map((item) =>
          item.capture_id === updated.capture_id ? updated : item,
        ),
      );
      setLatest((current) =>
        current?.capture_id === updated.capture_id ? updated : current,
      );
      setMessage(
        `Retomada concluída: ${updated.verified_count} cópias verificadas; ${updated.failed_count} falhas e ${updated.pending_count || 0} pendentes.`,
      );
    } catch (error) {
      setMessage(`Não foi possível retomar: ${String(error)}`);
    } finally {
      unlisten?.();
      setIngesting(false);
      setBusy(false);
    }
  }

  function discardDraft() {
    delete draftCache.current[draftKey()];
    writeStored("lumen.review-drafts.v1", draftCache.current);
    setReviewItems((current) => [...current]);
  }

  async function revokeApproval() {
    if (!organizationApproval || busy) return;
    setBusy(true);
    try {
      await invoke("revoke_organization", {
        destination,
        workspace,
        captureId: reviewCaptureId,
        expectedApprovalId: organizationApproval.approval_id,
      });
      setOrganizationApproval(null);
      setMessage(
        "Aprovação desfeita e registrada no histórico. As revisões e as cópias existentes foram preservadas.",
      );
    } catch (error) {
      setMessage(`Não foi possível desfazer: ${String(error)}`);
    } finally {
      setBusy(false);
    }
  }

  async function restorePreviousReview() {
    if (busy || reviewHasChanges) return;
    setBusy(true);
    try {
      await invoke("restore_previous_review", {
        destination,
        workspace,
        captureId: reviewCaptureId,
        assetId: selectedAssetId,
      });
      await loadReviewItems(reviewCaptureId, selectedAssetId);
      await loadCaptures();
      setMessage(
        "Revisão anterior restaurada como um novo evento. O histórico foi preservado.",
      );
    } catch (error) {
      setMessage(`Não foi possível restaurar: ${String(error)}`);
    } finally {
      setBusy(false);
    }
  }

  async function saveBatch() {
    if (
      busy ||
      !batchIds.length ||
      captureHasDrafts ||
      (!batchStatus && !batchMatterEnabled && !batchTagsEnabled)
    )
      return;
    if (
      !window.confirm(
        `Aplicar as alterações indicadas a ${batchIds.length} take(s)? Cada alteração ficará no histórico.`,
      )
    )
      return;
    setBusy(true);
    try {
      const items = await invoke<ReviewItem[]>("save_review_batch", {
        destination,
        workspace,
        captureId: reviewCaptureId,
        change: {
          asset_ids: batchIds,
          expected_event_ids: reviewItems
            .filter((item) => batchIds.includes(item.asset_id))
            .map(
              (item) =>
                item.organization?.event_id ||
                item.decision?.event_id ||
                item.asset_id,
            ),
          status: batchStatus || null,
          location: batchStatus === "confirmed" ? batchLocation : null,
          matter: batchMatterEnabled ? batchMatter : null,
          tags: batchTagsEnabled
            ? batchTags
                .split(/[,\n]/)
                .map((tag) => tag.trim())
                .filter(Boolean)
            : null,
        },
      });
      setReviewItems(items);
      setBatchIds([]);
      await loadCaptures();
      setMessage(
        "Revisões salvas em lote. Campos não selecionados foram preservados.",
      );
    } catch (error) {
      setMessage(`O lote não foi aplicado: ${String(error)}`);
    } finally {
      setBusy(false);
    }
  }

  const query = submittedSearch.trim().toLocaleLowerCase("pt-BR");
  const visibleCaptures = searchCaptures(captures, reviewIndex, submittedSearch);
  const hasSearchFilters =
    !!searchFilters.location ||
    !!searchFilters.matter ||
    !!searchFilters.date ||
    !!searchFilters.tag ||
    searchFilters.status !== "all";
  const catalogSearchActive =
    !!searchQuery.trim() ||
    !!submittedSearch ||
    hasSearchFilters ||
    showFullCatalog;
  const catalogSearchPending = searchQuery.trim() !== submittedSearch;
  const catalogResults = searchCatalog(captures, reviewIndex, {
    text: submittedSearch,
    filters: searchFilters,
    mediaOnly: true,
  });
  const catalogResultCount = catalogResults.reduce(
    (count, group) => count + group.results.length,
    0,
  );
  const catalogLocationOptions = [
    ...new Set([
      ...reviewIndex.map((item) =>
        item.status === "unidentified" && !item.location
          ? "Local não identificado"
          : item.location || "",
      ),
    ].filter(Boolean)),
  ].sort((a, b) => a.localeCompare(b, "pt-BR"));
  const catalogMatterOptions = [
    ...new Set(reviewIndex.map((item) => item.matter).filter(Boolean)),
  ].sort((a, b) => a.localeCompare(b, "pt-BR"));
  const catalogTagOptions = [
    ...new Set(
      reviewIndex.flatMap((item) => [...item.tags, ...(item.visual_tags || [])]),
    ),
  ].sort((a, b) => a.localeCompare(b, "pt-BR"));
  const pendingCaptureCount = captures.filter((capture) =>
    reviewIndex.some(
      (item) => item.capture_id === capture.capture_id && item.status === "pending",
    ),
  ).length;
  const selectedCatalogResult = catalogSelection
    ? catalogResults
        .find((group) => group.capture.capture_id === catalogSelection.captureId)
        ?.results.find((result) => result.asset.asset_id === catalogSelection.assetId)
    : undefined;
  const selectedCatalogCapture = catalogSelection
    ? captures.find((capture) => capture.capture_id === catalogSelection.captureId)
    : undefined;
  useEffect(() => {
    catalogPreviewRequest.current += 1;
    setCatalogSelection(null);
    setCatalogSelectedReview(null);
    setCatalogPreview(null);
    setCatalogPreviewError("");
    setCatalogPreviewLoading(false);
  }, [submittedSearch, searchFilters, showFullCatalog, destination, workspace, page]);
  const selectedReview = reviewItems.find(
    (item) => item.asset_id === selectedAssetId,
  );
  const selectedReviewIndex = reviewItems.findIndex(
    (item) => item.asset_id === selectedAssetId,
  );
  const reviewTagsList = reviewTags
    .split(/[,\n]/)
    .map((tag) => tag.trim())
    .filter(Boolean);
  const reviewHasChanges = reviewDraftChanged(selectedReview, {
    status: reviewStatus,
    location: reviewLocation,
    matter: reviewMatter,
    category: reviewCategory,
    tags: reviewTags,
    note: reviewNote,
  });
  const reviewCapture = captures.find(
    (item) => item.capture_id === reviewCaptureId,
  );
  const captureHasDrafts = reviewItems.some(
    (item) => !!draftCache.current[draftKey(reviewCaptureId, item.asset_id)],
  );

  const titles: Record<Page, [string, string]> = {
    Acervo: [
      "Seu acervo em um só lugar",
      "Encontre arquivos, acompanhe captações e retome revisões pendentes.",
    ],
    "Nova ingestão": [
      "Nova ingestão",
      "Escolha o cartão. O Lumen copia e, com a IA local pronta, separa os takes automaticamente — sem você classificar arquivo por arquivo.",
    ],
    Processamento: [
      "Processando captação",
      "O Lumen lê os arquivos e a IA local separa os takes por assunto, usando evidências para sugerir locais.",
    ],
    Revisão: [
      "Revisar organização",
      "Confira exceções e takes sem local. Você pode corrigir vários de uma vez; depois aprove para criar cópias por local → matéria.",
    ],
  };
  const pendingReviews = reviewItems.filter((item) => {
    if (item.decision?.status === "unidentified") return false;
    const location =
      item.decision?.location ??
      item.organization?.location ??
      item.suggestion?.location;
    return !item.organization || item.organization.requires_review || !location;
  }).length;
  const analyzedReviewCount = reviewItems.filter(
    (item) => !!item.visual_analysis,
  ).length;
  const reviewAiPendingCount = Math.max(
    0,
    reviewItems.length - analyzedReviewCount,
  );
  const unlocatedReviewCount = filterReviewItems(reviewItems, "unlocated").length;
  const filteredReviewItems = filterReviewItems(reviewItems, reviewFilter);
  const reviewGroups = groupReviewItems(
    filteredReviewItems,
    reviewCapture?.capture_name || "",
  );
  const selectedFilteredIndex = filteredReviewItems.findIndex(
    (item) => item.asset_id === selectedAssetId,
  );
  useEffect(() => {
    if (
      reviewFilter !== "all" &&
      !filteredReviewItems.some((item) => item.asset_id === selectedAssetId)
    ) {
      setSelectedAssetId(filteredReviewItems[0]?.asset_id || "");
    } else if (!selectedAssetId && filteredReviewItems.length) {
      setSelectedAssetId(filteredReviewItems[0].asset_id);
    }
  }, [reviewFilter, reviewRevision, selectedAssetId]);
  const canApproveOrganization =
    reviewItems.length > 0 &&
    pendingReviews === 0 &&
    !captureHasDrafts &&
    !busy &&
    !approvalLoading &&
    !organizationApproval;
  const openAiSettings = () => {
    if (!aiSettingsRef.current) return;
    aiSettingsRef.current.open = true;
    aiSettingsRef.current.scrollIntoView({ block: "center", behavior: "smooth" });
  };
  const rememberCatalogSearch = (value: string) => {
    const search = value.trim();
    if (!search) return;
    const next = [
      search,
      ...recentSearches.filter(
        (item) => item.toLocaleLowerCase("pt-BR") !== search.toLocaleLowerCase("pt-BR"),
      ),
    ].slice(0, 5);
    setRecentSearches(next);
    writeStored("lumen.catalog-searches.v1", next);
  };
  const submitCatalogSearch = (value = searchQuery) => {
    const search = value.trim();
    setSearchQuery(search);
    setSubmittedSearch(search);
    setShowFullCatalog(false);
    setSearchFocused(false);
    rememberCatalogSearch(search);
  };
  const clearCatalogSearch = () => {
    closeCatalogFilterPanels();
    setSearchQuery("");
    setSubmittedSearch("");
    setSearchFilters({ ...noCatalogFilters });
    setShowFullCatalog(false);
    setSearchFocused(false);
  };
  const clearCatalogFilters = () => {
    closeCatalogFilterPanels();
    setSearchFilters({ ...noCatalogFilters });
  };
  function updateCatalogFilter<K extends keyof CatalogSearchFilters>(
    key: K,
    value: CatalogSearchFilters[K],
  ) {
    closeCatalogFilterPanels();
    setSearchFocused(false);
    setSearchFilters((current) => ({ ...current, [key]: value }));
    setShowFullCatalog(false);
  }
  const openFullCatalog = () => {
    setSearchQuery("");
    setSubmittedSearch("");
    setSearchFilters({ ...noCatalogFilters });
    setShowFullCatalog(true);
  };
  const openPendingCaptures = () => {
    setSearchQuery("");
    setSubmittedSearch("");
    setSearchFilters({ ...noCatalogFilters, status: "pending" });
    setShowFullCatalog(false);
  };
  async function openCatalogResult(captureId: string, assetId: string) {
    const request = ++catalogPreviewRequest.current;
    const context = `${destination}\u0000${workspace}`;
    setSearchFocused(false);
    setCatalogSelection({ captureId, assetId });
    setCatalogSelectedReview(null);
    setCatalogPreview(null);
    setCatalogPreviewError("");
    setCatalogPreviewLoading(true);
    requestAnimationFrame(() => {
      catalogPreviewPanelRef.current?.focus({ preventScroll: true });
      if (window.innerWidth <= 800)
        catalogPreviewPanelRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    });
    if (!window.__TAURI_INTERNALS__) {
      setCatalogPreviewError("A prévia está disponível no aplicativo Lumen Desktop.");
      setCatalogPreviewLoading(false);
      return;
    }
    const [itemsResult, previewResult] = await Promise.allSettled([
      invoke<ReviewItem[]>("list_review_items", {
        destination,
        workspace,
        captureId,
      }),
      invoke<PreviewDescriptor>("create_preview", {
        destination,
        workspace,
        captureId,
        assetId,
      }),
    ]);
    if (request !== catalogPreviewRequest.current || context !== aiContext.current) return;
    if (itemsResult.status === "fulfilled") {
      setCatalogSelectedReview(
        itemsResult.value.find((item) => item.asset_id === assetId) || null,
      );
    }
    if (previewResult.status === "fulfilled") {
      setCatalogPreview(previewResult.value);
    } else {
      setCatalogPreviewError(String(previewResult.reason));
    }
    setCatalogPreviewLoading(false);
  }
  async function openCatalogResultInReview(selection = catalogSelection) {
    if (!selection) return;
    setPage("Revisão");
    setSettingsOpen(false);
    await loadReviewItems(selection.captureId, selection.assetId);
  }

  return (
    <div className="app-shell">
      {setupOpen && <SetupDialog
        onClose={() => setSetupOpen(false)}
        onContinue={() => {
          writeStored("lumen.setup.v1", true);
          setSetupOpen(false);
          void refreshOllama();
        }}
      />}
      <aside className="sidebar">
        <div className="brand">
          <img className="brand-mark" src={rjnMark} alt="RJN Systems" />
          <div>
            <strong>LUMEN</strong>
            <small>por RJN Systems</small>
          </div>
        </div>
        <nav aria-label="Navegação principal">
          {pages.map((item) => (
            <button
              key={item}
              disabled={busy}
              className={page === item ? "active" : ""}
              aria-current={page === item ? "page" : undefined}
              onClick={() => {
                setPage(item);
                if (item === "Revisão" && destination && workspace) {
                  setSettingsOpen(false);
                }
                if (
                  (item === "Acervo" ||
                    item === "Processamento" ||
                    item === "Revisão") &&
                  destination &&
                  workspace
                )
                  void loadCaptures();
              }}
            >
              <img
                src={page === item ? navActive : navIdle}
                alt=""
                width={10}
                height={10}
              />
              {item}
            </button>
          ))}
          <button
            disabled={busy}
            onClick={() => {
              setSettingsOpen(true);
              requestAnimationFrame(() =>
                settingsRef.current?.scrollIntoView({ block: "start" }),
              );
            }}
          >
            <img src={navIdle} alt="" width={10} height={10} />
            Configurações
          </button>
        </nav>
        <div className="sidebar-note">
          <span className="device-label">ESTE COMPUTADOR</span>
          <strong>Acervo local</strong>
          <span className="badge">
            {window.__TAURI_INTERNALS__
              ? "● Desktop ativo"
              : "● Prévia no navegador"}
          </span>
          <small>Originais sob seu controle</small>
        </div>
      </aside>
      <main className="main">
        <div className="topbar">
          <span className="eyebrow">
            LUMEN / {page.toLocaleUpperCase("pt-BR")}
          </span>
          <div className="top-statuses">
            <span className="badge">
              {window.__TAURI_INTERNALS__
                ? "● Aplicativo local ativo"
                : "● Prévia no navegador"}
            </span>
            <span className="badge neutral">
              {ollamaStatus?.model_ready
                ? "Qwen3-VL 4B · local"
                : "IA local não pronta"}
            </span>
          </div>
        </div>
        <header className="page-header">
          <div>
            <h1>{titles[page][0]}</h1>
            <p className="intro">{titles[page][1]}</p>
          </div>
          {page === "Revisão" && (
            <button
              className="primary"
              disabled={!canApproveOrganization}
              onClick={() => void approveOrganization()}
            >
              {organizationApproval
                ? "Organização aprovada"
                : "Aprovar organização"}
            </button>
          )}
          {(page === "Acervo" || page === "Nova ingestão") && (
            <button
              className={page === "Acervo" ? "primary" : "secondary"}
              onClick={() => {
                const target = page === "Acervo" ? "Nova ingestão" : "Acervo";
                setPage(target);
                if (target === "Acervo" && destination && workspace)
                  void loadCaptures();
              }}
            >
              {page === "Acervo" ? "Nova ingestão" : "Voltar ao acervo"}
            </button>
          )}
        </header>
        {message && (
          <div className="notice" role="status">
            {message}
          </div>
        )}
        {ingesting && (
          <section
            className="card progress-summary"
            role="status"
            aria-live="polite"
          >
            <div>
              <strong>
                {ingestProgress?.stage === "processing"
                  ? "Cópia registrada; gerando metadados e miniatura"
                  : "Copiando e verificando os arquivos"}
              </strong>
              <span>
                {ingestProgress
                  ? `${ingestProgress.done}/${ingestProgress.total} arquivos · ${ingestProgress.verified} verificados · ${ingestProgress.failed} falhas`
                  : "Preparando o inventário persistente…"}
              </span>
            </div>
            {ingestProgress ? (
              <progress
                max={ingestProgress.total || 1}
                value={ingestProgress.done}
                aria-label="Arquivos da ingestão concluídos"
              />
            ) : (
              <progress aria-label="Inventariando origem" />
            )}
            <p className="hint">
              {ingestProgress?.current ||
                "Não remova a origem durante a cópia."}
            </p>
          </section>
        )}
        {(page === "Nova ingestão" ||
          page === "Processamento" ||
          page === "Revisão") && (
          <details
            className="card ai-panel"
            aria-label="IA visual local"
            ref={aiSettingsRef}
          >
            <summary>
              IA local ·{" "}
              {ollamaStatus?.model_ready
                ? "pronta para organizar"
                : "precisa de configuração"}
              {aiRunning ? " · Análise em andamento" : ""}
            </summary>
            <div className="ai-panel-heading">
              <div>
                <h2>IA visual local · Qwen3-VL 4B Instruct</h2>
                <p role="status">
                  {ollamaChecking
                    ? "Consultando o Ollama…"
                    : ollamaStatus?.message ||
                      "Abra o aplicativo Desktop para conectar ao Ollama."}
                </p>
              </div>
              <span
                className={`badge ${ollamaStatus?.model_ready ? "" : "neutral"}`}
              >
                {ollamaStatus?.model_ready
                  ? "● Modelo pronto"
                  : ollamaStatus?.running
                    ? "Modelo não instalado"
                    : "Ollama desconectado"}
              </span>
              <button
                className="secondary"
                disabled={busy || ollamaChecking}
                onClick={() => void refreshOllama()}
              >
                Atualizar conexão
              </button>
            </div>
            {!ollamaStatus?.model_ready && (
              <p className="hint">
                No Ollama deste computador, instale o modelo:{" "}
                <code>ollama pull qwen3-vl:4b-instruct</code>. Depois, atualize
                a conexão.
              </p>
            )}
            <p className="hint">
              Imagens e quadros amostrados são analisados no próprio computador.
              A IA organiza grupos, assuntos e tags. Você revisa exceções; não
              há transcrição de áudio.
            </p>
            <label className="ai-toggle">
              <input
                type="checkbox"
                checked={aiDetailed}
                disabled={busy}
                onChange={(event) => setAiDetailed(event.target.checked)}
              />
              Análise detalhada de vídeos (3 quadros; mais demorada)
            </label>
            <p className="hint">
              {aiDetailed
                ? "Vídeos: três amostras para cobrir mais cenas."
                : "Modo rápido: imagens reduzidas e um quadro central por vídeo; cenas fora da amostra e textos pequenos podem passar despercebidos."}{" "}
              Resultados já concluídos são reaproveitados. Para aplicar outro
              modo a um take já analisado, use Reanalisar.
            </p>
            {aiProgress && (
              <div
                className={`ai-progress ${aiProgress.errors.length ? "has-errors" : ""}`}
                role="status"
              >
                <div>
                  <strong>
                    {aiRunning
                      ? `Analisando: ${aiProgress.current}`
                      : aiProgress.cancelled
                        ? "Fila interrompida"
                        : aiProgress.succeeded === 0 &&
                            aiProgress.errors.length > 0
                          ? "Organização não concluída"
                          : aiProgress.errors.length > 0
                            ? "Organização parcial — confira as falhas"
                            : "Organização automática concluída"}
                  </strong>
                  <span>
                    {aiProgress.done}/{aiProgress.total} processados ·{" "}
                    {aiProgress.succeeded} organizados
                  </span>
                </div>
                <progress
                  max={aiProgress.total || 1}
                  value={aiProgress.done}
                  aria-label="Progresso da análise visual"
                />
                {aiRunning && (
                  <button
                    className="secondary"
                    onClick={() => {
                      aiCancel.current = true;
                    }}
                  >
                    Parar após o take atual
                  </button>
                )}
                {aiProgress.errors.length > 0 && (
                  <details>
                    <summary>
                      {aiProgress.errors.length} falha(s) na análise
                    </summary>
                    <ul>
                      {aiProgress.errors.map((error, index) => (
                        <li key={index}>{error}</li>
                      ))}
                    </ul>
                  </details>
                )}
              </div>
            )}
          </details>
        )}
        {page === "Nova ingestão" && (
          <section
            className="card source-detection"
            aria-label="Origem para ingestão"
            aria-busy={sourceScanning}
          >
            <div className="source-detection-row">
              <span className="source-device-icon" aria-hidden="true">
                USB
              </span>
              <div
                className="source-detection-copy"
                role="status"
                aria-live="polite"
              >
                <h2>
                  {source
                    ? sourceDevice
                      ? `${sourceDevice.label} detectado em ${sourceDevice.path}`
                      : "Pasta de origem selecionada"
                    : deviceChecking
                      ? "Procurando pendrives e cartões…"
                      : devices.length
                        ? "Escolha um dispositivo para analisar"
                        : "Nenhum pendrive ou cartão detectado"}
                </h2>
                {source && <p className="source-path">{source}</p>}
                {sourceScanning ? (
                  <p>
                    Contando vídeos, fotos e arquivos auxiliares nas subpastas…
                  </p>
                ) : sourceInventory ? (
                  <p>
                    {sourceInventory.videos} vídeo(s) · {sourceInventory.images}{" "}
                    foto(s) · {sourceInventory.sidecars} auxiliar(es) ·{" "}
                    {formatBytes(sourceInventory.total_bytes)} · somente leitura
                  </p>
                ) : (
                  !sourceError && (
                    <p>
                      Conecte o dispositivo ou escolha a pasta de origem abaixo.
                    </p>
                  )
                )}
                {sourceError && (
                  <p className="source-feedback" role="alert">
                    {sourceError}
                  </p>
                )}
                {sourceInventory && sourceFileCount === 0 && (
                  <p className="source-feedback">
                    Nenhum arquivo suportado encontrado. Escolha a pasta com
                    vídeos ou fotos, incluindo suas subpastas.
                  </p>
                )}
                {sourceInventory?.partial && (
                  <p className="source-feedback">
                    Contagem parcial: a origem é muito grande ou lenta. A
                    ingestão fará o inventário completo antes de copiar.
                  </p>
                )}
                {!!sourceInventory?.unreadable_entries && (
                  <p className="source-feedback">
                    {sourceInventory.unreadable_entries} entrada(s) não puderam
                    ser lidas. Confira o acesso à unidade.
                  </p>
                )}
                {!!sourceInventory?.ignored_files && (
                  <p>
                    {sourceInventory.ignored_files} arquivo(s) de outros
                    formatos fora da ingestão.
                  </p>
                )}
              </div>
              <span className={`source-state ${sourceReady ? "ready" : ""}`}>
                {busy
                  ? "Operação em andamento"
                  : sourceScanning
                    ? "◌ Analisando"
                    : sourceReady
                      ? "● Pronto para ingerir"
                      : sourceError
                        ? "Atenção à origem"
                        : "Aguardando mídia"}
              </span>
            </div>
            <div className="source-device-actions">
              <button
                className="secondary"
                type="button"
                disabled={busy || deviceChecking}
                onClick={() => setDeviceRefresh((value) => value + 1)}
              >
                {deviceChecking
                  ? "Buscando dispositivos…"
                  : "Atualizar dispositivos"}
              </button>
              <button
                className="secondary"
                type="button"
                disabled={busy}
                onClick={() => void selectFolder("source")}
              >
                Escolher pasta
              </button>
              {source && (
                <button
                  className="secondary"
                  type="button"
                  disabled={busy || sourceScanning}
                  onClick={() => setSourceRefresh((value) => value + 1)}
                >
                  Analisar origem novamente
                </button>
              )}
            </div>
            {devices.length > 0 && (
              <div
                className="source-device-list"
                aria-label="Dispositivos conectados"
              >
                {devices.map((device) => (
                  <button
                    className="source-device-choice"
                    type="button"
                    key={device.path}
                    disabled={busy}
                    aria-pressed={source === device.path}
                    onClick={() => {
                      setAutoSourceRoot(device.path);
                      setSource(device.path);
                      setSourceRefresh((value) => value + 1);
                    }}
                  >
                    <strong>
                      {device.label} · {device.path}
                    </strong>
                    <span>
                      {formatBytes(device.free_bytes)} livres de{" "}
                      {formatBytes(device.capacity_bytes)}
                    </span>
                  </button>
                ))}
              </div>
            )}
            {deviceError && (
              <p className="source-feedback" role="status">
                {deviceError}
              </p>
            )}
            <p className="hint">
              A detecção apenas lê a lista de arquivos. A cópia só começa quando
              você confirma a ingestão.
            </p>
          </section>
        )}
        {(page === "Nova ingestão" ||
          page === "Acervo" ||
          page === "Processamento" ||
          page === "Revisão") && (
          <details
            hidden={!settingsOpen}
            className="card settings"
            ref={settingsRef}
            open={settingsOpen}
            onToggle={(event) => setSettingsOpen(event.currentTarget.open)}
          >
            <summary>
              Pastas e espaço de trabalho{" "}
              <span>{workspace || "não definido"}</span>
            </summary>
            <button className="secondary" type="button" onClick={() => setSetupOpen(true)}>
              Verificar instalação e IA
            </button>
            <h2>
              {page === "Nova ingestão"
                ? "De onde vêm e onde ficam os arquivos"
                : "Acervo local"}
            </h2>
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
                      onChange={(e) => {
                        setAutoSourceRoot("");
                        setSource(e.target.value);
                      }}
                      placeholder={"Ex.: G:\\DCIM"}
                    />
                    <button
                      className="secondary"
                      type="button"
                      disabled={busy}
                      onClick={() => selectFolder("source")}
                    >
                      Escolher
                    </button>
                  </span>
                </label>
                <span className="transfer-arrow" aria-hidden="true">
                  →
                </span>
                <label>
                  2. Destino — pasta permanente das cópias
                  <span className="input-action">
                    <input
                      value={destination}
                      disabled={busy}
                      onChange={(e) => setDestination(e.target.value)}
                      placeholder={"Ex.: D:\\Lumen\\Acervo"}
                    />
                    <button
                      className="secondary"
                      type="button"
                      disabled={busy}
                      onClick={() => selectFolder("destination")}
                    >
                      Escolher
                    </button>
                  </span>
                </label>
              </div>
            )}
            {page !== "Nova ingestão" && (
              <div className="field-grid workspace-grid">
                <label>
                  Pasta permanente das cópias{" "}
                  <span className="input-action">
                    <input
                      value={destination}
                      disabled={busy}
                      onChange={(e) => setDestination(e.target.value)}
                      placeholder={"Ex.: D:\\Lumen\\Acervo"}
                    />
                    <button
                      className="secondary"
                      type="button"
                      disabled={busy}
                      onClick={() => selectFolder("destination")}
                    >
                      Escolher
                    </button>
                  </span>
                </label>
              </div>
            )}
            {page === "Nova ingestão" && (
              <p className="hint">
                Escolha uma pasta de destino fora do cartão ou pendrive. Os
                originais permanecem na origem.
              </p>
            )}
            <p className="hint">
              Nesta fase, o espaço é local. Contas e permissões compartilhadas
              virão com a API autenticada.
            </p>
            <p className="hint">
              <a href={interLicenseUrl} download="Inter-LICENSE.txt">
                Licença da fonte Inter
              </a>
            </p>
          </details>
        )}
        {page === "Nova ingestão" && (
          <>
            <div className="ingestion-grid">
              <section className="card context-card">
                <div className="context-heading">
                  <div>
                    <h2>O que você sabe sobre a captação?</h2>
                    <p className="hint">
                      Esse contexto orienta a análise. Você não precisa localizar
                      cada take agora.
                    </p>
                  </div>
                  <span className="badge neutral">Opcional</span>
                </div>
                <p>
                  Informe o que lembra da pauta e da gravação. A IA usa esses
                  dados como contexto e analisa as mídias para separar os takes
                  por <b>local → matéria</b> — sem classificar arquivo por
                  arquivo.
                </p>
                <div className="context-fields">
                  <label>
                    Retranca ou matéria (opcional)
                    <input
                      disabled={busy}
                      value={captureName}
                      onChange={(e) => setCaptureName(e.target.value)}
                      placeholder="Ex.: Dia das Crianças · Comércio"
                    />
                    <small className="field-hint">
                      Se deixar vazio, o Lumen usa a data e a hora.
                    </small>
                  </label>
                  <label>
                    Pauta ou briefing (opcional)
                    <textarea
                      disabled={busy}
                      value={brief}
                      onChange={(e) => setBrief(e.target.value)}
                      maxLength={10000}
                      rows={3}
                      placeholder="Ex.: movimento das famílias e das lojas no Shopping Vitória."
                    />
                  </label>
                  <label>
                    Locais visitados (opcional, um por linha)
                    <textarea
                      disabled={busy}
                      value={locationsText}
                      onChange={(e) => setLocationsText(e.target.value)}
                      rows={2}
                      placeholder={"Shopping Vitória\nPraia do Morro"}
                    />
                  </label>
                  <label>
                    Equipe (opcional)
                    <input
                      disabled={busy}
                      value={team}
                      onChange={(event) => setTeam(event.target.value)}
                      maxLength={240}
                      placeholder="Ex.: Câmera 1 · Ronicley | Câmera 2 · equipe"
                    />
                  </label>
                </div>
                <p className="hint">
                  Os locais são pistas, não confirmação automática. Se a IA não
                  encontrar evidência, o take aparece no grupo “Sem local” para
                  você revisar.
                </p>
              </section>
              <aside className="card discovery-card">
                <h2>O Lumen vai identificar</h2>
                <div className="signal">
                  <strong>Metadados</strong>
                  <p>Data, duração, câmera e formato, quando disponíveis.</p>
                </div>
                <div className="signal">
                  <strong>Análise visual local</strong>
                  <p>
                    Cenas, objetos e textos visíveis em fotos e quadros de
                    vídeo. Este MVP não transcreve áudio.
                  </p>
                </div>
                <div className="signal">
                  <strong>Pistas de localização</strong>
                  <p>
                    GPS e telemetria SRT, quando disponíveis, combinados com
                    pistas visuais. Você confirma o local.
                  </p>
                </div>
                <div className="signal">
                  <strong>Agrupamento automático</strong>
                  <p>
                    A IA separa takes por local → matéria e deixa exceções
                    evidentes para revisão.
                  </p>
                </div>
              </aside>
            </div>
            <section className="action-banner">
              <div>
                <h2>Seus originais ficam preservados</h2>
                <p>
                  {ollamaStatus?.model_ready
                    ? "O Lumen copia e verifica o cartão. Em seguida, inicia a análise visual no computador e sugere grupos automaticamente."
                    : "O Lumen copia e verifica o cartão. Quando a IA local estiver configurada, ela analisa e separa os takes automaticamente."}
                </p>
                {!ollamaStatus?.model_ready && (
                  <button
                    type="button"
                    className="link-button"
                    onClick={openAiSettings}
                  >
                    Configurar IA local
                  </button>
                )}
                <p className="hint original-protection-hint">
                  Seus originais ficam preservados. O Lumen cria cópias
                  verificadas.
                </p>
              </div>
              <button
                className="primary"
                disabled={
                  busy ||
                  !sourceReady ||
                  !destination ||
                  !workspace
                }
                onClick={ingest}
              >
                {busy
                  ? "Processando…"
                  : sourceReady
                    ? `${ollamaStatus?.model_ready ? "Copiar e analisar" : "Copiar"} ${sourceFileCount} arquivo(s)`
                    : sourceScanning
                      ? "Analisando origem…"
                      : "Iniciar ingestão"}
              </button>
            </section>
          </>
        )}
        {page === "Nova ingestão" && latest && (
          <section className="card">
            <h2>Resultado da captação</h2>
            <p>
              {latest.capture_name} · {latest.verified_count} verificados ·{" "}
              {latest.failed_count} falhas
            </p>
            {latest.visited_locations.length > 0 && (
              <p className="hint">
                Locais informados: {latest.visited_locations.join(" · ")}
              </p>
            )}
            {latest.team && (
              <p className="hint">Equipe: {latest.team}</p>
            )}
            <div className="asset-list">
              {latest.assets.map((asset) => (
                <div key={asset.asset_id} className="asset media-asset">
                  <Thumbnail
                    destination={destination}
                    workspace={workspace}
                    captureId={latest.capture_id}
                    asset={asset}
                  />
                  <div className="asset-info">
                    <strong>{asset.original_name}</strong>
                    <small>
                      {asset.status === "verified"
                        ? "Cópia verificada"
                        : asset.error || "Falha na cópia"}
                    </small>
                    {asset.metadata && (
                      <small>
                        {asset.metadata.kind === "video" ? "Vídeo" : "Imagem"}
                        {asset.metadata.duration_seconds != null
                          ? ` · ${asset.metadata.duration_seconds.toFixed(1)} s`
                          : ""}
                        {asset.metadata.width && asset.metadata.height
                          ? ` · ${asset.metadata.width}×${asset.metadata.height}`
                          : ""}
                        {asset.metadata.video_codec
                          ? ` · ${asset.metadata.video_codec}`
                          : ""}
                      </small>
                    )}
                    {asset.processing_error && (
                      <small className="processing-warning">
                        Metadados/miniatura não concluídos:{" "}
                        {asset.processing_error}
                      </small>
                    )}
                  </div>
                </div>
              ))}
            </div>
            <p className="hint">Manifesto: {latest.manifest_path}</p>
            <button
              className="secondary"
              type="button"
              onClick={() => {
                setPage("Acervo");
                void loadCaptures();
              }}
            >
              Ver arquivos no Acervo
            </button>
            <button
              className="secondary result-next"
              type="button"
              onClick={() => {
                setPage("Processamento");
                void loadCaptures();
              }}
            >
              Conferir processamento
            </button>
            <button
              className="secondary result-next"
              type="button"
              onClick={() => {
                setPage("Revisão");
                void loadCaptures();
                void loadReviewItems(latest.capture_id);
              }}
            >
              Revisar takes
            </button>
          </section>
        )}
        {page === "Acervo" && (
          <>
            <div
              className="catalog-search-wrap"
            >
              <form
                className="catalog-search-form"
                role="search"
                onSubmit={(event) => {
                  event.preventDefault();
                  submitCatalogSearch();
                }}
              >
                <label className="search-field" htmlFor="catalog-search-input">
                  Pesquisar no acervo local
                  <span className="catalog-search-input-row">
                    <input
                      id="catalog-search-input"
                      type="search"
                      aria-label="Pesquisar no acervo local"
                      value={searchQuery}
                      onFocus={() => {
                        closeCatalogFilterPanels();
                        setSearchFocused(true);
                      }}
                      onChange={(event) => setSearchQuery(event.target.value)}
                      placeholder="Ex.: C001, Praia do Morro, comércio, pessoas"
                      aria-controls="catalog-search-suggestions"
                      aria-expanded={searchFocused}
                    />
                    {searchQuery && (
                      <button
                        type="button"
                        className="secondary catalog-clear-search"
                        onClick={clearCatalogSearch}
                        aria-label="Limpar busca e filtros"
                      >
                        Limpar
                      </button>
                    )}
                  </span>
                </label>
                <button className="primary catalog-submit-search" type="submit">
                  Buscar
                </button>
              </form>
              {searchFocused && (
                <div
                  className="catalog-search-suggestions"
                  id="catalog-search-suggestions"
                  role="group"
                  aria-label="Buscas recentes e exemplos"
                >
                  {recentSearches.length > 0 && (
                    <div>
                      <strong>Buscas recentes</strong>
                      <div className="catalog-suggestion-list">
                        {recentSearches.map((search) => (
                          <button
                            key={search}
                            type="button"
                            onMouseDown={(event) => event.preventDefault()}
                            onClick={() => submitCatalogSearch(search)}
                          >
                            {search}
                          </button>
                        ))}
                      </div>
                    </div>
                  )}
                  <div>
                    <strong>Exemplos</strong>
                    <div className="catalog-suggestion-list">
                      {catalogSearchExamples.map((search) => (
                        <button
                          key={search}
                          type="button"
                          onMouseDown={(event) => event.preventDefault()}
                          onClick={() => submitCatalogSearch(search)}
                        >
                          {search}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>
              )}
            </div>
            <div
              className="catalog-search-filters"
              aria-label="Filtros do acervo"
              onClickCapture={(event) => {
                if (!(event.target instanceof Element)) return;
                const summary = event.target.closest("summary");
                if (!summary) return;
                const filter = summary.parentElement;
                if (filter) filter.dataset.align = summary.getBoundingClientRect().left + 296 > window.innerWidth - 16 ? "end" : "start";
                setSearchFocused(false);
                closeCatalogFilterPanels(summary.parentElement);
              }}
            >
              <details className={`catalog-filter ${searchFilters.location ? "active" : ""}`}>
                <summary>{searchFilters.location ? `Local · ${searchFilters.location}` : "Local"}</summary>
                <CatalogFilterOptions label="Local" value={searchFilters.location}
                  options={[{ value: "", label: "Todos os locais" }, ...catalogLocationOptions.map((value) => ({ value, label: value }))]}
                  onChange={(value) => updateCatalogFilter("location", value)} />
              </details>
              <details className={`catalog-filter ${searchFilters.matter ? "active" : ""}`}>
                <summary>{searchFilters.matter ? `Matéria · ${searchFilters.matter}` : "Matéria"}</summary>
                <CatalogFilterOptions label="Matéria" value={searchFilters.matter}
                  options={[{ value: "", label: "Todas as matérias" }, ...catalogMatterOptions.map((value) => ({ value, label: value }))]}
                  onChange={(value) => updateCatalogFilter("matter", value)} />
              </details>
              <details className={`catalog-filter ${searchFilters.date ? "active" : ""}`}>
                <summary>{searchFilters.date ? `Data · ${new Date(`${searchFilters.date}T12:00:00`).toLocaleDateString("pt-BR")}` : "Data"}</summary>
                <label className="catalog-filter-content">
                  Data
                  <input
                    type="date"
                    value={searchFilters.date}
                    onChange={(event) => updateCatalogFilter("date", event.target.value)}
                  />
                </label>
              </details>
              <details className={`catalog-filter ${searchFilters.tag ? "active" : ""}`}>
                <summary>{searchFilters.tag ? `Tags · ${searchFilters.tag}` : "Tags"}</summary>
                <CatalogFilterOptions label="Tags" value={searchFilters.tag}
                  options={[{ value: "", label: "Todas as tags" }, ...catalogTagOptions.map((value) => ({ value, label: value }))]}
                  onChange={(value) => updateCatalogFilter("tag", value)} />
              </details>
              <details className={`catalog-filter ${searchFilters.status !== "all" ? "active" : ""}`}>
                <summary>
                  {searchFilters.status === "pending"
                    ? "Status · Pendente de revisão"
                    : searchFilters.status === "catalogued"
                      ? "Status · Catalogada"
                      : "Status"}
                </summary>
                <CatalogFilterOptions label="Status" searchable={false} value={searchFilters.status}
                  options={[{ value: "all", label: "Todos os status" }, { value: "pending", label: "Pendente de revisão" }, { value: "catalogued", label: "Catalogada" }]}
                  onChange={(value) => updateCatalogFilter("status", value as CatalogSearchFilters["status"])} />
              </details>
              {hasSearchFilters && (
                <button type="button" className="link-button" onClick={clearCatalogFilters}>
                  Limpar filtros
                </button>
              )}
            </div>
            <div className="metrics">
              <button
                type="button"
                className="card metric metric-button"
                onClick={openFullCatalog}
                aria-label="Abrir todos os arquivos catalogados"
              >
                <span>Arquivos catalogados</span>
                <strong>
                  {captures
                    .reduce(
                      (total, capture) => total + capture.verified_count,
                      0,
                    )
                    .toLocaleString("pt-BR")}
                </strong>
                <small>Cópias verificadas no acervo carregado</small>
              </button>
              <button
                type="button"
                className="card metric metric-button"
                onClick={openPendingCaptures}
                aria-label="Ver captações com takes pendentes de revisão"
              >
                <span>Captações recentes</span>
                <strong>{captures.length}</strong>
                <small>{pendingCaptureCount} aguardando revisão</small>
              </button>
              <button
                type="button"
                className="card metric metric-button"
                onClick={() => {
                  setPage("Nova ingestão");
                  setSettingsOpen(true);
                }}
                aria-label="Abrir Nova ingestão para conectar uma fonte"
              >
                <span>Fontes conectadas</span>
                <strong>{devices.length}</strong>
                <small>
                  {deviceChecking
                    ? "Atualizando dispositivos…"
                    : "Dispositivos USB detectados neste computador"}
                </small>
              </button>
            </div>
            {catalogSearchActive ? (
              <section className="catalog-search-results" ref={catalogResultsRef} aria-live="polite">
                <div className="section-heading">
                  <div>
                    <h2>{showFullCatalog ? "Arquivos catalogados" : "Resultados da busca"}</h2>
                    <p>
                      {catalogSearchPending || capturesLoading
                        ? "Buscando no acervo…"
                        : `${catalogResultCount} resultado(s) em ${catalogResults.length} captação(ões).`}
                    </p>
                  </div>
                  <button type="button" className="secondary" onClick={clearCatalogSearch}>
                    Limpar busca
                  </button>
                </div>
                {catalogSearchPending || capturesLoading ? (
                  <p className="empty" role="status">Buscando no acervo…</p>
                ) : catalogResults.length === 0 ? (
                  <div className="empty catalog-empty-state">
                    <p>Nenhum take encontrado. Tente outro termo ou remova filtros.</p>
                    {hasSearchFilters && (
                      <button type="button" className="secondary" onClick={clearCatalogFilters}>
                        Remover filtros
                      </button>
                    )}
                  </div>
                ) : (
                  <div className={`catalog-results-layout ${selectedCatalogResult ? "has-preview" : ""}`}>
                    <div className="catalog-result-groups">
                      {catalogResults.map(({ capture, results }) => (
                        <section className="catalog-result-group" key={capture.capture_id}>
                          <div className="catalog-result-group-heading">
                            <h3>{capture.capture_name}</h3>
                            <span>{results.length} take(s) · {new Date(capture.created_at).toLocaleDateString("pt-BR")}</span>
                          </div>
                          <div className="catalog-result-grid">
                            {results.map((result) => (
                              <article className="catalog-result-card" key={result.asset.asset_id}>
                                <button
                                  type="button"
                                  className="catalog-result-main"
                                  aria-pressed={catalogSelection?.assetId === result.asset.asset_id && catalogSelection.captureId === capture.capture_id}
                                  aria-label={`Abrir prévia de ${result.asset.original_name}, captação ${capture.capture_name}`}
                                  onClick={() => void openCatalogResult(capture.capture_id, result.asset.asset_id)}
                                >
                                  <Thumbnail
                                    destination={destination}
                                    workspace={workspace}
                                    captureId={capture.capture_id}
                                    asset={result.asset}
                                  />
                                  <span className="catalog-result-copy">
                                    <strong>{result.asset.original_name}</strong>
                                    <small>Local: {result.location || "Não identificado"}</small>
                                    <small>Matéria: {result.matter || "Não identificada"}</small>
                                    <small>Tags: {result.tags.length ? result.tags.join(", ") : "Sem tags"}</small>
                                    <small>Captação: {capture.capture_name}</small>
                                    <small className="catalog-match-excerpt">
                                      {result.excerpt ? `Correspondeu em: ${result.excerpt}` : "Arquivo do acervo local"}
                                    </small>
                                    <span className={`catalog-result-status ${result.status}`}>
                                      {result.status === "pending" ? "Pendente de revisão" : "Catalogada"}
                                    </span>
                                  </span>
                                </button>
                                <button
                                  type="button"
                                  className="link-button catalog-open-review"
                                  onClick={() => void openCatalogResultInReview({ captureId: capture.capture_id, assetId: result.asset.asset_id })}
                                >
                                  Abrir na revisão
                                </button>
                              </article>
                            ))}
                          </div>
                        </section>
                      ))}
                    </div>
                    {selectedCatalogResult && <aside
                      className="card catalog-preview-panel"
                      aria-label="Prévia e evidências do take"
                      ref={catalogPreviewPanelRef}
                      tabIndex={-1}
                      aria-busy={catalogPreviewLoading}
                    >
                      {selectedCatalogResult && selectedCatalogCapture ? (
                        <>
                          <div className="catalog-preview-heading">
                            <div>
                              <span className="step">Prévia do take</span>
                              <h3>{selectedCatalogResult.asset.original_name}</h3>
                            </div>
                            <button
                              type="button"
                              className="secondary"
                              aria-label="Fechar prévia"
                              onClick={() => {
                                catalogPreviewRequest.current += 1;
                                document.querySelector<HTMLButtonElement>(".catalog-result-main[aria-pressed='true']")?.focus();
                                setCatalogSelection(null);
                              }}
                            >
                              Fechar
                            </button>
                          </div>
                          <p className="hint">
                            {selectedCatalogCapture.capture_name} · {selectedCatalogResult.asset.metadata?.recorded_at
                              ? new Date(selectedCatalogResult.asset.metadata.recorded_at).toLocaleString("pt-BR")
                              : new Date(selectedCatalogCapture.created_at).toLocaleDateString("pt-BR")}
                          </p>
                          <div className="review-preview catalog-preview">
                            {catalogPreview?.kind === "image" && (
                              <img
                                src={catalogPreview.url}
                                alt={selectedCatalogResult.asset.original_name}
                                onError={() => setCatalogPreviewError("Não foi possível abrir a imagem.")}
                              />
                            )}
                            {catalogPreview?.kind === "video" && (
                              <video
                                src={catalogPreview.url}
                                controls
                                preload="metadata"
                                onError={() => setCatalogPreviewError("Não foi possível reproduzir o vídeo.")}
                              >
                                Seu sistema não suporta a reprodução deste vídeo.
                              </video>
                            )}
                            {!catalogPreview && catalogPreviewLoading && <p role="status">Carregando prévia…</p>}
                            {catalogPreviewError && <p role="status">{catalogPreviewError}</p>}
                          </div>
                          <section className="review-evidence">
                            <strong>Evidências</strong>
                            {catalogSelectedReview?.evidence.length ? (
                              <ul>
                                {catalogSelectedReview.evidence.map((evidence, index) => (
                                  <li key={`${evidence.kind}-${index}`}>
                                    <b>{evidence.label}:</b> {evidence.value}
                                  </li>
                                ))}
                              </ul>
                            ) : (
                              <p className="hint">Nenhuma evidência detalhada disponível para este take.</p>
                            )}
                            <p>Local: {selectedCatalogResult.location || "Não identificado"}</p>
                            <p>Matéria: {selectedCatalogResult.matter || "Não identificada"}</p>
                            <p>Tags: {selectedCatalogResult.tags.length ? selectedCatalogResult.tags.join(", ") : "Sem tags"}</p>
                            {selectedCatalogResult.review?.visual_description && (
                              <p>{selectedCatalogResult.review.visual_description}</p>
                            )}
                          </section>
                          <button type="button" className="primary" onClick={() => void openCatalogResultInReview()}>
                            Abrir na revisão
                          </button>
                        </>
                      ) : (
                        <p className="empty">Selecione um take para ver a prévia e as evidências.</p>
                      )}
                    </aside>}
                  </div>
                )}
              </section>
            ) : (
            <>
            <div className="archive-grid">
              <section className="card archive-captures">
                <div className="section-heading">
                  <div>
                    <h2>Captações neste computador</h2>
                    <p>
                      Pesquise por arquivo, captação, pauta, local confirmado,
                      matéria ou tags da revisão.
                    </p>
                  </div>
                  <button
                    className="secondary"
                    disabled={!destination || !workspace || busy}
                    onClick={loadCaptures}
                  >
                    Atualizar
                  </button>
                </div>

                {captures.length ? (
                  visibleCaptures.length ? (
                    visibleCaptures.map(({ capture, assets }) => (
                      <details
                        className="capture-detail"
                        key={capture.capture_id}
                        open={Boolean(query)}
                      >
                        <summary
                          className="capture"
                          aria-label={`Abrir detalhes da captação ${capture.capture_name}`}
                        >
                          {capture.assets.find(
                            (asset) => asset.thumbnail_relative_path,
                          ) && (
                            <Thumbnail
                              destination={destination}
                              workspace={workspace}
                              captureId={capture.capture_id}
                              asset={
                                capture.assets.find(
                                  (asset) => asset.thumbnail_relative_path,
                                )!
                              }
                            />
                          )}
                          <div className="asset-info">
                            <strong>{capture.capture_name}</strong>
                            <span>
                              {capture.verified_count} arquivos verificados ·{" "}
                              {capture.failed_count} falhas
                            </span>
                            <small>
                              {assets.length} arquivo(s) nesta visualização
                            </small>
                            {capture.visited_locations?.length > 0 && (
                              <small>
                                Locais informados:{" "}
                                {capture.visited_locations.join(" · ")}
                              </small>
                            )}
                          </div>
                        </summary>
                        {(capture.failed_count > 0 ||
                          (capture.pending_count || 0) > 0) && (
                          <div className="notice">
                            {capture.pending_count || 0} pendente(s) de cópia ·{" "}
                            {capture.failed_count} falha(s).{" "}
                            <button
                              className="secondary"
                              disabled={busy}
                              onClick={() => void resumeIngest(capture)}
                            >
                              Retomar ingestão
                            </button>
                          </div>
                        )}
                        {!!capture.load_warnings?.length && (
                          <p role="alert" className="notice">
                            {capture.load_warnings.join(" ")}
                          </p>
                        )}
                        <div className="asset-list">
                          {assets.map((asset) => (
                            <div
                              className="asset media-asset"
                              key={asset.asset_id}
                            >
                              <Thumbnail
                                destination={destination}
                                workspace={workspace}
                                captureId={capture.capture_id}
                                asset={asset}
                              />
                              <div className="asset-info">
                                <strong>{asset.original_name}</strong>
                                <small>{asset.original_relative_path}</small>
                                <small>
                                  {asset.status === "verified"
                                    ? "Cópia verificada"
                                    : asset.error || "Falha na cópia"}
                                  {asset.metadata?.duration_seconds != null
                                    ? ` · ${asset.metadata.duration_seconds.toFixed(1)} s`
                                    : ""}
                                  {asset.metadata?.width &&
                                  asset.metadata.height
                                    ? ` · ${asset.metadata.width}×${asset.metadata.height}`
                                    : ""}
                                </small>
                                {(() => {
                                  const entry = reviewIndex.find(
                                    (item) =>
                                      item.capture_id === capture.capture_id &&
                                      item.asset_id === asset.asset_id,
                                  );
                                  return entry ? (
                                    <small className="review-search-meta">
                                      {entry.status === "confirmed"
                                        ? `Local: ${entry.location}`
                                        : entry.status === "unidentified"
                                          ? "Local não identificado"
                                          : entry.status === "organized"
                                            ? "Organizado pela IA"
                                            : "Exceção ou análise pendente"}
                                      {entry.matter
                                        ? ` · Matéria: ${entry.matter}`
                                        : ""}
                                      {entry.tags.length
                                        ? ` · Tags: ${entry.tags.join(", ")}`
                                        : ""}
                                    </small>
                                  ) : null;
                                })()}
                                {asset.processing_error && (
                                  <small className="processing-warning">
                                    Prévia não concluída:{" "}
                                    {asset.processing_error}
                                  </small>
                                )}
                              </div>
                              {asset.status === "verified" &&
                                mediaExtension.test(asset.original_name) && (
                                  <button
                                    className="secondary open-review"
                                    type="button"
                                    onClick={() => {
                                      setPage("Revisão");
                                      void loadReviewItems(
                                        capture.capture_id,
                                        asset.asset_id,
                                      );
                                    }}
                                  >
                                    Abrir na Revisão
                                  </button>
                                )}
                            </div>
                          ))}
                        </div>
                      </details>
                    ))
                  ) : (
                    <p className="empty">
                      Nenhum arquivo encontrado para “{searchQuery}”. A busca
                      usa nomes, contexto, decisões humanas e descrições ou tags
                      visuais já analisadas.
                    </p>
                  )
                ) : (
                  <p className="empty">
                    Nenhuma captação carregada. Informe o destino e clique em
                    Atualizar.
                  </p>
                )}
              </section>
              <aside className="card sources-card">
                <h2>Fontes detectadas</h2>
                <p className="hint">
                  Dispositivos conectados e pastas escolhidas neste computador.
                </p>
                {devices.map((device) => (
                  <div className="signal source-device-card" key={device.path}>
                    <div>
                      <strong>
                        {device.label} · {device.path}
                      </strong>
                      <p>
                        {sourceReady && sourceDevice?.path === device.path
                          ? "Pronto para ler"
                          : "Conectado"}
                        {` · ${formatBytes(device.free_bytes)} livres`}
                      </p>
                    </div>
                    <button
                      type="button"
                      className="secondary"
                      disabled={busy}
                      aria-label={`Ingerir usando ${device.label} em ${device.path}`}
                      onClick={() => {
                        setSource(device.path);
                        setPage("Nova ingestão");
                        setSettingsOpen(true);
                      }}
                    >
                      Ingerir
                    </button>
                  </div>
                ))}
                {deviceError && (
                  <p className="processing-warning" role="status">
                    {deviceError}
                  </p>
                )}
                <div className="signal">
                  <strong>Origem selecionada</strong>
                  <p className="path-text">
                    {source || "Nenhuma pasta selecionada"}
                  </p>
                </div>
                <div className="signal">
                  <strong>Destino das cópias</strong>
                  <p className="path-text">
                    {destination ||
                      "Escolha a pasta permanente nas Configurações"}
                  </p>
                </div>
                <button
                  className="secondary"
                  disabled={busy}
                  onClick={() => {
                    setPage("Nova ingestão");
                    setSettingsOpen(true);
                  }}
                >
                  Selecionar origem
                </button>
              </aside>
            </div>
            <section className="action-banner">
              <span className="protection-mark" aria-hidden="true">
                ✓
              </span>
              <div>
                <h2>Seus originais continuam aqui</h2>
                <p>
                  A ingestão cria cópias verificadas, metadados e miniaturas. Os
                  arquivos de origem são preservados.
                </p>
              </div>
            </section>
            </>
            )}
          </>
        )}
        {page === "Processamento" && (
          <section className="card">
            <div className="section-heading">
              <div>
                <h2 className="processing-title">Leitura local e análise da captação</h2>
                <p>
                  Acompanhe a leitura dos arquivos e a organização automática
                  pela IA local. Nenhum original é movido.
                </p>
              </div>
              <button
                className="secondary"
                disabled={!destination || !workspace || busy}
                onClick={loadCaptures}
              >
                Atualizar
              </button>
            </div>
            <p className="hint">
              A IA usa imagens, quadros de vídeo e as pistas informadas na
              ingestão. Local só é sugerido quando há evidência; os originais
              continuam preservados.
            </p>
            {captures.length > 0 && (
              <label className="processing-selector">
                Captação em processamento
                <select
                  value={processingCaptureId}
                  onChange={(event) =>
                    setProcessingCaptureId(event.target.value)
                  }
                >
                  {captures.map((capture) => (
                    <option key={capture.capture_id} value={capture.capture_id}>
                      {capture.capture_name} ·{" "}
                      {new Date(capture.created_at).toLocaleString("pt-BR")} ·{" "}
                      {capture.verified_count} arquivo(s)
                    </option>
                  ))}
                </select>
              </label>
            )}
            {captures.length ? (
              captures
                .filter((capture) => capture.capture_id === processingCaptureId)
                .map((capture) => {
                  const media = capture.assets.filter(
                    (asset) =>
                      asset.status === "verified" &&
                      mediaExtension.test(asset.original_name),
                  );
                  const pending = media.filter(
                    (asset) =>
                      !asset.metadata ||
                      !asset.thumbnail_relative_path ||
                      asset.processing_error,
                  );
                  const analyzedByAi = reviewIndex.filter(
                    (item) =>
                      item.capture_id === capture.capture_id &&
                      Boolean(item.visual_description),
                  ).length;
                  const notAnalyzedByAi = Math.max(
                    0,
                    media.length - analyzedByAi,
                  );
                  const analysisDone = aiRunning
                    ? Math.min(aiProgress?.done || 0, media.length)
                    : analyzedByAi;
                  const analysisPercent = media.length
                    ? Math.round((analysisDone / media.length) * 100)
                    : 0;
                  return (
                    <div
                      className="processing-capture"
                      key={capture.capture_id}
                    >
                      <div className="processing-heading">
                        <div>
                          <h3>{capture.capture_name}</h3>
                          <p>
                            {capture.verified_count} cópia(s) verificada(s) ·{" "}
                            {media.filter((asset) => asset.metadata).length}/
                            {media.length} com metadados ·{" "}
                            {
                              media.filter(
                                (asset) => asset.thumbnail_relative_path,
                              ).length
                            }
                            /{media.length} com miniatura
                          </p>
                        </div>
                        <button
                          className="secondary"
                          disabled={busy || media.length === 0}
                          onClick={() => void retryProcessing(capture)}
                        >
                          {busy
                            ? "Processando…"
                            : pending.length
                              ? `Tentar novamente (${pending.length})`
                              : "Conferir prévias"}
                        </button>
                      </div>
                      {(capture.failed_count > 0 ||
                        (capture.pending_count || 0) > 0) && (
                        <div className="notice">
                          <p>
                            {capture.failed_count} falha(s) ·{" "}
                            {capture.pending_count || 0} arquivo(s) pendentes de
                            cópia. Reconecte a origem para continuar a mesma
                            captação.
                          </p>
                          <button
                            className="secondary"
                            disabled={busy}
                            onClick={() => void resumeIngest(capture)}
                          >
                            Retomar ingestão
                          </button>
                        </div>
                      )}
                      {!!capture.load_warnings?.length && (
                        <div role="alert" className="notice">
                          {capture.load_warnings.join(" ")}
                        </div>
                      )}
                      {capture.failed_count > 0 && (
                        <p className="processing-warning">
                          {capture.failed_count} cópia(s) falharam na ingestão.
                          Esta ação tenta apenas metadados e miniaturas de
                          cópias verificadas.
                        </p>
                      )}
                      <div className="progress-summary">
                        <div>
                          <strong>
                            {aiRunning
                              ? `Análise em andamento · ${aiProgress?.current || "preparando IA local"}`
                              : media.length && analyzedByAi === media.length
                                ? "Análise concluída"
                                : !ollamaStatus?.model_ready
                                  ? "Aguardando IA local"
                                  : notAnalyzedByAi > 0
                                    ? "IA pronta para analisar"
                                    : "Nenhuma mídia para analisar"}
                          </strong>
                          <span>
                            {capture.verified_count} de {capture.assets.length}{" "}
                            arquivos lidos · {analysisDone} de {media.length}{" "}
                            analisados · {analysisPercent}%
                          </span>
                        </div>
                        <progress
                          max={media.length || 1}
                          value={analysisDone}
                          aria-label="Progresso da análise visual local"
                        />
                      </div>
                      <div className="pipeline-grid">
                        <section className="pipeline-panel">
                          <span className="eyebrow">AGENTE LOCAL · ESTE COMPUTADOR</span>
                          <h2>Leitura local e proteção dos originais</h2>
                          <div className="signal">
                            <strong>Inventário</strong>
                            <p>
                              {capture.assets.length} arquivos registrados ·{" "}
                              {capture.verified_count} cópias verificadas ·{" "}
                              {capture.failed_count} falhas
                            </p>
                          </div>
                          <div className="signal">
                            <strong>Metadados</strong>
                            <p>
                              {media.filter((asset) => asset.metadata).length}{" "}
                              de {media.length} mídias com metadados
                            </p>
                          </div>
                          <div className="signal">
                            <strong>Miniaturas</strong>
                            <p>
                              {
                                media.filter(
                                  (asset) => asset.thumbnail_relative_path,
                                ).length
                              }{" "}
                              de {media.length} mídias com miniatura
                            </p>
                          </div>
                          <div className="signal">
                            <strong>Segurança</strong>
                            <p>
                              Os arquivos da origem não são movidos nem
                              renomeados.
                            </p>
                          </div>
                        </section>
                        <section className="pipeline-panel">
                          <span className="eyebrow">ANÁLISE VISUAL · IA LOCAL</span>
                          <h2>Entendimento do conteúdo</h2>
                          <div className="signal">
                            <strong>Leitura visual</strong>
                            <p>
                              Cenas, objetos e textos visíveis em fotos e
                              quadros de vídeo. Sem transcrição de áudio neste MVP.
                            </p>
                          </div>
                          <div className="signal">
                            <strong>Pistas de localização</strong>
                            <p>
                              GPS embutido e telemetria SRT, quando disponíveis,
                              mais pistas visuais e o contexto da captação.
                            </p>
                          </div>
                          <div className="signal">
                            <strong>Sugestão de grupos</strong>
                            <p>
                              Takes separados automaticamente por local → matéria;
                              locais sem evidência ficam destacados para revisão.
                            </p>
                          </div>
                          <div className="signal">
                            <strong>Busca preparada</strong>
                            <p>
                              Metadados, descrições visuais e tags ficam
                              disponíveis para pesquisar no acervo local.
                            </p>
                          </div>
                        </section>
                      </div>
                      {aiProgress?.errors.length ? (
                        <p className="notice" role="alert">
                          A análise teve {aiProgress.errors.length} falha(s).
                          Confira as falhas e retome
                          os takes pendentes.
                        </p>
                      ) : null}
                      {queuedAi?.destination === destination &&
                        queuedAi.workspace === workspace &&
                        queuedAi.captureId === capture.capture_id && (
                          <div className="notice" role="status">
                            Há uma análise interrompida ou com falhas.{" "}
                            <button
                              className="secondary"
                              disabled={busy || !ollamaStatus?.model_ready}
                              onClick={() =>
                                void runVisualAnalysis(
                                  capture,
                                  undefined,
                                  false,
                                  queuedAi.detailed,
                                )
                              }
                            >
                              Retomar análise
                            </button>
                            <p className="hint">
                              Resultados concluídos serão reutilizados. O modo
                              de amostragem original será mantido.
                            </p>
                          </div>
                        )}
                      <section className="action-banner processing-next">
                        <div>
                          <h2>
                            {aiRunning
                              ? "A IA está organizando sua captação"
                              : notAnalyzedByAi > 0
                                ? "A organização automática está pronta para iniciar"
                                : "Sugestões prontas para sua conferência"}
                          </h2>
                          <p>
                            {aiRunning
                              ? "Acompanhe o progresso acima. Ao terminar, você encontrará grupos por local → matéria e as exceções sem evidência."
                              : notAnalyzedByAi > 0 && !ollamaStatus?.model_ready
                                ? "A cópia verificada está segura. Configure a IA local para separar os takes automaticamente; depois, revise somente as exceções."
                                : notAnalyzedByAi > 0
                                  ? `${notAnalyzedByAi} arquivo(s) ainda aguardam análise. A IA separa o conteúdo e você revisa os casos sem evidência suficiente.`
                                  : "Revise os grupos por local → matéria. Takes sem evidência de local ficam separados para confirmação ou marcação como não identificados."}
                          </p>
                        </div>
                        {aiRunning ? (
                          <button className="secondary" disabled>
                            Analisando…
                          </button>
                        ) : notAnalyzedByAi > 0 && !ollamaStatus?.model_ready ? (
                          <button
                            className="secondary"
                            type="button"
                            onClick={openAiSettings}
                          >
                            Configurar IA local
                          </button>
                        ) : notAnalyzedByAi > 0 ? (
                          <button
                            className="primary"
                            disabled={busy || !media.length}
                            onClick={() => void runVisualAnalysis(capture)}
                          >
                            Analisar {notAnalyzedByAi} arquivo(s)
                          </button>
                        ) : (
                          <button
                            className="primary"
                            disabled={busy || !media.length}
                            onClick={() => {
                              setPage("Revisão");
                              void loadReviewItems(capture.capture_id);
                            }}
                          >
                            Revisar sugestões
                          </button>
                        )}
                      </section>
                      <h3 className="asset-section-title">
                        Arquivos lidos · {capture.assets.length}
                      </h3>
                      <details className="processing-files">
                        <summary>Ver inventário e prévias dos arquivos</summary>
                        <div className="processing-assets">
                          {capture.assets.map((asset) => (
                          <div
                            className="processing-asset"
                            key={asset.asset_id}
                          >
                            <Thumbnail
                              destination={destination}
                              workspace={workspace}
                              captureId={capture.capture_id}
                              asset={asset}
                            />
                            <div className="asset-info">
                              <strong>{asset.original_name}</strong>
                              <small>
                                {asset.status === "pending"
                                  ? "Cópia pendente — retome a ingestão"
                                  : asset.status !== "verified"
                                    ? "Falha na cópia"
                                    : !mediaExtension.test(asset.original_name)
                                      ? "Arquivo auxiliar preservado"
                                      : asset.processing_error
                                        ? "Prévia com falha"
                                        : asset.metadata &&
                                            asset.thumbnail_relative_path
                                          ? "Metadados e miniatura prontos"
                                          : "Prévia pendente"}
                              </small>
                              {asset.metadata && (
                                <small>
                                  {asset.metadata.width && asset.metadata.height
                                    ? `${asset.metadata.width}×${asset.metadata.height}`
                                    : "Dimensões indisponíveis"}
                                  {asset.metadata.duration_seconds != null
                                    ? ` · ${asset.metadata.duration_seconds.toFixed(1)} s`
                                    : ""}
                                  {asset.metadata.video_codec
                                    ? ` · ${asset.metadata.video_codec}`
                                    : ""}
                                </small>
                              )}
                              {asset.processing_error && (
                                <small className="processing-warning">
                                  {asset.processing_error}
                                </small>
                              )}
                            </div>
                          </div>
                          ))}
                        </div>
                      </details>
                    </div>
                  );
                })
            ) : (
              <p className="empty">
                Nenhuma captação carregada. Informe a pasta do acervo acima e
                clique em Atualizar.
              </p>
            )}
          </section>
        )}
        {page === "Revisão" && (
          <section className="review-section">
            <div className="review-toolbar">
              <p className="hint">
                Grupos por local → matéria. Confira as exceções e aprove quando
                todos os takes estiverem resolvidos.
              </p>
              <button
                className="secondary"
                disabled={!destination || !workspace || busy}
                onClick={() => {
                  void loadCaptures();
                  if (reviewCaptureId) void loadReviewItems(reviewCaptureId);
                }}
              >
                Atualizar
              </button>
            </div>
            <div className="review-context">
              <label>
                Captação para revisar
                <select
                  disabled={busy}
                  value={reviewCaptureId}
                  onChange={(event) => void loadReviewItems(event.target.value)}
                >
                  <option value="">Selecione uma captação</option>
                  {captures.map((capture) => (
                    <option key={capture.capture_id} value={capture.capture_id}>
                      {capture.capture_name} ·{" "}
                      {new Date(capture.created_at).toLocaleDateString("pt-BR")}
                    </option>
                  ))}
                </select>
              </label>
              {reviewCapture && (
                <>
                  <p className="hint">
                    A IA usa o conteúdo dos arquivos e o contexto informado como
                    pistas. Os grupos são exibidos por local → matéria; local sem
                    evidência suficiente continua não identificado.
                  </p>
                  {reviewCapture.team && (
                    <p className="hint">Equipe: {reviewCapture.team}</p>
                  )}
                </>
              )}
            </div>
            {reviewItems.length > 0 && (
              <section className="review-ai-status" aria-live="polite">
                <div>
                  <span className="eyebrow">ORGANIZAÇÃO DA CAPTAÇÃO</span>
                  <strong>
                    {analyzedReviewCount} de {reviewItems.length} takes
                    analisados pela IA · {pendingReviews} para conferir ·{" "}
                    {unlocatedReviewCount} sem local
                  </strong>
                  <p>
                    A IA já separou o conteúdo em grupos. Abra um take quando
                    precisar conferir a prévia ou corrigir uma exceção; os
                    demais não exigem classificação manual. Depois da aprovação,
                    você pode criar cópias organizadas. Os originais permanecem
                    preservados.
                  </p>
                  {reviewAiPendingCount > 0 && !ollamaStatus?.model_ready && (
                    <p className="processing-warning">
                      A IA ainda não analisou todos os takes porque não está
                      configurada neste computador. Você pode configurá-la e
                      gerar os grupos automaticamente.
                    </p>
                  )}
                </div>
                {reviewAiPendingCount > 0 &&
                  (ollamaStatus?.model_ready ? (
                    <button
                      className="primary"
                      disabled={busy || !reviewCapture}
                      onClick={() => {
                        if (reviewCapture) void runVisualAnalysis(reviewCapture);
                      }}
                    >
                      Analisar takes pendentes
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="secondary"
                      onClick={openAiSettings}
                    >
                      Configurar IA local
                    </button>
                  ))}
              </section>
            )}
            {captureHasDrafts && (
              <p className="notice" role="status">
                Há rascunhos nesta captação. Eles são preservados ao navegar;
                salve ou descarte os rascunhos antes de aprovar ou editar em
                lote.
              </p>
            )}
            {reviewItems.length > 0 && (
              <details className="card batch-editor">
                <summary>
                  Editar takes em lote · {batchIds.length} selecionado(s)
                </summary>
                <fieldset disabled={busy || captureHasDrafts}>
                  <div className="batch-actions">
                    <button
                      type="button"
                      className="secondary"
                      onClick={() =>
                        setBatchIds(
                          filteredReviewItems
                            .slice(0, 500)
                            .map((item) => item.asset_id),
                        )
                      }
                    >
                      Selecionar takes deste filtro (até 500)
                    </button>
                    <button
                      type="button"
                      className="secondary"
                      onClick={() => setBatchIds([])}
                    >
                      Limpar seleção
                    </button>
                  </div>
                  <div className="field-grid">
                    <label>
                      Alteração do local
                      <select
                        value={batchStatus}
                        onChange={(event) => setBatchStatus(event.target.value)}
                      >
                        <option value="">Preservar decisão atual</option>
                        <option value="confirmed">
                          Confirmar o mesmo local
                        </option>
                        <option value="unidentified">
                          Marcar local não identificado
                        </option>
                        <option value="pending">Manter pendente</option>
                      </select>
                    </label>
                    {batchStatus === "confirmed" && (
                      <label>
                        Local confirmado para os takes selecionados
                        <input
                          value={batchLocation}
                          maxLength={120}
                          onChange={(event) =>
                            setBatchLocation(event.target.value)
                          }
                        />
                      </label>
                    )}
                    <label>
                      <span>
                        <input
                          type="checkbox"
                          checked={batchMatterEnabled}
                          onChange={(event) =>
                            setBatchMatterEnabled(event.target.checked)
                          }
                        />{" "}
                        Alterar matéria
                      </span>
                      {batchMatterEnabled && (
                        <input
                          value={batchMatter}
                          maxLength={120}
                          onChange={(event) =>
                            setBatchMatter(event.target.value)
                          }
                          placeholder="Deixe vazio para limpar"
                        />
                      )}
                    </label>
                    <label>
                      <span>
                        <input
                          type="checkbox"
                          checked={batchTagsEnabled}
                          onChange={(event) =>
                            setBatchTagsEnabled(event.target.checked)
                          }
                        />{" "}
                        Substituir tags
                      </span>
                      {batchTagsEnabled && (
                        <input
                          value={batchTags}
                          onChange={(event) => setBatchTags(event.target.value)}
                          placeholder="Separadas por vírgula; vazio limpa"
                        />
                      )}
                    </label>
                  </div>
                  <button
                    className="primary"
                    disabled={
                      !batchIds.length ||
                      (!batchStatus &&
                        !batchMatterEnabled &&
                        !batchTagsEnabled) ||
                      (batchStatus === "confirmed" && !batchLocation.trim())
                    }
                    onClick={() => void saveBatch()}
                  >
                    Aplicar alterações aos selecionados
                  </button>
                  <p className="hint">
                    Somente os campos indicados serão alterados. O lote é
                    validado por inteiro antes de salvar.
                  </p>
                </fieldset>
              </details>
            )}
            {reviewItems.length > 0 && (
              <div className="review-filters" aria-label="Filtrar takes">
                {(
                  [
                    ["all", "Todos", reviewItems.length],
                    [
                      "high",
                      "Organizados pela IA",
                      reviewItems.filter(aiOrganized).length,
                    ],
                    ["pending", "Precisa revisar", pendingReviews],
                    ["unlocated", "Sem local", unlocatedReviewCount],
                    [
                      "confirmed",
                      "Confirmados",
                      reviewItems.filter(
                        (item) => item.decision?.status === "confirmed",
                      ).length,
                    ],
                  ] as const
                ).map(([value, label, count]) => (
                  <button
                    disabled={busy}
                    key={value}
                    aria-pressed={reviewFilter === value}
                    className={
                      value === "pending" || value === "unlocated"
                        ? "filter-warning"
                        : ""
                    }
                    onClick={() => setReviewFilter(value)}
                  >
                    {label} · {count}
                  </button>
                ))}
                <span>
                  {reviewGroups.size} grupo(s) nesta visualização · originais
                  preservados
                </span>
              </div>
            )}
            {reviewCaptureId && reviewItems.length > 0 ? (
              <div className="review-layout">
                <div className="review-group-list" aria-label="Grupos de takes">
                  {reviewGroups.size === 0 && (
                    <div className="card empty">Nenhum take neste filtro.</div>
                  )}
                  {[...reviewGroups.entries()].map(([key, group]) => {
                    const strengths = group.items.flatMap((item) =>
                      item.suggestion?.confidence == null
                        ? []
                        : [item.suggestion.confidence],
                    );
                    const reasons = [
                      ...new Set(
                        group.items.flatMap((item) =>
                          item.suggestion?.reason
                            ? [item.suggestion.reason]
                            : [],
                        ),
                      ),
                    ];
                    return (
                      <section
                        className={`review-gallery review-group ${group.state === "pending" || group.state === "unidentified" || group.state === "unlocated" ? "unknown-group" : ""}`}
                        key={key}
                      >
                        <div className="review-gallery-heading">
                          <div>
                            <h3>{group.location}</h3>
                            <p className="hint">
                              {group.matter} · {group.items.length} take(s)
                            </p>
                          </div>
                          <span
                            className={`step ${group.state === "pending" || group.state === "unidentified" || group.state === "unlocated" ? "unknown-badge" : ""}`}
                          >
                            {group.state === "ai"
                              ? "Inclui organização por IA"
                              : group.state === "confirmed"
                                ? "Revisado"
                                : group.state === "unidentified"
                                  ? "Sem local confirmado"
                                : group.state === "unlocated"
                                  ? "Sem local sugerido"
                                  : strengths.length
                                    ? `${Math.round(Math.min(...strengths) * 100)}% · força da pista`
                                    : group.state === "suggested"
                                      ? "Local sugerido"
                                      : "Precisa revisar"}
                          </span>
                        </div>
                        <div className="review-take-grid">
                          {group.items.map((item) => {
                            const asset = reviewCapture?.assets.find(
                              (value) => value.asset_id === item.asset_id,
                            );
                            return (
                              <div
                                className="review-take-wrapper"
                                key={item.asset_id}
                              >
                                <label className="take-selection">
                                  <input
                                    type="checkbox"
                                    disabled={
                                      busy ||
                                      captureHasDrafts ||
                                      (!batchIds.includes(item.asset_id) &&
                                        batchIds.length >= 500)
                                    }
                                    checked={batchIds.includes(item.asset_id)}
                                    onChange={(event) =>
                                      setBatchIds((current) =>
                                        event.target.checked
                                          ? [...current, item.asset_id]
                                          : current.filter(
                                              (id) => id !== item.asset_id,
                                            ),
                                      )
                                    }
                                  />
                                  Selecionar para lote
                                </label>
                                <button
                                  type="button"
                                  disabled={busy}
                                  aria-pressed={
                                    selectedAssetId === item.asset_id
                                  }
                                  className={`review-take ${selectedAssetId === item.asset_id ? "selected" : ""}`}
                                  onClick={() =>
                                    setSelectedAssetId(item.asset_id)
                                  }
                                >
                                  <div className="review-take-visual">
                                    {asset && (
                                      <Thumbnail
                                        destination={destination}
                                        workspace={workspace}
                                        captureId={reviewCaptureId}
                                        asset={asset}
                                      />
                                    )}
                                    <span
                                      className="take-state-icon"
                                      aria-hidden="true"
                                    >
                                      {draftCache.current[
                                        draftKey(reviewCaptureId, item.asset_id)
                                      ]
                                        ? "✎"
                                        : item.decision?.status === "confirmed"
                                          ? "✓"
                                          : asset?.metadata?.kind === "video"
                                            ? "▶"
                                            : "▧"}
                                    </span>
                                  </div>
                                  <span>
                                    <strong>{item.original_name}</strong>
                                    <small>
                                      {asset?.metadata?.duration_seconds != null
                                        ? `${asset.metadata.duration_seconds.toFixed(1)} s · `
                                        : ""}
                                      {asset?.metadata?.width &&
                                      asset.metadata.height
                                        ? `${asset.metadata.width}×${asset.metadata.height}`
                                        : item.decision?.status === "confirmed"
                                          ? "Local confirmado"
                                          : item.decision?.status ===
                                              "unidentified"
                                            ? "Local não identificado"
                                            : "Pendente de revisão"}
                                    </small>
                                  </span>
                                </button>
                              </div>
                            );
                          })}
                        </div>
                        <div
                          className={`group-explanation ${group.state === "pending" || group.state === "unidentified" || group.state === "unlocated" ? "unknown-explanation" : ""}`}
                        >
                          <strong>
                            {group.state === "ai"
                              ? "Agrupamento automático"
                              : group.state === "suggested"
                                ? "Por que este grupo?"
                                : group.state === "confirmed"
                                  ? "Organização confirmada por você"
                                  : group.state === "unlocated"
                                    ? "A IA não encontrou o local"
                                    : "Local não identificado"}
                          </strong>
                          {group.state === "ai" ? (
                            <p>
                              Este grupo inclui resultados de IA e preserva as
                              decisões humanas existentes. Confira local e
                              matéria antes de aprovar o conjunto. Local
                              desconhecido permanece sem identificação.
                            </p>
                          ) : group.state === "suggested" ? (
                            <>
                              {reasons.map((reason) => (
                                <p key={reason}>{reason}</p>
                              ))}
                              <p className="hint">
                                A força da pista ainda não é uma confiança
                                calibrada. Confira cada take e salve sua
                                decisão.
                              </p>
                            </>
                          ) : (
                            <p>
                              {group.state === "confirmed"
                                ? "Estes takes compartilham o local e a matéria registrados na revisão. Você pode editar as decisões ao lado."
                                : group.state === "unidentified"
                                  ? "A revisão registrou que o local não foi identificado. Essa decisão permite concluir a organização sem inventar uma localização."
                                  : group.state === "unlocated"
                                    ? "A IA já analisou e agrupou estes takes, mas não encontrou evidência para nomear o local. Filtre “Sem local” e selecione o grupo para confirmar em lote ou marcar como não identificado. Sem evidência, o Lumen não inventa a localização."
                                  : "Estes takes têm uma exceção ou análise ainda pendente. Execute a organização automática ou corrija somente os casos necessários."}
                            </p>
                          )}
                        </div>
                      </section>
                    );
                  })}
                </div>
                {selectedReview && (
                  <div className="review-editor">
                    <div className="review-editor-heading">
                      <div>
                        <span className="step">
                          Take {selectedReviewIndex + 1} de {reviewItems.length}
                        </span>
                        <h3>{selectedReview.original_name}</h3>
                      </div>
                      <div className="review-navigation">
                        <button
                          type="button"
                          className="secondary"
                          disabled={busy || selectedFilteredIndex <= 0}
                          onClick={() =>
                            setSelectedAssetId(
                              filteredReviewItems[selectedFilteredIndex - 1]
                                .asset_id,
                            )
                          }
                        >
                          Anterior
                        </button>
                        <button
                          type="button"
                          className="secondary"
                          disabled={
                            busy ||
                            selectedFilteredIndex < 0 ||
                            selectedFilteredIndex >=
                              filteredReviewItems.length - 1
                          }
                          onClick={() =>
                            setSelectedAssetId(
                              filteredReviewItems[selectedFilteredIndex + 1]
                                .asset_id,
                            )
                          }
                        >
                          Próximo
                        </button>
                      </div>
                    </div>
                    <p className="hint selected-take-meta">
                      {(() => {
                        const asset = reviewCapture?.assets.find(
                          (value) => value.asset_id === selectedReview.asset_id,
                        );
                        return (
                          [
                            asset?.metadata?.duration_seconds != null
                              ? `${asset.metadata.duration_seconds.toFixed(1)} s`
                              : null,
                            asset?.metadata?.width && asset.metadata.height
                              ? `${asset.metadata.width}×${asset.metadata.height}`
                              : null,
                            asset?.metadata?.video_codec,
                            asset?.metadata?.camera,
                            asset?.metadata?.recorded_at,
                          ]
                            .filter(Boolean)
                            .join(" · ") || "Metadados indisponíveis"
                        );
                      })()}
                    </p>
                    <div
                      className="review-preview"
                      aria-label={`Prévia de ${selectedReview.original_name}`}
                    >
                      {preview?.kind === "image" && (
                        <img
                          key={preview.url}
                          src={preview.url}
                          alt={selectedReview.original_name}
                          onError={() =>
                            setPreviewError(
                              "Não foi possível abrir a imagem completa.",
                            )
                          }
                        />
                      )}
                      {preview?.kind === "video" && (
                        <video
                          key={preview.url}
                          src={preview.url}
                          controls
                          preload="metadata"
                          onError={() =>
                            setPreviewError(
                              "Este vídeo não pôde ser reproduzido pelo player do sistema. A cópia verificada continua disponível no caminho abaixo.",
                            )
                          }
                        >
                          Seu sistema não suporta a reprodução deste vídeo.
                        </video>
                      )}
                      {!preview && !previewError && (
                        <p>Carregando prévia da cópia verificada…</p>
                      )}
                      {previewError && <p>{previewError}</p>}
                    </div>
                    {selectedReview.organization && (
                      <section className="review-evidence auto-organization">
                        <strong>
                          {selectedReview.organization.source === "ai"
                            ? "Organização automática"
                            : "Organização revisada"}
                        </strong>
                        <h3>
                          {selectedReview.organization.location ||
                            "Local não identificado"}
                        </h3>
                        <p>
                          <b>Assunto:</b>{" "}
                          {selectedReview.organization.matter ||
                            "Não identificado"}
                        </p>
                        <p>
                          <b>Local:</b>{" "}
                          {selectedReview.organization.location ||
                            "Não identificado — organizado por conteúdo"}
                        </p>
                        <div className="review-tag-chips">
                          {selectedReview.organization.tags.map((tag) => (
                            <span key={tag}>{tag}</span>
                          ))}
                        </div>
                        <p className="hint">
                          {selectedReview.organization.reason}
                        </p>
                      </section>
                    )}
                    <section
                      className="review-evidence ai-result"
                      aria-label="Análise visual do take"
                    >
                      <strong>Qwen3-VL 4B · análise visual</strong>
                      {selectedReview.visual_analysis ? (
                        <>
                          <p>{selectedReview.visual_analysis.description}</p>
                          {selectedReview.visual_analysis.visible_text.length >
                            0 && (
                            <p>
                              <b>Texto visível:</b>{" "}
                              {selectedReview.visual_analysis.visible_text.join(
                                " · ",
                              )}
                            </p>
                          )}
                          <p className="hint">
                            {
                              selectedReview.visual_analysis.frame_times_seconds
                                .length
                            }{" "}
                            quadro(s) ·{" "}
                            {selectedReview.visual_analysis.frame_times_seconds
                              .map((time) => `${time.toFixed(1)} s`)
                              .join(" · ")}{" "}
                            ·{" "}
                            {new Date(
                              selectedReview.visual_analysis.analyzed_at,
                            ).toLocaleString("pt-BR")}
                          </p>
                          <div className="review-tag-chips">
                            {selectedReview.visual_analysis.tags.map((tag) => (
                              <span key={tag}>{tag}</span>
                            ))}
                          </div>
                          {selectedReview.visual_analysis.tags.length > 0 && (
                            <button
                              className="secondary"
                              disabled={busy}
                              onClick={() =>
                                editReview({
                                  tags: [
                                    ...new Set([
                                      ...reviewTagsList,
                                      ...(selectedReview.visual_analysis
                                        ?.tags || []),
                                    ]),
                                  ]
                                    .slice(0, 20)
                                    .join(", "),
                                })
                              }
                            >
                              Preencher tags para conferir
                            </button>
                          )}
                          <p className="hint">
                            A análise cobre as imagens amostradas e pode conter
                            erros. Nada é confirmado automaticamente.
                          </p>
                        </>
                      ) : (
                        <p className="hint">
                          Este take ainda não tem análise visual. As evidências
                          técnicas e a revisão manual continuam disponíveis.
                        </p>
                      )}
                      <button
                        className="secondary ai-take-button"
                        disabled={
                          busy ||
                          !ollamaStatus?.model_ready ||
                          !reviewCapture ||
                          reviewHasChanges
                        }
                        onClick={() => {
                          if (reviewCapture)
                            void runVisualAnalysis(
                              reviewCapture,
                              selectedReview.asset_id,
                              !!selectedReview.visual_analysis,
                            );
                        }}
                      >
                        {selectedReview.visual_analysis
                          ? "Reanalisar este take"
                          : "Analisar este take com IA"}
                      </button>
                      {reviewHasChanges && (
                        <p className="hint">
                          Salve as alterações do take antes de solicitar uma
                          nova análise.
                        </p>
                      )}
                    </section>
                    {selectedReview.suggestion ? (
                      <div
                        className="review-evidence"
                        aria-label="Sugestão para conferência"
                      >
                        <strong>
                          Local sugerido: {selectedReview.suggestion.location}
                        </strong>
                        <p>{selectedReview.suggestion.reason}</p>
                        <p className="hint">
                          Força indicativa da pista:{" "}
                          {selectedReview.suggestion.confidence == null
                            ? "não calculada"
                            : `${Math.round(selectedReview.suggestion.confidence * 100)}%`}
                          . Esse percentual ainda não foi calibrado em captações
                          reais; o editor decide abaixo.
                        </p>
                        {selectedReview.suggestion.location && (
                          <button
                            type="button"
                            disabled={busy}
                            className="secondary"
                            onClick={() =>
                              editReview({
                                status: "confirmed",
                                location:
                                  selectedReview.suggestion?.location || "",
                              })
                            }
                          >
                            Preencher local para conferir
                          </button>
                        )}
                      </div>
                    ) : (
                      <p className="hint">
                        Nenhum local sugerido com segurança para este take. A
                        pauta e os locais visitados, sozinhos, não definem onde
                        ele foi gravado.
                      </p>
                    )}
                    <div className="review-evidence">
                      <strong>Pistas disponíveis</strong>
                      {selectedReview.evidence.length ? (
                        <ul>
                          {selectedReview.evidence.map((item) => (
                            <li key={item.kind}>
                              <span>{item.label}:</span> {item.value}{" "}
                              <small>({item.source})</small>
                            </li>
                          ))}
                        </ul>
                      ) : (
                        <p className="hint">
                          Nenhum metadado útil para esta mídia.
                        </p>
                      )}
                      <p className="hint">
                        Coordenadas GPS ajudam a verificar o take, mas ainda não
                        são convertidas automaticamente em nome de praia, loja
                        ou bairro. As descrições visuais da IA são pistas
                        adicionais e precisam de conferência.
                      </p>
                    </div>
                    {(() => {
                      const asset = reviewCapture?.assets.find(
                        (value) => value.asset_id === selectedReview.asset_id,
                      );
                      return asset && reviewCapture ? (
                        <p className="hint">
                          Cópia verificada:{" "}
                          <code className="copy-path">
                            {readableLocalPath(
                              reviewCapture.manifest_path.replace(
                                /[\\/][^\\/]+$/,
                                "",
                              ) +
                                "\\" +
                                asset.copy_relative_path,
                            )}
                          </code>
                        </p>
                      ) : null;
                    })()}
                    <details
                      className="optional-correction"
                      open={
                        reviewHasChanges ||
                        selectedReview.organization?.requires_review
                      }
                    >
                      <summary>Corrigir organização deste take</summary>
                      <fieldset className="review-fields" disabled={busy}>
                        <label>
                          Categoria (opcional)
                          <input
                            value={reviewCategory}
                            maxLength={100}
                            onChange={(event) =>
                              editReview({ category: event.target.value })
                            }
                            placeholder="Categoria do conteúdo"
                          />
                        </label>
                        <fieldset className="decision-options">
                          <legend>Decisão sobre o local</legend>
                          <button
                            type="button"
                            aria-pressed={reviewStatus === "confirmed"}
                            onClick={() => editReview({ status: "confirmed" })}
                          >
                            Confirmar local
                          </button>
                          <button
                            type="button"
                            aria-pressed={reviewStatus === "unidentified"}
                            onClick={() =>
                              editReview({ status: "unidentified" })
                            }
                          >
                            Local não identificado
                          </button>
                          <button
                            type="button"
                            aria-pressed={reviewStatus === "pending"}
                            onClick={() => editReview({ status: "pending" })}
                          >
                            Manter pendente
                          </button>
                        </fieldset>
                        {reviewStatus === "pending" && (
                          <p className="hint">
                            Matéria e tags podem ser salvas agora, mas este take
                            continuará pendente até você confirmar um local ou
                            marcar “Local não identificado”.
                          </p>
                        )}
                        {reviewStatus === "confirmed" && (
                          <label>
                            Local confirmado
                            <input
                              list="review-location-options"
                              value={reviewLocation}
                              maxLength={120}
                              onChange={(event) =>
                                editReview({ location: event.target.value })
                              }
                              placeholder="Ex.: Praia do Morro"
                            />
                          </label>
                        )}
                        <datalist id="review-location-options">
                          {[
                            ...new Set([
                              ...(reviewCapture?.visited_locations || []),
                              ...reviewItems.flatMap((item) =>
                                [
                                  item.decision?.location,
                                  item.suggestion?.location,
                                ].filter((value): value is string => !!value),
                              ),
                            ]),
                          ].map((location) => (
                            <option key={location} value={location} />
                          ))}
                        </datalist>
                        <label>
                          Matéria / retranca deste take
                          <input
                            value={reviewMatter}
                            maxLength={120}
                            onChange={(event) =>
                              editReview({ matter: event.target.value })
                            }
                            placeholder="Ex.: Movimento nas praias"
                          />
                        </label>
                        <label>
                          Tags (separadas por vírgula)
                          <input
                            value={reviewTags}
                            onChange={(event) =>
                              editReview({ tags: event.target.value })
                            }
                            placeholder="Ex.: pessoas, praia, comércio"
                          />
                        </label>
                        <label>
                          Observação da revisão
                          <textarea
                            value={reviewNote}
                            maxLength={1000}
                            onChange={(event) =>
                              editReview({ note: event.target.value })
                            }
                            rows={3}
                            placeholder="Como você confirmou ou por que o local ficou incerto?"
                          />
                        </label>
                      </fieldset>
                    </details>
                    {!!draftCache.current[draftKey()] && (
                      <p className="hint" role="status">
                        Rascunho preservado ao trocar de take.{" "}
                        <button
                          className="secondary"
                          disabled={busy}
                          onClick={discardDraft}
                        >
                          Descartar rascunho
                        </button>
                      </p>
                    )}
                    {reviewTagsList.length > 0 && (
                      <div
                        className="review-tag-chips"
                        aria-label="Tags deste take"
                      >
                        {reviewTagsList.map((tag, index) => (
                          <span key={`${tag}-${index}`}>{tag}</span>
                        ))}
                      </div>
                    )}
                    <button
                      className="primary"
                      type="button"
                      disabled={
                        busy ||
                        (!reviewHasChanges &&
                          !selectedReview.organization?.requires_review &&
                          !draftCache.current[draftKey()]) ||
                        (reviewStatus === "confirmed" && !reviewLocation.trim())
                      }
                      onClick={() =>
                        void saveReview(
                          !!selectedReview.organization?.requires_review &&
                            !reviewHasChanges,
                        )
                      }
                    >
                      {busy
                        ? "Salvando…"
                        : reviewHasChanges || draftCache.current[draftKey()]
                          ? "Salvar revisão deste take"
                          : selectedReview.organization?.requires_review
                            ? "Validar esta exceção"
                            : "Organização pronta para aprovação"}
                    </button>
                    <div className="review-history">
                      <strong>Histórico local</strong>
                      {selectedReview.history.length > 0 && (
                        <button
                          className="secondary"
                          disabled={busy || reviewHasChanges}
                          onClick={() => void restorePreviousReview()}
                        >
                          {selectedReview.history.length === 1
                            ? "Desfazer primeira revisão"
                            : "Restaurar revisão anterior"}
                        </button>
                      )}
                      {selectedReview.history.length ? (
                        <ul>
                          {[...selectedReview.history]
                            .reverse()
                            .map((event) => (
                              <li key={event.event_id}>
                                {new Date(event.reviewed_at).toLocaleString(
                                  "pt-BR",
                                )}{" "}
                                ·{" "}
                                {event.status === "confirmed"
                                  ? `Local confirmado: ${event.location}`
                                  : event.status === "unidentified"
                                    ? "Local não identificado"
                                    : "Pendente"}
                                {event.note ? ` · ${event.note}` : ""}
                                {event.author
                                  ? ` · ${event.author}`
                                  : " · Operador não registrado"}
                              </li>
                            ))}
                        </ul>
                      ) : (
                        <p className="hint">
                          Ainda não há decisões salvas para este take.
                        </p>
                      )}
                    </div>
                  </div>
                )}
              </div>
            ) : (
              <p className="empty">
                {reviewCaptureId
                  ? "Esta captação não tem mídia verificada para revisar."
                  : "Selecione uma captação. Se a lista estiver vazia, informe o acervo acima e clique em Atualizar."}
              </p>
            )}
            {organizationApproval && (
              <section
                className="card export-panel"
                aria-label="Criar pastas organizadas"
                aria-busy={exportPlanning || exportRunning}
              >
                <h2>Criar pastas com a organização aprovada</h2>
                <p>
                  O Lumen copia os arquivos por local e matéria. Locais incertos
                  ficam em “Local não identificado”. Os originais e a revisão
                  são preservados. Confira se o destino tem espaço livre para
                  receber as cópias.
                </p>
                {exportPlanning && (
                  <p role="status">Preparando a prévia das pastas…</p>
                )}
                {exportPlan && (
                  <>
                    <label>
                      Pasta de saída
                      <input
                        readOnly
                        value={readableLocalPath(exportPlan.output_directory)}
                      />
                    </label>
                    <p className="hint">
                      {exportPlan.files.length} arquivo(s) · até{" "}
                      {formatBytes(exportPlan.total_bytes)} adicionais.
                      Identificadores nos nomes evitam colisões. Arquivos
                      auxiliares ficam em uma pasta separada.
                    </p>
                    <details>
                      <summary>Ver a estrutura antes de copiar</summary>
                      <ul>
                        {exportPlan.files.map((file) => (
                          <li key={file.asset_id}>
                            <strong>{file.original_name}</strong>
                            <span>{file.relative_path}</span>
                          </li>
                        ))}
                      </ul>
                    </details>
                    {exportRunning && exportProgress && (
                      <div role="status">
                        <p>
                          Copiando e verificando {exportProgress.done}/
                          {exportProgress.total}: {exportProgress.current}
                        </p>
                        <progress
                          max={exportProgress.total || 1}
                          value={exportProgress.done}
                        />
                      </div>
                    )}
                    <button
                      className="primary"
                      disabled={
                        busy ||
                        captureHasDrafts ||
                        exportPlan.approval_id !==
                          organizationApproval.approval_id
                      }
                      onClick={() => void exportOrganizedFiles()}
                    >
                      {exportRunning
                        ? "Copiando e verificando…"
                        : exportResult?.errors.length
                          ? "Retomar cópias pendentes"
                          : exportResult
                            ? "Conferir arquivos exportados"
                          : "Criar pastas e copiar arquivos"}
                    </button>
                  </>
                )}
                {reviewHasChanges && (
                  <p className="hint">
                    Salve a correção e aprove novamente antes de criar as
                    pastas.
                  </p>
                )}
                {exportError && (
                  <p role="alert" className="approval-error">
                    {exportError}
                  </p>
                )}
                {exportResult && (
                  <div role="status">
                    <h3>
                      {exportResult.errors.length
                        ? "Exportação parcial"
                        : "Pastas organizadas"}
                    </h3>
                    <p>
                      {exportResult.copied} copiado(s) · {exportResult.reused}{" "}
                      já verificado(s) · {exportResult.errors.length} falha(s).
                    </p>
                    <p className="hint">
                      Relatório: {readableLocalPath(exportResult.report_path)}
                    </p>
                    {!exportResult.approval_current && (
                      <p>
                        A revisão mudou durante a cópia. Estas pastas
                        correspondem à aprovação anterior; aprove novamente para
                        gerar a versão atualizada.
                      </p>
                    )}
                    {exportResult.errors.length > 0 && (
                      <ul>
                        {exportResult.errors.map((error, index) => (
                          <li key={index}>{error}</li>
                        ))}
                      </ul>
                    )}
                  </div>
                )}
              </section>
            )}
            {reviewItems.length > 0 && (
              <section className="action-banner approval-banner">
                <span aria-hidden="true">✓</span>
                <div>
                  <h2>
                    {organizationApproval
                      ? "Organização aprovada"
                      : "Organização pronta para sua conferência"}
                  </h2>
                  <p>
                    {organizationApproval
                      ? `Aprovação registrada em ${new Date(organizationApproval.approved_at).toLocaleString("pt-BR")}. Alterar uma decisão exigirá uma nova aprovação.`
                      : captureHasDrafts
                        ? "Salve ou descarte os rascunhos antes de aprovar."
                        : pendingReviews
                          ? `${pendingReviews} take(s) precisam de atenção: falta análise ou há uma exceção.`
                          : "Confira os locais e matérias. A aprovação mantém a distinção entre sugestões de IA e decisões humanas."}
                  </p>
                  <p>
                    Os originais não são movidos. As decisões e o histórico
                    continuam disponíveis para edição.
                  </p>
                  {approvalError && (
                    <p className="approval-error" role="alert">
                      {approvalError}
                    </p>
                  )}
                </div>
                {organizationApproval && (
                  <button
                    className="secondary"
                    disabled={busy}
                    onClick={() => void revokeApproval()}
                  >
                    Desfazer aprovação
                  </button>
                )}
              </section>
            )}
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
