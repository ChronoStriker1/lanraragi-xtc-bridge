import { readFile } from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import { URL } from "node:url";

type QueryValue = string | number | boolean | undefined | null;
const DEVICE_REQUEST_TIMEOUT_MS = 20_000;
const DEVICE_UPLOAD_TIMEOUT_MS = 600_000;

export type XteinkFileEntry = {
  name: string;
  size: number;
  isDirectory: boolean;
  isEpub: boolean;
};

export function normalizeDeviceBaseUrl(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) {
    throw new Error("Device base URL is required.");
  }
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
  const url = new URL(withScheme);
  return `${url.protocol}//${url.host}`;
}

export function normalizeDevicePath(input: string): string {
  const trimmed = input.trim();
  if (!trimmed || trimmed === ".") return "/";
  const withRoot = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  return withRoot.replace(/\/+/g, "/");
}

function joinDevicePath(basePath: string, leaf: string): string {
  const cleanLeaf = leaf.replace(/^\/+/, "");
  return normalizeDevicePath(`${normalizeDevicePath(basePath)}/${cleanLeaf}`);
}

export class XteinkClient {
  private readonly baseUrl: string;

  constructor(baseUrl: string) {
    this.baseUrl = normalizeDeviceBaseUrl(baseUrl);
  }

  private buildUrl(pathname: string, query?: Record<string, QueryValue>): string {
    const url = new URL(pathname, this.baseUrl);
    if (query) {
      for (const [key, value] of Object.entries(query)) {
        if (value === undefined || value === null || value === "") continue;
        url.searchParams.set(key, String(value));
      }
    }
    return url.toString();
  }

  private async request(params: {
    method: "GET" | "POST";
    pathname: string;
    query?: Record<string, QueryValue>;
    headers?: Record<string, string>;
    body?: Buffer;
    timeoutMs?: number;
  }): Promise<{ status: number; body: string }> {
    const url = new URL(this.buildUrl(params.pathname, params.query));
    const isHttps = url.protocol === "https:";
    const transport = isHttps ? https : http;

    return new Promise((resolve, reject) => {
      const req = transport.request(
        {
          protocol: url.protocol,
          hostname: url.hostname,
          port: url.port || (isHttps ? 443 : 80),
          method: params.method,
          path: `${url.pathname}${url.search}`,
          headers: {
            ...(params.body ? { "content-length": String(params.body.length) } : {}),
            ...(params.headers || {}),
          },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (chunk) => {
            chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
          });
          res.on("end", () => {
            resolve({
              status: res.statusCode || 0,
              body: Buffer.concat(chunks).toString("utf8"),
            });
          });
        },
      );

      req.setTimeout(params.timeoutMs ?? DEVICE_REQUEST_TIMEOUT_MS, () => {
        req.destroy(new Error(`Device request timed out (${params.method} ${url.pathname}${url.search})`));
      });

      req.on("error", (error) => reject(error));
      if (params.body) {
        req.write(params.body);
      }
      req.end();
    });
  }

  private buildMultipart(parts: Array<{ name: string; value: string }>, file?: { fileName: string; bytes: Buffer }): {
    boundary: string;
    body: Buffer;
  } {
    const boundary = `----xtcbridge${Date.now().toString(16)}${Math.random().toString(16).slice(2)}`;
    const chunks: Buffer[] = [];

    for (const part of parts) {
      chunks.push(
        Buffer.from(
          `--${boundary}\r\nContent-Disposition: form-data; name="${part.name}"\r\n\r\n${part.value}\r\n`,
          "utf8",
        ),
      );
    }

    if (file) {
      const safeName = file.fileName.replace(/"/g, "_");
      chunks.push(
        Buffer.from(
          `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${safeName}"\r\nContent-Type: application/octet-stream\r\n\r\n`,
          "utf8",
        ),
      );
      chunks.push(file.bytes);
      chunks.push(Buffer.from("\r\n", "utf8"));
    }

    chunks.push(Buffer.from(`--${boundary}--\r\n`, "utf8"));
    return {
      boundary,
      body: Buffer.concat(chunks),
    };
  }

  async listFiles(rawPath: string): Promise<XteinkFileEntry[]> {
    const devicePath = normalizeDevicePath(rawPath);
    const response = await this.request({
      method: "GET",
      pathname: "/api/files",
      query: { path: devicePath },
    });
    if (response.status < 200 || response.status >= 300) {
      throw new Error(`Device file listing failed (${response.status}): ${response.body.slice(0, 200)}`);
    }
    const data = JSON.parse(response.body) as XteinkFileEntry[];
    return Array.isArray(data) ? data : [];
  }

  async createFolder(rawPath: string, name: string): Promise<void> {
    const folderName = name.trim();
    if (!folderName) {
      throw new Error("Folder name is required.");
    }

    const multipart = this.buildMultipart([
      { name: "name", value: folderName },
      { name: "path", value: normalizeDevicePath(rawPath) },
    ]);

    const response = await this.request({
      method: "POST",
      pathname: "/mkdir",
      headers: {
        "content-type": `multipart/form-data; boundary=${multipart.boundary}`,
      },
      body: multipart.body,
    });
    if (response.status < 200 || response.status >= 300) {
      throw new Error(`Device mkdir failed (${response.status}): ${response.body.slice(0, 200)}`);
    }
  }

  private async uploadFileOnce(params: { filePath: string; fileName: string; targetPath: string }): Promise<{
    status: number;
    body: string;
  }> {
    const bytes = await readFile(params.filePath);
    const multipart = this.buildMultipart([], {
      fileName: params.fileName,
      bytes,
    });

    return this.request({
      method: "POST",
      pathname: "/upload",
      query: { path: normalizeDevicePath(params.targetPath) },
      headers: {
        "content-type": `multipart/form-data; boundary=${multipart.boundary}`,
      },
      body: multipart.body,
      timeoutMs: DEVICE_UPLOAD_TIMEOUT_MS,
    });
  }

  async deletePath(rawPath: string, type: "file" | "folder" = "file"): Promise<void> {
    const multipart = this.buildMultipart([
      { name: "path", value: normalizeDevicePath(rawPath) },
      { name: "type", value: type },
    ]);

    const response = await this.request({
      method: "POST",
      pathname: "/delete",
      headers: {
        "content-type": `multipart/form-data; boundary=${multipart.boundary}`,
      },
      body: multipart.body,
    });

    if (response.status < 200 || response.status >= 300) {
      throw new Error(`Device delete failed (${response.status}): ${response.body.slice(0, 200)}`);
    }
  }

  async uploadFile(params: { filePath: string; fileName: string; targetPath: string }): Promise<void> {
    const firstAttempt = await this.uploadFileOnce(params);
    if (firstAttempt.status >= 200 && firstAttempt.status < 300) {
      return;
    }

    const conflictLike =
      firstAttempt.status === 409 ||
      firstAttempt.status === 412 ||
      /(already exists|exists|duplicate|conflict)/i.test(firstAttempt.body);

    if (!conflictLike) {
      throw new Error(`Device upload failed (${firstAttempt.status}): ${firstAttempt.body.slice(0, 200)}`);
    }

    const filePath = joinDevicePath(params.targetPath, params.fileName);
    try {
      await this.deletePath(filePath, "file");
    } catch (error) {
      const reason = error instanceof Error ? error.message : "Unknown device delete error";
      throw new Error(
        `Device upload failed (${firstAttempt.status}): ${firstAttempt.body.slice(0, 200)}; overwrite retry failed (${reason})`,
      );
    }

    const retry = await this.uploadFileOnce(params);
    if (retry.status < 200 || retry.status >= 300) {
      throw new Error(`Device upload retry failed (${retry.status}): ${retry.body.slice(0, 200)}`);
    }
  }
}
