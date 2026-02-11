import path from "node:path";
import { z } from "zod";

const envSchema = z.object({
  PORT: z.coerce.number().int().positive().default(3000),
  SERVER_PUBLIC_URL: z.string().url().default("http://localhost:3000"),
  LANRARAGI_BASE_URL: z.string().url(),
  LANRARAGI_API_KEY: z.string().optional().default(""),
  XTEINK_BASE_URL: z.string().url().default("http://xteink.local"),
  CBZ2XTC_PATH: z.string().min(1),
  PNG2XTC_PATH: z.string().optional().default(""),
  PYTHON_BIN: z.string().default("python3"),
  TEMP_ROOT: z.string().default(".tmp"),
  PAGE_FETCH_CONCURRENCY: z.coerce.number().int().min(1).max(16).default(6),
  USE_LRR_PAGE_EXTRACTION: z
    .string()
    .optional()
    .default("true")
    .transform((v) => !["false", "0", "no", "off"].includes(v.toLowerCase())),
});

export type AppConfig = z.infer<typeof envSchema> & {
  tempRootAbsolute: string;
};

export function loadConfig(): AppConfig {
  const parsed = envSchema.parse(process.env);
  return {
    ...parsed,
    tempRootAbsolute: path.isAbsolute(parsed.TEMP_ROOT)
      ? parsed.TEMP_ROOT
      : path.resolve(process.cwd(), parsed.TEMP_ROOT),
  };
}
