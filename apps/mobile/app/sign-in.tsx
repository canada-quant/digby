import React, { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useRouter } from 'expo-router';
import { useAuth } from '../lib/auth-context';

export default function SignIn() {
  const { signIn, user } = useAuth();
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();

  // The index route unmounts itself when it <Redirect>s here, so auth-state
  // changes can no longer be observed there — navigate on success HERE.
  useEffect(() => {
    if (user) router.replace('/chats');
  }, [user, router]);

  const onSubmit = async () => {
    if (!email.trim() || !password) {
      setError('Enter your email and password.');
      return;
    }
    setBusy(true);
    setError(undefined);
    try {
      await signIn(email.trim(), password);
      // navigation happens in the effect above on user state change
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Sign-in failed.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <Text style={styles.title}>Digby</Text>
      <Text style={styles.subtitle}>Ask once. Get the best of every AI.</Text>

      <TextInput
        style={styles.input}
        placeholder="Email"
        autoCapitalize="none"
        autoComplete="email"
        keyboardType="email-address"
        value={email}
        onChangeText={setEmail}
        editable={!busy}
      />
      <TextInput
        style={styles.input}
        placeholder="Password"
        secureTextEntry
        value={password}
        onChangeText={setPassword}
        editable={!busy}
      />

      {error ? <Text style={styles.error}>{error}</Text> : null}

      <Pressable
        style={[styles.button, busy && styles.buttonDisabled]}
        onPress={onSubmit}
        disabled={busy || user !== undefined}
        accessibilityRole="button"
      >
        {busy ? (
          <ActivityIndicator color="#fff" />
        ) : (
          <Text style={styles.buttonText}>Sign in</Text>
        )}
      </Pressable>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#fff',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
  },
  title: {
    fontSize: 40,
    fontWeight: '700',
    color: '#7C3AED',
    marginBottom: 8,
  },
  subtitle: {
    fontSize: 15,
    color: '#64748B',
    marginBottom: 32,
  },
  input: {
    width: '100%',
    borderWidth: 1,
    borderColor: '#E2E8F0',
    borderRadius: 10,
    padding: 14,
    fontSize: 16,
    marginBottom: 12,
    color: '#0F172A',
  },
  error: {
    color: '#DC2626',
    marginBottom: 12,
  },
  button: {
    width: '100%',
    backgroundColor: '#7C3AED',
    borderRadius: 10,
    padding: 16,
    alignItems: 'center',
  },
  buttonDisabled: {
    opacity: 0.6,
  },
  buttonText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '600',
  },
});
