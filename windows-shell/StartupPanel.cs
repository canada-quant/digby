namespace Digby.Shell;

// StartupPanel — the visible half of the bounded bootstrap (2026-10-09 hang fix).
//
// PROBLEM it fixes: the shell used to render NOTHING behind the WebView2 during
// startup — a hung CreateAsync / EnsureCoreWebView2Async / script registration
// left a white client area with no feedback and no error state, forever (the
// "it just spins forever" owner report). The shell had no spinner of its own,
// so the only visible state was blank white.
//
// This panel fills the client area between the menu and the WebView2:
//   LOADING  — "Opening Digby…" over a neutral background while init runs
//              (hidden once the first navigation completes).
//   ERROR    — what went wrong + which milestone hung + the log file path +
//              a Retry button (re-runs the whole bounded bootstrap).
// It is docked ABOVE the WebView2 (Controls.Add order + BringToFront), so it
// covers the blank-white window until the web app actually paints.

internal sealed partial class StartupPanel : Panel
{
    public enum Kind { Loading, Error }

    private readonly Label _title;
    private readonly Label _detail;
    private readonly Label _logHint;
    private readonly Button _retry;
    private readonly System.Windows.Forms.Timer _elapsedTimer;
    private readonly DateTime _shownAt = DateTime.UtcNow;

    private Action? _onRetry;

    public StartupPanel()
    {
        Dock = DockStyle.Fill;
        BackColor = Color.White;
        Padding = new Padding(24);

        // Centered stack — FlowLayoutPanel keeps children centered on resize.
        var stack = new FlowLayoutPanel
        {
            FlowDirection = FlowDirection.TopDown,
            WrapContents = false,
            AutoSize = true,
            Anchor = AnchorStyles.None,
        };
        // Center the stack itself: dock a host panel that centers its child.
        var host = new Panel { Dock = DockStyle.Fill };
        host.Controls.Add(stack);
        Controls.Add(host);

        _title = new Label
        {
            Text = "Opening Digby…",
            Font = new Font("Segoe UI", 13F, FontStyle.Regular),
            ForeColor = Color.FromArgb(30, 30, 32),
            AutoSize = true,
            TextAlign = ContentAlignment.MiddleCenter,
            Margin = new Padding(3, 0, 3, 4),
            MaximumSize = new Size(560, 0),
        };
        _detail = new Label
        {
            Text = "",
            Font = new Font("Segoe UI", 9.5F),
            ForeColor = Color.FromArgb(90, 90, 95),
            AutoSize = true,
            TextAlign = ContentAlignment.MiddleCenter,
            Margin = new Padding(3, 0, 3, 8),
            MaximumSize = new Size(560, 0),
        };
        _logHint = new Label
        {
            Text = "",
            Font = new Font("Segoe UI", 8.5F),
            ForeColor = Color.FromArgb(130, 130, 136),
            AutoSize = true,
            TextAlign = ContentAlignment.MiddleCenter,
            Margin = new Padding(3, 0, 3, 14),
            MaximumSize = new Size(560, 0),
        };
        _retry = new Button
        {
            Text = "Try again",
            Visible = false,
            AutoSize = true,
            Anchor = AnchorStyles.None,
            Margin = new Padding(3, 0, 3, 0),
        };
        _retry.Click += (_, _) => _onRetry?.Invoke();

        stack.Controls.Add(_title);
        stack.Controls.Add(_detail);
        stack.Controls.Add(_logHint);
        stack.Controls.Add(_retry);
        // FlowLayoutPanel cannot center its content by itself; center the
        // stack inside the host on every resize.
        host.Resize += (_, _) => CenterStack(host, stack);

        // Elapsed-seconds readout on the loading state: makes a hang visible
        // as a counting number instead of a frozen screen (and nudges the
        // user to the log file when it climbs).
        _elapsedTimer = new System.Windows.Forms.Timer { Interval = 1000 };
        _elapsedTimer.Tick += (_, _) =>
        {
            if (Visible && _retry.Visible == false)
            {
                var seconds = (int)(DateTime.UtcNow - _shownAt).TotalSeconds;
                if (seconds > 0 && seconds % 5 == 0)
                {
                    _detail.Text = $"Still starting up — {seconds}s" +
                        (seconds >= 30 ? " (details: " + ShellLog.LogFilePath + ")" : "");
                }
            }
        };
        _elapsedTimer.Start();
    }

    private static void CenterStack(Control host, Control stack)
    {
        stack.Location = new Point(
            Math.Max(0, (host.ClientSize.Width - stack.PreferredSize.Width) / 2),
            Math.Max(0, (host.ClientSize.Height - stack.PreferredSize.Height) / 2));
    }

    /// <summary>Loading state: title + sub-line while a bounded await runs.</summary>
    public void ShowLoading(string title, string detail)
    {
        _title.Text = title;
        _detail.Text = detail;
        _logHint.Text = "";
        _retry.Visible = false;
        Visible = true;
        BringToFront();
    }

    /// <summary>
    /// Error state (the visible half of "never an infinite spinner"): what
    /// hung/failed, where the diagnostics are, and Retry.
    /// </summary>
    public void ShowError(string title, string detail)
    {
        _title.Text = title;
        _detail.Text = detail;
        _logHint.Text = "Details are logged to:\n" + ShellLog.LogFilePath;
        _retry.Visible = true;
        Visible = true;
        BringToFront();
        _elapsedTimer.Stop();
    }

    /// <summary>Wire the Retry button (re-runs the bounded bootstrap).</summary>
    public void SetRetry(Action onRetry) => _onRetry = onRetry;

    /// <summary>Hide the panel — called when the first navigation completes.</summary>
    public void Dismiss()
    {
        _elapsedTimer.Stop();
        Visible = false;
    }

    protected override void Dispose(bool disposing)
    {
        if (disposing)
        {
            _elapsedTimer.Dispose();
        }
        base.Dispose(disposing);
    }
}
