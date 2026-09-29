using Open.Nat;

namespace MemWatch;

/// <summary>一键尝试 UPnP / NAT-PMP 端口映射，让外网能直连到本机。</summary>
internal static class ShareUpnp
{
    private static NatDevice? _device;
    private static Mapping? _mapping;

    public static async Task<(bool Ok, string? ExternalIp, string Detail)> TryMapAsync(int port, CancellationToken ct)
    {
        await ClearAsync().ConfigureAwait(false);
        try
        {
            using var timeout = CancellationTokenSource.CreateLinkedTokenSource(ct);
            timeout.CancelAfter(TimeSpan.FromSeconds(8));
            var discoverer = new NatDiscoverer();
            NatDevice device;
            try
            {
                device = await discoverer.DiscoverDeviceAsync(PortMapper.Upnp, timeout).ConfigureAwait(false);
            }
            catch
            {
                device = await discoverer.DiscoverDeviceAsync(PortMapper.Pmp, timeout).ConfigureAwait(false);
            }

            var mapping = new Mapping(Protocol.Tcp, port, port, 0, "MemWatch FileShare");
            await device.CreatePortMapAsync(mapping).ConfigureAwait(false);
            string? extIp = null;
            try
            {
                var ip = await device.GetExternalIPAsync().ConfigureAwait(false);
                extIp = ip?.ToString();
            }
            catch { /* ignore */ }

            _device = device;
            _mapping = mapping;
            return (true, extIp, L.T(
                $"已自动开通外网端口 {port}" + (string.IsNullOrEmpty(extIp) ? "" : $"（公网 {extIp}）"),
                $"WAN port {port} mapped" + (string.IsNullOrEmpty(extIp) ? "" : $" (public {extIp})")));
        }
        catch (Exception ex)
        {
            return (false, null, L.T(
                $"未能自动开通外网（路由器可能关闭了 UPnP）：{ex.Message}",
                $"Auto WAN map failed (router UPnP may be off): {ex.Message}"));
        }
    }

    public static async Task ClearAsync()
    {
        try
        {
            if (_device is not null && _mapping is not null)
                await _device.DeletePortMapAsync(_mapping).ConfigureAwait(false);
        }
        catch { /* ignore */ }
        finally
        {
            _device = null;
            _mapping = null;
        }
    }
}
