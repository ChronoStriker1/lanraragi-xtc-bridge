import { normalizeDeviceBaseUrl, normalizeDevicePath } from "./xteink-client";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

export type DeviceSettings = {
  baseUrl: string;
  path: string;
};

export type DeviceSettingsUpdate = {
  baseUrl?: string;
  path?: string;
};

export type DeviceConnectionManager = {
  getSettings: () => DeviceSettings;
  updateSettings: (next: DeviceSettingsUpdate) => DeviceSettings;
};

function loadPersistedSettings(filePath: string): Partial<DeviceSettings> | null {
  if (!existsSync(filePath)) return null;
  try {
    const raw = readFileSync(filePath, "utf8");
    const parsed = JSON.parse(raw) as Partial<DeviceSettings>;
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function saveSettings(filePath: string, settings: DeviceSettings): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify(settings, null, 2), "utf8");
}

export function createDeviceConnectionManager(input: DeviceSettings & { filePath?: string }): DeviceConnectionManager {
  let baseUrl = normalizeDeviceBaseUrl(input.baseUrl);
  let path = normalizeDevicePath(input.path);
  const settingsFile = input.filePath || "";

  if (settingsFile) {
    const persisted = loadPersistedSettings(settingsFile);
    if (persisted?.baseUrl) {
      try {
        baseUrl = normalizeDeviceBaseUrl(persisted.baseUrl);
      } catch {
        // Ignore invalid persisted base URL.
      }
    }
    if (persisted?.path) {
      try {
        path = normalizeDevicePath(persisted.path);
      } catch {
        // Ignore invalid persisted path.
      }
    }
  }

  return {
    getSettings: () => ({
      baseUrl,
      path,
    }),
    updateSettings: (next) => {
      if (next.baseUrl !== undefined) {
        baseUrl = normalizeDeviceBaseUrl(next.baseUrl);
      }
      if (next.path !== undefined) {
        path = normalizeDevicePath(next.path);
      }
      if (settingsFile) {
        saveSettings(settingsFile, { baseUrl, path });
      }
      return {
        baseUrl,
        path,
      };
    },
  };
}
