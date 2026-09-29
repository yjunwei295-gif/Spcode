using System.Collections.Concurrent;
using System.Net;
using System.Net.Sockets;
using System.Text;

namespace MemWatch.ShareRelay;

/// <summary>
/// 跨网中继：双方出站连接，访客用浏览器打开 http://公网IP:18767/验证码/
/// </summary>
public static class Program
{
    public const int ControlPort = 18766;
    public const int GuestPort = 18767;

    private static readonly ConcurrentDictionary<string, HostSession> Hosts = new(StringComparer.Ordinal);

    public static async Task Main()
    {
        Console.OutputEncoding = Encoding.UTF8;
        Console.WriteLine("MemWatch ShareRelay");
        Console.WriteLine($"  Host port  : {ControlPort}  (REG / STREAM)");
        Console.WriteLine($"  Guest port : {GuestPort}  (HTTP)");
        Console.WriteLine($"  URL        : http://YOUR_PUBLIC_IP:{GuestPort}/<code>/");
        Console.WriteLine("Ctrl+C to stop.");
        Console.WriteLine();

        using var cts = new CancellationTokenSource();
        Console.CancelKeyPress += (_, e) => { e.Cancel = true; cts.Cancel(); };

        var controlListener = new TcpListener(IPAddress.Any, ControlPort);
        var guestListener = new TcpListener(IPAddress.Any, GuestPort);
        controlListener.Start();
        guestListener.Start();

        await Task.WhenAny(
            AcceptLoopAsync(controlListener, hostSide: true, cts.Token),
            AcceptLoopAsync(guestListener, hostSide: false, cts.Token));

        cts.Cancel();
        try { controlListener.Stop(); } catch { /* ignore */ }
        try { guestListener.Stop(); } catch { /* ignore */ }
    }

    private static async Task AcceptLoopAsync(TcpListener listener, bool hostSide, CancellationToken ct)
    {
        while (!ct.IsCancellationRequested)
        {
            TcpClient? client = null;
            try
            {
                client = await listener.AcceptTcpClientAsync(ct);
                if (hostSide)
                    _ = Task.Run(() => HandleHostSideAsync(client, ct), ct);
                else
                    _ = Task.Run(() => HandleGuestAsync(client, ct), ct);
            }
            catch (OperationCanceledException) { break; }
            catch
            {
                try { client?.Dispose(); } catch { /* ignore */ }
            }
        }
    }

    private static async Task HandleHostSideAsync(TcpClient client, CancellationToken ct)
    {
        try
        {
            var stream = client.GetStream();
            var line = await ReadLineAsync(stream, ct);
            var parts = line.Trim().Split(' ', StringSplitOptions.RemoveEmptyEntries);
            if (parts.Length >= 2 && parts[0].Equals("REG", StringComparison.OrdinalIgnoreCase))
            {
                var code = parts[1];
                if (code.Length is < 4 or > 16)
                {
                    await WriteLineAsync(stream, "ERR bad_code", ct);
                    client.Dispose();
                    return;
                }

                var session = new HostSession(code, client, stream);
                if (Hosts.TryRemove(code, out var old))
                    old.Dispose();
                Hosts[code] = session;
                await WriteLineAsync(stream, "OK", ct);
                Console.WriteLine($"[{DateTime.Now:HH:mm:ss}] HOST online {code}");
                await session.IdleAsync(ct);
                if (Hosts.TryGetValue(code, out var cur) && ReferenceEquals(cur, session))
                    Hosts.TryRemove(code, out _);
                Console.WriteLine($"[{DateTime.Now:HH:mm:ss}] HOST offline {code}");
                session.Dispose();
                return;
            }

            if (parts.Length >= 3 && parts[0].Equals("STREAM", StringComparison.OrdinalIgnoreCase))
            {
                var code = parts[1];
                var sid = parts[2];
                if (!Hosts.TryGetValue(code, out var host) ||
                    !host.TryTakePending(sid, out var guest, out var prefix))
                {
                    await WriteLineAsync(stream, "ERR no_session", ct);
                    client.Dispose();
                    return;
                }

                await WriteLineAsync(stream, "OK", ct);
                Console.WriteLine($"[{DateTime.Now:HH:mm:ss}] PIPE {code} {sid}");
                try
                {
                    if (prefix.Length > 0)
                        await stream.WriteAsync(prefix, ct);
                    await PipeAsync(guest!.GetStream(), stream, ct);
                }
                catch { /* ignore */ }
                finally
                {
                    try { guest!.Dispose(); } catch { /* ignore */ }
                    try { client.Dispose(); } catch { /* ignore */ }
                }

                return;
            }

            await WriteLineAsync(stream, "ERR unknown", ct);
            client.Dispose();
        }
        catch
        {
            try { client.Dispose(); } catch { /* ignore */ }
        }
    }

    private static async Task HandleGuestAsync(TcpClient guest, CancellationToken ct)
    {
        try
        {
            var g = guest.GetStream();
            var headerBlock = await ReadHeadersAsync(g, ct);
            if (headerBlock is null)
            {
                guest.Dispose();
                return;
            }

            var normalized = headerBlock.Replace("\r\n", "\n", StringComparison.Ordinal);
            var lines = normalized.Split('\n');
            var reqParts = lines[0].Split(' ');
            if (reqParts.Length < 2)
            {
                guest.Dispose();
                return;
            }

            var method = reqParts[0];
            var target = reqParts[1];
            var ver = reqParts.Length >= 3 ? reqParts[2] : "HTTP/1.1";

            string path, query;
            var qIdx = target.IndexOf('?', StringComparison.Ordinal);
            if (qIdx >= 0) { path = target[..qIdx]; query = target[qIdx..]; }
            else { path = target; query = ""; }

            var segs = path.Split('/', StringSplitOptions.RemoveEmptyEntries);
            if (segs.Length == 0)
            {
                await WriteTextAsync(g, 200, "text/html; charset=utf-8",
                    "<html><body><h3>MemWatch ShareRelay</h3><p>Use /&lt;code&gt;/</p></body></html>", ct);
                guest.Dispose();
                return;
            }

            var code = segs[0];
            var rest = segs.Length == 1 ? "/" : "/" + string.Join('/', segs.Skip(1));
            var newFirst = $"{method} {rest}{query} {ver}";

            if (!Hosts.TryGetValue(code, out var host) || !host.IsAlive)
            {
                await WriteTextAsync(g, 503, "text/plain; charset=utf-8", "Host offline or invalid code.", ct);
                guest.Dispose();
                return;
            }

            var sb = new StringBuilder();
            sb.Append(newFirst).Append("\r\n");
            for (var i = 1; i < lines.Length; i++)
            {
                if (string.IsNullOrEmpty(lines[i])) continue;
                if (lines[i].StartsWith("Host:", StringComparison.OrdinalIgnoreCase)) continue;
                sb.Append(lines[i]).Append("\r\n");
            }
            sb.Append("\r\n");
            var prefix = Encoding.ASCII.GetBytes(sb.ToString());

            var sid = Guid.NewGuid().ToString("N")[..12];
            if (!await host.WaitForStreamAsync(sid, guest, prefix, ct))
            {
                await WriteTextAsync(g, 502, "text/plain; charset=utf-8", "Host did not accept.", ct);
                guest.Dispose();
            }
            // else guest ownership moved to STREAM pipe
        }
        catch
        {
            try { guest.Dispose(); } catch { /* ignore */ }
        }
    }

    private static async Task PipeAsync(Stream a, Stream b, CancellationToken ct)
    {
        using var linked = CancellationTokenSource.CreateLinkedTokenSource(ct);
        var t1 = a.CopyToAsync(b, 128 * 1024, linked.Token);
        var t2 = b.CopyToAsync(a, 128 * 1024, linked.Token);
        try { await Task.WhenAny(t1, t2); }
        catch { /* ignore */ }
        try { linked.Cancel(); } catch { /* ignore */ }
    }

    private static async Task<string> ReadLineAsync(NetworkStream stream, CancellationToken ct)
    {
        var buf = new List<byte>(128);
        var b = new byte[1];
        while (buf.Count < 4096)
        {
            var n = await stream.ReadAsync(b, ct);
            if (n <= 0) break;
            if (b[0] == (byte)'\n') break;
            if (b[0] != (byte)'\r') buf.Add(b[0]);
        }

        return Encoding.ASCII.GetString(buf.ToArray());
    }

    private static async Task<string?> ReadHeadersAsync(NetworkStream stream, CancellationToken ct)
    {
        var ms = new MemoryStream();
        var b = new byte[1];
        while (ms.Length < 64 * 1024)
        {
            var n = await stream.ReadAsync(b, ct);
            if (n <= 0) return null;
            ms.WriteByte(b[0]);
            var arr = ms.ToArray();
            var len = arr.Length;
            if (len >= 4 && arr[len - 4] == (byte)'\r' && arr[len - 3] == (byte)'\n' && arr[len - 2] == (byte)'\r' && arr[len - 1] == (byte)'\n')
                return Encoding.ASCII.GetString(arr);
            if (len >= 2 && arr[len - 2] == (byte)'\n' && arr[len - 1] == (byte)'\n')
                return Encoding.ASCII.GetString(arr);
        }

        return null;
    }

    private static Task WriteLineAsync(NetworkStream stream, string line, CancellationToken ct) =>
        stream.WriteAsync(Encoding.ASCII.GetBytes(line + "\n"), ct).AsTask();

    private static async Task WriteTextAsync(NetworkStream s, int code, string ctype, string text, CancellationToken ct)
    {
        var body = Encoding.UTF8.GetBytes(text);
        var hdr = Encoding.ASCII.GetBytes(
            $"HTTP/1.1 {code} X\r\nContent-Type: {ctype}\r\nContent-Length: {body.Length}\r\nConnection: close\r\n\r\n");
        await s.WriteAsync(hdr, ct);
        await s.WriteAsync(body, ct);
    }

    private sealed class HostSession : IDisposable
    {
        private readonly TcpClient _controlClient;
        private readonly NetworkStream _control;
        private readonly SemaphoreSlim _write = new(1, 1);
        private readonly ConcurrentDictionary<string, Pending> _pending = new();

        public HostSession(string code, TcpClient controlClient, NetworkStream control)
        {
            Code = code;
            _controlClient = controlClient;
            _control = control;
        }

        public string Code { get; }
        public bool IsAlive => _controlClient.Connected;

        public async Task IdleAsync(CancellationToken ct)
        {
            var buf = new byte[64];
            try
            {
                while (!ct.IsCancellationRequested)
                {
                    var n = await _control.ReadAsync(buf, ct);
                    if (n <= 0) break;
                }
            }
            catch { /* disconnect */ }
        }

        public async Task<bool> WaitForStreamAsync(string sid, TcpClient guest, byte[] prefix, CancellationToken ct)
        {
            var tcs = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
            _pending[sid] = new Pending(guest, prefix, tcs);
            try
            {
                await _write.WaitAsync(ct);
                try { await WriteLineAsync(_control, $"OPEN {sid}", ct); }
                finally { _write.Release(); }
            }
            catch
            {
                _pending.TryRemove(sid, out _);
                return false;
            }

            var done = await Task.WhenAny(tcs.Task, Task.Delay(20000, ct));
            if (done != tcs.Task)
            {
                if (_pending.TryRemove(sid, out var p))
                    try { p.Guest.Dispose(); } catch { /* ignore */ }
                return false;
            }

            return tcs.Task.Result;
        }

        public bool TryTakePending(string sid, out TcpClient? guest, out byte[] prefix)
        {
            guest = null;
            prefix = Array.Empty<byte>();
            if (!_pending.TryRemove(sid, out var p))
                return false;
            guest = p.Guest;
            prefix = p.Prefix;
            p.Taken.TrySetResult(true);
            return true;
        }

        public void Dispose()
        {
            foreach (var p in _pending.Values)
            {
                p.Taken.TrySetResult(false);
                try { p.Guest.Dispose(); } catch { /* ignore */ }
            }

            _pending.Clear();
            try { _controlClient.Dispose(); } catch { /* ignore */ }
            _write.Dispose();
        }

        private sealed record Pending(TcpClient Guest, byte[] Prefix, TaskCompletionSource<bool> Taken);
    }
}
