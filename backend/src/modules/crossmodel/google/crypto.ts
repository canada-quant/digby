/**
 * AES-256-GCM encryption/decryption for OAuth tokens.
 *
 * Key is a 32-byte hex string stored in env var (GOOGLE_TOKEN_ENCRYPTION_KEY by default).
 * Format: base64(iv[12] + authTag[16] + ciphertext)
 *
 * Two modes:
 *   - Default: uses GOOGLE_TOKEN_ENCRYPTION_KEY (convenience wrappers encrypt/decrypt)
 *   - Generic: uses encryptWith/decryptWith — pass the env var name as second argument
 */

import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';

const ALGO         = 'aes-256-gcm';
const IV_LEN       = 12;   // 96-bit IV for GCM
const AUTH_TAG_LEN = 16;   // 128-bit auth tag

/**
 * The named token-encryption env var is unset or malformed. Server
 * MISCONFIGURATION (not a client mistake and not a bug): self-hosted
 * instances whose .env skips e.g. GITHUB_TOKEN_ENCRYPTION_KEY used to
 * surface this as a bare 500 with a leaking stack trace on token save
 * (ticket 387a5760). Self-contained (no imports) so this leaf crypto module
 * never drags config/env into its importers — error-handler renders the
 * 503 + message via an instanceof arm.
 */
export class EncryptionKeyError extends Error {
  readonly statusCode = 503;
  readonly isOperational = false;
  constructor(message: string) {
    super(message);
    this.name = 'EncryptionKeyError';
    Object.setPrototypeOf(this, EncryptionKeyError.prototype);
  }
}

function getKey(envVar = 'GOOGLE_TOKEN_ENCRYPTION_KEY'): Buffer {
  const hex = process.env[envVar];
  if (!hex) throw new EncryptionKeyError(
    `${envVar} is not set on the server — OAuth/account tokens cannot be encrypted. ` +
    'The instance operator must set it to a 32-byte hex key (64 hex chars, `openssl rand -hex 32`) ' +
    'and restart the backend. Self-hosted instances: see docs/SELF_HOST.md.'
  );
  const key = Buffer.from(hex, 'hex');
  if (key.length !== 32) {
    throw new EncryptionKeyError(
      `${envVar} must be 32 bytes (64 hex chars) — got ${key.length} bytes. ` +
      'Regenerate it with `openssl rand -hex 32` and restart the backend.'
    );
  }
  return key;
}

/** Encrypt plaintext → base64(iv + authTag + ciphertext) using GOOGLE_TOKEN_ENCRYPTION_KEY */
export function encrypt(plaintext: string): string {
  return encryptWith(plaintext, 'GOOGLE_TOKEN_ENCRYPTION_KEY');
}

/** Decrypt base64(iv + authTag + ciphertext) → plaintext using GOOGLE_TOKEN_ENCRYPTION_KEY */
export function decrypt(ciphertext: string): string {
  return decryptWith(ciphertext, 'GOOGLE_TOKEN_ENCRYPTION_KEY');
}

/**
 * Encrypt plaintext using a specific env var as the encryption key.
 * @param plaintext  String to encrypt
 * @param keyEnvVar   Name of env var containing the 64-hex-char key
 */
export function encryptWith(plaintext: string, keyEnvVar: string): string {
  const key = getKey(keyEnvVar);
  const iv  = randomBytes(IV_LEN);
  const cipher = createCipheriv(ALGO, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag   = cipher.getAuthTag();
  return Buffer.concat([iv, authTag, encrypted]).toString('base64');
}

/**
 * Decrypt base64(iv + authTag + ciphertext) using a specific env var as the encryption key.
 * @param ciphertext  Base64 string from encryptWith
 * @param keyEnvVar    Name of env var containing the 64-hex-char key
 */
export function decryptWith(ciphertext: string, keyEnvVar: string): string {
  const key = getKey(keyEnvVar);
  const buf = Buffer.from(ciphertext, 'base64');
  const iv       = buf.subarray(0, IV_LEN);
  const authTag  = buf.subarray(IV_LEN, IV_LEN + AUTH_TAG_LEN);
  const encrypted = buf.subarray(IV_LEN + AUTH_TAG_LEN);
  const decipher = createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(authTag);
  return decipher.update(encrypted).toString('utf8') + decipher.final('utf8');
}
