# Ambitious prompting — integration map (2026-10-15)

Owner ask (2026-10-15): read and analyze *"How to be more ambitious: A tutorial for humans
with models"* (published 13 October 2026) and find places to add its prompts and learnings
into Digby — framework, chats, coding sessions, etc.

Status: **analysis + integration map — awaiting the owner's pick.** Nothing runtime was
changed this run; every recommendation below carries drop-in text and the exact surface
(file:line, read this session) it would land on. Sequencing proposal in §7.

The essay's frame: model capability is uneven, and the difference between users who "fly"
and users who stall is mostly **how they ask**. Four ambition types — **Speed** (same work,
less time), **Altitude** (the outcome above the task), **Depth** (the instruments and
standards of the field's best), **Range** (fields and techniques beyond the obvious one) —
plus a psychology backing (self-efficacy: specific hard goals beat "try your best"; believing
a thing possible, watching someone do it, and permission to fail all raise what gets
attempted). Speed is "bread and butter" and needs no doctrine; the map covers the other
three plus the psychology.

---

## 1. Where Digby ALREADY embodies the essay (keep — this is doctrine rationale)

Recording the resonances matters: they are the "why" behind designs that otherwise look
arbitrary, and future tuning should not erode them.

| Essay technique | Digby surface (verified this run) | Verdict |
|---|---|---|
| **Outside judge** — "Do not ask the model to judge itself" | The whole L2/L3 architecture: the Double Checker is an independent agentic peer with its own tools (`chat-agent.service.ts:3153` checkerDoctrine — "You are an independent CROSS-CHECKER — a different frontier model answering the SAME user question in parallel"); the ticket lane refuses self-review merges beyond a small fix (`feedback/ticket-dispatch.service.ts:293` — "Self-review alone NEVER merges… self-review shares your context, your blind spots, and your confabulation pressure"); the reviewer is spawned with a FRESH context handed only the diff | **Fully embodied** — Digby is a working implementation of this paragraph |
| **Assemble the crew — but don't roleplay** ("Don't ask the model to write a short seller, ask it to do what a short seller does") | `coding/roles.ts:91-165` — all nine delegate roles are FUNCTIONAL (planner, architect, explorer, researcher, cross-checker, coder, editor, verifier, reviewer), never personas; council personas are seat labels with duties (Double Checker = "analytical deep-diver… rigorous, quantitative, source-critical", `chat-agent.service.ts:1975`) | **Fully embodied by design** |
| **Specific hard goals** (Locke & Latham) | `update_plan` acceptance criteria; ticket `CLAIM_BAR` (`ticket-dispatch.service.ts:230`); KPI premise contracts (`goal_premise_set` bar/receipt rules) | **Embodied** |
| **Permission to fail** (Inner Game of Tennis) | Harness prompt, `coding/agent.ts:1122` — "an honest incomplete is a pass; an uncited completion claim is a fabrication strike" | **Embodied** — this is exactly the essay's point, stated as an anti-fabrication rule |
| **Give the model all the data** | 3-tier memory + `[RELEVANT LEARNINGS]` + `[CODE INDEX MATCHES]` + `[SESSION MEMORY INVENTORY]` injected at run start (`coding/agent.ts:1454-1484`); chat side: `buildChatQueryContext` (memory, history, project RAG, Workspace data) | **Embodied** |
| **A computer with software + connectors** ("all ways… require the model to have a computer… and access to data") | Coding worktrees with full shell; MCP connectors (Slack/Asana/Google/GitHub/X/Discord/Telegram/iMessage/HF); `web_pipe`/`youtube_pipe` bulk ingestion | **Embodied** — Digby already satisfies the essay's precondition |
| **Challenge what you know, adversarially** | Reviewer role ("REFUTE merge-safety", `ticket-dispatch.service.ts:291`); cross-checker scope rules (`chat-agent/cross-check-scope.ts:60-133`) | **Embodied in code + review; absent in chat answers** (see A3) |

No change needed for these. The recommendations below are the parts the essay has that
Digby's prompts do not yet say out loud.

---

## 2. Integration map — chat product

### A1. "Dig deeper" research rung — the essay's altitude moment · **TUNE**

`chat-agent/compute-policy-wiring.ts:610` `escalationUserNote(rung)` — the harness note the
escalation run carries. Current research-rung text: *"verify the earlier answer's key
claims, correct what was wrong, add what was missing."* That is verification (the essay's
"outside judge"), but the research rung is also the natural place for the essay's depth
moves — challenge assumptions from primary sources, don't just re-verify claims.

Drop-in (research rung only):

> `[DIG DEEPER — the user asked for a deeper look at your earlier answer to this question. Lead the research council on it now: verify the earlier answer's key claims against primary sources, challenge its underlying assumptions (not just its facts), correct what was wrong, add what was missing. Write "Deeper findings" as a complete stand-alone answer.]`

Tests to update in the same PR: `chat-agent.compute-policy.test.ts` (pins escalation
behavior and `"Deeper findings"` rows) and `research-rung-wording.test.ts` (pins
`PROGRESS_LINES`; check whether it asserts the note verbatim before touching).

### A2. Council colleague autonomy charter — depth + range lines · **TUNE**

`chat-agent.service.ts:2006-2011` `councilColleagueDoctrine` — the charter already carries
"Plan your own approach. Start broad, then narrow" and "You are done ONLY when you judge the
mission answered." Missing, per the essay: the *instruments* rule and the *new knowledge*
rule.

Drop-in (two charter bullets):

> `- Insist on the field's real instruments, not its vocabulary: when the mission involves data, use actual computation, tables, and primary sources — never a decorative summary of what an expert would say.`
> `- When you are deep in the material, spend part of your budget looking for what nobody asked about: the earliest signal, the blind spot, the assumption the sources share. Report it separately if you find it.`

These are the essay's "same instruments as the best" and "produce new knowledge" adapted to
a research council. `councilProfile()` budgets (24/16/8 steps) already allow it.

### A3. Lead doctrine "How to answer" — altitude line · **TUNE (light)**

`chat-agent.service.ts:1924-1935` `chatDoctrine` — the L1/L2 "How to answer" block. The
essay's core altitude question ("what do you want to happen next — what's the goal beyond
the goal?") is a USER-side lever, but a chat assistant can do its one honest version: when
the user asks for an artifact-shaped thing (a deck, an email, a summary) and the goal behind
it is inferable, answer the artifact AND name the outcome-shaped alternative. The
`proactiveOffersBlock` ("## Offer the next step", `capability-doctrine.ts:73`) is adjacent —
it offers the next ACTION, not the next ABSTRACTION.

Drop-in (one bullet in "How to answer", after the search-discipline bullet):

> `- When the request names an artifact (a summary, a deck, a draft), deliver it — and when the goal behind the request is clear and a bigger outcome is one step away, say so in one line and offer it ("this deck exists to get a decision on X — I can also draft the decision memo with options"). Never withhold the asked-for artifact; altitude is an offer, never a substitution.`

Guardrails: `PLAYBOOK_CHAR_BUDGET` (12,242 chars, `capability-doctrine.ts:66`) — check
headroom; `search-discipline.test.ts` asserts doctrine shape/section order.

### A4. Follow-up chips — one altitude-shaped follow-up · **TUNE (test-pinned)**

`chat-agent/capability-doctrine.ts:217-226` `followUpsInstruction()` — every chat answer
ends with 2-4 `[FOLLOWUPS]` questions. The essay's altitude prompt ("What's the goal beyond
the goal?") is a natural follow-up SHAPE: after answering the asked question, one follow-up
may go one level of abstraction up. The `[FOLLOWUPS]` markup itself is byte-pinned
(`capability-doctrine.test.ts:290+` pins the shape; the pipeline keys on the literal
`\n`-escaped markup) — the instruction TEXT around it is the tunable part.

Drop-in (append to the hasUser variant only):

> `, and when the question clearly sits inside a bigger goal, ONE of the follow-ups may go one level of abstraction up — the question the user would need answered NEXT to act on this answer (e.g. "What would you need to decide before acting on this?")`

### A5. Home-screen starter chips — an ambition slot in SPREAD_SPEC · **TUNE (optional)**

`backend/src/modules/crossmodel/suggested-questions.service.ts:623-641` — `CHIP_RULES` +
`SPREAD_SPEC` drive the home-screen starter chips (draft + critic, both LLM-passed). The
spread aims for professional/curiosity/practical/seasonal chips. An ambition-shaped slot
fits the existing rules with no new rule needed (the altitude shape is still "asks Digby
for something Digby can deliver"):

Drop-in (one more SPREAD_SPEC line):

> `(f) optionally 1 ambition chip that looks one level above the user's role or projects — not "what's new" but "what should I decide / build / change" (e.g. "What should our team stop doing next quarter?").`

Caution: `CHIP_RULES` forbid marketing words ("supercharge", "unlock") — keep the example
plain. Test surface: `suggested-questions` tests + the TIMELY/GROUNDED rules still apply.

### A6. User education: a new help doc — **ADD (the primary user-facing surface)**

`docs/DEPTH_AND_DIG_DEEPER.md` is currently the ONLY doc in the help pipeline's "Using
Digby" category (`frontend/scripts/sync-help-docs.mjs:77-82`, allowlist entry 9). A sibling
doc is the cleanest way to teach users the essay's techniques in Digby-native terms.

Proposed: `docs/ASKING_BIGGER.md` → slug `asking-bigger`, category "Using Digby". Content
skeleton: the three types (Altitude / Depth / Range) each with (a) one-line definition,
(b) a before/after prompt pair in Digby's own vocabulary — Altitude uses "start a coding
session that keeps X healthy" (the essay's crash-free example maps to Digby's coding
lanes + schedules), Depth uses "Dig deeper" + "challenge this assumption from the raw
data", Range uses "bring in what a short seller / forensic accountant would check" (with
the anti-roleplay caveat verbatim in spirit), and (c) the essay's one meta-prompt, adapted:
"I want a deeper version of this task, not a bigger one…" with attribution.

Mechanics (verified): add the doc, add the allowlist entry, `cd frontend && npm run
sync-help-docs`, commit both the source and the mirrored `frontend/content/help/` copy —
committed copies exist because the frontend Docker build context is `frontend/` only.

---

## 3. Integration map — coding sessions + framework

### B1. Delegate briefs — the "deeper, not bigger" contract · **ADD (one sentence)**

The essay's single most transferable artifact is its meta-prompt (name what a top
professional would do / the rawest material / the specific methods / what would prove it
right — then rewrite the ask). Digby's equivalent of a user prompt is the **delegate
brief** the orchestrator writes (`coding/roles.ts:184` `orchestratorRoleGuidance` already
covers mechanics: role choice, todo_id, complete instructions).

Drop-in (one sentence in orchestratorRoleGuidance, after the "Complete, self-contained
instructions" clause):

> `Write briefs the way a demanding principal would: name the RAW material to start from (files, logs, URLs — not pre-digested summaries) and, for anything investigative, what would PROVE the answer right or wrong — a brief that omits both gets a shallower worker.`

That is the essay's questions (2) and (4) compressed; (1) and (3) are the role system
itself. Tests: `roles.test.ts` pins retrieval-doctrine phrasing — additive sentence, low
collision risk, but run the suite.

### B2. Harness final-report line — the honest altitude note · **ADD (small)**

`coding/agent.ts:1117-1169` `systemPrompt`. The essay's altitude is the PROMPTER's lever;
an agent that unilaterally "goes up a level" is scope creep, and Digby's scope discipline is
correct. The honest adaptation is REPORTING-side: when the run saw a bigger outcome one
step beyond the goal, name it in the final as a suggestion — the coding equivalent of A3.

Drop-in (one bullet in "How you work", after the commit bullet):

> `- Scope to the stated goal — never silently expand it. But if the task is a symptom of a bigger outcome you can see (the fix that wants a guardrail, the report that wants a standing schedule), name it in ONE line of your final as a suggestion with the concrete next command, and leave it to the owner.`

### B3. Framework core doctrine — the sanctioned path only · **DOCUMENTED PATH, no change now**

`platform/core-doctrine.ts` is budget-pinned (`LAYER_BUDGETS` core 12,355 chars, pin rule =
measured +4%, `prompt-layers.test.ts` fails drift >8%) and hygiene-linted
(`prompt-hygiene.test.ts` fails CI on dates/ticket ids/project names in generic layers).
**Hand-editing is forbidden by design** — the only append path is
`platform/lesson-writer.ts recordLesson({repoRoot, ruleId, section, rule, incident, date, ticket?})`
with a `<area>.<name>` rule id, which also files the incident row in
`docs/FRAMEWORK_LESSONS.md`.

Candidate rule IF an incident ever motivates it (the ledger is incident-driven — do not
file without one): `ambition.brief` — "supervisor dispatch briefs name the raw material and
the proof condition." Until a real incident, nothing to record.

### B4. This repo's own lanes — AGENTS.md Conventions · **ADD (optional, owner call)**

AGENTS.md is truncated at 8,000 injected chars and is already 1.17M — must-see doctrine
belongs near the top, which is contested space. The lean version: a short "Ambition levers"
bullet cluster in Conventions recording that briefs carry raw-material + proof-condition
(B1's rule, once adopted) and that altitude offers are final-report suggestions, never
silent scope expansion (B2's rule). Only worth doing when B1/B2 actually land in code —
docs move with the code that needs them.

### B5. Verifier / reviewer / claim discipline — **NO CHANGE**

The essay's "outside judge" paragraph is already Digby's strongest embodiment (§1). Do not
add ambition framing to these prompts — their value IS their narrowness.

---

## 4. Integration map — user-facing guidance

- **C1 (the ADD)**: the help doc of A6 — `docs/ASKING_BIGGER.md`, allowlist entry, sync.
- **C2**: the marketing site's deep-research page (`frontend/lib/site/content.ts:465-498`,
  "When Digby goes deep") could cite the altitude/depth framing — content-only, optional.
- **C3**: standing-instructions placeholder (`SessionSettingsSection.tsx:96`, "e.g. Always
  answer in French. Keep replies under 200 words.") could gain one ambition-shaped example
  ("Push back when my ask is too small for my goal") — one string, optional.
- **C4 (found staleness, separate fix)**: README.md:19 and :273 still describe "four
  patience levels" and "Choose a patience level" — the picker was retired 2026-10-06
  (roster B-3; `PatiencePicker.tsx` deleted, `c3-legacy-retirement.test.tsx:148-150` pins
  its absence). `docs/DEPTH_AND_DIG_DEEPER.md`'s "Choosing a default depth" section
  likewise predates the retirement. Not this map's scope, but adjacent and worth a small
  docs PR.

---

## 5. Guardrails any implementer must respect (all verified this run)

| Surface | Pin / guard | Where |
|---|---|---|
| `[FOLLOWUPS]` markup | Byte-pinned literal `\n`-escaped markup; chips survive rewriteFollowUp / splitCompoundFollowUp | `capability-doctrine.test.ts:290+` |
| Playbook block | `PLAYBOOK_CHAR_BUDGET` 12,242 chars | `capability-doctrine.ts:66` |
| Escalation wording | "Deeper findings" title + progress lines + row metadata | `research-rung-wording.test.ts`, `chat-agent.compute-policy.test.ts:1057-1087` |
| Role prompts | Retrieval doctrine (search_memory/search_code_semantic) named in every role | `roles.test.ts:150-157` |
| Read-only refusal phrasing | "NO file-writing tools" clause | `delegation.68a36304.test.ts` |
| Core doctrine layers | Budget = measured +4%; drift >8% fails; hygiene lint (no dates/ids/names) | `platform/prompt-layers.test.ts`, `platform/prompt-hygiene.test.ts` |
| Machine-wake preamble | Token pins + seam source text | `machine-wake.test.ts`, `cross-check-scope.test.ts:109` |
| Help-docs mirror | Source doc + allowlist entry + committed `frontend/content/help/` copy must all move together | `frontend/scripts/sync-help-docs.mjs` |
| Chip rules | Marketing-word blocklist, privacy, TIMELY/GROUNDED | `suggested-questions.service.ts:623-633` |

---

## 6. Deliberately NOT recommended (anti-patterns from the essay's own caveats)

1. **No "you can do it" doctrine in coding prompts.** The Dantzig/Bannister effect is about
   the HUMAN's belief; injecting "the impossible is possible" pressure into agent prompts
   fights claim discipline and invites overclaiming. Digby already encodes the useful half
   (specific hard goals = acceptance criteria; permission to fail = "an honest incomplete is
   a pass").
2. **No roleplay crew.** The essay itself warns: find fields and techniques, don't cast
   characters. Digby's functional role system is the correct implementation; a "short seller
   persona" prompt would be a regression.
3. **No unilateral scope expansion.** Altitude is an OFFER to the owner (A3, B2), never a
   substitution for the asked-for artifact or a silent expansion of a coding goal.
4. **Speed type needs nothing.** The essay skips it; so does this map.

## 7. Proposed sequencing (owner's pick)

1. **A6/C1 help doc** (pure docs, no runtime risk) — teaches users the techniques today.
2. **A1 + A2** (chat depth: escalation note + council charter) — one code PR, tests
   `chat-agent.compute-policy` + `research-rung-wording` + council doctrine suites.
3. **B1 + B2** (coding: brief contract + final-report altitude line) — one code PR,
   `roles.test.ts` + harness prompt suites.
4. **A3/A4/A5** (chat light touches) — batch after 2 lands, one PR each area if preferred.
5. **B3** only on a real incident; **B4** when B1/B2 merge; **C4** as its own small docs PR.
