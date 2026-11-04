# Prebuilt dev-container image (`CODING_DEV_IMAGE`)

Optional prebuilt image for the shared tailnet dev container
(`dev-container.service.ts`). It bakes in tailscale, `netcat-openbsd`, the
`tssh`/`tcurl` helpers, and the `gh` CLI so first boot skips the `curl | sh`
tailscale install and the netcat apt round-trip — the boot script's
`command -v` guards detect them and go straight to starting tailscaled. The
baked `gh` (ticket ad7a1c3c) also makes the backend's runtime gh provisioning
(`container.service.ts` `ensureGhCli`, which docker-cp's a pinned,
sha256-verified gh into ready containers that lack one) a no-op on this image.

**Building/pushing is a manual ops step — deliberately not wired into CI.**
Rebuild occasionally to pick up tailscale updates.

## Build

```bash
docker build -t digby-dev:latest docker/dev-image
```

## Push — pick one

**Option A — GHCR:**

```bash
docker tag digby-dev:latest ghcr.io/canada-quant/digby-dev:latest
docker push ghcr.io/canada-quant/digby-dev:latest
# CODING_DEV_IMAGE=ghcr.io/canada-quant/digby-dev:latest
```

**Option B — EC2-local tag (no registry):** build directly on box A of the
two-box ca-central-1 prod fleet (A `203.0.113.10` stateful + B `203.0.113.11`
stateless behind the ALB) — A is where the worker and dev containers run, so
the image lands in the docker cache that actually uses it:

```bash
ssh ubuntu@203.0.113.10
sudo docker build -t digby-dev:local /opt/crossmodel/docker/dev-image
# CODING_DEV_IMAGE=digby-dev:local
```

## Enable

Set the env var on the backend (falls back to `CODING_RUNNER_IMAGE`, then
`node:20`, when unset):

```env
CODING_DEV_IMAGE=digby-dev:local
```

Existing dev containers keep their old image until recreated — use the
**Restart** button in Settings → Coding → Dev container (or wait for the next
reap/ensure cycle) to pick it up.
