# Digby Edge — end-to-end testing guide (Phases 3–5)

How to exercise the full cloud↔edge loop: pairing, presence, proxied browsing,
SSE streaming through the tunnel, and cloud→edge messages. No production deploy
required — both sides run the same codebase.

> Prereq: migrations applied (the selfhost `migrate` one-shot does this
> automatically; dev checkouts: `cd backend && npx prisma migrate deploy`).

## Topology A — local server as CLOUD + Mac/dev checkout as EDGE (easiest)

One selfhost stack on your server plays the "cloud" role (it has the relay);
a plain dev checkout on any other machine plays the "edge" (its backend runs
the tunnel client once paired).

### 1. Bring up the CLOUD (server)

```bash
cp selfhost.env.example .env   # set JWT secrets + one model key
docker compose -f docker-compose.selfhost.yml up -d --build
```

Make your account ADMIN (needed for all instance/cloud-link endpoints):

```bash
docker exec digby-postgres psql -U admin -d admin_db \
  -c "UPDATE users SET role='ADMIN' WHERE email='you@example.com';"
```

Sanity: `curl http://localhost:4000/health` (backend) and
`curl http://127.0.0.1:4100/health` (relay) both return ok.

### 2. Mint a pairing code on the CLOUD

```bash
CLOUD=http://<server>:8080   # the cloud's public URL (Caddy)
TOKEN=$(curl -s $CLOUD/api/auth/login -H 'content-type: application/json' \
  -d '{"email":"you@example.com","password":"…"}' | jq -r .data.accessToken)

curl -s $CLOUD/api/crossmodel/instances/pair/start \
  -H "Authorization: Bearer $TOKEN" -X POST | jq
# → { "success": true, "data": { "code": "…", "expiresAt": "…" } }   (10 min, single use)
```

### 3. Bring up the EDGE (any machine, dev checkout)

```bash
cd backend && npm run dev     # needs its own Postgres + Redis (docker-compose.yml dev stack)
```

Register/login on the edge, make yourself ADMIN there too (same SQL against
the edge's DB), then pair:

```bash
EDGE=http://localhost:4000
ETOKEN=$(curl -s $EDGE/api/auth/login -H 'content-type: application/json' \
  -d '{"email":"edge@example.com","password":"…"}' | jq -r .data.accessToken)

curl -s $EDGE/api/crossmodel/cloud-link/pair \
  -H "Authorization: Bearer $ETOKEN" -H 'content-type: application/json' \
  -d "{\"cloudUrl\":\"$CLOUD\",\"pairingCode\":\"<code from step 2>\"}" | jq
```

The `cloudUrl` is forgiving: `digby.ai`, `DIGBY.AI`, `https://digby.ai/` all
normalize to the same thing; a genuinely invalid URL gets a clear 400.

Within a few seconds the edge backend logs the tunnel connect, and:

```bash
curl -s $EDGE/api/crossmodel/cloud-link -H "Authorization: Bearer $ETOKEN" | jq
# → state: "linked", connected: true
```

### 3b. ALTERNATIVE — device activation (the edge mints the code)

Netflix/YouTube-TV style: the person at the edge never types a URL into the
cloud. Skip step 2; on the EDGE:

```bash
curl -s $EDGE/api/crossmodel/cloud-link/code/start \
  -H "Authorization: Bearer $ETOKEN" -H 'content-type: application/json' \
  -d "{\"cloudUrl\":\"$CLOUD\"}" | jq
# → { "success": true, "data": { "code": "WXYZ-6789", "expiresAt": "…" } }  (10 min, single use)
```

The edge's tunnel client now dials the cloud's relay every ~3s with
`Authorization: Bearer dgp_<code>` (a `state: "pending"` link row appears in
`GET /cloud-link`). On the CLOUD, redeem it (within 10 minutes):

```bash
curl -s $CLOUD/api/crossmodel/instances/pair/redeem \
  -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"code":"WXYZ-6789"}' | jq
# → { "success": true, "data": { "pending": true, "expiresAt": "…" } }
```

No instance row exists yet — the row materializes when the edge's next dial
lands (the relay consumes the claim atomically, mints the row, and answers
with a `paired` frame carrying the real `dgi_` token; the edge stores it and
the SAME socket becomes the live tunnel). Ordering doesn't matter: redeem
before or after the edge starts dialing, the ~3s redial closes the race.
Within seconds, `GET $CLOUD/api/crossmodel/instances` shows the new instance
`online: true`, and the edge's `GET /cloud-link` flips to `state: "linked"`.
If the code lapses first, the edge goes `state: "error"` with lastError
`pairing code expired — generate a new one` (re-POST code/start).

### 4. Verify presence + proxy on the CLOUD

```bash
curl -s $CLOUD/api/crossmodel/instances -H "Authorization: Bearer $TOKEN" | jq
# → your edge, "online": true

# Browse the edge's chats THROUGH the tunnel:
curl -s "$CLOUD/api/crossmodel/instances/<instanceId>/proxy/crossmodel/chats" \
  -H "Authorization: Bearer $TOKEN" | jq

# Send a message into an edge chat (cloud→edge, UNTRUSTED machine framing):
curl -s "$CLOUD/api/crossmodel/instances/<instanceId>/chats/<edgeChatId>/messages" \
  -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"message":"hello from the cloud","sourceLabel":"curl test"}' | jq
# → { "delivery": "started" | "queued" | "steered" }
```

The message lands in the edge chat wrapped in the UNTRUSTED webhook frame
(origin `webhook`, never a user turn). SSE also proxies: opening
`$CLOUD/api/crossmodel/instances/<id>/proxy/crossmodel/chats/<chatId>/stream`
in a browser tab (auth cookie) streams live run events from the edge.

### 5. UI check

- CLOUD UI sidebar → **Connected instances** (ADMIN only): presence dot,
  expandable chat list, "Pair instance" dialog (the UI equivalent of step 2 —
  and its "Enter the code shown on the edge" tab is the UI equivalent of
  step 3b's redeem: the dialog waits, then the new instance appears). Each
  edge chat row has a delete (trash) affordance — DELETE rides the tunnel
  proxy to the edge's own `DELETE /api/crossmodel/chats/:id`; an offline edge
  shows an honest "NOT deleted" toast.
- EDGE UI → account settings → **Cloud link**: linked state, live connected
  dot, Unlink. Unlinked state leads with "Pair to a cloud" (the step 3b flow:
  cloud URL → code shown BIG + copy → live "waiting…" → flips to linked when
  the tunnel lands); the classic cloud-minted-code form stays below it.

### 6. Revocation + list hygiene

- Cloud-side `DELETE /api/crossmodel/instances/:id` revokes (the edge's tunnel
  is hard-closed on its next ping); edge-side Unlink also tells the cloud to
  revoke (`DELETE /instances/self` with the tunnel token).
- **Revoked rows no longer appear in `GET /instances`** — they vanish from the
  UI on the next poll; pass `?includeRevoked=1` to see them.

## Topology B — two servers

Same as above but both sides run `docker-compose.selfhost.yml` on separate
hosts. The edge stack's Caddy is irrelevant to the tunnel (it dials OUT to
`<cloudUrl>/api/crossmodel/instances/tunnel`); only the cloud needs a
reachable URL.

## Known limitations (by design, v1)

- **Two selfhost stacks on ONE host are not supported yet** — container names
  and the named coding volumes are fixed (`digby-*`), so a second `up` on the
  same host collides. Use two hosts, or Topology A (dev checkout as the edge).
- The proxied chat view posts messages as the edge's paired ADMIN (a real user
  turn on the edge). Machine/agent pushes use the `/messages` endpoint
  (UNTRUSTED framing, depth-capped at 3) or the `send_to_instance` platform
  tool (consequential: needs a user-turn confirmation or a `ChatAutonomy`
  grant that includes it).

## Troubleshooting

- `state: "error", lastError: "token rejected — re-pair"` on the edge → the
  cloud row was revoked/deleted; re-pair with a fresh code.
- `state: "pending"` on the edge → a device-activation code is waiting for
  the cloud to redeem it (10-min TTL; on expiry it flips to `state: "error"`,
  lastError `pairing code expired — generate a new one`).
- Proxy returns `502 instance offline` → edge tunnel down: check the edge
  backend logs for reconnect backoff, and that `<cloudUrl>` is reachable from
  the edge (`curl $CLOUD/api/health` from the edge machine).
- Pairing code `401` → codes are single-use and expire after 10 minutes.
