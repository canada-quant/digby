/**
 * Re-export the AES-256-GCM helpers from the Google module. The crypto
 * primitives are identical across MCP integrations — only the env-var name
 * (X_TOKEN_ENCRYPTION_KEY) differs, and the caller passes that in.
 */
export { encryptWith, decryptWith } from '../google/crypto';
