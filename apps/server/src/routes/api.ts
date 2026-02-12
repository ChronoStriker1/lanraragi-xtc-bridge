import { Hono } from "hono";
import { readFile } from "node:fs/promises";
import { z } from "zod";
import { convertArchiveToXtc } from "../lib/conversion";
import { getConversionJob, getConversionJobFrame, startConversionJob, takeJobArtifact } from "../lib/conversion-jobs";
import { streamFileAsResponse } from "../lib/http";
import { defaultConversionSettings } from "../lib/settings";
import type { AppConfig } from "../lib/config";
import type { DeviceConnectionManager } from "../lib/device-connection";
import type { LanraragiConnectionManager } from "../lib/lanraragi-connection";
import { logError, logInfo } from "../lib/logger";
import { XteinkClient, normalizeDeviceBaseUrl, normalizeDevicePath } from "../lib/xteink-client";

const archiveQuerySchema = z.object({
  q: z.string().optional(),
  start: z.coerce.number().int().min(0).default(0),
  sortby: z.enum(["title", "progress", "lastreadtime", "size", "time_read", "date_added"]).default("title"),
  order: z.enum(["asc", "desc"]).default("asc"),
});

const facetsQuerySchema = z.object({
  namespace: z.enum(["artist", "group"]),
  q: z.string().optional(),
});

const tagSuggestQuerySchema = z.object({
  q: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(30),
});

const conversionSettingsSchema = z.object({
  orientation: z.enum(["landscape", "portrait"]).optional(),
  splitMode: z.enum(["overlap", "split", "nosplit"]).optional(),
  noDither: z.boolean().optional(),
  overlap: z.boolean().optional(),
  splitSpreads: z.string().optional(),
  splitAll: z.boolean().optional(),
  skip: z.string().optional(),
  only: z.string().optional(),
  dontSplit: z.string().optional(),
  contrastBoost: z.string().optional(),
  margin: z.string().optional(),
  includeOverviews: z.boolean().optional(),
  sidewaysOverviews: z.boolean().optional(),
  selectOverviews: z.string().optional(),
  start: z.number().nullable().optional(),
  stop: z.number().nullable().optional(),
  padBlack: z.boolean().optional(),
  hsplitCount: z.number().nullable().optional(),
  hsplitOverlap: z.number().nullable().optional(),
  hsplitMaxWidth: z.number().nullable().optional(),
  vsplitTarget: z.number().nullable().optional(),
  vsplitMinOverlap: z.number().nullable().optional(),
  sampleSet: z.string().optional(),
});

const convertBodySchema = z.object({
  settings: conversionSettingsSchema.optional(),
});

const deviceFilesQuerySchema = z.object({
  baseUrl: z.string().optional(),
  path: z.string().optional(),
});

const deviceMkdirBodySchema = z.object({
  baseUrl: z.string().optional(),
  path: z.string().optional(),
  name: z.string().min(1).max(120),
});

const uploadJobBodySchema = z.object({
  baseUrl: z.string().optional(),
  path: z.string().optional(),
});

const lanraragiSettingsBodySchema = z.object({
  baseUrl: z.string().optional(),
  apiKey: z.string().optional(),
});

const deviceSettingsBodySchema = z.object({
  baseUrl: z.string().optional(),
  path: z.string().optional(),
});

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PNG_IEND_CHUNK = Buffer.from([0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82]);

function isCompletePngBuffer(buffer: Buffer): boolean {
  if (buffer.length < PNG_SIGNATURE.length + PNG_IEND_CHUNK.length) {
    return false;
  }
  const signature = buffer.subarray(0, PNG_SIGNATURE.length);
  const tail = buffer.subarray(buffer.length - PNG_IEND_CHUNK.length);
  return signature.equals(PNG_SIGNATURE) && tail.equals(PNG_IEND_CHUNK);
}

function resolveSettings(input?: z.infer<typeof conversionSettingsSchema>) {
  return {
    ...defaultConversionSettings,
    ...(input ?? {}),
  };
}

export function createApiRouter(
  config: AppConfig,
  lanraragi: LanraragiConnectionManager,
  device: DeviceConnectionManager,
): Hono {
  const app = new Hono();
  const facetCache = new Map<"artist" | "group", { at: number; items: Array<{ name: string; count: number }> }>();
  let tagCache: { at: number; items: string[] } | null = null;
  const FACET_CACHE_MS = 5 * 60 * 1000;
  const TAG_CACHE_MS = 5 * 60 * 1000;
  let cacheVersion = lanraragi.getVersion();

  const ensureCachesFresh = () => {
    const currentVersion = lanraragi.getVersion();
    if (currentVersion === cacheVersion) return;
    facetCache.clear();
    tagCache = null;
    cacheVersion = currentVersion;
  };

  app.get("/health", async (c) => {
    try {
      const info = await lanraragi.getClient().ping();
      return c.json({ ok: true, lanraragi: info });
    } catch (error) {
      return c.json(
        {
          ok: false,
          error: error instanceof Error ? error.message : "Unknown error",
        },
        500,
      );
    }
  });

  app.get("/settings/defaults", (c) => {
    return c.json({ settings: defaultConversionSettings });
  });

  app.get("/lanraragi/settings", (c) => {
    return c.json({
      settings: lanraragi.getSettings(),
    });
  });

  app.post("/lanraragi/settings", async (c) => {
    const bodyJson = await c.req.json().catch(() => ({}));
    const parsed = lanraragiSettingsBodySchema.safeParse(bodyJson);
    if (!parsed.success) {
      return c.json({ error: parsed.error.flatten() }, 400);
    }

    const hasAnySetting = parsed.data.baseUrl !== undefined || parsed.data.apiKey !== undefined;
    if (!hasAnySetting) {
      return c.json({ error: "No LANraragi settings provided." }, 400);
    }

    let settings: ReturnType<LanraragiConnectionManager["getSettings"]>;
    try {
      settings = lanraragi.updateSettings({
        baseUrl: parsed.data.baseUrl,
        apiKey: parsed.data.apiKey,
      });
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : "Invalid LANraragi settings." }, 400);
    }
    ensureCachesFresh();

    return c.json({
      ok: true,
      settings,
    });
  });

  app.get("/device/defaults", (c) => {
    const settings = device.getSettings();
    return c.json(settings);
  });

  app.get("/device/settings", (c) => {
    return c.json({
      settings: device.getSettings(),
    });
  });

  app.post("/device/settings", async (c) => {
    const bodyJson = await c.req.json().catch(() => ({}));
    const parsed = deviceSettingsBodySchema.safeParse(bodyJson);
    if (!parsed.success) {
      return c.json({ error: parsed.error.flatten() }, 400);
    }

    const hasAnySetting = parsed.data.baseUrl !== undefined || parsed.data.path !== undefined;
    if (!hasAnySetting) {
      return c.json({ error: "No device settings provided." }, 400);
    }

    let settings: ReturnType<DeviceConnectionManager["getSettings"]>;
    try {
      settings = device.updateSettings({
        baseUrl: parsed.data.baseUrl,
        path: parsed.data.path,
      });
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : "Invalid device settings." }, 400);
    }

    return c.json({
      ok: true,
      settings,
    });
  });

  app.get("/device/files", async (c) => {
    const parsed = deviceFilesQuerySchema.safeParse(c.req.query());
    if (!parsed.success) {
      return c.json({ error: parsed.error.flatten() }, 400);
    }

    const defaults = device.getSettings();
    let baseUrl: string;
    try {
      baseUrl = normalizeDeviceBaseUrl(parsed.data.baseUrl || defaults.baseUrl);
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : "Invalid device URL" }, 400);
    }
    const devicePath = normalizeDevicePath(parsed.data.path || defaults.path);
    const client = new XteinkClient(baseUrl);
    const files = await client.listFiles(devicePath);
    return c.json({
      baseUrl,
      path: devicePath,
      files,
    });
  });

  app.post("/device/mkdir", async (c) => {
    const bodyJson = await c.req.json().catch(() => ({}));
    const parsed = deviceMkdirBodySchema.safeParse(bodyJson);
    if (!parsed.success) {
      return c.json({ error: parsed.error.flatten() }, 400);
    }

    const defaults = device.getSettings();
    let baseUrl: string;
    try {
      baseUrl = normalizeDeviceBaseUrl(parsed.data.baseUrl || defaults.baseUrl);
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : "Invalid device URL" }, 400);
    }
    const devicePath = normalizeDevicePath(parsed.data.path || defaults.path);
    const client = new XteinkClient(baseUrl);
    await client.createFolder(devicePath, parsed.data.name);

    return c.json({
      ok: true,
      baseUrl,
      path: devicePath,
      name: parsed.data.name.trim(),
    });
  });

  app.get("/archives", async (c) => {
    ensureCachesFresh();
    const parsed = archiveQuerySchema.safeParse(c.req.query());
    if (!parsed.success) {
      return c.json({ error: parsed.error.flatten() }, 400);
    }

    const data = await lanraragi.getClient().searchArchives({
      filter: parsed.data.q ?? "",
      start: parsed.data.start,
      sortby: parsed.data.sortby,
      order: parsed.data.order,
    });

    return c.json(data);
  });

  app.get("/facets", async (c) => {
    ensureCachesFresh();
    const parsed = facetsQuerySchema.safeParse(c.req.query());
    if (!parsed.success) {
      return c.json({ error: parsed.error.flatten() }, 400);
    }

    const namespace = parsed.data.namespace;
    const now = Date.now();
    const cached = facetCache.get(namespace);

    let items: Array<{ name: string; count: number }>;
    if (cached && now - cached.at < FACET_CACHE_MS) {
      items = cached.items;
    } else {
      const stats = await lanraragi.getClient().getTagStats(1);
      items = stats
        .filter((entry) => entry.namespace === namespace)
        .map((entry) => ({
          name: entry.text,
          count: Number(entry.weight) || 0,
        }))
        .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
      facetCache.set(namespace, { at: now, items });
    }

    const q = (parsed.data.q || "").trim().toLowerCase();
    const filtered = q ? items.filter((item) => item.name.toLowerCase().includes(q)) : items;

    return c.json({
      namespace,
      total: filtered.length,
      data: filtered,
    });
  });

  app.get("/tags/suggest", async (c) => {
    ensureCachesFresh();
    const parsed = tagSuggestQuerySchema.safeParse(c.req.query());
    if (!parsed.success) {
      return c.json({ error: parsed.error.flatten() }, 400);
    }

    const now = Date.now();
    let items: string[];
    if (tagCache && now - tagCache.at < TAG_CACHE_MS) {
      items = tagCache.items;
    } else {
      const stats = await lanraragi.getClient().getTagStats(1);
      items = stats
        .map((entry) => (entry.namespace ? `${entry.namespace}:${entry.text}` : entry.text))
        .filter((value) => value.trim().length > 0)
        .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
      tagCache = { at: now, items };
    }

    const q = (parsed.data.q || "").trim().toLowerCase();
    let filtered = items;
    if (q) {
      const startsWith = items.filter((item) => item.toLowerCase().startsWith(q));
      const includes = items.filter((item) => !item.toLowerCase().startsWith(q) && item.toLowerCase().includes(q));
      filtered = [...startsWith, ...includes];
    }

    return c.json({
      total: filtered.length,
      data: filtered.slice(0, parsed.data.limit),
    });
  });

  app.get("/archives/:id/thumbnail", async (c) => {
    ensureCachesFresh();
    const id = c.req.param("id");
    if (!id) return c.json({ error: "Missing archive id" }, 400);

    const response = await lanraragi.getClient().getArchiveThumbnail(id);
    return new Response(response.body, {
      status: 200,
      headers: {
        "content-type": response.headers.get("content-type") || "image/jpeg",
        "cache-control": "public, max-age=300",
      },
    });
  });

  app.get("/archives/:id/page", async (c) => {
    ensureCachesFresh();
    const id = c.req.param("id");
    if (!id) return c.json({ error: "Missing archive id" }, 400);
    const pagePath = c.req.query("path");
    if (!pagePath) return c.json({ error: "Missing page path" }, 400);

    const response = await lanraragi.getClient().getArchivePage(id, pagePath);
    return new Response(response.body, {
      status: 200,
      headers: {
        "content-type": response.headers.get("content-type") || "image/jpeg",
        "cache-control": "no-store",
      },
    });
  });

  app.get("/archives/:id", async (c) => {
    ensureCachesFresh();
    const id = c.req.param("id");
    const metadata = await lanraragi.getClient().getArchiveMetadata(id);
    return c.json(metadata);
  });

  app.post("/convert/:id", async (c) => {
    const id = c.req.param("id");
    if (!id) return c.json({ error: "Missing archive id" }, 400);

    const bodyJson = await c.req.json().catch(() => ({}));
    const parsedBody = convertBodySchema.safeParse(bodyJson);
    if (!parsedBody.success) {
      return c.json({ error: parsedBody.error.flatten() }, 400);
    }

    const settings = resolveSettings(parsedBody.data.settings);
    logInfo(`convert request id=${id} splitMode=${settings.splitMode} orientation=${settings.orientation}`);

    const artifact = await convertArchiveToXtc({
      config,
      lrr: lanraragi.getClient(),
      archiveId: id,
      settings,
    });
    return streamFileAsResponse({
      filePath: artifact.filePath,
      downloadName: artifact.downloadName,
      contentType: "application/octet-stream",
      onDone: () => {
        void artifact.dispose();
      },
    });
  });

  app.post("/convert/:id/start", async (c) => {
    const id = c.req.param("id");
    if (!id) return c.json({ error: "Missing archive id" }, 400);

    const bodyJson = await c.req.json().catch(() => ({}));
    const parsedBody = convertBodySchema.safeParse(bodyJson);
    if (!parsedBody.success) {
      return c.json({ error: parsedBody.error.flatten() }, 400);
    }

    const settings = resolveSettings(parsedBody.data.settings);
    const job = startConversionJob({
      config,
      lrr: lanraragi.getClient(),
      archiveId: id,
      settings,
    });

    return c.json({ job });
  });

  app.get("/convert/jobs/:jobId", (c) => {
    const jobId = c.req.param("jobId");
    if (!jobId) return c.json({ error: "Missing job id" }, 400);

    const job = getConversionJob(jobId);
    if (!job) return c.json({ error: "Job not found" }, 404);

    try {
      // Ensure response is always JSON-serializable even under concurrent updates.
      const safeJob = JSON.parse(JSON.stringify(job));
      return c.json({ job: safeJob });
    } catch (error) {
      logError(
        `job snapshot serialization failed jobId=${jobId} ${error instanceof Error ? error.message : String(error)}`,
      );
      return c.json({ error: "Job snapshot unavailable, retry shortly." }, 503);
    }
  });

  app.get("/convert/jobs/:jobId/frame", async (c) => {
    const jobId = c.req.param("jobId");
    if (!jobId) return c.json({ error: "Missing job id" }, 400);

    const frame = await getConversionJobFrame(jobId);
    if (!frame) {
      return c.json({ error: "Frame not available" }, 404);
    }

    const buffer = await readFile(frame.filePath).catch(() => null);
    if (!buffer || !isCompletePngBuffer(buffer)) {
      return c.json({ error: "Frame not available" }, 404);
    }

    return new Response(buffer, {
      headers: {
        "content-type": "image/png",
        "content-length": String(buffer.length),
        "cache-control": "no-store",
      },
    });
  });

  app.get("/convert/jobs/:jobId/download", (c) => {
    const jobId = c.req.param("jobId");
    if (!jobId) return c.json({ error: "Missing job id" }, 400);

    const artifact = takeJobArtifact(jobId);
    if (!artifact) {
      return c.json({ error: "Job is not ready for download" }, 409);
    }

    return streamFileAsResponse({
      filePath: artifact.filePath,
      downloadName: artifact.downloadName,
      contentType: "application/octet-stream",
      onDone: () => {
        void artifact.dispose();
      },
    });
  });

  app.post("/convert/jobs/:jobId/upload", async (c) => {
    const jobId = c.req.param("jobId");
    if (!jobId) return c.json({ error: "Missing job id" }, 400);

    const bodyJson = await c.req.json().catch(() => ({}));
    const parsedBody = uploadJobBodySchema.safeParse(bodyJson);
    if (!parsedBody.success) {
      return c.json({ error: parsedBody.error.flatten() }, 400);
    }

    const artifact = takeJobArtifact(jobId);
    if (!artifact) {
      return c.json({ error: "Job is not ready for upload" }, 409);
    }

    let baseUrl: string;
    const defaults = device.getSettings();
    try {
      baseUrl = normalizeDeviceBaseUrl(parsedBody.data.baseUrl || defaults.baseUrl);
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : "Invalid device URL" }, 400);
    }
    const devicePath = normalizeDevicePath(parsedBody.data.path || defaults.path);
    const deviceClient = new XteinkClient(baseUrl);
    const uploadStartAt = Date.now();
    const artifactName = artifact.downloadName || `${jobId}.xtc`;
    logInfo(
      `upload start job=${jobId} file=${artifactName} size=${artifact.fileSize} target=${baseUrl}${devicePath}`,
    );

    try {
      await deviceClient.uploadFile({
        filePath: artifact.filePath,
        fileName: artifactName,
        targetPath: devicePath,
      });
      const elapsedMs = Date.now() - uploadStartAt;
      logInfo(
        `upload done job=${jobId} file=${artifactName} size=${artifact.fileSize} target=${baseUrl}${devicePath} elapsed_ms=${elapsedMs}`,
      );
      return c.json({
        ok: true,
        baseUrl,
        path: devicePath,
        fileName: artifactName,
        fileSize: artifact.fileSize,
      });
    } catch (error) {
      const elapsedMs = Date.now() - uploadStartAt;
      logError(
        `upload failed job=${jobId} file=${artifactName} size=${artifact.fileSize} target=${baseUrl}${devicePath} elapsed_ms=${elapsedMs} error=${
          error instanceof Error ? error.message : "Unknown upload error"
        }`,
      );
      throw error;
    } finally {
      await artifact.dispose();
    }
  });

  return app;
}
