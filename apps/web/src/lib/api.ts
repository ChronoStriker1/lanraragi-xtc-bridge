import type { ConversionJob, ConversionSettings, DeviceFileEntry, SearchResponse } from "../types";

export async function fetchDefaults(): Promise<ConversionSettings> {
  const response = await fetch("/api/settings/defaults");
  if (!response.ok) {
    throw new Error(`Defaults request failed (${response.status})`);
  }
  const body = (await response.json()) as { settings: ConversionSettings };
  return body.settings;
}

export async function fetchLanraragiSettings(): Promise<{ baseUrl: string; hasApiKey: boolean }> {
  const response = await fetch("/api/lanraragi/settings");
  if (!response.ok) {
    throw new Error(`LANraragi settings request failed (${response.status})`);
  }
  const body = (await response.json()) as { settings: { baseUrl: string; hasApiKey: boolean } };
  return body.settings;
}

export async function updateLanraragiSettings(params: {
  baseUrl?: string;
  apiKey?: string;
}): Promise<{ baseUrl: string; hasApiKey: boolean }> {
  const response = await fetch("/api/lanraragi/settings", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(params),
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`LANraragi settings update failed (${response.status}): ${text.slice(0, 200)}`);
  }
  const body = (await response.json()) as { settings: { baseUrl: string; hasApiKey: boolean } };
  return body.settings;
}

export async function fetchDeviceDefaults(): Promise<{ baseUrl: string; path: string }> {
  const response = await fetch("/api/device/defaults");
  if (!response.ok) {
    throw new Error(`Device defaults request failed (${response.status})`);
  }
  return (await response.json()) as { baseUrl: string; path: string };
}

export async function updateDeviceDefaults(params: {
  baseUrl?: string;
  path?: string;
}): Promise<{ baseUrl: string; path: string }> {
  const response = await fetch("/api/device/settings", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(params),
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Device defaults update failed (${response.status}): ${text.slice(0, 200)}`);
  }
  const body = (await response.json()) as { settings: { baseUrl: string; path: string } };
  return body.settings;
}

export async function fetchArchives(params: {
  q: string;
  start: number;
  sortby: string;
  order: "asc" | "desc";
}): Promise<SearchResponse> {
  const query = new URLSearchParams({
    q: params.q,
    start: String(params.start),
    sortby: params.sortby,
    order: params.order,
  });

  const response = await fetch(`/api/archives?${query.toString()}`);
  if (!response.ok) {
    throw new Error(`Archive request failed (${response.status})`);
  }

  return (await response.json()) as SearchResponse;
}

export async function fetchFacets(params: { namespace: "artist" | "group"; q?: string }): Promise<Array<{ name: string; count: number }>> {
  const query = new URLSearchParams({
    namespace: params.namespace,
  });
  if (params.q && params.q.trim()) {
    query.set("q", params.q.trim());
  }

  const response = await fetch(`/api/facets?${query.toString()}`);
  if (!response.ok) {
    throw new Error(`Facet request failed (${response.status})`);
  }

  const body = (await response.json()) as { data: Array<{ name: string; count: number }> };
  return body.data;
}

export async function fetchTagSuggestions(params: { q: string; limit?: number }): Promise<string[]> {
  const query = new URLSearchParams();
  if (params.q.trim()) {
    query.set("q", params.q.trim());
  }
  if (params.limit) {
    query.set("limit", String(params.limit));
  }

  const response = await fetch(`/api/tags/suggest?${query.toString()}`);
  if (!response.ok) {
    throw new Error(`Tag suggestion request failed (${response.status})`);
  }
  const body = (await response.json()) as { data: string[] };
  return body.data;
}

export async function convertArchive(id: string, settings: ConversionSettings): Promise<Blob> {
  const response = await fetch(`/api/convert/${encodeURIComponent(id)}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ settings }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Conversion failed (${response.status}): ${text.slice(0, 200)}`);
  }

  return response.blob();
}

export async function startConversionJob(id: string, settings: ConversionSettings): Promise<ConversionJob> {
  const response = await fetch(`/api/convert/${encodeURIComponent(id)}/start`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ settings }),
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Failed to start conversion (${response.status}): ${text.slice(0, 200)}`);
  }
  const body = (await response.json()) as { job: ConversionJob };
  return body.job;
}

export async function fetchConversionJob(jobId: string): Promise<ConversionJob> {
  const response = await fetch(`/api/convert/jobs/${encodeURIComponent(jobId)}`);
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Failed to fetch conversion job (${response.status}): ${text.slice(0, 200)}`);
  }
  const body = (await response.json()) as { job: ConversionJob };
  return body.job;
}

export async function downloadConversionJob(jobId: string): Promise<Blob> {
  const response = await fetch(`/api/convert/jobs/${encodeURIComponent(jobId)}/download`);
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Failed to download conversion output (${response.status}): ${text.slice(0, 200)}`);
  }
  return response.blob();
}

export async function uploadConversionJob(params: {
  jobId: string;
  baseUrl: string;
  path: string;
}): Promise<{ ok: true; fileName: string; fileSize: number; baseUrl: string; path: string }> {
  const response = await fetch(`/api/convert/jobs/${encodeURIComponent(params.jobId)}/upload`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      baseUrl: params.baseUrl,
      path: params.path,
    }),
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Failed to upload conversion output (${response.status}): ${text.slice(0, 200)}`);
  }
  return (await response.json()) as { ok: true; fileName: string; fileSize: number; baseUrl: string; path: string };
}

export async function fetchDeviceFiles(params: {
  baseUrl: string;
  path: string;
}): Promise<{ baseUrl: string; path: string; files: DeviceFileEntry[] }> {
  const query = new URLSearchParams({
    baseUrl: params.baseUrl,
    path: params.path,
  });
  const response = await fetch(`/api/device/files?${query.toString()}`);
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Device file list failed (${response.status}): ${text.slice(0, 200)}`);
  }
  return (await response.json()) as { baseUrl: string; path: string; files: DeviceFileEntry[] };
}

export async function createDeviceFolder(params: {
  baseUrl: string;
  path: string;
  name: string;
}): Promise<void> {
  const response = await fetch("/api/device/mkdir", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(params),
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Device mkdir failed (${response.status}): ${text.slice(0, 200)}`);
  }
}

export function thumbnailUrl(id: string): string {
  return `/api/archives/${encodeURIComponent(id)}/thumbnail`;
}

export function archivePageUrl(id: string, pagePath: string): string {
  const query = new URLSearchParams({ path: pagePath });
  return `/api/archives/${encodeURIComponent(id)}/page?${query.toString()}`;
}

export function conversionFrameUrl(jobId: string, version: number): string {
  const query = new URLSearchParams({ v: String(version) });
  return `/api/convert/jobs/${encodeURIComponent(jobId)}/frame?${query.toString()}`;
}
