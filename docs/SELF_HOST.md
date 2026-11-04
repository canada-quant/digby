# Self-hosting Digby

Run the entire Digby stack on your own machine or server — your own database,
UI, coding worker, STT, MCP integrations, and model providers. Nothing talks to
digby.example.com unless you configure it to.

> **🔒 Isolation boundary (owner standing requirement, ticket c75b5f34): your self-hosted Digby self-improves on ITS OWN copy only.** `docker-compose.selfhost.yml` sets `DIGBY_INSTANCE=selfhost`: the instance's autonomous loop (merge → deploy → verify → auto-fix) resolves its repo/DB/deploy targets from YOUR environment — never production Digby's repo (`the production Digby repository`), DB, or infrastructure. Any attempt to resolve a production target from this instance hard-fails with an `ISOLATION BOUNDARY` error by design; to let it improve itself, point it at YOUR fork (see *Updating* / the `GITHUB_REPO_SLUG` notes in `selfhost.env.example`). This instance shares no secrets, database, or deploy path with digby.example.com.

> **Distribution note:** today this builds images from the source tree. The
> planned distribution is pre-built images + this compose file, so self-hosters
> won't need the source at all.

## Requirements

- Docker + Docker Compose v2
- ~8 GB RAM recommended (4 GB floor without the STT service; STT alone caps at 4g)
- At least one LLM provider API key (DeepSeek, Moonshot, Z.AI, DashScope) — or your own OpenAI-compatible endpoint assigned to the seats (no frontier keys are read anywhere since 2026-09-22)

## Quick start

```bash
cp selfhost.env.example .env
# Edit .env:
#   - JWT_SECRET / JWT_REFRESH_SECRET  → openssl rand -hex 32 (each)
#   - at least ONE model provider key

docker compose -f docker-compose.selfhost.yml up -d --build
```

Then open **http://localhost:8080** and register your account. Put your email
in `SELFHOST_ADMIN_EMAIL` in `.env` **before** you register (or before your
next sign-in) and that account becomes ADMIN on this instance — admin
surfaces, cloud-link pairing and the setup checklist need it. Without the
variable, promote by hand:

```bash
docker exec digby-postgres psql -U admin -d digby_db \
  -c "UPDATE users SET role='ADMIN' WHERE email='you@example.com';"
```

Then go to **Account → Admin → Setup**: it lists every feature of this
instance — ready, partly set up, not set up — with the env names still missing,
the OAuth callback URL to register, and a link to the matching section of this
guide (see *Setup checklist* below). Users who are not admins see the same
state in plain words on the Integrations tab ("not set up on this
instance — an administrator configures it").

Schema migrations run automatically on every `up` via the one-shot `migrate`
service — the backend and worker wait for it to complete.

## What you get

| Service | Purpose | Exposed |
|---|---|---|
| caddy | single entrypoint: `/api/*` → backend, rest → frontend | `:8080` |
| frontend | Next.js UI | internal |
| backend | Express API + chat agent | `127.0.0.1:4000` (debug) |
| relay | Digby Edge (Phase 3): holds paired edges' WS tunnels + proxies admin API/SSE down them | `127.0.0.1:4100` (debug) |
| worker | coding-session runner (claims runs from Postgres) | internal |
| postgres | app DB (pgvector) | internal |
| redis | cross-process state, rate limits, run mirrors | internal |
| stt | voice notes + YouTube-audio transcription (Parakeet, CPU) | internal |
| docker-socket-proxy | filtered Docker API for coding-session containers | internal |

Optional profiles:

```bash
# MCP integration servers (Google/GitHub/X/Slack/Asana/Discord + BrightData gateway)
docker compose -f docker-compose.selfhost.yml --profile mcp up -d --build

# Adminer DB UI on http://localhost:9521
docker compose -f docker-compose.selfhost.yml --profile tools up -d

# Hosted hardened browser for browser_task when no Mac is paired
# (.env: BROWSER_SERVICE_ENABLED=1 + BROWSER_SERVICE_SECRET)
docker compose -f docker-compose.selfhost.yml --profile browser up -d --build
```

## Setup checklist (Account → Admin → Setup)

The checklist is the one place that says what **this** instance can and cannot
do, so you never have to guess from a silent button. It reads the server's own
configuration (names and booleans — never a value) and groups it:

| Group | Rows | Not set up means |
|---|---|---|
| This instance | public URL, cookies / TLS, first admin, analytics isolation, cloud link | share links / OAuth callbacks / the Mac agent cannot be derived; or the build still carries Digby's production ad tags |
| Models | provider keys, every model seat (Digby, Double Checker, coding, image reader, speech …) | chat stops (providers) or that one seat falls to its fallback; with no provider key AND no Utility seat, headlines and starter questions say so once instead of retrying forever |
| Web search & browsing | web search, feeds, hosted browser | the model says "web search is NOT configured on this instance", web pipes / feeds / headlines are off |
| Integrations | Google, GitHub, X, Slack, Asana, Xero, Plaid, Discord | the Integrations tab shows *Not set up on this instance* instead of Connect |
| Messaging & devices | Telegram (incl. whether the webhook is registered), email as Digby, Mac agent, desktop app | — |
| Voice, images & documents | speech-to-text, text-to-speech, image generation, PDF OCR, Digby Kids | that feature reports itself unavailable |
| Coding sessions | Docker sandbox, registered endpoints | coding sessions cannot run containers |

Each row carries the exact env names to set, a one-line how-to, the callback
URL to register at the provider and a link to the section of this guide. The
same endpoint (`GET /api/crossmodel/instance/setup`) feeds the Integrations tab,
the home headlines card and the "How Digby answered" pill, so a
missing key reads the same everywhere. Production digby.example.com has every key set
and shows no such notices.

## LAN access (other devices on your network)

In `.env`:

```
SELFHOST_PUBLIC_URL=http://<your-lan-hostname-or-ip>:8080
```

Then rebuild (the frontend bakes its API URL at build time):

```bash
docker compose -f docker-compose.selfhost.yml up -d --build
```

Cookies are already non-Secure by default here (`COOKIE_SECURE=false`), so
plain-http LAN login works.

## TLS with a real domain

Caddy can terminate TLS automatically (Let's Encrypt):

1. Point DNS at the machine, open ports 80+443.
2. Edit `deploy/selfhost/Caddyfile`: replace the `:8080` block header with your
   domain (`digby.example.net {`).
3. Publish 443 on the caddy service in `docker-compose.selfhost.yml`.
4. `.env`: `SELFHOST_PUBLIC_URL=https://digby.example.net`, `COOKIE_SECURE=true`.
5. `docker compose -f docker-compose.selfhost.yml up -d --build`.

## Model providers

The backend adapts its lineup to whichever provider keys are set — with zero
keys, chat simply has nothing to call. Set any subset in `.env`.

Beyond env keys, admins can register any OpenAI-compatible server (Ollama,
vLLM, LM Studio, OpenRouter, …) as a custom model endpoint — no env vars or
restart needed: **Account → Admin → Endpoints** (REST
`/api/crossmodel/admin/model-endpoints/*`). The dialog auto-discovers the
server's model list; registered models are addressable as
`<label>:<modelId>` in coding sessions.

**Model roles** (same admin section, below the registry): every named seat of
the Digby experience — Digby the lead, the Double Checker (the one secondary
model: the preset-2 second opinion — which runs BEHIND the answer since the
2026-09-26 compute policy, see the "How deep Digby thinks" help page — + first
preset-3 council chair), the Triple Checker (the preset-3 research council),
The Helper fast tier, the
background utility model, the RAG **embeddings**/**reranker**, and
**speech-to-text (ASR)** — can be pointed at a built-in model or any
registered endpoint model (REST `/api/crossmodel/admin/model-roles`). This is
how a self-hosted box with NO cloud provider keys runs the core chat, coding,
and RAG experience on its own servers. Each role has a live **Test** button
that exercises the real call shape (a streamed chat completion to first token;
`/embeddings` with the 1536-dimension check; a Cohere-style `/rerank`; a
multipart `/audio/transcriptions` with a tiny silent WAV) — not just
`GET /models`. Notes:

- Agent seats need the model's `[coding]` flag; the fast seats (Helper,
  Utility) reject reasoning built-ins (they're called non-streaming).
- **Thinking models on the fast seats.** The Helper (web/YouTube digests, the
  utility fallback leg, the role Test probe) and Utility seats call the model
  **non-streaming with a small budget**. (The verifier worker also uses the
  Helper seat, but it runs a full STREAMING agent loop — its thinking control
  is the "no-think" chip, not this non-streaming path.) A model that thinks by default (Qwen3, DeepSeek…) spends that
  budget reasoning and returns nothing — Digby now sends the thinking-disable
  directive to every custom endpoint automatically, but the reliable fix is
  the **"no-think" chip** on the model's entry in the endpoint dialog. The
  Test button on those seats now runs the real non-streaming shape and tells
  you when a model came back empty for this reason; web/YouTube digests name
  the model that wrote them ("Digest by …") so you can see the seat working.
- **Which model edits code.** The **editor** worker runs on the session's
  coding model (the same model as the coding agent); only the **verifier**
  defaults to the Helper seat. The agent can still send a trivial pass to the
  Helper with `delegate({model:"helper"})`.
- **Registering endpoints alone assigns NO seats.** A seat you don't assign
  stays on its cloud built-in and needs that provider's API key. On a keyless
  box a dead seat shows a badge naming the exact variable to add (e.g.
  "add MOONSHOT_API_KEY") in Model roles, and the section's **Provider API
  keys on this instance** panel lists each built-in provider variable
  (`MOONSHOT_API_KEY`, `DEEPSEEK_API_KEY`, `ZAI_API_KEY`,
  `DASHSCOPE_API_KEY`) as set/missing with what it serves — key values never
  leave the server. In chat, a dead lead seat fails fast naming the same
  variable (instead of hanging on "Still writing the answer"), and a dead
  Double Checker/council seat is skipped with an honest note. At minimum,
  assign the Digby lead seat to one of your endpoint models — or add the
  named key to the backend `.env` and restart.
- An embeddings override must yield 1536-dimension vectors, and switching
  embedding models means re-ingesting previously embedded documents. A
  configured embeddings override that stops resolving FAILS the embed call
  rather than silently reverting to DashScope (mixed vector spaces corrupt
  retrieval) — fix or clear the role. **Qwen3-Embedding / other MRL models**
  natively return more than 1536 (Qwen3-Embedding-8B: 4096). Digby asks for
  `dimensions: 1536`; DashScope honors it server-side, but a self-hosted vLLM
  only does with `--hf-overrides '{"is_matryoshka": true}'` (and a LiteLLM
  proxy must forward the param). Easiest: tick the **"MRL" chip** on the
  model's entry in the endpoint dialog — Digby then truncates to the leading
  1536 dimensions and renormalizes client-side, which is exactly the
  `dimensions` operation for Matryoshka-trained models. Only flag genuine MRL
  models (truncating anything else silently degrades retrieval). Save refuses
  an embeddings model whose Test fails the dimension check, and the message
  now says whether the server *rejected* or *ignored* `dimensions`.
- **Streaming format matters.** Digby always streams and expects OpenAI
  **JSON delta chunks** (`data: {"choices":[{"delta":{"content":"…"}}]}`).
  Some gateways (certain LiteLLM/vLLM proxy configs) instead stream **plain
  text** in each `data:` line — Digby tolerates that (you'll get answers), but
  a raw-text stream **cannot carry tool calls**, so agentic work (Level 2, the
  coding agent) degrades to prose-only. Test with
  `curl -N .../v1/chat/completions -d '{"model":"…","messages":[…],"stream":true}'`:
  if the `data:` lines aren't JSON objects, configure the gateway to emit
  standard OpenAI streaming chunks to unlock function-calling. (A green Test
  button only proves tokens arrive, not that they're JSON.)
- Still cloud-only on a keyless box: image attachments in chat need either a
  `[vision]`-flagged custom model on the Digby seat or `MOONSHOT_API_KEY`
  (without either, images are dropped with an honest notice); Digby Kids
  needs `DASHSCOPE_API_KEY`; YouTube speech-to-text for caption-less videos
  needs `STT_BASE_URL` (or `DASHSCOPE_API_KEY` for the qwen3-asr-flash leg) — or an admin-pointed
  **speech-to-text (ASR)** role override on a registered endpoint (a bad
  override warns and falls back to this env chain). Text-to-speech, image
  description, PDF OCR, the browser agent, computer use and Digby Kids are
  seats too (Account → Admin → Endpoints → Model roles) — point any of them at
  your own endpoint.

### Decision gate (typed judgments, optional)

The **Decision gate** seat answers the framework's own small yes/no, choice
and score judgments (is this supervisor wake worth a turn, did a watched value
change materially, which depth for an Auto send (the preset router and, since
2026-09-26, the compute policy's depth / stakes / drafts-agree / revision-material
questions — see [How deep Digby thinks](./DEPTH_AND_DIG_DEEPER.md)), is the user asking to send a
message, cloud or Mac browser, is there anything to remember, does a coding
final need a self-audit) with a Jev-class decision model — one prefill, zero
output tokens, calibrated probabilities — instead of a reasoning-model
generation. It ships in SHADOW mode: it records what it would have decided
(`loop_metrics` kind `decision_gate`) and changes nothing until you flip a
purpose to `act` (Account → Admin → Endpoints → Model roles → Decision gate;
`DECISION_GATE_MODE_<PURPOSE>=act` is the env fallback). Backends, in the
order the seat tries them:

- the purpose's own **primary** when you set one on the seat's "Decision
  backends per purpose" panel (see below);
- built-in **`jev`** — TypeSafe Jev (`TYPESAFE_API_KEY`; `TYPESAFE_BASE_URL`
  and `TYPESAFE_MODEL` override the host / model id, e.g. the Vercel AI
  Gateway at `https://ai-gateway.vercel.sh/typesafe/v1`);
- built-in **`deepseek-flash`** — a logprob readout on your DeepSeek key
  (no extra service);
- a registered endpoint of type **Decision model (/systemone)** — a
  self-hosted Laya, JevK5, NeoHorse-Jev or openjev server (below), Kev — or
  any OpenAI-compatible server that returns `logprobs` (vLLM, SGLang,
  llama.cpp).

Kill switch `DECISION_GATE_DISABLED=1`. Every gated site runs its pre-gate
behaviour whenever the seat cannot answer.

#### Self-hosting an open-weight decision model (Laya / JevK5 / NeoHorse / openjev)

TypeSafe publishes no official open weights; every community rebuild speaks
the same `POST /v1/systemone` request and response, so each one is registered
the same way — Account → Admin → Endpoints → **Add endpoint**, Server type
**Decision model (TypeSafe-compatible /systemone)**.

> **Which parts your build has (2026-09-26 wave, integrated).** The
> per-purpose panel, challengers and "Promote to primary" come with the
> backend's `platform/decision-gate-backends.ts` (the panel hides when the
> route is absent). Laya's wire quirks (`distribution` score lists, no `model`
> in the response, required `noul` criteria), the **[calibrated]** and **max
> state chars** model fields and the temperature auto-fit ship in the same
> build (`platform/decision-gate.ts`; `grep -rn
> DECISION_GATE_SYSTEMONE_NOUL_CRITERIA_DISABLED backend/src` answers). On an
> OLDER backend the Endpoints dialog warns after a save that dropped those two
> fields. The auto-fit only WRITES temperatures when the operator opts in with
> `DECISION_GATE_TEMP_AUTOFIT_ENABLED=1` — until then the fits are reported on
> the readiness page and a self-hosted server stays UNCALIBRATED (its answers
> are shadow under an act purpose) unless you tick **[calibrated]** yourself.

| Server | Start it | Base URL | Model id(s) | Notes |
|---|---|---|---|---|
| [Laya](https://huggingface.co/convaiinnovations/laya) (Apache-2.0) | `pip install "laya[serve]"` then `LAYA_DEVICE=cuda LAYA_PRELOAD=1 laya-serve` (`LAYA_API_KEY` for a bearer) | `http://host:8000/v1` | `typed-decisions`, `multilingual`, `english` (add them manually — Laya serves no `/models`) | 512-token context: set **max state chars ≈ 1200** on each model. Ships over-confident — leave **[calibrated] unset** and let the readiness job fit a temperature on your labels. |
| [JevK5](https://github.com/allebee/jevk5) (Apache-2.0) | `jevk5-serve --model alibiserikbay/JevK5 --port 8090` | `http://host:8090/v1` | `alibiserikbay/JevK5` | Applies its own calibration temperature server-side — flag **[calibrated]** if you trust the card. The GGUF build runs under `llama-server`: register that one as an OpenAI-compatible chat endpoint (Digby's logprob readout), not as systemone. |
| [NeoHorse-Jev-4B](https://huggingface.co/TokenRhythm/NeoHorse-Jev-4B) (Apache-2.0) | `neohorse-decision serve --model-dir … --port 8080` (`NEOHORSE_API_KEY` bearer) | `http://host:8080/v1` | the served model id | No `/v1/models` — add the id manually; CUDA BF16 required; takes one image. |
| [openjev](https://huggingface.co/openjev/openjev) | vLLM serving `POST /v1/systemone` (see the model card) | `http://host:<port>/v1` | the served model id | **Licence CC BY-NC 4.0 (non-commercial)** — register it for testing only unless you hold a licence. |

Then **Test** the endpoint (GET `/models` — a 404 is tolerated when you listed
the models yourself — followed by one typed `noul` + `choice` through
`POST /systemone`; it proves the answer parses, not that it is calibrated),
and open Model roles → Decision gate → **Decision backends per purpose**:

1. Add the new model as a **challenger** (per purpose, or in "Default
   challengers"). Challengers are asked in parallel with the primary and only
   ever add shadow telemetry rows — they never answer, never act, and add no
   latency: a slow one keeps running in the background under its own
   `DECISION_GATE_CHALLENGER_TIMEOUT_MS` (default 5 s) and records its row
   when it settles (`challenger_timeout` on expiry). At most
   `DECISION_GATE_CHALLENGER_MAX` (default 2) run per decision.
2. Wait for the worker's readiness job (every 6 h): the **Comparison** table
   fills with one row per (purpose, backend) — labelled n, agreement, act-band
   precision, Brier, ECE, AUROC, p50/p95 latency and fail rate on the SAME
   outcome labels as TypeSafe Jev.
3. **Promote to primary** when the challenger's row holds the flip bars. On a
   purpose that runs in `act`, act drops to shadow until the readiness job
   re-stamps this backend (≤ 6 h); thresholds fitted on the old backend are
   never carried over.

Kill switches: `DECISION_GATE_PURPOSE_BACKENDS_DISABLED=1` (ignore the
per-purpose primaries — the seat chain answers everything),
`DECISION_GATE_CHALLENGERS_DISABLED=1` (no challenger calls),
`DECISION_GATE_CHALLENGER_DETACH_DISABLED=1` (wait the old 400 ms grace and
cut slow challengers at once, as before 2026-09-26),
`DECISION_GATE_SYSTEMONE_NOUL_CRITERIA_DISABLED=1` (stop filling absent
`noul` criteria for registry servers — Laya requires them),
`DECISION_GATE_TEMP_AUTOFIT_DISABLED=1` (the job stops writing temperature
fits per backend). Everything fails open: a bad backends row is the plain
seat chain, and challengers can only add telemetry.

#### Laya behind LiteLLM (a typed-decision proxy serving e.g. `agx-laya`)

A LiteLLM proxy can front Laya as a **typed-decision model on the chat
route**: `POST <base URL>/chat/completions` with `{ model, messages:[{ role:
"user", content: <state> }], questions }` (Digby's question map, unchanged)
answers with an OpenAI chat completion whose `message.content` is a JSON
envelope `{ result: { answers, usage, model } }`. On such a proxy
`/v1/systemone` does not exist and a normal chat call with `logprobs` is
refused ("a typed-decision model, not a chat model"), so the model must be
flagged, not guessed:

> **⚠ agx-laya on the cql-llm gateway is a TYPED-DECISION SERVICE — never
> target it with bare chat completions** (ticket 3c18284e, 2026-10-20). A bare
> completion (with or without `logprobs`) is refused by the gateway's own
> guard, in ~30 ms, HTTP 400, body verbatim: `litellm.BadRequestError:
> agx-laya is a typed-decision model, not a chat model. Send "questions":
> {key: {...}} ... or "preset": ...`. The guard fires BEFORE logprobs is
> considered, so an `allowed_openai_params` pin cannot bypass it and no model
> can read token logprobs out of it — only the questions shape above answers
> (200 in ~80 ms, class probabilities in `result.answers.{key}`). Since the
> 3c18284e fix the runtime LEARNS this: when a decision-gate logprob-readout
> leg 400s with that guard body, the same leg is retried over the questions
> shape and the spec is latched for later asks — so an unflagged registration
> self-heals on its first ask. The `decision:'systemone_chat'` flag (below)
> remains the declarative first choice; `stanne-qwen3-4b-utility` is NOT a
> logprob-readout candidate either (500, invalid response object). The learned
> latch is reported by the admin decision-readiness API (`GET
> /admin/model-roles/decision-readiness` — the `typedDecisionLatched` field;
> no dedicated frontend surface yet) and can be cleared with `POST
> /admin/model-roles/decision-latch/clear` (`{}` forgets every learned spec,
> `{ "spec": "label:model" }` one) — after flagging the model properly or
> retiring the endpoint.

1. If the proxy also serves chat models (the usual LiteLLM case — one
   endpoint listing `agx-laya` next to the chat / embedding ids), keep the
   endpoint as **OpenAI-compatible chat** and, on the decision model's row in
   the Endpoints dialog, tick **[typed decisions]** and set **max state chars
   ≈ 3800** (the proxy silently truncates the state at 1,024 input tokens;
   Digby then cuts first and stamps `stateTruncated`). Leave **[calibrated]**
   unset — Laya's `confidence` is 1 − normalised entropy; Digby puts every
   non-Jev systemone backend's confidence on the max-probability scale
   (`DECISION_GATE_CONFIDENCE_NORMALIZE_DISABLED=1` keeps the server value)
   and the readiness job fits a temperature on your labels.
2. If the proxy serves ONLY decision models, register it with Server type
   **Typed-decision proxy** (`systemone_chat`) instead; Test then requires
   `GET /models` and probes the first listed model through the chat route.
3. Model roles → Decision gate → add `<label>:agx-laya` as a challenger (or
   the seat Test button / the model's **Verify** button run one typed noul +
   choice through the chat route).

**A typed-decision route on a plain chat endpoint (ticket 2df5ed65).** A
LiteLLM-style gateway registered as Server type **OpenAI-compatible** lists
its decision routes next to chat models. The endpoint **Test** button is
kind-aware for them: a model flagged **[typed decisions]** (or kind
"decision", or a decision id like `agx-laya`) is never sent the 1-token chat
probe — a chat sibling answers the auth probe and the decision model is
probed with one typed decision through the chat route; when the endpoint has
no chat sibling, the typed-decision probe is the verdict. A model that
answers the chat probe with the proxy's typed-decision **usage guide** (a
400) is automatically re-probed with the decision shape — a pass renders as
*Connected* with a note naming the model and suggesting the **[typed
decisions]** flag, never as a broken endpoint. The per-model **Verify**
button and the Decision-gate seat Test drive decision-kind models through
the questions map too (never the logprob readout's plain chat call).

**Sampled-state corpus + the offline cascade ruler.** Decision rows keep only
a hash of the state. To collect a fine-tuning / eval set, set
`DECISION_GATE_STATE_SAMPLE_RATE` (0..1, default 0 = off) or a per-purpose
`DECISION_GATE_STATE_SAMPLE_RATE_<PURPOSE>`: a drawn ask writes one extra
`loop_metrics` row (`decision_gate_state`, the state cut at
`DECISION_GATE_STATE_SAMPLE_MAX_CHARS` = 12 000) that the readiness job prunes
after `DECISION_GATE_STATE_RETENTION_DAYS` (28). Export it as laya-evals JSONL
(`{ state, questions, expected, tags }`) with
`npm run decision-gate:export -- --purpose=wake_triage --days=28 > out.jsonl`
(inside the image: `node dist/scripts/decision-gate-export.js …`). Once a
challenger has ≥ 1 week of paired rows, `npm run decision-gate:cascade --
--days=14 --purpose=wake_triage --first='cql-litellm:agx-laya' --margin=0.03`
prints, per confidence cutoff τ, how much of the purpose the cheap first leg
could answer at ≤ 10 % in-band error (exact-binomial Learn-then-Test at level
0.05, fixed-sequence strict→loose) without being worse than the primary by
more than the margin. There is **no act-path cascade** yet — the table is the
ruler an act-path cascade would be admitted against.

## Web search (optional)

Without a search provider the chat answers from the models' own knowledge and
says so: the model's search tool returns *"Web search is NOT configured on this
Digby instance"* (never a fake "no results"), the answer's "How Digby answered"
pill notes it, feeds cannot be created, the home headlines card explains why it
is empty, and Account → Admin → Setup names this section. Three ways to turn it
on, in resolution order:

- **Admin UI (recommended)** — Admin → Settings → Web search: paste your Bright
  Data API key (+ zone). It is stored server-side ENCRYPTED (never echoed back
  after save) and arms search within ~30 s — no restart, no `.env` edit.
- **Direct API via env** — set `BRIGHTDATA_API_TOKEN` in `.env`
  (https://brightdata.com, a Web Unlocker zone; `BRIGHTDATA_WEB_UNLOCKER_ZONE`
  defaults to `web_unlocker1`). No gateway needed. Takes precedence over the
  admin store when set.- **Local gateway** — run with `--profile mcp` and set
  `MCP_DIGBY_URL=http://brightdata-mcp:8000/mcp` plus a `MCP_DIGBY_TOKEN` you
  invent (it gates your own gateway). The gateway container reads
  `BRIGHTDATA_API_TOKEN` from `.env` — it is a front for the same account, so
  it needs the env key (a store-only instance searches through the direct API
  instead). A self-hosted instance never falls back to Digby's production
  `mcp.digby.example.com` gateway: a token without `MCP_DIGBY_URL` is reported as a
  misconfiguration on the checklist and ignored.

With none of these configured, the web-search tools answer "web search is not
configured — set a Bright Data key in Admin → Settings → Web search" instead of
a generic outage error, so the operator knows exactly what to do.

## Integrations (Google, GitHub, X, Slack, Asana, Xero, Discord — optional)

Until a provider is configured its card on Account → Integrations reads
**Not set up on this instance** (admins see the env names, the callback URL to
register and a link here; users see who to ask), the chat's integration status
tells the model the same, and a Connect attempt that still reaches the backend
bounces back with the reason instead of a 500. Each integration needs its own
OAuth app created at the provider's console:

1. Create the OAuth app; set its callback/redirect URL to
   `<SELFHOST_PUBLIC_URL>/api/crossmodel/<provider>/callback`
   (e.g. `…/api/crossmodel/google/callback`). The backend derives exactly that
   URL from `SELFHOST_PUBLIC_URL`; set `*_OAUTH_REDIRECT_URI` only when the
   callback you registered lives on a different host.
2. Put the client id/secret in `.env`.
3. Generate the token-encryption key (`openssl rand -hex 32`) and the shared
   backend↔MCP secret (`<PROVIDER>_MCP_API_KEY`). **Xero and Plaid** encrypt
   their tokens with `GOOGLE_TOKEN_ENCRYPTION_KEY` — the backend refuses to boot
   when `XERO_CLIENT_ID` / `PLAID_CLIENT_ID` is set without it, and a consent
   that cannot be stored bounces back as "cannot store the token" naming the key.
4. Run with `--profile mcp`.

**Slack user-token scopes** (set on your Slack app under *OAuth & Permissions →
User Token Scopes* — Digby requests them via `user_scope` at connect time; the
app config must not conflict with them):

```
channels:read  groups:read  channels:history  groups:history
im:history  mpim:history  im:read  mpim:read
search:read  users:read  chat:write
```

`im:history` / `mpim:history` (added 2026-10-12, ticket 24541fb3) are what
DM / group-DM message reads need — `im:read` / `mpim:read` alone only LIST
those conversations. Connections made before they were requested must be
reconnected once: Slack grants are additive, so re-authorizing appends the new
scopes without dropping the old ones. After a successful connect,
`GET /api/crossmodel/slack/status` reports `missingScopes` — an empty array
means DM reads work.

**Telegram** needs a real TLS public URL (Telegram calls your webhook), so it
only works in the domain/TLS setup. Create the bot with @BotFather, set
`TELEGRAM_BOT_TOKEN`, `TELEGRAM_BOT_USERNAME` and a `TELEGRAM_WEBHOOK_SECRET`
you invent, restart, then tell Telegram your webhook **once** (the Setup
checklist prints this command with your URL filled in, and shows whether
Telegram has it registered):

```bash
curl "https://api.telegram.org/bot<TOKEN>/setWebhook" \
  -d url=<SELFHOST_PUBLIC_URL>/api/crossmodel/telegram/webhook \
  -d secret_token=<TELEGRAM_WEBHOOK_SECRET>
# check: url = your webhook, last_error_message empty
curl "https://api.telegram.org/bot<TOKEN>/getWebhookInfo"
```

Until that call is made the Telegram card says *Webhook not registered* and
messages to the bot go nowhere.

**The Mac agent** (iMessage, browser, computer use) pairs against **this**
instance: the one-liner on Account → Integrations → Your Mac fetches the
installer script and the agent from your own server and passes your `/api` as
the pairing URL —
`curl -fsSL <SELFHOST_PUBLIC_URL>/install-digby-agent.sh | DIGBY_INSTALL_HOST=<SELFHOST_PUBLIC_URL> bash -s -- <code> <SELFHOST_PUBLIC_URL>/api`.
A hand-typed install must pass the same second argument, or the agent pairs
with digby.example.com. Agent self-updates come from your server too — when
`SELFHOST_PUBLIC_URL` is https; on a plain-http instance the agent ignores
update adverts, so re-run the update one-liner from the Your Mac card.

**The desktop app** (`Digby.dmg` / `Digby-Setup.exe`) is a different matter:
the installers this instance serves are the production builds and sign into
digby.example.com, not here — the Integrations tab and the public site hide the download
links on a self-host. Use the browser (Add to Home Screen on phones) or rebuild
the app with your own home / update URLs (see `imessage-agent/README.md` for the device-bridge reference).

**GitHub without an OAuth app:** you can skip creating the OAuth app entirely
and paste a personal access token in the UI (Account → Integrations → GitHub).
`GITHUB_TOKEN_ENCRYPTION_KEY` is still required — the backend encrypts every
saved GitHub credential (OAuth or PAT) with it. Without it the backend refuses
to boot when the GitHub integration is active (set `GITHUB_OAUTH_CLIENT_ID`
or `GITHUB_MCP_API_KEY`), and a PAT-only instance returns
`503 GITHUB_TOKEN_ENCRYPTION_KEY is not set on the server…` on save instead of
a bare 500 — set the key (`openssl rand -hex 32`) and restart the stack.

**Discord** is different — it has no per-user OAuth here; it uses one shared
bot token. Create a Discord application
(https://discord.com/developers/applications → New Application → Bot →
Reset Token), put that token in `DISCORD_BOT_TOKEN`, and set
`DISCORD_MCP_API_KEY` (a strong random key you generate) plus
`DISCORD_MCP_URL=http://discord-mcp:8000/mcp` (the internal Docker
network URL — note: no `-prod` suffix in the selfhost stack; the compose
service aliases the container as `discord-mcp`). The bot token lives ONLY
in the `discord-mcp` container; the
backend never sees it.

## Updating

```bash
git pull
docker compose -f docker-compose.selfhost.yml up -d --build
```

The `migrate` service applies any new schema migrations on the way up.
(Once published images exist: `docker compose pull && up -d`.)

### Auto-updates (recommended for always-on servers)

A systemd timer pulls `main`, rebuilds, and restarts the stack every 10
minutes when there are changes (no-op otherwise):

```bash
# on the self-host box, from the repo checkout:
sudo cp deploy/selfhost/digby-selfhost-update.{service,timer} /etc/systemd/system/
# edit the service if your checkout is NOT at /opt/digby (DIGBY_REPO_DIR),
# or if you run compose profiles (DIGBY_COMPOSE_PROFILES=mcp):
sudo systemctl edit digby-selfhost-update.service   # or: sudoedit /etc/systemd/system/digby-selfhost-update.service
sudo systemctl daemon-reload
sudo systemctl enable --now digby-selfhost-update.timer
```

Watch it work: `journalctl -u digby-selfhost-update.service -f`.

The updater fast-forwards a clean checkout and **refuses to touch a dirty
one** (hand-edited files) — set `DIGBY_UPDATE_FORCE=1` in the unit to
hard-reset instead. It restarts the whole stack on update, which briefly
interrupts running coding sessions; they auto-resume from checkpoint.

### Self-improvement (autonomous fix loop — YOUR copy only)

Your instance can run Digby's autonomous loop (fix → PR → merge → rebuild →
verify) against **its own copy of the repo**. Two things make that safe by
design (ticket c75b5f34):

1. **`DIGBY_INSTANCE=selfhost`** (set by `docker-compose.selfhost.yml`): the
   backend/worker resolve their loop targets from YOUR env —
   `SELF_REPO` / `GITHUB_REPO_SLUG` / `INFRA_WATCH_REPO` — and there is NO
   fallback to production Digby's repo. Point them at **your fork**:

   ```
   # .env
   SELF_REPO=you/digby-fork
   GITHUB_REPO_SLUG=you/digby-fork
   INFRA_WATCH_REPO=you/digby-fork
   ```

   With them unset, the fleet pulse / deploy telemetry / self-merge simply
   report nothing about any repo; setting any of them to the PRODUCTION repo
   (`the production Digby repository`) **hard-fails** with an `ISOLATION BOUNDARY`
   error — that is the boundary working, not a bug.
2. **Your own stack**: your postgres (the `digby_postgres_data` volume),
   your redis, your deploy = the `git pull` + rebuild above. The production
   EC2 boxes, the prod RDS instance, and every prod secret are unreachable
   from this compose file — nothing here is forwarded to it.

Connect a GitHub account (Settings → Integrations) whose token can write your
fork, and the loop runs end-to-end on your copy.

## Backups

Everything that matters lives in the `digby_postgres_data` volume:

```bash
docker exec digby-postgres pg_dump -U admin -d digby_db | gzip > digby-backup-$(date +%F).sql.gz
```

The coding-workspaces volume (`digby_coding_workspaces`) holds session
worktrees — back it up too if you have uncommitted session work that matters.

> **The server-side backup/digest tooling referenced in earlier internal docs is a
> PRODUCTION tool** (S3 offsite copy, prod container names). On a self-hosted
> box its non-prod dump leg reads this instance's own `digby-postgres`
> container, but the one-liner above is the documented self-host backup —
> do not point the script's `BACKUP_PG_HOST` at any production database.

## Troubleshooting

- **Login works but immediately logs out / "Chat not found"** — you're on
  plain http with `COOKIE_SECURE=true` (or NODE_ENV-driven Secure cookies).
  Keep `COOKIE_SECURE=false` until you enable TLS.
- **Changed the URL and the UI still calls the old one** — `NEXT_PUBLIC_API_URL`
  is baked into the frontend bundle; rebuild with `--build`.
- **Check logs**: `docker logs digby-backend`, `docker logs digby-worker`,
  `docker compose -f docker-compose.selfhost.yml ps` for health states.
- **DB access**: `docker exec -it digby-postgres psql -U admin -d digby_db`.
- **"Web search is NOT configured on this Digby instance"** in answers, no
  headlines, "New feed" disabled — no search provider: see *Web search* above
  and the checklist row.
- **Headlines card says news needs a "background summarizer model"** (or the
  starter-question chips never become personalized) — search is on but the
  Utility seat is not: no `DEEPSEEK_API_KEY` / `DASHSCOPE_API_KEY` and no model
  assigned to the Utility seat (Account → Admin → Endpoints → Model roles).
  The card says so once and stops retrying — this is a terminal state, not an
  outage: assign the Utility seat (any cheap non-streaming model, e.g. via
  your gateway endpoint) and the next scheduler tick (≤ 15 min) builds
  briefings again. Same fix for starter questions.
- **Document upload fails with "no embeddings backend configured"** — no
  embeddings model: assign the Embeddings seat (an OpenAI-compatible
  `/embeddings` endpoint that returns 1536 dimensions) or set
  `DASHSCOPE_API_KEY`; until then uploads stay un-indexed (search still works
  keyword-only) and memory rows store keyword-only.
- **Connect button missing, card says "Not set up on this instance"** — that
  provider's OAuth app env is unset (admins see which); after setting it, restart
  the stack. A Connect that bounces with "cannot store the token" means the
  token-encryption key for that provider is missing.
- **Telegram bot never answers** — the webhook was never registered or points
  elsewhere: Account → Admin → Setup → Telegram shows the registered URL and
  the `setWebhook` command.
- **The Mac agent pairs with digby.example.com instead of this instance** — the install
  command was typed without the API URL argument; copy it from the Your Mac
  card (it carries `DIGBY_INSTALL_HOST` and your `/api`).
- **Not an admin on your own instance** — set `SELFHOST_ADMIN_EMAIL` in `.env`
  to your address and sign in again (or run the psql line under *Quick start*).

## Connecting this instance to a cloud Digby (Digby Edge, Phase 3)

This instance can pair TO a cloud Digby instance over an OUTBOUND WebSocket
tunnel — no port forwarding or inbound connectivity needed (NAT/CGNAT-safe).
The cloud stores none of this instance's data; it proxies API/SSE requests
down the tunnel to this instance's own REST API.

- On the CLOUD (an instance with the relay running, e.g. this stack): an ADMIN
  mints a 10-min pairing code via `POST /api/crossmodel/instances/pair/start`.
- On THIS (edge) instance: an ADMIN redeems it via
  `POST /api/crossmodel/cloud-link/pair` with `{ cloudUrl, pairingCode }`.
  The returned `dgi_` tunnel token is stored AES-256-GCM (`cloud_link` row,
  singleton) and the backend holds the tunnel to
  `<cloudUrl>/api/crossmodel/instances/tunnel` from then on.
- Management: `GET /api/crossmodel/cloud-link` (status), `POST
  /api/crossmodel/cloud-link/unlink`; cloud side: `GET/DELETE
  /api/crossmodel/instances[/:id]` (list/revoke, owner-scoped).
- Set `CLOUD_LINK_DISABLED=1` in `.env` to keep the tunnel client off even
  when paired. Caddy routes the tunnel + proxy paths to the `relay` service
  (deploy/selfhost/Caddyfile).

Device activation (the inverse flow — the EDGE mints the code): an ADMIN on
THIS instance calls `POST /api/crossmodel/cloud-link/code/start` with the
cloud URL; the edge then dials the cloud with that code until an ADMIN on the
cloud redeems it via `POST /api/crossmodel/instances/pair/redeem` — pairing
completes on the same socket, no copy of a `dgi_` token needed. Walkthrough:
`docs/DIGBY_EDGE_TESTING.md` §3b.

**End-to-end testing guide (two instances, curl walkthrough, UI check,
troubleshooting): `docs/DIGBY_EDGE_TESTING.md`.**
