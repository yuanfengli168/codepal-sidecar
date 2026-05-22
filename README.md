# codepal-sidecar

A static companion webpage for [**CodePal**](https://github.com/yuanfengli168/codepal)
— the local-first code Q&A router. Hosted on GitHub Pages, runs entirely
in your browser, talks to your locally-running CodePal server, and gives
you a one-screen workflow for asking repo questions **before** pasting
them into GitHub Copilot Chat / Claude / ChatGPT.

> **Status:** design phase. See [`DESIGN.md`](DESIGN.md) for the full
> spec. No implementation code yet — initial commit is documentation
> only.

---

## Why does this exist?

GitHub Copilot's endpoint isn't user-configurable, so you can't
transparently route its traffic through CodePal. The next-best workflow
is:

1. Type your question into **this page** instead of Copilot.
2. The page calls **your local CodePal** at `http://localhost:8742`.
3. CodePal runs its 3-tier ladder:
   - **Tier A** — match against your saved bug solutions (free)
   - **Tier B** — local RAG over your repo + local `qwen3:14b` (free)
   - **Tier C** *(disabled by default in this page — see DESIGN.md §3.4)*
4. If A or B answers, you're done — **zero premium-API tokens spent**.
5. If they don't, click **"Copy slimmed prompt"** to copy
   `query + top-K retrieved chunks` into Copilot Chat / Claude.

Net effect: most repo questions never leave your machine; the ones that
do carry ~3 KB of relevant context instead of pasting whole files.

---

## Requirements

- A running CodePal server on `http://localhost:<port>` (default `8742`)
  with CORS enabled — see CodePal's [CORS setup docs](https://github.com/yuanfengli168/codepal/blob/main/docs/copilot-sidecar-page-design.md).
- **Chrome** (Edge / Firefox likely work but are unsupported in v0;
  Safari is known to block HTTPS→HTTP-localhost requests).
- A Google account (for sign-in via [AuthKit](https://github.com/yuanfengli168/authkit)).

---

## Quick start (once implemented)

1. Visit `https://yuanfengli168.github.io/codepal-sidecar/`.
2. Click **Sign in** → Google.
3. Open **Settings** → enter your local CodePal port (default `8742`).
   The port is saved per-user via AuthKit's Saved Keys (Firestore).
4. In the **Project** field, paste a local path
   (`/Users/you/code/myrepo`) or a repo URL.
5. Type your question → **Ask CodePal**.
6. The page shows the answer + which tier produced it + the retrieved
   code chunks. From there you can:
   - **Dismiss** (the answer was good — don't bother Copilot)
   - **Copy slimmed prompt** (send the slim context to Copilot Chat)
   - 👍 / 👎 to rate (recorded via `POST /v1/feedback`)
   - **Save as bug solution** (one-click to persist into the bug DB)

---

## Repo layout (planned)

```
codepal-sidecar/
├── README.md           # ← you are here
├── DESIGN.md           # full design doc — read this before contributing
├── index.html          # entry page (planned)
├── app.js              # vanilla-JS controller (planned)
├── style.css           # hand-rolled minimal CSS (planned)
└── assets/             # icons / favicon (planned)
```

No build step, no bundler, no `node_modules`. Source IS the deployment.

---

## Hosting

GitHub Pages — `main` branch, root. The URL once enabled will be:

`https://yuanfengli168.github.io/codepal-sidecar/`

(Page setup is a manual one-time step on the repo's Settings → Pages
page after this initial commit lands.)

---

## License

To be added before first feature commit.
