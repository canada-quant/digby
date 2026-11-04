namespace Digby.Shell;

// Host allowlist — the port of main.swift:10-19 `keepInApp`.
//
// Hosts on this list load INSIDE the shell; anything else the USER clicks
// lands in the OS default browser. The contains-matches are deliberately loose
// (mirroring macOS) so accounts.google.com, gist.github.com and
// raw.githubusercontent.com all pass. Note System.Uri.Host canonicalizes to
// lowercase, so the case-insensitive compares are defense in depth, not a
// behavior change.
internal static class HostPolicy
{
    public static bool KeepInApp(string host)
    {
        return host.Equals("digby.example.com", StringComparison.OrdinalIgnoreCase)
            || host.EndsWith(".digby.example.com", StringComparison.OrdinalIgnoreCase)
            || host.Contains("google.com", StringComparison.OrdinalIgnoreCase)             // sign-in / Workspace OAuth
            || host.Contains("github.com", StringComparison.OrdinalIgnoreCase)             // sign-in OAuth
            || host.Contains("githubusercontent.com", StringComparison.OrdinalIgnoreCase)
            || host.Contains("apple.com", StringComparison.OrdinalIgnoreCase);
    }
}
