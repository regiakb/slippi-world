import {
  Chart,
  BarController,
  BarElement,
  CategoryScale,
  LinearScale,
  Tooltip,
  Legend,
} from "chart.js";

Chart.register(
  BarController,
  BarElement,
  CategoryScale,
  LinearScale,
  Tooltip,
  Legend
);

// ─── lookup tables ────────────────────────────────────────────────────────────
const CHARS = {
  0:"C.Falcon",1:"DK",2:"Fox",3:"G&W",4:"Kirby",5:"Bowser",
  6:"Link",7:"Luigi",8:"Mario",9:"Marth",10:"Mewtwo",11:"Ness",
  12:"Peach",13:"Pikachu",14:"ICs",15:"Jigglypuff",16:"Samus",
  17:"Yoshi",18:"Zelda",19:"Sheik",20:"Falco",21:"Y.Link",
  22:"Dr.Mario",23:"Roy",24:"Pichu",25:"Ganon",
  26:"Master Hand",27:"WireM",28:"WireF",29:"Giga Bowser",30:"Sandbag",
};
const STAGES = {
  2:"Fountain of Dreams",3:"Pokémon Stadium",4:"Peach's Castle",5:"Kongo Jungle",
  6:"Brinstar",7:"Corneria",8:"Yoshi's Story",9:"Onett",10:"Mute City",
  11:"Rainbow Cruise",12:"Jungle Japes",13:"Great Bay",14:"Hyrule Temple",
  15:"Brinstar Depths",16:"Yoshi's Island",17:"Green Greens",18:"Fourside",
  22:"Venom",23:"Poké Floats",24:"Big Blue",27:"Flat Zone",
  28:"Dream Land N64",29:"Yoshi's Island N64",30:"Kongo Jungle N64",
  31:"Battlefield",32:"Final Destination",
};

// ─── helpers ──────────────────────────────────────────────────────────────────
const $ = (id) => document.getElementById(id);
const fmtDate = (s) => s ? new Date(s).toLocaleDateString() : "?";
const fmtFrames = (f) => {
  if (f == null || f === "" || Number.isNaN(Number(f))) return "?";
  const n = Number(f);
  const s = Math.round(n / 60);
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${String(r).padStart(2, "0")}`;
};
const charName = (id) => CHARS[id] ?? (id!=null?`Char ${id}`:"?");

function charIcon(charId, costume = 0, showName = true) {
  if (charId == null) return `<span class="hint">?</span>`;
  const c = costume ?? 0;
  const name = charName(charId);
  const imgSrc = `/assets/characters/${charId}_${c}.png`;
  const fallback = `/assets/characters/${charId}_0.png`;
  return `<span class="char-icon">
    <img src="${imgSrc}" onerror="this.src='${fallback}';this.onerror=null" alt="${name}" title="${name} (costume ${c})" />
    ${showName ? `<span class="char-name">${name}</span>` : ""}
  </span>`;
}
const stageName = (id) => STAGES[id] ?? (id!=null?`Stage ${id}`:"?");
const pct = (a, b) => b ? `${Math.round(a/b*100)}%` : "?";
const MONTH_OPTIONS = [
  { value: "", label: "All months" },
  { value: "1", label: "January" },
  { value: "2", label: "February" },
  { value: "3", label: "March" },
  { value: "4", label: "April" },
  { value: "5", label: "May" },
  { value: "6", label: "June" },
  { value: "7", label: "July" },
  { value: "8", label: "August" },
  { value: "9", label: "September" },
  { value: "10", label: "October" },
  { value: "11", label: "November" },
  { value: "12", label: "December" },
];

function escAttr(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;");
}

function fmtLcancel(p) {
  if (p.lcancel_total > 0 && p.lcancel_success != null) {
    return ((p.lcancel_success / p.lcancel_total) * 100).toFixed(1) + "%";
  }
  if (p.lcancel_rate != null) return (p.lcancel_rate * 100).toFixed(1) + "%";
  return "—";
}

function fmtElo(n) {
  return Number.isFinite(Number(n)) ? String(Math.round(Number(n))) : "—";
}

function rankedBadge(ranked) {
  const r = ranked?.current;
  if (!r) return `<span class="hint">—</span>`;
  return `
    <span class="ranked-badge" title="${escAttr(r.name)} · ${fmtElo(r.elo)} ELO">
      <img src="${escAttr(r.iconPath)}" alt="${escAttr(r.name)}" />
      <span>${escAttr(r.name)}</span>
      <span class="hint">${fmtElo(r.elo)}</span>
    </span>
  `;
}

function rankedTableCell(ranked) {
  const r = resolveRankForTables(ranked);
  if (!r) return "—";
  return `
    <span class="ranked-table-cell" title="${escAttr(r.name)} · ${fmtElo(r.elo)} ELO">
      <img src="${escAttr(r.iconPath)}" alt="${escAttr(r.name)}" />
      <span>${escAttr(r.name)}</span>
    </span>
  `;
}

function resolveRankForTables(ranked) {
  const current = ranked?.current;
  if (current && current.key !== "none" && current.key !== "pending") return current;
  return ranked?.best ?? current ?? null;
}

async function api(path, opts) {
  const r = await fetch("/api" + path, opts);
  return r.json();
}

// ─── charts ───────────────────────────────────────────────────────────────────
const charts = {};
const stackedTotalsPlugin = {
  id: "stackedTotalsPlugin",
  afterDatasetsDraw(chart) {
    const { ctx, scales: { x, y } } = chart;
    const wins = chart.data.datasets[0]?.data ?? [];
    const losses = chart.data.datasets[1]?.data ?? [];
    ctx.save();
    ctx.fillStyle = "#dce8f5";
    ctx.font = "600 11px Rajdhani";
    ctx.textAlign = "center";
    for (let i = 0; i < x.ticks.length; i++) {
      const total = Number(wins[i] ?? 0) + Number(losses[i] ?? 0);
      const xPos = x.getPixelForValue(i);
      const yPos = y.getPixelForValue(total) - 6;
      ctx.fillText(String(total), xPos, yPos);
    }
    ctx.restore();
  },
};

function renderStackedWL(id, labels, wins, losses) {
  const ctx = $(id);
  if (!ctx) return;
  charts[id]?.destroy();
  charts[id] = new Chart(ctx, {
    type: "bar",
    data: {
      labels,
      datasets: [
        { label: "Wins", data: wins, backgroundColor: "#4ade80" },
        { label: "Losses", data: losses, backgroundColor: "#ef4444" },
      ],
    },
    plugins: [stackedTotalsPlugin],
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { labels: { color:"#ccc" } },
        tooltip: {
          callbacks: {
            label(ctx) {
              const winsVal = Number(ctx.chart.data.datasets[0].data[ctx.dataIndex] ?? 0);
              const lossesVal = Number(ctx.chart.data.datasets[1].data[ctx.dataIndex] ?? 0);
              const total = winsVal + lossesVal;
              const val = Number(ctx.raw ?? 0);
              const ratio = total > 0 ? ((val / total) * 100).toFixed(1) : "0.0";
              return `${ctx.dataset.label}: ${val} (${ratio}%)`;
            },
            footer(items) {
              if (!items.length) return "";
              const idx = items[0].dataIndex;
              const winsVal = Number(items[0].chart.data.datasets[0].data[idx] ?? 0);
              const lossesVal = Number(items[0].chart.data.datasets[1].data[idx] ?? 0);
              const total = winsVal + lossesVal;
              const winRatio = total > 0 ? ((winsVal / total) * 100).toFixed(1) : "0.0";
              return `Total: ${total} · Win %: ${winRatio}%`;
            },
          },
        },
      },
      scales: {
        x: { stacked: true, ticks:{ color:"#ccc", maxRotation:30 } },
        y: { stacked: true, beginAtZero: true, ticks:{ color:"#ccc" } },
      },
    },
  });
}

function renderAvgLcancelBars(id, labels, pctValues) {
  const ctx = $(id);
  if (!ctx) return;
  charts[id]?.destroy();
  charts[id] = new Chart(ctx, {
    type: "bar",
    data: {
      labels,
      datasets: [
        {
          label: "Avg L-cancel % (monthly)",
          data: pctValues,
          backgroundColor: "#c8922a",
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { labels: { color: "#ccc" } },
        tooltip: {
          callbacks: {
            label(ctx) {
              const v = ctx.raw;
              return v != null ? `${ctx.dataset.label}: ${v}%` : "No data";
            },
          },
        },
      },
      scales: {
        x: { ticks: { color: "#ccc", maxRotation: 45 } },
        y: {
          beginAtZero: true,
          max: 100,
          ticks: { color: "#ccc", callback: (v) => `${v}%` },
        },
      },
    },
  });
}

// ─── game detail modal ────────────────────────────────────────────────────────
async function openGameDetail(gameId) {
  const d = await api(`/games/${gameId}`);
  if (d.error) return;
  const g = d.game;
  const players = d.players;

  const fmt1dp = (v) => v != null ? v.toFixed(1) : "—";
  const fmtPct = (v) => v != null ? (v * 100).toFixed(1) + "%" : "—";

  const playerHTML = (p) => {
    const won = p.is_winner === 1;
    const lost = p.is_winner === 0;
    return `
      <div class="player-card ${won?"winner":lost?"loser":""}">
        <div class="player-header">
          ${charIcon(p.character_id, p.character_color, false)}
          <div>
            <div style="font-weight:700;font-size:1rem">${charName(p.character_id)}</div>
            <div class="code">${p.connect_code ?? p.display_name ?? "P"+(p.port+1)}</div>
          </div>
          <span class="result-badge ${won?"w":lost?"l":""}">${won?"WIN":lost?"LOSS":"—"}</span>
        </div>
        <div class="stat-row"><span class="s-label">Stocks remaining</span><span class="s-val">${p.end_stocks ?? "—"}</span></div>
        <div class="stat-row"><span class="s-label">Damage done</span><span class="s-val">${fmt1dp(p.damage_done)}</span></div>
        <div class="stat-row"><span class="s-label">Neutral wins</span><span class="s-val">${p.neutral_wins ?? "—"}</span></div>
        <div class="stat-row"><span class="s-label">Conversions</span><span class="s-val">${p.conversions_total ?? "—"}</span></div>
        <div class="stat-row"><span class="s-label">Conversion rate</span><span class="s-val">${fmtPct(p.conversion_rate)}</span></div>
        <div class="stat-row"><span class="s-label">Openings / kill</span><span class="s-val">${fmt1dp(p.openings_per_kill)}</span></div>
        <div class="stat-row"><span class="s-label">Dmg / opening</span><span class="s-val">${fmt1dp(p.damage_per_opening)}</span></div>
        <div class="stat-row"><span class="s-label">L-cancel %</span><span class="s-val">${fmtLcancel(p)}</span></div>
        <div class="stat-row"><span class="s-label">APM</span><span class="s-val">${fmt1dp(p.inputs_per_minute)}</span></div>
        <div class="stat-row"><span class="s-label">Digital APM</span><span class="s-val">${fmt1dp(p.digital_actions_per_minute)}</span></div>
      </div>`;
  };

  const overlay = document.createElement("div");
  overlay.className = "modal-overlay";
  overlay.innerHTML = `
    <div class="modal">
      <div class="modal-header">
        <div class="modal-title">${stageName(g.stage_id)}</div>
        <button class="modal-close" onclick="this.closest('.modal-overlay').remove()">✕</button>
      </div>
      <div class="match-players">
        ${players.map(playerHTML).join('<div class="vs-divider">VS</div>')}
      </div>
      <div class="modal-meta">
        <span>📅 ${fmtDate(g.played_at)}</span>
        <span>⏱ ${fmtFrames(g.duration_frames)}</span>
        <span>🎮 ${g.platform ?? "—"}</span>
        <span>📁 SLP v${g.slp_version ?? "?"}</span>
      </div>
    </div>`;
  overlay.addEventListener("click", (e) => { if (e.target === overlay) overlay.remove(); });
  document.addEventListener("keydown", function esc(e) { if (e.key==="Escape") { overlay.remove(); document.removeEventListener("keydown",esc); } });
  document.body.appendChild(overlay);
}

// ─── nav ─────────────────────────────────────────────────────────────────────
let currentPage = null;
let _livePoll = null;
const pages = {
  dashboard: { label:"Dashboard", load: loadDashboard },
  live:      { label:"LIVE",      load: loadLive },
  games:     { label:"Games",     load: loadGames },
  opponent:  { label:"Opponents",  load: loadOpponent },
  config:    { label:"Configuration",    load: loadConfig },
};

function showPage(name) {
  if (_livePoll && name !== "live") {
    clearTimeout(_livePoll);
    _livePoll = null;
  }
  for (const p of Object.keys(pages)) {
    $(`page-${p}`).style.display = p === name ? "" : "none";
  }
  document.querySelectorAll(".nav-btn").forEach(b => b.classList.toggle("active", b.dataset.page === name));
  currentPage = name;
  pages[name].load();
}

function initNav() {
  const nav = $("nav-links");
  nav.innerHTML = Object.entries(pages).map(([k,v]) =>
    `<button class="nav-btn" data-page="${k}" onclick="showPage('${k}')">${v.label}</button>`
  ).join("");
  window.showPage = showPage;
}

async function updateDbStats() {
  const r = await api("/db/stats");
  $("db-stats").textContent = `${r.games} games`;
}

// ─── CONFIG ───────────────────────────────────────────────────────────────────
let _ingestPoll = null;
let _ingestRateSamples = [];

/** @param {number | undefined} ms */
function fmtDuration(ms) {
  if (ms == null || ms < 0) return "—";
  let sec = Math.round(ms / 1000);
  const h = Math.floor(sec / 3600);
  sec %= 3600;
  const m = Math.floor(sec / 60);
  sec %= 60;
  if (h > 0) return `${h}h ${m}m ${sec}s`;
  if (m > 0) return `${m}m ${sec}s`;
  return `${sec}s`;
}

function updateIngestUI(running, progress, dbStats, backfill) {
  const btn  = $("ingest-btn");
  const stop = $("ingest-stop");
  if (!btn) return;
  const busy = running || backfill?.running;
  btn.disabled = busy;
  btn.textContent = busy ? "Processing…" : "Run Ingest";
  if (stop) stop.style.display = busy ? "" : "none";
  if (!busy) _ingestRateSamples = [];
  if (progress) {
    const p = progress;
    const dbAddedGames = dbStats?.addedGamesThisRun ?? 0;
    const dbGames = dbStats?.games ?? 0;
    const dbPlayers = dbStats?.players ?? 0;
    const showLoadingOnly = running && p.processed === 0;
    const pct = p.total ? Math.round((dbAddedGames / p.total) * 100) : 0;
    const sessionStart = p.startedAtMs;
    const elapsedMs = sessionStart ? Date.now() - sessionStart : 0;
    const elapsedSec = sessionStart ? Math.max(elapsedMs / 1000, 0.001) : 0;
    const avgRate = elapsedSec > 0 ? (p.processed / elapsedSec) : 0;
    const now = Date.now();
    _ingestRateSamples.push({ ts: now, processed: p.processed });
    const windowMs = 5000;
    _ingestRateSamples = _ingestRateSamples.filter((s) => now - s.ts <= windowMs);
    const base = _ingestRateSamples[0];
    const currentRate =
      base && now > base.ts ? ((p.processed - base.processed) / ((now - base.ts) / 1000)) : 0;
    if (showLoadingOnly) {
      $("ingest-result").innerHTML = `
        <div class="ingest-result">
          <div class="ingest-loading">
            <span class="spinner" aria-hidden="true"></span>
            <span>Phase 1/2: Ingesting games...</span>
            <span>Elapsed: <b>${fmtDuration(elapsedMs)}</b></span>
          </div>
        </div>`;
      return;
    }
    const phaseText = running
      ? "Phase 1/2: Ingesting to DB"
      : backfill?.running
        ? "Phase 2/2: Parsing stats backfill"
        : "Completed";
    const bfTotal = backfill?.total ?? 0;
    const bfProcessed = backfill?.processed ?? 0;
    const bfPct = bfTotal ? Math.round((bfProcessed / bfTotal) * 100) : 0;
    const endMs =
      busy
        ? null
        : backfill?.endedAtMs ?? p.endedAtMs;
    const totalRunMs =
      sessionStart && endMs != null ? endMs - sessionStart : null;
    const phase1Ms =
      sessionStart && p.endedAtMs != null ? p.endedAtMs - sessionStart : null;
    const phase2Ms =
      bfTotal > 0 && backfill?.startedAtMs && backfill?.endedAtMs
        ? backfill.endedAtMs - backfill.startedAtMs
        : null;
    const timeLines = busy
      ? `<span>Elapsed: <b>${fmtDuration(elapsedMs)}</b></span>`
      : `<span>Total time (full run): <b>${fmtDuration(totalRunMs)}</b></span>` +
        (phase1Ms != null
          ? `<span>Phase 1 (DB ingest): <b>${fmtDuration(phase1Ms)}</b></span>`
          : "") +
        (phase2Ms != null
          ? `<span>Phase 2 (stats backfill): <b>${fmtDuration(phase2Ms)}</b></span>`
          : "");
    $("ingest-result").innerHTML = `
      <div class="ingest-result"><div>
        <span>Phase: <b>${phaseText}</b></span>
        ${timeLines}
        <span>Progress (DB): <b>${dbAddedGames}/${p.total} (${pct}%)</b></span>
        <span>Parsed: <b>${p.parsed ?? p.processed}</b></span>
        <span>Current games/second: <b>${currentRate.toFixed(1)}</b></span>
        <span>Avg games/second: <b>${avgRate.toFixed(1)}</b></span>
        <span>Inserted: <b>${p.inserted}</b></span>
        <span>Skipped: <b>${p.skipped}</b></span>
        <span>Too short: <b>${p.tooShort}</b></span>
        <span>Errors: <b>${p.errors}</b></span>
        <span>Games in DB: <b>${dbGames}</b></span>
        <span>Players in DB: <b>${dbPlayers}</b></span>
        <span>Backfill stats: <b>${bfProcessed}/${bfTotal} (${bfPct}%)</b></span>
      </div></div>`;
  }
}

function startIngestPoll() {
  if (_ingestPoll) return;
  _ingestPoll = setInterval(async () => { // 400ms poll
    const s = await api("/ingest/status");
    updateIngestUI(s.running, s.progress, s.db, s.backfill);
    if (!s.running && !s.backfill?.running) {
      clearInterval(_ingestPoll);
      _ingestPoll = null;
      updateDbStats();
    }
  }, 400);
}

async function loadConfig() {
  const el = $("page-config");
  const [cfg, status] = await Promise.all([api("/config"), api("/ingest/status")]);

  el.innerHTML = `
    <h2>Configuration</h2>
    <section>
      <h3>My Connect Codes</h3>
      <div id="codes-list" class="code-list">
        ${cfg.codes.map(c => `
          <div class="tag">
            <span>${c}</span>
            <button onclick="removeCode('${c}')">×</button>
          </div>`).join("") || "<p class='hint'>No codes yet.</p>"}
      </div>
      <form onsubmit="addCode(event)" class="inline-form">
        <input id="inp-code" placeholder="ABCD#123" />
        <button type="submit">Add</button>
      </form>
    </section>

    <section>
      <h3>Replay Directories</h3>
      <div id="dirs-list" class="dir-list">
        ${cfg.dirs.map(d => `
          <div class="dir-row">
            <span>${d.path}</span>
            <button onclick="removeDir(${d.id})">Remove</button>
          </div>`).join("") || "<p class='hint'>No directories yet.</p>"}
      </div>
      <form onsubmit="addDir(event)" class="inline-form">
        <input id="inp-dir" placeholder="/home/user/Slippi" style="width:320px" />
        <button type="submit">Add</button>
      </form>
    </section>

    <section>
      <h3>Ingest</h3>
      <p class="hint">Scans all directories. Skips &lt;30s games and already-imported files.</p>
      <div style="display:flex;gap:.5rem;align-items:center">
        <button id="ingest-btn" onclick="runIngest()" class="btn-primary">Run Ingest</button>
        <button id="ingest-stop" onclick="stopIngest()" style="display:none;background:#7f1d1d;border-color:#991b1b;color:#fca5a5">Stop</button>
      </div>
      <div id="ingest-result" style="margin-top:.75rem"></div>
    </section>

    <section>
      <h3>Scheduled ingest</h3>
      <p class="hint">While this app is running, runs a full ingest every 8 hours (same as Run Ingest). Does not run if the app is closed.</p>
      <label style="display:flex;align-items:center;gap:.5rem;cursor:pointer;margin-top:.35rem">
        <input type="checkbox" id="auto-ingest-8h" ${cfg.autoIngest8h ? "checked" : ""} onchange="setAutoIngest8h(this.checked)" />
        <span>Auto-ingest every 8 hours</span>
      </label>
      <label style="display:flex;align-items:center;gap:.5rem;cursor:pointer;margin-top:.55rem">
        <input type="checkbox" id="auto-start" ${cfg.autoStart ? "checked" : ""} onchange="setAutoStart(this.checked)" />
        <span>Open Slippi World on system startup</span>
      </label>
    </section>

    <section>
      <h3>Database</h3>
      <p class="hint">Deletes imported games and stats. Keeps your connect codes and replay directories.</p>
      <div style="display:flex;gap:.5rem;align-items:center">
        <button id="db-reset-btn" onclick="resetDatabase()" style="background:#7f1d1d;border-color:#991b1b;color:#fca5a5">Delete Imported Data</button>
      </div>
      <div id="db-reset-result" class="hint" style="margin-top:.6rem"></div>
    </section>
  `;

  // restore state if ingest is already running
  updateIngestUI(status.running, status.progress, status.db, status.backfill);
  if (status.running || status.backfill?.running) startIngestPoll();

  window.removeCode = async (code) => {
    await api(`/config/codes/${encodeURIComponent(code)}`, { method:"DELETE" });
    loadConfig();
  };
  window.addCode = async (e) => {
    e.preventDefault();
    const code = $("inp-code").value.trim();
    if (!code) return;
    await api("/config/codes", { method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify({code}) });
    loadConfig();
  };
  window.removeDir = async (id) => {
    await api(`/config/dirs/${id}`, { method:"DELETE" });
    loadConfig();
  };
  window.addDir = async (e) => {
    e.preventDefault();
    const path = $("inp-dir").value.trim();
    if (!path) return;
    await api("/config/dirs", { method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify({path}) });
    loadConfig();
  };
  window.setAutoIngest8h = async (enabled) => {
    const cb = $("auto-ingest-8h");
    if (cb) cb.disabled = true;
    const res = await api("/config/auto-ingest-8h", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled }),
    });
    if (res.error && cb) cb.checked = !enabled;
    if (cb) cb.disabled = false;
  };
  window.setAutoStart = async (enabled) => {
    const cb = $("auto-start");
    if (cb) cb.disabled = true;
    const res = await api("/config/auto-start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled }),
    });
    if (res.error) {
      if (cb) cb.checked = !enabled;
      alert(res.error);
    }
    if (cb) cb.disabled = false;
  };
  window.runIngest = async () => {
    updateIngestUI(true, null);
    $("ingest-result").innerHTML = `<div class="ingest-result"><div><span>Scanning files…</span></div></div>`;
    const res = await api("/ingest", { method:"POST" });
    if (res.error) { updateIngestUI(false, null); return; }
    startIngestPoll();
  };
  window.stopIngest = async () => {
    await api("/ingest/stop", { method:"POST" });
    $("ingest-stop").disabled = true;
    $("ingest-stop").textContent = "Stopping…";
  };
  window.resetDatabase = async () => {
    if (!confirm("This will delete all imported games/stats. Continue?")) return;
    const btn = $("db-reset-btn");
    const out = $("db-reset-result");
    btn.disabled = true;
    out.textContent = "Deleting data…";
    const res = await api("/db/reset", { method:"POST" });
    if (res.error) {
      out.textContent = res.error;
      btn.disabled = false;
      return;
    }
    out.textContent = `Deleted ${res.cleared.games} games, ${res.cleared.players} players, ${res.cleared.errors} errors.`;
    await updateDbStats();
    btn.disabled = false;
  };
}

// ─── DASHBOARD ────────────────────────────────────────────────────────────────
const dashboardFilters = { year: "", month: "" };
function dashboardStatsParams() {
  const p = new URLSearchParams();
  if (dashboardFilters.year) p.set("year", dashboardFilters.year);
  if (dashboardFilters.month && dashboardFilters.year) p.set("month", dashboardFilters.month);
  return p.toString();
}

async function loadDashboard() {
  const el = $("page-dashboard");
  const nowYear = new Date().getFullYear();
  const yearOptions = ['<option value="">All years</option>']
    .concat(
      Array.from({ length: 12 }, (_, i) => {
        const y = String(nowYear - i);
        return `<option value="${y}" ${dashboardFilters.year === y ? "selected" : ""}>${y}</option>`;
      })
    )
    .join("");
  const monthOptions = MONTH_OPTIONS
    .map((m) => `<option value="${m.value}" ${dashboardFilters.month === m.value ? "selected" : ""}>${m.label}</option>`)
    .join("");
  const qs = dashboardStatsParams();
  const suffix = qs ? `?${qs}` : "";
  const [d, trends, matchups] = await Promise.all([
    api(`/stats/overview${suffix}`),
    api(`/stats/trends${suffix}`),
    api(`/stats/matchups${suffix}`),
  ]);

  if (!d.totals?.total_games) {
    el.innerHTML = `<h2>Dashboard</h2><p class="hint empty">No data yet — add directories in Config and run Ingest.</p>`;
    return;
  }

  const t = d.totals;
  const total = (t.wins ?? 0) + (t.losses ?? 0);
  const wr = total ? pct(t.wins, total) : "—";
  const mostUsed = d.byCharacter?.length
    ? `${charIcon(d.byCharacter[0].character_id, 0, true)} <span class="hint">${d.byCharacter[0].games} games</span>`
    : "—";
  const rankedMatchups = (matchups.rows ?? [])
    .filter((row) => (row.games ?? 0) >= 100)
    .map((row) => ({
      label: `${charIcon(row.my_char, 0, true)} <span class="hint">vs</span> ${charIcon(row.opp_char, 0, true)}`,
      winPct: row.games ? (row.wins / row.games) * 100 : 0,
      games: row.games ?? 0,
    }));
  const bestMatchup = rankedMatchups.length
    ? [...rankedMatchups].sort((a, b) => b.winPct - a.winPct)[0]
    : null;
  const worstMatchup = rankedMatchups.length
    ? [...rankedMatchups].sort((a, b) => a.winPct - b.winPct)[0]
    : null;
  const myBestRank = d.myRanked?.best;
  const myBestText = myBestRank ? `${myBestRank.name} · ${fmtElo(myBestRank.elo)} ELO` : "—";

  el.innerHTML = `
    <h2>Dashboard</h2>
    <div class="filters" style="margin:.5rem 0 1rem 0">
      <label class="hint" for="dash-year">Year</label>
      <select id="dash-year">${yearOptions}</select>
      <label class="hint" for="dash-month">Month</label>
      <select id="dash-month">${monthOptions}</select>
      <button onclick="applyDashboardFilters()">Apply</button>
      <button class="hint" onclick="clearDashboardFilters()">All time</button>
    </div>
    <div class="stat-grid">
      <div class="stat-card"><div class="stat-val">${t.total_games ?? "—"}</div><div class="stat-label">Total Games</div></div>
      <div class="stat-card"><div class="stat-val">${wr}</div><div class="stat-label">Win Rate</div></div>
      <div class="stat-card"><div class="stat-val">${t.wins ?? "—"}</div><div class="stat-label">Wins</div></div>
      <div class="stat-card"><div class="stat-val">${t.losses ?? "—"}</div><div class="stat-label">Losses</div></div>
      <div class="stat-card"><div class="stat-val">${(t.total_hours ?? 0)}h</div><div class="stat-label">Hours Played</div></div>
      <div class="stat-card"><div class="stat-val stat-val--small">${mostUsed}</div><div class="stat-label">Most Used Character</div></div>
      <div class="stat-card"><div class="stat-val stat-val--small">${rankedBadge(d.myRanked)}</div><div class="stat-label">My current rank ${d.myPrimaryCode ? `(${escAttr(d.myPrimaryCode)})` : ""}</div></div>
      <div class="stat-card"><div class="stat-val stat-val--small">${escAttr(myBestText)}</div><div class="stat-label">My best rank</div></div>
      <div class="stat-card"><div class="stat-val stat-val--small">${bestMatchup ? `${bestMatchup.winPct.toFixed(1)}%` : "—"}</div><div class="stat-label">Best Matchup ${bestMatchup ? `(${bestMatchup.games} games)` : "(min 100 games)"}</div><div class="stat-sub">${bestMatchup?.label ?? ""}</div></div>
      <div class="stat-card"><div class="stat-val stat-val--small">${worstMatchup ? `${worstMatchup.winPct.toFixed(1)}%` : "—"}</div><div class="stat-label">Worst Matchup ${worstMatchup ? `(${worstMatchup.games} games)` : "(min 100 games)"}</div><div class="stat-sub">${worstMatchup?.label ?? ""}</div></div>
    </div>
    <div class="dashboard-charts">
      <section class="chart-panel">
        <h3>By character (wins / losses)</h3>
        <div class="chart-canvas-wrap"><canvas id="charChart"></canvas></div>
      </section>
      <section class="chart-panel">
        <h3>By stage</h3>
        <div class="chart-canvas-wrap"><canvas id="stageChart"></canvas></div>
      </section>
      <section class="chart-panel">
        <h3>Results by month</h3>
        <div class="chart-canvas-wrap"><canvas id="trendChart"></canvas></div>
      </section>
      <section class="chart-panel">
        <h3>Character matchups (you vs opponent)</h3>
        <div class="chart-canvas-wrap"><canvas id="matchupChart"></canvas></div>
      </section>
    </div>
  `;

  window.openGameDetail = openGameDetail;

  if (d.byCharacter?.length) {
    const chars = d.byCharacter.slice(0, 10);
    renderStackedWL(
      "charChart",
      chars.map(c => charName(c.character_id)),
      chars.map((c) => c.wins ?? 0),
      chars.map((c) => Math.max((c.games ?? 0) - (c.wins ?? 0), 0)),
    );
  }
  if (d.byStage?.length) {
    const stages = d.byStage.slice(0, 10);
    renderStackedWL(
      "stageChart",
      stages.map(s => stageName(s.stage_id)),
      stages.map((s) => s.wins ?? 0),
      stages.map((s) => Math.max((s.games ?? 0) - (s.wins ?? 0), 0)),
    );
  }

  if (trends.monthly?.length) {
    const m = trends.monthly;
    const labels = m.map((x) => x.month);
    const wins = m.map((x) => x.wins ?? 0);
    const losses = m.map((x) => Math.max((x.games ?? 0) - (x.wins ?? 0), 0));
    renderStackedWL("trendChart", labels, wins, losses);
  }

  if (matchups.rows?.length) {
    const r = matchups.rows.slice(0, 20);
    renderStackedWL(
      "matchupChart",
      r.map((row) => `${charName(row.my_char)} vs ${charName(row.opp_char)}`),
      r.map((row) => row.wins ?? 0),
      r.map((row) => Math.max((row.games ?? 0) - (row.wins ?? 0), 0)),
    );
  }
  window.applyDashboardFilters = () => {
    const yearEl = $("dash-year");
    const monthEl = $("dash-month");
    dashboardFilters.year = yearEl?.value ?? "";
    dashboardFilters.month = monthEl?.value ?? "";
    if (!dashboardFilters.year) dashboardFilters.month = "";
    loadDashboard();
  };
  window.clearDashboardFilters = () => {
    dashboardFilters.year = "";
    dashboardFilters.month = "";
    loadDashboard();
  };
}

// ─── LIVE (newest “hot” replay under Config watch folders) ────────────────────
async function loadLive() {
  if (_livePoll) {
    clearTimeout(_livePoll);
    _livePoll = null;
  }
  const el = $("page-live");
  window.openGameDetail = openGameDetail;
  window.goOpponent = (code) => {
    if (!code) return;
    _oppPreload = code;
    showPage("opponent");
  };

  function liveOpponentBlock(L) {
    function liveRankedCard() {
      const ranked = L.opponentRanked;
      if (!ranked?.current) return "";
      const current = ranked.current;
      const best = ranked.best;
      const fmtElo = (n) => (Number.isFinite(Number(n)) ? Math.round(Number(n)) : "—");
      const bestDiffers = best && (best.elo > current.elo + 0.01 || best.key !== current.key);
      return `
        <div class="live-ranked-card">
          <div class="live-ranked-card-head">
            <img src="${escAttr(current.iconPath)}" alt="${escAttr(current.name)}" class="live-ranked-icon" />
            <div>
              <div class="live-ranked-title">Ranked (Slippi)</div>
              <div class="live-ranked-tag">${escAttr(ranked.connectCode ?? L.opponentCode ?? "—")}</div>
            </div>
          </div>
          <div class="live-ranked-grid">
            <div class="live-ranked-item"><span class="hint">Current rank</span><b>${escAttr(current.name)}</b></div>
            <div class="live-ranked-item"><span class="hint">Current ELO</span><b>${fmtElo(current.elo)}</b></div>
            <div class="live-ranked-item"><span class="hint">Current league</span><b>${escAttr(current.tier)}${current.division ? ` ${escAttr(current.division)}` : ""}</b></div>
            <div class="live-ranked-item"><span class="hint">Current games</span><b>${fmtElo(current.games)}</b></div>
            ${
              bestDiffers
                ? `<div class="live-ranked-item live-ranked-item--best">
                    <span class="hint">Best rank (historic)</span>
                    <b>${escAttr(best.name)} · ${fmtElo(best.elo)} ELO</b>
                    <span class="hint">${escAttr(best.season ?? "")}</span>
                  </div>`
                : `<div class="live-ranked-item live-ranked-item--best">
                    <span class="hint">Best rank</span>
                    <b>Current season peak</b>
                    <span class="hint">${escAttr(current.name)} · ${fmtElo(current.elo)} ELO</span>
                  </div>`
            }
          </div>
        </div>
      `;
    }

    const s = L.opponentInsight?.summary;
    const byStage = L.opponentInsight?.byStage ?? [];
    const hasDbData = s && Number(s.total_games) > 0;
    const total = s ? (s.my_wins ?? 0) + (s.their_wins ?? 0) : 0;
    const wrDb = total ? pct(s.my_wins, total) : null;
    const rankedStages = byStage
      .filter((row) => (row.games ?? 0) > 0)
      .map((row) => ({
        ...row,
        winPctNum: (row.wins ?? 0) / (row.games ?? 1),
      }));
    const bestStage = rankedStages.length
      ? [...rankedStages].sort((a, b) => b.winPctNum - a.winPctNum)[0]
      : null;
    const worstStage = rankedStages.length
      ? [...rankedStages].sort((a, b) => a.winPctNum - b.winPctNum)[0]
      : null;
    const bestStageText = bestStage
      ? `${stageName(bestStage.stage_id)} (${pct(bestStage.wins, bestStage.games)} · ${bestStage.games} games)`
      : "—";
    const worstStageText = worstStage
      ? `${stageName(worstStage.stage_id)} (${pct(worstStage.wins, worstStage.games)} · ${worstStage.games} games)`
      : "—";
    const mains =
      s?.their_chars
        ? s.their_chars
            .split(",")
            .filter(Boolean)
            .map((id) => charIcon(Number(id), 0, true))
            .join(" ")
        : "—";
    const mostPlayedCharacter =
      s?.most_played_char != null
        ? charIcon(Number(s.most_played_char), 0, true)
        : "—";
    const bestCharacter =
      s?.best_char != null
        ? charIcon(Number(s.best_char), 0, true)
        : "—";
    const characterInsights = `
      <div><span class="hint">Most played:</span> ${mostPlayedCharacter}</div>
      <div><span class="hint">Best:</span> ${bestCharacter}</div>
    `;
    const recentRows = (L.opponentInsight?.recentGames ?? [])
      .map(
        (rg) => `
          <tr class="${rg.i_won ? "win" : "loss"}" style="cursor:pointer" onclick="openGameDetail(${rg.id})">
            <td>${fmtDate(rg.played_at)}</td>
            <td>${stageName(rg.stage_id)}</td>
            <td>${charIcon(rg.my_char, 0, true)}</td>
            <td>${charIcon(rg.opp_char, 0, true)}</td>
            <td>${rg.i_won ? "W" : "L"}</td>
          </tr>`
      )
      .join("");
    let oppBody = "";
    if (L.opponentCode) {
      oppBody += `<p><b>Tag:</b> <span class="opp-link" onclick="goOpponent(${JSON.stringify(L.opponentCode)})">${escAttr(L.opponentCode)}</span></p>`;
      oppBody += liveRankedCard();
      if (L.opponentHint) oppBody += `<p class="hint">${escAttr(L.opponentHint)}</p>`;
      if (hasDbData) {
        oppBody += `<div class="stat-grid live-opp-stat-grid" style="margin-top:.75rem">
            <div class="stat-card"><div class="stat-val">${s.total_games}</div><div class="stat-label">Games vs (1v1)</div></div>
            <div class="stat-card"><div class="stat-val">${wrDb}</div><div class="stat-label">Your win rate</div></div>
            <div class="stat-card"><div class="stat-val">${s.my_wins ?? "—"}</div><div class="stat-label">Your wins</div></div>
            <div class="stat-card"><div class="stat-val">${s.their_wins ?? "—"}</div><div class="stat-label">Their wins</div></div>
            <div class="stat-card"><div class="stat-val stat-val--small">${mains}</div><div class="stat-label">Their characters</div></div>
            <div class="stat-card"><div class="stat-val stat-val--small">${characterInsights}</div><div class="stat-label">Character insights</div></div>
            <div class="stat-card"><div class="stat-val stat-val--small">${bestStageText}</div><div class="stat-label">Best stage</div></div>
            <div class="stat-card"><div class="stat-val stat-val--small">${worstStageText}</div><div class="stat-label">Worst stage</div></div>
          </div>
          <h4 style="margin-top:1rem">Recent recorded games</h4>
          <table>
            <thead><tr><th>Date</th><th>Stage</th><th>You</th><th>Them</th><th>Result</th></tr></thead>
            <tbody>${recentRows || "<tr><td colspan=5 class='hint'>No rows.</td></tr>"}</tbody>
          </table>`;
      } else {
        oppBody += `<p class="hint">No data in database.</p>`;
      }
    } else {
      oppBody += `<p class="hint">${escAttr(L.opponentHint ?? "No opponent tag detected yet.")}</p>`;
    }
    return `<h3 class="live-opp-title">LAST OPPONENT</h3>${oppBody}`;
  }

  function liveStatusBanner(playing) {
    if (playing) {
      return `<div class="live-page-status live-page-status--playing" role="status"><p class="live-page-status-msg"><span class="live-page-status-k">Status:</span> Playing! Good Luck!</p></div>`;
    }
    return `<div class="live-page-status live-page-status--waiting" role="status"><p class="live-page-status-msg"><span class="live-page-status-k">Status:</span> Waiting for a new game...</p></div>`;
  }

  const paint = async () => {
    const L = await api("/live");

    let body = "";
    let pollMs = 3200;

    if (L.snapshot?.players) {
      const snap = L.snapshot;
      const g = snap.game;
      const hot = L.fileHot !== false;
      pollMs = hot ? 900 : 2200;

      const playersHtml = snap.players
        .map(
          (p) => `
        <div class="live-player-card">
          <div class="live-player-head">
            ${charIcon(p.characterId, p.characterColor ?? 0, true)}
            <div>
              <div><b>Tag:</b> ${escAttr(p.connectCode ?? "—")}</div>
              <div class="hint">${escAttr(p.displayName ?? "")}</div>
            </div>
          </div>
        </div>`
        )
        .join("");

      const oppSection = liveOpponentBlock(L);

      body = `
        ${liveStatusBanner(true)}
        <div class="live-match">
          <h3>Current match</h3>
          <p><b>Stage:</b> ${stageName(g.stageId)} · <b>Teams:</b> ${g.isTeams ? "yes" : "no"}</p>
          <p class="hint" style="margin:.35rem 0 .75rem">Last touched: <b>${fmtDuration(L.file?.ageMs)}</b> ago · In-game time: <b>${fmtFrames(g.durationFrames)}</b></p>
          <div class="live-players">${playersHtml}</div>
        </div>
        ${oppSection}`;
    } else if (L.reason === "game_finished") {
      pollMs = 1300;
      body = `${liveStatusBanner(false)}
        ${liveOpponentBlock(L)}`;
    } else if (L.parseError) {
      pollMs = L.fileHot !== false ? 1200 : 2800;
      body = `
        ${liveStatusBanner(false)}
        <div class="live-parse-error">
          <p><code>${escAttr(L.file?.path ?? "")}</code></p>
          <p class="hint">Last touched: <b>${fmtDuration(L.file?.ageMs)}</b> ago</p>
          <p><b>Read error:</b> ${escAttr(L.parseError)}</p>
          ${L.opponentHint ? `<p class="hint">${escAttr(L.opponentHint)}</p>` : ""}
        </div>`;
    } else if (!L.active && (L.reason === "no_directories" || L.reason === "no_slp_files")) {
      pollMs = 5000;
      body = `${liveStatusBanner(false)}
        <p class="hint" style="margin-top:.75rem">${escAttr(L.hint ?? "")}</p>`;
    } else {
      pollMs = 4000;
      body = `${liveStatusBanner(false)}
        <p class="hint" style="margin-top:.75rem">${escAttr(L.hint ?? "")}</p>`;
    }

    el.innerHTML = `<h2>LIVE</h2>${body}`;
    return pollMs;
  };

  const livePollLoop = async () => {
    if (currentPage !== "live") {
      _livePoll = null;
      return;
    }
    let delay = 3000;
    try {
      delay = await paint();
    } catch (e) {
      console.error(e);
    }
    if (currentPage !== "live") {
      _livePoll = null;
      return;
    }
    delay = Math.min(12000, Math.max(350, delay));
    _livePoll = setTimeout(livePollLoop, delay);
  };
  livePollLoop();
}

// ─── GAMES ────────────────────────────────────────────────────────────────────
let gamesPage = 1;
let gamesLoading = false;
let gamesHasMore = true;
let gamesRequestSeq = 0;
const gamesFilters = { stage:"", char:"", opp:"", result:"", from:"", to:"" };

function gamesFilterParams(page) {
  const p = new URLSearchParams({ page, limit: 50 });
  if (gamesFilters.stage)  p.set("stage",  gamesFilters.stage);
  if (gamesFilters.char)   p.set("char",   gamesFilters.char);
  if (gamesFilters.opp)    p.set("opp",    gamesFilters.opp);
  if (gamesFilters.result) p.set("result", gamesFilters.result);
  if (gamesFilters.from)   p.set("from",   gamesFilters.from);
  if (gamesFilters.to)     p.set("to",     gamesFilters.to);
  return p;
}

// stage options for select
const STAGE_OPTIONS = Object.entries(STAGES).map(([id,name]) =>
  `<option value="${id}">${name}</option>`).join("");
const CHAR_OPTIONS = Object.entries(CHARS).filter(([id]) => Number(id) <= 25).map(([id,name]) =>
  `<option value="${id}">${name}</option>`).join("");

async function loadGames(reset = false) {
  const el = $("page-games");
  const f = gamesFilters;

  if (reset || !$("games-tbody")) {
    gamesPage = 1;
    gamesHasMore = true;
    el.innerHTML = `
      <h2>Games</h2>
      <div class="filters">
        <select id="f-stage" onchange="setFilter('stage',this.value)">
          <option value="">All stages</option>${STAGE_OPTIONS}
        </select>
        <select id="f-char" onchange="setFilter('char',this.value)">
          <option value="">All chars</option>${CHAR_OPTIONS}
        </select>
        <input id="f-opp" placeholder="Opponent code" value="${f.opp}"
               style="width:130px" oninput="setFilter('opp',this.value)" />
        <select id="f-result" onchange="setFilter('result',this.value)">
          <option value="">All results</option>
          <option value="win">Wins</option>
          <option value="loss">Losses</option>
        </select>
        <input id="f-from" type="date" value="${f.from}" onchange="setFilter('from',this.value)" />
        <span class="hint">→</span>
        <input id="f-to"   type="date" value="${f.to}"   onchange="setFilter('to',this.value)" />
        <button onclick="clearFilters()" class="hint" style="margin-left:.25rem">✕ Clear</button>
      </div>
      <div class="toolbar" style="margin-top:.5rem">
        <span class="hint">Total: <b id="games-total">0</b></span>
        <span class="hint">Loaded: <b id="games-loaded">0</b></span>
      </div>
      <table>
        <thead><tr><th></th><th>Date</th><th>Stage</th><th>Duration</th><th>My Char</th><th>Opponent</th><th>Opp Char</th><th>Result</th></tr></thead>
        <tbody id="games-tbody"></tbody>
      </table>
      <div id="games-loading" class="hint" style="margin-top:.75rem;display:none">Loading more games…</div>
      <div id="games-end" class="hint" style="margin-top:.75rem"></div>
    `;
  }

  if (gamesLoading || !gamesHasMore || currentPage !== "games") return;
  gamesLoading = true;
  const requestSeq = ++gamesRequestSeq;
  const loadingEl = $("games-loading");
  if (loadingEl) loadingEl.style.display = "";
  try {
    const d = await api(`/games?${gamesFilterParams(gamesPage)}`);
    if (requestSeq !== gamesRequestSeq) return;

    const tbody = $("games-tbody");
    if (!tbody) return;
    if (gamesPage === 1 && !d.rows.length) {
      tbody.innerHTML = "<tr><td colspan=8 class='hint' style='padding:1rem'>No games match filters.</td></tr>";
      gamesHasMore = false;
    } else {
      const rowsHtml = d.rows.map(g => `
        <tr class="${g.i_won===1?"win":g.i_won===0?"loss":""}" style="cursor:pointer" onclick="openGameDetail(${g.id})">
          <td style="width:8px;padding:0;background:${g.i_won===1?"var(--win-border)":g.i_won===0?"var(--loss-border)":"transparent"}"></td>
          <td>${fmtDate(g.played_at)}</td>
          <td>${stageName(g.stage_id)}</td>
          <td>${fmtFrames(g.duration_frames)}</td>
          <td>${charIcon(g.my_char, 0, true)}</td>
          <td class="opp-link" onclick="event.stopPropagation();goOpponent('${g.opp_code??""}')">${g.opp_code ?? g.opp_name ?? "?"}</td>
          <td>${charIcon(g.opp_char, 0, true)}</td>
          <td class="${g.i_won===1?"badge-w":g.i_won===0?"badge-l":"badge-u"}">${g.i_won===1?"WIN":g.i_won===0?"LOSS":"—"}</td>
        </tr>`).join("");
      if (gamesPage === 1) {
        tbody.innerHTML = rowsHtml;
      } else {
        tbody.insertAdjacentHTML("beforeend", rowsHtml);
      }
    }

    const totalEl = $("games-total");
    if (totalEl) totalEl.textContent = String(d.total ?? 0);
    const loadedEl = $("games-loaded");
    if (loadedEl) loadedEl.textContent = String(Math.min((gamesPage - 1) * 50 + d.rows.length, d.total ?? 0));
    gamesHasMore = d.rows.length === 50;
    const endEl = $("games-end");
    if (endEl) endEl.textContent = gamesHasMore ? "" : "No more games to load.";
    if (gamesHasMore) gamesPage += 1;
  } finally {
    if (loadingEl) loadingEl.style.display = "none";
    gamesLoading = false;
  }

  // restore select values (initial render resets them)
  if ($("f-stage")) $("f-stage").value = f.stage;
  if ($("f-char"))  $("f-char").value  = f.char;
  if ($("f-result")) $("f-result").value = f.result;

  window.setFilter = (key, val) => {
    gamesFilters[key] = val;
    gamesRequestSeq += 1;
    gamesLoading = false;
    loadGames(true);
  };
  window.clearFilters = () => {
    Object.keys(gamesFilters).forEach(k => gamesFilters[k] = "");
    gamesRequestSeq += 1;
    gamesLoading = false;
    loadGames(true);
  };
  window.goOpponent = (code) => {
    if (!code) return;
    _oppPreload = code;
    showPage("opponent");
  };
  window.openGameDetail = openGameDetail;
  window.loadGames = loadGames;
  window.onscroll = () => {
    if (currentPage !== "games" || gamesLoading || !gamesHasMore) return;
    const nearBottom = window.innerHeight + window.scrollY >= document.body.offsetHeight - 260;
    if (nearBottom) loadGames(false);
  };
}

// ─── OPPONENT ─────────────────────────────────────────────────────────────────
function oppDetailHTML(d) {
  const s = d.summary;
  const games = d.games ?? d.recent ?? [];
  const total = (s.my_wins??0)+(s.their_wins??0);
  const current = d.ranked?.current;
  const best = d.ranked?.best;
  const bestLine = best
    ? `${best.name} · ${fmtElo(best.elo)} ELO${best.season ? ` (${best.season})` : ""}`
    : "—";
  return `
    <div class="live-ranked-card" style="margin-top:.25rem;margin-bottom:1rem">
      <div class="live-ranked-card-head">
        ${current?.iconPath ? `<img src="${escAttr(current.iconPath)}" alt="${escAttr(current.name)}" class="live-ranked-icon" />` : ""}
        <div>
          <div class="live-ranked-title">Slippi Ranked</div>
          <div class="live-ranked-tag">${escAttr(d.code ?? "—")}</div>
        </div>
      </div>
      <div class="live-ranked-grid">
        <div class="live-ranked-item"><span class="hint">Current rank</span><b>${escAttr(current?.name ?? "—")}</b></div>
        <div class="live-ranked-item"><span class="hint">Current ELO</span><b>${fmtElo(current?.elo)}</b></div>
        <div class="live-ranked-item live-ranked-item--best">
          <span class="hint">Best rank</span>
          <b>${escAttr(bestLine)}</b>
        </div>
      </div>
    </div>
    <div class="stat-grid" style="margin-top:1rem">
      <div class="stat-card"><div class="stat-val">${s.total_games}</div><div class="stat-label">Games vs</div></div>
      <div class="stat-card"><div class="stat-val">${pct(s.my_wins,total)}</div><div class="stat-label">My Win Rate</div></div>
      <div class="stat-card"><div class="stat-val">${s.my_wins}</div><div class="stat-label">My Wins</div></div>
      <div class="stat-card"><div class="stat-val">${s.their_wins}</div><div class="stat-label">Their Wins</div></div>
    </div>
    <p style="margin:.75rem 0"><b>Their chars:</b> ${(s.their_chars??"").split(",").filter(Boolean).map(id=>charIcon(Number(id), 0, true)).join(" ")}</p>
    <h3>By Stage</h3>
    <table>
      <thead><tr><th>Stage</th><th>Games</th><th>Wins</th><th>Win%</th></tr></thead>
      <tbody>
        ${d.byStage.map(s=>`<tr><td>${stageName(s.stage_id)}</td><td>${s.games}</td><td>${s.wins}</td><td>${pct(s.wins,s.games)}</td></tr>`).join("")}
      </tbody>
    </table>
    <h3>Games</h3>
    <table>
      <thead><tr><th>Date</th><th>Stage</th><th>My Char</th><th>Their Char</th><th>Result</th></tr></thead>
      <tbody>
        ${games.map(g=>`
          <tr class="${g.i_won?"win":"loss"}" style="cursor:pointer" onclick="openGameDetail(${g.id})">
            <td>${fmtDate(g.played_at)}</td><td>${stageName(g.stage_id)}</td>
            <td>${charIcon(g.my_char, 0, true)}</td><td>${charIcon(g.opp_char, 0, true)}</td>
            <td>${g.i_won?"W":"L"}</td>
          </tr>`).join("")}
      </tbody>
    </table>`;
}

async function lookupOpponentCode(code, page = 1) {
  const c = String(code ?? "").trim();
  if (!c) return;
  const currentPage = Math.max(1, Number(page) || 1);
  const topSection = $("opp-top-section");
  if (topSection) topSection.style.display = "none";
  const res = $("opp-result");
  $("inp-opp").value = c;
  const d = await api(`/opponent/${encodeURIComponent(c.toUpperCase())}?page=${currentPage}&limit=50`);
  if (!d.summary?.total_games) {
    res.innerHTML = `<p class="hint">No games found vs ${c}.</p>`;
    const pager = $("opp-pager");
    if (pager) pager.innerHTML = "";
    return;
  }
  res.innerHTML = `<h3 style="margin-bottom:.5rem">${c}</h3>` + oppDetailHTML(d);
  const totalGames = Number(d.summary?.total_games ?? 0);
  const totalPages = Math.max(1, Math.ceil(totalGames / 50));
  const pager = $("opp-pager");
  if (pager) {
    pager.innerHTML = `
      <button ${currentPage <= 1 ? "disabled" : ""} onclick="lookupOpponentCode('${escAttr(c)}', ${currentPage - 1})">Prev</button>
      <span class="hint">Page ${currentPage} / ${totalPages} · ${totalGames} games</span>
      <button ${currentPage >= totalPages ? "disabled" : ""} onclick="lookupOpponentCode('${escAttr(c)}', ${currentPage + 1})">Next</button>
    `;
  }
}

window.lookupOpponentCode = lookupOpponentCode;

let _oppPreload = null;

async function loadOpponent() {
  const preloadCode = _oppPreload;
  _oppPreload = null;

  const el = $("page-opponent");
  window.openGameDetail = openGameDetail;
  const showTop = !preloadCode;
  const [top, recentTags] = showTop
    ? await Promise.all([
      api("/opponents/top?limit=20&includeRanked=1"),
      api("/opponents/recent?limit=20&includeRanked=1"),
    ])
    : [[], []];

  el.innerHTML = `
    <h2>Opponents</h2>
    <div style="position:relative;display:inline-block;margin-bottom:1.5rem">
      <form onsubmit="doLookup(event)" class="inline-form">
        <input id="inp-opp" placeholder="Search by code…" autocomplete="off"
               oninput="oppAutocomplete(this.value)" onfocus="oppAutocomplete(this.value)"
               onblur="setTimeout(()=>hideDropdown(),200)" style="width:200px"/>
        <button type="submit">Search</button>
      </form>
      <div id="opp-dropdown" class="dropdown" style="display:none"></div>
    </div>
    ${showTop ? `
    <div id="opp-top-section">
    <h3>Top 20 Opponents</h3>
    <table>
      <thead><tr><th>Code</th><th>Name</th><th>Games</th><th>My W%</th><th>Rank</th><th>ELO</th><th>Their Chars</th><th>Last Played</th></tr></thead>
      <tbody>
        ${top.map(o => {
          const total = (o.my_wins??0)+(o.their_wins??0);
          const chars = (o.their_chars??"").split(",").filter(Boolean).map(id=>charIcon(Number(id), 0, true)).join(" ");
          const rank = resolveRankForTables(o.ranked);
          return `<tr class="opp-link" onclick="lookupOpponentCode('${o.connect_code}')">
            <td><b>${o.connect_code}</b></td>
            <td>${o.names??""}</td>
            <td>${o.games}</td>
            <td>${pct(o.my_wins,total)}</td>
            <td>${rankedTableCell(o.ranked)}</td>
            <td>${fmtElo(rank?.elo)}</td>
            <td>${chars}</td>
            <td>${fmtDate(o.last_played)}</td>
          </tr>`;
        }).join("") || "<tr><td colspan=8 class='hint' style='padding:1rem'>No opponents yet.</td></tr>"}
      </tbody>
    </table>
    <h3 style="margin-top:1rem">Last 20 Opponent Tags Played</h3>
    <table>
      <thead><tr><th>Code</th><th>Name</th><th>Games</th><th>My W%</th><th>Rank</th><th>ELO</th><th>Their Chars</th><th>Last Played</th></tr></thead>
      <tbody>
        ${recentTags.map(o => {
          const total = (o.my_wins??0)+(o.their_wins??0);
          const chars = (o.their_chars??"").split(",").filter(Boolean).map(id=>charIcon(Number(id), 0, true)).join(" ");
          const rank = resolveRankForTables(o.ranked);
          return `<tr class="opp-link" onclick="lookupOpponentCode('${o.connect_code}')">
            <td><b>${o.connect_code}</b></td>
            <td>${o.names ?? ""}</td>
            <td>${o.games}</td>
            <td>${pct(o.my_wins,total)}</td>
            <td>${rankedTableCell(o.ranked)}</td>
            <td>${fmtElo(rank?.elo)}</td>
            <td>${chars}</td>
            <td>${fmtDate(o.last_played)}</td>
          </tr>`;
        }).join("") || "<tr><td colspan=8 class='hint' style='padding:1rem'>No opponents yet.</td></tr>"}
      </tbody>
    </table>
    </div>
    ` : ""}
    <div id="opp-result"></div>
    <div id="opp-pager" class="inline-form" style="margin-top:.75rem;gap:.75rem"></div>
  `;

  window.doLookup = (e) => { e.preventDefault(); const c=$("inp-opp").value.trim(); if(c) lookupOpponentCode(c, 1); };
  window.hideDropdown = () => { const d=$("opp-dropdown"); if(d) d.style.display="none"; };
  window.oppAutocomplete = async (q) => {
    const dd = $("opp-dropdown");
    if (!dd) return;
    if (!q.trim()) { dd.style.display="none"; return; }
    const results = await api(`/opponents/search?q=${encodeURIComponent(q)}`);
    const valid = results.filter((r) => r.connect_code);
    if (!valid.length) { dd.style.display="none"; return; }
    dd.innerHTML = valid
      .map(
        (r) =>
          `<div class="dropdown-item" data-code="${escAttr(r.connect_code)}">${r.connect_code} <span class="hint">${r.names ?? ""} · ${r.games} games</span></div>`
      )
      .join("");
    for (const node of dd.querySelectorAll(".dropdown-item")) {
      node.addEventListener("mousedown", (e) => {
        e.preventDefault();
        const code = node.getAttribute("data-code");
        if (code) lookupOpponentCode(code, 1);
      });
    }
    dd.style.display = "block";
  };

  if (preloadCode) lookupOpponentCode(preloadCode, 1);
}

// ─── init ─────────────────────────────────────────────────────────────────────
initNav();
updateDbStats();
showPage("dashboard");
