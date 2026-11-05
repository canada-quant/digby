import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import React from 'react';
import { AuthProvider } from '../lib/auth-context';
import { PushSoftPrompt } from '../lib/push-soft-prompt';

export default function RootLayout() {
  return (
    <AuthProvider>
      <StatusBar style="dark" />
      {/* M1.5 item G: once-per-install pre-prompt fired at the value moment
          (first completed chat run) — inside AuthProvider so it can register
          the push token against the signed-in client. */}
      <PushSoftPrompt />
      <Stack
        screenOptions={{
          headerStyle: { backgroundColor: '#7C3AED' },
          headerTintColor: '#fff',
        }}
      >
        <Stack.Screen name="index" options={{ headerShown: false }} />
        <Stack.Screen
          name="sign-in"
          options={{ title: 'Sign in', headerShown: false }}
        />
        <Stack.Screen name="chats" options={{ title: 'Chats' }} />
        <Stack.Screen name="settings" options={{ title: 'Settings' }} />
        <Stack.Screen
          name="chat/[id]"
          options={{ title: 'Chat' }}
        />
      </Stack>
    </AuthProvider>
  );
}
