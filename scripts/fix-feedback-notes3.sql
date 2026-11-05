UPDATE user_feature_requests SET "adminNote" = 'Fixed! Messages now load immediately when opening a conversation. Fixed a race condition in message loading with proper state synchronization.' WHERE id = '50eb5e34-c786-4111-9028-038e15ed4f22';

UPDATE user_feature_requests SET "adminNote" = 'Fixed! The Tell me more button on home screen news now works. Added the missing useEffect trigger.' WHERE id = 'fe6920de-6ed5-4996-922c-9f1cb974842f';

UPDATE user_feature_requests SET "adminNote" = 'Great news! Added multi-bank support so you can connect multiple bank accounts. The Add Bank button is now always visible.' WHERE id = '56192846-c42a-49c0-8243-ee9972649ee2';

UPDATE user_feature_requests SET "adminNote" = 'Fixed! The Xero connection failure was caused by a stale Docker build with old auth logic. Rebuilt with correct auth URL encoding.' WHERE id = '661895fc-68d7-4538-b2d0-2c98fba52950';

UPDATE user_feature_requests SET "adminNote" = 'Fixed! Added image reading capability descriptions to all models so they understand their context window sizes in thinking mode.' WHERE id = '42536416-0ecd-481e-b516-e0e23b44bc07';

UPDATE user_feature_requests SET status = 'done', "adminNote" = 'Done! In-chat thumbs-down feedback now appears in your Feedback tab with an orange "from chat" badge. Toast message directs you to Account > Feedback to track it.' WHERE id = '725314f6-e4ef-467b-9bda-85d4a9d5cd03';

UPDATE user_feature_requests SET status = 'done', "adminNote" = 'Fixed! Context and conversation history now maintained when switching between all patience modes. Deep research pipeline loads full conversation history, user memory, and system context.' WHERE id = 'adde495e-4547-4557-8a48-4f60e0610a36';

UPDATE user_feature_requests SET status = 'done', "adminNote" = 'Done! Added Check for Errors button on open-source responses. Sends conversation to frontier pipeline in thinking mode for fact-checking. Auto-creates bug report if serious errors found. Look for the shield icon on assistant messages.' WHERE id = '4b78f9a3-d17b-484d-a174-18e32e6b74ff';

UPDATE user_feature_requests SET status = 'done', "adminNote" = 'Fixed! Project member invites now use case-insensitive email lookup. Users are found regardless of email capitalization. Improved error message when user does not have an account yet.' WHERE id = '86c99a20-7cc8-45f1-bda3-b47bc886454d';
