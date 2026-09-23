using Microsoft.AspNetCore.Server.Kestrel.Core;
using QRCoder;
using System.Net;
using System.Text;
using System.Text.Json.Nodes;

namespace CodexPhoneBridge;

internal sealed class HttpHost(BridgeRuntime bridge, EventLoop loop)
{
    private WebApplication? app;
    private string qrUrl = "", qrSvg = "";
    public async Task Start()
    {
        var config = bridge.Config;
        var builder = WebApplication.CreateSlimBuilder(new WebApplicationOptions { ContentRootPath = config.Root, Args = [] });
        builder.Logging.ClearProviders();
        builder.WebHost.ConfigureKestrel(options =>
        {
            options.AddServerHeader = false; options.Limits.MaxRequestBodySize = 100 * 1024 * 1024; options.Limits.MaxConcurrentConnections = 256;
            var address = config.Host == "localhost" ? IPAddress.Loopback : IPAddress.Parse(config.Host);
            options.Listen(address, config.Port, listen => listen.Protocols = HttpProtocols.Http1);
        });
        app = builder.Build();
        app.UseWebSockets(new WebSocketOptions { KeepAliveInterval = TimeSpan.FromMilliseconds(Configuration.Int("CODEX_PHONE_HEARTBEAT_MS", 15000, 5000)), KeepAliveTimeout = TimeSpan.FromMilliseconds(Configuration.Int("CODEX_PHONE_HEARTBEAT_TIMEOUT_MS", 45000, 10000)) });
        app.Run(Handle); await app.StartAsync(bridge.Cancellation);
        Console.WriteLine($"Codex Link To Phone 已启动，C# Native AOT\n本机地址: http://127.0.0.1:{config.Port}/");
    }
    private async Task Handle(HttpContext context)
    {
        string path = context.Request.Path.Value ?? "/"; var response = context.Response; response.Headers.CacheControl = "no-store";
        try
        {
            bool authorized = context.Request.Query["token"].ToString() == bridge.Config.Token;
            if (path is "/api/health" or "/api/status" or "/qr.svg" or "/local-image" or "/ws")
            {
                if (!authorized) { response.StatusCode = 401; response.ContentType = "application/json; charset=utf-8"; await response.WriteAsync("{\"error\":\"unauthorized\"}"); return; }
                if (path == "/ws")
                {
                    if (context.Request.Query["streamProtocol"] != "1" || !context.WebSockets.IsWebSocketRequest) { response.StatusCode = 426; response.Headers.Connection = "close"; response.ContentLength = 0; return; }
                    var ws = await context.WebSockets.AcceptWebSocketAsync();
                    await loop.Invoke(async () =>
                    {
                        using var socket = new JsonSocket(ws, bridge.Cancellation); var client = new PhoneSession(bridge, socket); bridge.AddClient(client);
                        try { await socket.Run(message => EventLoop.Observe(bridge.HandlePhone(client, message))); }
                        finally { bridge.Clients.Remove(client); }
                    }); return;
                }
                if (path == "/api/health" || path == "/api/status")
                {
                    string json = ""; await loop.Invoke(() => { json = (path == "/api/health" ? bridge.Health() : bridge.State(compact: context.Request.Query["full"] != "1")).Wire(); return Task.CompletedTask; });
                    response.ContentType = "application/json; charset=utf-8"; await response.WriteAsync(json); return;
                }
                if (path == "/qr.svg")
                {
                    string svg = ""; await loop.Invoke(() =>
                    {
                        if (qrUrl != bridge.DirectUrl) { qrUrl = bridge.DirectUrl; using var data = QRCodeGenerator.GenerateQrCode(qrUrl, QRCodeGenerator.ECCLevel.M); using var qr = new SvgQRCode(data); qrSvg = qr.GetGraphic(5); }
                        svg = qrSvg; return Task.CompletedTask;
                    }); response.ContentType = "image/svg+xml; charset=utf-8"; await response.WriteAsync(svg); return;
                }
                string? image = SafeFile(bridge.Config.UploadDir, context.Request.Query["path"].ToString(), true);
                if (image is null || !ImageStore.Supported(image)) { response.StatusCode = 404; return; }
                response.Headers.CacheControl = "private, max-age=3600"; await FileResponse(context, image); return;
            }
            string relative = path == "/" ? "index.html" : Uri.UnescapeDataString(path.TrimStart('/'));
            string? file = SafeFile(bridge.Config.PublicDir, relative, false);
            if (file is null) { response.StatusCode = 404; await response.WriteAsync("Not found"); return; }
            await FileResponse(context, file);
        }
        catch (OperationCanceledException) when (context.RequestAborted.IsCancellationRequested || bridge.Cancellation.IsCancellationRequested) { }
        catch (Exception e) { Console.Error.WriteLine("HTTP 请求失败：" + e.Message); if (!response.HasStarted) { response.StatusCode = 500; await response.WriteAsync("Internal Server Error"); } else context.Abort(); }
    }
    private static string? SafeFile(string root, string raw, bool absolute)
    {
        try
        {
            if (raw == "" || raw.Contains('\0')) return null; root = Path.GetFullPath(root);
            string file = absolute ? Path.GetFullPath(raw) : Path.GetFullPath(raw, root);
            if (!file.StartsWith(root + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase) || !File.Exists(file)) return null;
            string current = root;
            foreach (string part in Path.GetRelativePath(root, file).Split(Path.DirectorySeparatorChar))
            {
                current = Path.Combine(current, part); if ((File.GetAttributes(current) & FileAttributes.ReparsePoint) != 0) return null;
            }
            return file;
        }
        catch (Exception e) when (e is IOException or ArgumentException or UnauthorizedAccessException or NotSupportedException) { return null; }
    }
    private static async Task FileResponse(HttpContext context, string path)
    {
        context.Response.ContentType = Path.GetExtension(path).ToLowerInvariant() switch
        { ".html" => "text/html; charset=utf-8", ".css" => "text/css; charset=utf-8", ".js" or ".mjs" => "text/javascript; charset=utf-8", ".svg" => "image/svg+xml; charset=utf-8", ".png" => "image/png", ".jpg" or ".jpeg" => "image/jpeg", ".webp" => "image/webp", ".gif" => "image/gif", ".ico" => "image/x-icon", ".json" => "application/json; charset=utf-8", ".woff2" => "font/woff2", _ => "application/octet-stream" };
        await context.Response.SendFileAsync(path, context.RequestAborted);
    }
    public async Task Stop() { if (app is not null) { using var deadline = new CancellationTokenSource(3000); await app.StopAsync(deadline.Token); await app.DisposeAsync(); } }
}
