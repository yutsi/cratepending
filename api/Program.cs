using System.Security.Claims;
using System.Text.Json;
using System.Threading.RateLimiting;
using Amazon.Lambda.AspNetCoreServer.Hosting;
using Microsoft.AspNetCore.Authentication;
using Microsoft.AspNetCore.Authentication.Cookies;
using Microsoft.AspNetCore.Authentication.Google;
using Npgsql;

var builder = WebApplication.CreateBuilder(args);
var config = builder.Configuration;
var connection = config.GetConnectionString("Postgres");
var clientId = config["Google:ClientId"];
var oauthEnabled = !string.IsNullOrWhiteSpace(connection) && !string.IsNullOrWhiteSpace(clientId)
    && !string.IsNullOrWhiteSpace(config["Google:ClientSecret"]);
builder.WebHost.ConfigureKestrel(options => options.Limits.MaxRequestBodySize = 128_000);
builder.Services.AddAWSLambdaHosting(LambdaEventSource.HttpApi);
builder.Services.AddMemoryCache(options => options.SizeLimit = 1_000);
builder.Services.AddHttpClient<BatchAgent>(client => client.Timeout = TimeSpan.FromSeconds(18));
builder.Services.AddRateLimiter(options =>
{
    options.RejectionStatusCode = 429;
    options.AddPolicy("ai", context => RateLimitPartition.GetFixedWindowLimiter(
        context.Connection.RemoteIpAddress?.ToString() ?? "unknown",
        _ => new FixedWindowRateLimiterOptions { PermitLimit = 12, Window = TimeSpan.FromMinutes(1) }));
});
var authentication = builder.Services.AddAuthentication(CookieAuthenticationDefaults.AuthenticationScheme)
    .AddCookie(options =>
    {
        options.Cookie.Name = "cratepending.account";
        options.Cookie.HttpOnly = true;
        options.Cookie.SecurePolicy = CookieSecurePolicy.SameAsRequest;
        options.Cookie.SameSite = SameSiteMode.Lax;
        options.ExpireTimeSpan = TimeSpan.FromDays(7);
    });
if (oauthEnabled)
{
    authentication.AddGoogle(options =>
    {
        options.ClientId = clientId!;
        options.ClientSecret = config["Google:ClientSecret"]!;
        options.SaveTokens = false;
        options.Events.OnCreatingTicket = ticket =>
        {
            var id = ticket.Principal?.FindFirstValue(ClaimTypes.NameIdentifier);
            if (id is null) { ticket.Fail("Missing Google subject"); return Task.CompletedTask; }
            ticket.Principal = new ClaimsPrincipal(new ClaimsIdentity(
                [new Claim(ClaimTypes.NameIdentifier, "google:" + id)], ticket.Scheme.Name));
            return Task.CompletedTask;
        };
    });
    builder.Services.AddSingleton(_ => NpgsqlDataSource.Create(connection!));
}
builder.Services.AddAuthorization();
var app = builder.Build();
if (oauthEnabled)
{
    await using var command = app.Services.GetRequiredService<NpgsqlDataSource>().CreateCommand(
        "CREATE TABLE IF NOT EXISTS backlog (account text NOT NULL, id text NOT NULL, data jsonb NOT NULL, PRIMARY KEY(account,id))");
    await command.ExecuteNonQueryAsync();
}
app.Use(async (context, next) =>
{
    if (context.Request.Path.StartsWithSegments("/api"))
    {
        context.Response.Headers.CacheControl = "no-store";
        context.Response.Headers.XContentTypeOptions = "nosniff";
        if (!HttpMethods.IsGet(context.Request.Method))
        {
            var origin = context.Request.Headers.Origin.ToString();
            var allowed = config["App:Origin"] ?? (context.Request.Scheme + "://" + context.Request.Host);
            if (context.Request.Headers["Sec-Fetch-Site"] == "cross-site" ||
                (origin.Length > 0 && !string.Equals(origin, allowed, StringComparison.OrdinalIgnoreCase)) ||
                (context.Request.Path != "/api/batch/parse" && origin.Length == 0))
            {
                context.Response.StatusCode = 403;
                return;
            }
        }
    }
    await next();
});
app.UseRateLimiter();
app.UseAuthentication();
app.UseAuthorization();
app.MapGet("/api/account", (HttpContext context) =>
    Results.Ok(new { enabled = oauthEnabled, signedIn = Account(context) is not null }));
app.MapPost("/api/batch/parse", async (BatchInput input, BatchAgent agent, CancellationToken ct) =>
{
    if (string.IsNullOrWhiteSpace(input.Text) || input.Text.Length > 4000)
        return Results.BadRequest(new { error = "Enter up to 4000 characters" });
    var batch = await agent.Parse(input.Text, ct);
    return batch is null ? Results.Json(new { error = "Live AI unavailable" }, statusCode: 503) : Results.Ok(batch);
}).RequireRateLimiting("ai");

if (oauthEnabled)
{
    app.MapGet("/api/auth/login", () => Results.Challenge(new AuthenticationProperties { RedirectUri = "/" }, [GoogleDefaults.AuthenticationScheme]));
    app.MapPost("/api/auth/logout", async (HttpContext context) =>
    {
        await context.SignOutAsync();
        return Results.Redirect("/");
    });
    app.MapGet("/api/backlog", async (HttpContext context, NpgsqlDataSource source, CancellationToken ct) =>
    {
        if (Account(context) is not { } account) return Results.Unauthorized();
        await using var command = source.CreateCommand("SELECT data::text FROM backlog WHERE account = $1 ORDER BY data->>'added' DESC");
        command.Parameters.AddWithValue(account);
        await using var reader = await command.ExecuteReaderAsync(ct);
        var entries = new List<JsonElement>();
        while (await reader.ReadAsync(ct))
            entries.Add(JsonSerializer.Deserialize<JsonElement>(reader.GetString(0)));
        return Results.Ok(entries);
    });
    app.MapPost("/api/backlog", async (HttpContext context, Changes input, NpgsqlDataSource source, CancellationToken ct) =>
    {
        if (Account(context) is not { } account) return Results.Unauthorized();
        var upserts = input.Upsert ?? [];
        var removals = input.Remove ?? [];
        if (upserts.Length + removals.Length > 50 || upserts.Any(entry => !Input.ValidEntry(entry)) ||
            removals.Any(id => !Input.ValidId(id)))
            return Results.BadRequest();
        await using var db = await source.OpenConnectionAsync(ct);
        await using var transaction = await db.BeginTransactionAsync(ct);
        foreach (var entry in upserts)
        {
            await using var command = new NpgsqlCommand(
                "INSERT INTO backlog (account,id,data) VALUES ($1,$2,$3::jsonb) ON CONFLICT (account,id) DO UPDATE SET data=excluded.data",
                db, transaction);
            command.Parameters.AddWithValue(account);
            command.Parameters.AddWithValue(entry.GetProperty("id").GetString()!);
            command.Parameters.AddWithValue(entry.GetRawText());
            await command.ExecuteNonQueryAsync(ct);
        }
        foreach (var id in removals)
        {
            await using var command = new NpgsqlCommand("DELETE FROM backlog WHERE account = $1 AND id = $2", db, transaction);
            command.Parameters.AddWithValue(account);
            command.Parameters.AddWithValue(id);
            await command.ExecuteNonQueryAsync(ct);
        }
        await transaction.CommitAsync(ct);
        return Results.NoContent();
    });
    app.MapDelete("/api/account", async (HttpContext context, NpgsqlDataSource source, CancellationToken ct) =>
    {
        if (Account(context) is not { } account) return Results.Unauthorized();
        await using var command = source.CreateCommand("DELETE FROM backlog WHERE account = $1");
        command.Parameters.AddWithValue(account);
        await command.ExecuteNonQueryAsync(ct);
        await context.SignOutAsync();
        return Results.NoContent();
    });
}

app.Run();
static string? Account(HttpContext context) => context.User.FindFirstValue(ClaimTypes.NameIdentifier);
public sealed record BatchInput(string? Text);
public sealed record Changes(JsonElement[]? Upsert, string[]? Remove);
