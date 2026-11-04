namespace Digby.Shell;

// Window position/size persistence — the Windows replacement for the macOS
// setFrameAutosaveName (brief item 1). JSON at %LOCALAPPDATA%\Digby\window.json,
// written on close, restored on launch, centered on first run.
//
// Named WindowPlacement (not WindowState) on purpose: Form already has a
// WindowState property, and shadowing it invites subtle bugs.
internal sealed class WindowPlacement
{
    public int X { get; set; }
    public int Y { get; set; }
    public int Width { get; set; }
    public int Height { get; set; }
    public bool Maximized { get; set; }

    private static string StateFile => Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
        "Digby", "window.json");

    public static WindowPlacement Load()
    {
        try
        {
            if (File.Exists(StateFile))
            {
                var state = System.Text.Json.JsonSerializer.Deserialize<WindowPlacement>(
                    File.ReadAllText(StateFile));
                if (state is not null && state.Width > 0 && state.Height > 0)
                {
                    return state;
                }
            }
        }
        catch
        {
            // Corrupt/locked state file → fall through to defaults (first run).
        }
        return new WindowPlacement { Width = 1280, Height = 860 };
    }

    public void Save()
    {
        try
        {
            var dir = Path.GetDirectoryName(StateFile);
            if (!string.IsNullOrEmpty(dir))
            {
                Directory.CreateDirectory(dir);
            }
            File.WriteAllText(StateFile, System.Text.Json.JsonSerializer.Serialize(this));
        }
        catch
        {
            // Never let persistence kill the app.
        }
    }

    /// <summary>
    /// The saved rectangle must intersect the current virtual screen — otherwise
    /// the window restores off-screen after a monitor is unplugged (the classic
    /// lost-window trap).
    /// </summary>
    public bool IsVisibleOnAnyScreen()
    {
        return Screen.AllScreens.Any(s =>
        {
            var area = s.WorkingArea;
            return X + Width > area.Left && X < area.Right &&
                   Y + Height > area.Top && Y < area.Bottom;
        });
    }
}
