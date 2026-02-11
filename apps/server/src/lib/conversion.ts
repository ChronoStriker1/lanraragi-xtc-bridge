import { spawn } from "node:child_process";
import { createWriteStream, existsSync } from "node:fs";
import { access, copyFile, mkdir, mkdtemp, open, readdir, rename, rm, stat } from "node:fs/promises";
import type { Dirent } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import pLimit from "p-limit";
import yazl from "yazl";
import type { AppConfig } from "./config";
import { LanraragiClient } from "./lanraragi-client";
import { settingsToCbz2xtcArgs } from "./settings";
import type { ConversionSettings } from "../types";
import { logError, logInfo } from "./logger";

const IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp", ".avif"]);
const PAGE_FETCH_RETRY_ATTEMPTS = 3;
const PAGE_FETCH_RETRY_DELAY_MS = 300;
const FRAME_POLL_INTERVAL_MS = 500;
const FRAME_MIN_AGE_MS = 350;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PNG_IEND_CHUNK = Buffer.from([0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82]);

export type ConversionProgressEvent =
  | { type: "stage"; stage: string; message: string }
  | { type: "pages_discovered"; total: number; pages: string[] }
  | { type: "page_done"; index: number; total: number; page: string }
  | { type: "cbz_ready"; total: number }
  | { type: "cbz2xtc_frame"; framePath: string; frameLabel: string }
  | { type: "cbz2xtc_summary"; summary: string }
  | { type: "done"; fileSize: number; downloadName: string };

function sanitizeSegment(input: string): string {
  return input
    .replace(/[^a-zA-Z0-9._-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 120) || "archive";
}

function cleanFilenamePart(input: string): string {
  return input
    .replace(/[<>:"/\\|?*\u0000-\u001f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function parseTags(raw: string): string[] {
  return raw
    .split(",")
    .map((tag) => tag.trim())
    .filter((tag) => tag.length > 0);
}

function namespaceTagValues(tags: string[], namespace: string): string[] {
  const prefix = `${namespace.toLowerCase()}:`;
  return tags
    .filter((tag) => tag.toLowerCase().startsWith(prefix))
    .map((tag) => cleanFilenamePart(tag.slice(prefix.length)))
    .filter((value) => value.length > 0);
}

function buildDownloadName(params: {
  title: string;
  filename: string;
  arcid: string;
  tags: string;
}): string {
  const tags = parseTags(params.tags || "");
  const group = namespaceTagValues(tags, "group")[0] || "";
  const artist = namespaceTagValues(tags, "artist")[0] || "";
  const title = cleanFilenamePart(params.title || params.filename || params.arcid) || "archive";

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

function buildPageRangeList(count: number): string {
  return Array.from({ length: count }, (_, idx) => String(idx + 1)).join(",");
}

function shiftDontSplitForPrependedCover(raw: string): string {
  const tokens = raw
    .split(",")
    .map((token) => token.trim())
    .filter((token) => token.length > 0)
    .map((token) => (/^\d+$/.test(token) ? String(Number(token) + 1) : token));

  tokens.unshift("1");
  const seen = new Set<string>();
  return tokens.filter((token) => {
    if (seen.has(token)) return false;
    seen.add(token);
    return true;
  }).join(",");
}

async function ensureFileExists(filePath: string): Promise<void> {
  await access(filePath);
}

function isCbzLikeExtension(extension: string): boolean {
  const ext = extension.replace(/^\./, "").toLowerCase();
  return ext === "cbz" || ext === "zip";
}

async function writeResponseToFile(response: Response, filePath: string): Promise<void> {
  if (!response.body) {
    throw new Error("LANraragi response did not include a body stream.");
  }
  const file = await open(filePath, "w");
  const reader = response.body.getReader();
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      if (!chunk.value || chunk.value.length === 0) continue;
      await file.write(chunk.value);
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // Ignore lock release issues from already-finalized streams.
    }
    await file.close();
  }
}

function looksLikeCoverOrNonArchive(contentType: string): boolean {
  const lowered = contentType.toLowerCase();
  if (!lowered) return false;
  if (lowered.startsWith("image/")) return true;
  if (lowered.includes("text/html")) return true;
  if (lowered.includes("application/json")) return true;
  return false;
}

async function isZipArchive(filePath: string): Promise<boolean> {
  const handle = await open(filePath, "r");
  try {
    const signature = Buffer.alloc(4);
    const { bytesRead } = await handle.read(signature, 0, 4, 0);
    if (bytesRead < 4) return false;
    if (signature[0] !== 0x50 || signature[1] !== 0x4b) return false;
    return (
      (signature[2] === 0x03 && signature[3] === 0x04) ||
      (signature[2] === 0x05 && signature[3] === 0x06) ||
      (signature[2] === 0x07 && signature[3] === 0x08)
    );
  } finally {
    await handle.close();
  }
}

function extensionFromContentDisposition(contentDisposition: string): string | null {
  const match = contentDisposition.match(/filename="?([^\";]+)"?/i);
  if (!match) return null;
  const ext = path.extname(match[1]).toLowerCase();
  return IMAGE_EXTENSIONS.has(ext) ? ext : null;
}

function extensionFromPageReference(pageRef: string): string | null {
  const pathMatch = pageRef.match(/[?&]path=([^&]+)/i);
  if (pathMatch) {
    try {
      const decoded = decodeURIComponent(pathMatch[1]);
      const ext = path.extname(decoded).toLowerCase();
      if (IMAGE_EXTENSIONS.has(ext)) return ext;
    } catch {
      // Ignore malformed query encoding and continue with fallback parsing.
    }
  }

  const plainPath = pageRef.split("?")[0] || "";
  const ext = path.extname(plainPath).toLowerCase();
  return IMAGE_EXTENSIONS.has(ext) ? ext : null;
}

function pageLabelFromReference(pageRef: string): string {
  const pathMatch = pageRef.match(/[?&]path=([^&]+)/i);
  if (pathMatch) {
    try {
      return decodeURIComponent(pathMatch[1]);
    } catch {
      return pathMatch[1];
    }
  }
  const plainPath = pageRef.split("?")[0] || pageRef;
  const trimmed = plainPath.trim();
  if (!trimmed) return pageRef;
  const parts = trimmed.split("/");
  return parts[parts.length - 1] || trimmed;
}

function inferPageExtension(response: Response, pageRef: string): string {
  const contentType = (response.headers.get("content-type") || "").toLowerCase();
  if (contentType.includes("png")) return ".png";
  if (contentType.includes("webp")) return ".webp";
  if (contentType.includes("gif")) return ".gif";
  if (contentType.includes("bmp")) return ".bmp";
  if (contentType.includes("avif")) return ".avif";
  if (contentType.includes("jpeg") || contentType.includes("jpg")) return ".jpg";

  const fromDisposition = extensionFromContentDisposition(response.headers.get("content-disposition") || "");
  if (fromDisposition) return fromDisposition;

  const fromRef = extensionFromPageReference(pageRef);
  if (fromRef) return fromRef;

  return ".jpg";
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function downloadPageWithRetry(params: {
  lrr: LanraragiClient;
  pageUrl: string;
  pageNumber: number;
}): Promise<Response> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= PAGE_FETCH_RETRY_ATTEMPTS; attempt += 1) {
    try {
      const response = await params.lrr.downloadByPageUrl(params.pageUrl);
      const contentType = (response.headers.get("content-type") || "").toLowerCase();
      if (contentType.includes("text/html") || contentType.includes("application/json")) {
        throw new Error(
          `Unexpected page content-type for page ${params.pageNumber}: ${contentType || "unknown"}`,
        );
      }
      return response;
    } catch (error) {
      lastError = error;
      if (attempt < PAGE_FETCH_RETRY_ATTEMPTS) {
        logInfo(
          `page fetch retry id-page=${params.pageNumber} attempt=${attempt + 1}/${PAGE_FETCH_RETRY_ATTEMPTS}`,
        );
        await sleep(PAGE_FETCH_RETRY_DELAY_MS * attempt);
        continue;
      }
    }
  }

  throw lastError instanceof Error ? lastError : new Error(`Failed to fetch page ${params.pageNumber}`);
}

async function getArchivePagesRobust(params: {
  lrr: LanraragiClient;
  archiveId: string;
  expectedPageCount?: number;
}): Promise<string[]> {
  const cachedPages = await params.lrr.getArchivePages(params.archiveId, { force: false });
  if (cachedPages.length > 1) {
    return cachedPages;
  }

  if (params.expectedPageCount !== undefined && params.expectedPageCount <= 1) {
    return cachedPages;
  }

  const refreshedPages = await params.lrr.getArchivePages(params.archiveId, { force: true });
  if (refreshedPages.length !== cachedPages.length) {
    logInfo(
      `page list refresh id=${params.archiveId} cached=${cachedPages.length} refreshed=${refreshedPages.length}`,
    );
  }

  return refreshedPages.length > 0 ? refreshedPages : cachedPages;
}

async function normalizeImagesForXtc(params: { files: string[]; pythonBin: string }): Promise<string[]> {
  if (!params.files.length) return [];

  const script = `
import os, sys
from PIL import Image
for src in sys.argv[1:]:
    src = os.path.abspath(src)
    base, _ = os.path.splitext(src)
    dst = base + ".jpg"
    with Image.open(src) as im:
        if im.mode in ("RGBA", "LA") or (im.mode == "P" and "transparency" in im.info):
            rgba = im.convert("RGBA")
            bg = Image.new("RGB", rgba.size, (255, 255, 255))
            bg.paste(rgba, mask=rgba.split()[-1])
            out = bg
        else:
            out = im.convert("RGB")
        out.save(dst, format="JPEG", quality=95, optimize=True)
    if os.path.abspath(dst) != src:
        os.remove(src)
    print(dst)
`;

  return new Promise((resolve, reject) => {
    const proc = spawn(params.pythonBin, ["-c", script, ...params.files], {
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    proc.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    proc.on("error", reject);
    proc.on("close", (code) => {
      if (code !== 0) {
        reject(
          new Error(
            `Image normalization failed with exit code ${code}.\nSTDOUT:\n${stdout.slice(0, 500)}\nSTDERR:\n${stderr.slice(0, 500)}`,
          ),
        );
        return;
      }
      const normalizedFiles = stdout
        .split(/\r?\n/g)
        .map((line) => line.trim())
        .filter((line) => line.length > 0);
      if (!normalizedFiles.length) {
        reject(new Error("Image normalization produced no output files."));
        return;
      }
      resolve(normalizedFiles);
    });
  });
}

async function rotateCoverForPortraitInLandscape(params: { filePath: string; pythonBin: string }): Promise<void> {
  const script = `
import os, sys
from PIL import Image

src = os.path.abspath(sys.argv[1])
ext = os.path.splitext(src)[1].lower()

with Image.open(src) as im:
    rotated = im.rotate(90, expand=True)
    if ext in (".jpg", ".jpeg"):
        if rotated.mode != "RGB":
            rotated = rotated.convert("RGB")
        rotated.save(src, format="JPEG", quality=95, optimize=True)
    elif ext == ".png":
        rotated.save(src, format="PNG", optimize=True)
    else:
        rotated.save(src)
`;

  await new Promise<void>((resolve, reject) => {
    const proc = spawn(params.pythonBin, ["-c", script, params.filePath], {
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    proc.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    proc.on("error", reject);
    proc.on("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(
        new Error(
          `Portrait cover rotation failed with exit code ${code}.\nSTDOUT:\n${stdout.slice(0, 500)}\nSTDERR:\n${stderr.slice(0, 500)}`,
        ),
      );
    });
  });
}

async function createCbzFromPages(params: {
  pages: string[];
  lrr: LanraragiClient;
  archivePath: string;
  concurrency: number;
  pythonBin: string;
  prependPortraitCoverForLandscape?: boolean;
  onProgress?: (event: ConversionProgressEvent) => void;
}): Promise<void> {
  const pageDir = path.join(path.dirname(params.archivePath), "pages_tmp");
  await mkdir(pageDir, { recursive: true });

  const limit = pLimit(params.concurrency);

  const downloadedFilesRaw = await Promise.all(
    params.pages.map((pageUrl, index) =>
      limit(async () => {
        const pageNumber = index + 1;
        const response = await downloadPageWithRetry({
          lrr: params.lrr,
          pageUrl,
          pageNumber,
        });
        const inferredExt = inferPageExtension(response, pageUrl);

        const fileName = `${String(pageNumber).padStart(5, "0")}${inferredExt}`;
        const filePath = path.join(pageDir, fileName);
        await writeResponseToFile(response, filePath);
        params.onProgress?.({
          type: "page_done",
          index: pageNumber,
          total: params.pages.length,
          page: pageLabelFromReference(pageUrl),
        });
        return filePath;
      }),
    ),
  );
  const downloadedFiles = await normalizeImagesForXtc({
    files: downloadedFilesRaw,
    pythonBin: params.pythonBin,
  });
  if (params.prependPortraitCoverForLandscape && downloadedFiles.length > 0) {
    await rotateCoverForPortraitInLandscape({
      filePath: downloadedFiles[0],
      pythonBin: params.pythonBin,
    });
    logInfo(`landscape cover prep applied file=${path.basename(downloadedFiles[0])}`);
  }

  let archivedPageCount = 0;
  await new Promise<void>((resolve, reject) => {
    const zip = new yazl.ZipFile();
    const out = createWriteStream(params.archivePath);

    zip.outputStream
      .pipe(out)
      .on("error", reject)
      .on("close", resolve);

    for (const filePath of downloadedFiles) {
      const ext = path.extname(filePath).toLowerCase();
      if (!IMAGE_EXTENSIONS.has(ext)) {
        continue;
      }
      zip.addFile(filePath, path.basename(filePath));
      archivedPageCount += 1;
    }

    zip.end();
  });

  if (archivedPageCount !== params.pages.length) {
    throw new Error(`CBZ build mismatch: expected ${params.pages.length} pages, archived ${archivedPageCount}.`);
  }

  logInfo(`built cbz from pages path=${params.archivePath} pages=${archivedPageCount}`);
  params.onProgress?.({
    type: "cbz_ready",
    total: archivedPageCount,
  });
}

function summarizeCbz2xtcOutput(stdout: string, stderr: string): string {
  const combined = `${stdout}\n${stderr}`;
  const lines = combined
    .split(/\r?\n/g)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (lines.length === 0) return "";

  const interesting = lines.filter((line) => /page|extract|split|output|xtc|done|warning|error/i.test(line));
  const picked = (interesting.length > 0 ? interesting : lines).slice(-8);
  return picked.join(" | ").slice(0, 1400);
}

type FrameCandidate = {
  path: string;
  mtimeMs: number;
  size: number;
};

async function listConvertedFrames(rootDir: string): Promise<FrameCandidate[]> {
  const frames: FrameCandidate[] = [];

  const visit = async (dirPath: string, depth: number) => {
    if (depth > 5) return;
    let entries: Dirent[];
    try {
      entries = (await readdir(dirPath, { withFileTypes: true })) as Dirent[];
    } catch {
      return;
    }

    for (const entry of entries) {
      const fullPath = path.join(dirPath, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "xtc_output" || entry.name === "deliver" || entry.name === ".frame_preview") {
          continue;
        }
        await visit(fullPath, depth + 1);
        continue;
      }

      if (!entry.isFile() || !entry.name.toLowerCase().endsWith(".png")) {
        continue;
      }

      try {
        const file = await stat(fullPath);
        frames.push({
          path: fullPath,
          mtimeMs: file.mtimeMs,
          size: file.size,
        });
      } catch {
        // Ignore transient files that are still being written.
      }
    }
  };

  await visit(rootDir, 0);
  frames.sort((a, b) => {
    if (a.mtimeMs !== b.mtimeMs) return a.mtimeMs - b.mtimeMs;
    return a.path.localeCompare(b.path);
  });
  return frames;
}

async function isCompletePngFile(filePath: string, sizeHint?: number): Promise<boolean> {
  const handle = await open(filePath, "r").catch(() => null);
  if (!handle) return false;
  try {
    const stats = sizeHint && sizeHint > 0 ? { size: sizeHint } : await handle.stat();
    const size = stats.size;
    if (size < PNG_SIGNATURE.length + PNG_IEND_CHUNK.length) {
      return false;
    }

    const signature = Buffer.alloc(PNG_SIGNATURE.length);
    const tail = Buffer.alloc(PNG_IEND_CHUNK.length);
    const signatureRead = await handle.read(signature, 0, signature.length, 0);
    const tailRead = await handle.read(tail, 0, tail.length, size - tail.length);

    if (signatureRead.bytesRead !== signature.length || tailRead.bytesRead !== tail.length) {
      return false;
    }
    return signature.equals(PNG_SIGNATURE) && tail.equals(PNG_IEND_CHUNK);
  } catch {
    return false;
  } finally {
    await handle.close().catch(() => undefined);
  }
}

async function runCbz2xtc(params: {
  config: AppConfig;
  jobDir: string;
  settings: ConversionSettings;
  onProgress?: (event: ConversionProgressEvent) => void;
}): Promise<{ stdout: string; stderr: string }> {
  const args = [
    params.config.CBZ2XTC_PATH,
    params.jobDir,
    ...settingsToCbz2xtcArgs(params.settings),
  ];
  logInfo(`cbz2xtc spawn cwd=${params.jobDir} cmd=${params.config.PYTHON_BIN} ${args.join(" ")}`);

  return new Promise((resolve, reject) => {
    const proc = spawn(params.config.PYTHON_BIN, args, {
      env: {
        ...process.env,
        ...(params.config.PNG2XTC_PATH
          ? {
              PNG2XTC_PATH: params.config.PNG2XTC_PATH,
            }
          : {}),
      },
      cwd: params.jobDir,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let polling = false;
    let stopped = false;
    const emittedSourceFrameKeys = new Set<string>();
    const previewDir = path.join(params.jobDir, ".frame_preview");
    let lastPreviewPath: string | null = null;

    const emitFrame = async () => {
      if (polling || stopped) return;
      polling = true;
      try {
        await mkdir(previewDir, { recursive: true });
        const frames = await listConvertedFrames(params.jobDir);
        if (!frames.length) return;

        const now = Date.now();
        let sourceFrame: FrameCandidate | null = null;
        for (const candidate of frames) {
          const frameKey = `${candidate.path}:${candidate.mtimeMs}:${candidate.size}`;
          if (emittedSourceFrameKeys.has(frameKey)) continue;
          if (now - candidate.mtimeMs < FRAME_MIN_AGE_MS) continue;
          if (!(await isCompletePngFile(candidate.path, candidate.size))) continue;
          sourceFrame = candidate;
          emittedSourceFrameKeys.add(frameKey);
          break;
        }
        if (!sourceFrame) return;

        const previewName = `${Date.now()}-${path.basename(sourceFrame.path)}`;
        const previewPath = path.join(previewDir, previewName);
        await copyFile(sourceFrame.path, previewPath);
        if (!(await isCompletePngFile(previewPath))) {
          await rm(previewPath, { force: true });
          return;
        }

        if (lastPreviewPath && lastPreviewPath !== previewPath) {
          await rm(lastPreviewPath, { force: true }).catch(() => undefined);
        }
        lastPreviewPath = previewPath;

        params.onProgress?.({
          type: "cbz2xtc_frame",
          framePath: previewPath,
          frameLabel: path.basename(sourceFrame.path),
        });
      } finally {
        polling = false;
      }
    };

    const timer = setInterval(() => {
      void emitFrame();
    }, FRAME_POLL_INTERVAL_MS);

    proc.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });

    proc.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    proc.on("error", reject);

    proc.on("close", (code) => {
      stopped = true;
      clearInterval(timer);
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }
      reject(
        new Error(
          `cbz2xtc failed with exit code ${code}.\nSTDOUT:\n${stdout.slice(0, 1000)}\nSTDERR:\n${stderr.slice(0, 1000)}`,
        ),
      );
    });

    void emitFrame();
  });
}

export type ConversionArtifact = {
  filePath: string;
  downloadName: string;
  fileSize: number;
  dispose: () => Promise<void>;
};

export async function convertArchiveToXtc(params: {
  config: AppConfig;
  lrr: LanraragiClient;
  archiveId: string;
  settings: ConversionSettings;
  onProgress?: (event: ConversionProgressEvent) => void;
}): Promise<ConversionArtifact> {
  await ensureFileExists(params.config.CBZ2XTC_PATH);
  if (params.config.PNG2XTC_PATH) {
    await ensureFileExists(params.config.PNG2XTC_PATH);
  }

  const workspace = existsSync(params.config.tempRootAbsolute)
    ? params.config.tempRootAbsolute
    : tmpdir();

  await mkdir(workspace, { recursive: true });
  const jobDir = await mkdtemp(path.join(workspace, "lrr-xtc-"));

  const cleanup = async () => {
    logInfo(`cleanup jobDir=${jobDir}`);
    await rm(jobDir, { recursive: true, force: true });
  };

  try {
    params.onProgress?.({
      type: "stage",
      stage: "metadata",
      message: "Loading archive metadata",
    });
    const metadata = await params.lrr.getArchiveMetadata(params.archiveId);
    logInfo(`convert start id=${params.archiveId} ext=${metadata.extension} pagecount=${metadata.pagecount}`);
    const resolvedSettings: ConversionSettings = { ...params.settings };

    if (resolvedSettings.orientation === "portrait") {
      resolvedSettings.splitMode = "nosplit";
      resolvedSettings.sidewaysOverviews = true;
    }

    if (resolvedSettings.splitMode === "overlap") {
      resolvedSettings.overlap = true;
    } else if (resolvedSettings.splitMode === "split") {
      resolvedSettings.overlap = false;
    }

    const baseName = sanitizeSegment(metadata.title || metadata.filename || metadata.arcid);
    const downloadName = buildDownloadName({
      title: metadata.title,
      filename: metadata.filename,
      arcid: metadata.arcid,
      tags: metadata.tags,
    });
    const archiveInputName = `${baseName}.cbz`;
    const archiveInputPath = path.join(jobDir, archiveInputName);
    let cachedPages: string[] | null = null;
    let landscapeCoverPrepApplied = false;
    const prependPortraitCoverForLandscape = resolvedSettings.orientation === "landscape";

    const preparePagesForBuild = (pages: string[]): string[] => {
      if (resolvedSettings.orientation !== "landscape" || pages.length === 0) {
        return pages;
      }

      if (!landscapeCoverPrepApplied) {
        resolvedSettings.dontSplit = shiftDontSplitForPrependedCover(resolvedSettings.dontSplit || "");
        landscapeCoverPrepApplied = true;
        params.onProgress?.({
          type: "stage",
          stage: "cover-prep",
          message: "Preparing portrait cover before landscape conversion",
        });
      }

      return [pages[0], ...pages];
    };

    if (resolvedSettings.splitMode === "nosplit") {
      let pageCount = metadata.pagecount || 0;
      if (pageCount <= 0) {
        cachedPages = await getArchivePagesRobust({
          lrr: params.lrr,
          archiveId: params.archiveId,
          expectedPageCount: metadata.pagecount,
        });
        pageCount = cachedPages.length;
      }

      if (pageCount > 0) {
        resolvedSettings.dontSplit = buildPageRangeList(pageCount);
      }
      resolvedSettings.overlap = false;
      resolvedSettings.splitAll = false;
    }

    if (params.config.USE_LRR_PAGE_EXTRACTION) {
      params.onProgress?.({
        type: "stage",
        stage: "fetching-pages",
        message: "Retrieving page list from LANraragi cache",
      });
      cachedPages = await getArchivePagesRobust({
        lrr: params.lrr,
        archiveId: params.archiveId,
        expectedPageCount: metadata.pagecount,
      });
      const pagesForBuild = preparePagesForBuild(cachedPages);
      params.onProgress?.({
        type: "pages_discovered",
        total: pagesForBuild.length,
        pages: pagesForBuild.map(pageLabelFromReference),
      });
      logInfo(`page extraction enabled id=${params.archiveId} pages=${cachedPages.length}`);

      if (pagesForBuild.length > 1) {
        params.onProgress?.({
          type: "stage",
          stage: "building-input",
          message: `Downloading ${pagesForBuild.length} pages and building conversion archive`,
        });
        await createCbzFromPages({
          pages: pagesForBuild,
          lrr: params.lrr,
          archivePath: archiveInputPath,
          concurrency: params.config.PAGE_FETCH_CONCURRENCY,
          pythonBin: params.config.PYTHON_BIN,
          prependPortraitCoverForLandscape,
          onProgress: params.onProgress,
        });
      } else {
        logInfo(`page extraction returned <=1 page for id=${params.archiveId}; trying archive download fallback`);
      }
    }

    if (!existsSync(archiveInputPath) && isCbzLikeExtension(metadata.extension)) {
      const archiveResponse = await params.lrr.downloadArchive(params.archiveId);
      const contentType = archiveResponse.headers.get("content-type") || "";
      logInfo(`archive download id=${params.archiveId} content-type=${contentType || "unknown"}`);

      if (looksLikeCoverOrNonArchive(contentType)) {
        cachedPages =
          cachedPages ??
          (await getArchivePagesRobust({
            lrr: params.lrr,
            archiveId: params.archiveId,
            expectedPageCount: metadata.pagecount,
          }));
        logInfo(
          `archive download looked non-archive, falling back to pages id=${params.archiveId} pages=${cachedPages.length}`,
        );
        if (!cachedPages.length) {
          throw new Error("Archive download did not return an archive and no pages were found.");
        }
        const pagesForBuild = preparePagesForBuild(cachedPages);

        await createCbzFromPages({
          pages: pagesForBuild,
          lrr: params.lrr,
          archivePath: archiveInputPath,
          concurrency: params.config.PAGE_FETCH_CONCURRENCY,
          pythonBin: params.config.PYTHON_BIN,
          prependPortraitCoverForLandscape,
          onProgress: params.onProgress,
        });
      } else {
        params.onProgress?.({
          type: "stage",
          stage: "archive-download",
          message: "Downloading source archive from LANraragi",
        });
        await writeResponseToFile(archiveResponse, archiveInputPath);
        const looksLikeZip = await isZipArchive(archiveInputPath);
        if (!looksLikeZip) {
          logError(`archive download was not zip-like id=${params.archiveId}; falling back to page extraction`);
          await rm(archiveInputPath, { force: true });
          cachedPages =
            cachedPages ??
            (await getArchivePagesRobust({
              lrr: params.lrr,
              archiveId: params.archiveId,
              expectedPageCount: metadata.pagecount,
            }));
          if (!cachedPages.length) {
            throw new Error("Archive payload was not a zip archive and no pages were found.");
          }
          const pagesForBuild = preparePagesForBuild(cachedPages);
          await createCbzFromPages({
            pages: pagesForBuild,
            lrr: params.lrr,
            archivePath: archiveInputPath,
            concurrency: params.config.PAGE_FETCH_CONCURRENCY,
            pythonBin: params.config.PYTHON_BIN,
            prependPortraitCoverForLandscape,
            onProgress: params.onProgress,
          });
        }
      }
    } else if (!existsSync(archiveInputPath)) {
      const pages =
        cachedPages ??
        (await getArchivePagesRobust({
          lrr: params.lrr,
          archiveId: params.archiveId,
          expectedPageCount: metadata.pagecount,
        }));
      logInfo(`non-cbz fallback id=${params.archiveId} pages=${pages.length}`);
      if (!pages.length) {
        throw new Error("Archive has no readable pages. Cannot build conversion input.");
      }
      const pagesForBuild = preparePagesForBuild(pages);

      await createCbzFromPages({
        pages: pagesForBuild,
        lrr: params.lrr,
        archivePath: archiveInputPath,
        concurrency: params.config.PAGE_FETCH_CONCURRENCY,
        pythonBin: params.config.PYTHON_BIN,
        prependPortraitCoverForLandscape,
        onProgress: params.onProgress,
      });
    }

    params.onProgress?.({
      type: "stage",
      stage: "cbz2xtc",
      message: "Running cbz2xtc conversion",
    });
    const cbz2xtcRun = await runCbz2xtc({
      config: params.config,
      jobDir,
      settings: resolvedSettings,
      onProgress: params.onProgress,
    });
    const cbz2xtcSummary = summarizeCbz2xtcOutput(cbz2xtcRun.stdout, cbz2xtcRun.stderr);
    if (cbz2xtcSummary) {
      logInfo(`cbz2xtc summary id=${params.archiveId} ${cbz2xtcSummary}`);
      params.onProgress?.({
        type: "cbz2xtc_summary",
        summary: cbz2xtcSummary,
      });
    }

    const outputPath = path.join(jobDir, "xtc_output", `${baseName}.xtc`);
    await ensureFileExists(outputPath);

    await mkdir(path.join(jobDir, "deliver"), { recursive: true });
    const deliverPath = path.join(jobDir, "deliver", `${baseName}.xtc`);
    await rename(outputPath, deliverPath);
    const outputInfo = await stat(deliverPath);
    logInfo(`convert done id=${params.archiveId} output=${deliverPath} size=${outputInfo.size}`);
    params.onProgress?.({
      type: "done",
      fileSize: outputInfo.size,
      downloadName,
    });

    return {
      filePath: deliverPath,
      downloadName,
      fileSize: outputInfo.size,
      dispose: cleanup,
    };
  } catch (error) {
    await cleanup();
    throw error;
  }
}
