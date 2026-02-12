import { Hono } from "hono";
import { z } from "zod";
import { readFile } from "node:fs/promises";
import { convertArchiveToXtc } from "../lib/conversion";
import type { AppConfig } from "../lib/config";
import { defaultConversionSettings } from "../lib/settings";
import type { LanraragiConnectionManager } from "../lib/lanraragi-connection";
import { opdsDateFromUnix, xmlEscape } from "../lib/xml";
import type { ArchiveRecord } from "../types";

const listQuerySchema = z.object({
  q: z.string().optional(),
  title: z.string().optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(10).max(100).default(30),
  sortby: z.enum(["title", "progress", "lastreadtime", "size", "time_read", "date_added"]).default("title"),
  order: z.enum(["asc", "desc"]).default("asc"),
});

const facetQuerySchema = z.object({
  letter: z.string().optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(10).max(100).default(40),
});

const titleBrowseQuerySchema = z.object({
  dir: z.enum(["asc", "desc"]).default("asc"),
  letter: z.string().optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(10).max(100).default(30),
});

const facetNamespaceSchema = z.enum(["artist", "group"]);

const FACET_CACHE_MS = 5 * 60 * 1000;
const TITLE_CACHE_MS = 15 * 60 * 1000;
const LETTER_BUCKETS = ["0-9", ...Array.from("ABCDEFGHIJKLMNOPQRSTUVWXYZ"), "#"];

type FacetNamespace = z.infer<typeof facetNamespaceSchema>;
type FacetItem = {
  name: string;
  count: number;
  bucket: string;
};

type TitleBrowseDir = "asc" | "desc";
type TitleBucketCache = {
  at: number;
  nextStart: number;
  total: number;
  done: boolean;
  buckets: Record<string, ArchiveRecord[]>;
};

function qs(input: Record<string, string | number | undefined>): string {
  const u = new URLSearchParams();
  for (const [k, v] of Object.entries(input)) {
    if (v === undefined || v === "") continue;
    u.set(k, String(v));
  }
  const rendered = u.toString();
  return rendered ? `?${rendered}` : "";
}

function baseUrl(config: AppConfig): string {
  return config.SERVER_PUBLIC_URL.replace(/\/+$/g, "");
}

function renderFeed(params: {
  id: string;
  title: string;
  selfHref: string;
  subtitle?: string;
  entries: string[];
}): string {
  const updated = new Date().toISOString();
  return `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom" xmlns:opds="http://opds-spec.org/2010/catalog">
  <id>${xmlEscape(params.id)}</id>
  <title>${xmlEscape(params.title)}</title>
  <updated>${updated}</updated>
  <author><name>lanraragi-xtc-bridge</name></author>
  <link rel="self" type="application/atom+xml;profile=opds-catalog" href="${xmlEscape(params.selfHref)}"/>
  ${params.subtitle ? `<subtitle>${xmlEscape(params.subtitle)}</subtitle>` : ""}
  ${params.entries.join("\n")}
</feed>`;
}

function renderNavigationEntry(params: {
  id: string;
  title: string;
  href: string;
  summary?: string;
}): string {
  return `<entry>
    <id>${xmlEscape(params.id)}</id>
    <title>${xmlEscape(params.title)}</title>
    <updated>${new Date().toISOString()}</updated>
    ${params.summary ? `<summary>${xmlEscape(params.summary)}</summary>` : ""}
    <link rel="subsection" type="application/atom+xml;profile=opds-catalog;kind=navigation" href="${xmlEscape(params.href)}"/>
  </entry>`;
}

function renderArchiveEntry(config: AppConfig, arc: ArchiveRecord): string {
  const id = encodeURIComponent(arc.arcid);
  const title = xmlEscape(arc.title || arc.filename || arc.arcid);
  const summary = xmlEscape(arc.summary || "");
  const tags = xmlEscape(arc.tags || "");
  const thumb = `/api/archives/${id}/thumbnail`;
  const download = `/opds/download/${id}`;
  const updatedAt = opdsDateFromUnix(arc.lastreadtime);

  return `<entry>
    <id>${xmlEscape(baseUrl(config))}/opds/item/${id}</id>
    <title>${title}</title>
    <updated>${updatedAt}</updated>
    <summary>${summary}</summary>
    <category term="tags" label="${tags}"/>
    <link rel="http://opds-spec.org/image/thumbnail" type="image/jpeg" href="${xmlEscape(thumb)}"/>
    <link rel="http://opds-spec.org/acquisition" type="application/epub+zip" href="${xmlEscape(download)}"/>
    <link rel="http://opds-spec.org/acquisition" type="application/octet-stream" href="${xmlEscape(download)}"/>
  </entry>`;
}

function resolveDownloadArchiveId(path: string, rawParamId?: string): string | null {
  const direct = (rawParamId ?? "").trim().replace(/\.xtc$/i, "");
  if (direct) return decodeURIComponent(direct);

  const m = path.match(/\/download\/([^/]+?)(?:\.xtc)?$/i);
  if (!m || !m[1]) return null;
  return decodeURIComponent(m[1]);
}

function bucketForFacetName(name: string): string {
  const first = name.trim().charAt(0).toUpperCase();
  if (!first) return "#";
  if (first >= "A" && first <= "Z") return first;
  if (first >= "0" && first <= "9") return "0-9";
  return "#";
}

function normalizeBucket(input?: string): string | undefined {
  if (!input) return undefined;
  const value = input.trim().toUpperCase();
  if (value === "0-9" || value === "#") return value;
  if (value.length === 1 && value >= "A" && value <= "Z") return value;
  if (value.length === 1 && value >= "0" && value <= "9") return "0-9";
  return undefined;
}

function titleBucketOrder(dir: TitleBrowseDir): string[] {
  const letters = Array.from("ABCDEFGHIJKLMNOPQRSTUVWXYZ");
  return dir === "desc" ? ["0-9", ...letters.reverse(), "#"] : ["0-9", ...letters, "#"];
}

async function renderArchiveListFeed(params: {
  config: AppConfig;
  lanraragi: LanraragiConnectionManager;
  feedPath: string;
  q?: string;
  title?: string;
  page: number;
  pageSize: number;
  sortby: "title" | "progress" | "lastreadtime" | "size" | "time_read" | "date_added";
  order: "asc" | "desc";
  includeHomeLink?: boolean;
}): Promise<string> {
  const start = (params.page - 1) * params.pageSize;
  const result = await params.lanraragi.getClient().searchArchives({
    filter: params.q ?? "",
    start,
    sortby: params.sortby,
    order: params.order,
  });

  const archives = result.data.slice(0, params.pageSize);
  const hasNext = start + archives.length < result.recordsFiltered;
  const listingTitle = params.title?.trim() || (params.q ? `Results: ${params.q}` : "Archives");

  const entries: string[] = [];
  if (params.includeHomeLink) {
    entries.push(
      renderNavigationEntry({
        id: `${baseUrl(params.config)}${params.feedPath}#home`,
        title: "Back to OPDS Home",
        href: "/opds",
      }),
    );
  }
  if (params.page > 1) {
    entries.push(
      renderNavigationEntry({
        id: `${baseUrl(params.config)}${params.feedPath}#prev-${params.page - 1}`,
        title: "Previous Page",
        href: `${params.feedPath}${qs({
          q: params.q,
          title: params.title,
          page: params.page - 1,
          pageSize: params.pageSize,
          sortby: params.sortby,
          order: params.order,
        })}`,
      }),
    );
  }
  if (hasNext) {
    entries.push(
      renderNavigationEntry({
        id: `${baseUrl(params.config)}${params.feedPath}#next-${params.page + 1}`,
        title: "Next Page",
        href: `${params.feedPath}${qs({
          q: params.q,
          title: params.title,
          page: params.page + 1,
          pageSize: params.pageSize,
          sortby: params.sortby,
          order: params.order,
        })}`,
      }),
    );
  }
  entries.push(...archives.map((arc) => renderArchiveEntry(params.config, arc)));

  return renderFeed({
    id: `${baseUrl(params.config)}${params.feedPath}`,
    title: listingTitle,
    selfHref: `${baseUrl(params.config)}${params.feedPath}${qs({
      q: params.q,
      title: params.title,
      page: params.page,
      pageSize: params.pageSize,
      sortby: params.sortby,
      order: params.order,
    })}`,
    subtitle: `Total ${result.recordsFiltered} archives. Page ${params.page}. Sorted by ${params.sortby} ${params.order}.`,
    entries,
  });
}

export function createOpdsRouter(config: AppConfig, lanraragi: LanraragiConnectionManager): Hono {
  const app = new Hono();
  const facetCache = new Map<FacetNamespace, { at: number; items: FacetItem[] }>();
  const titleCacheByDir: Record<TitleBrowseDir, TitleBucketCache | null> = {
    asc: null,
    desc: null,
  };

  const createEmptyTitleBuckets = (): Record<string, ArchiveRecord[]> =>
    Object.fromEntries(LETTER_BUCKETS.map((bucket) => [bucket, []])) as Record<string, ArchiveRecord[]>;

  const getOrResetTitleCache = (dir: TitleBrowseDir): TitleBucketCache => {
    const now = Date.now();
    const existing = titleCacheByDir[dir];
    if (existing && now - existing.at < TITLE_CACHE_MS) {
      return existing;
    }
    const next: TitleBucketCache = {
      at: now,
      nextStart: 0,
      total: Number.POSITIVE_INFINITY,
      done: false,
      buckets: createEmptyTitleBuckets(),
    };
    titleCacheByDir[dir] = next;
    return next;
  };

  const fillOneTitleChunk = async (dir: TitleBrowseDir): Promise<void> => {
    const cache = getOrResetTitleCache(dir);
    if (cache.done) return;

    const result = await lanraragi.getClient().searchArchives({
      filter: "",
      start: cache.nextStart,
      sortby: "title",
      order: dir,
    });
    cache.total = result.recordsFiltered;

    if (!result.data.length) {
      cache.done = true;
      cache.at = Date.now();
      return;
    }

    for (const arc of result.data) {
      const name = arc.title || arc.filename || "";
      const bucket = bucketForFacetName(name);
      if (!cache.buckets[bucket]) {
        cache.buckets[bucket] = [];
      }
      cache.buckets[bucket].push(arc);
    }

    cache.nextStart += result.data.length;
    if (cache.nextStart >= cache.total) {
      cache.done = true;
    }
    cache.at = Date.now();
  };

  const ensureTitleBucketItems = async (params: {
    dir: TitleBrowseDir;
    bucket: string;
    needed: number;
  }): Promise<{ items: ArchiveRecord[]; done: boolean }> => {
    const cache = getOrResetTitleCache(params.dir);
    while ((cache.buckets[params.bucket]?.length ?? 0) < params.needed && !cache.done) {
      await fillOneTitleChunk(params.dir);
    }
    return {
      items: cache.buckets[params.bucket] ?? [],
      done: cache.done,
    };
  };

  const getFacetItems = async (namespace: FacetNamespace): Promise<FacetItem[]> => {
    const now = Date.now();
    const cached = facetCache.get(namespace);
    if (cached && now - cached.at < FACET_CACHE_MS) {
      return cached.items;
    }

    const stats = await lanraragi.getClient().getTagStats(1);
    const merged = new Map<string, { name: string; count: number }>();
    for (const row of stats) {
      if (row.namespace.toLowerCase() !== namespace) continue;
      const name = row.text.trim();
      if (!name) continue;
      const key = name.toLowerCase();
      const count = Number.parseInt(row.weight, 10);
      const existing = merged.get(key);
      if (!existing) {
        merged.set(key, { name, count: Number.isFinite(count) ? count : 0 });
      } else {
        existing.count += Number.isFinite(count) ? count : 0;
      }
    }

    const items: FacetItem[] = Array.from(merged.values())
      .map((item) => ({
        name: item.name,
        count: item.count,
        bucket: bucketForFacetName(item.name),
      }))
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base", numeric: true }));

    facetCache.set(namespace, { at: now, items });
    return items;
  };

  app.get("/", async (c) => {
    const raw = c.req.query();
    const shouldRenderLegacyListing =
      raw.q !== undefined ||
      raw.page !== undefined ||
      raw.pageSize !== undefined ||
      raw.sortby !== undefined ||
      raw.order !== undefined ||
      raw.title !== undefined;

    if (shouldRenderLegacyListing) {
      const parsedList = listQuerySchema.safeParse(raw);
      if (!parsedList.success) {
        return c.text("Invalid query", 400);
      }

      const body = await renderArchiveListFeed({
        config,
        lanraragi,
        feedPath: "/opds",
        q: parsedList.data.q,
        title: parsedList.data.title,
        page: parsedList.data.page,
        pageSize: parsedList.data.pageSize,
        sortby: parsedList.data.sortby,
        order: parsedList.data.order,
      });

      return c.body(body, 200, {
        "content-type": "application/atom+xml; charset=utf-8",
        "cache-control": "no-store",
      });
    }

    const body = renderFeed({
      id: `${baseUrl(config)}/opds`,
      title: "LANraragi XTC Catalog",
      selfHref: `${baseUrl(config)}/opds`,
      subtitle: "Browse with navigation-first feeds optimized for XTEink.",
      entries: [
        renderNavigationEntry({
          id: `${baseUrl(config)}/opds/nav/recent`,
          title: "Recently Added",
          summary: "Newest archives first",
          href: `/opds/list${qs({
            title: "Recently Added",
            page: 1,
            pageSize: 30,
            sortby: "date_added",
            order: "desc",
          })}`,
        }),
        renderNavigationEntry({
          id: `${baseUrl(config)}/opds/nav/title-asc`,
          title: "Titles A-Z",
          href: `/opds/titles${qs({
            dir: "asc",
            page: 1,
            pageSize: 30,
          })}`,
        }),
        renderNavigationEntry({
          id: `${baseUrl(config)}/opds/nav/title-desc`,
          title: "Titles Z-A",
          href: `/opds/titles${qs({
            dir: "desc",
            page: 1,
            pageSize: 30,
          })}`,
        }),
        renderNavigationEntry({
          id: `${baseUrl(config)}/opds/nav/artists`,
          title: "Browse by Artist",
          href: "/opds/facets/artist",
        }),
        renderNavigationEntry({
          id: `${baseUrl(config)}/opds/nav/groups`,
          title: "Browse by Group",
          href: "/opds/facets/group",
        }),
      ],
    });

    return c.body(body, 200, {
      "content-type": "application/atom+xml; charset=utf-8",
      "cache-control": "no-store",
    });
  });

  app.get("/list", async (c) => {
    const parsed = listQuerySchema.safeParse(c.req.query());
    if (!parsed.success) {
      return c.text("Invalid query", 400);
    }

    const body = await renderArchiveListFeed({
      config,
      lanraragi,
      feedPath: "/opds/list",
      q: parsed.data.q,
      title: parsed.data.title,
      page: parsed.data.page,
      pageSize: parsed.data.pageSize,
      sortby: parsed.data.sortby,
      order: parsed.data.order,
      includeHomeLink: true,
    });

    return c.body(body, 200, {
      "content-type": "application/atom+xml; charset=utf-8",
      "cache-control": "no-store",
    });
  });

  app.get("/titles", async (c) => {
    const parsed = titleBrowseQuerySchema.safeParse(c.req.query());
    if (!parsed.success) {
      return c.text("Invalid query", 400);
    }

    const dir = parsed.data.dir;
    const letter = normalizeBucket(parsed.data.letter);
    const orderLabel = dir === "desc" ? "Z-A" : "A-Z";

    if (!letter) {
      const entries: string[] = [
        renderNavigationEntry({
          id: `${baseUrl(config)}/opds/titles#home`,
          title: "Back to OPDS Home",
          href: "/opds",
        }),
      ];

      for (const bucket of titleBucketOrder(dir)) {
        entries.push(
          renderNavigationEntry({
            id: `${baseUrl(config)}/opds/titles#${dir}-${bucket}`,
            title: bucket,
            href: `/opds/titles${qs({
              dir,
              letter: bucket,
              page: 1,
              pageSize: parsed.data.pageSize,
            })}`,
          }),
        );
      }

      const body = renderFeed({
        id: `${baseUrl(config)}/opds/titles${qs({ dir })}`,
        title: `Titles ${orderLabel}`,
        selfHref: `${baseUrl(config)}/opds/titles${qs({ dir })}`,
        subtitle: "Choose a letter section.",
        entries,
      });
      return c.body(body, 200, {
        "content-type": "application/atom+xml; charset=utf-8",
        "cache-control": "no-store",
      });
    }

    const page = parsed.data.page;
    const pageSize = parsed.data.pageSize;
    const start = (page - 1) * pageSize;
    const needed = start + pageSize + 1;
    const { items, done } = await ensureTitleBucketItems({
      dir,
      bucket: letter,
      needed,
    });
    const pageItems = items.slice(start, start + pageSize);
    const hasNext = items.length > start + pageSize || !done;

    const entries: string[] = [
      renderNavigationEntry({
        id: `${baseUrl(config)}/opds/titles#letters-${dir}`,
        title: `Back to Titles ${orderLabel}`,
        href: `/opds/titles${qs({ dir, page: 1, pageSize })}`,
      }),
    ];

    if (page > 1) {
      entries.push(
        renderNavigationEntry({
          id: `${baseUrl(config)}/opds/titles#prev-${dir}-${letter}-${page - 1}`,
          title: "Previous Page",
          href: `/opds/titles${qs({ dir, letter, page: page - 1, pageSize })}`,
        }),
      );
    }
    if (hasNext) {
      entries.push(
        renderNavigationEntry({
          id: `${baseUrl(config)}/opds/titles#next-${dir}-${letter}-${page + 1}`,
          title: "Next Page",
          href: `/opds/titles${qs({ dir, letter, page: page + 1, pageSize })}`,
        }),
      );
    }

    entries.push(...pageItems.map((arc) => renderArchiveEntry(config, arc)));

    const body = renderFeed({
      id: `${baseUrl(config)}/opds/titles${qs({ dir, letter, page, pageSize })}`,
      title: `Titles ${orderLabel}: ${letter}`,
      selfHref: `${baseUrl(config)}/opds/titles${qs({ dir, letter, page, pageSize })}`,
      subtitle: `${orderLabel} order by title. Section ${letter}. Page ${page}.`,
      entries,
    });

    return c.body(body, 200, {
      "content-type": "application/atom+xml; charset=utf-8",
      "cache-control": "no-store",
    });
  });

  app.get("/facets/:namespace", async (c) => {
    const parsedNamespace = facetNamespaceSchema.safeParse(c.req.param("namespace"));
    if (!parsedNamespace.success) {
      return c.text("Invalid namespace", 400);
    }
    const namespace = parsedNamespace.data;

    const parsed = facetQuerySchema.safeParse(c.req.query());
    if (!parsed.success) {
      return c.text("Invalid query", 400);
    }

    const letter = normalizeBucket(parsed.data.letter);
    const titleBase = namespace === "artist" ? "Artists" : "Groups";
    const items = await getFacetItems(namespace);

    if (!letter) {
      const counts = new Map<string, number>(LETTER_BUCKETS.map((bucket) => [bucket, 0]));
      for (const item of items) {
        counts.set(item.bucket, (counts.get(item.bucket) ?? 0) + 1);
      }

      const entries: string[] = [
        renderNavigationEntry({
          id: `${baseUrl(config)}/opds/facets/${namespace}#home`,
          title: "Back to OPDS Home",
          href: "/opds",
        }),
      ];

      for (const bucket of LETTER_BUCKETS) {
        const count = counts.get(bucket) ?? 0;
        if (count === 0) continue;
        entries.push(
          renderNavigationEntry({
            id: `${baseUrl(config)}/opds/facets/${namespace}#${bucket}`,
            title: `${bucket} (${count})`,
            href: `/opds/facets/${namespace}${qs({ letter: bucket, page: 1, pageSize: 40 })}`,
          }),
        );
      }

      const body = renderFeed({
        id: `${baseUrl(config)}/opds/facets/${namespace}`,
        title: `${titleBase} (A-Z)`,
        selfHref: `${baseUrl(config)}/opds/facets/${namespace}`,
        subtitle: `Choose a letter bucket. ${items.length} total ${titleBase.toLowerCase()}.`,
        entries,
      });

      return c.body(body, 200, {
        "content-type": "application/atom+xml; charset=utf-8",
        "cache-control": "no-store",
      });
    }

    const filtered = items.filter((item) => item.bucket === letter);
    const start = (parsed.data.page - 1) * parsed.data.pageSize;
    const pageItems = filtered.slice(start, start + parsed.data.pageSize);
    const hasNext = start + pageItems.length < filtered.length;

    const entries: string[] = [
      renderNavigationEntry({
        id: `${baseUrl(config)}/opds/facets/${namespace}#letters`,
        title: `Back to ${titleBase} A-Z`,
        href: `/opds/facets/${namespace}`,
      }),
    ];

    if (parsed.data.page > 1) {
      entries.push(
        renderNavigationEntry({
          id: `${baseUrl(config)}/opds/facets/${namespace}#prev-${letter}-${parsed.data.page - 1}`,
          title: "Previous Page",
          href: `/opds/facets/${namespace}${qs({
            letter,
            page: parsed.data.page - 1,
            pageSize: parsed.data.pageSize,
          })}`,
        }),
      );
    }
    if (hasNext) {
      entries.push(
        renderNavigationEntry({
          id: `${baseUrl(config)}/opds/facets/${namespace}#next-${letter}-${parsed.data.page + 1}`,
          title: "Next Page",
          href: `/opds/facets/${namespace}${qs({
            letter,
            page: parsed.data.page + 1,
            pageSize: parsed.data.pageSize,
          })}`,
        }),
      );
    }

    for (const facet of pageItems) {
      entries.push(
        renderNavigationEntry({
          id: `${baseUrl(config)}/opds/facets/${namespace}/${encodeURIComponent(facet.name)}`,
          title: `${facet.name} (${facet.count})`,
          href: `/opds/list${qs({
            q: `${namespace}:${facet.name}`,
            title: `${titleBase.slice(0, -1)}: ${facet.name}`,
            page: 1,
            pageSize: 30,
            sortby: "title",
            order: "asc",
          })}`,
        }),
      );
    }

    const body = renderFeed({
      id: `${baseUrl(config)}/opds/facets/${namespace}${qs({
        letter,
        page: parsed.data.page,
        pageSize: parsed.data.pageSize,
      })}`,
      title: `${titleBase}: ${letter}`,
      selfHref: `${baseUrl(config)}/opds/facets/${namespace}${qs({
        letter,
        page: parsed.data.page,
        pageSize: parsed.data.pageSize,
      })}`,
      subtitle: `${filtered.length} ${titleBase.toLowerCase()} in bucket ${letter}. Page ${parsed.data.page}.`,
      entries,
    });

    return c.body(body, 200, {
      "content-type": "application/atom+xml; charset=utf-8",
      "cache-control": "no-store",
    });
  });

  const handleDownload = async (c: any) => {
    const id = resolveDownloadArchiveId(c.req.path, c.req.param("id"));
    if (!id) return c.text("Missing archive id", 400);

    const artifact = await convertArchiveToXtc({
      config,
      lrr: lanraragi.getClient(),
      archiveId: id,
      settings: defaultConversionSettings,
    });
    const fileBuffer = await readFile(artifact.filePath);
    const fileBytes = new Uint8Array(fileBuffer);
    await artifact.dispose();

    c.header("content-type", "application/octet-stream");
    c.header("content-length", String(fileBytes.byteLength));
    c.header("content-disposition", `attachment; filename="${artifact.downloadName}"`);
    c.header("cache-control", "no-store");
    return c.body(fileBytes);
  };

  app.get("/download/:id", handleDownload);
  app.get("/download/:id.xtc", handleDownload);

  return app;
}
