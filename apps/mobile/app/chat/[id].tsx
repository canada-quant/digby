/**
 * Chat detail — the M0 streaming surface.
 *
 * Loads the transcript (GET /api/ai-chats/:id), then LIVE-streams the run over
 * SSE via @digby/api's sendMessageStream (expo/fetch body reader, Bearer auth
 * on both the /stream/register leg and the /stream?streamToken= leg — pinned
 * by backend route-posture tests). Markdown/code render through
 * react-native-enriched-markdown (StreamingConfig keeps partial-code-fence
 * rendering sane mid-stream). Image attachments upload via the existing
 * POST /api/crossmodel/upload (base64 JSON) and ride the send as uploadIds.
 *
 * Roadmap §3.2 item 3 (backgrounding) is M1: this screen keeps the stream
 * open for the session's lifetime; AppState handling lands with push.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  AppState,
  DeviceEventEmitter,
  FlatList,
  Image,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useLocalSearchParams, useNavigation } from 'expo-router';
import * as ExpoImagePicker from 'expo-image-picker';
import { Linking } from 'react-native';
import { EnrichedMarkdownText } from 'react-native-enriched-markdown';
import { useAuth } from '../../lib/auth-context';
import { noteChatRunCompleted } from '../../lib/push-soft-prompt';
import {
  sendMessageStream,
  uploadImage,
  ApiError,
  fetchReports,
} from '@digby/api';
import { REPORT_REASONS } from '@digby/api';
import type { SseEvent, StreamHandle, ReportReason } from '@digby/api';

/** Support contact (guideline 1.2/1.4 — reviewer-reachable contact surface). */
const SUPPORT_EMAIL = 'digby@digby.ai';

/** Human labels for the report reasons (REPORT_REASONS order). */
const REASON_LABELS: Record<ReportReason, string> = {
  hate_speech: 'Hate speech',
  harassment: 'Harassment or bullying',
  sexual_content: 'Sexual content',
  violence: 'Violence',
  self_harm: 'Self-harm',
  dangerous_acts: 'Dangerous acts',
  misinformation: 'Misinformation',
  illegal: 'Illegal content',
  spam: 'Spam or misleading',
  other: 'Something else',
};

/** One rendered row: a persisted message, or the in-flight live turn. */
interface ChatRow {
  key: string;
  role: 'user' | 'assistant';
  text: string;
  /** The DB message id — set for rows loaded from the transcript (reporting). */
  messageId?: string;
  /** Pending image attachments shown as thumbnails (user rows). */
  images?: { uri: string }[];
}

/** A picked-but-not-yet-sent attachment. */
interface PendingImage {
  localUri: string;
  filename: string;
  mimeType: string;
  base64: string;
  uploadId?: string; // set once uploaded
}

export default function ChatDetail() {
  const { crossChats, api } = useAuth();
  const { id } = useLocalSearchParams<{ id: string }>();
  const navigation = useNavigation();

  const [rows, setRows] = useState<ChatRow[] | null>(null);
  const [title, setTitle] = useState<string>('Chat');
  const [error, setError] = useState<string | undefined>();
  const [draft, setDraft] = useState('');
  const [pending, setPending] = useState<PendingImage[]>([]);
  const [sending, setSending] = useState(false);
  const [liveProgress, setLiveProgress] = useState<string | undefined>();

  const streamRef = useRef<StreamHandle | null>(null);
  const listRef = useRef<FlatList<ChatRow>>(null);
  // True while a live run is expected on this screen (set on send, cleared on
  // terminal/background) — gates the foreground RE-ATTACH: no run → no attach.
  const chatRunActiveRef = useRef(false);
  // The CURRENT live row's key — unique per turn (review B2: a constant
  // 'live' key meant a turn that ended without `complete` left a stale row
  // and the NEXT turn created a second one → duplicate FlatList keys).
  const liveKeyRef = useRef<string | null>(null);

  // Wire expo/fetch as the streaming transport once — the SDK-57 native
  // streaming fetch (resp.body.getReader()). @digby/api is transport-agnostic;
  // this is the ONE mobile-specific injection point.
  const streamClient = api;

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        setError(undefined);
        // /api/crossmodel/chats/:id — the SAME table the stream's chatId
        // resolves (crossModelChat). The legacy /api/ai-chats surface 404s
        // on stream sends.
        const chat = await crossChats.get(id);
        if (cancelled) return;
        setTitle(chat.title);
        setRows(
          (Array.isArray(chat.messages) ? chat.messages : []).map((m, i) => ({
            key: m.id ?? `${m.role}-${i}`,
            role: m.role === 'user' ? 'user' : 'assistant',
            text: m.content,
            messageId: m.id,
          }))
        );
      } catch (err) {
        if (!cancelled)
          setError(err instanceof Error ? err.message : 'Could not load chat.');
      }
    })();
    return () => {
      cancelled = true;
      streamRef.current?.dispose();
    };
  }, [crossChats, id]);

  useEffect(() => {
    navigation.setOptions({ title });
  }, [navigation, title]);

  // ── M1 backgrounding/reconnect (roadmap §3.2 item 3) ──────────────────────
  // iOS suspends the app and kills sockets seconds after backgrounding; Android
  // 15 cuts background network in 3–5s. Pattern: CLOSE the stream on
  // background (the run survives server-side — detached runs; push carries the
  // "finished" signal), then on foreground RE-ATTACH to the live run and resync
  // the transcript from REST (the source of truth). Declared BEFORE onEvent —
  // it closes over the callback via a ref set after definition.
  const onEventRef = useRef<(ev: SseEvent) => void>(() => {});

  useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') {
        // Foreground: resync the transcript from REST unconditionally (the
        // run may have finished while backgrounded — push or not), then
        // re-attach IF a run is still live.
        (async () => {
          try {
            const chat = await crossChats.get(id);
            setTitle(chat.title);
            setRows(
              (Array.isArray(chat.messages) ? chat.messages : []).map((m, i) => ({
                key: m.id ?? `${m.role}-${i}`,
                role: m.role === 'user' ? 'user' : 'assistant',
                text: m.content,
              }))
            );
          } catch { /* offline — the next foreground retries */ }
          // Live run → tail it (attachChatStream is viewer-only; a disconnect
          // never cancels the run).
          if (chatRunActiveRef.current && !streamRef.current) {
            try {
              const { attachChatStream } = await import('@digby/api');
              const handle = await attachChatStream(streamClient, id, (ev) => onEventRef.current(ev));
              if (!streamRef.current) streamRef.current = handle;
              else handle.dispose();
            } catch { /* attach is best-effort */ }
          }
        })();
      } else if (state === 'background') {
        // Background: close the viewer stream (sockets die anyway); the run
        // keeps executing server-side.
        streamRef.current?.dispose();
        streamRef.current = null;
      }
    });
    return () => sub.remove();
  }, [crossChats, id, streamClient]);

  const onEvent = useCallback((ev: SseEvent) => {
    if (ev.type === 'chunk') {
      const delta = (ev as { type: 'chunk'; data: { content: string } }).data?.content ?? '';
      if (!delta) return;
      setRows((prev) => {
        const next = prev ?? [];
        const liveKey = liveKeyRef.current;
        if (!liveKey) return next; // no live turn — drop stray chunks
        const idx = next.findIndex((r) => r.key === liveKey);
        if (idx !== -1) {
          const row = next[idx];
          return [...next.slice(0, idx), { ...row, text: row.text + delta }, ...next.slice(idx + 1)];
        }
        return [...next, { key: liveKey, role: 'assistant', text: delta }];
      });
    } else if (ev.type === 'progress') {
      const p = ev as { type: 'progress'; data: { message: string } };
      setLiveProgress(p.data?.message || undefined);
    } else if (ev.type === 'error') {
      const e = ev as { type: 'error'; data: { message: string } };
      setLiveProgress(undefined);
      chatRunActiveRef.current = false;
      freezeLiveRow();
      Alert.alert('Stream error', e.data?.message || 'The run failed.');
    } else if (ev.type === 'complete') {
      setLiveProgress(undefined);
      chatRunActiveRef.current = false;
      freezeLiveRow();
      // M1.5 item G — the value moment for the notification soft-prompt:
      // the overlay (root layout) asks once per install on the first
      // completed run; this screen never handles the prompt itself.
      noteChatRunCompleted();
    }
  }, []);

  // The AppState foreground re-attach routes events through this ref (declared
  // above onEvent to avoid a use-before-declaration — see the M1 note there).
  onEventRef.current = onEvent;

  /** Freeze the live row into a stable unique key (terminal or error path). */
  const freezeLiveRow = useCallback(() => {
    const liveKey = liveKeyRef.current;
    if (!liveKey) return;
    liveKeyRef.current = null;
    setRows((prev) => {
      const next = prev ?? [];
      const idx = next.findIndex((r) => r.key === liveKey);
      if (idx === -1) return next;
      const row = next[idx];
      return [...next.slice(0, idx), { ...row, key: `a-${liveKey}` }, ...next.slice(idx + 1)];
    });
  }, []);

  const send = useCallback(async () => {
    const message = draft.trim();
    if ((!message && pending.length === 0) || sending) return;
    setSending(true);
    setError(undefined);

    // 1. Upload pending images (base64 JSON — the browser path's shape).
    let uploadIds: string[] | undefined;
    if (pending.length > 0) {
      try {
        const uploaded = await Promise.all(
          pending.map((img) =>
            img.uploadId
              ? Promise.resolve(img.uploadId)
              : uploadImage(streamClient, {
                  filename: img.filename,
                  mimeType: img.mimeType,
                  base64: img.base64,
                }).then((r) => r.uploadId)
          )
        );
        uploadIds = uploaded;
      } catch (err) {
        setSending(false);
        Alert.alert(
          'Upload failed',
          err instanceof ApiError ? err.message : 'Could not upload the image.'
        );
        return;
      }
    }

    // 2. Render the user row immediately (optimistic).
    setRows((prev) => [
      ...(prev ?? []),
      {
        key: `u-${Date.now()}`,
        role: 'user',
        text: message,
        images: pending.map((p) => ({ uri: p.localUri })),
      },
    ]);
    setDraft('');
    setPending([]);
    setLiveProgress('Digby is on it…'); // status voice (2026-10-04) — the server's lines follow (backend chat-agent/status-voice.ts)

    // 3. Send + stream (Bearer on both legs; chat-title→id handled server-side).
    try {
      // Start a NEW live turn: unique key (review B2), cleared on freeze. A
      // live run is now expected — the foreground re-attach will tail it if
      // the app backgrounds mid-run.
      liveKeyRef.current = `live-${Date.now()}`;
      chatRunActiveRef.current = true;
      const { stream } = await sendMessageStream(
        streamClient,
        { message, chatId: id, uploadIds },
        onEvent
      );
      streamRef.current = stream;
      await stream.done;
    } catch (err) {
      // A 401 that survived refresh, or a register failure — surface it.
      const msg =
        err instanceof ApiError
          ? err.message
          : err instanceof Error
            ? err.message
            : 'The message could not be sent.';
      setRows((prev) => [...(prev ?? []), { key: `e-${Date.now()}`, role: 'assistant', text: `⚠︎ ${msg}` }]);
    } finally {
      freezeLiveRow();
      setSending(false);
      setLiveProgress(undefined);
      streamRef.current = null;
    }
  }, [draft, pending, sending, id, onEvent, freezeLiveRow, streamClient]);

  // ── Report content (M2-prep — guidelines 1.2/1.4) ──────────────────────────
  // Long-press any transcript message → Alert with the reason vocabulary →
  // POST /api/crossmodel/reports. Reports only transcript rows that carry a
  // DB message id (live rows finalize before they are reportable).
  const reportMessage = useCallback(
    (row: ChatRow) => {
      if (!row.messageId) {
        Alert.alert('Report content', 'This message cannot be reported yet.');
        return;
      }
      Alert.alert(
        'Report content',
        'Why are you reporting this message?',
        [
          { text: 'Cancel', style: 'cancel' },
          ...REPORT_REASONS.slice(0, 4).map((reason) => ({
            text: REASON_LABELS[reason],
            onPress: () => void fileReport(row, reason),
          })),
          {
            text: 'More…',
            onPress: () =>
              Alert.alert(
                'Report content',
                'Why are you reporting this message?',
                [
                  { text: 'Cancel', style: 'cancel' },
                  ...REPORT_REASONS.slice(4).map((r) => ({
                    text: REASON_LABELS[r],
                    onPress: () => void fileReport(row, r),
                  })),
                ]
              ),
          },
        ]
      );
    },
    // fileReport is stable (uses refs + id); keep deps minimal.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [id, streamClient]
  );

  const fileReport = async (row: ChatRow, reason: ReportReason) => {
    try {
      const reports = fetchReports(streamClient);
      await reports.report({
        chatId: String(id),
        messageId: row.messageId!,
        reason,
        surface: 'mobile',
      });
      Alert.alert('Reported', 'Thank you. Our team will review this content.');
    } catch (err) {
      Alert.alert(
        'Report failed',
        err instanceof ApiError ? err.message : 'Could not file the report. Please try again.'
      );
    }
  };

  const contactSupport = useCallback(() => {
    void Linking.openURL(
      `mailto:${SUPPORT_EMAIL}?subject=${encodeURIComponent('Digby content concern')}`
    ).catch(() => {
      Alert.alert('Contact support', `Email us at ${SUPPORT_EMAIL}`);
    });
  }, []);

  /** The report/contact entry point (guideline 1.2/1.4). */
  const openMenu = useCallback(() => {
    Alert.alert(
      'Chat options',
      undefined,
      [
        {
          text: 'Contact support',
          onPress: () => void contactSupport(),
        },
        {
          text: 'Report latest reply',
          onPress: () => {
            const lastAssistant = [...(rows ?? [])].reverse().find((r) => r.role === 'assistant');
            if (lastAssistant) reportMessage(lastAssistant);
          },
        },
        { text: 'Cancel', style: 'cancel' },
      ],
      { cancelable: true }
    );
  }, [rows, reportMessage, contactSupport]);

  // Header menu (guidelines 1.2/1.4): report/contact surface is reachable
  // without a long-press too — a ⋯ entry opens the report+contact sheet.
  // (Lives AFTER openMenu's declaration.)
  useEffect(() => {
    navigation.setOptions({
      headerRight: () => (
        <Pressable onPress={openMenu} accessibilityLabel="Chat options" accessibilityRole="button" hitSlop={8}>
          <Text style={styles.menuDot}>⋯</Text>
        </Pressable>
      ),
    });
  }, [navigation, openMenu]);

  const pickImage = useCallback(async () => {    try {
      const perm = await ExpoImagePicker.requestMediaLibraryPermissionsAsync();
      if (!perm.granted) {
        Alert.alert('Permission needed', 'Allow photo access to attach images.');
        return;
      }
      const result = await ExpoImagePicker.launchImageLibraryAsync({
        mediaTypes: ['images'],
        quality: 0.7,
        base64: true,
      });
      if (result.canceled || !result.assets?.length) return;
      const asset = result.assets[0];
      if (!asset.base64 || !asset.uri) return;
      const base64 = asset.base64;
      setPending((prev) => [
        ...prev,
        {
          localUri: asset.uri,
          filename: asset.fileName ?? `image-${Date.now()}.jpg`,
          mimeType: asset.mimeType ?? 'image/jpeg',
          base64,
        },
      ]);
    } catch {
      Alert.alert('Pick failed', 'Could not pick an image.');
    }
  }, []);

  const data = rows ?? [];

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      keyboardVerticalOffset={Platform.OS === 'ios' ? 88 : 0}
    >
      {error && rows === null ? (
        <View style={styles.empty}>
          <Text style={styles.emptyTitle}>Something went wrong</Text>
          <Text style={styles.emptyBody}>{error}</Text>
        </View>
      ) : rows === null ? (
        <View style={styles.empty}>
          <ActivityIndicator size="large" color="#7C3AED" />
        </View>
      ) : (
        <FlatList
          ref={listRef}
          data={data}
          keyExtractor={(item) => item.key}
          onContentSizeChange={() =>
            listRef.current?.scrollToEnd({ animated: true })
          }
          renderItem={({ item }) => (
            <Pressable
              onLongPress={() => reportMessage(item)}
              delayLongPress={350}
              accessibilityLabel={`${item.role === 'user' ? 'Your message' : 'Digby reply'} — long-press to report`}
            >
              <View
                style={[
                  styles.bubble,
                  item.role === 'user' ? styles.bubbleUser : styles.bubbleOther,
                ]}
              >
                {item.images?.length ? (
                  <View style={styles.imageRow}>
                    {item.images.map((img, i) => (
                      <Image key={i} source={{ uri: img.uri }} style={styles.thumb} />
                    ))}
                  </View>
                ) : null}
                {item.role === 'assistant' ? (
                  <EnrichedMarkdownText
                    markdown={item.text}
                    streamingAnimation
                    streamingConfig={{ tableMode: 'progressive', codeBlockMode: 'progressive' }}
                    containerStyle={styles.markdownAssistant}
                  />
                ) : (
                  <Text style={styles.messageUser}>{item.text}</Text>
                )}
              </View>
            </Pressable>
          )}
          ListFooterComponent={
            liveProgress ? (
              <View style={styles.progressRow}>
                <ActivityIndicator size="small" color="#7C3AED" />
                <Text style={styles.progressText}>{liveProgress}</Text>
              </View>
            ) : null
          }
          contentContainerStyle={{ padding: 16, gap: 10 }}
        />
      )}

      {/* Composer */}
      <View style={styles.composer}>
        {pending.length > 0 ? (
          <View style={styles.pendingRow}>
            {pending.map((p, i) => (
              <View key={i} style={styles.pendingWrap}>
                <Image source={{ uri: p.localUri }} style={styles.thumb} />
                <Pressable
                  style={styles.pendingRemove}
                  onPress={() =>
                    setPending((prev) => prev.filter((_, j) => j !== i))
                  }
                >
                  <Text style={styles.pendingRemoveText}>×</Text>
                </Pressable>
              </View>
            ))}
          </View>
        ) : null}
        <View style={styles.composerRow}>
          <Pressable style={styles.attachBtn} onPress={pickImage} disabled={sending}>
            <Text style={styles.attachBtnText}>＋</Text>
          </Pressable>
          <TextInput
            style={styles.input}
            placeholder="Message Digby…"
            placeholderTextColor="#94A3B8"
            value={draft}
            onChangeText={setDraft}
            multiline
            editable={!sending}
          />
          <Pressable
            style={[styles.sendBtn, sending && styles.sendBtnDisabled]}
            onPress={send}
            disabled={sending || (!draft.trim() && pending.length === 0)}
          >
            {sending ? (
              <ActivityIndicator size="small" color="#fff" />
            ) : (
              <Text style={styles.sendBtnText}>↑</Text>
            )}
          </Pressable>
        </View>
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#fff' },
  menuDot: { color: '#fff', fontSize: 22, fontWeight: '600', lineHeight: 26, paddingHorizontal: 4 },
  empty: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 32,
    gap: 8,
  },
  emptyTitle: { fontSize: 18, fontWeight: '600', color: '#0F172A' },
  emptyBody: { fontSize: 14, color: '#64748B', textAlign: 'center' },
  bubble: { maxWidth: '85%', borderRadius: 14, padding: 12 },
  bubbleUser: { alignSelf: 'flex-end', backgroundColor: '#7C3AED' },
  bubbleOther: { alignSelf: 'flex-start', backgroundColor: '#F1F5F9' },
  messageUser: { fontSize: 15, lineHeight: 21, color: '#fff' },
  markdownAssistant: { fontSize: 15, color: '#0F172A' },
  imageRow: { flexDirection: 'row', gap: 6, marginBottom: 8, flexWrap: 'wrap' },
  thumb: { width: 64, height: 64, borderRadius: 8 },
  progressRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingVertical: 6,
  },
  progressText: { fontSize: 13, color: '#7C3AED' },
  composer: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: '#E2E8F0',
    padding: 10,
    paddingBottom: Platform.OS === 'ios' ? 24 : 12,
    backgroundColor: '#fff',
  },
  pendingRow: { flexDirection: 'row', gap: 8, marginBottom: 8 },
  pendingWrap: { position: 'relative' },
  pendingRemove: {
    position: 'absolute',
    top: -6,
    right: -6,
    width: 20,
    height: 20,
    borderRadius: 10,
    backgroundColor: '#0F172A',
    alignItems: 'center',
    justifyContent: 'center',
  },
  pendingRemoveText: { color: '#fff', fontSize: 12, lineHeight: 14 },
  composerRow: { flexDirection: 'row', alignItems: 'flex-end', gap: 8 },
  attachBtn: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: '#F1F5F9',
    alignItems: 'center',
    justifyContent: 'center',
  },
  attachBtnText: { fontSize: 20, color: '#0F172A', lineHeight: 24 },
  input: {
    flex: 1,
    minHeight: 40,
    maxHeight: 120,
    borderRadius: 20,
    backgroundColor: '#F1F5F9',
    paddingHorizontal: 14,
    paddingTop: 10,
    paddingBottom: 10,
    fontSize: 15,
    color: '#0F172A',
  },
  sendBtn: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: '#7C3AED',
    alignItems: 'center',
    justifyContent: 'center',
  },
  sendBtnDisabled: { backgroundColor: '#C4B5FD' },
  sendBtnText: { color: '#fff', fontSize: 18, lineHeight: 22 },
});
