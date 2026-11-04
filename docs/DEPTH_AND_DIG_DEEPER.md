# How deep Digby thinks — and "Dig deeper"

Digby no longer asks you to pick a "level" before you send. Every question
starts as the fastest shape that can answer well, a second model checks the
answer behind it, and one control under each answer — **Dig deeper** — buys
more when you want it. This page explains what you see and what each part
means.

## What happens when you send a message

1. **The answer streams right away.** Digby (the lead model) starts on your
   question immediately — it can search the web, read your files and use your
   integrations as it goes. Nothing waits for a second model first.
2. **A second opinion runs behind it.** For most questions the Double Checker
   (a different model with its own web search) works the same question in
   parallel. It never blocks the first answer.
3. **A small pill under the answer tells you where the check is.**

| Pill | Meaning |
|---|---|
| **Checking…** | The second opinion is still running. You can read and reply meanwhile. |
| **Checked ✓** | The second opinion agrees — nothing material changed. |
| **Updated · what changed** | The check found a material difference (a number, a date, a name, a recommendation, a negation). The answer was corrected; the pill shows how many corrections and expands to the previous and revised text side by side. |
| **Check didn't finish** | The check was interrupted (for example a deploy or a timeout). The pill offers **Dig deeper to retry**. |

If you have already moved on to a newer message when a correction lands,
Digby posts it as a short addendum under your newer turn instead of rewriting
an answer you have scrolled past.

Only harness-measured facts drive the pill and the short status line above
the answer ("Checking the web", "Answering now — a second opinion is on its
way"). Neither is model prose — they come from fixed text keyed on what
actually ran.

## "This one matters — double-checking"

When a question is confidently judged both high-stakes (money, health, legal,
irreversible) **and** contestable, Digby waits briefly — at most 90 seconds —
for the second opinion before showing the first answer, and says so ("This
one matters — double-checking before answering"). This is the one case where
the answer is held back. Everything else streams first.

## Dig deeper

Under every answer there is exactly one control: **Dig deeper**. It runs the
next rung that has not yet been spent on that answer:

- **After a quick answer** → a full second-opinion verification of that
  answer (what used to be "Level 2 — Ensemble"). Takes a couple of minutes.
- **After a verified answer** → a research council: two colleague models
  research the question independently and Digby synthesises their findings
  (what used to be "Level 3 — Deep Research").

A council takes a while, and it has no time limit: it runs for as long as the
research needs and stops only if a model stops responding. Digby says so before it
starts ("as long as it needs — I'll post it here when it's ready"), keeps working on
this turn — you can navigate away or close the tab — and posts the result as a
**new** message titled "Deeper findings" — never as a rewrite of the answer you
already have. If you have connected Telegram (Account → Integrations), Digby
also sends you a note when the findings are ready.

Each answer can spend at most one verification and one council. Research
councils count against the daily deep-research allowance shown in your
account; when it is used up, Dig deeper says so plainly instead of starting a
council.

When a message clearly asks for research ("research this thoroughly and get
back to me") Digby notes it, but it does not start a council on its own — the
council is always yours to ask for with **Dig deeper** (an administrator can
opt the automatic start in once a launcher exists). When the daily allowance is
used up, Dig deeper says so plainly instead of starting one.

## Signed-out visitors

Without an account Digby answers with the standard two-model shape and waits
for the second opinion before answering (a bounded wait — up to about a minute
for a simple question, up to five for a deep one), but it cannot send you a
late correction or a background council (there is no chat to post it to).
Instead of **Dig deeper** you will see **Sign in for a deeper look**.

## Depth settings

There is no depth setting. Digby picks the shape per message (the compute
policy above), and **Dig deeper** under any answer takes it further —
that is the only depth control. The old **Account → Advanced** tab —
itself nothing but one read-only line since roster 2026-10-06 —
was removed outright on 27 October 2026 (ticket c99b404a).

The API still accepts every mode alias (stored rows, mobile, REST, schedules),
and an administrator can set a Digby to route every message on Auto
regardless (Admin → Settings → "Depth policy", the `patience_auto_only`
switch — production has run this way since 26 September 2026). That switch is
admin-only; a person's own questions are never bounded by it, and "Dig deeper"
under an answer keeps working either way.

## No spending bound per answer

There is no per-answer cost budget (since 2026-09-27). A check or a council is
never declined, cut short or refused because of what it would cost, and "Dig
deeper" always runs the next rung. The only cost cap anywhere in Digby is one a
project owner sets on a project (Project settings → "Spend cap per day"), and
that cap governs scheduled machine runs in the project — never a person's own
question. The former operator bound (`DEPTH_BUDGET_MAX_USD`, $0.25 per answer)
is gone; the time bound on a deeper council still applies.

## For operators

The mechanism behind this page is the **compute policy**: a calibrated
decision model (the Decision gate seat) answers four typed questions about
each message — depth, stakes, need for live web, research request — at send
time, one more when both drafts are in (do the drafts agree?) and one when a
revision lands (was the change material?). Every question ships in **shadow**
first: the policy behaves exactly like the presets until an administrator
flips a purpose to **act** in Account → Admin → Endpoints → Model roles →
Decision gate (purposes **Compute policy**, **Drafts agree**, **Revision
material**), and only after the readiness report marks it ready. Kill
switches (`COMPUTE_POLICY_DISABLED`, `ANSWER_FIRST_DISABLED`,
`DIG_DEEPER_DISABLED`, `DEPTH_BUDGET_DISABLED`,
`RESEARCH_REQUEST_AUTOSTART_DISABLED`, `UX_BEACON_DISABLED` on the server;
`DEPTH_BUDGET_RESEARCH_RUNG_DISABLED` was removed 2026-10-30 — the rung
rail is always on)
each restore the previous behaviour on their own; see
`.env.example`. (The former frontend build-time switch
`NEXT_PUBLIC_DEPTH_UX_DISABLED` is retired with the picker — it was never
forwarded into the frontend build and its picker paths are deleted.)
