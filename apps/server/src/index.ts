import "dotenv/config";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { existsSync } from "node:fs";
import path from "node:path";
import { loadConfig } from "./lib/config";
import { createDeviceConnectionManager } from "./lib/device-connection";
import { createLanraragiConnectionManager } from "./lib/lanraragi-connection";
import { createApiRouter } from "./routes/api";
import { createOpdsRouter } from "./routes/opds";
import { getLogFilePath, logError, logInfo } from "./lib/logger";

const config = loadConfig();
const lanraragi = createLanraragiConnectionManager({
  baseUrl: config.LANRARAGI_BASE_URL,
  apiKey: config.LANRARAGI_API_KEY,
});
const device = createDeviceConnectionManager({
  baseUrl: config.XTEINK_BASE_URL,
  path: "/",
  filePath: path.isAbsolute(config.DEVICE_SETTINGS_FILE)
    ? config.DEVICE_SETTINGS_FILE
    : path.resolve(process.cwd(), config.DEVICE_SETTINGS_FILE),
});
const webDistRoot = path.resolve(process.cwd(), "../web/dist");
const hasWebDist = existsSync(path.join(webDistRoot, "index.html"));

const app = new Hono();

app.use("*", cors());

app.onError((err, c) => {
  logError(err instanceof Error ? err.stack || err.message : String(err));
  return c.json(
    {
      error: err instanceof Error ? err.message : "Internal server error",
    },
    500,
  );
});

app.route("/api", createApiRouter(config, lanraragi, device));
app.route("/opds", createOpdsRouter(config, lanraragi));

if (hasWebDist) {
  app.use("/assets/*", serveStatic({ root: webDistRoot }));
  app.get("/favicon.ico", serveStatic({ root: webDistRoot }));
  app.get(
    "/",
    serveStatic({
      root: webDistRoot,
      rewriteRequestPath: () => "/index.html",
    }),
  );
} else {
  app.get("/", (c) =>
    c.json({
      name: "lanraragi-xtc-bridge",
      status: "ok",
      opds: `${config.SERVER_PUBLIC_URL}/opds`,
      api: `${config.SERVER_PUBLIC_URL}/api`,
      logFile: getLogFilePath(),
    }),
  );
}

serve(
  {
    fetch: app.fetch,
    port: config.PORT,
  },
  (info) => {
    logInfo(`lanraragi-xtc-bridge server listening on http://localhost:${info.port}`);
    logInfo(`log file path: ${getLogFilePath()}`);
  },
);
