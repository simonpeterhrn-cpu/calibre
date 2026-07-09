---
name: verify
description: Build, launch and drive the Calibre app to verify changes end-to-end in a real browser.
---

# Verifying Calibre

Vite + React 19 single-page app; surface is a browser GUI.

## Build & serve

```bash
npm run build          # must pass first
npm run preview        # serves dist/ at http://localhost:4173 (run in background)
```

`npm run preview` serves the production build, so the service worker
(`public/sw.js`) registers too — use it over `npm run dev` when PWA
behaviour matters.

## Drive

No Playwright browsers are installed; use the system Chrome channel:

```js
const browser = await chromium.launch({ channel: "chrome", headless: true });
```

Install the `playwright` lib in the scratchpad (`npm i playwright`), not the repo.

Flows worth driving:
- Today tab is home (`.h1` = "Today"); docket / habits / reserve panels live in `.today-side`.
- Regulator → "Load sample data" (accept the confirm dialog) to populate state fast.
- Tasks: `#new-task-input`, composer selects by `aria-label` (Priority, Project,
  Estimated sessions). Inline edit via row `edit` button.
- Deletions show a `.toast` with an Undo button (6 s) — no confirm dialog.
- Keyboard: `1–6` switch tabs, `Space` winds/pauses timer, `N` jumps to new-task input.
  Blur any focused input first (press Escape) or shortcuts are ignored.
- Data persists in localStorage key `calibre:v2`; timer in `calibre:timer:v1`.

## Gotchas

- Supabase is optional: without a signed-in session everything runs on
  localStorage, so no cloud mocking is needed.
- Mobile layout kicks in at ≤700px (bottom nav); test at 390×780.
