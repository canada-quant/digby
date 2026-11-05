import React, { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { Redirect, useRouter } from 'expo-router';
import { useAuth } from '../lib/auth-context';
import type { CrossModelChat } from '@digby/api';

export default function Chats() {
  const { crossChats, user, signOut } = useAuth();
  const router = useRouter();
  const [list, setList] = useState<CrossModelChat[] | null>(null);
  const [error, setError] = useState<string | undefined>();
  const [refreshing, setRefreshing] = useState(false);

  const load = async () => {
    try {
      setError(undefined);
      // The SSE stream targets crossModelChat rows — list THAT surface (the
      // web sidebar's /api/crossmodel/chats), not the legacy /api/ai-chats.
      const res = await crossChats.list({ page: 1, limit: 50 });
      setList(res);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load chats.');
    }
  };

  useEffect(() => {
    if (user !== undefined) void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user]);

  const onRefresh = async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  };

  // New chat: create (server titles it after the first message) → open it.
  // The composer's sendMessageStream carries the chatId on every send.
  const [creating, setCreating] = useState(false);
  const newChat = async () => {
    if (creating) return;
    setCreating(true);
    try {
      const chat = await crossChats.create({ title: 'New chat' });
      router.push(`/chat/${chat.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not create chat.');
    } finally {
      setCreating(false);
    }
  };

  // Signed out (signOut tap or definitive session expiry) → back to sign-in;
  // without this the user is left on a stale, unauthenticated list.
  if (user === undefined) {
    return <Redirect href="/sign-in" />;
  }

  return (
    <View style={styles.container}>
      <FlatList
        data={list ?? []}
        keyExtractor={(item) => item.id}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={onRefresh} />
        }
        ListHeaderComponent={
          <View style={styles.headerRow}>
            <Text style={styles.headerTitle} accessibilityRole="header">
              Chats
            </Text>
            <View style={styles.headerActions}>
              <Pressable onPress={newChat} accessibilityRole="button" accessibilityLabel="New chat" disabled={creating}>
                {creating ? (
                  <ActivityIndicator size="small" color="#7C3AED" />
                ) : (
                  <Text style={styles.newChat}>＋</Text>
                )}
              </Pressable>
              {/* Settings (M2-prep): account deletion (5.1.1(v)) + support. */}
              <Pressable
                onPress={() => router.push('/settings')}
                accessibilityRole="button"
                accessibilityLabel="Settings"
              >
                <Text style={styles.settingsLink}>Settings</Text>
              </Pressable>
              <Pressable onPress={signOut} accessibilityRole="button">
                <Text style={styles.signOut}>Sign out</Text>
              </Pressable>
            </View>
          </View>
        }
        ListEmptyComponent={
          error ? (
            <View style={styles.empty}>
              <Text style={styles.emptyTitle}>Something went wrong</Text>
              <Text style={styles.emptyBody}>{error}</Text>
              <Pressable style={styles.retryButton} onPress={load} accessibilityRole="button">
                <Text style={styles.retryText}>Retry</Text>
              </Pressable>
            </View>
          ) : list === null ? (
            <View style={styles.empty}>
              <ActivityIndicator size="large" color="#7C3AED" />
            </View>
          ) : (
            <View style={styles.empty}>
              <Text style={styles.emptyTitle}>No chats yet</Text>
              <Text style={styles.emptyBody}>
                Your Digby conversations will appear here.
              </Text>
            </View>
          )
        }
        renderItem={({ item }) => (
          <Pressable
            style={styles.row}
            onPress={() => router.push(`/chat/${item.id}`)}
            accessibilityRole="button"
            accessibilityLabel={`Open chat ${item.title}`}
          >
            <Text style={styles.rowTitle} numberOfLines={1}>
              {item.title}
            </Text>
            {item.lastMessage ? (
              <Text style={styles.rowPreview} numberOfLines={2}>
                {item.lastMessage}
              </Text>
            ) : null}
            <Text style={styles.rowMeta}>
              {item.messageCount ?? 0} messages
            </Text>
          </Pressable>
        )}
        contentContainerStyle={list?.length ? {} : styles.grow}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#fff' },
  grow: { flexGrow: 1 },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  headerTitle: { fontSize: 28, fontWeight: '700', color: '#0F172A' },
  headerActions: { flexDirection: 'row', alignItems: 'center', gap: 16 },
  newChat: { color: '#7C3AED', fontSize: 22, fontWeight: '600', lineHeight: 26 },
  settingsLink: { color: '#7C3AED', fontSize: 15, fontWeight: '600' },
  signOut: { color: '#7C3AED', fontSize: 15, fontWeight: '600' },
  empty: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 32,
    gap: 8,
  },
  emptyTitle: { fontSize: 18, fontWeight: '600', color: '#0F172A' },
  emptyBody: { fontSize: 14, color: '#64748B', textAlign: 'center' },
  retryButton: {
    marginTop: 12,
    backgroundColor: '#7C3AED',
    borderRadius: 8,
    paddingHorizontal: 20,
    paddingVertical: 10,
  },
  retryText: { color: '#fff', fontWeight: '600' },
  row: {
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#E2E8F0',
  },
  rowTitle: { fontSize: 16, fontWeight: '600', color: '#0F172A' },
  rowPreview: { fontSize: 14, color: '#64748B', marginTop: 2 },
  rowMeta: { fontSize: 12, color: '#94A3B8', marginTop: 4 },
});
