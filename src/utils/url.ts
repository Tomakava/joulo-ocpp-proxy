import type { CsmsBackend } from "../config";

export function resolveCsmsUrl(
  backend: CsmsBackend,
  chargePointId: string,
): string {
  if (!backend.appendChargePointId) return backend.url;

  const parsed = new URL(backend.url);
  const base = parsed.pathname.replace(/\/+$/, "");
  parsed.pathname = `${base}/${chargePointId}`;
  return parsed.toString();
}
