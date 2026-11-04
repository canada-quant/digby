-- Migration: Add Projects, RAG (pgvector), and Chat Sharing
-- Phase 1 of CrossModel Projects feature

-- Enable pgvector extension for vector similarity search
CREATE EXTENSION IF NOT EXISTS vector;

-- Add projectId to crossmodel_chats
ALTER TABLE "crossmodel_chats" ADD COLUMN "projectId" TEXT;

-- CreateTable: crossmodel_projects
CREATE TABLE "crossmodel_projects" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "systemPrompt" TEXT,
    "emoji" TEXT,
    "color" TEXT,
    "isPublic" BOOLEAN NOT NULL DEFAULT false,
    "shareToken" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "crossmodel_projects_pkey" PRIMARY KEY ("id")
);

-- CreateTable: project_members
CREATE TABLE "project_members" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'viewer',
    "addedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "project_members_pkey" PRIMARY KEY ("id")
);

-- CreateTable: project_documents
CREATE TABLE "project_documents" (
    "id" TEXT NOT NULL,
    "projectId" TEXT,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "sourceUrl" TEXT,
    "charCount" INTEGER NOT NULL DEFAULT 0,
    "chunkCount" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'processing',
    "errorMsg" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "project_documents_pkey" PRIMARY KEY ("id")
);

-- CreateTable: project_chunks (with pgvector embedding column)
CREATE TABLE "project_chunks" (
    "id" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "projectId" TEXT,
    "userId" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "embedding" vector(1536) NOT NULL,
    "chunkIndex" INTEGER NOT NULL,
    "tokenCount" INTEGER NOT NULL DEFAULT 0,
    "metadata" JSONB,

    CONSTRAINT "project_chunks_pkey" PRIMARY KEY ("id")
);

-- CreateTable: chat_share_links
CREATE TABLE "chat_share_links" (
    "id" TEXT NOT NULL,
    "chatId" TEXT NOT NULL,
    "shareToken" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "expiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "chat_share_links_pkey" PRIMARY KEY ("id")
);

-- CreateIndex: unique constraints
CREATE UNIQUE INDEX "crossmodel_projects_shareToken_key" ON "crossmodel_projects"("shareToken");
CREATE UNIQUE INDEX "project_members_projectId_userId_key" ON "project_members"("projectId", "userId");
CREATE UNIQUE INDEX "chat_share_links_chatId_key" ON "chat_share_links"("chatId");
CREATE UNIQUE INDEX "chat_share_links_shareToken_key" ON "chat_share_links"("shareToken");

-- CreateIndex: performance indexes
CREATE INDEX "crossmodel_projects_userId_idx" ON "crossmodel_projects"("userId");
CREATE INDEX "project_members_projectId_idx" ON "project_members"("projectId");
CREATE INDEX "project_members_userId_idx" ON "project_members"("userId");
CREATE INDEX "project_documents_userId_idx" ON "project_documents"("userId");
CREATE INDEX "project_documents_projectId_idx" ON "project_documents"("projectId");
CREATE INDEX "project_chunks_projectId_idx" ON "project_chunks"("projectId");
CREATE INDEX "project_chunks_userId_idx" ON "project_chunks"("userId");
CREATE INDEX "project_chunks_documentId_idx" ON "project_chunks"("documentId");
CREATE INDEX "crossmodel_chats_projectId_idx" ON "crossmodel_chats"("projectId");

-- GIN index for full-text search on chunk content (BM25-like hybrid search)
CREATE INDEX "project_chunks_content_fts_idx" ON "project_chunks" USING GIN (to_tsvector('english', "content"));

-- HNSW index for fast approximate nearest neighbor vector search
CREATE INDEX "project_chunks_embedding_idx" ON "project_chunks" USING hnsw ("embedding" vector_cosine_ops);

-- AddForeignKey constraints
ALTER TABLE "crossmodel_chats" ADD CONSTRAINT "crossmodel_chats_projectId_fkey"
    FOREIGN KEY ("projectId") REFERENCES "crossmodel_projects"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "crossmodel_projects" ADD CONSTRAINT "crossmodel_projects_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "project_members" ADD CONSTRAINT "project_members_projectId_fkey"
    FOREIGN KEY ("projectId") REFERENCES "crossmodel_projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "project_members" ADD CONSTRAINT "project_members_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "project_documents" ADD CONSTRAINT "project_documents_projectId_fkey"
    FOREIGN KEY ("projectId") REFERENCES "crossmodel_projects"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "project_documents" ADD CONSTRAINT "project_documents_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "project_chunks" ADD CONSTRAINT "project_chunks_documentId_fkey"
    FOREIGN KEY ("documentId") REFERENCES "project_documents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "chat_share_links" ADD CONSTRAINT "chat_share_links_chatId_fkey"
    FOREIGN KEY ("chatId") REFERENCES "crossmodel_chats"("id") ON DELETE CASCADE ON UPDATE CASCADE;
