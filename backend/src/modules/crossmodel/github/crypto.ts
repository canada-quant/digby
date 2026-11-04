/**
 * GitHub crypto — re-exports the generic encryptWith/decryptWith from the Google module
 * so callers can use a consistent import path.
 *
 * GitHub tokens are encrypted with the GITHUB_TOKEN_ENCRYPTION_KEY env var.
 */

export { encryptWith, decryptWith } from '../google/crypto';
