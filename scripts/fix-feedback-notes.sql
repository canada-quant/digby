-- One-time fix: update generic Digby Response notes with actual summaries
-- and mark completed tickets that were stuck as open.
-- Run on production: cat scripts/fix-feedback-notes.sql | ssh ... docker exec -i admin-postgres-prod psql -U admin -d admin_db

-- Mark tickets that were completed but stuck as open/retrying
UPDATE user_feature_requests SET status = 'done', "adminNote" = 'Done! In-chat thumbs-down feedback now appears in your Feedback tab with an orange "from chat" badge.' WHERE id = '725314f6-e4ef-467b-9bda-85d4a9d5cd03' AND status != 'done';
UPDATE user_feature_requests SET status = 'done', "adminNote" = 'Fixed! Context and conversation history now maintained when switching between all patience modes.' WHERE id = 'adde495e-4547-4557-8a48-4f60e0610a36' AND status != 'done';
UPDATE user_feature_requests SET status = 'done', "adminNote" = 'Done! Added Check for Errors button on open-source responses. Sends conversation to frontier pipeline for fact-checking.' WHERE id = '4b78f9a3-d17b-484d-a174-18e32e6b74ff' AND status != 'done';
UPDATE user_feature_requests SET status = 'done', "adminNote" = 'Fixed! Project member invites now use case-insensitive email lookup.' WHERE id = '86c99a20-7cc8-45f1-bda3-b47bc886454d' AND status != 'done';
