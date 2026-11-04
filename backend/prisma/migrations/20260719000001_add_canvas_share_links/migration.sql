-- Public share links for canvas artifacts (served straight from this table
-- through the backend — one service for all chats, no per-project containers).
CREATE TABLE "canvas_share_links" (
    "id" TEXT NOT NULL,
    "canvasId" TEXT NOT NULL,
    "shareToken" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "canvas_share_links_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "canvas_share_links_canvasId_key" ON "canvas_share_links"("canvasId");
CREATE UNIQUE INDEX "canvas_share_links_shareToken_key" ON "canvas_share_links"("shareToken");

ALTER TABLE "canvas_share_links" ADD CONSTRAINT "canvas_share_links_canvasId_fkey"
  FOREIGN KEY ("canvasId") REFERENCES "canvas_documents"("id") ON DELETE CASCADE ON UPDATE CASCADE;
