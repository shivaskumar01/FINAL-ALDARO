import crypto from 'crypto';

/**
 * AES-256-GCM encryption helpers for secrets at rest (shared by API + worker).
 *
 * Format: enc:base64(iv):base64(authTag):base64(ciphertext)
 * Key derivation: HKDF-SHA256 over ENCRYPTION_KEY (with a legacy raw-SHA256 fallback
 * for data encrypted before the HKDF migration).
 *
 * A10: previously duplicated in apps/api/src/lib/encryption.ts; now the single source of
 * truth so the worker (webhook delivery) and API agree on the scheme.
 *
 * NOTE: registry-credentials / per-workspace S3 secrets use a separate, internally
 * consistent raw-SHA256 scheme (no `enc:` prefix) and are intentionally NOT handled here.
 */

const ENCRYPTED_PREFIX = 'enc:';

let _derivedKey: Buffer | null = null;
let _legacyKey: Buffer | null = null;

function getDerivedKey(): Buffer | null {
  if (_derivedKey) return _derivedKey;
  const key = process.env.ENCRYPTION_KEY;
  if (!key || key.length < 32) return null;
  const derived = crypto.hkdfSync('sha256', key, 'aldaro-encryption-salt', 'aes-256-gcm-key', 32);
  _derivedKey = Buffer.isBuffer(derived) ? derived : Buffer.from(derived);
  return _derivedKey;
}

/** Legacy SHA-256 key derivation — used only as a decryption fallback for pre-HKDF data. */
function getLegacyKey(): Buffer | null {
  if (_legacyKey) return _legacyKey;
  const key = process.env.ENCRYPTION_KEY;
  if (!key || key.length < 32) return null;
  _legacyKey = crypto.createHash('sha256').update(key).digest();
  return _legacyKey;
}

export function encryptSecret(plaintext: string): string {
  const key = getDerivedKey();
  if (!key) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('ENCRYPTION_KEY is required in production — refusing to store plaintext secret');
    }
    return plaintext;
  }

  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return `${ENCRYPTED_PREFIX}${iv.toString('base64')}:${authTag.toString('base64')}:${encrypted.toString('base64')}`;
}

export function decryptSecret(stored: string): string {
  if (!stored.startsWith(ENCRYPTED_PREFIX)) {
    return stored; // legacy plaintext — return as-is
  }

  const key = getDerivedKey();
  if (!key) {
    throw new Error('Cannot decrypt secret: ENCRYPTION_KEY is not configured');
  }

  const payload = stored.slice(ENCRYPTED_PREFIX.length);
  const [ivB64, tagB64, dataB64] = payload.split(':');
  if (!ivB64 || !tagB64 || !dataB64) {
    throw new Error('Invalid encrypted secret format');
  }

  const iv = Buffer.from(ivB64, 'base64');
  const authTag = Buffer.from(tagB64, 'base64');
  const data = Buffer.from(dataB64, 'base64');

  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(authTag);
    return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
  } catch {
    const legacy = getLegacyKey();
    if (!legacy) throw new Error('Decryption failed and no legacy key available');
    const decipher = crypto.createDecipheriv('aes-256-gcm', legacy, iv);
    decipher.setAuthTag(authTag);
    return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
  }
}

export function isEncrypted(stored: string): boolean {
  return stored.startsWith(ENCRYPTED_PREFIX);
}
