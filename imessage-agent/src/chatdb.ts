/**
 * Read-only access to the macOS Messages database (~/Library/Messages/chat.db).
 *
 * Requires Full Disk Access for the process running this agent. We open the DB
 * read-only and never write to it.
 *
 * Gotcha: on modern macOS the `message.text` column is often NULL and the real
 * text lives in `attributedBody` — a serialized NSAttributedString (typedstream).
 * decodeAttributedBody() is a best-effort decoder that handles the common case.
 */

import Database from 'better-sqlite3';
import { homedir } from 'os';
import { join } from 'path';
import { resolveContactName } from './contacts';

const DB_PATH = join(homedir(), 'Library', 'Messages', 'chat.db');
const APPLE_EPOCH_MS = 978_307_200_000; // 2001-01-01 in unix ms

export interface ChatSummary {
  chatId: number;
  guid: string;
  identifier: string;
  displayName: string | null;
  lastMessage: string | null;
  lastDate: string | null;
}

export interface MessageRow {
  id: number;
  text: string;
  fromMe: boolean;
  handle: string | null;
  date: string | null;
}

function openDb(): Database.Database {
  // readonly + fileMustExist; throws a clear error if Full Disk Access is missing.
  return new Database(DB_PATH, { readonly: true, fileMustExist: true });
}

function appleDateToISO(value: number | bigint | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const n = typeof value === 'bigint' ? Number(value) : value;
  if (!n) return null;
  // Newer macOS: nanoseconds since 2001. Older: seconds since 2001.
  const ms = n > 1e12 ? n / 1e6 + APPLE_EPOCH_MS : n * 1000 + APPLE_EPOCH_MS;
  const d = new Date(ms);
  return isNaN(d.getTime()) ? null : d.toISOString();
}

/** Best-effort decode of an NSAttributedString typedstream blob to its plain text. */
export function decodeAttributedBody(body: Buffer | null | undefined): string {
  if (!body || body.length === 0) return '';
  try {
    const marker = Buffer.from('NSString');
    const idx = body.indexOf(marker);
    if (idx === -1) return '';
    // Skip "NSString" plus the 5 framing bytes that precede the string payload.
    let p = idx + marker.length + 5;
    if (p >= body.length) return '';
    let length: number;
    if (body[p] === 0x81) {
      // 2-byte little-endian length prefix
      length = body.readUInt16LE(p + 1);
      p += 3;
    } else {
      length = body[p];
      p += 1;
    }
    if (length <= 0) return '';
    if (p + length > body.length) length = body.length - p;
    return body.slice(p, p + length).toString('utf8');
  } catch {
    return '';
  }
}

function messageText(row: { text: string | null; attributedBody: Buffer | null }): string {
  if (row.text && row.text.length > 0) return row.text;
  return decodeAttributedBody(row.attributedBody);
}

/** Most recent conversations, newest first. */
export function listChats(limit = 20): ChatSummary[] {
  const db = openDb();
  try {
    const chats = db
      .prepare(
        `SELECT c.ROWID            AS chatId,
                c.guid             AS guid,
                c.chat_identifier  AS identifier,
                c.display_name     AS displayName,
                MAX(m.date)        AS lastDate
         FROM chat c
         JOIN chat_message_join cmj ON cmj.chat_id = c.ROWID
         JOIN message m             ON m.ROWID = cmj.message_id
         GROUP BY c.ROWID
         ORDER BY lastDate DESC
         LIMIT ?`,
      )
      .all(limit) as Array<{
      chatId: number;
      guid: string;
      identifier: string;
      displayName: string | null;
      lastDate: number | null;
    }>;

    const lastMsgStmt = db.prepare(
      `SELECT m.text AS text, m.attributedBody AS attributedBody
       FROM message m
       JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
       WHERE cmj.chat_id = ?
       ORDER BY m.date DESC
       LIMIT 1`,
    );

    return chats.map((c) => {
      const last = lastMsgStmt.get(c.chatId) as
        | { text: string | null; attributedBody: Buffer | null }
        | undefined;
      const lastMessage = last ? messageText(last) : '';
      // chat.display_name is only set for named GROUP chats; for 1:1 chats it's
      // NULL and `identifier` is just a phone/email. Fall back to the saved
      // Contacts name so the user sees "Mom", not "+15551234567".
      const displayName = c.displayName || resolveContactName(c.identifier) || null;
      return {
        chatId: c.chatId,
        guid: c.guid,
        identifier: c.identifier,
        displayName,
        lastMessage: lastMessage || null,
        lastDate: appleDateToISO(c.lastDate),
      };
    });
  } finally {
    db.close();
  }
}

/** Resolve a chat reference (numeric ROWID or handle identifier) to a chat ROWID. */
function resolveChatId(db: Database.Database, chat: string): number | null {
  if (/^\d+$/.test(chat)) return Number(chat);
  const row = db
    .prepare(`SELECT ROWID AS chatId FROM chat WHERE chat_identifier = ? ORDER BY ROWID DESC LIMIT 1`)
    .get(chat) as { chatId: number } | undefined;
  return row ? row.chatId : null;
}

/** Recent messages in a conversation, newest first. */
export function getMessages(chat: string, limit = 25): MessageRow[] {
  const db = openDb();
  try {
    const chatId = resolveChatId(db, chat);
    if (chatId === null) return [];
    const rows = db
      .prepare(
        `SELECT m.ROWID          AS id,
                m.text           AS text,
                m.attributedBody AS attributedBody,
                m.is_from_me     AS isFromMe,
                m.date           AS date,
                h.id             AS handle
         FROM message m
         JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
         LEFT JOIN handle h         ON h.ROWID = m.handle_id
         WHERE cmj.chat_id = ?
         ORDER BY m.date DESC
         LIMIT ?`,
      )
      .all(chatId, limit) as Array<{
      id: number;
      text: string | null;
      attributedBody: Buffer | null;
      isFromMe: number;
      date: number | null;
      handle: string | null;
    }>;

    return rows.map((r) => ({
      id: r.id,
      text: messageText(r),
      fromMe: !!r.isFromMe,
      handle: r.handle || null,
      date: appleDateToISO(r.date),
    }));
  } finally {
    db.close();
  }
}

/**
 * Throws if chat.db cannot be opened (e.g. Full Disk Access not granted).
 * The error text is user-facing (the agent's poll advert + the backend's
 * dispatch failures surface it verbatim in the card), so a permission denial
 * reads as an instruction, not a raw sqlite error.
 */
export function checkAccess(): { ok: boolean; error?: string } {
  try {
    const db = openDb();
    db.prepare('SELECT 1 FROM message LIMIT 1').get();
    db.close();
    return { ok: true };
  } catch (e: any) {
    const raw = e?.message || String(e);
    const denied = /unable to open database file|SQLITE_CANTOPEN|permission denied|operation not permitted/i.test(raw);
    return {
      ok: false,
      error: denied
        ? 'Full Disk Access is not granted to this helper yet — Digby cannot read your Messages. Grant it in System Settings → Privacy & Security → Full Disk Access (the Digby integrations card shows the exact steps and updates live).'
        : raw,
    };
  }
}
