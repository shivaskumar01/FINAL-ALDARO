/**
 * AES-256-GCM encryption helpers for secrets at rest.
 *
 * A10: the implementation now lives in @aldaro/shared (single source of truth) so the API
 * and worker share one scheme. This module re-exports it for backward compatibility with
 * existing imports (`import { decryptSecret } from './encryption'`).
 *
 * Used by: webhook endpoint secrets (encrypt at create, decrypt at delivery time).
 * NOTE: registry credentials and per-workspace S3 secrets use a separate raw-SHA256 scheme
 * (see registry-credentials.ts / warm-pool.ts) and do NOT go through these helpers.
 */
export { encryptSecret, decryptSecret, isEncrypted } from '@aldaro/shared';
