# runtime-skip-set.awk — the ONE definition of "does this path touch the
# runtime?" (ticket a4309ef9, 2026-10-16). Consumed by BOTH
# scripts/deploy/deploy-path-filter.sh (the push's own incremental diff) and
# scripts/deploy/deploy-strand-probe.sh (the last-deployed..HEAD catch-up
# range): same skip set, same deny-by-default, zero drift. Before this file
# the set lived inline in the filter alone — fine while it had one caller,
# a silent divergence class once two scripts had to agree.
#
# INPUT:  one changed path per line (git diff-tree / compare API
#         .files[].filename shapes — both are newline-separated path lists).
# OUTPUT: every input path that touches the RUNTIME (skip-set members print
#         nothing). A path matching NO rule prints = runtime: deny by
#         default, the fail-safe direction of deploy-path-filter.sh (a
#         wrongly-skipped deploy strands main; a redundant deploy never
#         does).
#
# THE SKIP SET (todo 03bdbf26, unchanged in substance):
#   .digby/**, docs/**, memory-bank/**, *.md anywhere, test files
#   (*.test.* / *.spec.* / backend/tests/**). Everything else is runtime.
#   ONE EXCEPTION: frontend/content/help/** counts as RUNTIME (served
#   content — see the carve-out comment inside the rule block).
#
# awk-not-bash reasons: the caller streams an arbitrarily long diff listing
# through it (300-file compare pages) without a read loop per line, and the
# patterns are regexes against $0 — awk's home ground.
#
# (`next`, never `continue`: awk's main block is NOT a loop — gawk FATALS on
# `continue` outside a loop, which killed the first cut of the path filter
# with EVERY push classified docs-only. The callers' rc check makes any awk
# death fail OPEN toward deploy instead of silently skipping.)
{
  path = $0
  # docs-ish trees
  if (path ~ /^\.digby\//) next
  if (path ~ /^docs\//) next
  if (path ~ /^memory-bank\//) next
  # SERVED CONTENT carve-out (F31 shortfall, 2026-10-21): frontend/content/help/**
  # is read from the runtime image at request time by frontend/lib/help-docs.ts
  # (the Dockerfile COPYs content/ into the image; the .md files are committed
  # build artifacts synced from docs/ by scripts/sync-help-docs.mjs) — runtime
  # despite the .md extension. Must run BEFORE the /\.md$/ rule or it never fires.
  if (path ~ /^frontend\/content\/help\//) { print path; next }
  # *.md anywhere (README.md, backend/foo.md, plans/bar.md …)
  if (path ~ /\.md$/) next
  # test files: *.test.ts / .test.tsx / .test.sh / .spec.ts anywhere,
  # plus the backend jest tree (tests/** under backend/).
  if (path ~ /\.test\.(ts|tsx|sh|js|mjs)$/) next
  if (path ~ /\.spec\.(ts|tsx|js|mjs)$/) next
  if (path ~ /^backend\/tests\//) next
  # everything else touches the runtime
  print path
}
