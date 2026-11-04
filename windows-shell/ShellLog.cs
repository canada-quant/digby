// Digby Windows shell (W2) — minimal file logger.
//
// The macOS shell logs nothing (NSAlert or nothing); the Windows port accepts
// bridge messages that are no-ops here (disconnectIMessage/voice; setupIMessage
// now spawns the bundled agent — see Bridge.HandleSetupIMessage)
// and "logs" is the observable half of that contract — so a plain append-only
// file under %LOCALAPPDATA%\Digby\shell.log keeps the surface debuggable
// without adding a logging dependency.

namespace Digby.Shell;

internal static class ShellLog
{
    public static readonly string LogFile = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
        "Digby", "shell.log");

    /// <summary>
    /// The log path as shown to users in error UI (StartupPanel) — forward
    /// slashes so it reads cleanly in a label and can be pasted anywhere.
    /// </summary>
    public static string LogFilePath => LogFile;

    private static readonly object Gate = new();


    public static void Info(string message) => Write("INFO ", message);

    public static void Error(string message) => Write("ERROR", message);

    private static void Write(string level, string message)
    {
        try
        {
            lock (Gate)
            {
                var dir = Path.GetDirectoryName(LogFile);
                if (!string.IsNullOrEmpty(dir))
                {
                    Directory.CreateDirectory(dir);
                }
                File.AppendAllText(LogFile,
                    $"{DateTime.UtcNow:yyyy-MM-dd'T'HH:mm:ss'Z'} {level} {message}{Environment.NewLine}");
            }
        }
        catch
        {
            // Logging must never take the shell down.
        }
    }
}
