import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import { loadConfig } from "../../src/config";
import { configureLogger } from "../../src/logger";

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
    // Keep the config file layer out of the way unless a test opts in.
    vi.stubEnv("CONFIG_FILE", join(tmpdir(), "ocpp-proxy-no-such-config.json"));
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    configureLogger({ logLevel: "info" });
  });

  it("requires PRIMARY_CSMS_URL", () => {
    expect(() => loadConfig()).toThrow("PRIMARY_CSMS_URL is required.");
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

  describe("config file", () => {
    const directory = mkdtempSync(join(tmpdir(), "ocpp-proxy-config-"));

    afterAll(() => {
      rmSync(directory, { recursive: true, force: true });
    });

    function writeConfigFile(options: object): void {
      const path = join(directory, "options.json");
      writeFileSync(path, JSON.stringify(options), "utf8");
      vi.stubEnv("CONFIG_FILE", path);
    }

    it("reads settings from the config file", () => {
      writeConfigFile({
        primary_csms_url: "wss://primary.example/ws",
        secondary_csms: [
          { url: "wss://s1.example/ws" },
          { url: "wss://s2.example/ws" },
        ],
        log_level: "warn",
      });

      const config = loadConfig();

      expect(config.primaryCsms.url).toBe("wss://primary.example/ws");
      expect(config.secondaryCsms).toEqual([
        { url: "wss://s1.example/ws", appendChargePointId: true },
        { url: "wss://s2.example/ws", appendChargePointId: true },
      ]);
      expect(config.loggerConfig.logLevel).toBe("warn");
    });

    it("lets environment variables override the config file", () => {
      writeConfigFile({
        primary_csms_url: "wss://file.example/ws",
        secondary_csms: [{ url: "wss://file-secondary.example/ws" }],
        log_level: "warn",
      });
      vi.stubEnv("PRIMARY_CSMS_URL", "wss://env.example/ws");
      vi.stubEnv("SECONDARY_CSMS_URLS", "wss://env-secondary.example/ws");
      vi.stubEnv("LOG_LEVEL", "error");

      const config = loadConfig();

      expect(config.primaryCsms.url).toBe("wss://env.example/ws");
      expect(config.secondaryCsms).toEqual([
        { url: "wss://env-secondary.example/ws", appendChargePointId: true },
      ]);
      expect(config.loggerConfig.logLevel).toBe("error");
    });

    it.each([
      { description: "a number", value: 42, expected: 42 },
      { description: "an empty string", value: "", expected: undefined },
    ])(
      "reads the debug message max length from the config file as $description",
      ({ value, expected }) => {
        writeConfigFile({
          primary_csms_url: "wss://primary.example/ws",
          log_debug_message_max_length: value,
        });

        expect(loadConfig().loggerConfig.debugMessageMaxLength).toBe(expected);
      }
    );

    it("still honours the pre-1.0.20 log_max_message_length option", () => {
      writeConfigFile({
        primary_csms_url: "wss://primary.example/ws",
        log_max_message_length: 55,
      });

      expect(loadConfig().loggerConfig.debugMessageMaxLength).toBe(55);
    });

    it("prefers the current option name over the deprecated one", () => {
      writeConfigFile({
        primary_csms_url: "wss://primary.example/ws",
        log_debug_message_max_length: 30,
        log_max_message_length: 55,
      });

      expect(loadConfig().loggerConfig.debugMessageMaxLength).toBe(30);
    });

    it("groups charger_mappings by charge point ID", () => {
      writeConfigFile({
        primary_csms_url: "wss://primary.example/ws",
        charger_mappings: [
          {
            secondary_url: "wss://analytics.example/ws",
            charger_id: "CP-1",
          },
          {
            secondary_url: "wss://other.example/ws",
            charger_id: "CP-1",
            mapped_charger_id: "ext-CP-1",
            password: "secret",
            id_tag: "TAG",
          },
          { secondary_url: "wss://analytics.example/ws", charger_id: "CP-2" },
          // Incomplete entries are skipped rather than failing startup.
          { charger_id: "CP-3" },
        ],
      });

      const { secondariesByCharger } = loadConfig();

      expect([...secondariesByCharger.keys()]).toEqual(["CP-1", "CP-2"]);
      expect(secondariesByCharger.get("CP-1")).toEqual([
        {
          url: "wss://analytics.example/ws",
          appendChargePointId: true,
          mappedChargerId: "CP-1",
          password: undefined,
          idTag: undefined,
        },
        {
          url: "wss://other.example/ws",
          appendChargePointId: true,
          mappedChargerId: "ext-CP-1",
          password: "secret",
          idTag: "TAG",
        },
      ]);
    });

    it("never logs a mapping password when skipping an invalid entry", () => {
      writeConfigFile({
        primary_csms_url: "wss://primary.example/ws",
        charger_mappings: [{ charger_id: "CP-1", password: "hunter2" }],
      });

      const lines: string[] = [];
      configureLogger({
        logLevel: "warn",
        sink: {
          stdout: (line) => lines.push(line),
          stderr: (line) => lines.push(line),
        },
      });

      loadConfig();

      const output = lines.join(" ");
      expect(output).toContain("charger_mappings entry ignored");
      expect(output).not.toContain("hunter2");
    });

    it("rejects an invalid config file value", () => {
      writeConfigFile({
        primary_csms_url: "wss://primary.example/ws",
        log_level: "verbose",
      });

      expect(() => loadConfig()).toThrow(
        "Invalid value for config file option log_level:"
      );
    });

    it.each([
      {
        description: "not an object",
        contents: '["wss://secondary.example/ws"]',
      },
      {
        description: "a list where an object is expected",
        contents: JSON.stringify({
          primary_csms_url: "wss://primary.example/ws",
          secondary_csms: "wss://secondary.example/ws",
        }),
      },
      {
        description: "entries of the wrong shape",
        contents: JSON.stringify({
          primary_csms_url: "wss://primary.example/ws",
          secondary_csms: [null, "wss://secondary.example/ws", { url: 42 }, {}],
        }),
      },
    ])("ignores config file options that are $description", ({ contents }) => {
      const path = join(directory, "wrong-types.json");
      writeFileSync(path, contents, "utf8");
      vi.stubEnv("CONFIG_FILE", path);
      vi.stubEnv("PRIMARY_CSMS_URL", "wss://env.example/ws");

      const config = loadConfig();

      expect(config.primaryCsms.url).toBe("wss://env.example/ws");
      expect(config.secondaryCsms).toEqual([]);
    });

    it("keeps the valid entries when only some are malformed", () => {
      writeConfigFile({
        primary_csms_url: "wss://primary.example/ws",
        secondary_csms: [{ url: "  wss://s1.example/ws  " }, { url: "" }],
        log_level: 7,
      });

      const config = loadConfig();

      expect(config.secondaryCsms).toEqual([
        { url: "wss://s1.example/ws", appendChargePointId: true },
      ]);
      // A non-string log_level is dropped, so the default applies.
      expect(config.loggerConfig.logLevel).toBe("info");
    });

    it("ignores a malformed config file", () => {
      const path = join(directory, "malformed.json");
      writeFileSync(path, "{ not json", "utf8");
      vi.stubEnv("CONFIG_FILE", path);
      vi.stubEnv("PRIMARY_CSMS_URL", "wss://primary.example/ws");

      const config = loadConfig();

      expect(config.primaryCsms.url).toBe("wss://primary.example/ws");
      expect(config.secondaryCsms).toEqual([]);
    });
  });
});
