import { existsSync, readFileSync } from "fs";
import { createLogger } from "./logger";

const log = createLogger("config");

export interface SecondaryChargerEntry {
  chargerId?: string;
  password?: string;
  idTag?: string;
}

// secondaryUrl ? originalChargerId ? { chargerId, password }
export type SecondaryChargerMap = Map<string, Map<string, SecondaryChargerEntry>>;

export interface Config {
  port: number;
  primaryUrl: string;
  secondaryUrls: string[];
  logLevel: "debug" | "info" | "warn" | "error";
  logMaxMessageLength: number;
  secondaryChargerMap: SecondaryChargerMap;
}

const LOG_LEVELS = ["debug", "info", "warn", "error"] as const;

interface FileSecondary {
  url: string;
  charger_map?: Array<{ charger_id: string; mapped_charger_id?: string; password?: string; id_tag?: string }>;
}

interface FileOptions {
  primary_csms_url?: string;
  secondary_csms?: FileSecondary[];
  log_level?: string;
  log_max_message_length?: number;
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

function buildSecondaryChargerMapFromFile(
  entries: FileSecondary[]
): SecondaryChargerMap {
  const result: SecondaryChargerMap = new Map();
  for (const entry of entries) {
    if (!entry.url || !entry.charger_map?.length) continue;
    for (const m of entry.charger_map) {
      if (!m.charger_id) {
        log.warn("charger_map entry missing required charger_id, skipping", { url: entry.url, entry: m });
        continue;
      }
      if (!result.has(entry.url)) result.set(entry.url, new Map());
      result.get(entry.url)!.set(m.charger_id, {
        chargerId: m.mapped_charger_id || undefined,
        password: m.password || undefined,
        idTag: m.id_tag || undefined,
      });
    }
  }
  return result;
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

  const rawMaxLen = process.env.LOG_MAX_MESSAGE_LENGTH
    ? parseInt(process.env.LOG_MAX_MESSAGE_LENGTH, 10)
    : file.log_max_message_length;
  const logMaxMessageLength =
    rawMaxLen !== undefined && Number.isFinite(rawMaxLen) && rawMaxLen > 0
      ? Math.floor(rawMaxLen)
      : 120;

  const secondaryChargerMap = buildSecondaryChargerMapFromFile(fileSecondaries);

  return {
    port,
    primaryUrl,
    secondaryUrls,
    logLevel,
    logMaxMessageLength,
    secondaryChargerMap,
  };
}
