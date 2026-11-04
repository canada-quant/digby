-- Digby Edge (Phase 2): admin-managed custom model endpoint registry — point a
-- Digby instance (esp. self-hosted) at any OpenAI-compatible model server
-- (Ollama, vLLM, LM Studio, OpenRouter, llama.cpp). A coding/chat model is
-- addressed as `<label>:<modelId>`; apiKeyEnc is AES-256-GCM at rest and never
-- returned by any API response. ownerUserId NULL = instance-wide (the only
-- kind the v1 UI creates); the column + FK exist for future per-user endpoints.

-- CreateTable
CREATE TABLE "model_endpoints" (
    "id" TEXT NOT NULL,
    "ownerUserId" TEXT,
    "label" TEXT NOT NULL,
    "providerShape" TEXT NOT NULL,
    "baseUrl" TEXT NOT NULL,
    "apiKeyEnc" TEXT,
    "models" JSONB NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "model_endpoints_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "model_endpoints_enabled_idx" ON "model_endpoints"("enabled");

-- AddForeignKey
ALTER TABLE "model_endpoints" ADD CONSTRAINT "model_endpoints_ownerUserId_fkey" FOREIGN KEY ("ownerUserId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
