import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ChargerCallGate } from "../../src/charger-calls";

const TIMEOUT_MS = 30_000;

function setup(options: { chargerOpen?: boolean } = {}) {
  const toCharger: string[] = [];
  const toSecondary: { secondary: string; raw: string }[] = [];
  let chargerOpen = options.chargerOpen ?? true;

  const gate = new ChargerCallGate<string>({
    sendToCharger: (raw) => {
      if (!chargerOpen) return false;
      toCharger.push(raw);
      return true;
    },
    replyToSecondary: (secondary, raw) => {
      toSecondary.push({ secondary, raw });
    },
    describe: (secondary) => secondary,
    log: { warn: vi.fn(), debug: vi.fn() },
    timeoutMs: TIMEOUT_MS,
  });

  return {
    gate,
    toCharger,
    toSecondary,
    setChargerOpen(open: boolean) {
      chargerOpen = open;
    },
  };
}

const call = (id: string, action = "TriggerMessage") =>
  `[2,"${id}","${action}",{}]`;

describe("ChargerCallGate", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("sends a secondary CALL only once the primary's CALL is answered", () => {
    const { gate, toCharger } = setup();

    gate.sendFromPrimary("p1", call("p1", "Reset"));
    gate.sendFromSecondary("sec-a", "s1", call("s1"));
    expect(toCharger).toEqual([call("p1", "Reset")]);

    expect(gate.routeReply("p1")).toEqual({ to: "primary" });
    expect(toCharger).toEqual([call("p1", "Reset"), call("s1")]);

    expect(gate.routeReply("s1")).toEqual({
      to: "secondary",
      secondary: "sec-a",
    });
  });

  it("holds a primary CALL behind a secondary one, then sends it first", () => {
    const { gate, toCharger } = setup();

    gate.sendFromSecondary("sec-a", "s1", call("s1"));
    gate.sendFromSecondary("sec-b", "s2", call("s2"));
    gate.sendFromPrimary("p1", call("p1", "Reset"));
    expect(toCharger).toEqual([call("s1")]);

    gate.routeReply("s1");
    // The primary goes ahead of the queued secondary CALL...
    expect(toCharger).toEqual([call("s1"), call("p1", "Reset")]);

    // ...and the secondary waits for the primary's answer.
    gate.routeReply("p1");
    expect(toCharger).toEqual([call("s1"), call("p1", "Reset"), call("s2")]);
  });

  it("never holds a primary CALL behind another primary CALL", () => {
    const { gate, toCharger } = setup();

    gate.sendFromPrimary("p1", call("p1", "Reset"));
    gate.sendFromPrimary("p2", call("p2", "ClearCache"));

    expect(toCharger).toEqual([call("p1", "Reset"), call("p2", "ClearCache")]);
  });

  it("answers a secondary with an error when the charger never replies", () => {
    const { gate, toCharger, toSecondary } = setup();

    gate.sendFromSecondary("sec-a", "s1", call("s1"));
    vi.advanceTimersByTime(TIMEOUT_MS / 2);
    gate.sendFromSecondary("sec-b", "s2", call("s2"));
    vi.advanceTimersByTime(TIMEOUT_MS / 2);

    expect(toSecondary).toEqual([
      {
        secondary: "sec-a",
        raw: '[4,"s1","GenericError","Proxy: charger did not answer in time",{}]',
      },
    ]);
    // The slot is free again, so the next CALL goes out.
    expect(toCharger).toEqual([call("s1"), call("s2")]);

    // A late reply to the timed-out CALL reaches no one.
    expect(gate.routeReply("s1")).toEqual({ to: "none" });
  });

  it("frees the slot when a primary CALL goes unanswered", () => {
    const { gate, toCharger } = setup();

    gate.sendFromPrimary("p1", call("p1", "Reset"));
    vi.advanceTimersByTime(TIMEOUT_MS / 2);
    gate.sendFromSecondary("sec-a", "s1", call("s1"));
    expect(toCharger).toEqual([call("p1", "Reset")]);

    vi.advanceTimersByTime(TIMEOUT_MS / 2);
    expect(toCharger).toEqual([call("p1", "Reset"), call("s1")]);

    // A late reply to the primary's CALL still reaches the primary.
    expect(gate.routeReply("p1")).toEqual({ to: "primary" });
  });

  it("answers a secondary at once when the charger is not connected", () => {
    const { gate, toSecondary } = setup({ chargerOpen: false });

    gate.sendFromSecondary("sec-a", "s1", call("s1"));

    expect(toSecondary).toEqual([
      {
        secondary: "sec-a",
        raw: '[4,"s1","GenericError","Proxy: charger not connected",{}]',
      },
    ]);
    // Nothing is left waiting, so a reply with that ID is the primary's.
    expect(gate.routeReply("s1")).toEqual({ to: "primary" });
  });

  it("replaces a queued CALL when the same secondary sends again", () => {
    const { gate, toCharger, toSecondary } = setup();

    gate.sendFromPrimary("p1", call("p1", "Reset"));
    gate.sendFromSecondary("sec-a", "s1", call("s1"));
    gate.sendFromSecondary("sec-a", "s2", call("s2"));

    expect(toSecondary).toEqual([
      {
        secondary: "sec-a",
        raw: '[4,"s1","GenericError","Proxy: superseded by a newer request from the same backend",{}]',
      },
    ]);

    gate.routeReply("p1");
    expect(toCharger).toEqual([call("p1", "Reset"), call("s2")]);
  });

  it("refuses a secondary CALL that waited out a whole timeout", () => {
    const { gate, toCharger, toSecondary } = setup();

    gate.sendFromPrimary("p1", call("p1", "Reset"));
    gate.sendFromSecondary("sec-a", "s1", call("s1"));
    vi.advanceTimersByTime(TIMEOUT_MS + 1);
    gate.routeReply("p1");

    expect(toCharger).toEqual([call("p1", "Reset")]);
    expect(toSecondary).toEqual([
      {
        secondary: "sec-a",
        raw: `[4,"s1","GenericError","Proxy: charger busy with other requests",{}]`,
      },
    ]);
  });

  it("refuses a queued CALL that waited behind another secondary's timeout", () => {
    const { gate, toCharger, toSecondary } = setup();

    gate.sendFromSecondary("sec-a", "s1", call("s1"));
    gate.sendFromSecondary("sec-b", "s2", call("s2"));
    vi.advanceTimersByTime(TIMEOUT_MS);

    expect(toCharger).toEqual([call("s1")]);
    expect(toSecondary.map((reply) => reply.secondary)).toEqual([
      "sec-a",
      "sec-b",
    ]);
  });

  it("routes an unknown reply to the primary", () => {
    const { gate } = setup();

    expect(gate.routeReply("nobody-asked")).toEqual({ to: "primary" });
  });

  it("answers everything still waiting when the session closes", () => {
    const { gate, toSecondary } = setup();

    gate.sendFromSecondary("sec-a", "s1", call("s1"));
    gate.sendFromSecondary("sec-b", "s2", call("s2"));
    gate.close();

    expect(toSecondary).toEqual([
      {
        secondary: "sec-a",
        raw: '[4,"s1","GenericError","Proxy: charger disconnected",{}]',
      },
      {
        secondary: "sec-b",
        raw: '[4,"s2","GenericError","Proxy: charger disconnected",{}]',
      },
    ]);

    // Closed: nothing more is sent or answered.
    gate.sendFromSecondary("sec-a", "s3", call("s3"));
    expect(toSecondary).toHaveLength(2);
  });
});
