using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Microsoft.Data.Sqlite;

var builder = WebApplication.CreateBuilder(args);
builder.WebHost.UseUrls(builder.Configuration["Urls"] ?? "http://127.0.0.1:5088");
builder.Services.AddCors(o => o.AddDefaultPolicy(p => p.AllowAnyOrigin().AllowAnyHeader().AllowAnyMethod()));

var app = builder.Build();
app.UseCors();

var dataRoot = Path.GetFullPath(builder.Configuration["DataRoot"]
    ?? Path.Combine(AppContext.BaseDirectory, "cloud-data"));
Directory.CreateDirectory(dataRoot);
Directory.CreateDirectory(Path.Combine(dataRoot, "chunks"));
var dbPath = Path.Combine(dataRoot, "index.db");
var db = new CloudDb(dbPath);
db.EnsureSchema();

const int ChunkSize = 4 * 1024 * 1024;
const int HeadBytes = 256 * 1024;

app.MapGet("/", () => Results.Text(
    "CloudTransferServer OK\n" +
    "POST /api/preflight\n" +
    "PUT  /api/chunks/{uploadId}/{index}\n" +
    "POST /api/complete\n" +
    "GET  /api/files?userId=local\n" +
    "GET  /api/download/{fileId}\n"));

app.MapGet("/api/health", () => Results.Json(new { ok = true, dataRoot, chunkSize = ChunkSize }));

app.MapPost("/api/preflight", async (HttpRequest req) =>
{
    var body = await JsonSerializer.DeserializeAsync<PreflightRequest>(req.Body, JsonOpt());
    if (body is null || string.IsNullOrWhiteSpace(body.ContentHash) || body.Size < 0)
        return Results.BadRequest(new { error = "invalid body" });

    var userId = string.IsNullOrWhiteSpace(body.UserId) ? "local" : body.UserId.Trim();
    var fileName = string.IsNullOrWhiteSpace(body.FileName) ? "file.bin" : Path.GetFileName(body.FileName);

    var blob = db.FindBlob(body.Size, body.HeadHash ?? "", body.ContentHash);
    if (blob is not null)
    {
        var fileId = db.AddUserFile(userId, fileName, blob.ContentHash);
        db.AddRef(blob.ContentHash);
        return Results.Json(new PreflightResponse
        {
            Instant = true,
            BlobId = blob.ContentHash,
            FileId = fileId,
            Message = "instant upload"
        });
    }

    var uploadId = Guid.NewGuid().ToString("N");
    var chunkHashes = body.ChunkHashes ?? new List<string>();
    var missing = new List<int>();
    for (var i = 0; i < chunkHashes.Count; i++)
    {
        var h = chunkHashes[i];
        if (string.IsNullOrWhiteSpace(h) || !ChunkExists(dataRoot, h))
            missing.Add(i);
    }

    db.SaveUploadSession(uploadId, userId, fileName, body.Size, body.HeadHash ?? "", body.ContentHash, chunkHashes);

    return Results.Json(new PreflightResponse
    {
        Instant = false,
        UploadId = uploadId,
        MissingChunks = missing,
        ChunkSize = ChunkSize,
        Message = missing.Count == 0 ? "all chunks present, call complete" : "need upload"
    });
});

app.MapPut("/api/chunks/{uploadId}/{index:int}", async (string uploadId, int index, HttpRequest req) =>
{
    var session = db.GetUploadSession(uploadId);
    if (session is null)
        return Results.NotFound(new { error = "upload session not found" });
    if (index < 0 || index >= session.ChunkHashes.Count)
        return Results.BadRequest(new { error = "bad index" });

    var expectHash = session.ChunkHashes[index];
    string? headerHash = req.Headers.TryGetValue("X-Chunk-Hash", out var hv) ? hv.ToString() : null;
    if (!string.IsNullOrWhiteSpace(headerHash) &&
        !string.Equals(headerHash, expectHash, StringComparison.OrdinalIgnoreCase))
        return Results.BadRequest(new { error = "chunk hash mismatch header" });

    await using var ms = new MemoryStream();
    await req.Body.CopyToAsync(ms);
    var bytes = ms.ToArray();
    var actual = Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant();
    if (!string.Equals(actual, expectHash, StringComparison.OrdinalIgnoreCase))
        return Results.BadRequest(new { error = "chunk hash mismatch body", expect = expectHash, actual });

    var path = ChunkPath(dataRoot, expectHash);
    if (!File.Exists(path))
    {
        var tmp = path + ".tmp";
        await File.WriteAllBytesAsync(tmp, bytes);
        File.Move(tmp, path, overwrite: true);
    }

    return Results.Json(new { ok = true, index, hash = expectHash, size = bytes.Length });
});

app.MapPost("/api/complete", async (HttpRequest req) =>
{
    var body = await JsonSerializer.DeserializeAsync<CompleteRequest>(req.Body, JsonOpt());
    if (body is null || string.IsNullOrWhiteSpace(body.UploadId))
        return Results.BadRequest(new { error = "invalid body" });

    var session = db.GetUploadSession(body.UploadId);
    if (session is null)
        return Results.NotFound(new { error = "upload session not found" });

    foreach (var h in session.ChunkHashes)
    {
        if (!ChunkExists(dataRoot, h))
            return Results.BadRequest(new { error = "missing chunk", hash = h });
    }

    // 组装物理文件（内容寻址）
    var blobDir = Path.Combine(dataRoot, "blobs");
    Directory.CreateDirectory(blobDir);
    var blobPath = Path.Combine(blobDir, session.ContentHash + ".bin");
    if (!File.Exists(blobPath))
    {
        var tmp = blobPath + ".tmp";
        await using (var fs = new FileStream(tmp, FileMode.Create, FileAccess.Write, FileShare.None))
        {
            foreach (var h in session.ChunkHashes)
            {
                var c = await File.ReadAllBytesAsync(ChunkPath(dataRoot, h));
                await fs.WriteAsync(c);
            }
        }

        // 校验整文件哈希
        await using (var check = File.OpenRead(tmp))
        {
            var hash = Convert.ToHexString(await SHA256.HashDataAsync(check)).ToLowerInvariant();
            if (!string.Equals(hash, session.ContentHash, StringComparison.OrdinalIgnoreCase))
            {
                File.Delete(tmp);
                return Results.BadRequest(new { error = "assembled content hash mismatch" });
            }
        }

        File.Move(tmp, blobPath, overwrite: true);
    }

    db.UpsertBlob(session.ContentHash, session.HeadHash, session.Size, blobPath, session.ChunkHashes.Count);
    var fileId = db.AddUserFile(session.UserId, session.FileName, session.ContentHash);
    db.AddRef(session.ContentHash);
    db.DeleteUploadSession(body.UploadId);

    return Results.Json(new
    {
        ok = true,
        instant = false,
        fileId,
        blobId = session.ContentHash,
        path = blobPath
    });
});

app.MapGet("/api/files", (string? userId) =>
{
    userId = string.IsNullOrWhiteSpace(userId) ? "local" : userId.Trim();
    var list = db.ListFiles(userId);
    return Results.Json(list);
});

app.MapGet("/api/download/{fileId:long}", (long fileId) =>
{
    var f = db.GetFile(fileId);
    if (f is null)
        return Results.NotFound();
    var blob = db.GetBlob(f.BlobId);
    if (blob is null || !File.Exists(blob.StoragePath))
        return Results.NotFound(new { error = "blob missing" });
    return Results.File(blob.StoragePath, "application/octet-stream", f.FileName);
});

Console.WriteLine($"CloudTransferServer listening. Data: {dataRoot}");
app.Run();

static string ChunkPath(string root, string hash) =>
    Path.Combine(root, "chunks", hash.ToLowerInvariant() + ".bin");

static bool ChunkExists(string root, string hash) =>
    File.Exists(ChunkPath(root, hash));

static JsonSerializerOptions JsonOpt() => new()
{
    PropertyNameCaseInsensitive = true,
    PropertyNamingPolicy = JsonNamingPolicy.CamelCase
};

sealed class PreflightRequest
{
    public string? UserId { get; set; }
    public string? FileName { get; set; }
    public long Size { get; set; }
    public string? HeadHash { get; set; }
    public string ContentHash { get; set; } = "";
    public List<string>? ChunkHashes { get; set; }
}

sealed class PreflightResponse
{
    public bool Instant { get; set; }
    public string? BlobId { get; set; }
    public long? FileId { get; set; }
    public string? UploadId { get; set; }
    public List<int>? MissingChunks { get; set; }
    public int ChunkSize { get; set; } = ChunkSize;
    public string? Message { get; set; }
}

sealed class CompleteRequest
{
    public string UploadId { get; set; } = "";
}

sealed class CloudDb
{
    private readonly string _path;
    private readonly object _gate = new();

    public CloudDb(string path) => _path = path;

    private SqliteConnection Open()
    {
        var c = new SqliteConnection($"Data Source={_path}");
        c.Open();
        return c;
    }

    public void EnsureSchema()
    {
        lock (_gate)
        using var c = Open();
        using var cmd = c.CreateCommand();
        cmd.CommandText = """
            CREATE TABLE IF NOT EXISTS blobs (
              content_hash TEXT PRIMARY KEY,
              head_hash TEXT NOT NULL,
              size INTEGER NOT NULL,
              storage_path TEXT NOT NULL,
              chunk_count INTEGER NOT NULL,
              ref_count INTEGER NOT NULL DEFAULT 0
            );
            CREATE TABLE IF NOT EXISTS user_files (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              user_id TEXT NOT NULL,
              file_name TEXT NOT NULL,
              blob_id TEXT NOT NULL,
              created_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS upload_sessions (
              upload_id TEXT PRIMARY KEY,
              user_id TEXT NOT NULL,
              file_name TEXT NOT NULL,
              size INTEGER NOT NULL,
              head_hash TEXT NOT NULL,
              content_hash TEXT NOT NULL,
              chunk_hashes_json TEXT NOT NULL
            );
            """;
        cmd.ExecuteNonQuery();
    }

    public BlobRow? FindBlob(long size, string headHash, string contentHash)
    {
        lock (_gate)
        using var c = Open();
        using var cmd = c.CreateCommand();
        cmd.CommandText = """
            SELECT content_hash, head_hash, size, storage_path, chunk_count, ref_count
            FROM blobs
            WHERE size=$s AND head_hash=$h AND content_hash=$c
            LIMIT 1;
            """;
        cmd.Parameters.AddWithValue("$s", size);
        cmd.Parameters.AddWithValue("$h", headHash.ToLowerInvariant());
        cmd.Parameters.AddWithValue("$c", contentHash.ToLowerInvariant());
        using var r = cmd.ExecuteReader();
        if (!r.Read()) return null;
        return new BlobRow(
            r.GetString(0), r.GetString(1), r.GetInt64(2), r.GetString(3), r.GetInt32(4), r.GetInt32(5));
    }

    public BlobRow? GetBlob(string contentHash)
    {
        lock (_gate)
        using var c = Open();
        using var cmd = c.CreateCommand();
        cmd.CommandText = """
            SELECT content_hash, head_hash, size, storage_path, chunk_count, ref_count
            FROM blobs WHERE content_hash=$c LIMIT 1;
            """;
        cmd.Parameters.AddWithValue("$c", contentHash.ToLowerInvariant());
        using var r = cmd.ExecuteReader();
        if (!r.Read()) return null;
        return new BlobRow(
            r.GetString(0), r.GetString(1), r.GetInt64(2), r.GetString(3), r.GetInt32(4), r.GetInt32(5));
    }

    public void UpsertBlob(string contentHash, string headHash, long size, string storagePath, int chunkCount)
    {
        lock (_gate)
        using var c = Open();
        using var cmd = c.CreateCommand();
        cmd.CommandText = """
            INSERT INTO blobs(content_hash, head_hash, size, storage_path, chunk_count, ref_count)
            VALUES($c,$h,$s,$p,$n,0)
            ON CONFLICT(content_hash) DO UPDATE SET
              storage_path=excluded.storage_path,
              chunk_count=excluded.chunk_count;
            """;
        cmd.Parameters.AddWithValue("$c", contentHash.ToLowerInvariant());
        cmd.Parameters.AddWithValue("$h", headHash.ToLowerInvariant());
        cmd.Parameters.AddWithValue("$s", size);
        cmd.Parameters.AddWithValue("$p", storagePath);
        cmd.Parameters.AddWithValue("$n", chunkCount);
        cmd.ExecuteNonQuery();
    }

    public void AddRef(string contentHash)
    {
        lock (_gate)
        using var c = Open();
        using var cmd = c.CreateCommand();
        cmd.CommandText = "UPDATE blobs SET ref_count = ref_count + 1 WHERE content_hash=$c;";
        cmd.Parameters.AddWithValue("$c", contentHash.ToLowerInvariant());
        cmd.ExecuteNonQuery();
    }

    public long AddUserFile(string userId, string fileName, string blobId)
    {
        lock (_gate)
        using var c = Open();
        using var cmd = c.CreateCommand();
        cmd.CommandText = """
            INSERT INTO user_files(user_id, file_name, blob_id, created_at)
            VALUES($u,$n,$b,$t);
            SELECT last_insert_rowid();
            """;
        cmd.Parameters.AddWithValue("$u", userId);
        cmd.Parameters.AddWithValue("$n", fileName);
        cmd.Parameters.AddWithValue("$b", blobId.ToLowerInvariant());
        cmd.Parameters.AddWithValue("$t", DateTime.UtcNow.ToString("o"));
        return (long)(cmd.ExecuteScalar() ?? 0L);
    }

    public List<object> ListFiles(string userId)
    {
        lock (_gate)
        using var c = Open();
        using var cmd = c.CreateCommand();
        cmd.CommandText = """
            SELECT f.id, f.file_name, f.blob_id, f.created_at, b.size
            FROM user_files f
            LEFT JOIN blobs b ON b.content_hash = f.blob_id
            WHERE f.user_id=$u
            ORDER BY f.id DESC
            LIMIT 200;
            """;
        cmd.Parameters.AddWithValue("$u", userId);
        using var r = cmd.ExecuteReader();
        var list = new List<object>();
        while (r.Read())
        {
            list.Add(new
            {
                id = r.GetInt64(0),
                fileName = r.GetString(1),
                blobId = r.GetString(2),
                createdAt = r.GetString(3),
                size = r.IsDBNull(4) ? 0L : r.GetInt64(4)
            });
        }

        return list;
    }

    public UserFileRow? GetFile(long id)
    {
        lock (_gate)
        using var c = Open();
        using var cmd = c.CreateCommand();
        cmd.CommandText = "SELECT id, user_id, file_name, blob_id FROM user_files WHERE id=$i;";
        cmd.Parameters.AddWithValue("$i", id);
        using var r = cmd.ExecuteReader();
        if (!r.Read()) return null;
        return new UserFileRow(r.GetInt64(0), r.GetString(1), r.GetString(2), r.GetString(3));
    }

    public void SaveUploadSession(string uploadId, string userId, string fileName, long size,
        string headHash, string contentHash, List<string> chunkHashes)
    {
        lock (_gate)
        using var c = Open();
        using var cmd = c.CreateCommand();
        cmd.CommandText = """
            INSERT OR REPLACE INTO upload_sessions
            (upload_id, user_id, file_name, size, head_hash, content_hash, chunk_hashes_json)
            VALUES($i,$u,$n,$s,$h,$c,$j);
            """;
        cmd.Parameters.AddWithValue("$i", uploadId);
        cmd.Parameters.AddWithValue("$u", userId);
        cmd.Parameters.AddWithValue("$n", fileName);
        cmd.Parameters.AddWithValue("$s", size);
        cmd.Parameters.AddWithValue("$h", headHash.ToLowerInvariant());
        cmd.Parameters.AddWithValue("$c", contentHash.ToLowerInvariant());
        cmd.Parameters.AddWithValue("$j", JsonSerializer.Serialize(chunkHashes.Select(x => x.ToLowerInvariant()).ToList()));
        cmd.ExecuteNonQuery();
    }

    public UploadSession? GetUploadSession(string uploadId)
    {
        lock (_gate)
        using var c = Open();
        using var cmd = c.CreateCommand();
        cmd.CommandText = """
            SELECT upload_id, user_id, file_name, size, head_hash, content_hash, chunk_hashes_json
            FROM upload_sessions WHERE upload_id=$i;
            """;
        cmd.Parameters.AddWithValue("$i", uploadId);
        using var r = cmd.ExecuteReader();
        if (!r.Read()) return null;
        var hashes = JsonSerializer.Deserialize<List<string>>(r.GetString(6)) ?? new();
        return new UploadSession(
            r.GetString(0), r.GetString(1), r.GetString(2), r.GetInt64(3),
            r.GetString(4), r.GetString(5), hashes);
    }

    public void DeleteUploadSession(string uploadId)
    {
        lock (_gate)
        using var c = Open();
        using var cmd = c.CreateCommand();
        cmd.CommandText = "DELETE FROM upload_sessions WHERE upload_id=$i;";
        cmd.Parameters.AddWithValue("$i", uploadId);
        cmd.ExecuteNonQuery();
    }
}

readonly record struct BlobRow(string ContentHash, string HeadHash, long Size, string StoragePath, int ChunkCount, int RefCount);
readonly record struct UserFileRow(long Id, string UserId, string FileName, string BlobId);
readonly record struct UploadSession(
    string UploadId, string UserId, string FileName, long Size,
    string HeadHash, string ContentHash, List<string> ChunkHashes);
