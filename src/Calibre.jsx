import { useState, useEffect, useRef, useCallback, useMemo } from "react";

/* ============================================================
   CALIBRE — a productivity instrument built with watchmaking
   precision. Redesign with the full feature set.

   DESIGN TOKENS
   --------------------------------------------------------
   Movement black  #101317   page ground
   Anthracite      #171B21   panels
   Steel line      #2A2F37   borders / tracks
   Case silver     #C4C9D1   structural rules
   Parchment       #ECE6D8   light task surface
   Brass           #B08D57   primary accent (hands / active)
   Brass-lo        #8A6E43   pressed brass
   Crimson         #A23B2E   seconds / alerts / overdue
   Jade            #4E8D6E   success / completed streaks
   Ivory           #F5F1E8   primary text
   Slate text      #8A9099   muted text

   TYPE
   Fraunces  — engraved technical serif (display)
   IBM Plex Sans  — body / UI
   IBM Plex Mono  — data, readouts, tickers
   ============================================================ */

const FONTS = `@import url('https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,300;9..144,400;9..144,500;9..144,600&family=IBM+Plex+Sans:wght@400;500;600&family=IBM+Plex+Mono:wght@400;500&display=swap');`;

const KEY = "calibre:v2";

const todayStr = () => new Date().toISOString().slice(0, 10);
const DAY = 86400000;

const seed = () => ({
  tasks: [
    { id: "t1", label: "Reply to Vestiaire authentication query", done: false, priority: "high", project: "Resale", due: todayStr(), created: Date.now() },
    { id: "t2", label: "Photograph Cartier Tank for listing", done: false, priority: "med", project: "Studio", due: null, created: Date.now() },
    { id: "t3", label: "Send FedEx dispute follow-up", done: true, priority: "high", project: "Admin", due: null, created: Date.now(), doneAt: Date.now() },
    { id: "t4", label: "Prep ACCT211 CVP slides", done: false, priority: "low", project: "Teaching", due: null, created: Date.now() },
  ],
  habits: [
    { id: "h1", name: "Inventory check", streak: 4, best: 9, history: {}, target: "daily" },
    { id: "h2", name: "Client replies", streak: 12, best: 12, history: {}, target: "daily" },
    { id: "h3", name: "Course prep", streak: 2, best: 6, history: {}, target: "daily" },
  ],
  sleepLog: {}, // date -> hours
  sessions: [], // {date, mode, minutes, taskId}
  completedSessions: 0,
  focusMinutesTotal: 0,
  settings: { work: 25, break: 5, longBreak: 15, cycles: 4, sound: true },
  notes: "",
});

/* seed a week of sleep + habit history for a live demo */
function withDemo(d) {
  const now = Date.now();
  const sl = { ...d.sleepLog };
  const hrs = [7.5, 6, 8, 7, 6.5, 7.5, 8];
  for (let i = 6; i >= 0; i--) {
    const ds = new Date(now - i * DAY).toISOString().slice(0, 10);
    if (sl[ds] == null) sl[ds] = hrs[6 - i];
  }
  const habits = d.habits.map((h, idx) => {
    const hist = { ...h.history };
    const pattern = [
      [1, 1, 1, 1, 0, 1, 1],
      [1, 1, 1, 1, 1, 1, 1],
      [0, 1, 1, 0, 1, 1, 0],
    ][idx] || [1, 0, 1, 0, 1, 0, 1];
    for (let i = 6; i >= 1; i--) {
      const ds = new Date(now - i * DAY).toISOString().slice(0, 10);
      if (hist[ds] == null) hist[ds] = !!pattern[6 - i];
    }
    return { ...h, history: hist };
  });
  return { ...d, sleepLog: sl, habits };
}

function useStore() {
  const [data, setData] = useState(null);
  const ready = useRef(false);
  useEffect(() => {
    (async () => {
      try {
        const r = await window.storage.get(KEY);
        setData(r ? JSON.parse(r.value) : withDemo(seed()));
      } catch {
        setData(withDemo(seed()));
      }
      ready.current = true;
    })();
  }, []);
  const save = useCallback((next) => {
    setData(next);
    window.storage.set(KEY, JSON.stringify(next)).catch(() => {});
  }, []);
  return [data, save, ready];
}

/* ---------- small helpers ---------- */
const PRIORITY = {
  high: { label: "High", color: "var(--crimson)" },
  med: { label: "Med", color: "var(--brass)" },
  low: { label: "Low", color: "var(--slate)" },
};
const PROJECTS = ["Resale", "Studio", "Admin", "Teaching", "Personal"];

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
      <svg viewBox="0 0 260 260" className="dial-svg">
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
    <svg viewBox={`0 0 ${width} ${height}`} width={width} height={height} preserveAspectRatio="none">
      <path d={d} fill="none" stroke={color} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}

/* ================= App ================= */
export default function Calibre() {
  const [data, save, ready] = useStore();
  const [tab, setTab] = useState("focus");

  /* timer state */
  const [mode, setMode] = useState("work");
  const [secondsLeft, setSecondsLeft] = useState(25 * 60);
  const [running, setRunning] = useState(false);
  const [activeTask, setActiveTask] = useState(null);
  const cycleRef = useRef(0);
  const tickRef = useRef(null);

  /* task form */
  const [newTask, setNewTask] = useState("");
  const [newPriority, setNewPriority] = useState("med");
  const [newProject, setNewProject] = useState("Resale");
  const [filter, setFilter] = useState("all");
  const [sleepInput, setSleepInput] = useState("");

  const S = data?.settings || { work: 25, break: 5, longBreak: 15, cycles: 4, sound: true };
  const total = mode === "work" ? S.work * 60 : mode === "break" ? S.break * 60 : S.longBreak * 60;

  useEffect(() => { if (!running) setSecondsLeft(total); }, [S.work, S.break, S.longBreak]); // eslint-disable-line

  const ping = useCallback(() => {
    if (!S.sound) return;
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      [880, 660, 990].forEach((f, i) => {
        const o = ctx.createOscillator(), g = ctx.createGain();
        o.frequency.value = f; o.type = "sine";
        o.connect(g); g.connect(ctx.destination);
        g.gain.setValueAtTime(0.0001, ctx.currentTime + i * 0.16);
        g.gain.exponentialRampToValueAtTime(0.18, ctx.currentTime + i * 0.16 + 0.02);
        g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + i * 0.16 + 0.15);
        o.start(ctx.currentTime + i * 0.16); o.stop(ctx.currentTime + i * 0.16 + 0.16);
      });
    } catch { /* ignore */ }
  }, [S.sound]);

  const completeSession = useCallback(() => {
    ping();
    if (!data) return;
    if (mode === "work") {
      cycleRef.current += 1;
      const isLong = cycleRef.current % S.cycles === 0;
      const nextMode = isLong ? "long" : "break";
      const sess = { date: todayStr(), mode: "work", minutes: S.work, taskId: activeTask };
      save({
        ...data,
        completedSessions: data.completedSessions + 1,
        focusMinutesTotal: data.focusMinutesTotal + S.work,
        sessions: [...data.sessions, sess],
      });
      setMode(nextMode);
      setSecondsLeft((isLong ? S.longBreak : S.break) * 60);
    } else {
      setMode("work");
      setSecondsLeft(S.work * 60);
    }
    setRunning(false);
  }, [data, mode, S, activeTask, ping, save]);

  useEffect(() => {
    if (running) {
      tickRef.current = setInterval(() => {
        setSecondsLeft((s) => {
          if (s <= 1) { clearInterval(tickRef.current); completeSession(); return 0; }
          return s - 1;
        });
      }, 1000);
    }
    return () => clearInterval(tickRef.current);
  }, [running, completeSession]);

  function skip() {
    setRunning(false);
    if (mode === "work") { cycleRef.current += 1; const long = cycleRef.current % S.cycles === 0; setMode(long ? "long" : "break"); setSecondsLeft((long ? S.longBreak : S.break) * 60); }
    else { setMode("work"); setSecondsLeft(S.work * 60); }
  }

  /* ---------- task ops ---------- */
  function addTask() {
    if (!newTask.trim()) return;
    save({ ...data, tasks: [...data.tasks, { id: "t" + Date.now(), label: newTask.trim(), done: false, priority: newPriority, project: newProject, due: null, created: Date.now() }] });
    setNewTask("");
  }
  function toggleTask(id) {
    save({ ...data, tasks: data.tasks.map((t) => t.id === id ? { ...t, done: !t.done, doneAt: !t.done ? Date.now() : null } : t) });
  }
  function delTask(id) { save({ ...data, tasks: data.tasks.filter((t) => t.id !== id) }); }
  function setActiveFocus(id) { setActiveTask(id); setTab("focus"); }

  /* ---------- habits ---------- */
  function toggleHabit(id) {
    const t = todayStr();
    save({
      ...data,
      habits: data.habits.map((h) => {
        if (h.id !== id) return h;
        const done = !h.history[t];
        const history = { ...h.history, [t]: done };
        // recompute streak
        let streak = 0;
        for (let i = 0; i < 400; i++) {
          const ds = new Date(Date.now() - i * DAY).toISOString().slice(0, 10);
          if (history[ds]) streak++; else break;
        }
        return { ...h, history, streak, best: Math.max(h.best, streak) };
      }),
    });
  }
  const [newHabit, setNewHabit] = useState("");
  function addHabit() {
    if (!newHabit.trim()) return;
    save({ ...data, habits: [...data.habits, { id: "h" + Date.now(), name: newHabit.trim(), streak: 0, best: 0, history: {}, target: "daily" }] });
    setNewHabit("");
  }
  function delHabit(id) { save({ ...data, habits: data.habits.filter((h) => h.id !== id) }); }

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
      const ds = new Date(Date.now() - i * DAY).toISOString().slice(0, 10);
      const mins = data.sessions.filter((s) => s.date === ds).reduce((a, s) => a + s.minutes, 0);
      last7.push({ ds, mins, sleep: data.sleepLog[ds] || 0 });
    }
    const todayMins = data.sessions.filter((s) => s.date === todayStr()).reduce((a, s) => a + s.minutes, 0);
    const sleepVals = Object.values(data.sleepLog);
    const avgSleep = sleepVals.length ? sleepVals.slice(-7).reduce((a, b) => a + b, 0) / Math.min(sleepVals.length, 7) : 0;
    const doneToday = data.tasks.filter((t) => t.done).length;
    const bestStreak = Math.max(0, ...data.habits.map((h) => h.streak));
    return { last7, todayMins, avgSleep, doneToday, bestStreak };
  }, [data]);

  if (!ready.current || !data) {
    return <div style={{ padding: 40, fontFamily: "IBM Plex Sans", color: "#8A9099" }}>Winding the mechanism…</div>;
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

  return (
    <div className="root">
      <style>{`
        ${FONTS}
        .root{
          --ink:#101317;--anthracite:#171B21;--steel:#2A2F37;--case:#C4C9D1;
          --parchment:#ECE6D8;--brass:#B08D57;--brass-lo:#8A6E43;--crimson:#A23B2E;
          --jade:#4E8D6E;--ivory:#F5F1E8;--slate:#8A9099;
          font-family:'IBM Plex Sans',sans-serif;background:var(--ink);color:var(--ivory);
          display:flex;border-radius:14px;overflow:hidden;border:1px solid var(--steel);min-height:640px;
        }
        .root *{box-sizing:border-box;}
        .nav{width:104px;background:#0C0E11;border-right:1px solid var(--steel);
          display:flex;flex-direction:column;align-items:center;padding:22px 0;gap:4px;flex-shrink:0;}
        .logo{font-family:'Fraunces',serif;font-weight:500;font-size:13px;letter-spacing:.24em;
          color:var(--brass);margin-bottom:26px;transform:rotate(0deg);}
        .navbtn{width:80px;padding:11px 0;border:none;background:transparent;color:var(--slate);
          font-size:11px;letter-spacing:.04em;cursor:pointer;display:flex;flex-direction:column;
          align-items:center;gap:5px;border-radius:9px;transition:.18s;}
        .navbtn .ic{font-size:19px;line-height:1;}
        .navbtn:hover{color:var(--case);background:rgba(255,255,255,.03);}
        .navbtn.on{color:var(--brass);background:rgba(176,141,87,.1);}
        .main{flex:1;padding:32px 40px;overflow-y:auto;max-height:760px;}
        .h1{font-family:'Fraunces',serif;font-weight:500;font-size:27px;margin:0 0 3px;letter-spacing:.01em;}
        .sub{color:var(--slate);font-size:13px;margin:0 0 26px;}
        .mono{font-family:'IBM Plex Mono',monospace;}

        /* focus */
        .dial{display:flex;flex-direction:column;align-items:center;gap:18px;}
        .dial-svg{width:300px;height:300px;}
        .dial-cap{font-family:'IBM Plex Mono',monospace;font-size:10px;fill:var(--slate);letter-spacing:.16em;}
        .dial-time{font-family:'IBM Plex Mono',monospace;font-size:40px;fill:var(--ivory);letter-spacing:.04em;}
        .dial-ctrl{display:flex;gap:10px;}
        .crown{background:var(--brass);color:#14171B;border:none;padding:11px 30px;border-radius:22px;
          font-weight:600;font-size:13px;cursor:pointer;letter-spacing:.03em;font-family:inherit;}
        .crown:active{background:var(--brass-lo);}
        .ghost{background:transparent;border:1px solid var(--steel);color:var(--case);padding:11px 20px;
          border-radius:22px;font-size:13px;cursor:pointer;font-family:inherit;}
        .ghost:hover{border-color:var(--brass);}
        .focus-task{margin-top:22px;text-align:center;font-size:13px;color:var(--slate);}
        .focus-task b{color:var(--ivory);font-weight:500;}
        .stat-row{display:flex;gap:14px;justify-content:center;margin-top:26px;flex-wrap:wrap;}
        .stat{background:var(--anthracite);border:1px solid var(--steel);border-radius:11px;
          padding:14px 22px;text-align:center;min-width:112px;}
        .stat .num{font-family:'IBM Plex Mono',monospace;font-size:23px;color:var(--brass);}
        .stat .lbl{font-size:10px;color:var(--slate);letter-spacing:.07em;margin-top:2px;}

        /* tasks */
        .toolbar{display:flex;gap:7px;flex-wrap:wrap;margin-bottom:16px;}
        .chip{background:transparent;border:1px solid var(--steel);color:var(--slate);
          padding:6px 13px;border-radius:16px;font-size:12px;cursor:pointer;font-family:inherit;}
        .chip.on{border-color:var(--brass);color:var(--brass);background:rgba(176,141,87,.08);}
        .ledger{background:var(--parchment);color:#20242A;border-radius:11px;overflow:hidden;}
        .lrow{display:flex;align-items:center;gap:13px;padding:13px 18px;border-bottom:1px solid rgba(0,0,0,.07);}
        .lrow:last-child{border-bottom:none;}
        .tick{width:21px;height:21px;border-radius:5px;border:1.5px solid var(--brass-lo);cursor:pointer;
          display:flex;align-items:center;justify-content:center;font-size:13px;color:var(--brass-lo);flex-shrink:0;}
        .tick.on{background:var(--brass-lo);color:var(--parchment);}
        .lbody{flex:1;min-width:0;}
        .llabel{font-size:14px;line-height:1.3;}
        .llabel.done{text-decoration:line-through;opacity:.45;}
        .lmeta{display:flex;gap:8px;margin-top:4px;align-items:center;}
        .badge{font-size:10px;padding:2px 8px;border-radius:10px;letter-spacing:.03em;font-family:'IBM Plex Mono',monospace;}
        .proj{font-size:10px;color:#5A5F52;letter-spacing:.04em;}
        .laction{background:none;border:none;cursor:pointer;font-size:12px;color:#5A5F52;padding:3px 6px;font-family:inherit;}
        .laction:hover{color:var(--brass-lo);}
        .laction.del:hover{color:var(--crimson);}
        .composer{display:flex;gap:8px;margin-top:16px;flex-wrap:wrap;}
        .inp{background:var(--anthracite);border:1px solid var(--steel);color:var(--ivory);
          padding:10px 13px;border-radius:8px;font-size:13px;font-family:inherit;}
        .inp:focus{outline:none;border-color:var(--brass);}
        select.inp{cursor:pointer;}
        .addbtn{background:var(--brass);border:none;color:#14171B;padding:0 20px;border-radius:8px;
          font-weight:600;cursor:pointer;font-family:inherit;}
        .addbtn:active{background:var(--brass-lo);}

        /* habits */
        .comps{display:flex;gap:18px;flex-wrap:wrap;}
        .comp{width:158px;background:var(--anthracite);border:1px solid var(--steel);border-radius:13px;
          padding:16px 14px;display:flex;flex-direction:column;gap:9px;position:relative;}
        .comp.on{border-color:var(--jade);}
        .comp-top{display:flex;justify-content:space-between;align-items:flex-start;}
        .comp-name{font-size:13px;font-weight:500;line-height:1.25;}
        .comp-streak{font-family:'IBM Plex Mono',monospace;font-size:30px;color:var(--brass);line-height:1;}
        .comp-unit{font-size:9px;color:var(--slate);letter-spacing:.1em;}
        .comp-best{font-size:10px;color:var(--slate);}
        .dots{display:flex;gap:4px;margin-top:4px;}
        .dot{width:13px;height:13px;border-radius:50%;border:1px solid var(--steel);}
        .dot.f{background:var(--jade);border-color:var(--jade);}
        .comp-btn{margin-top:4px;background:transparent;border:1px solid var(--steel);color:var(--case);
          padding:7px;border-radius:8px;font-size:12px;cursor:pointer;font-family:inherit;}
        .comp-btn.on{background:var(--jade);border-color:var(--jade);color:#0C0E11;font-weight:600;}
        .comp-del{position:absolute;top:8px;right:10px;background:none;border:none;color:var(--slate);
          cursor:pointer;font-size:14px;opacity:.5;}
        .comp-del:hover{opacity:1;color:var(--crimson);}

        /* reserve */
        .gauge-wrap{display:flex;justify-content:center;margin:6px 0 8px;}
        .weekbars{display:flex;gap:10px;justify-content:center;margin-top:26px;}
        .wb{width:26px;height:96px;background:var(--steel);border-radius:4px;display:flex;
          align-items:flex-end;position:relative;}
        .wbf{width:100%;background:var(--brass);border-radius:4px;}
        .wbl{position:absolute;bottom:-20px;width:100%;text-align:center;font-size:9px;color:var(--slate);}
        .wbv{position:absolute;top:-16px;width:100%;text-align:center;font-size:9px;color:var(--slate);font-family:'IBM Plex Mono',monospace;}

        /* insights */
        .cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:14px;margin-bottom:26px;}
        .card{background:var(--anthracite);border:1px solid var(--steel);border-radius:11px;padding:16px;}
        .card .cn{font-family:'IBM Plex Mono',monospace;font-size:26px;color:var(--brass);}
        .card .cl{font-size:11px;color:var(--slate);letter-spacing:.05em;margin-top:3px;}
        .panel{background:var(--anthracite);border:1px solid var(--steel);border-radius:11px;padding:20px;margin-bottom:18px;}
        .panel h3{font-family:'Fraunces',serif;font-weight:500;font-size:15px;margin:0 0 14px;}
        .barchart{display:flex;align-items:flex-end;gap:12px;height:120px;}
        .bc{flex:1;display:flex;flex-direction:column;align-items:center;gap:6px;height:100%;justify-content:flex-end;}
        .bcbar{width:100%;max-width:34px;background:var(--brass);border-radius:4px 4px 0 0;min-height:2px;}
        .bcl{font-size:9px;color:var(--slate);}
        .bcv{font-size:9px;color:var(--slate);font-family:'IBM Plex Mono',monospace;}

        /* regulator */
        .setrow{display:flex;align-items:center;justify-content:space-between;padding:14px 0;border-bottom:1px solid var(--steel);}
        .setrow:last-child{border-bottom:none;}
        .setlbl{font-size:14px;}
        .setsub{font-size:11px;color:var(--slate);margin-top:2px;}
        .stepper{display:flex;align-items:center;gap:10px;}
        .stepbtn{width:30px;height:30px;border-radius:7px;border:1px solid var(--steel);background:transparent;
          color:var(--ivory);cursor:pointer;font-size:16px;font-family:inherit;}
        .stepbtn:hover{border-color:var(--brass);}
        .stepval{font-family:'IBM Plex Mono',monospace;font-size:16px;width:34px;text-align:center;color:var(--brass);}
        .toggle{width:46px;height:26px;border-radius:13px;background:var(--steel);position:relative;cursor:pointer;border:none;}
        .toggle.on{background:var(--brass);}
        .toggle::after{content:'';position:absolute;top:3px;left:3px;width:20px;height:20px;border-radius:50%;
          background:var(--ivory);transition:.2s;}
        .toggle.on::after{left:23px;}
        .notes{width:100%;min-height:110px;background:var(--anthracite);border:1px solid var(--steel);
          color:var(--ivory);border-radius:10px;padding:14px;font-family:inherit;font-size:13px;resize:vertical;line-height:1.6;}
        .notes:focus{outline:none;border-color:var(--brass);}
        .danger{background:transparent;border:1px solid var(--crimson);color:var(--crimson);
          padding:9px 18px;border-radius:8px;cursor:pointer;font-size:13px;font-family:inherit;margin-top:8px;}
        .danger:hover{background:rgba(162,59,46,.12);}
        .empty{padding:30px;text-align:center;color:var(--slate);font-size:13px;}
      `}</style>

      <nav className="nav">
        <div className="logo">CAL</div>
        {NAV.map((n) => (
          <button key={n.id} className={`navbtn ${tab === n.id ? "on" : ""}`} onClick={() => setTab(n.id)}>
            <span className="ic">{n.icon}</span>{n.label}
          </button>
        ))}
      </nav>

      <div className="main">
        {/* FOCUS */}
        {tab === "focus" && (
          <>
            <h1 className="h1">Focus</h1>
            <p className="sub">One movement at a time — {S.work} on, {S.break} to rest.</p>
            <Dial mode={mode} secondsLeft={secondsLeft} total={total} running={running}
              onToggle={() => setRunning((r) => !r)} onReset={() => { setRunning(false); setSecondsLeft(total); }} onSkip={skip} />
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
            <p className="sub">{stats.doneToday} of {data.tasks.length} entries cleared.</p>
            <div className="toolbar">
              {["all", "active", "done", ...PROJECTS].map((f) => (
                <button key={f} className={`chip ${filter === f ? "on" : ""}`} onClick={() => setFilter(f)}>
                  {f === "all" ? "All" : f === "active" ? "Active" : f === "done" ? "Cleared" : f}
                </button>
              ))}
            </div>
            <div className="ledger">
              {sorted.length === 0 && <div className="empty">Nothing here. Add an entry below.</div>}
              {sorted.map((tk) => (
                <div className="lrow" key={tk.id}>
                  <div className={`tick ${tk.done ? "on" : ""}`} onClick={() => toggleTask(tk.id)}>{tk.done ? "✓" : ""}</div>
                  <div className="lbody">
                    <div className={`llabel ${tk.done ? "done" : ""}`}>{tk.label}</div>
                    <div className="lmeta">
                      <span className="badge" style={{ background: PRIORITY[tk.priority].color + "22", color: PRIORITY[tk.priority].color }}>{PRIORITY[tk.priority].label}</span>
                      <span className="proj">{tk.project}</span>
                    </div>
                  </div>
                  {!tk.done && <button className="laction" onClick={() => setActiveFocus(tk.id)}>focus</button>}
                  <button className="laction del" onClick={() => delTask(tk.id)}>remove</button>
                </div>
              ))}
            </div>
            <div className="composer">
              <input className="inp" style={{ flex: 1, minWidth: 180 }} placeholder="New entry…" value={newTask}
                onChange={(e) => setNewTask(e.target.value)} onKeyDown={(e) => e.key === "Enter" && addTask()} />
              <select className="inp" value={newPriority} onChange={(e) => setNewPriority(e.target.value)}>
                <option value="high">High</option><option value="med">Med</option><option value="low">Low</option>
              </select>
              <select className="inp" value={newProject} onChange={(e) => setNewProject(e.target.value)}>
                {PROJECTS.map((p) => <option key={p}>{p}</option>)}
              </select>
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
              {data.habits.map((h) => {
                const doneToday = !!h.history[t];
                const days = [];
                for (let i = 5; i >= 1; i--) days.push(!!h.history[new Date(Date.now() - i * DAY).toISOString().slice(0, 10)]);
                return (
                  <div key={h.id} className={`comp ${doneToday ? "on" : ""}`}>
                    <button className="comp-del" onClick={() => delHabit(h.id)}>×</button>
                    <div className="comp-top">
                      <div className="comp-name">{h.name}</div>
                    </div>
                    <div><span className="comp-streak">{h.streak}</span> <span className="comp-unit">DAY STREAK</span></div>
                    <div className="comp-best">Best: {h.best} days</div>
                    <div className="dots">{days.map((d, i) => <div key={i} className={`dot ${d ? "f" : ""}`} />)}</div>
                    <button className={`comp-btn ${doneToday ? "on" : ""}`} onClick={() => toggleHabit(h.id)}>
                      {doneToday ? "✓ Done today" : "Mark today"}
                    </button>
                  </div>
                );
              })}
            </div>
            <div className="composer">
              <input className="inp" style={{ flex: 1, minWidth: 180 }} placeholder="New habit…" value={newHabit}
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
                  <div className="wbl">{["S", "M", "T", "W", "T", "F", "S"][new Date(d.ds).getDay()]}</div>
                </div>
              ))}
            </div>
            <div className="composer" style={{ justifyContent: "center", marginTop: 40 }}>
              <input className="inp" style={{ maxWidth: 220 }} placeholder="Hours slept last night" value={sleepInput}
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
              <div className="card"><div className="cn">{data.tasks.filter((x) => x.done).length}</div><div className="cl">TASKS CLEARED</div></div>
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
                      <div className="bcl">{["S", "M", "T", "W", "T", "F", "S"][new Date(d.ds).getDay()]}</div>
                    </div>
                  );
                })}
              </div>
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
            <p className="sub">Fine-tune the movement. Adjust intervals, sound, and keep working notes.</p>
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
                    <button className="stepbtn" onClick={() => setS({ [r.k]: Math.max(r.min, S[r.k] - r.step) })}>−</button>
                    <span className="stepval">{S[r.k]}</span>
                    <button className="stepbtn" onClick={() => setS({ [r.k]: Math.min(r.max, S[r.k] + r.step) })}>+</button>
                  </div>
                </div>
              ))}
              <div className="setrow">
                <div><div className="setlbl">Chime on completion</div><div className="setsub">Soft three-note signal</div></div>
                <button className={`toggle ${S.sound ? "on" : ""}`} onClick={() => setS({ sound: !S.sound })} aria-label="toggle sound" />
              </div>
            </div>
            <div className="panel">
              <h3>Working notes</h3>
              <textarea className="notes" placeholder="Scratchpad — thoughts, reminders, anything worth keeping…"
                value={data.notes} onChange={(e) => saveNotes(e.target.value)} />
            </div>
            <button className="danger" onClick={() => { if (confirm("Reset all Calibre data? This cannot be undone.")) save(withDemo(seed())); }}>
              Reset all data
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
      <svg viewBox="0 0 220 200" width="300" height="270">
        {ticks}
        <path d={`M ${sx} ${sy} A ${r} ${r} 0 1 1 ${ex} ${ey}`} fill="none" stroke="var(--steel)" strokeWidth="11" strokeLinecap="round" />
        <path d={`M ${sx} ${sy} A ${r} ${r} 0 ${large} 1 ${fx} ${fy}`} fill="none" stroke="var(--brass)" strokeWidth="11" strokeLinecap="round" />
        <text x={cx} y={cy - 4} textAnchor="middle" style={{ fontFamily: "'IBM Plex Mono',monospace", fontSize: 26, fill: "var(--ivory)" }}>{avg.toFixed(1)}h</text>
        <text x={cx} y={cy + 18} textAnchor="middle" style={{ fontSize: 10, fill: "var(--slate)", letterSpacing: ".08em" }}>AVG RESERVE / 7D</text>
      </svg>
    </div>
  );
}
