import type { LoggerConfig, LogLevel } from "./logger";
import {
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

export function loadConfig(): Config {
  const primaryUrl: string | undefined = process.env.PRIMARY_CSMS_URL;
  if (!primaryUrl) {
    throw new Error(
      "PRIMARY_CSMS_URL is required. Set it to your primary CSMS WebSocket URL."
    );
  }

  const secondaryUrls: string[] = (process.env.SECONDARY_CSMS_URLS ?? "")
    .split(",")
    .map((u) => u.trim())
    .filter(Boolean);

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

  const logLevel: LogLevel = parseEnv(
    "LOG_LEVEL",
    (value) => parseStringUnion(value, LOG_LEVELS, DEFAULT_LOG_LEVEL)
  );
  const debugMessageMaxLength: number | undefined = parseEnv(
    "LOG_DEBUG_MESSAGE_MAX_LENGTH",
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
