import { createHash } from "node:crypto";

export interface LruCache<K, V> {
  get(key: K): V | undefined;
  set(key: K, value: V): void;
  has(key: K): boolean;
  size(): number;
}

/**
 * In-process LRU cache. A Map preserves insertion order, so "delete + re-set"
 * on access refreshes recency. Oldest entries are evicted when over capacity.
 */
export function createLruCache<K, V>(max = 128): LruCache<K, V> {
  const map = new Map<K, V>();
  return {
    get(key) {
      const value = map.get(key);
      if (value === undefined) return undefined;
      map.delete(key);
      map.set(key, value);
      return value;
    },
    set(key, value) {
      if (map.has(key)) map.delete(key);
      map.set(key, value);
      if (map.size > max) {
        const oldest = map.keys().next().value;
        if (oldest !== undefined) map.delete(oldest);
      }
    },
    has: (key) => map.has(key),
    size: () => map.size,
  };
}

/**
 * Cache key: sha256 of the image bytes (one or many views, in order), the
 * assembled user prompt, the model name, and (when given) the provider name
 * and detail level — identical image + question + model + provider + detail
 * pairs never call the API twice. The provider/detail parameters are optional
 * for backward compatibility; callers that know them should pass them.
 */
export function cacheKey(bytes: Buffer | Buffer[], prompt: string, model: string, providerName = "", detail = ""): string {
  const hash = createHash("sha256");
  const list = Array.isArray(bytes) ? bytes : [bytes];
  // Length-prefix each buffer so view boundaries are unambiguous
  // (hashing [a, b] never collides with hashing the concatenation a+b).
  for (const b of list) {
    const prefix = Buffer.alloc(4);
    prefix.writeUInt32BE(b.length);
    hash.update(prefix);
    hash.update(b);
  }
  hash.update(prompt).update(model).update(providerName).update(detail);
  return hash.digest("hex");
}
