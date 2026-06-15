export const LOG_LEVELS = ["full", "debug", "info", "warn", "error"] as const;

export type LogLevel = (typeof LOG_LEVELS)[number];

export const DEFAULT_LOG_LEVEL: LogLevel = "info";

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
  full: -1,
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

let minLevel: LogLevel = DEFAULT_LOG_LEVEL;

export function setLogLevel(level: LogLevel): void {
  minLevel = level;
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
    full: (msg: string, extra?: object) => log("full", tag, msg, extra),
    debug: (msg: string, extra?: object) => log("debug", tag, msg, extra),
    info: (msg: string, extra?: object) => log("info", tag, msg, extra),
    warn: (msg: string, extra?: object) => log("warn", tag, msg, extra),
    error: (msg: string, extra?: object) => log("error", tag, msg, extra),
  };
}
