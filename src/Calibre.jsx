import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { supabase } from "./supabase";

/* ============================================================
   CALIBRE — a productivity instrument built with watchmaking
   precision.

   DESIGN TOKENS (cyan/deep-blue theme, matches the gradient)
   --------------------------------------------------------
   --brass      #56e1e8   primary accent (hands / active)   [cyan]
   --brass-lo   #2ab8c0   pressed accent
   --anthracite rgba(2,18,70,.58)  panels
   --steel      rgba(86,225,232,.18) borders / tracks
   --case       rgba(86,225,232,.75) structural rules
   --parchment  rgba(5,25,80,.55)  light surface
   --crimson    #ff6b6b   alerts / overdue
   --jade       #4ecdc4   success / completed streaks
   --ivory      #e8f4ff   primary text
   --slate      #6fa8c8   muted text

   TYPE (loaded via <link> in index.html)
   Fraunces — display serif · IBM Plex Sans — UI · IBM Plex Mono — data
   ============================================================ */

const KEY = "calibre:v2";
const TIMER_KEY = "calibre:timer:v1";
const REMIND_KEY = "calibre:reminders:v1";
const DAY = 86400000;

/* Local calendar date (Europe/Paris etc.) — NOT UTC.
   'sv-SE' locale formats as YYYY-MM-DD. */
const dateStr = (ms) => new Date(ms).toLocaleDateString("sv-SE");
const todayStr = () => dateStr(Date.now());

const DEFAULT_SETTINGS = { work: 25, break: 5, longBreak: 15, cycles: 4, sound: true, targetBed: "23:00", targetWake: "07:00", reminders: false };

/* palette for user-defined projects — hues that sit well on the deep blue */
const PROJECT_COLORS = ["#56e1e8", "#4ecdc4", "#ff6b6b", "#ffc46b", "#b98bff", "#6b9bff"];
const DEFAULT_PROJECTS = ["Resale", "Studio", "Admin", "Teaching", "Personal"]
  .map((name, i) => ({ name, color: PROJECT_COLORS[i % PROJECT_COLORS.length] }));

const emptyData = () => ({
  tasks: [],
  habits: [],
  sleepLog: {}, // date -> {bed, wake, hours}
  sessions: [], // {date, mode, minutes, taskId, project}
  completedSessions: 0,
  focusMinutesTotal: 0,
  settings: { ...DEFAULT_SETTINGS },
  notes: "",
  projects: DEFAULT_PROJECTS.map((p) => ({ ...p })),
  programDone: {}, // program item id -> true
});

/* bring data written by older versions of the app up to the current shape */
function migrate(d) {
  if (!d || typeof d !== "object") return emptyData();
  const out = { ...emptyData(), ...d };
  out.settings = { ...DEFAULT_SETTINGS, ...(d.settings || {}) };
  if (!Array.isArray(out.projects) || out.projects.length === 0) {
    out.projects = DEFAULT_PROJECTS.map((p) => ({ ...p }));
  }
  if (!out.programDone || typeof out.programDone !== "object") out.programDone = {};
  /* sleepLog used to be date -> hours (a plain number); now it's
     date -> {bed, wake, hours} so bedtime/wake-time can be logged too */
  const norm = {};
  for (const [ds, v] of Object.entries(out.sleepLog || {})) {
    if (typeof v === "number") norm[ds] = { bed: null, wake: null, hours: v };
    else if (v && typeof v === "object") norm[ds] = { bed: v.bed || null, wake: v.wake || null, hours: v.hours || 0 };
  }
  out.sleepLog = norm;
  return out;
}

/* Optional sample content — only loaded on demand from the Regulator tab. */
function demoData() {
  const d = emptyData();
  const now = Date.now();
  d.tasks = [
    { id: "t1", label: "Reply to marketplace authentication query", done: false, priority: "high", project: "Resale", due: todayStr(), est: 2, created: now },
    { id: "t2", label: "Photograph new piece for listing", done: false, priority: "med", project: "Studio", due: null, est: 3, created: now },
    { id: "t3", label: "Send courier dispute follow-up", done: true, priority: "high", project: "Admin", due: null, created: now, doneAt: now },
    { id: "t4", label: "Prep course slides", done: false, priority: "low", project: "Teaching", due: null, created: now },
  ];
  const patterns = [
    [1, 1, 1, 1, 0, 1, 1],
    [1, 1, 1, 1, 1, 1, 1],
    [0, 1, 1, 0, 1, 1, 0],
  ];
  d.habits = ["Inventory check", "Client replies", "Course prep"].map((name, idx) => {
    const history = {};
    for (let i = 6; i >= 1; i--) history[dateStr(now - i * DAY)] = !!patterns[idx][6 - i];
    return { id: "h" + (idx + 1), name, best: 0, history };
  });
  const nights = [
    ["23:00", "06:30"], ["00:15", "06:15"], ["22:30", "06:30"], ["23:15", "06:15"],
    ["23:50", "06:20"], ["23:00", "06:30"], ["22:45", "06:45"],
  ];
  for (let i = 6; i >= 0; i--) {
    const [bed, wake] = nights[6 - i];
    d.sleepLog[dateStr(now - i * DAY)] = { bed, wake, hours: sleepHours(bed, wake) };
  }
  return d;
}

/* Hours between a bedtime and a wake time, both "HH:MM", assuming the
   wake time falls the next calendar day if it isn't after bedtime. */
function sleepHours(bed, wake) {
  if (!bed || !wake) return null;
  const [bh, bm] = bed.split(":").map(Number);
  const [wh, wm] = wake.split(":").map(Number);
  let start = bh * 60 + bm, end = wh * 60 + wm;
  if (end <= start) end += 24 * 60;
  return Math.round(((end - start) / 60) * 10) / 10;
}

/* Signed minutes between two "HH:MM" clock times, wrapped to the
   shortest direction around midnight (so 23:50 vs 23:00 reads as
   +50, not -1390). */
function timeDeltaMin(actual, target) {
  if (!actual || !target) return null;
  const [ah, am] = actual.split(":").map(Number);
  const [th, tm] = target.split(":").map(Number);
  let diff = (ah * 60 + am) - (th * 60 + tm);
  if (diff > 720) diff -= 1440;
  if (diff < -720) diff += 1440;
  return diff;
}
function fmtDelta(min) {
  if (min == null || min === 0) return "on target";
  const abs = Math.abs(min);
  const h = Math.floor(abs / 60), m = Math.round(abs % 60);
  const txt = h ? `${h}h ${m}m` : `${m}m`;
  return `${txt} ${min > 0 ? "later" : "earlier"} than target`;
}

/* Minutes-from-noon representation of a "HH:MM" clock time. Bedtimes
   cluster in the evening, far from the noon reference point, so
   averaging/variance on this scale doesn't get distorted by the
   midnight wraparound the way raw minutes-since-midnight would. */
function minutesFromNoon(hhmm) {
  if (!hhmm) return null;
  const [h, m] = hhmm.split(":").map(Number);
  let v = h * 60 + m - 12 * 60;
  if (v < 0) v += 24 * 60;
  return v;
}
function stdDev(arr) {
  if (arr.length < 2) return 0;
  const mean = arr.reduce((a, b) => a + b, 0) / arr.length;
  const variance = arr.reduce((a, b) => a + (b - mean) ** 2, 0) / arr.length;
  return Math.sqrt(variance);
}
/* 0-120min stddev in bedtime maps linearly to a 100-0 consistency score */
function consistencyBand(score) {
  if (score == null) return { label: "Not enough data", color: "var(--slate)" };
  if (score >= 80) return { label: "Very consistent", color: "var(--jade)" };
  if (score >= 60) return { label: "Fairly consistent", color: "var(--jade)" };
  if (score >= 40) return { label: "Irregular", color: "var(--brass)" };
  return { label: "Very irregular", color: "var(--crimson)" };
}
function pearson(xs, ys) {
  const n = xs.length;
  if (n < 2) return null;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let num = 0, dx2 = 0, dy2 = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - mx, dy = ys[i] - my;
    num += dx * dy; dx2 += dx * dx; dy2 += dy * dy;
  }
  const denom = Math.sqrt(dx2 * dy2);
  return denom === 0 ? 0 : num / denom;
}
function corrLabel(r) {
  if (r == null) return "Log a few more nights to see this.";
  const abs = Math.abs(r);
  if (abs < 0.15) return `No clear relationship yet (r = ${r.toFixed(2)}).`;
  const strength = abs >= 0.6 ? "Strong" : abs >= 0.35 ? "Moderate" : "Weak";
  const dir = r > 0
    ? "more sleep tends to line up with more focus time the next day"
    : "more sleep tends to line up with less focus time the next day";
  return `${strength} ${r > 0 ? "positive" : "negative"} link (r = ${r.toFixed(2)}) — ${dir}.`;
}

/* Current streak from history. If today is unchecked the chain isn't
   broken yet — count from yesterday. */
function calcStreak(history) {
  let streak = 0;
  const start = history[todayStr()] ? 0 : 1;
  for (let i = start; i < 400; i++) {
    if (history[dateStr(Date.now() - i * DAY)]) streak++;
    else break;
  }
  return streak;
}

/* ---------------- store: localStorage + optional authed cloud sync ------- */
function useStore() {
  const [data, setData] = useState(null);
  const [session, setSession] = useState(null);
  const [syncState, setSyncState] = useState("local"); // local | syncing | synced | error
  const cloudTimer = useRef(null);
  const latest = useRef(null);
  const loadedUid = useRef(undefined); // which user's data is currently loaded

  /* auth session */
  useEffect(() => {
    if (!supabase) return;
    supabase.auth.getSession().then(({ data: { session } }) => setSession(session));
    const { data: sub } = supabase.auth.onAuthStateChange((_e, s) => setSession(s));
    return () => sub.subscription.unsubscribe();
  }, []);

  /* initial load — cloud row wins if signed in and it exists,
     otherwise localStorage, otherwise a clean empty state */
  useEffect(() => {
    const uid = session?.user?.id ?? null;
    if (loadedUid.current === uid) return; // token refresh — data already loaded
    loadedUid.current = uid;
    let cancelled = false;
    (async () => {
      let local = null;
      try {
        const raw = localStorage.getItem(KEY);
        if (raw) local = migrate(JSON.parse(raw));
      } catch { /* corrupted local data — start fresh */ }

      if (supabase && session) {
        try {
          const { data: row, error } = await supabase
            .from("calibre_data")
            .select("data")
            .eq("user_id", session.user.id)
            .maybeSingle();
          if (cancelled) return;
          if (!error && row?.data) {
            const cloud = migrate(row.data);
            setData(cloud);
            latest.current = cloud;
            localStorage.setItem(KEY, JSON.stringify(cloud));
            setSyncState("synced");
            return;
          }
          if (!error && !row && local) {
            // first sign-in on this device: push local data up
            setData(local);
            latest.current = local;
            const { error: upErr } = await supabase
              .from("calibre_data")
              .upsert({ user_id: session.user.id, data: local, updated_at: new Date().toISOString() });
            setSyncState(upErr ? "error" : "synced");
            return;
          }
          if (error) setSyncState("error");
        } catch {
          if (!cancelled) setSyncState("error");
        }
      }
      if (cancelled) return;
      const d = local || emptyData();
      setData(d);
      latest.current = d;
      if (!supabase || !session) setSyncState("local");
    })();
    return () => { cancelled = true; };
  }, [session]);

  /* multi-tab: adopt changes written by another tab */
  useEffect(() => {
    const onStorage = (e) => {
      if (e.key === KEY && e.newValue) {
        try {
          const next = migrate(JSON.parse(e.newValue));
          latest.current = next;
          setData(next);
        } catch { /* ignore */ }
      }
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  /* live cross-device sync: adopt rows written by other devices.
     Our own writes echo back too — skipped by the deep-equality check.
     While a local write is pending (debounce timer), local wins. */
  useEffect(() => {
    if (!supabase || !session) return;
    const uid = session.user.id;
    const ch = supabase
      .channel(`calibre-sync-${uid}`)
      .on("postgres_changes",
        { event: "*", schema: "public", table: "calibre_data", filter: `user_id=eq.${uid}` },
        (payload) => {
          const incoming = payload.new?.data;
          if (!incoming || cloudTimer.current) return;
          const next = migrate(incoming);
          const s = JSON.stringify(next);
          if (s === JSON.stringify(latest.current)) return;
          latest.current = next;
          setData(next);
          try { localStorage.setItem(KEY, s); } catch { /* quota */ }
          setSyncState("synced");
        })
      .subscribe();
    return () => { supabase.removeChannel(ch); };
  }, [session]);

  const pushCloud = useCallback((uid) => {
    if (!supabase || !uid || !latest.current) return;
    setSyncState("syncing");
    supabase
      .from("calibre_data")
      .upsert({ user_id: uid, data: latest.current, updated_at: new Date().toISOString() })
      .then(({ error }) => setSyncState(error ? "error" : "synced"));
  }, []);

  /* save: state + localStorage immediately, cloud debounced (~900 ms) */
  const save = useCallback((next) => {
    setData(next);
    latest.current = next;
    try { localStorage.setItem(KEY, JSON.stringify(next)); } catch { /* quota */ }
    if (supabase && session) {
      clearTimeout(cloudTimer.current);
      cloudTimer.current = setTimeout(() => pushCloud(session.user.id), 900);
    }
  }, [session, pushCloud]);

  /* flush pending cloud write when the tab is hidden or closing */
  useEffect(() => {
    const flush = () => {
      if (cloudTimer.current && supabase && session) {
        clearTimeout(cloudTimer.current);
        cloudTimer.current = null;
        pushCloud(session.user.id);
      }
    };
    const onVis = () => { if (document.hidden) flush(); };
    document.addEventListener("visibilitychange", onVis);
    window.addEventListener("beforeunload", flush);
    return () => {
      document.removeEventListener("visibilitychange", onVis);
      window.removeEventListener("beforeunload", flush);
    };
  }, [session, pushCloud]);

  return { data, save, session, syncState };
}

/* ---------------- persisted timer (survives refresh) --------------------- */
function loadTimer() {
  try {
    const t = JSON.parse(localStorage.getItem(TIMER_KEY));
    if (t && typeof t === "object") return { mode: "work", running: false, endAt: null, remaining: null, cycle: 0, ...t };
  } catch { /* ignore */ }
  return { mode: "work", running: false, endAt: null, remaining: null, cycle: 0 };
}

/* one shared AudioContext, created lazily on first user-triggered chime */
let audioCtx = null;
function chime() {
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === "suspended") audioCtx.resume();
    [880, 660, 990].forEach((f, i) => {
      const o = audioCtx.createOscillator(), g = audioCtx.createGain();
      o.frequency.value = f; o.type = "sine";
      o.connect(g); g.connect(audioCtx.destination);
      const t0 = audioCtx.currentTime + i * 0.16;
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.exponentialRampToValueAtTime(0.18, t0 + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.15);
      o.start(t0); o.stop(t0 + 0.16);
    });
  } catch { /* audio unavailable */ }
}

/* ---------- small helpers ---------- */
const PRIORITY = {
  high: { label: "High", color: "var(--crimson)" },
  med: { label: "Med", color: "var(--brass)" },
  low: { label: "Low", color: "var(--slate)" },
};
const fmtDue = (ds) => {
  const [y, m, d] = ds.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString("en-GB", { day: "numeric", month: "short" });
};

const NAV = [
  { id: "today", label: "Today", icon: "◎" },
  { id: "program", label: "Programme", icon: "✦" },
  { id: "tasks", label: "Manifest", icon: "≣" },
  { id: "habits", label: "Habits", icon: "⊙" },
  { id: "reserve", label: "Reserve", icon: "◐" },
  { id: "insights", label: "Insights", icon: "◭" },
  { id: "regulator", label: "Regulator", icon: "⚙" },
];

/* ============== PROGRAMME — MPSI Janson → MP* → concours 2028 ==============
   Two-year roadmap. Item ids are stable: checked state lives in
   data.programDone and syncs like everything else. */
const ECRITS_2028 = "2028-04-17"; // ≈ start of the écrits (X / Centrale window)
const DRIVE_URL = "https://drive.google.com/drive/folders/1iKNEdPotIdQS13Adu0zUHkFUPV9JWkYX?usp=drive_link";
const POLY_LLG_URL = "https://miqmacs.fr/docLLG.pdf";      // « Mathématiques : du lycée aux CPGE » (LLG & Henri-IV)
const POLY_LLG_CORR_URL = "https://miqmacs.fr/docLLGc.pdf"; // correction du poly, même plan
const QCM_URL = "https://qcm.miqmacs.fr";                   // modules QCM d'auto-évaluation
const PROGRAM = [
  {
    id: "p0", title: "Été 2026 — la rampe de lancement", period: ["2026-07-01", "2026-08-31"],
    focus: "Arriver le 1er septembre avec les automatismes déjà en place. 3–4 h de maths par jour, régulières, plutôt que des journées héroïques.",
    items: [
      { id: "p0-llg", label: "Terminer le poly de Louis-le-Grand (transition lycée → MPSI), en rédigeant chaque exercice" },
      { id: "p0-qcm", label: "Valider chaque partie du poly avec le module QCM correspondant — corrigé consulté après coup seulement" },
      { id: "p0-auto", label: "Automatismes parfaits : dérivées, primitives usuelles, trigonométrie, inégalités classiques — sans hésiter" },
      { id: "p0-book", label: "Ellipses MPSI : logique & ensembles, calculs algébriques, nombres complexes (cours résumé + exos-minutes)" },
      { id: "p0-drive", label: "Organiser le Drive : un dossier par chapitre (polys, DS, fiches), pour tout retrouver en 10 secondes" },
      { id: "p0-fr", label: "Lire activement les 3 œuvres du programme de français-philo — carnet de citations tenu au fil des pages" },
      { id: "p0-phys", label: "Physique : terminale refichée (1 page par thème depuis tes cours) + premiers chapitres MPSI entrevus" },
      { id: "p0-sleep", label: "Caler le sommeil sur le rythme prépa (23 h – 7 h) deux semaines avant la rentrée" },
    ],
    weeks: [
      {
        id: "p0w1", title: "S1 — Mise en route", period: ["2026-07-13", "2026-07-19"],
        items: [
          { id: "p0w1-m", label: "Maths : poly LLG — logique & raisonnements, rédigé au propre + module QCM" },
          { id: "p0w1-p", label: "Physique : refiches mécanique de terminale (cinématique, lois de Newton) depuis tes cours" },
          { id: "p0w1-f", label: "Français : ouvrir l'œuvre 1 — lecture crayon en main, carnet de citations démarré" },
          { id: "p0w1-c", label: "Cadre : « Adopter le rythme prépa » dans l'app, sessions de 25 min sur le projet Maths" },
        ],
      },
      {
        id: "p0w2", title: "S2 — Le calcul, nerf de la guerre", period: ["2026-07-20", "2026-07-26"],
        items: [
          { id: "p0w2-m", label: "Maths : calculs algébriques & inégalités (sommes, produits, récurrences) + QCM" },
          { id: "p0w2-p", label: "Physique : mouvement dans un champ (gravitation, champ électrique) — 1 exo type bac par jour" },
          { id: "p0w2-f", label: "Français : œuvre 1 jusqu'à la moitié — fiche personnages / thèmes en parallèle" },
        ],
      },
      {
        id: "p0w3", title: "S3 — Trigonométrie & ondes", period: ["2026-07-27", "2026-08-02"],
        items: [
          { id: "p0w3-m", label: "Maths : trigonométrie — formules par cœur, équations trigonométriques + QCM" },
          { id: "p0w3-p", label: "Physique : ondes (interférences, diffraction, Doppler) — fiches + annales ciblées du Drive" },
          { id: "p0w3-f", label: "Français : terminer l'œuvre 1 — fiche de synthèse, 10 citations sues" },
        ],
      },
      {
        id: "p0w4", title: "S4 — Dérivation & circuits", period: ["2026-08-03", "2026-08-09"],
        items: [
          { id: "p0w4-m", label: "Maths : dérivation & étude de fonctions, inégalités par l'analyse + QCM" },
          { id: "p0w4-p", label: "Physique : électricité (circuits, RC) — 2 sujets de bac en temps limité" },
          { id: "p0w4-f", label: "Français : œuvre 2, première moitié — carnet de citations" },
        ],
      },
      {
        id: "p0w5", title: "S5 — Primitives & premiers pas MPSI", period: ["2026-08-10", "2026-08-16"],
        items: [
          { id: "p0w5-m", label: "Maths : primitives & calcul intégral + QCM" },
          { id: "p0w5-p", label: "Physique MPSI : l'oscillateur harmonique en découverte (cours du Drive)" },
          { id: "p0w5-f", label: "Français : terminer l'œuvre 2 — fiche de synthèse" },
        ],
      },
      {
        id: "p0w6", title: "S6 — Suites & complexes", period: ["2026-08-17", "2026-08-23"],
        items: [
          { id: "p0w6-m", label: "Maths : suites + nombres complexes (module, argument, forme exponentielle) + QCM" },
          { id: "p0w6-p", label: "Physique MPSI : lois des circuits (Kirchhoff, dipôles) + optique géométrique en découverte" },
          { id: "p0w6-f", label: "Français : œuvre 3, première moitié" },
        ],
      },
      {
        id: "p0w7", title: "S7 — Rentrée en tête", period: ["2026-08-24", "2026-08-31"],
        items: [
          { id: "p0w7-m", label: "Maths : reprendre tous les exercices ratés du poly ; refaire les modules QCM" },
          { id: "p0w7-p", label: "Physique : relire les fiches terminale (1 page/thème) + les débuts MPSI" },
          { id: "p0w7-f", label: "Français : terminer l'œuvre 3 — relier les 3 œuvres au thème de l'année (plan d'une dissertation)" },
          { id: "p0w7-r", label: "Sommeil calé 23 h – 7 h, affaires prêtes — et deux vrais jours de repos avant le 1er septembre" },
        ],
      },
    ],
  },
  {
    id: "p1", title: "MPSI, semestre 1 — installer la machine", period: ["2026-09-01", "2027-01-31"],
    focus: "Le classement pour MP* se joue dès maintenant. La règle d'or : aucun point de cours ne reste flou plus de 48 h.",
    items: [
      { id: "p1-fiche", label: "Relire et refaire le cours le soir même ; une fiche (théorèmes + méthodes) par chapitre" },
      { id: "p1-kholle", label: "Avant chaque khôlle de maths : Vrai/Faux et erreurs classiques du chapitre dans l'Ellipses" },
      { id: "p1-ds", label: "Chaque week-end : un problème type DS en temps limité, rédigé comme au concours" },
      { id: "p1-core", label: "Chapitres cœur maîtrisés : complexes, suites, limites/continuité, dérivabilité, équations différentielles, polynômes, arithmétique" },
      { id: "p1-rank", label: "Objectif classement : top 10 de la classe aux DS de maths et physique" },
      { id: "p1-ask", label: "Poser chaque point flou au prof ou en khôlle — la question ne coûte rien, la lacune coûte le concours" },
    ],
  },
  {
    id: "p2", title: "MPSI, semestre 2 — sécuriser l'étoile", period: ["2027-02-01", "2027-06-30"],
    focus: "L'algèbre linéaire est LE juge de paix de la MPSI. La décision MP* tombe en juin sur le classement de l'année.",
    items: [
      { id: "p2-algebra", label: "Algèbre linéaire à fond : espaces vectoriels, dimension finie, matrices, déterminants — refaits trois fois plutôt qu'une" },
      { id: "p2-analysis", label: "Analyse : développements limités, intégration sur un segment, séries numériques (début)" },
      { id: "p2-proba", label: "Probabilités finies + espaces préhilbertiens : ne pas les sacrifier, ils tombent aux concours" },
      { id: "p2-concours", label: "Sur chaque chapitre terminé : les sujets de concours (écrits, oraux) de l'Ellipses" },
      { id: "p2-rank", label: "Tenir le classement (top 10) jusqu'aux conseils de juin — c'est le dossier MP*" },
      { id: "p2-mpstar", label: "Obtenir la MP* de Janson ✦" },
    ],
  },
  {
    id: "p3", title: "Été 2027 — consolider avant l'assaut", period: ["2027-07-01", "2027-08-31"],
    focus: "Deux vraies semaines de repos, puis révision complète. En MP*, tout va deux fois plus vite : l'avance prise ici est décisive.",
    items: [
      { id: "p3-rest", label: "Deux semaines de vraie coupure — le cerveau consolide pendant le repos" },
      { id: "p3-review", label: "Révision complète MPSI par les fiches ; refaire intégralement les DS ratés de l'année" },
      { id: "p3-ahead", label: "Prendre de l'avance sur le programme MP : séries, intégrales généralisées, réduction des endomorphismes" },
      { id: "p3-tipe", label: "Choisir le sujet de TIPE et faire la première bibliographie" },
    ],
  },
  {
    id: "p4", title: "MP* — l'année du concours commence", period: ["2027-09-01", "2027-12-31"],
    focus: "Niveau X/ENS aux khôlles, rythme concours aux écrits. Le TIPE avance chaque semaine, pas « plus tard ».",
    items: [
      { id: "p4-subject", label: "Un sujet de concours (Centrale ou Mines) par semaine, en temps limité, rédigé" },
      { id: "p4-kholle", label: "Khôlles préparées au niveau X/ENS : planches classiques refaites jusqu'à fluidité" },
      { id: "p4-fiches", label: "Fiches méthodes transversales : « comment on attaque » chaque grand type de problème" },
      { id: "p4-tipe", label: "TIPE : expériences/résultats concrets avant décembre" },
    ],
  },
  {
    id: "p5", title: "Janvier – avril 2028 — révisions & écrits", period: ["2028-01-01", "2028-04-30"],
    focus: "Rotation systématique des thèmes, annales en conditions réelles. Les écrits se gagnent sur la régularité de la rédaction.",
    items: [
      { id: "p5-rotate", label: "Planning de révision en rotation : chaque thème revu au moins deux fois avant avril" },
      { id: "p5-annales", label: "Annales X-ENS, Centrale, Mines en conditions (durée réelle, sans notes)" },
      { id: "p5-blancs", label: "Deux sujets blancs par semaine, corrigés à fond : chaque point perdu est compris" },
      { id: "p5-ecrits", label: "Écrits 2028 ✦ — arriver reposé : les derniers jours, on dort, on ne bachote plus" },
    ],
  },
  {
    id: "p6", title: "Mai – juillet 2028 — les oraux", period: ["2028-05-01", "2028-07-31"],
    focus: "L'oral est un sport : une planche par jour, à voix haute, au tableau. C'est ici que l'X et CentraleSupélec se départagent.",
    items: [
      { id: "p6-planches", label: "Une planche d'oral par jour (X, CS) : parler en travaillant, gérer le tableau" },
      { id: "p6-ads", label: "Préparer l'ADS et l'oral de TIPE : exposé rodé, questions anticipées" },
      { id: "p6-pace", label: "Après les admissibilités : caler les cadences sur les écoles obtenues" },
      { id: "p6-goal", label: "Intégrer l'X ou CentraleSupélec ✦✦" },
    ],
  },
];

/* ======================= DIAL ======================= */
/* Composition borrowed from minimalist pairing dials (Wove): a large
   arc bleeding off the left edge, ghost numerals marking each session
   of the cycle along it, and the remaining time set huge beside the
   arc with a quiet label underneath. */
function Dial({ mode, secondsLeft, total, running, cycle, cycles, taskLabel, onToggle, onReset, onSkip }) {
  const pct = total ? 1 - secondsLeft / total : 0;
  const mm = String(Math.floor(secondsLeft / 60)).padStart(2, "0");
  const ss = String(secondsLeft % 60).padStart(2, "0");
  const accent = mode === "work" ? "var(--crimson)" : "var(--jade)";
  const cx = 20, cy = 230, r = 200;
  const rad = (deg) => (deg * Math.PI) / 180;
  const at = (deg, radius = r) => [cx + radius * Math.cos(rad(deg)), cy + radius * Math.sin(rad(deg))];

  /* progress runs down the visible right-hand arc, top → bottom */
  const theta = -90 + pct * 180;
  const [px, py] = at(theta);
  const [sx, sy] = at(-90);
  const arc = pct > 0.002 ? `M ${sx} ${sy} A ${r} ${r} 0 0 1 ${px} ${py}` : "";

  /* one ghost numeral + dot per session in the cycle, tangent-rotated */
  const pos = cycle % cycles;
  const ghosts = [];
  for (let i = 0; i < cycles; i++) {
    const a = cycles === 1 ? 0 : -58 + (116 / (cycles - 1)) * i;
    const [gx, gy] = at(a, r + 42);
    const [dx, dy] = at(a);
    const isNow = i === pos;
    const isPast = i < pos;
    ghosts.push(
      <g key={i}>
        <circle cx={dx} cy={dy} r={isNow ? 4 : 2.5}
          fill={isNow ? accent : isPast ? "var(--brass)" : "var(--steel)"} opacity={isNow ? 1 : 0.85} />
        <text x={gx} y={gy} transform={`rotate(${a} ${gx} ${gy})`}
          textAnchor="middle" dominantBaseline="central" className="dial-ghost"
          style={{ opacity: isNow ? 0.95 : isPast ? 0.4 : 0.16, fill: isNow ? "var(--brass)" : "var(--ivory)" }}>
          {String(i + 1).padStart(2, "0")}
        </text>
      </g>
    );
  }

  const label = mode === "work" ? "SESSION" : mode === "break" ? "SHORT REST" : "LONG REST";
  const desc = mode === "work"
    ? (taskLabel ? (taskLabel.length > 36 ? taskLabel.slice(0, 35) + "…" : taskLabel) : "one movement at a time.")
    : "let the mechanism breathe.";

  return (
    <div className="dial">
      <svg viewBox="0 0 700 460" className="dial-svg" role="timer" aria-label={`${label}: ${mm} minutes ${ss} seconds remaining`}>
        <circle cx={cx} cy={cy} r={r} fill="none" stroke="var(--steel)" strokeWidth="1.5" />
        {arc && <path d={arc} fill="none" stroke={accent} strokeWidth="2.5" strokeLinecap="round" opacity="0.9" />}
        {ghosts}
        <circle cx={px} cy={py} r="6" fill={accent} />
        <text x={300} y={250} className="dial-big">{mm}:{ss}</text>
        <text x={305} y={290} className="dial-mode" style={{ fill: accent }}>
          {label} · {String(pos + 1).padStart(2, "0")} OF {String(cycles).padStart(2, "0")}
        </text>
        <text x={305} y={315} className="dial-desc">{desc}</text>
      </svg>
      <div className="dial-ctrl">
        <button className="crown" onClick={onToggle}>{running ? "Pause" : "Wind"}</button>
        <button className="ghost" onClick={onReset}>Reset</button>
        <button className="ghost" onClick={onSkip}>Skip →</button>
      </div>
    </div>
  );
}

/* ================= sparkline ================= */
function Spark({ points, color = "var(--brass)", max, height = 40, width = 200, responsive = false }) {
  if (!points.length) return null;
  const hi = max || Math.max(...points, 1);
  const step = width / Math.max(points.length - 1, 1);
  const d = points.map((p, i) => `${i === 0 ? "M" : "L"} ${(i * step).toFixed(1)} ${(height - (p / hi) * height).toFixed(1)}`).join(" ");
  return (
    <svg viewBox={`0 0 ${width} ${height}`} width={responsive ? "100%" : width} height={height} preserveAspectRatio="none" aria-hidden="true"
      style={responsive ? { display: "block" } : undefined}>
      <path d={d} fill="none" stroke={color} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}

/* ================= scatter (sleep vs next-day focus) ================= */
function Scatter({ points, width = 300, height = 170, color = "var(--brass)" }) {
  if (!points.length) return null;
  const xs = points.map((p) => p[0]), ys = points.map((p) => p[1]);
  const xMax = Math.max(...xs, 1), yMax = Math.max(...ys, 1);
  const pad = 8;
  return (
    <svg viewBox={`0 0 ${width} ${height}`} width={width} height={height} aria-hidden="true">
      <line x1={pad} y1={height - pad} x2={width - pad} y2={height - pad} stroke="var(--steel)" strokeWidth="1" />
      <line x1={pad} y1={pad} x2={pad} y2={height - pad} stroke="var(--steel)" strokeWidth="1" />
      {points.map(([x, y], i) => {
        const px = pad + (x / xMax) * (width - pad * 2);
        const py = height - pad - (y / yMax) * (height - pad * 2);
        return <circle key={i} cx={px} cy={py} r="4" fill={color} opacity="0.7" />;
      })}
    </svg>
  );
}

/* ================= year heatmap (habits) ================= */
function YearHeatmap({ habits }) {
  if (habits.length === 0) return null;
  const today = new Date(); today.setHours(12, 0, 0, 0);
  const start = new Date(today.getTime() - (today.getDay() + 52 * 7) * DAY);
  const total = habits.length;
  const cols = [];
  const monthLabels = [];
  let prevMonth = "";
  let daysKept = 0;
  for (let w = 0; w < 53; w++) {
    const cells = [];
    for (let d = 0; d < 7; d++) {
      const date = new Date(start.getTime() + (w * 7 + d) * DAY);
      if (date > today) { cells.push(null); continue; }
      const ds = dateStr(date.getTime());
      const count = habits.reduce((a, h) => a + (h.history[ds] ? 1 : 0), 0);
      if (count > 0) daysKept++;
      cells.push({ ds, count });
    }
    const m = new Date(start.getTime() + w * 7 * DAY).toLocaleDateString("en-GB", { month: "short" });
    monthLabels.push(m !== prevMonth ? m : "");
    prevMonth = m;
    cols.push(cells);
  }
  const LEVELS = ["rgba(86,225,232,0.08)", "rgba(78,205,196,0.28)", "rgba(78,205,196,0.5)", "rgba(78,205,196,0.75)", "#4ecdc4"];
  const level = (count) => count === 0 ? 0 : Math.max(1, Math.round((count / total) * 4));
  return (
    <div className="panel" style={{ marginTop: 24 }}>
      <h3>The year — {daysKept} {daysKept === 1 ? "day" : "days"} with at least one habit kept</h3>
      <div className="heatwrap">
        <div>
          <div className="heatmonths" aria-hidden="true">
            {monthLabels.map((m, i) => <div key={i} className="heatmonth">{m}</div>)}
          </div>
          <div className="heatgrid" role="img" aria-label={`Habit heatmap for the last year: ${daysKept} days with at least one habit kept`}>
            {cols.map((cells, w) => (
              <div className="heatcol" key={w}>
                {cells.map((c, d) => c
                  ? <div key={d} className="heatcell" style={{ background: LEVELS[level(c.count)] }} title={`${c.ds} · ${c.count}/${total} habits`} />
                  : <div key={d} className="heatcell" style={{ background: "transparent" }} />)}
              </div>
            ))}
          </div>
        </div>
      </div>
      <div className="setsub" style={{ marginTop: 10 }}>Each cell is a day — deeper jade, more habits kept.</div>
    </div>
  );
}

/* ================= App ================= */
export default function Calibre() {
  const { data, save, session, syncState } = useStore();
  const [tab, setTab] = useState("today");
  const [insightRange, setInsightRange] = useState(7);

  /* ---------------- timer: timestamp-based, throttle-proof --------------- */
  const [timer, setTimer] = useState(loadTimer);
  const [now, setNow] = useState(Date.now());
  const [activeTask, setActiveTask] = useState(() => loadTimer().activeTask || null);
  const completedRef = useRef(false);

  const S = data?.settings || DEFAULT_SETTINGS;
  const total = timer.mode === "work" ? S.work * 60 : timer.mode === "break" ? S.break * 60 : S.longBreak * 60;
  const secondsLeft = timer.running
    ? Math.max(0, Math.round((timer.endAt - now) / 1000))
    : (timer.remaining ?? total);

  /* persist timer + pinned task across refreshes */
  useEffect(() => {
    try { localStorage.setItem(TIMER_KEY, JSON.stringify({ ...timer, activeTask })); } catch { /* ignore */ }
  }, [timer, activeTask]);

  /* tick from the wall clock; re-sync instantly when the tab wakes up */
  useEffect(() => {
    if (!timer.running) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 500);
    const onVis = () => setNow(Date.now());
    document.addEventListener("visibilitychange", onVis);
    return () => { clearInterval(id); document.removeEventListener("visibilitychange", onVis); };
  }, [timer.running]);

  /* countdown in the tab title while running */
  useEffect(() => {
    if (timer.running) {
      const mm = String(Math.floor(secondsLeft / 60)).padStart(2, "0");
      const ss = String(secondsLeft % 60).padStart(2, "0");
      document.title = `${mm}:${ss} · Calibre`;
    } else {
      document.title = "Calibre";
    }
  }, [timer.running, secondsLeft]);

  const completeSession = useCallback(() => {
    if (S.sound) chime();
    if (document.hidden && "Notification" in window && Notification.permission === "granted") {
      try {
        new Notification(timer.mode === "work" ? "Session complete" : "Rest over", {
          body: timer.mode === "work" ? "Time for a rest." : "Back to work.",
        });
      } catch { /* ignore */ }
    }
    if (timer.mode === "work") {
      const nextCycle = timer.cycle + 1;
      const isLong = nextCycle % S.cycles === 0;
      if (data) {
        const task = data.tasks.find((x) => x.id === activeTask);
        const sess = { date: todayStr(), mode: "work", minutes: S.work, taskId: activeTask, project: task?.project || null };
        save({
          ...data,
          completedSessions: data.completedSessions + 1,
          focusMinutesTotal: data.focusMinutesTotal + S.work,
          sessions: [...data.sessions, sess],
        });
      }
      setTimer((t) => ({ ...t, mode: isLong ? "long" : "break", running: false, endAt: null, remaining: null, cycle: nextCycle }));
    } else {
      setTimer((t) => ({ ...t, mode: "work", running: false, endAt: null, remaining: null }));
    }
  }, [data, save, timer.mode, timer.cycle, S, activeTask]);

  /* completion detection lives in an effect, not inside a state updater —
     safe under StrictMode's double-invocation, guarded against firing twice */
  useEffect(() => {
    if (timer.running && secondsLeft === 0 && !completedRef.current) {
      completedRef.current = true;
      completeSession();
    }
    if (secondsLeft > 0) completedRef.current = false;
  }, [timer.running, secondsLeft, completeSession]);

  const toggleTimer = useCallback(() => {
    if (timer.running) {
      setTimer((t) => ({ ...t, running: false, endAt: null, remaining: secondsLeft }));
    } else {
      if ("Notification" in window && Notification.permission === "default") {
        Notification.requestPermission().catch(() => {});
      }
      setTimer((t) => ({ ...t, running: true, endAt: Date.now() + secondsLeft * 1000, remaining: null }));
    }
  }, [timer.running, secondsLeft]);
  function resetTimer() { setTimer((t) => ({ ...t, running: false, endAt: null, remaining: null })); }
  function skip() {
    if (timer.mode === "work") {
      const nextCycle = timer.cycle + 1;
      const long = nextCycle % S.cycles === 0;
      setTimer((t) => ({ ...t, mode: long ? "long" : "break", running: false, endAt: null, remaining: null, cycle: nextCycle }));
    } else {
      setTimer((t) => ({ ...t, mode: "work", running: false, endAt: null, remaining: null }));
    }
  }

  /* ---------- task form ---------- */
  const [newTask, setNewTask] = useState("");
  const [newPriority, setNewPriority] = useState("med");
  const [newProject, setNewProject] = useState("");
  const [newDue, setNewDue] = useState("");
  const [newEst, setNewEst] = useState("");
  const [filter, setFilter] = useState("all");
  const [newHabit, setNewHabit] = useState("");

  /* ---------- sleep form: bedtime + wake time, not a raw hours count ---- */
  const [bedInput, setBedInput] = useState("");
  const [wakeInput, setWakeInput] = useState("");
  const [editingSleep, setEditingSleep] = useState(false);

  /* ---------- inline task editing ---------- */
  const [editingId, setEditingId] = useState(null);
  const [edit, setEdit] = useState(null);

  /* ---------- projects form ---------- */
  const [newProjName, setNewProjName] = useState("");
  const [newProjColor, setNewProjColor] = useState(PROJECT_COLORS[0]);
  const importRef = useRef(null);

  /* ---------- undo toast (replaces confirm dialogs for deletions) -------- */
  const [toast, setToast] = useState(null);
  const toastTimer = useRef(null);
  const showUndo = useCallback((msg, snapshot) => {
    clearTimeout(toastTimer.current);
    setToast({ msg, snapshot });
    toastTimer.current = setTimeout(() => setToast(null), 6000);
  }, []);
  function undoNow() {
    if (toast?.snapshot) save(toast.snapshot);
    clearTimeout(toastTimer.current);
    setToast(null);
  }

  /* ---------- keyboard shortcuts: Space wind/pause · 1–6 tabs · N new ---- */
  useEffect(() => {
    const onKey = (e) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const el = e.target;
      if (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.isContentEditable) return;
      if (e.key === " ") {
        e.preventDefault();
        toggleTimer();
      } else if (e.key >= "1" && e.key <= "7") {
        setTab(NAV[+e.key - 1].id);
      } else if (e.key === "n" || e.key === "N") {
        e.preventDefault();
        setTab("tasks");
        requestAnimationFrame(() => document.getElementById("new-task-input")?.focus());
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [toggleTimer]);

  /* ---------- reminders: wind-down + due-task nudges --------------------
     Fires at most once per day per kind, tracked in localStorage. Only
     works while the app (or its tab) is open — there is no push server. */
  const dataRef = useRef(null);
  useEffect(() => { dataRef.current = data; }, [data]);
  useEffect(() => {
    if (!S.reminders) return;
    const readFired = () => {
      try { return JSON.parse(localStorage.getItem(REMIND_KEY)) || {}; } catch { return {}; }
    };
    const markFired = (kind) => {
      const today = todayStr();
      const prev = readFired();
      const next = {};
      for (const k of Object.keys(prev)) if (k.endsWith(today)) next[k] = true; // prune old days
      next[`${kind}:${today}`] = true;
      try { localStorage.setItem(REMIND_KEY, JSON.stringify(next)); } catch { /* ignore */ }
    };
    const notify = (title, body) => {
      if (!("Notification" in window) || Notification.permission !== "granted") return false;
      try { new Notification(title, { body, icon: "/icon-192.png" }); return true; } catch { return false; }
    };
    const tick = () => {
      const d = dataRef.current;
      if (!d) return;
      const today = todayStr();
      const fired = readFired();
      const now = new Date();
      const nowMin = now.getHours() * 60 + now.getMinutes();

      /* wind-down: a 30-minute window starting 30 min before target bedtime */
      const [bh, bm] = (d.settings.targetBed || "23:00").split(":").map(Number);
      const windMin = (bh * 60 + bm - 30 + 1440) % 1440;
      const inWindWindow = nowMin >= windMin && nowMin < windMin + 30;
      if (inWindWindow && !fired[`wind:${today}`]) {
        if (notify("Wind down", `Target bedtime is ${d.settings.targetBed} — start closing the day.`)) markFired("wind");
      }

      /* due tasks: a morning nudge between 09:00 and 11:00 */
      if (nowMin >= 9 * 60 && nowMin < 11 * 60 && !fired[`due:${today}`]) {
        const due = d.tasks.filter((tk) => !tk.done && tk.due && tk.due <= today);
        if (due.length > 0) {
          if (notify(`${due.length} ${due.length === 1 ? "entry" : "entries"} due`, due.slice(0, 3).map((tk) => tk.label).join(" · "))) markFired("due");
        }
      }
    };
    tick();
    const id = setInterval(tick, 30000);
    return () => clearInterval(id);
  }, [S.reminders]);

  function toggleReminders() {
    if (!S.reminders && "Notification" in window && Notification.permission === "default") {
      Notification.requestPermission().catch(() => {});
    }
    setS({ reminders: !S.reminders });
  }

  /* ---------- auth form ---------- */
  const [email, setEmail] = useState("");
  const [authMsg, setAuthMsg] = useState("");
  async function sendLink() {
    if (!supabase || !email.trim()) return;
    setAuthMsg("Sending…");
    const { error } = await supabase.auth.signInWithOtp({
      email: email.trim(),
      options: { emailRedirectTo: window.location.origin },
    });
    setAuthMsg(error ? `Could not send link: ${error.message}` : "Check your inbox — a sign-in link is on its way.");
  }
  async function signOut() { await supabase?.auth.signOut(); setAuthMsg(""); }

  /* ---------- task ops ---------- */
  function addTask() {
    if (!newTask.trim()) return;
    const est = parseInt(newEst, 10);
    save({ ...data, tasks: [...data.tasks, {
      id: "t" + Date.now(), label: newTask.trim(), done: false, priority: newPriority,
      project: newProject || data.projects[0]?.name || null, due: newDue || null,
      est: est >= 1 ? Math.min(est, 20) : null, created: Date.now(),
    }] });
    setNewTask(""); setNewDue(""); setNewEst("");
  }
  function toggleTask(id) {
    save({ ...data, tasks: data.tasks.map((t) => t.id === id ? { ...t, done: !t.done, doneAt: !t.done ? Date.now() : null } : t) });
  }
  function delTask(id) {
    const tk = data.tasks.find((t) => t.id === id);
    if (activeTask === id) setActiveTask(null);
    showUndo(`Removed "${tk?.label}"`, data);
    save({ ...data, tasks: data.tasks.filter((t) => t.id !== id) });
  }
  function setActiveFocus(id) { setActiveTask(id); setTab("today"); }
  function startEdit(tk) {
    setEditingId(tk.id);
    setEdit({ label: tk.label, priority: tk.priority, project: tk.project || "", due: tk.due || "", est: tk.est || "" });
  }
  function saveEdit() {
    if (!edit?.label.trim()) return;
    const est = parseInt(edit.est, 10);
    save({ ...data, tasks: data.tasks.map((t) => t.id === editingId ? {
      ...t, label: edit.label.trim(), priority: edit.priority,
      project: edit.project || null, due: edit.due || null,
      est: est >= 1 ? Math.min(est, 20) : null,
    } : t) });
    setEditingId(null);
  }

  /* ---------- projects ---------- */
  const projColor = (name) => data?.projects.find((p) => p.name === name)?.color || "var(--slate)";
  function addProject() {
    const name = newProjName.trim();
    if (!name || data.projects.some((p) => p.name.toLowerCase() === name.toLowerCase())) return;
    save({ ...data, projects: [...data.projects, { name, color: newProjColor }] });
    setNewProjName("");
  }
  function delProject(name) {
    showUndo(`Removed project "${name}"`, data);
    save({ ...data, projects: data.projects.filter((p) => p.name !== name) });
    if (filter === name) setFilter("all");
  }

  /* ---------- programme ---------- */
  function toggleProgramItem(id) {
    save({ ...data, programDone: { ...data.programDone, [id]: !data.programDone[id] } });
  }
  /* seed the prépa working rhythm: projects + daily habits (additive) */
  function adoptRhythm() {
    const wantProjects = [
      { name: "Maths", color: "#56e1e8" }, { name: "Physique", color: "#b98bff" },
      { name: "Khôlles", color: "#ff6b6b" }, { name: "TIPE", color: "#ffc46b" },
    ];
    const wantHabits = ["Exos-minutes (10 min de calcul)", "Fiche du soir (cours du jour)", "Anglais — 15 min"];
    const newProjects = wantProjects.filter((w) => !data.projects.some((p) => p.name.toLowerCase() === w.name.toLowerCase()));
    const newHabits = wantHabits.filter((w) => !data.habits.some((h) => h.name.toLowerCase() === w.toLowerCase()));
    if (newProjects.length === 0 && newHabits.length === 0) return;
    showUndo("Rythme prépa adopté — projets et habitudes ajoutés", data);
    save({
      ...data,
      projects: [...data.projects, ...newProjects],
      habits: [...data.habits, ...newHabits.map((name, i) => ({ id: "h" + (Date.now() + i), name, best: 0, history: {} }))],
    });
  }

  /* ---------- backup ---------- */
  function exportData() {
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `calibre-backup-${todayStr()}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }
  function importData(file) {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const obj = JSON.parse(reader.result);
        if (!obj || typeof obj !== "object" || !Array.isArray(obj.tasks)) {
          alert("That file doesn't look like a Calibre backup."); return;
        }
        if (confirm("Replace all current data with this backup?")) save(migrate(obj));
      } catch {
        alert("Could not read that file.");
      }
    };
    reader.readAsText(file);
  }

  /* ---------- habits ---------- */
  function toggleHabit(id) {
    save({
      ...data,
      habits: data.habits.map((h) => {
        if (h.id !== id) return h;
        const history = { ...h.history, [todayStr()]: !h.history[todayStr()] };
        const streak = calcStreak(history);
        return { ...h, history, best: Math.max(h.best || 0, streak) };
      }),
    });
  }
  function addHabit() {
    if (!newHabit.trim()) return;
    save({ ...data, habits: [...data.habits, { id: "h" + Date.now(), name: newHabit.trim(), best: 0, history: {} }] });
    setNewHabit("");
  }
  function delHabit(id) {
    const h = data.habits.find((x) => x.id === id);
    showUndo(`Deleted habit "${h?.name}"`, data);
    save({ ...data, habits: data.habits.filter((x) => x.id !== id) });
  }

  /* ---------- sleep ---------- */
  function logSleep() {
    const hours = sleepHours(bedInput, wakeInput);
    if (hours == null || hours <= 0 || hours > 16) return;
    save({ ...data, sleepLog: { ...data.sleepLog, [todayStr()]: { bed: bedInput, wake: wakeInput, hours } } });
    setBedInput(""); setWakeInput(""); setEditingSleep(false);
  }

  /* ---------- settings ---------- */
  function setS(patch) { save({ ...data, settings: { ...S, ...patch } }); }
  function saveNotes(v) { save({ ...data, notes: v }); }

  /* ---------- derived stats ---------- */
  const stats = useMemo(() => {
    if (!data) return null;
    const last7 = [];
    for (let i = 6; i >= 0; i--) {
      const ds = dateStr(Date.now() - i * DAY);
      const mins = data.sessions.filter((s) => s.date === ds).reduce((a, s) => a + s.minutes, 0);
      last7.push({ ds, mins, sleep: data.sleepLog[ds]?.hours || 0 });
    }
    const todayMins = last7[6].mins;
    const logged = last7.filter((d) => d.sleep > 0);
    const avgSleep = logged.length ? logged.reduce((a, d) => a + d.sleep, 0) / logged.length : 0;
    const clearedToday = data.tasks.filter((t) => t.done && t.doneAt && dateStr(t.doneAt) === todayStr()).length;
    const doneAll = data.tasks.filter((t) => t.done).length;
    const bestStreak = Math.max(0, ...data.habits.map((h) => calcStreak(h.history)));
    /* focus by project over the last 7 days */
    const cutoff = last7[0].ds;
    const byProject = {};
    data.sessions.forEach((s) => {
      if (s.date >= cutoff) {
        const p = s.project || "—";
        byProject[p] = (byProject[p] || 0) + s.minutes;
      }
    });
    const projectRows = Object.entries(byProject).sort((a, b) => b[1] - a[1]);
    return { last7, todayMins, avgSleep, clearedToday, doneAll, bestStreak, projectRows };
  }, [data]);

  /* Insights tab: same shape of derived numbers as `stats`, but over a
     user-selectable window (7/30/90 days) instead of a fixed week —
     kept separate so Today/Reserve's fixed 7-day view can't regress. */
  const rangeStats = useMemo(() => {
    if (!data) return null;
    const days = insightRange;
    const series = [];
    for (let i = days - 1; i >= 0; i--) {
      const ds = dateStr(Date.now() - i * DAY);
      const mins = data.sessions.filter((s) => s.date === ds).reduce((a, s) => a + s.minutes, 0);
      const log = data.sleepLog[ds];
      series.push({ ds, mins, sleep: log?.hours || 0, bed: log?.bed || null });
    }
    const sleptDays = series.filter((d) => d.sleep > 0);
    const avgSleep = sleptDays.length ? sleptDays.reduce((a, d) => a + d.sleep, 0) / sleptDays.length : 0;
    const avgMins = Math.round(series.reduce((a, d) => a + d.mins, 0) / days);

    const bedMinutes = series.filter((d) => d.bed).map((d) => minutesFromNoon(d.bed));
    const consistency = bedMinutes.length >= 2 ? Math.max(0, Math.round(100 - (stdDev(bedMinutes) / 120) * 100)) : null;

    /* pair each night's sleep with the *next* day's focus minutes */
    const pairs = [];
    for (let i = 0; i < series.length - 1; i++) {
      if (series[i].sleep > 0) pairs.push([series[i].sleep, series[i + 1].mins]);
    }
    const r = pairs.length >= 3 ? pearson(pairs.map((p) => p[0]), pairs.map((p) => p[1])) : null;

    const cutoff = series[0].ds;
    const byProject = {};
    data.sessions.forEach((s) => {
      if (s.date >= cutoff) {
        const p = s.project || "—";
        byProject[p] = (byProject[p] || 0) + s.minutes;
      }
    });
    const projectRows = Object.entries(byProject).sort((a, b) => b[1] - a[1]);

    return { series, avgSleep, avgMins, consistency, projectRows, corr: { r, n: pairs.length, pairs } };
  }, [data, insightRange]);

  /* completed focus sessions per task — drives the est-progress tag */
  const sessCount = useMemo(() => {
    const m = {};
    data?.sessions.forEach((s) => { if (s.taskId) m[s.taskId] = (m[s.taskId] || 0) + 1; });
    return m;
  }, [data]);

  if (!data) {
    return (
      <div className="root" style={{ alignItems: "center", justifyContent: "center", minHeight: "100dvh", display: "flex", fontFamily: "'IBM Plex Mono', monospace", color: "#6fa8c8", fontSize: 13, letterSpacing: ".12em" }}>
        WINDING THE MECHANISM…
      </div>
    );
  }

  const t = todayStr();
  const filtered = data.tasks.filter((tk) => filter === "all" ? true : filter === "active" ? !tk.done : filter === "done" ? tk.done : tk.project === filter);
  const sorted = [...filtered].sort((a, b) => (a.done - b.done) || (({ high: 0, med: 1, low: 2 })[a.priority] - ({ high: 0, med: 1, low: 2 })[b.priority]));

  /* today's docket: overdue, due today, pinned, or high priority */
  const docket = data.tasks.filter((tk) =>
    !tk.done && (tk.id === activeTask || (tk.due && tk.due <= t) || tk.priority === "high"));

  const targetHours = sleepHours(S.targetBed, S.targetWake) ?? 8;
  const todayLog = data.sleepLog[t] || null;
  const bedDelta = todayLog?.bed ? timeDeltaMin(todayLog.bed, S.targetBed) : null;

  /* programme: which phase/week are we in, what's the next unchecked step */
  const phaseStatus = (p) => (t > p.period[1] ? "done" : t >= p.period[0] ? "current" : "upcoming");
  const phaseAllItems = (p) => [...p.items, ...(p.weeks ? p.weeks.flatMap((w) => w.items) : [])];
  const currentPhase = PROGRAM.find((p) => phaseStatus(p) === "current")
    || PROGRAM.find((p) => phaseStatus(p) === "upcoming")
    || PROGRAM[PROGRAM.length - 1];
  const currentWeek = currentPhase.weeks?.find((w) => t >= w.period[0] && t <= w.period[1]) || null;
  const nextProgramItem = currentWeek?.items.find((it) => !data.programDone[it.id])
    || currentPhase.items.find((it) => !data.programDone[it.id])
    || phaseAllItems(currentPhase).find((it) => !data.programDone[it.id])
    || null;
  const daysToEcrits = Math.max(0, Math.ceil((new Date(ECRITS_2028 + "T09:00:00") - Date.now()) / DAY));

  const SYNC = {
    local: { color: "var(--slate)", label: "Local only — data stays in this browser" },
    syncing: { color: "var(--brass)", label: "Syncing…" },
    synced: { color: "var(--jade)", label: "Synced to cloud" },
    error: { color: "var(--crimson)", label: "Sync error — changes saved locally" },
  }[syncState];

  return (
    <div className="root">
      <style>{`
        .root{
          --brass:#56e1e8;--brass-lo:#2ab8c0;
          --anthracite:rgba(2,18,70,0.58);--steel:rgba(86,225,232,0.18);
          --case:rgba(86,225,232,0.75);--parchment:rgba(5,25,80,0.55);
          --crimson:#ff6b6b;--jade:#4ecdc4;--ivory:#e8f4ff;--slate:#6fa8c8;
          font-family:'IBM Plex Sans',sans-serif;background:transparent;color:var(--ivory);
          position:relative;z-index:1;display:flex;min-height:100dvh;
        }
        .root *{box-sizing:border-box;}
        .nav{width:104px;background:rgba(2,10,42,0.72);backdrop-filter:blur(22px);
          -webkit-backdrop-filter:blur(22px);border-right:1px solid var(--steel);
          display:flex;flex-direction:column;align-items:center;padding:22px 0;gap:4px;flex-shrink:0;}
        .logo{font-family:'Fraunces',serif;font-weight:500;font-size:13px;letter-spacing:.24em;
          color:var(--brass);margin-bottom:26px;}
        .navbtn{width:80px;padding:11px 0;border:none;background:transparent;color:var(--slate);
          font-size:11px;letter-spacing:.04em;cursor:pointer;display:flex;flex-direction:column;
          align-items:center;gap:5px;border-radius:9px;transition:.18s;font-family:inherit;}
        .navbtn .ic{font-size:19px;line-height:1;}
        .navbtn:hover{color:var(--ivory);background:rgba(86,225,232,0.07);}
        .navbtn.on{color:var(--brass);background:rgba(86,225,232,0.12);}
        .syncdot{margin-top:auto;width:9px;height:9px;border-radius:50%;flex-shrink:0;}
        .main{flex:1;padding:32px 40px;overflow-y:auto;max-height:100dvh;
          background:rgba(2,10,42,0.35);backdrop-filter:blur(6px);-webkit-backdrop-filter:blur(6px);}
        .h1{font-family:'Fraunces',serif;font-weight:500;font-size:27px;margin:0 0 3px;letter-spacing:.01em;color:var(--ivory);}
        .sub{color:var(--slate);font-size:13px;margin:0 0 26px;}
        .mono{font-family:'IBM Plex Mono',monospace;}

        /* focus */
        .dial{display:flex;flex-direction:column;align-items:center;gap:6px;width:100%;}
        .dial-svg{width:100%;max-width:640px;height:auto;display:block;}
        .dial-ghost{font-family:'IBM Plex Mono',monospace;font-size:30px;font-weight:600;letter-spacing:.05em;}
        .dial-big{font-family:'IBM Plex Mono',monospace;font-size:82px;fill:var(--ivory);letter-spacing:.01em;}
        .dial-mode{font-family:'IBM Plex Mono',monospace;font-size:13px;letter-spacing:.18em;}
        .dial-desc{font-family:'IBM Plex Sans',sans-serif;font-size:14.5px;fill:var(--slate);}
        .dial-ctrl{display:flex;gap:10px;}
        .crown{background:var(--brass);color:#020d2e;border:none;padding:11px 30px;border-radius:22px;
          font-weight:600;font-size:13px;cursor:pointer;letter-spacing:.03em;font-family:inherit;}
        .crown:active{background:var(--brass-lo);}
        .ghost{background:rgba(86,225,232,0.06);border:1px solid var(--steel);color:var(--case);padding:11px 20px;
          border-radius:22px;font-size:13px;cursor:pointer;font-family:inherit;}
        .ghost:hover{border-color:var(--brass);background:rgba(86,225,232,0.1);}
        .focus-task{margin-top:22px;text-align:center;font-size:13px;color:var(--slate);}
        .focus-task b{color:var(--ivory);font-weight:500;}
        .stat-row{display:flex;gap:14px;justify-content:center;margin-top:26px;flex-wrap:wrap;}
        .stat{background:rgba(2,12,50,0.55);backdrop-filter:blur(14px);-webkit-backdrop-filter:blur(14px);
          border:1px solid var(--steel);border-radius:11px;
          padding:14px 22px;text-align:center;min-width:112px;}
        .stat .num{font-family:'IBM Plex Mono',monospace;font-size:23px;color:var(--brass);}
        .stat .lbl{font-size:10px;color:var(--slate);letter-spacing:.07em;margin-top:2px;}

        /* tasks */
        .toolbar{display:flex;gap:7px;flex-wrap:wrap;margin-bottom:16px;}
        .chip{background:rgba(86,225,232,0.05);border:1px solid var(--steel);color:var(--slate);
          padding:6px 13px;border-radius:16px;font-size:12px;cursor:pointer;font-family:inherit;}
        .chip.on{border-color:var(--brass);color:var(--brass);background:rgba(86,225,232,0.12);}
        .ledger{background:rgba(2,12,50,0.55);backdrop-filter:blur(14px);-webkit-backdrop-filter:blur(14px);
          border:1px solid var(--steel);border-radius:11px;overflow:hidden;color:var(--ivory);}
        .lrow{display:flex;align-items:center;gap:13px;padding:13px 18px;border-bottom:1px solid rgba(86,225,232,0.08);}
        .lrow:last-child{border-bottom:none;}
        .tick{width:21px;height:21px;border-radius:5px;border:1.5px solid var(--brass-lo);cursor:pointer;
          display:flex;align-items:center;justify-content:center;font-size:13px;color:var(--brass-lo);flex-shrink:0;
          background:transparent;padding:0;font-family:inherit;}
        .tick.on{background:var(--brass-lo);color:#020d2e;}
        .tick:focus-visible{outline:2px solid var(--brass);outline-offset:2px;}
        .lbody{flex:1;min-width:0;}
        .llabel{font-size:14px;line-height:1.3;color:var(--ivory);}
        .llabel.done{text-decoration:line-through;opacity:.4;}
        .lmeta{display:flex;gap:8px;margin-top:4px;align-items:center;flex-wrap:wrap;}
        .badge{font-size:10px;padding:2px 8px;border-radius:10px;letter-spacing:.03em;font-family:'IBM Plex Mono',monospace;}
        .proj{font-size:10px;color:var(--slate);letter-spacing:.04em;}
        .duetag{font-size:10px;font-family:'IBM Plex Mono',monospace;color:var(--slate);}
        .duetag.over{color:var(--crimson);}
        .laction{background:none;border:none;cursor:pointer;font-size:12px;color:var(--slate);padding:3px 6px;font-family:inherit;}
        .laction:hover{color:var(--brass);}
        .laction.del:hover{color:var(--crimson);}
        .composer{display:flex;gap:8px;margin-top:16px;flex-wrap:wrap;}
        .inp{background:rgba(2,18,70,0.65);border:1px solid var(--steel);color:var(--ivory);
          padding:10px 13px;border-radius:8px;font-size:13px;font-family:inherit;}
        .inp::placeholder{color:var(--slate);}
        .inp:focus{outline:none;border-color:var(--brass);}
        .inp:focus-visible{outline:2px solid var(--brass);outline-offset:1px;}
        select.inp{cursor:pointer;}
        select.inp option{background:#021242;color:var(--ivory);}
        input[type="date"].inp,input[type="time"].inp{color-scheme:dark;}
        .addbtn{background:var(--brass);border:none;color:#020d2e;padding:0 20px;border-radius:8px;
          font-weight:600;cursor:pointer;font-family:inherit;min-height:38px;}
        .addbtn:active{background:var(--brass-lo);}

        /* habits */
        .comps{display:flex;gap:18px;flex-wrap:wrap;}
        .comp{width:158px;background:rgba(2,12,50,0.55);backdrop-filter:blur(14px);-webkit-backdrop-filter:blur(14px);
          border:1px solid var(--steel);border-radius:13px;
          padding:16px 14px;display:flex;flex-direction:column;gap:9px;position:relative;}
        .comp.on{border-color:var(--jade);}
        .comp-name{font-size:13px;font-weight:500;line-height:1.25;color:var(--ivory);padding-right:16px;}
        .comp-streak{font-family:'IBM Plex Mono',monospace;font-size:30px;color:var(--brass);line-height:1;}
        .comp-unit{font-size:9px;color:var(--slate);letter-spacing:.1em;}
        .comp-best{font-size:10px;color:var(--slate);}
        .dots{display:flex;gap:4px;margin-top:4px;}
        .dot{width:13px;height:13px;border-radius:50%;border:1px solid var(--steel);}
        .dot.f{background:var(--jade);border-color:var(--jade);}
        .comp-btn{margin-top:4px;background:rgba(86,225,232,0.07);border:1px solid var(--steel);color:var(--case);
          padding:7px;border-radius:8px;font-size:12px;cursor:pointer;font-family:inherit;}
        .comp-btn.on{background:var(--jade);border-color:var(--jade);color:#020d2e;font-weight:600;}
        .comp-del{position:absolute;top:8px;right:10px;background:none;border:none;color:var(--slate);
          cursor:pointer;font-size:14px;opacity:.5;font-family:inherit;}
        .comp-del:hover{opacity:1;color:var(--crimson);}
        .heatwrap{overflow-x:auto;padding-bottom:6px;}
        .heatmonths{display:flex;gap:2px;margin-bottom:5px;}
        .heatmonth{width:9px;flex-shrink:0;font-size:8px;color:var(--slate);white-space:nowrap;overflow:visible;}
        .heatgrid{display:flex;gap:2px;width:fit-content;}
        .heatcol{display:flex;flex-direction:column;gap:2px;}
        .heatcell{width:9px;height:9px;border-radius:2px;flex-shrink:0;}

        /* reserve */
        .gauge-wrap{display:flex;justify-content:center;margin:6px 0 8px;}
        .weekbars{display:flex;gap:10px;width:fit-content;margin:26px auto 0;height:96px;}
        .wb{width:26px;height:96px;background:rgba(86,225,232,0.12);border-radius:4px;display:flex;
          align-items:flex-end;position:relative;}
        .wbf{width:100%;background:var(--brass);border-radius:4px;}
        .wbl{position:absolute;bottom:-20px;width:100%;text-align:center;font-size:9px;color:var(--slate);}
        .wbv{position:absolute;top:-16px;width:100%;text-align:center;font-size:9px;color:var(--slate);font-family:'IBM Plex Mono',monospace;}
        .target-line{position:absolute;left:0;right:0;height:0;border-top:1px dashed var(--jade);opacity:.55;pointer-events:none;}

        /* insights */
        .cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:14px;margin-bottom:26px;}
        .card{background:rgba(2,12,50,0.55);backdrop-filter:blur(14px);-webkit-backdrop-filter:blur(14px);
          border:1px solid var(--steel);border-radius:11px;padding:16px;}
        .card .cn{font-family:'IBM Plex Mono',monospace;font-size:26px;color:var(--brass);}
        .card .cl{font-size:11px;color:var(--slate);letter-spacing:.05em;margin-top:3px;}
        .panel{background:rgba(2,12,50,0.55);backdrop-filter:blur(14px);-webkit-backdrop-filter:blur(14px);
          border:1px solid var(--steel);border-radius:11px;padding:20px;margin-bottom:18px;}
        .panel h3{font-family:'Fraunces',serif;font-weight:500;font-size:15px;margin:0 0 14px;color:var(--ivory);}
        .barchart{display:flex;align-items:flex-end;gap:12px;height:120px;}
        .bc{flex:1;display:flex;flex-direction:column;align-items:center;gap:6px;height:100%;justify-content:flex-end;}
        .bcbar{width:100%;max-width:34px;background:var(--brass);border-radius:4px 4px 0 0;min-height:2px;}
        .bcl{font-size:9px;color:var(--slate);}
        .bcv{font-size:9px;color:var(--slate);font-family:'IBM Plex Mono',monospace;}
        .prow{display:flex;align-items:center;gap:12px;margin-bottom:9px;}
        .plbl{width:76px;font-size:12px;color:var(--ivory);flex-shrink:0;}
        .ptrack{flex:1;height:9px;background:rgba(86,225,232,0.12);border-radius:5px;overflow:hidden;}
        .pfill{height:100%;background:var(--brass);border-radius:5px;}
        .pval{width:56px;text-align:right;font-size:11px;color:var(--slate);font-family:'IBM Plex Mono',monospace;flex-shrink:0;}

        /* regulator */
        .setrow{display:flex;align-items:center;justify-content:space-between;padding:14px 0;border-bottom:1px solid var(--steel);gap:12px;flex-wrap:wrap;}
        .setrow:last-child{border-bottom:none;}
        .setlbl{font-size:14px;color:var(--ivory);}
        .setsub{font-size:11px;color:var(--slate);margin-top:2px;}
        .stepper{display:flex;align-items:center;gap:10px;}
        .stepbtn{width:30px;height:30px;border-radius:7px;border:1px solid var(--steel);
          background:rgba(86,225,232,0.07);color:var(--ivory);cursor:pointer;font-size:16px;font-family:inherit;}
        .stepbtn:hover{border-color:var(--brass);background:rgba(86,225,232,0.14);}
        .stepval{font-family:'IBM Plex Mono',monospace;font-size:16px;width:34px;text-align:center;color:var(--brass);}
        .toggle{width:46px;height:26px;border-radius:13px;background:rgba(86,225,232,0.2);position:relative;cursor:pointer;border:none;}
        .toggle.on{background:var(--brass);}
        .toggle::after{content:'';position:absolute;top:3px;left:3px;width:20px;height:20px;border-radius:50%;
          background:var(--ivory);transition:.2s;}
        .toggle.on::after{left:23px;}
        .notes{width:100%;min-height:110px;background:rgba(2,18,70,0.65);border:1px solid var(--steel);
          color:var(--ivory);border-radius:10px;padding:14px;font-family:inherit;font-size:13px;resize:vertical;line-height:1.6;}
        .notes::placeholder{color:var(--slate);}
        .notes:focus{outline:none;border-color:var(--brass);}
        .danger{background:transparent;border:1px solid var(--crimson);color:var(--crimson);
          padding:9px 18px;border-radius:8px;cursor:pointer;font-size:13px;font-family:inherit;margin-top:8px;margin-right:10px;}
        .danger:hover{background:rgba(255,107,107,.12);}
        .quiet{background:transparent;border:1px solid var(--steel);color:var(--slate);
          padding:9px 18px;border-radius:8px;cursor:pointer;font-size:13px;font-family:inherit;margin-top:8px;}
        .quiet:hover{border-color:var(--brass);color:var(--brass);}
        .empty{padding:30px;text-align:center;color:var(--slate);font-size:13px;}
        .authmsg{font-size:12px;color:var(--slate);margin-top:10px;}

        /* programme */
        .phase-head{display:flex;align-items:center;gap:12px;flex-wrap:wrap;}
        .phase-chip{font-size:9px;font-family:'IBM Plex Mono',monospace;letter-spacing:.14em;
          padding:3px 9px;border-radius:10px;border:1px solid var(--steel);color:var(--slate);}
        .phase-chip.current{border-color:var(--brass);color:var(--brass);background:rgba(86,225,232,0.1);}
        .phase-chip.done{border-color:var(--jade);color:var(--jade);}
        .week{border-left:2px solid var(--steel);padding-left:14px;margin-top:18px;}
        .week.now{border-left-color:var(--brass);}
        .week-title{font-size:13px;font-weight:600;color:var(--ivory);}

        /* today */
        .today-grid{display:grid;grid-template-columns:minmax(340px,1.15fr) minmax(0,1fr);gap:32px;align-items:start;}
        .today-side .panel{margin-bottom:14px;}
        .drow{display:flex;align-items:center;gap:11px;padding:8px 0;border-bottom:1px solid rgba(86,225,232,0.07);}
        .drow:last-child{border-bottom:none;}

        /* shared bits */
        .proj{display:inline-flex;align-items:center;gap:5px;}
        .pdot{width:8px;height:8px;border-radius:50%;display:inline-block;flex-shrink:0;}
        .esttag{font-size:10px;font-family:'IBM Plex Mono',monospace;color:var(--slate);}
        .swatch{width:22px;height:22px;border-radius:50%;border:2px solid transparent;cursor:pointer;padding:0;}
        .swatch.on{border-color:var(--ivory);}
        .kbd{font-family:'IBM Plex Mono',monospace;font-size:11px;border:1px solid var(--steel);
          border-radius:4px;padding:1px 7px;color:var(--ivory);background:rgba(86,225,232,0.07);}
        .toast{position:fixed;bottom:26px;left:50%;transform:translateX(-50%);z-index:60;
          background:rgba(2,14,56,0.94);border:1px solid var(--steel);color:var(--ivory);
          padding:12px 18px;border-radius:11px;display:flex;gap:16px;align-items:center;font-size:13px;
          backdrop-filter:blur(14px);-webkit-backdrop-filter:blur(14px);box-shadow:0 10px 34px rgba(0,0,0,0.45);}
        .toast button{background:none;border:none;color:var(--brass);cursor:pointer;
          font-weight:600;font-size:13px;font-family:inherit;padding:0;}
        input[type="number"].inp::-webkit-inner-spin-button{opacity:1;}

        /* ---------- mobile ---------- */
        @media (max-width: 700px){
          .root{flex-direction:column;}
          .nav{position:fixed;bottom:0;left:0;right:0;width:100%;height:auto;flex-direction:row;
            justify-content:space-around;padding:6px 4px calc(6px + env(safe-area-inset-bottom));
            border-right:none;border-top:1px solid var(--steel);z-index:20;gap:0;}
          .logo{display:none;}
          .syncdot{display:none;}
          .navbtn{width:auto;flex:1;padding:7px 0;font-size:10px;gap:3px;}
          .navbtn .ic{font-size:17px;}
          .main{padding:22px 16px 100px;max-height:none;}
          .h1{font-size:23px;}
          .comp{width:calc(50% - 9px);}
          .stat{min-width:96px;padding:12px 14px;}
          .today-grid{grid-template-columns:1fr;gap:22px;}
          .toast{bottom:calc(76px + env(safe-area-inset-bottom));width:calc(100% - 32px);max-width:420px;}
        }
      `}</style>

      <nav className="nav" aria-label="Main navigation">
        <div className="logo">CAL</div>
        {NAV.map((n) => (
          <button key={n.id} className={`navbtn ${tab === n.id ? "on" : ""}`} onClick={() => setTab(n.id)} aria-current={tab === n.id ? "page" : undefined}>
            <span className="ic" aria-hidden="true">{n.icon}</span>{n.label}
          </button>
        ))}
        <div className="syncdot" style={{ background: SYNC.color }} title={SYNC.label} role="status" aria-label={SYNC.label} />
      </nav>

      <div className="main">
        {/* TODAY */}
        {tab === "today" && (
          <>
            <h1 className="h1">Today</h1>
            <p className="sub">{new Date().toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long" })} — {S.work} on, {S.break} to rest.</p>
            <div className="today-grid">
              <div>
                <Dial mode={timer.mode} secondsLeft={secondsLeft} total={total} running={timer.running}
                  cycle={timer.cycle} cycles={S.cycles}
                  taskLabel={data.tasks.find((x) => x.id === activeTask)?.label || null}
                  onToggle={toggleTimer} onReset={resetTimer} onSkip={skip} />
                <div className="focus-task">
                  {activeTask
                    ? <>Winding on <b>{data.tasks.find((x) => x.id === activeTask)?.label || "—"}</b> · <button className="laction" onClick={() => setActiveTask(null)}>clear</button></>
                    : <>No task pinned — pick one from the docket to track sessions against it.</>}
                </div>
                <div className="stat-row">
                  <div className="stat"><div className="num">{stats.todayMins}</div><div className="lbl">MIN TODAY</div></div>
                  <div className="stat"><div className="num">{data.completedSessions}</div><div className="lbl">SESSIONS</div></div>
                  <div className="stat"><div className="num">{Math.round(data.focusMinutesTotal / 60)}h</div><div className="lbl">ALL-TIME</div></div>
                </div>
              </div>
              <div className="today-side">
                <div className="panel" style={{ borderColor: "rgba(86,225,232,0.3)" }}>
                  <h3>Programme · {currentWeek ? currentWeek.title : currentPhase.title.split("—")[0].trim()}</h3>
                  {nextProgramItem ? (
                    <div className="drow">
                      <button className="tick" onClick={() => toggleProgramItem(nextProgramItem.id)}
                        role="checkbox" aria-checked={false} aria-label={`Marquer « ${nextProgramItem.label} »`} />
                      <div className="llabel" style={{ fontSize: 13, flex: 1 }}>{nextProgramItem.label}</div>
                      <button className="laction" onClick={() => setTab("program")}>tout voir</button>
                    </div>
                  ) : (
                    <div className="setsub">Phase bouclée ✦ — <button className="laction" style={{ padding: 0 }} onClick={() => setTab("program")}>voir la suite</button></div>
                  )}
                </div>
                <div className="panel">
                  <h3>On the docket</h3>
                  {docket.length === 0 && (
                    <div className="setsub">Nothing pressing — overdue, due-today, pinned and high-priority entries appear here.</div>
                  )}
                  {docket.slice(0, 8).map((tk) => {
                    const overdue = tk.due && tk.due < t;
                    return (
                      <div className="drow" key={tk.id}>
                        <button className={`tick ${tk.done ? "on" : ""}`} onClick={() => toggleTask(tk.id)}
                          role="checkbox" aria-checked={tk.done} aria-label={`Mark "${tk.label}" done`} />
                        <div className="lbody">
                          <div className="llabel" style={{ fontSize: 13 }}>{tk.label}</div>
                          <div className="lmeta">
                            <span className="proj"><span className="pdot" style={{ background: projColor(tk.project) }} />{tk.project}</span>
                            {tk.due && <span className={`duetag ${overdue ? "over" : ""}`}>{overdue ? "overdue" : "due today"}</span>}
                            {tk.est && <span className="esttag">◉ {sessCount[tk.id] || 0}/{tk.est}</span>}
                          </div>
                        </div>
                        {activeTask !== tk.id && <button className="laction" onClick={() => setActiveTask(tk.id)}>focus</button>}
                        {activeTask === tk.id && <span className="esttag" style={{ color: "var(--brass)" }}>pinned</span>}
                      </div>
                    );
                  })}
                  {docket.length > 8 && <div className="setsub" style={{ marginTop: 8 }}>+{docket.length - 8} more in the Manifest.</div>}
                </div>
                <div className="panel">
                  <h3>Habits</h3>
                  {data.habits.length === 0 && <div className="setsub">No habits yet — add them in the Habits tab.</div>}
                  {data.habits.map((h) => {
                    const doneToday = !!h.history[t];
                    return (
                      <div className="drow" key={h.id}>
                        <div className="lbody">
                          <span style={{ fontSize: 13 }}>{h.name}</span>
                          <span className="esttag" style={{ marginLeft: 8 }}>{calcStreak(h.history)}d streak</span>
                        </div>
                        <button className={`comp-btn ${doneToday ? "on" : ""}`} style={{ marginTop: 0, padding: "5px 12px" }}
                          onClick={() => toggleHabit(h.id)} aria-pressed={doneToday}>
                          {doneToday ? "✓" : "Mark"}
                        </button>
                      </div>
                    );
                  })}
                </div>
                <div className="panel">
                  <h3>Reserve</h3>
                  {todayLog ? (
                    <div className="setsub">
                      <b style={{ color: "var(--jade)", fontFamily: "'IBM Plex Mono',monospace" }}>{todayLog.hours}h</b>
                      {todayLog.bed && todayLog.wake && <> · {todayLog.bed} → {todayLog.wake}</>} · {stats.avgSleep.toFixed(1)}h average this week.
                    </div>
                  ) : (
                    <div className="composer" style={{ marginTop: 0 }}>
                      <input type="time" className="inp" style={{ flex: 1, minWidth: 96 }} aria-label="Bedtime"
                        value={bedInput} onChange={(e) => setBedInput(e.target.value)} />
                      <input type="time" className="inp" style={{ flex: 1, minWidth: 96 }} aria-label="Wake time"
                        value={wakeInput} onChange={(e) => setWakeInput(e.target.value)} onKeyDown={(e) => e.key === "Enter" && logSleep()} />
                      <button className="addbtn" onClick={logSleep}>Log</button>
                    </div>
                  )}
                </div>
              </div>
            </div>
          </>
        )}

        {/* PROGRAMME */}
        {tab === "program" && (
          <>
            <h1 className="h1">Programme</h1>
            <p className="sub">MPSI Janson de Sailly → MP✦ → l'X ou CentraleSupélec. Concours 2028.</p>

            <div className="cards" style={{ maxWidth: 720 }}>
              <div className="card"><div className="cn">{daysToEcrits}</div><div className="cl">JOURS AVANT LES ÉCRITS</div></div>
              <div className="card">
                <div className="cn">{PROGRAM.reduce((a, p) => a + phaseAllItems(p).filter((it) => data.programDone[it.id]).length, 0)}<span style={{ fontSize: 15, color: "var(--slate)" }}> / {PROGRAM.reduce((a, p) => a + phaseAllItems(p).length, 0)}</span></div>
                <div className="cl">JALONS FRANCHIS</div>
              </div>
              <div className="card">
                <div className="cn" style={{ fontSize: 16, lineHeight: 1.3, paddingTop: 6 }}>{currentPhase.title.split("—")[0].trim()}</div>
                <div className="cl">PHASE EN COURS</div>
              </div>
            </div>

            <div className="panel">
              <h3>Arsenal</h3>
              <div className="drow">
                <div className="lbody">
                  <div className="llabel" style={{ fontSize: 13 }}>Ellipses — Maths MPSI/MP2I, 6ᵉ édition (Prépas Sciences)</div>
                  <div className="setsub">Par chapitre : cours résumé → méthodes → Vrai/Faux → exos. Les « exos-minutes » chaque matin.</div>
                </div>
              </div>
              <div className="drow">
                <div className="lbody">
                  <div className="llabel" style={{ fontSize: 13 }}><a href={DRIVE_URL} target="_blank" rel="noreferrer" style={{ color: "var(--brass)" }}>Le Drive de prépa ↗</a></div>
                  <div className="setsub">Polys, DS et fiches — un dossier par chapitre, rangé le jour même.</div>
                </div>
              </div>
              <div className="drow">
                <div className="lbody">
                  <div className="llabel" style={{ fontSize: 13 }}>
                    <a href={POLY_LLG_URL} target="_blank" rel="noreferrer" style={{ color: "var(--brass)" }}>Poly de Louis-le-Grand ↗</a>
                    {" · "}
                    <a href={POLY_LLG_CORR_URL} target="_blank" rel="noreferrer" style={{ color: "var(--slate)" }}>corrigé ↗</a>
                  </div>
                  <div className="setsub">« Mathématiques : du lycée aux CPGE » (LLG & Henri-IV) — le travail de cet été, chaque exercice rédigé au propre. Le corrigé se consulte après avoir cherché, jamais avant.</div>
                </div>
              </div>
              <div className="drow">
                <div className="lbody">
                  <div className="llabel" style={{ fontSize: 13 }}><a href={QCM_URL} target="_blank" rel="noreferrer" style={{ color: "var(--brass)" }}>QCM d'auto-évaluation ↗</a></div>
                  <div className="setsub">Les modules QCM du prof — un module en fin de chapitre pour vérifier que le cours est vraiment su.</div>
                </div>
              </div>
              <div className="drow">
                <div className="lbody">
                  <div className="llabel" style={{ fontSize: 13 }}>Les 3 œuvres du programme de français-philo</div>
                  <div className="setsub">Lecture active : crayon en main, carnet de citations classées par thème, fiche de synthèse par œuvre. Une œuvre ≈ 2 semaines.</div>
                </div>
              </div>
              <div className="drow">
                <div className="lbody">
                  <div className="llabel" style={{ fontSize: 13 }}>Physique — cours de terminale & annales</div>
                  <div className="setsub">Tes cours de l'année + sujets de bac (dans le Drive) : refichage par thème, puis exos en temps limité. Les débuts MPSI (oscillateur, circuits, optique) en découverte fin août.</div>
                </div>
              </div>
              <button className="quiet" onClick={adoptRhythm}>Adopter le rythme prépa (projets + habitudes)</button>
            </div>

            {PROGRAM.map((p) => {
              const st = phaseStatus(p);
              const done = phaseAllItems(p).filter((it) => data.programDone[it.id]).length;
              const totalItems = phaseAllItems(p).length;
              return (
                <div className="panel" key={p.id} style={{ opacity: st === "done" ? 0.65 : 1, borderColor: st === "current" ? "rgba(86,225,232,0.45)" : undefined }}>
                  <div className="phase-head">
                    <h3 style={{ margin: 0 }}>{p.title}</h3>
                    <span className={`phase-chip ${st}`}>{st === "done" ? "FAIT" : st === "current" ? "EN COURS" : "À VENIR"}</span>
                    <span className="esttag" style={{ marginLeft: "auto" }}>{done}/{totalItems}</span>
                  </div>
                  <div className="setsub" style={{ margin: "6px 0 12px" }}>
                    {p.period.map((ds) => {
                      const [y, m, d] = ds.split("-").map(Number);
                      return new Date(y, m - 1, d).toLocaleDateString("fr-FR", { month: "short", year: "numeric" });
                    }).join(" → ")} · {p.focus}
                  </div>
                  {p.items.map((it) => {
                    const isDone = !!data.programDone[it.id];
                    return (
                      <div className="drow" key={it.id}>
                        <button className={`tick ${isDone ? "on" : ""}`} onClick={() => toggleProgramItem(it.id)}
                          role="checkbox" aria-checked={isDone} aria-label={`Marquer « ${it.label} »`}>
                          {isDone ? "✓" : ""}
                        </button>
                        <div className={`llabel ${isDone ? "done" : ""}`} style={{ fontSize: 13, flex: 1 }}>{it.label}</div>
                      </div>
                    );
                  })}
                  {p.weeks?.map((w) => {
                    const wDone = w.items.filter((it) => data.programDone[it.id]).length;
                    const isNow = t >= w.period[0] && t <= w.period[1];
                    const isPast = t > w.period[1];
                    return (
                      <div className={`week ${isNow ? "now" : ""}`} key={w.id}
                        style={{ opacity: isPast && wDone === w.items.length ? 0.6 : 1 }}>
                        <div className="phase-head" style={{ marginBottom: 2 }}>
                          <span className="week-title">{w.title}</span>
                          <span className="esttag">{fmtDue(w.period[0])} → {fmtDue(w.period[1])}</span>
                          {isNow && <span className="phase-chip current">CETTE SEMAINE</span>}
                          <span className="esttag" style={{ marginLeft: "auto" }}>{wDone}/{w.items.length}</span>
                        </div>
                        {w.items.map((it) => {
                          const isDone = !!data.programDone[it.id];
                          return (
                            <div className="drow" key={it.id}>
                              <button className={`tick ${isDone ? "on" : ""}`} onClick={() => toggleProgramItem(it.id)}
                                role="checkbox" aria-checked={isDone} aria-label={`Marquer « ${it.label} »`}>
                                {isDone ? "✓" : ""}
                              </button>
                              <div className={`llabel ${isDone ? "done" : ""}`} style={{ fontSize: 13, flex: 1 }}>{it.label}</div>
                            </div>
                          );
                        })}
                      </div>
                    );
                  })}
                </div>
              );
            })}
          </>
        )}

        {/* TASKS */}
        {tab === "tasks" && (
          <>
            <h1 className="h1">Manifest</h1>
            <p className="sub">{stats.doneAll} of {data.tasks.length} entries cleared · {stats.clearedToday} today.</p>
            <div className="toolbar" role="group" aria-label="Filter tasks">
              {["all", "active", "done", ...data.projects.map((p) => p.name)].map((f) => (
                <button key={f} className={`chip ${filter === f ? "on" : ""}`} onClick={() => setFilter(f)} aria-pressed={filter === f}>
                  {f === "all" ? "All" : f === "active" ? "Active" : f === "done" ? "Cleared" : f}
                </button>
              ))}
            </div>
            <div className="ledger">
              {sorted.length === 0 && <div className="empty">Nothing here. Add an entry below.</div>}
              {sorted.map((tk) => {
                const overdue = tk.due && !tk.done && tk.due < t;
                if (editingId === tk.id) {
                  return (
                    <div className="lrow" key={tk.id}>
                      <div className="lbody">
                        <div className="composer" style={{ marginTop: 0 }}>
                          <input className="inp" style={{ flex: 1, minWidth: 150 }} value={edit.label} autoFocus aria-label="Task label"
                            onChange={(e) => setEdit({ ...edit, label: e.target.value })}
                            onKeyDown={(e) => { if (e.key === "Enter") saveEdit(); if (e.key === "Escape") setEditingId(null); }} />
                          <select className="inp" value={edit.priority} onChange={(e) => setEdit({ ...edit, priority: e.target.value })} aria-label="Priority">
                            <option value="high">High</option><option value="med">Med</option><option value="low">Low</option>
                          </select>
                          <select className="inp" value={edit.project} onChange={(e) => setEdit({ ...edit, project: e.target.value })} aria-label="Project">
                            {!data.projects.some((p) => p.name === edit.project) && <option value={edit.project}>{edit.project || "—"}</option>}
                            {data.projects.map((p) => <option key={p.name}>{p.name}</option>)}
                          </select>
                          <input type="date" className="inp" value={edit.due} onChange={(e) => setEdit({ ...edit, due: e.target.value })} aria-label="Due date" />
                          <input className="inp" style={{ width: 76 }} type="number" min="1" max="20" placeholder="Est ◉" aria-label="Estimated sessions"
                            value={edit.est} onChange={(e) => setEdit({ ...edit, est: e.target.value })} />
                        </div>
                      </div>
                      <button className="laction" onClick={saveEdit}>save</button>
                      <button className="laction" onClick={() => setEditingId(null)}>cancel</button>
                    </div>
                  );
                }
                return (
                  <div className="lrow" key={tk.id}>
                    <button className={`tick ${tk.done ? "on" : ""}`} onClick={() => toggleTask(tk.id)}
                      role="checkbox" aria-checked={tk.done} aria-label={`Mark "${tk.label}" ${tk.done ? "not done" : "done"}`}>
                      {tk.done ? "✓" : ""}
                    </button>
                    <div className="lbody">
                      <div className={`llabel ${tk.done ? "done" : ""}`}>{tk.label}</div>
                      <div className="lmeta">
                        <span className="badge" style={{ background: PRIORITY[tk.priority].color + "22", color: PRIORITY[tk.priority].color }}>{PRIORITY[tk.priority].label}</span>
                        <span className="proj"><span className="pdot" style={{ background: projColor(tk.project) }} />{tk.project}</span>
                        {tk.due && <span className={`duetag ${overdue ? "over" : ""}`}>{overdue ? "overdue · " : "due "}{fmtDue(tk.due)}</span>}
                        {(tk.est || sessCount[tk.id]) && <span className="esttag">◉ {sessCount[tk.id] || 0}{tk.est ? `/${tk.est}` : ""}</span>}
                      </div>
                    </div>
                    {!tk.done && <button className="laction" onClick={() => setActiveFocus(tk.id)}>focus</button>}
                    <button className="laction" onClick={() => startEdit(tk)} aria-label={`Edit "${tk.label}"`}>edit</button>
                    <button className="laction del" onClick={() => delTask(tk.id)} aria-label={`Remove "${tk.label}"`}>remove</button>
                  </div>
                );
              })}
            </div>
            <div className="composer">
              <input id="new-task-input" className="inp" style={{ flex: 1, minWidth: 180 }} placeholder="New entry…" aria-label="New task" value={newTask}
                onChange={(e) => setNewTask(e.target.value)} onKeyDown={(e) => e.key === "Enter" && addTask()} />
              <select className="inp" value={newPriority} onChange={(e) => setNewPriority(e.target.value)} aria-label="Priority">
                <option value="high">High</option><option value="med">Med</option><option value="low">Low</option>
              </select>
              <select className="inp" value={newProject || data.projects[0]?.name || ""} onChange={(e) => setNewProject(e.target.value)} aria-label="Project">
                {data.projects.map((p) => <option key={p.name}>{p.name}</option>)}
              </select>
              <input type="date" className="inp" value={newDue} onChange={(e) => setNewDue(e.target.value)} aria-label="Due date (optional)" />
              <input className="inp" style={{ width: 76 }} type="number" min="1" max="20" placeholder="Est ◉" aria-label="Estimated sessions (optional)"
                value={newEst} onChange={(e) => setNewEst(e.target.value)} />
              <button className="addbtn" onClick={addTask}>Add</button>
            </div>
          </>
        )}

        {/* HABITS */}
        {tab === "habits" && (
          <>
            <h1 className="h1">Habits</h1>
            <p className="sub">Sub-dials — small mechanisms, kept running. Last 6 days shown as dots.</p>
            <div className="comps">
              {data.habits.length === 0 && <div className="empty" style={{ width: "100%" }}>No habits yet. Add one below.</div>}
              {data.habits.map((h) => {
                const doneToday = !!h.history[t];
                const streak = calcStreak(h.history);
                const days = [];
                for (let i = 5; i >= 1; i--) days.push(!!h.history[dateStr(Date.now() - i * DAY)]);
                return (
                  <div key={h.id} className={`comp ${doneToday ? "on" : ""}`}>
                    <button className="comp-del" onClick={() => delHabit(h.id)} aria-label={`Delete habit "${h.name}"`}>×</button>
                    <div className="comp-name">{h.name}</div>
                    <div><span className="comp-streak">{streak}</span> <span className="comp-unit">DAY STREAK</span></div>
                    <div className="comp-best">Best: {Math.max(h.best || 0, streak)} days</div>
                    <div className="dots" aria-hidden="true">{days.map((d, i) => <div key={i} className={`dot ${d ? "f" : ""}`} />)}</div>
                    <button className={`comp-btn ${doneToday ? "on" : ""}`} onClick={() => toggleHabit(h.id)} aria-pressed={doneToday}>
                      {doneToday ? "✓ Done today" : "Mark today"}
                    </button>
                  </div>
                );
              })}
            </div>
            <div className="composer">
              <input className="inp" style={{ flex: 1, minWidth: 180 }} placeholder="New habit…" aria-label="New habit" value={newHabit}
                onChange={(e) => setNewHabit(e.target.value)} onKeyDown={(e) => e.key === "Enter" && addHabit()} />
              <button className="addbtn" onClick={addHabit}>Add</button>
            </div>
            <YearHeatmap habits={data.habits} />
          </>
        )}

        {/* RESERVE */}
        {tab === "reserve" && (
          <>
            <h1 className="h1">Reserve</h1>
            <p className="sub">Sleep, read like a power reserve — the energy left to run on.</p>
            <ReserveGauge avg={stats.avgSleep} target={targetHours} />
            <div className="weekbars" style={{ position: "relative" }}>
              <div className="target-line" style={{ bottom: `${Math.min((targetHours / 9) * 100, 100)}%` }} aria-hidden="true" />
              {stats.last7.map((d, i) => (
                <div className="wb" key={i}>
                  {d.sleep > 0 && <div className="wbv">{d.sleep}</div>}
                  <div className="wbf" style={{ height: `${Math.min((d.sleep / 9) * 100, 100)}%` }} />
                  <div className="wbl">{["S", "M", "T", "W", "T", "F", "S"][new Date(d.ds + "T12:00:00").getDay()]}</div>
                </div>
              ))}
            </div>

            <div className="panel" style={{ maxWidth: 480, margin: "40px auto 0" }}>
              <h3>Last night</h3>
              {todayLog && !editingSleep ? (
                <>
                  <div className="setlbl">
                    {todayLog.bed || "—"} <span style={{ color: "var(--slate)" }}>→</span> {todayLog.wake || "—"}
                    {" · "}<b style={{ color: "var(--jade)", fontFamily: "'IBM Plex Mono',monospace" }}>{todayLog.hours}h</b>
                  </div>
                  {bedDelta != null && (
                    <div className="setsub" style={{ marginTop: 6, color: Math.abs(bedDelta) <= 15 ? "var(--jade)" : "var(--crimson)" }}>
                      Bedtime {fmtDelta(bedDelta)}
                    </div>
                  )}
                  <button className="quiet" onClick={() => { setBedInput(todayLog.bed || ""); setWakeInput(todayLog.wake || ""); setEditingSleep(true); }}>
                    Edit
                  </button>
                </>
              ) : (
                <>
                  <div className="composer" style={{ marginTop: 0 }}>
                    <input type="time" className="inp" aria-label="Bedtime" value={bedInput} onChange={(e) => setBedInput(e.target.value)} />
                    <input type="time" className="inp" aria-label="Wake time" value={wakeInput} onChange={(e) => setWakeInput(e.target.value)}
                      onKeyDown={(e) => e.key === "Enter" && logSleep()} />
                    <button className="addbtn" onClick={logSleep}>{todayLog ? "Update" : "Log night"}</button>
                    {editingSleep && <button className="laction" onClick={() => { setEditingSleep(false); setBedInput(""); setWakeInput(""); }}>cancel</button>}
                  </div>
                  {bedInput && wakeInput && (() => {
                    const preview = sleepHours(bedInput, wakeInput);
                    const suspicious = preview > 16;
                    return (
                      <div className="setsub" style={{ marginTop: 8, color: suspicious ? "var(--crimson)" : undefined }}>
                        {preview}h of sleep{suspicious ? " — check the times, that seems too long to log" : ""}
                      </div>
                    );
                  })()}
                </>
              )}
            </div>

            <div className="panel" style={{ maxWidth: 480, margin: "14px auto 0" }}>
              <h3>Target schedule</h3>
              <div className="setrow">
                <div><div className="setlbl">Bedtime</div><div className="setsub">Aim to be asleep by</div></div>
                <input type="time" className="inp" value={S.targetBed} onChange={(e) => setS({ targetBed: e.target.value })} aria-label="Target bedtime" />
              </div>
              <div className="setrow">
                <div><div className="setlbl">Wake time</div><div className="setsub">Aim to be up by</div></div>
                <input type="time" className="inp" value={S.targetWake} onChange={(e) => setS({ targetWake: e.target.value })} aria-label="Target wake time" />
              </div>
              <div className="setsub" style={{ marginTop: 8 }}>Target reserve: {targetHours.toFixed(1)}h a night</div>
            </div>
          </>
        )}

        {/* INSIGHTS */}
        {tab === "insights" && (
          <>
            <h1 className="h1">Insights</h1>
            <p className="sub">The week at a glance — where the movement is running true.</p>
            <div className="toolbar" role="group" aria-label="Insights time range" style={{ marginBottom: 20 }}>
              {[7, 30, 90].map((d) => (
                <button key={d} className={`chip ${insightRange === d ? "on" : ""}`} onClick={() => setInsightRange(d)} aria-pressed={insightRange === d}>
                  {d}D
                </button>
              ))}
            </div>
            <div className="cards">
              <div className="card"><div className="cn">{stats.todayMins}</div><div className="cl">FOCUS MIN TODAY</div></div>
              <div className="card"><div className="cn">{rangeStats.avgSleep.toFixed(1)}h</div><div className="cl">AVG SLEEP / {insightRange}D</div></div>
              {(() => {
                const band = consistencyBand(rangeStats.consistency);
                return (
                  <div className="card">
                    <div className="cn">{rangeStats.consistency ?? "—"}</div>
                    <div className="cl">SLEEP CONSISTENCY</div>
                    <div style={{ fontSize: 10, marginTop: 3, color: band.color }}>{band.label}</div>
                  </div>
                );
              })()}
              <div className="card"><div className="cn">{stats.bestStreak}</div><div className="cl">TOP STREAK</div></div>
              <div className="card"><div className="cn">{stats.clearedToday}</div><div className="cl">CLEARED TODAY</div></div>
            </div>

            <div className="panel">
              <h3>Focus minutes — last {insightRange} days</h3>
              {insightRange <= 7 ? (
                <div className="barchart">
                  {rangeStats.series.map((d, i) => {
                    const max = Math.max(...rangeStats.series.map((x) => x.mins), 25);
                    return (
                      <div className="bc" key={i}>
                        <div className="bcv">{d.mins || ""}</div>
                        <div className="bcbar" style={{ height: `${(d.mins / max) * 100}%` }} />
                        <div className="bcl">{["S", "M", "T", "W", "T", "F", "S"][new Date(d.ds + "T12:00:00").getDay()]}</div>
                      </div>
                    );
                  })}
                </div>
              ) : (
                <>
                  <Spark points={rangeStats.series.map((d) => d.mins)} color="var(--brass)" width={600} height={90} responsive />
                  <div style={{ display: "flex", justifyContent: "space-between", fontSize: 10, color: "var(--slate)", marginTop: 8 }}>
                    <span>{fmtDue(rangeStats.series[0].ds)}</span>
                    <span>avg {rangeStats.avgMins} min/day</span>
                    <span>{fmtDue(rangeStats.series[rangeStats.series.length - 1].ds)}</span>
                  </div>
                </>
              )}
            </div>

            <div className="panel">
              <h3>Focus by project — last {insightRange} days</h3>
              {rangeStats.projectRows.length === 0 && <div className="empty" style={{ padding: "12px 0" }}>No sessions recorded in this window yet.</div>}
              {rangeStats.projectRows.map(([p, mins]) => {
                const max = rangeStats.projectRows[0][1];
                return (
                  <div className="prow" key={p}>
                    <div className="plbl">{p}</div>
                    <div className="ptrack"><div className="pfill" style={{ width: `${(mins / max) * 100}%` }} /></div>
                    <div className="pval">{mins} min</div>
                  </div>
                );
              })}
            </div>

            <div className="panel">
              <h3>Sleep vs focus — do they track?</h3>
              <div style={{ display: "flex", gap: 24, alignItems: "center", flexWrap: "wrap" }}>
                <div style={{ flex: 1, minWidth: 200 }}>
                  <div style={{ fontSize: 11, color: "var(--slate)", marginBottom: 6 }}>Sleep (hrs)</div>
                  <Spark points={rangeStats.series.map((d) => d.sleep)} color="var(--jade)" max={9} width={insightRange <= 7 ? 240 : 500} height={50} responsive={insightRange > 7} />
                </div>
                <div style={{ flex: 1, minWidth: 200 }}>
                  <div style={{ fontSize: 11, color: "var(--slate)", marginBottom: 6 }}>Focus (min)</div>
                  <Spark points={rangeStats.series.map((d) => d.mins)} color="var(--brass)" width={insightRange <= 7 ? 240 : 500} height={50} responsive={insightRange > 7} />
                </div>
              </div>
            </div>

            <div className="panel">
              <h3>Sleep vs next-day focus</h3>
              {rangeStats.corr.n >= 3 ? (
                <div style={{ display: "flex", gap: 24, alignItems: "flex-start", flexWrap: "wrap" }}>
                  <div>
                    <Scatter points={rangeStats.corr.pairs} />
                    <div style={{ display: "flex", justifyContent: "space-between", fontSize: 10, color: "var(--slate)", marginTop: 4, width: 300 }}>
                      <span>Sleep (hrs) →</span><span>↑ Next-day focus (min)</span>
                    </div>
                  </div>
                  <div style={{ flex: 1, minWidth: 180 }}>
                    <div className="setsub">Each point is one night's sleep against the focus minutes logged the next day ({rangeStats.corr.n} nights compared).</div>
                    <div className="setlbl" style={{ marginTop: 10, fontSize: 13 }}>{corrLabel(rangeStats.corr.r)}</div>
                  </div>
                </div>
              ) : (
                <div className="empty" style={{ padding: "12px 0" }}>Log a few more nights of sleep to see whether it tracks with your focus the next day.</div>
              )}
            </div>
          </>
        )}

        {/* REGULATOR */}
        {tab === "regulator" && (
          <>
            <h1 className="h1">Regulator</h1>
            <p className="sub">Fine-tune the movement. Adjust intervals, sound, sync, and keep working notes.</p>
            <div className="panel">
              {[
                { k: "work", lbl: "Session length", sub: "Deep-focus interval", min: 5, max: 90, step: 5 },
                { k: "break", lbl: "Short rest", sub: "Between sessions", min: 1, max: 30, step: 1 },
                { k: "longBreak", lbl: "Long rest", sub: "After a full cycle", min: 5, max: 45, step: 5 },
                { k: "cycles", lbl: "Cycle length", sub: "Sessions before a long rest", min: 2, max: 8, step: 1 },
              ].map((r) => (
                <div className="setrow" key={r.k}>
                  <div><div className="setlbl">{r.lbl}</div><div className="setsub">{r.sub}</div></div>
                  <div className="stepper">
                    <button className="stepbtn" onClick={() => setS({ [r.k]: Math.max(r.min, S[r.k] - r.step) })} aria-label={`Decrease ${r.lbl}`}>−</button>
                    <span className="stepval">{S[r.k]}</span>
                    <button className="stepbtn" onClick={() => setS({ [r.k]: Math.min(r.max, S[r.k] + r.step) })} aria-label={`Increase ${r.lbl}`}>+</button>
                  </div>
                </div>
              ))}
              <div className="setrow">
                <div><div className="setlbl">Chime on completion</div><div className="setsub">Soft three-note signal</div></div>
                <button className={`toggle ${S.sound ? "on" : ""}`} onClick={() => setS({ sound: !S.sound })}
                  role="switch" aria-checked={S.sound} aria-label="Chime on completion" />
              </div>
              <div className="setrow">
                <div>
                  <div className="setlbl">Reminders</div>
                  <div className="setsub">Wind-down 30 min before target bedtime · due-entry nudge in the morning. Works while the app is open.</div>
                </div>
                <button className={`toggle ${S.reminders ? "on" : ""}`} onClick={toggleReminders}
                  role="switch" aria-checked={S.reminders} aria-label="Reminders" />
              </div>
            </div>

            <div className="panel">
              <h3>Cloud sync</h3>
              {!supabase && (
                <div className="setsub">Not configured — data lives in this browser only. Add Supabase keys to enable sync.</div>
              )}
              {supabase && session && (
                <>
                  <div className="setlbl" style={{ fontSize: 13 }}>
                    Signed in as <b>{session.user.email}</b>
                  </div>
                  <div className="setsub" style={{ marginTop: 4 }}>
                    <span style={{ color: SYNC.color }}>●</span> {SYNC.label}
                  </div>
                  <button className="quiet" onClick={signOut}>Sign out</button>
                </>
              )}
              {supabase && !session && (
                <>
                  <div className="setsub" style={{ marginBottom: 10 }}>
                    Sign in to sync across devices. Until then, data stays in this browser only.
                  </div>
                  <div className="composer" style={{ marginTop: 0 }}>
                    <input className="inp" type="email" style={{ flex: 1, minWidth: 200 }} placeholder="you@example.com"
                      aria-label="Email for sign-in link" value={email}
                      onChange={(e) => setEmail(e.target.value)} onKeyDown={(e) => e.key === "Enter" && sendLink()} />
                    <button className="addbtn" onClick={sendLink}>Send sign-in link</button>
                  </div>
                  {authMsg && <div className="authmsg">{authMsg}</div>}
                </>
              )}
            </div>

            <div className="panel">
              <h3>Projects</h3>
              {data.projects.map((p) => (
                <div className="setrow" key={p.name}>
                  <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                    <span className="pdot" style={{ background: p.color, width: 11, height: 11 }} />
                    <span className="setlbl">{p.name}</span>
                  </div>
                  <button className="laction del" onClick={() => delProject(p.name)} aria-label={`Remove project "${p.name}"`}>remove</button>
                </div>
              ))}
              <div className="composer">
                <input className="inp" style={{ flex: 1, minWidth: 140 }} placeholder="New project…" aria-label="New project name"
                  value={newProjName} onChange={(e) => setNewProjName(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && addProject()} />
                <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                  {PROJECT_COLORS.map((c) => (
                    <button key={c} className={`swatch ${newProjColor === c ? "on" : ""}`} style={{ background: c }}
                      onClick={() => setNewProjColor(c)} aria-label={`Colour ${c}`} aria-pressed={newProjColor === c} />
                  ))}
                </div>
                <button className="addbtn" onClick={addProject}>Add</button>
              </div>
            </div>

            <div className="panel">
              <h3>Backup</h3>
              <div className="setsub" style={{ marginBottom: 4 }}>
                Download everything as a JSON file, or restore from a previous export.
              </div>
              <button className="quiet" onClick={exportData}>Export data</button>
              <button className="quiet" style={{ marginLeft: 10 }} onClick={() => importRef.current?.click()}>Import backup…</button>
              <input ref={importRef} type="file" accept="application/json,.json" style={{ display: "none" }}
                onChange={(e) => { importData(e.target.files?.[0]); e.target.value = ""; }} />
            </div>

            <div className="panel">
              <h3>Shortcuts</h3>
              <div className="setsub">
                <span className="kbd">Space</span> wind / pause · <span className="kbd">1–7</span> switch tabs · <span className="kbd">N</span> new entry
              </div>
            </div>

            <div className="panel">
              <h3>Working notes</h3>
              <textarea className="notes" placeholder="Scratchpad — thoughts, reminders, anything worth keeping…"
                aria-label="Working notes" value={data.notes} onChange={(e) => saveNotes(e.target.value)} />
            </div>

            <button className="danger" onClick={() => { if (confirm("Reset all Calibre data? This clears every task, habit, session and note. It cannot be undone.")) save(emptyData()); }}>
              Reset all data
            </button>
            <button className="quiet" onClick={() => { if (data.tasks.length === 0 || confirm("Replace current data with sample data?")) save(demoData()); }}>
              Load sample data
            </button>
          </>
        )}
      </div>

      {toast && (
        <div className="toast" role="status">
          <span>{toast.msg}</span>
          <button onClick={undoNow}>Undo</button>
        </div>
      )}
    </div>
  );
}

/* ============ Reserve gauge ============ */
function ReserveGauge({ avg, target }) {
  const pct = Math.min(avg / 9, 1);
  const r = 82, cx = 110, cy = 110;
  const start = -220, sweep = 260;
  const toXY = (deg) => [cx + r * Math.cos((deg * Math.PI) / 180), cy + r * Math.sin((deg * Math.PI) / 180)];
  const [sx, sy] = toXY(start);
  const [ex, ey] = toXY(start + sweep);
  const [fx, fy] = toXY(start + sweep * pct);
  const large = sweep * pct > 180 ? 1 : 0;
  const ticks = [];
  for (let i = 0; i <= 9; i++) {
    const deg = start + (sweep * i) / 9;
    const [x1, y1] = [cx + (r + 4) * Math.cos((deg * Math.PI) / 180), cy + (r + 4) * Math.sin((deg * Math.PI) / 180)];
    const [x2, y2] = [cx + (r + 12) * Math.cos((deg * Math.PI) / 180), cy + (r + 12) * Math.sin((deg * Math.PI) / 180)];
    ticks.push(<line key={i} x1={x1} y1={y1} x2={x2} y2={y2} stroke="var(--steel)" strokeWidth="1.5" />);
  }
  const targetPct = target != null ? Math.min(target / 9, 1) : null;
  let targetMark = null;
  if (targetPct != null) {
    const deg = start + sweep * targetPct;
    const [x1, y1] = [cx + (r - 7) * Math.cos((deg * Math.PI) / 180), cy + (r - 7) * Math.sin((deg * Math.PI) / 180)];
    const [x2, y2] = [cx + (r + 7) * Math.cos((deg * Math.PI) / 180), cy + (r + 7) * Math.sin((deg * Math.PI) / 180)];
    targetMark = <line x1={x1} y1={y1} x2={x2} y2={y2} stroke="var(--jade)" strokeWidth="3" strokeLinecap="round" />;
  }
  return (
    <div className="gauge-wrap">
      <svg viewBox="0 0 220 200" width="300" height="270" style={{ maxWidth: "80vw" }} role="img" aria-label={`Average sleep over 7 days: ${avg.toFixed(1)} hours, target ${target?.toFixed(1)} hours`}>
        {ticks}
        <path d={`M ${sx} ${sy} A ${r} ${r} 0 1 1 ${ex} ${ey}`} fill="none" stroke="var(--steel)" strokeWidth="11" strokeLinecap="round" />
        {pct > 0 && <path d={`M ${sx} ${sy} A ${r} ${r} 0 ${large} 1 ${fx} ${fy}`} fill="none" stroke="var(--brass)" strokeWidth="11" strokeLinecap="round" />}
        {targetMark}
        <text x={cx} y={cy - 4} textAnchor="middle" style={{ fontFamily: "'IBM Plex Mono',monospace", fontSize: 26, fill: "var(--ivory)" }}>{avg.toFixed(1)}h</text>
        <text x={cx} y={cy + 18} textAnchor="middle" style={{ fontSize: 10, fill: "var(--slate)", letterSpacing: ".08em" }}>AVG RESERVE / 7D</text>
      </svg>
    </div>
  );
}
