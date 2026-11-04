/**
 * Account → Profile → Change password (2026-10-12): the form renders three
 * password inputs with the right autocomplete hints for password managers,
 * and a Digby Kids child account never sees it (the parent sets a child's
 * password under Account → Kids). react-dom/server idiom (node-environment
 * vitest, no jsdom).
 */
import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn() }) }));
vi.mock('next/image', () => ({ default: (props: { alt: string }) => createElement('img', { alt: props.alt }) }));
vi.mock('@/lib/auth', () => ({ authApi: { changePassword: vi.fn() } }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { ProfileTab, NEW_PASSWORD_MIN_LENGTH } from './ProfileTab';

describe('ProfileTab change password', () => {
  it('renders current / new / confirm password inputs with password-manager hints', () => {
    const html = renderToStaticMarkup(createElement(ProfileTab, { email: 'a@b.c' }));
    expect(html).toContain('data-testid="change-password"');
    expect(html).toContain('Change password');
    expect(html.match(/type="password"/g)).toHaveLength(3);
    expect(html).toContain('autoComplete="current-password"');
    expect(html.match(/autoComplete="new-password"/g)).toHaveLength(2);
    // The account's username rides along (hidden) so the manager updates the right entry.
    expect(html).toContain('autoComplete="username"');
    expect(html).toContain(`At least ${NEW_PASSWORD_MIN_LENGTH} characters.`);
    expect(NEW_PASSWORD_MIN_LENGTH).toBe(8); // the backend register / change-password floor
  });

  it('is hidden for a Digby Kids child account', () => {
    const html = renderToStaticMarkup(createElement(ProfileTab, { isChild: true }));
    expect(html).not.toContain('data-testid="change-password"');
    expect(html).not.toContain('type="password"');
  });
});
