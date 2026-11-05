import dotenv from 'dotenv';
import { z } from 'zod';

dotenv.config();

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.string().default('4000'),
  DATABASE_URL: z.string(),
  REDIS_URL: z.string(),
  JWT_SECRET: z.string().min(32),
  JWT_REFRESH_SECRET: z.string().min(32),
  JWT_EXPIRES_IN: z.string().default('15m'),
  JWT_REFRESH_EXPIRES_IN: z.string().default('7d'),
  COHERE_API_KEY: z.string().optional(),
  // Google OAuth & MCP (optional — features are disabled if not set)
  GOOGLE_OAUTH_CLIENT_ID:       z.string().optional(),
  GOOGLE_OAUTH_CLIENT_SECRET:   z.string().optional(),
  GOOGLE_OAUTH_REDIRECT_URI:    z.string().optional(),
  GOOGLE_TOKEN_ENCRYPTION_KEY:  z.string().optional(), // 32-byte hex (64 chars)
  GOOGLE_MCP_API_KEY:           z.string().optional(),
  GOOGLE_MCP_URL:               z.string().optional(), // default: http://google-mcp-prod:8000/mcp
  // GitHub OAuth & MCP (optional — features are disabled if not set)
  GITHUB_OAUTH_CLIENT_ID:       z.string().optional(),
  GITHUB_OAUTH_CLIENT_SECRET:   z.string().optional(),
  GITHUB_TOKEN_ENCRYPTION_KEY:  z.string().optional(), // 32-byte hex (64 chars)
  GITHUB_MCP_API_KEY:           z.string().optional(),
  GITHUB_MCP_URL:               z.string().optional(), // default: http://github-mcp-prod:8000/mcp
  // X (Twitter) OAuth 2.0 PKCE + MCP container — optional, feature disabled if not set
  X_OAUTH_CLIENT_ID:            z.string().optional(),
  X_OAUTH_CLIENT_SECRET:        z.string().optional(),
  X_OAUTH_REDIRECT_URI:         z.string().optional(),
  X_TOKEN_ENCRYPTION_KEY:       z.string().optional(), // 32-byte hex (64 chars) — openssl rand -hex 32
  X_MCP_API_KEY:                z.string().optional(),
  X_MCP_URL:                    z.string().optional(), // default: http://x-mcp-prod:8000/mcp
  X_BEARER_TOKEN:               z.string().optional(), // app-only token (currently unused)
  // macOS iMessage bridge agent (optional — feature is dark until a Mac is paired)
  IMESSAGE_AGENT_API_URL:       z.string().optional(), // base URL the Mac agent dials home to (default: https://digby.ai/api)
  IMESSAGE_AGENT_DOWNLOAD_URL:  z.string().optional(), // where the UI links users to download the agent
});

const parseEnv = () => {
  try {
    const parsed = envSchema.parse(process.env);

    // Validate Google OAuth key at startup if Google OAuth is configured.
    // Without this, the error only surfaces when a user tries to connect Google
    // (inside crypto.ts getKey()), which gives a 500 with a leaking stack trace.
    // Xero and Plaid tokens are encrypted with the SAME key (xero/token-manager.ts,
    // plaid/token-manager.ts import ../google/crypto), so their credentials are
    // boot signals too (2026-10-20 self-host hardening; XERO_* / PLAID_* are not
    // in the Zod schema — read process.env). Production sets the key.
    const tokenKeyUsers = [
      parsed.GOOGLE_OAUTH_CLIENT_ID && 'GOOGLE_OAUTH_CLIENT_ID',
      process.env.XERO_CLIENT_ID && 'XERO_CLIENT_ID',
      process.env.PLAID_CLIENT_ID && 'PLAID_CLIENT_ID',
    ].filter((x): x is string => !!x);
    if (tokenKeyUsers.length > 0) {
      if (!parsed.GOOGLE_TOKEN_ENCRYPTION_KEY) {
        console.error(`❌ ${tokenKeyUsers.join(' / ')} is set but GOOGLE_TOKEN_ENCRYPTION_KEY is missing. ` +
          'Set GOOGLE_TOKEN_ENCRYPTION_KEY to a 32-byte hex string (64 hex chars). ' +
          'Generate with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"');
        process.exit(1);
      }
      const keyBuf = Buffer.from(parsed.GOOGLE_TOKEN_ENCRYPTION_KEY, 'hex');
      if (keyBuf.length !== 32) {
        console.error('❌ GOOGLE_TOKEN_ENCRYPTION_KEY must be exactly 32 bytes (64 hex characters). ' +
          `Got ${keyBuf.length} bytes (${parsed.GOOGLE_TOKEN_ENCRYPTION_KEY.length} hex chars).`);
        process.exit(1);
      }
    }

    // Same fail-fast for GitHub (ticket 387a5760): saving a GitHub account —
    // OAuth or pasted personal access token — encrypts with this key. Gate on
    // the opt-in signals that default EMPTY in every compose file (the OAuth
    // app id, the MCP API key); GITHUB_MCP_URL always has a default and would
    // false-positive on instances that never touch GitHub. A PAT-only instance
    // (no OAuth app, no MCP key) has no boot signal — that case is caught at
    // the endpoint with a 503 naming the env var
    // (github-oauth.controller.ts assertEncryptionKey).
    if (parsed.GITHUB_OAUTH_CLIENT_ID || parsed.GITHUB_MCP_API_KEY) {
      if (!parsed.GITHUB_TOKEN_ENCRYPTION_KEY) {
        console.error('❌ GITHUB_TOKEN_ENCRYPTION_KEY is not set, but the GitHub integration is active ' +
          '(GITHUB_OAUTH_CLIENT_ID or GITHUB_MCP_API_KEY is configured). Saving a GitHub account — OAuth or ' +
          'personal access token — will fail. Set GITHUB_TOKEN_ENCRYPTION_KEY to a 32-byte hex string ' +
          '(64 hex chars). Generate with: openssl rand -hex 32');
        process.exit(1);
      }
      const githubKeyBuf = Buffer.from(parsed.GITHUB_TOKEN_ENCRYPTION_KEY, 'hex');
      if (githubKeyBuf.length !== 32) {
        console.error('❌ GITHUB_TOKEN_ENCRYPTION_KEY must be exactly 32 bytes (64 hex characters). ' +
          `Got ${githubKeyBuf.length} bytes (${parsed.GITHUB_TOKEN_ENCRYPTION_KEY.length} hex chars). ` +
          'Generate with: openssl rand -hex 32');
        process.exit(1);
      }
    }

    return parsed;
  } catch (error) {
    console.error('❌ Invalid environment variables:', error);
    process.exit(1);
  }
};

export const env = parseEnv();
