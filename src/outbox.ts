import { createHash, randomUUID } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync, type SQLInputValue, type StatementSync } from "node:sqlite";
import { readLegacyState } from "./state";
import type { ParsedMessage } from "./types";

export interface DeliveryTarget {
  chargerId: string;
  primaryUrl: string;
  protocol: string;
  secondaryUrl: string;
  mappedChargerId: string;
  appendChargePointId: boolean;
}

export interface Delivery {
  id: number;
  scope: string;
  raw: string;
  messageId: string | null;
  relayId: string;
  action: string | null;
  state: string;
  wire: string | null;
  sentAt: number | null;
  timeouts: number;
  transactionKey: number | null;
  primaryTx: string | null;
  critical: number;
  unsafe: number;
  error: string | null;
  operatorNote: string | null;
}

interface Transaction {
  id: number;
  primary_tx: string | null;
  secondary_tx: string | null;
  primary_status: string;
  discarded: number;
}

const DELIVERY_COLUMNS = `id,scope,raw,message_id AS messageId,relay_id AS relayId,action,state,wire,
  sent_at AS sentAt,timeouts,transaction_key AS transactionKey,
  COALESCE(primary_tx,(SELECT primary_tx FROM transactions WHERE transactions.id=frames.transaction_key)) AS primaryTx,
  critical,unsafe,error,operator_note AS operatorNote`;
const CRITICAL_ACTIONS: Partial<Record<string, true>> = {
  BootNotification: true,
  StartTransaction: true,
  StopTransaction: true,
  TransactionEvent: true,
};
const RECEIPT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

export function defaultOutboxPath(): string {
  const legacy = process.env.STATE_FILE ?? "/data/state.json";
  const path = process.env.OUTBOX_FILE ?? (legacy.endsWith(".json") ? legacy.slice(0, -5) + ".sqlite" : legacy + ".sqlite");
  if (!path.trim() || path === ":memory:" || path.startsWith("file:")) {
    throw new Error("OUTBOX_FILE must name a persistent SQLite file");
  }
  return path;
}

/** One exclusive owner. Administration requires stopping the proxy first. */
export class OutboxStore {
  private readonly db: DatabaseSync;
  private readonly statements = new Map<string, StatementSync>();
  private storageError: string | null = null;

  constructor(path = defaultOutboxPath(), legacyPath: string | null = process.env.STATE_FILE ?? "/data/state.json") {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path, { timeout: 0 });
    try {
      // Exclusive rollback-journal mode also prevents an offline administrator
      // or a second proxy from changing an in-flight queue under its owner.
      this.db.exec("PRAGMA locking_mode=EXCLUSIVE; PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL;");
      const versionRow = this.one("PRAGMA user_version") as { user_version: number } | undefined;
      const version = versionRow?.user_version;
      if (version !== 0 && version !== 1) throw new Error("Unsupported outbox database version");
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
        CREATE TABLE IF NOT EXISTS targets (scope TEXT PRIMARY KEY, identity TEXT NOT NULL) STRICT;
        CREATE TABLE IF NOT EXISTS transactions (
          id INTEGER PRIMARY KEY, scope TEXT NOT NULL, fingerprint TEXT NOT NULL,
          start_message_id TEXT, primary_tx TEXT, secondary_tx TEXT,
          primary_status TEXT NOT NULL DEFAULT 'pending', discarded INTEGER NOT NULL DEFAULT 0,
          closed_at INTEGER, UNIQUE(scope,fingerprint)
        ) STRICT;
        CREATE INDEX IF NOT EXISTS transactions_primary ON transactions(scope,primary_tx,id);
        CREATE INDEX IF NOT EXISTS transactions_start ON transactions(scope,start_message_id);
        CREATE TABLE IF NOT EXISTS frames (
          id INTEGER PRIMARY KEY AUTOINCREMENT, scope TEXT NOT NULL, fingerprint TEXT NOT NULL,
          message_id TEXT, relay_id TEXT NOT NULL UNIQUE, action TEXT, raw TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'queued',
          wire TEXT, sent_at INTEGER, timeouts INTEGER NOT NULL DEFAULT 0,
          transaction_key INTEGER REFERENCES transactions(id), primary_tx TEXT,
          critical INTEGER NOT NULL, unsafe INTEGER NOT NULL, error TEXT, operator_note TEXT,
          created_at INTEGER NOT NULL
        ) STRICT;
        CREATE INDEX IF NOT EXISTS frames_fifo ON frames(scope,id)
          WHERE state IN ('queued','inflight','blocked','uncertain') OR (state='rejected' AND critical=1);
        CREATE INDEX IF NOT EXISTS frames_transaction ON frames(transaction_key);
        CREATE INDEX IF NOT EXISTS frames_start_retry ON frames(scope,fingerprint) WHERE unsafe=1;
        CREATE TABLE IF NOT EXISTS legacy_bindings (
          legacy_key TEXT NOT NULL, primary_tx TEXT NOT NULL, secondary_tx TEXT NOT NULL,
          scope TEXT, PRIMARY KEY(legacy_key,primary_tx)
        ) STRICT;
        PRAGMA user_version=1;
      `);
      if (path !== ":memory:") chmodSync(path, 0o600);
      if (legacyPath && !this.one("SELECT value FROM metadata WHERE key='legacy_imported'")) {
        const legacy = readLegacyState(legacyPath);
        this.atomic(() => {
          for (const [key, mappings] of legacy) {
            for (const [primary, secondary] of mappings) {
              this.run("INSERT OR IGNORE INTO legacy_bindings(legacy_key,primary_tx,secondary_tx) VALUES(?,?,?)", key, primary, secondary);
            }
          }
          this.run("INSERT INTO metadata VALUES('legacy_imported','1')");
        });
      }
      // A process can die after send() but before recording the backend's reply.
      this.interrupt();
      this.run(`DELETE FROM transactions WHERE closed_at < ?
        AND NOT EXISTS(SELECT 1 FROM frames WHERE transaction_key=transactions.id)`, Date.now() - RECEIPT_RETENTION_MS);
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  private statement(sql: string): StatementSync {
    let statement = this.statements.get(sql);
    if (!statement) {
      statement = this.db.prepare(sql);
      this.statements.set(sql, statement);
    }
    return statement;
  }

  private run(sql: string, ...values: SQLInputValue[]) {
    return this.statement(sql).run(...values);
  }

  // SQLite's API does not encode row types. The STRICT schema and fixed SELECT
  // projections below own those shapes; callers name the concrete row type.
  private one(sql: string, ...values: SQLInputValue[]): unknown {
    return this.statement(sql).get(...values);
  }

  private requiredTransaction(sql: string, ...values: SQLInputValue[]): Transaction {
    const row = this.one(sql, ...values) as Transaction | undefined;
    if (row === undefined) throw new Error("Outbox transaction record is missing");
    return row;
  }

  private all(sql: string, ...values: SQLInputValue[]): unknown[] {
    return this.statement(sql).all(...values);
  }

  private atomic<T>(operation: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  register(target: DeliveryTarget): string {
    const scope = JSON.stringify([target.chargerId, target.primaryUrl, target.protocol, target.secondaryUrl, target.mappedChargerId, target.appendChargePointId]);
    const base = `${target.chargerId}::${target.secondaryUrl}`;
    const legacyKey = target.mappedChargerId === target.chargerId ? base : `${base}::${target.mappedChargerId}`;
    this.atomic(() => {
      this.run("INSERT OR IGNORE INTO targets VALUES(?,?)", scope, JSON.stringify(target));
      // Legacy files did not identify the primary. Claim their mappings once,
      // rather than leaking them into a different primary route later.
      const bindings = this.all("SELECT primary_tx,secondary_tx FROM legacy_bindings WHERE legacy_key=? AND scope IS NULL", legacyKey) as { primary_tx: string; secondary_tx: string }[];
      for (const row of bindings) {
        this.run(`INSERT OR IGNORE INTO transactions(scope,fingerprint,primary_tx,secondary_tx,primary_status)
          VALUES(?,?,?,?,'accepted')`, scope, `legacy:${row.primary_tx}`, row.primary_tx, row.secondary_tx);
      }
      this.run("UPDATE legacy_bindings SET scope=? WHERE legacy_key=? AND scope IS NULL", scope, legacyKey);
    });
    return scope;
  }

  enqueue(scope: string, msg: ParsedMessage | null, raw: string): void {
    const payload = objectPayload(msg?.payload);
    const primaryTx = transactionId(payload?.transactionId);
    const unsafe = msg?.action === "StartTransaction" || (msg?.action === "TransactionEvent" && payload?.eventType === "Started");
    const fingerprint = unsafe ? createHash("sha256").update(raw).digest("hex") : "";
    this.atomic(() => {
      if (unsafe && msg.action === "TransactionEvent" &&
          this.one("SELECT id FROM frames WHERE scope=? AND fingerprint=? AND unsafe=1", scope, fingerprint)) return;
      let transactionKey: number | null = null;
      if (msg?.action === "StartTransaction") {
        this.run("INSERT OR IGNORE INTO transactions(scope,fingerprint,start_message_id) VALUES(?,?,?)", scope, fingerprint, msg.id);
        const transaction = this.requiredTransaction("SELECT * FROM transactions WHERE scope=? AND fingerprint=?", scope, fingerprint);
        // A charger may resend a start whose response from the primary was lost.
        // A recorded secondary acceptance must never become a second start.
        if (transaction.secondary_tx !== null || transaction.discarded) return;
        if (this.one("SELECT id FROM frames WHERE transaction_key=? AND action='StartTransaction'", transaction.id)) return;
        transactionKey = transaction.id;
      } else if (primaryTx !== null && (msg?.action === "MeterValues" || msg?.action === "StopTransaction")) {
        const transaction = this.one("SELECT * FROM transactions WHERE scope=? AND primary_tx=? ORDER BY id DESC LIMIT 1", scope, primaryTx) as Transaction | undefined;
        transactionKey = transaction?.id ?? null;
      }
      const discarded = transactionKey === null ? false : Boolean(this.transaction(transactionKey).discarded);
      this.run(`INSERT INTO frames(scope,fingerprint,message_id,relay_id,action,raw,transaction_key,primary_tx,critical,unsafe,created_at,state)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`, scope, fingerprint, msg?.id ?? null, randomUUID(), msg?.action ?? null, raw, transactionKey, primaryTx,
        Number(CRITICAL_ACTIONS[msg?.action ?? ""] === true), Number(unsafe), Date.now(), discarded ? "discarded" : "queued");
    });
  }

  capturePrimary(scope: string, reply: ParsedMessage): void {
    if (reply.type !== 3 && reply.type !== 4) return;
    const transaction = this.one(`SELECT * FROM transactions WHERE scope=? AND start_message_id=?
      AND primary_status='pending' ORDER BY id DESC LIMIT 1`, scope, reply.id) as Transaction | undefined;
    if (!transaction) return;
    const payload = objectPayload(reply.payload);
    const primaryTx = transactionId(payload?.transactionId);
    const accepted = reply.type === 3 && objectPayload(payload?.idTagInfo)?.status === "Accepted" && primaryTx !== null;
    this.atomic(() => {
      this.run("UPDATE transactions SET primary_tx=?,primary_status=? WHERE id=?", primaryTx, accepted ? "accepted" : "rejected", transaction.id);
      if (accepted) {
        this.run("UPDATE frames SET state='queued',error=NULL WHERE transaction_key=? AND state='blocked' AND error='Primary acknowledgement is missing'", transaction.id);
      } else {
        // No physical transaction was accepted by the primary. Preserve the
        // request as a receipt, but do not invent one on a secondary.
        this.run("UPDATE frames SET state='cancelled',error='Primary rejected StartTransaction' WHERE transaction_key=?", transaction.id);
      }
    });
  }

  private transaction(id: number): Transaction {
    return this.requiredTransaction("SELECT * FROM transactions WHERE id=?", id);
  }

  canSend(entry: Delivery): boolean {
    if (entry.action !== "StartTransaction") return true;
    return entry.transactionKey !== null && this.transaction(entry.transactionKey).primary_status === "accepted";
  }

  mappedTransaction(entry: Delivery): string | null {
    return entry.transactionKey === null ? null : this.transaction(entry.transactionKey).secondary_tx;
  }

  head(scope: string): Delivery | undefined {
    const entry = this.one(`SELECT ${DELIVERY_COLUMNS} FROM frames WHERE scope=? AND
      (state IN ('queued','inflight','blocked','uncertain') OR (state='rejected' AND critical=1)) ORDER BY id LIMIT 1`, scope) as Delivery | undefined;
    return entry;
  }

  prepare(id: number, wire: string): void {
    this.run("UPDATE frames SET state='inflight',wire=COALESCE(wire,?),sent_at=? WHERE id=? AND state='queued'", wire, Date.now(), id);
  }

  block(id: number, error: string): void {
    this.run("UPDATE frames SET state='blocked',sent_at=NULL,error=? WHERE id=?", error, id);
  }

  malformed(id: number): void {
    this.run("UPDATE frames SET state='unconfirmed',sent_at=NULL,error='Frame has no OCPP CALL acknowledgement' WHERE id=?", id);
  }

  interrupt(scope?: string): void {
    this.atomic(() => {
      const values = scope === undefined ? [] : [scope];
      const filter = scope === undefined ? "" : " AND scope=?";
      this.run(`UPDATE frames SET state=CASE WHEN unsafe=1 THEN 'uncertain' ELSE 'queued' END,
        sent_at=NULL,error=CASE WHEN unsafe=1 THEN 'Connection ended before durable acknowledgement; reconcile before retrying' ELSE error END
        WHERE state='inflight'${filter}`, ...values);
      this.run(`UPDATE frames SET state='blocked',error='Primary acknowledgement is missing'
        WHERE state='queued' AND action='StartTransaction'
        AND transaction_key IN (SELECT id FROM transactions WHERE primary_status='pending')${filter}`, ...values);
    });
  }

  timeout(id: number): void {
    this.run(`UPDATE frames SET timeouts=timeouts+1,sent_at=NULL,
      state=CASE WHEN unsafe=1 THEN 'uncertain' WHEN timeouts+1>=2 THEN CASE WHEN critical=1 THEN 'uncertain' ELSE 'unconfirmed' END ELSE 'queued' END,
      error='Backend did not acknowledge delivery' WHERE id=?`, id);
  }

  acknowledge(scope: string, reply: ParsedMessage): number | null {
    if (reply.type !== 3 && reply.type !== 4) return null;
    const entry = this.one(`SELECT ${DELIVERY_COLUMNS} FROM frames WHERE scope=? AND relay_id=?
      AND wire IS NOT NULL AND state IN ('inflight','uncertain','unconfirmed') ORDER BY id LIMIT 1`, scope, reply.id) as Delivery | undefined;
    if (!entry) return null;
    const payload = objectPayload(reply.payload);
    const startAccepted = entry.action !== "StartTransaction" || (objectPayload(payload?.idTagInfo)?.status === "Accepted" && transactionId(payload?.transactionId) !== null);
    const bootAccepted = entry.action !== "BootNotification" || payload?.status === "Accepted";
    const tokenInfo = objectPayload(payload?.idTokenInfo);
    const eventAccepted = entry.action !== "TransactionEvent" || tokenInfo === null || tokenInfo.status === "Accepted";
    const transferAccepted = entry.action !== "DataTransfer" || payload?.status === "Accepted";
    const authorizationAccepted = entry.action !== "Authorize" || (objectPayload(payload?.idTagInfo) ?? tokenInfo)?.status === "Accepted";
    if (reply.type === 4 || !startAccepted || !bootAccepted || !eventAccepted || !transferAccepted || !authorizationAccepted) {
      this.run("UPDATE frames SET state='rejected',sent_at=NULL,error=? WHERE id=?", `Backend rejected ${entry.action ?? "frame"}: ${reply.raw}`, entry.id);
    } else {
      this.accept(entry, entry.action === "StartTransaction" ? transactionId(payload?.transactionId) : null);
    }
    return entry.id;
  }

  private accept(entry: Delivery, secondaryTx: string | null, note?: string, primaryTx?: string): void {
    this.atomic(() => {
      if (primaryTx !== undefined && entry.transactionKey !== null) {
        this.run("UPDATE transactions SET primary_tx=?,primary_status='accepted' WHERE id=?", primaryTx, entry.transactionKey);
      }
      if (entry.action === "StartTransaction") {
        if (entry.transactionKey === null || secondaryTx === null) throw new Error("Start receipt needs a secondary transaction ID");
        this.run("UPDATE transactions SET secondary_tx=? WHERE id=?", secondaryTx, entry.transactionKey);
      }
      if (entry.action === "StopTransaction" && entry.transactionKey !== null) {
        this.run("UPDATE transactions SET closed_at=? WHERE id=?", Date.now(), entry.transactionKey);
      }
      if (note || entry.operatorNote || (entry.unsafe && entry.action === "TransactionEvent")) {
        this.run("UPDATE frames SET state=?,sent_at=NULL,error=?,operator_note=? WHERE id=?", note ? "reconciled" : "delivered", note ?? null, note ?? entry.operatorNote, entry.id);
      } else {
        this.run("DELETE FROM frames WHERE id=?", entry.id);
      }
    });
  }

  /** Operator receipts are not fabricated backend messages. Nothing is sent. */
  resolve(id: number, outcome: "received" | "not_received", note: string, secondaryTx?: string, primaryTx?: string): void {
    const entry = this.one(`SELECT ${DELIVERY_COLUMNS} FROM frames WHERE id=?`, id) as Delivery | undefined;
    if (!entry || !["uncertain", "unconfirmed", "rejected", "blocked"].includes(entry.state)) throw new Error("Choose an unresolved delivery");
    if (!note.trim()) throw new Error("A reconciliation note is required");
    if (entry.action !== "StartTransaction" && (primaryTx !== undefined || secondaryTx !== undefined)) throw new Error("Transaction IDs apply only to start reconciliation");
    if (primaryTx !== undefined && (!/^-?\d+$/.test(primaryTx) || transactionId(Number(primaryTx)) === null)) throw new Error("Invalid primary transaction ID");
    if (entry.action === "StartTransaction") {
      if (entry.transactionKey === null) throw new Error("Start has no transaction record");
      const transaction = this.transaction(entry.transactionKey);
      if (transaction.primary_tx === null && primaryTx === undefined) throw new Error("The primary transaction ID must also be reconciled");
      if (transaction.primary_tx !== null && primaryTx !== undefined && transaction.primary_tx !== String(Number(primaryTx))) throw new Error("Cannot replace a confirmed primary transaction ID");
    }
    if (outcome === "not_received") {
      if (secondaryTx !== undefined) throw new Error("Non-receipt cannot assign a secondary transaction ID");
      this.atomic(() => {
        if (entry.transactionKey !== null && primaryTx !== undefined) {
          this.run("UPDATE transactions SET primary_tx=?,primary_status='accepted' WHERE id=?", String(Number(primaryTx)), entry.transactionKey);
        }
        this.run("UPDATE frames SET state='queued',wire=NULL,sent_at=NULL,timeouts=0,error=NULL,operator_note=? WHERE id=?", note, id);
      });
      return;
    }
    if (entry.action === "StartTransaction" && (secondaryTx === undefined || !/^-?\d+$/.test(secondaryTx) || transactionId(Number(secondaryTx)) === null)) {
      throw new Error("A received start requires a valid secondary transaction ID");
    }
    this.accept(entry, secondaryTx === undefined ? null : String(Number(secondaryTx)), note, primaryTx === undefined ? undefined : String(Number(primaryTx)));
  }

  discard(id: number, note: string): void {
    const entry = this.one(`SELECT ${DELIVERY_COLUMNS} FROM frames WHERE id=?`, id) as Delivery | undefined;
    if (!entry || entry.state === "inflight") throw new Error("Choose a delivery which is not in flight");
    if (!note.trim()) throw new Error("An explicit discard reason is required");
    this.atomic(() => {
      if (entry.action === "StartTransaction" && entry.transactionKey !== null) {
        // A discarded start cannot license its meter/stop frames to use IDs
        // belonging to another backend. Retain the whole session as discarded.
        this.run("UPDATE transactions SET discarded=1 WHERE id=?", entry.transactionKey);
        this.run("UPDATE frames SET state='discarded',sent_at=NULL,error=NULL,operator_note=? WHERE transaction_key=?", note, entry.transactionKey);
      } else {
        this.run("UPDATE frames SET state='discarded',sent_at=NULL,error=NULL,operator_note=? WHERE id=?", note, id);
      }
    });
  }

  bind(id: number, primaryTx: string, secondaryTx: string, note: string): void {
    const entry = this.one(`SELECT ${DELIVERY_COLUMNS} FROM frames WHERE id=?`, id) as Delivery | undefined;
    if (entry?.state !== "blocked" || entry.transactionKey !== null || entry.primaryTx !== primaryTx) {
      throw new Error("Choose a blocked delivery missing its transaction binding");
    }
    if (!/^-?\d+$/.test(primaryTx) || !/^-?\d+$/.test(secondaryTx) ||
        transactionId(Number(primaryTx)) === null || transactionId(Number(secondaryTx)) === null || !note.trim()) {
      throw new Error("Valid transaction IDs and a reconciliation note are required");
    }
    this.atomic(() => {
      this.run(`INSERT INTO transactions(scope,fingerprint,primary_tx,secondary_tx,primary_status)
        VALUES(?,?,?,?,'accepted')`, entry.scope, `manual:${randomUUID()}`, primaryTx, String(Number(secondaryTx)));
      const transaction = this.requiredTransaction("SELECT * FROM transactions WHERE scope=? AND primary_tx=? ORDER BY id DESC LIMIT 1", entry.scope, primaryTx);
      this.run(`UPDATE frames SET transaction_key=?,state=CASE WHEN state='blocked' THEN 'queued' ELSE state END,
        operator_note=? WHERE scope=? AND primary_tx=? AND transaction_key IS NULL`, transaction.id, note, entry.scope, primaryTx);
    });
  }

  inspect(): Delivery[] {
    const entries = this.all(`SELECT ${DELIVERY_COLUMNS} FROM frames ORDER BY id`) as Delivery[];
    return entries;
  }

  health() {
    let counts: Record<string, number> | null = null;
    let oldestPendingSeconds: number | null = null;
    try {
      const grouped = this.all("SELECT state,count(*) AS count FROM frames GROUP BY state") as { state: string; count: number }[];
      counts = Object.fromEntries(grouped.map(row => [row.state, row.count]));
      const oldestRow = this.one("SELECT min(created_at) AS created FROM frames WHERE state IN ('queued','inflight')") as { created: number | null } | undefined;
      const oldest = oldestRow?.created;
      oldestPendingSeconds = oldest == null ? 0 : Math.max(0, Math.floor((Date.now() - oldest) / 1000));
    } catch (error) {
      this.fail(error);
    }
    const degraded = this.storageError !== null || (oldestPendingSeconds ?? 0) >= 120 ||
      ["blocked", "uncertain", "unconfirmed", "rejected"].some(state => (counts?.[state] ?? 0) > 0);
    return { status: degraded ? "degraded" : "ok", counts, oldestPendingSeconds, storageError: this.storageError };
  }

  fail(error: unknown): void {
    this.storageError = error instanceof Error ? error.message : String(error);
  }

  close(): void {
    this.db.close();
  }
}

function objectPayload(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? value as Record<string, unknown> : null;
}

function transactionId(value: unknown): string | null {
  return typeof value === "number" && Number.isSafeInteger(value) ? String(value) : null;
}

