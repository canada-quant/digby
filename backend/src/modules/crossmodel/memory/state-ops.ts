/**
 * Per-item memory updates ("state ops") — 2026-10-20 memory wave.
 *
 * Every structured memory extractor (user profile, project state, thread state, coding project
 * memory, the dreams) used to ask the model to RE-EMIT the whole stored object with the new turn
 * merged in. The answer's size therefore tracked the size of the stored object, not the size of
 * the change: as an object grew its echo outgrew the output budget, the JSON was cut, nothing
 * parsed and nothing was saved — the profile parse_error bursts, the project-state 4000 → 8000
 * scaled-budget treadmill, the coding fold's 3000 → 8000 one (see AGENTS.md 2026-10-20).
 *
 * This module is the alternative: the model is SHOWN the state with a stable id on every list item
 * / map entry and answers with only what changes —
 *
 *   {"set":    {"summary": "new text"},                 text fields, replaced whole (bounded)
 *    "add":    {"recentDecisions": ["new item"]},       list items, prepended (lists are newest-first)
 *    "update": {"D2": "corrected text"},                a list item or map entry, by id
 *    "remove": ["P1", "T3"],                            list items / map entries, by id
 *    "put":    {"confirmedFacts": {"db": "Postgres"}}}  map entries, by key
 *
 * — and {} when nothing changed. The answer is bounded by the CHANGE, so a large stored object no
 * longer means a large (and truncatable) answer. Every write is clamped to the spec's caps; list
 * overflow evicts the oldest items (returned, so a caller can file them elsewhere).
 *
 * A model that answers in the OLD whole-object shape anyway is still honoured (`legacyShape`):
 * text fields become `set`, lists / maps are replaced — then clamped like everything else.
 *
 * Kill switch MEMORY_STATE_OPS_DISABLED=1 (read by the callers): every extractor goes back to the
 * whole-object re-emission. Pure leaf: imports the clamp + parsers only.
 */
import { clampProfileText } from './profile-guard';
import { parseModelJson, salvageTruncatedJson } from './model-json';

export interface TextSpec { cap: number }
export interface ListSpec { cap: number; itemCap: number; idPrefix: string }
export interface MapSpec { cap: number; keyCap: number; valueCap: number; idPrefix: string }

/** The shape of one op-updated state. Paths may be dotted ('entities.people'). */
export interface OpsSpec {
  text?: Record<string, TextSpec>;
  lists?: Record<string, ListSpec>;
  maps?: Record<string, MapSpec>;
}

export interface StateOps {
  set?: Record<string, string>;
  add?: Record<string, string[]>;
  update?: Record<string, string>;
  remove?: string[];
  put?: Record<string, Record<string, string>>;
  /** legacy whole-object answers only: full replacement of a list / map. */
  replaceLists?: Record<string, string[]>;
  replaceMaps?: Record<string, Record<string, string>>;
}

export interface ApplyResult<T> {
  state: T;
  /** true when any content field moved (the E5 honest label). */
  changed: boolean;
  counts: { set: number; added: number; updated: number; removed: number; put: number; evicted: number };
  /** list items pushed past a cap, newest-first order lost — oldest first. */
  evicted: Array<{ path: string; item: string }>;
  /** ids / paths the answer named that do not exist in the shown state (ignored). */
  unknown: string[];
}

export function memoryStateOpsEnabled(): boolean {
  return process.env.MEMORY_STATE_OPS_DISABLED !== '1';
}

// ── paths ───────────────────────────────────────────────────────────────────

function getPath(obj: any, path: string): unknown {
  return path.split('.').reduce((o, k) => (o && typeof o === 'object' ? o[k] : undefined), obj);
}

function setPath(obj: any, path: string, value: unknown): void {
  const keys = path.split('.');
  let o = obj;
  for (const k of keys.slice(0, -1)) {
    if (!o[k] || typeof o[k] !== 'object' || Array.isArray(o[k])) o[k] = {};
    o = o[k];
  }
  o[keys[keys.length - 1]] = value;
}

const strList = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
const strMap = (v: unknown): Record<string, string> => {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return {};
  const out: Record<string, string> = {};
  for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
    if (x == null) continue;
    out[k] = typeof x === 'string' ? x : JSON.stringify(x);
  }
  return out;
};
const clean = (s: string): string => s.replace(/\s+/g, ' ').trim();

// ── render (what the model is shown) ────────────────────────────────────────

/** The id of list item / map entry `index` (0-based) under `prefix`. */
export const opId = (prefix: string, index: number): string => `${prefix}${index + 1}`;

/**
 * The state as the model sees it: text fields as `name: value`, list items and map entries each
 * on their own line behind a stable id. Ids are positional in THIS snapshot — applyStateOps must be
 * given the same snapshot.
 */
export function renderStateForOps(state: unknown, spec: OpsSpec): string {
  const lines: string[] = [];
  for (const [path, t] of Object.entries(spec.text ?? {})) {
    const v = getPath(state, path);
    lines.push(`${path} (at most ${t.cap} characters): ${typeof v === 'string' && v.trim() ? v : '(empty)'}`);
  }
  for (const [path, l] of Object.entries(spec.lists ?? {})) {
    const items = strList(getPath(state, path));
    lines.push(`${path} (list, newest first, at most ${l.cap} items of ${l.itemCap} characters):`);
    if (!items.length) lines.push('  (none)');
    items.forEach((item, i) => lines.push(`  [${opId(l.idPrefix, i)}] ${item}`));
  }
  for (const [path, m] of Object.entries(spec.maps ?? {})) {
    const entries = Object.entries(strMap(getPath(state, path)));
    lines.push(`${path} (key → value, at most ${m.cap} entries):`);
    if (!entries.length) lines.push('  (none)');
    entries.forEach(([k, v], i) => lines.push(`  [${opId(m.idPrefix, i)}] ${k}: ${v}`));
  }
  return lines.join('\n');
}

/** The answer-format paragraph for a prompt — field names come from the spec so they never drift. */
export function opsInstruction(spec: OpsSpec): string {
  const text = Object.keys(spec.text ?? {});
  const lists = Object.keys(spec.lists ?? {});
  const maps = Object.keys(spec.maps ?? {});
  const parts = [
    'Return ONLY the CHANGES as one JSON object — never re-emit what stays the same:',
    ...(text.length ? [`- "set": {"<field>": "<the field's complete new text>"} — replace a text field (${text.join(', ')}). Use "" to clear it.`] : []),
    ...(lists.length ? [`- "add": {"<list>": ["<new item>"]} — new items for a list (${lists.join(', ')}); they go first (newest first).`] : []),
    `- "update": {"<id>": "<corrected text>"} — rewrite one existing item or entry by its [id].`,
    `- "remove": ["<id>"] — drop items or entries that are wrong, superseded or no longer true, by [id].`,
    ...(maps.length ? [`- "put": {"<map>": {"<key>": "<value>"}} — add entries to ${maps.join(', ')}.`] : []),
    'Omit every group you do not need. Return {} when nothing should change. Keep every value within the limit shown for its field.',
  ];
  return parts.join('\n');
}

// ── parse ───────────────────────────────────────────────────────────────────

const OP_KEYS = ['set', 'add', 'update', 'remove', 'put'] as const;

/**
 * The model's answer as ops, or null when nothing parses. A truncated answer keeps its complete
 * op groups (salvageTruncatedJson). A whole-object answer (no op keys, spec fields present) is
 * converted: text → set, lists / maps → replaced; `legacyShape` says so.
 */
export function parseStateOps(raw: unknown, spec: OpsSpec): { ops: StateOps; legacyShape: boolean; salvaged: boolean } | null {
  let salvaged = false;
  let obj: any = parseModelJson(raw);
  if (!obj) {
    obj = salvageTruncatedJson(raw);
    salvaged = !!obj;
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
  const hasOpKey = OP_KEYS.some((k) => k in obj);
  if (hasOpKey) {
    const ops: StateOps = {};
    const set = strMap(obj.set);
    if (Object.keys(set).length) ops.set = set;
    if (obj.add && typeof obj.add === 'object' && !Array.isArray(obj.add)) {
      const add: Record<string, string[]> = {};
      for (const [p, v] of Object.entries(obj.add as Record<string, unknown>)) {
        const items = Array.isArray(v) ? strList(v) : typeof v === 'string' ? [v] : [];
        if (items.length) add[p] = items;
      }
      if (Object.keys(add).length) ops.add = add;
    }
    const update = strMap(obj.update);
    if (Object.keys(update).length) ops.update = update;
    const remove = Array.isArray(obj.remove) ? strList(obj.remove) : typeof obj.remove === 'string' ? [obj.remove] : [];
    if (remove.length) ops.remove = remove;
    if (obj.put && typeof obj.put === 'object' && !Array.isArray(obj.put)) {
      const put: Record<string, Record<string, string>> = {};
      for (const [p, v] of Object.entries(obj.put as Record<string, unknown>)) {
        const m = strMap(v);
        if (Object.keys(m).length) put[p] = m;
      }
      if (Object.keys(put).length) ops.put = put;
    }
    return { ops, legacyShape: false, salvaged };
  }
  // Whole-object answer: honour it field by field (clamped by apply).
  const ops: StateOps = {};
  let any = false;
  for (const path of Object.keys(spec.text ?? {})) {
    const v = getPath(obj, path);
    if (typeof v === 'string') { (ops.set ??= {})[path] = v; any = true; }
  }
  for (const path of Object.keys(spec.lists ?? {})) {
    const v = getPath(obj, path);
    if (Array.isArray(v)) { (ops.replaceLists ??= {})[path] = strList(v); any = true; }
  }
  for (const path of Object.keys(spec.maps ?? {})) {
    const v = getPath(obj, path);
    if (v && typeof v === 'object' && !Array.isArray(v)) { (ops.replaceMaps ??= {})[path] = strMap(v); any = true; }
  }
  if (!any) return Object.keys(obj).length === 0 ? { ops: {}, legacyShape: false, salvaged } : null;
  return { ops, legacyShape: true, salvaged };
}

// ── apply ───────────────────────────────────────────────────────────────────

/**
 * Apply `ops` to `state` (the SAME snapshot renderStateForOps was given) and clamp every field the
 * spec names. Order: update → remove → add (prepended) → cap (oldest evicted). Unknown ids and
 * paths are ignored and reported. Never throws; `state` is not mutated.
 */
export function applyStateOps<T>(state: T, ops: StateOps, spec: OpsSpec): ApplyResult<T> {
  const next: any = JSON.parse(JSON.stringify(state ?? {}));
  const counts = { set: 0, added: 0, updated: 0, removed: 0, put: 0, evicted: 0 };
  const evicted: Array<{ path: string; item: string }> = [];
  const unknown: string[] = [];

  // id → location in the ORIGINAL snapshot
  const listItems = new Map<string, { path: string; index: number }>();
  const mapEntries = new Map<string, { path: string; key: string }>();
  for (const [path, l] of Object.entries(spec.lists ?? {})) {
    strList(getPath(state, path)).forEach((_, i) => listItems.set(opId(l.idPrefix, i).toLowerCase(), { path, index: i }));
  }
  for (const [path, m] of Object.entries(spec.maps ?? {})) {
    Object.keys(strMap(getPath(state, path))).forEach((k, i) => mapEntries.set(opId(m.idPrefix, i).toLowerCase(), { path, key: k }));
  }
  const lists: Record<string, Array<string | null>> = {};
  for (const path of Object.keys(spec.lists ?? {})) lists[path] = strList(getPath(state, path));
  const maps: Record<string, Record<string, string>> = {};
  for (const path of Object.keys(spec.maps ?? {})) maps[path] = strMap(getPath(state, path));

  const idOf = (raw: string) => raw.trim().replace(/^\[|\]$/g, '').toLowerCase();

  // set — text fields
  for (const [path, value] of Object.entries(ops.set ?? {})) {
    const t = spec.text?.[path];
    if (!t) { unknown.push(path); continue; }
    setPath(next, path, clampProfileText(value.trim(), t.cap));
    counts.set++;
  }
  // update — by id
  for (const [rawId, value] of Object.entries(ops.update ?? {})) {
    const id = idOf(rawId);
    const li = listItems.get(id);
    if (li) {
      const v = clean(value);
      if (v) { lists[li.path][li.index] = v; counts.updated++; }
      else { lists[li.path][li.index] = null; counts.removed++; }
      continue;
    }
    const me = mapEntries.get(id);
    if (me) { maps[me.path][me.key] = clean(value); counts.updated++; continue; }
    unknown.push(rawId);
  }
  // remove — by id
  for (const rawId of ops.remove ?? []) {
    const id = idOf(rawId);
    const li = listItems.get(id);
    if (li) { if (lists[li.path][li.index] !== null) { lists[li.path][li.index] = null; counts.removed++; } continue; }
    const me = mapEntries.get(id);
    if (me) { if (me.key in maps[me.path]) { delete maps[me.path][me.key]; counts.removed++; } continue; }
    unknown.push(rawId);
  }
  // legacy whole-object replacements
  for (const [path, items] of Object.entries(ops.replaceLists ?? {})) {
    if (!(path in lists)) { unknown.push(path); continue; }
    lists[path] = items;
    counts.set++;
  }
  for (const [path, m] of Object.entries(ops.replaceMaps ?? {})) {
    if (!(path in maps)) { unknown.push(path); continue; }
    maps[path] = m;
    counts.set++;
  }
  // add — prepended, deduped case-insensitively against what is kept
  for (const [path, items] of Object.entries(ops.add ?? {})) {
    if (!(path in lists)) { unknown.push(path); continue; }
    const kept = lists[path].filter((x): x is string => x !== null);
    const seen = new Set(kept.map((x) => x.toLowerCase()));
    const fresh: string[] = [];
    for (const raw of items) {
      const v = clean(raw);
      if (!v || seen.has(v.toLowerCase())) continue;
      seen.add(v.toLowerCase());
      fresh.push(v);
    }
    lists[path] = [...fresh, ...kept];
    counts.added += fresh.length;
  }
  // put — map entries
  for (const [path, entries] of Object.entries(ops.put ?? {})) {
    if (!(path in maps)) { unknown.push(path); continue; }
    for (const [k, v] of Object.entries(entries)) {
      const key = clean(k);
      if (!key) continue;
      maps[path][key] = clean(v);
      counts.put++;
    }
  }

  // clamp + cap, then write back
  for (const [path, l] of Object.entries(spec.lists ?? {})) {
    const items = lists[path].filter((x): x is string => typeof x === 'string' && !!x).map((x) => clampProfileText(x, l.itemCap));
    const keep = items.slice(0, l.cap);
    for (const item of items.slice(l.cap).reverse()) { evicted.push({ path, item }); counts.evicted++; }
    setPath(next, path, keep);
  }
  for (const [path, m] of Object.entries(spec.maps ?? {})) {
    const entries = Object.entries(maps[path])
      .filter(([k, v]) => k && v)
      .map(([k, v]) => [clampProfileText(k, m.keyCap), clampProfileText(v, m.valueCap)] as [string, string]);
    // newest entries were put last — keep the last `cap`
    const keep = entries.slice(Math.max(0, entries.length - m.cap));
    counts.evicted += entries.length - keep.length;
    setPath(next, path, Object.fromEntries(keep));
  }
  for (const [path, t] of Object.entries(spec.text ?? {})) {
    const v = getPath(next, path);
    setPath(next, path, clampProfileText(typeof v === 'string' ? v : '', t.cap));
  }

  const contentPaths = [...Object.keys(spec.text ?? {}), ...Object.keys(spec.lists ?? {}), ...Object.keys(spec.maps ?? {})];
  const changed = contentPaths.some((p) => JSON.stringify(getPath(state, p) ?? null) !== JSON.stringify(getPath(next, p) ?? null));
  return { state: next as T, changed, counts, evicted, unknown };
}

/** The upper bound, in characters, of an answer that sets / adds everything the spec allows. */
export function maxOpsAnswerChars(spec: OpsSpec): number {
  const text = Object.values(spec.text ?? {}).reduce((n, t) => n + t.cap, 0);
  const lists = Object.values(spec.lists ?? {}).reduce((n, l) => n + l.cap * l.itemCap, 0);
  const maps = Object.values(spec.maps ?? {}).reduce((n, m) => n + m.cap * (m.keyCap + m.valueCap), 0);
  return text + lists + maps;
}

/** One short line for an outcome row's `detail`: what the answer did ("ops set=1 add=2 upd=0 rm=1 …"). */
export function describeOps(parsed: { legacyShape: boolean; salvaged: boolean }, applied: Pick<ApplyResult<unknown>, 'counts' | 'unknown'>): string {
  const c = applied.counts;
  return `ops${parsed.legacyShape ? ' legacy-shape' : ''} set=${c.set} add=${c.added} upd=${c.updated} rm=${c.removed}`
    + `${c.put ? ` put=${c.put}` : ''}${c.evicted ? ` evicted=${c.evicted}` : ''}`
    + `${applied.unknown.length ? ` unknown=${applied.unknown.length}` : ''}${parsed.salvaged ? ' salvaged' : ''}`;
}
