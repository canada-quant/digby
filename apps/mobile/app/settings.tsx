/**
 * Settings (M2-prep — App Store 5.1.1(v) in-app account deletion).
 *
 * Account section: sign out + the store-mandated "Delete account" flow.
 * The delete is confirm-gated TWICE: (1) an Alert explaining permanence,
 * (2) the account password (backend re-auth — a stolen bearer token alone
 * cannot delete the account). On success the local session tears down
 * exactly like signOut (SecureStore refresh token + access token + user
 * state) and the auth gate redirects to sign-in.
 *
 * Support contact (guideline 1.2/1.4): mailto link to the support address —
 * the reviewer needs a reachable contact surface; the chat screen's report
 * action is the content-moderation half.
 */

import React, { useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Linking,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { Redirect } from 'expo-router';
import { fetchAuth, ApiError } from '@digby/api';
import type { DigbyApiClient } from '@digby/api';
import { useAuth } from '../lib/auth-context';

/** Support contact (guideline 1.2/1.4 — reviewer-reachable contact surface). */
const SUPPORT_EMAIL = 'digby@digby.ai';

export default function Settings() {
  const { user, signOut, api } = useAuth();
  const [password, setPassword] = useState('');
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | undefined>();

  if (user === undefined) {
    return <Redirect href="/sign-in" />;
  }

  const doDelete = async (client: DigbyApiClient, pw: string) => {
    if (deleting) return;
    setDeleting(true);
    try {
      // THROWS on failure (unlike logout) — the user must know if the
      // deletion did NOT happen. @digby/api clears the access token on success.
      const auth = fetchAuth(client);
      await auth.deleteAccount({ password: pw });
      // Local teardown — exactly the signOut shape (SecureStore refresh
      // token, in-memory access token, user state). The auth gates on
      // /chats + this screen redirect to sign-in.
      await signOut();
    } catch (err) {
      setDeleting(false);
      if (err instanceof ApiError && err.status === 401) {
        setDeleteError('Incorrect password. Your account was not deleted.');
      } else {
        setDeleteError(
          err instanceof Error ? err.message : 'Could not delete the account. Please try again.'
        );
      }
    }
  };

  /** Confirm-gated delete: Alert (permanence) → password → DELETE. */
  const onDeleteAccount = () => {
    Alert.alert(
      'Delete account',
      'This permanently deletes your account, chats, memories, and all associated data. This cannot be undone.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete account',
          style: 'destructive',
          onPress: () => {
            setDeleteError(undefined);
            if (!password) {
              setDeleteError('Enter your password to confirm deletion.');
              return;
            }
            void doDelete(api, password);
          },
        },
      ]
    );
  };

  const contactSupport = () => {
    void Linking.openURL(
      `mailto:${SUPPORT_EMAIL}?subject=${encodeURIComponent('Digby mobile app support')}`
    ).catch(() => {
      Alert.alert('Contact support', `Email us at ${SUPPORT_EMAIL}`);
    });
  };

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Account</Text>
        <Text style={styles.userEmail}>{user?.email ?? ''}</Text>
        <Pressable
          style={styles.signOutButton}
          onPress={signOut}
          accessibilityRole="button"
          disabled={deleting}
        >
          <Text style={styles.signOutText}>Sign out</Text>
        </Pressable>
      </View>

      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Delete account</Text>
        <Text style={styles.sectionBody}>
          Permanently deletes your account, chats, memories, and all associated
          data. This cannot be undone.
        </Text>
        <TextInput
          style={styles.passwordInput}
          placeholder="Password"
          placeholderTextColor="#94A3B8"
          secureTextEntry
          autoCapitalize="none"
          autoCorrect={false}
          value={password}
          onChangeText={setPassword}
          editable={!deleting}
          accessibilityLabel="Account password"
        />
        {deleteError ? <Text style={styles.errorText}>{deleteError}</Text> : null}
        <Pressable
          style={[styles.deleteButton, deleting && styles.deleteButtonDisabled]}
          onPress={onDeleteAccount}
          accessibilityRole="button"
          accessibilityLabel="Delete account"
          disabled={deleting}
        >
          {deleting ? (
            <ActivityIndicator size="small" color="#fff" />
          ) : (
            <Text style={styles.deleteButtonText}>Delete account</Text>
          )}
        </Pressable>
      </View>

      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Support</Text>
        <Text style={styles.sectionBody}>
          Found a problem or need help? Contact us and we will get back to you.
        </Text>
        <Pressable style={styles.supportButton} onPress={contactSupport} accessibilityRole="button">
          <Text style={styles.supportButtonText}>Contact support</Text>
        </Pressable>
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#fff' },
  content: { padding: 16, gap: 24 },
  section: { gap: 10 },
  sectionTitle: { fontSize: 18, fontWeight: '700', color: '#0F172A' },
  sectionBody: { fontSize: 14, color: '#64748B', lineHeight: 20 },
  userEmail: { fontSize: 14, color: '#64748B' },
  signOutButton: {
    alignSelf: 'flex-start',
    backgroundColor: '#F1F5F9',
    borderRadius: 8,
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  signOutText: { color: '#0F172A', fontWeight: '600', fontSize: 15 },
  passwordInput: {
    borderWidth: 1,
    borderColor: '#E2E8F0',
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 15,
    color: '#0F172A',
    backgroundColor: '#fff',
  },
  deleteButton: {
    alignSelf: 'flex-start',
    backgroundColor: '#DC2626',
    borderRadius: 8,
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  deleteButtonDisabled: { opacity: 0.6 },
  deleteButtonText: { color: '#fff', fontWeight: '600', fontSize: 15 },
  errorText: { color: '#DC2626', fontSize: 13 },
  supportButton: {
    alignSelf: 'flex-start',
    backgroundColor: '#F1F5F9',
    borderRadius: 8,
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  supportButtonText: { color: '#7C3AED', fontWeight: '600', fontSize: 15 },
});
