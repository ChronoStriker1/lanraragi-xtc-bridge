import { randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import type { AppConfig } from "./config";
import { convertArchiveToXtc, type ConversionArtifact, type ConversionProgressEvent } from "./conversion";
import { LanraragiClient } from "./lanraragi-client";
import type { ConversionSettings } from "../types";
import { logError } from "./logger";

type JobStatus = "queued" | "running" | "completed" | "failed";

type JobPage = {
  label: string;
  done: boolean;
};

export type ConversionJobSnapshot = {
  jobId: string;
  archiveId: string;
  status: JobStatus;
  stage: string;
  message: string;
  progress: number;
  totalPages: number;
  completedPages: number;
  pages: JobPage[];
  currentPagePath: string | null;
  currentConvertedFrameLabel: string | null;
  convertedFrameVersion: number;
  error: string | null;
  downloadName: string | null;
  fileSize: number | null;
  createdAt: string;
  updatedAt: string;
};

type ConversionJobRecord = {
  snapshot: ConversionJobSnapshot;
  artifact: ConversionArtifact | null;
  cleanupTimer: ReturnType<typeof setTimeout> | null;
  currentConvertedFramePath: string | null;
};

const JOB_TTL_MS = 15 * 60 * 1000;
const jobs = new Map<string, ConversionJobRecord>();

function nowIso(): string {
  return new Date().toISOString();
}

function updateProgress(snapshot: ConversionJobSnapshot): void {
  if (snapshot.status === "completed") {
    snapshot.progress = 1;
    return;
  }
  if (snapshot.status === "failed") {
    return;
  }
  if (snapshot.totalPages > 0) {
    const pagePart = Math.min(0.7, (snapshot.completedPages / snapshot.totalPages) * 0.7);
    if (snapshot.stage === "cbz2xtc") {
      snapshot.progress = Math.max(pagePart, 0.85);
      return;
    }
    snapshot.progress = Math.max(snapshot.progress, pagePart);
    return;
  }
  if (snapshot.stage === "cbz2xtc") {
    snapshot.progress = Math.max(snapshot.progress, 0.85);
    return;
  }
  if (snapshot.stage === "archive-download") {
    snapshot.progress = Math.max(snapshot.progress, 0.35);
    return;
  }
  if (snapshot.status === "running") {
    snapshot.progress = Math.max(snapshot.progress, 0.1);
  }
}

function scheduleCleanup(jobId: string): void {
  const record = jobs.get(jobId);
  if (!record) return;

  if (record.cleanupTimer) {
    clearTimeout(record.cleanupTimer);
  }

  record.cleanupTimer = setTimeout(async () => {
    const stale = jobs.get(jobId);
    if (!stale) return;
    try {
      await stale.artifact?.dispose();
    } catch (error) {
      logError(`job cleanup failed jobId=${jobId} ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      jobs.delete(jobId);
    }
  }, JOB_TTL_MS);
}

function applyProgressEvent(record: ConversionJobRecord, event: ConversionProgressEvent): void {
  const { snapshot } = record;
  snapshot.updatedAt = nowIso();
  if (event.type === "stage") {
    snapshot.stage = event.stage;
    snapshot.message = event.message;
  } else if (event.type === "pages_discovered") {
    snapshot.totalPages = event.total;
    snapshot.completedPages = 0;
    snapshot.pages = event.pages.map((label) => ({ label, done: false }));
    snapshot.message = `Found ${event.total} pages`;
  } else if (event.type === "page_done") {
    snapshot.totalPages = event.total;
    snapshot.completedPages = Math.max(snapshot.completedPages, event.index);
    snapshot.currentPagePath = event.page;
    if (snapshot.pages.length >= event.index) {
      snapshot.pages[event.index - 1] = {
        label: snapshot.pages[event.index - 1]?.label || event.page,
        done: true,
      };
    }
    snapshot.message = `Downloaded page ${event.index}/${event.total}`;
  } else if (event.type === "cbz_ready") {
    snapshot.message = `Built conversion archive with ${event.total} pages`;
  } else if (event.type === "cbz2xtc_frame") {
    record.currentConvertedFramePath = event.framePath;
    snapshot.currentConvertedFrameLabel = event.frameLabel;
    snapshot.convertedFrameVersion += 1;
    snapshot.message = `Converting frame ${event.frameLabel}`;
  } else if (event.type === "cbz2xtc_summary") {
    snapshot.message = event.summary;
  } else if (event.type === "done") {
    snapshot.status = "completed";
    snapshot.stage = "completed";
    snapshot.message = `Conversion complete (${event.fileSize} bytes)`;
    snapshot.progress = 1;
    snapshot.downloadName = event.downloadName;
    snapshot.fileSize = event.fileSize;
  }
  updateProgress(snapshot);
}

export function startConversionJob(params: {
  config: AppConfig;
  lrr: LanraragiClient;
  archiveId: string;
  settings: ConversionSettings;
}): ConversionJobSnapshot {
  const jobId = randomUUID();
  const snapshot: ConversionJobSnapshot = {
    jobId,
    archiveId: params.archiveId,
    status: "queued",
    stage: "queued",
    message: "Queued",
    progress: 0,
    totalPages: 0,
    completedPages: 0,
    pages: [],
    currentPagePath: null,
    currentConvertedFrameLabel: null,
    convertedFrameVersion: 0,
    error: null,
    downloadName: null,
    fileSize: null,
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };

  jobs.set(jobId, {
    snapshot,
    artifact: null,
    cleanupTimer: null,
    currentConvertedFramePath: null,
  });

  void (async () => {
    const record = jobs.get(jobId);
    if (!record) return;

    record.snapshot.status = "running";
    record.snapshot.stage = "starting";
    record.snapshot.message = "Starting conversion";
    record.snapshot.updatedAt = nowIso();
    updateProgress(record.snapshot);

    try {
      const artifact = await convertArchiveToXtc({
        config: params.config,
        lrr: params.lrr,
        archiveId: params.archiveId,
        settings: params.settings,
        onProgress: (event) => {
          const current = jobs.get(jobId);
          if (!current) return;
          applyProgressEvent(current, event);
        },
      });

      const current = jobs.get(jobId);
      if (!current) {
        await artifact.dispose();
        return;
      }
      current.artifact = artifact;
      current.snapshot.status = "completed";
      current.snapshot.stage = "completed";
      current.snapshot.message = "Conversion complete, ready to download";
      current.snapshot.progress = 1;
      current.snapshot.downloadName = artifact.downloadName;
      current.snapshot.fileSize = artifact.fileSize;
      current.snapshot.updatedAt = nowIso();
      scheduleCleanup(jobId);
    } catch (error) {
      const current = jobs.get(jobId);
      if (!current) return;
      current.snapshot.status = "failed";
      current.snapshot.stage = "failed";
      current.snapshot.error = error instanceof Error ? error.message : String(error);
      current.snapshot.message = current.snapshot.error;
      current.snapshot.updatedAt = nowIso();
      scheduleCleanup(jobId);
    }
  })();

  return snapshot;
}

export function getConversionJob(jobId: string): ConversionJobSnapshot | null {
  const record = jobs.get(jobId);
  return record ? record.snapshot : null;
}

export async function getConversionJobFrame(jobId: string): Promise<{ filePath: string; mtimeMs: number } | null> {
  const record = jobs.get(jobId);
  const framePath = record?.currentConvertedFramePath;
  if (!framePath) return null;

  try {
    const file = await stat(framePath);
    return {
      filePath: framePath,
      mtimeMs: file.mtimeMs,
    };
  } catch {
    return null;
  }
}

export function takeJobArtifact(jobId: string): ConversionArtifact | null {
  const record = jobs.get(jobId);
  if (!record || record.snapshot.status !== "completed" || !record.artifact) {
    return null;
  }

  if (record.cleanupTimer) {
    clearTimeout(record.cleanupTimer);
    record.cleanupTimer = null;
  }

  const artifact = record.artifact;
  record.artifact = null;
  jobs.delete(jobId);
  return artifact;
}
