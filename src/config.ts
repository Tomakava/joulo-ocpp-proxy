import { existsSync, readFileSync } from "fs";

import type { LoggerConfig, LogLevel } from "./logger";
import {
  createLogger,
  DEFAULT_DEBUG_MESSAGE_MAX_LENGTH,
  DEFAULT_LOG_LEVEL,
  LOG_LEVELS,
} from "./logger";
import {
  parseBoolean,
  parseEnv,
  parseIntegerInRange,
  parseOptionalPositiveInteger,
  parseStringUnion,
} from "./utils/value-parsers";

const log = createLogger("config");

export interface Config {
  port: number;
  primaryCsms: CsmsBackend;
  secondaryCsms: CsmsBackend[];
  loggerConfig: LoggerConfig;
}

export interface CsmsBackend {
  url: string;
  appendChargePointId: boolean;
}

interface FileSecondary {
  url: string;
}

interface FileOptions {
  primary_csms_url?: string;
  secondary_csms?: FileSecondary[];
  log_level?: string;
  /** Empty string disables truncation, matching LOG_DEBUG_MESSAGE_MAX_LENGTH. */
  log_debug_message_max_length?: number | string;
}

/** Home Assistant writes the addon options here. */
const DEFAULT_CONFIG_FILE = "/data/options.json";

function loadFileOptions(): FileOptions {
  const path = process.env.CONFIG_FILE ?? DEFAULT_CONFIG_FILE;
  if (!existsSync(path)) {
    log.info("no config file found, using environment variables");
    return {};
  }
  try {
    log.info("loading config file", { path });
    return parseFileOptions(JSON.parse(readFileSync(path, "utf8")));
  } catch (error) {
    log.error("failed to read config file", { path, error: String(error) });
    return {};
  }
}

/**
 * Pick the recognized options out of a parsed config file.
 *
 * The file is user-written and untrusted: in Home Assistant the addon schema
 * validates it first, but a hand-written CONFIG_FILE has no such guard. Options
 * of the wrong type are reported and dropped rather than crashing startup, so
 * one bad line can't take the proxy down.
 */
function parseFileOptions(parsed: unknown): FileOptions {
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    log.error("config file is not a JSON object, ignoring it");
    return {};
  }

  const raw = parsed as Record<string, unknown>;

  return {
    primary_csms_url: readString(raw.primary_csms_url, "primary_csms_url"),
    secondary_csms: readSecondaries(raw.secondary_csms),
    log_level: readString(raw.log_level, "log_level"),
    log_debug_message_max_length:
      readScalar(
        raw.log_debug_message_max_length,
        "log_debug_message_max_length"
      ) ?? readLegacyMaxLength(raw.log_max_message_length),
  };
}

/**
 * Up to addon 1.0.19 this option was named log_max_message_length. Keep reading
 * it so upgrading doesn't silently drop a configured limit back to the default.
 */
function readLegacyMaxLength(value: unknown): string | number | undefined {
  const legacy = readScalar(value, "log_max_message_length");
  if (legacy === undefined) return undefined;

  log.warn(
    "log_max_message_length is deprecated, rename it to log_debug_message_max_length"
  );
  return legacy;
}

function readString(value: unknown, option: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "string") return value;

  log.warn("config file option ignored: expected a string", { option });
  return undefined;
}

function readScalar(
  value: unknown,
  option: string
): string | number | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "string" || typeof value === "number") return value;

  log.warn("config file option ignored: expected a string or number", {
    option,
  });
  return undefined;
}

function readSecondaries(value: unknown): FileSecondary[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    log.warn("config file option ignored: expected a list", {
      option: "secondary_csms",
    });
    return undefined;
  }

  const secondaries: FileSecondary[] = [];
  value.forEach((entry, index) => {
    const url =
      typeof entry === "object" && entry !== null
        ? (entry as Record<string, unknown>).url
        : undefined;

    if (typeof url !== "string" || url.trim() === "") {
      log.warn("secondary_csms entry ignored: expected a non-empty url", {
        index,
      });
      return;
    }

    secondaries.push({ url: url.trim() });
  });

  return secondaries;
}

/**
 * Resolve a setting from the environment first, falling back to the config
 * file. File values are stringified so both sources share the same parser.
 * A set-but-empty environment variable still wins: for some settings an empty
 * value is meaningful (an empty LOG_DEBUG_MESSAGE_MAX_LENGTH disables
 * truncation), so it must not silently fall through to the config file.
 */
function parseSetting<T>(
  envName: string,
  fileOptionName: string,
  fileValue: string | number | undefined,
  parser: (value: string | undefined) => T
): T {
  const envValue = process.env[envName];
  if (envValue !== undefined) {
    return parseEnv(envName, parser);
  }

  if (fileValue === undefined) {
    return parser(undefined);
  }

  try {
    return parser(String(fileValue));
  } catch (error) {
    if (error instanceof Error) {
      throw new Error(
        `Invalid value for config file option ${fileOptionName}: ${error.message}`,
        { cause: error }
      );
    }

    throw new Error(`Invalid value for config file option ${fileOptionName}.`, {
      cause: error,
    });
  }
}

export function loadConfig(): Config {
  const file = loadFileOptions();

  const primaryUrl: string | undefined =
    process.env.PRIMARY_CSMS_URL ?? file.primary_csms_url;
  if (!primaryUrl) {
    throw new Error(
      "PRIMARY_CSMS_URL is required. Set it via the PRIMARY_CSMS_URL environment variable, the primary_csms_url config file option, or the addon configuration in Home Assistant."
    );
  }

  const envSecondaryUrls: string[] = (process.env.SECONDARY_CSMS_URLS ?? "")
    .split(",")
    .map((u) => u.trim())
    .filter(Boolean);

  const secondaryUrls: string[] =
    envSecondaryUrls.length > 0
      ? envSecondaryUrls
      : (file.secondary_csms ?? []).map((entry) => entry.url);

  const primaryAppendChargePointId: boolean = parseEnv(
    "PRIMARY_CSMS_APPEND_CHARGE_POINT_ID",
    (value) => parseBoolean(value, true)
  );

  const secondaryAppendChargePointId: boolean = parseEnv(
    "SECONDARY_CSMS_APPEND_CHARGE_POINT_ID",
    (value) => parseBoolean(value, true)
  );

  const secondaryCsms: CsmsBackend[] = secondaryUrls.map((url) => ({
    url,
    appendChargePointId: secondaryAppendChargePointId,
  }));

  const logLevel: LogLevel = parseSetting(
    "LOG_LEVEL",
    "log_level",
    file.log_level,
    (value) => parseStringUnion(value, LOG_LEVELS, DEFAULT_LOG_LEVEL)
  );
  const debugMessageMaxLength: number | undefined = parseSetting(
    "LOG_DEBUG_MESSAGE_MAX_LENGTH",
    "log_debug_message_max_length",
    file.log_debug_message_max_length,
    (value) =>
      parseOptionalPositiveInteger(
        value,
        DEFAULT_DEBUG_MESSAGE_MAX_LENGTH
      )
  );

  const port: number = parseEnv("PORT", (value) =>
    parseIntegerInRange(value ?? "9000", 1, 65535)
  );

  return {
    port,
    primaryCsms: {
      url: primaryUrl,
      appendChargePointId: primaryAppendChargePointId,
    },
    secondaryCsms,
    loggerConfig: {
      logLevel,
      debugMessageMaxLength,
    },
  };
}
