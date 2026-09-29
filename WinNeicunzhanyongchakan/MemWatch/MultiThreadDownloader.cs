using System.Diagnostics;
using System.Net.Http.Headers;
using System.Text;
using System.Text.RegularExpressions;

namespace MemWatch;

internal enum DownloadJobState
{
    Queued,
    Probing,
    Running,
    Paused,
    Completed,
    Failed,
    Cancelled
}

internal sealed class DownloadJob
{
    public string Id { get; } = Guid.NewGuid().ToString("N");
    /// <summary>用户输入的原始链接（可能是包装页）。</summary>
    public string Url { get; init; } = "";
    /// <summary>解析后的真实下载地址。</summary>
    public string ResolvedUrl { get; set; } = "";
    public string FileName { get; set; } = "";
    public string SavePath { get; set; } = "";
    public int ThreadCount { get; set; } = 8;
    public DownloadJobState State { get; set; } = DownloadJobState.Queued;
    public long TotalBytes { get; set; } = -1;
    public long DownloadedBytes { get; set; }
    public double SpeedBytesPerSec { get; set; }
    public string Message { get; set; } = "";
    public bool FromAutoDetect { get; set; }
    public CancellationTokenSource? Cts { get; set; }

    public double Progress01 =>
        TotalBytes > 0 ? Math.Clamp((double)DownloadedBytes / TotalBytes, 0, 1) : 0;

    public string EffectiveUrl =>
        !string.IsNullOrWhiteSpace(ResolvedUrl) ? ResolvedUrl : Url;
}

/// <summary>多连接分段 HTTP 下载；不支持 Range 时回退单线程。</summary>
internal static class MultiThreadDownloader
{
    private static readonly HttpClient Http = CreateClient();
    private static readonly string[] FileExtHints =
    {
        ".zip", ".rar", ".7z", ".exe", ".msi", ".msix", ".iso", ".img",
        ".mp4", ".mkv", ".avi", ".mp3", ".flac", ".wav",
        ".pdf", ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx",
        ".apk", ".dmg", ".pkg", ".deb", ".rpm", ".gz", ".bz2", ".xz",
        ".png", ".jpg", ".jpeg", ".gif", ".webp", ".psd", ".ai",
        ".torrent", ".crx", ".vsix", ".nupkg"
    };

    private static HttpClient CreateClient()
    {
        var handler = new HttpClientHandler
        {
            AllowAutoRedirect = true,
            MaxAutomaticRedirections = 12,
            AutomaticDecompression = System.Net.DecompressionMethods.All
        };
        var c = new HttpClient(handler)
        {
            Timeout = TimeSpan.FromHours(6)
        };
        c.DefaultRequestHeaders.UserAgent.ParseAdd(
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36");
        c.DefaultRequestHeaders.Accept.ParseAdd("*/*");
        return c;
    }

    public static bool TryExtractUrl(string? text, out string url)
    {
        url = "";
        if (string.IsNullOrWhiteSpace(text))
            return false;

        text = text.Trim().Trim('"', '\'', '<', '>', '“', '”');
        // 取第一段 http(s) URL
        var m = Regex.Match(text, @"https?://[^\s<>""']+", RegexOptions.IgnoreCase);
        if (!m.Success)
            return false;

        url = m.Value.TrimEnd('.', ',', ';', ')', ']', '}', '>', '"', '\'');
        return Uri.TryCreate(url, UriKind.Absolute, out var uri)
               && (uri.Scheme == Uri.UriSchemeHttp || uri.Scheme == Uri.UriSchemeHttps);
    }

    /// <summary>探测结果：含解析后的真实 URL。</summary>
    public readonly record struct ProbeResult(
        bool Downloadable,
        string RealUrl,
        string? FileName,
        long? Length,
        string Reason);

    /// <summary>判断链接是否像可下载文件；若是包装页则尝试解开真实直链。</summary>
    public static async Task<ProbeResult> ProbeAsync(string url, CancellationToken ct)
    {
        try
        {
            var resolved = await ResolveRealDownloadUrlAsync(url, ct);
            if (resolved.IsDirectFile)
            {
                return new ProbeResult(true, resolved.FinalUrl, resolved.FileName, resolved.Length,
                    resolved.Reason);
            }

            // 解析出了更像文件的候选
            if (!string.Equals(resolved.FinalUrl, url, StringComparison.OrdinalIgnoreCase)
                && (LooksLikeFileUrl(resolved.FinalUrl) || resolved.Score >= 80))
            {
                return new ProbeResult(true, resolved.FinalUrl, resolved.FileName ?? GuessFileName(resolved.FinalUrl, null),
                    resolved.Length, resolved.Reason);
            }

            return new ProbeResult(false, resolved.FinalUrl, resolved.FileName, resolved.Length, resolved.Reason);
        }
        catch (Exception ex)
        {
            if (LooksLikeFileUrl(url))
                return new ProbeResult(true, url, GuessFileName(url, null), null, ex.Message);
            return new ProbeResult(false, url, null, null, ex.Message);
        }
    }

    internal sealed class ResolveState
    {
        public string FinalUrl = "";
        public string? FileName;
        public long? Length;
        public bool IsDirectFile;
        public int Score;
        public string Reason = "";
    }

    /// <summary>
    /// 解开封装链接：先 HEAD/Range 轻量探测，仅在确认是 HTML/JSON 包装页时才读正文。
    /// </summary>
    public static async Task<ResolveState> ResolveRealDownloadUrlAsync(
        string startUrl, CancellationToken ct, int maxHops = 5)
    {
        var current = startUrl;
        var visited = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        ResolveState? bestFileCandidate = null;

        for (var hop = 0; hop < maxHops; hop++)
        {
            ct.ThrowIfCancellationRequested();
            if (!visited.Add(NormalizeUrlKey(current)))
                break;

            // 轻量探测：避免对大文件发完整 GET（否则会卡死/占满带宽）
            var probe = await ProbeHeadersAsync(current, ct).ConfigureAwait(false);
            current = probe.FinalUrl;

            if (probe.IsDirect)
            {
                return new ResolveState
                {
                    FinalUrl = probe.FinalUrl,
                    FileName = GuessFileName(probe.FinalUrl, probe.ContentDisposition),
                    Length = probe.Length,
                    IsDirectFile = true,
                    Score = 1000,
                    Reason = hop == 0
                        ? probe.Reason
                        : L.T($"已解开封装 → {probe.Reason}", $"Unwrapped → {probe.Reason}")
                };
            }

            if (!probe.IsHtml && !probe.IsJson)
            {
                if (LooksLikeFileUrl(probe.FinalUrl))
                {
                    return new ResolveState
                    {
                        FinalUrl = probe.FinalUrl,
                        FileName = GuessFileName(probe.FinalUrl, probe.ContentDisposition),
                        Length = probe.Length,
                        IsDirectFile = true,
                        Score = 900,
                        Reason = L.T("重定向后的文件链接", "File URL after redirects")
                    };
                }

                break;
            }

            // 仅包装页才拉有限正文
            var body = await FetchBodyLimitedAsync(probe.FinalUrl, maxBytes: 512 * 1024, ct).ConfigureAwait(false);
            var baseUri = new Uri(probe.FinalUrl);
            var candidates = probe.IsJson
                ? ExtractUrlsFromJson(body, baseUri)
                : ExtractUrlsFromHtml(body, baseUri);

            if (candidates.Count == 0)
            {
                return new ResolveState
                {
                    FinalUrl = probe.FinalUrl,
                    FileName = GuessFileName(probe.FinalUrl, null),
                    Length = probe.Length,
                    IsDirectFile = false,
                    Score = 0,
                    Reason = L.T("包装页中未找到下载链接", "No download link found in wrapper page")
                };
            }

            var ranked = candidates
                .Select(u => (Url: u, Score: ScoreCandidate(u, body, baseUri)))
                .OrderByDescending(x => x.Score)
                .ToList();

            var top = ranked[0];
            if (bestFileCandidate is null || top.Score > bestFileCandidate.Score)
            {
                bestFileCandidate = new ResolveState
                {
                    FinalUrl = top.Url,
                    FileName = GuessFileName(top.Url, null),
                    Length = null,
                    IsDirectFile = LooksLikeFileUrl(top.Url),
                    Score = top.Score,
                    Reason = L.T($"从包装页解析到候选（分 {top.Score}）", $"Candidate from wrapper (score {top.Score})")
                };
            }

            if (top.Score >= 40 && !string.Equals(top.Url, probe.FinalUrl, StringComparison.OrdinalIgnoreCase))
            {
                current = top.Url;
                continue;
            }

            break;
        }

        if (bestFileCandidate is not null && bestFileCandidate.Score >= 50)
        {
            bestFileCandidate.Reason = L.T(
                $"已从封装链接解析真实地址（分 {bestFileCandidate.Score}）",
                $"Resolved real URL from wrapper (score {bestFileCandidate.Score})");
            return bestFileCandidate;
        }

        return new ResolveState
        {
            FinalUrl = current,
            FileName = GuessFileName(current, null),
            IsDirectFile = LooksLikeFileUrl(current),
            Score = LooksLikeFileUrl(current) ? 70 : 0,
            Reason = LooksLikeFileUrl(current)
                ? L.T("按链接形态判断为文件", "Looks like a file URL")
                : L.T("未能解开真实下载链接", "Could not unwrap real download URL")
        };
    }

    private readonly struct HeaderProbe
    {
        public string FinalUrl { get; init; }
        public bool IsDirect { get; init; }
        public bool IsHtml { get; init; }
        public bool IsJson { get; init; }
        public long? Length { get; init; }
        public ContentDispositionHeaderValue? ContentDisposition { get; init; }
        public string Reason { get; init; }
    }

    private static async Task<HeaderProbe> ProbeHeadersAsync(string url, CancellationToken ct)
    {
        // 1) HEAD
        try
        {
            using var headReq = new HttpRequestMessage(HttpMethod.Head, url);
            headReq.Headers.TryAddWithoutValidation("Accept", "*/*");
            using var headResp = await Http.SendAsync(headReq, HttpCompletionOption.ResponseHeadersRead, ct)
                .ConfigureAwait(false);
            if (headResp.IsSuccessStatusCode)
                return ClassifyHeaders(headResp);
        }
        catch
        {
            // fall through
        }

        // 2) Range GET 只取 1 字节，避免拉全文件
        using var getReq = new HttpRequestMessage(HttpMethod.Get, url);
        getReq.Headers.Range = new RangeHeaderValue(0, 0);
        getReq.Headers.TryAddWithoutValidation("Accept",
            "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8");
        using var getResp = await Http.SendAsync(getReq, HttpCompletionOption.ResponseHeadersRead, ct)
            .ConfigureAwait(false);

        var classified = ClassifyHeaders(getResp);
        // 尽快丢掉仅 1 字节的响应体
        try
        {
            await getResp.Content.CopyToAsync(Stream.Null, ct).ConfigureAwait(false);
        }
        catch
        {
            // ignore
        }

        return classified;
    }

    private static HeaderProbe ClassifyHeaders(HttpResponseMessage resp)
    {
        var finalUrl = resp.RequestMessage?.RequestUri?.ToString() ?? resp.RequestMessage?.RequestUri?.AbsoluteUri ?? "";
        if (string.IsNullOrEmpty(finalUrl) && resp.Headers.Location is not null)
            finalUrl = resp.Headers.Location.ToString();
        if (string.IsNullOrEmpty(finalUrl))
            finalUrl = resp.RequestMessage?.RequestUri?.ToString() ?? "";

        // RequestUri after redirect
        finalUrl = resp.RequestMessage?.RequestUri?.ToString() ?? finalUrl;

        long? length = resp.Content.Headers.ContentLength;
        if (resp.Content.Headers.ContentRange?.Length is long total)
            length = total;

        var media = resp.Content.Headers.ContentType?.MediaType ?? "";
        var isHtml = media.Contains("html", StringComparison.OrdinalIgnoreCase)
                     || media.Contains("xhtml", StringComparison.OrdinalIgnoreCase);
        var isJson = media.Contains("json", StringComparison.OrdinalIgnoreCase);

        if (IsDirectDownloadResponse(resp, finalUrl, out var reason))
        {
            return new HeaderProbe
            {
                FinalUrl = finalUrl,
                IsDirect = true,
                IsHtml = false,
                IsJson = false,
                Length = length,
                ContentDisposition = resp.Content.Headers.ContentDisposition,
                Reason = reason
            };
        }

        return new HeaderProbe
        {
            FinalUrl = finalUrl,
            IsDirect = false,
            IsHtml = isHtml,
            IsJson = isJson,
            Length = length,
            ContentDisposition = resp.Content.Headers.ContentDisposition,
            Reason = ""
        };
    }

    private static async Task<string> FetchBodyLimitedAsync(string url, int maxBytes, CancellationToken ct)
    {
        using var req = new HttpRequestMessage(HttpMethod.Get, url);
        req.Headers.TryAddWithoutValidation("Accept",
            "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8");
        using var resp = await Http.SendAsync(req, HttpCompletionOption.ResponseHeadersRead, ct)
            .ConfigureAwait(false);
        resp.EnsureSuccessStatusCode();
        return await ReadBodyLimitedAsync(resp, maxBytes, ct).ConfigureAwait(false);
    }

    private static List<string> ExtractUrlsFromHtml(string html, Uri baseUri)
    {
        var set = new Dictionary<string, int>(StringComparer.OrdinalIgnoreCase);

        void Add(string? raw, int bonus = 0)
        {
            if (string.IsNullOrWhiteSpace(raw))
                return;
            raw = HtmlDecode(raw.Trim().Trim('"', '\'', '`'));
            if (raw.StartsWith("//", StringComparison.Ordinal))
                raw = baseUri.Scheme + ":" + raw;
            if (!Uri.TryCreate(baseUri, raw, out var abs))
                return;
            if (abs.Scheme != Uri.UriSchemeHttp && abs.Scheme != Uri.UriSchemeHttps)
                return;
            var s = abs.ToString();
            if (s.StartsWith("javascript:", StringComparison.OrdinalIgnoreCase)
                || s.StartsWith("mailto:", StringComparison.OrdinalIgnoreCase)
                || s.StartsWith("data:", StringComparison.OrdinalIgnoreCase))
                return;
            set[s] = Math.Max(set.GetValueOrDefault(s), bonus);
        }

        // meta refresh
        foreach (Match m in Regex.Matches(html,
                     @"<meta[^>]+http-equiv\s*=\s*[""']?refresh[""']?[^>]+content\s*=\s*[""']?\d+\s*;\s*url\s*=\s*([^""'\s>]+)",
                     RegexOptions.IgnoreCase))
            Add(m.Groups[1].Value, 90);

        foreach (Match m in Regex.Matches(html,
                     @"content\s*=\s*[""']?\d+\s*;\s*url\s*=\s*([^""'\s>]+)",
                     RegexOptions.IgnoreCase))
            Add(m.Groups[1].Value, 85);

        // location / window.location
        foreach (Match m in Regex.Matches(html,
                     @"(?:window\.)?location(?:\.href)?\s*=\s*[""'](https?://[^""']+|/?[^""']+)[""']",
                     RegexOptions.IgnoreCase))
            Add(m.Groups[1].Value, 88);

        foreach (Match m in Regex.Matches(html,
                     @"location\.replace\s*\(\s*[""'](https?://[^""']+|/?[^""']+)[""']",
                     RegexOptions.IgnoreCase))
            Add(m.Groups[1].Value, 88);

        // download 属性链接
        foreach (Match m in Regex.Matches(html,
                     @"<a[^>]+href\s*=\s*[""']([^""']+)[""'][^>]*\bdownload\b",
                     RegexOptions.IgnoreCase))
            Add(m.Groups[1].Value, 95);

        foreach (Match m in Regex.Matches(html,
                     @"\bdownload\b[^>]*href\s*=\s*[""']([^""']+)[""']",
                     RegexOptions.IgnoreCase))
            Add(m.Groups[1].Value, 95);

        // 普通 href / src
        foreach (Match m in Regex.Matches(html,
                     @"\b(?:href|src)\s*=\s*[""']([^""']+)[""']",
                     RegexOptions.IgnoreCase))
        {
            var v = m.Groups[1].Value;
            var bonus = LooksLikeFileUrl(v) || LooksLikeFileUrl(MakeAbs(baseUri, v)) ? 70 : 10;
            if (Regex.IsMatch(v, @"download|attachment|getfile|fileid|dl\.|mirror", RegexOptions.IgnoreCase))
                bonus += 25;
            Add(v, bonus);
        }

        // 查询参数里的嵌套 URL
        foreach (Match m in Regex.Matches(html,
                     @"(?:url|target|link|file|download|redirect|dest|to|jump|u)\s*[=:]\s*[""']?(https?://[^""'\s<>]+)",
                     RegexOptions.IgnoreCase))
            Add(m.Groups[1].Value, 75);

        foreach (Match m in Regex.Matches(html,
                     @"(?:url|target|link|file|download|redirect)\s*[=:]\s*[""']?((?:%2[Ff]|/)[^""'\s<>]+)",
                     RegexOptions.IgnoreCase))
        {
            try
            {
                Add(Uri.UnescapeDataString(m.Groups[1].Value), 70);
            }
            catch
            {
                Add(m.Groups[1].Value, 60);
            }
        }

        // iframe
        foreach (Match m in Regex.Matches(html,
                     @"<iframe[^>]+src\s*=\s*[""']([^""']+)[""']",
                     RegexOptions.IgnoreCase))
            Add(m.Groups[1].Value, 50);

        return set.OrderByDescending(kv => kv.Value).Select(kv => kv.Key).Take(40).ToList();
    }

    private static List<string> ExtractUrlsFromJson(string json, Uri baseUri)
    {
        var list = new List<string>();
        foreach (Match m in Regex.Matches(json, @"https?://[^""'\s\\]+", RegexOptions.IgnoreCase))
        {
            var u = m.Value.TrimEnd('\\', ',', '}', ']');
            if (Uri.TryCreate(u, UriKind.Absolute, out _))
                list.Add(u);
        }

        foreach (Match m in Regex.Matches(json,
                     @"""(?:url|downloadUrl|download_url|fileUrl|file_url|link|href|src)""\s*:\s*""([^""]+)""",
                     RegexOptions.IgnoreCase))
        {
            var raw = Regex.Unescape(m.Groups[1].Value);
            if (Uri.TryCreate(baseUri, raw, out var abs)
                && (abs.Scheme == Uri.UriSchemeHttp || abs.Scheme == Uri.UriSchemeHttps))
                list.Add(abs.ToString());
        }

        return list.Distinct(StringComparer.OrdinalIgnoreCase).Take(40).ToList();
    }

    private static int ScoreCandidate(string url, string pageHtml, Uri pageUri)
    {
        var score = 0;
        if (!Uri.TryCreate(url, UriKind.Absolute, out var uri))
            return 0;

        if (LooksLikeFileUrl(url))
            score += 100;

        var path = uri.AbsolutePath + uri.Query;
        if (Regex.IsMatch(path, @"download|attachment|getfile|fileid|/dl/|mirror|release", RegexOptions.IgnoreCase))
            score += 35;

        foreach (var ext in FileExtHints)
        {
            if (path.Contains(ext, StringComparison.OrdinalIgnoreCase))
            {
                score += 20;
                break;
            }
        }

        if (string.Equals(uri.Host, pageUri.Host, StringComparison.OrdinalIgnoreCase))
            score += 8;
        else if (uri.Host.Contains("cdn", StringComparison.OrdinalIgnoreCase)
                 || uri.Host.Contains("download", StringComparison.OrdinalIgnoreCase)
                 || uri.Host.Contains("github", StringComparison.OrdinalIgnoreCase)
                 || uri.Host.Contains("sourceforge", StringComparison.OrdinalIgnoreCase)
                 || uri.Host.Contains("googleusercontent", StringComparison.OrdinalIgnoreCase))
            score += 25;

        // 页面上下文：靠近「下载」字样的链接加分（粗略）
        var idx = pageHtml.IndexOf(uri.AbsolutePath, StringComparison.OrdinalIgnoreCase);
        if (idx < 0)
            idx = pageHtml.IndexOf(url, StringComparison.OrdinalIgnoreCase);
        if (idx >= 0)
        {
            var start = Math.Max(0, idx - 80);
            var len = Math.Min(160, pageHtml.Length - start);
            var ctx = pageHtml.AsSpan(start, len);
            if (ctx.Contains("download", StringComparison.OrdinalIgnoreCase)
                || ctx.Contains("下载", StringComparison.Ordinal)
                || ctx.Contains("下载地址", StringComparison.Ordinal)
                || ctx.Contains("本地下载", StringComparison.Ordinal)
                || ctx.Contains("点击下载", StringComparison.Ordinal))
                score += 40;
        }

        // 排除明显非文件页
        if (path.EndsWith(".html", StringComparison.OrdinalIgnoreCase)
            || path.EndsWith(".htm", StringComparison.OrdinalIgnoreCase)
            || path.EndsWith(".php", StringComparison.OrdinalIgnoreCase)
            || path.EndsWith(".aspx", StringComparison.OrdinalIgnoreCase))
        {
            if (!uri.Query.Contains("download", StringComparison.OrdinalIgnoreCase)
                && !LooksLikeFileUrl(url))
                score -= 40;
        }

        return score;
    }

    private static string MakeAbs(Uri baseUri, string raw)
    {
        try
        {
            return Uri.TryCreate(baseUri, raw, out var u) ? u.ToString() : raw;
        }
        catch
        {
            return raw;
        }
    }

    private static string NormalizeUrlKey(string url)
    {
        try
        {
            var u = new Uri(url);
            return u.GetLeftPart(UriPartial.Path).TrimEnd('/').ToLowerInvariant() + u.Query;
        }
        catch
        {
            return url.Trim().ToLowerInvariant();
        }
    }

    private static string HtmlDecode(string s)
    {
        return s
            .Replace("&amp;", "&", StringComparison.OrdinalIgnoreCase)
            .Replace("&quot;", "\"", StringComparison.OrdinalIgnoreCase)
            .Replace("&#39;", "'", StringComparison.OrdinalIgnoreCase)
            .Replace("&lt;", "<", StringComparison.OrdinalIgnoreCase)
            .Replace("&gt;", ">", StringComparison.OrdinalIgnoreCase);
    }

    private static bool IsDirectDownloadResponse(HttpResponseMessage resp, string url, out string reason)
    {
        reason = "";
        if (!resp.IsSuccessStatusCode && (int)resp.StatusCode is not (>= 200 and < 400 or 206))
            return false;

        var cd = resp.Content.Headers.ContentDisposition;
        if (cd?.DispositionType.Equals("attachment", StringComparison.OrdinalIgnoreCase) == true
            || !string.IsNullOrWhiteSpace(cd?.FileName) || !string.IsNullOrWhiteSpace(cd?.FileNameStar))
        {
            reason = L.T("浏览器附件下载", "Attachment download");
            return true;
        }

        var ct = resp.Content.Headers.ContentType?.MediaType ?? "";
        if (IsBinaryContentType(ct))
        {
            reason = $"Content-Type: {ct}";
            return true;
        }

        if (LooksLikeFileUrl(url) && !ct.Contains("html", StringComparison.OrdinalIgnoreCase)
            && !ct.Contains("json", StringComparison.OrdinalIgnoreCase)
            && !ct.Contains("javascript", StringComparison.OrdinalIgnoreCase))
        {
            if (string.IsNullOrEmpty(ct) || !ct.StartsWith("text/", StringComparison.OrdinalIgnoreCase))
            {
                reason = L.T("文件扩展名", "File extension");
                return true;
            }
        }

        long? length = resp.Content.Headers.ContentLength;
        if (resp.Content.Headers.ContentRange?.Length is long total)
            length = total;
        if (length is > 256 * 1024 && IsBinaryContentType(ct))
        {
            reason = L.T("较大二进制响应", "Large binary response");
            return true;
        }

        return false;
    }

    private static async Task<string> ReadBodyLimitedAsync(HttpResponseMessage resp, int maxBytes, CancellationToken ct)
    {
        await using var stream = await resp.Content.ReadAsStreamAsync(ct).ConfigureAwait(false);
        using var ms = new MemoryStream(Math.Min(maxBytes, 256 * 1024));
        var buffer = new byte[64 * 1024];
        var total = 0;
        while (total < maxBytes)
        {
            var n = await stream.ReadAsync(buffer.AsMemory(0, Math.Min(buffer.Length, maxBytes - total)), ct)
                .ConfigureAwait(false);
            if (n <= 0)
                break;
            ms.Write(buffer, 0, n);
            total += n;
        }

        var charset = resp.Content.Headers.ContentType?.CharSet;
        Encoding enc;
        try
        {
            enc = !string.IsNullOrWhiteSpace(charset) ? Encoding.GetEncoding(charset) : Encoding.UTF8;
        }
        catch
        {
            enc = Encoding.UTF8;
        }

        return enc.GetString(ms.ToArray());
    }

    private static (bool Downloadable, string? FileName, long? Length, string Reason) AnalyzeResponse(
        string url, HttpResponseMessage resp)
    {
        if (IsDirectDownloadResponse(resp, url, out var reason))
        {
            return (true, GuessFileName(url, resp.Content.Headers.ContentDisposition),
                resp.Content.Headers.ContentLength, reason);
        }

        var ct = resp.Content.Headers.ContentType?.MediaType ?? "";
        if (ct.Contains("text/html", StringComparison.OrdinalIgnoreCase))
            return (false, null, null, L.T("网页，非文件", "Web page, not a file"));

        return (false, null, null, L.T("不像可下载文件", "Does not look downloadable"));
    }

    private static bool IsBinaryContentType(string ct)
    {
        if (string.IsNullOrWhiteSpace(ct))
            return false;
        ct = ct.ToLowerInvariant();
        if (ct.StartsWith("text/", StringComparison.Ordinal))
            return false;
        if (ct.Contains("html", StringComparison.Ordinal) || ct.Contains("javascript", StringComparison.Ordinal)
            || ct.Contains("json", StringComparison.Ordinal) || ct.Contains("xml", StringComparison.Ordinal))
            return false;
        return ct.StartsWith("application/", StringComparison.Ordinal)
               || ct.StartsWith("image/", StringComparison.Ordinal)
               || ct.StartsWith("audio/", StringComparison.Ordinal)
               || ct.StartsWith("video/", StringComparison.Ordinal)
               || ct.Contains("octet-stream", StringComparison.Ordinal)
               || ct.Contains("zip", StringComparison.Ordinal);
    }

    public static bool LooksLikeFileUrl(string url)
    {
        if (!Uri.TryCreate(url, UriKind.Absolute, out var uri))
            return false;
        var path = uri.AbsolutePath;
        foreach (var ext in FileExtHints)
        {
            if (path.EndsWith(ext, StringComparison.OrdinalIgnoreCase))
                return true;
        }

        // query 里常见 download=
        if (uri.Query.Contains("download=", StringComparison.OrdinalIgnoreCase)
            || uri.Query.Contains("attachment", StringComparison.OrdinalIgnoreCase))
            return true;
        return false;
    }

    public static string GuessFileName(string url, ContentDispositionHeaderValue? cd)
    {
        try
        {
            if (cd != null)
            {
                var n = cd.FileNameStar ?? cd.FileName;
                if (!string.IsNullOrWhiteSpace(n))
                {
                    n = n.Trim().Trim('"');
                    n = Path.GetFileName(n);
                    if (!string.IsNullOrWhiteSpace(n))
                        return SanitizeFileName(n);
                }
            }
        }
        catch
        {
            // ignore
        }

        if (Uri.TryCreate(url, UriKind.Absolute, out var uri))
        {
            var name = Path.GetFileName(uri.LocalPath);
            if (!string.IsNullOrWhiteSpace(name) && name.Contains('.', StringComparison.Ordinal))
                return SanitizeFileName(Uri.UnescapeDataString(name));
        }

        return $"download_{DateTime.Now:yyyyMMdd_HHmmss}.bin";
    }

    public static string SanitizeFileName(string name)
    {
        foreach (var c in Path.GetInvalidFileNameChars())
            name = name.Replace(c, '_');
        name = name.Trim().TrimEnd('.');
        return string.IsNullOrWhiteSpace(name) ? "download.bin" : name;
    }

    public static string UniquePath(string dir, string fileName)
    {
        Directory.CreateDirectory(dir);
        var dest = Path.Combine(dir, fileName);
        if (!File.Exists(dest))
            return dest;
        var stem = Path.GetFileNameWithoutExtension(fileName);
        var ext = Path.GetExtension(fileName);
        for (var i = 1; i < 10000; i++)
        {
            var p = Path.Combine(dir, $"{stem}_{i}{ext}");
            if (!File.Exists(p))
                return p;
        }

        return Path.Combine(dir, $"{stem}_{Guid.NewGuid():N}{ext}");
    }

    public static async Task RunAsync(DownloadJob job, IProgress<DownloadJob>? progress, CancellationToken ct)
    {
        job.State = DownloadJobState.Probing;
        job.Message = L.T("解析真实下载地址…", "Resolving real download URL…");
        progress?.Report(job);

        using var linked = CancellationTokenSource.CreateLinkedTokenSource(ct, job.Cts?.Token ?? CancellationToken.None);
        var token = linked.Token;

        try
        {
            var resolved = await ResolveRealDownloadUrlAsync(job.Url, token).ConfigureAwait(false);
            job.ResolvedUrl = resolved.FinalUrl;
            if (!string.IsNullOrWhiteSpace(resolved.FileName)
                && (string.IsNullOrWhiteSpace(job.FileName)
                    || job.FileName.StartsWith("download_", StringComparison.OrdinalIgnoreCase)))
            {
                job.FileName = resolved.FileName;
            }

            if (!resolved.IsDirectFile && !LooksLikeFileUrl(resolved.FinalUrl) && resolved.Score < 50)
                throw new InvalidOperationException(resolved.Reason);

            job.Message = string.Equals(job.Url, job.ResolvedUrl, StringComparison.OrdinalIgnoreCase)
                ? L.T("探测中…", "Probing…")
                : L.T("已解析直链，探测中…", "Direct URL resolved, probing…");
            progress?.Report(job);

            long contentLength = -1;
            var acceptRanges = false;
            var finalUrl = job.EffectiveUrl;

            using (var probeReq = new HttpRequestMessage(HttpMethod.Get, finalUrl))
            {
                probeReq.Headers.Range = new RangeHeaderValue(0, 0);
                using var probeResp = await Http.SendAsync(probeReq, HttpCompletionOption.ResponseHeadersRead, token)
                    .ConfigureAwait(false);
                probeResp.EnsureSuccessStatusCode();
                finalUrl = probeResp.RequestMessage?.RequestUri?.ToString() ?? finalUrl;
                job.ResolvedUrl = finalUrl;

                if (string.IsNullOrWhiteSpace(job.FileName)
                    || job.FileName.StartsWith("download_", StringComparison.OrdinalIgnoreCase))
                {
                    job.FileName = GuessFileName(finalUrl, probeResp.Content.Headers.ContentDisposition);
                }

                if (probeResp.Content.Headers.ContentRange?.Length is long total)
                    contentLength = total;
                else if (probeResp.Content.Headers.ContentLength is long len
                         && probeResp.StatusCode != System.Net.HttpStatusCode.PartialContent)
                    contentLength = len;

                acceptRanges = probeResp.StatusCode == System.Net.HttpStatusCode.PartialContent
                               || string.Equals(probeResp.Headers.AcceptRanges?.ToString(), "bytes",
                                   StringComparison.OrdinalIgnoreCase);

                var media = probeResp.Content.Headers.ContentType?.MediaType ?? "";
                if (media.Contains("html", StringComparison.OrdinalIgnoreCase)
                    && !IsDirectDownloadResponse(probeResp, finalUrl, out _))
                {
                    throw new InvalidOperationException(L.T(
                        "目标仍是网页，未能找到真实文件链接。请尝试在浏览器中右键「复制链接地址」后再下。",
                        "Still an HTML page; real file URL not found. Try copying the direct link from the browser."));
                }

                try
                {
                    await probeResp.Content.CopyToAsync(Stream.Null, token).ConfigureAwait(false);
                }
                catch
                {
                    // ignore
                }
            }

            if (string.IsNullOrWhiteSpace(job.SavePath))
            {
                var dir = Path.Combine(
                    Environment.GetFolderPath(Environment.SpecialFolder.UserProfile),
                    "Downloads");
                job.SavePath = UniquePath(dir, job.FileName);
                job.FileName = Path.GetFileName(job.SavePath);
            }
            else
            {
                var dir = Path.GetDirectoryName(job.SavePath);
                if (!string.IsNullOrEmpty(dir))
                {
                    var newPath = UniquePath(dir, job.FileName);
                    if (!string.Equals(newPath, job.SavePath, StringComparison.OrdinalIgnoreCase))
                    {
                        job.SavePath = newPath;
                        job.FileName = Path.GetFileName(newPath);
                    }
                }
            }

            job.TotalBytes = contentLength;
            job.DownloadedBytes = 0;
            job.State = DownloadJobState.Running;
            job.Message = L.T("下载中…", "Downloading…");
            progress?.Report(job);

            var threads = Math.Clamp(job.ThreadCount, 1, 16);
            if (!acceptRanges || contentLength <= 0 || contentLength < 256 * 1024)
                threads = 1;

            var speedSw = Stopwatch.StartNew();
            long lastBytes = 0;
            var lastTick = TimeSpan.Zero;
            var lastUi = Stopwatch.StartNew();

            void OnProgressTick()
            {
                token.ThrowIfCancellationRequested();

                var now = speedSw.Elapsed;
                var dt = (now - lastTick).TotalSeconds;
                if (dt >= 0.25)
                {
                    job.SpeedBytesPerSec = (job.DownloadedBytes - lastBytes) / dt;
                    lastBytes = job.DownloadedBytes;
                    lastTick = now;
                }

                // 限制 UI 刷新频率，避免卡死
                if (lastUi.ElapsedMilliseconds >= 300)
                {
                    lastUi.Restart();
                    progress?.Report(job);
                }
            }

            if (threads == 1)
                await DownloadSingleAsync(finalUrl, job, OnProgressTick, token).ConfigureAwait(false);
            else
                await DownloadSegmentedAsync(finalUrl, job, contentLength, threads, OnProgressTick, token)
                    .ConfigureAwait(false);

            token.ThrowIfCancellationRequested();
            job.DownloadedBytes = job.TotalBytes > 0 ? job.TotalBytes : job.DownloadedBytes;
            job.State = DownloadJobState.Completed;
            job.SpeedBytesPerSec = 0;
            job.Message = L.T("完成", "Done");
            progress?.Report(job);
        }
        catch (OperationCanceledException)
        {
            job.State = DownloadJobState.Cancelled;
            job.Message = L.T("已中止", "Stopped");
            progress?.Report(job);
            TryDeletePartial(job.SavePath);
        }
        catch (Exception ex)
        {
            job.State = DownloadJobState.Failed;
            job.Message = ex.Message;
            progress?.Report(job);
            TryDeletePartial(job.SavePath);
        }
    }

    private static async Task DownloadSingleAsync(
        string url, DownloadJob job, Action onTick, CancellationToken ct)
    {
        using var req = new HttpRequestMessage(HttpMethod.Get, url);
        using var resp = await Http.SendAsync(req, HttpCompletionOption.ResponseHeadersRead, ct)
            .ConfigureAwait(false);
        resp.EnsureSuccessStatusCode();
        if (job.TotalBytes <= 0 && resp.Content.Headers.ContentLength is long len)
            job.TotalBytes = len;

        await using var input = await resp.Content.ReadAsStreamAsync(ct).ConfigureAwait(false);
        await using var output = new FileStream(job.SavePath, FileMode.Create, FileAccess.Write, FileShare.None, 256 * 1024, true);
        var buffer = new byte[256 * 1024];
        long written = 0;
        while (true)
        {
            ct.ThrowIfCancellationRequested();
            var n = await input.ReadAsync(buffer.AsMemory(0, buffer.Length), ct).ConfigureAwait(false);
            if (n <= 0)
                break;
            await output.WriteAsync(buffer.AsMemory(0, n), ct).ConfigureAwait(false);
            written += n;
            job.DownloadedBytes = written;
            onTick();
        }
    }

    private static async Task DownloadSegmentedAsync(
        string url, DownloadJob job, long total, int threads, Action onTick, CancellationToken ct)
    {
        // 预分配并用 RandomAccess 并行写入，避免多 FileStream Seek 互相卡死
        await using (var fs = new FileStream(job.SavePath, FileMode.Create, FileAccess.Write, FileShare.None))
        {
            fs.SetLength(total);
        }

        var partSize = total / threads;
        var ranges = new List<(long Start, long End)>(threads);
        for (var i = 0; i < threads; i++)
        {
            var start = i * partSize;
            var end = i == threads - 1 ? total - 1 : start + partSize - 1;
            ranges.Add((start, end));
        }

        long sharedDownloaded = 0;
        var tasks = new Task[threads];
        for (var i = 0; i < threads; i++)
        {
            var (start, end) = ranges[i];
            tasks[i] = Task.Run(async () =>
            {
                using var req = new HttpRequestMessage(HttpMethod.Get, url);
                req.Headers.Range = new RangeHeaderValue(start, end);
                using var resp = await Http.SendAsync(req, HttpCompletionOption.ResponseHeadersRead, ct)
                    .ConfigureAwait(false);
                if (!resp.IsSuccessStatusCode && resp.StatusCode != System.Net.HttpStatusCode.PartialContent)
                    resp.EnsureSuccessStatusCode();

                await using var input = await resp.Content.ReadAsStreamAsync(ct).ConfigureAwait(false);
                using var handle = File.OpenHandle(
                    job.SavePath, FileMode.Open, FileAccess.Write, FileShare.ReadWrite, FileOptions.Asynchronous);

                var buffer = new byte[128 * 1024];
                long local = 0;
                var expected = end - start + 1;
                while (local < expected)
                {
                    ct.ThrowIfCancellationRequested();
                    var need = (int)Math.Min(buffer.Length, expected - local);
                    var n = await input.ReadAsync(buffer.AsMemory(0, need), ct).ConfigureAwait(false);
                    if (n <= 0)
                        break;
                    await RandomAccess.WriteAsync(handle, buffer.AsMemory(0, n), start + local, ct)
                        .ConfigureAwait(false);
                    local += n;
                    job.DownloadedBytes = Interlocked.Add(ref sharedDownloaded, n);
                    onTick();
                }
            }, ct);
        }

        await Task.WhenAll(tasks).ConfigureAwait(false);
        job.DownloadedBytes = total;
    }

    private static void TryDeletePartial(string? path)
    {
        try
        {
            if (!string.IsNullOrWhiteSpace(path) && File.Exists(path))
                File.Delete(path);
        }
        catch
        {
            // ignore
        }
    }
}
