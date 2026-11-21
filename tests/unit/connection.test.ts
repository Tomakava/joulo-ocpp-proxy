import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import type { CsmsBackend, SecondaryTarget } from "../../src/config";
import { ChargerConnection } from "../../src/connection";
import { OutboxStore } from "../../src/outbox";

interface MockSocket {
  readyState: number;
  sent: string[];
  failNextSend: boolean;
  emit: (event: string, ...args: unknown[]) => void;
}

let connectCalls: { url: string; protocols: string | string[] | undefined }[] = [];
let sockets: MockSocket[] = [];
const stores = new Set<OutboxStore>();
const connections = new Set<ChargerConnection>();

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
      if (url !== null) connectCalls.push({ url, protocols });
      sockets.push(this);
    }
    on(event: string, handler: (...args: unknown[]) => void) {
      const handlers = this.handlers.get(event) ?? [];
      handlers.push(handler);
      this.handlers.set(event, handlers);
      return this;
    }
    emit(event: string, ...args: unknown[]) {
      for (const handler of this.handlers.get(event) ?? []) handler(...args);
    }
    send(raw: string) {
      if (this.failNextSend) {
        this.failNextSend = false;
        throw new Error("socket is closing");
      }
      this.sent.push(raw);
    }
    close() {
      if (this.readyState === MockWebSocket.CLOSED) return;
      this.readyState = MockWebSocket.CLOSED;
      this.emit("close", 1000, Buffer.from(""));
    }
    ping() { this.emit("pong"); }
    pong() { /* The test peer already observes the ping. */ }
  }
  return { default: MockWebSocket };
});

beforeEach(() => {
  vi.useFakeTimers();
  connectCalls = [];
  sockets = [];
});

afterEach(() => {
  for (const connection of connections) connection.teardown();
  for (const store of stores) store.close();
  connections.clear();
  stores.clear();
  vi.useRealTimers();
});

function fixture(options: {
  store?: OutboxStore;
  primary?: CsmsBackend;
  secondary?: SecondaryTarget;
  protocol?: string;
} = {}): Fixture {
  const store = options.store ?? new OutboxStore(":memory:", null);
  stores.add(store);
  const firstSocket = sockets.length;
  const connection = new ChargerConnection(
    new WebSocket(null), "CP-1",
    options.primary ?? { url: "ws://primary.example/ocpp", appendChargePointId: true },
    [options.secondary ?? { url: "ws://secondary.example/ocpp", appendChargePointId: true, mappedChargerId: "CP-1" }],
    options.protocol ?? "ocpp1.6", undefined, store,
  );
  connections.add(connection);
  const [charger, primary, secondary] = sockets.slice(firstSocket);
  secondary.emit("open");
  return { connection, charger, primary, secondary, store };
}

interface Fixture {
  connection: ChargerConnection;
  charger: MockSocket;
  primary: MockSocket;
  secondary: MockSocket;
  store: OutboxStore;
}
type Call = [number, string, string, Record<string, unknown>];

function callAt(socket: MockSocket, index = -1): Call {
  const raw = socket.sent.at(index);
  if (raw === undefined) throw new Error("Expected a wire frame");
  return JSON.parse(raw) as Call;
}

function answer(socket: MockSocket, payload: Record<string, unknown> = {}, index = -1) {
  socket.emit("message", Buffer.from(JSON.stringify([3, callAt(socket, index)[1], payload])));
}

function send(f: Fixture, id: string, action: string, payload: Record<string, unknown> = {}) {
  f.charger.emit("message", Buffer.from(JSON.stringify([2, id, action, payload])));
}

function start(f: Fixture) {
  send(f, "start-1", "StartTransaction", { connectorId: 1, idTag: "CARD-1", meterStart: 0, timestamp: "2026-01-01T00:00:00Z" });
  answer(f.primary, { transactionId: 111, idTagInfo: { status: "Accepted" } });
  answer(f.secondary, { transactionId: 222, idTagInfo: { status: "Accepted" } });
}

describe("ChargerConnection delivery", () => {
  it.each([
    { append: true, protocol: "ocpp1.6", suffix: "/CP-1" },
    { append: false, protocol: "ocpp2.0.1", suffix: "" },
  ])("preserves backend URL and protocol selection ($protocol)", ({ append, protocol, suffix }) => {
    fixture({
      primary: { url: "ws://primary.example/ocpp", appendChargePointId: append },
      secondary: { url: "ws://secondary.example/ocpp", appendChargePointId: append, mappedChargerId: "CP-1" },
      protocol,
    });
    expect(connectCalls).toEqual([
      { url: `ws://primary.example/ocpp${suffix}`, protocols: [protocol] },
      { url: `ws://secondary.example/ocpp${suffix}`, protocols: [protocol] },
    ]);
  });

  it("keeps primary forwarding alive when a secondary send fails", () => {
    const f = fixture();
    f.secondary.failNextSend = true;
    send(f, "heartbeat", "Heartbeat");
    expect(callAt(f.primary)).toEqual([2, "heartbeat", "Heartbeat", {}]);
    expect(f.secondary.sent).toEqual([]);
    f.secondary.emit("open");
    expect(callAt(f.secondary).slice(2)).toEqual(["Heartbeat", {}]);
    answer(f.secondary);
    expect(f.store.inspect()).toEqual([]);
  });

  it("sends one mirrored CALL at a time and keeps retries' relay IDs stable", () => {
    const f = fixture();
    send(f, "one", "Heartbeat");
    send(f, "two", "Heartbeat");
    expect(f.secondary.sent).toHaveLength(1);
    const first = f.secondary.sent[0];
    vi.advanceTimersByTime(120_000);
    expect(f.secondary.sent).toEqual([first, first]);
    answer(f.secondary);
    expect(callAt(f.secondary)[2]).toBe("Heartbeat");
    expect(callAt(f.secondary)[1]).not.toBe(callAt(f.secondary, 0)[1]);
    answer(f.secondary);
    expect(f.store.inspect()).toEqual([]);
  });

  it("does not mistake a reused charger RPC ID or a late reply for a newer delivery", () => {
    const f = fixture();
    send(f, "reused", "Heartbeat");
    const firstRelay = callAt(f.secondary)[1];
    vi.advanceTimersByTime(240_000);
    send(f, "reused", "Heartbeat");
    const secondRelay = callAt(f.secondary)[1];
    expect(secondRelay).not.toBe(firstRelay);
    f.secondary.emit("message", Buffer.from(JSON.stringify([3, firstRelay, {}])));
    expect(f.store.inspect().map(row => [row.relayId, row.state])).toEqual([[secondRelay, "inflight"]]);
    answer(f.secondary);
    expect(f.store.inspect()).toEqual([]);
  });

  it("retains unparseable reports without blocking valid reports behind them", () => {
    const f = fixture();
    f.charger.emit("message", Buffer.from("not-ocpp"));
    send(f, "heartbeat", "Heartbeat");
    expect(f.secondary.sent[0]).toBe("not-ocpp");
    expect(callAt(f.secondary)[2]).toBe("Heartbeat");
    answer(f.secondary);
    expect(f.store.inspect().map(row => [row.raw, row.state])).toEqual([["not-ocpp", "unconfirmed"]]);
    expect(f.store.health().status).toBe("degraded");
  });

  it("requires the primary to accept a start before opening a secondary transaction", () => {
    const f = fixture();
    send(f, "start", "StartTransaction", { connectorId: 1, meterStart: 0 });
    expect(f.secondary.sent).toEqual([]);
    answer(f.primary, { transactionId: 111, idTagInfo: { status: "Invalid" } });
    send(f, "heartbeat", "Heartbeat");
    expect(callAt(f.secondary)[2]).toBe("Heartbeat");
    expect(f.store.inspect().find(row => row.action === "StartTransaction")?.state).toBe("cancelled");
  });

  it("never replays an ambiguous transaction start and still forwards primary traffic", () => {
    const f = fixture();
    send(f, "start", "StartTransaction", { connectorId: 1, meterStart: 0 });
    answer(f.primary, { transactionId: 111, idTagInfo: { status: "Accepted" } });
    send(f, "meter", "MeterValues", { transactionId: 111 });
    f.secondary.readyState = WebSocket.CLOSED;
    f.secondary.emit("close", 1006, Buffer.from(""));
    vi.advanceTimersByTime(10_000);
    const reconnected = sockets[sockets.length - 1];
    reconnected.emit("open");
    expect(reconnected.sent).toEqual([]);
    send(f, "heartbeat", "Heartbeat");
    expect(callAt(f.primary)[2]).toBe("Heartbeat");
    const unresolved = f.store.inspect().find(row => row.action === "StartTransaction");
    expect(unresolved?.state).toBe("uncertain");
    if (!unresolved) throw new Error("Start receipt missing");
    f.store.resolve(unresolved.id, "received", "Backend confirmed its transaction ID", "222");
    reconnected.emit("open");
    expect(callAt(reconnected)[3].transactionId).toBe(222);
    expect(f.store.health().counts?.reconciled).toBe(1);
  });

  it("blocks a start immediately on an acknowledgement timeout, without resending it", () => {
    const f = fixture();
    send(f, "start", "StartTransaction", { connectorId: 1, meterStart: 0 });
    answer(f.primary, { transactionId: 111, idTagInfo: { status: "Accepted" } });
    vi.advanceTimersByTime(240_000);
    expect(f.secondary.sent).toHaveLength(1);
    expect(f.store.inspect()[0].state).toBe("uncertain");
  });

  it("retains failed periodic reports and continues delivery instead of deleting them", () => {
    const f = fixture();
    send(f, "one", "Heartbeat");
    send(f, "two", "Heartbeat");
    vi.advanceTimersByTime(240_000);
    expect(f.store.inspect().map(row => row.state)).toEqual(["unconfirmed", "inflight"]);
    answer(f.secondary);
    expect(f.store.inspect().map(row => row.state)).toEqual(["unconfirmed"]);
  });

  it("preserves all reports through an outage larger than the old 100-frame limit", () => {
    const f = fixture();
    f.secondary.readyState = WebSocket.CLOSED;
    for (let sequence = 0; sequence < 151; sequence++) send(f, `report-${String(sequence)}`, "MeterValues", { sequence });
    f.secondary.readyState = WebSocket.OPEN;
    f.secondary.emit("open");
    const delivered: unknown[] = [];
    for (let sequence = 0; sequence < 151; sequence++) {
      delivered.push(callAt(f.secondary)[3].sequence);
      answer(f.secondary);
    }
    expect(delivered).toEqual(Array.from({ length: 151 }, (_, sequence) => sequence));
    expect(f.store.inspect()).toEqual([]);
  });

  it("keeps queued data across charger connection teardown", () => {
    const f = fixture();
    f.secondary.readyState = WebSocket.CLOSED;
    send(f, "queued", "MeterValues", { value: 123 });
    f.connection.teardown();
    const next = fixture({ store: f.store });
    expect(callAt(next.secondary).slice(2)).toEqual(["MeterValues", { value: 123 }]);
    answer(next.secondary);
    expect(next.store.inspect()).toEqual([]);
  });

  it("rewrites a retried stop with its confirmed ID and keeps rejected stops visible", () => {
    const f = fixture();
    start(f);
    send(f, "stop", "StopTransaction", { transactionId: 111, meterStop: 42 });
    expect(callAt(f.secondary)[3].transactionId).toBe(222);
    const wire = f.secondary.sent.at(-1);
    vi.advanceTimersByTime(120_000);
    expect(f.secondary.sent.at(-1)).toBe(wire);
    const relayId = callAt(f.secondary)[1];
    f.secondary.emit("message", Buffer.from(JSON.stringify([4, relayId, "InternalError", "not stored", {}])));
    const rejected = f.store.inspect()[0];
    expect(rejected.state).toBe("rejected");
    expect(f.store.mappedTransaction(rejected)).toBe("222");
    expect(f.store.health().status).toBe("degraded");
  });

  it("does not send primary transaction IDs when a secondary binding is missing", () => {
    const f = fixture();
    send(f, "orphan", "MeterValues", { transactionId: 111 });
    expect(f.secondary.sent).toEqual([]);
    expect(f.store.inspect()[0].state).toBe("blocked");
    f.store.bind(f.store.inspect()[0].id, "111", "222", "Both systems confirmed this active session");
    f.secondary.emit("open");
    expect(callAt(f.secondary)[3].transactionId).toBe(222);
  });

  it("continues primary control and reports degraded health on journal failure", () => {
    const f = fixture();
    vi.spyOn(f.store, "enqueue").mockImplementationOnce(() => { throw new Error("ENOSPC"); });
    send(f, "heartbeat", "Heartbeat");
    expect(callAt(f.primary)).toEqual([2, "heartbeat", "Heartbeat", {}]);
    expect(f.secondary.sent).toEqual([]);
    expect(f.store.health()).toMatchObject({ status: "degraded", storageError: "ENOSPC" });
  });
});
