# Patience levels → always Auto, Jev-gated: deprecation, back-test and verification plan (2026-09-25)

## Executive summary

1. Owner directive (Paul, 2026-09-25): users no longer pick a patience level; every human send is Auto, the level is chosen by decision-gate purpose `auto_route` (seat #19), everything is back-tested and verified before and during rollout, and the hosted Jev is later swappable for an open-weights decision model as a seat change.
2. The three internal tiers (`single_thinking` / `thinking` / `deep_research`) and their budgets stay; they stop being a user choice. Routing is one flag-gated override at the two user seams (`crossmodel.controller.ts:1151-1178`, `platform.service.ts:814-846`) plus a picker-less frontend — no re-plumb of the seven intakes.
3. Two production facts change the mechanics from the first draft: (a) with ALB → nginx → Express and `trust proxy 1` (`backend/src/app.ts:52`, `infrastructure.yml:70`) `req.ip` is the ALB node, so the guest quota key must be proven per-client by a Phase 0 probe before guests can ever be routed to Deep Research; (b) docker-compose forwards only listed vars (`docker-compose.app.yml:30-31`) and env-overrides fold into `.env` only on the next deploy (`deploy.yml:261`), so every kill switch is a deploy, and the two switches that must be instant (`patience_auto_only`, `auto_route_act_percent`) live in `SystemSetting` behind the existing 60 s-cached admin PUT.
4. Quota safety: Auto never errors a user on quota — a non-reserving allowance check runs before the pick and any L3 that cannot reserve demotes to Ensemble with a code-selected `reasonKey`; under the flag the allowance fails CLOSED on Redis error; machine origins get the floor on the RESOLVED level (per-message or stored) and the busy-queue drain RESERVES before running a queued council.
5. Exemptions pinned by tests: Digby Kids never reach the router (hoisted `isChild`), supervisor chats keep their stored `thinking` (a council pick would out-rank `supervisorProfile()` at `chat-agent.service.ts:2276`), Telegram gains an `isChild` guard now and Auto later, coding satellite and `browser_agent` untouched.
6. Back-test = three in-place evidence streams (live shadow rows, a label window that records the user's PICKED level via a new `modeSource` signal, and a `prodq.sh` replay from `/app/dist`) reported as aggregates only; the label window is new third-party egress for non-Auto users and is gated on owner Q1 exactly like the replay (DeepSeek readout spec until answered).
7. Acceptance is pre-registered as confidence bounds on a held-out window, clustered by user: paired gate-vs-heuristic agreement lower bound > −2 pp on ≥3,000 paired picked rows (or −5 pp with the reason stated), L3 recall Wilson LB ≥ 0.70 on ≥300 picked-L3 rows, over-escalation Wilson UB ≤ 5% on ≥300 picked-L1 rows, top-label ECE ≤ 0.10, coverage ≥ 60%, decision p95 ≤ 1,200 ms, telemetry coverage ≥ 95%. Heuristic agreement is a diagnostic, never a gate.
8. Rollout: Phase 0 observe (probes, volumes, hop count) → 1a backend hardening + label window (flag off, pickers live) → 1b always-Auto + picker removal gated on a pre-flip heuristic-cost check (heuristic L3 share ≤ 8% on turns users ran at L1/L2) → 2 back-test readouts fit/test split → 3 act canary with a concurrent control cohort and a stop rule → 4 cleanup and re-shadow items → 5 open-weights seat swap.
9. The acting backend is pinned by `spec` (`DECISION_GATE_ACT_BACKEND_AUTO_ROUTE`); any seat change makes `routeMessageAuto` behave as shadow by construction, so the JevK5 swap is: register endpoint → fallback 3 days → seat model ≥ 7 days shadow → replay → §4.6 table passes → update pin and re-fit thresholds (a new per-option L3 threshold env is added because one env cannot express the refit today, `decision-gate.ts:163-167`).
10. Open questions that change the work: replay/label-window egress consent, whether agents keep any level override, scheduled-council default, the structured "Dig deeper" escalation, guest Deep Research, flip authority, and an L2 checker cap.

### Status (2026-09-26 23:00Z)

- **Audit 2026-09-26 (late, branch `audit/unify-routing`) — the platform-seam allowance / reserve (§7.1 item 7) SHIPPED and the seams unified:** ONE resolver (`platform/send-mode.ts resolveSendMode`) serves the web stream, REST `POST /platform/chats/:id/messages` / `send_chat_message` and Telegram — the switch, the §3.4 allowance (now on EVERY auto send, not only under the switch), the supervisor clamp and the machine floor live there; the REST seam reserves the council quota for a human Level 3 and demotes on refusal; the label window arms for a `picked` level even under the switch (option A). "Auto never errors a user on quota" now holds on every seam. Kill switches in `.env.example` ("THE send-mode resolver").

- **Phase 0 readout — DONE 2026-09-25 19:35Z**, written where §6 asks: `memory-bank/crossmodel-activeContext.md`, entry "2026-09-25 (20:30Z) — program merge LIVE-VERIFIED on 52473fdf; Jev answering; patience plan Phase 0 readout". Headline: 37.6 human sends/day (14 d), 14.4/day outside supervisor chats; L1 20.2% / L2 78.3% / L3 1.5% (7 d: 0.7%); signed-in users per class 4/4/2; owner = 88% of L2 / 75% of L3; L2 p50 $0.18 / 359 s, L1 $0.085 / 200 s, L3 $0.18 / 1,473 s; user-run L3 share 1.5% (≤ 8% bar) but the replayed-heuristic share is not yet computed; the §4.3 label-window minima need 68–790 days at current volume — beyond the 28-day retention edge, so 1b can only proceed through the §4.5 replay substitute. Backend answering: TypeSafe Jev since 2026-09-25 ~17:00Z (DG0925D). `auto_route` had 0 rows all-time at that readout.
- **STATE 2026-09-26 (audit "patience_auto_only prod state vs documented contract"):** the prod row `patience_auto_only=1` since 2026-09-26 20:35:16Z (flipped via the bare admin PUT during the compute-policy step-2 rollout; actor unrecorded — the audit trail below did not exist yet). Under the switch an Account → Advanced preset (`modeSource:'default'`) is routed as Auto with the preset kept as `routing.requestedMode` only, and guests are routed (kept off Level 3) instead of the client's forced Ensemble — the Advanced tab now reads `GET /depth/policy` and disables its radios with a notice. The PUT is validated / idempotent / audited (`patience_auto_only_by`), Account → Admin → Settings → Depth policy is the toggle, `GET /admin/settings/patience-auto-only` reads since / updatedBy. Canonical: the AGENTS.md "Always-Auto switch — prod state vs contract" bullet.
- **Phase 1a — BACKEND LANDED 2026-09-25 (N-wave, branch -1), switch OFF at landing (ON in prod since 2026-09-26 20:35Z — see STATE above):** SystemSetting `patience_auto_only` (cached reader, admin `PUT /admin/settings/patience_auto_only`, env boot default `PATIENCE_AUTO_ONLY=0`) with the SSE-seam override / non-reserving deep-research allowance / L3→Ensemble demotion wired BEHIND it; the explicit-level label window (`shadowAutoRouteAgainst`, fires ONLY for `modeSource==='picked'` — no web/mobile client sends `modeSource` yet ⇒ zero egress; `LABEL_WINDOW_SAMPLE_PERCENT`, `LABEL_WINDOW_DECISION_SPEC=deepseek-flash` until Q1, `DECISION_GATE_AUTO_ROUTE_LABEL_WINDOW_DISABLED`); `run_spend` / `run_tokens` / `chat_search_usage` stamps carry `mode` + `routingSource`; loop_metrics `deep_research_quota_rejected`; `quotaClientIp(req)` (`QUOTA_TRUSTED_PROXY_HOPS`); kids hoisted above routing; Telegram `isChild` guard; per-option `DECISION_GATE_THRESHOLD_AUTO_ROUTE_DEEP_RESEARCH`. **NOT done from §7.1:** the acting-backend pin by `spec` (item 3), the platform-seam allowance/reserve (7), the schedule/orphan clamp (8), the drain reserve + `routing Json?` migration (9–10), Zod defaults `'auto'` (6), the compose shell pin (1, partial), AR0926/XFF0926 (15), the replay script (16), the E2E driver (17), the client `modeSource` send (19), and everything in 1b (no picker removal, no switch flip). The N4 checker-site router shipped as its OWN purpose `checker_route`, not under `auto_route`.
- **`auto_route` mode = act since 2026-09-26 02:05Z** (owner override, store row; see `DECISION_MODEL_ENHANCEMENTS_2026-09-25.md` §6.1). This does NOT start Phase 3: it governs only sends that already carry `mode='auto'`; the §4.6 acceptance bars have not been measured and the act canary / control cohort of §6 Phase 3 has not been run.
- **Phase 1a — CLIENT `modeSource` SHIPPED 2026-09-26 (§7.1 item 19, web only; branch `patience/label-window-client`) ⇒ the label window is LIVE against the SEAT backend, sample 100%.** Every plain-chat send from the web client now carries `modeSource`: `'picked'` once `setPatienceLevel` ran for a real user pick in this browser tab (sticky through new chats, chat switches whose stored mode equals the pick, and in-tab navigation — `frontend/app/crossmodel/mode-source.ts`, per-tab `sessionStorage` key `cm_mode_origin`; a refused Level 3 click at quota is no pick), `'restored'` when opening a chat replaced the level with its stored mode (`nextOriginAfterRestore`; a no-op restore keeps a genuine pick), else `'default'` (the stored preference, or a guest's forced Ensemble); nothing under Auto and nothing for kids. It rides the GET query, the >1500-char register body and the register-failure fallback (`plain-session.ts buildPlainStreamUrl`), forwarded by `CodeSessionView` on both the live send and the busy-queue passthrough. Owner Q1 was answered on 2026-09-26 (the owner asked for the back-test over all user chats), so `LABEL_WINDOW_DEFAULT_SPEC` moved `'deepseek-flash'` → `'seat'` (the decision seat chain — TypeSafe Jev in prod); `LABEL_WINDOW_DECISION_SPEC` still pins another backend, `LABEL_WINDOW_SAMPLE_PERCENT` unset = 100, `DECISION_GATE_AUTO_ROUTE_LABEL_WINDOW_DISABLED=1` still kills it. Mobile (`packages/api/src/streaming.ts`, `apps/mobile`) still sends no `modeSource` (item 26 open) ⇒ its explicit sends stay `user_explicit`. Expected in prod: `loop_metrics` kind `decision_gate`, phase `outcome`, purpose `auto_route`, `meta.note='user_picked'` + `meta.labelWindow=true` + `meta.modeSource='picked'` + `meta.actual`=the picked level + `meta.heuristic`=the regex's pick, on picked-level signed-in adult non-supervisor sends; `user_default` on the run's `routingSource` stamps (`chat_search_usage` / `run_spend`) for default/restored sends with NO gate call. The §3.9 stored-mode restore + `createChat`/`updateChat` mode writes are still in place (1b prerequisites) — the signal now labels a restore honestly (`restored` → `user_default`) instead of counting it as a pick, which was the contamination §3.9 feared.
- **Design review 2026-09-26 (owner: "isn't there a better, more SOTA approach for non-technical users?"):** `docs/DEPTH_UX_SOTA_2026-09-26.md` — an 11-agent pass (pipeline map, 14-d telemetry, literature, product sweep, three designs, three judges) recommends replacing the level picker AND the Auto-LEVEL router with an OUTCOME-DRIVEN COMPUTE POLICY: answer-first on every send (the checker runs behind the answer, not in front), a calibrated gate deciding when to add compute (verify / search / council) at moments where evidence exists, one "Dig deeper" control, presets L1/L2/L3 kept as fail-open tuples. This plan's switch, label window and `auto_route` purpose are reused by its steps 2–3; the picker moves to Account → Advanced instead of being removed. Five owner decisions are listed in its §8; nothing of it is built yet.
- **§4.5 replay probe LANDED 2026-09-26 (item 16 of §7.1):** `scripts/framework-audit/backtest-auto-route.js` (+ `backtest-auto-route.test.sh`, `backend/src/scripts/backtest-auto-route-metrics.test.ts`; one-shot `AR0926-REPLAY` text in `scripts/framework-audit/README.md`) — batched `prodq.sh` replay with stubbed telemetry, cursor file, `--merge`, `--dry-run`, the full §4.6 verdict table (n/a with the reason where historical rows cannot support a metric). ~~NOT yet run in production~~ — **SUPERSEDED: it RAN on 2026-09-26 15:50–15:53Z (the AR0926 entry right below; 418 turns, spec jev).**
- **AR0926 replay RUN 2026-09-26 15:50–15:53Z (box A, unit ar-20260926-1550, spec jev, 30 d, report `/var/tmp/ar-backtest/report-ar-20260926-1550.json`):** corpus 418 human agent turns (11,605 rows scanned; 9,347 assistant rows were not engine=agent, 1,670 not followed by an assistant row, 163 machine-origin) from 5 distinct users; U = stored chat level (409/410 restore-contaminated, 1 real pick): L1 221 / L2 181 / L3 8. Jev: 418/418 ok, p50 140 ms, p95 192 ms, 0 over 1.5 s. Coverage at τ 46.9% (bar ≥ 60%). Gate@τ agreement with U 51.5% vs heuristic 48.3% (+3.2 pp; Wald 95% [−2.1, +8.5]; user-clustered bootstrap [−14.2, +8.9]). Level mix gate 45/53/1.9 vs heuristic 18/80/2.2 vs U 54/44/2; over-escalation 1/221 (Wilson upper 2.5% ✓); L3 promotion ratio 0.89 ✓; ECE vs U 0.163, top bucket (conf ≥ 0.89, n=67) agrees 54% — Jev is over-confident against the STORED-level label; projected $/turn −5.9% (join 28.5%); former-L1 cohort p50 104 s → 234 s projected (ratio 2.25, bar ≤ 1.5 — half of the U=L1 turns route to L2). EVERY §4.6 row is n/a on sample size (bars need 2,000 rows / 300 per class / 20 users per class; this product's human traffic is ~14 turns/day from 5 accounts), so the replay cannot certify the flip either way; it does show no error/latency risk and no L3 inflation. Decision: stay in shadow (label window live from wave 419f9c5a with modeSource + seat backend); the plan's Phase-3 first step — act for the OWNER's accounts only via `AUTO_ROUTE_ACT_USER_IDS` with `auto_route_act_percent=0` — is the only test that produces a real label at this volume and is the owner's call.
- **Phase 1b switch FLIPPED — `patience_auto_only=1` in prod since 2026-09-26 20:35:16Z** (recorded by the 2026-09-26 audit, finding docs-drift-3; read-only prod SQL: `system_settings` row `patience_auto_only=1`, `updatedAt 2026-09-26 20:35:16.556`, DB TimeZone UTC). **Author unrecorded:** the table has no `_by` companion row for this key and the generic PUT logged no identity; the container that served 20:35Z was recreated by the 21:07→21:40Z and 21:22→21:59Z deploys, so the log line is gone and it cannot even be confirmed the flip came through the PUT rather than an in-container upsert. Most likely (INFERRED): the loop session executing `DEPTH_UX_SOTA_2026-09-26.md` §5 step 2 five minutes after deploy 36268584103 (cp/integration) went green at 20:30:18Z. The env `PATIENCE_AUTO_ONLY` is UNSET on every box, so the row alone holds the switch ON — deleting it silently reverts to OFF (§7.2 item 21's "env template `PATIENCE_AUTO_ONLY=1`" is still an owner decision; deploy.yml is owner-guarded). **Effect on live sends (verified in code):** every non-supervisor, non-kid, non-escalation human send — guests' forced Ensemble and REST / mobile explicit levels included — is server-rewritten to `auto` with the client level kept as `routing.requestedMode`; the first such prod row landed 22:12:00Z (`routingSource='auto_heuristic'`, `requestedMode='thinking'`, `modeSource='default'`). **Same-day fixes shipped with the record:** (a) a SIGNED-IN user's Account → Advanced preset (`modeSource==='default'`) is now HONOURED as their explicit level (the help page promises it and the owner kept that control — `PATIENCE_AUTO_ONLY_PRESET_DISABLED=1` restores rewrite-everything); (b) the switch flips through the supervisor-switch shape — strict value, idempotent, `patience_auto_only_by` audit row, loop_metrics `patience_switch`, `GET /admin/settings/patience` (since / updatedBy / source), Account → Admin → Settings → Always Auto (`PATIENCE_AUTO_ONLY_AUDIT_DISABLED=1` = the bare upsert). **48 h post-flip gates (§6 row 1b) — first readout 22:58Z, 2.4 h in:** 0 `deep_research_quota_rejected` rows since the flip (⇒ 0 `RATE_LIMIT_*` on user sends); 1 routed human row (`routing` present) vs 1 `user_picked` L3 send that started before the flip and 1 `escalation` row (exempt by design); the 68 + 64 unrouted assistant rows since the flip carry no `routingSource` at all (INFERRED to be machine / supervisor turns — not verified per row). Too early for the L3-share and former-L1 p50 gates — re-run at 2026-09-28 20:35Z.

---

## 1. Goal and non-goals

**Goal.** Every human chat send runs through `routeMessageAuto`; no user-facing surface (web composer, mobile ⋯ menu, session settings, mobile app, Digby MCP, platform REST for user origin) lets a person pick a level. The level is chosen by decision-gate purpose `auto_route` (seat #19 `decision`) in ACT mode once the back-test passes, with the regex heuristic as the fail-open baseline. An Auto pick of Deep Research never errors a user on quota — it demotes with an honest reason. Machine lanes, supervisors and kids are on explicit, cheaper policies. The gate's backend can be swapped to an open-weights decision model as a seat change that automatically re-enters shadow.

**Non-goals.**
- Not changing the three internal tiers. `single_thinking` / `thinking` / `deep_research` remain the run engine's vocabulary (`chat-agent.service.ts:1080`, `:1306`) and budgets (`agent-profiles.ts:92-120`; `chat-agent.service.ts:1355-1357`, `:1404-1412`, `:2249`). They stop being a *user* choice.
- Not re-pricing L2 in this wave (a per-user checker cap is Q7).
- Not changing the Digby Kids pipeline — only guaranteeing it is never routed, on every channel.
- Not touching `browser_agent` (`controller:1691-1720`) or the P5 coding satellite (`controller:1104-1131`).
- Not removing or migrating `crossmodel_chats.mode` (`schema.prisma:226`); it becomes informational (§3.9).
- Not enriching the gate's state or question shape before the first act flip — that would invalidate the shadow rows the flip is gated on (§3.3). Enrichment, allowed-levels criteria and pasted-block stripping are Phase 4 items with their own re-shadow.
- Not tightening the heuristic before Phase 1b **unless** the pre-1b cost gate fails (§6, Phase 1b) — then the bare-word L3 triggers are tightened in 1a.
- Not training a model.

---

## 2. Current state (from the maps, cited)

**Intake.** `mode` enters through seven intakes that all funnel into `startDetachedChatRun` / `runChatAgentTurn` with a concrete level (`chat-agent.service.ts:1080`, `:1306`). `PATIENCE_MODES` still carries retired values and `'auto'` is a separate constant (`types.ts:19`, `:26-27`); `normalizePatienceMode` only aliases (`types.ts:40-44`). Zod defaults an omitted mode to `'single_thinking'` (`crossmodel.validation.ts:14`, `:93`) — but the shared mobile client always sends an explicit `mode: params.mode ?? 'single_thinking'` (`packages/api/src/streaming.ts:296`; `apps/mobile/app/chat/[id].tsx:293-297` passes none), so the mobile app is pinned to L1 by its own client, not by the Zod default.

**The Auto detent.** Only when `mode === 'auto'` does the SSE controller call `routeMessageAuto` (`crossmodel.controller.ts:1158-1178`, awaited at `:1174` **before** `res.flushHeaders()` at `:1273`) and emit `routing` (`:1293`; `chat-agent.service.ts:1482`). The platform send seam does the same (`platform.service.ts:818-830`) and otherwise resolves `normalizeChatAgentMode(opts.mode || chat.mode)` (`:830`) — an agent-origin send with no per-message mode runs the chat's STORED level; only `origin.kind === 'webhook'` is clamped (`:840-846`); an omitted origin counts as `'user'` only at `messageOrigin` (`:967`). `routeMessageAuto` (`auto-router-gate.ts:27-75`): heuristic first; `off` → heuristic; `shadow` → heuristic immediately plus a non-blocking outcome row whose `actual` is the **heuristic's** level (`:46-53`); `act` → awaits the gate ≤ 1500 ms (`:23`), uses its choice only when confidence ≥ 0.85 for L3 / 0.7 otherwise (`:60-61`); any error → heuristic (`:71-74`). State = `{message ≤ 4000 chars, chat_has_code_workspace}` with one `choice` question (`:31-45`). Mode per purpose: `DECISION_GATE_MODE_AUTO_ROUTE` → `DECISION_GATE_DEFAULT_MODE` → `shadow` (`off` under `NODE_ENV=test`) (`decision-gate.ts:153-159`); `DECISION_GATE_DISABLED=1` kills all purposes (`:132-134`). `decisionThreshold` reads ONE env per purpose and applies it to every option (`:163-167`). Backend chain: seat model → seat fallback → built-in `jev` (label `'TypeSafe Jev'`, `:207`) → built-in `deepseek-flash` logprob readout (label `'DeepSeek logprob readout'`), cached 30 s (`:247-268`, `:122`). Decision rows never store the state; outcome rows store `predicted {choice, confidence}` only — no probability vector (`:551-559`, `:656-690`). `decide()` writes NO row when no backend is servable (`:620-625`). `'auto'` is never persisted (`crossmodel.service.ts:724-727`; `platform.service.ts:326-328`; `projects.controller.ts:548-549`).

**Heuristic.** L3 on any RESEARCH_INTENT hit — including bare `research`, `sources`, `cite` (`auto-router.ts:41-53`) — or a ≥ 1200-char multi-part brief (`:71-72`, `:115-122`); L1 only ≤ 160 chars with a simple opener, single-part (`:125-127`); else L2 (`:130-135`). Two other consumers must survive: `isSimpleQuestion` for the L2 cross-check wait (`chat-agent.service.ts:1816-1817`) and the `needsWorkspace` code-attach trigger (`controller:1111-1113`; `platform.service.ts:665`).

**Ordering hazards in the SSE seam.** The auto block (`:1158`) runs **before** the Digby Kids branch (`:1317-1324`). The council quota is reserved **after** routing (`:1590-1610`): an Auto pick of L3 for an out-of-quota user or guest emits `RATE_LIMIT_DEEP_RESEARCH` / `_GUEST` and ends the stream with no downgrade. Busy-chat enqueue happens **before** the reserve (`:1517` comment) so a queued `deep_research` row has never had a slot reserved; the drain replays `pending.mode` straight into `startDetachedChatRun` (`chat-agent.service.ts:868-880`; `QUEUED_RUN_MODES` includes `deep_research`, `:672`).

**Quota.** Signed-in: SystemSetting `deep_research_daily_limit` default 5, cached 60 s, Redis INCR-first reserve, fails OPEN on Redis error (`rate-limit.service.ts:23-41`, `:121-148`); non-reserving `checkDeepResearchQuota` exists (`:96-108`). Guest: per client IP, `ANON_DEEP_RESEARCH_DAILY_LIMIT` default 2, fails CLOSED by design (`:158-201`); no non-reserving anon check (not found). **Client IP:** `getClientIp` (`controller:76-80`) takes the first XFF hop; the request path is client → ALB (AGENTS.md:150) → nginx on the box (`infrastructure.yml:64-70`, `proxy_add_x_forwarded_for`) → Express with `app.set('trust proxy', 1)` (`app.ts:52`, comment still says Cloudflare). With one trusted hop Express's `req.ip` resolves to the right-most XFF entry = the ALB node, so neither the first hop (header-writable) nor `req.ip` (shared ALB address) is a trustworthy per-client key today. The same helper keys registration slots (`controller:961-962`; `stream-registration.ts:35`) and the anon stream-token IP binding (`controller:1041-1051`). No probe of `req.ip` vs the XFF chain exists in the repo (not found).

**Machine lanes.** REST / `send_chat_message` / ticket dispatch (`feedback/ticket-dispatch.service.ts:159-166`, origin agent, no mode) / first-prompt recovery (`platform/first-prompt-recovery.ts:161`) / cloud-link enter `sendChatMessage` and reserve **no** quota (`platform.service.ts:833-839` comment). Fleet Management UI sends are `origin: { kind: 'user' }` (`fleet/fleet.service.ts:941`) — into supervisor chats too. Schedule/hook firings replay the stored `chat.mode` including `deep_research`, unmetered (`schedule.service.ts:2870-2871`, `:2939`); orphan re-fires likewise (`orphan-recovery.ts:273-276`, `:438-442`). Supervisors are stored `thinking` (`supervisor.service.ts:912`; `project-supervisor.service.ts:677`); in the run `profile = isCouncil ? councilProfile('lead') : isFleetSupervisorChat ? supervisorProfile() : …` (`chat-agent.service.ts:2276`) — a routed `deep_research` would out-rank the supervisor profile. `set_chat_mode` can store `deep_research` on any plain chat (`session-tools.ts:44-58`, `:128-138`; advertised `supervisor.service.ts:211`). Telegram hardcodes `single_thinking` with `chatId: null, sessionId: telegram:<id>` (`telegram.controller.ts:188-200`) → the run's `sessionId` is `anon-telegram:<id>` (`chat-agent.service.ts:1446`); there is **no `isChild` guard** in `backend/src/modules/crossmodel/telegram/` (grep: not found) — a linked child account already runs the adult single-model agent. Coding chats store `thinking` but the satellite diverts before the router (`controller:1104-1131`).

**Frontend.** Three pickers on one copy source (`PatiencePicker.tsx:109-148`; `FloatingChrome.tsx:248-277`; `SessionSettingsSection.tsx:185-205`; `patience.ts:27-52`). `mode` state seeded from `cm_prefs.patienceMode` (default `'auto'`, `preferences.ts:24`; `page.tsx:352-355`). Guests: a stored/default `'auto'` is force-mapped to `'thinking'` (`page.tsx:356-364`) — the wire carries a concrete level that is NOT a choice. `setPatienceLevel` refuses L3 at quota with a toast, persists locally and PATCHes the chat row (`page.tsx:2551-2568`); opening a chat restores its stored mode into the preference (`page.tsx:1610-1617`); `createChat` sends `mode: pipelineMode` (`:1944`) which is `'auto'` for default users and is stored as `'thinking'` (`crossmodel.service.ts:726`). No `modeSource`/`patienceSource` signal exists on any send (grep `page.tsx`, `plain-session.ts`: not found). The live `routing` event is dropped (`plain-session.ts:178-181`); `PlainMessageMeta` has no routing field (`lib/api/coding.ts:144-150`). Follow-up chips are model-generated (`[FOLLOWUPS]` parsed at `chat-agent.service.ts:205`; `code-transcript.tsx:1131-1146`; `onPick` prefills the composer, `CodeSessionView.tsx:3058`) — no harness-appended chip exists. Streamed assistant rows carry temp ids (`a-${Date.now()}`, `CodeSessionView.tsx:147`, `:1787`) unless `data.messageId` arrived, so a share of `message_feedback` rows have `messageId: null` (`controller:1928`).

**Telemetry that already exists.** `loop_metrics` kind `decision_gate` (`decision-gate.ts:561-583`, `:656-690`; `sessionId = chatId || undefined` at `controller:1174`, so guest rows have NO sessionId); `chat_search_usage {mode, webToolCalls, machine}` and `chat_platform_usage {mode, …}` per run (`chat-agent.service.ts:3306-3341`), each stamped `{model, profile:'chat', triggerKind}` (`:2420-2426`); **`run_spend` / `run_tokens_in` / `run_tokens_out` DO land for chat runs** — `recordRunSpend` is ungated since 2026-09-13 (`coding/agent.ts:4560-4565`; `chat-agent.service.ts:2427` runs the orchestrator through `runCodingAgent`; rows written by `loop-metrics.service.ts:862-905`, stamp without `mode`); `crosscheck_late_reconcile` / `crosscheck_reconcile` (`loop-metrics.service.ts:396`, `:472`); assistant-row `metadata {mode, routing, models[*].time, synthesisTime}` (`chat-agent.service.ts:3362-3389`); `crossmodel_chats.mode` (`userId` is NOT nullable, `schema.prisma:223` — guests never get a chat row); `message_feedback` (`schema.prisma:370-390`). Retention 30 days (`loop-metrics.service.ts:1147`); writes buffered and lossy (`:746-771`, `:788-801`). DG0925 (`playbook.sh:1589-1626`) already aggregates gate rows with psql and counts `DECISION_GATE_*` lines inside the containers (`:1604`); `prodq.sh` runs a read-only JS probe inside the active backend container (`prodq.sh:1-27`).

**Ops mechanics.** `docker-compose.app.yml` forwards only explicitly listed `${VAR}`s (`:30-31` comment); the backend (`:16-160`) and worker (`:225-345`) lists carry `TYPESAFE_*` (`:53-55`, `:239-241`) but **no** `DECISION_GATE_*`, `ANON_DEEP_RESEARCH_DAILY_LIMIT`, `MACHINE_TURN_CROSSCHECK_ENABLED` or `LOOP_METRICS_P0_DISABLED` (grep: none) — the same class of bug memory-bank recorded for `TYPESAFE_API_KEY` on 2026-09-25. The ec2-ops `env_override` input is `workflow_dispatch`-only (`ec2-ops.yml:23`, `:73`), which the session token cannot trigger; a one-shot can only stage lines into `/opt/crossmodel-local/env-overrides.env`, folded into `.env` by `deploy.yml`'s "Apply box-local env overrides" step (`:261-275`) on the NEXT deploy; `docker restart` keeps the old environment. SystemSettings are admin-editable live: `GET/PUT /admin/settings/:key` (`crossmodel.routes.ts:487-494`), 60 s cache (`rate-limit.service.ts:23-41`), invalidation at `controller:2418-2420`. Shell tests under `scripts/deploy/*.test.sh` run in CI (`ci.yml:45-49`).

**Gaps.** No test exercises `routeMessageAuto` (not found). Whether `TYPESAFE_API_KEY` is SET in prod is unknown (memory-bank 2026-09-25: in no GitHub secret / box `.env` / overrides at report time) — shadow rows may be on the DeepSeek readout. Unfitted logprob readouts are uncalibrated (eval doc `:210`; the measured 0.452 hard-tier ECE at `:189` is for raw Qwen3-4B-Instruct logits, not DeepSeek — DeepSeek's own ECE is unmeasured). Admin `modeCounts` omit `single_thinking` (`controller:2611-2617`). Stale copy: CLAUDE.md:14 "Four patience levels", AdminTab.tsx:628 "Patience 4", docs/api-reference.md:45, `scripts/test-patience-routing.ts:9-16`.

---

## 3. Target design

### 3.1 Always-Auto at the two user seams (flag, not rewrite)

One switch, **`patience_auto_only`**, read through the same 60 s-cached SystemSetting path as `deep_research_daily_limit` (`rate-limit.service.ts:23-41`; PUT `/admin/settings/:key`, `crossmodel.routes.ts:494`; invalidation idiom `controller:2418-2420`) with env `PATIENCE_AUTO_ONLY` as the boot default (deployed `0`, flipped in Phase 1b). It makes both user-facing seams treat every **user-origin** send into a **non-supervisor** chat as `'auto'`:

- **SSE:** after normalization (`controller:1084` / cached-mode `:1065-1072`) and before the auto block (`:1158`): if the switch is on, `mode !== 'browser_agent'`, and the target chat is not `isSupervisor || isProjectSupervisor` (one field on the chat lookup the controller already performs), record `requestedMode = mode`, `modeSource` (§4.2), set `mode = 'auto'`. Zod enums stay (`crossmodel.validation.ts:9`) so in-flight clients never 400.
- **Platform:** in `sendChatMessage` (`platform.service.ts:814-830`) when `(opts.origin?.kind ?? 'user') === 'user'` (omitted origin = user, matching `messageOrigin` at `:967`), the switch is on, and the chat is not a supervisor chat, force the auto branch. Supervisor chats keep their stored `thinking` on every path (Fleet UI sends are user-origin, `fleet.service.ts:941`). Machine origins follow §3.6.
- **Zod defaults** on the stream/register schemas (`crossmodel.validation.ts:14`, `:93`) flip to `'auto'` in 1a — today no client omits mode there, so this is inert and only prepares the mobile client change (item 26). The platform REST default (`platform.validation.ts:54`, documented "Omitted → the chat's stored mode", `:52-54`; `docs/DIGBY_PLATFORM_API.md:59-63`) is **left untouched until 1b** — the server override covers user origins from 1b, and the doc line changes in the same 1b commit so the public contract never silently drifts.
- `registerStreamQuery` (`controller:973-976`) keeps storing what the client sent (plus `modeSource`); the override happens at consume time.
- **Stream ordering change:** flush SSE headers and emit `progress {message:'Deciding how deeply to think…', stage:'routing'}` BEFORE awaiting the gate (`:1174`), then `routing`. Today headers flush at `:1273`, so an act-mode wait would be dead air. Every error path between the new flush point and `:1273` must already emit an SSE `error` event (the quota path does; audit `:1174-1273` for any `res.status(...)` JSON response and convert).

Why a switch: it is the kill switch back to user choice for API/mobile clients (§5.5), it lets the frontend change land independently, and the override is two `if` blocks rather than a re-plumb of seven intakes.

### 3.2 Who chooses the level

Unchanged wrapper: `routeMessageAuto` — heuristic baseline, gate `auto_route` in `shadow` until the back-test passes, then `act`.

**Thresholds — per option.** Today one env applies to every option (`decision-gate.ts:163-167`): setting `DECISION_GATE_THRESHOLD_AUTO_ROUTE=0.75` to loosen L1/L2 would LOWER the L3 bar from 0.85. Phase 1a adds `DECISION_GATE_THRESHOLD_AUTO_ROUTE_DEEP_RESEARCH` (default 0.85; the generic env can never lower it — pinned in `auto-router-gate.test.ts`). Defaults stay 0.85 / 0.7 until Phase 2 refits them on the held-out window (§4.6).

New inputs to the wrapper: `allowDeepResearch` (default true), `actEligible` (canary, default true), `segment` (`user | guest | kid_skipped | telegram | machine`), `escalationOf` (§3.8). If `allowDeepResearch` is false and the chosen level is `deep_research`, the wrapper returns `thinking` with `reasonKey: 'quota_exhausted'` (or `'guest_no_research'`, `'quota_unavailable'`) and `clamped: 'quota'`. **The clamp is applied after the decision** — not fed into the state or question — so the shadow dataset stays comparable across the flip. The outcome row keeps `actual = heuristic.level` (pre-clamp); the clamp is telemetered separately.

**Acting-backend pin.** `DECISION_GATE_ACT_BACKEND_AUTO_ROUTE=<spec>` (a backend **spec** such as `jev`, `deepseek-flash` or `<label>:<model>` — not the display label, which admins can rename in the Endpoints UI, `decision-gate.ts:221-224`). `DecideResult` gains `spec` beside `label`; `routeMessageAuto` compares it and on mismatch behaves as shadow, logs once, and writes the outcome row with `note:'backend_pin_mismatch'` so readouts separate pin-shadow from below-threshold. Any seat change (§8) or fallback leg therefore re-enters shadow by construction.

**Outcome rows gain** `meta.answers.level.probabilities` (three numbers, on both decision and outcome rows), `meta.heuristic` (the heuristic level on EVERY outcome row, including label-window rows where `actual` = U), `meta.segment`, `meta.modeSource`, `meta.reasonKey`, `meta.clamped`, `meta.note`.

### 3.3 What the gate sees

MVP: exactly today's state — `{message ≤ 4000 chars, chat_has_code_workspace}` and the single `level` choice (`auto-router-gate.ts:31-45`). Every shadow row since 2026-09-24 was produced on this state; changing it before the act flip discards the evidence the flip is gated on.

Deferred to Phase 4, each with its own ≥ 7-day re-shadow: (a) asking the gate only over permitted levels when `allowDeepResearch` is false (act rows `note:'reduced_criteria'`, excluded from calibration readouts); (b) stripping fenced/quoted/pasted blocks to their first ~200 chars; (c) code-selected extras (`turn_index`, `prior_level`, `has_attachments` — requires attachment resolution moved above routing, `controller:1213-1231` — `is_guest`, `has_knowledge_base`). The eval doc's two extra nouls (docs/JEV…:254) are deferred: they multiply readout calls per question (`decision-gate.ts:537-538`).

Injection posture in the MVP: only the user's typed `message` is routed (`controller:1174`) — attachment text and tool output never reach the gate — pinned by test. The worst outcome of steering is a council run within quota (AGENTS.md:1561).

### 3.4 Quota- and auth-aware demotion

Before the auto block, both seams compute `allowDeepResearch`:
- signed-in: `checkDeepResearchQuota(userId).allowed` (`rate-limit.service.ts:96-108`, non-reserving);
- guest: new non-reserving `checkAnonDeepResearchQuota(ip)` mirroring the reserve's key and limit (`:158-201`), `false` when the limit is 0;
- **on Redis error under the switch: `false`** (`reasonKey:'quota_unavailable'`, demote to Ensemble). Today's fail-open reserve was bounded by a human having to CHOOSE Level 3; under Auto-only the heuristic promotes on bare `research`/`sources`/`cite` with no human in the loop, so a Redis outage must floor to L2, matching the anon reserve's fail-closed posture (`:197-200`). The reserve's fail-open stays only for the switch-off / explicit-choice world.

**Guest IP prerequisite (Phase 0 → 1a).** Do NOT switch `getClientIp` to `req.ip`: under `trust proxy 1` behind ALB + nginx it is the ALB node, and the helper also keys registration slots and the anon stream-token binding. Phase 0 adds a read-only ec2-ops one-shot that logs, for one known request through digby.ai, the masked `req.ip`, the full XFF chain and the socket peer (or reads nginx's access-log XFF for a test hit) and records the real hop count. Phase 1a then either sets `trust proxy` to that hop count (expected 2: ALB + nginx) or takes the entry immediately LEFT of the ALB hop, exposed as a dedicated `quotaClientIp(req)` used ONLY by the anon quota key and the canary hash; `getClientIp` stays untouched so registration caps and token binding do not collapse onto a handful of ALB addresses. Pinned by a supertest case that sends a forged 2-hop XFF and asserts the client-derived IP, plus a re-check that `sameIpSession` still rejects a cross-/24 replay. **Until the probe proves a per-client key, guests run with `allowDeepResearch:false` and anonymous act-canary eligibility is 0.** Acceptance: two guests on different networks get distinct `deep_research_anon_usage:` keys.

The reserve at `:1590-1610` stays for a permitted L3 pick. If it still fails (race) and the switch is on, the controller demotes to `thinking`, rewrites `routing` (`reasonKey:'quota_exhausted'`, `clamped:'quota'`), logs `auto router: quota demotion`, and continues. The `RATE_LIMIT_DEEP_RESEARCH*` error path remains only for explicit machine-origin L3 and the switch-off world.

The platform seam gets the same `allowDeepResearch` computation **and the reserve** for user-origin sends before `startDetachedChatRun` (`platform.service.ts:920-1030`) — closing the REST bypass its own comment acknowledges (`:833-839`). Fleet UI user-origin sends into non-supervisor chats take this path.

**Busy-queue drain RESERVES.** A queued `deep_research` row has never had a slot reserved (enqueue precedes the reserve, `controller:1517`), and `checkDeepResearchQuota` never increments — a check-only drain would let N queued L3 sends all pass `used < limit`. At drain (`chat-agent.service.ts:868-880`), `reserveDeepResearchQuota(userId)` (or the anon reserve) runs for a queued `deep_research`; refusal demotes to `thinking` with `reasonKey:'quota_exhausted'`, written into the new `pending_chat_messages.routing Json?` column. Test: two queued L3 rows with limit 1 → exactly one council run.

### 3.5 Kids — every channel

- **SSE:** hoist the `isChild` lookup (`controller:1317-1324`) above the auto block: when `isChild`, skip routing entirely (no heuristic, no gate call), fall through to the kid branch. Post-deploy check: zero `decision_gate` rows for a kid session.
- **Telegram (Phase 1a):** add an `isChild` guard to the inbound path (`telegram.controller.ts:188-200`): refuse with the kid-mode message or route to `streamKidResponse`; pinned in a telegram test. The Phase 4 Telegram Auto item is conditional on this guard. Post-deploy check: zero adult-agent runs and zero `decision_gate` rows for `anon-telegram:` sessions owned by `users.isChild=true`.

### 3.6 Machine, supervisor and channel policy (Phase 1a, pinned; owner Q3 can relax it)

**Rule:** the machine floor applies to the **RESOLVED** level for every `origin.kind !== 'user'` — whether it came from `opts.mode`, stored `chat.mode` (`platform.service.ts:830`) or an escalated auto route. An omitted origin is `'user'`.

| Lane | Behaviour | Where |
|---|---|---|
| Supervisor chats (Fleet, project) | Excluded from the `patience_auto_only` override and from the label window on both seams; keep stored `thinking`, checker skipped. Never Auto, never council. Pinned: a user-origin send into a supervisor chat under the switch never calls `routeMessageAuto` and never runs `councilProfile`. | `controller:1151-1178`; `platform.service.ts:814-830`; `chat-agent.service.ts:2276`; `fleet.service.ts:939-948` |
| Schedule / hook firings | Stored `deep_research` clamped to `thinking` unless the chat carries an owner-armed grant `allowScheduledCouncil` (context-store key via `memory/context-store.ts`, no migration); armed fires `reserveDeepResearchQuota(ownerId)` and demote on refusal. The clamp writes `routing {level:'thinking', reasonKey:'channel_floor', clamped:'machine'}` into the run args (`startDetachedChatRun` already takes `routing`, `chat-agent.service.ts:1151-1156`) so the run's existing `chat_search_usage` row and assistant metadata carry it — **no new metric kind** (the kinds registry is closed, `loop-metrics.service.ts:31-587`). | `schedule.service.ts:2870-2871`, `:2939`, `:2981-2987` |
| Orphan re-fires | Same policy. | `orphan-recovery.ts:273-276`, `:438-442` |
| Webhooks | Unchanged allowlist + L3 clamp. | `webhook.controller.ts:42`; `platform.service.ts:840-846` |
| `send_chat_message` / REST from agents, ticket dispatch, first-prompt recovery, cloud-link | Per-message `mode` stays accepted for machine origins but the RESOLVED level is floored: `deep_research` (per-message OR stored) → `thinking`, `reasonKey:'channel_floor'`. Test: chat stored `deep_research`, agent origin, no mode → runs `thinking`. | `platform-tools.ts:245-262`, `:2777-2795`; `platform.service.ts:830`, `:840-846` |
| `set_chat_mode` tool | Kept (59-tool pin unchanged, `platform-tool-names.ts:215`); description: "stored mode affects machine wakes only; user sends are always Auto; deep_research on machine wakes needs the owner grant". Stored L3 is inert on every machine path without the grant. Removal (or dropping `deep_research` from the enum) is Q2. | `session-tools.ts:44-58` |
| Telegram | 1a: `isChild` guard (§3.5); pinned L1 otherwise, documented. Phase 4: `routeMessageAuto` with `allowDeepResearch:false`, `segment:'telegram'`. | `telegram.controller.ts:196` |
| Mobile app | Routing arrives only with the 1b server override (the client sends an explicit `mode`, `streaming.ts:296`). Item 26 (send no mode / `'auto'`) ships in **1a** so mobile sends stop being recorded as explicit L1 picks during the label window; until that release lands, the mobile client (`x-digby-client` / User-Agent) is excluded from the label window. | `packages/api/src/streaming.ts:267`, `:296` |
| Coding satellite | Unchanged; diverts before the router. | `controller:1104-1131` |
| Busy-queue drain | Reserves for a queued L3 (§3.4); `pending_chat_messages.routing Json?` (additive migration). | `chat-agent.service.ts:868-880`; `message-queue.service.ts:85-96`; `schema.prisma:316-335` |

`isSimpleQuestion` (`chat-agent.service.ts:1816-1817`) prefers `args.routing.level` when present, regex otherwise — one judge per turn. `needsWorkspace` keeps using the heuristic (it never changes level).

### 3.7 What remains user-visible

- **Depth chip on every assistant turn**: "Quick" / "Ensemble" / "Deep Research" from `PATIENCE_SHORT` (`patience.ts:27`), rendered from the `routing` SSE event (after the new early `progress`, §3.1) and from `metadata.routing` on reload. Tooltip copy keyed by a **code-selected `reasonKey`** enum on the routing object — `{simple_lookup, default_ensemble, research_requested, long_brief, quota_exhausted, quota_unavailable, guest_no_research, channel_floor, user_escalation, decision_gate}` — mapped to plain English in the frontend: "Simple lookup — one model answers directly"; "A second model is checking this answer in parallel"; "You asked for a report with sources — running the research council"; "Ensemble · Deep Research used up for today (5/5) — resets midnight UTC"; "Ensemble · Deep Research needs a free account" with a sign-in link. The raw gate string (`auto-router-gate.ts:66`) stays in metadata for admins; source/confidence show in More-info (`code-transcript.tsx:1306-1320`). Share-page badge (`shared/chat/[token]/page.tsx:129-141`) gains the reason.
- **Quota badge** re-keyed on the last turn's `routing.level === 'deep_research'` / remaining count, shown when remaining ≤ 1 (`page.tsx:4273-4288`).
- **No picker** anywhere. "New chat" placement in FloatingChrome re-keyed on flavor, not `showPatience` (`FloatingChrome.tsx:235`, `:409`). Home-screen placeholder: "Digby decides how deeply to think. Ask for a quick answer or deep research in your own words."
- **Escalation in words** ("do deep research on this", "cite sources", "briefly") reaches the heuristic and gate as today.

### 3.8 "Dig deeper" — a structured escalation, not a text chip (Q4)

Follow-up chips are model-generated and prefill the composer; a chip whose TEXT says "research it thoroughly and cite sources" is L3-by-construction for the regex (`auto-router.ts:50-51`) and would poison both H and the escalation label. So:
- The server **appends** a fixed "Dig deeper" chip to `followUps` after parsing the model's `[FOLLOWUPS]` block — on the SSE `followups` event and in persisted metadata — so it exists regardless of what the model wrote, flagged `metadata.followUps[i].kind:'escalate'`.
- Clicking it sends a **structured flag**, not trigger text: `escalate: true` on the register body / stream params, resolved server-side to `routing.escalationOf = <prior assistant message id>`. The router returns the prior turn's level + 1 with `reasonKey:'user_escalation'` (quota/allowance rules still apply), and the outcome row is written against the PRIOR message's decision id with `actual = requested level`, `note:'user_escalation'`.
- Escalation-flagged messages are excluded from the H × gate and calibration pools; **E** = "prior routed level < requested level".
- It borders on "changeable by users", so it is Q4; the plan works without it (labels then come only from the label window and thumbs).

### 3.9 Persistence

`crossmodel_chats.mode` keeps its values; the frontend stops writing it (`page.tsx:2566-2567`, `:1944` createChat mode, `:2566-2567` updateChat) and stops restoring it into the preference (`page.tsx:1610-1617`) **in Phase 1a** (before the label window opens — otherwise every Auto user who reopens a chat is silently switched to an explicit `'thinking'` and all their later sends would read as explicit picks). `createChat` default `'fast'` (`crossmodel.service.ts:64`) and the schema default (`schema.prisma:226`) are left alone in the MVP — readers normalize (`normalizeChatAgentMode`, `platform.service.ts:151-155`; `orphan-recovery.ts:273-276`). Assistant rows gain `routing.source`, `reasonKey`, `clamped`, `requestedMode`, `modeSource`, `confidence`, `backend`, `escalationOf`; the chat run's `chat_search_usage` meta and its `run_spend` stamp gain `mode` + `routingSource` so cost per level reads without joins.

---

## 4. Back-test methodology

### 4.1 Principle and evidence streams

All computed in place on box A, aggregates only, never message text or user ids off the box:

1. **Live shadow telemetry** — `decision_gate` rows the running app writes; read by an ec2-ops one-shot (SQL via the DG0925 idiom, `playbook.sh:1603-1607`).
2. **Label window** — while the pickers are live (Phase 1a, switch off) the shadow gate is fired on explicit-level user sends with `actual = the user's level`, but **only sends tagged `modeSource='picked'`** count as U (§4.2). Non-blocking (`void`), no request-path latency. **This is new third-party egress:** today only `mode==='auto'` sends reach the gate (`controller:1158`; `platform.service.ts:818`); the label window would send messages (≤ 4,000 chars, `auto-router-gate.ts:32`) of users who explicitly did NOT pick Auto, and guests, to TypeSafe (`decision-gate.ts:204-211`). It is therefore covered by owner Q1 together with the replay; **until Q1 is answered the label window runs with `spec:'deepseek-flash'`** (`decision-gate.ts:89-90`, a provider that already receives every chat message), throttled by `LABEL_WINDOW_SAMPLE_PERCENT` (default 100). Excluded from the label window: guests, the mobile client until item 26 ships, supervisor chats, kids, escalation-flagged sends.
3. **In-place replay** — a `prodq.sh` JS probe re-scores historical human messages with the compiled heuristic and gate from `/app/dist` (`backend/Dockerfile:58`) and prints confusion matrices. Same egress rule: `spec='deepseek-flash'` until Q1.

Plus the **pre-removal U-snapshot** (§4.4 query 0), taken before any picker is removed — it can never be regenerated afterwards. It inherits the restore contamination unless filtered to rows whose chat mode was written by the slider (the UI slider's `updateChat` is NOT audited — grep `chat.mode` in `crossmodel.service.ts`/`crossmodel.controller.ts`: not found — so historical rows are only weakly labelled; the snapshot reports that limitation beside every number).

**Distribution shift.** Once the picker is gone users will encode depth in words the regex fires on. Every U-based number is estimated on the pre-shift distribution. AR0926 therefore carries a named **shift metric** (share of human messages hitting RESEARCH_INTENT and SIMPLE_OPENER, pre-1b week vs each post-1b week), and the act decision requires (i) post-1b shadow rows for gate-vs-H, coverage, latency, L3 promotion, and (ii) a post-1b labelled re-check: either the structured escalation signal (§3.8) or an in-place owner-rated sample of ≥ 300 post-1b messages, rated levels stored as outcome rows `note:'owner_rated'`, never exported. Label-window U thresholds are necessary; the post-1b re-check is the sufficient condition.

### 4.2 Data and labels (with biases)

| Label / signal | Source | Bias stated in every readout |
|---|---|---|
| **H** heuristic level | `meta.heuristic` on every outcome row (new); `outcome.actual` on legacy `'auto'` rows (`auto-router-gate.ts:50`) | It is the regex; over-escalates on bare `research`/`sources`/`cite`. Reported as *agreement*, diagnostic only. |
| **U** user-picked level | Label-window rows with `note:'user_picked'` — the client sends `modeSource ∈ {picked, default, restored}` with the mode (`page.tsx:1919` send path; register body `plain-session.ts:462`); `picked` = `setPatienceLevel` ran in this session. `default`/`restored` rows are recorded as `note:'user_default'` and reported but excluded from U. Historical: `metadata.mode` on assistant rows without `routing` (weak). | Sticky per user/chat; L3 under-sampled (picker refuses L3 at quota, `page.tsx:2553-2556`; guests 2/day); guests' wire level is a FORCED default (`page.tsx:361-364`) — excluded; mobile pinned L1 by its client — excluded until item 26. Report the picked/default split (query 2). |
| **E** escalation | Structured "Dig deeper" (§3.8) → outcome row against the prior decision id, `note:'user_escalation'` | Only captures under-routing; exists only if Q4 = yes. |
| **O** owner-rated | ≥ 300 post-1b messages rated in place, `note:'owner_rated'` | Single rater; the sufficient-condition label for the act flip. |
| **F** feedback | `message_feedback` joined on `messageId` → `metadata.mode`; fallback `(chatId, latest assistant row created before feedback.createdAt)` for null ids; join rate reported (query 0) | Sparse, negative-skewed; `slow` conflates level cost with provider latency; temp ids leave `messageId` null. Counts with a minimum (≥ 5 events per arm), act vs control. |
| **R** checker value | `crosscheck_late_reconcile` / `crosscheck_reconcile` outcome `revised` vs `unchanged` | L2 runs only. |
| **W** grounding | `chat_search_usage.webToolCalls` per level | Whether the model searched, not whether it needed to. |
| **T** latency | `metadata.models.digby.time`, `double_checker.time`, `triple_checker.time`, `synthesisTime`; time-to-first-byte from the E2E driver | Provider-dependent; p50/p95 per level per week; the act wait is pure added TTFB. |
| **$** cost | **Measured USD**: `run_spend` / `run_tokens_*` rows (ungated for chat runs since 2026-09-13, `agent.ts:4560-4565`), stamp `profile='chat'`, joined by `runId` when present else `(sessionId, createdAt ± 60 s)` to the run's `chat_search_usage` row (`mode`); from 1a the stamp carries `mode`/`routingSource` directly. The step/deadline caps (L2 ≈ 2.2× L1, L3 ≈ 10–15× L1 by budget) are a cross-check only, labelled as maxima. | Estimated-token rows (`meta.estimated`) flagged. |
| Segment | `meta.segment` (new, code-selected at both seams). Legacy rows: guest = `sessionId IS NULL` (`controller:1174` passes `chatId || undefined`); Telegram = `sessionId LIKE 'anon-telegram:%'` (never reaches the router — no decision rows); kids = never routed (count only); coding via `chat_coding_state`; machine via `stamp.triggerKind` / `metadata.origin`. An E2E assertion checks a signed-in send always yields a decision row with a non-null `sessionId`. | Every rate grouped by `meta.backend` AND segment. |

### 4.3 Sample sizes, fit/test split, retention

- **Volume first (Phase 0):** AR0926 query 0 prints human sends/day, explicit-vs-auto share, explicit-level volumes per class and per distinct user over 30 days, and the `messageId` join rate. The label-window length is derived: days needed to reach the class minima × 1.5 (not a fixed 14 days), capped by the 28-day retention edge. Expected TypeSafe calls/day for the label window = explicit human sends/day × `LABEL_WINDOW_SAMPLE_PERCENT`; credit burn stated in memory-bank.
- **Pre-registered time split:** thresholds/temperature are fitted on window A (days 1–7 of the label window) and every §4.6 metric is evaluated on a disjoint window B (days 8–14, or the post-1b week). AR0926 takes explicit `from/to` bounds and prints which window served as fit vs test. Coverage/ECE are never quoted from the fit window.
- **Clustering:** rows are not independent (a handful of accounts dominate human turns) — every U-based rate carries a bootstrap CI clustered by `userId`, and each class needs ≥ 20 distinct users.
- **Retention:** rows older than 30 days are reaped (`loop-metrics.service.ts:1147`). Each readout prints `min(createdAt)`; no threshold is re-evaluated on a window whose start predates now − 28 d; label-window aggregates (per-class counts, 3×3 matrices, calibration table) are snapshotted into memory-bank at window end. Confirm `LOOP_METRICS_P0_DISABLED` is unset (`:659-663`); report `n` beside every rate (lossy sink, `:746-771`).
- **Telemetry coverage (must pass before any rate is read):** decision rows/day ÷ Auto-routed human sends/day ≥ 95% (denominator from `chat_search_usage` rows carrying `routingSource`, or the `auto router:` log at `controller:1177`); decision↔outcome join rate by `meta.id` ≥ 90%. Below that the readout is a telemetry fault, not a result — `decide()` writes no row when no backend is servable (`decision-gate.ts:620-625`), so a low row count is otherwise invisible.

### 4.4 Mechanism — live readout (ec2-ops one-shot `AR0926`)

A marker-gated block above `==ONE-SHOT-INSERT-POINT-PROD==` (`playbook.sh:1628`), same `q()` helper as DG0925 (`docker run --rm -i pgvector/pgvector:pg16 psql "$BE_URL"`), triggered by a push to `main` touching `scripts/ec2-ops/**` (`ec2-ops.yml:31-36`), read with `get_job_logs`, ≤ 24 KB, `head -40` per query, explicit `:from`/`:to` bounds. Backend labels are `'TypeSafe Jev'` and `'DeepSeek logprob readout'` (`decision-gate.ts:207`, `:634`), never `'jev'`. Guest predicate on legacy rows: `"sessionId" IS NULL`.

**Query 0 — pre-removal U-snapshot + volumes (once, before 1b; via the replay probe for the heuristic column):** human assistant rows over 90 days without `metadata.routing` — `metadata.mode` × re-run heuristic 3×3, per-level volumes, per-distinct-user counts per class, L3 share, F thumbs-down rate + `messageId` join rate, R revised rate, W search rate, T p50/p95 per level, measured $ per level, human sends/day and explicit-vs-auto share. Pasted into memory-bank.

**Query 1 — volume, backend, errors, guest share, pin-shadow:**
```sql
SELECT meta->>'phase' AS phase, meta->>'backend' AS backend, meta->>'mode' AS mode, meta->>'ok' AS ok,
       count(*) AS n, count(*) FILTER (WHERE "sessionId" IS NULL) AS n_guest_legacy,
       count(*) FILTER (WHERE meta->>'segment'='guest') AS n_guest,
       count(*) FILTER (WHERE meta->>'note'='backend_pin_mismatch') AS n_pin_shadow,
       round(avg(value)::numeric,1) AS avg_ms_or_agree
FROM loop_metrics
WHERE kind='decision_gate' AND meta->>'purpose'='auto_route' AND "createdAt" BETWEEN :from AND :to
GROUP BY 1,2,3,4 ORDER BY 1,2,3,4;
```

**Query 2 — three-way matrix (U × H × gate) by note:**
```sql
SELECT meta->>'backend' AS backend, coalesce(meta->>'note','auto') AS note, meta->>'modeSource' AS mode_source,
       meta->>'actual' AS actual, meta->>'heuristic' AS heuristic, meta->'predicted'->>'choice' AS gate,
       count(*) AS n, count(DISTINCT "sessionId") AS n_sessions,
       round(100*avg(value)::numeric,1) AS agreed_pct, round(avg((meta->>'confidence')::numeric),3) AS avg_conf
FROM loop_metrics
WHERE kind='decision_gate' AND meta->>'purpose'='auto_route' AND meta->>'phase'='outcome'
  AND "createdAt" BETWEEN :from AND :to
GROUP BY 1,2,3,4,5,6 ORDER BY 1,2,3,4,5,6;
```

**Query 3 — coverage at threshold (what ACT would have done), per option:**
```sql
SELECT meta->>'backend' AS backend, meta->'predicted'->>'choice' AS gate,
       count(*) AS n,
       count(*) FILTER (WHERE (meta->>'confidence')::numeric >= CASE WHEN meta->'predicted'->>'choice'='deep_research' THEN 0.85 ELSE 0.7 END) AS would_act,
       round(100*avg(value) FILTER (WHERE (meta->>'confidence')::numeric >= CASE WHEN meta->'predicted'->>'choice'='deep_research' THEN 0.85 ELSE 0.7 END)::numeric,1) AS agreed_pct_when_acting
FROM loop_metrics
WHERE kind='decision_gate' AND meta->>'purpose'='auto_route' AND meta->>'phase'='outcome'
  AND coalesce(meta->>'note','')<>'user_escalation' AND "createdAt" BETWEEN :from AND :to
GROUP BY 1,2;
```

**Query 4 — calibration (top-label ECE, bins from 1/3) and Brier from the probability vector:**
```sql
-- top-label reliability: bins over [1/3, 1] so a 3-way choice never falls into bucket 0
SELECT meta->>'backend' AS backend, coalesce(meta->>'note','auto') AS note,
       width_bucket((meta->>'confidence')::numeric, 0.3333, 1.0, 6) AS bucket,
       count(*) AS n, round(avg((meta->>'confidence')::numeric),3) AS mean_conf, round(avg(value)::numeric,3) AS empirical_agree
FROM loop_metrics
WHERE kind='decision_gate' AND meta->>'purpose'='auto_route' AND meta->>'phase'='outcome'
  AND meta->>'note' IN ('user_picked','owner_rated') AND "createdAt" BETWEEN :from AND :to
GROUP BY 1,2,3 ORDER BY 1,2,3;
-- multi-class Brier = sum_k (p_k - 1[k=actual])^2 per row; p_k from meta.predicted.probabilities (1a field)
SELECT meta->>'backend' AS backend, count(*) AS n,
  round(avg( power((meta->'predicted'->'probabilities'->>'single_thinking')::numeric - (meta->>'actual'='single_thinking')::int, 2)
           + power((meta->'predicted'->'probabilities'->>'thinking')::numeric        - (meta->>'actual'='thinking')::int, 2)
           + power((meta->'predicted'->'probabilities'->>'deep_research')::numeric   - (meta->>'actual'='deep_research')::int, 2) )::numeric, 4) AS brier
FROM loop_metrics
WHERE kind='decision_gate' AND meta->>'purpose'='auto_route' AND meta->>'phase'='outcome'
  AND meta->'predicted' ? 'probabilities' AND meta->>'note' IN ('user_picked','owner_rated') AND "createdAt" BETWEEN :from AND :to
GROUP BY 1;
```
ECE = Σ_bins (n_b/N)·|mean_conf_b − empirical_agree_b| over the top-label table; per-option reliability uses `p_k` vs `1[k=actual]` with the same binning. Until the `probabilities` field exists, only top-label ECE is measurable and the Brier gate is not applied.

**Query 5 — latency and errors per backend (act budget):**
```sql
SELECT meta->>'backend' AS backend,
       percentile_cont(0.5) WITHIN GROUP (ORDER BY value) AS p50_ms,
       percentile_cont(0.95) WITHIN GROUP (ORDER BY value) AS p95_ms,
       count(*) FILTER (WHERE value > 1500) AS over_budget,
       count(*) FILTER (WHERE (meta->>'ok')='false') AS failed, count(*) AS n
FROM loop_metrics
WHERE kind='decision_gate' AND meta->>'purpose'='auto_route' AND meta->>'phase'='decision'
  AND "createdAt" BETWEEN :from AND :to
GROUP BY 1;
```

**Query 6 — L3 promotion, over/under-escalation (picked rows), human non-supervisor only:**
```sql
SELECT m.meta->>'backend' AS backend,
       count(*) AS n,
       round(100*avg((m.meta->>'heuristic'='deep_research')::int)::numeric,1) AS heuristic_l3_pct,
       round(100*avg(((m.meta->'predicted'->>'choice')='deep_research' AND (m.meta->>'confidence')::numeric>=0.85)::int)::numeric,1) AS gate_l3_at_threshold_pct,
       count(*) FILTER (WHERE m.meta->>'note'='user_picked' AND m.meta->>'actual'='single_thinking' AND (m.meta->'predicted'->>'choice')='deep_research') AS over_esc,
       count(*) FILTER (WHERE m.meta->>'note'='user_picked' AND m.meta->>'actual'='single_thinking') AS picked_l1,
       count(*) FILTER (WHERE m.meta->>'note'='user_picked' AND m.meta->>'actual'='deep_research' AND (m.meta->'predicted'->>'choice')='single_thinking') AS under_esc,
       count(*) FILTER (WHERE m.meta->>'note'='user_picked' AND m.meta->>'actual'='deep_research') AS picked_l3
FROM loop_metrics m LEFT JOIN crossmodel_chats c ON c.id = m."sessionId"
WHERE m.kind='decision_gate' AND m.meta->>'purpose'='auto_route' AND m.meta->>'phase'='outcome'
  AND coalesce(c."isSupervisor",false)=false AND coalesce(m.meta->>'segment','user') IN ('user','guest')
  AND coalesce(m.meta->>'note','')<>'user_escalation' AND m."createdAt" BETWEEN :from AND :to
GROUP BY 1;
```
(Legacy rows with `"sessionId" IS NULL` survive the LEFT JOIN as guests.)

**Query 7 — post-flip monitors (daily), act cohort vs concurrent control:**
```sql
SELECT date_trunc('day',"createdAt") AS d, meta->>'mode' AS level, meta->>'routingSource' AS src,
       meta->>'clamped' AS clamped, meta->>'reasonKey' AS reason,
       (meta->>'actEligible')::boolean AS act_cohort, count(*) AS n,
       round(100*avg((coalesce((meta->>'webToolCalls')::int,0)=0)::int)::numeric,1) AS zero_search_pct
FROM loop_metrics
WHERE kind='chat_search_usage' AND coalesce((meta->>'machine')::boolean,false)=false
  AND "createdAt" BETWEEN :from AND :to
GROUP BY 1,2,3,4,5,6 ORDER BY 1,2,3;
-- measured $ per level per day (1a stamp carries mode)
SELECT date_trunc('day',"createdAt") AS d, meta->>'mode' AS level, count(*) AS runs, round(sum(value)::numeric,2) AS usd, round(avg(value)::numeric,4) AS usd_per_run
FROM loop_metrics WHERE kind='run_spend' AND meta->>'profile'='chat' AND "createdAt" BETWEEN :from AND :to
GROUP BY 1,2 ORDER BY 1,2;
```
Plus: machine-origin council runs/day (`triggerKind<>'user' AND mode='deep_research'`), supervisor-chat council runs (= 0), `RATE_LIMIT_DEEP_RESEARCH*` on user sends (from the backend log line count in the one-shot), the shift metric (RESEARCH_INTENT / SIMPLE_OPENER hit share via the replay probe on the last 7 days), F counts per arm, kid/Telegram-child decision rows (= 0).

### 4.5 Mechanism — in-place replay (`prodq.sh` probe)

`scripts/framework-audit/backtest-auto-route.js`, run as `bash /opt/crossmodel/scripts/framework-audit/prodq.sh /tmp/backtest-auto-route.js <days> <spec>` from a one-shot that heredocs the probe to `/tmp` (the repo rsync may lag the playbook; ec2-ops and deploy run in parallel). The probe:
- requires `/app/dist/config/database` (Prisma), `/app/dist/modules/crossmodel/platform/auto-router` (`routeMessageHeuristic`) and `.../decision-gate` (`decide` with `opts.spec`, `decision-gate.ts:89-90`);
- **stubs telemetry**: overwrites `recordLoopMetric` on the required `loop-metrics.service` CJS namespace before calling `decide`, and tags sessions `backtest:` as belt-and-braces (readouts exclude that prefix);
- selects human user rows for the last N days: chats `isSupervisor=false`, `parentChatId IS NULL`, `updatedAt` in window (no `createdAt`-only index on messages, `schema.prisma:303-304`), user rows whose next assistant row has `metadata.engine='agent'` and no `metadata.origin`, cursor by `(chatId, createdAt)`;
- label per row: `metadata.mode` when `metadata.routing` is absent (U-weak; flagged as restore-contaminated), else `metadata.routing.level` (H);
- scores each message with the heuristic and `decide(..., {purpose:'auto_route', spec})`; `spec` defaults to `deepseek-flash`; `jev` only after Q1;
- serial calls with a 200 ms floor, 300 messages per invocation, run detached (`systemd-run --collect`) because the CI ssh session breaks on long-silent streams; each batch appends a JSON aggregate line to `/var/tmp/ar-backtest/<date>.jsonl`; a final step merges;
- prints only counts per segment, confusion matrices (U × H, U × gate-at-threshold, H × gate), coverage, top-label ECE + per-option Brier, L3 rates, over/under-escalation, median `digby.time` per label, measured $ per label, F thumbs-down per label, the shift metric. Never a message, never a user id.

### 4.6 Metrics and acceptance thresholds (gate to `act`) — pre-registered

All on human, non-supervisor turns, on the backend that will serve act (a backend change resets the clock; the pin enforces it), evaluated on window B (§4.3) and re-confirmed post-1b. Rows: label-window `user_picked` (+ `owner_rated` post-1b). Every rate: Wilson/bootstrap CI clustered by user, ≥ 20 distinct users per class, ≥ 10 events before any rate is quoted.

| Metric | Threshold (bound, not point estimate) | Sample size |
|---|---|---|
| Telemetry coverage | decision rows ÷ routed sends ≥ 95%; decision↔outcome join ≥ 90% — else the readout is void | per day |
| Decision error rate (`ok=false`) | ≤ 2% | ≥ 2,000 decision rows |
| Decision latency p95 (added TTFB) | ≤ 1,200 ms (budget 1,500); over-budget ≤ 2% | same |
| Coverage at threshold | ≥ 60% — below this, stay in shadow (eval doc §6c) | ≥ 2,000 outcome rows |
| Agreement with heuristic | **Diagnostic only** — report the 3×3 H × gate matrix and audit disagreement cells by option; no floor (a floor would penalise fixing the regex's over-escalations) | — |
| Non-inferiority vs heuristic on U | McNemar-style paired CI on (gate − heuristic) agreement with picked level: 95% lower bound > −2 pp (≈ 3,000–4,000 paired rows at 15% discordance); if volume cannot reach that, widen to −5 pp and state why in memory-bank | ≥ 3,000 paired `user_picked` rows (or ≥ 1,000 with the −5 pp margin) |
| L3 recall | Wilson 95% lower bound ≥ 0.70 on `user_picked` L3 (no thumbs-down) | ≥ 300 picked-L3 rows |
| Over-escalation (gate L3 where U = L1) | Wilson 95% upper bound ≤ 5% | ≥ 300 picked-L1 rows |
| Under-escalation (gate L1 where U = L3) | Wilson 95% upper bound ≤ 15% | ≥ 300 picked-L3 rows |
| Calibration | Top-label ECE ≤ 0.10 (bins from 1/3); Brier ≤ 0.20 once `probabilities` exist; top bucket empirical agreement ≥ 0.90; ECE vs U is reported as an upper bound (U is noisy) beside ECE vs `owner_rated` — temperature is fitted on the cleaner set | ≥ 100 rows in each of the two top buckets |
| L3 promotion under act (simulated from covered rows) | ≤ 1.5× the heuristic's L3 rate on the same rows and ≤ 8% of human turns absolute | ≥ 2,000 rows |
| Cost (measured) | Projected USD/turn delta ≤ +15% vs the heuristic mix (from `run_spend` per level × predicted mix); council runs/day ≤ 1.2× baseline; checker launches/day ≤ 1.1× baseline | ≥ 200 `run_spend` rows per level |
| Former-L1 cohort latency | For messages users historically ran at L1, routed p50 completion ≤ 1.5× the pre-flip L1 p50 (else widen the L1 rule — e.g. short imperative "summarize/explain briefly" — before act) | ≥ 300 rows |
| Outcome proxies | R revised rate on gate-L2 picks the heuristic called L1 ≤ 15%; W zero-search share on L3 picks reported | ≥ 200 rows each |
| Guest segment | Unmeasurable until `meta.segment` lands (legacy guest rows are `sessionId IS NULL`); then L3 promotion ≤ 2× signed-in, else guests keep `allowDeepResearch:false` (Q5); guests out of the act canary until then | ≥ 300 guest rows |
| Post-1b re-check (sufficient condition) | Same bounds on `owner_rated` (≥ 300) or escalation-labelled rows; shift metric reported | ≥ 300 |

If non-inferiority fails: do not flip; refit per-option thresholds on window A; re-evaluate on a fresh window B. If the DeepSeek readout is the only servable backend (TypeSafe key unset), the flip is blocked: unfitted readouts are uncalibrated and a temperature fit would not transfer to Jev.

---

## 5. Verification

### 5.1 Backend tests to add (jest)

- **`platform/auto-router-gate.test.ts` (new):** off returns heuristic; shadow returns heuristic immediately and records `actual=heuristic.level, acted:false, heuristic`; act uses the gate at/above threshold, falls back below; timeout/throw fall open; `allowDeepResearch:false` clamps L3 → `thinking` with `reasonKey:'quota_exhausted'`, `clamped:'quota'`, `actual` pre-clamp; `actEligible:false` behaves as shadow; acting-backend pin compares `spec`, mismatch → shadow + `note:'backend_pin_mismatch'`; the generic `DECISION_GATE_THRESHOLD_AUTO_ROUTE` cannot lower the L3 threshold below `DECISION_GATE_THRESHOLD_AUTO_ROUTE_DEEP_RESEARCH`; `probabilities` persisted on decision and outcome rows; `escalationOf` returns prior level + 1 with `user_escalation`; `segment`/`modeSource` recorded; suites set `DECISION_GATE_MODE_AUTO_ROUTE` explicitly (`decision-gate.hermeticity.test.ts:60-89`).
- **Controller suites (extend `crossmodel.controller.*.test.ts`):** under the switch an explicit `mode=deep_research` from a user is routed, `requestedMode`/`modeSource` stamped; a user-origin send into a supervisor chat never calls `routeMessageAuto`; kid sends never call it; guest at anon limit 0 gets `thinking` + `guest_no_research`, no `RATE_LIMIT_DEEP_RESEARCH_GUEST`; Redis error under the switch → `quota_unavailable` demotion; reserve failure after routing demotes; `browser_agent` bypasses; only `message` text reaches the router; label window fires `note:'user_picked'` only for `modeSource='picked'`, non-blocking, never for guests/mobile/supervisor chats; headers flush + `progress` precede the gate await; `quotaClientIp` derives the client from a forged 2-hop XFF while `getClientIp`/`sameIpSession` are unchanged.
- **`rate-limit.anon.test.ts`:** `checkAnonDeepResearchQuota` mirrors the reserve's key/limit, never increments, fails closed.
- **`platform.service.test.ts`:** user-origin REST send under the switch routes Auto and reserves; supervisor chat excluded; agent origin + stored `deep_research` + no mode → `thinking` with `channel_floor`; omitted origin treated as user; webhook pins (`:1517-1530`) unchanged.
- **`schedule.service` / `orphan-recovery.test.ts:702-729`:** stored `deep_research` replays only with the grant (and reserves); otherwise `thinking` with `routing.clamped:'machine'` in the run args.
- **`chat-agent.service.test.ts`:** metadata carries the widened routing; `chat_search_usage` meta and the `run_spend` stamp carry `mode`/`routingSource`/`clamped`; `isSimpleQuestion` prefers `args.routing.level`; drain RESERVES for a queued L3 (two queued rows, limit 1 → one council); harness-appended "Dig deeper" chip present in `followUps` (if Q4).
- **`telegram` test:** child-owned link never runs the adult agent.
- **New shell pin `scripts/deploy/compose-env-forwarding.test.sh`** (runs in `ci.yml:45-49`): greps that every flag this plan reads — `DECISION_GATE_DEFAULT_MODE`, `DECISION_GATE_MODE_AUTO_ROUTE`, `DECISION_GATE_THRESHOLD_AUTO_ROUTE`, `DECISION_GATE_THRESHOLD_AUTO_ROUTE_DEEP_RESEARCH`, `DECISION_GATE_TEMP_AUTO_ROUTE`, `DECISION_GATE_DISABLED`, `DECISION_GATE_ACT_BACKEND_AUTO_ROUTE`, `PATIENCE_AUTO_ONLY`, `AUTO_ROUTE_ACT_PERCENT`, `AUTO_ROUTE_ACT_USER_IDS`, `LABEL_WINDOW_SAMPLE_PERCENT`, `ANON_DEEP_RESEARCH_DAILY_LIMIT`, `LOOP_METRICS_P0_DISABLED`, `MACHINE_TURN_CROSSCHECK_ENABLED` — appears in BOTH the backend and worker `environment:` blocks of `docker-compose.app.yml` (schedule/hook/orphan fires run in the worker, `backend/src/worker.ts:13-35`) and in `deploy.yml`'s `.env` template.
- Existing pins to keep green: `auto-router.test.ts:8-25`, `decision-gate.test.ts`, `chat-gate.test.ts`, `orphan-recovery.test.ts:272-285`, `webhook.test.ts:168-205`, `platform-tools.session-tools.test.ts:183-214`, `platform-tools.test.ts:319` (59-tool inventory unchanged), `product-watch.service.test.ts:90,94,110` (MODE_LABEL kept as internal tier naming), `route-posture.test.ts:507`, `openapi.test.ts:51-59` (no route added/removed in the MVP). Prisma migration additive (generate + tsc in `ci.yml:80-83`).

### 5.2 Frontend (vitest)

- `plain-session.test.ts:41-45` flips to "routing is carried into `plainMeta.routing`"; `:325-342` asserts `reasonKey`/`reason` survive.
- `patience.test.ts:170-218`: keep the vocabulary pins; drop picker-row title pins.
- Retire/rewrite in the same PR: `PatiencePicker.test.tsx:243-260`, `c1-convergence-smoke.test.tsx:619-657`, `c3-legacy-retirement.test.tsx:107-109/:138-142`, `inplace-conversion.test.tsx:86-92/:108-111`, `p2-measure-touch-pins.test.ts:135`. New pins: no `PatiencePicker` import; send line `mode: 'auto'` for guests and users; no `updateChat({mode})` and no `createChat({mode})` from the page; no stored-mode restore; `modeSource` sent during 1a; `DepthChip` renders copy per `reasonKey`, guest vs signed-in quota lines, nothing for kids; quota badge keys on routing; "Dig deeper" sends `escalate:true` (if Q4).
- `guest-sessions.test.ts:146,156` unchanged.

### 5.3 CI and E2E driver

`ci.yml` runs shell tests (`:45-49`), backend prisma generate + tsc + jest (`:80-91`), frontend tsc + vitest (`:115-122`); `deploy.yml` reuses it (`:72-80`). Local: `cd backend && npx tsc --noEmit && npx jest src/modules/crossmodel/platform src/modules/crossmodel/chat-agent`; `cd frontend && npx tsc --noEmit && npx vitest run app/crossmodel`; `bash scripts/deploy/compose-env-forwarding.test.sh`.

`scripts/test-patience-routing.ts` (stale, `:9-16`, `:24-46`) is rewritten in 1a as the Auto-only E2E driver: registers a throwaway user, sends a labelled prompt set (10 L1-shaped, 10 L2-shaped, 5 L3-shaped, 3 quota-exhaustion, 3 guest, 1 escalation) with no `mode`, asserts `progress` then `routing` on every stream, level distribution, `reasonKey`, zero `RATE_LIMIT_*`, p95 time-to-first-byte and time-to-`routing`, a non-null `sessionId` decision row for the signed-in sends, and zero decision rows for a kid account. Run after every deploy (standing verify-in-production directive).

**Post-deploy checklist (every phase):** health endpoint; DG0925 re-run shows `DECISION_GATE_*` and `PATIENCE_AUTO_ONLY` lines INSIDE `admin-backend-*` and the worker (`playbook.sh:1604`); authenticated no-mode send → `routing` present; guest research-shaped prompt after 2 L3 runs → `routing.clamped='quota'` and a normal answer; kid send → `init {mode:'kids'}`, zero `decision_gate` rows; supervisor chats: council runs = 0; machine-origin council runs/day = 0 unless granted; Telegram child links: adult runs = 0.

### 5.4 Shadow window, canary, act

- **Label window / shadow (1a):** switch off, pickers live, length from Phase 0 volumes (§4.3); readouts at day 3, 7 and window end; the ≥ 14-day act shadow clock starts only from the first day `backend='TypeSafe Jev'` appears in DG0925 — 1a starts regardless (readout-backed rows are still useful for latency/error/volume).
- **1b:** switch on + picker removal, then ≥ 7 days heuristic-only Auto with the gate in shadow, post-1b labelled re-check collected.
- **Canary (Phase 3):** `auto_route_act_percent` (SystemSetting, env `AUTO_ROUTE_ACT_PERCENT` boot default) evaluated at both seams as `hash(userId, else guest sessionId from the registration, else quotaClientIp) % 100 < percent` → `actEligible`; `AUTO_ROUTE_ACT_USER_IDS` forces the owner's accounts first. Non-eligible sends stay shadow and keep writing outcome rows — a **concurrent control cohort**; `actEligible` is stamped on every row. Every monitor is act-vs-control on the same days, never vs a pre-flip week. **Per step:** advance only after ≥ 300 act-cohort human turns (≥ 100 per predicted level for the L3 checks) and cohort sizes are reported. **Stop rule (auto-revert to `auto_route_act_percent=0`):** act L3 share > 1.5× control with n ≥ 300; or thumbs-down `incomplete`+`slow` count ≥ 5 and rate > 2× control; or decision `ok=false` > 2% over 2 h; or p95 added TTFB > 1,500 ms over 2 h. Sequence: allowlist 2 days → 10% 3 days → 50% 3 days → 100%.
- **Guest vs signed-in:** guests are routed from 1b (heuristic) with `allowDeepResearch` from the anon check only after the hop-count fix is deployed and verified; the act canary reaches guests only from the 50% step and only if the guest row of §4.6 passed.
- **Post-flip monitoring (daily, 7 days, query 7):** act vs control level mix, quota clamps, `RATE_LIMIT_*` on user sends = 0, decision error ≤ 2%, p95 ≤ 1,200 ms, F counts per arm (≥ 5 events before a rate), E rate after L1 answers ≤ 8% (if Q4), former-L1 cohort p50, machine/supervisor council runs = 0 unless granted.

### 5.5 Kill switches and rollback — real mechanics

**Two paths, two latencies.**
- **Instant (≤ 60 s cache):** `patience_auto_only` and `auto_route_act_percent` are SystemSettings — an admin PUT `/api/crossmodel/admin/settings/:key` (`crossmodel.routes.ts:494`) flips them without a deploy; env is only the boot default.
- **One deploy (blue-green on A and B via push to `main`; the worker on A picks it up in the same recreate):** every other env flip. Mechanism: either a one-line commit to `deploy.yml`'s `.env` template, or stage a line into `/opt/crossmodel-local/env-overrides.env` via a one-shot (idiom `playbook.sh:1664-1671`) and push a deploy — `apply-env-overrides.sh` folds it into `.env` (`deploy.yml:261-275`) and the recreate injects it; `docker restart` does NOT re-read env. Emergency alternative: a one-shot that edits `/opt/crossmodel/.env` and runs `docker compose -f docker-compose.app.yml up -d --force-recreate` for the active colour on each box. **Prerequisite (1a):** the vars must be listed in `docker-compose.app.yml` (both blocks) or they never reach the container — until that lands every env row below is inert. Time-to-rollback is measured on the first 1a deploy from the run log and recorded in memory-bank (budget 10–20 min).

| Symptom | Flip | Path | Effect |
|---|---|---|---|
| Canary regression | `auto_route_act_percent=0` (SystemSetting) | instant | Act cohort → shadow |
| Auto-only itself is wrong | `patience_auto_only=0` (SystemSetting) | instant | Explicit client levels honoured again for API/mobile; web UI picker returns only via a blue-green revert of the frontend PR (`rollback.sh`) |
| Gate wrong / slow | `DECISION_GATE_MODE_AUTO_ROUTE=shadow` (or `off`) | deploy | Heuristic routes; UX = Phase 1b |
| Gate provider outage | nothing — fails open; watch `ok=false` | — | — |
| Backend changed under act | automatic — pin mismatch ⇒ shadow | — | — |
| Guests should never reach L3 | `ANON_DEEP_RESEARCH_DAILY_LIMIT=0` | deploy | Guests floored at Ensemble |
| Everything | `DECISION_GATE_DISABLED=1` | deploy | All seven purposes off |
| Seat | Account → Admin → Endpoints → Decision gate: clear override | instant (chain cache 30 s) | Falls to built-ins; act auto-drops to shadow via the pin |

Rollback of data: none — the only migration is an additive nullable column; stored modes untouched.

---

## 6. Rollout phases and gates (each gate = metric + threshold + who flips what)

| Phase | Ships | Gate to leave (metric · threshold) | Who flips what (exact env / seat / setting) |
|---|---|---|---|
| **0 — Observe (day 0, ops only)** | Re-run DG0925 under a fresh marker; `XFF0926` hop-count probe (masked `req.ip` vs XFF chain vs socket peer for one known request); AR0926 query 0 (U-snapshot, volumes, human sends/day, explicit share, `messageId` join rate) | Backend answering known; hop count recorded; volumes → label-window length and expected TypeSafe calls/day written to memory-bank; `LOOP_METRICS_P0_DISABLED` confirmed unset | Session pushes the one-shots. Owner: `gh secret set TYPESAFE_API_KEY` if MISSING — 1a starts regardless; the act shadow clock starts on the first `backend='TypeSafe Jev'` day; owner pinged again at 1a + 7 days if still missing |
| **1a — Backend hardening + label window (days 1–3; switch `0`, pickers live)** | Compose/deploy env forwarding for every flag + shell pin; `patience_auto_only` / `auto_route_act_percent` SystemSettings (env boot defaults `0` / `100`); label window (`modeSource`, `LABEL_WINDOW_SAMPLE_PERCENT`, `spec:'deepseek-flash'` until Q1); `probabilities`/`heuristic`/`segment` telemetry; per-option L3 threshold env; acting-backend pin by `spec`; `allowDeepResearch` (fail-closed under the switch) + demotion at both seams; anon check; `quotaClientIp` + trust-proxy hop fix; kid hoist; Telegram `isChild`; supervisor exclusion; machine floor on the RESOLVED level; schedule/orphan clamp + grant; drain reserve + `routing Json?` migration; early header flush + `progress`; `isSimpleQuestion` fix; `run_spend`/`chat_search_usage` stamp `mode`/`routingSource`; Zod stream defaults `'auto'`; harness "Dig deeper" chip (if Q4); frontend: remove stored-mode restore + `createChat`/`updateChat` mode writes, send `modeSource`; mobile item 26; tests; AR0926 block; replay probe; E2E driver | CI green incl. the shell pin; DG0925 shows the flags INSIDE both containers; E2E driver green in prod; 48 h: 0 `RATE_LIMIT_*` on user sends, `user_picked` rows accumulating with the picked/default split reported, telemetry coverage ≥ 95%, guests' quota keys distinct across networks, supervisor/machine council runs = 0 unless granted, `chat_run_interrupted`/`provider_rejected` per level within ±10% | Session deploys (standing directive). Envs land via `docker-compose.app.yml` + `deploy.yml` template in the same commit |
| **1b — Always-Auto + picker removal** | Set `patience_auto_only=1` (SystemSetting PUT; env template `PATIENCE_AUTO_ONLY=1` in the same wave); platform REST default → `'auto'` + doc line; frontend PR: pickers removed, `mode:'auto'` always, DepthChip, quota badge re-keyed, pins rewritten, MCP send override removed | **Pre-flip gates:** label window reached its class minima (§4.3) or the replay substitute is invoked with its caveats; **heuristic cost gate** from query 0 — heuristic L3 share over the last 30 days of human turns users ran at L1/L2 ≤ 8% absolute and projected council runs/day ≤ 1.2× current, else tighten bare `research`/`sources`/`cite` to phrase forms in 1a first (label-window rows then recomputed against the tightened H). **48 h post-flip:** 0 `RATE_LIMIT_*` on user sends; `routing` on 100% of human assistant rows; L3 share ≤ 1.5× and L1 share within ±10 points of the **replayed-heuristic** distribution from query 0 (not the user-pick mix, which is reported only); former-L1 cohort p50 ≤ 1.5×; no `/stream` 5xx rise; F counts per level reported | Session flips the SystemSetting and deploys; owner told in memory-bank |
| **2 — Back-test readouts (≥ 7 days post-1b, no code)** | AR0926 on window B (fit on A); post-1b shadow rows; owner-rated ≥ 300 sample (or escalation labels); replay on 30 days with `spec=deepseek-flash` (+ `jev` after Q1); shift metric | Every row of §4.6 on the acting backend, on window B, clustered CIs; aggregates in memory-bank | Session runs; owner answers Q1/Q5 and rates the sample |
| **3 — Act canary → 100%** | `DECISION_GATE_MODE_AUTO_ROUTE=act` + `DECISION_GATE_ACT_BACKEND_AUTO_ROUTE=jev` (deploy) with `auto_route_act_percent=0`; then `AUTO_ROUTE_ACT_USER_IDS=<owner>` 2 d → `auto_route_act_percent=10` 3 d → 50 3 d → 100 (SystemSetting PUTs) | Each step: ≥ 300 act-cohort turns, act-vs-control monitors within bounds, stop rule not triggered; act-cohort agreement within 3 points of Phase 2; thumbs `incomplete` on gate-L1 turns ≤ 1.5× control | Session after posting each step's numbers (Q6 — the first `act` deploy is the natural owner step) |
| **4 — Cleanup + re-shadow items (after 7 days at 100%)** | Doctrine/docs rewrite (§7.4); Telegram routed L1/L2 (guarded); allowed-levels question shape; pasted-block stripping; state enrichment; `set_chat_mode` decision (Q2); `createChat` default; admin `modeCounts`; stale copy | Each state/question change: ≥ 7-day re-shadow, §4.6 re-passed on window B | Session |
| **5 — Open-weights seat swap** | §8 | Per-backend re-pass of §4.6 | Owner picks the seat in Account → Admin → Endpoints; session updates the pin env by deploy |

---

## 7. Code change list by file (in order; descriptions, no code)

### 7.1 Phase 1a — backend and ops

1. `docker-compose.app.yml` (backend `environment:` `:16-160` and worker `:225-345`) + `.github/workflows/deploy.yml` `.env` template (`:180`, `:594` idiom) — forward every flag listed in §5.1; new `scripts/deploy/compose-env-forwarding.test.sh`.
2. `backend/src/modules/crossmodel/platform/decision-gate.ts` — `DecideResult.spec`; `compactAnswers` keeps `probabilities` for choice answers (`:551-559`); outcome rows persist `probabilities`, `heuristic`, `segment`, `modeSource`, `reasonKey`, `clamped` (`:656-690`); `decisionThreshold` gains an optional per-option env (`DECISION_GATE_THRESHOLD_AUTO_ROUTE_DEEP_RESEARCH`, floor 0.85 unless set explicitly) (`:163-167`).
3. `backend/src/modules/crossmodel/platform/auto-router-gate.ts` — inputs `allowDeepResearch`, `actEligible`, `segment`, `modeSource`, `escalationOf`; post-decision clamp; `reasonKey` on every outcome; `AutoRouteOutcome` widened (`source, confidence, heuristicLevel, backend, spec, clamped, reasonKey`); pin by `spec` with `note:'backend_pin_mismatch'`; canary read from the SystemSetting/env; per-option threshold; export `shadowAutoRouteAgainst(input, actualLevel, note, opts)` (label window; `spec` override; `LABEL_WINDOW_SAMPLE_PERCENT`).
4. `backend/src/modules/crossmodel/rate-limit.service.ts` — `checkAnonDeepResearchQuota(ip)` (non-reserving twin of `:177-201`, fails closed); `deepResearchAllowance({userId, ip, strict})` returning `{allowL3, remaining, limit, reasonKey}` — `strict` (the switch) fails closed on Redis error; SystemSetting readers for `patience_auto_only`, `auto_route_act_percent` on the 60 s cache with invalidation on admin PUT (`controller:2418-2420` idiom).
5. `backend/src/app.ts:52` — `trust proxy` set to the probed hop count (or loopback + ALB CIDRs); `backend/src/modules/crossmodel/crossmodel.controller.ts` — (a) new `quotaClientIp(req)` beside `getClientIp` (`:76-80`, untouched) used only by the anon allowance/reserve and the canary hash; (b) hoist `isChild` (`:1317-1324`) above `:1151`; (c) supervisor exclusion + switch override before `:1158`, `requestedMode`/`modeSource` retained; (d) label window call when the switch is off and `modeSource='picked'` (never guests/mobile/supervisor); (e) allowance + `actEligible` + `segment`; (f) flush headers + `progress` before the gate await, audit error paths `:1174-1273`; (g) reserve failure under the switch demotes (`:1590-1610`); (h) enqueue stores routing (`:1490-1530`); (i) `escalate` flag → `escalationOf`; (j) log `:1177` gains `source/reasonKey/clamped/segment`.
6. `backend/src/modules/crossmodel/crossmodel.validation.ts:14, :93` — defaults `'auto'`; `modeSource` and `escalate` optional fields; enums unchanged. (`platform.validation.ts:54` untouched until 1b.)
7. `backend/src/modules/crossmodel/platform/platform.service.ts:814-846, :920-1030` — user-origin (incl. omitted origin) sends honour the switch, skip supervisor chats, compute allowance, **reserve** before start with demotion; machine floor on the RESOLVED level with `channel_floor`; label window for user-origin picked sends.
8. `backend/src/modules/crossmodel/coding/schedule.service.ts:2870-2871, :2939, :2981-2987` and `chat-agent/orphan-recovery.ts:273-276, :384-385, :428-445` — clamp unless `allowScheduledCouncil` grant; armed fires reserve; pass `routing {channel_floor, clamped:'machine'}` into the run args.
9. `backend/src/modules/crossmodel/chat-agent/chat-agent.service.ts` — routing type widened (`:1151-1156`); `isSimpleQuestion` prefers `args.routing.level` (`:1816-1817`); drain reserves for a queued L3 and writes the demotion (`:868-880`); `chat_search_usage` meta + the `chatMetricStamp` (`:2420-2426`) gain `mode`, `routingSource`, `clamped`, `actEligible` (`:3306-3318`); persisted routing widened (`:3366-3371`); `complete` carries it (`:3704`); harness-appended "Dig deeper" chip after `[FOLLOWUPS]` parsing (`:205`) with `kind:'escalate'` (if Q4).
10. `backend/src/modules/crossmodel/chat-agent/message-queue.service.ts:85-96` + `backend/prisma/schema.prisma:316-335` — additive `routing Json?` on `pending_chat_messages` (migration).
11. `backend/src/modules/crossmodel/telegram/telegram.controller.ts:188-200` — `isChild` guard.
12. `backend/src/modules/crossmodel/platform/session-tools.ts:44-58` and `platform-tools.ts:245-262` — description text only.
13. `backend/src/modules/crossmodel/platform/loop-metrics.service.ts:862-905` — `run_spend`/`run_tokens_*` accept `mode`/`routingSource` on the stamp (no new kind).
14. Tests per §5.1 (new `auto-router-gate.test.ts`; extended controller, rate-limit, platform.service, schedule/orphan, chat-agent, telegram suites; shell pin).
15. `scripts/ec2-ops/playbook.sh` above `:1628` — `XFF0926` hop-count probe, `AR0926` block (§4.4 queries 0–7 with `:from/:to`), re-armed DG0925 marker.
16. `scripts/framework-audit/backtest-auto-route.js` (new, §4.5); `scripts/framework-audit/README.md` usage line.
17. `scripts/test-patience-routing.ts` — rewrite as the Auto-only E2E driver (§5.3).
18. `.env.example:806-824` — document `PATIENCE_AUTO_ONLY`, `AUTO_ROUTE_ACT_PERCENT`, `AUTO_ROUTE_ACT_USER_IDS`, `LABEL_WINDOW_SAMPLE_PERCENT`, `DECISION_GATE_ACT_BACKEND_AUTO_ROUTE`, `DECISION_GATE_THRESHOLD_AUTO_ROUTE_DEEP_RESEARCH`, and that `deep_research_daily_limit`-style SystemSettings override the boot envs.
19. Frontend, 1a (before the label window opens): `frontend/app/crossmodel/page.tsx:1610-1617` delete the stored-mode restore; `:1944` `createChat` sends no mode; `:2566-2567` no `updateChat({mode})`; send `modeSource` (`:1919`; `plain-session.ts:462`) set to `picked` only when `setPatienceLevel` ran this session; `packages/api/src/streaming.ts:267, :296` and `apps/mobile/app/chat/[id].tsx:293-297` send no mode (item 26 moved to 1a).
20. `memory-bank/crossmodel-activeContext.md`, `crossmodel-progress.md` — dated entry (same commit, CLAUDE.md rule 2), including measured deploy/rollback time.

### 7.2 Phase 1b — switch flip + frontend

21. SystemSetting `patience_auto_only=1` via admin PUT — **DONE in prod 2026-09-26 20:35:16Z (unattributed; see Status)**; `deploy.yml` template `PATIENCE_AUTO_ONLY=1` — **NOT done** (owner-guarded file; the env is unset on every box, the row alone holds the switch ON); `platform.validation.ts:54` default `'auto'` + `docs/DIGBY_PLATFORM_API.md:59-63` / `frontend/content/help/platform-api.md:59-63` line change in the same commit — open.
22. `frontend/lib/api/coding.ts:144-150` — `PlainMessageMeta.routing?: {level, reasonKey, reason?, source?, clamped?, confidence?, suggestCode?, escalationOf?}`.
23. `frontend/app/crossmodel/plain-session.ts:178-181, :342-352, :462, :484, :491` — keep `routing` as a live status part; `buildPlainMeta` forwards `reasonKey/clamped`; builders send `mode=auto` (+ `escalate` when set); `mapPlainMessages` forwards `metadata.routing` on reload.
24. `frontend/app/crossmodel/components/DepthChip.tsx` (new) — level from `PATIENCE_SHORT` + tooltip table keyed by `reasonKey` and guest/signed-in; nothing for kids; mounted in the streaming header and `code-transcript.tsx:1281-1333` replacing the mode badge; "Dig deeper" chip renders from `followUps[].kind==='escalate'` and sends the structured flag (`code-transcript.tsx:1131-1146`; `CodeSessionView.tsx:3058` onPick path).
25. `frontend/app/crossmodel/page.tsx` — remove `PATIENCE_MAP`/`REVERSE_MAP` send usage (`:293-294`); mode state constant `'auto'` (`:352-355`); delete `guestMode` (`:361-364`); send `'auto'` (`:1919`, `:3625`); delete `setPatienceLevel`/`selectAutoMode` (`:2551-2577`); drop patience props (`:2855-2870`, `:2911-2927`); remove picker mounts (`:3698-3716`, `:4409-4432`); re-key quota badge (`:4273-4288`).
26. `frontend/app/crossmodel/components/PatiencePicker.tsx` — delete; `FloatingChrome.tsx:117-129, :248-277` remove group, re-key "New chat" (`:235`, `:409`); `SessionSettingsSection.tsx:45-51, :185-205` remove group; `ChatComposer.tsx:65-68, :220`, `lib/workspace-sections.ts:537-542` comments; `CodeSessionView.tsx:716-717, :750-751, :779-784, :1776, :2362, :2449, :3366-3369` drop mode plumbing and the guest doc line.
27. `frontend/lib/preferences.ts:19-61` — legacy `patienceMode` parsed and ignored; `normalizePatienceMode` returns `'auto'`.
28. `frontend/lib/api/crossmodel.ts:20, :68, :243-245, :266, :571` — client mode params removed (server still accepts them).
29. `frontend/app/crossmodel/patience.ts:27-52` — labels/descriptions kept as chip vocabulary; picker titles dropped; `AUTO_DESCRIPTION` → tooltip header / placeholder.
30. `frontend/app/crossmodel/shared/chat/[token]/page.tsx:129-141` — badge gains the reason; `account/ModelRolesSection.tsx:206`, `model-display.ts:46-47` wording; `AdminTab.tsx:628` copy.
31. `digby-mcp/src/tools/digby.ts:18-37, :83, :131` — `mode` kept only as the list filter; send override removed.
32. Tests per §5.2.

### 7.3 Phase 2 — no code (readouts, replay, owner-rated sample, memory-bank aggregates).

### 7.4 Phase 4 — cleanup and re-shadow items (separate PRs)

33. Doctrine: `chat-context.ts:343-350` ("Digby chooses the answer depth per message; users ask for more or less in words") + `chat-context.test.ts:538-561` (keep the `'4 thinking levels'` negative pin and ≤ 4900 cap); `capability-doctrine.ts:90, :105`; `supervisor.service.ts:211`; `model-roles.service.ts:216-218` ("runs ACT for auto_route") and `:39, :70, :121, :206, :217`.
34. Docs: CLAUDE.md:14-22, :512-521, :719, :745, :832; AGENTS.md:24, :1561, :3289-3291 (+ dated 2026-09-25 bullet); docs/DIGBY_PLATFORM_UNIFICATION_PLAN.md:357-393 (superseded note); docs/JEV_DECISION_MODELS_DIGBY_EVAL_2026-09-24.md:48, :316-336, :420-431 (new ground truth: `user_picked` window, escalation, owner-rated; act row; env `DECISION_GATE_MODE_<PURPOSE>=act`); docs/SELF_HOST.md:165, :186-190; docs/api-reference.md:45, :72; README.md:19, :273, :301; .env.example:776, :817; `scripts/test-patience-routing.ts` header. `product-watch.service.ts:45-51` MODE_LABEL ("Level N (…)") and its test pins are **intentionally kept** as internal tier naming for owner alerts.
35. `telegram.controller.ts:188-200` → `routeMessageAuto` with `allowDeepResearch:false`, `segment:'telegram'` (conditional on the 1a `isChild` guard); `auto-router-gate.ts` allowed-levels criteria (`note:'reduced_criteria'`) and pasted-block stripping — each behind its own re-shadow; `crossmodel.service.ts:64` default `'thinking'`; `feed.service.ts:281-283`, `context.service.ts:700-704` stop writing `'fast'`; `controller:2611-2617` buckets; `set_chat_mode` / `PATCH mode` removal or `deep_research` dropped from its enum if Q2 says so (tool-count pin 59 → 58; `openapi.json` regen only if a path changes).

---

## 8. Open-weights swap readiness (JevK5 / NeoHorse-Jev / Kev / any systemone or logprobs server)

- **Mechanism exists.** The `decision` seat accepts a registry endpoint of shape `systemone` or a logprobs-capable OpenAI-compatible server (`decision-gate.ts:218-231`, `:501-516`; validation `model-roles.service.ts:869-881`), set in Account → Admin → Endpoints with the Test button (`probeDecisionSpec`, `:1461-1465`). Chain cache 30 s (`:122`); every row carries `meta.backend` (label) and, from 1a, the `spec`.
- **Safe by construction.** `DECISION_GATE_ACT_BACKEND_AUTO_ROUTE` pins the acting backend by `spec`; any seat change makes `routeMessageAuto` behave as shadow (rows `note:'backend_pin_mismatch'`) until the pin is updated by deploy — nobody can act on thresholds fitted to another backend.
- **Procedure.** Register the endpoint → set it as the seat's custom fallback for 3 days (smoke test of `ok` rate and latency; it answers only when Jev fails) → set it as the seat model (act auto-drops to shadow) for ≥ 7 days / ≥ 2,000 rows → replay with `spec=<label>:<model>` on the historical corpus (self-hosted ⇒ no third-party egress; Q1 moot; the full 90-day history usable) → AR0926 filtered on the new backend, window A fit / window B test → update the pin and thresholds only when §4.6 passes for that backend.
- **Calibration re-check specifics.** Refit `DECISION_GATE_THRESHOLD_AUTO_ROUTE` and `..._DEEP_RESEARCH`; for logprob-shaped backends fit `DECISION_GATE_TEMP_AUTO_ROUTE` (`:172-178`) on window A only. Thresholds are per purpose, not per backend: if two backends serve concurrently one threshold applies to both — accept for a fallback answering < 5% of calls, otherwise add a per-backend threshold env (Phase 5 code item). Re-measure ECE with the `probabilities` field, top-label bins from 1/3.
- **Readiness checklist.** Endpoint reachable from boxes A/B (outbound allowlist); p95 ≤ 600 ms from the boxes; systemone parsing pinned with `decision-gate.test.ts:150-184`-style fixtures; admin model-map row (`model-roles.service.ts:800-808`) shows the chain; the compose env lists already forward whatever the endpoint needs. Not before Phase 4 has settled — swapping the judge while the product change is settling confounds F/E/O signals.

---

## 9. Risks and mitigations

| Risk | Where | Gate / metric | Mitigation | Rollback |
|---|---|---|---|---|
| Auto picks L3 for an out-of-quota user/guest → stream errors | `controller:1590-1610` | 0 `RATE_LIMIT_*` on user sends (48 h) | Pre-check + demotion with `reasonKey` (§3.4) | `patience_auto_only=0` (instant) |
| Guest quota key collapses onto the ALB IP (two guest L3 runs exhaust everyone; `sameIpSession` passes for all guests) or is header-spoofable | `app.ts:52`; `controller:76-80`, `:1041-1051` | Phase 0 probe; distinct keys across networks | Hop-count fix + dedicated `quotaClientIp`; guests off L3 and out of the canary until proven | `ANON_DEEP_RESEARCH_DAILY_LIMIT=0` (deploy) |
| Kill switches inert — env never reaches the container / overrides fold only on deploy | `docker-compose.app.yml:30-31`; `deploy.yml:261` | DG0925 shows flags inside containers; shell pin green | Compose + template listing in 1a; instant switches moved to SystemSetting | n/a |
| Supervisor chat routed to a council by a research-shaped owner message | `fleet.service.ts:941`; `chat-agent.service.ts:2276` | supervisor council runs = 0 | Supervisor exclusion at both seams, pinned | n/a |
| Redis outage converts to unmetered councils with no human bound | `rate-limit.service.ts:144-147` | `quota_unavailable` demotions counted | Allowance fails CLOSED under the switch | n/a |
| Queued L3 rows run unmetered at drain | `controller:1517`; `chat-agent.service.ts:868-880` | queued councils ≤ reserved | Drain RESERVES; refusal demotes | n/a |
| Agent-origin send inherits a stored `deep_research` | `platform.service.ts:830`; `session-tools.ts:128-138` | machine council runs = 0 unless granted | Floor on the RESOLVED level; stored L3 inert without the grant | remove grants |
| Shadow agreement rewards regex mimicry | `auto-router-gate.ts:50` | U-based non-inferiority bounds; H agreement diagnostic only | Label window (`user_picked`), owner-rated post-1b sample, replay | n/a |
| `user_explicit` contaminated by guest/mobile/restored defaults | `page.tsx:361-364`, `:1610-1617`; `streaming.ts:296` | picked/default split reported | `modeSource`; restore + mode writes removed in 1a; guests/mobile excluded | n/a |
| Per-option Brier/ECE uncomputable; 0.5-floored bins mis-bucket | `decision-gate.ts:551-559`, `:656-690` | Brier gate applied only once `probabilities` exist | Persist the vector; bins from 1/3 | n/a |
| Distribution shift after picker removal invalidates pre-flip labels | `auto-router.ts:50-51` | shift metric; post-1b re-check | Owner-rated / escalation labels post-1b are the sufficient condition | n/a |
| Point-estimate gates pass or fail on noise | §4.6 | CI bounds, clustered by user | Pre-registered bounds and minima; fit/test split | n/a |
| Label window is new third-party egress; volume unknown | `auto-router-gate.ts:32`; `decision-gate.ts:204-211` | Q1; Phase 0 volumes | `spec:'deepseek-flash'` + `LABEL_WINDOW_SAMPLE_PERCENT` until Q1 | set percent 0 |
| Prod backend is the uncalibrated DeepSeek readout | memory-bank 2026-09-25 | `backend='TypeSafe Jev'` in DG0925 | Act blocked unless Jev answered window B | n/a |
| Heuristic-only Auto for weeks promotes on bare words | `auto-router.ts:50-51` | pre-1b: heuristic L3 share ≤ 8%, council runs/day ≤ 1.2× | Tighten triggers in 1a if the gate fails; quota is the hard bound | n/a |
| Former-L1 users see slower default answers with no opt-down | `agent-profiles.ts:94-116` | former-L1 cohort p50 ≤ 1.5× | Widen the L1 rule before act; escalation/words | n/a |
| Act adds up to 1.5 s dead air before the first byte | `controller:1174` vs `:1273` | p95 ≤ 1,200 ms; over-budget ≤ 2% | Early flush + `progress`; canary; fail-open | `auto_route_act_percent=0` |
| Jev outage / 429 → silent fallback; unservable seat writes no rows | `decision-gate.ts:381-386`, `:620-625` | `ok=false` ≤ 2%; telemetry coverage ≥ 95% | Coverage metric blocks readouts; seat fallback | `DECISION_GATE_MODE_AUTO_ROUTE=shadow` |
| One threshold env cannot express the per-option refit | `decision-gate.ts:163-167` | pin: generic env cannot lower L3 | Per-option L3 env in 1a | env |
| Prompt-steered promotion to council runs | `auto-router-gate.ts:32` | L3 promotion ≤ 1.5×, ≤ 8% abs | Quota bound; L3 ≥ 0.85; only typed text routed; Phase 4 stripping | threshold env |
| Kids routed via Telegram or SSE | `controller:1158` vs `:1317`; telegram (no guard) | kid decision rows = 0; child adult runs = 0 | Kid hoist + Telegram guard, pinned | n/a |
| "Dig deeper" text poisons H and E | `auto-router.ts:50-51` | escalation rows excluded from pools | Structured `escalate` flag, harness-appended chip | n/a |
| Canary compared to a different-population week; no stop rule | §5.4 | act-vs-control same days; per-step n; stop rule | Concurrent control cohort; guest hash on session id | `auto_route_act_percent=0` |
| Cost gate rests on asserted multipliers | — | measured USD per level | `run_spend` rows (exist for chat runs) stamped with `mode` | n/a |
| loop_metrics 30-day reaping / lossy buffer / P0 kill | `loop-metrics.service.ts:1147`, `:746-771`, `:659-663` | `min(createdAt)` printed; env unset | Snapshots to memory-bank; no re-eval past now − 28 d | n/a |
| Replay pollutes live gate telemetry | `decision-gate.ts:635`, `:644` | none | Probe stubs `recordLoopMetric`; `backtest:` prefix excluded | n/a |
| Two judges disagree in one turn | `chat-agent.service.ts:1816-1817` | none after fix | `isSimpleQuestion` reads `routing.level` | n/a |
| API/MCP/mobile clients keep sending levels → 400s or silent L1 | `crossmodel.validation.ts:14`, `:93`; `streaming.ts:296` | zero 4xx on mode | Accept-and-ignore; mobile item 26 in 1a | `patience_auto_only=0` |
| Source-string vitest pins block deploy | c1/c3/inplace/p2 tests | CI green | Rewritten in the same frontend PR | n/a |
| Switch-off rollback leaves the web UI without a picker | frontend PR | — | SystemSetting is the first flip; UI revert is `rollback.sh` | `rollback.sh` |
| L2 unmetered for everyone (25 req/10 min per IP only) | `app.ts:196-208` | checker launches/user/day distribution | Observe in 1b; cap is Q7 | n/a |

---

## 10. Open questions for the owner (only those that change the work)

> **SUPERSEDED 2026-09-26/27 (recorded 2026-09-28, backlog audit DOI-26) — none of Q1–Q7 is open.**
> Q1 answered 2026-09-26 (the back-test ran over all user chats on the SEAT backend — `LABEL_WINDOW_DEFAULT_SPEC 'seat'`).
> Q2 / Q3 / Q6 superseded by the ONE per-send resolver `platform/send-mode.ts resolveSendMode` + the Auto-default (AGENTS.md "2026-09-26 (audit, branch `audit/unify-routing`)" and "Auto is THE default" bullets): machine overrides keep a floor, a scheduled council is clamped to Ensemble (`supervisor_no_research` / `channel_floor`), and the flip authority was exercised — `patience_auto_only=1` since 2026-09-26 20:35Z.
> Q4 "Dig deeper" SHIPPED as the compute policy's one control (cp/harness, `docs/DEPTH_UX_SOTA_2026-09-26.md`).
> Q5 guests keep Deep Research via the per-IP allowance (`ANON_DEEP_RESEARCH_DAILY_LIMIT`, default 2).
> Q7 L2 checker cap superseded by the owner's "no hidden cost caps" (2026-09-27): the only cost cap is a user-set `ProjectSettings.spendCapUsdPerDay`.
> The questions below are kept as the record of what was asked.

1. **Egress (replay AND label window).** May the back-test send historical user messages (≤ 4,000 chars, last 30 days, human turns) and, during the label window, live messages of users who did NOT pick Auto to TypeSafe's hosted Jev from box A? If not, both run on the DeepSeek readout only, and the Jev evidence for act comes solely from `'auto'` sends plus the post-1b owner-rated sample.
2. **Machine overrides.** Does "not changeable by users" extend to agents and the platform API? The plan keeps `set_chat_mode` and per-message machine `mode` with a floor on the resolved level; say the word and Phase 4 drops `deep_research` from the enum or removes them (59-tool pin, public API docs, possible `openapi.json` regen).
3. **Scheduled council.** Stored `deep_research` on schedule/hook/orphan fires is clamped to Ensemble unless the chat carries an owner-armed grant that reserves your quota. Confirm the default-clamp posture, or name lanes to pre-arm.
4. **"Dig deeper".** A harness-appended one-tap follow-up that sends a structured escalation (prior level + 1), not a level control. Acceptable under "not changeable"? It is the strongest post-removal ground-truth signal; without it the post-1b labels are your rated sample and thumbs.
5. **Guests.** Keep Deep Research reachable for guests via Auto within the 2/day per-IP allowance (after the hop-count fix is proven), or pin guests to Quick/Ensemble (`ANON_DEEP_RESEARCH_DAILY_LIMIT=0`)? Decides whether anonymous traffic ever hits the decision seat under act.
6. **Flip authority.** The plan assumes the session flips `patience_auto_only` and each canary step after posting that gate's numbers, and that the first `act` deploy is yours. Confirm or name other steps you want to flip personally.
7. **L2 checker cap.** Once everyone is on Auto, L2 (two full agentic loops) is the default cost with no per-user meter. Add a per-user daily checker cap now, or observe for a cycle first? The plan observes.

---

## Critique log

**Applied (50)**
- CT-1 / CO-2 / RA-1 (blocker): `req.ip` is the ALB under `trust proxy 1` — replaced with a Phase 0 hop-count probe, `trust proxy` fix, dedicated `quotaClientIp`, guests off L3 + out of the canary until proven (§2, §3.4, §7.1 item 5).
- CT-2 / CO-5 (blocker/major): env flips are deploys, not restarts; instant switches moved to SystemSetting; time-to-rollback measured (§5.5).
- CO-1 (blocker): compose forwards only listed vars — all flags added to both `environment:` blocks + template + shell pin; Phase 0 verifies inside containers (§5.1, §6, §7.1 item 1).
- CT-3 / CO-3 (major/blocker): supervisor chats excluded from the override and label window at both seams; pinned (§3.6).
- CT-4 (major): `run_spend` rows exist for chat runs — cost is measured USD; static caps demoted to a cross-check (§4.2, §4.6).
- CT-5 (major): routing chip cannot explain the act wait — headers flushed + `progress` emitted before the gate await; act wait budgeted as TTFB (§3.1, §4.6).
- CT-6 / CO-9 / RA-3 (major): label window is new third-party egress — folded into Q1, DeepSeek spec until answered, sample-percent throttle, Phase 0 volume baseline (§4.1, §4.3, Q1).
- CT-7 / CO-10 / RA-10 (major/minor): `userId` is non-nullable; guests = `sessionId IS NULL` on legacy rows plus a new `meta.segment`; guest row marked unmeasurable until it lands (§4.2, §4.4, §4.6).
- CT-8 (minor): Telegram sessions are `anon-telegram:%` and never reach the router (§4.2).
- CT-9 (minor): backend label is `'TypeSafe Jev'`; pin uses `spec` (§3.2, §4.4).
- CT-10 (minor): ECE 0.45 attributed to raw Qwen3-4B logits, not DeepSeek (§2).
- CT-11 / RA-7 (minor/major): anon pre-check and, under the switch, the signed-in allowance fail CLOSED (§3.4).
- CT-12 / ST-10 (minor/major): "Dig deeper" is a harness-appended chip sending a structured `escalate` flag, excluded from H/gate pools, outcome written against the prior decision (§3.8).
- CO-4 / RA-4 / ST-1 (major/blocker): `user_explicit` contaminated — `modeSource=picked|default|restored` sent by the client, restore + mode writes removed in 1a, guests/mobile excluded, split reported (§3.9, §4.2, §7.1 item 19).
- CO-6 / RA-6 (major): machine floor applies to the RESOLVED level incl. stored mode; omitted origin = user; test added (§3.6).
- CO-7 (major): Phase 1b level-mix gate compares against the replayed-heuristic distribution (§6).
- CO-8 (major): floored-run row rides the run's existing rows via `routing` in the run args — no new metric kind (§3.6).
- CO-11 (minor): `product-watch` MODE_LABEL intentionally kept as internal tier naming (§7.4 item 34).
- CO-12 (minor): Phase 0 no longer blocks on the owner; act shadow clock starts on the first Jev day; owner re-pinged (§6).
- CO-14 / RA-13 (minor): platform REST default untouched until 1b; doc line changes in the same commit (§3.1).
- RA-2 (major): busy-queue drain RESERVES for a queued L3 (§3.4).
- RA-5 (major): mobile sends an explicit mode — item 26 moved to 1a, mobile excluded from the label window meanwhile (§3.6).
- RA-8 (major): per-option L3 threshold env added; generic env cannot lower it (§3.2).
- RA-9 (major): pre-1b heuristic cost gate (L3 share ≤ 8%, council runs ≤ 1.2×) else tighten triggers in 1a (§6).
- RA-11 (major): Telegram `isChild` guard in 1a; Phase 4 Telegram Auto conditional on it (§3.5).
- RA-12 (major): former-L1 cohort latency gate (§4.6).
- RA-13 (minor): pin on `spec` + `note:'backend_pin_mismatch'` counted in query 1 (§3.2).
- ST-2 (blocker): `probabilities` persisted; Brier defined; bins from 1/3; Brier gate deferred until the field exists (§3.2, §4.4).
- ST-3 (blocker): shift metric + post-1b owner-rated/escalation re-check as the sufficient condition (§4.1, §4.6).
- ST-4 (major): gates rewritten as confidence bounds with minima and user-clustered CIs (§4.6).
- ST-5 (major): heuristic agreement demoted to a diagnostic (§4.6).
- ST-6 (major): pre-registered fit/test window split (§4.3).
- ST-7 (major): canary monitors act-vs-control, per-step minimum n, stop rule, guest hash on session id (§5.4).
- ST-8 (major): telemetry coverage + decision↔outcome join rate gate (§4.3).
- ST-11 (major): `meta.heuristic` on every outcome row; query 2 is three-way (§3.2, §4.4).
- ST-12 (major): `messageId` join rate + fallback join; F as counts with minima, act vs control (§4.2).
- ST-13 (minor): ECE vs U reported as an upper bound; temperature fitted on the cleaner label set (§4.6).
- ST-14 (minor): label-window length derived from Phase 0 volumes; replay substitute's contamination stated (§4.3, §4.1).
- ST-15 (minor): `min(createdAt)` printed; no re-eval past now − 28 d; snapshots (§4.3).

**Rejected (1)**
- ST-9 premise ("no chat-run cost rows exist; recordRunSpend is coding-only") — rejected: `recordRunSpend` is ungated for every top-level run since 2026-09-13 (`coding/agent.ts:4560-4565`; chat runs go through `runCodingAgent` at `chat-agent.service.ts:2427`), so `run_spend`/`run_tokens_*` rows DO land for chat runs; the finding's intent (measure, do not assert) is applied via CT-4 with the wall-clock proxy kept only as a cross-check.
