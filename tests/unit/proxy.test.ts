import { describe, expect, it } from "vitest";

import type { SecondaryTarget } from "../../src/config";
import { uniqueSecondaries } from "../../src/proxy";

const target = (
  url: string,
  mappedChargerId: string,
  extra: Partial<SecondaryTarget> = {}
): SecondaryTarget => ({
  url,
  appendChargePointId: true,
  mappedChargerId,
  ...extra,
});

describe("uniqueSecondaries", () => {
  it("keeps the first of two secondaries with the same URL and charger ID", () => {
    const global = target("wss://a.example/ocpp", "CP-1");
    const mapped = target("wss://a.example/ocpp", "CP-1", { password: "x" });

    expect(uniqueSecondaries("CP-1", [global, mapped])).toEqual([global]);
  });

  it("keeps secondaries that share a URL under different charger IDs", () => {
    const first = target("wss://a.example/ocpp", "ext-A");
    const second = target("wss://a.example/ocpp", "ext-B");

    expect(uniqueSecondaries("CP-1", [first, second])).toEqual([first, second]);
  });
});
