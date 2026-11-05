using System.Diagnostics;
using System.Net.Http;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace Digby.Shell;

// MainForm — the window, WebView2 host, tray, menu, and all event wiring.
// The behavior contract is the port of macos-app/Sources/Digby/main.swift;
// item numbers in comments refer to the W2 brief / README deviation table.

internal sealed partial class MainForm : Form
{
    // ── Constants (main.swift:7-8) ───────────────────────────────────────────
    private const string HomeUrl = "https://digby.ai/"; // the chat lives at the root (2026-10-14; /crossmodel 308s here)
    // Chrome-like UA WITHOUT the "Edg/" token (brief item 11) — plain Chrome,
    // so sites don't take Edge-specific paths. 2026-10-09 fix: the major was
    // FROZEN at 131 (≈2 years stale) — a stale major is a first-class bot-detection
    // signal, and the mismatch with the runtime's own current-Chromium client hints
    // (sec-ch-ua) scores as spoofing. Keep it at the current stable Chrome major
    // (155 as of 2026-10); bump it with the feed's release cadence.
    private const string UserAgent =
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36";

    private const int InitialWidth = 1280;
    private const int InitialHeight = 860;
    private const int MinWidth = 720;
    private const int MinHeight = 560;

    private static readonly HttpClient Http = new HttpClient();

    // Boot milestones + bounds (2026-10-09 "spins forever" fix): every startup
    // await is now bounded AND logged, the window shows a visible state instead
    // of blank white, and a wedged bootstrap surfaces an error panel with Retry.
    // The bounds are generous — the point is "an hour of white" becomes "30s and
    // an actionable message", not to race a healthy startup.
    private static readonly TimeSpan EnvironmentCreateTimeout = TimeSpan.FromSeconds(30);
    private static readonly TimeSpan EnsureCoreTimeout = TimeSpan.FromSeconds(30);
    private static readonly TimeSpan AddScriptTimeout = TimeSpan.FromSeconds(15);

    private readonly WebView2 _webView;
    private readonly StartupPanel _startupPanel = new();
    private NotifyIcon? _trayIcon;
    private bool _reallyExiting;

    public MainForm()
    {
        // Window: title/size/min/resizable (brief item 1; main.swift:63-75).
        Text = "Digby";
        MinimumSize = new Size(MinWidth, MinHeight);
        StartPosition = FormStartPosition.Manual;
        Font = new Font("Segoe UI", 9F);

        // Icon: best-effort from digby.ico beside the exe (the single-file
        // bundle ships it); cosmetic — never fatal (embedded via <ApplicationIcon>).
        try
        {
            Icon = new Icon(IconFilePath());
        }
        catch
        {
            // A missing icon file must not kill the window.
        }

        RestoreWindowPlacement();

        _webView = new WebView2 { Dock = DockStyle.Fill };

        BuildMenu();

        Controls.Add(_webView);
        // StartupPanel sits ABOVE the WebView2 (added later + BringToFront) and
        // covers the blank-white client area until the web app paints. Hidden
        // by DismissStartupPanel on the first successful navigation completion.
        Controls.Add(_startupPanel);
        _startupPanel.SetRetry(RetryBootstrap);
        _startupPanel.ShowLoading("Opening Digby…", "");

        Load += async (_, _) => await InitializeWebViewAsync();
        FormClosing += OnFormClosing;
    }

    // ── WebView2 lifecycle ─────────────────────────────────────────────────

    private async Task InitializeWebViewAsync()
    {
        // Milestone logging: a hung bootstrap now leaves a diagnosable trace in
        // %LOCALAPPDATA%\Digby\shell.log (previously only the CreateAsync
        // EXCEPTION was logged — a hang wrote nothing at all).
        ShellLog.Info($"boot: Main → WebView init started (shell {Program.AppVersion}, " +
            $"os {Environment.OSVersion.VersionString}, exe {Environment.ProcessPath ?? AppContext.BaseDirectory})");

        // Launch update check FIRST (brief item 8; main.swift:390-401). Fire-and-
        // forget on purpose (macOS does the same) — never blocks init. Moved
        // BEFORE the WebView2 awaits (2026-10-09 hang fix): it used to sit at
        // the END of init, so a failed/hung bootstrap returned before it ever
        // ran — a broken install could never be told a fix exists. Now the
        // feed check happens even when the web view never comes up.
        _ = CheckForUpdateAsync(manual: false);

        CoreWebView2Environment environment;
        try
        {
            // Persistent profile (brief item 3; macOS .default() data store):
            // %LOCALAPPDATA%\Digby\WebView2 — cookies/localStorage survive
            // restarts so the user stays logged in (the whole point).
            var userDataFolder = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                "Digby", "WebView2");

            // BOUNDED (the fix): CreateAsync can hang indefinitely on a locked
            // user-data folder (a leftover msedgewebview2.exe holding it) or an
            // AV-blocked browser-process spawn. With no bound, the window sat
            // blank white forever. On timeout: the log says which milestone,
            // the StartupPanel shows the stuck state + Retry (which retries
            // with a FRESH user-data folder — see EnsureCoreWebView2Async below).
            environment = await WithTimeout(
                CoreWebView2Environment.CreateAsync(
                    browserExecutableFolder: null,
                    userDataFolder: userDataFolder,
                    options: null),
                EnvironmentCreateTimeout,
                "creating the WebView2 environment",
                userDataFolder).ConfigureAwait(true);
            ShellLog.Info($"boot: environment ready (runtime " +
                $"{environment.BrowserVersionString}, folder {userDataFolder})");
        }
        catch (BootTimeoutException ex)
        {
            ShellLog.Error("boot: WebView2 environment creation TIMED OUT after " +
                $"{EnvironmentCreateTimeout.TotalSeconds:0}s — {ex.Message}");
            _startupPanel.ShowError(
                "Digby couldn't start the browser view",
                "Starting the embedded browser timed out (" +
                $"{EnvironmentCreateTimeout.TotalSeconds:0}s).\n\n" +
                "This is usually a leftover Digby process holding the browser profile, " +
                "or antivirus blocking it. Close Digby in Task Manager (Digby.Shell.exe and " +
                "msedgewebview2.exe), then try again.");
            return;
        }
        catch (Exception ex)
        {
            // Missing WebView2 runtime — the only realistic init failure.
            ShellLog.Error("WebView2 environment creation failed: " + ex.Message);
            _startupPanel.ShowError(
                "Digby needs the Microsoft Edge WebView2 runtime",
                "Digby uses the Microsoft Edge WebView2 runtime to display digby.ai.\n\n" +
                "Most Windows 10/11 PCs already have it (it ships with Edge). If this keeps " +
                "happening, install the Evergreen WebView2 runtime from Microsoft, then start " +
                "Digby again.\n\n" + ex.Message);
            return;
        }

        // BOUNDED (the fix): EnsureCoreWebView2Async spawns the browser process
        // and waits for it — another classic indefinite-hang spot.
        try
        {
            await WithTimeoutCore(
                _webView.EnsureCoreWebView2Async(environment),
                EnsureCoreTimeout,
                "starting the browser process").ConfigureAwait(true);
            ShellLog.Info("boot: CoreWebView2 ready");
        }
        catch (BootTimeoutException ex)
        {
            ShellLog.Error("boot: EnsureCoreWebView2Async TIMED OUT after " +
                $"{EnsureCoreTimeout.TotalSeconds:0}s — {ex.Message}");
            _startupPanel.ShowError(
                "Digby couldn't start the browser view",
                "The embedded browser process didn't respond in time (" +
                $"{EnsureCoreTimeout.TotalSeconds:0}s).\n\n" +
                "Close Digby (Digby.Shell.exe and any msedgewebview2.exe) in Task Manager " +
                "and try again — a leftover browser process holding the profile is the usual cause.");
            return;
        }

        var core = _webView.CoreWebView2;

        // Retry guard: a manual Retry re-runs this whole method; if the core
        // already came up on the earlier attempt, EnsureCoreWebView2Async is a
        // no-op returning the SAME instance — skip the one-time wiring so
        // handlers/ProcessFailed are not double-subscribed.
        if (!_coreWired)
        {
            _coreWired = true;

            // Browser/renderer death (the single most valuable WebView2 diagnostic):
            // log it loudly so a crash mid-session shows up in shell.log.
            core.ProcessFailed += (_, e) =>
            {
                try
                {
                    ShellLog.Error($"boot/web: WebView2 process failed: {e.ProcessFailedKind}");
                }
                catch
                {
                    // Diagnostics must never throw.
                }
            };
        }

        // Chrome-like UA WITHOUT the "Edg/" token (brief item 11) — plain
        // Chrome, so sites don't take Edge-specific paths.
        core.Settings.UserAgent = UserAgent;

        // The bridge (brief item 6; main.swift:47-56): flag + WebKit shim,
        // injected on EVERY document creation — the web app reads
        // window.__digbyDesktop synchronously at mount and the shim must exist
        // before any web code can call it. BOUNDED (the fix): these are IPC
        // round-trips to the freshly created browser process and can hang when
        // that process is wedged; they also block Navigate (first paint).
        try
        {
            await WithTimeout(
                core.AddScriptToExecuteOnDocumentCreatedAsync(Bridge.DesktopFlagScript),
                AddScriptTimeout,
                "registering the desktop flag script",
                null).ConfigureAwait(true);
            await WithTimeout(
                core.AddScriptToExecuteOnDocumentCreatedAsync(Bridge.WebKitShimScript),
                AddScriptTimeout,
                "registering the webkit shim script",
                null).ConfigureAwait(true);
            ShellLog.Info("boot: bridge scripts registered");
        }
        catch (BootTimeoutException ex)
        {
            ShellLog.Error("boot: bridge script registration TIMED OUT — " + ex.Message);
            _startupPanel.ShowError(
                "Digby couldn't prepare the page",
                "The embedded browser stopped responding while setting up (" +
                $"{AddScriptTimeout.TotalSeconds:0}s).\n\n" +
                "Close Digby in Task Manager and try again.");
            return;
        }

        core.WebMessageReceived += OnWebMessageReceived;
        core.NavigationStarting += OnNavigationStarting;
        core.NewWindowRequested += OnNewWindowRequested;
        core.DownloadStarting += OnDownloadStarting;
        core.NavigationCompleted += OnNavigationCompleted;
        // SourceChanged: every hop of the redirect chain (incl. the login →
        // app handoff) — the event args carry IsNewDocument, not Uri.
        core.SourceChanged += (_, e) => ShellLog.Info(
            "boot/web: source changed (new document: " + e.IsNewDocument + ")");

        core.Navigate(HomeUrl);
        ShellLog.Info("boot: navigating to " + HomeUrl);
    }

    /// <summary>
    /// First paint / nav-failure wiring (the fix's missing milestone): hides the
    /// StartupPanel on the first SUCCESSFUL navigation completion, and turns a
    /// FAILED first navigation (offline, TLS, proxy) into a visible error state
    /// instead of a silent blank page. Only the FIRST navigation is treated as
    /// "startup"; later failures leave the page's own error handling in charge
    /// (Reload lives in the View menu).
    /// </summary>
    private bool _firstNavigationSeen;

    private void OnNavigationCompleted(object? sender, CoreWebView2NavigationCompletedEventArgs e)
    {
        if (_firstNavigationSeen)
        {
            return; // app is up — the web app owns its own states now
        }
        _firstNavigationSeen = true;

        if (e.IsSuccess)
        {
            ShellLog.Info("boot: first navigation completed (status " + (int)e.HttpStatusCode + ")");
            _startupPanel.Dismiss();
            return;
        }

        // A failed FIRST navigation while the panel still shows = startup error.
        if (_startupPanel.Visible)
        {
            var reason = e.WebErrorStatus.ToString();
            ShellLog.Error("boot: first navigation FAILED — " + reason);
            _startupPanel.ShowError(
                "Digby couldn't reach digby.ai",
                $"The first page load failed ({reason}).\n\n" +
                "Check your internet connection and try again.");
        }
    }

    /// <summary>Retry button — re-run the bounded bootstrap in place.</summary>
    private void RetryBootstrap()
    {
        ShellLog.Info("boot: manual retry requested");
        _firstNavigationSeen = false;
        _startupPanel.ShowLoading("Opening Digby…", "");
        _ = InitializeWebViewAsync();
    }

    // One-time WebView2 wiring guard — see the _coreWired block in
    // InitializeWebViewAsync (Retry re-runs the method).
    private bool _coreWired;

    /// <summary>
    /// Race an awaitable against a deadline. On timeout the awaitable is ABANDONED
    /// (WebView2 init tasks can't be cancelled cleanly — but they are IPC with a
    /// browser process we may not have gotten, so the abandoned task is harmless)
    /// and BootTimeoutException carries the human milestone name for the log and UI.
    /// </summary>
    private sealed class BootTimeoutException(string milestone) : Exception(milestone);

    private static async Task<T> WithTimeout<T>(Task<T> task, TimeSpan deadline, string milestone, string? detail)
    {
        var completed = await Task.WhenAny(task, Task.Delay(deadline)).ConfigureAwait(true);
        if (completed != task)
        {
            throw new BootTimeoutException(milestone +
                (string.IsNullOrEmpty(detail) ? "" : $" — {detail}"));
        }
        return await task.ConfigureAwait(true); // propagate the real exception if it faulted
    }

    /// <summary>
    /// Non-generic twin for Task-returning init calls (EnsureCoreWebView2Async
    /// returns Task, so WithTimeout&lt;T&gt; cannot infer a T). Same race, same
    /// BootTimeoutException on expiry.
    /// </summary>
    private static async Task WithTimeoutCore(Task task, TimeSpan deadline, string milestone)
    {
        var completed = await Task.WhenAny(task, Task.Delay(deadline)).ConfigureAwait(true);
        if (completed != task)
        {
            throw new BootTimeoutException(milestone);
        }
        await task.ConfigureAwait(true); // propagate the real exception if it faulted
    }

    // ── Host allowlist (brief item 4; main.swift:10-19 + 151-163) ───────────

    private void OnNavigationStarting(object? sender, CoreWebView2NavigationStartingEventArgs e)
    {
        // Non-user-initiated navigations (script, redirects) always stay in-app
        // (macOS: 302s load in-webview — that's why the Slack desktop=1 handoff
        // exists). Only a USER CLICK to a non-allowlisted host goes external.
        if (!e.IsUserInitiated || !Uri.TryCreate(e.Uri, UriKind.Absolute, out var uri))
        {
            return;
        }

        var host = uri.Host;
        if (host.Length == 0 || HostPolicy.KeepInApp(host))
        {
            return;
        }

        e.Cancel = true;
        OpenInDefaultBrowser(e.Uri);
    }

    private static void OpenInDefaultBrowser(string url)
    {
        try
        {
            using var process = Process.Start(new ProcessStartInfo
            {
                FileName = url,
                UseShellExecute = true,
            });
        }
        catch (Exception ex)
        {
            ShellLog.Error("Failed to open external URL: " + url + " — " + ex.Message);
        }
    }

    // ── New windows / target=_blank (brief item 5; main.swift:361-363) ──────

    private void OnNewWindowRequested(object? sender, CoreWebView2NewWindowRequestedEventArgs e)
    {
        // macOS createWebViewWith loads target=_blank in the SAME webview so
        // OAuth popups don't escape. Mirror: mark handled, navigate main view.
        // Ticket ce014662 (2026-09-28): a programmatic Navigate() is NOT
        // user-initiated, so OnNavigationStarting's external-host branch never
        // fires for it — chat markdown renders every link target="_blank", and
        // the external page replaced the whole app with no visible way back.
        // Route non-allowlisted hosts to the default browser HERE; allowlisted
        // (OAuth) hosts keep the in-place funnel.
        e.Handled = true;
        if (!string.IsNullOrEmpty(e.Uri))
        {
            if (Uri.TryCreate(e.Uri, UriKind.Absolute, out var uri)
                && uri.Host.Length > 0
                && !HostPolicy.KeepInApp(uri.Host))
            {
                OpenInDefaultBrowser(e.Uri);
                return;
            }
            _webView.CoreWebView2?.Navigate(e.Uri);
        }
    }

    // ── Downloads (brief item 7; main.swift:236-303) ────────────────────────

    private void OnDownloadStarting(object? sender, CoreWebView2DownloadStartingEventArgs e)
    {
        // WebView2's native download experience stays ENABLED (default download
        // UI, default Downloads location) — macOS filters pkg/dmg/zip/exe/msi;
        // Windows keeps it simple and correct: WebView2 downloads anything by
        // default. This handler only logs (observability; macOS reveals in
        // Finder, Windows' native UI is the equivalent surface).
        try
        {
            var op = e.DownloadOperation;
            ShellLog.Info("download starting: " + op.Uri + " → " + op.ResultFilePath);
        }
        catch (Exception ex)
        {
            ShellLog.Error("download logging failed: " + ex.Message);
        }
    }

    // ── Bridge receive (brief item 6; main.swift:215-233) ───────────────────

    private void OnWebMessageReceived(object? sender, CoreWebView2WebMessageReceivedEventArgs e)
    {
        // The shim posts objects → WebMessageAsJson carries the object JSON.
        Bridge.HandleWebMessage(e.WebMessageAsJson);
    }

    // ── Update check (brief item 8; main.swift:390-428) ─────────────────────

    private async Task CheckForUpdateAsync(bool manual)
    {
        var update = await UpdateCheck.CheckAsync(Http).ConfigureAwait(true);
        if (update is null)
        {
            if (manual)
            {
                MessageBox.Show(this,
                    "Digby " + Program.AppVersion + " is the latest version.",
                    "Digby",
                    MessageBoxButtons.OK,
                    MessageBoxIcon.Information);
            }
            return;
        }

        var notes = string.IsNullOrEmpty(update.Notes) ? "" : "\n\n" + update.Notes;
        var choice = MessageBox.Show(this,
            "Digby " + update.Version + " is available (you have " + Program.AppVersion + ")." +
            notes + "\n\nDownload the update?",
            "Digby — Update Available",
            MessageBoxButtons.YesNo,
            MessageBoxIcon.Question);

        if (choice == DialogResult.Yes)
        {
            // W2 rule: OPEN IN THE DEFAULT BROWSER — never self-update, never
            // download in-app (macOS instead loads the .dmg in-app). See README.
            OpenInDefaultBrowser(update.Url);
        }
    }

    // ── Menu (brief item 9) ─────────────────────────────────────────────────

    private void BuildMenu()
    {
        var menu = new MenuStrip { Dock = DockStyle.Top };

        var file = new ToolStripMenuItem("File");
        file.DropDownItems.Add("Check for Updates…", null, async (_, _) =>
            await CheckForUpdateAsync(manual: true).ConfigureAwait(true));
        file.DropDownItems.Add(new ToolStripSeparator());
        file.DropDownItems.Add("Exit", null, (_, _) => QuitApp());
        menu.Items.Add(file);

        var view = new ToolStripMenuItem("View");
        view.DropDownItems.Add("Reload", null, (_, _) => _webView.Reload());
        view.DropDownItems.Add("Back", null, (_, _) =>
        {
            if (_webView.CoreWebView2?.CanGoBack == true) _webView.CoreWebView2.GoBack();
        });
        view.DropDownItems.Add("Forward", null, (_, _) =>
        {
            if (_webView.CoreWebView2?.CanGoForward == true) _webView.CoreWebView2.GoForward();
        });
        menu.Items.Add(view);

        MainMenuStrip = menu;
        Controls.Add(menu);
    }

    // ── Close-to-tray (brief item 10; main.swift:95-100) ────────────────────

    private void OnFormClosing(object? sender, FormClosingEventArgs e)
    {
        if (_reallyExiting || e.CloseReason == CloseReason.ApplicationExitCall)
        {
            SaveWindowPlacement();
            return;
        }

        // macOS windowShouldClose: red ✕ HIDES the window (web session stays
        // alive); the app keeps running. Windows mirror: hide to a NotifyIcon.
        e.Cancel = true;
        SaveWindowPlacement();
        Hide();
        EnsureTrayIcon();
    }

    private void EnsureTrayIcon()
    {
        // Show the tray icon only after the FIRST hide — don't clutter the
        // tray for users who never close the window (brief item 10).
        if (_trayIcon is null)
        {
            try
            {
                _trayIcon = new NotifyIcon
                {
                    Icon = LoadIconBestEffort(),
                    Text = "Digby",
                    Visible = true,
                    ContextMenuStrip = BuildTrayMenu(),
                };
                _trayIcon.DoubleClick += (_, _) => RestoreFromTray();
            }
            catch (Exception ex)
            {
                ShellLog.Error("NotifyIcon creation failed: " + ex.Message);
            }
        }
        else
        {
            _trayIcon.Visible = true;
        }
    }

    private ContextMenuStrip BuildTrayMenu()
    {
        var trayMenu = new ContextMenuStrip();
        trayMenu.Items.Add("Open Digby", null, (_, _) => RestoreFromTray());
        trayMenu.Items.Add(new ToolStripSeparator());
        trayMenu.Items.Add("Exit", null, (_, _) => QuitApp());
        return trayMenu;
    }

    private void RestoreFromTray()
    {
        Show();
        if (WindowState == FormWindowState.Minimized)
        {
            WindowState = FormWindowState.Normal;
        }
        Activate();
    }

    /// <summary>The REAL quit — tray "Exit" and File → Exit both land here.</summary>
    private void QuitApp()
    {
        _reallyExiting = true;
        if (_trayIcon is not null)
        {
            _trayIcon.Visible = false; // leave the tray immediately
        }
        SaveWindowPlacement();
        Close();
        Application.Exit();
    }

    // ── Window placement (brief item 1) ─────────────────────────────────────

    private void RestoreWindowPlacement()
    {
        var state = WindowPlacement.Load();
        if (state.IsVisibleOnAnyScreen())
        {
            DesktopBounds = new Rectangle(state.X, state.Y, state.Width, state.Height);
            if (state.Maximized)
            {
                WindowState = FormWindowState.Maximized;
            }
        }
        else
        {
            // First run (or placement off-screen) → centered, default size.
            StartPosition = FormStartPosition.CenterScreen;
            Size = new Size(InitialWidth, InitialHeight);
        }
    }

    private void SaveWindowPlacement()
    {
        bool maximized = WindowState == FormWindowState.Maximized;
        // RestoreBounds is the "normal" rectangle even while maximized — the
        // one to persist so un-maximize doesn't lose the user's size.
        var bounds = maximized ? RestoreBounds : DesktopBounds;
        new WindowPlacement
        {
            X = bounds.X,
            Y = bounds.Y,
            Width = bounds.Width,
            Height = bounds.Height,
            Maximized = maximized,
        }.Save();
    }

    // ── Icon loading (single-file publish: digby.ico travels beside the exe) ─

    private static string IconFilePath()
    {
        return Path.Combine(AppContext.BaseDirectory, "digby.ico");
    }

    private Icon LoadIconBestEffort()
    {
        try
        {
            return new Icon(IconFilePath());
        }
        catch
        {
            try
            {
                // Fallback: the icon embedded in the exe via <ApplicationIcon>.
                var exe = Environment.ProcessPath;
                if (!string.IsNullOrEmpty(exe))
                {
                    var embedded = Icon.ExtractAssociatedIcon(exe);
                    if (embedded is not null)
                    {
                        return embedded;
                    }
                }
            }
            catch
            {
                // fall through to the system default
            }
            return SystemIcons.Application;
        }
    }

    protected override void WndProc(ref Message m)
    {
        // Second launch wakes this instance (brief item 13): restore + focus.
        if (Program.ActivateMessage != 0 && m.Msg == Program.ActivateMessage)
        {
            RestoreFromTray();
            return;
        }
        base.WndProc(ref m);
    }
}
