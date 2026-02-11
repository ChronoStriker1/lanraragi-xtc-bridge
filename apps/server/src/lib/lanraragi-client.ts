import { URL } from "node:url";
import type { ArchivePagesResponse, ArchiveRecord, SearchResponse } from "../types";

type QueryValue = string | number | boolean | undefined | null;

function makeAuthHeader(apiKey: string): string | undefined {
  if (!apiKey) return undefined;
  return `Bearer ${Buffer.from(apiKey).toString("base64")}`;
}

export class LanraragiClient {
  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
  ) {}

  private buildUrl(pathname: string, query?: Record<string, QueryValue>): string {
    const url = new URL(pathname, this.baseUrl);
    if (query) {
      for (const [key, value] of Object.entries(query)) {
        if (value === undefined || value === null || value === "") continue;
        url.searchParams.set(key, String(value));
      }
    }
    if (this.apiKey) {
      url.searchParams.set("key", this.apiKey);
    }
    return url.toString();
  }

  private async fetchJson<T>(pathname: string, query?: Record<string, QueryValue>): Promise<T> {
    const response = await fetch(this.buildUrl(pathname, query), {
      headers: {
        ...(makeAuthHeader(this.apiKey) ? { Authorization: makeAuthHeader(this.apiKey)! } : {}),
      },
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`LANraragi request failed (${response.status}): ${text.slice(0, 200)}`);
    }

    return (await response.json()) as T;
  }

  async ping(): Promise<{ name?: string; version?: string }> {
    return this.fetchJson<{ name?: string; version?: string }>("/api/info");
  }

  async searchArchives(params: {
    filter?: string;
    start?: number;
    sortby?: string;
    order?: "asc" | "desc";
    category?: string;
  }): Promise<SearchResponse> {
    return this.fetchJson<SearchResponse>("/api/search", {
      filter: params.filter ?? "",
      start: params.start ?? 0,
      sortby: params.sortby ?? "title",
      order: params.order ?? "asc",
      category: params.category ?? "",
    });
  }

  async getArchiveMetadata(id: string): Promise<ArchiveRecord> {
    return this.fetchJson<ArchiveRecord>(`/api/archives/${encodeURIComponent(id)}/metadata`);
  }

  async getArchivePages(id: string, options?: { force?: boolean }): Promise<string[]> {
    const data = await this.fetchJson<ArchivePagesResponse>(`/api/archives/${encodeURIComponent(id)}/files`, {
      force: options?.force ? "true" : "false",
    });
    return data.pages ?? [];
  }

  async getTagStats(minweight = 1): Promise<Array<{ namespace: string; text: string; weight: string }>> {
    return this.fetchJson<Array<{ namespace: string; text: string; weight: string }>>("/api/database/stats", {
      minweight,
    });
  }

  async getArchiveThumbnail(id: string): Promise<Response> {
    const response = await fetch(this.buildUrl(`/api/archives/${encodeURIComponent(id)}/thumbnail`), {
      headers: {
        ...(makeAuthHeader(this.apiKey) ? { Authorization: makeAuthHeader(this.apiKey)! } : {}),
      },
    });

    if (!response.ok) {
      throw new Error(`Thumbnail request failed (${response.status})`);
    }

    return response;
  }

  async getArchivePage(id: string, pagePath: string): Promise<Response> {
    const response = await fetch(
      this.buildUrl(`/api/archives/${encodeURIComponent(id)}/page`, {
        path: pagePath,
      }),
      {
        headers: {
          ...(makeAuthHeader(this.apiKey) ? { Authorization: makeAuthHeader(this.apiKey)! } : {}),
        },
      },
    );

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Page request failed (${response.status}): ${text.slice(0, 120)}`);
    }

    return response;
  }

  async downloadArchive(id: string): Promise<Response> {
    const response = await fetch(this.buildUrl(`/api/archives/${encodeURIComponent(id)}/download`), {
      headers: {
        ...(makeAuthHeader(this.apiKey) ? { Authorization: makeAuthHeader(this.apiKey)! } : {}),
      },
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Archive download failed (${response.status}): ${text.slice(0, 200)}`);
    }

    return response;
  }

  async downloadByPageUrl(pagePathOrUrl: string): Promise<Response> {
    const url = pagePathOrUrl.startsWith("http")
      ? new URL(pagePathOrUrl)
      : new URL(pagePathOrUrl, this.baseUrl);

    if (this.apiKey && !url.searchParams.get("key")) {
      url.searchParams.set("key", this.apiKey);
    }

    const response = await fetch(url, {
      headers: {
        ...(makeAuthHeader(this.apiKey) ? { Authorization: makeAuthHeader(this.apiKey)! } : {}),
      },
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Page fetch failed (${response.status}): ${text.slice(0, 120)}`);
    }

    return response;
  }
}
