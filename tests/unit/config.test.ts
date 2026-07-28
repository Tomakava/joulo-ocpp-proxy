import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import { loadConfig } from "../../src/config";

describe("loadConfig", () => {
  const environmentVariables = [
    "PRIMARY_CSMS_URL",
    "SECONDARY_CSMS_URLS",
    "PRIMARY_CSMS_APPEND_CHARGE_POINT_ID",
    "SECONDARY_CSMS_APPEND_CHARGE_POINT_ID",
    "LOG_LEVEL",
    "LOG_DEBUG_MESSAGE_MAX_LENGTH",
    "PORT",
  ] as const;

  beforeEach(() => {
    for (const envName of environmentVariables) {
      vi.stubEnv(envName, undefined);
    }
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("requires PRIMARY_CSMS_URL", () => {
    expect(() => loadConfig()).toThrow(
      "PRIMARY_CSMS_URL is required. Set it to your primary CSMS WebSocket URL."
    );
  });

  it("parses defaults and secondary list", () => {
    vi.stubEnv("PRIMARY_CSMS_URL", "wss://primary.example/ws");
    vi.stubEnv(
      "SECONDARY_CSMS_URLS",
      "wss://s1.example/ws,  wss://s2.example/ws ,, wss://s3.example/ws"
    );

    const config = loadConfig();

    expect(config.port).toBe(9000);
    expect(config.primaryCsms).toEqual({
      url: "wss://primary.example/ws",
      appendChargePointId: true,
    });
    expect(config.secondaryCsms).toEqual([
      {
        url: "wss://s1.example/ws",
        appendChargePointId: true,
      },
      {
        url: "wss://s2.example/ws",
        appendChargePointId: true,
      },
      {
        url: "wss://s3.example/ws",
        appendChargePointId: true,
      },
    ]);
    expect(config.loggerConfig.logLevel).toBe("info");
    expect(config.loggerConfig.debugMessageMaxLength).toBe(120);
  });

  it.each([
    { description: "empty", value: "" },
    { description: "whitespace", value: "   " },
  ])(
    "disables debug message truncation when env var is $description",
    ({ value }) => {
      vi.stubEnv("PRIMARY_CSMS_URL", "wss://primary.example/ws");
      vi.stubEnv("LOG_DEBUG_MESSAGE_MAX_LENGTH", value);

      const config = loadConfig();

      expect(config.loggerConfig.debugMessageMaxLength).toBeUndefined();
    }
  );

  it.each([
    { value: "1", expected: 1 },
    { value: "65535", expected: 65535 },
  ])("accepts port boundary $value", ({ value, expected }) => {
    vi.stubEnv("PRIMARY_CSMS_URL", "wss://primary.example/ws");
    vi.stubEnv("PORT", value);

    expect(loadConfig().port).toBe(expected);
  });

  it.each([
    {
      envName: "PORT",
      value: "70000",
      expectedCause:
        'Value must be an integer between 1 and 65535: "70000"',
    },
    {
      envName: "PORT",
      value: "9000junk",
      expectedCause: 'Invalid integer: "9000junk"',
    },
    {
      envName: "PORT",
      value: "3.14",
      expectedCause: 'Invalid integer: "3.14"',
    },
    {
      envName: "LOG_DEBUG_MESSAGE_MAX_LENGTH",
      value: "0",
      expectedCause: 'Value must be a positive integer: "0"',
    },
    {
      envName: "LOG_DEBUG_MESSAGE_MAX_LENGTH",
      value: "abc",
      expectedCause: 'Invalid integer: "abc"',
    },
    {
      envName: "PRIMARY_CSMS_APPEND_CHARGE_POINT_ID",
      value: "yes",
      expectedCause:
        'Invalid boolean value: "yes". Expected one of: true, false.',
    },
    {
      envName: "SECONDARY_CSMS_APPEND_CHARGE_POINT_ID",
      value: "nope",
      expectedCause:
        'Invalid boolean value: "nope". Expected one of: true, false.',
    },
    {
      envName: "LOG_LEVEL",
      value: "verbose",
      expectedCause:
        'Invalid value: "verbose". Expected one of: debug, info, warn, error.',
    },
  ])(
    "rejects invalid $envName value $value",
    ({ envName, value, expectedCause }) => {
      vi.stubEnv("PRIMARY_CSMS_URL", "wss://primary.example/ws");
      vi.stubEnv(envName, value);

      expect(() => loadConfig()).toThrow(
        `Invalid value for environment variable ${envName}: ${expectedCause}`
      );
    }
  );

  it("parses custom log settings", () => {
    vi.stubEnv("PRIMARY_CSMS_URL", "wss://primary.example/ws");
    vi.stubEnv("LOG_LEVEL", "warn");
    vi.stubEnv("LOG_DEBUG_MESSAGE_MAX_LENGTH", "77");
    vi.stubEnv("PORT", "9001");

    const config = loadConfig();

    expect(config.loggerConfig.logLevel).toBe("warn");
    expect(config.loggerConfig.debugMessageMaxLength).toBe(77);
    expect(config.port).toBe(9001);
  });

  it("parses append charge point id flags per csms config", () => {
    vi.stubEnv("PRIMARY_CSMS_URL", "ws://primary.local/ocpp");
    vi.stubEnv("PRIMARY_CSMS_APPEND_CHARGE_POINT_ID", "false");
    vi.stubEnv("SECONDARY_CSMS_APPEND_CHARGE_POINT_ID", "false");
    vi.stubEnv(
      "SECONDARY_CSMS_URLS",
      "ws://secondary-a.local/ocpp,ws://secondary-b.local/ocpp"
    );

    const config = loadConfig();

    expect(config.primaryCsms).toEqual({
      url: "ws://primary.local/ocpp",
      appendChargePointId: false,
    });
    expect(config.secondaryCsms).toEqual([
      { url: "ws://secondary-a.local/ocpp", appendChargePointId: false },
      { url: "ws://secondary-b.local/ocpp", appendChargePointId: false },
    ]);
  });
});
