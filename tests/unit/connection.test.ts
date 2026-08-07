import { tmpdir } from "os";
import { join } from "path";

import { describe, expect, it, beforeEach, vi } from "vitest";
import WebSocket from "ws";
import type { CsmsBackend, SecondaryTarget } from "../../src/config";

import { ChargerConnection } from "../../src/connection";
import { StateStore } from "../../src/state";

interface WsConnectCall {
  url: string;
  protocols: string | string[] | undefined;
}

/** The parts of the mock socket these tests drive or inspect. */
interface MockSocket {
  readyState: number;
  /** Frames handed to send(), in order. */
  sent: string[];
  /** When true, the next send() throws, as `ws` does on a closing socket. */
  failNextSend: boolean;
  emit: (event: string, ...args: unknown[]) => void;
}

let connectCalls: WsConnectCall[] = [];
let sockets: MockSocket[] = [];

/*
 * ChargerConnection creates outbound WebSocket instances internally. Mocking
 * the module is the smallest seam that lets this unit test inspect connection
 * arguments, drive socket events, and fail a send without opening real network
 * connections.
 */
vi.mock("ws", () => {
  class MockWebSocket {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSING = 2;
    static CLOSED = 3;

    readyState = MockWebSocket.OPEN;
    sent: string[] = [];
    failNextSend = false;
    private handlers = new Map<string, ((...args: unknown[]) => void)[]>();

    constructor(url: string | null, protocols?: string | string[]) {
      if (url !== null) {
        connectCalls.push({ url, protocols });
      }
      sockets.push(this);
    }

    on(event: string, handler: (...args: unknown[]) => void) {
      const existing = this.handlers.get(event);
      if (existing) existing.push(handler);
      else this.handlers.set(event, [handler]);
      return this;
    }

    emit(event: string, ...args: unknown[]) {
      for (const handler of this.handlers.get(event) ?? []) {
        handler(...args);
      }
    }

    send(data: string) {
      if (this.failNextSend) {
        this.failNextSend = false;
        throw new Error("socket is closing");
      }
      this.sent.push(data);
      return undefined;
    }
    close() {
      this.readyState = MockWebSocket.CLOSED;
    }
    ping() {
      return undefined;
    }
    pong() {
      return undefined;
    }
  }

  return {
    default: MockWebSocket,
  };
});

beforeEach(() => {
  connectCalls = [];
  sockets = [];
});

/** Persistence isn't under test here; keep it off the real /data path. */
function createTestStore() {
  return new StateStore(join(tmpdir(), "ocpp-proxy-connection-test-state.json"));
}

function createMockChargerSocket() {
  // `null` is handled by the WebSocket mock above; the real `ws` constructor
  // cannot be used this way outside this test.
  return new WebSocket(null);
}

/** Mirrors src/connection.ts — these drive the fake-timer assertions below. */
const RECONNECT_DELAY_MS = 10_000;
const ACK_TIMEOUT_MS = 120_000;

/**
 * A connection with one unmapped secondary, and the three sockets it created.
 * The charger socket is returned as a MockSocket so tests can drive its events.
 */
function createMirrorFixture(chargePointId: string) {
  const backend = {
    url: "ws://csms.example/endpoint",
    appendChargePointId: false,
  };

  const connection = new ChargerConnection(
    createMockChargerSocket(),
    chargePointId,
    backend,
    [{ ...backend, mappedChargerId: chargePointId }],
    "ocpp1.6",
    undefined,
    createTestStore()
  );

  const [charger, primarySocket, secondarySocket] = sockets;
  return { connection, charger, primarySocket, secondarySocket };
}

describe("ChargerConnection", () => {
  it.each([
    {
      description: "opens primary and secondary connections using resolved URLs",
      appendChargePointId: true,
      primaryUrl: "ws://csms.example/endpoint",
      secondaryUrl: "ws://secondary.example/inspect",
      protocol: "ocpp1.6",
      expectedPrimaryUrl: "ws://csms.example/endpoint/cp-abc",
      expectedSecondaryUrl: "ws://secondary.example/inspect/cp-abc",
    },
    {
      description: "keeps connection URLs unchanged when appending is disabled",
      appendChargePointId: false,
      primaryUrl: "ws://csms.example/raw-endpoint?tenant=emea",
      secondaryUrl: "ws://secondary.example/raw-mirror?source=mirror",
      protocol: "ocpp2.0.1",
      expectedPrimaryUrl: "ws://csms.example/raw-endpoint?tenant=emea",
      expectedSecondaryUrl:
        "ws://secondary.example/raw-mirror?source=mirror",
    },
  ])(
    "$description",
    ({
      appendChargePointId,
      primaryUrl,
      secondaryUrl,
      protocol,
      expectedPrimaryUrl,
      expectedSecondaryUrl,
    }) => {
      const charger = createMockChargerSocket();
      const primary: CsmsBackend = {
        url: primaryUrl,
        appendChargePointId,
      };
      const secondary: SecondaryTarget = {
        url: secondaryUrl,
        appendChargePointId,
        mappedChargerId: "cp-abc",
      };

      new ChargerConnection(
        charger,
        "cp-abc",
        primary,
        [secondary],
        protocol,
        undefined,
        createTestStore(),
      );

      expect(connectCalls).toEqual([
        { url: expectedPrimaryUrl, protocols: [protocol] },
        { url: expectedSecondaryUrl, protocols: [protocol] },
      ]);
    }
  );

  it("queues a mirrored frame when the secondary send fails, and replays it on reconnect", () => {
    const charger = createMockChargerSocket();
    const primary: CsmsBackend = {
      url: "ws://csms.example/endpoint",
      appendChargePointId: false,
    };
    const secondary: SecondaryTarget = {
      ...primary,
      mappedChargerId: "cp-queue",
    };

    const connection = new ChargerConnection(
      charger,
      "cp-queue",
      primary,
      [secondary],
      "ocpp1.6",
      undefined,
      createTestStore(),
    );

    // sockets: [charger, primary, secondary]
    const [chargerSocket, primarySocket, secondarySocket] = sockets;
    const frame = '[2,"m-1","Heartbeat",{}]';

    secondarySocket.failNextSend = true;
    chargerSocket.emit("message", Buffer.from(frame));

    // The primary still got it, and the failed mirror wasn't dropped...
    expect(primarySocket.sent).toEqual([frame]);
    expect(secondarySocket.sent).toEqual([]);

    // ...it was queued, and goes out when the secondary comes back.
    secondarySocket.emit("open");
    expect(secondarySocket.sent).toEqual([frame]);

    connection.teardown();
  });

  it("holds a mirrored CALL until the secondary answers it", () => {
    const { charger, connection, secondarySocket } = createMirrorFixture("cp-seq");

    charger.emit("message", Buffer.from('[2,"m-1","Heartbeat",{}]'));
    charger.emit("message", Buffer.from('[2,"m-2","Heartbeat",{}]'));

    // Only the first is in flight: OCPP is request/response, and the frames
    // behind it may need what its answer carries.
    expect(secondarySocket.sent).toEqual(['[2,"m-1","Heartbeat",{}]']);

    secondarySocket.emit("message", Buffer.from('[3,"m-1",{}]'));
    expect(secondarySocket.sent).toEqual([
      '[2,"m-1","Heartbeat",{}]',
      '[2,"m-2","Heartbeat",{}]',
    ]);

    connection.teardown();
  });

  it("mirrors a frame it cannot decode without waiting for an answer to it", () => {
    const { charger, connection, secondarySocket } = createMirrorFixture("cp-raw");

    // An undecodable frame has no message ID, so no answer can ever match it;
    // it must not become a barrier the rest of the mirror queues behind.
    charger.emit("message", Buffer.from("not-ocpp"));
    charger.emit("message", Buffer.from('[2,"m-1","Heartbeat",{}]'));

    expect(secondarySocket.sent).toEqual([
      "not-ocpp",
      '[2,"m-1","Heartbeat",{}]',
    ]);

    connection.teardown();
  });

  /*
   * The incident this queue exists for: a secondary's socket went half-open, so
   * send() reported success for a StartTransaction and a MeterValues that never
   * arrived. Nothing was queued, and when the socket finally dropped ~60s later
   * only the frames from after the close were replayed — leaving that secondary
   * with no transaction ID for the session, and every later MeterValues carrying
   * the primary's ID instead.
   */
  it("replays frames a half-open secondary never acknowledged, and rewrites the ones behind them", () => {
    vi.useFakeTimers();
    try {
      const { charger, connection, secondarySocket, primarySocket } =
        createMirrorFixture("cp-halfopen");

      const startFrame =
        '[2,"start-1","StartTransaction",{"connectorId":1,"idTag":"CARD-1","meterStart":0}]';

      charger.emit("message", Buffer.from(startFrame));
      primarySocket.emit(
        "message",
        Buffer.from('[3,"start-1",{"transactionId":111,"idTagInfo":{"status":"Accepted"}}]')
      );

      // The frame was written to a socket that still looks open...
      expect(secondarySocket.sent).toEqual([startFrame]);

      // ...so the MeterValues behind it waits, rather than going out with a
      // transaction ID this secondary never issued.
      charger.emit(
        "message",
        Buffer.from('[2,"meter-1","MeterValues",{"connectorId":1,"transactionId":111}]')
      );
      expect(secondarySocket.sent).toEqual([startFrame]);

      // The socket was dead all along; it finally drops.
      secondarySocket.readyState = WebSocket.CLOSED;
      secondarySocket.emit("close", 1006, Buffer.from(""));
      vi.advanceTimersByTime(RECONNECT_DELAY_MS);

      const reconnected = sockets[sockets.length - 1];
      reconnected.emit("open");

      // The StartTransaction is replayed first — the MeterValues still can't go.
      expect(reconnected.sent).toEqual([startFrame]);

      reconnected.emit(
        "message",
        Buffer.from('[3,"start-1",{"transactionId":222,"idTagInfo":{"status":"Accepted"}}]')
      );

      // With the mapping finally known, the waiting MeterValues is rewritten
      // with it — the rewrite is derived when the frame is sent, not when it
      // was queued.
      expect(reconnected.sent).toHaveLength(2);
      const meter = JSON.parse(reconnected.sent[1]) as [
        number,
        string,
        string,
        Record<string, unknown>,
      ];
      expect(meter[3].transactionId).toBe(222);

      connection.teardown();
    } finally {
      vi.useRealTimers();
    }
  });

  it("resends an unanswered CALL, then gives up so the mirror keeps moving", () => {
    vi.useFakeTimers();
    try {
      const { charger, connection, secondarySocket } =
        createMirrorFixture("cp-timeout");

      charger.emit("message", Buffer.from('[2,"m-1","Heartbeat",{}]'));
      charger.emit("message", Buffer.from('[2,"m-2","Heartbeat",{}]'));
      expect(secondarySocket.sent).toEqual(['[2,"m-1","Heartbeat",{}]']);

      // The socket stays open and the secondary stays silent, so m-1 is resent.
      vi.advanceTimersByTime(ACK_TIMEOUT_MS);
      expect(secondarySocket.sent).toEqual([
        '[2,"m-1","Heartbeat",{}]',
        '[2,"m-1","Heartbeat",{}]',
      ]);

      // Still nothing. Out of tries: m-1 is abandoned rather than blocking m-2
      // forever, and the queue moves on.
      vi.advanceTimersByTime(ACK_TIMEOUT_MS);
      expect(secondarySocket.sent[2]).toBe('[2,"m-2","Heartbeat",{}]');

      connection.teardown();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps a transaction mapping until the secondary acknowledges the StopTransaction", () => {
    vi.useFakeTimers();
    try {
      const { charger, connection, secondarySocket, primarySocket } =
        createMirrorFixture("cp-stop");

      charger.emit(
        "message",
        Buffer.from('[2,"start-1","StartTransaction",{"connectorId":1,"meterStart":0}]')
      );
      primarySocket.emit(
        "message",
        Buffer.from('[3,"start-1",{"transactionId":111,"idTagInfo":{"status":"Accepted"}}]')
      );
      secondarySocket.emit(
        "message",
        Buffer.from('[3,"start-1",{"transactionId":222,"idTagInfo":{"status":"Accepted"}}]')
      );

      charger.emit(
        "message",
        Buffer.from('[2,"stop-1","StopTransaction",{"transactionId":111,"meterStop":5}]')
      );

      const firstStop = JSON.parse(secondarySocket.sent[1]) as [
        number,
        string,
        string,
        Record<string, unknown>,
      ];
      expect(firstStop[3].transactionId).toBe(222);

      // Unanswered, so it is resent — and must still carry the secondary's ID.
      // Releasing the mapping when the frame was written would send the retry
      // with the primary's ID instead.
      vi.advanceTimersByTime(ACK_TIMEOUT_MS);
      const retriedStop = JSON.parse(secondarySocket.sent[2]) as [
        number,
        string,
        string,
        Record<string, unknown>,
      ];
      expect(retriedStop[3].transactionId).toBe(222);

      connection.teardown();
    } finally {
      vi.useRealTimers();
    }
  });
});
