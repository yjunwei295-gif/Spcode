using System.Diagnostics;
using System.Net;
using System.Net.Http.Json;
using System.Net.Sockets;
using System.Text;
using System.Text.Json.Serialization;

namespace MemWatch;

internal sealed class ShareFileItem
{
    public string Id { get; init; } = Guid.NewGuid().ToString("N")[..8];
    public string Path { get; init; } = "";
    public string Name { get; init; } = "";
    public long Size { get; init; }
}

internal sealed class RemoteShareFile
{
    [JsonPropertyName("id")] public string Id { get; set; } = "";
    [JsonPropertyName("name")] public string Name { get; set; } = "";
    [JsonPropertyName("size")] public long Size { get; set; }
}

/// <summary>
/// 直连分享：开始分享时一键开防火墙 + 尝试 UPnP 开通外网端口；
/// 对方粘贴分享串直连下载。
/// </summary>
internal sealed class FileShareService
{
    public const string TokenPrefix = "MWFS1";
    public static FileShareService Instance { get; } = new();

    private readonly object _gate = new();
    private readonly List<ShareFileItem> _files = new();
    private TcpListener? _listener;
    private CancellationTokenSource? _cts;
    private int _activeTransfers;
    private Task? _netReadyTask;

    // 复用，避免每次探测/下载 new HttpClient 导致套接字堆积
    private static readonly HttpClient SharedHttp = CreateSharedHttp();
    private static readonly HttpClient SharedHttpShort = CreateSharedHttpShort();

    public bool IsRunning { get; private set; }
    public bool AllowDownload { get; set; } = true;
    public string ShareCode { get; private set; } = "";
    public int Port { get; private set; } = 18765;
    public int ActiveTransfers => Volatile.Read(ref _activeTransfers);
    public string? PublicIp { get; private set; }
    /// <summary>是否已通过 UPnP 自动映射外网端口。</summary>
    public bool WanMapped { get; private set; }
    public string NetworkStatus { get; private set; } = "";

    public event Action? Changed;

    public List<ShareFileItem> GetFiles()
    {
        lock (_gate) return _files.ToList();
    }

    public IReadOnlyList<string> GetCandidateIps()
    {
        var list = new List<string>();
        if (!string.IsNullOrWhiteSpace(PublicIp))
            list.Add(PublicIp);
        try
        {
            foreach (var ip in Dns.GetHostAddresses(Dns.GetHostName()))
            {
                if (ip.AddressFamily != AddressFamily.InterNetwork) continue;
                if (IPAddress.IsLoopback(ip)) continue;
                list.Add(ip.ToString());
            }
        }
        catch { /* ignore */ }

        // 本机自测接收时可用
        list.Add("127.0.0.1");
        return list.Distinct(StringComparer.OrdinalIgnoreCase).ToList();
    }

    /// <summary>发给对方的一整段分享串（含地址+端口+验证码）。</summary>
    public string BuildShareToken()
    {
        if (!IsRunning)
            return "";
        var ips = string.Join(",", GetCandidateIps());
        if (string.IsNullOrEmpty(ips))
            ips = "127.0.0.1";
        return $"{TokenPrefix}|{ShareCode}|{Port}|{ips}";
    }

    public static bool TryParseShareToken(string text, out string code, out int port, out List<string> hosts, out string error)
    {
        code = "";
        port = 0;
        hosts = new List<string>();
        error = "";
        text = (text ?? "").Trim().Trim('"', '\'', '“', '”', ' ');
        // 允许用户粘贴整段说明文字时抽出 token
        var idx = text.IndexOf(TokenPrefix, StringComparison.OrdinalIgnoreCase);
        if (idx >= 0)
        {
            var end = text.IndexOfAny([' ', '\r', '\n', '\t'], idx);
            text = end > idx ? text[idx..end] : text[idx..];
        }

        var parts = text.Split('|');
        if (parts.Length < 4 || !parts[0].Equals(TokenPrefix, StringComparison.OrdinalIgnoreCase))
        {
            error = L.T("分享串无效。请粘贴对方复制的完整分享串。", "Invalid share token. Paste the full token from the sharer.");
            return false;
        }

        code = parts[1].Trim();
        if (!int.TryParse(parts[2].Trim(), out port) || port is < 1 or > 65535)
        {
            error = L.T("分享串端口无效。", "Invalid port in share token.");
            return false;
        }

        foreach (var h in parts[3].Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries))
        {
            if (IPAddress.TryParse(h, out _))
                hosts.Add(h);
        }

        if (hosts.Count == 0)
        {
            error = L.T("分享串里没有可用地址。", "No usable address in share token.");
            return false;
        }

        return true;
    }

    public void AddFiles(IEnumerable<string> paths)
    {
        lock (_gate)
        {
            var exist = new HashSet<string>(_files.Select(f => f.Path), StringComparer.OrdinalIgnoreCase);
            foreach (var p in paths)
            {
                try
                {
                    if (!File.Exists(p) || !exist.Add(Path.GetFullPath(p))) continue;
                    var fi = new FileInfo(p);
                    _files.Add(new ShareFileItem { Path = fi.FullName, Name = fi.Name, Size = fi.Length });
                }
                catch { /* skip */ }
            }
        }

        RaiseChanged();
    }

    public void ClearFiles()
    {
        lock (_gate) _files.Clear();
        RaiseChanged();
    }

    public void Start(int? port = null)
    {
        if (IsRunning) return;
        lock (_gate)
        {
            if (_files.Count == 0)
                throw new InvalidOperationException(L.T("请先添加要分享的文件。", "Add files to share first."));
        }

        Port = port is > 0 and < 65535 ? port.Value : 18765;
        ShareCode = Random.Shared.Next(0, 1_000_000).ToString("D6");
        _cts = new CancellationTokenSource();
        _listener = new TcpListener(IPAddress.Any, Port);
        try
        {
            _listener.Start();
        }
        catch (SocketException ex)
        {
            _listener = null;
            _cts.Dispose();
            _cts = null;
            throw new InvalidOperationException(L.T(
                $"无法在端口 {Port} 上开始分享：{ex.Message}。请换一个端口，或检查是否已被占用。",
                $"Cannot listen on port {Port}: {ex.Message}. Try another port."));
        }

        TryEnsureFirewallAllow(Port);
        WanMapped = false;
        NetworkStatus = L.T("正在一键开通网络…", "Preparing network…");
        IsRunning = true;
        RaiseChanged();

        var token = _cts.Token;
        _ = Task.Run(() => AcceptLoopAsync(token), token);
        _netReadyTask = Task.Run(() => PrepareNetworkAsync(token), token);
    }

    /// <summary>等待防火墙/UPnP/公网 IP 准备完成（最多约数秒）。</summary>
    public Task WaitNetworkReadyAsync(CancellationToken ct = default)
    {
        var t = _netReadyTask;
        if (t is null) return Task.CompletedTask;
        return t.WaitAsync(ct);
    }

    private async Task PrepareNetworkAsync(CancellationToken ct)
    {
        try
        {
            var upnp = await ShareUpnp.TryMapAsync(Port, ct).ConfigureAwait(false);
            WanMapped = upnp.Ok;
            if (!string.IsNullOrWhiteSpace(upnp.ExternalIp))
                PublicIp = upnp.ExternalIp;
            else
                PublicIp = await TryGetPublicIpAsync(ct).ConfigureAwait(false);

            if (WanMapped)
            {
                NetworkStatus = upnp.Detail;
            }
            else
            {
                NetworkStatus = L.T(
                    "仅局域网可用（已开防火墙）。外网需路由器开启 UPnP，或双方同一 Wi‑Fi。",
                    "LAN only (firewall opened). For WAN enable router UPnP, or use same Wi‑Fi.")
                    + " " + upnp.Detail;
            }
        }
        catch (OperationCanceledException) when (ct.IsCancellationRequested)
        {
            /* stop */
        }
        catch (Exception ex)
        {
            NetworkStatus = L.T("网络准备异常：", "Network prepare error: ") + ex.Message;
        }
        finally
        {
            RaiseChanged();
        }
    }

    public void Stop()
    {
        try { _cts?.Cancel(); } catch { /* ignore */ }
        try { _listener?.Stop(); } catch { /* ignore */ }
        _ = ShareUpnp.ClearAsync();
        _listener = null;
        _cts?.Dispose();
        _cts = null;
        _netReadyTask = null;
        IsRunning = false;
        ShareCode = "";
        PublicIp = null;
        WanMapped = false;
        NetworkStatus = "";
        Interlocked.Exchange(ref _activeTransfers, 0);
        RaiseChanged();
    }

    public void Shutdown() => Stop();

    public void RegenerateCode()
    {
        if (!IsRunning) return;
        ShareCode = Random.Shared.Next(0, 1_000_000).ToString("D6");
        RaiseChanged();
    }

    /// <summary>接收端：探测哪个地址能连上，列出文件。</summary>
    public static async Task<(string BaseUrl, string Code, List<RemoteShareFile> Files)> ConnectAndListAsync(
        string token, CancellationToken ct)
    {
        if (!TryParseShareToken(token, out var code, out var port, out var hosts, out var err))
            throw new InvalidOperationException(err);

        Exception? last = null;
        var tried = new List<string>();
        foreach (var host in hosts)
        {
            ct.ThrowIfCancellationRequested();
            var baseUrl = $"http://{host}:{port}";
            tried.Add($"{host}:{port}");
            try
            {
                using var resp = await SharedHttpShort.GetAsync(
                        $"{baseUrl}/api/files?c={Uri.EscapeDataString(code)}", ct)
                    .ConfigureAwait(false);
                if (resp.StatusCode == HttpStatusCode.Forbidden)
                {
                    var body = await resp.Content.ReadAsStringAsync(ct).ConfigureAwait(false);
                    if (body.Contains("disabled", StringComparison.OrdinalIgnoreCase))
                        throw new InvalidOperationException(L.T(
                            "对方已关闭「允许下载」。",
                            "The sharer disabled downloads."));
                    throw new InvalidOperationException(L.T("验证码错误。", "Wrong share code."));
                }

                resp.EnsureSuccessStatusCode();
                var dto = await resp.Content.ReadFromJsonAsync<FilesResponse>(cancellationToken: ct)
                    .ConfigureAwait(false);
                if (dto is null || !dto.Ok)
                    throw new InvalidOperationException(L.T("对方返回异常。", "Unexpected response from sharer."));
                return (baseUrl, code, dto.Files ?? new List<RemoteShareFile>());
            }
            catch (OperationCanceledException) when (ct.IsCancellationRequested)
            {
                throw;
            }
            catch (InvalidOperationException)
            {
                throw;
            }
            catch (Exception ex)
            {
                // HttpClient 超时也是 TaskCanceledException，不能当成「用户取消」
                last = ex;
            }
        }

        var detail = last is null ? "" : $"\n({last.GetType().Name}: {last.Message})";
        throw new InvalidOperationException(L.T(
            $"无法连接到分享者（已试：{string.Join("、", tried)}）。\n请确认：对方已点「开始分享」且未停止；双方同一局域网（或做了端口映射）；Windows 防火墙放行端口 {port}。",
            $"Cannot reach sharer (tried: {string.Join(", ", tried)}).\nCheck: sharer is still sharing; same LAN (or port-forward); firewall allows port {port}.")
            + detail);
    }

    public static async Task DownloadFileAsync(
        string baseUrl, string code, RemoteShareFile file, string savePath, IProgress<double>? progress, CancellationToken ct)
    {
        var url = $"{baseUrl}/d/{Uri.EscapeDataString(file.Id)}?c={Uri.EscapeDataString(code)}";
        using var resp = await SharedHttp.GetAsync(url, HttpCompletionOption.ResponseHeadersRead, ct)
            .ConfigureAwait(false);
        if (resp.StatusCode == HttpStatusCode.Forbidden)
            throw new InvalidOperationException(L.T("对方禁止下载或验证码错误。", "Download forbidden or bad code."));
        resp.EnsureSuccessStatusCode();

        var total = resp.Content.Headers.ContentLength ?? file.Size;
        await using var input = await resp.Content.ReadAsStreamAsync(ct).ConfigureAwait(false);
        var dir = Path.GetDirectoryName(savePath);
        if (!string.IsNullOrEmpty(dir))
            Directory.CreateDirectory(dir);
        await using var output = new FileStream(savePath, FileMode.Create, FileAccess.Write, FileShare.None, 128 * 1024, true);
        var buffer = new byte[128 * 1024];
        long got = 0;
        while (true)
        {
            ct.ThrowIfCancellationRequested();
            var n = await input.ReadAsync(buffer, ct).ConfigureAwait(false);
            if (n <= 0) break;
            await output.WriteAsync(buffer.AsMemory(0, n), ct).ConfigureAwait(false);
            got += n;
            if (total > 0)
                progress?.Report(Math.Clamp((double)got / total, 0, 1));
        }
    }

    private async Task AcceptLoopAsync(CancellationToken ct)
    {
        while (!ct.IsCancellationRequested)
        {
            TcpClient? client = null;
            try
            {
                client = await _listener!.AcceptTcpClientAsync(ct).ConfigureAwait(false);
                _ = Task.Run(() => HandleClientAsync(client, ct), ct);
            }
            catch (OperationCanceledException) { break; }
            catch
            {
                try { client?.Dispose(); } catch { /* ignore */ }
                if (ct.IsCancellationRequested) break;
            }
        }
    }

    private async Task HandleClientAsync(TcpClient client, CancellationToken ct)
    {
        using (client)
        {
            try
            {
                using var stream = client.GetStream();
                var req = await ReadHttpRequestAsync(stream, ct).ConfigureAwait(false);
                if (req is null) return;
                await DispatchAsync(stream, req, ct).ConfigureAwait(false);
            }
            catch { /* drop */ }
        }
    }

    private async Task DispatchAsync(NetworkStream stream, HttpReq req, CancellationToken ct)
    {
        var path = req.Path;
        var q = req.Query;

        if (path.Equals("/api/files", StringComparison.OrdinalIgnoreCase))
        {
            if (!CheckCode(q.Get("c")))
            {
                await WriteJsonAsync(stream, 403, "{\"ok\":false,\"error\":\"bad_code\"}", ct).ConfigureAwait(false);
                return;
            }

            if (!AllowDownload)
            {
                await WriteJsonAsync(stream, 403, "{\"ok\":false,\"error\":\"disabled\"}", ct).ConfigureAwait(false);
                return;
            }

            var files = GetFiles();
            var json = "{\"ok\":true,\"files\":[" +
                       string.Join(",", files.Select(f =>
                           $"{{\"id\":\"{Esc(f.Id)}\",\"name\":\"{Esc(f.Name)}\",\"size\":{f.Size}}}" )) +
                       "]}";
            await WriteJsonAsync(stream, 200, json, ct).ConfigureAwait(false);
            return;
        }

        if (path.StartsWith("/d/", StringComparison.OrdinalIgnoreCase))
        {
            if (!CheckCode(q.Get("c")))
            {
                await WriteTextAsync(stream, 403, "Bad code", ct).ConfigureAwait(false);
                return;
            }

            if (!AllowDownload)
            {
                await WriteTextAsync(stream, 403, L.T("分享者已关闭下载。", "Sharing host disabled downloads."), ct)
                    .ConfigureAwait(false);
                return;
            }

            var id = path["/d/".Length..].Trim('/');
            ShareFileItem? file;
            lock (_gate)
                file = _files.FirstOrDefault(f => f.Id.Equals(id, StringComparison.OrdinalIgnoreCase));

            if (file is null || !File.Exists(file.Path))
            {
                await WriteTextAsync(stream, 404, "Not found", ct).ConfigureAwait(false);
                return;
            }

            await WriteFileAsync(stream, file, ct).ConfigureAwait(false);
            return;
        }

        await WriteTextAsync(stream, 200,
            L.T("请使用 MemWatch「文件分享 → 接收」粘贴分享串下载。",
                "Use MemWatch File Share → Receive and paste the share token."), ct).ConfigureAwait(false);
    }

    private bool CheckCode(string? code) =>
        !string.IsNullOrWhiteSpace(ShareCode) &&
        !string.IsNullOrWhiteSpace(code) &&
        string.Equals(ShareCode.Trim(), code.Trim(), StringComparison.Ordinal);

    private async Task WriteFileAsync(NetworkStream stream, ShareFileItem file, CancellationToken ct)
    {
        Interlocked.Increment(ref _activeTransfers);
        RaiseChanged();
        try
        {
            await using var fs = new FileStream(file.Path, FileMode.Open, FileAccess.Read, FileShare.Read, 128 * 1024, true);
            var name = file.Name.Replace("\"", "");
            var header =
                "HTTP/1.1 200 OK\r\nContent-Type: application/octet-stream\r\n" +
                $"Content-Length: {fs.Length}\r\n" +
                $"Content-Disposition: attachment; filename=\"{name}\"\r\nConnection: close\r\n\r\n";
            await stream.WriteAsync(Encoding.ASCII.GetBytes(header), ct).ConfigureAwait(false);
            var buffer = new byte[128 * 1024];
            while (true)
            {
                ct.ThrowIfCancellationRequested();
                if (!AllowDownload || !IsRunning) break;
                var n = await fs.ReadAsync(buffer, ct).ConfigureAwait(false);
                if (n <= 0) break;
                await stream.WriteAsync(buffer.AsMemory(0, n), ct).ConfigureAwait(false);
            }
        }
        finally
        {
            Interlocked.Decrement(ref _activeTransfers);
            RaiseChanged();
        }
    }

    private static async Task WriteJsonAsync(NetworkStream stream, int status, string json, CancellationToken ct)
    {
        var body = Encoding.UTF8.GetBytes(json);
        var header = Encoding.ASCII.GetBytes(
            $"HTTP/1.1 {status} X\r\nContent-Type: application/json; charset=utf-8\r\nContent-Length: {body.Length}\r\nConnection: close\r\n\r\n");
        await stream.WriteAsync(header, ct).ConfigureAwait(false);
        await stream.WriteAsync(body, ct).ConfigureAwait(false);
    }

    private static async Task WriteTextAsync(NetworkStream stream, int status, string text, CancellationToken ct)
    {
        var body = Encoding.UTF8.GetBytes(text);
        var header = Encoding.ASCII.GetBytes(
            $"HTTP/1.1 {status} X\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: {body.Length}\r\nConnection: close\r\n\r\n");
        await stream.WriteAsync(header, ct).ConfigureAwait(false);
        await stream.WriteAsync(body, ct).ConfigureAwait(false);
    }

    private static string Esc(string s) =>
        s.Replace("\\", "\\\\").Replace("\"", "\\\"");

    private static async Task<HttpReq?> ReadHttpRequestAsync(NetworkStream stream, CancellationToken ct)
    {
        var buf = new byte[32 * 1024];
        var total = 0;
        while (total < buf.Length)
        {
            var n = await stream.ReadAsync(buf.AsMemory(total, buf.Length - total), ct).ConfigureAwait(false);
            if (n <= 0) break;
            total += n;
            var text = Encoding.ASCII.GetString(buf, 0, total);
            var idx = text.IndexOf("\r\n\r\n", StringComparison.Ordinal);
            if (idx < 0) continue;
            var lines = text[..idx].Split("\r\n");
            if (lines.Length == 0) return null;
            var parts = lines[0].Split(' ');
            if (parts.Length < 2) return null;
            var raw = parts[1];
            var qIndex = raw.IndexOf('?', StringComparison.Ordinal);
            var path = qIndex >= 0 ? raw[..qIndex] : raw;
            var query = qIndex >= 0 ? raw[(qIndex + 1)..] : "";
            return new HttpReq(path, ParseQuery(query));
        }

        return null;
    }

    private static Dictionary<string, string> ParseQuery(string query)
    {
        var dict = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        if (string.IsNullOrEmpty(query)) return dict;
        foreach (var pair in query.Split('&', StringSplitOptions.RemoveEmptyEntries))
        {
            var kv = pair.Split('=', 2);
            dict[Uri.UnescapeDataString(kv[0])] = kv.Length > 1 ? Uri.UnescapeDataString(kv[1]) : "";
        }

        return dict;
    }

    private static async Task<string?> TryGetPublicIpAsync(CancellationToken ct)
    {
        try
        {
            var ip = (await SharedHttpShort.GetStringAsync("https://api.ipify.org", ct).ConfigureAwait(false)).Trim();
            return IPAddress.TryParse(ip, out _) ? ip : null;
        }
        catch { return null; }
    }

    private static HttpClient CreateSharedHttp() =>
        new(new SocketsHttpHandler { PooledConnectionLifetime = TimeSpan.FromMinutes(5) })
        {
            Timeout = TimeSpan.FromHours(6)
        };

    private static HttpClient CreateSharedHttpShort() =>
        new(new SocketsHttpHandler { PooledConnectionLifetime = TimeSpan.FromMinutes(2) })
        {
            Timeout = TimeSpan.FromSeconds(5)
        };

    /// <summary>管理员权限下尝试放行入站端口，否则对方连不上也没有明确提示。</summary>
    private static void TryEnsureFirewallAllow(int port)
    {
        const string ruleName = "MemWatch FileShare";
        try
        {
            RunNetshSilent($"advfirewall firewall delete rule name=\"{ruleName}\"");
            RunNetshSilent(
                $"advfirewall firewall add rule name=\"{ruleName}\" dir=in action=allow protocol=TCP localport={port} profile=any");
        }
        catch { /* 失败时由连接端提示用户手动放行 */ }
    }

    private static void RunNetshSilent(string args)
    {
        using var p = Process.Start(new ProcessStartInfo
        {
            FileName = "netsh",
            Arguments = args,
            CreateNoWindow = true,
            UseShellExecute = false,
            RedirectStandardOutput = true,
            RedirectStandardError = true
        });
        if (p is null) return;
        p.WaitForExit(8000);
    }

    private void RaiseChanged()
    {
        try { Changed?.Invoke(); } catch { /* ignore */ }
    }

    private sealed record HttpReq(string Path, Dictionary<string, string> Query);

    private sealed class FilesResponse
    {
        [JsonPropertyName("ok")] public bool Ok { get; set; }
        [JsonPropertyName("files")] public List<RemoteShareFile>? Files { get; set; }
    }
}

internal static class QueryExt
{
    public static string? Get(this Dictionary<string, string> q, string key) =>
        q.TryGetValue(key, out var v) ? v : null;
}
