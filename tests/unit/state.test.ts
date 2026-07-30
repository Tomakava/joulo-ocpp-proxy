import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { StateStore } from "../../src/state";

describe("StateStore", () => {
  let directory: string;
  let path: string;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "ocpp-proxy-state-store-"));
    path = join(directory, "state.json");
  });

  afterEach(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  it("round-trips mappings through the state file", () => {
    const store = new StateStore(path);
    store.set("CP-1", "wss://secondary.example/ws", "111", "222");
    store.set("CP-1", "wss://other.example/ws", "111", "333");
    store.flush();

    const reloaded = new StateStore(path);
    reloaded.load();

    expect(reloaded.get("CP-1", "wss://secondary.example/ws")).toEqual(
      new Map([["111", "222"]])
    );
    expect(reloaded.get("CP-1", "wss://other.example/ws")).toEqual(
      new Map([["111", "333"]])
    );
    expect(reloaded.get("CP-2", "wss://secondary.example/ws")).toEqual(new Map());
  });

  it("returns a detached map so session changes don't mutate the store", () => {
    const store = new StateStore(path);
    store.set("CP-1", "wss://secondary.example/ws", "111", "222");

    const working = store.get("CP-1", "wss://secondary.example/ws");
    working.set("999", "888");

    expect(store.get("CP-1", "wss://secondary.example/ws")).toEqual(
      new Map([["111", "222"]])
    );
  });

  it("forgets a mapping once its transaction is deleted", () => {
    const store = new StateStore(path);
    store.set("CP-1", "wss://secondary.example/ws", "111", "222");
    store.delete("CP-1", "wss://secondary.example/ws", "111");
    store.flush();

    expect(readFileSync(path, "utf8")).not.toContain("222");

    const reloaded = new StateStore(path);
    reloaded.load();
    expect(reloaded.get("CP-1", "wss://secondary.example/ws")).toEqual(new Map());
  });

  it("prunes entries older than the retention window on load", () => {
    const eightDaysAgo = Date.now() - 8 * 24 * 60 * 60 * 1000;
    writeFileSync(
      path,
      JSON.stringify({
        version: 1,
        txMaps: {
          "CP-1::wss://secondary.example/ws": {
            "111": { secondaryTxId: "222", lastUpdatedAt: eightDaysAgo },
            "112": { secondaryTxId: "223", lastUpdatedAt: Date.now() },
          },
        },
      }),
      "utf8"
    );

    const store = new StateStore(path);
    store.load();

    expect(store.get("CP-1", "wss://secondary.example/ws")).toEqual(
      new Map([["112", "223"]])
    );
  });

  it.each([
    { description: "a missing file", contents: null },
    { description: "malformed JSON", contents: "{ not json" },
    { description: "an unknown version", contents: '{"version":99,"txMaps":{}}' },
    {
      description: "entries of the wrong shape",
      contents: JSON.stringify({
        version: 1,
        txMaps: { "CP-1::wss://secondary.example/ws": { "111": "222" } },
      }),
    },
  ])("starts empty given $description", ({ contents }) => {
    if (contents !== null) writeFileSync(path, contents, "utf8");

    const store = new StateStore(path);
    store.load();

    expect(store.get("CP-1", "wss://secondary.example/ws")).toEqual(new Map());
  });

  it("does not throw when the state file cannot be written", () => {
    const store = new StateStore(join(directory, "missing-dir", "state.json"));
    store.set("CP-1", "wss://secondary.example/ws", "111", "222");

    expect(() => {
      store.flush();
    }).not.toThrow();
  });
});
