-- CreateTable
CREATE TABLE "chat_autonomy" (
    "chatId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "allowedTools" TEXT[],
    "scheduleCap" INTEGER NOT NULL DEFAULT 48,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "chat_autonomy_pkey" PRIMARY KEY ("chatId")
);

-- CreateTable
CREATE TABLE "event_hooks" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "sourceChatId" TEXT NOT NULL,
    "targetChatId" TEXT NOT NULL,
    "eventTypes" TEXT[],
    "promptTemplate" TEXT NOT NULL DEFAULT '',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "debounceSec" INTEGER NOT NULL DEFAULT 60,
    "lastFiredAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "event_hooks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "hook_events" (
    "id" TEXT NOT NULL,
    "hookId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "hook_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "project_goals" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "status" TEXT NOT NULL DEFAULT 'active',
    "blockedReason" TEXT,
    "createdByChatId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "project_goals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "project_todos" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "goalId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "blockedReason" TEXT,
    "assigneeChatId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "project_todos_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "goal_dependencies" (
    "goalId" TEXT NOT NULL,
    "dependsOnGoalId" TEXT NOT NULL,

    CONSTRAINT "goal_dependencies_pkey" PRIMARY KEY ("goalId","dependsOnGoalId")
);

-- CreateTable
CREATE TABLE "todo_dependencies" (
    "todoId" TEXT NOT NULL,
    "dependsOnTodoId" TEXT NOT NULL,

    CONSTRAINT "todo_dependencies_pkey" PRIMARY KEY ("todoId","dependsOnTodoId")
);

-- CreateIndex
CREATE INDEX "chat_autonomy_userId_idx" ON "chat_autonomy"("userId");

-- CreateIndex
CREATE INDEX "event_hooks_sourceChatId_enabled_idx" ON "event_hooks"("sourceChatId", "enabled");

-- CreateIndex
CREATE INDEX "event_hooks_userId_idx" ON "event_hooks"("userId");

-- CreateIndex
CREATE INDEX "hook_events_status_createdAt_idx" ON "hook_events"("status", "createdAt");

-- CreateIndex
CREATE INDEX "project_goals_projectId_idx" ON "project_goals"("projectId");

-- CreateIndex
CREATE INDEX "project_goals_userId_idx" ON "project_goals"("userId");

-- CreateIndex
CREATE INDEX "project_todos_goalId_idx" ON "project_todos"("goalId");

-- CreateIndex
CREATE INDEX "project_todos_projectId_idx" ON "project_todos"("projectId");

-- AddForeignKey
ALTER TABLE "chat_autonomy" ADD CONSTRAINT "chat_autonomy_chatId_fkey" FOREIGN KEY ("chatId") REFERENCES "crossmodel_chats"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chat_autonomy" ADD CONSTRAINT "chat_autonomy_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "event_hooks" ADD CONSTRAINT "event_hooks_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "event_hooks" ADD CONSTRAINT "event_hooks_sourceChatId_fkey" FOREIGN KEY ("sourceChatId") REFERENCES "crossmodel_chats"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "event_hooks" ADD CONSTRAINT "event_hooks_targetChatId_fkey" FOREIGN KEY ("targetChatId") REFERENCES "crossmodel_chats"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "hook_events" ADD CONSTRAINT "hook_events_hookId_fkey" FOREIGN KEY ("hookId") REFERENCES "event_hooks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_goals" ADD CONSTRAINT "project_goals_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "crossmodel_projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_goals" ADD CONSTRAINT "project_goals_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_todos" ADD CONSTRAINT "project_todos_goalId_fkey" FOREIGN KEY ("goalId") REFERENCES "project_goals"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_todos" ADD CONSTRAINT "project_todos_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "goal_dependencies" ADD CONSTRAINT "goal_dependencies_goalId_fkey" FOREIGN KEY ("goalId") REFERENCES "project_goals"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "goal_dependencies" ADD CONSTRAINT "goal_dependencies_dependsOnGoalId_fkey" FOREIGN KEY ("dependsOnGoalId") REFERENCES "project_goals"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "todo_dependencies" ADD CONSTRAINT "todo_dependencies_todoId_fkey" FOREIGN KEY ("todoId") REFERENCES "project_todos"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "todo_dependencies" ADD CONSTRAINT "todo_dependencies_dependsOnTodoId_fkey" FOREIGN KEY ("dependsOnTodoId") REFERENCES "project_todos"("id") ON DELETE CASCADE ON UPDATE CASCADE;

