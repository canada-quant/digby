namespace Digby.Shell;

// The JS → native bridge — the port of main.swift:47-56 + 215-233.
//
// The web app sends via window.webkit.messageHandlers.digby.postMessage(...)
// (IMessageCard.tsx:130). WebView2 has no window.webkit, so the shim injected
// below routes that call to window.chrome.webview.postMessage — the web side
// needs ZERO changes.
internal static class Bridge
{
    /// <summary>
    /// The desktop flag injected at document creation — the port of main.swift:47-56.
    /// Version comes from the assembly (AssemblyVersion 1.0.0 → "1.0.0");
    /// canSetupIMessage is TRUE: the installer bundles the W3 agent at
    /// <exe>\agent (digby.nsi SecAgent), so the web offers one-click setup
    /// (IMessageCard gates on canSetupIMessage) and setupIMessage spawns it.
    /// Plain concatenation + string.Format keeps the JS exactly as specified —
    /// no escaping surprises from interpolation/raw strings.
    /// </summary>
    public static string DesktopFlagScript => string.Concat(
        "window.__digbyDesktop = { version: \"", Program.AppVersion,
        "\", platform: \"windows\", canSetupIMessage: true };");

    /// <summary>
    /// The WebKit shim — CRITICAL for zero frontend changes (brief item 6b):
    /// the web app calls window.webkit.messageHandlers.digby.postMessage(msg),
    /// which does not exist under WebView2. This redirects it to
    /// window.chrome.webview.postMessage (the WebView2 host-message channel,
    /// wired to CoreWebView2.WebMessageReceived). Never overwrites an existing
    /// window.webkit (the `||` keeps any real one).
    /// </summary>
    public static string WebKitShimScript =>
        "window.webkit = window.webkit || { messageHandlers: { digby: { postMessage: (msg) => window.chrome.webview.postMessage(msg) } } };";

    /// <summary>
    /// Messages the web app sends today. Body must be a JSON object with a
    /// string `type`; anything else is silently ignored (main.swift:225-232
    /// guard). Every type the macOS shell handles is accepted here — surface
    /// parity — but voice is a no-op on Windows (VoiceMode is macOS-only;
    /// setupIMessage now spawns the bundled agent — see HandleSetupIMessage).
    /// </summary>
    public static void HandleWebMessage(string webMessageAsJson)
    {
        try
        {
            if (string.IsNullOrWhiteSpace(webMessageAsJson))
            {
                return;
            }
            using var doc = System.Text.Json.JsonDocument.Parse(webMessageAsJson);
            var root = doc.RootElement;
            if (root.ValueKind != System.Text.Json.JsonValueKind.Object)
            {
                return;
            }
            if (!root.TryGetProperty("type", out var typeEl) ||
                typeEl.ValueKind != System.Text.Json.JsonValueKind.String)
            {
                return;
            }
            var type = typeEl.GetString();
            if (string.IsNullOrEmpty(type))
            {
                return;
            }

            switch (type)
            {
                case "setupIMessage":
                    // One-click setup (the port of main.swift's setupIMessage): spawn the
                    // bundled W3 agent (digby.nsi SecAgent laid it at <exe>\agent) with the
                    // pairing code + api base in its env — the same DIGBY_PAIR_CODE /
                    // DIGBY_API_URL contract the installer's launch-agent.bat uses. The
                    // agent's `run` command sees the env code, pairs non-interactively
                    // (ensurePaired → pairComplete → saves %USERPROFILE%\.config\digby-agent\
                    // config.json) and enters its poll loop. Launching the agent this way
                    // does the install's autostart Run key one better: it pairs NOW instead
                    // of at next login with no code.
                    HandleSetupIMessage(ReadString(root, "pairingCode"), ReadString(root, "apiBase"));
                    break;
                case "disconnectIMessage":
                    // macOS accepts this too (dead surface from the web) — mirror: log no-op.
                    ShellLog.Info("bridge disconnectIMessage accepted (no-op on Windows)");
                    break;
                case "voice":
                    // macOS routes to VoiceMode; Windows has no voice mode — accepted +
                    // ignored, the parity of macOS's accept-unknown-silently default.
                    ShellLog.Info("bridge voice accepted (no voice mode on Windows)");
                    break;
                default:
                    break; // unknown types: silently ignored (main.swift default: break)
            }
        }
        catch (System.Text.Json.JsonException)
        {
            // Not JSON at all → macOS parity: silently ignored.
        }
    }

    private static string ReadString(System.Text.Json.JsonElement root, string property)
    {
        return root.TryGetProperty(property, out var value) &&
               value.ValueKind == System.Text.Json.JsonValueKind.String
            ? (value.GetString() ?? "")
            : "";
    }

    /// <summary>
    /// One-click setup (the port of main.swift's setupIMessage): spawn the
    /// bundled W3 agent with the pairing code in its env — the agent's
    /// non-interactive pairing path (windows-agent/src/index.ts: DIGBY_PAIR_CODE +
    /// DIGBY_API_URL → ensurePaired → pairComplete → config saved → poll loop).
    /// </summary>
    private static void HandleSetupIMessage(string pairingCode, string apiBase)
    {
        try
        {
            if (string.IsNullOrWhiteSpace(pairingCode))
            {
                ShellLog.Error("setupIMessage rejected: no pairingCode");
                return;
            }
            // The agent bundle the installer laid at <exe>\agent (digby.nsi SecAgent):
            // node.exe + dist\index.js — the exact layout launch-agent.bat launches
            // ("%DIR%node.exe" "%DIR%dist\index.js" run). The bat itself is
            // installer-staged (build-installer.sh / windows.yml), not committed, so
            // spawn node.exe directly with the same env it would set.
            var agentDir = Path.Combine(AppContext.BaseDirectory, "agent");
            var nodeExe = Path.Combine(agentDir, "node.exe");
            var agentEntry = Path.Combine(agentDir, "dist", "index.js");
            if (!File.Exists(nodeExe) || !File.Exists(agentEntry))
            {
                ShellLog.Error("setupIMessage: no bundled agent at " + agentDir);
                return;
            }

            // The agent's own log — SecAgent creates %LOCALAPPDATA%\Digby and the
            // bat appends there (`>> agent.log 2>&1`); this spawn mirrors that.
            var agentLogDir = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                "Digby");
            var agentLogPath = Path.Combine(agentLogDir, "agent.log");
            Directory.CreateDirectory(agentLogDir);

            var startInfo = new System.Diagnostics.ProcessStartInfo
            {
                FileName = nodeExe,
                Arguments = "\"" + agentEntry + "\" run",
                WorkingDirectory = agentDir,
                UseShellExecute = false,
                CreateNoWindow = true,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
            };
            // The pairing contract (windows-agent/src/index.ts): DIGBY_PAIR_CODE +
            // DIGBY_API_URL make `run` pair non-interactively — ensurePaired reads
            // the env before ever prompting for a code — then the poll loop starts.
            startInfo.EnvironmentVariables["DIGBY_PAIR_CODE"] = pairingCode;
            startInfo.EnvironmentVariables["DIGBY_API_URL"] =
                string.IsNullOrWhiteSpace(apiBase) ? "https://digby.example.com/api" : apiBase;

            // NOT `using` — the detached log-pump task below owns the handle.
            var process = System.Diagnostics.Process.Start(startInfo);
            if (process == null)
            {
                ShellLog.Error("setupIMessage: failed to start the bundled agent");
                return;
            }

            // Mirror the bat's `>> agent.log 2>&1`: pump BOTH streams (concurrently —
            // sequential reads can deadlock on a full pipe) into the agent log once
            // the agent exits; the poll loop owns the process while it lives.
            _ = Task.Run(async () =>
            {
                var stdoutTask = process.StandardOutput.ReadToEndAsync();
                var stderrTask = process.StandardError.ReadToEndAsync();
                var output = await stdoutTask + await stderrTask;
                await process.WaitForExitAsync();
                try
                {
                    await File.AppendAllTextAsync(agentLogPath, output);
                }
                catch
                {
                    // Best-effort: the shell log still records the spawn + exit.
                }
                ShellLog.Info("setupIMessage: agent exited (code " + process.ExitCode + ")");
            });
            ShellLog.Info("setupIMessage: spawned the bundled agent (pid " + process.Id + ")");
        }
        catch (Exception ex)
        {
            ShellLog.Error("setupIMessage failed: " + ex.Message);
        }
    }
}
