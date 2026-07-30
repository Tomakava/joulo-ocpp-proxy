import { readFileSync, renameSync, writeFileSync } from "fs";
import { createLogger } from "./logger";

const DEFAULT_STATE_FILE = "/data/state.json";
const FLUSH_DEBOUNCE_MS = 500;
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const STATE_VERSION = 1;

const log = createLogger("state");

interface TxEntry {
  secondaryTxId: string;
  lastUpdatedAt: number;
}

function storeKey(chargerId: string, secondaryUrl: string): string {
  return `${chargerId}::${secondaryUrl}`;
}

/**
 * Persists the primary→secondary transaction ID mappings so a proxy restart or
 * charger reconnect mid-transaction doesn't strand MeterValues and
 * StopTransaction with a transaction ID the secondary never issued.
 *
 * Writes are debounced and best-effort: losing the file costs mapping accuracy,
 * never charger traffic.
 */
export class StateStore {
  /** storeKey → (primary txId → entry) */
  private txMaps = new Map<string, Map<string, TxEntry>>();
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private flushFailureWarned = false;

  constructor(
    private readonly path: string = process.env.STATE_FILE ?? DEFAULT_STATE_FILE
  ) {}

  load(): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(this.path, "utf8"));
    } catch {
      // Missing or corrupt — start fresh.
      return;
    }

    this.txMaps = parseStateData(parsed);
    this.prune();
  }

  /** Mappings recorded for one charger/secondary pair, as a live working map. */
  get(chargerId: string, secondaryUrl: string): Map<string, string> {
    const entries = this.txMaps.get(storeKey(chargerId, secondaryUrl));
    if (entries === undefined) return new Map();

    return new Map(
      [...entries].map(([primaryTxId, entry]) => [
        primaryTxId,
        entry.secondaryTxId,
      ])
    );
  }

  set(
    chargerId: string,
    secondaryUrl: string,
    primaryTxId: string,
    secondaryTxId: string
  ): void {
    const key = storeKey(chargerId, secondaryUrl);
    let entries = this.txMaps.get(key);
    if (entries === undefined) {
      entries = new Map();
      this.txMaps.set(key, entries);
    }

    entries.set(primaryTxId, { secondaryTxId, lastUpdatedAt: Date.now() });
    this.scheduleFlush();
  }

  delete(chargerId: string, secondaryUrl: string, primaryTxId: string): void {
    const key = storeKey(chargerId, secondaryUrl);
    const entries = this.txMaps.get(key);
    if (entries === undefined) return;

    entries.delete(primaryTxId);
    if (entries.size === 0) this.txMaps.delete(key);
    this.scheduleFlush();
  }

  flush(): void {
    if (this.flushTimer !== null) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }

    const temporaryPath = `${this.path}.tmp`;
    try {
      // Write-then-rename so a crash mid-write can't truncate the live file.
      writeFileSync(temporaryPath, JSON.stringify(this.serialize(), null, 2), "utf8");
      renameSync(temporaryPath, this.path);
    } catch (err) {
      // Best-effort — non-fatal, but warn once so a misconfigured /data mount
      // or read-only volume doesn't fail silently for the lifetime of the
      // process.
      if (!this.flushFailureWarned) {
        this.flushFailureWarned = true;
        log.warn("failed to persist state; txIdMap will not survive restart", {
          path: this.path,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  private serialize(): object {
    const txMaps: Record<string, Record<string, TxEntry>> = {};
    for (const [key, entries] of this.txMaps) {
      txMaps[key] = Object.fromEntries(entries);
    }
    return { version: STATE_VERSION, txMaps };
  }

  private scheduleFlush(): void {
    if (this.flushTimer !== null) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.flush();
    }, FLUSH_DEBOUNCE_MS);
  }

  /** Drop mappings for transactions that can no longer plausibly be running. */
  private prune(): void {
    const cutoff = Date.now() - MAX_AGE_MS;

    for (const [key, entries] of this.txMaps) {
      for (const [primaryTxId, entry] of entries) {
        if (entry.lastUpdatedAt < cutoff) entries.delete(primaryTxId);
      }
      if (entries.size === 0) this.txMaps.delete(key);
    }
  }
}

/** Read a persisted state file, ignoring anything that isn't in the expected shape. */
function parseStateData(parsed: unknown): Map<string, Map<string, TxEntry>> {
  const result = new Map<string, Map<string, TxEntry>>();

  if (typeof parsed !== "object" || parsed === null) return result;

  const { version, txMaps } = parsed as Record<string, unknown>;
  if (version !== STATE_VERSION) return result;
  if (typeof txMaps !== "object" || txMaps === null) return result;

  for (const [key, rawEntries] of Object.entries(txMaps)) {
    if (typeof rawEntries !== "object" || rawEntries === null) continue;

    const entries = new Map<string, TxEntry>();
    for (const [primaryTxId, rawEntry] of Object.entries(
      rawEntries as Record<string, unknown>
    )) {
      const entry = parseTxEntry(rawEntry);
      if (entry !== null) entries.set(primaryTxId, entry);
    }

    if (entries.size > 0) result.set(key, entries);
  }

  return result;
}

function parseTxEntry(rawEntry: unknown): TxEntry | null {
  if (typeof rawEntry !== "object" || rawEntry === null) return null;

  const { secondaryTxId, lastUpdatedAt } = rawEntry as Record<string, unknown>;
  if (typeof secondaryTxId !== "string") return null;
  if (typeof lastUpdatedAt !== "number") return null;

  return { secondaryTxId, lastUpdatedAt };
}
