**Filed:** 2026-10-30 (lane `dc2796a9`, firing 4) · **Status: ⛔ WITHDRAWN (firing 6, 2026-10-30T08:47Z)** — the matched-size A/B came back **both legs intact**. Per the Fleet's own decision rule, the escalation does not ship. See § VERDICT FIRING 6. The firing-5 text below is kept as the record of what was believed and why.

---

## VERDICT — FIRING 6: **WITHDRAWN. The proxy is clean. The harness question reopens.**

The Fleet named one remaining fork and gave a three-way decision rule. The A/B ran as a **matched pair** and lands on branch 3.

### The matched pair (same model, same tools, same prompts; only the hop differs)

`DIRECT` = `https://api.moonshot.ai/v1`, model **`kimi-k3`**, bypassing llm-cql entirely.
`PROXY` = **`https://llm.cql.ca/v1`**, model **`api-optimize-moonshot-kimi-k3`** (the production alias), run **on the prod app box** with the endpoint key decrypted in-process from `model_endpoints.apiKeyEnc` — never printed, never left the box.

| shape | DIRECT | PROXY | verdict |
|---|---|---|---|
| small control | 79 c / 8 frag | 82 c / 19 frag ×2 | both PARSES |
| **newline-bearing** (~1,500 c, the `send_chat_message` shape) | **4,102 c / 282 frag** | **4,244 c / 292 frag**; 3,542 c / 244 frag | both PARSES |
| **two-call batch** (the "986 merge" shape) | 588 c + 311 c (2 slots) | 588 c + 311 c (2 slots) ×2 | both PARSES |
| generative 8 k | — | 19,471 c / 3,383 frag | PARSES |
| **generative ~22 k — AT/ABOVE THE 22,138 PRODUCTION CUT** | **26,316 c / 2,113 frag**; 23,974 c / 1,999 frag | **33,831 c / 2,928 frag**; **36,137 c / 3,120 frag** | **both PARSES** |
| **production request shape** (40 tools + large system prompt + `goal_update` with a long note) | — | **10,964 c / 963 frag**; 10,649 c / 942 frag | both PARSES |

Every trial: `finish_reason=tool_calls`, SSE `[DONE]` sentinel seen, **zero** non-`data:` lines, **zero** unparseable frames, **zero** multi-line events. **17 of 17 trials parsed.**

**The size gap that blocked firing 5 is CLOSED.** The largest direct datapoint is now **26,316 chars** — above the 22,138 production cut — and the proxy carries **36,137 chars** intact, 1.6× the largest observed cut.

### What this means, plainly

- **Branch 3 of the Fleet's rule fires: both intact ⇒ the cut is downstream of the proxy, and the harness question reopens.** The escalation is WITHDRAWN. It is not sent, not retargeted, not softened into a "monitor it" note.
- **`llm.cql.ca` does not sever tool-call arguments at any size we can produce.** A claim that it does is now unsupported by the best evidence we have, and this lane will not keep asserting it.
- The one caveat that keeps this from being a complete acquittal: **the cut is not reproducible on demand through either leg.** 58 production cut rows exist while 17/17 probe trials parse. So the probe rules the proxy OUT as a *consistent* severship; it does not by itself explain the production rows.

### A correction to the firing-5 record (self-harming)

Firing 5's leg (a) was described as "straight to `api.moonshot.ai` behind `api-optimize-moonshot-kimi-k3`". **That framing was wrong**: `api-optimize-moonshot-kimi-k3` is a **LiteLLM alias**, not a Moonshot model id — calling it directly returns `404 Not found the model api-optimize-moonshot-kimi-k3`. The alias resolves to Moonshot's **`kimi-k3`** (`model-catalog.ts:161`: "`api-optimize-moonshot-kimi-k3` ⇒ kimi-k3"). This firing re-ran leg (a) with the correct upstream id, which is why the numbers above are trustworthy where firing 5's 5,260-char datapoint was ambiguous about which model actually answered.

### The harness blind spot this pair exposed (now instrumented)

With the proxy cleared, the only remaining place a cut can originate *inside our own process* is the SSE frame reader — and it had a hole that made it unfalsifiable:

- **`coding-model.ts:2184`** skipped every line not starting with `data:` **before any counter ran**. `receivedBytes` is a sum over `data:` frames we parsed, so payload on such a line (a spec-compliant multi-line event, or a frame emitted with its prefix lost) entered **neither** side of recv-vs-acc — and the row still read `drop=0`, handing the verdict to the gateway off a stream the measurement never fully saw.
- **`tool-call-finalize-meta.ts:147-154`** voided the gateway verdict on `ur=` only; `pf/pb/pc` (parse-failed frames) did **not** void it.

Both are now closed: the reader counts `skippedRawLines`/`skippedRawBytes` and `multilineDataEvents` (legitimate SSE — blank separators, `:` keepalives, `event:`/`id:`/`retry:` — is explicitly allowed and not counted), `gatewayOrOurs` voids on `skippedRawLines`, and `sk=`/`sb=`/`ml=` render in the short value that survives the 240-char read cut.

> **⚠ CORRECTION (firing 6 follow-up, independent review).** The line above originally read "Both are now closed" and that was **FALSE for (b)**. The code added `ur=` and `skippedRawLines` voiding, but **never** added `pf/pb/pc` — a parse-failed frame carrying tool-call bytes still could not void a gateway verdict. A doc claiming a guard it never shipped is the same defect class as the stale present-tense prose that manufactured the FS gate-widening ask. Now actually fixed: `gatewayOrOurs` voids on `parseFailToolCalls > 0`, and on the **conjunction** `parseFailLines > 0 && multilineDataEvents > 0` (a split event whose lines all parse loses nothing, so the disjunction would manufacture false `ours` verdicts — the mirror-image lie). Pinned by 3 tests; discriminator suite 35/35.
>
> The same review found a second, subtler version of "recorded but unreadable": the new counters rode the **finalize** row only, while a cut turn is **rejected** — so the row an analyst actually reads could not show `sk=`/`ml=`/`pf=`. They now ride `turn.streamTrace` → `ctx.turnStreamTrace` → the `dispatch_reject` row, with the types extended in `coding-model.ts` and `tools.ts` and a test pinning it.

### What is NOT established (stated before the numbers, not after)

- **The exact ~5,260-char matched pair the Fleet asked for is now CLOSED — BOTH legs measured (2026-10-30, firing 7, read 11:22Z).** The DIRECT half ran: **5,174 chars / 295 fragments** and **5,219 chars / 296 fragments**, both `PARSES`. The **PROXY half** was re-run once the admin-backend blue/green rotation settled, on `admin-backend-green` via SSM, with the `llm-cql` credential decrypted **in process** from `model_endpoints.apiKeyEnc` (len 25, never printed — the route the Fleet specified): **5,534 chars / 317 fragments** and **5,264 chars / 299 fragments**, both `ALL_PARSE`. Same model (`api-optimize-moonshot-kimi-k3`), same tools, same prompts; only the hop differs. Every trial: `bad_json=0`, `non_data_lines=0`, `multiline_events=0`, `finish_reason=tool_calls`, `[DONE]` seen.
- **And at a LARGE size, through the proxy: `generate22k` produced 50,054 chars / 4,337 fragments, `ALL_PARSE`** — **2.3× the 22,138-char production cut.** The size objection that blocked firing 5 is not merely met, it is exceeded through the leg under suspicion.
- **Consequence:** the `llm.cql.ca` boundary is now **CLEARED as a consistent severship at, and well beyond, the production cut size** — on a controlled pair whose only variable is the hop. What the production rows still lack is a reproduction, not a size-matched test. The escalation stays **withdrawn**.
- The reviewer's third finding stands as a limitation on the probe harness itself: `tmp/efdb-probe2.py` writes `total_arg_chars` as the **sum of fragment counts**, not characters — a mislabelled field. The **character** figures quoted in the table come from the per-slot `chars` field, which is correct (`{"0":{"fragments":282,"chars":4102}}`), but anyone re-reading the raw JSONL must not take `total_arg_chars` at face value.

---

**Consequence for every earlier "culprit=gateway" row in this family:** they were read off a measurement that could not see a skipped line. They are not yet *wrong* — no row has been re-read since the counters shipped — but they are **no longer sufficient** to name the gateway. That is the reopening the Fleet asked for, stated without decoration.

---

## VERDICT — where the boundary sits (firing 5, superseded above)


**(1) `llm-cql` is OURS — not a vendor, not a third-party relay.** BaseUrl is **`https://llm.cql.ca/v1`**, tailnet origin **`http://100.64.0.1:4001/v1`** (`model-endpoints.service.ts:122-131`); the repo names it "**the owner's LiteLLM gateway**" (`utility-llm.test.ts:1143`). Responses are LiteLLM's own (`401 Authentication Error, No api key passed in`; `/health/readiness`, `/health/liveliness`). All 23 `llm-cql:*` model seats read `resolves:true, servable:true`.
**Consequence:** Fleet branch 1 fires whichever hop severs — because the proxy is our estate, a cut introduced *anywhere inside llm-cql* is OURS; only a cut introduced by the provider *behind* llm-cql is external. The symptom below stands; the **addressee was wrong**. Retargeted to whoever operates `llm.cql.ca`; do not send this to a vendor relay as written.

**(2) `llm.cql.ca` is ALIVE — `AGENTS.md:12`'s "dead" claim is STALE.** Measured twice: `/health/readiness` → `{"status":"healthy","db":"connected"}`, `/health/liveliness` → `"I'm alive!"`, both 200. The restore `utility-llm.test.ts:1144` was waiting on (FO f124, oq_63f66) has happened. Corrected in `AGENTS.md` in the same change. `mcp.cql.ca` was NOT re-verified.

**(3) Leg (a) RAN — direct to upstream at 5,260 chars: INTACT.** Straight to `api.moonshot.ai` (provider behind `api-optimize-moonshot-kimi-k3`, an affected family), **bypassing llm-cql**: `finish_reason=tool_calls`, sentinel seen, **296 argument fragments, 5,260 chars, PARSES**.

**(4) Leg (b) — BLOCKED, not inferred.** No llm-cql credential in this container (0 matching env names); `DATABASE_URL` unset so `apiKeyEnc` is unreadable; unauthenticated calls are 401 on both Cloudflare and tailnet. Needs an operator-supplied key. **No proxy verdict is claimed.**

**(5) The A/B is NOT closed — the gap is SIZE.** Leg (a) is intact at **5,260** chars; the largest observed kimi-k3 cut is **22,138**. Different sizes are not a controlled pair. ~27 KB and ~10 KB direct probes each stalled twice with no output and were killed, not retried — so **no large-size direct datapoint exists**.

**(6) Against our own best example:** the 22,138-char `update_plan` cut at `05:16:11.559Z` is the **only** cut row carrying `fr:stop` (all others `fr:tool_calls`) — a different signature that may be an output-cap stop, not mid-transit severance. Do not use it as the archetype until separated.

---

## One-paragraph summary

> **⚠ STALE (2026-10-30, ticket 9b2b3798): the conclusion below is SUPERSEDED — do not act on it.**
> This summary asserts two things a later, primary-source read refuted. (1) *"the harness-side
> accounting now proves that no byte the gateway delivered was lost"* — unsound as an inference:
> `coding-model.ts` documents three shapes (an unparseable `data:` frame, a line without the
> `data:` prefix, argument bytes in a shape the accumulator cannot read) that lose real fragments
> while `recv == acc` still reads clean and `drop=0` *"blames the gateway"*. Those are exactly why
> `pf`/`pb`/`pc`, `sk`/`ml` and `ur` exist. (2) *"cannot repair a payload the transport keeps
> re-severing … We are escalating the transport"* — the escalation was WITHDRAWN by this same
> document's firing-6 matched pair (§ VERDICT FIRING 6: both legs intact). The durable correction
> is that the rejection message must assert **neither** cause: it cannot see any of those counters.
> See `tool-arguments.ts` `toolArgumentRejection` + `tool-arguments.9b2b3798.test.ts`, which pin
> that the text states only the ambiguity and points at the stream diagnostics. The paragraph below
> is kept as the historical record of what was believed at filing time.

On the `llm-cql` custom-endpoint path (label `llm-cql (custom endpoint)`), tool-call argument
payloads arrive **structurally unfinished** — truncated inside a string literal or before a
closing brace, so `JSON.parse` reports `Unexpected end of JSON input` or
`Expected ',' or '}' after property value` — while the transport itself reports the turn as
**complete** (`finishReason=tool_calls`, `sc=1` i.e. the `data: [DONE]` sentinel was seen). The
harness-side accounting now proves that **no byte the gateway delivered was lost, dropped,
misrouted between slots, or left undrained inside our process**, and that the per-slot byte
totals decompose the received byte count *exactly*. The payload was already short when it
reached us. The harness has been fixed to stop dispatching half-built calls (it rejects them
and re-requests once); that fix is working as designed but **cannot repair a payload the
transport keeps re-severing** — measured: the re-emit fires and the transport re-cuts at the
same byte. We are escalating the transport, not asking for a harness change.

---

## What the vendor should look at

The `llm-cql` gateway (custom endpoint in front of the upstream models) must, for a
`stream=true` chat completion that requests tools:

1. Forward the upstream SSE `delta.tool_calls[].function.arguments` fragments **intact**, and
2. Either deliver the complete arguments for every tool call it names, **or** not report
   `finish_reason: "tool_calls"` / terminate the stream cleanly as if it had.

What we observe is the third option: it names a tool call, ships a **prefix** of its JSON
arguments, and closes the turn as successful. A downstream client has no way to distinguish
this from a well-formed short payload except by parsing — which is exactly how we detect it.

**This is not a "your payload was too long" problem.** See § Size-independence: the same defect
cuts payloads at 17 chars and at 22,138 chars, and shrinking a payload provably does not help
(9/9 shrink retries failed; the rejection text no longer asks models to shrink, because doing so
only destroys information — see § What we already changed).

---

## Evidence: the bytes are lost at or before our ingress

Read from `tool_call_finalize` / `dispatch_reject` metric rows, `asOf 2026-10-30T06:12:45.249Z`,
window 4 h, total 63 rows. Field meanings are ours; each is a rendered token on the row, so this
is mechanically checkable rather than a narrative.

### 1. Per-slot byte identity closes EXACTLY — the strongest term

Each finalize row reports per-slot argument lengths. On every multi-call row observed, the
per-slot lengths **sum to the received byte count with zero remainder**:

| row (Z) | per-slot arg lengths | sum | `recv` | broken slot |
|---|---|---|---|---|
| `06:05:31.146` | 786, 1052, 1147, 2172 | **5157** | **5157** | `k=0` (786) |
| `04:42:54.902` | 1025, 822, 847, 73 | **2767** | **2767** | `k=2` (847) |

Why this matters, and why it is stronger than a global total: a single `received == accumulated`
comparison *could* be satisfied while bytes were moved from one tool call's slot into another's.
The identity above is per slot, so a slot-to-slot misroute would leave the totals unequal. They
are exactly equal, so **the received bytes are distributed across slots exactly as the gateway
framed them**. The deficit is in the framed content itself.

Corroborating tokens, all rendered on the same rows (so no cross-row join is required):
`db=0` (dropped bytes), `ub=0` (undrained SSE tail), `ni=0` (index-less deltas — no fragment was
routed by a guess), `pc`/`pf`/`pb` **absent**, which is a *render-only-when-nonzero* property
(`tool-call-finalize-meta.ts:158-162`), therefore `pc=0` — no parse-failed frame carried
tool-call bytes.

### 2. The cut is TOOL-AGNOSTIC and MODEL-AGNOSTIC

Observed cut lengths (chars): **17, 39, 39, 39, 41, 57, 64, 67, 786, 847, 880, 1025, 1147, 1787,
22138** — across `goal_update`, `todo_update`, `get_feedback`, `send_chat_message`,
`update_plan`, `finish_run`, `edit_file`. Nothing in the geometry is specific to one tool: `39`
recurs on `goal_update` only because `{"goalId": "` is 13 chars and the first 26 of a 36-char
UUID runs out exactly there — an artefact of that header, not of that tool.

Crucially the defect crosses **models** on the same gateway:

| model | tool | cut (chars) |
|---|---|---|
| `api-optimize-xiaomi-mimo-v2.6-pro` | goal_update / todo_update / get_feedback / send_chat_message | 17, 39, 39, 41, 57, 64, 67, 880, 1025, 1147 |
| `api-optimize-moonshot-kimi-k3` | update_plan | 22138 |
| `api-optimize-alibaba-deepseek-v4.1-flash` | update_plan | 1787 |

Three distinct upstream models behind the same endpoint producing the same class of
structurally-unfinished payload is a property of the endpoint's relay, not of any one model's
sampler.

### 3. Size-independence, and the falsified theories

- **Not an output-token budget.** `finish_reason` is `tool_calls` on every cut row (28/28 read
  earlier; none `length`). 25 distinct cut sizes spanning 17 → 22,138 chars.
- **Not a reasoning budget.** Reasoning length `rz` on the recovery rows ranges 4,957 → 76,421
  at an identical 39-byte cut; the two longest payloads sit at the two *longest* `rz` values.
- **Not a single oversized upstream chunk.** A natural hypothesis — "the container emitted one
  big chunk that overflowed something" — is **refuted by our own fragment counters**. The 39-byte
  `goal_update` rows carry `fg=6` byte-bearing fragments across 7 routed deltas (≈6.5 chars per
  fragment); `frag`/`recv` stays ≈14–16 bytes per fragment across all rows. This is ordinary
  fine-grained streaming, not a coalesced burst. Recorded because the hypothesis is attractive
  and wrong.
- **Not our frame boundary.** See §1: `pc=0`, `db=0`, `ub=0`, `ni=0`, per-slot identity exact.

### 3b. The cut is DETERMINISTIC at a fixed structural offset — the sharpest discriminator

The single most diagnostic property in this report. Seat `41bd202a` ran the same `goal_update`
twice with **different `progressNote` text**, and both were severed at **exactly 39 chars** with a
**byte-identical** fragment:

```
{"goalId": "a8c755c8", "progressNote":
```

Verified length: that prefix is **exactly 39 bytes** (`printf '%s' | wc -c` → 39). Rows from our
telemetry: `05:36:07.887Z` (recovery, `len[39]`), `05:41:03.354Z` (`dispatch_reject`, `argLen:39`),
`05:54:53.323Z` (`dispatch_reject`, `argLen:39`). A `goal_get` on the seat confirmed the note
never landed. *(Note on timestamps: a peer report dated the second attempt `05:56Z`; our own rows
put it at `05:54:53.323Z`. Both attempts are post-`c911c96a`, deploy run `41002696540`, success
`05:10:13Z`.)*

**Why a fixed offset matters more than any single cut size:** if the cut were random, or a
budget running out, it would track the payload's *content length* — a different note text would
cut at a different byte. It does not. The cut lands at the same structural boundary regardless of
what follows it, which points at a **fixed relay/emission boundary in the gateway** (a bounded
first emission whose remainder is never scheduled) rather than at anything size- or
content-dependent. It also rules out the payload simply being "too long": the `progressNote` here
was ≤200 chars.

**Independent of size, direction confirmed:** in-family cut spread now runs **17 → 880 → 1,500 → 22,138**
chars. Both ends of that range, and the deterministic fixed-offset case, are the same defect.

**One row that argues the other way, stated against our own interest.** At `06:50:44.826Z` row a
`send_chat_message` was rejected with `argLen:1500` and gateway `recv=1500 acc=1500 drop=0`
(`fg=127`, `sl:"0:129"`) — a **round** 1,500, i.e. exactly the value a size threshold would
produce, and unlike the 39-byte case it does not sit at the `{"goalId": "…` structural boundary.
Two further rows in the same run cut at `argLen:849` (`06:54:49.789Z`, a 2-call batch,
`recv=1408`) and `argLen:69` (`06:56:35.250Z`). So the family contains at least one cut that is
consistent with a **length cap** as well as the structural-severance class. We are not claiming a
single mechanism: §3b's fixed offset is proven for the `goal_update` twin, while this 1,500 row
should be tested by the vendor against any per-piece / per-emission byte ceiling on their side.
*(Verified from our own `tool_call_finalize` rows, not from the peer report that surfaced it.)*

### 4. The repair that works (field-tested) — worth telling the caller

The rejection text we now emit tells the model not to shrink a value but to **reshape** the call.
Observed working: a supervisor seat hit an 880-char cut on a tool call, then split it into a
title-only update followed by a separate send — both landed clean. Shrinking the *values* of the
same shape fails (9/9); changing the *shape* (fewer opaque fields, or split across two calls)
succeeds. This is mitigation, not a fix: it costs the agent extra turns every time the transport
severs a large payload.

---

## The falsifier — what would move this back to our side

Stated explicitly so this escalation is a testable claim, not an assertion. **Any one** of these
on a future row voids the vendor attribution for that row:

1. `pc > 0` — a `data:` frame failed to parse while carrying tool-call bytes (we discarded bytes).
2. `ur > 0` — argument bytes rode an argument shape our counter cannot read
   (`function_call.arguments` or a top-level `arguments`). **This term is currently
   UNAVAILABLE, see § Caveats.**
3. `db > 0` or `ub > 0` — bytes dropped after receipt, or stranded undrained.
4. `ni > 0` — a delta lacked a usable index and was routed by guess.
5. Per-slot lengths **not** summing to `recv` — a slot-to-slot misroute.

Everything in §1 is exactly these five terms read off live rows.

---

## Caveats we are stating against our own interest

- **Term (ii) `ur=` is not evaluable on the rows above, and absence there is NOT zero.** The rows
  through `06:07:26Z` were emitted by processes serving `2cb1f342`, which **predates** the commit
  that added the `ur=` counter (`da97a6e1`, ancestor of `15844873`). `grep` for `ur:` at
  `2cb1f342` returns **0**. Because `ur=` is render-only-when-nonzero, its absence on a
  *pre-instrument* build means **unknown**, not zero. This is the same class of error as reading
  a pre-deploy window as a post-deploy result: **date a row by its tokens, never by its clock.**
  Term (ii) becomes checkable on the first row served by a post-`da97a6e1` build.
- **The `severed_stream_recovery` count rising is not by itself a worsening trend.** All observed
  rows are post-gate, so the rate is real in observed terms (5 → 11 in 24 h as of this writing),
  but it is also a function of how many lanes were active. We do not claim the gateway
  regressed; we claim it has been doing this continuously.
- **We cannot bound the pre-gate rate.** Before the structural gate the counter read 0 rows
  because the guard was dead by construction, not because nothing was being severed. Any
  before/after comparison of cut frequency across the gate change is uninformative.
- **We are not asking for a capability probe as a substitute.** A `/model/info` check remains a
  defensive option on our side; it does not replace this report.

---

## What we already changed (so this is not read as us asking you to fix our harness)

Harness-side, already merged and deployed on the serving builds:
- The re-emit guard was **dead by construction** — it required `streamCompleted === false`, but
  every reproduction reads `finishReason=tool_calls` with the `[DONE]` sentinel seen, so it
  rejected 100% of turns. It is now **structural**: a payload that stops mid-structure triggers
  one re-request per run. Kill switch `SEVERED_STREAM_RECOVERY_DISABLED=1`.
- Truncated non-streaming tool calls are **refused** rather than executed with fabricated empty
  arguments (`c911c96a`).
- Per-fragment gateway arithmetic (`rb/ab/db/fg/ub/sl/ni`) is emitted on the rejecting call's own
  row, so the evidence above travels with the rejection. A re-emitted turn's reject row also
  carries `rl` (the argLens captured at the re-emit), so "did our re-request re-cut at the same
  byte?" is answered by `rl` vs `argLen` on ONE row rather than a cross-row join.
- The rejection text no longer tells models to shrink payloads (that instruction produced an
  89→39→17 spiral), and instead advises reshaping.

**Honest limit we hold ourselves to:** the re-emit **fires and does not heal** — per-attempt rows
show `re:1 sc:1 argLen:39` and a re-cut at the same 39 bytes. We claim *"the gate fires"*, never
*"the re-emit repaired the payload"*.

---

## Contact / how to verify on your side

Reproduce with any `stream=true` tool-calling request through the `llm-cql` custom endpoint using
`api-optimize-xiaomi-mimo-v2.6-pro` (highest-yield observed) and a large, opaque string field
(e.g. a 400+ char progress note). Inspect the raw SSE: look for a `delta.tool_calls[].function.arguments`
sequence whose concatenation is not valid JSON, followed by `finish_reason: "tool_calls"` and
`data: [DONE]`.

Row identifiers for your logs: `call_e36b29aec8c04550b3d2e738` (39 b, `goal_update`),
`call_1a492bd1b30f4d179a6770d9` (880 b, `send_chat_message`), `call_ce4c8edadf6c44eeab7f4f30`
(1787 b, `update_plan`, kimi path), at `05:54:53Z`, `06:07:26Z`, `05:16:11Z` respectively.