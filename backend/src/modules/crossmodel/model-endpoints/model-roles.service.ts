/**
 * Digby Edge — instance-wide MODEL ROLES config.
 *
 * The Digby experience is an ensemble of NAMED SEATS ("Digby" the lead, the
 * "Double Checker" second opinion — Level 2 parallel answer AND Level 3
 * council colleague, ONE model — the "Triple Checker" third opinion on the
 * Level 3 council, "The Helper" fast tier, the background utility model;
 * owner renames 2026-09-15). Each seat
 * has always been a hardcoded built-in model — on a self-hosted Edge instance
 * with no cloud provider keys, every hardcoded seat 401s the moment a
 * workspace session or chat touches it (tickets 09f6e89a, 68b1aba3), and even
 * on prod the lineup was not customizable.
 *
 * This service stores an ADMIN-managed override per role. A value is either a
 * built-in model id (coding-model.ts) or a Digby Edge '<label>:<modelId>'
 * custom-endpoint spec (model-endpoints.service.ts registry). Empty/absent =
 * the built-in default, so a fresh instance behaves byte-identically.
 *
 * Storage: ONE row in the namespaced context store (['instance','model-roles']
 * / 'config') — no migration, works on prod and Edge alike. Reads are cached
 * in-process for 30s (same TTL idiom as the registry cache) and FAIL OPEN to
 * the defaults: a DB hiccup must never kill a chat or coding run.
 *
 * Consumers resolve via coding-model.ts resolveRoleModelForRun (dynamic import
 * — keeps this module off the jest-sensitive load-time graph) and hand the
 * resulting spec to resolveProviderForRun, which already understands both
 * built-ins and registry specs.
 */

import axios from 'axios';
import logger from '../../../utils/logger';
import { AppError } from '../../../middleware/error-handler';
import prisma from '../../../config/database';
import { storeGet, storePut } from '../memory/context-store';
import { resolveRegistryModel } from './model-endpoints.service';
import { truncateMatryoshka } from './matryoshka';
import { runToolSchemasIfLoaded } from '../coding/run-tools-registry';
import { frontierSeatsAllowed, frontierSeatsRefuse } from './provider-class';
import { webSearchStatus } from '../platform/instance-setup';

export type ModelRoleKey =
  | 'chat_orchestrator'   // "Digby" — lead + synthesizer, every patience level
  | 'chat_quick'          // "Quick answers" — the Auto QUICK lane's lead (dynamic roster 2026-10-03): lookups / live facts, thinking off; unset FOLLOWS The Helper seat
  | 'supervisor'          // "Fleet Supervisor" — supervisor chats (owner ask 2026-09-10: a DIFFERENT decoder here = coverage)
  | 'project_supervisor'  // "Project Supervisor" — per-project supervisor chats (isProjectSupervisor); default FOLLOWS the supervisor seat
  | 'double_checker'      // "Double Checker" — the ONE secondary model: L2 independent parallel answer AND L3 council colleague (owner 2026-09-15)
  | 'triple_checker'      // "Triple Checker" — the third model: L3 council colleague
  | 'coding_default'      // default workspace/coding model when no stored pref survives
  | 'coding_helper'       // "The Helper" — helper-tier workers (editor/verifier) + web/youtube pipe summarizers
  | 'coding_reviewer'     // "Reviewer" — the reviewer + cross_checker WORKERS a lane delegates to; unset FOLLOWS the Double Checker seat (a different model than the coder = independent review)
  | 'coding_architect'    // "Architect" — the planner + architect workers; unset = the lane's own coding model
  | 'coding_explorer'     // "Explorer" — the explorer + web_researcher workers; unset = the lane's own coding model
  | 'utility'             // background utility (titles, follow-ups, memory extraction) — '' = built-in DeepSeek→DashScope chain
  | 'embeddings'          // RAG/memory embeddings — '' = built-in DashScope text-embedding-v4; overrides MUST return 1536 dims
  | 'rerank'              // RAG/memory reranker — '' = built-in DashScope qwen3-rerank (RRF fallback on failure)
  | 'asr'                 // speech-to-text — '' = built-in chain: self-hosted STT (STT_BASE_URL) when set, else DashScope qwen3-asr-flash
  // ── Capability seats (2026-09-22, owner: "the user can fully configure and edit ALL models") —
  //    every model call that used to be a fixed constant is a seat now. ──
  | 'vision_describe'     // "Image reader" — image → description for text-only peers, KB image ingestion, feedback screenshots
  | 'pdf_ocr'             // "PDF reader (OCR)" — PDF page images → layout-faithful Markdown (was Gemini)
  | 'browser_agent'       // "Browser agent" — the browser_task sub-session + its cloud/Mac/computer routing decision
  | 'computer_vision'     // "Computer-use vision" — screenshot → next action for computer_task (was gpt-5.6-luna)
  | 'kids'                // "Digby Kids" — every child sub-account chat (was a fixed qwen3.6-flash)
  | 'tts'                 // text-to-speech — '' = built-in DashScope qwen3-tts-flash (was OpenAI tts-1)
  // ── Decision seat (2026-09-24, owner: "build it all … with TypeSafe's API, then deploy the open-source alternative") ──
  | 'decision'            // "Decision gate" — typed noul/choice/score judgments for the harness's own gates (platform/decision-gate.ts)
  // ── Image generator seat (2026-09-24, owner: "add image generation model and admin endpoint and defaults to generate images") ──
  | 'image_generate';     // "Image generator" — the generate_image tool + POST /images/generate (image-generate.ts); built-ins are IMAGE models, never chat ids

/**
 * Seats renamed / collapsed on 2026-09-15 (owner: "remove the names …
 * cross-checker, logician and professor and just change them to Double
 * Checker & Triple Checker … there shouldn't be a cross checker and a
 * logician — the secondary should be the same model on both patience level 2
 * and 3"). Stored rows and API callers using the OLD keys keep working: on
 * READ an old key feeds its new seat (an explicit new key always wins; among
 * aliases the first listed wins), on WRITE an old key is translated, and the
 * next save of ANY role drops the old keys from the row (self-heal).
 * `utility_fallback` (the 2026-09-15 AM seat) became the utility seat's
 * CUSTOM FALLBACK — see `fallbacks` below.
 */
export const LEGACY_ROLE_ALIASES: Record<string, ModelRoleKey> = {
  chat_cross_checker: 'double_checker',
  council_logician: 'double_checker',
  council_professor: 'triple_checker',
};
export const LEGACY_UTILITY_FALLBACK_KEY = 'utility_fallback';

/**
 * Ticket 7a078b4d (2026-09-28): a seat-name SYNONYM an agent naturally
 * derives from the admin surface, healed to the seat it uniquely names. The
 * admin panel's own label for the decision seat is "Decision gate" while the
 * seat KEY is `decision` — an agent executing the [INFRA ALERT — decision
 * backend] playbook (which said "check with the Model roles Test button",
 * naming the UI control, not the tool form) probed
 * `test_model_role {role:'decision_gate'}` and 400'd deterministically, 3×,
 * tripping the tool-failure breaker on the Fleet Supervisor. The backend
 * SPECS (jev / deepseek-flash — DECISION_BUILT_IN_OPTIONS) are healed at the
 * agent TOOL seam instead (fleet-ops-tools.ts), where they become the
 * `candidate` of a decision-seat probe — exactly what "probe the jev
 * backend" means. A synonym here MUST name exactly one seat (a two-seat
 * synonym is a defect in this table, not a heal). Scope (review 7a078b4d):
 * stored rows are READ strictly (isModelRoleKey — a synonym never loads from
 * a row), but healable CALLERS include the admin WRITE path through
 * normalizePatch — PUT /admin/model-roles {roles:{decision_gate:…}} now
 * lands on the decision seat, exactly as LEGACY_ROLE_ALIASES keys already
 * do (same class, admin-only route).
 */
export const ROLE_SYNONYMS: Record<string, ModelRoleKey> = {
  decision_gate: 'decision',
};

export interface ModelRoleDef {
  key: ModelRoleKey;
  /** User-facing seat name — the SAME string the chat UI's status stream and
   *  More-info cards show for this seat (frontend model-display SEAT_LABELS). */
  persona: string;
  description: string;
  /** '' means "the built-in multi-provider chain" (utility/embeddings/rerank/asr)
   *  — or, when `inheritsFrom` is set, "whatever that seat resolves to". */
  defaultModel: string;
  /** Project-supervisor preflight 2026-09-14: a seat whose UNSET value follows
   *  another seat's RESOLVED model (its override, else its built-in) instead of
   *  a hardcoded id. Lets a new seat ship with zero behaviour change until the
   *  owner assigns it — the owner decides seats, not the code. One hop only. */
  inheritsFrom?: ModelRoleKey;
  /** Harness roadmap item 4 (2026-09-19): a WORKER seat whose UNSET value means
   *  "the model of the lane that delegates" (the session's coding model —
   *  project pick > user pick > Workspace default), i.e. exactly what the
   *  worker ran on before the seat existed. '' here is not a built-in chain;
   *  servability/test probe the Workspace default seat as the representative. */
  followsSession?: boolean;
  /** Owner 2026-09-15 ("add custom fallback … so the admin can override the
   *  normal digby fallbacks to other custom models when the preferred models
   *  failed"): seats whose runtime has a fallback seam the admin may point at
   *  a model of their own. Unset = Digby's built-in fallback behaviour. */
  fallbackable: boolean;
  /** What happens when the seat's model fails and NO custom fallback is set
   *  (shown under the fallback picker). */
  builtInFallback: string;
}

/** Ordered as the admin UI lists them. Defaults MUST mirror the hardcoded
 *  constants at the seams (chat-agent.service.ts, coding-model.ts,
 *  coding-data.service.ts, utility-llm.ts) — the drift guard in
 *  model-roles.service.test.ts pins the coding ones. */
export const MODEL_ROLES: ModelRoleDef[] = [
  { key: 'chat_orchestrator', persona: 'Digby', defaultModel: 'kimi-k3', fallbackable: true,
    description: 'The lead. Digby answers every chat at every patience level: runs the tools, talks to you, and writes the final answer. At Level 2 and 3 it also reconciles what the checkers found.',
    builtInFallback: 'If this model returns nothing or rejects the request, the turn is finished on the built-in kimi-k3.' },
  // Dynamic roster phase 1 (owner chose option B, 2026-10-03 — docs/DYNAMIC_ROSTER_PLAN_2026-10-03.md):
  // the lead of the Auto QUICK lane — weather, scores, prices, definitions,
  // simple how-tos — run with web tools, thinking OFF and a short step budget.
  // Unset FOLLOWS The Helper seat (the owner's own example: "a simple helper
  // agent set to qwen3.8 flash or 27b"), so the seat ships with no new pick to
  // make. A failure finishes the turn on this seat's custom fallback, else on
  // the Digby seat (helper-seat.ts pickLeadFallback).
  { key: 'chat_quick', persona: 'Quick answers', defaultModel: '', inheritsFrom: 'coding_helper', fallbackable: true,
    description: 'Answers quick lookups in Auto chats — weather, scores, prices, definitions, simple how-tos — with live web search, thinking off and a short step budget, so they come back in seconds instead of minutes. Used only when Auto routes a message to the Quick lane (Dig deeper still climbs to the full lead + checker). Unset = follows The Helper seat. Pick a fast model that calls tools reliably.',
    builtInFallback: 'If this model fails, the turn is finished on the custom fallback when set, else on the Digby seat (the normal lead).' },
  // 2026-09-03 model wave: the L2 checker seat became a full autonomous peer
  // (was the GLM one-shot drafter). 2026-09-10: its default moved from
  // deepseek-v4-pro to deepseek-flash — DeepSeek V4.1 Flash, the vendor's
  // single current model (V4 Pro is routed to it from 2026-09-14).
  // Owner ask 2026-09-10: the supervisor on a DIFFERENT decoder than the lanes
  // it audits catches what a same-model reviewer is blind to. Same autonomy,
  // tools, and raised budget as before — only the model seat is swappable.
  { key: 'supervisor', persona: 'Fleet Supervisor', defaultModel: 'kimi-k3', fallbackable: true,
    description: 'Runs the Fleet Supervisor chat (fleet sweeps, cross-checks, dispatch). Full platform toolset and autonomy either way — pick a model DIFFERENT from the lanes it audits for independent coverage (e.g. deepseek-flash while lanes run kimi/glm).',
    builtInFallback: 'If this model returns nothing or rejects the request, the wake is finished on the built-in kimi-k3.' },
  // Project-supervisor preflight 2026-09-14: the per-project supervisor layer
  // (#741) resolved the SAME 'supervisor' seat as the fleet chat, so there was
  // no knob to run the layer that spawns and steers workers on a different
  // model. Its default is NOT a hardcoded id — it FOLLOWS the supervisor seat's
  // resolved model (inheritsFrom), so nothing changes until the owner sets it.
  { key: 'project_supervisor', persona: 'Project Supervisor', defaultModel: '', inheritsFrom: 'supervisor', fallbackable: true,
    description: 'Runs each project\'s supervisor chat — the layer whose job is to fan out workers (start_coding_session, steer) and report up to the Fleet Supervisor. Unset = follows the Fleet Supervisor seat. Pick a model that uses tools reliably — the 2026-09-13 review measured 58% zero-tool machine finals on kimi-k3 vs 0% on glm-5.3 / deepseek-flash.',
    builtInFallback: 'If this model returns nothing or rejects the request, the wake is finished on the built-in kimi-k3.' },
  // Owner 2026-09-15: ONE secondary model for both levels — the same "Double
  // Checker" answers Level 2 independently and sits on the Level 3 council.
  { key: 'double_checker', persona: 'Double Checker', defaultModel: 'deepseek-flash', fallbackable: true,
    description: 'Digby\'s second opinion — one model for both levels. Level 2: answers the same question independently, in parallel, with its own web tools; Digby then reconciles the two answers. Level 3: the first colleague on the research council.',
    builtInFallback: 'If this model fails, Level 2 continues on Digby\'s answer alone (flagged lower confidence) and Level 3\'s lead covers the mission itself.' },
  { key: 'triple_checker', persona: 'Triple Checker', defaultModel: 'glm-5.3', fallbackable: true,
    description: 'Digby\'s third opinion. Level 3 only: the second colleague on the research council, working alongside the Double Checker until Digby synthesizes.',
    builtInFallback: 'If this model fails, the research lead covers the mission itself.' },
  { key: 'coding_default', persona: 'Workspace default', defaultModel: 'glm-5.3', fallbackable: true,
    description: 'The coding model stamped on new workspace sessions when no (valid) per-user pick exists.',
    builtInFallback: 'On a transient provider failure (429/5xx/connection), a coding run backs off and retries, then fails over to this custom fallback — or, for a custom-endpoint seat with no fallback set, to the built-in glm-5.3 — with attribution (ticket fe6f0b0b). A hard failure still surfaces as a failed run, never a silent swap.' },
  { key: 'coding_helper', persona: 'The Helper', defaultModel: 'qwen3.6-27b', fallbackable: true,
    description: 'Fast tier for mechanical work: the web_pipe / youtube_pipe digests, verifier subagents, and any worker the lead delegates with model:"helper". Called non-streaming — a default-thinking custom model should be flagged "no-think" on its endpoint entry. Browser tasks, image description, PDF OCR, computer use, Digby Kids and speech each have their own seat below.',
    builtInFallback: 'If a custom helper model fails, the built-in qwen3.6-27b answers once instead (with honest attribution).' },
  // Harness roadmap item 4 (owner-approved 2026-09-19; Claude Code / Cursor /
  // Devin route sub-agents per role): the WORKER roles a lane delegates to get
  // their own seats. The Reviewer seat FOLLOWS the Double Checker by default —
  // the owner's standing independence rule ("a DIFFERENT decoder than the
  // lanes it audits catches what a same-model reviewer is blind to") applied
  // to code review; the other two ship byte-identical (unset = the lane's own
  // model) so the owner decides seats, not the code. An explicit
  // model:'helper'|'premium'|<id> on the delegate call still wins over a seat.
  { key: 'coding_reviewer', persona: 'Reviewer', defaultModel: '', inheritsFrom: 'double_checker', fallbackable: false,
    description: 'Runs the reviewer and cross_checker workers a coding lane delegates to (read-only second opinions on a diff, a plan or a claim). Unset = follows the Double Checker seat, so the review runs on a DIFFERENT model than the coder by default — independent coverage, the same rule as the Fleet Supervisor. Assign a model here to pin it.',
    builtInFallback: 'If the seat\'s model cannot be served on this instance (missing provider key), the worker runs on the lane\'s own coding model instead — logged, never refused.' },
  { key: 'coding_architect', persona: 'Architect', defaultModel: '', followsSession: true, fallbackable: false,
    description: 'Runs the planner and architect workers (read-only: decompose the task, map the code, propose the design). Unset = each lane\'s own coding model, exactly as before. Assign a stronger reasoning model here to lift every lane\'s planning without touching the coders.',
    builtInFallback: 'Unset = the lane\'s own coding model. An assigned model that fails simply fails that worker, which the lead retries or covers itself.' },
  { key: 'coding_explorer', persona: 'Explorer', defaultModel: '', followsSession: true, fallbackable: false,
    description: 'Runs the explorer and web_researcher workers (read-only: find files, read code, search the web). Unset = each lane\'s own coding model, exactly as before. A fast, cheap model here trims the cost of the highest-volume reads.',
    builtInFallback: 'Unset = the lane\'s own coding model. An assigned model that fails simply fails that worker, which the lead retries or covers itself.' },
  { key: 'utility', persona: 'Utility (background)', defaultModel: '', fallbackable: true,
    description: 'Titles, follow-ups, memory extraction, compaction recaps, status lines. Empty = the built-in DeepSeek → DashScope chain. Called non-streaming — flag a default-thinking custom model "no-think".',
    builtInFallback: 'If the primary fails, the built-in chain continues: DeepSeek, then the DashScope qwen3.6-27b safety net. A custom fallback here serves BEFORE the DashScope safety net (e.g. your own node during a cloud billing outage) — custom endpoint models only.' },
  { key: 'embeddings', persona: 'Embeddings', defaultModel: '', fallbackable: false,
    description: 'RAG + memory vector embeddings (OpenAI-compatible /embeddings; MUST yield 1536 dimensions). Empty = built-in DashScope text-embedding-v4. An MRL-trained model that natively returns more (Qwen3-Embedding, text-embedding-3…) works when flagged "MRL" on its endpoint entry — Digby truncates to 1536 client-side. Switching models invalidates previously embedded documents — re-ingest them.',
    builtInFallback: 'No fallback by design — mixing two embedding models corrupts the vector space.' },
  { key: 'rerank', persona: 'Reranker', defaultModel: '', fallbackable: false,
    description: 'RAG retrieval reranker (Cohere-style /rerank: {model, query, documents, top_n}). Empty = built-in DashScope qwen3-rerank; any failure falls back to fused keyword+vector order.',
    builtInFallback: 'Any failure falls back to the fused keyword+vector order.' },
  // ── Capability seats (2026-09-22): the model calls that were fixed constants ──
  { key: 'vision_describe', persona: 'Image reader', defaultModel: 'glm-5.3-flash', fallbackable: true,
    description: 'Turns an image into a written description. Fires when a text-only seat needs to "see" an attached image (the Double / Triple Checker in chat, text-only coding models), when an image is added to a project knowledge base, and for screenshots on feedback tickets. Called non-streaming with the image inline — needs a vision-capable model.',
    builtInFallback: 'If this model fails, the built-in glm-5.3-flash describes the image; if that is unavailable too, the image is skipped with an honest note.' },
  { key: 'pdf_ocr', persona: 'PDF reader (OCR)', defaultModel: 'glm-5.3-flash', fallbackable: true,
    description: 'Transcribes PDFs to layout-faithful Markdown (tables stay tables, empty cells stay empty, merged headers as HTML tables). Fires for every PDF Digby reads — chat uploads, knowledge-base ingestion, PDFs found by web search, Google Drive files — when the PDF is scanned or small enough to be layout-sensitive (≤10 pages, ≤15 MB). The built-in GLM reads the whole PDF natively at low reasoning effort; any other vision model gets the pages rendered to images, one call per page, non-streaming.',
    builtInFallback: 'If this model fails, the custom fallback (when set — deepseek-flash is the recommended different-vendor pick), then the built-in glm-5.3-flash; if OCR fails everywhere, the PDF\'s own text layer (pdf-parse) is used — tables flatten but nothing is lost.' },
  { key: 'browser_agent', persona: 'Browser agent', defaultModel: 'glm-5.3', fallbackable: false,
    description: 'Drives the browser_task tool: a bounded sub-session (6 steps, 120 s) that navigates, reads and clicks step by step, and first decides whether a task runs in the cloud browser, the paired Mac browser or computer use. Called non-streaming with function tools; reasoning effort is capped at "high" so each step fits the deadline.',
    builtInFallback: 'No fallback: a failing model ends the browser task with an honest report and the chat continues.' },
  { key: 'computer_vision', persona: 'Computer-use vision', defaultModel: 'deepseek-flash', fallbackable: false,
    description: 'Drives the computer_task tool on a paired Mac: looks at each screenshot and picks the next click, keystroke or scroll. Called non-streaming with the screenshot inline plus function tools — needs a model that does BOTH vision and tool calling.',
    builtInFallback: 'If this model hangs or fails, the next provider in the seat chain serves the step — ultimately the built-in deepseek-flash. Each attempt is bounded to 45 s inside the step\'s 90 s budget, and a model that times out is moved to the back of the chain (never dropped) for 10 min — ticket c4fa5417. If every provider in that chain fails, the session ends with an honest report; actions already taken on the Mac stand.' },
  { key: 'kids', persona: 'Digby Kids', defaultModel: 'qwen3.6-flash', fallbackable: false,
    description: 'Answers every chat from a child sub-account with the Socratic tutor prompt and bounded web search. Streamed. Nothing else on the platform (deep research, integrations, knowledge bases, memory) runs on this path.',
    builtInFallback: 'No fallback: a failing model returns an honest error to the child\'s chat.' },
  // ── Non-chat seats ──
  { key: 'asr', persona: 'Speech-to-text (ASR)', defaultModel: '', fallbackable: false,
    description: 'Chat voice notes (browsers without on-device speech recognition) + youtube_pipe audio fallback (OpenAI-compatible POST /audio/transcriptions). Empty = the built-in chain: self-hosted STT (STT_BASE_URL) when configured, else DashScope qwen3-asr-flash. On an override failure Digby falls back to that built-in chain automatically.',
    builtInFallback: 'On an override failure the built-in chain (self-hosted STT, else DashScope qwen3-asr-flash) serves.' },
  { key: 'tts', persona: 'Text-to-speech', defaultModel: '', fallbackable: false,
    description: 'Read-aloud for answers (the speaker button on transcripts and the Mac app\'s voice mode). Empty = built-in DashScope qwen3-tts-flash. An override must be an OpenAI-compatible POST /audio/speech model on a registered endpoint (returns audio bytes).',
    builtInFallback: 'On an override failure the built-in DashScope voice serves; if that fails too, the button reports an error.' },
  // ── Decision seat (2026-09-24): the harness's own small judgments — is this
  //    wake worth a supervisor turn, did a watched value change materially,
  //    which patience level for Auto, is the user asking to SEND a message,
  //    cloud or Mac browser, is there anything to remember, does the final
  //    need a self-audit — answered by a Jev-class DECISION MODEL (typed
  //    noul / choice / score with calibrated probabilities, one prefill, zero
  //    output tokens, ~50–500 ms) instead of a reasoning-model generation.
  //    Built-ins: 'jev' = TypeSafe Jev over TYPESAFE_API_KEY (the calibrated
  //    reference), 'deepseek-flash' = a logprob readout on the existing
  //    DeepSeek key (no new infrastructure). Overrides: a registered endpoint
  //    of shape 'systemone' (self-hosted JevK5 / NeoHorse / Kev) or any
  //    logprobs-capable OpenAI-compatible server. Every consumer fails open. ──
  { key: 'decision', persona: 'Decision gate', defaultModel: 'jev', fallbackable: true,
    description: 'Typed yes/no, choice and score judgments for the framework\'s own gates (supervisor wake triage, schedule delta materiality, the Auto patience router, iMessage send intent, browser driver choice, memory-extraction and self-audit gates). Runs SHADOW by default — it records what it would have decided next to what the reasoning path did; DECISION_GATE_MODE_<PURPOSE>=act lets a purpose skip work on a confident answer. Built-ins: "jev" = TypeSafe Jev (needs TYPESAFE_API_KEY), "deepseek-flash" = a logprob readout on the DeepSeek key. Overrides: a registered endpoint of type "Decision model (/v1/systemone)" — a self-hosted JevK5, NeoHorse-Jev or Kev server — a typed-decision model behind an OpenAI-compatible proxy (LiteLLM fronting Laya: flag the model [typed decisions] on its endpoint, e.g. cql-litellm:agx-laya, max state chars ≈ 3800), or any OpenAI-compatible server that returns logprobs.',
    builtInFallback: 'If the seat\'s backend is unavailable (no TYPESAFE_API_KEY, error, timeout), the custom fallback (when set), then the built-in jev, then the built-in deepseek-flash readout serve; when nothing can serve, every gated site simply runs its pre-gate behaviour (fail-open) and the gate records the miss.' },
  // ── Image generator seat (2026-09-24, owner: "add image generation model and
  //    admin endpoint and defaults to generate images"): the generate_image tool
  //    (every chat level + coding sessions, signed-in adults) and POST
  //    /api/crossmodel/images/generate run on it. Runtime: image-generate.ts.
  //    Its built-ins are IMAGE models with their own vocabulary (like the
  //    Decision gate) — IMAGE_BUILT_IN_OPTIONS, never the chat ids. Default
  //    qwen-image-3.0 (DashScope): 4 s / $0.03 at 1024², any size 512²–2048²,
  //    and the SAME model edits an attached reference image. ──
  { key: 'image_generate', persona: 'Image generator', defaultModel: 'qwen-image-3.0', fallbackable: true,
    description: 'Creates pictures from a prompt: the generate_image tool (every chat level and coding session, signed-in adults only) and POST /api/crossmodel/images/generate. Built-ins: qwen-image-3.0 (DashScope — default: ~4 s, $0.03, any size 512²–2048², also EDITS an attached reference image), qwen-image-2.0 (DashScope, edits, RPM 120), z-image-turbo (DashScope, $0.015, RPM 120, text only), wan2.7-image (DashScope, RPM 300, edits), glm-image (Z.AI, 30–50 s, $0.015, text only), cogview-4-250304 (Z.AI, ~8 s, $0.01, text only). Overrides: a registered endpoint model flagged [image] — an OpenAI-compatible POST /images/generations route returning data[0].b64_json or url. A reference image only reaches edit-capable DashScope legs; text-only legs get a written description from the Image reader seat instead (the result says which). Caps: IMAGE_CHAT_HOURLY_CAP (8) per chat/hour, IMAGE_USER_DAILY_CAP (40) per user/day.',
    builtInFallback: 'If this model fails or is rate-limited, the custom fallback (when set), then the built-in chain z-image-turbo (same DashScope key, RPM 120) → glm-image (Z.AI — a different vendor) → cogview-4-250304 serves; keyless legs are skipped; a content-safety refusal stops the chain and is reported honestly.' },
];

/** Seats that may carry an admin-assigned custom fallback model. */
export const FALLBACKABLE_ROLES = new Set<ModelRoleKey>(MODEL_ROLES.filter(r => r.fallbackable).map(r => r.key));

/** Seat labels by key — the ONE vocabulary the chat UI's status stream,
 *  model cards and the admin page share (owner 2026-09-15). */
export const SEAT_PERSONAS: Record<ModelRoleKey, string> = Object.fromEntries(MODEL_ROLES.map(r => [r.key, r.persona])) as Record<ModelRoleKey, string>;

/** Roles whose call shape is NOT chat/completions — assignable to ANY registered
 *  endpoint model (the [coding] agent flag is meaningless for them), never to a
 *  built-in chat model id. */
export const NON_CHAT_ROLES = new Set<ModelRoleKey>(['embeddings', 'rerank', 'asr', 'tts']);

/** Seats that send IMAGES inline (image_url parts) — the model must be
 *  vision-capable: a built-in from VISION_BUILT_IN_MODEL_IDS, or a registry
 *  model flagged [vision] (and [coding], which the run-path resolver requires). */
export const VISION_ROLES = new Set<ModelRoleKey>(['vision_describe', 'pdf_ocr', 'computer_vision']);
/** Seats whose call shape is an IMAGE GENERATION request (2026-09-24): built-ins
 *  from IMAGE_BUILT_IN_OPTIONS (image-generate.ts), or a registry model flagged
 *  [image] — never a chat id, never the [coding] flag. */
export const IMAGE_ROLES = new Set<ModelRoleKey>(['image_generate']);
/** Seat governance (audit E3, 2026-09-27; review fixer the same day): the
 *  seats the 2026-09-22 no-frontier doctrine OBSERVES at SAVE time — the chat
 *  lead, both supervisors and both checkers. A '<label>:<modelId>' spec whose
 *  registry resolution carries governanceClass 'frontier' (a frontier vendor
 *  host, or a proxy model id such as `api-anthropic-claude-fable-5-1`) on one
 *  of these seats — or on its custom fallback — writes ONE loop_metrics
 *  `seat_governance` row and is badged on the admin page. The seat is the
 *  OWNER's setting: by default it SAVES (outcome 'observed'); only
 *  FRONTIER_SEATS_REFUSE=1 turns the save into a 400 (outcome 'refused'), and
 *  even then an owner-confirmed `set_model_role_fallback` card passes
 *  ('allowed_by_owner') and a PROBE (/test, test_model_role) is never refused.
 *  Coding / helper / capability seats are NOT governed here (the finding
 *  scoped the fix to chat + supervisor turns). The run path never consults
 *  this set. */
export const FRONTIER_GOVERNED_ROLES = new Set<ModelRoleKey>(['chat_orchestrator', 'chat_quick', 'supervisor', 'project_supervisor', 'double_checker', 'triple_checker']);
/** Built-ins whose provider entry carries supportsVision (coding-model.ts —
 *  pinned equal by the drift test). */
export const VISION_BUILT_IN_MODEL_IDS = ['glm-5.3-flash', 'deepseek-flash', 'kimi-k3', 'kimi-k2.6', 'qwen3.6-27b'];
/** Seats whose consumers call the model NON-STREAMING but WITH tools or images
 *  (one bounded call per step). Reasoning-always-on GLM is fine here (the
 *  browser agent has run glm-5.3 this way since 2026-06) — only the must-STREAM
 *  Kimi models are rejected (100+ s non-streaming blocks, the project-wide rule). */
export const NON_STREAMING_TOOL_ROLES = new Set<ModelRoleKey>(['browser_agent', 'computer_vision', 'vision_describe', 'pdf_ocr']);
const MUST_STREAM_BUILT_INS = new Set(['kimi-k3', 'kimi-k2.6']);
/** The proven agent lineup for the chat / supervisor / coding seats (tool loops,
 *  long context). The small utility models are deliberately not offered there. */
const AGENT_BUILT_IN_MODEL_IDS = ['kimi-k3', 'glm-5.3', 'deepseek-flash', 'qwen3.6-27b'];

/**
 * The built-in ids an admin may assign to a seat — ONE source of truth for the
 * save-time gate (assertAssignable) and the UI picker (`builtInOptions` on the
 * role view). Non-chat seats take no built-in ids (their '' default IS the
 * built-in; overrides are registry specs).
 */
export function builtInOptionsFor(key: ModelRoleKey): string[] {
  if (NON_CHAT_ROLES.has(key)) return [];
  if (key === 'decision') return [...DECISION_BUILT_IN_OPTIONS];
  if (IMAGE_ROLES.has(key)) return [...IMAGE_BUILT_IN_OPTIONS];
  if (NON_STREAMING_ROLES.has(key)) return [...FAST_BUILT_IN_MODEL_IDS];
  // Computer use may also run kimi-k3 (the only model with published GUI
  // benchmarks — OSWorld-Verified 84.8; verified live 2026-09-22 at effort
  // 'low', ~13 s/step non-streaming); the other vision seats keep Kimi off
  // (must-stream rule) since GLM/DeepSeek serve them faster and cheaper.
  if (key === 'computer_vision') return ['deepseek-flash', 'glm-5.3-flash', 'kimi-k3', 'qwen3.6-27b'];
  if (VISION_ROLES.has(key)) return VISION_BUILT_IN_MODEL_IDS.filter(id => !MUST_STREAM_BUILT_INS.has(id) && id !== 'kimi-k2.6');
  if (key === 'browser_agent') return ['glm-5.3', 'deepseek-flash', 'glm-5.3-flash', 'qwen3.6-27b'];
  if (key === 'kids') return ['qwen3.6-flash', 'qwen3.6-27b', 'deepseek-flash', 'glm-5.3-flash', 'glm-5.3', 'kimi-k3'];
  // The Quick lane streams an agent loop with web tools (thinking off) — the fast tier first.
  if (key === 'chat_quick') return ['qwen3.6-27b', 'qwen3.6-flash', 'glm-5.3-flash', 'deepseek-flash', 'glm-5.3', 'kimi-k3'];
  return [...AGENT_BUILT_IN_MODEL_IDS];
}

const ROLE_BY_KEY: Record<string, ModelRoleDef> = Object.fromEntries(MODEL_ROLES.map(r => [r.key, r]));

export function isModelRoleKey(x: any): x is ModelRoleKey {
  // Own-property check: prototype member names ('toString', 'constructor', …)
  // must not validate as roles (adversarial review finding).
  return typeof x === 'string' && Object.hasOwn(ROLE_BY_KEY, x);
}

/** A current key, a LEGACY alias, or a surface SYNONYM translated to its
 *  current seat; null when neither (own-property checks throughout — see
 *  isModelRoleKey). Stored rows are read through isModelRoleKey (strict), so
 *  synonyms heal CALLERS only — a synonym never loads from a stored config. */
export function normalizeRoleKey(x: any): ModelRoleKey | null {
  if (isModelRoleKey(x)) return x;
  if (typeof x === 'string' && Object.hasOwn(LEGACY_ROLE_ALIASES, x)) return LEGACY_ROLE_ALIASES[x];
  if (typeof x === 'string' && Object.hasOwn(ROLE_SYNONYMS, x)) return ROLE_SYNONYMS[x];
  return null;
}

/** Built-in coding-model ids (coding-model.ts CodingModelId — kept in sync by test).
 *  2026-09-03 GLM-5.3 cutover: glm-5.2 is gone (normalizeCodingModel aliases it).
 *  2026-09-10 DeepSeek V4.1 Flash cutover: deepseek-v4-pro / deepseek-v4-flash
 *  are gone the same way — a stored override on either id still RUNS (the
 *  run path normalizes) but the picker offers and saves only deepseek-flash. */
export const BUILT_IN_MODEL_IDS = new Set([
  'glm-5.3', 'deepseek-flash', 'kimi-k3', 'kimi-k2.6', 'qwen3.6-27b',
  // 2026-09-22 capability seats: the vision utility + the kids default became
  // first-class built-ins so the admin can move them between seats.
  'glm-5.3-flash', 'qwen3.6-flash',
]);

/** Retired built-in ids that may still sit in a stored override row. Aliased on
 *  READ so the admin surface (picker selection, Test button, `override` /
 *  `effective`) agrees with the run path, which already normalizes them in
 *  coding-model.ts normalizeCodingModel — otherwise a pre-cutover row shows as
 *  "Default" and its Test 400s while the seat runs fine. A local map, not an
 *  import: this module deliberately keeps coding-model off its static graph. */
const LEGACY_BUILT_IN_ALIASES: Record<string, string> = {
  'glm-5.2': 'glm-5.3',
  'deepseek-v4-pro': 'deepseek-flash',
  'deepseek-v4-flash': 'deepseek-flash',
};
const aliasBuiltIn = (v: string): string => LEGACY_BUILT_IN_ALIASES[v] ?? v;

/**
 * Seats whose consumers call the model NON-STREAMING with a plain-chat payload
 * (utility-llm's override leg, the web/youtube-pipe summarizers). Reasoning-
 * shaped built-ins are rejected for them at save time: kimi-k3/k2.6 MUST
 * stream (100+s non-streaming blocks — the project-wide Kimi rule) and glm-5.3
 * cannot switch thinking off (hard-fails; leaks a leading <think> block inside
 * content). deepseek-flash thinks by default too, but its per-call
 * `thinking:{type:'disabled'}` switch is honored and helper-completion forces
 * it on this path — so it stays a FAST built-in (as deepseek-v4-flash was).
 * The admin's Test button probes the real non-streaming shape, so without this
 * gate it would green-light configs that fail 100% at runtime (adversarial
 * review finding).
 */
const NON_STREAMING_ROLES = new Set<ModelRoleKey>(['utility', 'coding_helper']);
/** The decision seat's own built-in vocabulary — NOT chat models (decision-gate.ts). */
const DECISION_BUILT_IN_OPTIONS: readonly string[] = ['jev', 'deepseek-flash'];
/** The Image generator seat's own built-in vocabulary (2026-09-24) — image
 *  models, NOT chat models. Pinned equal to image-generate.ts IMAGE_BUILT_INS
 *  (the runtime table: provider, sizes, timeouts) by the drift test. The
 *  RPM-2/5 premium tiers (qwen-image-3.0-pro, 2.0-pro, -max, edit-max,
 *  wan2.7-image-pro) are deliberately not offered. Exported for the UI/tests. */
export const IMAGE_BUILT_IN_OPTIONS: readonly string[] = ['qwen-image-3.0', 'qwen-image-2.0', 'z-image-turbo', 'wan2.7-image', 'glm-image', 'cogview-4-250304'];
const REASONING_BUILT_INS = new Set(['kimi-k3', 'kimi-k2.6', 'glm-5.3']);
/** Built-ins assignable to the non-streaming seats (exported for the UI/test). */
export const FAST_BUILT_IN_MODEL_IDS = ['deepseek-flash', 'qwen3.6-27b'];

const STORE_NS = ['instance', 'model-roles'];
const STORE_KEY = 'config';
const CACHE_TTL_MS = 30_000;

export interface RoleOverrides { [key: string]: string }
/** Admin-assigned custom fallback per seat (fallbackable seats only). */
export interface RoleFallbacks { [key: string]: string }
export interface ModelRoleConfig { overrides: RoleOverrides; fallbacks: RoleFallbacks }
/** The stored row's shape. `roles` may still carry LEGACY keys (translated on read). */
interface StoredRoleConfig { roles?: Record<string, string>; fallbacks?: Record<string, string> }
let cache: { config: ModelRoleConfig; expiresAt: number } | null = null;
let inFlight: Promise<ModelRoleConfig> | null = null;

/** Test hook + mutation invalidation. */
export function clearModelRoleCache(): void { cache = null; inFlight = null; }

/**
 * Pure: the stored row → current-key overrides + fallbacks. Legacy seat keys
 * feed their new seat (explicit new key wins; among aliases the FIRST listed in
 * LEGACY_ROLE_ALIASES wins — chat_cross_checker over council_logician for the
 * Double Checker, so a Level-2 re-seat is what both levels now run); a legacy
 * `utility_fallback` role becomes the utility seat's custom fallback. Retired
 * built-in ids alias forward. Exported for the migration pins.
 */
export function normalizeStoredRoleConfig(stored: StoredRoleConfig | null | undefined): ModelRoleConfig {
  const overrides: RoleOverrides = {};
  const fallbacks: RoleFallbacks = {};
  const roles = stored?.roles ?? {};
  const clean = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? aliasBuiltIn(v.trim()) : null);
  for (const [k, v] of Object.entries(roles)) {
    const val = clean(v);
    if (val && isModelRoleKey(k)) overrides[k] = val;
  }
  for (const [legacy, target] of Object.entries(LEGACY_ROLE_ALIASES)) {
    const val = clean(roles[legacy]);
    if (val && !overrides[target]) overrides[target] = val;
  }
  for (const [k, v] of Object.entries(stored?.fallbacks ?? {})) {
    const val = clean(v);
    if (val && isModelRoleKey(k) && FALLBACKABLE_ROLES.has(k)) fallbacks[k] = val;
  }
  const legacyUtilityFallback = clean(roles[LEGACY_UTILITY_FALLBACK_KEY]);
  if (legacyUtilityFallback && !fallbacks.utility) fallbacks.utility = legacyUtilityFallback;
  return { overrides, fallbacks };
}

/**
 * Stored config (known keys, non-empty values only). On a store-read FAILURE
 * this serves the last successfully read config when it has any
 * (stale-on-error — an instance with an embeddings override must not silently
 * flip vector spaces on a DB blip), else fails open to {}. Concurrent
 * cold-cache callers share ONE read (the chat lane resolves four seats in
 * parallel per run — adversarial review finding).
 */
export async function getModelRoleConfig(): Promise<ModelRoleConfig> {
  if (cache && cache.expiresAt > Date.now()) return cache.config;
  // Stale-while-revalidate (audit 2026-09-26 gate-runtime-2): an EXPIRED config
  // is served now and refreshed in the background — the decision gate's
  // request-path consumers must never await a live store read on a 30 s expiry.
  // Only a truly cold cache awaits.
  if (cache) {
    if (!inFlight) void refreshModelRoleConfig().catch(() => { /* logged inside */ });
    return cache.config;
  }
  return refreshModelRoleConfig();
}

async function refreshModelRoleConfig(): Promise<ModelRoleConfig> {
  if (inFlight) return inFlight;
  inFlight = (async () => {
    let config: ModelRoleConfig = { overrides: {}, fallbacks: {} };
    try {
      const stored = await storeGet<StoredRoleConfig>(STORE_NS, STORE_KEY);
      config = normalizeStoredRoleConfig(stored);
    } catch (err: any) {
      logger.warn(`model-roles: config read failed (${err?.message}) — ${cache ? 'serving the last known config' : 'using built-in defaults'}`);
      config = cache ? cache.config : { overrides: {}, fallbacks: {} };
    }
    cache = { config, expiresAt: Date.now() + CACHE_TTL_MS };
    return config;
  })();
  try {
    return await inFlight;
  } finally {
    inFlight = null;
  }
}

/** Stored seat overrides (current keys). */
export async function getModelRoleOverrides(): Promise<RoleOverrides> {
  return (await getModelRoleConfig()).overrides;
}

/** Admin-assigned custom fallbacks (current keys, fallbackable seats only). */
export async function getModelRoleFallbacks(): Promise<RoleFallbacks> {
  return (await getModelRoleConfig()).fallbacks;
}

/**
 * The admin's CUSTOM fallback for a seat — the model that serves when the
 * seat's model fails — or '' when none is set (Digby's built-in fallback
 * behaviour applies). Legacy keys accepted; a non-fallbackable seat is ''.
 */
export async function resolveRoleFallback(key: ModelRoleKey | string): Promise<string> {
  const k = normalizeRoleKey(key);
  if (!k || !FALLBACKABLE_ROLES.has(k)) return '';
  return (await getModelRoleFallbacks())[k] || '';
}

/**
 * Project-supervisor preflight 2026-09-14: what a role runs when it has NO
 * override of its own. A plain seat → its built-in default; an inheriting seat
 * → the parent seat's RESOLVED model (parent override, else parent default).
 * Pure over the already-read overrides, so every consumer (resolve, list,
 * test) agrees byte-for-byte on the unset value.
 */
export function roleDefaultModel(key: ModelRoleKey, overrides: RoleOverrides): string {
  const def = ROLE_BY_KEY[key];
  if (def.inheritsFrom) {
    const parent = ROLE_BY_KEY[def.inheritsFrom];
    return overrides[parent.key] || parent.defaultModel;
  }
  return def.defaultModel;
}

/** The model spec a role runs on: the admin override, else the built-in default
 *  (or, for an inheriting seat, the parent seat's resolved model). Legacy seat
 *  keys resolve their current seat; the retired `utility_fallback` key resolves
 *  the utility seat's custom fallback ('' when none). Unknown keys → ''. */
export async function resolveRoleModel(key: ModelRoleKey | string): Promise<string> {
  if (key === LEGACY_UTILITY_FALLBACK_KEY) return resolveRoleFallback('utility');
  const k = normalizeRoleKey(key);
  if (!k) return '';
  const overrides = await getModelRoleOverrides();
  return overrides[k] || roleDefaultModel(k, overrides);
}

// ── Admin surface ─────────────────────────────────────────────────────────────

export interface ModelRoleView extends ModelRoleDef {
  /** The stored override, or null when the role runs its default. */
  override: string | null;
  /** What the role actually runs right now (override || defaultModel). */
  effective: string;
  /** False when a stored '<label>:<modelId>' override no longer resolves
   *  (endpoint deleted/disabled/renamed) — the seat silently runs its default
   *  until fixed; the UI badges this. Always true for defaults/built-ins. */
  resolves: boolean;
  /** False when the EFFECTIVE model cannot be served on THIS instance (a
   *  built-in whose provider API key is not set — the keyless-Edge trap:
   *  seats you "didn't touch" silently point at dead providers). The UI
   *  badges these so an Edge admin sees which seats need assignment. */
  servable: boolean;
  unservableReason?: string;
  /** The exact .env variable whose absence makes the seat unservable — the UI
   *  badges "add MOONSHOT_API_KEY" instead of a generic "no API key" (owner
   *  ask 2026-09-05). For the utility chain it names both legs. */
  missingEnvKey?: string;
  /** e5298647: set ONLY on the coding_default row, and only when the VIEWING
   *  admin's own per-user coding pick (UserPreferences.codingModel) resolves
   *  to a model DIFFERENT from this seat's effective — the admin's own new
   *  sessions then stamp that pick, not the seat (resolveStampedCodingModel
   *  precedence: project > user pref > seat), so a seat save looks dead
   *  without this signal. */
  viewerPick?: { stored: string; resolved: string };
  /** Seat-health signal (owner 2026-09-14): how many times in the last 24h
   *  this seat's configured model FAILED and the built-in served instead
   *  (loop_metrics seat_fallback rows naming this role — helper-seat.ts
   *  digests/workers, the orchestrator/supervisor empty-output fallback). 0
   *  when quiet or when the read fails (fail-open). The Endpoints panel badges
   *  a flaky seat from it. */
  recentFailures: number;
  /** The admin's custom fallback model for this seat, or null (built-in
   *  fallback behaviour — see `builtInFallback`). Always null on a
   *  non-fallbackable seat. */
  fallback: string | null;
  /** False when a stored '<label>:<modelId>' fallback no longer resolves. */
  fallbackResolves: boolean;
  /** Seat governance (audit E3, 2026-09-27): 'frontier' when the EFFECTIVE
   *  model is a registry spec whose class is frontier (a frontier vendor host
   *  or a proxy model id naming a frontier family). Present ONLY then — the UI
   *  badges the seat; the seat keeps serving (fail-open). Built-ins never
   *  carry it (no frontier built-ins exist since 2026-09-22). */
  providerClass?: 'frontier';
  /** Same signal for the seat's custom fallback. Present ONLY when frontier. */
  fallbackProviderClass?: 'frontier';
  /** True (the default) = governance is observe-only and a frontier-class
   *  model may be saved on a governed seat; false = FRONTIER_SEATS_REFUSE=1 is
   *  set on this instance and the next save of such a spec is refused. The
   *  badge title branches on it. */
  frontierSeatsAllowed: boolean;
  /** The built-in model ids this seat accepts (builtInOptionsFor) — the UI's
   *  picker reads it so the frontend carries no per-seat model lists. Empty
   *  for non-chat seats (their override is always a registry spec). */
  builtInOptions: string[];
  /** 2026-09-27: the seat's configured model is LATCHED OFF by a deterministic
   *  invalid-request rejection (tools over the model's cap, reasoning_effort
   *  refused with tools, tools unsupported, unknown param, model not found,
   *  context too long) and runs on `to` until `until` — the newest
   *  seat_fallback row with meta.latchedUntil ahead of now (loop-metrics
   *  listActiveSeatLatches). Absent when the seat is not latched. The UI badges
   *  "seat unusable: <reason> — running on Y since <t>". */
  latched?: { from: string; to: string; reason: string; fingerprint?: string; since: string; until: string };
}

/** Trailing window for `recentFailures`. */
export const RECENT_FAILURES_WINDOW_HOURS = 24;

/** Live seat latches by role — fail-open to none (a telemetry read must never
 *  break the admin page). Dynamic import: loop-metrics pulls prisma. */
async function activeSeatLatchesByRole(): Promise<Record<string, ModelRoleView['latched']>> {
  try {
    const { listActiveSeatLatches } = await import('../platform/loop-metrics.service');
    const out: Record<string, ModelRoleView['latched']> = {};
    for (const l of await listActiveSeatLatches()) {
      if (!out[l.role]) out[l.role] = { from: l.from, to: l.to, reason: l.reason, ...(l.fingerprint ? { fingerprint: l.fingerprint } : {}), since: l.since, until: l.until };
    }
    return out;
  } catch (err: any) {
    logger.warn(`model-roles: seat latch read failed (${err?.message}) — reporting no latches`);
    return {};
  }
}

/** seat_fallback rows per role in the trailing window — fail-open to no
 *  counts (a telemetry read must never break the admin page). Dynamic import:
 *  loop-metrics pulls prisma; this module keeps it off its static graph. */
async function recentSeatFailures(): Promise<Record<string, number>> {
  try {
    const { countSeatFallbacksByRole } = await import('../platform/loop-metrics.service');
    return await countSeatFallbacksByRole(RECENT_FAILURES_WINDOW_HOURS);
  } catch (err: any) {
    logger.warn(`model-roles: seat_fallback count failed (${err?.message}) — reporting recentFailures 0`);
    return {};
  }
}

/** Seat governance outcomes (audit E3, 2026-09-27; review fixer the same day):
 *  'observed'          — the frontier-class spec was recorded and the save /
 *                        probe went ahead (governance is visibility) while the
 *                        auto-pick policy is 'open_only'.
 *  'allowed_by_policy' — roster 2026-10-06 C-1 (owner: "access to any and all
 *                        models"): the same, under the auto-pick policy 'all'
 *                        (platform/roster-policy.ts — the default). The row says
 *                        the instance's policy admits the model, not merely that
 *                        it was seen. AUTO_PICK_FRONTIER_DISABLED=1 restores
 *                        'observed'.
 *  'refused'           — FRONTIER_SEATS_REFUSE=1 and the SAVE was 400'd.
 *  'allowed_by_owner'  — FRONTIER_SEATS_REFUSE=1 but the write rode an
 *                        owner-confirmed card (`set_model_role_fallback`). */
export type SeatGovernanceOutcome = 'observed' | 'allowed_by_policy' | 'refused' | 'allowed_by_owner';

/** Seat governance telemetry: ONE loop_metrics `seat_governance` row per
 *  frontier-class assignment attempt on a governed seat — {role, spec, slot,
 *  outcome, probe}. Fire-and-forget, fail-open: a telemetry hiccup never
 *  changes the verdict. Dynamic import for the same graph reason as
 *  recentSeatFailures. */
function recordSeatGovernance(meta: { role: string; spec: string; slot: 'seat' | 'fallback'; outcome: SeatGovernanceOutcome; probe: boolean; policy?: 'all' | 'open_only' }): void {
  void import('../platform/loop-metrics.service')
    .then(m => { if (typeof m.recordLoopMetric === 'function') m.recordLoopMetric({ kind: 'seat_governance', meta }); })
    .catch(() => { /* fail-open */ });
  const line = `model-roles: seat_governance ${meta.outcome}${meta.probe ? ' (probe)' : ''} — ${meta.role}${meta.slot === 'fallback' ? '.fallback' : ''}=${meta.spec} is frontier-class`;
  if (meta.outcome === 'refused') logger.warn(`${line} (FRONTIER_SEATS_REFUSE=1)`); else logger.info(line);
}

/** Why a role's effective model cannot serve on this instance ({reason:null} =
 *  fine), with the missing .env variable named separately for the UI badge.
 *  Chain roles ('' default) check their chain's env keys; agent-shaped roles
 *  go through the run path's own resolution (coding-model, dynamic import to
 *  keep this module off its static graph). Fail-open on any error. */
async function roleServability(key: ModelRoleKey, effective: string): Promise<{ reason: string | null; missingEnvKey?: string }> {
  try {
    if (!effective) {
      // A follow-session worker seat has no model of its own — it runs whatever
      // the delegating lane runs, which the lane's own pre-flight already vets.
      if (ROLE_BY_KEY[key]?.followsSession) return { reason: null };
      if (key === 'utility') {
        return (process.env.DEEPSEEK_API_KEY || process.env.DASHSCOPE_API_KEY)
          ? { reason: null }
          : { reason: 'the built-in utility chain needs DEEPSEEK_API_KEY or DASHSCOPE_API_KEY — neither is set on this instance', missingEnvKey: 'DEEPSEEK_API_KEY or DASHSCOPE_API_KEY' };
      }
      if (key === 'asr') {
        // The built-in ASR chain: self-hosted STT first (STT_BASE_URL), else
        // DashScope qwen3-asr-flash (needs DASHSCOPE_API_KEY). Keyless only
        // when NEITHER leg can serve. (OpenAI whisper-1 left the chain on
        // 2026-09-22 — no frontier models anywhere.)
        return (process.env.STT_BASE_URL || process.env.DASHSCOPE_API_KEY)
          ? { reason: null }
          : { reason: 'the built-in ASR chain needs STT_BASE_URL (self-hosted STT) or DASHSCOPE_API_KEY (qwen3-asr-flash) — neither is set on this instance', missingEnvKey: 'STT_BASE_URL or DASHSCOPE_API_KEY' };
      }
      // embeddings / rerank / tts built-in defaults run on DashScope.
      return process.env.DASHSCOPE_API_KEY
        ? { reason: null }
        : { reason: 'the built-in default needs DASHSCOPE_API_KEY, which is not set on this instance', missingEnvKey: 'DASHSCOPE_API_KEY' };
    }
    if (NON_CHAT_ROLES.has(key)) return { reason: null }; // custom specs: resolvability is the `resolves` flag; keyless is legitimate
    if (key === 'decision') {
      // Built-ins name their env key; registry specs are vetted by `resolves`.
      const { decisionSpecEnvKey } = await import('../platform/decision-gate');
      const envKey = decisionSpecEnvKey(effective);
      if (!envKey || process.env[envKey]) return { reason: null };
      return { reason: `its backend "${effective}" needs the ${envKey} environment variable, which is not set on this instance`, missingEnvKey: envKey };
    }
    if (IMAGE_ROLES.has(key)) {
      // Image built-ins name their provider key (DashScope / Z.AI); registry
      // specs are vetted by `resolves`. Never fall through to seatServability —
      // coding-model would normalize an unknown id to glm-5.3.
      const { imageSpecEnvKey } = await import('../image-generate');
      const envKey = imageSpecEnvKey(effective);
      if (!envKey || process.env[envKey]) return { reason: null };
      return { reason: `its model "${effective}" needs the ${envKey} environment variable, which is not set on this instance`, missingEnvKey: envKey };
    }
    const { seatServability } = await import('../coding/coding-model');
    return seatServability(effective);
  } catch {
    return { reason: null };
  }
}

export async function listModelRoles(userId?: string): Promise<ModelRoleView[]> {
  const { overrides, fallbacks } = await getModelRoleConfig();
  // e5298647: the admin's "Workspace default" (coding_default) is SHADOWED for
  // the viewing admin's own sessions whenever their UserPreferences.codingModel
  // resolves — resolveStampedCodingModel precedence is project pick > user pref
  // > this seat (the 2026-09-11 17:25Z seat save looked dead because the
  // owner's 2026-08-24 kimi-k3 pick kept winning). Surface the shadowing pick
  // on the coding_default row only when it would stamp a DIFFERENT model than
  // the seat's effective (a default-valued pref row resolving to the same model
  // is not a shadow and stays quiet). Fail-open: a pref-lookup hiccup must
  // never break the admin page.
  // Seats govern sessions (2026-09-28): a stored value shadows the seat ONLY when
  // the user set it THEMSELVES (context-store marker) — the default "glm-5.2"
  // row every user carried is not a pick. SEAT_GOVERNS_SESSIONS_DISABLED=1
  // restores the pre-change rule (any resolvable stored value shadows).
  let viewerPick: { stored: string; resolved: string } | null = null;
  if (userId) {
    try {
      const pref = await prisma.userPreferences.findUnique({ where: { userId }, select: { codingModel: true } });
      const stored = pref?.codingModel?.trim();
      if (stored) {
        const governance = await import('../coding/seat-governance');
        const counts = governance.seatGovernsSessionsDisabled()
          ? true
          : (governance.isCodingModelPickValue(stored) && await governance.isCodingModelExplicit(userId, stored).catch(() => false));
        if (counts) {
          const { resolveOneCodingPick } = await import('../coding/coding-data.service');
          const resolved = await resolveOneCodingPick(stored, userId).catch(() => null);
          const seatEffective = overrides['coding_default'] || ROLE_BY_KEY.coding_default.defaultModel;
          if (resolved && resolved !== seatEffective) viewerPick = { stored, resolved };
        }
      }
    } catch { /* fail-open */ }
  }
  const [failures, latches] = await Promise.all([recentSeatFailures(), activeSeatLatchesByRole()]);
  return Promise.all(MODEL_ROLES.map(async r => {
    const override = overrides[r.key] ?? null;
    // Stale-override signal: deleting/disabling an endpoint (or unflagging its
    // model) leaves the role pointing at nothing and the seat silently reverts
    // to its built-in at run time — surface that in the admin UI instead of
    // letting it hide (adversarial review finding). Fail-open to true: a
    // lookup hiccup must not paint every role stale.
    let resolves = true;
    // Seat governance (audit E3, 2026-09-27): the same resolution also tells
    // whether the EFFECTIVE model is frontier-class — badge it (present only
    // when 'frontier'); the seat keeps serving regardless (fail-open).
    let providerClass: 'frontier' | undefined;
    if (override && override.includes(':')) {
      try {
        const reg = await resolveRegistryModel(override);
        resolves = !!reg;
        if (reg?.governanceClass === 'frontier') providerClass = 'frontier';
      } catch { resolves = true; }
    }
    // Project-supervisor preflight 2026-09-14: an inheriting seat's view carries
    // the RESOLVED parent model as its defaultModel, so the admin UI's
    // "Default — <model>" label (and servability badge) shows what actually
    // runs when unset, not the '' placeholder the definition holds.
    const defaultModel = roleDefaultModel(r.key, overrides);
    const effective = override || defaultModel;
    const { reason: unservableReason, missingEnvKey } = await roleServability(r.key, effective);
    // Custom fallback (owner 2026-09-15): same stale-spec signal as the seat.
    const fallback = (r.fallbackable && fallbacks[r.key]) || null;
    let fallbackResolves = true;
    let fallbackProviderClass: 'frontier' | undefined;
    if (fallback && fallback.includes(':')) {
      try {
        const reg = await resolveRegistryModel(fallback);
        fallbackResolves = !!reg;
        if (reg?.governanceClass === 'frontier') fallbackProviderClass = 'frontier';
      } catch { fallbackResolves = true; }
    }
    return {
      ...r, defaultModel, override, effective, resolves,
      servable: !unservableReason,
      ...(unservableReason ? { unservableReason } : {}),
      ...(unservableReason && missingEnvKey ? { missingEnvKey } : {}),
      ...(r.key === 'coding_default' && viewerPick ? { viewerPick } : {}),
      recentFailures: failures[r.key] ?? 0,
      ...(latches[r.key] ? { latched: latches[r.key] } : {}),
      fallback,
      fallbackResolves,
      ...(providerClass ? { providerClass } : {}),
      ...(fallbackProviderClass ? { fallbackProviderClass } : {}),
      frontierSeatsAllowed: frontierSeatsAllowed(),
      builtInOptions: builtInOptionsFor(r.key),
    };
  }));
}

// ── The model map: built-in models + fixed chains (owner 2026-09-22) ─────────
// "Control and understand what everything is doing exactly": besides the seats
// above, the admin page lists every BUILT-IN model with the call parameters the
// code fixes for it, and every FIXED CHAIN — the fallback orders and pipelines
// that are not a seat pick — so nothing about which model runs when is hidden
// in source. Read-only today; the seats are where the picks live.

export interface BuiltInModelInfo {
  id: string;
  provider: string;
  envKey: string;
  /** The env var is set on this instance (presence only). */
  present: boolean;
  supportsVision: boolean;
  /** Kimi must stream (100+ s non-streaming blocks) — kept off non-streaming seats. */
  mustStream: boolean;
  /** Human summary of the fixed call parameters (reasoning, thinking, output cap, temperature). */
  params: string;
  /** Transcript/context budget in characters (~4 per token), when the entry sets one. */
  contextChars?: number;
  /** Seats that run this model when unset. */
  defaultFor: string[];
  /** 'chat' = a chat/completions model (the coding-model table); 'image' = an
   *  image-generation model (image-generate.ts IMAGE_BUILT_INS, 2026-09-24). */
  kind: 'chat' | 'image';
}

/** Every built-in model with its fixed call contract — read from the run
 *  path's own provider tables (coding-model.ts resolveProvider for chat
 *  models; image-generate.ts IMAGE_BUILT_INS for image models), never a copy. */
export async function listBuiltInModelInfo(): Promise<BuiltInModelInfo[]> {
  const { BUILT_IN_CODING_MODEL_IDS, resolveProvider } = await import('../coding/coding-model');
  const { IMAGE_BUILT_INS } = await import('../image-generate');
  const imageRows: BuiltInModelInfo[] = Object.entries(IMAGE_BUILT_INS).map(([id, m]) => ({
    id,
    provider: m.provider === 'zai' ? 'Z.AI (api.z.ai) — images' : 'Alibaba DashScope intl — images',
    envKey: m.envKey,
    present: !!process.env[m.envKey],
    supportsVision: false,
    mustStream: false,
    params: [
      m.provider === 'zai'
        ? 'OpenAI-shaped POST /images/generations (size WxH, n 1, URL result downloaded at once)'
        : 'DashScope native sync multimodal-generation route (size W*H, n 1, watermark off, signed URL downloaded at once)',
      `sizes ${Object.entries(m.sizes).map(([a, s]) => `${a} ${s}`).join(', ')}`,
      m.provider === 'zai' ? 'quality standard (hd only with polish)' : 'prompt_extend off (polish opt-in)',
      m.edits ? 'accepts a reference image (edits)' : 'text only',
      m.price + (m.rpm ? `; RPM ${m.rpm}` : ''),
      `timeout ${Math.round(m.timeoutMs / 1000)}s${m.retries ? `, ${m.retries} retry on 5xx` : ''}`,
    ].join('; '),
    defaultFor: MODEL_ROLES.filter(r => r.defaultModel === id).map(r => r.persona),
    kind: 'image' as const,
  }));
  const chatRows: BuiltInModelInfo[] = BUILT_IN_CODING_MODEL_IDS.map((id) => {
    const p = resolveProvider(id);
    const extra = (p.extra ?? {}) as Record<string, any>;
    const bits: string[] = [];
    if (extra.thinking?.type === 'enabled') bits.push('thinking on');
    if (extra.reasoning_effort) bits.push(`reasoning effort ${extra.reasoning_effort}`);
    if (id === 'kimi-k3') bits.push('thinking always on, sampling fixed server-side (no temperature)');
    if (id === 'glm-5.3') bits.push('thinking cannot be disabled');
    if (id === 'glm-5.3-flash') bits.push('reasons before answering');
    if (typeof extra.temperature === 'number') bits.push(`temperature ${extra.temperature}`);
    if (typeof extra.max_tokens === 'number') bits.push(`output cap ${extra.max_tokens.toLocaleString()} tokens (agent seats)`);
    if (typeof extra.max_completion_tokens === 'number') bits.push(`output cap ${extra.max_completion_tokens.toLocaleString()} tokens`);
    if (!bits.length) bits.push('provider defaults');
    return {
      id,
      provider: p.label,
      envKey: p.envKey || '',
      present: p.envKey ? !!process.env[p.envKey] : true,
      supportsVision: p.supportsVision === true,
      mustStream: MUST_STREAM_BUILT_INS.has(id),
      params: bits.join('; '),
      ...(p.contextChars ? { contextChars: p.contextChars } : {}),
      defaultFor: MODEL_ROLES.filter(r => r.defaultModel === id).map(r => r.persona),
      kind: 'chat' as const,
    };
  });
  return [...chatRows, ...imageRows];
}

export interface FixedChain {
  key: string;
  title: string;
  /** Ordered legs / steps, in plain words. */
  steps: string[];
  /** Env vars that shape the chain, when any. */
  envKeys?: string[];
  /** Seats whose picks feed this chain. */
  seats?: string[];
}

/** The pipelines and fallback orders that are NOT a single seat pick. */
export function listFixedChains(): FixedChain[] {
  const stt = (process.env.STT_BASE_URL || '').trim();
  return [
    { key: 'utility_chain', title: 'Background utility chain', seats: ['Utility (background)'],
      steps: ['Utility seat override (when set)', 'deepseek-flash, thinking off (DEEPSEEK_API_KEY) — a 402/401 latches this leg off for 30 min and files an owner ticket', 'Utility seat custom fallback (when set — custom endpoints only)', `DashScope ${process.env.DASHSCOPE_UTILITY_MODEL || 'qwen3.6-27b'} safety net (DASHSCOPE_API_KEY; DASHSCOPE_UTILITY_MODEL overrides the id)`],
      envKeys: ['DEEPSEEK_API_KEY', 'DASHSCOPE_API_KEY', 'DASHSCOPE_UTILITY_MODEL'] },
    { key: 'chat_lead_fallback', title: 'Digby seat — empty answer / capability rejection', seats: ['Digby', 'Fleet Supervisor', 'Project Supervisor'],
      steps: ['The seat\'s custom fallback (when set and servable)', 'Built-in kimi-k3 (MOONSHOT_API_KEY)', 'Otherwise the run ends with an honest empty-answer note'] },
    { key: 'chat_vision_upgrade', title: 'Digby seat — images attached but the model cannot see', seats: ['Digby'],
      steps: ['The seat\'s custom fallback, when it is [vision]-capable and servable', 'Built-in kimi-k3 (MOONSHOT_API_KEY)', 'Otherwise the images are dropped and both the model and the user are told'] },
    { key: 'double_checker_retry', title: 'Double Checker — provider error / empty draft', seats: ['Double Checker'],
      steps: ['One retry on the seat\'s custom fallback (when set)', 'Level 2 continues on Digby\'s answer alone (flagged lower confidence)'] },
    { key: 'council_colleague_rerun', title: 'Council colleague — failure mid-mission', seats: ['Double Checker', 'Triple Checker'],
      steps: ['One re-run on the seat\'s custom fallback (kept for the rest of the run)', 'The research lead covers the mission itself'] },
    { key: 'coding_lead_failover', title: 'Coding lead — transient provider failure (429 / 5xx / connection / billing)', seats: ['Workspace default'],
      steps: ['Back off and retry the chosen model (Retry-After honored)', 'Workspace default custom fallback (when set)', 'Built-in order glm-5.3 → deepseek-flash → kimi-k3 (custom-endpoint seats only; first servable wins)', 'A hard failure still surfaces as a failed run — never a silent swap'] },
    { key: 'helper_fallback', title: 'The Helper — custom model failure', seats: ['The Helper'],
      steps: ['The Helper\'s custom fallback (when set)', 'Built-in qwen3.6-27b, once, with attribution'] },
    { key: 'image_reader_chain', title: 'Image reader — describe an image', seats: ['Image reader'],
      steps: ['Image reader seat model', 'Its custom fallback (when set)', 'Built-in glm-5.3-flash (ZAI_API_KEY)', 'Otherwise the image is skipped with an honest note'] },
    { key: 'pdf_pipeline', title: 'PDF text extraction (every PDF Digby reads)', seats: ['PDF reader (OCR)'],
      steps: ['pdf-parse text layer (free, flattens tables)', 'When scanned or ≤10 pages / ≤15 MB: pages rendered to PNG → PDF reader seat, one call per page', 'OCR result kept when it is ≥ half the text layer (always for scanned PDFs); otherwise the text layer'] },
    { key: 'asr_chain', title: 'Speech-to-text', seats: ['Speech-to-text (ASR)'],
      steps: ['ASR seat override (OpenAI-compatible /audio/transcriptions)', stt ? `Self-hosted STT ${stt} (STT_BASE_URL, model ${(process.env.STT_MODEL || 'whisper-1').trim()})` : 'Self-hosted STT — not configured (STT_BASE_URL unset)', 'DashScope qwen3-asr-flash (DASHSCOPE_API_KEY; ≤3 min of audio per request — YouTube audio needs one of the first two legs)'],
      envKeys: ['STT_BASE_URL', 'STT_MODEL', 'STT_API_KEY', 'DASHSCOPE_API_KEY'] },
    { key: 'tts_chain', title: 'Text-to-speech', seats: ['Text-to-speech'],
      steps: ['TTS seat override (OpenAI-compatible /audio/speech)', 'DashScope qwen3-tts-flash (DASHSCOPE_API_KEY) — WAV, long answers split at sentences and joined'],
      envKeys: ['DASHSCOPE_API_KEY'] },
    { key: 'image_chain', title: 'Image generator — generate_image tool / POST /images/generate', seats: ['Image generator'],
      steps: [
        'Image generator seat model (built-in default qwen-image-3.0 on DashScope — RPM 20; a 429 with Retry-After ≤ 5 s waits once)',
        'Its custom fallback (when set)',
        'Built-in z-image-turbo (DASHSCOPE_API_KEY — same key, RPM 120, absorbs the default\'s rate limits)',
        'Built-in glm-image (ZAI_API_KEY — a different vendor, the provider-outage hedge)',
        'Built-in cogview-4-250304 (ZAI_API_KEY — cheapest, last resort)',
        'Keyless legs are skipped; a content-safety refusal stops the chain and is reported honestly',
        'A reference image runs only on edit-capable DashScope legs (qwen-image-3.0 / qwen-image-2.0 / wan2.7-image); with none servable the Image reader seat describes it and the text-only leg gets the description',
        'Every image is downloaded at once (provider URLs expire) and saved as a File; caps IMAGE_CHAT_HOURLY_CAP (8) per chat/hour + IMAGE_USER_DAILY_CAP (40) per user/day',
      ],
      envKeys: ['DASHSCOPE_API_KEY', 'ZAI_API_KEY', 'IMAGE_CHAT_HOURLY_CAP', 'IMAGE_USER_DAILY_CAP'] },
    { key: 'url_ingestion', title: 'Knowledge-base URL ingestion',
      steps: ['BrightData scrape_as_markdown (BRIGHTDATA_API_TOKEN direct, or the MCP gateway) — PDFs go through the PDF pipeline', 'Utility chain writes a 3-6 line overview (fail-open)', 'The scraped content is stored verbatim, then chunked and embedded on the Embeddings seat'],
      envKeys: ['BRIGHTDATA_API_TOKEN', 'MCP_DIGBY_TOKEN', 'MCP_DIGBY_URL'], seats: ['Utility (background)', 'Embeddings'] },
    { key: 'browser_routing', title: 'browser_task — where a browsing task runs', seats: ['Browser agent', 'Computer-use vision'],
      steps: ['No paired Mac → cloud browser (BrightData read)', 'Paired Mac → the Browser agent seat reasons cloud vs Mac vs computer use (no keywords)', 'Computer use is offered only when the Computer-use vision seat is servable'] },
    { key: 'kids_path', title: 'Digby Kids', seats: ['Digby Kids'],
      steps: ['Bounded BrightData search when the question needs it', 'Digby Kids seat streams the Socratic answer', 'Status lines come from the Utility chain'] },
    { key: 'decision_chain', title: 'Decision gate — typed judgments for the harness\'s own gates', seats: ['Decision gate'],
      steps: [
        // Rendered live on the admin model map — every switch named here is read by code in backend/src
        // (2026-09-26 integration of the open-weight decision-backends wave: platform/decision-gate-backends.ts
        // for the per-purpose primary / challengers, platform/decision-gate.ts for the systemone adapter
        // tolerance + per-(backend, purpose) calibration, platform/decision-gate-readiness*.ts for the autofit).
        'The purpose\'s PRIMARY backend when one is set on the Decision gate seat\'s "Decision backends per purpose" panel (store row instance:decision-gate/backends, every box within 30 s)',
        'Decision gate seat model: jev = TypeSafe /v1/systemone (TYPESAFE_API_KEY; TYPESAFE_BASE_URL / TYPESAFE_MODEL override the host and model id), deepseek-flash = one-prefill logprob readout (DEEPSEEK_API_KEY), or a registered "Decision model (/systemone)" endpoint — TypeSafe Jev, or a self-hosted Laya / JevK5 / NeoHorse-Jev / openjev server (registration recipe + each server\'s wire quirks: docs/SELF_HOST.md "Self-hosting an open-weight decision model") — a typed-decision model behind an OpenAI-compatible PROXY (LiteLLM fronting Laya — llm.example.com agx-laya: the model flagged [typed decisions] on its endpoint, or a "Typed-decision proxy" endpoint; the gate then POSTs /chat/completions with the questions map and reads the JSON answers envelope from the message content — the systemone_chat transport; max state chars ≈ 3800) — or any logprobs-capable OpenAI-compatible server. Since 2026-09-26 a NON-jev systemone backend\'s confidence is put on the max-probability scale (Laya reports 1 − normalised entropy)',
        'Its custom fallback (when set)',
        'Built-in jev, then built-in deepseek-flash readout (first servable leg wins, all inside the caller\'s deadline)',
        'CHALLENGERS (the purpose\'s own list, else the panel\'s default challengers) are asked in PARALLEL with the chain — never on memo hits, probes or a pinned-spec caller — at most DECISION_GATE_CHALLENGER_MAX (default 2), DETACHED since 2026-09-26: they add ZERO latency — the primary answers as soon as its chain settles, a still-running challenger continues in the background under its own DECISION_GATE_CHALLENGER_TIMEOUT_MS (default 20000 — DECISION_GATE_CHALLENGER_LONG_TIMEOUT_DISABLED=1 restores 5000; ok:false challenger_timeout on expiry), DECISION_GATE_CHALLENGER_GRACE_MS is an optional wait (default 0); each writes its own decision_gate row {challenger:true, primaryId, backendSpec} and its own outcome row (a challenger settling after the outcome was labelled in the same process is paired through the late-outcome registry; across processes only what had settled by stash time pairs), never answers, never acts, never feeds auto-demote',
        'Nothing servable / error / timeout → the gated site runs its pre-gate behaviour (fail-open); every call and its later outcome land in loop_metrics decision_gate. A backend that answers HTTP 401/403 is LATCHED for DECISION_GATE_AUTH_LATCH_MS (default 90 s; one probe ask per cooldown; the Test button always calls) — the first latch writes loop_metrics decision_gate_backend_down and raises an [INFRA ALERT — decision backend down] wake to the Fleet Supervisor; the readiness stamp carries per-purpose `health` {downgraded, fellThrough, latched} and get_fleet_telemetry view boxes a decisionGate tile (audit budgets-cost-6, 2026-09-26). A primary change on an act purpose drops that purpose to shadow on the PUT (loop_metrics decision_gate_backend_changed) until a fresh READY stamp re-admits act — the readiness job runs every 6 h. Opt-in sampled STATE corpus (2026-09-26): DECISION_GATE_STATE_SAMPLE_RATE (default 0) / DECISION_GATE_STATE_SAMPLE_RATE_<PURPOSE> write one loop_metrics decision_gate_state row per drawn ask (state ≤ DECISION_GATE_STATE_SAMPLE_MAX_CHARS, 12000; pruned by the readiness job after DECISION_GATE_STATE_RETENTION_DAYS, 28; `npm run decision-gate:export` prints the laya-evals JSONL; `npm run decision-gate:cascade` prints the OFFLINE cascade ruler — no act-path cascade exists)',
        'Calibrated = the built-in jev, a registered model the admin flagged [calibrated], or any backend with a FITTED temperature for (backend, purpose) — store row instance:decision-gate/backends `temps` (written by the 6 h readiness job only when DECISION_GATE_TEMP_AUTOFIT_ENABLED=1; DECISION_GATE_TEMP_AUTOFIT_DISABLED=1 kills it), else the readout\'s env temperature. A plain self-hosted systemone server (Laya ships ECE ≈ 0.47 raw) is NOT presumed calibrated; an act purpose answered by an uncalibrated backend is downgraded to shadow. Registry systemone bodies get stock noul criteria (Laya needs them) and are cut at the model\'s [max state chars]',
        'Per purpose: the fleet-wide mode set on the Decision gate seat above (stored once, every box within 30 s — no redeploy) → else DECISION_GATE_MODE_<PURPOSE> = off | shadow (default) | act; DECISION_GATE_THRESHOLD_<PURPOSE>; DECISION_GATE_TEMP_<PURPOSE> for the readout (fit with `npm run decision-gate:fit`); kill switch DECISION_GATE_DISABLED=1 (no calls)',
      ],
      envKeys: ['TYPESAFE_API_KEY', 'TYPESAFE_BASE_URL', 'TYPESAFE_MODEL', 'DEEPSEEK_API_KEY', 'DECISION_GATE_DEFAULT_MODE', 'DECISION_GATE_DISABLED', 'DECISION_GATE_CHALLENGER_MAX', 'DECISION_GATE_CHALLENGER_GRACE_MS', 'DECISION_GATE_CHALLENGER_TIMEOUT_MS', 'DECISION_GATE_CHALLENGER_LONG_TIMEOUT_DISABLED', 'DECISION_GATE_STATE_SAMPLE_RATE', 'DECISION_GATE_STATE_SAMPLE_MAX_CHARS', 'DECISION_GATE_STATE_SAMPLE_DISABLED', 'DECISION_GATE_TEMP_AUTOFIT_ENABLED', 'DECISION_GATE_TEMP_AUTOFIT_DISABLED', 'DECISION_GATE_AUTH_LATCH_MS'] },
  ];
}

// ── Provider API keys on this instance (owner ask 2026-09-05) ─────────────────
// The Model-roles UI shows which .env variables the BUILT-IN seat defaults run
// on and whether each is set, so "add MOONSHOT_API_KEY" is actionable at a
// glance. Presence only — the key values never leave the process.

export interface ProviderKeyStatus {
  /** The backend .env variable, e.g. 'MOONSHOT_API_KEY'. */
  envKey: string;
  /** Human provider name + host. */
  provider: string;
  /** Set on this instance (presence only, never the value). */
  present: boolean;
  /** What the key serves — built-in model ids and fixed extras (vision, RAG). */
  serves: string[];
}

/** Env vars the built-in seat defaults + fixed chains run on. Mirrors the
 *  envKey fields in coding-model.ts resolveProvider plus the DashScope-backed
 *  RAG/vision constants (rag.service, image-describe). */
const PROVIDER_KEY_DEFS: Array<Omit<ProviderKeyStatus, 'present'>> = [
  { envKey: 'MOONSHOT_API_KEY', provider: 'Moonshot (api.moonshot.ai)', serves: ['kimi-k3', 'kimi-k2.6', 'the built-in vision upgrade when the Digby seat cannot see an attached image'] },
  { envKey: 'DEEPSEEK_API_KEY', provider: 'DeepSeek (api.deepseek.com)', serves: ['deepseek-flash (V4.1 Flash)', 'Computer-use vision default', 'utility chain (primary leg)'] },
  { envKey: 'ZAI_API_KEY', provider: 'Z.AI (api.z.ai)', serves: ['glm-5.3', 'glm-5.3-flash (Image reader + PDF reader defaults)', 'glm-image / cogview-4-250304 (Image generator fallback legs)'] },
  { envKey: 'DASHSCOPE_API_KEY', provider: 'Alibaba DashScope intl', serves: ['qwen3.6-27b', 'qwen3.6-flash (Digby Kids default)', 'qwen-image-3.0 (Image generator default), qwen-image-2.0, z-image-turbo, wan2.7-image', 'embeddings default (text-embedding-v4)', 'rerank default (qwen3-rerank)', 'text-to-speech default (qwen3-tts-flash)', 'speech-to-text fallback leg (qwen3-asr-flash)', 'utility chain (safety-net leg)'] },
  { envKey: 'TYPESAFE_API_KEY', provider: 'TypeSafe AI (api.typesafe.ai — Jev decision model)', serves: ['jev (Decision gate default)'] },
  // Self-host setup hardening (2026-10-20): web search is a provider key too — the
  // panel used to show every model key while the instance silently had no search.
  // `present` = a search backend is configured (direct token OR gateway token + URL).
  { envKey: 'BRIGHTDATA_API_TOKEN', provider: 'BrightData (web search + page reading) — env, or the key saved in Admin → Settings → Web search, or MCP_DIGBY_TOKEN + MCP_DIGBY_URL for the MCP gateway', serves: ['search_engine / scrape_as_markdown / scrape_batch / web_pipe', 'topic feeds + the news briefing', 'knowledge-base URL ingestion', 'Digby Kids web grounding', 'the cloud browser reader'] },
];

export function listProviderKeyStatus(): ProviderKeyStatus[] {
  const ws = webSearchStatus();
  return PROVIDER_KEY_DEFS.map(d => d.envKey === 'BRIGHTDATA_API_TOKEN'
    // The row names the env var the instance actually runs on (a gateway-only
    // self-host must not read "BRIGHTDATA_API_TOKEN ✓ set").
    ? { ...d, envKey: ws.mode === 'gateway' && ws.configured ? 'MCP_DIGBY_TOKEN' : 'BRIGHTDATA_API_TOKEN', present: ws.configured }
    : { ...d, present: !!process.env[d.envKey] });
}

/**
 * Validate ONE candidate override value. '' (clear) is always valid.
 * Agent roles: a built-in id, or a '<label>:<modelId>' spec that currently
 * resolves to an ENABLED registry endpoint model flagged [coding] (the
 * "usable as an agent model" flag — the run path's resolveProviderForRun
 * enforces the same gate, so accepting an unflagged model would silently fall
 * back to glm-5.2, exactly the failure class this feature exists to kill).
 * Non-chat roles (embeddings/rerank): any registered endpoint model — the
 * [coding] flag is meaningless there, and built-in chat ids are rejected.
 */
/**
 * The DECISION seat's assignability rule, shared by the seat save, the seat's
 * custom fallback, the live tester and (2026-09-26, plan F) the per-purpose
 * backends PUT (decision-gate-backends.ts): the seat has its own built-in
 * vocabulary (jev / deepseek-flash readout) and accepts ANY registered endpoint
 * model — a 'systemone'-shape endpoint (a TypeSafe-compatible decision server:
 * JevK5, NeoHorse, Laya, openjev) or an OpenAI-compatible server that returns
 * logprobs. The [coding] flag is meaningless here. Throws AppError(400) with the
 * precise reason; an empty value is a clear and passes.
 */
export async function assertDecisionSpecAssignable(value: string): Promise<void> {
  if (!value) return; // clear
  if (DECISION_BUILT_IN_OPTIONS.includes(value)) return;
  if (!value.includes(':')) {
    throw new AppError(400, `"${value}" is not offered for the "Decision gate" seat. Built-ins: ${DECISION_BUILT_IN_OPTIONS.join(' / ')} — or assign a registered endpoint model (a "Decision model (/v1/systemone)" endpoint, or an OpenAI-compatible server that returns logprobs).`);
  }
  const reg = await resolveRegistryModel(value).catch(() => null);
  if (!reg) {
    throw new AppError(400, `"${value}" for the "Decision gate" seat does not resolve — check the endpoint label, model id, and that the endpoint is enabled.`);
  }
}

/**
 * The decision backend spec a purpose's PRIMARY leg is configured to run on,
 * fleet-wide (plan D, 2026-09-26): the STORED per-purpose primary from the
 * backends row (decision-gate-backends.ts resolveEffectivePrimarySpec; a
 * fresh, deduped read), else the decision seat's model. The readiness stamp /
 * admission that compare their measured `backendSpec` against THIS judge the
 * fleet's configuration (reviewer 2026-09-26). Fail-open to the seat model.
 */
export async function effectivePrimarySpec(purpose: string): Promise<string> {
  const seat = await resolveRoleModel('decision');
  try {
    const { resolveEffectivePrimarySpec } = await import('../platform/decision-gate-backends');
    return (await resolveEffectivePrimarySpec(purpose)) || seat;
  } catch (err: any) {
    logger.warn(`model-roles: decision backends row unavailable for ${purpose} (${err?.message}) — the seat model is the primary`);
    return seat;
  }
}

/** `probe`: the caller is a read-only live test (never refused by seat
 *  governance); `ownerConfirmed`: the write rides an owner-confirmed card. */
async function assertAssignable(key: ModelRoleKey, value: string, opts?: { probeEmbeddingDims?: boolean; asFallback?: boolean; probe?: boolean; ownerConfirmed?: boolean; warnings?: string[] }): Promise<void> {
  if (!value) return; // clear
  if (opts?.asFallback) {
    if (!FALLBACKABLE_ROLES.has(key)) {
      throw new AppError(400, `The "${key}" seat has no custom-fallback slot — ${ROLE_BY_KEY[key].builtInFallback}`);
    }
    // The utility fallback exists to ride out a CLOUD outage on the owner's
    // own node — a built-in id there is redundant-to-harmful (adversarial
    // review F1, 2026-09-15): 'deepseek-flash' would re-call the provider leg
    // that just failed/skipped (hammering a latched-off 402ing provider every
    // call), and 'qwen3.6-27b' IS the DashScope safety-net leg below. Custom
    // specs only; the runtime leg skips legacy stored built-ins (utility-llm.ts).
    if (key === 'utility' && !value.includes(':')) {
      throw new AppError(400, `The utility seat's custom fallback exists to ride out a cloud outage on YOUR OWN node — assign a "<label>:<modelId>" custom endpoint spec (e.g. nebius-b300:Qwen/Qwen3-32B). Built-in ids are already legs of the built-in chain (DeepSeek primary / DashScope safety net).`);
    }
  }
  if (key === 'decision') {
    await assertDecisionSpecAssignable(value);
    return;
  }
  if (IMAGE_ROLES.has(key)) {
    // The Image generator seat (2026-09-24) has its own built-in vocabulary
    // (image models) and accepts a registered endpoint model ONLY when flagged
    // [image] (OpenAI-compatible POST /images/generations). Chat built-ins
    // ('kimi-k3'…) fall to the not-offered error below — this branch runs
    // BEFORE the BUILT_IN_MODEL_IDS branch. The same rule serves asFallback.
    const persona = ROLE_BY_KEY[key].persona;
    if (IMAGE_BUILT_IN_OPTIONS.includes(value)) return;
    if (!value.includes(':')) {
      throw new AppError(400, `"${value}" is not offered for the "${persona}" seat. Built-ins: ${IMAGE_BUILT_IN_OPTIONS.join(' / ')} — or assign a registered endpoint model flagged [image] (an OpenAI-compatible POST /images/generations route).`);
    }
    const reg = await resolveRegistryModel(value).catch(() => null);
    if (!reg) {
      throw new AppError(400, `"${value}" for the "${persona}" seat does not resolve — check the endpoint label, model id, and that the endpoint is enabled.`);
    }
    if (reg.image !== true) {
      throw new AppError(400, `"${value}" is registered but not flagged [image] — enable the image toggle on that model in the endpoint dialog (it must serve an OpenAI-compatible POST /images/generations returning data[0].b64_json or url).`);
    }
    // 09a03aef (2026-10-24): SAVE-TIME chain-timeout warning — a custom image
    // model whose MEASURED probe latency (the entry's last Detect capabilities
    // run) implies a chain-size latency ABOVE its effective chain timeout will
    // time out on every real chat generate and silently fall to a built-in
    // (the exact incident this ticket reports). The save still proceeds (the
    // admin may know the backend is being tuned) — but it is never silent:
    // updateModelRoles collects the line and the PUT response carries it.
    // Probe-passing asserts (testModelRole) run with no collector — read-only.
    if (opts?.warnings && !opts?.probe) {
      try {
        const { resolveRegistryModelEntry } = await import('./model-endpoints.service');
        const entry = await resolveRegistryModelEntry(value).catch(() => null);
        // 09a03aef (review): only a Detect row whose image probe SUCCEEDED
        // (ok + value true — row() marks a failed probe ok:true / value:false)
        // carries a latency worth scaling; a failed probe's latency is noise.
        const detected = entry?.capabilities?.results?.find(r => r.capability === 'image_generation' && r.ok === true && r.value === true);
        const measuredMs = detected?.latencyMs ?? 0;
        if (measuredMs > 0) {
          const { probeChainRepresentativeness } = await import('../image-generate');
          const chainTimeoutMs = reg.imageTimeoutMs && reg.imageTimeoutMs > 0 ? reg.imageTimeoutMs : (await import('../image-generate')).imageCustomTimeoutMs();
          const verdict = probeChainRepresentativeness(measuredMs, chainTimeoutMs);
          if (verdict) opts.warnings.push(`"${value}" on the "${persona}" seat: ${verdict}`);
        }
      } catch { /* the warning is best-effort — the save path never breaks on it */ }
    }
    return;
  }
  if (NON_CHAT_ROLES.has(key)) {
    if (!value.includes(':')) {
      throw new AppError(400, `Role "${key}" takes a "<label>:<modelId>" endpoint spec (an embedding / rerank / speech-to-text / text-to-speech model on a registered endpoint), or empty for the built-in default.`);
    }
    const reg = await resolveRegistryModel(value).catch(() => null);
    if (!reg) {
      throw new AppError(400, `"${value}" for role "${key}" does not resolve — check the endpoint label, model id, and that the endpoint is enabled.`);
    }
    // SAVE-TIME dimension gate (owner 2026-09-08): a wrong-dimension embeddings
    // model used to save fine (the Test button was advisory) and then FAIL
    // CLOSED on every embedTexts call — ingestion errored, chat RAG went dark,
    // memory fell to keyword-only, all with only log lines. Refuse the save
    // with the same verdict the Test button shows. (testModelRole passes no
    // opts: it probes itself right after, so the probe never runs twice.)
    if (key === 'embeddings' && opts?.probeEmbeddingDims) {
      const probe = await probeEmbeddings(value);
      if (!probe.ok) throw new AppError(400, `Refusing to save the embeddings role — ${probe.error}`);
    }
    return;
  }
  if (BUILT_IN_MODEL_IDS.has(value)) {
    if (NON_STREAMING_ROLES.has(key) && REASONING_BUILT_INS.has(value)) {
      throw new AppError(400, `"${value}" cannot serve the "${key}" role: this seat is called non-streaming for fast background work, and reasoning models either must stream (Kimi) or leak/burn their thinking there. Use ${FAST_BUILT_IN_MODEL_IDS.join(' / ')} or a custom endpoint model.`);
    }
    if (VISION_ROLES.has(key) && !VISION_BUILT_IN_MODEL_IDS.includes(value)) {
      throw new AppError(400, `"${value}" cannot serve the "${ROLE_BY_KEY[key].persona}" seat: it sends images inline and ${value} is text-only. Use ${builtInOptionsFor(key).join(' / ')} or a custom endpoint model flagged [vision].`);
    }
    if (NON_STREAMING_TOOL_ROLES.has(key) && key !== 'computer_vision' && MUST_STREAM_BUILT_INS.has(value)) {
      throw new AppError(400, `"${value}" cannot serve the "${ROLE_BY_KEY[key].persona}" seat: it is called non-streaming (one bounded call per step) and Kimi must stream — a non-streaming Kimi call blocks 100+ seconds on its reasoning. Use ${builtInOptionsFor(key).join(' / ')} or a custom endpoint model.`);
    }
    if (!builtInOptionsFor(key).includes(value)) {
      throw new AppError(400, `"${value}" is not offered for the "${ROLE_BY_KEY[key].persona}" seat. Built-ins for this seat: ${builtInOptionsFor(key).join(' / ')} — or assign a custom endpoint model.`);
    }
    return;
  }
  if (!value.includes(':')) {
    throw new AppError(400, `"${value}" for role "${key}" is not a built-in model or a "<label>:<modelId>" endpoint spec.`);
  }
  const reg = await resolveRegistryModel(value).catch(() => null);
  if (!reg) {
    throw new AppError(400, `"${value}" for role "${key}" does not resolve — check the endpoint label, model id, and that the endpoint is enabled.`);
  }
  // Seat governance (audit E3, 2026-09-27; review fixer the same day): the
  // 2026-09-22 no-frontier doctrine, OBSERVED where a seat is assigned (PUT
  // /admin/model-roles + fallbacks, POST /admin/model-roles/test) — never on
  // the run path. A frontier-class registry model (provider-class.ts: a
  // frontier vendor host, or a proxy id like `api-anthropic-claude-fable-5-1`)
  // on a governed chat / supervisor seat writes ONE loop_metrics
  // seat_governance row (fail-open on the write) and, by default, SAVES: the
  // seat is the owner's setting (observe-only on the owner's own
  // configuration). Refusal is OPT-IN — FRONTIER_SEATS_REFUSE=1 — and even
  // then (a) a PROBE is read-only and always runs (the admin Test button and
  // the in-loop test_model_role must be able to tell whether the owner's live
  // seat is alive), and (b) an owner-confirmed card (set_model_role_fallback,
  // ASK-ONLY by construction) is the owner's decision and passes.
  if (reg.governanceClass === 'frontier' && FRONTIER_GOVERNED_ROLES.has(key)) {
    const probe = opts?.probe === true;
    // roster 2026-10-06 C-1: the governance row follows the store-backed auto-pick policy ('all' by default; an
    // env FRONTIER_SEATS_REFUSE=1 or AUTO_PICK_FRONTIER_DISABLED=1 reads 'open_only'). Fail-open: a policy read
    // failure reads the policy module's defaults (it never throws).
    const policy = await import('../platform/roster-policy').then((m) => m.autoPickPolicy()).catch(() => 'open_only' as const);
    const outcome: SeatGovernanceOutcome = probe || !frontierSeatsRefuse() ? (policy === 'all' ? 'allowed_by_policy' : 'observed')
      : opts?.ownerConfirmed ? 'allowed_by_owner'
      : 'refused';
    recordSeatGovernance({ role: key, spec: value, slot: opts?.asFallback ? 'fallback' : 'seat', outcome, probe, policy });
    if (outcome === 'refused') {
      throw new AppError(400, `"${value}" is a frontier-class model (a frontier vendor host, or a model id naming a closed frontier family) and this instance refuses it on the "${ROLE_BY_KEY[key].persona}" seat (FRONTIER_SEATS_REFUSE=1 — the 2026-09-22 no-frontier doctrine, enforced at save time). Assign an open-weight model, or unset FRONTIER_SEATS_REFUSE to return to observe-only governance (owner decision).`);
    }
  }
  // 2026-09-27 (owner: "coding is a seat choice, not a model capability"): every
  // CHAT-capable registry model is assignable to the chat / agent / coding
  // seats — chat-capable = the model IS a chat model (explicit kind, the legacy
  // [coding] flag, a detection, or the id heuristic), never an embeddings /
  // rerank / ASR / TTS / image / decision model.
  const chatCapable = typeof reg.chatCapable === 'boolean' ? reg.chatCapable : reg.coding === true;
  if (!chatCapable) {
    throw new AppError(400, `"${value}" for role "${key}" is registered as a ${reg.kind ?? 'non-chat'} model, not a chat model — only chat-capable models can serve this seat (set the model's kind to "chat" in the endpoint dialog, or run Detect capabilities, if that is wrong).`);
  }
  if (VISION_ROLES.has(key) && !reg.supportsVision) {
    throw new AppError(400, `"${value}" for the "${ROLE_BY_KEY[key].persona}" seat is not flagged [vision] — this seat sends images inline. Enable the vision toggle on that model in the endpoint dialog (only if the model really accepts image_url parts).`);
  }
}

/** Translate a patch's keys to current seat keys (legacy aliases accepted; the
 *  retired `utility_fallback` role lands in the fallbacks patch). */
function normalizePatch(patch: Record<string, string> | undefined, what: 'role' | 'fallback'): Array<[ModelRoleKey, string]> {
  const out: Array<[ModelRoleKey, string]> = [];
  for (const [k, v] of Object.entries(patch ?? {})) {
    const key = normalizeRoleKey(k);
    if (!key) {
      throw new AppError(400, `Unknown model ${what} "${k}" — valid roles: ${MODEL_ROLES.map(r => r.key).join(', ')}.`);
    }
    if (typeof v !== 'string' || v.length > 300) {
      throw new AppError(400, `${what === 'role' ? 'Role' : 'Fallback for'} "${k}" needs a string model spec (max 300 chars).`);
    }
    out.push([key, v.trim()]);
  }
  return out;
}

/**
 * Partial update: { roles: { <key>: <value> } } and/or (owner 2026-09-15)
 * { fallbacks: { <key>: <value> } }. '' clears an override / fallback back to
 * the built-in behaviour; unknown keys are a clear 400; legacy seat keys are
 * translated (and dropped from the stored row on this save). A fallback equal
 * to the seat's own model is refused — it could never take over. Returns the
 * fresh role list.
 */
export async function updateModelRoles(
  patch: Record<string, string>,
  userId?: string,
  opts?: {
    fallbacks?: Record<string, string>;
    /** Seat governance (review fixer 2026-09-27): the write rides an
     *  owner-confirmed card (`set_model_role_fallback` is ASK-ONLY — a human
     *  approved this exact call), so an opt-in FRONTIER_SEATS_REFUSE=1
     *  refusal yields to the owner's decision ('allowed_by_owner'). */
    ownerConfirmed?: boolean;
    /** 09a03aef: out-collector for save-time ADVISORY lines (the save still
     *  proceeds — these are warnings, never refusals). The controller
     *  forwards them on the PUT response; the agent tool ignores them. */
    warnings?: string[];
  },
): Promise<ModelRoleView[]> {
  // The retired `utility_fallback` role key rides the roles patch from old
  // clients — it IS the utility seat's fallback now.
  const rolesPatch: Record<string, string> = { ...(patch ?? {}) };
  const fallbacksPatch: Record<string, string> = { ...(opts?.fallbacks ?? {}) };
  if (Object.hasOwn(rolesPatch, LEGACY_UTILITY_FALLBACK_KEY)) {
    fallbacksPatch.utility = rolesPatch[LEGACY_UTILITY_FALLBACK_KEY];
    delete rolesPatch[LEGACY_UTILITY_FALLBACK_KEY];
  }
  const roleEntries = normalizePatch(rolesPatch, 'role');
  const fallbackEntries = normalizePatch(fallbacksPatch, 'fallback');
  if (!roleEntries.length && !fallbackEntries.length) {
    throw new AppError(400, 'No roles to update — send { roles: { "<role>": "<model or empty to reset>" } } and/or { fallbacks: { "<role>": "<model or empty>" } }.');
  }
  const ownerConfirmed = opts?.ownerConfirmed === true;
  for (const [k, v] of roleEntries) await assertAssignable(k, v, { probeEmbeddingDims: true, ownerConfirmed, warnings: opts?.warnings });
  for (const [k, v] of fallbackEntries) await assertAssignable(k, v, { asFallback: true, ownerConfirmed, warnings: opts?.warnings });
  // Read-modify-write the single config row (admin mutations are rare and
  // serialized through the UI — last write wins is acceptable here). Legacy
  // keys and retired built-in ids self-heal on the next save of ANY role.
  let existing: ModelRoleConfig = { overrides: {}, fallbacks: {} };
  try {
    existing = normalizeStoredRoleConfig(await storeGet<StoredRoleConfig>(STORE_NS, STORE_KEY));
  } catch { existing = { overrides: {}, fallbacks: {} }; }
  for (const [k, val] of roleEntries) {
    if (val) existing.overrides[k] = val;
    else delete existing.overrides[k];
  }
  for (const [k, val] of fallbackEntries) {
    if (val) existing.fallbacks[k] = val;
    else delete existing.fallbacks[k];
  }
  // A fallback identical to the seat's EFFECTIVE model can never take over —
  // refuse the combination as saved (either side of the patch may have
  // created it).
  for (const [k, fb] of Object.entries(existing.fallbacks)) {
    const key = k as ModelRoleKey;
    const effective = existing.overrides[key] || roleDefaultModel(key, existing.overrides);
    if (fb && effective && fb === effective) {
      throw new AppError(400, `The fallback for "${ROLE_BY_KEY[key].persona}" is the same model the seat already runs (${fb}) — pick a different model, or clear the fallback to keep Digby's built-in behaviour.`);
    }
  }
  await storePut(STORE_NS, STORE_KEY, { roles: existing.overrides, fallbacks: existing.fallbacks });
  clearModelRoleCache();
  logger.info(`model-roles: updated ${[
    ...roleEntries.map(([k, v]) => `${k}=${v || '(default)'}`),
    ...fallbackEntries.map(([k, v]) => `${k}.fallback=${v || '(built-in)'}`),
  ].join(', ')}`);
  return listModelRoles(userId);
}

// ── Live connection tester (admin "verify it actually works" button) ─────────
// The endpoint dialog's Test only proves GET /models; runs then failed on the
// COMPLETION call (PR #610's acknowledged gap). These probes exercise the real
// call shape per role: chat roles stream a completion until the FIRST token
// (proves auth + model id without waiting out a reasoning model), embeddings
// posts /embeddings and checks the 1536-dimension contract, rerank posts a
// Cohere-style /rerank. Errors never leak the key.

/** Exported for endpoint-verifier.ts (its full-stream parse probe reuses the
 *  same 20s budget — one timeout constant for every admin probe). */
export const ROLE_TEST_TIMEOUT_MS = 20_000;
/**
 * 2026-10-07 (owner: "longer time outs for custom endpoints"): a CUSTOM endpoint (a registry `<label>:<model>` spec —
 * self-hosted or gateway) gets a longer probe budget. The Digby seat's real request (208 tool definitions, 212 KB) took
 * 41 s to its first token on a COLD Spark prefill (warm 1.3 s), so 20 s reported a working model as "Timed out". 55 s by
 * default — under the ALB's 60 s idle timeout, which would otherwise cut the admin request itself. Env
 * ROLE_TEST_CUSTOM_TIMEOUT_MS (clamped 20–58 s); ROLE_TEST_CUSTOM_TIMEOUT_DISABLED=1 restores 20 s for every probe.
 */
export const ROLE_TEST_CUSTOM_TIMEOUT_DEFAULT_MS = 55_000;
export function roleTestCustomTimeoutMs(): number {
  if (process.env.ROLE_TEST_CUSTOM_TIMEOUT_DISABLED === '1') return ROLE_TEST_TIMEOUT_MS;
  const n = Number(process.env.ROLE_TEST_CUSTOM_TIMEOUT_MS);
  return Number.isFinite(n) && n > 0 ? Math.min(58_000, Math.max(ROLE_TEST_TIMEOUT_MS, Math.floor(n))) : ROLE_TEST_CUSTOM_TIMEOUT_DEFAULT_MS;
}
/** The probe budget for a seat spec: custom endpoint (`<label>:<model>`) ⇒ the longer budget; built-in ⇒ 20 s. */
export function roleTestTimeoutMs(spec: string | null | undefined): number {
  return typeof spec === 'string' && spec.includes(':') ? roleTestCustomTimeoutMs() : ROLE_TEST_TIMEOUT_MS;
}
/** Grace over IMAGE_PROBE_TIMEOUT_MS before the image Test answers on its own (the runtime's clamps normally win). */
export const IMAGE_PROBE_HARD_CAP_GRACE_MS = 5_000;

// Built-in embeddings/rerank targets — mirrors of rag.service.ts constants
// (kept here to avoid importing the whole RAG module into the admin path;
// the model-roles test in model-roles.service.test.ts pins them in sync).
const BUILTIN_EMBEDDING_URL = 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1/embeddings';
const BUILTIN_EMBEDDING_MODEL = 'text-embedding-v4';
const BUILTIN_RERANK_URL = 'https://dashscope-intl.aliyuncs.com/compatible-api/v1/reranks';
const BUILTIN_RERANK_MODEL = 'qwen3-rerank';
/** The pgvector schema is pinned to vector(1536) everywhere — an override must match. */
export const EMBEDDING_DIMENSIONS = 1536;

export interface ModelRoleTestResult {
  ok: boolean;
  /** What was exercised, e.g. "my-ollama:qwen3:32b" or "built-in default (kimi-k3)". */
  target: string;
  latencyMs: number;
  detail?: string;
  error?: string;
  /** Image generator seat only (2026-09-24): the probe's generated thumbnail,
   *  base64 — the admin page renders it under the result line. */
  image?: { mediaType: string; data: string };
}

/** Key-scrubbed error text (safeTestError's contract, shared shape).
 *  Redaction runs BEFORE any truncation (a slice could otherwise cut the key
 *  mid-string and leak a prefix) and also covers the key's JSON-escaped
 *  rendering plus generic bearer tokens in echoed bodies (review finding).
 *  Exported for endpoint-verifier.ts (per-model parse verification probes). */
export function scrubError(err: any, apiKey?: string | null, timeoutMs: number = ROLE_TEST_TIMEOUT_MS): string {
  const redact = (s: string): string => {
    let out = s.replace(/Bearer\s+[^\s"'\\)]+/gi, 'Bearer •••');
    if (apiKey) {
      out = out.split(apiKey).join('•••');
      const escaped = JSON.stringify(apiKey).slice(1, -1);
      if (escaped !== apiKey) out = out.split(escaped).join('•••');
    }
    return out;
  };
  const status = err?.response?.status;
  const body = (() => {
    try {
      // 2026-09-29: a streamed error body (the chat probes post with
      // responseType 'stream') was JSON-serialized as the raw stream object
      // ("{"_writeState":…"). Prefer the text drainAxiosErrorBody cached on
      // the error; never serialize an undrained stream.
      if (typeof err?.digbyBody === 'string' && err.digbyBody) return redact(err.digbyBody).slice(0, 200);
      const data = err?.response?.data;
      if (data && typeof data === 'object' && typeof data.on === 'function') return '';
      // Ticket 902ea9c1 (2026-10-26): byte-fetching probes (tts/image post with
      // responseType 'arraybuffer') surface upstream error bodies as Node
      // Buffers / typed arrays — JSON.stringify renders that as
      // {"type":"Buffer","data":[123,34,…]} and hides the provider's message.
      // Decode bytes to text (utf8, lossy on invalid sequences so a binary body
      // can never throw) so the actual JSON error text shows; a plain
      // {type:'Buffer',data:[…]} object (a buffer echoed back as JSON) decodes
      // the same way. Redaction still runs on the DECODED text.
      let text: string | null = null;
      if (Buffer.isBuffer(data) || data instanceof Uint8Array) {
        text = Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString('utf8');
      } else if (data instanceof ArrayBuffer) {
        text = Buffer.from(data).toString('utf8');
      } else if (data && typeof data === 'object' && data.type === 'Buffer' && Array.isArray(data.data) && data.data.every((b: any) => typeof b === 'number')) {
        text = Buffer.from(data.data).toString('utf8');
      }
      if (text != null) return redact(text).slice(0, 200);
      return redact(JSON.stringify(data) ?? '').slice(0, 200);
    } catch { return ''; }
  })();
  let msg = status
    ? `HTTP ${status}${err?.response?.statusText ? ` ${redact(String(err.response.statusText))}` : ''}${body && body !== '{}' ? ` — ${body}` : ''}`
    : err?.code === 'ECONNABORTED' || /timeout/i.test(String(err?.message || ''))
      ? `Timed out after ${timeoutMs / 1000}s${timeoutMs > ROLE_TEST_TIMEOUT_MS ? ' — no first token yet; a self-hosted model can take this long on a cold start (the next try usually answers in seconds once its cache is warm)' : ''}`
      : String(err?.message || err?.code || 'connection failed');
  return redact(msg).slice(0, 500);
}

/** Bearer + JSON headers for the OpenAI-compatible probes. Exported for
 *  endpoint-verifier.ts (its streaming parse probe sends the same headers). */
export function authHeaders(apiKey?: string | null): Record<string, string> {
  return { ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}), 'Content-Type': 'application/json' };
}

/** Resolve a NON-CHAT override spec to { url suffix target, key } or the built-in mirror.
 *  `builtin` is omitted by roles whose '' default is NOT the DashScope mirror
 *  (asr resolves its own env chain in the caller). */
async function nonChatTarget(
  spec: string,
  pathSuffix: '/embeddings' | '/rerank' | '/audio/transcriptions' | '/audio/speech',
  builtin?: { url: string; model: string },
): Promise<{ url: string; model: string; apiKey?: string | null; matryoshka: boolean }> {
  if (!spec) {
    if (!builtin) throw new AppError(400, 'This role has no built-in default to test — assign a custom endpoint model.');
    if (!process.env.DASHSCOPE_API_KEY) throw new AppError(400, 'The built-in default needs DASHSCOPE_API_KEY, which is not set on this instance — assign a custom endpoint instead.');
    return { url: builtin.url, model: builtin.model, apiKey: process.env.DASHSCOPE_API_KEY, matryoshka: false };
  }
  const reg = await resolveRegistryModel(spec).catch(() => null);
  if (!reg) throw new AppError(400, `"${spec}" does not resolve — check the endpoint label, model id, and that the endpoint is enabled.`);
  return { url: `${reg.baseUrl}${pathSuffix}`, model: reg.model, apiKey: reg.apiKey, matryoshka: reg.matryoshka === true };
}

/**
 * The dimension-mismatch verdict, distinguishing the two very different
 * problems that used to share one sentence (owner 2026-09-08, Qwen3-Embedding-8B
 * "returns 4096"): the server REJECTED `dimensions` (400 → we retried without;
 * vLLM says so in the body when the model isn't Matryoshka-flagged) vs the
 * server IGNORED it and returned its native size. Names every fix path.
 * Exported for tests and shared verbatim by the runtime's error text shape.
 */
export function describeDimsMismatch(native: number, dimsRejected: boolean, rejectBody: string): string {
  const lead = dimsRejected
    ? `The server REJECTED the OpenAI \`dimensions\` parameter (${rejectBody || 'HTTP 400'}) and natively returns ${native}-dimensional vectors`
    : `The server IGNORED the \`dimensions\` request and returned ${native}-dimensional vectors`;
  const fix = native > EMBEDDING_DIMENSIONS
    ? `Digby's vector store is pinned to ${EMBEDDING_DIMENSIONS}. Fixes: (a) if this is an MRL-trained model (Qwen3-Embedding, text-embedding-3, nomic-embed v1.5…) flag it "MRL" on the endpoint's model entry so Digby truncates to ${EMBEDDING_DIMENSIONS} client-side; (b) make the server honor \`dimensions\` (vLLM: --hf-overrides '{"is_matryoshka": true}'; a LiteLLM proxy must forward the param); or (c) pick a model that natively outputs ${EMBEDDING_DIMENSIONS} dims.`
    : `Digby's vector store is pinned to ${EMBEDDING_DIMENSIONS} and a shorter vector cannot be padded — pick a model that outputs ${EMBEDDING_DIMENSIONS} dims (or supports the \`dimensions\` parameter).`;
  return `${lead}. ${fix}`;
}

/** POST /embeddings and verify the 1536-dimension contract — with the same
 *  Matryoshka truncation the runtime applies for flagged models, so Test
 *  predicts runtime. Exported for endpoint-verifier.ts (per-model parse
 *  verification) — keep the 1536-dim/matryoshka semantics identical. */
export async function probeEmbeddings(spec: string): Promise<ModelRoleTestResult> {
  const t0 = Date.now();
  const target = spec || `built-in default (${BUILTIN_EMBEDDING_MODEL})`;
  let apiKey: string | null | undefined;
  try {
    const t = await nonChatTarget(spec, '/embeddings', { url: BUILTIN_EMBEDDING_URL, model: BUILTIN_EMBEDDING_MODEL });
    apiKey = t.apiKey;
    const post = (body: any) => axios.post(t.url, body, { headers: authHeaders(t.apiKey), timeout: roleTestTimeoutMs(spec) });
    // Track whether the server REJECTED `dimensions` (400 → retry without) and
    // keep its (scrubbed) first body — for vLLM that body is the sentence that
    // tells the admin to enable is_matryoshka.
    let dimsRejected = false;
    let rejectBody = '';
    let resp;
    try {
      resp = await post({ model: t.model, input: ['Digby connection test'], dimensions: EMBEDDING_DIMENSIONS });
    } catch (err: any) {
      if (err?.response?.status === 400) {
        dimsRejected = true;
        rejectBody = scrubError(err, t.apiKey, roleTestTimeoutMs(spec));
        resp = await post({ model: t.model, input: ['Digby connection test'] });
      } else {
        throw err;
      }
    }
    const vec = resp.data?.data?.[0]?.embedding;
    if (!Array.isArray(vec)) {
      return { ok: false, target, latencyMs: Date.now() - t0, error: 'Response is not an OpenAI-compatible /embeddings shape (expected data[0].embedding array).' };
    }
    const native = vec.length;
    if (native === EMBEDDING_DIMENSIONS) {
      return { ok: true, target, latencyMs: Date.now() - t0, detail: `embedding OK — ${EMBEDDING_DIMENSIONS} dimensions${dimsRejected ? ' (the server rejected the `dimensions` param but its native size already matches)' : ''}` };
    }
    if (t.matryoshka && native > EMBEDDING_DIMENSIONS) {
      truncateMatryoshka(vec, EMBEDDING_DIMENSIONS); // same operation the runtime applies — proves the shape
      return { ok: true, target, latencyMs: Date.now() - t0, detail: `embedding OK — native ${native} dims, Matryoshka-truncated to ${EMBEDDING_DIMENSIONS} client-side (the server ${dimsRejected ? 'rejected' : 'ignored'} the \`dimensions\` request)` };
    }
    return { ok: false, target, latencyMs: Date.now() - t0, error: describeDimsMismatch(native, dimsRejected, rejectBody) };
  } catch (err: any) {
    if (err instanceof AppError) throw err;
    return { ok: false, target, latencyMs: Date.now() - t0, error: scrubError(err, apiKey, roleTestTimeoutMs(spec)) };
  }
}

/** POST a Cohere-style /rerank probe and verify the results shape.
 *  Exported for endpoint-verifier.ts (per-model parse verification). */
export async function probeRerank(spec: string): Promise<ModelRoleTestResult> {
  const t0 = Date.now();
  const target = spec || `built-in default (${BUILTIN_RERANK_MODEL})`;
  let apiKey: string | null | undefined;
  try {
    const t = await nonChatTarget(spec, '/rerank', { url: BUILTIN_RERANK_URL, model: BUILTIN_RERANK_MODEL });
    apiKey = t.apiKey;
    const resp = await axios.post(t.url, {
      model: t.model,
      query: 'digby connection test',
      documents: ['alpha test document', 'beta test document'],
      top_n: 1,
    }, { headers: authHeaders(t.apiKey), timeout: roleTestTimeoutMs(spec) });
    const results = resp.data?.results;
    if (!Array.isArray(results) || !results.length || typeof results[0]?.index !== 'number') {
      return { ok: false, target, latencyMs: Date.now() - t0, error: 'Response is not a Cohere-style /rerank shape (expected results[{index, relevance_score}]).' };
    }
    return { ok: true, target, latencyMs: Date.now() - t0, detail: `rerank OK — ${results.length} scored result(s)` };
  } catch (err: any) {
    if (err instanceof AppError) throw err;
    return { ok: false, target, latencyMs: Date.now() - t0, error: scrubError(err, apiKey, roleTestTimeoutMs(spec)) };
  }
}

// ── ASR probe payload: a ~0.5s 16kHz mono 16-bit PCM silence WAV, built in
// code (44-byte RIFF header + zeroed samples — no fixture file). Silent on
// purpose: we only need the server to ACCEPT the request (auth, model id,
// multipart /audio/transcriptions handling); most ASR servers return an empty
// transcript, which is a green result here.
const ASR_PROBE_SAMPLE_RATE = 16_000;
const ASR_PROBE_NUM_SAMPLES = 8_000; // 0.5s of 16kHz mono
export const ASR_PROBE_WAV_FILENAME = 'digby-connection-test.wav';

/** Build the probe WAV buffer (RIFF/WAVE, 16-bit PCM, mono, 16kHz, ~0.5s). */
export function buildAsrProbeWav(): Buffer {
  const dataLen = ASR_PROBE_NUM_SAMPLES * 2; // 16-bit samples
  const buf = Buffer.alloc(44 + dataLen); // header + zeroed silence samples
  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(36 + dataLen, 4);      // ChunkSize (file - 8)
  buf.write('WAVE', 8, 'ascii');
  buf.write('fmt ', 12, 'ascii');
  buf.writeUInt32LE(16, 16);               // Subchunk1Size (PCM)
  buf.writeUInt16LE(1, 20);                // AudioFormat = PCM
  buf.writeUInt16LE(1, 22);                // NumChannels = mono
  buf.writeUInt32LE(ASR_PROBE_SAMPLE_RATE, 24);
  buf.writeUInt32LE(ASR_PROBE_SAMPLE_RATE * 2, 28); // ByteRate = rate * channels * 2
  buf.writeUInt16LE(2, 32);                // BlockAlign = channels * 2
  buf.writeUInt16LE(16, 34);               // BitsPerSample
  buf.write('data', 36, 'ascii');
  buf.writeUInt32LE(dataLen, 40);
  return buf;
}

/** Extract the transcript text an OpenAI-compatible /audio/transcriptions
 *  server may return — response_format varies (plain text, {text}, {segments}).
 *  Anything 2xx counts (the runtime treats an empty transcript as ''). */
export function asrTranscriptText(data: any): string {
  if (typeof data === 'string') return data.trim();
  if (data && typeof data === 'object' && typeof data.text === 'string') return data.text.trim();
  return '';
}

/** POST a multipart /audio/transcriptions probe with a tiny silent WAV —
 *  with the OVERRIDE's registry target when a spec is set, else the built-in
 *  chain's live leg (self-hosted STT_BASE_URL when configured, else DashScope
 *  qwen3-asr-flash — the exact legs speech.ts transcribeAudio runs). ANY 2xx is
 *  a pass (the runtime sends response_format 'text' and trims); the returned
 *  text snippet (usually empty for silence) is reported. */
async function probeAsr(spec: string): Promise<ModelRoleTestResult> {
  const t0 = Date.now();
  const sttBaseUrl = (process.env.STT_BASE_URL || '').trim().replace(/\/+$/, '');
  const sttModel = (process.env.STT_MODEL || 'whisper-1').trim();
  const dashscopeKey = (process.env.DASHSCOPE_API_KEY || '').trim();
  const target = spec
    || (sttBaseUrl
      ? `built-in ASR chain (self-hosted ${sttBaseUrl}, model ${sttModel})`
      : `built-in ASR chain (DashScope qwen3-asr-flash)`);
  let apiKey: string | null | undefined;
  try {
    if (!spec && !sttBaseUrl) {
      if (!dashscopeKey) {
        // Mirror roleServability: the chain needs STT_BASE_URL or DASHSCOPE_API_KEY.
        throw new AppError(400, 'The built-in ASR chain needs STT_BASE_URL (self-hosted STT) or DASHSCOPE_API_KEY (qwen3-asr-flash) — neither is set on this instance. Assign a custom endpoint model instead.');
      }
      // The DashScope leg is not an OpenAI-compatible multipart route — probe it
      // with the runtime's own client on the silent WAV.
      apiKey = dashscopeKey;
      const { transcribeAudio } = await import('../speech');
      const text = await transcribeAudio(buildAsrProbeWav(), ASR_PROBE_WAV_FILENAME, 'audio/wav', { onlyDashScope: true });
      return { ok: true, target, latencyMs: Date.now() - t0, detail: `qwen3-asr-flash OK — ${text ? `returned ${JSON.stringify(text.slice(0, 40))}` : 'empty transcript for the 0.5s silent probe (expected)'}` };
    }
    let url: string, model: string, key: string | null | undefined;
    if (spec) {
      const t = await nonChatTarget(spec, '/audio/transcriptions');
      url = t.url; model = t.model; key = t.apiKey;
    } else {
      url = `${sttBaseUrl}/audio/transcriptions`;
      model = sttModel;
      key = (process.env.STT_API_KEY || 'digby-local-stt').trim();
    }
    apiKey = key;
    const FormData = require('form-data');
    const form = new FormData();
    form.append('file', buildAsrProbeWav(), { filename: ASR_PROBE_WAV_FILENAME, contentType: 'audio/wav' });
    form.append('model', model);
    form.append('response_format', 'text');
    const resp = await axios.post(url, form, {
      headers: { ...(key ? { Authorization: `Bearer ${key}` } : {}), ...form.getHeaders() },
      timeout: roleTestTimeoutMs(spec),
      maxContentLength: 10 * 1024 * 1024,
      maxBodyLength: 10 * 1024 * 1024,
    });
    const text = asrTranscriptText(resp.data);
    return {
      ok: true,
      target,
      latencyMs: Date.now() - t0,
      detail: `transcription endpoint OK — ${text ? `returned ${JSON.stringify(text.slice(0, 40))}` : 'empty transcript for the 0.5s silent probe (expected)'}`,
    };
  } catch (err: any) {
    if (err instanceof AppError) throw err;
    return { ok: false, target, latencyMs: Date.now() - t0, error: scrubError(err, apiKey, roleTestTimeoutMs(spec)) };
  }
}

/** Text-to-speech probe: the OVERRIDE's OpenAI-compatible POST /audio/speech
 *  (a few words, mp3) must answer 2xx with audio bytes; the built-in default
 *  runs the runtime's DashScope qwen3-tts-flash client on the same words. */
async function probeTts(spec: string): Promise<ModelRoleTestResult> {
  const t0 = Date.now();
  const target = spec || 'built-in default (DashScope qwen3-tts-flash)';
  let apiKey: string | null | undefined;
  try {
    if (!spec) {
      if (!process.env.DASHSCOPE_API_KEY) throw new AppError(400, 'The built-in text-to-speech default needs DASHSCOPE_API_KEY, which is not set on this instance — assign a custom endpoint model instead.');
      apiKey = process.env.DASHSCOPE_API_KEY;
      const { textToSpeech } = await import('../speech');
      const spoken = await textToSpeech('Digby connection test.');
      return { ok: spoken.audio.length > 0, target, latencyMs: Date.now() - t0, detail: `${spoken.model} OK — ${spoken.audio.length.toLocaleString()} bytes of ${spoken.mimeType} (voice ${spoken.voice})` };
    }
    const t = await nonChatTarget(spec, '/audio/speech');
    apiKey = t.apiKey;
    const resp = await axios.post(t.url, { model: t.model, input: 'Digby connection test.', voice: 'alloy', response_format: 'mp3' }, {
      headers: authHeaders(t.apiKey), timeout: roleTestTimeoutMs(spec), responseType: 'arraybuffer',
    });
    const bytes = Buffer.from(resp.data).length;
    const ct = String(resp.headers?.['content-type'] || '');
    if (!bytes || (ct && !ct.startsWith('audio/') && !ct.includes('octet-stream'))) {
      return { ok: false, target, latencyMs: Date.now() - t0, error: `Response is not audio (content-type ${ct || 'unknown'}, ${bytes} bytes) — the route must return the spoken audio bytes like OpenAI's /audio/speech.` };
    }
    return { ok: true, target, latencyMs: Date.now() - t0, detail: `speech OK — ${bytes.toLocaleString()} bytes (${ct || 'audio'})` };
  } catch (err: any) {
    if (err instanceof AppError) throw err;
    return { ok: false, target, latencyMs: Date.now() - t0, error: scrubError(err, apiKey, roleTestTimeoutMs(spec)) };
  }
}

/** The tool schemas the seat's RUN would offer (agent.ts runToolSchemasForProbe)
 *  — [] for seats that never send tools, and fail-open to [] when the agent
 *  module cannot load here (a probe must never throw on its own shape). */
export async function roleProbeToolSchemas(roleKey: ModelRoleKey | null | undefined): Promise<any[]> {
  if (!roleKey) return [];
  const kind: 'chat' | 'coding' | null =
    roleKey === 'coding_default' || roleKey === 'coding_helper' || roleKey === 'coding_reviewer' || roleKey === 'coding_architect' || roleKey === 'coding_explorer' ? 'coding'
      : roleKey === 'chat_orchestrator' || roleKey === 'supervisor' || roleKey === 'project_supervisor' || roleKey === 'double_checker' || roleKey === 'triple_checker' ? 'chat'
        : null;
  if (!kind) return [];
  // Through the registry LEAF (run-tools-registry.ts), never by importing
  // coding/agent — its load graph reaches config/env (process.exit under an
  // unconfigured test env). agent.ts registers itself at boot in every server
  // process; a process that never loaded it probes without tools.
  const schemas = runToolSchemasIfLoaded({ kind, supervisorTools: roleKey === 'supervisor' || roleKey === 'project_supervisor' });
  if (!schemas) logger.warn(`model-roles: tool schemas for the ${roleKey} probe are not registered in this process — probing without tools`);
  return schemas ?? [];
}

/** Human explanation + fix for a classified invalid-request probe failure. */
export function describeProbeRejection(
  cls: { kind: string; detail: string; cap?: number },
  ctx: { model: string; persona: string; sentTools: number; noneRetry?: 'accepted' | 'rejected' | null },
): string {
  switch (cls.kind) {
    case 'tools_too_long':
      return `TOOL LIMIT: ${ctx.model} accepts at most ${cls.cap ?? 'N'} tools per request and the "${ctx.persona}" seat sends ${ctx.sentTools}. Set "max tools"${cls.cap ? ` = ${cls.cap}` : ''} on this model in the endpoint dialog (or run Detect capabilities) — Digby then trims the long tail automatically. Provider said: ${cls.detail}`;
    case 'reasoning_effort_unsupported':
      return `REASONING EFFORT: ${ctx.model} rejects reasoning_effort together with function tools on /chat/completions${ctx.noneRetry === 'accepted' ? " — retried with reasoning_effort:'none' and it ANSWERED; Digby now sends 'none' to this model" : ctx.noneRetry === 'rejected' ? " — a retry with reasoning_effort:'none' was rejected too" : ''}. LiteLLM fix: add \`reasoning_effort: none\` under litellm_params for this model group, or route the model via /v1/responses. Provider said: ${cls.detail}`;
    case 'tools_unsupported':
      return `TOOLS UNSUPPORTED: ${ctx.model} cannot serve tool-enabled requests as sent (vLLM: --enable-auto-tool-choice --tool-call-parser; LiteLLM must pass them through). Provider said: ${cls.detail}`;
    case 'model_not_found':
      return `MODEL NOT FOUND: the endpoint does not serve "${ctx.model}" — check the id (Fetch from server lists the served ids). Provider said: ${cls.detail}`;
    case 'context_too_long':
      return `CONTEXT TOO LONG: even the probe request exceeds ${ctx.model}'s window — set its context window on the model entry. Provider said: ${cls.detail}`;
    default:
      return `UNSUPPORTED PARAMETER: ${ctx.model} rejected a request parameter Digby sends. Provider said: ${cls.detail}`;
  }
}

/**
 * Stream a chat completion until the FIRST data chunk — proves auth + model id
 * without waiting out a reasoning model's full answer. 2026-09-27: the probe
 * sends the seat's REAL request shape (coding-model buildTurnPayload — the
 * seat's tool list trimmed to the model's cap, the effort param the run would
 * send, the custom-endpoint hygiene), so a 128-tool cap or a reasoning_effort
 * rejection shows up in the Test button, not in production. On the exact
 * reasoning_effort 400 it retries once with 'none' (and latches it for the
 * model, exactly as the run path does); every deterministic 400 is classified
 * and explained with the fix.
 */
async function probeChatCompletion(spec: string, target: string, opts?: { role?: ModelRoleKey | null }): Promise<ModelRoleTestResult> {
  const t0 = Date.now();
  let apiKey: string | undefined;
  try {
    const cm = await import('../coding/coding-model');
    const { providerToolLimit, trimToolsToLimit } = await import('../coding/provider-limits');
    const { classifyInvalidRequest } = await import('../coding/seat-invalid-request');
    const provider = await cm.resolveProviderForRun(spec);
    // A colon spec that silently fell back to built-ins is a config error the
    // tester must SURFACE, not mask (that silent fallback IS the Edge 401 bug).
    if (spec.includes(':') && !provider.label.endsWith('(custom endpoint)')) {
      return { ok: false, target, latencyMs: Date.now() - t0, error: `"${spec}" no longer resolves to an enabled, chat-capable endpoint model — the run path would silently fall back to ${provider.model}.` };
    }
    apiKey = provider.apiKey;
    if (!provider.apiKey && !spec.includes(':')) {
      return { ok: false, target, latencyMs: Date.now() - t0, error: `The built-in provider for "${provider.model}" has no API key set on this instance (${provider.label}).` };
    }
    const persona = opts?.role ? ROLE_BY_KEY[opts.role]?.persona ?? opts.role : 'seat';
    const schemas = await roleProbeToolSchemas(opts?.role);
    const limit = providerToolLimit(provider); // registry / documented class / learned cap, else the OPT-IN blanket env; unknown = none (built-ins none)
    const trimmed = limit && schemas.length > limit ? trimToolsToLimit(schemas, limit) : null;
    const toolsToSend = trimmed ? trimmed.tools : schemas;
    const payload: any = cm.buildTurnPayload(provider, [{ role: 'user', content: 'Connection test — reply with the single word OK.' }], toolsToSend.length ? toolsToSend : undefined);
    payload.max_tokens = 16;
    const shape = `${toolsToSend.length} tool(s)${trimmed ? ` (trimmed from ${trimmed.from} to the model's ${limit}-tool limit)` : ''}, reasoning_effort=${payload.reasoning_effort ?? 'omitted'}`;
    const post = (body: any) => axios.post(provider.url, body, {
      headers: authHeaders(provider.apiKey),
      timeout: roleTestTimeoutMs(spec),
      responseType: 'stream',
    });
    let noneRetry: 'accepted' | 'rejected' | null = null;
    let resp: any;
    try {
      resp = await post(payload);
    } catch (err: any) {
      const status = err?.response?.status;
      const body = await cm.drainAxiosErrorBody(err);
      const detail = cm.extractProviderErrorDetail(body, 600);
      // The run path's own effort retry, mirrored here (2026-09-29: 'none'
      // when effort cannot ride with tools, a LOWER rung when the value is
      // rejected, 'omit' when the parameter is unknown).
      const nextEffort = status === 400 && cm.isCustomEndpointProvider(provider)
        ? cm.nextReasoningEffortAfterRejection(payload.reasoning_effort, detail) : null;
      if (nextEffort && nextEffort !== (payload.reasoning_effort ?? 'omit')) {
        try {
          const retryPayload = { ...payload };
          delete retryPayload.thinking;
          if (nextEffort === 'omit') delete retryPayload.reasoning_effort; else retryPayload.reasoning_effort = nextEffort;
          resp = await post(retryPayload);
          noneRetry = 'accepted';
          cm.latchReasoningEffort(provider, nextEffort);
        } catch (err2: any) {
          noneRetry = 'rejected';
          const body2 = await cm.drainAxiosErrorBody(err2);
          const cls2 = classifyInvalidRequest({ errorStatus: err2?.response?.status, providerError: cm.extractProviderErrorDetail(body2, 600) });
          return { ok: false, target, latencyMs: Date.now() - t0, error: scrubError(new Error(describeProbeRejection(cls2 ?? { kind: 'reasoning_effort_unsupported', detail }, { model: provider.model, persona, sentTools: toolsToSend.length, noneRetry })), apiKey) };
        }
      } else {
        const cls = classifyInvalidRequest({ errorStatus: status, providerError: detail });
        if (cls) {
          return { ok: false, target, latencyMs: Date.now() - t0, error: scrubError(new Error(`${describeProbeRejection(cls, { model: provider.model, persona, sentTools: toolsToSend.length })} (request shape: ${shape})`), apiKey) };
        }
        throw err;
      }
    }
    await new Promise<void>((resolve, reject) => {
      const stream = resp.data;
      let gotData = false;
      const timer = setTimeout(() => { try { stream.destroy(); } catch { /* closing */ } reject(new Error(`Connected but no tokens arrived within ${roleTestTimeoutMs(spec) / 1000}s`)); }, roleTestTimeoutMs(spec));
      const done = (err?: Error) => {
        clearTimeout(timer);
        try { stream.destroy(); } catch { /* closing */ }
        if (err) reject(err); else resolve();
      };
      stream.once('data', () => { gotData = true; done(); });
      // A data-less 'end' is an empty 200 — the endpoint produced NO tokens,
      // which would fail every real run (review finding).
      stream.once('end', () => done(gotData ? undefined : new Error('Stream ended without any data — the endpoint returned an empty 200 (no tokens produced).')));
      stream.once('error', (err: Error) => done(err));
    });
    return {
      ok: true, target, latencyMs: Date.now() - t0,
      detail: `authenticated — completion stream opened and first tokens received; request shape: ${shape}${noneRetry === 'accepted' ? " — NOTE: the model rejected the injected reasoning_effort with tools; Digby now sends reasoning_effort:'none' to it (LiteLLM: add reasoning_effort: none under litellm_params for this model group, or route it via /v1/responses)" : ''}`,
    };
  } catch (err: any) {
    return { ok: false, target, latencyMs: Date.now() - t0, error: scrubError(err, apiKey, roleTestTimeoutMs(spec)) };
  }
}

/**
 * Test a role's model end-to-end with the REAL call shape. `candidate` tests
 * an unsaved value from the dialog ('' = the built-in default); omitted, the
 * currently-stored config is exercised. Validation errors (unknown role,
 * unresolvable spec) throw AppError(400); reachability/auth problems come back
 * as { ok:false, error } so the UI renders them inline.
 */
export async function testModelRole(roleKeyIn: string, candidate?: string, opts?: { fallback?: boolean }): Promise<ModelRoleTestResult> {
  // The retired `utility_fallback` role tests the utility seat's FALLBACK slot.
  const testingFallback = opts?.fallback === true || roleKeyIn === LEGACY_UTILITY_FALLBACK_KEY;
  const roleKey = normalizeRoleKey(roleKeyIn === LEGACY_UTILITY_FALLBACK_KEY ? 'utility' : roleKeyIn);
  if (!roleKey) {
    throw new AppError(400, `Unknown model role "${roleKeyIn}" — valid roles: ${MODEL_ROLES.map(r => r.key).join(', ')}.`);
  }
  const { overrides, fallbacks } = await getModelRoleConfig();
  const value = typeof candidate === 'string'
    ? candidate.trim()
    : ((testingFallback ? fallbacks[roleKey] : overrides[roleKey]) ?? '');
  // A live test is READ-ONLY: seat governance records it but never refuses
  // it (the owner must be able to probe their own live seat — review fixer
  // 2026-09-27).
  await assertAssignable(roleKey, value, { asFallback: testingFallback, probe: true });
  // A fallback slot has no built-in leg of its own to probe — an empty slot
  // means "Digby's built-in fallback behaviour", which the seat's own Test
  // (and, for utility, the built-in chain) already exercises.
  if (testingFallback && !value) {
    throw new AppError(400, `No custom fallback configured for "${ROLE_BY_KEY[roleKey].persona}" (empty = ${ROLE_BY_KEY[roleKey].builtInFallback}) — assign a model to test it here.`);
  }
  if (roleKey === 'embeddings') return probeEmbeddings(value);
  if (roleKey === 'rerank') return probeRerank(value);
  if (roleKey === 'asr') return probeAsr(value);
  if (roleKey === 'tts') return probeTts(value);
  if (IMAGE_ROLES.has(roleKey)) {
    // The runtime's own client generates the SMALLEST image the pinned leg
    // allows (never the chain — `spec` pins exactly one leg) and hands the
    // thumbnail back for the page to render. A keyless built-in 400s like the
    // other probes (mirrors roleServability).
    const spec = value || roleDefaultModel(roleKey, overrides);
    const target = value || `built-in default (${spec})`;
    const { imageSpecEnvKey, probeImageGenerate, imageProbeTimeoutMs } = await import('../image-generate');
    const envKey = imageSpecEnvKey(spec);
    if (envKey && !process.env[envKey]) {
      throw new AppError(400, `"${spec}" needs ${envKey}, which is not set on this instance — set it or assign a custom endpoint model flagged [image].`);
    }
    // Ticket 61d33af9 (2026-10-10): the probe budget is now 180 s (imageProbeTimeoutMs,
    // env-clamped) because real self-hosted image backends take ~118 s at the OpenAI
    // Images default shape. The SYNC route below still returns whatever the probe
    // answers — but a JSON POST held open >60 s dies at the ALB's idle timeout
    // (live-verified 60 s 2026-10-10), so the UI calls the STREAMING twin
    // (testModelRoleStream / POST /admin/model-roles/test/stream) which writes
    // keepalive frames while the probe runs. testModelRole stays the synchronous
    // twin for the agent tool and tests.
    // Ticket 04c8ffd1 (2026-10-23, review B1): a per-model imageTimeoutMs raises
    // the probe budget with it — a slow local backend (5-10 min/generation) that
    // the admin explicitly unblocked with a raised entry timeout must not be
    // "tested" against the stock 180 s budget and reported broken. The entry's
    // clamped value (resolveRegistryModel) wins; absent entry = stock probe budget.
    const { resolveRegistryModel } = await import('./model-endpoints.service');
    let entryImageTimeoutMs: number | undefined;
    try {
      const reg = await resolveRegistryModel(spec);
      entryImageTimeoutMs = reg?.imageTimeoutMs && reg.imageTimeoutMs > 0 ? reg.imageTimeoutMs : undefined;
    } catch {
      // A registry miss must not break the Test button — probeImageGenerate
      // reports the skip itself (the leg never resolves).
    }
    const budgetMs = Math.max(imageProbeTimeoutMs(), entryImageTimeoutMs ?? 0);
    const hardCapMs = budgetMs + IMAGE_PROBE_HARD_CAP_GRACE_MS;
    const t0 = Date.now();
    let capTimer: ReturnType<typeof setTimeout> | null = null;
    const capped = new Promise<Awaited<ReturnType<typeof probeImageGenerate>>>((resolve) => {
      capTimer = setTimeout(() => resolve({
        ok: false, latencyMs: Date.now() - t0,
        detail: `the probe did not finish within ${Math.round(hardCapMs / 1000)} s — the provider is still running the request; try a faster model or check the provider's status`,
      }), hardCapMs);
    });
    let r: Awaited<ReturnType<typeof probeImageGenerate>>;
    try {
      r = await Promise.race([probeImageGenerate(spec, budgetMs), capped]);
    } finally {
      if (capTimer) clearTimeout(capTimer);
    }
    return {
      ok: r.ok, target, latencyMs: r.latencyMs,
      ...(r.ok ? { detail: r.detail } : { error: r.detail }),
      ...(r.image ? { image: r.image } : {}),
    };
  }
  if (roleKey === 'decision') {
    // The gate's REAL call shape (one noul + one choice over a fixed sanity
    // state) against exactly the chosen spec — never the seat chain.
    const { probeDecisionSpec } = await import('../platform/decision-gate');
    return probeDecisionSpec(value || roleDefaultModel(roleKey, overrides));
  }
  // Agent-shaped roles run a chat-completion probe. An empty utility role
  // means "the built-in chain" — probe its primary leg (DeepSeek, else the
  // DashScope fallback) so the button verifies what would actually serve.
  // Project-supervisor preflight 2026-09-14: an inheriting seat's '' probes
  // the PARENT's resolved model (what it would actually run), never ''.
  let spec = value || roleDefaultModel(roleKey, overrides);
  let target = value || `built-in default (${spec || 'chain'})`;
  if (roleKey === 'utility' && !spec) {
    spec = process.env.DEEPSEEK_API_KEY ? 'deepseek-flash' : 'qwen3.6-27b';
    target = `built-in chain (${spec})`;
  }
  // A follow-session worker seat's '' = "the delegating lane's own model" —
  // probe the Workspace default seat as the representative of what most lanes
  // run, and say so (a per-project pick can differ).
  if (ROLE_BY_KEY[roleKey].followsSession && !spec) {
    spec = overrides['coding_default'] || ROLE_BY_KEY.coding_default.defaultModel;
    target = `unset — follows each lane's own coding model (probing the Workspace default seat: ${spec})`;
  }
  // The fast seats are called NON-STREAMING at runtime (pipes, utility leg) —
  // probe THAT shape (owner 2026-09-08): a streaming first-chunk probe went
  // green for a default-thinking custom Qwen whose real non-streaming call
  // returned only reasoning / empty content.
  if (NON_STREAMING_ROLES.has(roleKey) || NON_STREAMING_TOOL_ROLES.has(roleKey)) return probeNonStreamingCompletion(spec, target);
  // 2026-09-27: the agent seats probe with their REAL tool list + effort param.
  return probeChatCompletion(spec, target, { role: roleKey });
}

/**
 * Ticket 61d33af9 (2026-10-10): the STREAMING delivery twin of testModelRole.
 * The image probe now runs up to 180 s (imageProbeTimeoutMs) — longer than the
 * ALB's 60 s idle timeout — so a plain JSON POST would be cut mid-flight and
 * the admin would see a network error instead of the probe's typed answer.
 * This variant opens the SSE response FIRST (headers flushed immediately),
 * writes a keepalive comment every 15 s while the probe runs, and delivers the
 * result as ONE terminal `data:` frame — the browser-side reader treats the
 * `result` frame as the answer and any other frame as keepalive. The probe
 * itself is the SAME testModelRole call (same budget, same clamps) — only the
 * delivery differs. Used by POST /admin/model-roles/test/stream for EVERY role
 * (a 20 s chat probe rides it harmlessly), because the UI must not have to
 * know which seat is slow today.
 */
export async function testModelRoleStream(
  roleKeyIn: string,
  candidate: string | undefined,
  opts: { fallback?: boolean } | undefined,
  write: (frame: string) => void,
): Promise<void> {
  const hb = setInterval(() => { try { write(': keepalive\n\n'); } catch { /* client gone */ } }, 15_000);
  try {
    let result: ModelRoleTestResult;
    try {
      result = await testModelRole(roleKeyIn, candidate, opts);
    } catch (err: any) {
      // The sync route's typed errors (unknown role, keyless built-in, empty
      // fallback slot) reach the stream as a failed result frame — the UI
      // renders them exactly like the JSON route's axios error toast.
      result = { ok: false, target: String(candidate ?? roleKeyIn), latencyMs: 0, error: String(err?.message || err) };
    }
    write(`data: ${JSON.stringify({ type: 'result', result })}\n\n`);
  } finally {
    clearInterval(hb);
  }
}

/**
 * Non-streaming probe with the Helper/Utility seats' REAL call shape
 * (helper-completion.ts: thinking-off directive for custom endpoints, closed +
 * unclosed <think> stripping, empty answer = failure naming the fix).
 * Exported for endpoint-verifier.ts (its 'utility' shape IS this probe).
 */
export async function probeNonStreamingCompletion(spec: string, target: string): Promise<ModelRoleTestResult> {
  const t0 = Date.now();
  let apiKey: string | undefined;
  try {
    const { resolveProviderForRun } = await import('../coding/coding-model');
    const { runHelperCompletion, HelperEmptyAnswerError } = await import('../coding/helper-completion');
    const provider = await resolveProviderForRun(spec);
    if (spec.includes(':') && !provider.label.endsWith('(custom endpoint)')) {
      return { ok: false, target, latencyMs: Date.now() - t0, error: `"${spec}" no longer resolves to an enabled, [coding]-flagged endpoint model — the run path would silently fall back to ${provider.model}.` };
    }
    apiKey = provider.apiKey;
    if (!provider.apiKey && !spec.includes(':')) {
      return { ok: false, target, latencyMs: Date.now() - t0, error: `The built-in provider for "${provider.model}" has no API key set on this instance (${provider.label}).` };
    }
    try {
      const answer = await runHelperCompletion(
        provider,
        [{ role: 'user', content: 'Connection test — reply with the single word OK.' }],
        { maxTokens: 256, temperature: 0, timeoutMs: roleTestTimeoutMs(spec) },
      );
      return {
        ok: true, target, latencyMs: Date.now() - t0,
        detail: `non-streaming completion OK — answered ${JSON.stringify(answer.text.slice(0, 40))}${answer.hadReasoning ? ' (the model also emitted reasoning — Digby strips it; flag the model "no-think" to stop paying for it)' : ''}`,
      };
    } catch (err: any) {
      if (err instanceof HelperEmptyAnswerError) return { ok: false, target, latencyMs: Date.now() - t0, error: err.message };
      throw err;
    }
  } catch (err: any) {
    return { ok: false, target, latencyMs: Date.now() - t0, error: scrubError(err, apiKey, roleTestTimeoutMs(spec)) };
  }
}
