/**
 * Tests for the AES-256-GCM OAuth-token crypto helpers.
 *
 * github/slack/asana/x crypto modules re-export encryptWith/decryptWith from
 * this module, so these tests cover every provider's token-encryption path.
 */

import { encrypt, decrypt, encryptWith, decryptWith } from './crypto';

const DEFAULT_KEY_ENV = 'GOOGLE_TOKEN_ENCRYPTION_KEY';
const KEY_A_ENV = 'TEST_CRYPTO_KEY_A';
const KEY_B_ENV = 'TEST_CRYPTO_KEY_B';

// Valid 32-byte keys, 64 hex chars each.
const KEY_DEFAULT = 'a'.repeat(64);
const KEY_A = 'b'.repeat(64);
const KEY_B = 'c'.repeat(64);

const MANAGED_ENVS = [DEFAULT_KEY_ENV, KEY_A_ENV, KEY_B_ENV];

const IV_LEN = 12;
const AUTH_TAG_LEN = 16;

let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
  savedEnv = {};
  for (const name of MANAGED_ENVS) {
    savedEnv[name] = process.env[name];
  }
  process.env[DEFAULT_KEY_ENV] = KEY_DEFAULT;
  process.env[KEY_A_ENV] = KEY_A;
  process.env[KEY_B_ENV] = KEY_B;
});

afterEach(() => {
  for (const name of MANAGED_ENVS) {
    const prev = savedEnv[name];
    if (prev === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = prev;
    }
  }
});

describe('encrypt/decrypt (default GOOGLE_TOKEN_ENCRYPTION_KEY)', () => {
  it('round-trips plaintext including unicode, newlines, empty and long strings', () => {
    const samples = [
      'hello world',
      '',
      'multi\nline\ntext',
      'üñïçødé 🔐 トークン',
      'x'.repeat(10_000),
    ];
    for (const plaintext of samples) {
      expect(decrypt(encrypt(plaintext))).toBe(plaintext);
    }
  });

  it('emits base64(iv[12] + authTag[16] + ciphertext)', () => {
    const plaintext = 'format check';
    const buf = Buffer.from(encrypt(plaintext), 'base64');
    expect(buf.length).toBe(IV_LEN + AUTH_TAG_LEN + Buffer.byteLength(plaintext));
  });

  it('uses a random IV: the same plaintext encrypts to different ciphertexts', () => {
    expect(encrypt('same input')).not.toBe(encrypt('same input'));
  });

  it('rejects a tampered ciphertext body (GCM auth verification)', () => {
    const buf = Buffer.from(encrypt('sensitive token'), 'base64');
    const last = buf.length - 1;
    buf[last] = (buf[last] as number) ^ 0xff;
    expect(() => decrypt(buf.toString('base64'))).toThrow();
  });

  it('rejects a tampered auth tag', () => {
    const buf = Buffer.from(encrypt('sensitive token'), 'base64');
    buf[IV_LEN] = (buf[IV_LEN] as number) ^ 0x01;
    expect(() => decrypt(buf.toString('base64'))).toThrow();
  });

  it('cannot decrypt with the wrong key', () => {
    const ciphertext = encryptWith('secret', KEY_A_ENV);
    expect(() => decryptWith(ciphertext, KEY_B_ENV)).toThrow();
  });
});

describe('encryptWith/decryptWith (named env var key)', () => {
  it('round-trips using the specified env var', () => {
    const plaintext = 'github oauth access token';
    expect(decryptWith(encryptWith(plaintext, KEY_A_ENV), KEY_A_ENV)).toBe(plaintext);
  });

  it('isolated keys: a ciphertext is only readable under the key that produced it', () => {
    const ctA = encryptWith('token-for-a', KEY_A_ENV);
    expect(decryptWith(ctA, KEY_A_ENV)).toBe('token-for-a');
    expect(() => decryptWith(ctA, KEY_B_ENV)).toThrow();
    expect(() => decrypt(ctA)).toThrow(); // default key differs too
  });
});

describe('key handling', () => {
  it('throws EncryptionKeyError naming the env var when it is not set (ticket 387a5760: actionable message, 503)', () => {
    delete process.env[DEFAULT_KEY_ENV];
    let caught: any;
    try { encrypt('x'); } catch (e) { caught = e; }
    expect(caught).toBeInstanceOf(Error);
    expect(caught.name).toBe('EncryptionKeyError');
    expect(caught.statusCode).toBe(503);
    expect(caught.message).toContain(`${DEFAULT_KEY_ENV} is not set on the server`);
    expect(caught.message).toContain('openssl rand -hex 32');
  });

  it('throws when the key is not 32 bytes (64 hex chars)', () => {
    process.env[DEFAULT_KEY_ENV] = 'abcd';
    expect(() => encrypt('x')).toThrow('must be 32 bytes (64 hex chars)');
  });

  it('honors the custom env var name in error messages', () => {
    delete process.env[KEY_A_ENV];
    expect(() => encryptWith('x', KEY_A_ENV)).toThrow(`${KEY_A_ENV} is not set on the server`);
  });
});
