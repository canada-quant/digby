import apiClient from './api-client';

export interface User {
  id: string;
  email: string;
  firstName?: string;
  lastName?: string;
  role: string;
  avatar?: string;
  // Digby Kids
  isChild?: boolean;
  parentId?: string | null;
  childAge?: number | null;
}

export interface LoginCredentials {
  email: string;
  password: string;
}

export interface RegisterData {
  email: string;
  password: string;
  firstName?: string;
  lastName?: string;
  /** Meta Pixel event id shared with the server's Conversions API event (dedup) — lib/meta-pixel.ts. */
  metaEventId?: string;
  /** Meta ClickID (`_fbc`) — the backend also reads the cookie and our own fbclid capture. */
  metaFbc?: string;
  /**
   * "I accept the Terms of Service and Acceptable Use" (Phase 2 Cloud, todo
   * ea95fa0b). Sent only when the box is actually ticked — see the signup form.
   * The backend records it against the new user (terms.service) and decides
   * whether a MISSING acceptance refuses the signup via the live
   * `require_terms_acceptance` policy (default OFF).
   */
  acceptedTerms?: boolean;
}

export const authApi = {
  async login(credentials: LoginCredentials) {
    const response = await apiClient.post('/auth/login', credentials);
    if (response.data.data.accessToken) {
      localStorage.setItem('accessToken', response.data.data.accessToken);
    }
    return response.data.data;
  },

  async register(data: RegisterData) {
    const response = await apiClient.post('/auth/register', data);
    if (response.data.data.accessToken) {
      localStorage.setItem('accessToken', response.data.data.accessToken);
    }
    return response.data.data;
  },

  async logout() {
    await apiClient.post('/auth/logout');
    localStorage.removeItem('accessToken');
  },

  async getCurrentUser(): Promise<User> {
    const response = await apiClient.get('/auth/me');
    return response.data.data;
  },

  /**
   * POST /auth/change-password. The backend signs out every other device and
   * hands this browser a fresh token pair (refresh cookie + accessToken), so
   * store the new access token exactly like login. Throws on failure (a wrong
   * current password is a 400 with `error`, never a 401).
   */
  async changePassword(data: { currentPassword: string; newPassword: string }) {
    const response = await apiClient.post('/auth/change-password', data);
    if (response.data.data?.accessToken) {
      localStorage.setItem('accessToken', response.data.data.accessToken);
    }
    return response.data.data as { accessToken: string; refreshTokensRevoked: number; accessTokensCutOff: boolean };
  },

  async refreshToken() {
    const response = await apiClient.post('/auth/refresh');
    if (response.data.data.accessToken) {
      localStorage.setItem('accessToken', response.data.data.accessToken);
    }
    return response.data.data;
  },

  /**
   * POST /auth/verify-email { token } — consume an emailed verification token.
   *
   * DELIBERATELY UNAUTHENTICATED (the /verify-email page calls this): the link is
   * routinely opened in a different browser or on a phone than the one that
   * signed up, so requiring a session would strand exactly the users verification
   * exists to serve. The token IS the credential — 32 random bytes, sha256-stored
   * server-side, single-use, 24 h.
   */
  async verifyEmail(token: string) {
    const response = await apiClient.post('/auth/verify-email', { token });
    return response.data.data as { alreadyVerified: boolean };
  },

  /**
   * POST /auth/resend-verification — re-send the link to the signed-in user.
   * Returns `mailed: false` (with an `error`) when SMTP is unavailable, which
   * the page reports honestly rather than claiming an email arrived.
   */
  async resendVerification() {
    const response = await apiClient.post('/auth/resend-verification');
    return response.data.data as { mailed: boolean; error?: string };
  },
};
