# Design brief — "Repos" settings tab (repo management)

**For:** the designer creating the Repos management UI
**Surface:** web operator console (`web/`) · desktop · **Day theme only** (theme switcher was removed)
**One-liner:** Give an org a place to **connect, see, re-validate, and disconnect** its GitHub repos.

---

## 1. Why this exists (the problem)

The product model is **Organization → Repos → Threads**. A *thread* (a unit of work) always lives on a
*repo* (a connected GitHub repository). Today there is **no screen anywhere to connect or manage a repo**,
so a new org has zero repos and the operator can't start any work — the "Connect a repo first" prompt in
the create-thread dialog currently dead-ends on a tab that can't connect a repo.

This tab fills that gap. It's the home for everything an operator does to a repo *except* using it.

---

## 2. Where it lives

A **new fourth tab in Org Settings**, alongside the existing **General / Credentials / Members**.

- Route: `/orgs/:orgId/settings?section=repos`
- The settings shell is already built — reuse it exactly:
  - Top bar (52px) with brand + "Org name / Settings" breadcrumb + account menu.
  - Left nav rail (228px): the new **Repos** item sits under General/Credentials/Members
    (suggested icon: a repo/branch glyph, e.g. `FolderGit2`).
  - Content column: **max-width 640px**, generous padding (matches the other tabs).
- Visual references (please match these for consistency):
  - `web/src/features/settings/components/members-section.tsx` — the **list/table pattern** (bordered
    card, mono uppercase column header, rows divided by hairlines, status pill at right).
  - `web/src/features/settings/components/credentials-section.tsx` — the **card + inline-edit + validate**
    pattern (icon, title, sub, status pill, a field with Test/Save and an inline result reason).
  - `web/src/features/create/components/create-thread.tsx` — the existing **empty-state** pattern
    (dashed border, icon-in-circle, title, body, CTA) and the repo picker styling.

---

## 3. Design-system tokens to use (Day theme)

Use the existing CSS variables — don't introduce new colors:

- Text: `--text` (primary), `--dim` (secondary), `--faint` (tertiary/labels)
- Accent (brand/active): `--accent`, `--accent-soft` (bg), `--accent-line` (border)
- Status: `--green` (healthy/validated), `--red` (error/failed)
- Surfaces: `--surface`, `--surface-2`, `--panel`; borders `--border`, `--border-2`, `--hair`
- Type: `font-disp` (headings), `font-mono` (ids/urls/branches/timestamps)
- Section header pattern: `font-disp` 22px title + a 13px `--dim` one-line subtitle.

---

## 4. The data each repo carries (design for the real fields)

Every repo row binds to this shape (from the backend list endpoint). Design the UI honestly around it:

| Field | Type | Use in UI |
|---|---|---|
| `name` | string | Primary label (display name, e.g. "Atlas Web") |
| `gitUrl` | string | `https://github.com/owner/repo`, shown mono/secondary |
| `slug` | string | URL-safe id (e.g. `atlas-web`); optional small mono caption |
| `defaultBranch` | string | Base branch chip (e.g. `main`) |
| `accessOk` | boolean | Drives the **access status pill** (see below) |
| `accessCheckedAt` | timestamp \| null | "checked 2h ago" relative time next to the pill |
| `threadCount` | number | "3 threads" — **also gates whether Disconnect is allowed** |

**Access status pill — two states:**
- `accessOk = true` → **green** "Connected" (GitHub token reached the repo). Caption: "checked 2h ago".
- `accessOk = false` → **red** "Access failed" + a short reason string the backend returns
  (e.g. "repo unreachable or token lacks access"). This row offers a **Re-validate** action.

---

## 5. Screens & states to design

Please produce the following (one tab, many states). Group A–D are the core; E–J are the interactions.

### A. Repos tab — loading
Skeleton/"Loading repos…" consistent with the other tabs' loading text.

### B. Repos tab — empty (no repos connected)
Reuse the empty-state pattern. **Two variants**, because connecting a repo needs an org GitHub token:
- **B1 — GitHub PAT is set:** empty illustration + title "No repositories connected yet" + the
  **Connect form** (section E) directly below, ready to use.
- **B2 — GitHub PAT is NOT set (precondition):** a banner/notice — "Set a GitHub token in **Credentials**
  to connect repos" with a link to the Credentials tab. The connect form is disabled/hidden until then.

### C. Repos tab — populated list
- Section header: "Repos" + subtitle "GitHub repositories connected to {org}. Threads run on these."
- The **Connect** affordance (section E) — either always-visible at top, or behind a "Connect repo"
  button that reveals the form (your call; the Credentials tab uses reveal-on-edit, Members uses a
  top-right button — pick what reads cleanest here).
- The **repo list** (bordered card like Members): one row per repo (section D).

### D. Repo row — anatomy
Left→right within a row:
1. Repo identity: `name` (semibold) over `gitUrl` (mono, faint).
2. Default-branch chip (`main`), mono.
3. Access status pill (green "Connected" / red "Access failed") + relative `accessCheckedAt`.
4. Thread count ("3 threads", or "No threads").
5. Row actions (owner only): **Re-validate**, **Edit**, **Disconnect** — as buttons or an overflow (⋯)
   menu. Show the disabled Disconnect state (section H1) clearly.

### E. Connect-repo form + its result states
Fields: **Repo URL** (required, `https://github.com/owner/repo`), optional **Display name**, optional
**Base branch** (defaults to the repo's default). Primary button "Connect". Design **four** states:
- **E1 idle** — empty form.
- **E2 validating** — button spinner / "Connecting…" while the backend probes GitHub.
- **E3 connected & access OK** — success affirmation; the new repo appears in the list with a green pill.
- **E4 connected but access failed** — the repo is still saved, but with a **red "Access failed"** pill +
  the reason; surface a "Re-validate" path. (Important: a bad token does **not** block saving the row.)

### F. Re-validate (per row)
A button that re-probes GitHub access. States: idle → loading ("Re-validating…") → result (pill flips
green or stays red with an updated reason + refreshed "checked just now").

### G. Edit default branch / display name (per row)
Lightweight inline edit or small popover to change `name` and/or `defaultBranch`. No GitHub call — pure
metadata. Save/Cancel.

### H. Disconnect (per row) — **blocking rule**
Disconnecting is **only allowed when the repo has zero threads** (so we never silently destroy work).
- **H1 — has threads (`threadCount > 0`):** Disconnect is **disabled**, with a tooltip/inline hint:
  "Delete this repo's threads first." Consider showing the count as the reason.
- **H2 — no threads:** Disconnect is enabled → opens a **confirm dialog** (model it on the existing
  delete-org dialog, but lighter): "Disconnect {repo}? This removes it from {org}. Threads aren't
  affected because there are none." Buttons: Cancel / Disconnect (destructive/red).

### I. Owner vs member (read-only)
Only **owners** can connect / re-validate / edit / disconnect (the backend enforces this). For a
**member**, design the read-only view: the list and statuses are visible, but every write affordance is
disabled or hidden. (Mirror how General/Credentials disable writes for non-owners.)

### J. List error state
"Couldn't load repositories." in `--red`, matching the other tabs.

---

## 6. Microcopy (proposed — refine as you like)

- Tab label: **Repos**
- Header + subtitle: **"Repos"** / "GitHub repositories connected to {org}. Threads run on these."
- Empty: **"No repositories connected yet"** / "Connect a GitHub repo to start running threads on it."
- PAT-missing banner: "Set a GitHub token in **Credentials** to connect repos."
- Connect button: **Connect** · while busy: **Connecting…**
- Access pills: **Connected** (green) · **Access failed** (red)
- Access-failed reason (from backend, examples): "repo unreachable or token lacks access",
  "not an HTTPS GitHub URL", "no GitHub token set".
- Re-validate: **Re-validate** · busy: **Re-validating…**
- Disconnect disabled hint: **"Delete this repo's threads first."**
- Disconnect dialog: title **"Disconnect {repo}?"**, confirm **Disconnect**.

---

## 7. Cross-flow to keep coherent

The create-thread dialog's "Connect a repo first" empty state will be **re-pointed to this tab** (today it
mis-points to Credentials). So the loop is: *create thread → no repo → "Connect a repo" → this Repos tab →
connect → back to creating a thread.* Please make the empty/connect states feel like a natural landing for
someone who arrived mid-thread-creation.

---

## 8. Constraints
- **Day theme only.** No dark mode, no theme variants.
- Desktop operator console (not mobile-first); match the existing settings density and type scale.
- **No new top-level navigation.** Repo management is a settings tab, not a sidebar/section of its own.

## 9. Out of scope (don't design these now)
- Per-repo credentials/tokens (repos all use the org's GitHub token).
- Repos as a browsable nav tier in the main app sidebar.
- Repo-level analytics/health beyond the access pill + thread count.

## 10. Deliverables requested
- The Repos tab in: **empty (both PAT variants), populated, loading, error**.
- The **connect form** in its 4 states (idle / validating / OK / access-failed).
- **Row** with both access-pill states and the **disabled vs enabled Disconnect**.
- The **Disconnect confirm dialog**.
- The **member (read-only)** variant.
- Redlines/spacing can follow the existing settings tabs — reuse, don't reinvent.
