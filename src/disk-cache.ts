import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { log } from "./log.js";
import { tmpRoot } from "./tmp-root.js";

/**
 * Optional persistent description cache, layered under the in-process LRU:
 * identical image + prompt + model pairs survive server restarts without
 * paying the VLM API again. Files are <sha256-key>.txt under a cache dir.
 * All I/O is best-effort — read/write failures are logged and ignored. The
 * dir is created 0700, files are written 0600, writes are atomic (temp file
 * + rename), and the cache is capped at `maxEntries` (oldest by mtime first).
 */
export interface DiskCache {
  readonly enabled: boolean;
  get(key: string): Promise<string | undefined>;
  set(key: string, text: string): Promise<void>;
}

export function createDiskCache(enabled: boolean, dir?: string, maxEntries = 500): DiskCache {
  const root = dir ?? path.join(tmpRoot(), "cache");
  let dirReady: Promise<string> | undefined;

  const ensureDir = async (): Promise<string> => {
    await fs.mkdir(root, { recursive: true, mode: 0o700 });
    // mkdir's mode applies only to newly created dirs; enforce it on existing ones too.
    await fs.chmod(root, 0o700);
    return root;
  };

  /**
   * Drop the oldest entries (by mtime, then name) when the cache would exceed
   * maxEntries. The incoming write adds one more file, so evict the excess
   * relative to that, not the current count.
   */
  const evictIfNeeded = async (): Promise<void> => {
    try {
      const names = await fs.readdir(root);
      const dayAgo = Date.now() - 24 * 60 * 60 * 1000;
      // Sweep orphaned atomic-write leftovers (crash between writeFile and rename).
      for (const n of names.filter((n) => n.endsWith(".tmp"))) {
        const p = path.join(root, n);
        const s = await fs.stat(p).catch(() => undefined);
        if (s && s.mtimeMs < dayAgo) await fs.unlink(p).catch(() => {});
      }
      const txts = names.filter((n) => n.endsWith(".txt"));
      const overflow = txts.length + 1 - maxEntries;
      if (overflow <= 0) return;
      const entries = await Promise.all(
        txts.map(async (name) => {
          const p = path.join(root, name);
          try {
            const s = await fs.stat(p);
            return { p, mtime: s.mtimeMs, name };
          } catch {
            return undefined; // raced away
          }
        }),
      );
      const valid = entries.filter((e): e is NonNullable<(typeof entries)[number]> => e !== undefined);
      valid.sort((a, b) => (a.mtime !== b.mtime ? a.mtime - b.mtime : a.name.localeCompare(b.name)));
      for (const e of valid.slice(0, overflow)) {
        await fs.unlink(e.p).catch(() => {});
      }
    } catch (err) {
      log("disk cache eviction failed:", err instanceof Error ? err.message : String(err));
    }
  };

  return {
    enabled,
    async get(key) {
      if (!enabled) return undefined;
      try {
        return await fs.readFile(path.join(root, `${key}.txt`), "utf8");
      } catch {
        return undefined;
      }
    },
    async set(key, text) {
      if (!enabled) return;
      try {
        dirReady ??= ensureDir().catch((err) => {
          dirReady = undefined;
          throw err;
        });
        const dir = await dirReady;
        await evictIfNeeded();
        const finalPath = path.join(dir, `${key}.txt`);
        const tmpPath = path.join(dir, `.${key}.${process.pid}.${randomUUID()}.tmp`);
        await fs.writeFile(tmpPath, text, { encoding: "utf8", mode: 0o600 });
        await fs.rename(tmpPath, finalPath); // atomic: readers never observe a partial file
      } catch (err) {
        log("disk cache write failed:", err instanceof Error ? err.message : String(err));
      }
    },
  };
}

/** Reads AGENT_EYES_DISK_CACHE / AGENT_EYES_DISK_CACHE_DIR from the environment. */
export function createDiskCacheFromEnv(): DiskCache {
  const raw = (process.env.AGENT_EYES_DISK_CACHE ?? "").trim().toLowerCase();
  const enabled = raw === "1" || raw === "true";
  return createDiskCache(enabled, process.env.AGENT_EYES_DISK_CACHE_DIR || undefined);
}
