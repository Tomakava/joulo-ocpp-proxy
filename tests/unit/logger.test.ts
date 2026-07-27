import {
  describe,
  expect,
  it,
  beforeEach,
} from "vitest";

import { configureLogger, createLogger } from "../../src/logger";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseLogEntry(line: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(line);
  if (!isRecord(parsed)) {
    throw new Error("Expected logger output to be a JSON object");
  }

  return parsed;
}

function getStringProperty(
  entry: Record<string, unknown>,
  property: string
): string {
  const value = entry[property];
  if (typeof value !== "string") {
    throw new Error(`Expected logger output property ${property} to be a string`);
  }

  return value;
}

describe("logger", () => {
  const restoreStreams = () => {
    const stdoutEntries: string[] = [];
    const stderrEntries: string[] = [];

    const originalStdoutWrite = process.stdout.write.bind(process.stdout);
    const originalStderrWrite = process.stderr.write.bind(process.stderr);

    process.stdout.write = (chunk: string | Uint8Array) => {
      stdoutEntries.push(String(chunk));
      return true;
    };

    process.stderr.write = (chunk: string | Uint8Array) => {
      stderrEntries.push(String(chunk));
      return true;
    };

    return {
      restore: () => {
        process.stdout.write = originalStdoutWrite;
        process.stderr.write = originalStderrWrite;
      },
      stdoutEntries,
      stderrEntries,
    };
  };

  beforeEach(() => {
    configureLogger({ logLevel: "info" });
  });

  it("suppresses logs below configured level", () => {
    const sink = restoreStreams();
    try {
      configureLogger({ logLevel: "error" });
      const logger = createLogger("proxy");

      logger.info("info message");
      logger.error("error message");

      expect(sink.stdoutEntries).toHaveLength(0);
      expect(sink.stderrEntries).toHaveLength(1);
      const entry = parseLogEntry(sink.stderrEntries[0]);
      expect(getStringProperty(entry, "level")).toBe("error");
    } finally {
      sink.restore();
    }
  });

  it("truncates debug message payloads", () => {
    const sink = restoreStreams();
    try {
      configureLogger({ logLevel: "debug", debugMessageMaxLength: 4 });
      const logger = createLogger("proxy");

      logger.debugOcppFrame("charger -> proxy", '[2,"abc","Heartbeat",{}]');

      const entry = parseLogEntry(sink.stdoutEntries[0]);
      expect(getStringProperty(entry, "level")).toBe("debug");
      expect(getStringProperty(entry, "message")).toContain('[OCPP CALL] (abc):');
      expect(getStringProperty(entry, "message")).toContain('[2,');
    } finally {
      sink.restore();
    }
  });

  it("truncates debug message payloads by default", () => {
    const sink = restoreStreams();
    try {
      configureLogger({ logLevel: "debug" });
      const logger = createLogger("proxy");

      const payload = '[2,"abc","Heartbeat",{"data":"' + "a".repeat(160) + '"}]';
      logger.debugOcppFrame("charger -> proxy", payload);

      const entry = parseLogEntry(sink.stdoutEntries[0]);
      const summaryPrefix = "[OCPP CALL] (abc): ";
      const expectedPayload = payload.slice(0, 120);

      expect(getStringProperty(entry, "level")).toBe("debug");
      expect(getStringProperty(entry, "message")).toBe(summaryPrefix + expectedPayload);
    } finally {
      sink.restore();
    }
  });

  it("does not truncate when debugMessageMaxLength is explicitly undefined", () => {
    const sink = restoreStreams();
    try {
      configureLogger({
        logLevel: "debug",
        debugMessageMaxLength: undefined,
      });
      const logger = createLogger("proxy");

      const payload = '[2,"abc","Heartbeat",{"data":"' + "a".repeat(160) + '"}]';
      logger.debugOcppFrame("charger -> proxy", payload);

      const entry = parseLogEntry(sink.stdoutEntries[0]);
      const summaryPrefix = "[OCPP CALL] (abc): ";

      expect(getStringProperty(entry, "level")).toBe("debug");
      expect(getStringProperty(entry, "message")).toBe(summaryPrefix + payload);
    } finally {
      sink.restore();
    }
  });
});
