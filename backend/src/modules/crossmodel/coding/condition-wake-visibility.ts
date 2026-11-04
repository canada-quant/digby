/**
 * Ticket e44e1219 — condition-wake OBSERVABILITY (the wake was always real).
 *
 * Root cause (verified in prod 2026-10-24): await_condition registers a
 * CONDITION WAKE as a store row (namespace 'await-condition', key
 * <chatId>:<kind>:<slug>@<sha>) plus a delayed backstop hook event — NOT a
 * coding_schedules row and NOT a hook_subscription. A supervisor verifying a
 * lane's "condition wake registered (backstop HH:MMZ)" claim with
 * get_chat_status therefore saw schedules.enabled=0 and concluded no wake
 * existed, arming redundant one-shots. The mechanism was fine; the probe was
 * blind.
 *
 * Fix: list the chat's open condition-wake records in get_chat_status under
 * `conditionWakes` (the supervisor's existing one-call probe), and mint an
 * await_condition receipt so "wake registered" is a receipted fact. This
 * module holds the shared, side-effect-free shape so platform.service.ts
 * (status read) and run-receipts.ts (receipt parser) never import each other.
 */
import { storeListNamespace } from '../memory/context-store';
import type { ConditionWakeRecord } from './await-condition';

/** Open-wake view of a ConditionWakeRecord for status payloads. */
export interface ConditionWakeStatusView {
	/** Wake kind (from the record's spec). */
	condition: 'ci' | 'pr_merged' | 'deploy';
	/** "owner/name" of the repo the condition watches. */
	repo: string;
	sha?: string | null;
	pullNumber?: number | null;
	/** When the backstop fires if the condition is never met. */
	horizonAt: string | null;
	createdAt: string | null;
	updatedAt: string | null;
	/** Cron probe count so far (best-effort). */
	checks?: number;
	/** Best-effort one-line description ("deploy of owner/repo@abc123def456 concluded"). */
	summary?: string | null;
}

/**
 * The chat's OPEN condition wakes (rows the cron still watches), newest first,
 * bounded. Never throws — the status read degrades to [] (a visibility
 * failure must never break get_chat_status). Rows whose horizonAt has passed
 * are EXCLUDED: the backstop has fired (or is about to), so the wake is no
 * longer "registered + armed" — showing it would resurrect exactly the stale
 * state this fix exists to kill.
 */
export async function listOpenConditionWakesForChat(
	chatId: string,
	opts: { limit?: number } = {},
): Promise<ConditionWakeStatusView[]> {
	const limit = Math.max(1, Math.min(Math.round(Number(opts.limit ?? 20)) || 20, 50));
	try {
		const rows = await storeListNamespace<ConditionWakeRecord>(['await-condition'], { limit: 1000 });
		const now = Date.now();
		const out: ConditionWakeStatusView[] = [];
		for (const r of rows) {
			if (!r.key.startsWith(`${chatId}:`)) continue;
			const v = r.value as unknown as Record<string, unknown>;
			const spec = (v && typeof v === 'object' && v.spec && typeof v.spec === 'object' ? v.spec : null) as Record<string, unknown> | null;
			const kind = spec ? String(spec.kind ?? '') : '';
			const horizon = typeof v.horizonAt === 'string' ? new Date(v.horizonAt).getTime() : NaN;
			if (Number.isFinite(horizon) && horizon < now) continue; // past horizon: the backstop owns the tail
			out.push({
				condition: kind === 'ci' || kind === 'pr_merged' || kind === 'deploy' ? kind : 'deploy',
				repo: spec ? `${String(spec.owner ?? '')}/${String(spec.repo ?? '')}` : '',
				sha: spec ? (typeof spec.sha === 'string' && spec.sha ? spec.sha : null) : null,
				pullNumber: spec ? (typeof spec.pullNumber === 'number' ? spec.pullNumber : null) : null,
				horizonAt: typeof v.horizonAt === 'string' ? v.horizonAt : null,
				createdAt: r.createdAt ? r.createdAt.toISOString() : null,
				updatedAt: r.updatedAt ? r.updatedAt.toISOString() : null,
				checks: typeof v.checks === 'number' ? v.checks : undefined,
				summary: describeWakeForView(kind, spec),
			});
			if (out.length >= limit) break;
		}
		out.sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''));
		return out.slice(0, limit);
	} catch {
		return [];
	}
}

/** Best-effort description for a view row (never throws, may be null). */
function describeWakeForView(kind: string, spec: Record<string, unknown> | null): string | null {
	if (!spec) return null;
	const slug = `${String(spec.owner ?? '')}/${String(spec.repo ?? '')}`;
	if (kind === 'pr_merged') return `PR ${slug}#${String(spec.pullNumber ?? '?')} merged or closed`;
	if (kind === 'deploy') return `deploy of ${slug}@${String(spec.sha ?? '').slice(0, 12)} concluded`;
	if (kind === 'ci') return `CI on ${slug}@${String(spec.sha ?? '').slice(0, 12)} finished`;
	return null;
}

/**
 * Ticket e44e1219 receipt support: does this await_condition tool result
 * REGISTER a wake (the not-met + end-turn notice shapes — both carry the
 * registration line)? A met-in-tool answer mints no wake row, so it is not a
 * registration receipt. Pure; exported for the run-receipts parser test.
 */
export const CONDITION_WAKE_REGISTERED_LINE_RE = /Registered a CONDITION WAKE:|registered a CONDITION WAKE for:/;
