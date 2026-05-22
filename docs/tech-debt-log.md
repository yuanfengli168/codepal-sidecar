# Tech Debt Log — codepal-sidecar

## [2026-05-22] Firebase apiKey and Project Sharing

- **Issue:** The current deployment uses the Firebase config (apiKey, projectId, etc.) from the AuthKit demo project (`ai-idea-generator-d9e15`). This config is public and committed to the repo.
- **Reason:** Per DESIGN.md decision #4, no new Firebase project was created for this app in v0. The AuthKit demo project is reused for simplicity and to avoid extra setup.
- **Risk:**
  - apiKey is not a secret, but sharing a Firebase project across unrelated apps can cause quota, billing, and data isolation issues.
  - If the AuthKit demo project is deleted, rotated, or its rules change, codepal-sidecar will break.
  - All users of both apps share the same Firestore instance and quotas.
- **Mitigation:**
  - Firestore security rules and Authorized Domains are enforced.
  - No sensitive data is stored; only per-user port and feedback.
  - This is documented as a tech debt and flagged for v1.
- **Action:**
  - When ready, create a dedicated Firebase project for codepal-sidecar, update `config.js`, and rotate the config in the repo.

---

_Add new entries below as tech debt is discovered or resolved._
