import {
  describe,
  expect,
  it,
  beforeEach,
} from "vitest";

import { configureLogger, createLogger } from "../../src/logger";

describe("logger", () => {
  const restoreStreams = () => {
    const stdoutEntries: string[] = [];
    const stderrEntries: string[] = [];

    const originalStdoutWrite = process.stdout.write;
    const originalStderrWrite = process.stderr.write;

    process.stdout.write = (((chunk) => {
      stdoutEntries.push(String(chunk));
      return true;
    }) as (chunk: string | Buffer) => boolean) as unknown as typeof process.stdout.write;

    process.stderr.write = (((chunk) => {
      stderrEntries.push(String(chunk));
      return true;
    }) as (chunk: string | Buffer) => boolean) as unknown as typeof process.stderr.write;

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
      expect(JSON.parse(sink.stderrEntries[0]).level).toBe("error");
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

      const parsed = JSON.parse(sink.stdoutEntries[0]);
      expect(parsed.level).toBe("debug");
      expect(parsed.message).toContain('[OCPP CALL] (abc):');
      expect(parsed.message).toContain('[2,');
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

      const parsed = JSON.parse(sink.stdoutEntries[0]);
      const summaryPrefix = "[OCPP CALL] (abc): ";
      const expectedPayload = payload.slice(0, 120);

      expect(parsed.level).toBe("debug");
      expect(parsed.message).toBe(summaryPrefix + expectedPayload);
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

      const parsed = JSON.parse(sink.stdoutEntries[0]);
      const summaryPrefix = "[OCPP CALL] (abc): ";

      expect(parsed.level).toBe("debug");
      expect(parsed.message).toBe(summaryPrefix + payload);
    } finally {
      sink.restore();
    }
  });
});
