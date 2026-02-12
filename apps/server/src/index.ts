import "dotenv/config";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
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

app.get("/", (c) =>
  c.json({
    name: "lanraragi-xtc-bridge",
    status: "ok",
    opds: `${config.SERVER_PUBLIC_URL}/opds`,
    api: `${config.SERVER_PUBLIC_URL}/api`,
    logFile: getLogFilePath(),
  }),
);

app.route("/api", createApiRouter(config, lanraragi, device));
app.route("/opds", createOpdsRouter(config, lanraragi));

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
