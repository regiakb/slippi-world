import { getDb } from "./db/schema";
import {
  ingest,
  stopParserWork,
  getBackfillStatus,
  tryIngestCompletedLiveReplay,
  isRefreshPlayerStocksRunning,
} from "./parser/ingest";
import { parseLiveReplay } from "./parser/live-snapshot";
import { findNewestSlpWithMtime } from "./live/replay-watch";
import { logLiveStartupHint, startLiveTrace } from "./live/live-trace";
import index from "../frontend/index.html";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, normalize } from "node:path";

getDb(); // init DB on startup
logLiveStartupHint();

const PORT = Number(process.env.PORT ?? 7474);
const FRONTEND_DIR = join(import.meta.dir, "../frontend");
const STATIC_ASSETS_DIR = (process.env.STATIC_ASSETS_DIR?.trim() || join(FRONTEND_DIR, "assets")).replace(/[/\\]+$/, "");

// ─── helpers ─────────────────────────────────────────────────────────────────
function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
async function body<T>(req: Request): Promise<T> {
  return req.json() as Promise<T>;
}

function buildYearMonthFilter(req: Request) {
  const u = new URL(req.url);
  const yearRaw = u.searchParams.get("year");
  const monthRaw = u.searchParams.get("month");
  const year = yearRaw ? Number(yearRaw) : null;
  const month = monthRaw ? Number(monthRaw) : null;
  const validYear = Number.isInteger(year) && year! >= 2000 && year! <= 2100 ? year : null;
  const validMonth = Number.isInteger(month) && month! >= 1 && month! <= 12 ? month : null;
  const conditions: string[] = [];
  const params: Record<string, unknown> = {};

  if (validYear && validMonth) {
    const nextYear = validMonth === 12 ? validYear + 1 : validYear;
    const nextMonth = validMonth === 12 ? 1 : validMonth + 1;
    const monthStr = String(validMonth).padStart(2, "0");
    const nextMonthStr = String(nextMonth).padStart(2, "0");
    conditions.push("g.played_at >= $fromDate");
    conditions.push("g.played_at < $toDateExclusive");
    params.$fromDate = `${validYear}-${monthStr}-01T00:00:00`;
    params.$toDateExclusive = `${nextYear}-${nextMonthStr}-01T00:00:00`;
  } else if (validYear) {
    conditions.push("g.played_at >= $fromDate");
    conditions.push("g.played_at < $toDateExclusive");
    params.$fromDate = `${validYear}-01-01T00:00:00`;
    params.$toDateExclusive = `${validYear + 1}-01-01T00:00:00`;
  }

  return { conditions, params };
}

// ─── ingest state ─────────────────────────────────────────────────────────────
let ingestRunning = false;
let lastIngestResult: unknown = null;
const ingestAbort = { stop: false };
let ingestBaseGames = 0;
let ingestBasePlayers = 0;
const ONLY_1V1_SQL = "g.is_teams = 0 AND (SELECT COUNT(*) FROM players px WHERE px.game_id = g.id) = 2";
const LIVE_STALE_MS = Math.max(30_000, Number(process.env.LIVE_REPLAY_STALE_MS ?? 180_000));
const AUTO_INGEST_8H_MS = 8 * 60 * 60 * 1000;
const SLIPPI_GQL_URL = "https://internal.slippi.gg";
const SLIPPI_RANK_CACHE_TTL_MS = 5 * 60 * 1000;
const SLIPPI_RANK_ERROR_TTL_MS = 60 * 1000;
let autoIngest8hInterval: ReturnType<typeof setInterval> | null = null;
let shutdownRequested = false;
type RankedLeague = {
  key: string;
  name: string;
  tier: string;
  division: string | null;
  iconPath: string;
};
type SlippiRankedResult = {
  connectCode: string;
  displayName: string | null;
  current: RankedLeague & { elo: number; games: number };
  best: (RankedLeague & { elo: number; games: number; season: string }) | null;
};
const slippiRankCache = new Map<string, { expiresAt: number; value: SlippiRankedResult | null }>();
const slippiRankInflight = new Map<string, Promise<SlippiRankedResult | null>>();

const LEAGUES: RankedLeague[] = [
  { key: "none", name: "Unranked", tier: "Unranked", division: null, iconPath: "/assets/ranked/rank_Unranked1.svg" },
  { key: "pending", name: "Pending", tier: "Pending", division: null, iconPath: "/assets/ranked/rank_Unranked3.svg" },
  { key: "bronze1", name: "Bronze 1", tier: "Bronze", division: "1", iconPath: "/assets/ranked/rank_Bronze_I.svg" },
  { key: "bronze2", name: "Bronze 2", tier: "Bronze", division: "2", iconPath: "/assets/ranked/rank_Bronze_II.svg" },
  { key: "bronze3", name: "Bronze 3", tier: "Bronze", division: "3", iconPath: "/assets/ranked/rank_Bronze_III.svg" },
  { key: "silver1", name: "Silver 1", tier: "Silver", division: "1", iconPath: "/assets/ranked/rank_Silver_I.svg" },
  { key: "silver2", name: "Silver 2", tier: "Silver", division: "2", iconPath: "/assets/ranked/rank_Silver_II.svg" },
  { key: "silver3", name: "Silver 3", tier: "Silver", division: "3", iconPath: "/assets/ranked/rank_Silver_III.svg" },
  { key: "gold1", name: "Gold 1", tier: "Gold", division: "1", iconPath: "/assets/ranked/rank_Gold_I.svg" },
  { key: "gold2", name: "Gold 2", tier: "Gold", division: "2", iconPath: "/assets/ranked/rank_Gold_II.svg" },
  { key: "gold3", name: "Gold 3", tier: "Gold", division: "3", iconPath: "/assets/ranked/rank_Gold_III.svg" },
  { key: "plat1", name: "Platinum 1", tier: "Platinum", division: "1", iconPath: "/assets/ranked/rank_Platinum_I.svg" },
  { key: "plat2", name: "Platinum 2", tier: "Platinum", division: "2", iconPath: "/assets/ranked/rank_Platinum_II.svg" },
  { key: "plat3", name: "Platinum 3", tier: "Platinum", division: "3", iconPath: "/assets/ranked/rank_Platinum_III.svg" },
  { key: "diamond1", name: "Diamond 1", tier: "Diamond", division: "1", iconPath: "/assets/ranked/rank_Diamond_I.svg" },
  { key: "diamond2", name: "Diamond 2", tier: "Diamond", division: "2", iconPath: "/assets/ranked/rank_Diamond_II.svg" },
  { key: "diamond3", name: "Diamond 3", tier: "Diamond", division: "3", iconPath: "/assets/ranked/rank_Diamond_III.svg" },
  { key: "master1", name: "Master 1", tier: "Master", division: "1", iconPath: "/assets/ranked/rank_Master_I.svg" },
  { key: "master2", name: "Master 2", tier: "Master", division: "2", iconPath: "/assets/ranked/rank_Master_II.svg" },
  { key: "master3", name: "Master 3", tier: "Master", division: "3", iconPath: "/assets/ranked/rank_Master_III.svg" },
  { key: "grandmaster", name: "Grandmaster", tier: "Grandmaster", division: null, iconPath: "/assets/ranked/rank_Grand_Master.svg" },
];
const LEAGUE_BY_KEY = new Map(LEAGUES.map((league) => [league.key, league]));

function leagueByKey(key: string): RankedLeague {
  return LEAGUE_BY_KEY.get(key) ?? LEAGUE_BY_KEY.get("none")!;
}

function leagueFromRating(ratingOrdinal: number | null | undefined, hasPlacement: boolean, gamesPlayed: number): RankedLeague {
  const rating = Number(ratingOrdinal ?? 0);
  if (!Number.isFinite(rating) || gamesPlayed === 0) return leagueByKey("none");
  if (gamesPlayed < 5) return leagueByKey("pending");
  if (rating >= 2191.75 && hasPlacement) return leagueByKey("grandmaster");
  if (rating >= 2350) return leagueByKey("master3");
  if (rating >= 2275) return leagueByKey("master2");
  if (rating >= 2191.75) return leagueByKey("master1");
  if (rating >= 2136.28) return leagueByKey("diamond3");
  if (rating >= 2073.67) return leagueByKey("diamond2");
  if (rating >= 2003.92) return leagueByKey("diamond1");
  if (rating >= 1927.03) return leagueByKey("plat3");
  if (rating >= 1843) return leagueByKey("plat2");
  if (rating >= 1751.83) return leagueByKey("plat1");
  if (rating >= 1653.52) return leagueByKey("gold3");
  if (rating >= 1548.07) return leagueByKey("gold2");
  if (rating >= 1435.48) return leagueByKey("gold1");
  if (rating >= 1315.75) return leagueByKey("silver3");
  if (rating >= 1188.88) return leagueByKey("silver2");
  if (rating >= 1054.87) return leagueByKey("silver1");
  if (rating >= 913.72) return leagueByKey("bronze3");
  if (rating >= 765.43) return leagueByKey("bronze2");
  return leagueByKey("bronze1");
}

async function fetchSlippiRanked(connectCode: string): Promise<SlippiRankedResult | null> {
  const code = String(connectCode ?? "").trim().toUpperCase();
  if (!code) return null;
  const cached = slippiRankCache.get(code);
  if (cached && cached.expiresAt > Date.now()) return cached.value;
  const inflight = slippiRankInflight.get(code);
  if (inflight) return inflight;
  const run = (async () => {
    try {
      const query = `
        query UserProfilePageQuery($cc: String, $uid: String) {
          getUser(connectCode: $cc, fbUid: $uid) {
            displayName
            connectCode { code }
            rankedNetplayProfile {
              ratingOrdinal
              ratingUpdateCount
              dailyGlobalPlacement
              dailyRegionalPlacement
            }
            rankedNetplayProfileHistory {
              ratingOrdinal
              ratingUpdateCount
              season { name }
            }
          }
        }
      `;
      const resp = await fetch(SLIPPI_GQL_URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        signal: AbortSignal.timeout(3500),
        body: JSON.stringify({
          operationName: "UserProfilePageQuery",
          query,
          variables: { cc: code, uid: code },
        }),
      });
      if (!resp.ok) throw new Error(`slippi status ${resp.status}`);
      const payload = (await resp.json()) as any;
      const user = payload?.data?.getUser;
      if (!user?.rankedNetplayProfile) {
        slippiRankCache.set(code, { value: null, expiresAt: Date.now() + SLIPPI_RANK_CACHE_TTL_MS });
        return null;
      }
      const currentRating = Number(user.rankedNetplayProfile.ratingOrdinal ?? 0);
      const currentGames = Number(user.rankedNetplayProfile.ratingUpdateCount ?? 0);
      const hasPlacement = Boolean(user.rankedNetplayProfile.dailyGlobalPlacement || user.rankedNetplayProfile.dailyRegionalPlacement);
      const currentLeague = leagueFromRating(currentRating, hasPlacement, currentGames);
      const rankedRows = [
        {
          elo: currentRating,
          games: currentGames,
          season: "Actual",
          league: currentLeague,
        },
        ...((user.rankedNetplayProfileHistory ?? []) as any[]).map((row) => {
          const elo = Number(row?.ratingOrdinal ?? 0);
          const games = Number(row?.ratingUpdateCount ?? 0);
          return {
            elo,
            games,
            season: String(row?.season?.name ?? "Season"),
            league: leagueFromRating(elo, false, games),
          };
        }),
      ].filter((r) => Number.isFinite(r.elo));
      const best = rankedRows.sort((a, b) => b.elo - a.elo)[0] ?? null;
      const out: SlippiRankedResult = {
        connectCode: String(user.connectCode?.code ?? code),
        displayName: user.displayName ?? null,
        current: { ...currentLeague, elo: currentRating, games: currentGames },
        best: best
          ? { ...best.league, elo: best.elo, games: best.games, season: best.season }
          : null,
      };
      slippiRankCache.set(code, { value: out, expiresAt: Date.now() + SLIPPI_RANK_CACHE_TTL_MS });
      return out;
    } catch (err) {
      console.warn("[live] ranked fetch error", err);
      slippiRankCache.set(code, { value: null, expiresAt: Date.now() + SLIPPI_RANK_ERROR_TTL_MS });
      return null;
    } finally {
      slippiRankInflight.delete(code);
    }
  })();
  slippiRankInflight.set(code, run);
  return run;
}

async function fetchRankedMap(codes: string[]): Promise<Record<string, SlippiRankedResult | null>> {
  const uniq = [...new Set(codes.map((c) => String(c ?? "").trim().toUpperCase()).filter(Boolean))];
  const pairs = await Promise.all(
    uniq.map(async (code) => [code, await fetchSlippiRanked(code)] as const)
  );
  return Object.fromEntries(pairs);
}

function kvGet(key: string): string | undefined {
  const row = getDb()
    .query("SELECT value FROM app_kv WHERE key = $k")
    .get({ $k: key }) as { value: string } | undefined;
  return row?.value;
}

function kvSet(key: string, value: string) {
  getDb()
    .prepare("INSERT INTO app_kv (key, value) VALUES ($k, $v) ON CONFLICT(key) DO UPDATE SET value = $v")
    .run({ $k: key, $v: value });
}

function getAutoIngest8hEnabled(): boolean {
  return kvGet("auto_ingest_8h") === "1";
}

function getAutoStartEnabled(): boolean {
  return kvGet("auto_start") === "1";
}

function getLinuxAutostartDesktopPath() {
  const configHome = process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config");
  return join(configHome, "autostart", "slippi-world.desktop");
}

function getWindowsStartupScriptPath() {
  const appData = process.env.APPDATA ?? join(homedir(), "AppData", "Roaming");
  return join(
    appData,
    "Microsoft",
    "Windows",
    "Start Menu",
    "Programs",
    "Startup",
    "SlippiWorld-Autostart.cmd"
  );
}

function getLaunchCommandPath() {
  const explicit = process.env.AUTO_START_COMMAND?.trim();
  if (explicit) return explicit;
  const appImagePath = process.env.APPIMAGE?.trim();
  return appImagePath && appImagePath.length > 0 ? appImagePath : process.execPath;
}

function setAutoStartEnabled(enabled: boolean) {
  if (process.platform === "linux") {
    const desktopPath = getLinuxAutostartDesktopPath();
    const autostartDir = join(desktopPath, "..");
    if (!existsSync(autostartDir)) mkdirSync(autostartDir, { recursive: true });
    if (enabled) {
      const execPath = getLaunchCommandPath().replace(/"/g, '\\"');
      // env SLIPPI_AUTOSTART=1 tells the tray launcher to start minimized to tray
      // (no browser window) when launched on session boot.
      const desktop = `[Desktop Entry]
Type=Application
Name=Slippi World
Comment=Start Slippi World on login
Exec=env SLIPPI_AUTOSTART=1 "${execPath}"
Terminal=false
X-GNOME-Autostart-enabled=true
Categories=Game;Utility;
`;
      writeFileSync(desktopPath, desktop, "utf8");
    } else if (existsSync(desktopPath)) {
      rmSync(desktopPath);
    }
    kvSet("auto_start", enabled ? "1" : "0");
    return;
  }

  if (process.platform === "win32") {
    const startupPath = getWindowsStartupScriptPath();
    const startupDir = join(startupPath, "..");
    if (!existsSync(startupDir)) mkdirSync(startupDir, { recursive: true });
    if (enabled) {
      const cmdPath = getLaunchCommandPath().replace(/"/g, '""');
      // SLIPPI_AUTOSTART=1 signals the tray launcher to skip opening the browser
      // and just start minimized to the system tray.
      const startupScript =
        `@echo off\r\nset SLIPPI_AUTOSTART=1\r\nstart "" "${cmdPath}"\r\n`;
      writeFileSync(startupPath, startupScript, "utf8");
    } else if (existsSync(startupPath)) {
      rmSync(startupPath);
    }
    kvSet("auto_start", enabled ? "1" : "0");
    return;
  }

  throw new Error("Auto-start is currently supported on Linux and Windows.");
}

function tryStartIngest(): boolean {
  if (ingestRunning || getBackfillStatus().running || isRefreshPlayerStocksRunning()) return false;
  const db = getDb();
  ingestBaseGames = (db.query("SELECT COUNT(*) AS n FROM games").get() as any).n;
  ingestBasePlayers = (db.query("SELECT COUNT(*) AS n FROM players").get() as any).n;
  ingestRunning = true;
  ingestAbort.stop = false;
  ingest((p) => {
    lastIngestResult = p;
  }, ingestAbort)
    .then((r) => {
      lastIngestResult = r;
    })
    .finally(() => {
      ingestRunning = false;
    });
  return true;
}

function syncAutoIngest8hSchedule() {
  if (autoIngest8hInterval !== null) {
    clearInterval(autoIngest8hInterval);
    autoIngest8hInterval = null;
  }
  if (!getAutoIngest8hEnabled()) return;
  autoIngest8hInterval = setInterval(() => {
    tryStartIngest();
  }, AUTO_INGEST_8H_MS);
}

function openBrowser(url: string) {
  if (process.env.NO_OPEN_BROWSER === "1") return;
  try {
    const cmd =
      process.platform === "win32"
        ? ["cmd", "/c", "start", "", url]
        : process.platform === "darwin"
          ? ["open", url]
          : [
              "sh",
              "-lc",
              `(xdg-open '${url}' || gio open '${url}' || sensible-browser '${url}') >/dev/null 2>&1 &`,
            ];
    const child = Bun.spawn({
      cmd,
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
    });
    child.unref();
  } catch {
    console.warn(`Could not auto-open browser. Open manually: ${url}`);
  }
}

function gracefulShutdown(server: ReturnType<typeof Bun.serve>) {
  if (shutdownRequested) return;
  shutdownRequested = true;
  setTimeout(() => {
    try {
      stopParserWork();
      server.stop(true);
    } finally {
      process.exit(0);
    }
  }, 120);
}

function pickLiveOpponent(
  players: Array<{ connectCode: string | null }>,
  myCodes: Set<string>
): { code: string | null; hint: string | null } {
  if (myCodes.size === 0) {
    return {
      code: null,
      hint: "Add your connect code in Config so we can match the opponent tag.",
    };
  }
  const withCodes = players.filter((p) => p.connectCode?.trim());
  const mine = withCodes.filter((p) => myCodes.has(p.connectCode!.toUpperCase()));
  const theirs = withCodes.filter((p) => !myCodes.has(p.connectCode!.toUpperCase()));
  if (mine.length === 1 && theirs.length === 1) {
    return { code: theirs[0]!.connectCode!.toUpperCase(), hint: null };
  }
  if (mine.length === 0 && withCodes.length >= 2) {
    return { code: null, hint: "No player tag matches your connect codes — check Config." };
  }
  if (theirs.length >= 1) {
    const ambiguous = theirs.length > 1 && mine.length !== 1;
    return {
      code: theirs[0]!.connectCode!.toUpperCase(),
      hint: ambiguous ? "Multiple opponent tags — showing stats for the first unmatched tag." : null,
    };
  }
  return { code: null, hint: "Waiting for opponent connect code in the replay…" };
}

type LivePlayerRow = { connectCode: string | null };

async function liveOpponentInsightBundle(
  db: ReturnType<typeof getDb>,
  players: LivePlayerRow[],
  myCodes: Set<string>
): Promise<{
  opponentCode: string | null;
  opponentHint: string | null;
  opponentInsight: { summary: unknown; byStage: unknown[]; recentGames: unknown[] } | null;
  opponentRanked: SlippiRankedResult | null;
}> {
  const { code: opponentCode, hint: oppHint } = pickLiveOpponent(players, myCodes);
  let opponentInsight: { summary: unknown; byStage: unknown[]; recentGames: unknown[] } | null = null;
  let opponentRanked: SlippiRankedResult | null = null;
  if (opponentCode) {
    const p = { $code: opponentCode };
    const summary = db.query(`
            SELECT
              COUNT(DISTINCT g.id)                             AS total_games,
              SUM(CASE WHEN me.is_winner=1 THEN 1 ELSE 0 END) AS my_wins,
              SUM(CASE WHEN op.is_winner=1 THEN 1 ELSE 0 END) AS their_wins,
              GROUP_CONCAT(DISTINCT op.character_id)           AS their_chars,
              GROUP_CONCAT(DISTINCT op.display_name)           AS their_names,
              (
                SELECT op2.character_id
                FROM games g2
                JOIN players me2 ON me2.game_id=g2.id AND me2.is_me=1
                JOIN players op2 ON op2.game_id=g2.id AND op2.is_me=0 AND op2.connect_code=$code
                WHERE ${ONLY_1V1_SQL}
                  AND op2.character_id IS NOT NULL
                GROUP BY op2.character_id
                ORDER BY COUNT(*) DESC
                LIMIT 1
              )                                                AS most_played_char,
              (
                SELECT op3.character_id
                FROM games g3
                JOIN players me3 ON me3.game_id=g3.id AND me3.is_me=1
                JOIN players op3 ON op3.game_id=g3.id AND op3.is_me=0 AND op3.connect_code=$code
                WHERE ${ONLY_1V1_SQL}
                  AND op3.character_id IS NOT NULL
                GROUP BY op3.character_id
                ORDER BY (SUM(CASE WHEN op3.is_winner=1 THEN 1 ELSE 0 END) * 1.0 / COUNT(*)) DESC,
                         COUNT(*) DESC
                LIMIT 1
              )                                                AS best_char
            FROM games g
            JOIN players me ON me.game_id=g.id AND me.is_me=1
            JOIN players op ON op.game_id=g.id AND op.is_me=0 AND op.connect_code=$code
            WHERE ${ONLY_1V1_SQL}
          `).get(p);

    const byStage = db.query(`
            SELECT
              g.stage_id,
              COUNT(*) AS games,
              SUM(CASE WHEN me.is_winner=1 THEN 1 ELSE 0 END) AS wins
            FROM games g
            JOIN players me ON me.game_id=g.id AND me.is_me=1
            JOIN players op ON op.game_id=g.id AND op.is_me=0 AND op.connect_code=$code
            WHERE g.stage_id IS NOT NULL
              AND ${ONLY_1V1_SQL}
            GROUP BY g.stage_id
            ORDER BY games DESC
          `).all(p);

    const recentGames = db.query(`
            SELECT g.id, g.played_at, g.stage_id, g.duration_frames,
                   me.character_id AS my_char, op.character_id AS opp_char,
                   me.is_winner AS i_won
            FROM games g
            JOIN players me ON me.game_id=g.id AND me.is_me=1
            JOIN players op ON op.game_id=g.id AND op.is_me=0 AND op.connect_code=$code
            WHERE ${ONLY_1V1_SQL}
            ORDER BY g.played_at DESC
            LIMIT 8
          `).all(p);

    const tg = (summary as { total_games?: number } | null)?.total_games ?? 0;
    if (tg > 0) {
      opponentInsight = { summary, byStage, recentGames };
    }
    opponentRanked = await fetchSlippiRanked(opponentCode);
  }
  return { opponentCode, opponentHint: oppHint, opponentInsight, opponentRanked };
}

// ─── server ───────────────────────────────────────────────────────────────────
const server = Bun.serve({
  port: PORT,
  development: { hmr: true },

  routes: {
    "/": index,
    "/dashboard": index,
    "/live": index,
    "/games": index,
    "/opponent": index,
    "/config": index,

    // ── config ──────────────────────────────────────────────────────────────
    "/api/config": {
      GET() {
        const db = getDb();
        const codes = (db.query("SELECT code FROM my_codes").all() as any[]).map((r) => r.code);
        const dirs = db.query("SELECT id, path FROM watch_dirs").all();
        return json({ codes, dirs, autoIngest8h: getAutoIngest8hEnabled(), autoStart: getAutoStartEnabled() });
      },
    },

    "/api/config/auto-ingest-8h": {
      async POST(req) {
        const { enabled } = await body<{ enabled?: boolean }>(req);
        if (typeof enabled !== "boolean") return json({ error: "enabled boolean required" }, 400);
        kvSet("auto_ingest_8h", enabled ? "1" : "0");
        syncAutoIngest8hSchedule();
        return json({ ok: true, autoIngest8h: enabled });
      },
    },

    "/api/config/auto-start": {
      async POST(req) {
        const { enabled } = await body<{ enabled?: boolean }>(req);
        if (typeof enabled !== "boolean") return json({ error: "enabled boolean required" }, 400);
        try {
          setAutoStartEnabled(enabled);
        } catch (e) {
          return json({ error: e instanceof Error ? e.message : "could not update auto-start" }, 400);
        }
        return json({ ok: true, autoStart: enabled });
      },
    },

    "/api/config/codes": {
      async POST(req) {
        const { code } = await body<{ code: string }>(req);
        if (!code?.trim()) return json({ error: "code required" }, 400);
        getDb().prepare("INSERT OR IGNORE INTO my_codes (code) VALUES ($code)").run({ $code: code.trim().toUpperCase() });
        return json({ ok: true });
      },
    },

    "/api/config/codes/:code": {
      DELETE(req) {
        getDb().prepare("DELETE FROM my_codes WHERE code = $code").run({ $code: req.params.code.toUpperCase() });
        return json({ ok: true });
      },
    },

    "/api/config/dirs": {
      async POST(req) {
        const { path } = await body<{ path: string }>(req);
        if (!path?.trim()) return json({ error: "path required" }, 400);
        getDb().prepare("INSERT OR IGNORE INTO watch_dirs (path) VALUES ($path)").run({ $path: path.trim() });
        return json({ ok: true });
      },
    },

    "/api/config/dirs/:id": {
      DELETE(req) {
        getDb().prepare("DELETE FROM watch_dirs WHERE id = $id").run({ $id: Number(req.params.id) });
        return json({ ok: true });
      },
    },

    // ── live replay (newest “hot” .slp under watch dirs) ──────────────────────
    "/api/live": {
      async GET() {
        const tr = startLiveTrace();
        try {
          const db = getDb();
          tr.step("after-getDb");

          const watchRows = db.query("SELECT path FROM watch_dirs").all() as { path: string }[];
          const watchPaths = watchRows.map((r) => r.path).filter(Boolean);
          const myCodes = new Set(
            (db.query("SELECT code FROM my_codes").all() as { code: string }[]).map((r) => r.code.toUpperCase())
          );
          tr.step("after-config-queries", { watchDirs: watchPaths.length, myCodes: myCodes.size });

          if (watchPaths.length === 0) {
            tr.finish({ active: false, reason: "no_directories" });
            return json({
              watchPaths,
              staleMs: LIVE_STALE_MS,
              active: false,
              reason: "no_directories",
              hint: "Add replay folders in Config to monitor live games.",
            });
          }

          const newest = findNewestSlpWithMtime(watchPaths);
          if (!newest) {
            tr.finish({ active: false, reason: "no_slp_files" });
            return json({
              watchPaths,
              staleMs: LIVE_STALE_MS,
              active: false,
              reason: "no_slp_files",
              hint: "No .slp files found under your watch folders.",
            });
          }

          const ageMs = Date.now() - newest.mtimeMs;
          const fileInfo = { path: newest.path, mtimeMs: newest.mtimeMs, ageMs };
          const fileHot = ageMs <= LIVE_STALE_MS;
          tr.step("newest-slp", { ageMs, fileHot, pathTail: newest.path.slice(-64) });

          tr.step("parseLiveReplay:before");
          const snap = parseLiveReplay(newest.path, tr);
          tr.step("parseLiveReplay:after", {
            ok: snap.ok,
            gameEnded: snap.ok ? snap.gameEnded : undefined,
            err: snap.ok ? undefined : snap.error,
          });

          const baseLive = { watchPaths, staleMs: LIVE_STALE_MS, file: fileInfo, fileHot };

          if (snap.ok && snap.gameEnded) {
            tr.step("live-auto-ingest:before");
            await tryIngestCompletedLiveReplay(newest.path, ingestRunning);
            tr.step("live-auto-ingest:after");
            tr.step("db-opponent:before");
            const opp = await liveOpponentInsightBundle(db, snap.players, myCodes);
            tr.step("db-opponent:after");
            tr.finish({
              active: false,
              reason: "game_finished",
              fileHot: false,
              lastFrame: snap.game.durationFrames,
            });
            return json({
              ...baseLive,
              active: false,
              reason: "game_finished",
              hint: "Idle — listening for a new replay. The finished match was saved to the database when possible; opponent stats below refresh automatically.",
              opponentCode: opp.opponentCode,
              opponentHint: opp.opponentHint,
              opponentInsight: opp.opponentInsight,
              opponentRanked: opp.opponentRanked,
            });
          }
          if (!snap.ok) {
            const reason = snap.error.startsWith("not_1v1:") ? "not_1v1" : "parse_error";
            tr.finish({ active: true, reason, parseError: snap.error, fileHot });
            return json({
              ...baseLive,
              active: true,
              reason,
              parseError: snap.error,
              opponentCode: null,
              opponentHint:
                myCodes.size === 0
                  ? "Add your connect code in Config to identify the opponent."
                  : null,
              opponentInsight: null,
            });
          }

          tr.step("db-opponent:before");
          const opp = await liveOpponentInsightBundle(db, snap.players, myCodes);
          tr.step("db-opponent:after", { opponentCode: opp.opponentCode ?? null });

          tr.finish({
            active: true,
            reason: null,
            fileHot,
            lastFrame: snap.game.durationFrames,
            opponentCode: opp.opponentCode ?? null,
            hasInsight: Boolean(opp.opponentInsight),
          });
          return json({
            ...baseLive,
            active: true,
            reason: null,
            snapshot: snap,
            opponentCode: opp.opponentCode,
            opponentHint: opp.opponentHint,
            opponentInsight: opp.opponentInsight,
            opponentRanked: opp.opponentRanked,
          });
        } catch (e) {
          tr.step("UNCAUGHT", { error: e instanceof Error ? e.message : String(e) });
          tr.finish({ error: true });
          console.error("[live] UNCAUGHT_EXCEPTION", e);
          throw e;
        }
      },
    },

    // ── ingest ───────────────────────────────────────────────────────────────
    "/api/ingest": {
      async POST() {
        if (!tryStartIngest()) return json({ error: "ingest/backfill already running" }, 409);
        return json({ ok: true, message: "ingest started" });
      },
    },

    "/api/ingest/stop": {
      POST() {
        ingestAbort.stop = true;
        stopParserWork();
        return json({ ok: true });
      },
    },

    "/api/ingest/status": {
      GET() {
        const db = getDb();
        const games = (db.query("SELECT COUNT(*) AS n FROM games").get() as any).n;
        const players = (db.query("SELECT COUNT(*) AS n FROM players").get() as any).n;
        const backfill = getBackfillStatus();
        return json({
          running: ingestRunning,
          backfill,
          progress: lastIngestResult,
          db: {
            games,
            players,
            addedGamesThisRun: Math.max(0, games - ingestBaseGames),
            addedPlayersThisRun: Math.max(0, players - ingestBasePlayers),
          },
        });
      },
    },

    // ── stats overview ────────────────────────────────────────────────────────
    "/api/stats/overview": {
      async GET(req) {
        const db = getDb();
        const timeFilter = buildYearMonthFilter(req);
        const totalsWhere = [`${ONLY_1V1_SQL}`, ...timeFilter.conditions].join(" AND ");
        const groupWhere = [`${ONLY_1V1_SQL}`, ...timeFilter.conditions].join(" AND ");

        const totals = db.query(`
          SELECT
            COUNT(DISTINCT g.id)                                                    AS total_games,
            COUNT(DISTINCT CASE WHEN p.is_me=1 AND p.is_winner=1 THEN g.id END)    AS wins,
            COUNT(DISTINCT CASE WHEN p.is_me=1 AND p.is_winner=0 THEN g.id END)    AS losses,
            ROUND(SUM(g.duration_frames)/3600.0/60.0, 2)                           AS total_hours,
            MIN(g.played_at)                                                        AS first_game,
            MAX(g.played_at)                                                        AS last_game
          FROM games g
          LEFT JOIN players p ON p.game_id=g.id AND p.is_me=1
          WHERE ${totalsWhere}
        `).get(timeFilter.params);

        const byCharacter = db.query(`
          SELECT
            p.character_id,
            COUNT(DISTINCT g.id)                              AS games,
            SUM(CASE WHEN p.is_winner=1 THEN 1 ELSE 0 END)   AS wins,
            ROUND(AVG(s.lcancel_rate)*100,1)                  AS avg_lcancel_pct,
            ROUND(AVG(s.inputs_per_minute),1)                 AS avg_apm
          FROM players p
          JOIN games g ON g.id=p.game_id
          LEFT JOIN stats s ON s.player_id=p.id
          WHERE p.is_me=1 AND p.character_id IS NOT NULL
            AND ${groupWhere}
          GROUP BY p.character_id
          ORDER BY games DESC
        `).all(timeFilter.params);

        const byStage = db.query(`
          SELECT
            g.stage_id,
            COUNT(DISTINCT g.id)                              AS games,
            SUM(CASE WHEN p.is_winner=1 THEN 1 ELSE 0 END)   AS wins
          FROM games g
          LEFT JOIN players p ON p.game_id=g.id AND p.is_me=1
          WHERE g.stage_id IS NOT NULL
            AND ${groupWhere}
          GROUP BY g.stage_id
          ORDER BY games DESC
        `).all(timeFilter.params);

        const recentGames = db.query(`
          SELECT
            g.id, g.played_at, g.stage_id, g.duration_frames,
            GROUP_CONCAT(p.character_id||':'||COALESCE(p.connect_code,'?')||':'||p.is_me) AS players_info
          FROM games g
          JOIN players p ON p.game_id=g.id
          WHERE ${totalsWhere}
          GROUP BY g.id
          ORDER BY g.played_at DESC
          LIMIT 20
        `).all(timeFilter.params);
        const myCodes = (db.query("SELECT code FROM my_codes ORDER BY rowid ASC").all() as { code: string }[])
          .map((r) => r.code)
          .filter(Boolean);
        const myPrimaryCode = myCodes[0] ?? null;
        const myRanked = myPrimaryCode ? await fetchSlippiRanked(myPrimaryCode) : null;
        return json({ totals, byCharacter, byStage, recentGames, myPrimaryCode, myRanked });
      },
    },

    // ── SlippiDV-style aggregates: trends + character matchups ─────────────────
    "/api/stats/trends": {
      GET(req) {
        const db = getDb();
        const timeFilter = buildYearMonthFilter(req);
        const where = ["g.played_at IS NOT NULL", `${ONLY_1V1_SQL}`, ...timeFilter.conditions].join(" AND ");
        const monthly = db.query(`
          SELECT
            strftime('%Y-%m', g.played_at) AS month,
            COUNT(DISTINCT g.id) AS games,
            SUM(CASE WHEN me.is_winner = 1 THEN 1 ELSE 0 END) AS wins,
            ROUND(AVG(s.lcancel_rate) * 100, 1) AS avg_lcancel_pct
          FROM games g
          JOIN players me ON me.game_id = g.id AND me.is_me = 1
          LEFT JOIN stats s ON s.player_id = me.id
          WHERE ${where}
          GROUP BY month
          ORDER BY month
        `).all(timeFilter.params);
        return json({ monthly });
      },
    },

    "/api/stats/matchups": {
      GET(req) {
        const db = getDb();
        const timeFilter = buildYearMonthFilter(req);
        const where = [
          "me.character_id IS NOT NULL",
          "op.character_id IS NOT NULL",
          `${ONLY_1V1_SQL}`,
          ...timeFilter.conditions,
        ].join(" AND ");
        const rows = db.query(`
          SELECT
            me.character_id AS my_char,
            op.character_id AS opp_char,
            COUNT(DISTINCT g.id) AS games,
            SUM(CASE WHEN me.is_winner = 1 THEN 1 ELSE 0 END) AS wins
          FROM games g
          JOIN players me ON me.game_id = g.id AND me.is_me = 1
          JOIN players op ON op.game_id = g.id AND op.is_me = 0
          WHERE ${where}
          GROUP BY me.character_id, op.character_id
          HAVING games >= 3
          ORDER BY games DESC
          LIMIT 32
        `).all(timeFilter.params);
        return json({ rows });
      },
    },

    // ── games list ────────────────────────────────────────────────────────────
    "/api/games": {
      GET(req) {
        const db = getDb();
        const u = new URL(req.url);
        const page  = Number(u.searchParams.get("page")  ?? 1);
        const limit = Number(u.searchParams.get("limit") ?? 50);
        const offset = (page - 1) * limit;

        const stageId  = u.searchParams.get("stage");
        const charId   = u.searchParams.get("char");
        const oppCode  = u.searchParams.get("opp")?.toUpperCase();
        const result   = u.searchParams.get("result"); // "win" | "loss"
        const dateFrom = u.searchParams.get("from");
        const dateTo   = u.searchParams.get("to");

        const conditions: string[] = [];
        const params: Record<string, unknown> = { $limit: limit, $offset: offset };

        conditions.push(ONLY_1V1_SQL);
        if (stageId)  { conditions.push("g.stage_id = $stageId");   params.$stageId  = stageId; }
        if (charId)   { conditions.push("p.character_id = $charId"); params.$charId   = charId; }
        if (oppCode)  { conditions.push("op.connect_code = $oppCode"); params.$oppCode = oppCode; }
        if (result === "win")  { conditions.push("p.is_winner = 1"); }
        if (result === "loss") { conditions.push("p.is_winner = 0"); }
        if (dateFrom) { conditions.push("g.played_at >= $dateFrom"); params.$dateFrom = dateFrom; }
        if (dateTo)   { conditions.push("g.played_at <= $dateTo");   params.$dateTo   = dateTo + "T23:59:59"; }

        const where = conditions.length ? "WHERE " + conditions.join(" AND ") : "";

        const rows = db.query(`
          SELECT g.id, g.played_at, g.stage_id, g.duration_frames, g.platform,
                 p.character_id AS my_char, p.is_winner AS i_won,
                 op.connect_code AS opp_code, op.character_id AS opp_char, op.display_name AS opp_name
          FROM games g
          JOIN players p ON p.game_id=g.id AND p.is_me=1
          LEFT JOIN players op ON op.game_id=g.id AND op.is_me=0
          ${where}
          ORDER BY g.played_at DESC
          LIMIT $limit OFFSET $offset
        `).all(params);

        const countParams = { ...params };
        delete countParams.$limit;
        delete countParams.$offset;
        const total = (db.query(`
          SELECT COUNT(*) AS n FROM games g
          JOIN players p ON p.game_id=g.id AND p.is_me=1
          LEFT JOIN players op ON op.game_id=g.id AND op.is_me=0
          ${where}
        `).get(countParams) as any).n;

        return json({ rows, total, page, limit });
      },
    },

    // ── opponents top 50 + autocomplete ───────────────────────────────────────
    "/api/opponents/top": {
      async GET(req) {
        const db = getDb();
        const u = new URL(req.url);
        const limit = Math.max(1, Math.min(100, Number(u.searchParams.get("limit") ?? 50)));
        const includeRanked = u.searchParams.get("includeRanked") === "1";
        const rows = db.query(`
          SELECT
            op.connect_code,
            GROUP_CONCAT(DISTINCT op.display_name)          AS names,
            COUNT(DISTINCT g.id)                            AS games,
            SUM(CASE WHEN me.is_winner=1 THEN 1 ELSE 0 END) AS my_wins,
            SUM(CASE WHEN op.is_winner=1 THEN 1 ELSE 0 END) AS their_wins,
            MAX(g.played_at)                                AS last_played,
            GROUP_CONCAT(DISTINCT op.character_id)          AS their_chars
          FROM games g
          JOIN players me ON me.game_id=g.id AND me.is_me=1
          JOIN players op ON op.game_id=g.id AND op.is_me=0 AND op.connect_code IS NOT NULL
          WHERE ${ONLY_1V1_SQL}
          GROUP BY op.connect_code
          ORDER BY games DESC
          LIMIT $limit
        `).all({ $limit: limit });
        if (!includeRanked) return json(rows);
        const rankedMap = await fetchRankedMap((rows as any[]).map((r) => r.connect_code));
        const out = (rows as any[]).map((r) => ({
          ...r,
          ranked: r.connect_code ? rankedMap[String(r.connect_code).toUpperCase()] ?? null : null,
        }));
        return json(out);
      },
    },

    "/api/opponents/recent": {
      async GET(req) {
        const db = getDb();
        const u = new URL(req.url);
        const limit = Math.max(1, Math.min(100, Number(u.searchParams.get("limit") ?? 20)));
        const includeRanked = u.searchParams.get("includeRanked") === "1";
        const rows = db.query(`
          SELECT
            op.connect_code,
            GROUP_CONCAT(DISTINCT op.display_name) AS names,
            COUNT(DISTINCT g.id) AS games,
            SUM(CASE WHEN me.is_winner=1 THEN 1 ELSE 0 END) AS my_wins,
            SUM(CASE WHEN op.is_winner=1 THEN 1 ELSE 0 END) AS their_wins,
            MAX(g.played_at) AS last_played,
            GROUP_CONCAT(DISTINCT op.character_id) AS their_chars
          FROM games g
          JOIN players me ON me.game_id = g.id AND me.is_me = 1
          JOIN players op ON op.game_id = g.id AND op.is_me = 0 AND op.connect_code IS NOT NULL
          WHERE TRIM(op.connect_code) != ''
            AND ${ONLY_1V1_SQL}
          GROUP BY op.connect_code
          ORDER BY last_played DESC
          LIMIT $limit
        `).all({ $limit: limit });
        if (!includeRanked) return json(rows);
        const rankedMap = await fetchRankedMap((rows as any[]).map((r) => r.connect_code));
        const out = (rows as any[]).map((r) => ({
          ...r,
          ranked: r.connect_code ? rankedMap[String(r.connect_code).toUpperCase()] ?? null : null,
        }));
        return json(out);
      },
    },

    "/api/opponents/search": {
      GET(req) {
        const db = getDb();
        const q = (new URL(req.url).searchParams.get("q") ?? "").toUpperCase();
        if (q.length < 1) return json([]);
        const rows = db.query(`
          SELECT DISTINCT op.connect_code,
                 GROUP_CONCAT(DISTINCT op.display_name) AS names,
                 COUNT(DISTINCT g.id) AS games
          FROM players op
          JOIN games g ON g.id=op.game_id
          WHERE op.is_me=0
            AND op.connect_code IS NOT NULL
            AND TRIM(op.connect_code) != ''
            AND op.connect_code LIKE $q
            AND ${ONLY_1V1_SQL}
          GROUP BY op.connect_code
          ORDER BY games DESC
          LIMIT 8
        `).all({ $q: `%${q}%` });
        return json(rows);
      },
    },

    // ── game detail ───────────────────────────────────────────────────────────
    "/api/games/:id": {
      GET(req) {
        const db = getDb();
        const id = Number(req.params.id);
        const game = db.query(`
          SELECT id, played_at, stage_id, duration_frames, platform, slp_version, is_teams, file_path
          FROM games g
          WHERE id = $id
            AND ${ONLY_1V1_SQL}
        `).get({ $id: id });
        if (!game) return json({ error: "not found" }, 404);

        const players = db.query(`
          SELECT p.id, p.port, p.character_id, p.character_color, p.display_name,
                 p.connect_code, p.is_me, p.start_stocks, p.end_stocks, p.is_winner,
                 s.neutral_wins, s.neutral_losses, s.conversions_total, s.conversion_rate,
                 s.openings_per_kill, s.damage_per_opening,
                 s.lcancel_success, s.lcancel_total, s.lcancel_rate,
                 s.damage_done, s.inputs_per_minute, s.digital_actions_per_minute, s.total_kills
          FROM players p
          LEFT JOIN stats s ON s.player_id = p.id
          WHERE p.game_id = $id
          ORDER BY p.port
        `).all({ $id: id });

        return json({ game, players });
      },
    },

    // ── opponent lookup ────────────────────────────────────────────────────────
    "/api/opponent/:code": {
      async GET(req) {
        const db = getDb();
        const u = new URL(req.url);
        const code = req.params.code.toUpperCase();
        const page = Math.max(1, Number(u.searchParams.get("page") ?? 1));
        const limit = Math.max(1, Math.min(200, Number(u.searchParams.get("limit") ?? 50)));
        const offset = (page - 1) * limit;
        const p = { $code: code, $limit: limit, $offset: offset };

        const summary = db.query(`
          SELECT
            COUNT(DISTINCT g.id)                                    AS total_games,
            SUM(CASE WHEN me.is_winner=1 THEN 1 ELSE 0 END)        AS my_wins,
            SUM(CASE WHEN op.is_winner=1 THEN 1 ELSE 0 END)        AS their_wins,
            GROUP_CONCAT(DISTINCT op.character_id)                  AS their_chars,
            GROUP_CONCAT(DISTINCT op.display_name)                  AS their_names
          FROM games g
          JOIN players me ON me.game_id=g.id AND me.is_me=1
          JOIN players op ON op.game_id=g.id AND op.is_me=0 AND op.connect_code=$code
          WHERE ${ONLY_1V1_SQL}
        `).get(p);

        const byStage = db.query(`
          SELECT
            g.stage_id,
            COUNT(*) AS games,
            SUM(CASE WHEN me.is_winner=1 THEN 1 ELSE 0 END) AS wins
          FROM games g
          JOIN players me ON me.game_id=g.id AND me.is_me=1
          JOIN players op ON op.game_id=g.id AND op.is_me=0 AND op.connect_code=$code
          WHERE g.stage_id IS NOT NULL
            AND ${ONLY_1V1_SQL}
          GROUP BY g.stage_id
          ORDER BY games DESC
        `).all(p);

        const games = db.query(`
          SELECT g.id, g.played_at, g.stage_id, g.duration_frames,
                 me.character_id AS my_char, op.character_id AS opp_char,
                 me.is_winner AS i_won
          FROM games g
          JOIN players me ON me.game_id=g.id AND me.is_me=1
          JOIN players op ON op.game_id=g.id AND op.is_me=0 AND op.connect_code=$code
          WHERE ${ONLY_1V1_SQL}
          ORDER BY g.played_at DESC
          LIMIT $limit OFFSET $offset
        `).all(p);

        const ranked = await fetchSlippiRanked(code);
        return json({ code, summary, byStage, games, page, limit, ranked });
      },
    },

    // ── db meta ────────────────────────────────────────────────────────────────
    "/api/db/stats": {
      GET() {
        const db = getDb();
        return json({
          games:   (db.query("SELECT COUNT(*) AS n FROM games").get() as any).n,
          players: (db.query("SELECT COUNT(*) AS n FROM players").get() as any).n,
          errors:  (db.query("SELECT COUNT(*) AS n FROM ingest_errors").get() as any).n,
        });
      },
    },

    "/api/db/reset": {
      POST() {
        if (ingestRunning || isRefreshPlayerStocksRunning()) {
          return json({ error: "stop ingest or stock refresh before resetting database" }, 409);
        }
        const db = getDb();
        const before = {
          games: (db.query("SELECT COUNT(*) AS n FROM games").get() as any).n,
          players: (db.query("SELECT COUNT(*) AS n FROM players").get() as any).n,
          errors: (db.query("SELECT COUNT(*) AS n FROM ingest_errors").get() as any).n,
        };
        db.transaction(() => {
          db.query("DELETE FROM stats").run();
          db.query("DELETE FROM players").run();
          db.query("DELETE FROM games").run();
          db.query("DELETE FROM ingest_errors").run();
          db.query("DELETE FROM sqlite_sequence WHERE name IN ('games','players','stats','ingest_errors')").run();
        })();
        lastIngestResult = null;
        return json({ ok: true, cleared: before });
      },
    },
    "/api/system/status": {
      GET() {
        return json({ ok: true, running: true, port: server.port });
      },
    },
    "/api/system/stop": {
      POST() {
        gracefulShutdown(server);
        return json({ ok: true, stopping: true });
      },
    },

    // ── static assets ─────────────────────────────────────────────────────────
    "/assets/*": (req) => {
      const url = new URL(req.url);
      const relPath = normalize(url.pathname).replace(/^([/\\])+/, "");
      if (relPath.includes("..")) return new Response("Not found", { status: 404 });
      if (!relPath.startsWith("assets/")) return new Response("Not found", { status: 404 });
      const assetRelPath = relPath.replace(/^assets[/\\]/, "");
      const filePath = join(STATIC_ASSETS_DIR, assetRelPath);
      const file = Bun.file(filePath);
      return new Response(file);
    },
  },
});

syncAutoIngest8hSchedule();

const appUrl = `http://localhost:${server.port}`;
console.log(`slippi-world running on ${appUrl}`);
openBrowser(appUrl);

process.on("SIGINT", () => gracefulShutdown(server));
process.on("SIGTERM", () => gracefulShutdown(server));
