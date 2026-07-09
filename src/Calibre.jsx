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
const DAY = 86400000;

/* Local calendar date (Europe/Paris etc.) — NOT UTC.
   'sv-SE' locale formats as YYYY-MM-DD. */
const dateStr = (ms) => new Date(ms).toLocaleDateString("sv-SE");
const todayStr = () => dateStr(Date.now());

const DEFAULT_SETTINGS = { work: 25, break: 5, longBreak: 15, cycles: 4, sound: true };

const emptyData = () => ({
  tasks: [],
  habits: [],
  sleepLog: {}, // date -> hours
  sessions: [], // {date, mode, minutes, taskId, project}
  completedSessions: 0,
  focusMinutesTotal: 0,
  settings: { ...DEFAULT_SETTINGS },
  notes: "",
});

/* Optional sample content — only loaded on demand from the Regulator tab. */
function demoData() {
  const d = emptyData();
  const now = Date.now();
  d.tasks = [
    { id: "t1", label: "Reply to marketplace authentication query", done: false, priority: "high", project: "Resale", due: todayStr(), created: now },
    { id: "t2", label: "Photograph new piece for listing", done: false, priority: "med", project: "Studio", due: null, created: now },
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
  const hrs = [7.5, 6, 8, 7, 6.5, 7.5, 8];
  for (let i = 6; i >= 0; i--) d.sleepLog[dateStr(now - i * DAY)] = hrs[6 - i];
  return d;
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
        if (raw) local = JSON.parse(raw);
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
            setData(row.data);
            latest.current = row.data;
            localStorage.setItem(KEY, JSON.stringify(row.data));
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
          const next = JSON.parse(e.newValue);
          latest.current = next;
          setData(next);
        } catch { /* ignore */ }
      }
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

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
const PROJECTS = ["Resale", "Studio", "Admin", "Teaching", "Personal"];
const fmtDue = (ds) => {
  const [y, m, d] = ds.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString("en-GB", { day: "numeric", month: "short" });
};

/* ======================= DIAL ======================= */
function Dial({ mode, secondsLeft, total, running, onToggle, onReset, onSkip }) {
  const pct = total ? 1 - secondsLeft / total : 0;
  const angle = pct * 360;
  const cx = 130, cy = 130, R = 108;
  const hx = cx + R * Math.sin((angle * Math.PI) / 180);
  const hy = cy - R * Math.cos((angle * Math.PI) / 180);
  const large = angle > 180 ? 1 : 0;
  const arc = angle > 0.1 ? `M ${cx} ${cy - R} A ${R} ${R} 0 ${large} 1 ${hx} ${hy}` : "";
  const mm = String(Math.floor(secondsLeft / 60)).padStart(2, "0");
  const ss = String(secondsLeft % 60).padStart(2, "0");
  const accent = mode === "work" ? "var(--crimson)" : "var(--jade)";

  const ticks = [];
  for (let i = 0; i < 60; i++) {
    const a = (i * 6 * Math.PI) / 180;
    const major = i % 5 === 0;
    const rO = 118, rI = major ? 106 : 112;
    ticks.push(
      <line key={i}
        x1={cx + rO * Math.sin(a)} y1={cy - rO * Math.cos(a)}
        x2={cx + rI * Math.sin(a)} y2={cy - rI * Math.cos(a)}
        stroke={major ? "var(--brass)" : "var(--steel)"}
        strokeWidth={major ? 2 : 1} opacity={major ? 0.85 : 0.5} />
    );
  }
  const label = mode === "work" ? "SESSION" : mode === "break" ? "SHORT REST" : "LONG REST";

  return (
    <div className="dial">
      <svg viewBox="0 0 260 260" className="dial-svg" role="timer" aria-label={`${label}: ${mm} minutes ${ss} seconds remaining`}>
        <circle cx={cx} cy={cy} r="127" fill="var(--anthracite)" stroke="var(--steel)" strokeWidth="1.5" />
        <circle cx={cx} cy={cy} r="118" fill="none" stroke="var(--steel)" strokeWidth="0.5" opacity="0.5" />
        {ticks}
        {arc && <path d={arc} fill="none" stroke={accent} strokeWidth="3.5" strokeLinecap="round" opacity="0.9" />}
        <line x1={cx} y1={cy} x2={hx} y2={hy} stroke="var(--brass)" strokeWidth="2.5" strokeLinecap="round" />
        <circle cx={cx} cy={cy} r="4.5" fill="var(--brass)" />
        <text x={cx} y={cy - 34} textAnchor="middle" className="dial-cap">{label}</text>
        <text x={cx} y={cy + 8} textAnchor="middle" className="dial-time">{mm}:{ss}</text>
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
function Spark({ points, color = "var(--brass)", max, height = 40, width = 200 }) {
  if (!points.length) return null;
  const hi = max || Math.max(...points, 1);
  const step = width / Math.max(points.length - 1, 1);
  const d = points.map((p, i) => `${i === 0 ? "M" : "L"} ${(i * step).toFixed(1)} ${(height - (p / hi) * height).toFixed(1)}`).join(" ");
  return (
    <svg viewBox={`0 0 ${width} ${height}`} width={width} height={height} preserveAspectRatio="none" aria-hidden="true">
      <path d={d} fill="none" stroke={color} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}

/* ================= App ================= */
export default function Calibre() {
  const { data, save, session, syncState } = useStore();
  const [tab, setTab] = useState("focus");

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

  function toggleTimer() {
    if (timer.running) {
      setTimer((t) => ({ ...t, running: false, endAt: null, remaining: secondsLeft }));
    } else {
      if ("Notification" in window && Notification.permission === "default") {
        Notification.requestPermission().catch(() => {});
      }
      setTimer((t) => ({ ...t, running: true, endAt: Date.now() + secondsLeft * 1000, remaining: null }));
    }
  }
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
  const [newProject, setNewProject] = useState("Resale");
  const [newDue, setNewDue] = useState("");
  const [filter, setFilter] = useState("all");
  const [sleepInput, setSleepInput] = useState("");
  const [newHabit, setNewHabit] = useState("");

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
    save({ ...data, tasks: [...data.tasks, { id: "t" + Date.now(), label: newTask.trim(), done: false, priority: newPriority, project: newProject, due: newDue || null, created: Date.now() }] });
    setNewTask(""); setNewDue("");
  }
  function toggleTask(id) {
    save({ ...data, tasks: data.tasks.map((t) => t.id === id ? { ...t, done: !t.done, doneAt: !t.done ? Date.now() : null } : t) });
  }
  function delTask(id) {
    const tk = data.tasks.find((t) => t.id === id);
    if (!confirm(`Remove "${tk?.label}"? This cannot be undone.`)) return;
    if (activeTask === id) setActiveTask(null);
    save({ ...data, tasks: data.tasks.filter((t) => t.id !== id) });
  }
  function setActiveFocus(id) { setActiveTask(id); setTab("focus"); }

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
    if (!confirm(`Delete habit "${h?.name}" and its history? This cannot be undone.`)) return;
    save({ ...data, habits: data.habits.filter((x) => x.id !== id) });
  }

  /* ---------- sleep ---------- */
  function logSleep() {
    const v = parseFloat(sleepInput);
    if (isNaN(v) || v < 0 || v > 16) return;
    save({ ...data, sleepLog: { ...data.sleepLog, [todayStr()]: Math.round(v * 10) / 10 } });
    setSleepInput("");
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
      last7.push({ ds, mins, sleep: data.sleepLog[ds] || 0 });
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

  const NAV = [
    { id: "focus", label: "Focus", icon: "◎" },
    { id: "tasks", label: "Manifest", icon: "≣" },
    { id: "habits", label: "Habits", icon: "⊙" },
    { id: "reserve", label: "Reserve", icon: "◐" },
    { id: "insights", label: "Insights", icon: "◭" },
    { id: "regulator", label: "Regulator", icon: "⚙" },
  ];
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
        .dial{display:flex;flex-direction:column;align-items:center;gap:18px;}
        .dial-svg{width:300px;height:300px;max-width:80vw;}
        .dial-cap{font-family:'IBM Plex Mono',monospace;font-size:10px;fill:var(--slate);letter-spacing:.16em;}
        .dial-time{font-family:'IBM Plex Mono',monospace;font-size:40px;fill:var(--ivory);letter-spacing:.04em;}
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
        input[type="date"].inp{color-scheme:dark;}
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

        /* reserve */
        .gauge-wrap{display:flex;justify-content:center;margin:6px 0 8px;}
        .weekbars{display:flex;gap:10px;justify-content:center;margin-top:26px;}
        .wb{width:26px;height:96px;background:rgba(86,225,232,0.12);border-radius:4px;display:flex;
          align-items:flex-end;position:relative;}
        .wbf{width:100%;background:var(--brass);border-radius:4px;}
        .wbl{position:absolute;bottom:-20px;width:100%;text-align:center;font-size:9px;color:var(--slate);}
        .wbv{position:absolute;top:-16px;width:100%;text-align:center;font-size:9px;color:var(--slate);font-family:'IBM Plex Mono',monospace;}

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
          .dial-svg{width:240px;height:240px;}
          .comp{width:calc(50% - 9px);}
          .stat{min-width:96px;padding:12px 14px;}
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
        {/* FOCUS */}
        {tab === "focus" && (
          <>
            <h1 className="h1">Focus</h1>
            <p className="sub">One movement at a time — {S.work} on, {S.break} to rest.</p>
            <Dial mode={timer.mode} secondsLeft={secondsLeft} total={total} running={timer.running}
              onToggle={toggleTimer} onReset={resetTimer} onSkip={skip} />
            <div className="focus-task">
              {activeTask
                ? <>Winding on <b>{data.tasks.find((x) => x.id === activeTask)?.label || "—"}</b> · <button className="laction" onClick={() => setActiveTask(null)}>clear</button></>
                : <>No task pinned — pick one from the Manifest to track sessions against it.</>}
            </div>
            <div className="stat-row">
              <div className="stat"><div className="num">{stats.todayMins}</div><div className="lbl">MIN TODAY</div></div>
              <div className="stat"><div className="num">{data.completedSessions}</div><div className="lbl">SESSIONS</div></div>
              <div className="stat"><div className="num">{Math.round(data.focusMinutesTotal / 60)}h</div><div className="lbl">ALL-TIME</div></div>
            </div>
          </>
        )}

        {/* TASKS */}
        {tab === "tasks" && (
          <>
            <h1 className="h1">Manifest</h1>
            <p className="sub">{stats.doneAll} of {data.tasks.length} entries cleared · {stats.clearedToday} today.</p>
            <div className="toolbar" role="group" aria-label="Filter tasks">
              {["all", "active", "done", ...PROJECTS].map((f) => (
                <button key={f} className={`chip ${filter === f ? "on" : ""}`} onClick={() => setFilter(f)} aria-pressed={filter === f}>
                  {f === "all" ? "All" : f === "active" ? "Active" : f === "done" ? "Cleared" : f}
                </button>
              ))}
            </div>
            <div className="ledger">
              {sorted.length === 0 && <div className="empty">Nothing here. Add an entry below.</div>}
              {sorted.map((tk) => {
                const overdue = tk.due && !tk.done && tk.due < t;
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
                        <span className="proj">{tk.project}</span>
                        {tk.due && <span className={`duetag ${overdue ? "over" : ""}`}>{overdue ? "overdue · " : "due "}{fmtDue(tk.due)}</span>}
                      </div>
                    </div>
                    {!tk.done && <button className="laction" onClick={() => setActiveFocus(tk.id)}>focus</button>}
                    <button className="laction del" onClick={() => delTask(tk.id)} aria-label={`Remove "${tk.label}"`}>remove</button>
                  </div>
                );
              })}
            </div>
            <div className="composer">
              <input className="inp" style={{ flex: 1, minWidth: 180 }} placeholder="New entry…" aria-label="New task" value={newTask}
                onChange={(e) => setNewTask(e.target.value)} onKeyDown={(e) => e.key === "Enter" && addTask()} />
              <select className="inp" value={newPriority} onChange={(e) => setNewPriority(e.target.value)} aria-label="Priority">
                <option value="high">High</option><option value="med">Med</option><option value="low">Low</option>
              </select>
              <select className="inp" value={newProject} onChange={(e) => setNewProject(e.target.value)} aria-label="Project">
                {PROJECTS.map((p) => <option key={p}>{p}</option>)}
              </select>
              <input type="date" className="inp" value={newDue} onChange={(e) => setNewDue(e.target.value)} aria-label="Due date (optional)" />
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
          </>
        )}

        {/* RESERVE */}
        {tab === "reserve" && (
          <>
            <h1 className="h1">Reserve</h1>
            <p className="sub">Sleep, read like a power reserve — the energy left to run on.</p>
            <ReserveGauge avg={stats.avgSleep} />
            <div className="weekbars">
              {stats.last7.map((d, i) => (
                <div className="wb" key={i}>
                  {d.sleep > 0 && <div className="wbv">{d.sleep}</div>}
                  <div className="wbf" style={{ height: `${Math.min((d.sleep / 9) * 100, 100)}%` }} />
                  <div className="wbl">{["S", "M", "T", "W", "T", "F", "S"][new Date(d.ds + "T12:00:00").getDay()]}</div>
                </div>
              ))}
            </div>
            <div className="composer" style={{ justifyContent: "center", marginTop: 40 }}>
              <input className="inp" style={{ maxWidth: 220 }} placeholder="Hours slept last night" aria-label="Hours slept last night"
                inputMode="decimal" value={sleepInput}
                onChange={(e) => setSleepInput(e.target.value)} onKeyDown={(e) => e.key === "Enter" && logSleep()} />
              <button className="addbtn" onClick={logSleep}>Log</button>
            </div>
          </>
        )}

        {/* INSIGHTS */}
        {tab === "insights" && (
          <>
            <h1 className="h1">Insights</h1>
            <p className="sub">The week at a glance — where the movement is running true.</p>
            <div className="cards">
              <div className="card"><div className="cn">{stats.todayMins}</div><div className="cl">FOCUS MIN TODAY</div></div>
              <div className="card"><div className="cn">{stats.avgSleep.toFixed(1)}h</div><div className="cl">AVG SLEEP / 7D</div></div>
              <div className="card"><div className="cn">{stats.bestStreak}</div><div className="cl">TOP STREAK</div></div>
              <div className="card"><div className="cn">{stats.clearedToday}</div><div className="cl">CLEARED TODAY</div></div>
            </div>
            <div className="panel">
              <h3>Focus minutes — last 7 days</h3>
              <div className="barchart">
                {stats.last7.map((d, i) => {
                  const max = Math.max(...stats.last7.map((x) => x.mins), 25);
                  return (
                    <div className="bc" key={i}>
                      <div className="bcv">{d.mins || ""}</div>
                      <div className="bcbar" style={{ height: `${(d.mins / max) * 100}%` }} />
                      <div className="bcl">{["S", "M", "T", "W", "T", "F", "S"][new Date(d.ds + "T12:00:00").getDay()]}</div>
                    </div>
                  );
                })}
              </div>
            </div>
            <div className="panel">
              <h3>Focus by project — last 7 days</h3>
              {stats.projectRows.length === 0 && <div className="empty" style={{ padding: "12px 0" }}>No sessions recorded this week yet.</div>}
              {stats.projectRows.map(([p, mins]) => {
                const max = stats.projectRows[0][1];
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
                <div>
                  <div style={{ fontSize: 11, color: "var(--slate)", marginBottom: 6 }}>Sleep (hrs)</div>
                  <Spark points={stats.last7.map((d) => d.sleep)} color="var(--jade)" max={9} width={240} height={50} />
                </div>
                <div>
                  <div style={{ fontSize: 11, color: "var(--slate)", marginBottom: 6 }}>Focus (min)</div>
                  <Spark points={stats.last7.map((d) => d.mins)} color="var(--brass)" width={240} height={50} />
                </div>
              </div>
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
    </div>
  );
}

/* ============ Reserve gauge ============ */
function ReserveGauge({ avg }) {
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
  return (
    <div className="gauge-wrap">
      <svg viewBox="0 0 220 200" width="300" height="270" style={{ maxWidth: "80vw" }} role="img" aria-label={`Average sleep over 7 days: ${avg.toFixed(1)} hours`}>
        {ticks}
        <path d={`M ${sx} ${sy} A ${r} ${r} 0 1 1 ${ex} ${ey}`} fill="none" stroke="var(--steel)" strokeWidth="11" strokeLinecap="round" />
        {pct > 0 && <path d={`M ${sx} ${sy} A ${r} ${r} 0 ${large} 1 ${fx} ${fy}`} fill="none" stroke="var(--brass)" strokeWidth="11" strokeLinecap="round" />}
        <text x={cx} y={cy - 4} textAnchor="middle" style={{ fontFamily: "'IBM Plex Mono',monospace", fontSize: 26, fill: "var(--ivory)" }}>{avg.toFixed(1)}h</text>
        <text x={cx} y={cy + 18} textAnchor="middle" style={{ fontSize: 10, fill: "var(--slate)", letterSpacing: ".08em" }}>AVG RESERVE / 7D</text>
      </svg>
    </div>
  );
}
