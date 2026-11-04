-- Ticket 90a5b127 (2026-10-19): the flagger's own typed declaration that an
-- owner-card ask is OPTIONAL. TRUE completes the options axis of the
-- owner-card payload-gap admission (detectOwnerCardPayloadGaps) by
-- declaration; FALSE suppresses the prose-optionality fallback; NULL = not
-- declared. The structural signal that ends the incomplete-card FP family's
-- wording chase (84b11946 → 65cfec1b → cea10fa4 → 90a5b127, all FPs, zero
-- true positives in the wild): the flagger knows the ask is optional — the
-- detector no longer guesses it from prose.
ALTER TABLE "owner_questions" ADD COLUMN "optionalAsk" BOOLEAN;
