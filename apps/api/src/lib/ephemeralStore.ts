import Redis from 'ioredis';

/**
 * Ephemeral TTL key-value store (A13/A14).
 *
 * Backed by Redis when REDIS_URL is set, otherwise an in-memory Map (single-instance
 * dev fallback). Used for security primitives that must be shared across API replicas:
 *  - JWT jti revocation denylist (A13), instant logout / ban within the 15-min window
 *  - agent callback replay nonces (A14), per-instance caches are replay-bypassable at scale
 *
 * Degradation: if REDIS_URL is set but Redis errors, reads return "miss" and the
 * check-and-set returns "fresh" (fail-open). For 15-min tokens and best-effort replay
 * defense this is the safe failure mode, it never locks legitimate users/agents out.
 */

let _redis: Redis | null = null;
let _redisInitTried = false;
const mem = new Map<string, { value: string; expiresAt: number }>();

function getRedis(): Redis | null {
  if (_redis || _redisInitTried) return _redis;
  _redisInitTried = true;
  const url = process.env.REDIS_URL;
  if (!url) return null;
  try {
    _redis = new Redis(url, { maxRetriesPerRequest: 2, enableOfflineQueue: false });
    _redis.on('error', (err) => console.error('[ephemeralStore] redis error:', err.message));
  } catch (err) {
    console.error('[ephemeralStore] failed to init redis, using in-memory fallback:', (err as Error).message);
    _redis = null;
  }
  return _redis;
}

// In-memory fallback GC (no-op cost when Redis is used).
const _gc = setInterval(() => {
  const now = Date.now();
  for (const [k, v] of mem) if (v.expiresAt <= now) mem.delete(k);
}, 60_000);
_gc.unref?.();

export async function setWithTtl(key: string, value: string, ttlSeconds: number): Promise<void> {
  const ttl = Math.max(1, Math.ceil(ttlSeconds));
  const r = getRedis();
  if (r) {
    try {
      await r.set(key, value, 'EX', ttl);
      return;
    } catch (err) {
      console.error('[ephemeralStore] setWithTtl redis error:', (err as Error).message);
      return; // best-effort
    }
  }
  mem.set(key, { value, expiresAt: Date.now() + ttl * 1000 });
}

export async function get(key: string): Promise<string | null> {
  const r = getRedis();
  if (r) {
    try {
      return await r.get(key);
    } catch (err) {
      console.error('[ephemeralStore] get redis error:', (err as Error).message);
      return null; // fail-open (treat as miss)
    }
  }
  const v = mem.get(key);
  if (!v) return null;
  if (v.expiresAt <= Date.now()) {
    mem.delete(key);
    return null;
  }
  return v.value;
}

export async function exists(key: string): Promise<boolean> {
  return (await get(key)) !== null;
}

/**
 * Atomic check-and-set. Returns true if the key was newly set (not present), false if it
 * already existed. Used for replay-nonce protection. Fail-open (returns true) on Redis error.
 */
export async function setIfAbsentWithTtl(key: string, value: string, ttlSeconds: number): Promise<boolean> {
  const ttl = Math.max(1, Math.ceil(ttlSeconds));
  const r = getRedis();
  if (r) {
    try {
      const res = await r.set(key, value, 'EX', ttl, 'NX');
      return res === 'OK';
    } catch (err) {
      console.error('[ephemeralStore] setIfAbsentWithTtl redis error:', (err as Error).message);
      return true; // fail-open
    }
  }
  const cur = mem.get(key);
  if (cur && cur.expiresAt > Date.now()) return false;
  mem.set(key, { value, expiresAt: Date.now() + ttl * 1000 });
  return true;
}

// --- A13: JWT jti revocation denylist ---

const REVOKED_PREFIX = 'revoked:jti:';

export async function revokeJti(jti: string, ttlSeconds: number): Promise<void> {
  await setWithTtl(`${REVOKED_PREFIX}${jti}`, '1', ttlSeconds);
}

export async function isJtiRevoked(jti: string): Promise<boolean> {
  return exists(`${REVOKED_PREFIX}${jti}`);
}
