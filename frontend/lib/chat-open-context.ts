/**
 * "Open this chat in place" for anything rendered inside the chat view (2026-10-08 interlinks): the page's
 * openChatById, published by CodeSessionView to every markdown renderer beneath it so a session chip or a
 * `/?chatId=` link switches chats without reloading the app. Null elsewhere (the management dashboard,
 * a project page): callers fall back to a normal navigation to the deep link.
 */

import { createContext } from 'react';

export type OpenChat = (chatId: string) => void;

export const ChatOpenContext = createContext<OpenChat | null>(null);
