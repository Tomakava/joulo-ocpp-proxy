import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultOutboxPath, OutboxStore, type Delivery, type DeliveryTarget } from "../../src/outbox";
import { runDeliveryCommand } from "../../src/delivery-cli";
import { decodeOcppFrame } from "../../src/utils/ocpp";

const target: DeliveryTarget = {
  chargerId: "CP-1", primaryUrl: "ws://primary.example/CP-1", protocol: "ocpp1.6",
  secondaryUrl: "ws://secondary.example", mappedChargerId: "CP-1", appendChargePointId: true,
};
const stores = new Set<OutboxStore>();
let directory: string;
let path: string;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "ocpp-outbox-"));
  path = join(directory, "outbox.sqlite");
});

afterEach(() => {
  for (const store of stores) store.close();
  stores.clear();
  vi.useRealTimers();
  vi.unstubAllEnvs();
  rmSync(directory, { recursive: true, force: true });
});

function open(legacy: string | null = null) {
  const store = new OutboxStore(path, legacy);
  stores.add(store);
  return store;
}

function close(store: OutboxStore) {
  store.close();
  stores.delete(store);
}

function message(raw: string) {
  const decoded = decodeOcppFrame(raw);
  if (!decoded) throw new Error("Invalid test OCPP frame");
  return decoded;
}

function enqueue(store: OutboxStore, scope: string, id: string, action: string, payload: Record<string, unknown> = {}): Delivery {
  const raw = JSON.stringify([2, id, action, payload]);
  store.enqueue(scope, message(raw), raw);
  const entry = store.inspect().findLast(row => row.messageId === id);
  if (!entry) throw new Error("Expected a recorded report");
  return entry;
}

function prepare(store: OutboxStore, entry: Delivery) {
  const decoded = message(entry.raw);
  store.prepare(entry.id, JSON.stringify([2, entry.relayId, decoded.action, decoded.payload]));
}

function acknowledge(store: OutboxStore, scope: string, entry: Delivery, payload: Record<string, unknown> = {}) {
  store.acknowledge(scope, message(JSON.stringify([3, entry.relayId, payload])));
}

function acceptStart(store: OutboxStore, scope: string, id = "start", primary = 111, secondary = 222) {
  const entry = enqueue(store, scope, id, "StartTransaction", { connectorId: 1, meterStart: 0, timestamp: `2026-01-01T00:00:${id === "start" ? "00" : "10"}Z` });
  store.capturePrimary(scope, message(JSON.stringify([3, id, { transactionId: primary, idTagInfo: { status: "Accepted" } }])));
  prepare(store, entry);
  acknowledge(store, scope, entry, { transactionId: secondary, idTagInfo: { status: "Accepted" } });
}

describe("durable secondary outbox", () => {
  it("reopens queued reports in order after the process owner is gone", () => {
    let store = open();
    const scope = store.register(target);
    enqueue(store, scope, "one", "Heartbeat", { sequence: 1 });
    enqueue(store, scope, "two", "Heartbeat", { sequence: 2 });
    close(store);
    store = open();
    store.register(target);
    const delivered: unknown[] = [];
    for (let entry = store.head(scope); entry; entry = store.head(scope)) {
      delivered.push(message(entry.raw).payload);
      prepare(store, entry);
      acknowledge(store, scope, entry);
    }
    expect(delivered).toEqual([{ sequence: 1 }, { sequence: 2 }]);
  });

  it("recovers an in-flight start as uncertain, never as another send", () => {
    let store = open();
    const scope = store.register(target);
    const start = enqueue(store, scope, "start", "StartTransaction", { connectorId: 1, meterStart: 0 });
    store.capturePrimary(scope, message('[3,"start",{"transactionId":111,"idTagInfo":{"status":"Accepted"}}]'));
    prepare(store, start);
    enqueue(store, scope, "meter", "MeterValues", { transactionId: 111 });
    close(store);
    store = open();
    expect(store.head(scope)).toMatchObject({ id: start.id, state: "uncertain", relayId: start.relayId });
    expect(store.inspect().find(row => row.action === "MeterValues")?.state).toBe("queued");
    expect(store.health().status).toBe("degraded");
  });

  it("commits the secondary binding with its start receipt before removing the start", () => {
    let store = open();
    const scope = store.register(target);
    acceptStart(store, scope);
    enqueue(store, scope, "meter", "MeterValues", { transactionId: 111 });
    close(store);
    store = open();
    const meter = store.head(scope);
    if (!meter) throw new Error("Meter report missing");
    expect(meter.action).toBe("MeterValues");
    expect(store.mappedTransaction(meter)).toBe("222");
    expect(store.inspect().some(row => row.action === "StartTransaction")).toBe(false);
  });

  it("retains active mappings longer than seven days", () => {
    vi.useFakeTimers();
    let store = open();
    const scope = store.register(target);
    acceptStart(store, scope);
    close(store);
    vi.setSystemTime(Date.now() + 14 * 24 * 60 * 60 * 1000);
    store = open();
    const meter = enqueue(store, scope, "late-meter", "MeterValues", { transactionId: 111 });
    expect(store.mappedTransaction(meter)).toBe("222");
  });

  it("does not transfer an old primary's binding to a different route or protocol", () => {
    const store = open();
    const original = store.register(target);
    acceptStart(store, original);
    for (const changed of [{ ...target, primaryUrl: "ws://other.example/CP-1" }, { ...target, protocol: "ocpp2.0.1" }, { ...target, mappedChargerId: "external" }, { ...target, appendChargePointId: false }]) {
      const scope = store.register(changed);
      const meter = enqueue(store, scope, "meter", "MeterValues", { transactionId: 111 });
      expect(store.mappedTransaction(meter)).toBeNull();
    }
  });

  it("keeps archived old samples bound to their own session when primary IDs are reused", () => {
    const store = open();
    const scope = store.register(target);
    acceptStart(store, scope);
    const oldMeter = enqueue(store, scope, "old-meter", "MeterValues", { transactionId: 111 });
    prepare(store, oldMeter);
    store.timeout(oldMeter.id);
    prepare(store, oldMeter);
    store.timeout(oldMeter.id);
    const stop = enqueue(store, scope, "stop", "StopTransaction", { transactionId: 111, meterStop: 5 });
    prepare(store, stop);
    acknowledge(store, scope, stop);
    acceptStart(store, scope, "next-start", 111, 333);
    const newMeter = enqueue(store, scope, "new-meter", "MeterValues", { transactionId: 111 });
    store.resolve(oldMeter.id, "not_received", "Backend confirmed the old sample was absent");
    expect(store.mappedTransaction(oldMeter)).toBe("222");
    expect(store.mappedTransaction(newMeter)).toBe("333");
  });

  it("keeps CALLERROR and declined start receipts without inventing a transaction binding", () => {
    const store = open();
    const scope = store.register(target);
    const start = enqueue(store, scope, "start", "StartTransaction", { connectorId: 1 });
    store.capturePrimary(scope, message('[3,"start",{"transactionId":111,"idTagInfo":{"status":"Accepted"}}]'));
    prepare(store, start);
    acknowledge(store, scope, start, { transactionId: 222, idTagInfo: { status: "Invalid" } });
    expect(store.head(scope)?.state).toBe("rejected");
    expect(store.mappedTransaction(start)).toBeNull();
    expect(store.inspect()[0].error).toContain("Invalid");
  });

  it("keeps rejected stop receipts and their transaction mapping", () => {
    const store = open();
    const scope = store.register(target);
    acceptStart(store, scope);
    const stop = enqueue(store, scope, "stop", "StopTransaction", { transactionId: 111 });
    prepare(store, stop);
    store.acknowledge(scope, message(JSON.stringify([4, stop.relayId, "InternalError", "retry later", {}])));
    expect(store.head(scope)?.state).toBe("rejected");
    expect(store.mappedTransaction(stop)).toBe("222");
  });

  it("reconciles a backend-confirmed start without sending it again", () => {
    let store = open();
    const scope = store.register(target);
    const start = enqueue(store, scope, "start", "StartTransaction", { connectorId: 1 });
    store.capturePrimary(scope, message('[3,"start",{"transactionId":111,"idTagInfo":{"status":"Accepted"}}]'));
    prepare(store, start);
    store.timeout(start.id);
    store.resolve(start.id, "received", "Backend operator confirmed transaction 222", "222");
    const meter = enqueue(store, scope, "meter", "MeterValues", { transactionId: 111 });
    close(store);
    store = open();
    expect(store.head(scope)?.id).toBe(meter.id);
    expect(store.mappedTransaction(meter)).toBe("222");
    expect(store.inspect().find(row => row.id === start.id)).toMatchObject({ state: "reconciled", operatorNote: "Backend operator confirmed transaction 222" });
  });

  it("rejects missing or malformed reconciliation IDs and evidence", () => {
    const store = open();
    const scope = store.register(target);
    const start = enqueue(store, scope, "start", "StartTransaction", { connectorId: 1 });
    store.capturePrimary(scope, message('[3,"start",{"transactionId":111,"idTagInfo":{"status":"Accepted"}}]'));
    prepare(store, start);
    store.timeout(start.id);
    for (const id of [undefined, "", "NaN", "1e3", "Infinity", "9007199254740993"]) {
      expect(() => { store.resolve(start.id, "received", "Confirmed", id); }).toThrow();
    }
    expect(() => { store.resolve(start.id, "not_received", " "); }).toThrow();
    expect(store.head(scope)?.state).toBe("uncertain");
  });

  it("retains a human retry decision after the retried report is acknowledged", () => {
    const store = open();
    const scope = store.register(target);
    const sample = enqueue(store, scope, "sample", "MeterValues", { value: 1 });
    prepare(store, sample);
    store.timeout(sample.id);
    prepare(store, sample);
    store.timeout(sample.id);
    store.resolve(sample.id, "not_received", "Backend explicitly confirmed non-receipt");
    prepare(store, sample);
    acknowledge(store, scope, sample);
    expect(store.inspect()[0]).toMatchObject({ state: "delivered", operatorNote: "Backend explicitly confirmed non-receipt" });
    expect(store.health().status).toBe("ok");
  });

  it("requires explicit session abandonment before discarding dependent reports", () => {
    const store = open();
    const scope = store.register(target);
    const start = enqueue(store, scope, "start", "StartTransaction", { connectorId: 1 });
    store.capturePrimary(scope, message('[3,"start",{"transactionId":111,"idTagInfo":{"status":"Accepted"}}]'));
    prepare(store, start);
    store.timeout(start.id);
    enqueue(store, scope, "meter", "MeterValues", { transactionId: 111 });
    store.discard(start.id, "Operator intentionally abandoned this reporting session");
    enqueue(store, scope, "stop", "StopTransaction", { transactionId: 111 });
    expect(store.inspect().map(row => row.state)).toEqual(["discarded", "discarded", "discarded"]);
    expect(store.head(scope)).toBeUndefined();
  });

  it("migrates old JSON mappings once without modifying them or expiring active sessions", () => {
    const legacy = join(directory, "state.json");
    const original = JSON.stringify({ version: 1, txMaps: { "CP-1::ws://secondary.example": { "111": { secondaryTxId: "222", lastUpdatedAt: 0 } } } });
    writeFileSync(legacy, original);
    let store = open(legacy);
    const scope = store.register(target);
    close(store);
    expect(readFileSync(legacy, "utf8")).toBe(original);
    writeFileSync(legacy, "not-json");
    store = open(legacy);
    const meter = enqueue(store, scope, "meter", "MeterValues", { transactionId: 111 });
    expect(store.mappedTransaction(meter)).toBe("222");
  });

  it("refuses a second owner instead of changing a live in-flight delivery", () => {
    const store = open();
    const scope = store.register(target);
    const entry = enqueue(store, scope, "heartbeat", "Heartbeat");
    prepare(store, entry);
    expect(() => new OutboxStore(path, null)).toThrow();
    expect(store.head(scope)?.state).toBe("inflight");
  });

  it("refuses a corrupt journal rather than silently starting empty", () => {
    writeFileSync(path, "not-a-sqlite-database");
    expect(() => new OutboxStore(path, null)).toThrow();
    expect(readFileSync(path, "utf8")).toBe("not-a-sqlite-database");
  });

  it("exposes stale queues as degraded even while the process remains alive", () => {
    vi.useFakeTimers();
    const store = open();
    enqueue(store, store.register(target), "heartbeat", "Heartbeat");
    vi.setSystemTime(Date.now() + 120_000);
    expect(store.health()).toMatchObject({ status: "degraded", oldestPendingSeconds: 120 });
  });

  it("supports offline CLI inspection and prevents live reconciliation", () => {
    const store = open();
    const scope = store.register(target);
    const entry = enqueue(store, scope, "heartbeat", "Heartbeat");
    prepare(store, entry);
    expect(() => runDeliveryCommand(["list", "--db", path])).toThrow();
    close(store);
    const output: string[] = [];
    runDeliveryCommand(["list", "--db", path], text => output.push(text));
    expect(output.join("\n")).toContain('"action": "Heartbeat"');
    expect(output.join("\n")).not.toContain('"raw"');
  });

  it("allows a retried primary response to recover a start lost before its primary ID was recorded", () => {
    let store = open();
    const scope = store.register(target);
    const start = enqueue(store, scope, "start", "StartTransaction", { connectorId: 1 });
    close(store);
    store = open();
    expect(store.head(scope)?.state).toBe("blocked");
    expect(store.canSend(start)).toBe(false);
    store.capturePrimary(scope, message('[3,"start",{"transactionId":111,"idTagInfo":{"status":"Accepted"}}]'));
    expect(store.head(scope)?.state).toBe("queued");
    expect(store.canSend(start)).toBe(true);
  });

  it("requires primary evidence when manually retrying a start with a missing primary response", () => {
    let store = open();
    const scope = store.register(target);
    const start = enqueue(store, scope, "start", "StartTransaction", { connectorId: 1 });
    close(store);
    store = open();
    expect(() => { store.resolve(start.id, "not_received", "Secondary never received this"); }).toThrow();
    store.resolve(start.id, "not_received", "Primary confirmed 111; secondary confirmed non-receipt", undefined, "111");
    expect(store.canSend(start)).toBe(true);
    prepare(store, start);
    store.timeout(start.id);
    expect(() => { store.resolve(start.id, "received", "Confirmed", "222", "999"); }).toThrow();
    expect(store.head(scope)?.state).toBe("uncertain");
  });

  it("retains and deduplicates a confirmed OCPP 2 transaction-start event", () => {
    const store = open();
    const scope = store.register({ ...target, protocol: "ocpp2.0.1" });
    const raw = '[2,"event","TransactionEvent",{"eventType":"Started","seqNo":0,"transactionInfo":{"transactionId":"EV-1"}}]';
    store.enqueue(scope, message(raw), raw);
    const start = store.head(scope);
    if (!start) throw new Error("Expected start event");
    prepare(store, start);
    acknowledge(store, scope, start);
    store.enqueue(scope, message(raw), raw);
    expect(store.head(scope)).toBeUndefined();
    expect(store.inspect().map(row => row.state)).toEqual(["delivered"]);
  });

  it("does not create an apparently healthy empty journal for a mistyped CLI path", () => {
    expect(() => runDeliveryCommand(["status", "--db", join(directory, "missing.sqlite")])).toThrow("does not exist");
  });

  it.each(["", " ", ":memory:", "file::memory:"])("rejects a nonpersistent production journal path: %s", value => {
    vi.stubEnv("OUTBOX_FILE", value);
    expect(() => defaultOutboxPath()).toThrow("persistent SQLite file");
  });

  it.each([
    { action: "BootNotification", response: { status: "Pending" } },
    { action: "Authorize", response: { idTagInfo: { status: "Invalid" } } },
    { action: "DataTransfer", response: { status: "UnknownVendorId" } },
    { action: "TransactionEvent", response: { idTokenInfo: { status: "Blocked" } } },
  ])("does not count a negative $action CALLRESULT as successful delivery", ({ action, response }) => {
    const store = open();
    const scope = store.register(target);
    const entry = enqueue(store, scope, "negative", action, {});
    prepare(store, entry);
    acknowledge(store, scope, entry, response);
    expect(store.inspect()[0]).toMatchObject({ id: entry.id, state: "rejected" });
    expect(store.health().status).toBe("degraded");
  });
});
