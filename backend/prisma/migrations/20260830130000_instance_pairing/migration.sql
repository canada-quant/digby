-- Digby Edge (Phase 3): cloud↔edge instance pairing over an OUTBOUND WebSocket
-- tunnel. One schema, both roles: an instance is "cloud" when it has
-- connected_instances rows (edges paired TO it) and "edge" when it has a
-- cloud_link row (it is paired TO a cloud). The edge dials OUT to the cloud's
-- relay over WSS — no inbound connectivity to the edge is ever needed. The
-- cloud stores NO edge data; it proxies requests through the tunnel to the
-- edge's own REST API.
--   connected_instances: cloud side. tokenHash = sha256 of the `dgi_` tunnel
--     token (plaintext shown once at pair/complete). The relay re-checks
--     `status` on every client ping so a revoke kills the live tunnel.
--   cloud_link: edge side, singleton (one row max, enforced in the service).
--     tokenEnc = the `dgi_` token AES-256-GCM at rest (the edge must PRESENT
--     the token), never returned by any API response.

-- CreateTable
CREATE TABLE "connected_instances" (
    "id" TEXT NOT NULL,
    "ownerUserId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "protocolVersion" INTEGER NOT NULL DEFAULT 1,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "lastSeenAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "connected_instances_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cloud_link" (
    "id" TEXT NOT NULL,
    "cloudUrl" TEXT NOT NULL,
    "tokenEnc" TEXT NOT NULL,
    "instanceName" TEXT NOT NULL,
    "pairedByUserId" TEXT NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'linked',
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "cloud_link_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "connected_instances_tokenHash_key" ON "connected_instances"("tokenHash");

-- CreateIndex
CREATE INDEX "connected_instances_ownerUserId_idx" ON "connected_instances"("ownerUserId");

-- AddForeignKey
ALTER TABLE "connected_instances" ADD CONSTRAINT "connected_instances_ownerUserId_fkey" FOREIGN KEY ("ownerUserId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cloud_link" ADD CONSTRAINT "cloud_link_pairedByUserId_fkey" FOREIGN KEY ("pairedByUserId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
