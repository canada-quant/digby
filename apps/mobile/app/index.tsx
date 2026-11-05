import { Redirect, useRouter } from 'expo-router';
import React, { useEffect } from 'react';
import { ActivityIndicator, View } from 'react-native';
import { useAuth } from '../lib/auth-context';

/**
 * Entry route — redirects by auth state:
 *   restoring → spinner; signed out → /sign-in; signed in → /chats.
 */
export default function Index() {
  const { user } = useAuth();
  const router = useRouter();

  // Re-evaluate on every auth change, not just mount: <Redirect> replaces
  // this route (index unmounts), so sign-in → user state change must be
  // observed HERE only while mounted — the sign-in screen performs its own
  // post-login navigation.
  useEffect(() => {
    if (user) router.replace('/chats');
  }, [user, router]);

  if (user === null) {
    return (
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
        <ActivityIndicator size="large" color="#7C3AED" />
      </View>
    );
  }

  if (user === undefined) {
    return <Redirect href="/sign-in" />;
  }

  return (
    <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
      <ActivityIndicator size="large" color="#7C3AED" />
    </View>
  );
}
