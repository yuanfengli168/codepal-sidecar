# codepal-sidecar — Design Document

> Captured 2026-05-22 from a multi-turn design discussion. This document
> is the single source of truth for what we're building, why, and how
> the responsibilities split between the **CodePal server**
> (yuanfengli168/codepal) and the **sidecar webpage**
> (yuanfengli168/codepal-sidecar — this repo).
>
> **Status: design only. Do not implement yet — pending green-light from Jacky.**

---

## 1. Problem statement

GitHub Copilot's API endpoint is pinned to `*.githubcopilot.com` and
ignores `HTTPS_PROXY`. We cannot transparently intercept Copilot
traffic, so we cannot transparently feed it through CodePal's tier
A/B/C ladder.

We need a workflow where the user, *by choice*, asks CodePal first —
ideally with a single screen and minimal friction — and only forwards
to Copilot when CodePal can't answer locally. The whole point is to
avoid sending bulk repo context to a premium API when a local answer
would do.

## 2. Goals & non-goals

### Goals (v0)

- One static page on GitHub Pages that talks to a locally-running
  CodePal server.
- Per-user persistence of the local port (so the user can use multiple
  machines).
- Visible accounting of cost savings: counter of local vs. forwarded
  queries.
- Rate every answer (👍/👎 + optional note) and feed that signal back
  into CodePal's bug DB.
- Zero build step — vanilla HTML/JS/CSS served straight from GH Pages.

### Non-goals (v0)

- Intercepting Copilot's actual traffic (impossible without forking).
- Real-time streaming of tier-B answers (defer to v1).
- Multi-user collaboration on a single CodePal instance.
- Mobile-optimized UI (desktop only).
- Safari support (Chrome / Edge / Firefox only).

## 3. Locked-in decisions

| # | Decision | Source |
|---|---|---|
| 1 | Sidecar webpage lives in its own public repo: `yuanfengli168/codepal-sidecar` | Q&A 2026-05-22 |
| 2 | Hosted via **GitHub Pages** off `main` branch root | Q&A 2026-05-22 |
| 3 | **CORS** added to CodePal whitelisting `https://yuanfengli168.github.io` + `http://localhost:*` | Q&A 2026-05-22 |
| 4 | Authentication uses **AuthKit** (`yuanfengli168/authkit`) — Firebase Google sign-in, no new Firebase project | Q&A 2026-05-22 |
| 5 | **Per-user local port** stored in AuthKit's Saved Keys (Firestore subcollection `users/{uid}/savedKeys`) | Q&A 2026-05-22 |
| 6 | **Tier-C disabled by default** for page-initiated queries — new `allow_external: bool = False` flag on `QueryRequest` | Q&A 2026-05-22 |
| 7 | **Project context** is a **free-text input** (local path or repo URL); last value persisted in `localStorage` | Q&A 2026-05-22 |
| 8 | Counter persistence: **`localStorage` only** in v0; sync to Firestore deferred to v1 | Default |
| 9 | Feedback storage in CodePal: **sqlite** at `~/.codepal/feedback.db` (single-table schema) | Default |
| 10 | UI framework: **vanilla JS + hand-rolled CSS** (no React/Svelte, no Pico/Tailwind) | Default |
| 11 | Browser support: **Chrome / Edge / Firefox**. Safari may break on HTTPS→HTTP-localhost; documented as not supported in v0 | Q&A 2026-05-22 |
| 12 | License: **TBD** — add before first feature commit | Open |

## 4. Architecture

```
┌─────────────────────────────────┐         ┌──────────────────────┐
│  Chrome on user's laptop         │         │  Firebase            │
│                                  │         │  (AuthKit project)   │
│  https://yuanfengli168.github.io │         │                      │
│         /codepal-sidecar/         │ ──auth─▶│  Google OAuth        │
│  ┌────────────────────────────┐  │         │  Firestore:          │
│  │ index.html / app.js        │  │ ◀────── │   users/{uid}/       │
│  │                            │  │         │     savedKeys/port   │
│  └────────────┬───────────────┘  │         └──────────────────────┘
│               │                  │
│               │ fetch()          │
│               ▼                  │
│  http://localhost:<port>/v1/...  │
│  ┌────────────────────────────┐  │
│  │ CodePal server             │  │
│  │  - CORS allows GH Pages    │  │
│  │  - tier A/B/(C-gated)       │  │
│  │  - new POST /v1/feedback   │  │
│  └────────────────────────────┘  │
└─────────────────────────────────┘
```

### 4.1 Trust model

- CodePal binds to `127.0.0.1` only → the local server is reachable
  exclusively from the user's own browser. **No auth enforcement on
  CodePal in v0** — the localhost binding is the gate.
- AuthKit/Firebase auth is purely a UX layer for "remember my port"
  and "rate/save across machines". CodePal does not validate Firebase
  tokens.
- If a future version exposes CodePal on a LAN/IP, we MUST add a
  Bearer-token check that validates Firebase ID tokens. **Out of
  scope for v0.**

## 5. Server-side prerequisite PR (`codepal` repo)

Four items, each with tests:

### 5.1 CORS middleware

- New `[cors]` section in TOML config:
  ```toml
  [cors]
  allow_origins = [
    "http://localhost",
    "http://localhost:8742",
    "https://yuanfengli168.github.io",
  ]
  allow_origin_regex = "^http://(localhost|127\\.0\\.0\\.1)(:\\d+)?$"
  allow_credentials = false
  allow_methods = ["GET", "POST", "OPTIONS"]
  allow_headers = ["*"]
  ```
- New `CORSConfig` pydantic model in `codepal/config.py`.
- `fastapi.middleware.cors.CORSMiddleware` added in `codepal/api/app.py`
  inside `create_app()`.
- Tests: preflight `OPTIONS` from `https://yuanfengli168.github.io` returns
  the correct `Access-Control-Allow-Origin` header; preflight from a
  random origin gets rejected.

### 5.2 `allow_external` flag on `QueryRequest`

- Add field to `codepal.api.models.QueryRequest`:
  ```python
  allow_external: bool = Field(
      True,
      description=(
          "If False, dispatcher returns 'no local match' instead of "
          "forwarding to the external LLM (tier C). Use this from "
          "sidecar UIs that want the user to decide whether to pay."
      ),
  )
  ```
- `QueryDispatcher.dispatch()` must respect the flag: when `False` and
  tiers A+B both fail, return a `QueryResponse` with
  `source="none"`, `answer=""`, plus the retrieved `context_chunks`
  (so the page can still display them and offer "copy to Copilot").
- Tests: parametrized — flag `True` → tier C runs; flag `False` →
  tier C skipped, response shape preserved.

### 5.3 `POST /v1/feedback` endpoint

- New `api/routes/feedback.py`.
- Request body:
  ```python
  class FeedbackRequest(BaseModel):
      query: str
      answer: str
      rating: Literal["up", "down"]
      source: str            # bug_db | local_llm | external_llm | none
      project_slug: str | None = None
      notes: str | None = None
  ```
- Storage: sqlite at `~/.codepal/feedback.db`, single table:
  ```sql
  CREATE TABLE IF NOT EXISTS feedback (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    ts          TEXT    NOT NULL,
    query       TEXT    NOT NULL,
    answer      TEXT    NOT NULL,
    rating      TEXT    NOT NULL CHECK (rating IN ('up', 'down')),
    source      TEXT    NOT NULL,
    project_slug TEXT,
    notes       TEXT
  );
  ```
- Response: `{"id": 42, "ts": "2026-05-22T..."}`.
- Tests: round-trip insert + read; reject invalid rating; persists
  across process restarts (file-backed).

### 5.4 No new `/v1/projects` endpoint (per decision #7)

Free-text input means the page sends `project_slug` directly. CodePal's
existing `_derive_slug()` in `api/routes/index.py` already handles both
paths and URLs; expose it via a small helper if reuse is needed.

---

## 6. Sidecar page (`codepal-sidecar` repo) — v0 spec

### 6.1 File layout

```
codepal-sidecar/
├── README.md
├── DESIGN.md            # this file
├── index.html           # single page, ~150 LOC
├── app.js               # vanilla JS controller, ~400 LOC
├── style.css            # hand-rolled, ~150 LOC
├── assets/
│   └── favicon.svg
└── LICENSE              # TBD before first feature commit
```

### 6.2 UI regions (top to bottom)

1. **Header bar** — brand, AuthKit login pill, connection indicator
   (green/red dot polling `GET /v1/status` every 30s), counter widget
   (`X local · Y forwarded · ~Z tokens saved`).
2. **Settings drawer** (collapsible) — port input (saved via AuthKit
   Saved Keys), project free-text input (persisted to localStorage).
3. **Query box** — large textarea, "Ask CodePal" button, keyboard
   shortcut `Cmd+Enter`.
4. **Answer card** — appears after submit:
   - Tier badge: 🟢 Bug DB / 🔵 Local LLM / 🟡 None (when
     `allow_external=false` and no local match)
   - Answer text (rendered as plain markdown — simple regex, no lib)
   - Collapsible "Retrieved chunks" list with `file_path:Lstart-Lend`
     + score; each chunk clickable to expand the snippet
   - Action row: **Dismiss** · **Copy slimmed prompt** · 👍 · 👎 · **Save as bug**
5. **History panel** (right side, optional in v0) — last 20 queries
   from localStorage, click to re-run.

### 6.3 Key flows

#### 6.3.1 First-run

1. User lands on page → not signed in → AuthKit modal shows.
2. After Google sign-in → check Firestore for `savedKeys/codepal_port`.
3. If missing → settings drawer opens with port input prefilled to `8742`.
4. User clicks Save → write to Firestore.

#### 6.3.2 Ask a question

1. User types query + project path → clicks Ask.
2. Page checks `GET /v1/status` first (3s timeout). If red dot, show
   error banner with "Is CodePal running?".
3. Page POSTs to `/v1/query` with body:
   ```json
   {
     "query": "<text>",
     "project_path": "<text>",
     "allow_external": false
   }
   ```
4. Render answer card. Increment counter:
   - `source ∈ {bug_db, local_llm}` → `local++`
   - `source == "none"` → `forwarded++` (presumed, user will paste)
5. Persist last query + response to localStorage history.

#### 6.3.3 Copy slimmed prompt

Template:
```
[Context retrieved by CodePal from {project_slug}]

{for chunk in context_chunks:}
- {chunk.file}:{chunk.lines[0]}-{chunk.lines[1]} (score {chunk.score})
{chunk.snippet}
---
{endfor}

Question: {query}
```
Copied via `navigator.clipboard.writeText()`. Increment `forwarded++`.

#### 6.3.4 Rate

- 👍/👎 → optional textarea → `POST /v1/feedback` with full payload.
- 👍 also unlocks a **Save as bug solution** button which POSTs to
  `/v1/bugs` with `error=query, solution=answer, context=joined-chunks`.
  Saved only on explicit click; we don't auto-save.

### 6.4 Counter accounting

In `localStorage`:
```json
{
  "counter": {
    "local": 38,
    "forwarded": 9,
    "tokens_saved_est": 14230,
    "since_iso": "2026-05-22T10:00:00Z"
  }
}
```
- `tokens_saved_est` = `sum(len(chunk.snippet) for chunk in local_answers) / 4`
  (rough chars-per-token heuristic — adequate for "look at the savings"
  storytelling; no need for `tiktoken`).
- Reset button in settings drawer.

### 6.5 AuthKit integration

- Load AuthKit from its CDN/GH Pages URL.
- `AuthKit.init({ firebase: {...}, enabledProviders: ['google', 'email'], ... })`
- Use `AuthKit.requireAuth()` to gate the settings drawer save action.
- Use AuthKit's Saved Keys API to read/write `codepal_port`.
- Settings page (`AuthKit.renderSettings('#settings-anchor')`) shown
  via a "Manage account" link in the header.

## 7. Testing strategy

### 7.1 Server-side (`codepal` repo)

- `tests/unit/test_cors.py` — preflight allow/deny matrix.
- `tests/unit/test_query_allow_external.py` — flag True/False paths.
- `tests/unit/test_feedback.py` — round-trip + validation.
- Existing 11-test F1–F4 regression suite continues to pass.

### 7.2 Page-side (`codepal-sidecar` repo)

- v0 manual only — too small for a test runner. Smoke checklist in
  README.
- Defer to v1: add Playwright + GitHub Actions for end-to-end against
  a stubbed CodePal.

## 8. Definition of Done — v0

### Server (`codepal` repo, prerequisite PR)

- [ ] CORS middleware + `[cors]` config section
- [ ] `allow_external` flag on `QueryRequest`
- [ ] `POST /v1/feedback` + sqlite store
- [ ] Tests for all three above
- [ ] `config.toml.example` updated
- [ ] `docs/design.md` §5 amended with new endpoint + flag

### Sidecar (`codepal-sidecar` repo)

- [ ] `index.html` / `app.js` / `style.css`
- [ ] AuthKit init + Saved Keys for `codepal_port`
- [ ] Free-text project input with localStorage persistence
- [ ] Query → `/v1/query` with `allow_external=false`
- [ ] Tier badge + chunks display
- [ ] Counter (localStorage)
- [ ] **Copy slimmed prompt** button
- [ ] 👍/👎 → `POST /v1/feedback`
- [ ] **Save as bug** → `POST /v1/bugs`
- [ ] Connection indicator polling `/v1/status`
- [ ] GH Pages enabled and live at `https://yuanfengli168.github.io/codepal-sidecar/`
- [ ] `README.md` updated with screenshots + final setup steps
- [ ] `LICENSE` chosen

## 9. Open questions (defer or decide before implementation)

1. **License.** MIT, Apache-2.0, or something else? Affects both repos.
2. **Firebase config exposure.** AuthKit needs `apiKey` etc. in the
   browser. Per Firebase docs this is OK (apiKey isn't a secret) but
   we should restrict the Firebase project's authorized domains to
   `yuanfengli168.github.io` + `localhost`.
3. **Markdown rendering.** Hand-rolled regex for code fences vs.
   pulling `marked` from CDN (~50 KB). Defaulting to regex; revisit
   if answers look ugly.
4. **"None" source UX.** When `allow_external=false` and no local
   match, what's the most helpful UI state? Current plan: show
   retrieved chunks (if any) + a big "Copy to Copilot" button + a
   note "CodePal didn't find a local answer."
5. **Rate limiting.** v0 has none. Acceptable for localhost.

## 10. Out-of-scope (v1+)

- Streaming tier-B answers.
- Cross-machine Firestore-synced counter + history.
- Multi-project dashboard.
- Native Anthropic schema support on CodePal (for Claude Desktop direct).
- Mobile-friendly layout.
- Safari support.
- LAN/multi-user CodePal exposure with Firebase token auth.

---

## Sign-off

This document captures every locked decision from the 2026-05-22
design session. **No code in either repo until Jacky signs off on this
document.** When approved, implementation order will be:

1. Land the CodePal server prerequisite PR (CORS + flag + feedback).
2. Build the sidecar page against it.
3. Enable GH Pages + first manual smoke run.

— end —
