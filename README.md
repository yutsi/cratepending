# [Open the live CratePending demo](https://cratepending.cratepending.workers.dev/)

# CratePending

CratePending is a music backlog for releases, tracks, artists, and record labels. Capture a friend’s recommendations in one note, review what an agent found, or save your original text. Ask for a record label, a mood or genre, something from a friend, or the entry that has waited longest.

## Public demo and C# backend

The public demo runs a Next.js static export with a Cloudflare Worker and live Workers AI. The same UI runs with ASP.NET and PostgreSQL in Docker Compose. Google sign-in is disabled on the public Worker. Public guest entries stay in the tab session. C# is responsible for OAuth and long-term account storage when configured.

Both endpoints use the same model ID, prompt, tool signature and response shape. The model can request MusicBrainz searches for specific titles, artists, or labels. Server code validates and executes those requests, returns possible matches for review, and leaves saving to the listener. For an exact record-label match, it can also check MusicBrainz relationships for a Bandcamp page. No match, a quota error, and a skipped lookup all allow raw or manual saving. The same UI offers Spotify, YouTube and Bandcamp search links and keeps SoundCloud links from the listener. Release age requires a known year. The catalog lookup requires a real maintainer contact.

## Run locally

1. Install Node.js 22+ and run `npm ci` and `npm run dev` to work on the browser UI. Without an API the app uses basic parsing.
2. For the full stack, copy `.env.example` to `.env`, set a strong PostgreSQL password, and run `docker compose up`. Open `http://localhost:8080`. Compose loads `compose.override.yaml` automatically and starts the hot-reloading Next.js frontend, the API, and PostgreSQL. Leave the command running while editing frontend files. After changing C# files, run `docker compose up -d --build api` in a second terminal. To serve the production export locally, run `docker compose -f compose.yaml up --build`.
3. Set `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_AI_TOKEN` and `MUSICBRAINZ_CONTACT` for live enrichment. Set `AI_MOCK=true` for a deterministic API smoke test.
4. To enable accounts, configure Google OAuth credentials and register `http://localhost:8080/signin-google` for local testing. For a hosted backend, use HTTPS and the production callback URL, configure trusted proxy handling and `App__Origin`, and persist ASP.NET data protection keys securely. Google sign-in should ship with a PostgreSQL account-isolation test and a review of account deletion and backup retention.

## Public deploy on Cloudflare Free

Run `npm ci`, authenticate Wrangler with your Cloudflare account, set `MUSICBRAINZ_CONTACT` with `npx wrangler secret put MUSICBRAINZ_CONTACT`, and build with `NEXT_PUBLIC_REPO_URL` set to the HTTPS URL of your source repository. Run `npm run deploy:demo`. The Worker serves the Next.js export as static assets, so the UI and API share an origin. The repo URL is embedded at build time and renders in the demo banner and footer. The public service uses the free quotas for Workers, SQLite-backed Durable Objects, and Workers AI. Keep the account on the Free plan for the quota cutoff. Confirm a live tool call once deployed.

The demo enforces a short input limit, bounded model calls, an application-wide MusicBrainz throttle, and a shared lookup cache. A Cloudflare rate-limiting binding rejects sustained bursts on `/api/batch/parse` without a CAPTCHA. Guests can continue to save raw text or use basic parsing when the model quota is exhausted. Use the default workers.dev hostname first, then configure your Cloudflare custom domain and the optional redirect from your portfolio.

## AWS exercise

The optional SAM template deploys only the ASP.NET batch endpoint with a mock model. It demonstrates Lambda, API Gateway, and CloudWatch with the same C# project. Use an eligible AWS Free account, and keep the public portfolio demo on Cloudflare. From the repository root, run `sam build --template-file infra/aws/template.yaml`, then `sam local start-api` to test in Docker or `sam deploy --guided` for a temporary cloud environment. Send a POST with `{"text":"Test upload"}` to the printed endpoint. Run `sam delete` after inspecting logs and remove any remaining log groups or deployment artifacts if created.

## Checks and privacy

GitHub Actions runs formatting, lint, type checks, unit tests, desktop and mobile E2E/accessibility tests, a static build, a Worker packaging check, and an ASP.NET HTTP smoke test. Run `node evals/run.mjs http://localhost:8080` against a live-model configuration, then run it against the deployed demo to compare extraction. Live evaluation calls consume quota.

Use the in-app privacy notice as a starting point. Before launch, publish your controller contact, legal basis, processors, retention periods, and rights process. Verify the Cloudflare model and logging settings, keep notes out of request logs, and document how deletion works for backups. The demo has no analytics or embedded players. MusicBrainz receives search terms only.
