/** isDegenerate — guards the browser-agent's final answer against the
 *  repetitive 'Let me…' monologue collapse (prod session 7be7440a). */

// glm-loop transitively imports logger → env.ts (process.exit on missing env in
// a bare test env) and driver/router modules; mock the leaves so importing the
// pure isDegenerate helper never triggers env validation.
jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('./glm-client', () => ({
  __esModule: true,
  glmChat: jest.fn(),
  stripThink: (s: string) => s,
}));
jest.mock('./router', () => ({ __esModule: true, selectBrowserDriver: jest.fn() }));

import { isDegenerate } from './glm-loop';

describe('isDegenerate', () => {
  it('passes short answers through (never degenerate under 400 chars)', () => {
    expect(isDegenerate('The page loads and the login button works.')).toBe(false);
    expect(isDegenerate('')).toBe(false);
  });

  it('passes a real varied report', () => {
    const report = [
      'Checked the homepage: it renders with the hero image and nav bar intact.',
      'The download counter reads 17,842 as of today.',
      'The blog list shows five posts, newest first, all with working links.',
      'No console errors appeared during navigation.',
      'The contact form submits and returns a success toast.',
      'Mobile layout collapses the nav into a hamburger menu correctly.',
    ].join(' ');
    expect(isDegenerate(report)).toBe(false);
  });

  it('flags a sentence repeated many times', () => {
    // >400 chars so the length floor is cleared; the same sentence 12×.
    const loop = Array(12).fill('Let me check the next thing on the page carefully now.').join(' ');
    expect(loop.length).toBeGreaterThan(400);
    expect(isDegenerate(loop)).toBe(true);
  });

  it('flags low unique-sentence ratio', () => {
    const s = 'Let me look. ';
    const t = (s.repeat(30)) + 'Now I will proceed carefully to inspect the remaining elements here.';
    expect(isDegenerate(t)).toBe(true);
  });
});
