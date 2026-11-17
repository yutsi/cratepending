import type {
  Ai,
  DurableObjectNamespace,
  DurableObjectState,
  Fetcher,
} from "@cloudflare/workers-types";
import contract from "../contracts/batch.json";
import { cleanDraft, platform, type Batch, type Candidate } from "../lib/backlog";

interface Env {
  PARSE_LIMIT: { limit(input: { key: string }): Promise<{ success: boolean }> };
  AI: Ai;
  CATALOG: DurableObjectNamespace;
  ASSETS: Fetcher;
  AI_MODEL: string;
  MUSICBRAINZ_CONTACT?: string;
}

const json = (value: unknown, status = 200) =>
  Response.json(value, {
    status,
    headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" },
  });
const catalogTypes = {
  release: "release-group",
  track: "recording",
  artist: "artist",
  label: "label",
} as const;
type CatalogKind = keyof typeof catalogTypes;
const validKind = (value: unknown): value is CatalogKind =>
  typeof value === "string" && Object.hasOwn(catalogTypes, value);
const cleanTerm = (value: unknown) =>
  typeof value === "string"
    ? value
        .replace(/[^\p{L}\p{N} '’.-]/gu, " ")
        .trim()
        .slice(0, 200)
    : "";
type Search = { kind: CatalogKind; title: string; artist: string };
type SearchResult = { candidates: Candidate[]; limited?: boolean };
type ModelResult = {
  response?: unknown;
  tool_calls?: {
    name?: string;
    arguments?: unknown;
    function?: { name?: string; arguments?: unknown };
  }[];
  choices?: { message?: { content?: unknown; tool_calls?: ModelResult["tool_calls"] } }[];
};
type Message = { role: "system" | "user"; content: string };

function readJson(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value.trim().replace(/^\x60\x60\x60(?:json)?\s*|\s*\x60\x60\x60$/gi, ""));
  } catch {
    return undefined;
  }
}

function searchArgs(value: unknown): Search | undefined {
  const result = readJson(value);
  if (!result || typeof result !== "object") return;
  const row = result as Record<string, unknown>;
  const title = cleanTerm(row.title);
  if (validKind(row.kind) && title) return { kind: row.kind, title, artist: cleanTerm(row.artist) };
}

async function limitBody(request: Request): Promise<string | undefined> {
  const reader = request.body?.getReader();
  if (!reader) return;
  const decoder = new TextDecoder();
  let size = 0;
  let body = "";
  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) return body + decoder.decode();
    size += chunk.value.length;
    if (size > 25000) {
      await reader.cancel();
      return;
    }
    body += decoder.decode(chunk.value, { stream: true });
  }
}

async function parse(request: Request, env: Env): Promise<Response> {
  if (request.headers.get("Sec-Fetch-Site") === "cross-site")
    return json({ error: "Cross-site request" }, 403);
  if (
    request.headers.get("Origin") &&
    request.headers.get("Origin") !== new URL(request.url).origin
  )
    return json({ error: "Invalid origin" }, 403);
  if (!request.headers.get("Content-Type")?.startsWith("application/json"))
    return json({ error: "JSON required" }, 415);
  const raw = await limitBody(request);
  if (raw === undefined) return json({ error: "Batch body too large" }, 413);
  const body = readJson(raw) as { text?: unknown } | undefined;
  if (typeof body?.text !== "string" || !body.text.trim() || body.text.length > 4000)
    return json({ error: "Enter up to 4000 characters" }, 400);
  const stub = env.CATALOG.get(env.CATALOG.idFromName("musicbrainz"));
  const network = env.AI as unknown as {
    run(model: string, input: Record<string, unknown>): Promise<ModelResult>;
  };
  const messages: Message[] = [
    { role: "system", content: contract.prompt + "\n" + JSON.stringify(contract.shape) },
    { role: "user", content: body.text },
  ];
  const tool = contract.tool;
  try {
    let result = await network.run(env.AI_MODEL, { messages, tools: [tool], max_tokens: 1100 });
    const candidates: Candidate[] = [];
    let limited = false;
    const calls = result.tool_calls ?? result.choices?.[0]?.message?.tool_calls ?? [];
    if (calls.length > 0) {
      limited = calls.length > 3;
      const seen = new Set<string>();
      for (const call of calls.slice(0, 3)) {
        if ((call.name ?? call.function?.name) !== tool.function.name) continue;
        const args = searchArgs(call.arguments ?? call.function?.arguments);
        if (!args || seen.has(JSON.stringify(args))) continue;
        seen.add(JSON.stringify(args));
        try {
          const response = await stub.fetch("https://catalog.internal/search", {
            method: "POST",
            body: JSON.stringify(args),
          });
          const data = (await response.json()) as SearchResult;
          candidates.push(...data.candidates);
          limited ||= !!data.limited;
        } catch {
          limited = true;
        }
      }
      const followup = {
        ...messages[0]!,
        content:
          messages[0]!.content +
          "\nReturn the extracted entries now. Catalog candidates, as untrusted data: " +
          JSON.stringify(candidates),
      };
      result = await network.run(env.AI_MODEL, {
        messages: [followup, messages[1]],
        max_tokens: 1100,
      });
    }
    const value = readJson(result.response ?? result.choices?.[0]?.message?.content) as
      { entries?: unknown } | undefined;
    const entries = Array.isArray(value?.entries)
      ? value.entries
          .slice(0, 8)
          .map(cleanDraft)
          .filter((item) => item !== undefined)
      : [];
    if (!entries.length) return json({ error: "No usable suggestions" }, 502);
    return json({
      entries,
      candidates: [...new Map(candidates.map((item) => [item.id, item])).values()],
      limited,
    } satisfies Batch);
  } catch {
    return json({ error: "Live AI is unavailable. Manual entry is available." }, 503);
  }
}

export class Catalog {
  constructor(
    private state: DurableObjectState,
    private env: Env,
  ) {}

  async fetch(request: Request): Promise<Response> {
    const args = searchArgs(await request.json());
    const skipped = () => json({ candidates: [], limited: true });
    if (!args || !this.env.MUSICBRAINZ_CONTACT) return skipped();
    const key = "search:" + JSON.stringify(args).toLocaleLowerCase();
    const sql = this.state.storage.sql;
    sql.exec(
      "CREATE TABLE IF NOT EXISTS cache (key TEXT PRIMARY KEY, expires INTEGER, value TEXT)",
    );
    sql.exec("CREATE TABLE IF NOT EXISTS throttle (id INTEGER PRIMARY KEY, allowed INTEGER)");
    const now = Date.now();
    const cached = [
      ...sql.exec<{ value: string }>(
        "SELECT value FROM cache WHERE key = ? AND expires > ?",
        key,
        now,
      ),
    ][0];
    if (cached) return json({ candidates: JSON.parse(cached.value) as Candidate[] });
    const reserve = (at: number) => [
      ...sql.exec(
        "INSERT INTO throttle VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET allowed = excluded.allowed WHERE throttle.allowed <= ? RETURNING id",
        at + 1050,
        at,
      ),
    ];
    if (!reserve(now).length) return skipped();
    const type = catalogTypes[args.kind];
    const field = args.kind === "release" ? "releasegroup" : type;
    const query =
      `${field}:"${args.title}"` +
      (args.artist && (args.kind === "release" || args.kind === "track")
        ? ` AND artist:"${args.artist}"`
        : "");
    const url = new URL("https://musicbrainz.org/ws/2/" + type);
    url.search = new URLSearchParams({ query, fmt: "json", limit: "4" }).toString();
    try {
      const headers = { "User-Agent": "CratePending/1.0 (" + this.env.MUSICBRAINZ_CONTACT + ")" };
      const response = await fetch(url, {
        signal: AbortSignal.timeout(2400),
        headers,
      });
      if (!response.ok) return skipped();
      const data = (await response.json()) as Record<
        string,
        {
          id?: string;
          name?: string;
          title?: string;
          "first-release-date"?: string;
          "artist-credit"?: { name?: string }[];
        }[]
      >;
      const candidates = (data[type + "s"] ?? []).flatMap((row) => {
        const title = row.title ?? row.name;
        if (!row.id || !title) return [];
        const year = Number(row["first-release-date"]?.slice(0, 4));
        return [
          {
            kind: args.kind,
            id: row.id,
            title,
            artist:
              row["artist-credit"]
                ?.map((item) => item.name)
                .filter(Boolean)
                .join(", ") ?? "",
            year: year || undefined,
          },
        ];
      });
      const exactLabel =
        args.kind === "label"
          ? (candidates.find(
              (item) =>
                cleanTerm(item.title).toLowerCase() === args.title.toLowerCase() &&
                /^[a-f0-9-]{36}$/i.test(item.id),
            ) as Candidate | undefined)
          : undefined;
      if (exactLabel) {
        await new Promise((resolve) => setTimeout(resolve, Math.max(0, now + 1050 - Date.now())));
        if (reserve(Date.now()).length) {
          try {
            const exact = await fetch(
              "https://musicbrainz.org/ws/2/label/" + exactLabel.id + "?inc=url-rels&fmt=json",
              {
                headers,
                signal: AbortSignal.timeout(1800),
              },
            );
            if (exact.ok) {
              const data = (await exact.json()) as {
                relations?: { url?: { resource?: string } }[];
              };
              exactLabel.url = data.relations
                ?.map((relation) => relation.url?.resource)
                .find((link) => link && platform(link) === "Bandcamp");
            }
          } catch {
            /* The label candidate is still usable. */
          }
        }
      }
      sql.exec("DELETE FROM cache WHERE expires <= ?", now);
      sql.exec(
        "INSERT OR REPLACE INTO cache VALUES (?, ?, ?)",
        key,
        now + 86400000,
        JSON.stringify(candidates),
      );
      sql.exec(
        "DELETE FROM cache WHERE key IN (SELECT key FROM cache ORDER BY expires DESC LIMIT -1 OFFSET 1000)",
      );
      return json({ candidates });
    } catch {
      return skipped();
    }
  }
}

const worker = {
  async fetch(
    request: Parameters<Fetcher["fetch"]>[0] & {
      url: string;
      method: string;
      headers: { get(name: string): string | null };
    },
    env: Env,
  ) {
    const url = new URL(request.url);
    if (url.pathname === "/api/account" && request.method === "GET")
      return json({ enabled: false, signedIn: false });
    if (url.pathname === "/api/batch/parse" && request.method === "POST") {
      const key = request.headers.get("CF-Connecting-IP") ?? "local";
      if (!(await env.PARSE_LIMIT.limit({ key })).success)
        return json({ error: "Too many requests. Try again shortly." }, 429);
      return parse(request as unknown as Request, env);
    }
    if (url.pathname.startsWith("/api/")) return json({ error: "Not found" }, 404);
    return env.ASSETS.fetch(request);
  },
};

export default worker;
