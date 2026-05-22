/* codepal-sidecar — vanilla JS controller (ES module).
 *
 * Responsibilities (see DESIGN.md §6):
 *   - AuthKit — sign-in + per-user port via Saved Keys.
 *     Falls back to localStorage when Firebase config is missing.
 *   - Settings drawer: port (AuthKit/localStorage), project (localStorage).
 *   - Query → POST /v1/query with allow_external=false.
 *   - Render answer card + tier badge + retrieved chunks.
 *   - Counter accounting (localStorage).
 *   - Copy slimmed prompt.
 *   - 👍/👎 → POST /v1/feedback.
 *   - Save as bug → POST /v1/bugs.
 *   - Connection indicator polling /v1/status every 30s.
 *   - History (last 20 in localStorage).
 */

"use strict";

import { FIREBASE_CONFIG, AUTHKIT_BASE_URL, AUTHKIT_BRAND_NAME } from "./config.js";

// ── constants ─────────────────────────────────────────────────────────
const DEFAULT_PORT = 8742;
const STATUS_POLL_MS = 30_000;
const STATUS_TIMEOUT_MS = 3_000;
const QUERY_TIMEOUT_MS = 120_000;
const HISTORY_MAX = 20;
const TOKENS_PER_CHAR = 0.25; // ~4 chars/token

const LS = {
  port: "codepal.port",
  project: "codepal.project",
  counter: "codepal.counter",
  history: "codepal.history",
};

// ── DOM refs ──────────────────────────────────────────────────────────
const $ = (id) => document.getElementById(id);
const els = {
  connDot: $("conn-dot"),
  connLabel: $("conn-label"),
  cLocal: $("c-local"),
  cFwd: $("c-forwarded"),
  cTokens: $("c-tokens"),
  settingsBtn: $("settings-btn"),
  authBtn: $("auth-btn"),
  settings: $("settings"),
  portInput: $("port-input"),
  portSave: $("port-save"),
  portStatus: $("port-status"),
  projectInput: $("project-input"),
  counterReset: $("counter-reset"),
  accountAnchor: $("account-anchor"),
  errorBanner: $("error-banner"),
  queryInput: $("query-input"),
  askBtn: $("ask-btn"),
  answerCard: $("answer-card"),
  tierBadge: $("tier-badge"),
  dismissBtn: $("dismiss-btn"),
  answerBody: $("answer-body"),
  chunksWrap: $("chunks-wrap"),
  chunksCount: $("chunks-count"),
  chunksList: $("chunks-list"),
  copyBtn: $("copy-btn"),
  upBtn: $("up-btn"),
  downBtn: $("down-btn"),
  bugBtn: $("bug-btn"),
  feedbackNote: $("feedback-note"),
  noteInput: $("note-input"),
  noteSend: $("note-send"),
  feedbackStatus: $("feedback-status"),
  historyList: $("history-list"),
};

// ── state ─────────────────────────────────────────────────────────────
const state = {
  port: DEFAULT_PORT,
  project: "",
  lastQuery: null,    // { query, project_slug, response }
  lastRating: null,   // "up" | "down"
  counter: { local: 0, forwarded: 0, tokens_saved_est: 0, since_iso: new Date().toISOString() },
  history: [],
};

// ── localStorage helpers ──────────────────────────────────────────────
function lsGet(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw == null ? fallback : JSON.parse(raw);
  } catch { return fallback; }
}
function lsSet(key, val) {
  try { localStorage.setItem(key, JSON.stringify(val)); } catch {}
}

// ── AuthKit adapter ───────────────────────────────────────────────────
// Real AuthKit API (per https://github.com/yuanfengli168/authkit):
//   AuthKit.init({ firebase, enabledProviders, anchor, loginMode,
//                  brandName, baseUrl })
//   AuthKit.onAuthStateChanged(cb)
//   AuthKit.currentUser
//   AuthKit.signOut()
//   AuthKit.showLogin() / hideLogin()
//   AuthKit.renderSettings(selector)
//   AuthKit.saveKey({ name, value })       — upserts in Firestore
//   AuthKit.getSavedKeys()                 — returns list of {name, value, ...}
//
// We dynamically import AuthKit only when a real Firebase config is
// present. Without config the page works locally with no auth.
const authkit = {
  module: null,         // AuthKit module reference
  enabled: false,       // true once init() succeeds
  user: null,

  async init() {
    if (!FIREBASE_CONFIG.apiKey) {
      console.info("[sidecar] No Firebase config — AuthKit disabled, using localStorage only.");
      els.authBtn.title = "Add Firebase config in config.js to enable sign-in";
      return;
    }
    try {
      const mod = await import(AUTHKIT_BASE_URL + "index.js");
      this.module = mod.default || mod.AuthKit;
      if (!this.module) throw new Error("AuthKit module did not export default/AuthKit");
      await this.module.init({
        firebase: FIREBASE_CONFIG,
        enabledProviders: ["google", "email"],
        anchor: "#auth-anchor",
        loginMode: "modal",
        brandName: AUTHKIT_BRAND_NAME,
        baseUrl: AUTHKIT_BASE_URL,
      });
      this.enabled = true;
      this.module.onAuthStateChanged((user) => handleAuthChange(user));
    } catch (e) {
      console.warn("AuthKit init failed; falling back to localStorage.", e);
      this.enabled = false;
    }
  },

  async signIn() {
    if (!this.enabled) return null;
    this.module.showLogin();
  },

  async signOut() {
    if (!this.enabled) return null;
    return this.module.signOut();
  },

  async getPort() {
    if (this.enabled && this.user) {
      try {
        const keys = await this.module.getSavedKeys();
        const entry = (keys || []).find((k) => k.name === "codepal_port");
        if (entry && entry.value) return parseInt(entry.value, 10);
      } catch (e) { console.warn("getSavedKeys failed", e); }
    }
    return lsGet(LS.port, DEFAULT_PORT);
  },

  async setPort(port) {
    lsSet(LS.port, port);
    if (this.enabled && this.user) {
      try {
        await this.module.saveKey({ name: "codepal_port", value: String(port) });
      } catch (e) { console.warn("saveKey failed", e); }
    }
  },

  renderSettings(anchor) {
    if (this.enabled && typeof this.module.renderSettings === "function") {
      try { this.module.renderSettings(anchor); } catch (e) { console.warn(e); }
    }
  },
};

function handleAuthChange(user) {
  authkit.user = user || null;
  if (user) {
    els.authBtn.textContent = user.displayName || user.email || "Sign out";
    // Pull port from saved keys now that we're signed in.
    authkit.getPort().then(applyPort);
  } else {
    els.authBtn.textContent = "Sign in";
  }
}

// ── fetch helpers ─────────────────────────────────────────────────────
function baseURL() { return `http://localhost:${state.port}`; }

async function fetchJSON(path, opts = {}, timeoutMs = QUERY_TIMEOUT_MS) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(baseURL() + path, {
      ...opts,
      signal: ctrl.signal,
      headers: { "Content-Type": "application/json", ...(opts.headers || {}) },
    });
    const text = await res.text();
    let body = null;
    try { body = text ? JSON.parse(text) : null; } catch { body = text; }
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${typeof body === "string" ? body : JSON.stringify(body)}`);
    return body;
  } finally {
    clearTimeout(t);
  }
}

// ── connection status ────────────────────────────────────────────────
async function pollStatus() {
  try {
    await fetchJSON("/v1/status", { method: "GET" }, STATUS_TIMEOUT_MS);
    setStatus("ok", `connected · :${state.port}`);
    hideBanner();
  } catch (e) {
    setStatus("bad", `unreachable · :${state.port}`);
  }
}
function setStatus(kind, label) {
  els.connDot.className = "dot dot-" + kind;
  els.connLabel.textContent = label;
}

function showBanner(msg) {
  els.errorBanner.textContent = msg;
  els.errorBanner.classList.remove("hidden");
}
function hideBanner() { els.errorBanner.classList.add("hidden"); }

// ── counter ──────────────────────────────────────────────────────────
function loadCounter() {
  const c = lsGet(LS.counter, null);
  if (c) state.counter = c;
  renderCounter();
}
function saveCounter() { lsSet(LS.counter, state.counter); }
function renderCounter() {
  els.cLocal.textContent = state.counter.local;
  els.cFwd.textContent = state.counter.forwarded;
  els.cTokens.textContent = Math.round(state.counter.tokens_saved_est).toLocaleString();
}
function bumpLocal(chunks) {
  state.counter.local += 1;
  const chars = (chunks || []).reduce((s, c) => s + (c.snippet ? c.snippet.length : 0), 0);
  state.counter.tokens_saved_est += chars * TOKENS_PER_CHAR;
  saveCounter(); renderCounter();
}
function bumpForwarded() {
  state.counter.forwarded += 1;
  saveCounter(); renderCounter();
}
function resetCounter() {
  state.counter = { local: 0, forwarded: 0, tokens_saved_est: 0, since_iso: new Date().toISOString() };
  saveCounter(); renderCounter();
}

// ── history ──────────────────────────────────────────────────────────
function loadHistory() {
  state.history = lsGet(LS.history, []);
  renderHistory();
}
function pushHistory(entry) {
  state.history.unshift(entry);
  state.history = state.history.slice(0, HISTORY_MAX);
  lsSet(LS.history, state.history);
  renderHistory();
}
function renderHistory() {
  els.historyList.innerHTML = "";
  for (const h of state.history) {
    const li = document.createElement("li");
    li.innerHTML = `
      <span class="h-tier">${escapeHTML(tierLabel(h.source))}</span>
      <span class="h-q"></span>
      <span class="h-ts">${formatTs(h.ts)}</span>`;
    li.querySelector(".h-q").textContent = h.query;
    li.addEventListener("click", () => {
      els.queryInput.value = h.query;
      els.queryInput.focus();
    });
    els.historyList.appendChild(li);
  }
}
function formatTs(iso) {
  try {
    const d = new Date(iso);
    return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  } catch { return ""; }
}

// ── tier badge ───────────────────────────────────────────────────────
function tierLabel(source) {
  switch (source) {
    case "bug_db":       return "🟢 Bug DB";
    case "local_llm":    return "🔵 Local LLM";
    case "external_llm": return "🟡 External";
    case "none":         return "⚪ None";
    default:             return source || "?";
  }
}
function tierBadgeClass(source) {
  return ({
    bug_db: "badge badge-bugdb",
    local_llm: "badge badge-local",
    external_llm: "badge badge-external",
    none: "badge badge-none",
  })[source] || "badge";
}

// ── markdown (minimal, regex-only) ───────────────────────────────────
function renderMarkdown(src) {
  if (!src) return "";
  // Escape first, then re-introduce specific markup.
  let s = escapeHTML(src);
  // Fenced code blocks ```lang\n...```
  s = s.replace(/```([a-zA-Z0-9_+-]*)\n([\s\S]*?)```/g, (_m, lang, code) => {
    return `<pre><code class="lang-${escapeAttr(lang)}">${code}</code></pre>`;
  });
  // Inline code `...`
  s = s.replace(/`([^`\n]+)`/g, (_m, t) => `<code>${t}</code>`);
  // Links [text](url)
  s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
    (_m, txt, url) => `<a href="${escapeAttr(url)}" target="_blank" rel="noopener">${txt}</a>`);
  // Bold **x**
  s = s.replace(/\*\*([^*\n]+)\*\*/g, "<b>$1</b>");
  return s;
}
function escapeHTML(s) {
  return String(s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
function escapeAttr(s) { return escapeHTML(s); }

// ── render answer ────────────────────────────────────────────────────
function renderAnswer(resp) {
  els.answerCard.classList.remove("hidden");
  els.tierBadge.className = tierBadgeClass(resp.source);
  els.tierBadge.textContent = tierLabel(resp.source);
  els.answerBody.innerHTML = renderMarkdown(resp.answer || "");

  const chunks = resp.context_chunks || [];
  els.chunksCount.textContent = chunks.length;
  els.chunksList.innerHTML = "";
  for (const c of chunks) {
    const li = document.createElement("li");
    const file = c.file_path || c.file || "?";
    const lines = c.lines || (c.line_start != null ? [c.line_start, c.line_end] : null);
    const range = lines ? `:L${lines[0]}-L${lines[1]}` : "";
    const score = c.score != null ? c.score.toFixed(3) : "";
    li.innerHTML = `
      <div class="chunk-head">
        <span class="chunk-file">${escapeHTML(file + range)}</span>
        ${score ? `<span class="chunk-score">${score}</span>` : ""}
      </div>
      <pre class="chunk-snippet"></pre>`;
    li.querySelector(".chunk-snippet").textContent = c.snippet || "";
    li.querySelector(".chunk-head").addEventListener("click", () => li.classList.toggle("expanded"));
    els.chunksList.appendChild(li);
  }
  els.chunksWrap.open = chunks.length > 0 && resp.source === "none";

  // Reset feedback widget state.
  els.feedbackNote.classList.add("hidden");
  els.feedbackStatus.textContent = "";
  els.bugBtn.classList.add("hidden");
  state.lastRating = null;
}

// ── ask flow ─────────────────────────────────────────────────────────
async function ask() {
  const query = els.queryInput.value.trim();
  if (!query) return;
  const projectSlug = els.projectInput.value.trim();

  els.askBtn.disabled = true;
  els.askBtn.textContent = "Asking…";
  hideBanner();

  // Status precheck (best-effort, short timeout).
  try {
    await fetchJSON("/v1/status", { method: "GET" }, STATUS_TIMEOUT_MS);
  } catch {
    setStatus("bad", `unreachable · :${state.port}`);
    showBanner("CodePal didn't respond on :" + state.port + ". Is the server running?");
    els.askBtn.disabled = false;
    els.askBtn.textContent = "Ask CodePal";
    return;
  }

  let resp;
  try {
    resp = await fetchJSON("/v1/query", {
      method: "POST",
      body: JSON.stringify({
        query,
        project_path: projectSlug || undefined,
        project_slug: projectSlug || undefined,
        allow_external: false,
      }),
    });
  } catch (e) {
    showBanner("Query failed: " + e.message);
    els.askBtn.disabled = false;
    els.askBtn.textContent = "Ask CodePal";
    return;
  } finally {
    els.askBtn.disabled = false;
    els.askBtn.textContent = "Ask CodePal";
  }

  state.lastQuery = { query, project_slug: projectSlug, response: resp };
  renderAnswer(resp);

  // Counter: local sources count as wins, "none" means user will likely forward.
  if (resp.source === "bug_db" || resp.source === "local_llm") {
    bumpLocal(resp.context_chunks);
  }

  pushHistory({
    ts: new Date().toISOString(),
    query,
    source: resp.source,
    project_slug: projectSlug,
  });
}

// ── copy slimmed prompt ─────────────────────────────────────────────
function buildSlimmedPrompt() {
  const lq = state.lastQuery;
  if (!lq) return "";
  const chunks = lq.response.context_chunks || [];
  const slug = lq.project_slug || "(unspecified project)";
  let out = `[Context retrieved by CodePal from ${slug}]\n\n`;
  for (const c of chunks) {
    const file = c.file_path || c.file || "?";
    const lines = c.lines || [c.line_start, c.line_end];
    const score = c.score != null ? c.score.toFixed(3) : "n/a";
    out += `- ${file}:${lines[0]}-${lines[1]} (score ${score})\n`;
    out += (c.snippet || "") + "\n---\n";
  }
  out += `\nQuestion: ${lq.query}\n`;
  return out;
}

async function copySlimmed() {
  const text = buildSlimmedPrompt();
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
    bumpForwarded();
    els.copyBtn.textContent = "Copied ✓";
    setTimeout(() => (els.copyBtn.textContent = "Copy slimmed prompt"), 1500);
  } catch (e) {
    showBanner("Clipboard write failed: " + e.message);
  }
}

// ── feedback ─────────────────────────────────────────────────────────
function startRating(rating) {
  state.lastRating = rating;
  els.feedbackNote.classList.remove("hidden");
  els.feedbackStatus.textContent = "";
  els.noteInput.focus();
  // Per DESIGN §6.3.4 — up unlocks "Save as bug".
  els.bugBtn.classList.toggle("hidden", rating !== "up");
}

async function sendFeedback() {
  const lq = state.lastQuery;
  if (!lq || !state.lastRating) return;
  const body = {
    query: lq.query,
    answer: lq.response.answer || "",
    rating: state.lastRating,
    source: lq.response.source || "none",
    project_slug: lq.project_slug || null,
    notes: els.noteInput.value.trim() || null,
  };
  els.noteSend.disabled = true;
  try {
    const res = await fetchJSON("/v1/feedback", { method: "POST", body: JSON.stringify(body) });
    els.feedbackStatus.textContent = `saved · id ${res.id}`;
    els.noteInput.value = "";
  } catch (e) {
    els.feedbackStatus.textContent = "failed: " + e.message;
  } finally {
    els.noteSend.disabled = false;
  }
}

async function saveBug() {
  const lq = state.lastQuery;
  if (!lq) return;
  const chunks = lq.response.context_chunks || [];
  const context = chunks.map((c) => c.snippet || "").join("\n---\n");
  const body = {
    error: lq.query,
    solution: lq.response.answer || "",
    context,
    project_slug: lq.project_slug || null,
  };
  els.bugBtn.disabled = true;
  try {
    const res = await fetchJSON("/v1/bugs", { method: "POST", body: JSON.stringify(body) });
    els.feedbackStatus.textContent = `bug saved · id ${res.id || "?"}`;
    els.bugBtn.classList.add("hidden");
  } catch (e) {
    els.feedbackStatus.textContent = "save-bug failed: " + e.message;
  } finally {
    els.bugBtn.disabled = false;
  }
}

// ── settings ─────────────────────────────────────────────────────────
function applyPort(port) {
  if (!port || isNaN(port)) port = DEFAULT_PORT;
  state.port = port;
  els.portInput.value = port;
  pollStatus();
}

async function savePort() {
  const port = parseInt(els.portInput.value, 10);
  if (!port || port < 1 || port > 65535) {
    els.portStatus.textContent = "invalid port";
    return;
  }
  state.port = port;
  await authkit.setPort(port);
  els.portStatus.textContent = authkit.enabled && authkit.user
    ? "saved to AuthKit ✓"
    : "saved locally ✓";
  setTimeout(() => (els.portStatus.textContent = ""), 2500);
  pollStatus();
}

function toggleSettings() {
  els.settings.classList.toggle("hidden");
  if (!els.settings.classList.contains("hidden")) {
    authkit.renderSettings(els.accountAnchor);
  }
}

// ── wire-up ──────────────────────────────────────────────────────────
function bindEvents() {
  els.settingsBtn.addEventListener("click", toggleSettings);
  els.portSave.addEventListener("click", savePort);
  els.projectInput.addEventListener("input", () => lsSet(LS.project, els.projectInput.value));
  els.counterReset.addEventListener("click", () => {
    if (confirm("Reset counter to zero?")) resetCounter();
  });

  els.askBtn.addEventListener("click", ask);
  els.queryInput.addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") { e.preventDefault(); ask(); }
  });

  els.dismissBtn.addEventListener("click", () => els.answerCard.classList.add("hidden"));
  els.copyBtn.addEventListener("click", copySlimmed);
  els.upBtn.addEventListener("click", () => startRating("up"));
  els.downBtn.addEventListener("click", () => startRating("down"));
  els.noteSend.addEventListener("click", sendFeedback);
  els.bugBtn.addEventListener("click", saveBug);

  els.authBtn.addEventListener("click", async () => {
    if (!authkit.enabled) {
      showBanner("AuthKit isn't configured — add your Firebase config to config.js to enable sign-in. Settings persist locally for now.");
      return;
    }
    if (authkit.user) await authkit.signOut();
    else await authkit.signIn();
  });
}

async function init() {
  // Restore from localStorage immediately so UI is usable without auth.
  applyPort(lsGet(LS.port, DEFAULT_PORT));
  els.projectInput.value = lsGet(LS.project, "");
  loadCounter();
  loadHistory();
  bindEvents();

  // Then try AuthKit. If user is signed in, it'll overwrite port via callback.
  await authkit.init();

  // Connection polling.
  pollStatus();
  setInterval(pollStatus, STATUS_POLL_MS);
}

document.addEventListener("DOMContentLoaded", init);
