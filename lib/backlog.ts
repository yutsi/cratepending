export type Kind = "release" | "track" | "artist" | "label" | "note";
export const kinds: Kind[] = ["release", "track", "artist", "label", "note"];
export type Draft = {
  kind: Kind;
  title: string;
  artist: string;
  friend: string;
  tags: string[];
  url: string;
};
export type Entry = Draft & {
  id: string;
  added: string;
  original: string;
  listened: boolean;
  year?: number;
};
export type Candidate = {
  kind: Kind;
  title: string;
  artist: string;
  id: string;
  year?: number;
  url?: string;
};
export type Batch = { entries: Draft[]; candidates: Candidate[]; limited?: boolean };
export const empty: Draft = {
  kind: "release",
  title: "",
  artist: "",
  friend: "",
  tags: [],
  url: "",
};
export const seeds: Entry[] = [
  {
    ...empty,
    id: "cloaked",
    kind: "release",
    title: "Cloaked",
    artist: "Tipper",
    year: 2026,
    tags: ["Psybient", "Downtempo"],
    url: "https://tipper.bandcamp.com/album/cloaked",
    added: "2026-02-14T00:00:00Z",
    original: "",
    listened: false,
  },
  {
    ...empty,
    id: "sangoma",
    kind: "label",
    title: "Sangoma Records",
    tags: ["Psytrance"],
    url: "https://sangomarecs.bandcamp.com/",
    added: "2026-03-01T00:00:00Z",
    original: "",
    listened: false,
  },
];

export function platform(value: string): string | undefined {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || url.port) return;
    const host = url.hostname;
    if (host === "open.spotify.com") return "Spotify";
    if (["youtube.com", "www.youtube.com", "music.youtube.com", "youtu.be"].includes(host))
      return "YouTube";
    if (host === "bandcamp.com" || host.endsWith(".bandcamp.com")) return "Bandcamp";
    if (["soundcloud.com", "www.soundcloud.com", "on.soundcloud.com"].includes(host))
      return "SoundCloud";
  } catch {
    return;
  }
}

export function links(item: Draft) {
  const source = platform(item.url);
  const direct = source ? [{ label: source, url: item.url }] : [];
  if (item.kind === "note") return direct;
  const q = encodeURIComponent([item.artist, item.title].filter(Boolean).join(" "));
  const options = [
    { label: "Spotify search", url: "https://open.spotify.com/search/" + q, platform: "Spotify" },
    {
      label: "YouTube search",
      url: "https://www.youtube.com/results?search_query=" + q,
      platform: "YouTube",
    },
    { label: "Bandcamp search", url: "https://bandcamp.com/search?q=" + q, platform: "Bandcamp" },
  ];
  return [...direct, ...options.filter((option) => option.platform !== source)];
}

export function cleanDraft(value: unknown): Draft | undefined {
  if (!value || typeof value !== "object") return;
  const row = value as Record<string, unknown>;
  const string = (key: string) =>
    typeof row[key] === "string" ? row[key].trim().slice(0, 350) : "";
  const kind = kinds.find((item) => row.kind === item);
  const title = string("title");
  if (!kind || !title) return;
  const url = typeof row.url === "string" ? row.url.trim().slice(0, 2048) : "";
  const tags = Array.isArray(row.tags)
    ? row.tags
        .filter((tag): tag is string => typeof tag === "string")
        .slice(0, 10)
        .map((tag) => tag.slice(0, 40))
    : [];
  return {
    kind,
    title,
    artist: string("artist"),
    friend: string("friend"),
    tags,
    url: platform(url) ? url : "",
  };
}

export function basicParse(text: string): Draft[] {
  return text
    .split(/\n+|;\s*|(?<=[.!?])\s+(?=[A-Z])/)
    .slice(0, 8)
    .flatMap((part) => {
      const raw = part.trim();
      if (!raw) return [];
      const url = raw.match(/https:\/\/[^\s]+/)?.[0].replace(/[.!?)]$/, "") ?? "";
      const plain = raw
        .replace(url, "")
        .trim()
        .replace(/[.!?]+$/, "")
        .trim();
      const friend = plain.match(
        /^(.+?)\s+(?:recommended(?:\s+me)?|suggested|said to (?:check out|listen to))\s+(.+)$/i,
      );
      const name = (friend?.[2] ?? plain).replace(/^["“']|["”']$/g, "");
      const pair = name.split(/\s+[-–—]\s+/, 2);
      return [
        {
          ...empty,
          kind: /\b(?:records|recordings|label)$/i.test(name)
            ? "label"
            : pair.length > 1
              ? "release"
              : "note",
          title: (pair[1] ?? name) || url || raw,
          artist: pair.length > 1 ? (pair[0] ?? "") : "",
          friend: friend?.[1] ?? "",
          url: platform(url) ? url : "",
        },
      ];
    });
}

export function recommend(
  entries: Entry[],
  request: string,
): { entry: Entry; reason: string } | undefined {
  const query = request.toLocaleLowerCase().trim();
  const pool = entries.filter((entry) => !entry.listened);
  const includes = (value: string) =>
    value.length > 0 &&
    (" " + query.replace(/[^\p{L}\p{N}]+/gu, " ") + " ").includes(
      " " + value.toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ") + " ",
    );
  const friends = entries.map((entry) => entry.friend).filter(includes);
  const byFriend = friends.length > 0 || /\b(?:friend|friends)\b/.test(query);
  const tags = new Set(
    entries
      .flatMap((entry) => entry.tags)
      .filter(includes)
      .map((tag) => tag.toLowerCase()),
  );
  const oldRelease =
    /\b(?:old|older|oldest) (?:release|track|album|record)/.test(query) ||
    /\b(?:release|track|album|record) from before\b/.test(query);
  const old = /\b(?:old|older|oldest|longest|earliest)\b/.test(query);
  const label = /\b(?:label|labels|record label)\b/.test(query);
  const timeSort = (a: Entry, b: Entry) => a.added.localeCompare(b.added);
  const eligible = pool.filter(
    (entry) =>
      (!byFriend ||
        (friends.length
          ? friends.some((friend) => friend.toLowerCase() === entry.friend.toLowerCase())
          : entry.friend)) &&
      (!tags.size || entry.tags.some((tag) => tags.has(tag.toLowerCase()))) &&
      (!oldRelease || !!entry.year) &&
      (!label || entry.kind === "label"),
  );
  const entry = eligible.sort((a, b) =>
    oldRelease
      ? (a.year ?? Infinity) - (b.year ?? Infinity) || timeSort(a, b)
      : old
        ? timeSort(a, b)
        : b.added.localeCompare(a.added),
  )[0];
  if (!entry) return;
  const reasons = [
    oldRelease && "Earliest known release",
    old && !oldRelease && "Longest in your backlog",
    byFriend && "From " + entry.friend,
    tags.size > 0 && entry.tags.filter((tag) => tags.has(tag.toLowerCase())).join(", "),
    label && "Record label",
  ].filter(Boolean);
  return { entry, reason: reasons.join(" · ") || "Still waiting in your backlog" };
}
