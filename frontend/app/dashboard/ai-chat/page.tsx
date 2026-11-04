'use client';

import { useState, useEffect, useRef } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { aiChatApi, Chat, Message } from '@/lib/api/ai-chat';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Skeleton } from '@/components/ui/skeleton';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { toast } from 'sonner';
import { Send, Plus, MessageSquare, Trash2, Edit } from 'lucide-react';
import { format } from 'date-fns';

export default function AIChatPage() {
  const [selectedChatId, setSelectedChatId] = useState<string | null>(null);
  const [confirmDeleteChatId, setConfirmDeleteChatId] = useState<string | null>(null);
  const [messageInput, setMessageInput] = useState('');
  const [newChatTitle, setNewChatTitle] = useState('');
  const [isCreatingChat, setIsCreatingChat] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const queryClient = useQueryClient();

  // List chats
  const { data: chatsData, isLoading: isLoadingChats } = useQuery({
    queryKey: ['ai-chats'],
    queryFn: () => aiChatApi.list({ limit: 50 }),
  });

  // Get selected chat
  const { data: currentChat, isLoading: isLoadingChat } = useQuery({
    queryKey: ['ai-chat', selectedChatId],
    queryFn: () => aiChatApi.get(selectedChatId!),
    enabled: !!selectedChatId,
  });

  // Create chat mutation
  const createChatMutation = useMutation({
    mutationFn: aiChatApi.create,
    onSuccess: (data) => {
      toast.success(data.message);
      queryClient.invalidateQueries({ queryKey: ['ai-chats'] });
      setSelectedChatId(data.data.id);
      setIsCreatingChat(false);
      setNewChatTitle('');
    },
    onError: (error: any) => {
      toast.error(error.response?.data?.error || 'Failed to create chat');
    },
  });

  // Add message mutation
  const addMessageMutation = useMutation({
    mutationFn: ({ chatId, content }: { chatId: string; content: string }) =>
      aiChatApi.addMessage(chatId, { content }),
    onSuccess: (data) => {
      queryClient.setQueryData(['ai-chat', selectedChatId], data);
      queryClient.invalidateQueries({ queryKey: ['ai-chats'] });
      setMessageInput('');
    },
    onError: (error: any) => {
      toast.error(error.response?.data?.error || 'Failed to send message');
    },
  });

  // Delete chat mutation
  const deleteChatMutation = useMutation({
    mutationFn: aiChatApi.delete,
    onSuccess: (data) => {
      toast.success(data.message);
      queryClient.invalidateQueries({ queryKey: ['ai-chats'] });
      if (selectedChatId === selectedChatId) {
        setSelectedChatId(null);
      }
    },
    onError: (error: any) => {
      toast.error(error.response?.data?.error || 'Failed to delete chat');
    },
  });

  // Auto-scroll to bottom
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [currentChat?.messages]);

  // Auto-select first chat
  useEffect(() => {
    if (chatsData?.chats.length && !selectedChatId) {
      setSelectedChatId(chatsData.chats[0].id);
    }
  }, [chatsData, selectedChatId]);

  const handleSendMessage = (e: React.FormEvent) => {
    e.preventDefault();
    if (!messageInput.trim() || !selectedChatId || addMessageMutation.isPending) return;
    
    addMessageMutation.mutate({
      chatId: selectedChatId,
      content: messageInput.trim(),
    });
  };

  const handleCreateChat = (e: React.FormEvent) => {
    e.preventDefault();
    if (!newChatTitle.trim() || createChatMutation.isPending) return;
    
    createChatMutation.mutate({ title: newChatTitle.trim() });
  };

  return (
    <div className="flex h-screen bg-background">
      {/* Sidebar */}
      <div className="w-80 border-r flex flex-col">
        <div className="p-4 border-b">
          <h2 className="text-lg font-semibold mb-4">AI Chat</h2>
          
          {isCreatingChat ? (
            <form onSubmit={handleCreateChat} className="space-y-2">
              <Input
                value={newChatTitle}
                onChange={(e) => setNewChatTitle(e.target.value)}
                placeholder="Chat title..."
                autoFocus
              />
              <div className="flex gap-2">
                <Button type="submit" size="sm" className="flex-1" disabled={createChatMutation.isPending}>
                  Create
                </Button>
                <Button type="button" size="sm" variant="outline" onClick={() => {
                  setIsCreatingChat(false);
                  setNewChatTitle('');
                }}>
                  Cancel
                </Button>
              </div>
            </form>
          ) : (
            <Button onClick={() => setIsCreatingChat(true)} className="w-full">
              <Plus className="mr-2 size-4" />
              New Chat
            </Button>
          )}
        </div>

        <ScrollArea className="flex-1">
          {isLoadingChats ? (
            <div className="p-4 space-y-2">
              <Skeleton className="h-16 w-full" />
              <Skeleton className="h-16 w-full" />
              <Skeleton className="h-16 w-full" />
            </div>
          ) : (
            <div className="p-2">
              {chatsData?.chats.map((chat) => (
                <div
                  key={chat.id}
                  className={`relative group p-3 rounded-lg mb-2 hover:bg-accent transition-colors cursor-pointer ${
                    selectedChatId === chat.id ? 'bg-accent' : ''
                  }`}
                  onClick={() => setSelectedChatId(chat.id)}
                >
                  <div className="flex items-start justify-between">
                    <div className="flex-1 min-w-0">
                      <div className="font-medium truncate">{chat.title}</div>
                      <div className="text-xs text-muted-foreground truncate">
                        {chat.lastMessage || 'No messages yet'}
                      </div>
                      <div className="text-xs text-muted-foreground mt-1">
                        {chat.messageCount || 0} messages
                      </div>
                    </div>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="size-8 p-0 shrink-0"
                      onClick={(e) => {
                        e.stopPropagation();
                        setConfirmDeleteChatId(chat.id);
                      }}
                    >
                      <Trash2 className="size-4" />
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </ScrollArea>
      </div>

      {/* Chat Area */}
      <div className="flex-1 flex flex-col">
        {selectedChatId ? (
          <>
            {/* Chat Header */}
            <div className="border-b p-4">
              <h3 className="font-semibold">{currentChat?.title || 'Loading...'}</h3>
              <p className="text-sm text-muted-foreground">
                {currentChat?.messages.length || 0} messages
              </p>
            </div>

            {/* Messages */}
            <ScrollArea className="flex-1 p-4">
              {isLoadingChat ? (
                <div className="space-y-4">
                  <Skeleton className="h-20 w-3/4" />
                  <Skeleton className="h-20 w-3/4 ml-auto" />
                </div>
              ) : (
                <div className="space-y-4 pb-4">
                  {currentChat?.messages.map((message, index) => (
                    <div
                      key={index}
                      className={`flex ${message.role === 'user' ? 'justify-end' : 'justify-start'}`}
                    >
                      <div
                        className={`max-w-[70%] rounded-lg p-3 ${
                          message.role === 'user'
                            ? 'bg-primary text-primary-foreground'
                            : 'bg-muted'
                        }`}
                      >
                        <div className="text-sm whitespace-pre-wrap">{message.content}</div>
                        <div className="text-xs mt-1 opacity-70">
                          {format(new Date(message.timestamp), 'HH:mm')}
                        </div>
                      </div>
                    </div>
                  ))}
                  <div ref={messagesEndRef} />
                </div>
              )}
            </ScrollArea>

            {/* Input */}
            <div className="border-t p-4">
              <form onSubmit={handleSendMessage} className="flex gap-2">
                <Input
                  value={messageInput}
                  onChange={(e) => setMessageInput(e.target.value)}
                  placeholder="Type your message..."
                  disabled={addMessageMutation.isPending}
                />
                <Button type="submit" disabled={addMessageMutation.isPending || !messageInput.trim()}>
                  <Send className="size-4" />
                </Button>
              </form>
            </div>
          </>
        ) : (
          <div className="flex-1 flex items-center justify-center">
            <div className="text-center text-muted-foreground">
              <MessageSquare className="size-12 mx-auto mb-4 opacity-50" />
              <p>Select a chat or create a new one to start</p>
            </div>
          </div>
        )}
      </div>

      {/* Delete chat confirmation */}
      <AlertDialog open={!!confirmDeleteChatId} onOpenChange={(open) => !open && setConfirmDeleteChatId(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this chat?</AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently delete the chat and all its messages. This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive hover:bg-destructive/90"
              onClick={() => {
                if (confirmDeleteChatId) deleteChatMutation.mutate(confirmDeleteChatId);
                setConfirmDeleteChatId(null);
              }}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}