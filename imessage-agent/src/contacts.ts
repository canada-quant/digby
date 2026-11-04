/**
 * Resolve iMessage handles (phone numbers / emails) to the names saved in the
 * macOS Contacts app.
 *
 * chat.db only stores handles — Messages.app shows names by joining them against
 * Contacts at display time. We do the same: read the AddressBook SQLite store(s)
 * (read-only) and build a handle → name map. Uses the same Full Disk Access the
 * agent already has; if Contacts can't be read, every lookup just returns null
 * and callers fall back to the raw handle (no regression).
 */

import Database from 'better-sqlite3';
import { homedir } from 'os';
import { join } from 'path';
import { existsSync, readdirSync } from 'fs';

const AB_ROOT = join(homedir(), 'Library', 'Application Support', 'AddressBook');
const TTL_MS = 10 * 60 * 1000; // contacts change rarely — cache for 10 min

/** All AddressBook-v22.abcddb files (top-level + each iCloud/local "Source"). */
function abcddbPaths(): string[] {
  const paths: string[] = [];
  const top = join(AB_ROOT, 'AddressBook-v22.abcddb');
  if (existsSync(top)) paths.push(top);
  try {
    const sources = join(AB_ROOT, 'Sources');
    for (const dir of readdirSync(sources)) {
      const p = join(sources, dir, 'AddressBook-v22.abcddb');
      if (existsSync(p)) paths.push(p);
    }
  } catch {
    /* no Sources dir — fine */
  }
  return paths;
}

/** Loose phone match: digits only, last 10 (so +1 5551234567 == (555) 123-4567). */
function normPhone(s: string): string | null {
  const digits = (s || '').replace(/\D/g, '');
  return digits.length >= 7 ? digits.slice(-10) : null;
}

function normEmail(s: string): string | null {
  const e = (s || '').trim().toLowerCase();
  return e.includes('@') ? e : null;
}

let cache: { map: Map<string, string>; at: number } | null = null;

function recordName(r: any): string {
  const full = [r.ZFIRSTNAME, r.ZLASTNAME].filter(Boolean).join(' ').trim();
  return full || r.ZORGANIZATION || r.ZNICKNAME || '';
}

function buildMap(): Map<string, string> {
  const map = new Map<string, string>();
  for (const path of abcddbPaths()) {
    let db: Database.Database | null = null;
    try {
      db = new Database(path, { readonly: true, fileMustExist: true });
      const phones = db
        .prepare(
          `SELECT r.ZFIRSTNAME, r.ZLASTNAME, r.ZORGANIZATION, r.ZNICKNAME, p.ZFULLNUMBER AS num
             FROM ZABCDPHONENUMBER p
             JOIN ZABCDRECORD r ON r.Z_PK = p.ZOWNER
            WHERE p.ZFULLNUMBER IS NOT NULL`,
        )
        .all() as any[];
      for (const row of phones) {
        const key = normPhone(row.num);
        const name = recordName(row);
        if (key && name && !map.has(key)) map.set(key, name);
      }
      const emails = db
        .prepare(
          `SELECT r.ZFIRSTNAME, r.ZLASTNAME, r.ZORGANIZATION, r.ZNICKNAME, e.ZADDRESS AS addr
             FROM ZABCDEMAILADDRESS e
             JOIN ZABCDRECORD r ON r.Z_PK = e.ZOWNER
            WHERE e.ZADDRESS IS NOT NULL`,
        )
        .all() as any[];
      for (const row of emails) {
        const key = normEmail(row.addr);
        const name = recordName(row);
        if (key && name && !map.has(key)) map.set(key, name);
      }
    } catch {
      /* unreadable source (locked / schema variance / permission) — skip it */
    } finally {
      try {
        db?.close();
      } catch {
        /* ignore */
      }
    }
  }
  return map;
}

function getMap(): Map<string, string> {
  const now = Date.now();
  if (cache && now - cache.at < TTL_MS) return cache.map;
  let map: Map<string, string>;
  try {
    map = buildMap();
  } catch {
    map = new Map();
  }
  cache = { map, at: now };
  return map;
}

/** Saved contact name for a phone/email handle, or null if none. */
export function resolveContactName(handle: string | null | undefined): string | null {
  if (!handle) return null;
  const map = getMap();
  if (map.size === 0) return null;
  const phone = normPhone(handle);
  if (phone && map.has(phone)) return map.get(phone)!;
  const email = normEmail(handle);
  if (email && map.has(email)) return map.get(email)!;
  return null;
}
