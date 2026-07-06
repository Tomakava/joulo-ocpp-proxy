import {
  describe,
  expect,
  it,
  beforeEach,
  afterEach,
} from "vitest";

import { loadConfig } from "../../src/config";

describe("loadConfig", () => {
  const restore = () => {
    delete process.env.PRIMARY_CSMS_URL;
    delete process.env.SECONDARY_CSMS_URLS;
    delete process.env.LOG_LEVEL;
    delete process.env.LOG_DEBUG_MESSAGE_MAX_LENGTH;
    delete process.env.PORT;
  };

  beforeEach(() => {
    restore();
  });

  afterEach(() => {
    restore();
  });

  it("requires PRIMARY_CSMS_URL", () => {
    expect(() => loadConfig()).toThrow(
      "PRIMARY_CSMS_URL is required. Set it to your primary CSMS WebSocket URL."
    );
  });

  it("parses defaults and secondary list", () => {
    process.env.PRIMARY_CSMS_URL = "wss://primary.example/ws";
    process.env.SECONDARY_CSMS_URLS = "wss://s1.example/ws,  wss://s2.example/ws ,, wss://s3.example/ws";

    const config = loadConfig();

    expect(config.port).toBe(9000);
    expect(config.primaryUrl).toBe("wss://primary.example/ws");
    expect(config.secondaryUrls).toEqual([
      "wss://s1.example/ws",
      "wss://s2.example/ws",
      "wss://s3.example/ws",
    ]);
    expect(config.loggerConfig.logLevel).toBe("info");
    expect(config.loggerConfig.debugMessageMaxLength).toBe(120);
  });

  it("validates port boundaries", () => {
    process.env.PRIMARY_CSMS_URL = "wss://primary.example/ws";
    process.env.PORT = "70000";

    expect(() => loadConfig()).toThrow('Invalid PORT value: "70000"');
  });

  it("parses custom log settings", () => {
    process.env.PRIMARY_CSMS_URL = "wss://primary.example/ws";
    process.env.LOG_LEVEL = "warn";
    process.env.LOG_DEBUG_MESSAGE_MAX_LENGTH = "77";
    process.env.PORT = "9001";

    const config = loadConfig();

    expect(config.loggerConfig.logLevel).toBe("warn");
    expect(config.loggerConfig.debugMessageMaxLength).toBe(77);
    expect(config.port).toBe(9001);
  });
});
