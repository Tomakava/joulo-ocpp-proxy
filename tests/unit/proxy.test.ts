import { describe, expect, it } from "vitest";

import type { CsmsBackend, SecondaryTarget } from "../../src/config";
import {
  parseChargerPath,
  selectPrimary,
  uniqueSecondaries,
} from "../../src/proxy";

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

describe("parseChargerPath", () => {
  it.each([
    { url: "/CP-1", routePath: "", chargePointId: "CP-1" },
    { url: "/site-a/CP-1", routePath: "site-a", chargePointId: "CP-1" },
    { url: "//ocpp/site-b//CP-1/?x=y", routePath: "ocpp/site-b", chargePointId: "CP-1" },
    { url: "/", routePath: "", chargePointId: null },
    { url: undefined, routePath: "", chargePointId: null },
  ])("splits $url", ({ url, routePath, chargePointId }) => {
    expect(parseChargerPath(url)).toEqual({ routePath, chargePointId });
  });
});

describe("selectPrimary", () => {
  const fallback: CsmsBackend = {
    url: "wss://default.example/ocpp",
    appendChargePointId: true,
  };
  const siteA: CsmsBackend = {
    url: "wss://a.example/ocpp",
    appendChargePointId: false,
  };
  const primaryCsmsByPath = new Map([["site-a", siteA]]);

  it("uses the route matching the path", () => {
    expect(
      selectPrimary({ primaryCsms: fallback, primaryCsmsByPath }, "site-a")
    ).toBe(siteA);
  });

  it("falls back to the default primary for an unknown path", () => {
    expect(
      selectPrimary({ primaryCsms: fallback, primaryCsmsByPath }, "ocpp")
    ).toBe(fallback);
    expect(selectPrimary({ primaryCsms: fallback }, "")).toBe(fallback);
  });

  it("finds no primary for an unknown path without a default", () => {
    expect(selectPrimary({ primaryCsmsByPath }, "site-b")).toBeUndefined();
    expect(selectPrimary({ primaryCsmsByPath }, "")).toBeUndefined();
  });
});
