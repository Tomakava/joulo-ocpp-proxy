export function parsePositiveInteger(
  value: string | undefined,
  fallback?: number
): number | undefined {
  if (value === undefined) return fallback;

  const normalized = value.trim().toLowerCase();
  if (normalized === "") return fallback;

  const parsed = parseInt(normalized, 10);
  if (!Number.isFinite(parsed) || parsed < 1) return fallback;

  return parsed;
}
