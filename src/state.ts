import { readFileSync } from "node:fs";

/**
 * Read the previous JSON mapping format without changing it. Active mappings
 * must not expire merely because the charger has stayed plugged in for a week.
 * A malformed existing file is an upgrade error, not an empty set of mappings.
 */
export function readLegacyState(path: string): Map<string, Map<string, string>> {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return new Map();
    throw error;
  }
  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed !== "object" || parsed === null || !("version" in parsed) || parsed.version !== 1 || !("txMaps" in parsed) || typeof parsed.txMaps !== "object" || parsed.txMaps === null || Array.isArray(parsed.txMaps)) {
    throw new Error("Unsupported or corrupt legacy transaction state");
  }
  const result = new Map<string, Map<string, string>>();
  const txMaps = parsed.txMaps as Record<string, unknown>;
  for (const [key, value] of Object.entries(txMaps)) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new Error("Corrupt legacy transaction mappings");
    }
    const mappings = new Map<string, string>();
    const entries = value as Record<string, unknown>;
    for (const [primary, entry] of Object.entries(entries)) {
      if (!/^-?\d+$/.test(primary) || !Number.isSafeInteger(Number(primary)) ||
          typeof entry !== "object" || entry === null || !("secondaryTxId" in entry) ||
          typeof entry.secondaryTxId !== "string" || !/^-?\d+$/.test(entry.secondaryTxId) ||
          !Number.isSafeInteger(Number(entry.secondaryTxId))) {
        throw new Error("Corrupt legacy transaction mapping");
      }
      mappings.set(String(Number(primary)), String(Number(entry.secondaryTxId)));
    }
    result.set(key, mappings);
  }
  return result;
}
