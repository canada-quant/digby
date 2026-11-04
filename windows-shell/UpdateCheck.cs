namespace Digby.Shell;

// Launch update check — the port of main.swift:390-411.
//
// Fetches digby.example.com/windows-latest.json (the Windows mirror of the macOS
// desktop-latest.json feed) and compares dotted-numeric versions. On newer:
// prompt, and on Yes OPEN THE DOWNLOAD URL IN THE DEFAULT BROWSER — never
// self-update, never download in-app (the W2 rule; macOS instead loads the
// .dmg through its in-app downloader). Feed failure is silent, like macOS.
internal static class UpdateCheck
{
    private const string FeedUrl = "https://digby.example.com/windows-latest.json";

    public sealed class FeedInfo
    {
        public string Version { get; set; } = "";
        public string Url { get; set; } = "";
        public string? Notes { get; set; }
    }

    /// <summary>Fetch + compare; null when no update / any failure (silent, macOS parity).</summary>
    public static async Task<FeedInfo?> CheckAsync(HttpClient http)
    {
        try
        {
            using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(10));
            var json = await http.GetStringAsync(FeedUrl, cts.Token).ConfigureAwait(false);
            var feed = System.Text.Json.JsonSerializer.Deserialize<FeedInfo>(
                json, new System.Text.Json.JsonSerializerOptions { PropertyNameCaseInsensitive = true });
            if (feed is null || string.IsNullOrWhiteSpace(feed.Version) || string.IsNullOrWhiteSpace(feed.Url))
            {
                return null;
            }
            return IsNewer(feed.Version, Program.AppVersion) ? feed : null;
        }
        catch
        {
            return null; // feed fetch failure → silent (macOS behavior)
        }
    }

    /// <summary>
    /// Dotted-numeric comparison, the port of main.swift:403-411 isNewer:
    /// split on '.', parse ints (missing/unparseable → 0), first differing
    /// segment decides. "1.2" == "1.2.0"; "1.10" &gt; "1.9" (numeric, not lexical).
    /// </summary>
    public static bool IsNewer(string a, string b)
    {
        var pa = ParseSegments(a);
        var pb = ParseSegments(b);
        var count = Math.Max(pa.Length, pb.Length);
        for (var i = 0; i < count; i++)
        {
            var x = i < pa.Length ? pa[i] : 0;
            var y = i < pb.Length ? pb[i] : 0;
            if (x != y)
            {
                return x > y;
            }
        }
        return false;
    }

    private static int[] ParseSegments(string version)
    {
        if (string.IsNullOrEmpty(version))
        {
            return Array.Empty<int>();
        }
        var parts = version.Split('.');
        var values = new int[parts.Length];
        for (var i = 0; i < parts.Length; i++)
        {
            values[i] = int.TryParse(parts[i], out var v) ? v : 0;
        }
        return values;
    }
}
