# Jev, open-weights decision models, and where Digby wastes time

**Evaluation, 2026-09-24.** Written for the owner. Scope: (1) what Jev is and how Digby should use
it; (2) the open-weights alternatives released since 2026-09-15 and which are actually better;
(3) how to speed up decision-making at the session level (chat turns, Digby Code runs, supervisor
wakes) and the backend level, and where the framework burns time for nothing. Every number below is
sourced; file references are `backend/src/modules/crossmodel/...` unless stated.

> **Status pointer (2026-09-26 02:05Z).** This is the 2026-09-24 evaluation; the engineering that followed is in
> [`DECISION_MODEL_ENHANCEMENTS_2026-09-25.md`](DECISION_MODEL_ENHANCEMENTS_2026-09-25.md) (E1–E12 + N1–N10, status lines per
> item, §6 act-flip roadmap with the live state). Live now: seat #19 answers on TypeSafe Jev `jev-1.13.0` in production
> (key in prod since 2026-09-25 16:40Z; Jev p50 ≈ 265 ms vs the DeepSeek readout ≈ 750 ms), the purpose registry is 17
> (+ probe), gate modes are store-backed and admin-editable, and **five purposes run in act** — `sweep_triage`,
> `imessage_send`, `wake_triage`, `auto_route`, `drain_triage` (owner 2026-09-26 00:20Z: "why dont you just start flipping
> things and monitoring"); the other twelve are not in act (eleven confirmed shadow; `delta_material`'s mode is unconfirmed) for the reasons listed in the enhancements doc §6.1. Auto-demote
> now judges act-period labels only (Wilson upper bound rule, a1bf00e2). Canonical records: the 2026-09-25/26 decision-gate
> bullets in [`../AGENTS.md`](../AGENTS.md) and `memory-bank/crossmodel-activeContext.md`. Numbers below are as of
> 2026-09-24 and are not updated.

## 0. The short version

**Jev** (TypeSafe AI, 2026-09-15) is not an LLM. It is a *decision model*: state in, typed answers
out (`choice` / `score` / `noul`), each with a calibrated probability, in one prefill pass with zero
output tokens. 70–500 ms, $0.042 per million input tokens, output free. Proprietary, hosted only,
waitlisted, 32k-token state.

**The open field caught up in nine days.** JevK5 (Qwen3.5-4B LoRA, Apache-2.0) is #2 of 68 on
JevBench v1.4, 1.25 points behind Jev, at 13 ms per decision on an H100 and runnable as GGUF on a
CPU. Kev-9B, NeoHorse-Jev-4B, Open-Jev-27B and Jev-Omni (multimodal) are within a few public-set
points. The adapter approach (SemIf / openjev-sglang: a frozen instruct model, one prefill, read the
option letters' logprobs) needs no training and works against DeepSeek's API and any vLLM/SGLang
server — including the GLM-5.3 and Qwen3.8-Flash-Next the owner already serves on the Spark cluster.

**But decision models are a latency/cost tier, not an intelligence tier.** On JevBench's 308 sealed
decisions, `deepseek-flash` (the model Digby already pays for) scores 94.8%; Jev 36.7%; the best
open clone 34%. So the right design is a **confidence-gated cascade**, not a swap: a ~50 ms typed
decision handles the routine 60–90% of gates and routes the uncertain remainder to the reasoning
model that runs today.

**Where the time actually goes in Digby** (memory-bank + code, September): the Fleet Supervisor is
saturated (121 turns/day, busy 19.2 h/day, p50 8 min per turn, ~12 min of thinking before the first
token at `reasoning_effort:'max'`; 66 of 121 turns were single ~1.2 KB report-ups); ~40% of one
project's spend is no-op polling; the self-audit round fires on 99.5% of runs; every small judgment
(iMessage send intent, browser driver choice, memory extraction, claim mining) is a full
reasoning-model generation; tool schemas (~30–40k tokens) ride every step; the chat system prompt
puts a second-precision clock *ahead of* ~17 KB of static doctrine so it can never prefix-cache; and
there is no time-to-first-token metric anywhere.

**Recommendations, ranked by expected wall-clock saved per unit of work:**

| # | Change | Kind | Expected effect | Effort |
|---|---|---|---|---|
| 1 | **Typed pre-triage of supervisor wakes** (`ack / coalesce / act_now / escalate_owner`) before any reasoning turn; ride `wake_queue_rider` | decision seat | Removes the ≥50% of wakes that are report-ups from the 8–19 min turn path; supervisor answers humans in minutes again | M |
| 2 | **Model-judged, default-on delta gate** for watch/poll schedules (`noul`: "did anything material change?") | decision seat | Cuts the ~40% no-op polling spend and its wall-clock; keeps the fail-open heartbeat | S–M |
| 3 | **Extend human-turn effort to Kimi K3**; keep machine wakes at `max` | config | K3 verified to accept `reasoning_effort` (seat-call.ts:137-141); human-turn-effort.ts:28-30 still skips it | XS |
| 4 | **Move the second-precision clock to the END of the system prompt** (chat and coding) so the ~17 KB static block prefix-caches; parse DeepSeek/GLM/vLLM `cached_tokens` so it is measurable | backend | Cheaper and faster prefill on every step of every loop; today cache effectiveness is invisible except for Kimi | S |
| 5 | **Parallelize the pre-first-token path**: 8 serial integration prefetches, 4 serial memory steps, 4× chat-row reads, seat resolution after context build, 5–6 serial supervisor block builds | backend | Seconds off every turn's time-to-first-token | S–M |
| 6 | **Replace the four "reason, then return JSON" micro-classifiers** with typed decisions: iMessage send intent (awaited every paired-Mac turn), browser driver choice (GLM at `high`, 30 s cap), memory-extraction gate, action-verifier claim extraction (1+N serial LLM calls pre-delivery) | decision seat | 8–30 s → ~50 ms each; the verifier one is on the pre-delivery path of every machine wake | M |
| 7 | **Auto-router from regex to decision model** (`platform/auto-router.ts` is a "zero-latency heuristic" by necessity) | decision seat | Better L1/L2/L3 placement at ~50 ms; the doctrine's own rule ("never gate on a regex; the model judges") finally affordable | S |
| 8 | **Gate the self-audit and goal-continue rounds** (`noul`: "does this final claim work the receipts don't evidence?") instead of firing them on 99.5% of runs | decision seat | Up to 20 steps saved per run when the answer is a clean no | M |
| 9 | **Cancel stragglers**: L2 checkers that missed the 75 s simple-question window keep running to 900 s at `max` unmerged; L3 colleagues past the 12-min ceiling | backend | Spend and provider-concurrency (Z.AI 1302) relief | S |
| 10 | **Run read-only tools concurrently inside a step**; stop re-running the full context build per delegation; fire-and-forget the coding opening title (12 s awaited today) | backend | Seconds to minutes per coding run | M |
| 11 | **Add `ttft_ms` / phase metrics to loop_metrics** | telemetry | Nothing above can be proven without it | XS |

Items 1, 2, 6, 7, 8 share one piece of infrastructure: a **Decision seat** (`decision`, seat #19)
behind a `decide()` helper speaking the `/v1/systemone` contract, run in **shadow mode first**
(log the typed answer next to the reasoning model's actual outcome; act only once agreement and
calibration on Digby's own traffic are measured). Section 6 specifies it; section 8 sequences it.
## 1. What Jev is (verified 2026-09-24)

Jev is TypeSafe AI's **decision model** ("System One" model), released in limited early access on
2026-09-15 alongside a US$40M seed round led by DCVC. It is not an LLM: it does not decode text. You
send a **state** (string, JSON object or text array) plus one or more **typed questions**, and it
returns, for every question at once, a typed answer with a **calibrated probability distribution**:

| Primitive | Returns | Cap |
|---|---|---|
| `choice` | best option + probability per option + confidence | 255 options (quality unestablished past ~20 on the open clones) |
| `score` | position on an ordered scale (expected value) + per-level probabilities | — |
| `noul` | P(statement about the state is true), 0–1 | — |

Mechanics (inferred by Archer Hume, corroborated by every open rebuild): the state is encoded once
into a KV cache; each question is an isolated branch (no cross-question attention); each option's
`</opt>` hidden state is scored against the question's `<decide>` hidden state by a **pointer head**;
softmax over those scores is the answer. One prefill, zero output tokens. Trained with **RLCD**
(reinforcement learning for calibrated decisions — proper scoring rules such as log/Brier loss, so
"80% confidence ≈ 80% correct"). Token accounting is strictly additive (state + questions), so N
questions over one state cost ~one state read.

Hard numbers:

| Fact | Value | Source |
|---|---|---|
| Latency | 70–500 ms per request (JevBench measured p50 0.652 s / p95 0.722 s from Germany incl. network) | TypeSafe; JevBench v1.4 |
| Price | **$0.042 per 1M input tokens, output free**; ≈ $0.040 per 1,000 decisions at 950 tokens/decision | TypeSafe, Vercel, JevBench |
| Context | 32,000 tokens | Vercel model page |
| TypeSafe's own eval | 67.8% agreement with reference vs GPT-5.6 Sol 74.1% / Claude Opus 5 73.1%; 61.8% vs 79.1% on invoice processing | TypeSafe eval, via geotoolbox |
| JevBench v1.4 | **#1 of 68** (score 63.29): 86.6% on 534 public decisions, **36.7% on 308 sealed decisions**, hard-tier ECE 0.061 | fstandhartinger/jevbench |
| Access | Proprietary, hosted only, **waitlist**. `POST api.typesafe.ai/v1/systemone` or Vercel AI Gateway `https://ai-gateway.vercel.sh/typesafe/v1/systemone` (model `typesafe-ai/jev`; free promo on the gateway ends **2026-09-25**). No weights, no self-host licence. | TypeSafe, Vercel docs |

Request/response contract (the de-facto standard every open clone now serves):

```json
POST /v1/systemone
{ "model": "typesafe-ai/jev",
  "state": "…any text or JSON…",
  "questions": {
    "refund":  { "type": "noul",   "instructions": "Is the customer asking for money back?" },
    "team":    { "type": "choice", "instructions": "Which team should handle this?",
                 "criteria": { "billing": "Charges and refunds", "technical": "Bugs and outages" } },
    "urgency": { "type": "score",  "instructions": "How soon must this be resolved?",
                 "criteria": ["can wait", "this week", "today"] } } }
→ { "answers": { "refund": {"type":"noul","noul":0.98},
                 "team":   {"type":"choice","choice":"billing","probabilities":{"billing":0.96,"technical":0.04},"confidence":0.96},
                 "urgency":{"type":"score","score":1.9,"probabilities":{…},"confidence":0.71} },
    "usage": { "input_tokens": 275, "output_tokens": 0 } }
```

What it is good for (TypeSafe's own framing, and the pattern Vercel/eve ship): the *judgment* step of
an agent loop — routing, gating tool calls, "is this done / grounded / in scope / safe", picking the
next model, escalation — where the answer space is known in advance and the result feeds an `if`.
What it is not: generation, explanation, open answer spaces, or a replacement for deterministic rules.

Two honest caveats before anyone gets excited:
1. **Accuracy is not frontier.** On TypeSafe's own eval Jev is 6–17 points below GPT-5.6 Sol. On
   JevBench's sealed set every system, Jev included, collapses to 30–37%. Decision models win on
   *latency, cost and schema-safety*, not on intelligence.
2. **Schema-validity ≠ correctness.** "Never hallucinates" means it cannot return a malformed
   answer; it can absolutely pick the wrong valid option.

## 2. The open-weights field (nine days old, moving daily)

Everything below is Apache-2.0 or MIT unless noted, serves (or can serve) the `/v1/systemone`
contract, and returns zero output tokens.

### 2a. Dedicated decision models (trained head, prefill-only)

| Model | Base / size | Head | Latency (hardware) | Best published numbers | Caveats the authors state |
|---|---|---|---|---|---|
| **JevK5 v0.2** (alibiserikbay) | Qwen3.5-4B + merged LoRA r16; also **2B** and **GGUF** (llama.cpp: NVIDIA/AMD/Intel/Apple/CPU) | SemIf letter-logit readout, one temperature T=1.532 | **p50 13.5 ms / p95 14.9 ms** (H100, CUDA graphs); 1–4k-token docs p50 30 ms / p95 161 ms; ~9 GB bf16 | **JevBench #2 of 68, #1 open** (62.04 vs Jev 63.29); public 85.3% vs Jev 86.6%; sealed 33.1% vs 36.7%; hard-tier ECE 0.066; Q8 GGUF matches bf16 on 228/231 | English only; refuses >16,384 tokens; sealed-set drop; distilled from Qwen3.6-27B-thinking synthetic Qs |
| **Kev-9B** (Jared Palmer) | Qwen3.5-9B-Base + LoRA r16 + pointer head; family 0.8B / 4B / 9B (Qwen3.5) and 8B (Qwen3) | pointer head, built-in T=2.30 | Kev-4B answers 6 questions in **18–50 ms** (H100 vs L40S); CUDA/ROCm/MLX; 9B slow on Mac (DeltaNet has no MPS kernel) | OOD locked test **0.852 acc / 0.237 Brier** (Jev dev 0.857 / 0.211); OOD ECE 0.042 as served (Jev 0.049); confident-error rate 4.0% (Jev 3.7%); 0.00 unknowable items answered ≥0.9 (Jev 0.09) | coverage at ≤5% error 0.45 vs Jev 0.70; MMLU-Pro 0.515 vs 0.840; cannot subtract dates (ships `date_facts` preprocessor); Kev-4B is JevBench #24 (36.1) |
| **NeoHorse-Jev-4B** (TokenRhythm) | NeoHorse-1-4B (Qwen3.5-class, multimodal: text + one image) + pointer head | pointer head | not published in card; vLLM/SGLang adapters + native HTTP (`/v1/systemone`, `/v1/decision`); ~9.1 GB | six-benchmark open-weights aggregate **77.70** (Open-Jev-9B 75.67, Kev-4B 74.25, Laya 58.24); JevBench public 75.73; Kev suite 81.92 | results dated 2026-09-24 by the vendor; no JevBench composite |
| **Open-Jev-9B / 2B / 27B-v1.1** (ZefanCai) | Qwen3.5-9B / 2B, Qwen3.8-27B; LoRA (PEFT) | pointer/decision head, non-generative | not published | JevBench public 77.13 (best open on that column in NeoHorse's table) | **JevBench composite only 11.2 (#65)** — slow/expensive as measured, $0.249/1k; adapters not merged; explicitly "no parity claim" |
| **openjev 4B v5** (AlexWortega) | Qwen3.5-4B cross-encoder (NLI: entail/contradict/neutral); also 2B, 0.8B; **image-capable** | one forward pass *per option* → order-invariant, deterministic (0/231 flips) | not published | JevBench public **0.814** (Jev 0.866, SemIf 0.810); RAGTruth AUROC 0.932, HaluBench 0.937, LLMBar 0.834 | **prompt injection drops JevBench 0.833→0.467**; shell-command safety reviewer only 0.600 acc; trained on other benchmarks' test splits |
| **Jev-Omni** (akhilaaa3) | Gemma-4-12B-IT, 30k-question fine-tune; **text, image, audio, video** | classifier head | **83 ms** text (~2k tokens), 26 ms image, 31 ms audio, 504 ms video (H200); ~50 GB fp32 | JevBench public 86.15%; DecisionBench-Medium 87.57%, **ECE 0.040**; MMAU 63.1% | one question per call (state re-sent per question); ≤20 options; heavy |
| **Laya** (Convai Innovations) — HF #1 trending | ModernBERT-large **421M** (EN, 512 ctx) / mmBERT-base 322M (45 languages, 1024 ctx) / typed-decisions 421M; trained from scratch, RLCD | 2-layer decision head + option scorer + act-vs-escalate gate | **32.8 ms** single / 72.3 ms for 10 batched (T4); ~9 ms P50 claimed on GPU; **CPU 193–464 ms per question** (and 49 s warm on a 4-vCPU VPS in one independent test) | typed-decisions 0.766 *fine-tuned on the benchmark's own train split*; **zero-shot 0.362 (below the 0.461 majority baseline)**; ECE 0.081 after per-question temperature fit (raw 0.466); Banking77 0.425 vs Jev 0.870 | JevBench composite 30.3 (#36); degrades past ~20 options; it is "a fast base to specialise", not a zero-shot judge |
| **openJev-verdict-2.0** (Heman10x) | ModernBERT-base **149.6M**, RLCD, 512 ctx | dual-channel calibration heads | **20–25 ms** GPU; **<35 ms in-browser WebGPU (<600 MB)**; trained in 8.8 h on a GTX 1660 Ti | typed-decisions 2,000 held-out: **77.10% acc, Brier 0.0636, ECE 0.0144** (Laya 76.6/0.066; Jev 72.7/0.148 on that set); option-flip 4.76% | weights trained on <71-token contexts; hard-tier 36.9%; small-context only |
| **Tiny-Jev / Tiny-Jev-1.7B** (lostargon) | Qwen3-0.6B / 1.7B, merged LoRA, ~100k synthetic states | option-marker linear head, temperature-calibrated | "a few ms" consumer GPU; **~20–50 ms on Apple M-series** | in-distribution 95.8% / ECE 0.004; OOD template families 93.5% / 0.033; **fully held-out domains (code review, search intent) 53.1% / ECE 0.299** | the two held-out domains are exactly the agent-guardrail shapes Digby cares about → needs fitting on Digby data |
| **mini-Jev** (samatv256) | **frozen** Qwen3-0.6B + 1.1 MB MLP head, grouped softmax over candidates | candidate-scoring (tool/model/next-action selection) | 76–85 ms (GH200, shared-prefix KV path) | synthetic: 73.0% semantic choice, 67.6% stress | explicitly experimental; but ships **Jev Decisions v1**: 12M canonical agent-decision records (6.2M choice-eligible, 1.06M trajectories) — training data for exactly Digby's tool-routing problem |
| **AgentJev-0.6B** (aimeigaoshou) | Qwen3-0.6B, SFT + RLCD on executed coding pairs | noul: "is this implementation actually done?" | — | coding-completion acc 57.8%, AUROC 0.589 | barely above chance today — a signal that "is the work done" is *hard* for tiny heads; Digby's evidence guard should not be replaced by this yet |
| Hopper / Winnow-12B Q8 / reflex-4B / djev (DiffusionGemma) / metask-jev-4b / Jobe | various | native typed | Hopper p50 0.134 s; djev p50 0.247 s; metask p50 **0.086 s** (JevBench, self-hosted ×2+0.15 s penalty applied) | JevBench #3 59.43 / #4 55.58 / #5 53.99 / #6 52.23 / #7 47.78 / 44.74 | community entries; check licences per repo before shipping |

### 2b. "Any LLM as a decision model" adapters (no training; one prefill + first-token logprobs)

| Adapter | How | Works with | Numbers |
|---|---|---|---|
| **SemIf** (TheoLeeCJ, MIT) — the protocol JevK5 and JevBench's baseline use | render state + question + lettered options, `max_tokens=1`, read the next-token logprobs of the option letters, softmax ÷ temperature | vLLM, SGLang, llama.cpp, **any OpenAI-compatible API that returns logprobs, DeepSeek API explicitly**, MLX | frozen Qwen3.5-4B: **1.02 s direct vs 5.33 s JSON generation (5.2×)**; shared-suffix batching 2.3 → 20 decisions/s; Qwen3.8-27B EXL3 balanced acc 0.958; JevBench #8 (47.69) with a 4B base |
| **openjev-sglang** (ekzhang) | SGLang radix cache: warm the shared state prefix once, fire up to **64 questions** concurrently with `max_new_tokens=1` + label logprobs; `/v1/systemone` server | Qwen3.6-35B-A3B on a B200 (Modal); any SGLang model with single-token labels | "<1 s for 64 tasks"; 32,768 tokens/branch |
| **deepseek-jev** (skeptrune) | same idea against DeepSeek V4.1 Flash (SGLang scoring) | repo 404s today (renamed/removed) | — |
| AnyJev (Nokia), Simple Jev (featherless), open-alternative-jev (Ikermoel) | logit extraction wrappers, some image-capable | any HF model | open-alternative-jev on Qwen3.6-27B: 0.737 acc, **ECE 0.020**, 582 ms/case |

### 2c. What JevBench v1.4 actually says (68 systems, 34 open)

Score = harmonic mean of Intelligence, Calibration, Speed, Cost (each 0–100; speed 100 at 0.1 s,
−20/decade; cost 100 at $0.001 per 1,000 decisions, −30/decade; sealed items 20% of Intelligence).

- Native typed models occupy the entire top 10. **JevK5 (open, 4B) is within 1.25 points of Jev.**
- General LLMs adapted through JSON schema sit at the bottom: **DeepSeek V4.1 Flash (thinking) is #71
  with score 4.8 at $0.594 per 1k decisions** — yet it is the *best-calibrated system in the whole
  benchmark* (ECE 0.009, verbalized probabilities). Digby already pays for exactly that model at
  exactly that price for every small judgment.
- Every system, Jev included, drops to 26–37% on the sealed set. Treat all "accuracy" numbers as
  in-distribution; **the only number that matters for Digby is agreement with Digby's own outcomes**,
  which nobody has measured yet.

### 2d. Can Digby's existing providers do the SemIf trick today?

| Provider (seat) | `logprobs`/`top_logprobs` | Implication |
|---|---|---|
| DeepSeek direct (`deepseek-flash`: Double Checker, Utility, memory pipeline) | **Yes**, `top_logprobs` 0–20; `thinking:{type:'disabled'}` + `max_tokens:1` | Zero-infra decision seat today: one prefill, 20 option letters, input-only cost (DeepSeek's cache-hit pricing applies to the repeated doctrine prefix) |
| Moonshot direct (`kimi-k3`: Digby lead, supervisor) | **Yes** (AI SDK provider docs) — but K3 always reasons first, so `max_tokens:1` would only cut off reasoning | Not a decision seat; keep Kimi for generation |
| Z.ai (`glm-5.3`, `glm-5.3-flash`) | **No** (absent from the OpenAPI spec) | Cannot be a decision seat via API |
| Self-hosted GLM-5.3 W4A16 (canada-quant cluster, vLLM/SGLang) | **Yes** (both servers return logprobs; SGLang has radix-cache prefix sharing) | The openjev-sglang pattern runs unchanged on the owner's own cluster: 64 typed questions per state, prefill-only |
| Custom endpoints (Digby Edge registry: Ollama/vLLM/LM Studio/OpenRouter) | vLLM/llama.cpp yes; Ollama partial | A registered `decision` endpoint can host JevK5-GGUF, Kev-4B or NeoHorse-Jev-4B behind `/v1/systemone` |
## 3. What the independent benchmark actually says (JevBench v1.4.0, generated 2026-09-23, 76 systems, 70 open)

Score = harmonic mean of Intelligence / Calibration / Speed / Cost (25% each). Speed: 100 at 0.1 s,
−20 per decade. Cost: 100 at $0.001 per 1,000 decisions, −30 per decade. Sealed items are 20% of
Intelligence. Self-hosted endpoints get a ×2 + 0.15 s latency penalty ("an assumption, not a
measurement"). Rows below are extracted from `results/v1.4/jevbench-v1.4-results.json`.

| # | System | Kind | Score | Public acc (534) | **Sealed acc (308)** | Hard ECE |
|---|---|---|---|---|---|---|
| 1 | Jev 1.13.0 (TypeSafe, hosted) | native typed | 63.29 | 0.866 | **0.367** | 0.061 |
| 2 | **JevK5 v0.2** (Qwen3.5-4B LoRA, open) | native typed | 62.04 | 0.853 | 0.331 | 0.066 (card) |
| 3 | Hopper (open) | native typed | 59.43 | 0.823 | 0.341 | 0.060 |
| 4 | Winnow-12B Q8 (open) | native typed | 55.58 | 0.857 | 0.331 | 0.120 |
| 8 | SemIf on frozen Qwen3.5-4B (no training) | letter-logit readout | 47.69 | 0.810 | 0.263 | 0.121 |
| 12 | jqv — Qwen3-32B zero-shot logits | letter-logit readout | 44.35 | 0.801 | 0.282 | 0.088 |
| 15 | Raw Qwen3-4B-Instruct direct logits (no temperature) | raw logits | 40.95 | 0.697 | 0.273 | **0.452** |
| 22 | Kev-4B | native typed | 36.14 | 0.662 | 0.224 | 0.402 |
| 24 | GPT-6 Luna (low effort, JSON) | LLM, verbalized | 35.11 | 0.991 | **0.929** | — |
| 25/26 | SimpleJev Qwen3.8-27B / NInfer **Qwen3.8-Flash-Next** | letter-logit readout | 34.6 / 34.0 | 0.866 / 0.896 | 0.357 / 0.341 | 0.061 / 0.054 |
| 32 | Laya (ModernBERT-large, CPU) | native typed | 30.25 | 0.584 | 0.308 | 0.206 |
| 33 | openjev-sglang (Qwen3.6-35B-A3B, SGLang) | letter-logit readout | 27.65 | 0.853 | 0.331 | 0.094 |
| 48 | GPT-5.6 Luna (low, JSON) | LLM, verbalized | 18.51 | 0.974 | 0.890 | 0.071 |
| 59 | Open-Jev 9B | native typed | 11.20 | 0.775 | 0.299 | 0.190 |
| 65 | **DeepSeek V4.1 Flash (thinking default, JSON)** | LLM, verbalized | 4.77 | **0.978** | **0.948** | **0.033** (Brier 0.044) |

Four conclusions that matter for Digby:

1. **Decision models are a latency/cost tier, not an intelligence tier.** On the sealed set the
   reasoning LLM Digby already runs (`deepseek-flash`) scores 94.8%; Jev scores 36.7%; the best open
   clone 33–34%. Anything consequential (evidence verdicts, "is this work actually done", merge
   decisions) must keep a path to the reasoning model.
2. **The fast tier is still worth having.** DeepSeek's JSON-schema path costs $0.594 per 1,000
   decisions and takes seconds to tens of seconds; the native tier costs $0.02–0.04 and answers in
   13–300 ms. Public-set accuracy (the in-distribution shapes: routing, policy yes/no, adequacy,
   severity, enum extraction) is 85–90% for the top native systems — good enough to *gate*, not to
   *decide alone*.
3. **Calibration comes from fitting, not from the base.** Raw instruct-model logits have ECE 0.45;
   the same base with a SemIf prompt and one fitted temperature has ECE 0.12; a distilled LoRA
   (JevK5) 0.07; Jev 0.06. Digby has the labels to fit this (every guard/gate/supervisor outcome
   is already in `loop_metrics`).
4. **Frozen Qwen3.8-Flash-Next with a letter-logit readout (NInfer row) posts 0.896 public accuracy
   and ECE 0.054 with zero training** — and that exact model is already served on the owner's Spark
   S4 (llama.cpp GGUF). The cheapest credible Digby decision seat may be a model the fleet already
   hosts.

## 4. Where Digby wastes time today (from AGENTS.md, memory-bank 2026-09-10 → 09-24, the 09-13 supervisor review)

Owner directives that frame every recommendation: "full steam" (09-11, 29 gates observe-only),
"no idle time" (09-14), "users get the first available answer" (09-18), no confirm cards for
machine-to-machine sends (09-15/18), "what the hell have you done all night" (09-22 → human turns at
`reasoning_effort:'high'`), no L2 checker on machine turns (09-22), every model call is an
admin-editable seat (09-22). Rejected: auto-stretching machine cadences (09-11).

| Waste class | Measured | Root cause | Decision-model fit? |
|---|---|---|---|
| **Fleet Supervisor saturation** | 121 turns/24 h, busy 19.2 h/day, p50 8 min / p90 19 min per turn; glm-5.3 at `max` = ~12 min of thinking before the first content token (717 s; `high` = 135 s); machine wakes average ~299k input tokens; **66 of 121 turns were single ~1.2 KB report-ups**; hook lag p50 67 / p90 115 min | Every wake, however trivial, is a full reasoning turn over a 1M-char context | **Yes — triage.** A typed pre-read ("does this report-up need a supervisor action?", choice: ack / coalesce / act-now / escalate-owner) at ~50 ms would let ≥50% of wakes coalesce without a reasoning turn |
| **No-op polling lanes** | ~40% of CanLaw spend is no-op polling; watch lanes mostly no-op ticks (CQL poller ~$36/day, Path C $130/105 runs, S3 watch $34/52); 151 busy-skip alarms/day; self-audit round fires on 99.5% of runs and 85% of finals are self-audit text | Schedules run the model to discover nothing changed; the opt-in **delta gate** (probe cheap sources, skip when unchanged) is the only default-on lever and is opt-in per schedule | **Yes — "did anything material change?"** noul over the probe diff + last run summary; make the delta gate model-judged and default-on |
| **L2 cross-check waiting** | 20% of checkers killed at 420 s with the lead blocked since step 2; ~100 machine-origin checker runs/day nobody read (removed 09-22); simple L2 E2E now 26 s | Checker runs for every human turn regardless of whether the question is contestable | **Partly.** A noul "is this claim time-sensitive / disputable / high-stakes?" can decide whether to *spawn* the Double Checker at all; the 09-18 progressive reconcile already fixed the blocking |
| **Provider rejection round-trips** | Z.AI code 1302 rejected 210 glm-5.3 turns in 3 h across 16 sessions, each step paying a rejected round trip before falling back to kimi-k3; a custom utility seat paid 221 × 30 s timeouts in one hour | Concurrency ceiling on one key; fallback only after failure | No — this is a seat/provider decision (second Z.AI key, or move the machine seats to the self-hosted GLM-5.3 cluster) |
| **Deterministic verifier reject-backs** | ~20 pre-delivery reject-backs/24 h, 38 retries/24 h, one 16 min long | Fabricated ids / future clocks caught only after a full turn | **Yes — pre-submission check** on the final's cited ids and clocks is already deterministic; a noul "does this final claim work that the tool receipts do not evidence?" can run *before* delivery for ~50 ms instead of after a 10-min turn |
| **Utility reasoning overhead** | reasoning adds ~8 s vs 0.7 s per extraction; thinking-off JSON extractors answered `{"add":{}}` 12/12 so they were moved to thinking-on | JSON generation by a reasoning model for what is a classification | **Yes — the canonical Jev use-case.** Memory "is there a fact worth remembering?", followup-chip selection, title choice among candidates, feed relevance, kid-status tone are all `choice`/`noul` |
| **Context assembly** | history load 5.9 s → 13 ms (fixed); retrieval embedded 17.5k-char wake envelopes (27 s vs 1.6 s) dropping memory on ~50% of machine turns (fixed); vecMs p90 still 5–9 s cold; project_learnings p50 3.7 / p90 9.3 s | Backend, not model | No — plain engineering (halfvec copy, smaller scan cap) |
| **Lanes never delegate / never search** | delegation in 2/209 runs; 57 kimi-k3 sessions/24 h: delegation 5, web 1, memory 21 | Doctrine asks the model to judge; the model doesn't | Partly — a `score` "how parallelizable is this plan?" could *prompt* delegation, but this is mostly a seat/prompt problem |
| **Deploy churn** | waves 49–73 min; 38 deploy-interrupt replays 09-17 / 12 on 09-18, each a 10–20-min machine run re-run from scratch (resume-brief now) | Infra | No |
| **Web search latency** | BrightData direct tier timed out 67×/4 h (45–60 s each) ≈ 55 min lane wall-clock per 4 h (hedged at 12 s now); ~20 s/search normal | Vendor | No — but a noul "does answering this need a live search?" on *machine* turns would cut searches that exist only because the doctrine says "when uncertain, search" |

Net: the biggest single lever is not a new model but **routing the ~60% of supervisor wakes and the
~40% of schedule ticks that produce no action away from a 5–20-minute reasoning turn**. That is a
typed decision over a small, code-selected state — exactly the shape Jev-class models are built for,
and exactly the shape where JevBench's public-set 85–90% accuracy applies.
## 5. Where Digby already makes typed decisions with a reasoning model

Every row below is a place where the framework asks a generative model a bounded question and
parses the answer. Each is the canonical Jev shape. "Today" is what the code does; "cost" is what
the user or the lane waits for.

| Decision point | Where | Today | Cost | Typed form |
|---|---|---|---|---|
| **Supervisor wake worth a turn?** | `platform/hooks.service.ts` `deliverHookGroup`; `platform/supervisor.service.ts:133` (debounce 0); `supervisor_noop` is only classified *after* the turn by note length (`supervisor.service.ts:376-383`) | Every `run_completed`, report-up and hook wakes a 24-step / 45-min reasoning turn over ~299k tokens | p50 8 min / p90 19 min; 66/121 turns were 1.2 KB report-ups | `choice` {`ack_only`, `coalesce_next_sweep`, `act_now`, `escalate_owner`} over {event kind, sender lane, 1–2 KB payload, open directives count, last sweep summary}; `noul` "does this event change what the supervisor should do next?" |
| **Schedule tick: did anything change?** | `coding/delta-gate.service.ts` (opt-in; deterministic probes; fail-open; ~420k tokens per ungated firing) | Watch lanes run the full model to discover "no change" | ~40% of CanLaw spend; 151 busy-skip alarms/day | `noul` over {probe diffs, last run's one-line outcome, schedule prompt}: "is there a material change this lane must act on?" — default-on for schedules whose prompt is watch-shaped (itself a one-time `choice`) |
| **Patience level for `mode='auto'`** | `platform/auto-router.ts` — "PURE, zero-latency heuristic (no model call)"; regex + length; "bias cheap" | Regex picks L1/L2/L3 | 0 ms but wrong placement costs a 480 s L2 or a 40-min L3 | `choice` {`single_thinking`, `thinking`, `deep_research`} + `noul` "needs live web?" + `noul` "code/repo intent?" |
| **Browser/computer driver** | `browser-agent/router.ts:199-222` — `glmChat` at `reasoningEffort:'high'`, 600 tokens, 30 s timeout, JSON parse | GLM reasons to pick cloud/local/computer | seconds to 30 s per `browser_task` | `choice` {`cloud`, `local`, `computer`} over the task text + availability flags |
| **iMessage send intent** | `imessage/nlp.ts:93-140` `classifySendDraft` — utilityChat, 700 tokens, 8 s cap, awaited on every turn with a paired online Mac (`chat-agent.service.ts:3629-3658`) | A reasoning model returns JSON `{send, recipient, message}` | up to 8 s added to *every* answer | `noul` "is the latest user turn asking to send a message now?" gates the extraction; only a `true` pays for the utility call |
| **Memory extraction gate** | `langgraph/memory.graph.ts:1753-1860` — distill on every ≥300-char answer, thread state, profile → serial flat facts (90 s thinking), project state; 1–5 utility calls per turn | Extraction runs whether or not there is anything to extract | background, but it is the utility seat's biggest load | `noul` "does this exchange contain a new durable user fact / project decision / thread commitment?" (three nouls, one prefill) → run only the extractors that fire |
| **Pre-delivery claim mining on machine wakes** | `platform/action-verifier.ts:2540-2579` — one LLM call for the note + one per tool-args blob, serial, uncapped, 30 s each; then `guardMachineWakeFinalAnswer` (`chat-agent.service.ts:2893`) | LLM extracts claims; deterministic lanes then check ids/clocks; citation-class reject-back re-runs the whole wake (16-min retry logged) | pre-delivery on every supervisor wake | deterministic id/clock mining (already exists) + one batched `noul` per mined claim "is this claim evidenced by the receipts?"; the LLM extractor becomes the fallback for the unmatched remainder |
| **Self-audit / goal-continue** | `coding/agent.ts:4240-4329`; `coding/verify.service.ts:52-58` — up to 40 continue rounds × 20 steps; self-audit once per plan state, fires on 99.5% of runs | The model is asked "are you SURE it's done?" as another full turn | up to 20 steps per run | `noul` "does the final claim work the tool receipts do not evidence?" + `choice` {`done`, `continue`, `blocked`} over {plan state, last receipts, final text}; audit only when uncertain |
| **Verify failure class** | `verify.service.ts` (exit 137 / empty output → `[ENVIRONMENTAL]`) | deterministic today — keep it | — | (no change; a `choice` {`code`, `environment`, `flaky_dependency`} could widen coverage later) |
| **Reflection consult on failure streak** | `coding/reflection.ts:30,93` — up to 2 per run, 45 s each, on the Double Checker seat | A reasoning model diagnoses the streak | 45 s × 2 | `choice` {`same_approach_retry`, `change_approach`, `ask_user`, `stop`} first; consult the reasoning seat only on `change_approach` |
| **Worker/seat routing** | `worker_seat_route` metric; `coding/delegation.ts:57-64`; `roles.ts` | Fixed per role | — | `choice` over available seats by task shape (later; low priority) |
| **Suggested-questions critic** | `suggested-questions.service.ts:93-95,931,952` — draft (120 s thinking) then critic (100 s thinking), serial | Two thinking calls per user per day | background | `score` "quality 0–3" per drafted chip replaces the critic call |
| **Feed relevance / news topics** | `worker.ts` feed-refresh every 2 min (up to 5 LLM call sites); news topics | utility calls | background | `score` relevance per item over {item, user interests memory} |
| **Strike adjudication** | daily batch | LLM verdict per strike | background | `choice` {`real`, `false_positive`, `unclear`} — and this is the labelled dataset for fitting the seat (below) |
| **Destructive-action confirmations, `NEVER_AUTONOMOUS_TOOLS`, money, other users' data** | deterministic lists | deterministic | — | **Leave deterministic.** openjev's own card: as a shell-command safety reviewer a 4B decision head scores 0.600 and catches 37% of deny-worthy commands; one injected line flips 0.833 → 0.467 |

## 6. Proposed architecture: one Decision seat, a cascade, shadow first

### 6a. Contract
Add seat #19 **`decision`** ("Decision gate") to `model-endpoints/model-roles.service.ts`
`MODEL_ROLES`, non-streaming, with a `decide()` helper next to `seatCompletion` in `seat-call.ts`:

```ts
type Question =
  | { type: 'noul';   instructions: string }
  | { type: 'choice'; instructions: string; criteria: Record<string, string> }   // ≤ 20 options in practice
  | { type: 'score';  instructions: string; criteria: string[] };                // 2–10 ordered levels
type Answer =
  | { type: 'noul';   noul: number }
  | { type: 'choice'; choice: string; probabilities: Record<string, number>; confidence: number }
  | { type: 'score';  score: number;  probabilities: Record<string, number>; confidence: number };
decide(state: string | object, questions: Record<string, Question>, opts: { purpose: string; timeoutMs?: number })
  : Promise<{ answers: Record<string, Answer>; ms: number; backend: string; usage: { input_tokens: number } }>
```

This is byte-compatible with TypeSafe's `/v1/systemone`, which every open clone also serves
(JevK5 `jevk5-serve`, Kev `kev.serve`, NeoHorse `neohorse-decision serve`, Laya `laya-serve`,
Open-Jev `jev.server`, openjev-sglang). So the seat's built-in options are *backends*, not models:

| Backend | What it is | When |
|---|---|---|
| `systemone:<label>` | any registered custom endpoint exposing `POST /v1/systemone` (JevK5-GGUF on Box C's CPU or a Spark; NeoHorse/Kev on a GPU; Jev via Vercel AI Gateway or TypeSafe if the waitlist clears) | preferred once one is up |
| `logit:deepseek-flash` | SemIf-style readout on the existing DeepSeek key: `thinking:{type:'disabled'}`, `max_tokens:1`, `logprobs:true`, `top_logprobs:20`, lettered options, softmax ÷ fitted temperature (DeepSeek documents `top_logprobs` 0–20; Digby's fast-seat path already disables thinking) | **day one, zero infra** |
| `logit:<label>:<model>` | the same readout against a vLLM/SGLang/llama.cpp endpoint that returns logprobs (the Spark's GLM-5.3 W4A16, Qwen3.8-Flash-Next — the "NInfer Qwen3.8-Flash-Next" JevBench row is exactly this: 0.896 public accuracy, ECE 0.054, no training) | when the cluster has headroom |
| `json:<seat>` | today's behaviour (reasoning model returns JSON) | the fallback for low confidence and for `deepseek`-less installs |

Z.ai's API returns no logprobs, so `glm-5.3` via API cannot be a logit backend; Moonshot returns
logprobs but Kimi K3 always reasons first, so it is not a prefill-only candidate either.

### 6b. The cascade (how every call site uses it)
1. Build a **small, code-selected state** (the event payload, the diff, the tool args — never the
   transcript). Jev's own jaggedness page: "accuracy falls as the state grows with content
   unrelated to the decision"; JevK5 refuses >16k tokens; Laya's English checkpoint has ~320
   tokens of state. Digby's 299k-token wakes are the anti-pattern.
2. `decide()` with one to five questions. ~13–300 ms.
3. **Act on high confidence; escalate the rest.** Thresholds per action class, TypeSafe-style:
   read-only/cheap actions ≥ 0.6, anything that skips work (coalesce a wake, skip a schedule run,
   skip an audit) ≥ 0.85, and never below 0.5. Below threshold → today's path (the reasoning seat).
4. **Fail open to today's behaviour** on timeout/error — the seat can only remove work, never add
   risk. Same rule as the delta gate.
5. Record a `loop_metrics` row per decision (`decision_gate`: purpose, backend, ms, answer,
   confidence, and later the outcome) so calibration is measured, not assumed.

### 6c. Shadow mode, then fit, then act
- **Shadow (week 1):** call `decide()` at each site but do not act; log the typed answer next to
  what the reasoning model actually did (the supervisor's `supervisor_noop`/`supervisor_action`
  classification, the schedule run's "no change" outcome, `guard_strike` rows, the auto-router's
  level vs. the level the user manually re-selected). This yields agreement, coverage-at-≤5%-error
  and ECE per purpose on Digby's real traffic — the only numbers that matter (JevBench's sealed set
  shows every public score is in-distribution).
- **Fit (week 2):** one temperature per (backend, purpose) from the shadow log (SemIf/Kev/JevK5 all
  do exactly this; raw logits are ECE 0.45, fitted 0.07–0.12). If coverage at ≤5% error is below
  ~60% for a purpose, that purpose stays on the reasoning seat.
  *Status 2026-09-25 (WI-I):* the readout now persists its raw per-option logprobs on every
  decision row (`loop_metrics decision_gate meta.logits`, keyed by option key so a row pairs
  directly with the outcome's `actual`), and `backend/scripts/decision-gate-fit-temperature.ts`
  (`cd backend && npm run decision-gate:fit -- --days=14 [--purpose=…]`) fits T per
  (backend, purpose) by NLL, prints Brier/ECE at T=1 vs the fit and the exact
  `DECISION_GATE_TEMP_<PURPOSE>=` line (runtime clamp [0.7, 10]). Measured before the fit:
  wake_triage readout noul was exactly 0 on 402 / exactly 1 on 27 of 429 rows — confidence 1.0
  everywhere, so the 0.85 threshold had no margin. The fit needs outcome rows with a real
  `actual` (WI-C) — until a purpose has ≥ 50 paired rows the script marks it NOT READY and no
  temperature should ship; the readout must not be the acting backend for wake_triage before then.
- **Act (week 3):** flip purposes one at a time behind `DECISION_GATE_<PURPOSE>=1`, observe-only
  telemetry unchanged, kill switch `DECISION_GATE_DISABLED=1` (the same posture as every other
  gate since 2026-09-11). *2026-09-25 (WI-S):* the per-purpose mode is a STORE-BACKED fleet-wide
  setting now (Account → Admin → Endpoints → Model roles → Decision gate; `PUT
  /admin/model-roles/decision-modes`) — one save reaches A, B and C within 30 s; env
  `DECISION_GATE_MODE_<PURPOSE>` is the fallback when nothing is stored (`docs/REMOTE_OPS.md`).
  A decision row also names every leg that failed before the answering one (`meta.legErrors`,
  `meta.legIndex`, WI-H) so a silent Jev outage cannot swap the calibrated backend for the
  uncalibrated readout unnoticed under act.
- **Train (later, optional):** Digby already produces labelled decisions at scale
  (`guard_strike` outcomes, strike adjudication verdicts, `supervisor_noop` vs `_action`,
  schedule skip vs. act, user re-selections of the patience level). Kev and JevK5 publish the
  recipe: LoRA r16 + pointer/letter head, a few thousand records, 15 minutes to a few hours on one
  GPU (JevK5: Qwen3.5-4B; Kev-9B delta fine-tune: 15 min). mini-Jev's **Jev Decisions v1** dataset
  (12M agent-decision records, 6.2M choice-eligible) is a public warm start for tool/next-action
  routing. This is the path to a Digby-specific decision model that beats every generic one on
  Digby's shapes — and the Spark cluster is idle enough to train it.

### 6d. Which open model to actually stand up
- **Day one:** no model — `logit:deepseek-flash`. Cost is input-only at $0.15/M with prefix-cache
  discounts on the repeated instruction block; latency is one prefill (~0.5 s first-byte figure
  already measured for the computer-vision seat with thinking off).
- **First self-hosted backend:** **JevK5** — Apache-2.0, #1 open on JevBench, `/v1/systemone`
  server included, 13 ms/decision on an H100, GGUF build for CPU/any GPU (Q8 matches bf16 on
  228/231 items), 2B variant at 3.5 GB. Run the GGUF on Box C (m7i-flex.2xlarge, 8 vCPU) for the
  gates that tolerate ~200–500 ms, or bf16 on one Spark for ~15–30 ms.
- **If multimodal decisions are needed** (screenshots in browser/computer tasks, KB images):
  **Jev-Omni** (Gemma-4-12B, text/image/audio/video, 26–83 ms on an H200, ECE 0.040) or
  **NeoHorse-Jev-4B** (text + one image, vLLM/SGLang adapters).
- **Skip for Digby:** Laya (zero-shot near chance, 320-token state, CPU 193–464 ms per question;
  a fine-tuning base, not a judge), open-jev-deberta (512 tokens, OOD 0.69), Open-Jev 9B/27B as
  served today (batch 1, no prefix cache, JevBench composite 11.2), AgentJev ("is the code done?"
  at 57.8% — the shape Digby cares most about is the one tiny heads do worst at).
- **Hosted Jev itself:** worth an API key for the shadow comparison only if the waitlist clears;
  Vercel's gateway promo is free through 2026-09-25, then $0.042/M. It is the calibration
  reference, not the production backend — Digby's rule since 2026-09-22 is open models on admin
  seats, and Jev has no weights.

## 7. Speed-ups that need no new model (from the code map)

Ranked by wall-clock saved per unit of work. File refs are exact as of `main` c8d39c6.

**Human-visible latency**
1. `chat-agent/human-turn-effort.ts:28-30` skips kimi-k3 ("unknown param support") — but
   `seat-call.ts:137-141` already sends `reasoning_effort` to K3, "verified live 2026-09-22". Extend
   the human-turn override to K3 (`high` for L2/L3; `low` is defensible for L1). Also apply
   `humanTurnEffort()` to the Double Checker on human turns (`chat-agent.service.ts:1945` forces
   `max`). Machine wakes stay `max`.
2. **System-prompt ordering for prefix caching.** `chat-agent/chat-context.ts:943-944` starts
   `systemContext` with a second-precision `[CURRENT DATE & TIME]` block, followed by
   `SHARED_AI_RULES` (12.2 KB) + `DIGBY_PLATFORM_IDENTITY` (5.0 KB) + integration status; the coding
   prompt appends `roleGuidance` after its datetime block (`coding/agent.ts:993`). Move the clock (and
   anything per-turn) to the tail; round it to the minute. Then parse `prompt_cache_hit_tokens`
   (DeepSeek) and `prompt_tokens_details.cached_tokens` (GLM/vLLM) at `coding-model.ts:919-928` and
   price hits correctly in `cost.ts:43-49`. Today only Moonshot's `prompt_cache_key` is observable.
3. **Pre-first-token path** (`crossmodel.controller.ts` → `chat-agent.service.ts:372-1590`):
   `integration-context.ts:24-468` runs Google/Xero/Slack/Asana/GitHub/X/Plaid/iMessage one after
   another with no overall deadline → `Promise.allSettled` with a 3 s ceiling;
   `langgraph/memory.graph.ts:1290-1293` runs conversation → user state → project state → blocks in
   series → parallelize the loads; the chat row is read 4× (`controller:1104,1162`,
   `chat-context.ts:682`, `chat-agent.service.ts:1519`) → read once; seat resolution
   (`chat-agent.service.ts:1570-1590`) waits for the context build → start it alongside; supervisor
   wakes build 5–6 context blocks serially (`:452-494`, `:1541-1558`) → `Promise.all`.
4. **`classifySendDraft` on every paired-Mac turn** (`chat-agent.service.ts:3629-3658`) — until the
   decision seat exists, a cheap "looks like a send" pre-filter avoids the 8 s utility wait on
   answers that plainly are not messages.
5. **Stragglers.** Simple-question checkers that miss the 75 s window run to 900 s at `max`, are
   never merged, and the late reconcile is not armed on that path (`chat-agent.service.ts:2057-2063,
   2714-2720`) → cancel or arm the reconcile. L3 colleagues past the 12-min `DISPATCH_CEILING_MS`
   keep running (`:2243-2259`) → cancel once the lead has written its final.

**Machine lanes**
6. **Tool schemas on every step**: ~140 filtered coding schemas (~30–40k tokens) and ~130 chat
   schemas ride every call (`coding/agent.ts:2182-2188`; `coding-model.ts:785-788`), and the
   per-turn filter changes the list (derail breaker, on-demand groups) which invalidates the
   provider's prefix cache. Keep the list stable within a run and move dynamic groups behind
   `load_tool_group`; count schemas in `compaction.ts:105`'s budget.
7. **Serial tools within a step** (`coding/agent.ts:3313` → `await runTool` at `:3525`): run
   read-only tools (`search_engine`, scrape, `search_memory`, `get_*`/`list_*`) concurrently under
   the existing 24-call cap.
8. **Redundant summarization of one exchange**: session summary + run journal + thread state +
   distill (`coding/coding-memory.service.ts:538,579,645`; `coding/run-journal.service.ts:113`;
   `langgraph/memory.graph.ts:1610,1839`) → one distill producing all records; run the three
   coding-memory calls in parallel meanwhile.
9. **Opening coding turn awaits the title for 12 s** (`coding/run-executor.ts:115,835`) → fire and
   forget, as chat already does.
10. **Workers re-run the full context build per delegation** (`coding/agent.ts:942-972`) → pass the
    parent's blocks down.
11. **Ungated schedules and no machine deadline**: `computeMachineRunDeadlineMs` returns null unless
    `RUN_DEADLINE_ENABLED=1` (`coding/schedule.service.ts:1602`); the delta gate is opt-in per
    schedule. Default the (model-judged) delta gate on for watch-shaped schedules; a soft deadline
    that *tells* the model to wrap up (not a kill) is compatible with "full steam".
12. **Provider concurrency**: Z.AI code 1302 rejected 210 glm-5.3 turns in 3 h across 16 sessions,
    each paying a rejected round-trip before the kimi-k3 fallback. This is a seat decision: a second
    Z.AI key, or move the *machine* seats (supervisor wakes, lanes) to the self-hosted GLM-5.3 W4A16
    on the Spark cluster once its gateway emits JSON SSE with a tool-call parser
    (`--enable-auto-tool-choice --tool-call-parser`; the raw-text gateway answers prose-only).
13. **Telemetry gap**: no `ttft_ms`, no per-phase duration, no checker-gate wait, no per-tool
    latency in the 125 `loop_metrics` kinds. Add `ttft_ms` and `phase_ms` first — every item above
    is otherwise unprovable.

## 8. Rollout (three weeks, each step shippable alone)

| Week | Ship | Files | Verify |
|---|---|---|---|
| 1 | `ttft_ms` + `phase_ms` metrics; K3 human-turn effort; clock-to-tail + `cached_tokens` parsing; parallel integration prefetch + memory loads; straggler cancels | `platform/loop-metrics.service.ts`, `chat-agent/human-turn-effort.ts`, `chat-agent/chat-context.ts`, `coding/agent.ts:740-1103`, `coding/coding-model.ts:919-928`, `cost.ts`, `integration-context.ts`, `langgraph/memory.graph.ts`, `chat-agent.service.ts` | prod `ttft_ms` p50 before/after on human L2 turns; DeepSeek `prompt_cache_hit_tokens` > 0 on step ≥2 |
| 1 | **Decision seat, shadow mode**: `decision` seat + `decide()` with the `logit:deepseek-flash` backend; shadow calls at the supervisor wake, schedule tick, auto-router and iMessage sites; `decision_gate` metric | `model-endpoints/model-roles.service.ts`, `seat-call.ts`, new `platform/decision-gate.ts`, `platform/hooks.service.ts`, `coding/delta-gate.service.ts`, `platform/auto-router.ts`, `imessage/nlp.ts` | shadow rows with agreement vs. actual outcome per purpose |
| 2 | Temperature fit per purpose from shadow rows; act on `wake_triage` and `delta_material` behind env flags; JevK5-GGUF `/v1/systemone` on Box C registered as `systemone:jevk5` | `platform/decision-gate.ts`, `scripts/deploy/` (one container), `docs/SELF_HOST.md` | supervisor p50 turn time and turns/day; `schedule_delta_skip` rate; zero missed material changes in the heartbeat window |
| 3 | Act on browser driver, iMessage gate, memory-extraction gate, verifier claim batching, self-audit gate; tool-schema stability + concurrent read-only tools | `browser-agent/router.ts`, `imessage/nlp.ts`, `langgraph/memory.graph.ts`, `platform/action-verifier.ts`, `coding/agent.ts` | per-purpose coverage at ≤5% error ≥ 60%, else the purpose stays on the reasoning seat |
| later | Fit a Digby-specific LoRA (Kev/JevK5 recipe) on the shadow + adjudication corpus; serve it on a Spark next to GLM-5.3 | `canada-quant/*` | beats `logit:deepseek-flash` on Digby's own held-out decisions |

Owner directives this respects: no new confirm cards; machine lanes keep `max`; nothing here adds a
gate that can bounce a final — the seat only *removes* reasoning turns, and fails open to today's
behaviour.

## 9. Risks and what not to do

- **Do not hand consequential verdicts to a decision head alone.** Sealed-set accuracy of every
  decision model is 26–37% vs 94.8% for `deepseek-flash`. Evidence verdicts, merge/publish, "is the
  work done", money, other users' data stay on reasoning seats or deterministic rules. The cascade
  design makes this structural: low confidence → today's path.
- **Prompt injection.** Decision models "do not treat injected instructions as hostile" (TypeSafe's
  own jaggedness page); openjev drops from 0.833 to 0.467 with one injected line. Build states from
  code-selected fields, never from raw tool output or user text where an attacker could plant
  instructions; keep the deterministic credential/destructive checks in front.
- **Calibration drift.** ECE is fitted per purpose on Digby traffic; re-fit on a schedule (the daily
  strike-adjudication batch is a natural place) and alarm when observed error at the acting
  threshold exceeds 5% — the same observe-only telemetry posture as every other gate.
- **Option count and state size.** Keep `choice` ≤ 20 options (quality "not established" past 20 on
  every open card; Jev caps at 255) and states to a few KB. Hierarchical choices, not 77-way lists.
- **Arithmetic, dates, negation, multi-hop.** All weak spots on Jev's own list; Kev cannot subtract
  dates. Compute those in code (`date_facts`-style preprocessing) and ask the model only the
  semantic question.
- **Do not re-add a debounce or a hard deadline to get the supervisor's time back** — the owner
  rejected both. Triage *before* the turn is the compliant lever.
- **Licences.** JevK5, Kev, NeoHorse, Jev-Omni, Laya, openjev-verdict: Apache-2.0. SemIf, openjev
  (AlexWortega), openJev-verdict code: MIT. Hopper/Winnow/reflex/djev: check per repo before
  shipping. Jev: proprietary, no self-host.

## 10. Sources

Jev: [Wikipedia](https://en.wikipedia.org/wiki/Jev_(AI_model)) · [What is Jev (geotoolbox)](https://geotoolbox.ai/blog/what-is-jev-ai) · [TypeSafe docs index](https://docs.typesafe.ai/llms.txt) · [API reference](https://docs.typesafe.ai/api.md) · [Models](https://docs.typesafe.ai/models.md) · [Confidence](https://docs.typesafe.ai/confidence.md) · [Confidence-gated routing](https://docs.typesafe.ai/patterns/confidence-routing.md) · [Jev 1.13 jaggedness](https://docs.typesafe.ai/model-jaggedness/jev-1.13.md) · [Function calling cookbook](https://docs.typesafe.ai/cookbooks/function_calling.md) · [LLM guardrails cookbook](https://docs.typesafe.ai/cookbooks/llm_guardrails.md) · [Jev with coding agents](https://docs.typesafe.ai/introduction/coding-agents.md) · [Vercel AI Gateway: TypeSafe API](https://vercel.com/docs/ai-gateway/sdks-and-apis/typesafe) · [Vercel model page](https://vercel.com/ai-gateway/models/jev) · [eve auto-approve tool calls with Jev](https://vercel.com/kb/guide/auto-approve-tool-calls-eve-jev) · [Archer Hume, Jev's Architecture Unmasked](https://archerhume.com/posts/jevs-architecture-unmasked/) · [HF blog: how to use Jev](https://huggingface.co/blog/sora-2/how-to-use-the-jev-ai-model-a-step-by-step-develop) · [HF blog: Jev vs LLMs](https://huggingface.co/blog/sora-2/jev-ai-vs-llms-when-should-you-use-a-decision-mode) · [boringbot: the hype of Jev](https://boringbot.substack.com/p/the-hype-of-jev-explained-a-deep)

Benchmarks: [JevBench repo](https://github.com/fstandhartinger/jevbench) · [v1.4 results JSON](https://raw.githubusercontent.com/fstandhartinger/jevbench/main/results/v1.4/jevbench-v1.4-results.json) · [Benchmark Heaven leaderboard](https://benchmarkheaven.com/jev-models) · [HN thread](https://news.ycombinator.com/item?id=49800574) · [Luni/laya-jev-benchmark](https://huggingface.co/datasets/Luni/laya-jev-benchmark) · [Open-weights Jev alternatives (Rohit Raj)](https://rohitraj.tech/notes/jev-alternatives-open-weights-decision-models-2026) · [madewithjev directory](https://madewithjev.com/open-source-jev) · [Flowtivity: Laya benchmarked](https://flowtivity.ai/blog/laya-open-source-jev-alternative/) · [mer.vin: Laya](https://mer.vin/news/laya-the-33ms-open-source-decision-model-beating-jev/) · [Open weights, restricted use](https://highlearningrate.substack.com/p/open-weights-restricted-use-2026)

Models: [JevK5](https://huggingface.co/alibiserikbay/JevK5) · [JevK5-GGUF](https://huggingface.co/alibiserikbay/JevK5-GGUF) · [JevK5 runtime](https://github.com/allebee/jevk5) · [Kev repo](https://github.com/jaredpalmer/kev) · [Kev-9B](https://huggingface.co/jaredpalmer/kev-9b) · [Kev-0.5B](https://huggingface.co/jaredpalmer/kev-0.5b) · [NeoHorse-Jev-4B](https://huggingface.co/TokenRhythm/NeoHorse-Jev-4B) · [Open-Jev-9B](https://huggingface.co/ZefanCai/Open-Jev-9B) · [Open-Jev-27B-v1.1](https://huggingface.co/ZefanCai/Open-Jev-27B-v1.1) · [openjev (AlexWortega)](https://huggingface.co/AlexWortega/openjev) · [Jev-Omni](https://huggingface.co/akhilaaa3/Jev-Omni) · [Laya](https://huggingface.co/convaiinnovations/laya) · [open-jev-deberta-v3-large](https://huggingface.co/com-kotobalabs/open-jev-deberta-v3-large) · [openJev-verdict-2.0](https://github.com/Heman10x-NGU/openJev-verdict-2.0) · [Tiny-Jev](https://huggingface.co/lostargon/Tiny-Jev) · [mini-Jev + Jev Decisions v1](https://huggingface.co/samatv256/mini-Jev) · [AgentJev-0.6B](https://huggingface.co/aimeigaoshou/agent-jev) · [Hopper](https://github.com/hopit-ai/hopper) · [SemIf](https://github.com/TheoLeeCJ/SemIf) · [openjev-sglang](https://github.com/ekzhang/openjev-sglang)

Provider capability: [DeepSeek chat completions (logprobs, top_logprobs 0–20)](https://api-docs.deepseek.com/api/create-chat-completion) · [Moonshot logprobs (AI SDK provider)](https://ai-sdk.dev/providers/ai-sdk-providers/moonshotai) · [Z.ai chat completion (no logprobs)](https://docs.z.ai/api-reference/llm/chat-completion)

Internal: `AGENTS.md` §Gate defaults, §Fleet supervisor; `memory-bank/crossmodel-activeContext.md`, `memory-bank/crossmodel-progress.md` (2026-09-10 → 09-24); `docs/reviews/2026-09-13-framework-supervisor-project-review.md`; `docs/reviews/2026-09-08-spark-cluster-review.md`; code as cited.
