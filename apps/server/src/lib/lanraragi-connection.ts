import { LanraragiClient } from "./lanraragi-client";

export type LanraragiSettingsPublic = {
  baseUrl: string;
  hasApiKey: boolean;
};

export type LanraragiSettingsUpdate = {
  baseUrl?: string;
  apiKey?: string;
};

export type LanraragiConnectionManager = {
  getClient: () => LanraragiClient;
  getSettings: () => LanraragiSettingsPublic;
  updateSettings: (next: LanraragiSettingsUpdate) => LanraragiSettingsPublic;
  getVersion: () => number;
};

function normalizeLanraragiBaseUrl(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) {
    throw new Error("LANraragi base URL is required.");
  }
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
  const parsed = new URL(withScheme);
  return `${parsed.protocol}//${parsed.host}`;
}

export function createLanraragiConnectionManager(input: {
  baseUrl: string;
  apiKey: string;
}): LanraragiConnectionManager {
  let baseUrl = normalizeLanraragiBaseUrl(input.baseUrl);
  let apiKey = input.apiKey || "";
  let client = new LanraragiClient(baseUrl, apiKey);
  let version = 0;

  return {
    getClient: () => client,
    getSettings: () => ({
      baseUrl,
      hasApiKey: apiKey.trim().length > 0,
    }),
    updateSettings: (next) => {
      const nextBaseUrl = next.baseUrl !== undefined ? normalizeLanraragiBaseUrl(next.baseUrl) : baseUrl;
      const nextApiKey = next.apiKey !== undefined ? next.apiKey : apiKey;
      baseUrl = nextBaseUrl;
      apiKey = nextApiKey;
      client = new LanraragiClient(baseUrl, apiKey);
      version += 1;
      return {
        baseUrl,
        hasApiKey: apiKey.trim().length > 0,
      };
    },
    getVersion: () => version,
  };
}
