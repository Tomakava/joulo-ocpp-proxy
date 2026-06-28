import {
  OCPP_MSG_CALL,
  OCPP_MSG_CALLERROR,
  OCPP_MSG_CALLRESULT,
} from "./types";

export const LOG_LEVELS = ["debug", "info", "warn", "error"] as const;

export type LogLevel = (typeof LOG_LEVELS)[number];

export const DEFAULT_LOG_LEVEL: LogLevel = "info";

export interface LoggerConfig {
  logLevel: LogLevel;
  debugMessageMaxLength: number | null;
}

export function isLogLevel(value: string): value is LogLevel {
  return (LOG_LEVELS as readonly string[]).includes(value);
}

export function parseLogLevel(
  value: string | undefined,
  fallback: LogLevel = DEFAULT_LOG_LEVEL
): LogLevel {
  const level = (value ?? fallback).toLowerCase();
  return isLogLevel(level) ? level : fallback;
}

const LEVEL_WEIGHT: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

let minLevel: LogLevel = DEFAULT_LOG_LEVEL;
let debugMessageMaxLength: number | null = 120;

export function setLogLevel(level: LogLevel): void {
  minLevel = level;
}

export function setDebugMessageMaxLength(value: number | null): void {
  debugMessageMaxLength = value;
}

export function configureLogger(config: LoggerConfig): void {
  setLogLevel(config.logLevel);
  setDebugMessageMaxLength(config.debugMessageMaxLength);
}

function truncateMessage(raw: string): string {
  if (debugMessageMaxLength === null) return raw;
  return raw.slice(0, debugMessageMaxLength);
}

function summarizeDebugMessage(raw: string): string {
  try {
    const msg = JSON.parse(raw) as unknown[];
    if (!Array.isArray(msg) || msg.length < 3) return truncateMessage(raw);

    const type = msg[0] as number;
    const id = String(msg[1]);

    if (type === OCPP_MSG_CALL) {
      return `[CALL] ${msg[2]} (${id})`;
    }

    if (type === OCPP_MSG_CALLRESULT) {
      return `[RESULT] (${id})`;
    }

    if (type === OCPP_MSG_CALLERROR) {
      return `[ERROR] (${id})`;
    }

    return `[${type}] (${id})`;
  } catch {
    return truncateMessage(raw);
  }
}

function buildDebugExtra(extra?: object): object | undefined {
  if (!extra || !Object.hasOwn(extra as Record<string, unknown>, "message")) {
    return extra;
  }

  const payload = extra as Record<string, unknown>;
  const message = payload.message;
  if (typeof message !== "string") return extra;

  return {
    ...payload,
    message: summarizeDebugMessage(message),
  };
}

function log(level: LogLevel, tag: string, message: string, extra?: object) {
  if (LEVEL_WEIGHT[level] < LEVEL_WEIGHT[minLevel]) return;

  const entry: Record<string, unknown> = {
    time: new Date().toISOString(),
    level,
    tag,
    msg: message,
    ...extra,
  };

  const line = JSON.stringify(entry);

  if (level === "error") process.stderr.write(line + "\n");
  else process.stdout.write(line + "\n");
}

export function createLogger(tag: string) {
  return {
    debug: (msg: string, extra?: object) =>
      log("debug", tag, msg, buildDebugExtra(extra)),
    info: (msg: string, extra?: object) => log("info", tag, msg, extra),
    warn: (msg: string, extra?: object) => log("warn", tag, msg, extra),
    error: (msg: string, extra?: object) => log("error", tag, msg, extra),
  };
}
