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
  /**
   * Primary for chargers whose URL path matches no route. Optional when
   * primaryCsmsByPath is set: chargers on an unknown path are then refused.
   */
  primaryCsms?: CsmsBackend;
  /**
   * Primaries selected by the path in front of the charge point ID, keyed by
   * that path without leading or trailing slashes (`site-a`, `ocpp/site-b`).
   */
  primaryCsmsByPath?: Map<string, CsmsBackend>;
  /** Mirrors that receive traffic from every charger. */
  secondaryCsms: CsmsBackend[];
  /** Mirrors wired to one specific charger, keyed by its charge point ID. */
  secondariesByCharger: Map<string, SecondaryTarget[]>;
  loggerConfig: LoggerConfig;
}

export interface CsmsBackend {
  url: string;
  appendChargePointId: boolean;
}

/**
 * A secondary backend wired to a single charger, which may know that charger
 * under a different ID and expect its own credentials and idTag.
 */
export interface SecondaryTarget extends CsmsBackend {
  mappedChargerId: string;
  password?: string;
  idTag?: string;
}

interface FileSecondary {
  url: string;
}

interface FilePrimaryRoute {
  path: string;
  url: string;
  append_charge_point_id?: boolean;
}

interface FileChargerMapping {
  secondary_url: string;
  charger_id: string;
  mapped_charger_id?: string;
  password?: string;
  id_tag?: string;
}

interface FileOptions {
  primary_csms_url?: string;
  primary_csms_append_charge_point_id?: boolean;
  primary_csms_routes?: FilePrimaryRoute[];
  secondary_csms_append_charge_point_id?: boolean;
  secondary_csms?: FileSecondary[];
  charger_mappings?: FileChargerMapping[];
  log_level?: string;
  /**
   * Empty string or 0 disables truncation, matching
   * LOG_DEBUG_MESSAGE_MAX_LENGTH. 0 exists because the Home Assistant schema
   * can't express an empty integer.
   */
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
    primary_csms_append_charge_point_id: readBoolean(
      raw.primary_csms_append_charge_point_id,
      "primary_csms_append_charge_point_id"
    ),
    primary_csms_routes: readPrimaryRoutes(raw.primary_csms_routes),
    secondary_csms_append_charge_point_id: readBoolean(
      raw.secondary_csms_append_charge_point_id,
      "secondary_csms_append_charge_point_id"
    ),
    secondary_csms: readSecondaries(raw.secondary_csms),
    charger_mappings: readChargerMappings(raw.charger_mappings),
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

function readBoolean(value: unknown, option: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "boolean") return value;

  log.warn("config file option ignored: expected true or false", { option });
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

function readPrimaryRoutes(value: unknown): FilePrimaryRoute[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    log.warn("config file option ignored: expected a list", {
      option: "primary_csms_routes",
    });
    return undefined;
  }

  const routes: FilePrimaryRoute[] = [];
  value.forEach((entry, index) => {
    if (typeof entry !== "object" || entry === null) {
      log.warn("primary_csms_routes entry ignored: expected an object", {
        index,
      });
      return;
    }

    const raw = entry as Record<string, unknown>;
    const path =
      typeof raw.path === "string" ? normalizeRoutePath(raw.path) : "";
    const url = readEntryString(raw.url);

    if (path === "" || url === undefined) {
      log.warn(
        "primary_csms_routes entry ignored: path and url are required",
        { index }
      );
      return;
    }

    const append = raw.append_charge_point_id;
    if (append !== undefined && typeof append !== "boolean") {
      log.warn(
        "primary_csms_routes append_charge_point_id ignored: expected true or false",
        { index }
      );
    }

    routes.push({
      path,
      url,
      append_charge_point_id: typeof append === "boolean" ? append : undefined,
    });
  });

  return routes;
}

/**
 * A route path as the proxy compares it: no empty segments and no leading or
 * trailing slashes, so `/site-a/`, `site-a` and `//site-a` are one route.
 */
export function normalizeRoutePath(path: string): string {
  return path.split("/").filter(Boolean).join("/");
}

function readChargerMappings(
  value: unknown
): FileChargerMapping[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    log.warn("config file option ignored: expected a list", {
      option: "charger_mappings",
    });
    return undefined;
  }

  const mappings: FileChargerMapping[] = [];
  value.forEach((entry, index) => {
    if (typeof entry !== "object" || entry === null) {
      log.warn("charger_mappings entry ignored: expected an object", { index });
      return;
    }

    const raw = entry as Record<string, unknown>;
    const secondaryUrl = readEntryString(raw.secondary_url);
    const chargerId = readEntryString(raw.charger_id);

    if (secondaryUrl === undefined || chargerId === undefined) {
      // Report the position only — a mapping can carry a password, and this
      // log line ends up in the Home Assistant addon log.
      log.warn(
        "charger_mappings entry ignored: secondary_url and charger_id are required",
        { index }
      );
      return;
    }

    mappings.push({
      secondary_url: secondaryUrl,
      charger_id: chargerId,
      mapped_charger_id: readEntryString(raw.mapped_charger_id),
      password: readEntryString(raw.password),
      id_tag: readEntryString(raw.id_tag),
    });
  });

  return mappings;
}

/** A trimmed, non-empty string from a config file entry, or undefined. */
function readEntryString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;

  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
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
  fileValue: string | number | boolean | undefined,
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

/**
 * Group charger_mappings entries by the charge point ID the charger connects
 * with. Each entry wires one charger to one secondary backend, optionally under
 * a different identity.
 */
function buildSecondariesByCharger(
  entries: FileChargerMapping[],
  appendChargePointId: boolean
): Map<string, SecondaryTarget[]> {
  const result = new Map<string, SecondaryTarget[]>();

  // Entries arrive validated from parseFileOptions: both ids are non-empty.
  for (const entry of entries) {
    const target: SecondaryTarget = {
      url: entry.secondary_url,
      appendChargePointId,
      mappedChargerId: entry.mapped_charger_id ?? entry.charger_id,
      password: entry.password,
      idTag: entry.id_tag,
    };

    const targets = result.get(entry.charger_id);
    if (targets) targets.push(target);
    else result.set(entry.charger_id, [target]);
  }

  return result;
}

/**
 * Key primary_csms_routes by path. A route without its own
 * append_charge_point_id follows primary_csms_append_charge_point_id.
 */
function buildPrimaryCsmsByPath(
  routes: FilePrimaryRoute[],
  appendChargePointId: boolean
): Map<string, CsmsBackend> {
  const result = new Map<string, CsmsBackend>();

  for (const route of routes) {
    if (result.has(route.path)) {
      log.warn("duplicate primary_csms_routes path ignored", {
        path: route.path,
      });
      continue;
    }

    result.set(route.path, {
      url: route.url,
      appendChargePointId: route.append_charge_point_id ?? appendChargePointId,
    });
  }

  return result;
}

/** Like parseOptionalPositiveInteger, but 0 also means "no limit". */
function parseDebugMessageMaxLength(
  value: string | undefined
): number | undefined {
  if (value?.trim() === "0") return undefined;
  return parseOptionalPositiveInteger(value, DEFAULT_DEBUG_MESSAGE_MAX_LENGTH);
}

export function loadConfig(): Config {
  const file = loadFileOptions();

  // An empty string is how the Home Assistant form leaves the URL unset, which
  // is valid when primary_csms_routes is configured.
  const rawPrimaryUrl = (
    process.env.PRIMARY_CSMS_URL ?? file.primary_csms_url
  )?.trim();
  const primaryUrl: string | undefined =
    rawPrimaryUrl === "" ? undefined : rawPrimaryUrl;

  const envSecondaryUrls: string[] = (process.env.SECONDARY_CSMS_URLS ?? "")
    .split(",")
    .map((u) => u.trim())
    .filter(Boolean);

  const secondaryUrls: string[] =
    envSecondaryUrls.length > 0
      ? envSecondaryUrls
      : (file.secondary_csms ?? []).map((entry) => entry.url);

  const primaryAppendChargePointId: boolean = parseSetting(
    "PRIMARY_CSMS_APPEND_CHARGE_POINT_ID",
    "primary_csms_append_charge_point_id",
    file.primary_csms_append_charge_point_id,
    (value) => parseBoolean(value, true)
  );

  const primaryCsmsByPath = buildPrimaryCsmsByPath(
    file.primary_csms_routes ?? [],
    primaryAppendChargePointId
  );

  if (!primaryUrl && primaryCsmsByPath.size === 0) {
    throw new Error(
      "PRIMARY_CSMS_URL is required. Set it via the PRIMARY_CSMS_URL environment variable, the primary_csms_url config file option, or the addon configuration in Home Assistant. Alternatively, configure primary_csms_routes."
    );
  }

  const secondaryAppendChargePointId: boolean = parseSetting(
    "SECONDARY_CSMS_APPEND_CHARGE_POINT_ID",
    "secondary_csms_append_charge_point_id",
    file.secondary_csms_append_charge_point_id,
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
    parseDebugMessageMaxLength
  );

  const port: number = parseEnv("PORT", (value) =>
    parseIntegerInRange(value ?? "9000", 1, 65535)
  );

  const secondariesByCharger = buildSecondariesByCharger(
    file.charger_mappings ?? [],
    secondaryAppendChargePointId
  );

  return {
    port,
    primaryCsms: primaryUrl
      ? { url: primaryUrl, appendChargePointId: primaryAppendChargePointId }
      : undefined,
    primaryCsmsByPath,
    secondaryCsms,
    secondariesByCharger,
    loggerConfig: {
      logLevel,
      debugMessageMaxLength,
    },
  };
}
