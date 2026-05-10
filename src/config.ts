import { existsSync, readFileSync } from "fs";
import { createLogger } from "./logger";

const log = createLogger("config");

export interface SecondaryTarget {
  url: string;
  mappedChargerId: string;
  password?: string;
  idTag?: string;
}

export interface Config {
  port: number;
  primaryUrl: string;
  logLevel: "debug" | "info" | "warn" | "error";
  logMaxMessageLength: number;
  secondariesByCharger: Map<string, SecondaryTarget[]>;
}

const LOG_LEVELS = ["debug", "info", "warn", "error"] as const;

interface FileChargerMapping {
  secondary_url: string;
  charger_id: string;
  mapped_charger_id?: string;
  password?: string;
  id_tag?: string;
}

interface FileOptions {
  primary_csms_url?: string;
  charger_mappings?: FileChargerMapping[];
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

function buildSecondariesByCharger(
  entries: FileChargerMapping[]
): Map<string, SecondaryTarget[]> {
  const result = new Map<string, SecondaryTarget[]>();
  for (const m of entries) {
    if (!m.secondary_url || !m.charger_id) {
      log.warn("charger_mappings entry missing secondary_url or charger_id, skipping", { entry: m });
      continue;
    }
    const target: SecondaryTarget = {
      url: m.secondary_url,
      mappedChargerId: m.mapped_charger_id || m.charger_id,
      password: m.password || undefined,
      idTag: m.id_tag || undefined,
    };
    const list = result.get(m.charger_id);
    if (list) list.push(target);
    else result.set(m.charger_id, [target]);
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

  const secondariesByCharger = buildSecondariesByCharger(file.charger_mappings ?? []);

  return {
    port,
    primaryUrl,
    logLevel,
    logMaxMessageLength,
    secondariesByCharger,
  };
}
