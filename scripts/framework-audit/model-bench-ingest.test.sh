#!/usr/bin/env bash
# Offline checks for model-bench-ingest.js (offline model bench → scorecard, 2026-10-04): argument parsing + the pure
# helpers only — the ingest itself needs the backend container (/app/dist); its full run() is pinned with the REAL
# leaf by backend/src/scripts/model-bench-ingest.test.ts.
set -euo pipefail
cd "$(dirname "$0")"
node --check model-bench-ingest.js
node -e '
const s = require("./model-bench-ingest.js");
const eq = (a, b, m) => { if (JSON.stringify(a) !== JSON.stringify(b)) { console.error("FAIL " + m + ": " + JSON.stringify(a)); process.exit(1); } };
const pick = (o) => ({ runId: o.runId, apply: o.apply, cleanup: o.cleanup, judge: o.judge, judgeConcurrency: o.judgeConcurrency, err: !!o.error });
eq(pick(s.parseArgs(["--run-id", "mb1"], {})), { runId: "mb1", apply: false, cleanup: false, judge: true, judgeConcurrency: 4, err: false }, "dry run by default");
eq(pick(s.parseArgs(["--run-id", "mb1", "--apply", "--cleanup", "--no-judge", "--judge-concurrency", "2"], {})), { runId: "mb1", apply: true, cleanup: true, judge: false, judgeConcurrency: 2, err: false }, "flags");
eq(pick(s.parseArgs([], { RUN_ID: "mb2", APPLY: "1", CLEANUP: "true", NO_JUDGE: "1" })), { runId: "mb2", apply: true, cleanup: true, judge: false, judgeConcurrency: 4, err: false }, "env twins");
eq(!!s.parseArgs([], {}).error, true, "a run id is required");
eq(!!s.parseArgs(["--run-id", "a/b"], {}).error, true, "a bad run id is refused");
eq(/--apply/.test(s.parseArgs(["--run-id", "mb1", "--cleanup"], {}).error), true, "cleanup without apply is refused");
eq(s.familyOf("cql-litellm:api-optimize-zai-glm-5.3-flash"), "glm", "family from the model id");
eq(s.judgeBiasWarnings("deepseek-flash", ["deepseek-flash", "glm-5.3"]).length, 1, "same-family bias warning");
// 28d9e351: the unattended fail-safe helpers
eq(s.unattendedContext({ argv: [], env: {}, isTTY: false }), true, "no tty is unattended (the prodq docker-exec shape)");
eq(s.unattendedContext({ argv: [], env: { INVOCATION_ID: "x" }, isTTY: true }), true, "systemd injection is unattended");
eq(s.unattendedContext({ argv: ["--attended"], env: {}, isTTY: false }), false, "--attended forces the attended path");
eq(s.unattendedContext({ argv: [], env: { UNATTENDED: "0" }, isTTY: false }), false, "UNATTENDED=0 forces the attended path");
eq(s.unattendedContext({ argv: ["--unattended"], env: {}, isTTY: true }), true, "--unattended forces the guard on");
eq(s.DEFAULT_UNATTENDED_JUDGE, "qwen3.6-27b", "the pinned unattended default judge");
eq(s.pickConflictFreeJudge([{ spec: "cql-litellm:api-cohere-command-a-plus", family: "cohere", tier: "standard", servable: false, autoEligible: true }, { spec: "cql-litellm:mimo-v26-flash-rl", family: "mimo", tier: "fast", servable: true, autoEligible: true }], ["glm-5.3", "deepseek-flash"]), "cql-litellm:mimo-v26-flash-rl", "a retired (unservable) card never wins the auto-pick (28d9e351)");
eq(s.pickConflictFreeJudge([{ spec: "cql-litellm:api-cohere-command-a-plus", family: "cohere", tier: "standard", servable: false, autoEligible: true }], ["glm-5.3"]), null, "only a retired card available => null, never it");
// 2026-10-20 task kinds: the title kind vs the classified kind (counts only) and the per-kind summary lines
eq(s.kindAgreement([{ kind: "code", planKind: "code" }, { kind: "code", planKind: "explain" }, { kind: "writing" }, { planKind: "lookup" }]), { agree: 1, differ: 1, unstamped: 1, noTitleKind: 1 }, "kind agreement counts");
const kl = s.summaryLines({ models: { m: { lanes: { all: { n: 2, ttftP50Ms: 1, ttftP90Ms: 2, doneP50Ms: 3, failRate: 0, quality: 4, qualityN: 2 } }, kinds: { code: { n: 2, ttftP50Ms: 1, ttftP90Ms: 2, doneP50Ms: 3, failRate: 0, quality: 4, qualityN: 2, fieldSize: 3 } } } } }, { m: { measured: 2 } });
eq(kl.length, 3, "one line per lane and per kind under the model line");
eq(/^  k:code .* · field 3$/.test(kl[2]), true, "a kind line names the kind and its field size");
// 2026-10-20 review: the ALL-singleton shape (answers measured, no comparative group) is a broken run — unattended refuses it
eq(s.allSingletonRun({ measured: 2, comparativeGroups: 0, singletonsUnjudged: 2 }), true, "an all-singleton run is flagged");
eq(s.allSingletonRun({ measured: 3, comparativeGroups: 1, singletonsUnjudged: 1 }), false, "a mixed run (one comparative group) is a normal run");
eq(s.allSingletonRun({ measured: 0, comparativeGroups: 0, singletonsUnjudged: 0 }), false, "nothing measured is not the all-singleton shape");
eq(s.allSingletonRun({ measured: 2, comparativeGroups: 0, singletonsUnjudged: 0 }), false, "an all-absolute run is the 28d9e351 refuse, not this one");
// 2026-10-20 judge v2 (the default): the panel, the flags, the ballots, the aggregation
eq(s.parseArgs(["--run-id", "mb1"], {}).judgeVersion, "v2", "judge v2 is the default");
eq(s.parseArgs(["--run-id", "mb1", "--judge-version", "v1"], {}).error, "", "--judge-version v1 restores the single judge");
eq(!!s.parseArgs(["--run-id", "mb1", "--judge-version", "v1", "--judge-panel", "qwen3.6-27b"], {}).error, true, "v2 flags are refused under v1");
eq(/DISTINCT/.test(s.parseArgs(["--run-id", "mb1", "--judge-panel", "qwen3.6-27b,qwen3.6-flash"], {}).error), true, "a panel needs distinct families");
eq(s.parseArgs([], { RUN_ID: "mb1", JUDGE_PANEL: "qwen3.6-27b,deepseek-flash", MIN_BALLOTS: "3" }).judgePanel, ["qwen3.6-27b", "deepseek-flash"], "JUDGE_PANEL env twin");
eq([...s.DEFAULT_JUDGE_PANEL], ["qwen3.6-27b", "deepseek-flash"], "the default panel: open, distinct families, non-streaming-safe");
const K3 = s.aggregateBallots([{ ranked: ["x", "y", "z"] }]);
eq([K3.x.quality, K3.y.quality, K3.z.quality], [5, 3, 1], "one ballot of K=3 is the v1 5/3/1");
eq(Object.values(s.aggregateBallots([{ ranked: ["x", "y", "z"] }, { ranked: ["z", "y", "x"] }])).map((v) => v.quality), [3, 3, 3], "a forward/reverse disagreement averages to 3");
const l2r = new Map([["A", { spec: "glm-5.3" }], ["B", { spec: "deepseek-flash" }], ["C", { spec: "kimi-k3" }]]);
eq(s.mapRankingToModels(["B"], l2r, { requireComplete: true }), null, "v2 refuses a partial ranking");
eq(s.mapRankingToModels(["B"], l2r).length, 3, "v1 still fills a partial ranking in by position");
const plan = s.ballotsFor({ questionIdx: 1, rows: [{ spec: "glm-5.3", chatId: "g" }, { spec: "deepseek-flash", chatId: "d" }, { spec: "kimi-k3", chatId: "k" }] }, ["deepseek-flash", "qwen3.6-27b"], { runId: "r" });
eq(plan.ballots.filter((b) => b.judge === "deepseek-flash").every((b) => b.pairs.every((p) => p.row.chatId !== "d")), true, "a judge never ranks its own family");
const qb = plan.ballots.filter((b) => b.judge === "qwen3.6-27b").map((b) => b.pairs.map((p) => p.row.chatId));
eq(qb.length, 3, "K ballots for K answers");
eq(qb[1], [...qb[0].slice(1), qb[0][0]], "ballot o is the shuffle rotated by o (a cyclic Latin square)");
eq([0, 1, 2].every((slot) => new Set(qb.map((o) => o[slot])).size === 3), true, "every answer once in every slot");
const pw = s.aggregateBallots([{ ranked: ["d", "k", "g"] }, { ranked: ["k", "g"] }]);
eq([pw.d.quality, pw.k.quality, pw.g.quality], [5, 3, 1], "pairwise: a ballot that left a family out only counts for its pairs");
eq(Math.round(s.lengthSlope([[{ ranked: ["l", "m", "s"] }]], { s: 1, m: Math.exp(1), l: Math.exp(2) }) * 1000) / 1000, 0.333, "the length-control slope (per question group)");
eq(s.qualityJudgeStamp(["a", "b"]), "v2:2xK", "the bucket stamp");
eq(s.panelWarnings(s.DEFAULT_JUDGE_PANEL, ["qwen3.6-27b", "deepseek-flash", "kimi-k3"]).length, 1, "the pre-flight names an unrankable pair");
// the bench end-of-run hint names the same panel (scripts/e2e/model-bench.py BENCH_JUDGE_PANEL is the twin)
const py = require("fs").readFileSync("../e2e/model-bench.py", "utf8").match(/^BENCH_JUDGE_PANEL = "?\x27?([^\x27"]+)/m);
eq(py && py[1], s.DEFAULT_JUDGE_PANEL.join(","), "model-bench.py BENCH_JUDGE_PANEL == DEFAULT_JUDGE_PANEL");
console.log("model-bench-ingest.test.sh: ok");
'
