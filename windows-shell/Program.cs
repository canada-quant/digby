// Digby Windows shell (W2) — entry point + single-instance guard.
//
// The Windows port of macos-app/Sources/Digby/main.swift: a WinForms host
// around https://digby.example.com/ rendered by Microsoft Edge WebView2, with
// the same behavior contract (host allowlist, in-app new windows, the
// __digbyDesktop bridge, close-hides-not-quits, launch update check).
// See windows-shell/README.md for the full port + deviation table.

using System.Runtime.InteropServices;

namespace Digby.Shell;

internal static class Program
{
    /// <summary>Named mutex — only one shell per user session (brief item 13).</summary>
    private const string SingleInstanceMutexName = "Digby.Shell.SingleInstance";

    /// <summary>
    /// Registered window message used by a second launch to wake the running
    /// instance (same string → same id in every process). 0 if registration
    /// failed, which never happens in practice but is guarded anyway.
    /// </summary>
    internal static readonly int ActivateMessage =
        NativeMethods.RegisterWindowMessage("Digby.Shell.Activate");

    /// <summary>Shell version (AssemblyVersion 1.0.0 → "1.0.0"), used by the bridge flag.</summary>
    internal static string AppVersion =>
        typeof(Program).Assembly.GetName().Version?.ToString(3) ?? "1.0.0";

    [STAThread]
    private static int Main()
    {
        using var mutex = new Mutex(initiallyOwned: true, SingleInstanceMutexName, out bool createdNew);
        if (!createdNew)
        {
            // Second launch: poke the running shell and get out of the way.
            // LOGGED (2026-10-09 hang fix): a hung first instance holding the
            // mutex makes every subsequent launch a silent no-op — this line is
            // the only trace that distinguishes "shortcut does nothing" from
            // "app not installed" when the user reports the app won't open.
            ShellLog.Info("second launch: existing instance holds the single-instance mutex — " +
                "posting the activate broadcast and exiting");
            if (ActivateMessage != 0)
            {
                NativeMethods.PostMessage(
                    NativeMethods.HwndBroadcast, ActivateMessage, IntPtr.Zero, IntPtr.Zero);
            }
            return 0;
        }

        // Generated initializer — applies <ApplicationHighDpiMode>PerMonitorV2</…>
        // (and the default visual style/font) from Digby.Shell.csproj.
        ApplicationConfiguration.Initialize();

        try
        {
            Application.Run(new MainForm());
            return 0;
        }
        finally
        {
            GC.KeepAlive(mutex); // hold the single-instance claim until we exit
        }
    }
}

internal static class NativeMethods
{
    public static readonly nint HwndBroadcast = unchecked((nint)0xFFFF);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    public static extern int RegisterWindowMessage(string messageName);

    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool PostMessage(nint hWnd, int msg, nint wParam, nint lParam);
}
