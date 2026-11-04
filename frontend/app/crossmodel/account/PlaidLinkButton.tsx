'use client';

/**
 * PlaidLinkButton — Opens the Plaid Link widget to connect a bank account.
 *
 * Flow:
 *   1. User clicks "Connect Bank"
 *   2. Frontend requests a link_token from the backend
 *   3. usePlaidLink hook initializes with the token
 *   4. Plaid Link widget opens (bank selection, login, MFA)
 *   5. On success, frontend sends public_token to backend for exchange
 *   6. Backend stores encrypted access_token in DB
 *   7. Status refreshes to show connected state
 */

import { useState, useCallback, useEffect } from 'react';
import { usePlaidLink } from 'react-plaid-link';
import { Button } from '@/components/ui/button';
import { Loader2, Plus } from 'lucide-react';
import { toast } from 'sonner';
import { plaidApi, type PlaidStatus } from '@/lib/api/crossmodel';

interface PlaidLinkButtonProps {
  onConnected: (status: PlaidStatus) => void;
  /** When true, shows "Add Bank" instead of "Connect Bank" */
  hasExisting?: boolean;
}

export default function PlaidLinkButton({ onConnected, hasExisting }: PlaidLinkButtonProps) {
  const [linkToken, setLinkToken] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [exchanging, setExchanging] = useState(false);

  // Fetch a link token from the backend when user clicks "Connect Bank"
  const fetchLinkToken = useCallback(async () => {
    setLoading(true);
    try {
      const token = await plaidApi.createLinkToken();
      setLinkToken(token);
    } catch (e: any) {
      // The backend's 503 names the reason (credentials, or the token-encryption
      // key on a self-host) — show it rather than a generic line.
      toast.error(e?.response?.data?.error || (e?.response ? 'Plaid is not set up on this instance yet — an administrator configures it under Account → Admin → Setup.' : 'Could not reach Digby — check your connection and try again.'));
      setLoading(false);
    }
  }, []);

  // Plaid Link success handler — exchange public_token for access_token
  const onSuccess = useCallback(async (publicToken: string, metadata: any) => {
    setExchanging(true);
    try {
      const institution = metadata?.institution;
      await plaidApi.exchangeToken(
        publicToken,
        institution?.institution_id || undefined,
        institution?.name || undefined,
      );
      toast.success(`Bank connected${institution?.name ? `: ${institution.name}` : ''}`);
      // Refresh status
      const status = await plaidApi.getStatus();
      onConnected(status);
    } catch (e: any) {
      toast.error(e?.response?.data?.error || 'Failed to connect bank account. Please try again.');
    } finally {
      setExchanging(false);
      setLinkToken(null);
    }
  }, [onConnected]);

  // Plaid Link exit handler
  const onExit = useCallback(() => {
    setLinkToken(null);
    setLoading(false);
  }, []);

  // Initialize Plaid Link with the token
  const { open, ready } = usePlaidLink({
    token: linkToken,
    onSuccess,
    onExit,
  });

  // Auto-open Plaid Link once the token is ready
  useEffect(() => {
    if (linkToken && ready) {
      open();
      setLoading(false);
    }
  }, [linkToken, ready, open]);

  const isLoading = loading || exchanging;

  return (
    <Button
      size="sm"
      className="h-7 text-xs bg-[#111] hover:bg-[#333] border-0 text-white gap-1.5"
      disabled={isLoading}
      onClick={fetchLinkToken}
    >
      {isLoading ? <Loader2 className="size-3.5 animate-spin" /> : <Plus className="size-3.5" />}
      {exchanging ? 'Connecting...' : hasExisting ? 'Add Bank' : 'Connect Bank'}
    </Button>
  );
}
