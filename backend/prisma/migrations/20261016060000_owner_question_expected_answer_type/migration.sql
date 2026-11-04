-- Todo 77c88942 item 2 (audit 2026-10-16): the flagger declares the EXPECTED
-- answer type on an owner question — 'free' (default: any non-empty text
-- resolves, the legacy behavior), 'choice', 'yes_no', or
-- 'credential:<ENVKEY>'. A credential gate resolves ONLY on a store_secret
-- RunToolReceipt for that envKey, never on answer text (specimen
-- oq_211513ed/oq_483730f8: both answered "yes public" 3 s apart and opened
-- the credential-gated Schooltime todo).
ALTER TABLE "owner_questions" ADD COLUMN "expectedAnswerType" TEXT;
