# CrossModel — Deployment Guide

> ⚠️ STALE (2026-08-14): example-local-host-era deploy doc — live path is .github/workflows/deploy.yml + deploy-blue-green.sh (see AGENTS.md); kept for history.


## Infrastructure

| Component | Details |
|-----------|---------|
| Server | `example-local-host` (192.0.2.10, user: `paul`) |
| Project path | `/home/paul/crossmodel` |
| SSH key | `/Users/example/.ssh/ubuntu_server` |
| Reverse proxy | Caddy (local LAN) |
| Containers | Docker Compose (prod file only) |

## Production URLs

| Service | URL | Port |
|---------|-----|------|
| Frontend | `http://example-local.test` | 8247 |
| Frontend (IP) | `http://100.64.0.1:8247` | 8247 |
| Backend API | `http://100.64.0.1:4000/api` | 4000 |
| DB Admin | `http://crossmodeldb.cozz` | 9521 |

---

## Deploy Commands

### Full Deploy (code change)

```bash
# On local machine — push changes
git add -A
git commit -m "feat/fix: <description>"
git push origin main

# On server — pull and rebuild
ssh -i /Users/example/.ssh/ubuntu_server paul@example-local-host \
  "cd /home/paul/crossmodel && git pull origin main && \
   docker compose -f docker-compose.prod.yml up -d --build backend frontend"

# Verify
ssh -i /Users/example/.ssh/ubuntu_server paul@example-local-host \
  "docker logs admin-backend-prod --tail 10"
```

### Backend Only (most common)

```bash
ssh -i /Users/example/.ssh/ubuntu_server paul@example-local-host \
  "cd /home/paul/crossmodel && git pull origin main && \
   docker compose -f docker-compose.prod.yml build backend && \
   docker compose -f docker-compose.prod.yml up -d backend"
```

### Database Migration

```bash
ssh -i /Users/example/.ssh/ubuntu_server paul@example-local-host \
  "cd /home/paul/crossmodel && \
   docker exec admin-backend-prod npx prisma migrate deploy"
```

---

## Container Management

```bash
# Check status
docker ps --filter 'name=admin-' --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}'

# View logs
docker logs admin-backend-prod --tail 50
docker logs admin-frontend-prod --tail 50
docker logs admin-backend-prod -f  # follow

# Restart a container
docker restart admin-backend-prod

# Shell into container
docker exec -it admin-backend-prod sh
```

---

## Production Container Names

All containers end in `-prod`:
- `admin-frontend-prod`
- `admin-backend-prod`
- `admin-postgres-prod`
- `admin-redis-prod`
- `admin-adminer-prod`

---

## Persistent Volumes

- `crossmodel_postgres_data` — all chat, user, project, document data
- `crossmodel_redis_data` — anonymous sessions (24h TTL per session)

**NEVER delete these volumes without explicit user confirmation.**

---

## Environment File

Production env is set in `docker-compose.prod.yml` (not in `.env`). The `.env` file is for local development only.

Required env vars:
```env
NODE_ENV=production
PORT=4000
DATABASE_URL=postgresql://...
REDIS_URL=redis://...
JWT_SECRET=<min 32 chars>
JWT_REFRESH_SECRET=<min 32 chars>
OPENAI_API_KEY=sk-proj-...
XAI_GROK_API_KEY=xai-...
GOOGLE_GEMINI_API_KEY=AIza...
FIREWORKS_API_KEY=fw_...
MCP_DIGBY_TOKEN=...
COHERE_API_KEY=...
FRONTEND_URL=http://example-local.test,http://100.64.0.1:8247,http://localhost:8247
```

---

## Caddy Proxy Configuration

```
http://example-local.test {
    reverse_proxy localhost:8247
}

http://crossmodeldb.cozz {
    reverse_proxy localhost:9521
}
```

---

## Fresh Deploy (first time)

```bash
cd /home/paul/crossmodel

# 1. Configure environment
cp .env.example .env
# Edit .env with all API keys

# 2. Build and start
docker compose -f docker-compose.prod.yml build
docker compose -f docker-compose.prod.yml up -d

# 3. Apply migrations
docker exec admin-backend-prod npx prisma migrate deploy

# 4. Seed (optional — creates test users)
docker exec admin-backend-prod npx tsx prisma/seed.ts
```

---

## Session Sync Workflow (Run at Start of Every Session)

```bash
# 1. Check server git status
ssh -i /Users/example/.ssh/ubuntu_server paul@example-local-host \
  "cd /home/paul/crossmodel && git status && git log --oneline -3"

# 2. Fetch remote and check differences
cd /Users/example/Development/crossmodel
git fetch origin
git log --oneline origin/main -3

# 3. If server has uncommitted changes, commit first
ssh -i /Users/example/.ssh/ubuntu_server paul@example-local-host \
  "cd /home/paul/crossmodel && git add -A && \
   git commit -m 'chore: sync server changes' && git push origin main"

# 4. Pull latest locally
git pull origin main

# 5. Pull latest to server
ssh -i /Users/example/.ssh/ubuntu_server paul@example-local-host \
  "cd /home/paul/crossmodel && git pull origin main"
```

---

## Troubleshooting

### Backend won't start
```bash
docker logs admin-backend-prod --tail 50
# Common causes: missing env var, DB connection failed, Prisma schema mismatch
```

### DB schema out of sync
```bash
docker exec admin-backend-prod npx prisma migrate deploy
```

### Port already in use
```bash
docker ps  # check what's running
docker restart admin-backend-prod
```

### CORS errors in browser
Ensure `FRONTEND_URL` in `docker-compose.prod.yml` includes your domain (comma-separated).

### Frontend TypeScript error at startup
The production Dockerfile must copy TypeScript from the build stage:
```dockerfile
COPY --from=build /app/node_modules/typescript ./node_modules/typescript
```

### Grok 500 error
Transient xAI infrastructure issue. Retry the query — it's expected behavior.

### Gemini timeout
`gemini-3-pro-preview` in thinking + web mode can take 90-120s. This is expected.
