# Asking bigger — altitude, depth, and range

The difference between a useful answer and a game-changing one is usually the ask,
not the model. A recent essay — *"How to be more ambitious: A tutorial for
humans with models"* (published 13 October 2026) — names four kinds of ambition a
prompt can carry: **speed**, **altitude**, **depth**, and **range**. Three of them
cost you one sentence in your own words, and Digby has a native lever for each.
This page translates them into Digby's vocabulary.

## Altitude — ask for the outcome above the task

The task you type is usually a proxy for an outcome one level up. "Fix the flaky
deploy test" really means "I want deploys I don't have to watch." Ask for the
outcome and you can get the outcome — including the mechanism that keeps it true
after the chat is over.

**Before:** "Fix the flaky test in the deploy pipeline."

**After:** "Start a coding session that keeps the deploy pipeline healthy — fix
the flaky test, and leave behind whatever standing check would catch this class
of failure on its own."

Digby's standing levers, for outcomes you want to persist rather than babysit:

- A **coding session** can leave behind the guardrail itself — a test, a monitor,
  a script — not just the one-off fix.
- A **schedule** turns a one-off task into a standing outcome: "check the
  production logs every morning and tell me what changed" keeps working while you
  do something else.

One rule keeps this honest: Digby delivers what you actually asked for — it will
not silently swap in a "bigger" outcome instead of the artifact you requested.
Altitude is a lever you hold: when the bigger outcome is what you want, ask for
it in the open.

## Depth — ask for the field's instruments, not its vocabulary

The best people in a field don't summarize — they compute, check primary sources,
and use the field's actual instruments. A question that asks what experts "think"
gets you vocabulary; a question that hands over the raw material and asks for the
work gets you the work.

**Before:** "What's happening to our retention?"

**After:** "Here's the raw export (attached). Compute monthly cohort retention
yourself, show me the table, and challenge the assumption that the dip is
seasonal — from the data, not from commentary about the data."

Two Digby levers do this from the answer side:

- **Point at raw material, not your summary of it.** Attach the file, paste the
  log, give the URL. Digby can read and compute; a pre-digested summary throws
  that ability away.
- **Dig deeper** — the one control under every answer — buys the next rung of
  scrutiny: a second model verifying the answer you have, then a research council
  that works the question independently. See
  [How deep Digby thinks](./DEPTH_AND_DIG_DEEPER.md).

## Range — bring in the checks another field would run

Every field has habits, and its blind spots live exactly where its habits are.
The standard checks of a *different* field catch what yours misses — a forensic
accountant reads a partnership agreement differently than a lawyer does.

**Before:** "Review this partnership agreement."

**After:** "Review this partnership agreement, then run the checks a forensic
accountant would run on it — where would this look fine but hide an obligation?"

The caveat the essay insists on: **borrow the checks, not the costume.** Don't
ask the model to *be* a short seller or to *write like* a forensic accountant —
ask it to *do what* one does: the named checks, the instruments, the skepticism.
A persona gets you vocabulary; a function gets you work.

## Speed needs no technique

The essay counts speed — same work, less time — as bread and butter, and Digby
agrees: answers stream first and a second model checks behind them (the one
exception, a short hold on high-stakes contestable questions, is described in
[How deep Digby thinks](./DEPTH_AND_DIG_DEEPER.md)). There is nothing extra to
ask for. Spend your one sentence of ambition on altitude, depth, or range.

## The one meta-prompt

Adapted from the essay: when a task matters, spend one turn upgrading the ask
before you send it. Paste this together with your draft:

> Before I send this, turn it into a deeper version of the task — not a bigger
> one. Tell me: what would a top professional in this field actually do with it?
> What is the rawest material to start from — files, logs, URLs, not my summary
> of them? Which specific methods would they use? What would show the result is
> right — other than you or me? Then show me the rewritten ask and wait for my
> go-ahead.

It works in any Digby surface — a chat, the first message of a coding session, a
research question — and it costs one turn. The rewritten ask is still yours to
edit; the point is seeing the gap between what you typed and what you actually
want.

---

*The framing on this page is adapted from "How to be more ambitious: A tutorial
for humans with models" (published 13 October 2026).*
