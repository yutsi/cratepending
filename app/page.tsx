"use client";

import { useEffect, useRef, useState, useSyncExternalStore, type FormEvent } from "react";
import {
  basicParse,
  cleanDraft,
  empty,
  kinds,
  links,
  platform,
  recommend,
  seeds,
  type Batch,
  type Candidate,
  type Draft,
  type Entry,
  type Kind,
} from "../lib/backlog";

const storageKey = "cratepending:guest:v1";
const subscribe = () => () => {};
const themes = ["System", "Light", "Dark"] as const;
type Theme = (typeof themes)[number];
type Account = { enabled: boolean; signedIn: boolean };
type Mode = "batch" | "manual";
const repo = process.env.NEXT_PUBLIC_REPO_URL;

function PlayLinks({ entry }: { entry: Draft }) {
  return (
    <div className="links">
      {links(entry).map((link) => (
        <a key={link.label} href={link.url} target="_blank" rel="noreferrer">
          {link.label} <span aria-hidden="true">↗</span>
        </a>
      ))}
    </div>
  );
}

function DraftFields({ draft, onChange }: { draft: Draft; onChange: (value: Draft) => void }) {
  return (
    <div className="fields">
      <label>
        Type
        <select
          value={draft.kind}
          onChange={(e) => onChange({ ...draft, kind: e.target.value as Kind })}
        >
          {kinds.map((kind) => (
            <option key={kind} value={kind}>
              {kind === "label" ? "Record label" : kind}
            </option>
          ))}
        </select>
      </label>
      <label>
        Title or name
        <input
          required
          maxLength={350}
          value={draft.title}
          onChange={(e) => onChange({ ...draft, title: e.target.value })}
        />
      </label>
      {draft.kind !== "label" && draft.kind !== "note" && (
        <label>
          Artist
          <input
            maxLength={350}
            value={draft.artist}
            onChange={(e) => onChange({ ...draft, artist: e.target.value })}
          />
        </label>
      )}
      <label>
        Recommended by
        <input
          maxLength={350}
          placeholder="Friend’s name or nickname"
          value={draft.friend}
          onChange={(e) => onChange({ ...draft, friend: e.target.value })}
        />
      </label>
      <label>
        Mood or genre
        <input
          placeholder="Ambient, mellow"
          maxLength={200}
          value={draft.tags.join(",")}
          onChange={(e) => onChange({ ...draft, tags: e.target.value.split(",") })}
        />
      </label>
      <label>
        Platform link
        <input
          type="url"
          maxLength={2048}
          placeholder="https://…bandcamp.com"
          value={draft.url}
          onChange={(e) => onChange({ ...draft, url: e.target.value })}
        />
      </label>
    </div>
  );
}

export default function Home() {
  const mounted = useSyncExternalStore(
    subscribe,
    () => true,
    () => false,
  );
  const [entries, setEntries] = useState<Entry[]>([...seeds]);
  const [ready, setReady] = useState(false);
  const [account, setAccount] = useState<Account>();
  const [theme, setTheme] = useState<Theme>("System");
  const [mode, setMode] = useState<Mode>("batch");
  const [note, setNote] = useState("");
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [years, setYears] = useState<Record<number, number | undefined>>({});
  const [manual, setManual] = useState<Draft>(empty);
  const [editing, setEditing] = useState<Entry>();
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("");
  const [pick, setPick] = useState<ReturnType<typeof recommend>>();
  const [searched, setSearched] = useState(false);
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);
  const [savedOnce, setSavedOnce] = useState(false);
  const [showPrivacy, setShowPrivacy] = useState(false);
  const activeParse = useRef<AbortController>(null);
  const privacy = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    let active = true;
    async function start() {
      try {
        const data = sessionStorage.getItem(storageKey);
        if (data && active) setEntries(JSON.parse(data) as Entry[]);
        const preference = localStorage.getItem("cratepending:theme");
        if (active && themes.includes(preference as Theme)) setTheme(preference as Theme);
      } catch {
        /* Storage may be unavailable. */
      }
      if (active) setReady(true);
      try {
        const response = await fetch("/api/account", { cache: "no-store" });
        const session = response.ok ? ((await response.json()) as Account) : undefined;
        if (!active || !session) return;
        if (session.signedIn) {
          const remote = await fetch("/api/backlog", { cache: "no-store" });
          if (!remote.ok) throw new Error("Backlog unavailable");
          const items = (await remote.json()) as Entry[];
          if (active) setEntries(items);
        }
        if (active) setAccount(session);
      } catch {
        if (active) setStatus("Account storage is unavailable. You can use a guest session.");
      }
    }
    void start();
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    document.documentElement.dataset.theme = theme.toLowerCase();
    if (theme !== "System") {
      try {
        localStorage.setItem("cratepending:theme", theme);
      } catch {
        /* optional preference */
      }
    }
  }, [theme]);

  useEffect(() => {
    if (showPrivacy && !privacy.current?.open) privacy.current?.showModal();
  }, [showPrivacy]);

  async function mutate(
    next: Entry[],
    changes: { upsert?: Entry[]; remove?: string[] },
    message: string,
  ) {
    if (account?.signedIn) {
      try {
        const response = await fetch("/api/backlog", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(changes),
        });
        if (!response.ok) throw new Error("Save failed");
      } catch {
        setStatus("Your changes could not be saved. Please try again.");
        return false;
      }
    } else {
      try {
        sessionStorage.setItem(storageKey, JSON.stringify(next));
      } catch {
        message += " Browser storage is unavailable, so these changes last until you reload.";
      }
    }
    setEntries(next);
    setStatus(message);
    return true;
  }

  async function add(items: Entry[]) {
    if (!items.length) return false;
    const saved = await mutate(
      [...items, ...entries],
      { upsert: items },
      items.length === 1
        ? "Saved to your backlog."
        : `${items.length} items saved to your backlog.`,
    );
    if (saved) setSavedOnce(true);
    return saved;
  }

  function makeEntry(draft: Draft, original = "", year?: number): Entry {
    return {
      ...draft,
      id: crypto.randomUUID(),
      original,
      added: new Date().toISOString(),
      listened: false,
      year,
    };
  }

  async function parse() {
    const input = note.trim();
    if (!input) return;
    const controller = new AbortController();
    activeParse.current = controller;
    setBusy(true);
    setDrafts([]);
    setCandidates([]);
    setYears({});
    setStatus("Reading your note…");
    try {
      const response = await fetch("/api/batch/parse", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: note }),
        signal: controller.signal,
      });
      if (!response.ok) throw new Error("AI unavailable");
      const data = (await response.json()) as Batch;
      const extracted = data.entries.map(cleanDraft).filter((draft): draft is Draft => !!draft);
      if (!extracted.length) throw new Error("No entries");
      setDrafts(extracted);
      setCandidates(data.candidates);
      setStatus(
        data.limited
          ? "Review your suggestions. Some catalog checks were skipped."
          : "Review your suggestions before saving.",
      );
    } catch {
      if (controller.signal.aborted) return;
      setDrafts(basicParse(input));
      setStatus("Live AI is unavailable. These basic suggestions came from your browser.");
    } finally {
      setBusy(false);
    }
  }

  function resetNote() {
    activeParse.current?.abort();
    setNote("");
    setDrafts([]);
    setCandidates([]);
    setYears({});
  }

  async function submitManual(event: FormEvent) {
    event.preventDefault();
    if (manual.url && !platform(manual.url)) {
      setStatus("Use an HTTPS link from Spotify, YouTube, Bandcamp, or SoundCloud.");
      return;
    }
    const draft = cleanDraft({
      ...manual,
      tags: manual.tags.map((tag) => tag.trim()).filter(Boolean),
    });
    if (!draft) {
      setStatus("Enter a title or name.");
      return;
    }
    if (editing) {
      const next = { ...editing, ...draft };
      if (
        await mutate(
          entries.map((entry) => (entry.id === next.id ? next : entry)),
          { upsert: [next] },
          "Entry updated.",
        )
      )
        setEditing(undefined);
    } else if (!(await add([makeEntry(draft)]))) return;
    setManual(empty);
  }

  function download() {
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(entries, null, 2)], { type: "application/json" }),
    );
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "cratepending-backlog.json";
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  const visible = entries.filter((entry) =>
    [entry.title, entry.artist, entry.friend, entry.kind, ...entry.tags]
      .join(" ")
      .toLowerCase()
      .includes(filter.toLowerCase()),
  );

  return (
    <>
      <a className="skip" href="#main">
        Skip to content
      </a>
      <header className="top">
        <div className="shell top-inner">
          <a className="brand" href="./" aria-label="CratePending home">
            <span className="record" aria-hidden="true" />
            Crate<span>Pending</span>
          </a>
          <div className="header-actions">
            <label className="theme">
              Theme
              <select
                value={theme}
                onChange={(event) => {
                  const next = event.target.value as Theme;
                  if (next === "System") {
                    try {
                      localStorage.removeItem("cratepending:theme");
                    } catch {
                      /* optional preference */
                    }
                  }
                  setTheme(next);
                }}
              >
                {themes.map((value) => (
                  <option key={value}>{value}</option>
                ))}
              </select>
            </label>
            {account?.enabled &&
              (account.signedIn ? (
                <form action="/api/auth/logout" method="post">
                  <button className="quiet">Sign out</button>
                </form>
              ) : (
                <a href="/api/auth/login">Sign in with Google</a>
              ))}
          </div>
        </div>
      </header>
      <div className="demo">
        <div className="shell demo-inner">
          <p>
            <span className="demo-dot" aria-hidden="true" />
            <strong>{account?.enabled ? "Guest access" : "Free-tier demo"}</strong>{" "}
            <span>Live AI runs within a shared quota. Guest saves last for this tab session.</span>
          </p>
          {repo ? (
            <a href={repo} target="_blank" rel="noreferrer">
              View C# backend ↗
            </a>
          ) : (
            <a href="#backend">C# backend details ↓</a>
          )}
        </div>
      </div>
      <main id="main" className="shell">
        <section className="intro">
          <p className="eyebrow">THE LISTENING BACKLOG</p>
          <h1>
            What’s on
            <br />
            your <em>list?</em>
          </h1>
          <p>Save what you want to hear. Find the right thing to play when you’re ready.</p>
        </section>
        <div className="dashboard">
          <section className="panel capture" aria-labelledby="capture-title">
            <div className="section-title">
              <span aria-hidden="true">+</span>
              <h2 id="capture-title">Add to your crate</h2>
            </div>
            <div className="switch">
              <button
                type="button"
                aria-pressed={mode === "batch"}
                onClick={() => setMode("batch")}
              >
                Batch entry
              </button>
              <button
                type="button"
                aria-pressed={mode === "manual"}
                onClick={() => {
                  setMode("manual");
                  setEditing(undefined);
                  setManual(empty);
                }}
              >
                Manual entry
              </button>
            </div>
            {mode === "batch" ? (
              <>
                <label htmlFor="note">What should you check out?</label>
                <textarea
                  id="note"
                  disabled={busy}
                  maxLength={4000}
                  value={note}
                  onChange={(e) => {
                    setNote(e.target.value);
                    setDrafts([]);
                    setCandidates([]);
                    setYears({});
                  }}
                  aria-describedby="batch-hint"
                  placeholder="Maya recommended Tipper — Cloaked. Sam said to check out Sangoma Records."
                />
                <p className="hint" id="batch-hint">
                  Include who recommended each item. Separate entries with new lines, or write them
                  as sentences. You can paste platform links.
                </p>
                <div className="actions">
                  <button
                    className="primary"
                    disabled={!ready || !note.trim() || busy}
                    onClick={() => void parse()}
                  >
                    {busy ? "Parsing…" : "Parse with AI"}
                  </button>
                  <button
                    className="quiet"
                    disabled={!ready || !note.trim()}
                    onClick={async () => {
                      if (
                        await add([
                          makeEntry(
                            { ...empty, kind: "note", title: note.trim().slice(0, 90) },
                            note,
                          ),
                        ])
                      )
                        resetNote();
                    }}
                  >
                    Save original text
                  </button>
                </div>
                {drafts.length > 0 && (
                  <form
                    className="review"
                    onSubmit={async (event) => {
                      event.preventDefault();
                      if (drafts.some((draft) => draft.url && !platform(draft.url))) {
                        setStatus(
                          "Use an HTTPS link from Spotify, YouTube, Bandcamp, or SoundCloud.",
                        );
                        return;
                      }
                      const cleaned = drafts.map((draft) =>
                        cleanDraft({
                          ...draft,
                          tags: draft.tags.map((tag) => tag.trim()).filter(Boolean),
                        }),
                      );
                      if (cleaned.some((draft) => !draft)) {
                        setStatus("Every entry needs a title or name.");
                        return;
                      }
                      const items = cleaned.flatMap((draft, index) =>
                        draft ? [makeEntry(draft, note, years[index])] : [],
                      );
                      if (await add(items)) resetNote();
                    }}
                  >
                    <h3>Review suggested entries</h3>
                    {drafts.map((draft, index) => (
                      <fieldset key={index}>
                        <legend>Entry {index + 1}</legend>
                        <DraftFields
                          draft={draft}
                          onChange={(next) => {
                            if (
                              next.title !== draft.title ||
                              next.artist !== draft.artist ||
                              next.kind !== draft.kind
                            )
                              setYears({ ...years, [index]: undefined });
                            setDrafts(drafts.map((item, i) => (i === index ? next : item)));
                          }}
                        />
                        {candidates.some((candidate) => candidate.kind === draft.kind) && (
                          <label>
                            MusicBrainz candidates
                            <select
                              value=""
                              onChange={(event) => {
                                const item = candidates.find(
                                  (candidate) => candidate.id === event.target.value,
                                );
                                if (item) {
                                  setDrafts(
                                    drafts.map((row, i) =>
                                      i === index
                                        ? {
                                            ...row,
                                            title: item.title,
                                            artist: item.artist || row.artist,
                                            url: row.url || item.url || "",
                                          }
                                        : row,
                                    ),
                                  );
                                  setYears({ ...years, [index]: item.year });
                                }
                              }}
                            >
                              <option value="">Choose a match if it’s yours</option>
                              {candidates
                                .filter((candidate) => candidate.kind === draft.kind)
                                .map((candidate) => (
                                  <option key={candidate.id} value={candidate.id}>
                                    {[candidate.artist, candidate.title, candidate.year]
                                      .filter(Boolean)
                                      .join(" — ")}
                                  </option>
                                ))}
                            </select>
                          </label>
                        )}
                        <button
                          type="button"
                          className="quiet"
                          onClick={() => {
                            setDrafts(drafts.filter((_, i) => i !== index));
                            setYears(
                              Object.fromEntries(
                                Object.entries(years)
                                  .filter(([key]) => Number(key) !== index)
                                  .map(([key, value]) => [
                                    Number(key) > index ? Number(key) - 1 : Number(key),
                                    value,
                                  ]),
                              ),
                            );
                          }}
                        >
                          Remove entry {index + 1}
                        </button>
                      </fieldset>
                    ))}
                    <button className="primary">
                      Save {drafts.length} {drafts.length === 1 ? "entry" : "entries"}
                    </button>
                  </form>
                )}
              </>
            ) : (
              <form onSubmit={(event) => void submitManual(event)}>
                {editing && <h3>Edit {editing.title}</h3>}
                <DraftFields draft={manual} onChange={setManual} />
                {editing?.original && (
                  <details>
                    <summary>Original text</summary>
                    <p className="original">{editing.original}</p>
                  </details>
                )}
                <button className="primary" disabled={!ready || !manual.title.trim()}>
                  {editing ? "Save changes" : "Save entry"}
                </button>
              </form>
            )}
            <p className="status" role="status">
              {status}
            </p>
            {savedOnce && !account?.signedIn && (
              <p className="hint">
                {account?.enabled ? (
                  <a href="/api/auth/login">Create an account to save your backlog long-term.</a>
                ) : (
                  "Save a copy with Export. Account sign-in is off in this demo."
                )}
              </p>
            )}
          </section>
          <section className="panel recommend" aria-labelledby="recommend-title">
            <div className="section-title">
              <span aria-hidden="true">✦</span>
              <h2 id="recommend-title">Find something to play</h2>
            </div>
            <form
              onSubmit={(event) => {
                event.preventDefault();
                setPick(recommend(entries, query));
                setSearched(true);
              }}
            >
              <label htmlFor="query">What are you in the mood for?</label>
              <input
                id="query"
                maxLength={200}
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Something older from a friend…"
              />
              <div className="chips">
                {["Longest waiting", "From a friend", "A record label"].map((text) => (
                  <button type="button" key={text} onClick={() => setQuery(text)}>
                    {text}
                  </button>
                ))}
              </div>
              <button className="primary" disabled={!ready}>
                Pick from my backlog
              </button>
            </form>
            <div aria-live="polite">
              {searched &&
                (pick ? (
                  <div className="pick">
                    <p>{pick.reason}</p>
                    <h3>{pick.entry.title}</h3>
                    {pick.entry.artist && <p>{pick.entry.artist}</p>}
                    <PlayLinks entry={pick.entry} />
                  </div>
                ) : (
                  <p className="hint">
                    No unlistened entries match. Try a different friend or tag.
                  </p>
                ))}
            </div>
          </section>
        </div>
        <section className="backlog" aria-labelledby="backlog-title">
          <div className="backlog-head">
            <div>
              <h2 id="backlog-title">Your crate</h2>
              <p>{entries.filter((entry) => !entry.listened).length} waiting to explore</p>
            </div>
            <div className="actions">
              <label>
                <span className="sr">Filter entries</span>
                <input
                  type="search"
                  placeholder="Filter entries"
                  value={filter}
                  onChange={(e) => setFilter(e.target.value)}
                />
              </label>
              <button className="quiet" onClick={download}>
                Export
              </button>
            </div>
          </div>
          {visible.length === 0 && <p className="hint">No entries to show.</p>}
          <ul className="entry-list">
            {visible.map((entry) => (
              <li key={entry.id} className="entry">
                <div className={"stamp " + entry.kind} aria-hidden="true">
                  {entry.kind === "label" ? "▦" : entry.kind === "note" ? "≡" : "◉"}
                </div>
                <div className="entry-info">
                  <p className="kind">
                    {entry.kind === "label" ? "Record label" : entry.kind}
                    {entry.listened ? " · Listened" : ""}
                  </p>
                  <h3>{entry.title}</h3>
                  {(entry.artist || entry.friend || entry.year) && (
                    <p>
                      {[entry.artist, entry.year, entry.friend ? "From " + entry.friend : ""]
                        .filter(Boolean)
                        .join(" · ")}
                    </p>
                  )}
                  <div className="chips">
                    {entry.tags.map((tag, index) => (
                      <span key={index}>{tag}</span>
                    ))}
                  </div>
                  <PlayLinks entry={entry} />
                  {entry.original && (
                    <details>
                      <summary>Original text</summary>
                      <p className="original">{entry.original}</p>
                    </details>
                  )}
                </div>
                <div className="row-actions">
                  <button
                    className="quiet"
                    onClick={() => {
                      setEditing(entry);
                      setManual(entry);
                      setMode("manual");
                      document.getElementById("capture-title")?.scrollIntoView();
                    }}
                  >
                    Edit<span className="sr"> {entry.title}</span>
                  </button>
                  <button
                    className="quiet"
                    onClick={() => {
                      const next = { ...entry, listened: !entry.listened };
                      void mutate(
                        entries.map((item) => (item.id === entry.id ? next : item)),
                        { upsert: [next] },
                        next.listened
                          ? "Marked as listened."
                          : "Returned to your listening backlog.",
                      );
                    }}
                  >
                    {entry.listened ? "Mark unlistened" : "Mark listened"}
                    <span className="sr"> {entry.title}</span>
                  </button>
                  <button
                    className="quiet"
                    onClick={() =>
                      void mutate(
                        entries.filter((item) => item.id !== entry.id),
                        { remove: [entry.id] },
                        "Entry removed.",
                      )
                    }
                  >
                    Remove<span className="sr"> {entry.title}</span>
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </section>
        <section className="footer shell" id="backend">
          <div>
            <strong>CratePending</strong>
            <p>
              The public demo uses Cloudflare Workers AI. The project repository contains the
              ASP.NET backend, PostgreSQL setup, and agent tests.
            </p>
            {repo && (
              <a href={repo} target="_blank" rel="noreferrer">
                View the ASP.NET backend ↗
              </a>
            )}
          </div>
          <div className="actions">
            <button className="quiet" onClick={() => setShowPrivacy(true)}>
              Privacy
            </button>
            {!account?.signedIn && (
              <button
                className="quiet"
                onClick={() => {
                  if (window.confirm("Clear all saved items in this tab?")) {
                    setPick(undefined);
                    setSearched(false);
                    void mutate([], {}, "Guest backlog cleared.");
                  }
                }}
              >
                Clear guest backlog
              </button>
            )}
            {account?.signedIn && mounted && (
              <>
                <button
                  className="quiet"
                  onClick={async () => {
                    try {
                      const local = JSON.parse(
                        sessionStorage.getItem(storageKey) ?? "[]",
                      ) as Entry[];
                      const incoming = local.filter(
                        (item) => !entries.some((entry) => entry.id === item.id),
                      );
                      if (!incoming.length) {
                        setStatus("There are no new guest entries in this tab.");
                        return;
                      }
                      if (
                        await mutate(
                          [...incoming, ...entries],
                          { upsert: incoming },
                          "Guest entries imported.",
                        )
                      )
                        sessionStorage.removeItem(storageKey);
                    } catch {
                      setStatus("Guest entries could not be read.");
                    }
                  }}
                >
                  Import guest entries
                </button>
                <button
                  className="quiet"
                  onClick={async () => {
                    if (!window.confirm("Permanently delete your account and its saved entries?"))
                      return;
                    try {
                      const response = await fetch("/api/account", { method: "DELETE" });
                      if (response.ok) location.reload();
                      else setStatus("Account deletion failed. Try again.");
                    } catch {
                      setStatus("Account deletion failed. Try again.");
                    }
                  }}
                >
                  Delete account data
                </button>
              </>
            )}
          </div>
        </section>
      </main>
      <dialog ref={privacy} onClose={() => setShowPrivacy(false)}>
        <form method="dialog">
          <h2>Privacy</h2>
          <p>
            Guest entries stay in this tab’s session storage. A theme override is saved on this
            browser. Use Export to keep a copy or Clear guest backlog to remove your entries.
          </p>
          <p>
            Parse with AI sends the pasted text to the processing service and its model provider.
            MusicBrainz receives catalog search terms. Use manual entry or Save original text if you
            prefer to keep guest notes on this device. Platform links open the provider’s own site.
          </p>
          {account?.enabled && (
            <p>
              Signed-in entries are stored on the server. You can export or delete your account data
              from this page.
            </p>
          )}
          <button autoFocus className="primary">
            Close
          </button>
        </form>
      </dialog>
    </>
  );
}
