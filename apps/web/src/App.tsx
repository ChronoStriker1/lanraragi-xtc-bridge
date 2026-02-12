import { useEffect, useMemo, useRef, useState } from "react";
import {
  archivePageUrl,
  conversionFrameUrl,
  createDeviceFolder,
  downloadConversionJob,
  fetchArchives,
  fetchConversionJob,
  fetchDeviceDefaults,
  fetchDeviceFiles,
  fetchDefaults,
  fetchFacets,
  fetchLanraragiSettings,
  fetchTagSuggestions,
  startConversionJob,
  thumbnailUrl,
  updateLanraragiSettings,
  updateDeviceDefaults,
  uploadConversionJob,
} from "./lib/api";
import type { ArchiveRecord, ConversionJob, ConversionSettings, DeviceFileEntry } from "./types";

const SORT_OPTIONS = [
  { label: "Title", value: "title" },
  { label: "Date", value: "date_added" },
  { label: "Progress", value: "progress" },
  { label: "Last Read", value: "lastreadtime" },
  { label: "File Size", value: "size" },
  { label: "Read Time", value: "time_read" },
] as const;

const SETTINGS_STORAGE_KEY = "xtc_conversion_settings_v1";
const SORT_STORAGE_KEY = "xtc_sort_options_v1";
const DEVICE_STORAGE_KEY = "xtc_device_settings_v1";
const PANEL_STORAGE_KEY = "xtc_settings_panel_collapsed_v1";
const SERVICE_PANEL_STORAGE_KEY = "xtc_service_panel_collapsed_v1";
const DEVICE_PANEL_STORAGE_KEY = "xtc_device_panel_collapsed_v1";
const PUBLIC_BASE_URL_STORAGE_KEY = "xtc_public_base_url_v1";
const THEME_STORAGE_KEY = "xtc_theme_mode_v1";
const FACET_PREFIXES = ["ALL", "0-9", ..."ABCDEFGHIJKLMNOPQRSTUVWXYZ"] as const;
const BATCH_MAX_PARALLEL = 4;

type ViewMode = "library" | "artists" | "groups";
type FacetNamespace = "artist" | "group";
type ThemeMode = "system" | "light" | "dark";

type FacetSelection = {
  namespace: FacetNamespace;
  name: string;
};

type UploadProgressState = {
  phase: "idle" | "queued" | "uploading" | "completed" | "failed";
  progress: number;
  message: string;
};

function buildEffectiveSettings(
  settings: ConversionSettings,
  defaults: ConversionSettings,
  showAdvanced: boolean,
): ConversionSettings {
  if (showAdvanced) return settings;
  return {
    ...defaults,
    orientation: settings.orientation,
    splitMode: settings.splitMode,
    noDither: settings.noDither,
    contrastBoost: settings.contrastBoost,
    margin: settings.margin,
  };
}

function loadStoredSettings(): Partial<ConversionSettings> | null {
  const raw = localStorage.getItem(SETTINGS_STORAGE_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<ConversionSettings>;
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function formatSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let i = 0;
  let value = bytes;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i += 1;
  }
  return `${value.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

function formatElapsed(totalSeconds: number): string {
  const safe = Number.isFinite(totalSeconds) && totalSeconds > 0 ? Math.floor(totalSeconds) : 0;
  const minutes = Math.floor(safe / 60);
  const seconds = safe % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function pageFromFrameLabel(frameLabel: string | null): number | null {
  if (!frameLabel) return null;
  const base = frameLabel.replace(/\.[^.]+$/, "");
  const match = base.match(/\d+/);
  if (!match) return null;
  const value = Number(match[0]);
  return Number.isFinite(value) && value > 0 ? value : null;
}

function formatJobPageFrameLine(job: ConversionJob): string | null {
  const totalPages = job.totalPages;
  if (totalPages <= 0) {
    return job.convertedFrameVersion > 0 ? `Page ?/? • Frames ${job.convertedFrameVersion}` : null;
  }

  const parsedFramePage = pageFromFrameLabel(job.currentConvertedFrameLabel);
  const workingPage =
    parsedFramePage && parsedFramePage <= totalPages
      ? parsedFramePage
      : job.status === "completed"
        ? totalPages
        : Math.max(1, Math.min(totalPages, job.completedPages || 1));

  if (job.stage === "cbz2xtc" || job.convertedFrameVersion > 0) {
    return `Page ${workingPage}/${totalPages} • Frames ${job.convertedFrameVersion}`;
  }

  return `Pages ${job.completedPages}/${totalPages}`;
}

function cleanFileNamePart(input: string): string {
  return input
    .replace(/[<>:"/\\|?*\u0000-\u001f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function setNumberOrNull<T extends keyof ConversionSettings>(
  current: ConversionSettings,
  key: T,
  value: string,
): ConversionSettings {
  const parsed = value.trim() === "" ? null : Number(value);
  return {
    ...current,
    [key]: parsed !== null && Number.isFinite(parsed) ? parsed : null,
  };
}

function parseTags(raw: string): string[] {
  return raw
    .split(",")
    .map((tag) => tag.trim())
    .filter((tag) => tag.length > 0);
}

function normalizeCommaTerms(raw: string): string {
  return raw
    .split(",")
    .map((term) => term.trim())
    .filter((term) => term.length > 0)
    .join(",");
}

function extractLastCommaTerm(raw: string): string {
  const parts = raw.split(",");
  return (parts[parts.length - 1] || "").trim();
}

function applyTagAutocomplete(raw: string, suggestion: string): string {
  const parts = raw.split(",");
  if (parts.length === 0) return suggestion;
  parts[parts.length - 1] = ` ${suggestion}`;
  const rebuilt = parts.join(",");
  return rebuilt.startsWith(" ") ? rebuilt.slice(1) : rebuilt;
}

function formatUnixTag(tag: string): string {
  const splitIndex = tag.indexOf(":");
  if (splitIndex <= 0) return tag;
  const namespace = tag.slice(0, splitIndex).trim();
  const value = tag.slice(splitIndex + 1).trim();
  if (!/(date|time|timestamp|added|created|updated|modified|read)/i.test(namespace)) {
    return tag;
  }
  if (!/^\d{10,13}$/.test(value)) return tag;

  const num = Number(value);
  if (!Number.isFinite(num)) return tag;
  const ms = value.length === 13 ? num : num * 1000;
  if (ms < Date.UTC(1990, 0, 1) || ms > Date.UTC(2200, 0, 1)) return tag;
  const formatted = new Date(ms).toLocaleString();
  return `${namespace}:${formatted}`;
}

function buildDownloadName(archive: ArchiveRecord): string {
  const title = cleanFileNamePart(archive.title || archive.filename || archive.arcid) || "archive";
  const tags = parseTags(archive.tags || "");
  const group = cleanFileNamePart(namespaceValues(tags, "group")[0] || "");
  const artist = cleanFileNamePart(namespaceValues(tags, "artist")[0] || "");

  let prefix = "";
  if (group && artist) {
    prefix = `[${group} (${artist})] `;
  } else if (group) {
    prefix = `[${group}] `;
  } else if (artist) {
    prefix = `(${artist}) `;
  }

  return `${prefix}${title}.xtc`.slice(0, 220);
}

function namespaceValues(tags: string[], namespace: string): string[] {
  const prefix = `${namespace.toLowerCase()}:`;
  return tags
    .filter((tag) => tag.toLowerCase().startsWith(prefix))
    .map((tag) => tag.slice(prefix.length).trim())
    .filter((tag) => tag.length > 0);
}

function buildArchiveFilter(baseFilter: string, facet: FacetSelection | null): string {
  const trimmed = baseFilter.trim();
  if (!facet) return trimmed;
  const facetFilter = `${facet.namespace}:${facet.name}`;
  return trimmed ? `${facetFilter},${trimmed}` : facetFilter;
}

function loadStoredSort(): { sortby: string; order: "asc" | "desc" } {
  const fallback = { sortby: "title", order: "asc" as const };
  if (typeof window === "undefined") return fallback;

  const raw = window.localStorage.getItem(SORT_STORAGE_KEY);
  if (!raw) return fallback;

  try {
    const parsed = JSON.parse(raw) as { sortby?: string; order?: "asc" | "desc" };
    const validSort = SORT_OPTIONS.some((option) => option.value === parsed.sortby) ? parsed.sortby! : fallback.sortby;
    const validOrder = parsed.order === "asc" || parsed.order === "desc" ? parsed.order : fallback.order;
    return {
      sortby: validSort,
      order: validOrder,
    };
  } catch {
    return fallback;
  }
}

function loadStoredPublicBaseUrl(): string {
  if (typeof window === "undefined") return "";
  return window.localStorage.getItem(PUBLIC_BASE_URL_STORAGE_KEY) || "";
}

function loadServicePanelCollapsed(): boolean {
  if (typeof window === "undefined") return false;
  return window.localStorage.getItem(SERVICE_PANEL_STORAGE_KEY) === "true";
}

function loadDevicePanelCollapsed(): boolean {
  if (typeof window === "undefined") return false;
  return window.localStorage.getItem(DEVICE_PANEL_STORAGE_KEY) === "true";
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function loadStoredThemeMode(): ThemeMode {
  if (typeof window === "undefined") return "system";
  const raw = window.localStorage.getItem(THEME_STORAGE_KEY);
  return raw === "light" || raw === "dark" || raw === "system" ? raw : "system";
}

function isRetryablePollError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const message = error.message || "";
  return (
    message.includes("(500)") ||
    message.includes("(502)") ||
    message.includes("(503)") ||
    message.includes("(504)") ||
    message.includes("Failed to fetch")
  );
}

function normalizeDeviceBaseUrlInput(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) {
    throw new Error("Device address is required.");
  }
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
  const parsed = new URL(withScheme);
  return `${parsed.protocol}//${parsed.host}`;
}

function normalizeLanraragiBaseUrlInput(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) {
    throw new Error("LANraragi address is required.");
  }
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
  const parsed = new URL(withScheme);
  return `${parsed.protocol}//${parsed.host}`;
}

function normalizePublicBaseUrlInput(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) return "";
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
  const parsed = new URL(withScheme);
  return `${parsed.protocol}//${parsed.host}`;
}

function normalizeDevicePath(input: string): string {
  const trimmed = input.trim();
  if (!trimmed || trimmed === ".") return "/";
  const withRoot = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  return withRoot.replace(/\/+/g, "/");
}

function joinDevicePath(parentPath: string, segment: string): string {
  const parent = normalizeDevicePath(parentPath);
  const clean = segment.trim().replace(/^\/+|\/+$/g, "");
  if (!clean) return parent;
  return normalizeDevicePath(`${parent === "/" ? "" : parent}/${clean}`);
}

function matchesFacetPrefix(value: string, prefix: (typeof FACET_PREFIXES)[number]): boolean {
  const trimmed = value.trim();
  if (!trimmed) return false;
  if (prefix === "ALL") return true;
  if (prefix === "0-9") return /^[0-9]/i.test(trimmed);
  return trimmed[0].toUpperCase() === prefix;
}

export default function App() {
  const initialSortRef = useRef(loadStoredSort());
  const uploadTickerRef = useRef<Record<string, number>>({});
  const singleUploadTickerRef = useRef<number | null>(null);
  const [settings, setSettings] = useState<ConversionSettings | null>(null);
  const [themeMode, setThemeMode] = useState<ThemeMode>(() => loadStoredThemeMode());
  const [defaultSettings, setDefaultSettings] = useState<ConversionSettings | null>(null);
  const [archives, setArchives] = useState<ArchiveRecord[]>([]);
  const [total, setTotal] = useState(0);
  const [filter, setFilter] = useState("");
  const [normalizedFilter, setNormalizedFilter] = useState("");
  const [start, setStart] = useState(0);
  const [sortby, setSortby] = useState(initialSortRef.current.sortby);
  const [order, setOrder] = useState<"asc" | "desc">(initialSortRef.current.order);
  const [loading, setLoading] = useState(false);
  const [loadingSettings, setLoadingSettings] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [convertingId, setConvertingId] = useState<string | null>(null);
  const [lastConversion, setLastConversion] = useState<{
    id: string;
    title: string;
    size: number;
    action: "downloaded" | "uploaded";
    target?: string;
  } | null>(null);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [cropThumbs, setCropThumbs] = useState(false);
  const [conversionJob, setConversionJob] = useState<ConversionJob | null>(null);
  const [selectedArchives, setSelectedArchives] = useState<Record<string, ArchiveRecord>>({});
  const [batchState, setBatchState] = useState<{
    total: number;
    completed: number;
    failed: number;
    active: number;
    currentTitle: string;
  } | null>(null);
  const [batchJobs, setBatchJobs] = useState<Record<string, ConversionJob>>({});
  const [batchArchiveTitles, setBatchArchiveTitles] = useState<Record<string, string>>({});
  const [batchArchiveOrder, setBatchArchiveOrder] = useState<string[]>([]);
  const [batchUploads, setBatchUploads] = useState<Record<string, UploadProgressState>>({});
  const [singleUpload, setSingleUpload] = useState<UploadProgressState | null>(null);
  const [tagSuggestions, setTagSuggestions] = useState<string[]>([]);
  const [tagSuggestLoading, setTagSuggestLoading] = useState(false);
  const [settingsPanelCollapsed, setSettingsPanelCollapsed] = useState(() => {
    if (typeof window === "undefined") return false;
    return window.localStorage.getItem(PANEL_STORAGE_KEY) === "true";
  });

  const [lanraragiBaseUrl, setLanraragiBaseUrl] = useState("");
  const [lanraragiApiKey, setLanraragiApiKey] = useState("");
  const [lanraragiHasApiKey, setLanraragiHasApiKey] = useState(false);
  const [lanraragiLoading, setLanraragiLoading] = useState(false);
  const [lanraragiSaving, setLanraragiSaving] = useState(false);
  const [lanraragiError, setLanraragiError] = useState<string | null>(null);
  const [lanraragiNotice, setLanraragiNotice] = useState<string | null>(null);
  const [lanraragiReloadToken, setLanraragiReloadToken] = useState(0);
  const [servicePanelCollapsed, setServicePanelCollapsed] = useState(() => loadServicePanelCollapsed());
  const [devicePanelCollapsed, setDevicePanelCollapsed] = useState(() => loadDevicePanelCollapsed());
  const [publicBaseUrl, setPublicBaseUrl] = useState(() => loadStoredPublicBaseUrl());

  const [deviceBaseUrl, setDeviceBaseUrl] = useState("http://xteink.local");
  const [deviceTargetPath, setDeviceTargetPath] = useState("/");
  const [deviceRootDirs, setDeviceRootDirs] = useState<DeviceFileEntry[]>([]);
  const [deviceLoading, setDeviceLoading] = useState(false);
  const [deviceSaving, setDeviceSaving] = useState(false);
  const [deviceError, setDeviceError] = useState<string | null>(null);
  const [deviceNotice, setDeviceNotice] = useState<string | null>(null);
  const [newDeviceFolderName, setNewDeviceFolderName] = useState("");

  const [viewMode, setViewMode] = useState<ViewMode>("library");
  const [facetSearch, setFacetSearch] = useState("");
  const [facetPrefix, setFacetPrefix] = useState<(typeof FACET_PREFIXES)[number]>("ALL");
  const [facetItems, setFacetItems] = useState<Array<{ name: string; count: number }>>([]);
  const [facetLoading, setFacetLoading] = useState(false);
  const [facetError, setFacetError] = useState<string | null>(null);
  const [selectedFacet, setSelectedFacet] = useState<FacetSelection | null>(null);

  const isFacetListView = (viewMode === "artists" || viewMode === "groups") && !selectedFacet;

  const activeFacetNamespace = useMemo<FacetNamespace | null>(() => {
    if (viewMode === "artists") return "artist";
    if (viewMode === "groups") return "group";
    return null;
  }, [viewMode]);

  const opdsBaseUrl = useMemo(() => {
    if (publicBaseUrl.trim()) {
      try {
        return `${normalizePublicBaseUrlInput(publicBaseUrl)}/opds`;
      } catch {
        // Ignore malformed manual base URL and fall back to computed defaults.
      }
    }
    const explicit = import.meta.env.VITE_OPDS_URL as string | undefined;
    if (explicit) return explicit;
    return `${window.location.protocol}//${window.location.hostname}:3000/opds`;
  }, [publicBaseUrl]);

  const selectedCount = useMemo(() => Object.keys(selectedArchives).length, [selectedArchives]);
  const isBatchRunning = batchState !== null;

  const filteredFacetItems = useMemo(
    () => facetItems.filter((item) => matchesFacetPrefix(item.name, facetPrefix)),
    [facetItems, facetPrefix],
  );
  const batchJobList = useMemo(
    () =>
      Object.values(batchJobs).sort(
        (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
      ),
    [batchJobs],
  );
  const batchRows = useMemo(() => {
    const orderIndex = new Map<string, number>();
    batchArchiveOrder.forEach((archiveId, index) => {
      orderIndex.set(archiveId, index);
    });

    const used = new Set<string>();
    const rows: Array<{
      archiveId: string;
      title: string;
      job: ConversionJob | null;
      upload: UploadProgressState | null;
      updatedAt: number;
    }> = [];

    for (const job of batchJobList) {
      const archiveId = job.archiveId;
      const title = batchArchiveTitles[archiveId] || archiveId;
      used.add(archiveId);
      rows.push({
        archiveId,
        title,
        job,
        upload: batchUploads[archiveId] || null,
        updatedAt: new Date(job.updatedAt).getTime(),
      });
    }

    for (const [archiveId, title] of Object.entries(batchArchiveTitles)) {
      if (used.has(archiveId)) continue;
      rows.push({
        archiveId,
        title,
        job: null,
        upload: batchUploads[archiveId] || null,
        updatedAt: 0,
      });
    }

    return rows.sort((a, b) => {
      const aOrder = orderIndex.get(a.archiveId);
      const bOrder = orderIndex.get(b.archiveId);
      if (aOrder !== undefined && bOrder !== undefined && aOrder !== bOrder) {
        return aOrder - bOrder;
      }
      if (aOrder !== undefined) return -1;
      if (bOrder !== undefined) return 1;
      if (a.updatedAt !== b.updatedAt) return b.updatedAt - a.updatedAt;
      return a.title.localeCompare(b.title, undefined, { sensitivity: "base" });
    });
  }, [batchArchiveOrder, batchArchiveTitles, batchJobList, batchUploads]);
  const batchPreviewItems = useMemo(() => {
    const orderIndex = new Map<string, number>();
    batchArchiveOrder.forEach((archiveId, index) => {
      orderIndex.set(archiveId, index);
    });

    const items = batchRows
      .map((row) => {
        if (!row.job) return null;
        const fromFrame = row.job.convertedFrameVersion > 0;
        const src = fromFrame
          ? conversionFrameUrl(row.job.jobId, row.job.convertedFrameVersion)
          : row.job.currentPagePath
            ? archivePageUrl(row.job.archiveId, row.job.currentPagePath)
            : null;
        if (!src) return null;

        return {
          archiveId: row.archiveId,
          title: row.title,
          src,
          label: fromFrame ? row.job.currentConvertedFrameLabel || "Converted frame" : row.job.currentPagePath || "Page",
          order: orderIndex.get(row.archiveId) ?? Number.MAX_SAFE_INTEGER,
        };
      })
      .filter((item): item is { archiveId: string; title: string; src: string; label: string; order: number } => item !== null);

    return items.sort((a, b) => a.order - b.order);
  }, [batchArchiveOrder, batchRows]);

  useEffect(() => {
    const advanced = localStorage.getItem("xtc_show_advanced");
    const crop = localStorage.getItem("cropthumbs");
    setShowAdvanced(advanced === "true");
    setCropThumbs(crop === "true");
  }, []);

  useEffect(() => {
    localStorage.setItem("xtc_show_advanced", showAdvanced ? "true" : "false");
  }, [showAdvanced]);

  useEffect(() => {
    localStorage.setItem("cropthumbs", cropThumbs ? "true" : "false");
  }, [cropThumbs]);

  useEffect(() => {
    localStorage.setItem(PANEL_STORAGE_KEY, settingsPanelCollapsed ? "true" : "false");
  }, [settingsPanelCollapsed]);

  useEffect(() => {
    localStorage.setItem(SERVICE_PANEL_STORAGE_KEY, servicePanelCollapsed ? "true" : "false");
  }, [servicePanelCollapsed]);

  useEffect(() => {
    localStorage.setItem(DEVICE_PANEL_STORAGE_KEY, devicePanelCollapsed ? "true" : "false");
  }, [devicePanelCollapsed]);

  useEffect(() => {
    localStorage.setItem(PUBLIC_BASE_URL_STORAGE_KEY, publicBaseUrl);
  }, [publicBaseUrl]);

  useEffect(() => {
    localStorage.setItem(THEME_STORAGE_KEY, themeMode);
  }, [themeMode]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const root = window.document.documentElement;
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const applyTheme = () => {
      const resolved = themeMode === "system" ? (media.matches ? "dark" : "light") : themeMode;
      root.setAttribute("data-theme", resolved);
      root.style.colorScheme = resolved;
    };

    applyTheme();
    if (themeMode !== "system") return;

    const onChange = () => applyTheme();
    if (typeof media.addEventListener === "function") {
      media.addEventListener("change", onChange);
      return () => media.removeEventListener("change", onChange);
    }

    media.addListener(onChange);
    return () => media.removeListener(onChange);
  }, [themeMode]);

  useEffect(() => {
    localStorage.setItem(
      SORT_STORAGE_KEY,
      JSON.stringify({
        sortby,
        order,
      }),
    );
  }, [sortby, order]);

  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      setLanraragiLoading(true);
      setLanraragiError(null);
      try {
        const settings = await fetchLanraragiSettings();
        if (cancelled) return;
        setLanraragiBaseUrl(settings.baseUrl);
        setLanraragiHasApiKey(settings.hasApiKey);
      } catch (err) {
        if (cancelled) return;
        setLanraragiError(err instanceof Error ? err.message : "Failed to load LANraragi connection settings.");
      } finally {
        if (!cancelled) {
          setLanraragiLoading(false);
        }
      }
    };
    void run();

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const raw = localStorage.getItem(DEVICE_STORAGE_KEY);
    let hadLocalFallback = false;
    if (raw) {
      try {
        const parsed = JSON.parse(raw) as { baseUrl?: string; path?: string };
        if (parsed.baseUrl) {
          setDeviceBaseUrl(parsed.baseUrl);
          hadLocalFallback = true;
        }
        if (parsed.path) {
          setDeviceTargetPath(normalizeDevicePath(parsed.path));
          hadLocalFallback = true;
        }
      } catch {
        // Ignore malformed local settings and continue with server defaults.
      }
    }

    let cancelled = false;
    const run = async () => {
      try {
        const defaults = await fetchDeviceDefaults();
        if (cancelled) return;
        setDeviceBaseUrl(defaults.baseUrl);
        setDeviceTargetPath(normalizeDevicePath(defaults.path));
      } catch {
        // Keep fallback local values when defaults endpoint is not reachable.
        if (!hadLocalFallback) {
          setDeviceError("Could not load saved device defaults. Enter device address and save.");
        }
      }
    };

    void run();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const run = async () => {
      setLoadingSettings(true);
      try {
        const defaults = await fetchDefaults();
        const stored = loadStoredSettings();
        setDefaultSettings(defaults);
        setSettings({
          ...defaults,
          ...(stored ?? {}),
        });
      } catch (err) {
        setError(err instanceof Error ? err.message : "Could not load defaults");
      } finally {
        setLoadingSettings(false);
      }
    };
    void run();
  }, []);

  useEffect(() => {
    if (!settings) return;
    localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(settings));
  }, [settings]);

  useEffect(() => {
    localStorage.setItem(
      DEVICE_STORAGE_KEY,
      JSON.stringify({
        baseUrl: deviceBaseUrl,
        path: normalizeDevicePath(deviceTargetPath),
      }),
    );
  }, [deviceBaseUrl, deviceTargetPath]);

  useEffect(() => {
    if (!archives.length) return;
    setSelectedArchives((previous) => {
      let changed = false;
      const next = { ...previous };
      for (const archive of archives) {
        if (next[archive.arcid]) {
          next[archive.arcid] = archive;
          changed = true;
        }
      }
      return changed ? next : previous;
    });
  }, [archives]);

  useEffect(() => {
    if (!activeFacetNamespace || selectedFacet) return;

    let cancelled = false;
    const run = async () => {
      setFacetLoading(true);
      setFacetError(null);
      try {
        const data = await fetchFacets({
          namespace: activeFacetNamespace,
          q: facetSearch,
        });
        if (cancelled) return;
        setFacetItems(data);
      } catch (err) {
        if (cancelled) return;
        setFacetError(err instanceof Error ? err.message : "Failed to load facets");
      } finally {
        if (!cancelled) {
          setFacetLoading(false);
        }
      }
    };

    void run();
    return () => {
      cancelled = true;
    };
  }, [activeFacetNamespace, facetSearch, selectedFacet, lanraragiReloadToken]);

  useEffect(() => {
    setNormalizedFilter(normalizeCommaTerms(filter));
  }, [filter]);

  useEffect(() => {
    if (viewMode !== "library" || selectedFacet) {
      setTagSuggestions([]);
      setTagSuggestLoading(false);
      return;
    }

    const current = extractLastCommaTerm(filter);
    if (!current) {
      setTagSuggestions([]);
      setTagSuggestLoading(false);
      return;
    }

    let cancelled = false;
    const timer = window.setTimeout(async () => {
      setTagSuggestLoading(true);
      try {
        const suggestions = await fetchTagSuggestions({
          q: current,
          limit: 18,
        });
        if (!cancelled) {
          setTagSuggestions(suggestions);
        }
      } catch {
        if (!cancelled) {
          setTagSuggestions([]);
        }
      } finally {
        if (!cancelled) {
          setTagSuggestLoading(false);
        }
      }
    }, 180);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [filter, viewMode, selectedFacet]);

  useEffect(() => {
    if (isFacetListView) return;

    let cancelled = false;
    const run = async () => {
      setLoading(true);
      setError(null);
      try {
        const data = await fetchArchives({
          q: buildArchiveFilter(normalizedFilter, selectedFacet),
          start,
          sortby,
          order,
        });
        if (cancelled) return;
        setArchives(data.data);
        setTotal(data.recordsFiltered);
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : "Failed to load archives");
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    };

    void run();
    return () => {
      cancelled = true;
    };
  }, [normalizedFilter, start, sortby, order, selectedFacet, isFacetListView, lanraragiReloadToken]);

  const canPrev = start > 0;
  const canNext = start + archives.length < total;
  const pageStep = archives.length || 100;

  const scrollToTop = () => {
    if (typeof window === "undefined") return;
    window.scrollTo({ top: 0, behavior: "auto" });
  };

  const goPrevPage = () => {
    setStart((current) => Math.max(0, current - pageStep));
    scrollToTop();
  };

  const goNextPage = () => {
    setStart((current) => current + pageStep);
    scrollToTop();
  };

  const triggerBlobDownload = (blob: Blob, name: string) => {
    const objectUrl = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = objectUrl;
    link.download = name;
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(objectUrl), 60_000);
  };

  useEffect(
    () => () => {
      for (const timer of Object.values(uploadTickerRef.current)) {
        window.clearInterval(timer);
      }
      uploadTickerRef.current = {};
      if (singleUploadTickerRef.current) {
        window.clearInterval(singleUploadTickerRef.current);
        singleUploadTickerRef.current = null;
      }
    },
    [],
  );

  const startBatchUploadTicker = (archiveId: string) => {
    const existing = uploadTickerRef.current[archiveId];
    if (existing) {
      window.clearInterval(existing);
    }
    const startedAt = Date.now();
    const timer = window.setInterval(() => {
      setBatchUploads((previous) => {
        const current = previous[archiveId];
        if (!current || current.phase !== "uploading") return previous;
        const elapsedSeconds = Math.floor((Date.now() - startedAt) / 1000);
        const nextProgress = Math.max(current.progress, Math.min(99, 8 + Math.floor(elapsedSeconds / 3)));
        const nextMessage = `Uploading to XTEink (${formatElapsed(elapsedSeconds)})`;
        if (nextProgress === current.progress && nextMessage === current.message) return previous;
        return {
          ...previous,
          [archiveId]: {
            ...current,
            progress: nextProgress,
            message: nextMessage,
          },
        };
      });
    }, 1_000);
    uploadTickerRef.current[archiveId] = timer;
  };

  const stopBatchUploadTicker = (archiveId: string) => {
    const timer = uploadTickerRef.current[archiveId];
    if (!timer) return;
    window.clearInterval(timer);
    delete uploadTickerRef.current[archiveId];
  };

  const startSingleUploadTicker = () => {
    if (singleUploadTickerRef.current) {
      window.clearInterval(singleUploadTickerRef.current);
    }
    const startedAt = Date.now();
    const timer = window.setInterval(() => {
      setSingleUpload((current) => {
        if (!current || current.phase !== "uploading") return current;
        const elapsedSeconds = Math.floor((Date.now() - startedAt) / 1000);
        return {
          ...current,
          progress: Math.max(current.progress, Math.min(99, 8 + Math.floor(elapsedSeconds / 3))),
          message: `Uploading converted archive to XTEink (${formatElapsed(elapsedSeconds)})`,
        };
      });
    }, 1_000);
    singleUploadTickerRef.current = timer;
  };

  const stopSingleUploadTicker = () => {
    if (!singleUploadTickerRef.current) return;
    window.clearInterval(singleUploadTickerRef.current);
    singleUploadTickerRef.current = null;
  };

  const runConversionJob = async (
    archive: ArchiveRecord,
    effectiveSettings: ConversionSettings,
    onJobUpdate?: (job: ConversionJob) => void,
  ): Promise<ConversionJob> => {
    let job = await startConversionJob(archive.arcid, effectiveSettings);
    onJobUpdate?.(job);
    let pollFailures = 0;

    while (job.status === "queued" || job.status === "running") {
      await wait(800);
      try {
        job = await fetchConversionJob(job.jobId);
        pollFailures = 0;
        onJobUpdate?.(job);
      } catch (error) {
        if (isRetryablePollError(error) && pollFailures < 5) {
          pollFailures += 1;
          await wait(300 * pollFailures);
          continue;
        }
        throw error;
      }
    }

    if (job.status !== "completed") {
      throw new Error(job.error || "Conversion failed");
    }

    return job;
  };

  const deliverCompletedJob = async (params: {
    archive: ArchiveRecord;
    mode: "download" | "upload";
    jobId: string;
    uploadRunner?: (jobId: string) => Promise<{ ok: true; fileName: string; fileSize: number; baseUrl: string; path: string }>;
  }): Promise<{ size: number; target?: string }> => {
    if (params.mode === "download") {
      const blob = await downloadConversionJob(params.jobId);
      if (blob.size <= 0) {
        throw new Error("Conversion returned an empty file.");
      }

      triggerBlobDownload(blob, buildDownloadName(params.archive));
      return { size: blob.size };
    }

    const baseUrl = normalizeDeviceBaseUrlInput(deviceBaseUrl);
    const path = normalizeDevicePath(deviceTargetPath);
    const upload = params.uploadRunner
      ? await params.uploadRunner(params.jobId)
      : await uploadConversionJob({
          jobId: params.jobId,
          baseUrl,
          path,
        });
    return {
      size: upload.fileSize,
      target: `${baseUrl}${path}`,
    };
  };

  const toggleArchiveSelection = (archive: ArchiveRecord, selected: boolean) => {
    setSelectedArchives((previous) => {
      const next = { ...previous };
      if (selected) {
        next[archive.arcid] = archive;
      } else {
        delete next[archive.arcid];
      }
      return next;
    });
  };

  const selectAllShown = () => {
    setSelectedArchives((previous) => {
      const next = { ...previous };
      for (const archive of archives) {
        next[archive.arcid] = archive;
      }
      return next;
    });
  };

  const clearSelected = () => {
    setSelectedArchives({});
  };

  const runSelectedAction = async (mode: "download" | "upload") => {
    if (!settings || !defaultSettings) return;
    const batch = Object.values(selectedArchives);
    if (batch.length === 0) return;
    setError(null);
    setLastConversion(null);
    setConversionJob(null);
    setBatchJobs({});
    for (const timer of Object.values(uploadTickerRef.current)) {
      window.clearInterval(timer);
    }
    uploadTickerRef.current = {};
    setBatchArchiveTitles(
      Object.fromEntries(batch.map((archive) => [archive.arcid, archive.title || archive.filename || archive.arcid])),
    );
    setBatchArchiveOrder(batch.map((archive) => archive.arcid));
    setBatchUploads(
      mode === "upload"
        ? Object.fromEntries(
            batch.map((archive) => [
              archive.arcid,
              {
                phase: "idle",
                progress: 0,
                message: "Waiting for conversion",
              } satisfies UploadProgressState,
            ]),
          )
        : {},
    );
    setBatchState({
      total: batch.length,
      completed: 0,
      failed: 0,
      active: 0,
      currentTitle: "",
    });

    try {
      const effectiveSettings = buildEffectiveSettings(settings, defaultSettings, showAdvanced);
      const queue = [...batch];
      const workerCount = Math.min(BATCH_MAX_PARALLEL, queue.length);
      const failures: string[] = [];
      let nextIndex = 0;
      const uploadBaseUrl = mode === "upload" ? normalizeDeviceBaseUrlInput(deviceBaseUrl) : "";
      const uploadPath = mode === "upload" ? normalizeDevicePath(deviceTargetPath) : "/";
      let uploadQueue = Promise.resolve();
      const uploadTasks: Promise<void>[] = [];
      const enqueueUpload = (params: { archive: ArchiveRecord; jobId: string; archiveTitle: string }): Promise<void> => {
        setBatchUploads((previous) => ({
          ...previous,
          [params.archive.arcid]: {
            phase: "queued",
            progress: 3,
            message: "Queued for device upload",
          },
        }));
        const run = async () => {
          setBatchState((previous) =>
            previous
              ? {
                  ...previous,
                  currentTitle: `${params.archiveTitle} (upload)`,
                }
              : previous,
          );
          setBatchUploads((previous) => ({
            ...previous,
            [params.archive.arcid]: {
              phase: "uploading",
              progress: 8,
              message: "Uploading to XTEink (00:00)",
            },
          }));
          startBatchUploadTicker(params.archive.arcid);
          try {
            const upload = await uploadConversionJob({
              jobId: params.jobId,
              baseUrl: uploadBaseUrl,
              path: uploadPath,
            });
            stopBatchUploadTicker(params.archive.arcid);
            setBatchUploads((previous) => ({
              ...previous,
              [params.archive.arcid]: {
                phase: "completed",
                progress: 100,
                message: "Upload complete",
              },
            }));
            setLastConversion({
              id: params.archive.arcid,
              title: params.archiveTitle,
              size: upload.fileSize,
              action: "uploaded",
              target: `${uploadBaseUrl}${uploadPath}`,
            });
            setBatchState((previous) =>
              previous
                ? {
                    ...previous,
                    completed: previous.completed + 1,
                  }
                : previous,
            );
          } catch (err) {
            stopBatchUploadTicker(params.archive.arcid);
            failures.push(`${params.archiveTitle}: ${err instanceof Error ? err.message : "Upload failed"}`);
            setBatchUploads((previous) => ({
              ...previous,
              [params.archive.arcid]: {
                phase: "failed",
                progress: 100,
                message: err instanceof Error ? err.message : "Upload failed",
              },
            }));
            setBatchState((previous) =>
              previous
                ? {
                    ...previous,
                    failed: previous.failed + 1,
                  }
                : previous,
            );
          }
        };
        const chained = uploadQueue.then(run, run);
        uploadQueue = chained.then(
          () => undefined,
          () => undefined,
        );
        return chained;
      };

      const runWorker = async () => {
        while (true) {
          const index = nextIndex;
          nextIndex += 1;
          if (index >= queue.length) {
            return;
          }

          const archive = queue[index];
          const archiveTitle = archive.title || archive.filename || archive.arcid;
          setBatchState((previous) =>
            previous
              ? {
                  ...previous,
                  active: previous.active + 1,
                  currentTitle: archiveTitle,
                }
              : previous,
          );

          try {
            const completedJob = await runConversionJob(
              archive,
              effectiveSettings,
              (job) => {
                setBatchJobs((previous) => ({
                  ...previous,
                  [job.jobId]: job,
                }));
              },
            );
            if (mode === "upload") {
              uploadTasks.push(
                enqueueUpload({
                  archive,
                  jobId: completedJob.jobId,
                  archiveTitle,
                }),
              );
            } else {
              const result = await deliverCompletedJob({
                archive,
                mode: "download",
                jobId: completedJob.jobId,
              });
              setLastConversion({
                id: archive.arcid,
                title: archiveTitle,
                size: result.size,
                action: "downloaded",
              });
              setBatchState((previous) =>
                previous
                  ? {
                      ...previous,
                      completed: previous.completed + 1,
                    }
                  : previous,
              );
            }
          } catch (err) {
            failures.push(`${archiveTitle}: ${err instanceof Error ? err.message : "Conversion failed"}`);
            if (mode === "upload") {
              setBatchUploads((previous) => ({
                ...previous,
                [archive.arcid]: {
                  phase: "failed",
                  progress: 100,
                  message: err instanceof Error ? err.message : "Conversion failed",
                },
              }));
            }
            setBatchState((previous) =>
              previous
                ? {
                    ...previous,
                    failed: previous.failed + 1,
                  }
                : previous,
            );
          } finally {
            setBatchState((previous) =>
              previous
                ? {
                    ...previous,
                    active: Math.max(0, previous.active - 1),
                  }
                : previous,
            );
          }
        }
      };

      await Promise.all(Array.from({ length: workerCount }, () => runWorker()));
      if (mode === "upload") {
        await Promise.all(uploadTasks);
      }

      if (failures.length > 0) {
        const preview = failures.slice(0, 3).join(" | ");
        setError(
          `Batch completed with ${failures.length} failure${failures.length === 1 ? "" : "s"}: ${preview}${
            failures.length > 3 ? " ..." : ""
          }`,
        );
      } else {
        setSelectedArchives({});
      }

      setBatchState((previous) =>
        previous
          ? {
              ...previous,
              currentTitle: "Done",
            }
          : previous,
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Batch conversion failed");
    } finally {
      setConvertingId(null);
      setConversionJob(null);
      for (const timer of Object.values(uploadTickerRef.current)) {
        window.clearInterval(timer);
      }
      uploadTickerRef.current = {};
      setTimeout(() => {
        setBatchState(null);
        setBatchJobs({});
        setBatchArchiveTitles({});
        setBatchArchiveOrder([]);
        setBatchUploads({});
      }, 1200);
    }
  };

  const onConvertSelected = async () => {
    await runSelectedAction("download");
  };

  const onUploadSelected = async () => {
    await runSelectedAction("upload");
  };

  const runSingleAction = async (archive: ArchiveRecord, mode: "download" | "upload") => {
    if (!settings || !defaultSettings || isBatchRunning) return;
    setConvertingId(archive.arcid);
    setError(null);
    setLastConversion(null);
    setSingleUpload(null);
    stopSingleUploadTicker();

    try {
      const effectiveSettings = buildEffectiveSettings(settings, defaultSettings, showAdvanced);
      const completedJob = await runConversionJob(archive, effectiveSettings, (job) => {
        setConversionJob(job);
      });
      if (mode === "upload") {
        setSingleUpload({
          phase: "uploading",
          progress: 8,
          message: "Uploading converted archive to XTEink (00:00)",
        });
        startSingleUploadTicker();
      }
      const result = await deliverCompletedJob({
        archive,
        mode,
        jobId: completedJob.jobId,
      });
      if (mode === "upload") {
        stopSingleUploadTicker();
        setSingleUpload({
          phase: "completed",
          progress: 100,
          message: "Upload complete",
        });
      }
      setLastConversion({
        id: archive.arcid,
        title: archive.title || archive.filename || archive.arcid,
        size: result.size,
        action: mode === "download" ? "downloaded" : "uploaded",
        target: result.target,
      });
      setConversionJob(null);
    } catch (err) {
      stopSingleUploadTicker();
      if (mode === "upload") {
        setSingleUpload({
          phase: "failed",
          progress: 100,
          message: err instanceof Error ? err.message : "Upload failed",
        });
      }
      setError(err instanceof Error ? err.message : "Conversion failed");
      setConversionJob((current) =>
        current
          ? {
              ...current,
              status: "failed",
              stage: "failed",
              message: err instanceof Error ? err.message : "Conversion failed",
              error: err instanceof Error ? err.message : "Conversion failed",
            }
          : current,
      );
    } finally {
      setConvertingId(null);
    }
  };

  const onConvert = async (archive: ArchiveRecord) => {
    await runSingleAction(archive, "download");
  };

  const onUpload = async (archive: ArchiveRecord) => {
    await runSingleAction(archive, "upload");
  };

  const switchMode = (mode: ViewMode) => {
    setViewMode(mode);
    setSelectedFacet(null);
    setFilter("");
    setFacetSearch("");
    setFacetPrefix("ALL");
    setStart(0);
  };

  const onSaveLanraragiSettings = async () => {
    setLanraragiError(null);
    setLanraragiNotice(null);
    setLanraragiSaving(true);
    try {
      const normalizedBaseUrl = normalizeLanraragiBaseUrlInput(lanraragiBaseUrl);
      const normalizedPublicBaseUrl = normalizePublicBaseUrlInput(publicBaseUrl);
      const payload: { baseUrl: string; apiKey?: string } = {
        baseUrl: normalizedBaseUrl,
      };
      if (lanraragiApiKey.trim().length > 0) {
        payload.apiKey = lanraragiApiKey;
      }

      const settings = await updateLanraragiSettings(payload);
      setLanraragiBaseUrl(settings.baseUrl);
      setLanraragiHasApiKey(settings.hasApiKey);
      setLanraragiApiKey("");
      setPublicBaseUrl(normalizedPublicBaseUrl);
      setLanraragiNotice("Service connection settings updated.");
      setLanraragiReloadToken((current) => current + 1);
      setServicePanelCollapsed(true);
      setStart(0);
    } catch (err) {
      setLanraragiError(err instanceof Error ? err.message : "Failed to save LANraragi settings.");
    } finally {
      setLanraragiSaving(false);
    }
  };

  const onSaveDeviceDefaults = async () => {
    setDeviceError(null);
    setDeviceNotice(null);
    setDeviceSaving(true);
    try {
      const normalizedBaseUrl = normalizeDeviceBaseUrlInput(deviceBaseUrl);
      const normalizedPath = normalizeDevicePath(deviceTargetPath);
      const saved = await updateDeviceDefaults({
        baseUrl: normalizedBaseUrl,
        path: normalizedPath,
      });
      setDeviceBaseUrl(saved.baseUrl);
      setDeviceTargetPath(saved.path);
      setDeviceNotice("Device defaults saved.");
      setDevicePanelCollapsed(true);
    } catch (err) {
      setDeviceError(err instanceof Error ? err.message : "Failed to save device defaults.");
    } finally {
      setDeviceSaving(false);
    }
  };

  const refreshDeviceRootFolders = async () => {
    setDeviceLoading(true);
    setDeviceError(null);
    try {
      const baseUrl = normalizeDeviceBaseUrlInput(deviceBaseUrl);
      const response = await fetchDeviceFiles({
        baseUrl,
        path: "/",
      });
      const directories = response.files
        .filter((entry) => entry.isDirectory)
        .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
      setDeviceRootDirs(directories);
    } catch (err) {
      setDeviceError(err instanceof Error ? err.message : "Failed to read device folders");
    } finally {
      setDeviceLoading(false);
    }
  };

  const onCreateDeviceFolder = async () => {
    const name = newDeviceFolderName.trim();
    if (!name) return;
    setDeviceLoading(true);
    setDeviceError(null);
    try {
      const baseUrl = normalizeDeviceBaseUrlInput(deviceBaseUrl);
      const parentPath = normalizeDevicePath(deviceTargetPath);
      await createDeviceFolder({
        baseUrl,
        path: parentPath,
        name,
      });
      const nextPath = joinDevicePath(parentPath, name);
      setDeviceTargetPath(nextPath);
      setNewDeviceFolderName("");
      const response = await fetchDeviceFiles({
        baseUrl,
        path: "/",
      });
      const directories = response.files
        .filter((entry) => entry.isDirectory)
        .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
      setDeviceRootDirs(directories);
    } catch (err) {
      setDeviceError(err instanceof Error ? err.message : "Failed to create device folder");
    } finally {
      setDeviceLoading(false);
    }
  };

  const isCbz2xtcStage = conversionJob?.stage === "cbz2xtc";
  const showingConvertedFrame = isCbz2xtcStage && conversionJob.convertedFrameVersion > 0 && !!conversionJob.jobId;
  const conversionPreviewSrc = conversionJob
    ? isCbz2xtcStage
      ? showingConvertedFrame
        ? conversionFrameUrl(conversionJob.jobId, conversionJob.convertedFrameVersion)
        : null
      : conversionJob.currentPagePath
        ? archivePageUrl(conversionJob.archiveId, conversionJob.currentPagePath)
        : null
    : null;
  const conversionPreviewLabel = conversionJob
    ? showingConvertedFrame
      ? conversionJob.currentConvertedFrameLabel || "Converted frame"
      : conversionJob.currentPagePath
    : null;
  const conversionPageFrameLine = conversionJob ? formatJobPageFrameLine(conversionJob) : null;
  const batchDoneCount = batchState ? batchState.completed + batchState.failed : 0;
  const batchPercent = batchState && batchState.total > 0 ? Math.round((batchDoneCount / batchState.total) * 100) : 0;
  const batchUploadQueueCount = batchState
    ? Object.values(batchUploads).filter((state) => state.phase === "queued" || state.phase === "uploading").length
    : 0;

  if (loadingSettings || !settings || !defaultSettings) {
    return <div className="center-screen">Loading configuration...</div>;
  }

  return (
    <div className={`app-shell ${settingsPanelCollapsed ? "settings-collapsed" : ""}`}>
      <aside className={`settings-pane ${settingsPanelCollapsed ? "collapsed" : ""}`}>
        <button
          className="settings-toggle-btn"
          type="button"
          onClick={() => setSettingsPanelCollapsed((current) => !current)}
          aria-expanded={!settingsPanelCollapsed}
          aria-label={settingsPanelCollapsed ? "Open settings" : "Close settings"}
          title={settingsPanelCollapsed ? "Open settings" : "Close settings"}
        >
          <span className="settings-toggle-icon" aria-hidden="true">
            ☰
          </span>
        </button>

        <div className={`settings-pane-body ${settingsPanelCollapsed ? "hidden" : ""}`}>
        <h1>XTC Forge</h1>
        <p className="muted">LANraragi to XTEink X4 converter with live OPDS delivery.</p>

        <div className="settings-grid display-options">
          <h2>Display</h2>
          <label>
            Theme
            <select value={themeMode} onChange={(e) => setThemeMode(e.target.value as ThemeMode)}>
              <option value="system">Follow system</option>
              <option value="light">Light</option>
              <option value="dark">Dark</option>
            </select>
          </label>
        </div>

        <div className="opds-box device-box">
          <div className="section-header-row">
            <div className="small-label">Service Connection</div>
            <button
              className="section-toggle-btn"
              type="button"
              onClick={() => setServicePanelCollapsed((current) => !current)}
              aria-label={servicePanelCollapsed ? "Expand service settings" : "Collapse service settings"}
            >
              {servicePanelCollapsed ? "<" : "^"}
            </button>
          </div>

          {servicePanelCollapsed ? (
            <div className="conversion-sub">
              LANraragi: {lanraragiBaseUrl || "Not set"} • API key: {lanraragiHasApiKey ? "stored" : "not set"}
              <br />
              OPDS link: {opdsBaseUrl}
            </div>
          ) : (
            <>
              <label>
                LANraragi server address
                <input
                  value={lanraragiBaseUrl}
                  onChange={(e) => setLanraragiBaseUrl(e.target.value)}
                  onBlur={() => {
                    try {
                      setLanraragiBaseUrl(normalizeLanraragiBaseUrlInput(lanraragiBaseUrl));
                    } catch {
                      // Keep raw value so user can continue editing.
                    }
                  }}
                  placeholder="http://localhost:3001"
                />
              </label>
              <label>
                LANraragi API key / password
                <input
                  type="password"
                  value={lanraragiApiKey}
                  onChange={(e) => setLanraragiApiKey(e.target.value)}
                  placeholder={lanraragiHasApiKey ? "Stored key exists. Enter new key to replace." : "Enter API key"}
                />
              </label>
              <label>
                Public base URL (optional)
                <input
                  value={publicBaseUrl}
                  onChange={(e) => setPublicBaseUrl(e.target.value)}
                  onBlur={() => {
                    try {
                      setPublicBaseUrl(normalizePublicBaseUrlInput(publicBaseUrl));
                    } catch {
                      // Keep raw value so user can continue editing.
                    }
                  }}
                  placeholder="https://your-domain.example"
                />
              </label>
              <div className="conversion-sub">
                Stored key: {lanraragiHasApiKey ? "set" : "not set"}
                {lanraragiApiKey ? " • New key pending save" : ""}
              </div>
              <div className="conversion-sub">
                OPDS link preview:{" "}
                <a href={opdsBaseUrl} target="_blank" rel="noreferrer">
                  {opdsBaseUrl}
                </a>
              </div>
              <div className="device-actions">
                <button
                  type="button"
                  onClick={() => {
                    void onSaveLanraragiSettings();
                  }}
                  disabled={lanraragiLoading || lanraragiSaving}
                >
                  {lanraragiSaving ? "Saving..." : "Save service settings"}
                </button>
              </div>
            </>
          )}
          {lanraragiNotice ? <p className="success">{lanraragiNotice}</p> : null}
          {lanraragiError ? <p className="error">{lanraragiError}</p> : null}
        </div>

        <div className="opds-box device-box">
          <div className="section-header-row">
            <div className="small-label">XTEink Device</div>
            <button
              className="section-toggle-btn"
              type="button"
              onClick={() => setDevicePanelCollapsed((current) => !current)}
              aria-label={devicePanelCollapsed ? "Expand XTEink settings" : "Collapse XTEink settings"}
            >
              {devicePanelCollapsed ? "<" : "^"}
            </button>
          </div>
          {devicePanelCollapsed ? (
            <div className="conversion-sub">
              Device: {deviceBaseUrl || "Not set"}
              <br />
              Upload path: {normalizeDevicePath(deviceTargetPath)}
            </div>
          ) : (
            <>
              <label>
                Device address
                <input
                  value={deviceBaseUrl}
                  onChange={(e) => setDeviceBaseUrl(e.target.value)}
                  onBlur={() => {
                    try {
                      setDeviceBaseUrl(normalizeDeviceBaseUrlInput(deviceBaseUrl));
                    } catch {
                      // Keep raw value so user can continue editing.
                    }
                  }}
                  placeholder="http://xteink.local"
                />
              </label>
              <label>
                Upload folder path
                <input
                  value={deviceTargetPath}
                  onChange={(e) => setDeviceTargetPath(e.target.value)}
                  onBlur={() => setDeviceTargetPath(normalizeDevicePath(deviceTargetPath))}
                  placeholder="/Lanraragi"
                />
              </label>
              <div className="device-actions">
                <button type="button" onClick={() => void refreshDeviceRootFolders()} disabled={deviceLoading}>
                  {deviceLoading ? "Checking..." : "List root folders"}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    void onSaveDeviceDefaults();
                  }}
                  disabled={deviceSaving || deviceLoading}
                >
                  {deviceSaving ? "Saving..." : "Save device defaults"}
                </button>
              </div>
              {deviceRootDirs.length > 0 ? (
                <div className="device-folder-list">
                  {deviceRootDirs.map((entry) => (
                    <button
                      key={`root-${entry.name}`}
                      type="button"
                      onClick={() => setDeviceTargetPath(joinDevicePath("/", entry.name))}
                    >
                      /{entry.name}
                    </button>
                  ))}
                </div>
              ) : null}
              <div className="device-create-row">
                <input
                  value={newDeviceFolderName}
                  onChange={(e) => setNewDeviceFolderName(e.target.value)}
                  placeholder="New folder in current path"
                />
                <button type="button" onClick={() => void onCreateDeviceFolder()} disabled={deviceLoading}>
                  Create
                </button>
              </div>
            </>
          )}
          {deviceNotice ? <p className="success">{deviceNotice}</p> : null}
          {deviceError ? <p className="error">{deviceError}</p> : null}
        </div>

        <div className="settings-grid basic-options">
          <h2>Recommended Options</h2>

          <label>
            Orientation
            <select
              value={settings.orientation}
              onChange={(e) =>
                setSettings({
                  ...settings,
                  orientation: e.target.value as ConversionSettings["orientation"],
                })
              }
            >
              <option value="landscape">Landscape</option>
              <option value="portrait">Portrait</option>
            </select>
          </label>

          <label>
            Page split
            <select
              value={settings.splitMode}
              onChange={(e) =>
                setSettings({
                  ...settings,
                  splitMode: e.target.value as ConversionSettings["splitMode"],
                })
              }
            >
              <option value="overlap">Overlapping thirds</option>
              <option value="split">Split in half</option>
              <option value="nosplit">No split</option>
            </select>
          </label>

          <label>
            Dithering
            <select
              value={settings.noDither ? "none" : "floyd"}
              onChange={(e) => setSettings({ ...settings, noDither: e.target.value === "none" })}
            >
              <option value="floyd">Floyd-Steinberg</option>
              <option value="none">None</option>
            </select>
          </label>

          <label>
            Contrast
            <select
              value={settings.contrastBoost}
              onChange={(e) => setSettings({ ...settings, contrastBoost: e.target.value })}
            >
              <option value="0">None</option>
              <option value="2">Light</option>
              <option value="4">Medium</option>
              <option value="6">Strong</option>
              <option value="8">Maximum</option>
            </select>
          </label>

          <label>
            Margin crop (%)
            <input
              type="number"
              min="0"
              max="20"
              step="0.5"
              value={settings.margin}
              onChange={(e) => setSettings({ ...settings, margin: e.target.value })}
            />
          </label>

          <label className="checkbox-row">
            <input type="checkbox" checked={showAdvanced} onChange={(e) => setShowAdvanced(e.target.checked)} />
            Show advanced options
          </label>
        </div>

        {showAdvanced ? (
          <div className="settings-grid advanced-options">
            <h2>Advanced</h2>

            <label className="checkbox-row">
              <input
                type="checkbox"
                checked={settings.overlap}
                onChange={(e) => setSettings({ ...settings, overlap: e.target.checked })}
              />
              Force overlap flag
            </label>
            <label className="checkbox-row">
              <input
                type="checkbox"
                checked={settings.splitAll}
                onChange={(e) => setSettings({ ...settings, splitAll: e.target.checked })}
              />
              Split all pages
            </label>
            <label className="checkbox-row">
              <input
                type="checkbox"
                checked={settings.includeOverviews}
                onChange={(e) => setSettings({ ...settings, includeOverviews: e.target.checked })}
              />
              Include overview pages
            </label>
            <label className="checkbox-row">
              <input
                type="checkbox"
                checked={settings.sidewaysOverviews}
                onChange={(e) => setSettings({ ...settings, sidewaysOverviews: e.target.checked })}
              />
              Sideways overviews
            </label>
            <label className="checkbox-row">
              <input
                type="checkbox"
                checked={settings.padBlack}
                onChange={(e) => setSettings({ ...settings, padBlack: e.target.checked })}
              />
              Black padding
            </label>

            <label>
              Split spreads
              <input
                value={settings.splitSpreads}
                onChange={(e) => setSettings({ ...settings, splitSpreads: e.target.value })}
                placeholder="all or 1,5,9"
              />
            </label>
            <label>
              Skip pages
              <input
                value={settings.skip}
                onChange={(e) => setSettings({ ...settings, skip: e.target.value })}
                placeholder="2,3"
              />
            </label>
            <label>
              Only pages
              <input
                value={settings.only}
                onChange={(e) => setSettings({ ...settings, only: e.target.value })}
                placeholder="1,2,10"
              />
            </label>
            <label>
              Do not split pages
              <input
                value={settings.dontSplit}
                onChange={(e) => setSettings({ ...settings, dontSplit: e.target.value })}
                placeholder="1,3,10"
              />
            </label>
            <label>
              Select overviews
              <input
                value={settings.selectOverviews}
                onChange={(e) => setSettings({ ...settings, selectOverviews: e.target.value })}
                placeholder="10,12"
              />
            </label>
            <label>
              Sample set
              <input
                value={settings.sampleSet}
                onChange={(e) => setSettings({ ...settings, sampleSet: e.target.value })}
                placeholder=""
              />
            </label>

            <label>
              Start page
              <input
                type="number"
                value={settings.start ?? ""}
                onChange={(e) => setSettings(setNumberOrNull(settings, "start", e.target.value))}
              />
            </label>
            <label>
              Stop page
              <input
                type="number"
                value={settings.stop ?? ""}
                onChange={(e) => setSettings(setNumberOrNull(settings, "stop", e.target.value))}
              />
            </label>
            <label>
              H split count
              <input
                type="number"
                value={settings.hsplitCount ?? ""}
                onChange={(e) => setSettings(setNumberOrNull(settings, "hsplitCount", e.target.value))}
              />
            </label>
            <label>
              H split overlap
              <input
                type="number"
                value={settings.hsplitOverlap ?? ""}
                onChange={(e) => setSettings(setNumberOrNull(settings, "hsplitOverlap", e.target.value))}
              />
            </label>
            <label>
              H split max width
              <input
                type="number"
                value={settings.hsplitMaxWidth ?? ""}
                onChange={(e) => setSettings(setNumberOrNull(settings, "hsplitMaxWidth", e.target.value))}
              />
            </label>
            <label>
              V split target
              <input
                type="number"
                value={settings.vsplitTarget ?? ""}
                onChange={(e) => setSettings(setNumberOrNull(settings, "vsplitTarget", e.target.value))}
              />
            </label>
            <label>
              V split min overlap
              <input
                type="number"
                value={settings.vsplitMinOverlap ?? ""}
                onChange={(e) => setSettings(setNumberOrNull(settings, "vsplitMinOverlap", e.target.value))}
              />
            </label>
          </div>
        ) : null}
        </div>
      </aside>

      <main className="library-pane">
        <div className="mode-switch">
          <button className={viewMode === "library" ? "active" : ""} onClick={() => switchMode("library")}>
            Library
          </button>
          <button className={viewMode === "artists" ? "active" : ""} onClick={() => switchMode("artists")}>
            Artists
          </button>
          <button className={viewMode === "groups" ? "active" : ""} onClick={() => switchMode("groups")}>
            Groups
          </button>
        </div>

        {isFacetListView ? (
          <>
            <header className="toolbar facets-toolbar">
              <input
                value={facetSearch}
                onChange={(e) => setFacetSearch(e.target.value)}
                placeholder={`Search ${activeFacetNamespace ?? "facet"} list`}
              />
            </header>

            <div className="facet-alpha-bar" role="group" aria-label="Facet alphabet filter">
              {FACET_PREFIXES.map((prefix) => (
                <button
                  key={prefix}
                  className={facetPrefix === prefix ? "active" : ""}
                  onClick={() => setFacetPrefix(prefix)}
                >
                  {prefix}
                </button>
              ))}
            </div>

            {facetError ? <p className="error">{facetError}</p> : null}

            <section className="facet-list">
              {facetLoading ? <p>Loading...</p> : null}
              {!facetLoading && filteredFacetItems.length === 0 ? <p>No results.</p> : null}
              {filteredFacetItems.map((item) => (
                <button
                  key={`${activeFacetNamespace}-${item.name}`}
                  className="facet-item"
                  onClick={() => {
                    if (!activeFacetNamespace) return;
                    setSelectedFacet({ namespace: activeFacetNamespace, name: item.name });
                    setStart(0);
                    setFilter("");
                  }}
                >
                  <span>{item.name}</span>
                  <strong>{item.count}</strong>
                </button>
              ))}
            </section>
          </>
        ) : (
          <>
            <header className="toolbar">
              <div className="search-input-wrap">
                <input
                  value={filter}
                  onChange={(e) => {
                    setFilter(e.target.value);
                    setStart(0);
                  }}
                  placeholder="Search title, tags, summary (comma-separated terms)"
                />
              </div>

              <select
                value={sortby}
                onChange={(e) => {
                  setSortby(e.target.value);
                  setStart(0);
                }}
              >
                {SORT_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>

              <button
                onClick={() => {
                  setOrder(order === "asc" ? "desc" : "asc");
                  setStart(0);
                }}
              >
                {order === "asc" ? "Ascending" : "Descending"}
              </button>

              <label className="checkbox-row crop-toggle">
                <input type="checkbox" checked={cropThumbs} onChange={(e) => setCropThumbs(e.target.checked)} />
                Crop thumbnails
              </label>
            </header>
            {(filter.trim().length > 0 || tagSuggestLoading || tagSuggestions.length > 0) && !selectedFacet ? (
              <div className="search-assist-row">
                {filter.trim().length > 0 ? (
                  <p className="search-hint">Searching for: {normalizedFilter || "(none)"}</p>
                ) : null}
                {tagSuggestLoading ? <p className="search-hint">Loading tag suggestions...</p> : null}
                {tagSuggestions.length > 0 ? (
                  <div className="tag-suggest-list" role="listbox" aria-label="Tag suggestions">
                    {tagSuggestions.map((suggestion) => (
                      <button
                        key={`tag-suggest-${suggestion}`}
                        type="button"
                        onClick={() => {
                          setFilter((current) => applyTagAutocomplete(current, suggestion));
                          setStart(0);
                          setTagSuggestions([]);
                        }}
                      >
                        {suggestion}
                      </button>
                    ))}
                  </div>
                ) : null}
              </div>
            ) : null}

            {selectedFacet ? (
              <div className="facet-active-banner">
                <span>
                  Showing {selectedFacet.namespace}: <strong>{selectedFacet.name}</strong>
                </span>
                <button
                  onClick={() => {
                    setSelectedFacet(null);
                    setStart(0);
                    setFilter("");
                  }}
                >
                  Back to {selectedFacet.namespace} list
                </button>
              </div>
            ) : null}

            {conversionJob ? (
              <section className="conversion-panel" aria-live="polite">
                <div className="conversion-head">
                  <strong>
                    Conversion {conversionJob.archiveId.slice(0, 8)}: {conversionJob.status}
                  </strong>
                  <span>{Math.round(conversionJob.progress * 100)}%</span>
                </div>
                <div className="conversion-bar">
                  <span style={{ width: `${Math.max(2, Math.round(conversionJob.progress * 100))}%` }} />
                </div>
                <p className="conversion-message">{conversionJob.message}</p>
                {conversionPageFrameLine ? <p className="conversion-sub">{conversionPageFrameLine}</p> : null}
                {isCbz2xtcStage && !showingConvertedFrame ? (
                  <p className="conversion-sub">Waiting for first fully converted frame...</p>
                ) : null}
                {conversionPreviewSrc ? (
                  <div className="conversion-preview">
                    <img
                      src={conversionPreviewSrc}
                      alt={showingConvertedFrame ? "Current converted frame" : `Current page ${conversionJob.completedPages}`}
                      onError={(event) => {
                        event.currentTarget.onerror = null;
                        event.currentTarget.src =
                          "data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=";
                      }}
                    />
                    <small>
                      {showingConvertedFrame ? "Converted frame" : "Source page"}: {conversionPreviewLabel}
                    </small>
                  </div>
                ) : null}
                {singleUpload ? (
                  <div className="upload-status-box">
                    <div className="conversion-head">
                      <strong>Upload</strong>
                      <span>{singleUpload.progress}%</span>
                    </div>
                    <div className="conversion-bar upload-bar">
                      <span style={{ width: `${Math.max(2, singleUpload.progress)}%` }} />
                    </div>
                    <p className="conversion-sub">{singleUpload.message}</p>
                  </div>
                ) : null}
              </section>
            ) : null}

            {error ? <p className="error">{error}</p> : null}
            {lastConversion ? (
              <p className="success">
                {lastConversion.action === "uploaded" ? "Uploaded" : "Downloaded"} <strong>{lastConversion.title}</strong>{" "}
                ({lastConversion.id.slice(0, 8)})
                {" - "}
                {formatSize(lastConversion.size)}
                {lastConversion.target ? ` to ${lastConversion.target}` : ""}
              </p>
            ) : null}
            {batchState ? (
              <section className="conversion-panel batch-panel" aria-live="polite">
                <div className="conversion-head">
                  <strong>
                    Batch {batchDoneCount}/{batchState.total}
                  </strong>
                  <span>{batchPercent}%</span>
                </div>
                <div className="conversion-bar">
                  <span style={{ width: `${Math.max(2, batchPercent)}%` }} />
                </div>
                <p className="conversion-sub">
                  Active conversions {batchState.active}
                  {Object.keys(batchUploads).length > 0 ? ` • Upload queue ${batchUploadQueueCount}` : ""}
                  {" • "}Success {batchState.completed} • Failed {batchState.failed}
                </p>
                {batchState.currentTitle ? <p className="conversion-sub">Current: {batchState.currentTitle}</p> : null}
                {batchPreviewItems.length > 0 ? (
                  <div className="batch-preview-strip">
                    {batchPreviewItems.map((item) => (
                      <div className="conversion-preview batch-preview-card" key={`preview-${item.archiveId}`}>
                        <img
                          src={item.src}
                          alt={`Current preview for ${item.title}`}
                          onError={(event) => {
                            event.currentTarget.onerror = null;
                            event.currentTarget.src =
                              "data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=";
                          }}
                        />
                        <small>
                          {item.title}: {item.label}
                        </small>
                      </div>
                    ))}
                  </div>
                ) : null}
                {batchRows.length > 0 ? (
                  <div className="batch-jobs">
                    {batchRows.map((row) => {
                      const percent = row.job ? Math.round(row.job.progress * 100) : 0;
                      const pageLine = row.job ? formatJobPageFrameLine(row.job) || "Pending conversion" : "Pending conversion";
                      const upload = row.upload;
                      return (
                        <div className="batch-job-row" key={`batch-${row.archiveId}`}>
                          <div className="batch-job-head">
                            <strong>{row.title}</strong>
                            <span>
                              {row.job ? `${row.job.status} • ${percent}%` : "queued"}
                            </span>
                          </div>
                          <div className="conversion-bar">
                            <span style={{ width: `${Math.max(2, percent)}%` }} />
                          </div>
                          <p className="conversion-sub">{pageLine}</p>
                          {upload ? (
                            <>
                              <div className="batch-job-head upload-head">
                                <strong>Upload</strong>
                                <span>{upload.phase} • {upload.progress}%</span>
                              </div>
                              <div className="conversion-bar upload-bar">
                                <span style={{ width: `${Math.max(2, upload.progress)}%` }} />
                              </div>
                              <p className="conversion-sub">{upload.message}</p>
                            </>
                          ) : null}
                        </div>
                      );
                    })}
                  </div>
                ) : null}
              </section>
            ) : null}

            <div className="bulk-toolbar">
              <span>{selectedCount} selected</span>
              <button disabled={loading || archives.length === 0 || isBatchRunning} onClick={selectAllShown}>
                Select shown
              </button>
              <button disabled={selectedCount === 0 || isBatchRunning} onClick={clearSelected}>
                Clear
              </button>
              <button
                disabled={selectedCount === 0 || isBatchRunning || convertingId !== null}
                onClick={() => {
                  void onConvertSelected();
                }}
              >
                Convert + download selected
              </button>
              <button
                className="secondary-btn"
                disabled={selectedCount === 0 || isBatchRunning || convertingId !== null}
                onClick={() => {
                  void onUploadSelected();
                }}
              >
                Convert + upload selected
              </button>
            </div>

            <div className="stats-row">
              <span>{loading ? "Loading archives..." : `${archives.length} shown / ${total} total`}</span>
              <div className="pager">
                <button disabled={!canPrev || loading} onClick={goPrevPage}>
                  Previous
                </button>
                <button disabled={!canNext || loading} onClick={goNextPage}>
                  Next
                </button>
              </div>
            </div>

            <section className="archive-grid">
              {archives.map((archive) => {
                const tags = parseTags(archive.tags || "");
                const artists = namespaceValues(tags, "artist");
                const groups = namespaceValues(tags, "group");
                const isSelected = Boolean(selectedArchives[archive.arcid]);

                return (
                  <article className={`archive-card ${isSelected ? "selected" : ""}`} key={archive.arcid}>
                    <label className="archive-select">
                      <input
                        type="checkbox"
                        checked={isSelected}
                        onChange={(e) => toggleArchiveSelection(archive, e.target.checked)}
                        disabled={isBatchRunning}
                      />
                      Select
                    </label>
                    <div className={`cover-frame ${cropThumbs ? "crop" : "nocrop"}`}>
                      <img src={thumbnailUrl(archive.arcid)} alt={archive.title} loading="lazy" />
                    </div>

                    <div className="tag-hover-panel" role="region" aria-label="Archive tags">
                      <div className="tag-hover-header">Tags</div>
                      <div className="tag-hover-list">
                        {tags.length > 0 ? (
                          <ul>
                            {tags.map((tag) => (
                              <li key={`${archive.arcid}-${tag}`}>{formatUnixTag(tag)}</li>
                            ))}
                          </ul>
                        ) : (
                          <p>No tags</p>
                        )}
                      </div>
                    </div>

                    <div className="card-body">
                      <h3>{archive.title || archive.filename || archive.arcid}</h3>
                      <div className="credit-line">
                        <strong>Artist:</strong> <span>{artists.length > 0 ? artists.join(", ") : "Unknown"}</span>
                      </div>
                      <div className="credit-line">
                        <strong>Group:</strong> <span>{groups.length > 0 ? groups.join(", ") : "Unknown"}</span>
                      </div>

                      <p className="summary">{archive.summary || "No summary"}</p>
                      <div className="meta-line">
                        <span title={archive.arcid}>ID {archive.arcid.slice(0, 8)}</span>
                        <span>{archive.extension.toUpperCase()}</span>
                        <span>{archive.pagecount || 0} pages</span>
                        <span>{formatSize(archive.size || 0)}</span>
                      </div>
                      <div className="card-actions">
                        <button
                          disabled={isBatchRunning || (convertingId !== null && convertingId !== archive.arcid)}
                          onClick={() => {
                            void onConvert(archive);
                          }}
                        >
                          {convertingId === archive.arcid ? "Converting..." : "Convert and download XTC"}
                        </button>
                        <button
                          className="secondary-btn"
                          disabled={isBatchRunning || (convertingId !== null && convertingId !== archive.arcid)}
                          onClick={() => {
                            void onUpload(archive);
                          }}
                        >
                          {convertingId === archive.arcid ? "Converting..." : "Convert and upload to XTEink"}
                        </button>
                      </div>
                    </div>
                  </article>
                );
              })}
            </section>

            <div className="stats-row bottom-pager-row">
              <span>{loading ? "Loading archives..." : `${archives.length} shown / ${total} total`}</span>
              <div className="pager">
                <button disabled={!canPrev || loading} onClick={goPrevPage}>
                  Previous
                </button>
                <button disabled={!canNext || loading} onClick={goNextPage}>
                  Next
                </button>
              </div>
            </div>
          </>
        )}
      </main>
    </div>
  );
}
