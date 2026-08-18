/**
 * Shared env parsing helpers. Read lazily (per call) so tests and embedders
 * can change process.env between invocations.
 */

/**
 * Read a positive-integer millisecond timeout from an env var. Missing,
 * empty, non-numeric, or non-positive values fall back to `fallback`.
 */
export function envTimeoutMs(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.floor(n);
}
