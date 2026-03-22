import crypto from 'crypto';

/**
 * AES-256-GCM encryption helpers for secrets at rest.
 *
 * Used by: webhook secrets, registry credentials, connection tokens.
 * Format: base64(iv):base64(authTag):base64(ciphertext)
 *
 * The ENCRYPTION_KEY env var is required in production.
 * In dev without a key, encrypt/decrypt are no-ops (plaintext passthrough).
 */

const ENCRYPTED_PREFIX = 'enc:';

let _derivedKey: Buffer | null = null;

function getDerivedKey(): Buffer | null {
  if (_derivedKey) return _derivedKey;
  const key = process.env.ENCRYPTION_KEY;
  if (!key || key.length < 32) return null;
  _derivedKey = crypto.createHash('sha256').update(key).digest();
  return _derivedKey;
}

/**
 * Encrypt a plaintext string. Returns prefixed ciphertext.
 * If ENCRYPTION_KEY is not set, returns plaintext unchanged (dev mode).
 */
export function encryptSecret(plaintext: string): string {
  const key = getDerivedKey();
  if (!key) return plaintext;

  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return `${ENCRYPTED_PREFIX}${iv.toString('base64')}:${authTag.toString('base64')}:${encrypted.toString('base64')}`;
}

/**
 * Decrypt a secret. Handles both encrypted (prefixed) and legacy plaintext values.
 * This provides backward compatibility — old plaintext secrets still work.
 */
export function decryptSecret(stored: string): string {
  if (!stored.startsWith(ENCRYPTED_PREFIX)) {
    // Legacy plaintext — return as-is
    return stored;
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

  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(authTag);
  const decrypted = Buffer.concat([decipher.update(data), decipher.final()]);
  return decrypted.toString('utf8');
}

/**
 * Check if a stored value is already encrypted.
 */
export function isEncrypted(stored: string): boolean {
  return stored.startsWith(ENCRYPTED_PREFIX);
}
