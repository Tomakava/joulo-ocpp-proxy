import { describe, expect, it } from "vitest";

import type { CsmsBackend } from "../../../src/config";
import { resolveCsmsUrl } from "../../../src/utils/url";

describe("resolveCsmsUrl", () => {
  const createBackend = (url: string, appendChargePointId = true): CsmsBackend => ({
    url,
    appendChargePointId,
  });

  it.each([
    {
      description: "appends charge point id when enabled",
      url: "ws://example.local/ocpp",
      appendChargePointId: true,
      chargePointId: "cp-1",
      expected: "ws://example.local/ocpp/cp-1",
    },
    {
      description: "appends charge point id with query params preserved",
      url: "ws://example.local/endpoint?tenant=emea",
      appendChargePointId: true,
      chargePointId: "cp-query",
      expected: "ws://example.local/endpoint/cp-query?tenant=emea",
    },
    {
      description: "keeps a single trailing slash between path and id",
      url: "ws://example.local/endpoint//",
      appendChargePointId: true,
      chargePointId: "cp-1",
      expected: "ws://example.local/endpoint/cp-1",
    },
    {
      description: "returns original URL when disabled",
      url: "ws://example.local/endpoint?tenant=emea",
      appendChargePointId: false,
      chargePointId: "cp-1",
      expected: "ws://example.local/endpoint?tenant=emea",
    },
  ])(
    "$description",
    ({ url, appendChargePointId, chargePointId, expected }) => {
      const backend = createBackend(url, appendChargePointId);

      expect(resolveCsmsUrl(backend, chargePointId)).toBe(expected);
    }
  );
});
