import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readLegacyState } from "../../src/state";

describe("legacy transaction-state upgrade", () => {
  let directory: string;
  let path: string;
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "ocpp-legacy-state-"));
    path = join(directory, "state.json");
  });
  afterEach(() => { rmSync(directory, { recursive: true, force: true }); });

  it("preserves old active bindings and distinct mapped charger identities", () => {
    const original = JSON.stringify({
      version: 1,
      txMaps: {
        "CP-1::ws://secondary.example": { "111": { secondaryTxId: "222", lastUpdatedAt: 0 } },
        "CP-1::ws://secondary.example::external": { "111": { secondaryTxId: "333", lastUpdatedAt: 0 } },
      },
    });
    writeFileSync(path, original);
    expect(readLegacyState(path)).toEqual(new Map([
      ["CP-1::ws://secondary.example", new Map([["111", "222"]])],
      ["CP-1::ws://secondary.example::external", new Map([["111", "333"]])],
    ]));
    expect(readFileSync(path, "utf8")).toBe(original);
  });

  it("starts without legacy mappings only when no legacy file exists", () => {
    expect(readLegacyState(path)).toEqual(new Map());
  });

  it.each([
    "{ not json",
    "null",
    '{"version":99,"txMaps":{}}',
    '{"version":1,"txMaps":[]}',
    '{"version":1,"txMaps":{"CP-1":[]}}',
    '{"version":1,"txMaps":{"CP-1":{"111":"222"}}}',
  ])("does not turn corrupt legacy data into an empty upgrade: %s", contents => {
    writeFileSync(path, contents);
    expect(() => readLegacyState(path)).toThrow();
    expect(readFileSync(path, "utf8")).toBe(contents);
  });
});
