// Shared catalog contracts and pure rules used by the desktop and regression tests.
export type VisualAnalysis = {
  model: string;
  analyzed_at: string;
  description: string;
  category: string;
  matter: string;
  needs_review: boolean;
  review_reason: string;
  visible_text: string[];
  tags: string[];
  location: string | null;
  location_reason: string;
  frame_times_seconds: number[];
};
export type OrganizationProposal = {
  event_id: string;
  category: string;
  matter: string;
  tags: string[];
  location: string | null;
  source: "ai" | "human";
  requires_review: boolean;
  reason: string;
};
export type Asset = {
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
    camera?: string;
  };
  thumbnail_relative_path?: string;
  processing_error?: string;
};
export type Manifest = {
  capture_id: string;
  workspace_id: string;
  capture_name: string;
  brief: string;
  team?: string;
  visited_locations: string[];
  created_at: string;
  verified_count: number;
  failed_count: number;
  assets: Asset[];
  manifest_path: string;
  pending_count?: number;
  source_path?: string;
  load_warnings?: string[];
};
export type ReviewEvent = {
  event_id: string;
  status: "confirmed" | "unidentified" | "pending";
  location: string | null;
  matter: string;
  tags: string[];
  note: string;
  reviewed_at: string;
  category?: string;
  author?: string;
};
export type ReviewItem = {
  asset_id: string;
  original_name: string;
  evidence: { kind: string; label: string; value: string; source: string }[];
  suggestion: {
    location: string | null;
    matter: string | null;
    tags: string[];
    confidence: number | null;
    reason: string;
  } | null;
  decision: ReviewEvent | null;
  history: ReviewEvent[];
  visual_analysis?: VisualAnalysis | null;
  organization?: OrganizationProposal | null;
};
export type ReviewSearchEntry = {
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
export type ReviewDraft = {
  status: ReviewEvent["status"];
  location: string;
  matter: string;
  category: string;
  tags: string;
  note: string;
};
export type ReviewFilter = "all" | "pending" | "confirmed" | "high" | "unlocated";
export type ReviewGroup = {
  location: string;
  matter: string;
  state:
    | "pending"
    | "suggested"
    | "ai"
    | "confirmed"
    | "unidentified"
    | "unlocated";
  items: ReviewItem[];
};

const normalized = (value: string) =>
  value
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLocaleLowerCase("pt-BR");
const dateText = (value?: string) =>
  value && Number.isFinite(new Date(value).getTime())
    ? [value, new Date(value).toLocaleDateString("pt-BR")].join(" ")
    : value || "";

export type CatalogStatusFilter = "all" | "pending" | "catalogued";
export type CatalogSearchFilters = {
  location: string;
  matter: string;
  date: string;
  tag: string;
  status: CatalogStatusFilter;
};
export type CatalogSearchInput = {
  text: string;
  filters: CatalogSearchFilters;
  mediaOnly?: boolean;
};
export type CatalogAssetMatch = {
  asset: Asset;
  review: ReviewSearchEntry | null;
  location: string;
  matter: string;
  tags: string[];
  status: "pending" | "catalogued";
  excerpt: string;
};
export type CatalogSearchGroup = {
  capture: Manifest;
  results: CatalogAssetMatch[];
};

const emptyCatalogFilters: CatalogSearchFilters = {
  location: "",
  matter: "",
  date: "",
  tag: "",
  status: "all",
};
const mediaExtensions = new Set([
  "3g2", "3gp", "arw", "avi", "bmp", "cr2", "cr3", "dng", "gif",
  "heic", "jpeg", "jpg", "m2t", "m2ts", "m4v", "mkv", "mov", "mp4",
  "mpeg", "mpg", "nef", "orf", "png", "raf", "raw", "rw2", "tif",
  "tiff", "webp", "wmv",
]);
const mediaFile = (asset: Asset) => {
  const extension = asset.original_name.split(".").pop()?.toLocaleLowerCase("en-US");
  return asset.status === "verified" && !!extension && mediaExtensions.has(extension);
};
const dateInputValue = (value?: string) => {
  if (!value) return "";
  const direct = value.match(/^\d{4}-\d{2}-\d{2}/)?.[0];
  if (direct && value.length === 10) return direct;
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) return "";
  const year = parsed.getFullYear();
  const month = String(parsed.getMonth() + 1).padStart(2, "0");
  const day = String(parsed.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
};
const queryTokens = (text: string) => normalized(text.trim()).split(/\s+/).filter(Boolean);
const includesEveryToken = (value: string, tokens: string[]) => {
  const haystack = normalized(value);
  return tokens.every((token) => haystack.includes(token));
};
const shortValue = (value: string, limit = 110) =>
  value.length > limit ? `${value.slice(0, limit - 1).trimEnd()}…` : value;

export function searchCatalog(
  captures: Manifest[],
  reviewIndex: ReviewSearchEntry[],
  input: CatalogSearchInput,
): CatalogSearchGroup[] {
  const tokens = queryTokens(input.text);
  const filters = input.filters;
  const index = new Map(
    reviewIndex.map((item) => [
      `${item.capture_id}\u0000${item.asset_id}`,
      item,
    ]),
  );
  return captures.flatMap((capture) => {
    const captureFields = [
      { label: "Captação", value: capture.capture_name },
      { label: "Pauta", value: capture.brief },
      { label: "Equipe", value: capture.team || "" },
      { label: "Local informado", value: capture.visited_locations.join(" · ") },
      { label: "Data da captação", value: dateText(capture.created_at) },
    ];
    const captureText = captureFields.map((field) => field.value).join(" ");
    const captureMatches = !tokens.length || includesEveryToken(captureText, tokens);
    const results = capture.assets.flatMap((asset) => {
      if (input.mediaOnly && !mediaFile(asset)) return [];
      const review = index.get(`${capture.capture_id}\u0000${asset.asset_id}`) || null;
      const status: CatalogAssetMatch["status"] =
        review?.status === "pending" || !review ? "pending" : "catalogued";
      const location =
        review?.location ||
        (review?.status === "unidentified" ? "Local não identificado" : "");
      const matter = review?.matter || "";
      const tags = [...new Set([...(review?.tags || []), ...(review?.visual_tags || [])])];
      const assetFields = [
        { label: "Arquivo", value: asset.original_name },
        { label: "Caminho do arquivo", value: asset.original_relative_path },
        { label: "Tipo de mídia", value: asset.metadata?.kind || "" },
        { label: "Data do arquivo", value: dateText(asset.metadata?.recorded_at) },
        { label: "Local", value: location },
        { label: "Matéria", value: matter },
        { label: "Tags", value: tags.join(" · ") },
        { label: "Descrição visual", value: review?.visual_description || "" },
        { label: "Texto visível", value: review?.visible_text?.join(" · ") || "" },
      ];
      const assetText = assetFields.map((field) => field.value).join(" ");
      const assetMatches =
        !tokens.length || includesEveryToken(`${captureText} ${assetText}`, tokens);
      if (tokens.length && !captureMatches && !assetMatches) return [];
      if (filters.location && normalized(location) !== normalized(filters.location)) return [];
      if (filters.matter && normalized(matter) !== normalized(filters.matter)) return [];
      if (filters.tag && !tags.some((tag) => normalized(tag) === normalized(filters.tag))) return [];
      if (filters.status !== "all" && status !== filters.status) return [];
      if (
        filters.date &&
        dateInputValue(capture.created_at) !== filters.date &&
        dateInputValue(asset.metadata?.recorded_at) !== filters.date
      ) return [];

      const matchedFields = (captureMatches ? captureFields : [...captureFields, ...assetFields]).filter(
        (field) => tokens.some((token) => normalized(field.value).includes(token)),
      );
      const excerpt = tokens.length
        ? matchedFields.slice(0, 2).map((field) => `${field.label}: ${shortValue(field.value)}`).join(" · ")
        : [
            filters.location && `Local: ${filters.location}`,
            filters.matter && `Matéria: ${filters.matter}`,
            filters.date && `Data: ${new Date(`${filters.date}T12:00:00`).toLocaleDateString("pt-BR")}`,
            filters.tag && `Tag: ${filters.tag}`,
            filters.status === "pending" && "Status: pendente de revisão",
            filters.status === "catalogued" && "Status: catalogada",
          ].filter(Boolean).join(" · ");
      return [{ asset, review, location, matter, tags, status, excerpt }];
    });
    return results.length ? [{ capture, results }] : [];
  });
}

export function searchCaptures(
  captures: Manifest[],
  reviewIndex: ReviewSearchEntry[],
  text: string,
) {
  return searchCatalog(captures, reviewIndex, {
    text,
    filters: emptyCatalogFilters,
  }).map(({ capture, results }) => ({
    capture,
    assets: results.map(({ asset }) => asset),
  }));
}

export const aiOrganized = (item: ReviewItem) =>
  item.organization?.source === "ai" && !item.organization.requires_review;

export function filterReviewItems(items: ReviewItem[], filter: ReviewFilter) {
  return items.filter(
    (item) => {
      const location =
        item.decision?.location ??
        item.organization?.location ??
        item.suggestion?.location;
      return (
        filter === "all" ||
        (filter === "high"
          ? aiOrganized(item)
          : filter === "pending"
            ? item.decision?.status !== "unidentified" &&
              (!item.organization ||
                item.organization.requires_review ||
                !location)
            : filter === "unlocated"
              ? !location
              : item.decision?.status === "confirmed")
      );
    },
  );
}

export function groupReviewItems(items: ReviewItem[], captureName: string) {
  const groups = new Map<string, ReviewGroup>();
  for (const item of items) {
    const organization = item.organization;
    const effectiveLocation =
      item.decision?.location ??
      item.suggestion?.location ??
      organization?.location;
    const state: ReviewGroup["state"] =
      item.decision?.status === "unidentified"
        ? "unidentified"
        : item.decision?.status === "confirmed"
          ? "confirmed"
          : !effectiveLocation
              ? organization
                ? "unlocated"
                : "pending"
              : organization?.requires_review
                ? "pending"
                : item.suggestion?.location
                  ? "suggested"
                  : organization
                    ? "ai"
                    : "pending";
    const location =
      item.decision?.status === "unidentified"
        ? "Local não identificado"
        : effectiveLocation || "Local não sugerido";
    const matter = organization
      ? organization.matter || "Sem matéria identificada"
      : item.suggestion?.matter || captureName || "Sem matéria identificada";
    const key = JSON.stringify([
      location.toLocaleLowerCase("pt-BR"),
      matter.toLocaleLowerCase("pt-BR"),
    ]);
    const group = groups.get(key) || { location, matter, state, items: [] };
    const priority = {
      pending: 6,
      suggested: 5,
      ai: 4,
      unlocated: 3,
      unidentified: 2,
      confirmed: 1,
    };
    if (priority[state] > priority[group.state]) group.state = state;
    group.items.push(item);
    groups.set(key, group);
  }
  return groups;
}

export function reviewBaseline(item?: ReviewItem): ReviewDraft {
  const decision = item?.decision;
  const organization = item?.organization;
  return {
    status: decision?.status || "pending",
    location: decision?.location ?? organization?.location ?? "",
    matter: decision?.matter ?? organization?.matter ?? "",
    category: decision?.category ?? organization?.category ?? "",
    tags: (decision?.tags || organization?.tags || []).join(", "),
    note: decision?.note || "",
  };
}

export function reviewDraftChanged(
  item: ReviewItem | undefined,
  draft: ReviewDraft,
) {
  if (!item) return false;
  const baseline = reviewBaseline(item);
  const tags = (value: string) =>
    value
      .split(/[,\n]/)
      .map((tag) => tag.trim())
      .filter(Boolean);
  return (
    baseline.status !== draft.status ||
    baseline.category !== draft.category.trim() ||
    baseline.matter !== draft.matter.trim() ||
    baseline.note !== draft.note.trim() ||
    (draft.status === "confirmed" &&
      baseline.location !== draft.location.trim()) ||
    JSON.stringify(tags(baseline.tags)) !== JSON.stringify(tags(draft.tags))
  );
}
