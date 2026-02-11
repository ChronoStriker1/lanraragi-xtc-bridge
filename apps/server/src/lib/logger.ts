import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";

const logFilePath = process.env.LOG_FILE
  ? path.resolve(process.cwd(), process.env.LOG_FILE)
  : path.resolve(process.cwd(), "logs", "bridge.log");

function formatLine(level: "INFO" | "ERROR", message: string): string {
  return `[${new Date().toISOString()}] [${level}] ${message}\n`;
}

function write(level: "INFO" | "ERROR", message: string): void {
  const line = formatLine(level, message);
  if (level === "ERROR") {
    console.error(line.trimEnd());
  } else {
    console.log(line.trimEnd());
  }

  try {
    mkdirSync(path.dirname(logFilePath), { recursive: true });
    appendFileSync(logFilePath, line);
  } catch {
    // Best-effort file logging; console output remains available.
  }
}

export function logInfo(message: string): void {
  write("INFO", message);
}

export function logError(message: string): void {
  write("ERROR", message);
}

export function getLogFilePath(): string {
  return logFilePath;
}
