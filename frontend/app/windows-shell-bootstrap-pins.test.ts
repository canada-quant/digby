/**
 * 2026-10-09 Windows-shell hang fix — bootstrap bounds + visible states pins.
 *
 * Owner report (verbatim): "i have it installed on my windows laptop currently
 * but when it opens it just spins forever." Audit finding: the shell's whole
 * WebView2 bootstrap was unbounded and invisible — CreateAsync /
 * EnsureCoreWebView2Async / both AddScriptToExecuteOnDocumentCreatedAsync had
 * no timeout, the only visible state during init was the WebView2's blank
 * white placeholder, the first navigation had no NavigationCompleted handler,
 * and the ONLY log line in the entire boot path was the CreateAsync exception
 * (a HANG wrote nothing).
 *
 * The C# toolchain only exists on the Windows runner (the same constraint the
 * windows-feed pins were designed around), so this suite pins the shell's
 * SOURCE — the exact seams the fix added, so a regression (someone removes a
 * timeout, the StartupPanel, or the milestone logging) fails here even though
 * no Windows unit harness exists for the shell itself.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';

const readSrc = (rel: string): string =>
  readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

const MAIN = readSrc('../../windows-shell/MainForm.cs');
const PANEL = readSrc('../../windows-shell/StartupPanel.cs');
const PROGRAM = readSrc('../../windows-shell/Program.cs');
const SHELL_LOG = readSrc('../../windows-shell/ShellLog.cs');

describe('shell bootstrap — every startup await is bounded (2026-10-09)', () => {
  it('CreateAsync is raced against a deadline', () => {
    const block = MAIN.match(/CoreWebView2Environment\.CreateAsync\([\s\S]*?options: null\)/);
    expect(block).not.toBeNull();
    expect(MAIN).toContain('EnvironmentCreateTimeout = TimeSpan.FromSeconds(30)');
  });

  it('EnsureCoreWebView2Async is raced against a deadline', () => {
    expect(MAIN).toContain('EnsureCoreTimeout = TimeSpan.FromSeconds(30)');
    // EnsureCoreWebView2Async returns plain Task — the non-generic twin wraps it.
    const block = MAIN.match(/WithTimeoutCore\(\s*_webView\.EnsureCoreWebView2Async\(environment\)/);
    expect(block).not.toBeNull();
  });

  it('both AddScriptToExecuteOnDocumentCreatedAsync calls are raced against a deadline', () => {
    expect(MAIN).toContain('AddScriptTimeout = TimeSpan.FromSeconds(15)');
    expect(MAIN).toMatch(
      /WithTimeout\(\s*core\.AddScriptToExecuteOnDocumentCreatedAsync\(Bridge\.DesktopFlagScript\)/,
    );
    expect(MAIN).toMatch(
      /WithTimeout\(\s*core\.AddScriptToExecuteOnDocumentCreatedAsync\(Bridge\.WebKitShimScript\)/,
    );
  });

  it('no unbounded WebView2 init await remains (the timeout helper wraps every one)', () => {
    // Every AddScript call site must be inside WithTimeout( — count call sites
    // vs wrapped sites; a bare `await core.AddScriptToExecuteOnDocumentCreatedAsync`
    // (no WithTimeout) is the regression this catches.
    const bare = MAIN.match(/await core\.AddScriptToExecuteOnDocumentCreatedAsync\(/g) ?? [];
    const wrapped = MAIN.match(/WithTimeout\(\s*core\.AddScriptToExecuteOnDocumentCreatedAsync\(/g) ?? [];
    expect(bare.length).toBe(0);
    expect(wrapped.length).toBe(2);
  });
});

describe('shell bootstrap — a hang is VISIBLE, never a silent blank (2026-10-09)', () => {
  it('the StartupPanel exists and is mounted over the WebView2', () => {
    expect(PANEL).toContain('class StartupPanel : Panel');
    expect(MAIN).toContain('Controls.Add(_startupPanel)');
    expect(MAIN).toContain('_startupPanel.SetRetry(RetryBootstrap)');
    // BringToFront() is the panel's own z-order mechanism (called inside
    // ShowLoading/ShowError), not a MainForm call.
    expect(PANEL).toMatch(/BringToFront\(\)/);
  });

  it('the panel has a loading state, an error state, and a Retry', () => {
    expect(PANEL).toContain('ShowLoading');
    expect(PANEL).toContain('ShowError');
    expect(PANEL).toContain('SetRetry');
    expect(PANEL).toContain('_retry.Visible = true');
  });

  it('every boot failure path routes to the panel (no MessageBox-and-die path remains)', () => {
    // The old missing-runtime path was MessageBox + Close() — the window died
    // with no trace. The one REMAINING MessageBox is the update-check prompt
    // (user-initiated, not a boot failure) — the missing-runtime handler must
    // be a panel error state instead.
    expect(MAIN).toContain(
      '"Digby uses the Microsoft Edge WebView2 runtime to display digby.ai.\\n\\n"');
    expect(MAIN).not.toMatch(
      /MessageBox\.Show\(\s*this,\s*"Digby needs the Microsoft Edge WebView2 runtime/);
    // ...and every boot failure (env create, ensure-core, scripts, missing
    // runtime, failed first navigation) lands on the panel.
    expect(MAIN.match(/_startupPanel\.ShowError\(/g)?.length).toBeGreaterThanOrEqual(5);
  });

  it('a failed FIRST navigation shows the error state (NavigationCompleted wired)', () => {
    expect(MAIN).toContain('core.NavigationCompleted += OnNavigationCompleted');
    expect(MAIN).toContain("Digby couldn't reach digby.ai");
    // and the first SUCCESSFUL navigation dismisses the panel
    expect(MAIN).toContain('_startupPanel.Dismiss()');
  });

  it('the Retry path re-runs the bootstrap and is bounded too', () => {
    expect(MAIN).toContain('private void RetryBootstrap()');
    expect(MAIN).toContain('_ = InitializeWebViewAsync();');
  });
});

describe('shell bootstrap — a hang leaves a diagnosable trace (2026-10-09)', () => {
  it('boot milestones are logged from init start through first navigation', () => {
    expect(MAIN).toContain('boot: Main → WebView init started');
    expect(MAIN).toContain('boot: environment ready');
    expect(MAIN).toContain('boot: CoreWebView2 ready');
    expect(MAIN).toContain('boot: bridge scripts registered');
    expect(MAIN).toContain('boot: navigating to');
    expect(MAIN).toContain('boot: first navigation completed');
  });

  it('timeouts are LOGGED, not just thrown', () => {
    expect(MAIN).toContain('boot: WebView2 environment creation TIMED OUT');
    expect(MAIN).toContain('boot: EnsureCoreWebView2Async TIMED OUT');
    expect(MAIN).toContain('boot: bridge script registration TIMED OUT');
  });

  it('browser/renderer death is logged (ProcessFailed wired)', () => {
    expect(MAIN).toContain('core.ProcessFailed +=');
    expect(MAIN).toContain('WebView2 process failed');
  });

  it('the log path is surfaced in the error UI', () => {
    expect(SHELL_LOG).toContain('public static string LogFilePath');
    expect(PANEL).toContain('ShellLog.LogFilePath');
  });

  it('the second-launch mutex path is logged (a wedged first instance is traceable)', () => {
    expect(PROGRAM).toContain('second launch: existing instance holds the single-instance mutex');
  });

  it('the UA major is current Chrome, not the frozen Chrome/131 (bot-scoring spoof signal)', () => {
    expect(MAIN).not.toContain('Chrome/131.0.0.0');
    expect(MAIN).toMatch(/Chrome\/1[4-9]\d\.0\.0\.0/);
  });
});
