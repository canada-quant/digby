UPDATE user_feature_requests SET "adminNote" = 'Fixed! Feed title generation now uses Responses API with smart fallback truncation. Auto-fix runs on every feed load, and frontend polls until title is clean.' WHERE id = '02b7002d-1a15-4eeb-a546-5eeda691d79f';

UPDATE user_feature_requests SET "adminNote" = 'Done! Built the Home Page with 20 unique news containers with Load More, and a calendar schedule section with AI prompts for Google Calendar users.' WHERE id = '49019694-df02-46a8-86c5-ee6031c30a67';

UPDATE user_feature_requests SET "adminNote" = 'Fixed! Feeds now use Responses API with gpt-5-mini and web search. Added auto-polling, retry logic, stuck feed rescue, loading spinners, and content fallback.' WHERE id = 'bec2e627-2ca9-4754-a419-1fbfd9747d9f';

UPDATE user_feature_requests SET "adminNote" = 'Fixed! Added AI-generated titles for feeds. Entries now show above messages. Feed naming and content loading both work correctly.' WHERE id = 'e3b7d674-9a88-4424-badf-5f962a7a8936';

UPDATE user_feature_requests SET "adminNote" = 'Done! Built the feed feature UI with entries, metadata, refresh, quick-ask, feed header above messages, and auto-refresh on click.' WHERE id = '8c99e7d6-a6b8-4bb6-a558-a7ec1fe21ee4';

UPDATE user_feature_requests SET "adminNote" = 'Fixed! Feeds now open their specific feed chat instead of redirecting back to the news briefing.' WHERE id = '9971d7cd-58c4-41b1-ac09-04adfc4c115d';

UPDATE user_feature_requests SET "adminNote" = 'Fixed! New feeds now properly open via loadChat when clicked.' WHERE id = '8f2e864c-e9ee-4520-9d60-f475238bf84d';

UPDATE user_feature_requests SET "adminNote" = 'Fixed! Changed button label from ambiguous "Resolved" to "Mark as Resolved" so it is clear it is an action, not a status.' WHERE id = '5ad224dc-5b7b-4f3c-91a5-7a89fee24baf';

UPDATE user_feature_requests SET "adminNote" = 'Done! Moved the New Chat button from sidebar top to under the Chats section where it is more intuitive.' WHERE id = '18eedeff-f766-4022-bc22-a0a43b1a2f2c';

UPDATE user_feature_requests SET "adminNote" = 'Done! Added a feedback button directly in chat at the bottom of the message card for easy access.' WHERE id = 'c09699a9-c030-4c75-9592-807e8f57a723';

UPDATE user_feature_requests SET "adminNote" = 'Fixed! Resolved the stuck UI issue caused by a stalled deploy. Cleared and redeployed with fresh service worker cache.' WHERE id = 'af4da123-dbe9-47b4-b01f-a4fea9fe4648';

UPDATE user_feature_requests SET "adminNote" = 'Fixed! Cleared stale cached state. PWA service worker cache updated to serve fresh content.' WHERE id = '0b3aaaed-ec41-44e7-85ee-f41830ac3ffd';
