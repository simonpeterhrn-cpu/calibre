# Calibre

A productivity instrument built with watchmaking precision — a Today
dashboard, focus timer, task manifest with session estimates, custom
projects, habit tracker, sleep reserve and weekly insights.

React 19 + Vite, installable as a PWA (works offline), with an optional
Supabase cloud sync (magic-link auth, per-user rows, Row Level Security,
live cross-device updates via Realtime).

## Run locally

```
npm install
npm run dev
```

## Cloud sync (optional)

1. Create a Supabase project and run `supabase-setup.sql` in its SQL Editor.
2. In the dashboard: enable Email auth, and set the Site URL / redirect
   allow-list to your deployed URL (see notes at the bottom of the SQL file).
3. Copy `.env.example` to `.env.local` and fill in your project URL and anon key.

Without keys — or without signing in — the app runs fully on localStorage.

## Notes

- The timer is wall-clock based: it stays accurate in background tabs,
  shows the countdown in the tab title, and survives page refreshes.
- Keyboard shortcuts: `Space` wind/pause · `1–6` switch tabs · `N` new entry.
- Deletions show an Undo toast for six seconds instead of a confirm dialog.
- Backup: Regulator → Backup exports all data as JSON and restores from it.
- Dates use the local timezone (Europe/Paris safe), not UTC.
- "Load sample data" in the Regulator tab populates demo content;
  "Reset all data" clears everything.
