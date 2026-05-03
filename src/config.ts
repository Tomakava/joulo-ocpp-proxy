import { existsSync, readFileSync } from "fs";
import { createLogger } from "./logger";

const log = createLogger("config");

export interface Config {
  port: number;
  primaryUrl: string;
  secondaryUrls: string[];
  logLevel: "debug" | "info" | "warn" | "error";
}

const LOG_LEVELS = ["debug", "info", "warn", "error"] as const;

interface FileSecondary {
  url: string;
}

interface FileOptions {
  primary_csms_url?: string;
  secondary_csms?: FileSecondary[];
  log_level?: string;
}

function loadFileOptions(): FileOptions {
  const path = process.env.CONFIG_FILE ?? "/data/options.json";
  if (!existsSync(path)) {
    log.info("no config file found, using environment variables");
    return {};
  }
  try {
    log.info("loading config file", { path });
    return JSON.parse(readFileSync(path, "utf8")) as FileOptions;
  } catch (err) {
    log.error("failed to read config file", { path, error: String(err) });
    return {};
  }
}

export function loadConfig(): Config {
  const file = loadFileOptions();

  const primaryUrl = process.env.PRIMARY_CSMS_URL ?? file.primary_csms_url;
  if (!primaryUrl) {
    throw new Error(
      "PRIMARY_CSMS_URL is required. Set it via the PRIMARY_CSMS_URL environment variable or the addon configuration in Home Assistant."
    );
  }

  const fileSecondaries = file.secondary_csms ?? [];
  const secondaryUrls: string[] = process.env.SECONDARY_CSMS_URLS
    ? process.env.SECONDARY_CSMS_URLS.split(",").map((u) => u.trim()).filter(Boolean)
    : fileSecondaries.map((e) => e.url).filter(Boolean);

  const level = (process.env.LOG_LEVEL ?? file.log_level ?? "info").toLowerCase();
  const logLevel = LOG_LEVELS.includes(level as any)
    ? (level as Config["logLevel"])
    : "info";

  const port = process.env.PORT ? parseInt(process.env.PORT, 10) : 9000;
  if (!Number.isFinite(port) || port < 1 || port > 65535) {
    throw new Error(
      `Invalid PORT value: "${process.env.PORT}". Must be an integer between 1 and 65535.`
    );
  }

  return {
    port,
    primaryUrl,
    secondaryUrls,
    logLevel,
  };
}
