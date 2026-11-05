#!/usr/bin/env bash
# 2026-10-12 credential rotation: pin the model-provider key plumbing to the
# coding box. Box C's worker .env is never rewritten from GitHub secrets
# (rsync excludes it), so a provider key reaches the worker ONLY through
# deploy.yml's curated env-secrets heredoc (SECEOF). Before this pin the
# MOONSHOT / DEEPSEEK / ZAI / DASHSCOPE keys were missing from that list and a
# rotated secret never reached coding sessions or supervisor wakes on C.
# Checks: (1) web .env template carries each key from secrets, (2) the SECEOF
# heredoc carries each key, (3) compose forwards each key to backend + worker.
set -u
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WF="$HERE/../../.github/workflows/deploy.yml"
APP="$HERE/../../docker-compose.app.yml"
KEYS="MOONSHOT_API_KEY DEEPSEEK_API_KEY ZAI_API_KEY DASHSCOPE_API_KEY TYPESAFE_API_KEY"
fails=0
# Incident 2026-10-12: rotated secrets the coding box must receive from GitHub (SECEOF only).
SECEOF_ONLY="JWT_SECRET JWT_REFRESH_SECRET MCP_DIGBY_TOKEN CODING_EGRESS_SECRET BRIGHTDATA_API_TOKEN OPENAI_API_KEY XAI_GROK_API_KEY GOOGLE_GEMINI_API_KEY COHERE_API_KEY"

# (0) PARITY: every secret the web .env template writes from GitHub secrets that the
# WORKER service reads must also ride the coding-box SECEOF list — otherwise a
# rotated secret (JWT_SECRET, MCP_DIGBY_TOKEN, an encryption key …) never reaches C.
parity=$(python3 - "$WF" "$APP" <<'PY'
import re,sys
d=open(sys.argv[1]).read(); c=open(sys.argv[2]).read()
w=c[c.index('\n  worker:'):c.index('\n  frontend:')]
worker=set(re.findall(r'^\s*- ([A-Z0-9_]+)=', w, re.M))
i=d.index("cat > /opt/crossmodel/.env << 'ENVEOF'"); j=d.index('ENVEOF',i+40)
tmpl=[n for n in re.findall(r'^\s*([A-Z0-9_]+)=\$\{\{ secrets\.', d[i:j], re.M) if n in worker]
k=d.index("<< 'SECEOF'"); l=d.index('\n          SECEOF',k)
sec=set(re.findall(r'^\s*([A-Z0-9_]+)=', d[k:l], re.M))
print(' '.join(n for n in tmpl if n not in sec))
PY
)
if [ -z "$parity" ]; then echo "ok - every worker-read secret in the web template rides the coding-box SECEOF"; else echo "FAIL - worker-read secrets missing from the coding-box SECEOF: $parity"; fails=$((fails+1)); fi
dupes=$(sed -n "/<< 'SECEOF'/,/^          SECEOF$/p" "$WF" | grep -oE '^ +[A-Z0-9_]+=' | tr -d ' =' | sort | uniq -d | tr '\n' ' ')
if [ -z "$dupes" ]; then echo "ok - no key appears twice in the coding-box SECEOF"; else echo "FAIL - duplicate keys in the coding-box SECEOF: $dupes"; fails=$((fails+1)); fi

[ -f "$WF" ] || { echo "FAIL - deploy.yml not found at $WF"; exit 1; }

for k in $KEYS; do
  if grep -qF -- "$k=\${{ secrets.$k }}" "$WF"; then echo "ok - web .env template has $k"; else echo "FAIL - web .env template missing $k"; fails=$((fails+1)); fi
done

seceof_start=$(grep -n "<< 'SECEOF'" "$WF" | head -1 | cut -d: -f1)
seceof_end=$(grep -n "^          SECEOF$" "$WF" | head -1 | cut -d: -f1)
if [ -n "$seceof_start" ] && [ -n "$seceof_end" ] && [ "$seceof_end" -gt "$seceof_start" ]; then
  block=$(sed -n "${seceof_start},${seceof_end}p" "$WF")
  for k in $KEYS; do
    if printf '%s' "$block" | grep -q "^ *$k=\${{ secrets.$k }}$"; then echo "ok - coding-box SECEOF has $k"; else echo "FAIL - coding-box SECEOF missing $k"; fails=$((fails+1)); fi
  done
  for k in $SECEOF_ONLY; do
    if printf '%s' "$block" | grep -q "^ *$k=\${{ secrets.$k }}$"; then echo "ok - coding-box SECEOF has $k"; else echo "FAIL - coding-box SECEOF missing $k"; fails=$((fails+1)); fi
  done
else
  echo "FAIL - could not locate the SECEOF heredoc in deploy.yml"
  fails=$((fails+1))
fi

for k in $KEYS; do
  n=$(grep -c "^ *- $k=" "$APP" || true)
  if [ "$n" -ge 2 ]; then echo "ok - compose forwards $k to $n service(s)"; else echo "FAIL - expected ≥2 $k pass-throughs in app.yml, found $n"; fails=$((fails+1)); fi
done

[ "$fails" -eq 0 ] && { echo "=== model-keys-env-secrets: all checks passed ==="; exit 0; }
echo "=== model-keys-env-secrets: $fails check(s) FAILED ==="
exit 1
