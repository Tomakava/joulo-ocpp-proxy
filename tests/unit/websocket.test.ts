import { describe, expect, it } from "vitest";

import { rawDataToString } from "../../src/websocket";

describe("rawDataToString", () => {
  it("converts a Buffer", () => {
    expect(rawDataToString(Buffer.from("message"))).toBe("message");
  });

  it("converts an ArrayBuffer", () => {
    expect(rawDataToString(new Uint8Array([109, 115, 103]).buffer)).toBe("msg");
  });

  it("concatenates Buffer fragments", () => {
    expect(rawDataToString([Buffer.from("mes"), Buffer.from("sage")])).toBe("message");
  });
});
