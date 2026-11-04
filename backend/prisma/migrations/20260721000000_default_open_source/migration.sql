-- New users default to the open-source model set (pre-launch, 2026-07-21).
-- Changes the column DEFAULT only; existing rows keep whatever they had, so
-- users who explicitly chose 'frontier' are unaffected.
ALTER TABLE "user_preferences" ALTER COLUMN "modelSet" SET DEFAULT 'open_source';
