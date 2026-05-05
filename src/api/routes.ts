import { Hono } from "hono";
import { cors } from "hono/cors";
import { getDb } from "../db/schema";
import { ingest } from "../parser/ingest";

export const api = new Hono().basePath("/api");
api.use(cors());

// ─── Config ──────────────────────────────────────────────────────────────────

api.get("/config", (c) => {
  const db = getDb();
  const codes = (db.prepare("SELECT code FROM my_codes").all() as any[]).map((r) => r.code);
  const dirs = (db.prepare("SELECT id, path FROM watch_dirs").all() as any[]);
  return c.json({ codes, dirs });
});

api.post("/config/codes", async (c) => {
  const { code } = await c.req.json<{ code: string }>();
  if (!code?.trim()) return c.json({ error: "code required" }, 400);
  getDb().prepare("INSERT OR IGNORE INTO my_codes (code) VALUES (?)").run(code.trim().toUpperCase());
  return c.json({ ok: true });
});

api.delete("/config/codes/:code", (c) => {
  getDb().prepare("DELETE FROM my_codes WHERE code = ?").run(c.req.param("code").toUpperCase());
  return c.json({ ok: true });
});

api.post("/config/dirs", async (c) => {
  const { path } = await c.req.json<{ path: string }>();
  if (!path?.trim()) return c.json({ error: "path required" }, 400);
  getDb().prepare("INSERT OR IGNORE INTO watch_dirs (path) VALUES (?)").run(path.trim());
  return c.json({ ok: true });
});

api.delete("/config/dirs/:id", (c) => {
  getDb().prepare("DELETE FROM watch_dirs WHERE id = ?").run(Number(c.req.param("id")));
  return c.json({ ok: true });
});

// ─── Ingest ───────────────────────────────────────────────────────────────────

let ingestRunning = false;
let lastIngestResult: any = null;

api.post("/ingest", async (c) => {
  if (ingestRunning) return c.json({ error: "already running" }, 409);
  ingestRunning = true;
  const result = await ingest((p) => { lastIngestResult = p; }).finally(() => {
    ingestRunning = false;
  });
  lastIngestResult = result;
  return c.json(result);
});

api.get("/ingest/status", (c) => {
  return c.json({ running: ingestRunning, progress: lastIngestResult });
});

// ─── Stats overview ───────────────────────────────────────────────────────────

api.get("/stats/overview", (c) => {
  const db = getDb();

  const totals = db.prepare(`
    SELECT
      COUNT(DISTINCT g.id)                                          AS total_games,
      COUNT(DISTINCT CASE WHEN p.is_me = 1 AND p.is_winner = 1 THEN g.id END) AS wins,
      COUNT(DISTINCT CASE WHEN p.is_me = 1 AND p.is_winner = 0 THEN g.id END) AS losses,
      ROUND(SUM(g.duration_frames) / 3600.0 / 60.0, 2)            AS total_hours,
      MIN(g.played_at)                                              AS first_game,
      MAX(g.played_at)                                              AS last_game
    FROM games g
    LEFT JOIN players p ON p.game_id = g.id AND p.is_me = 1
  `).get() as any;

  const byCharacter = db.prepare(`
    SELECT
      p.character_id,
      COUNT(DISTINCT g.id)                                           AS games,
      SUM(CASE WHEN p.is_winner = 1 THEN 1 ELSE 0 END)              AS wins,
      ROUND(AVG(s.lcancel_rate) * 100, 1)                           AS avg_lcancel_pct,
      ROUND(AVG(s.inputs_per_minute), 1)                            AS avg_apm
    FROM players p
    JOIN games g ON g.id = p.game_id
    LEFT JOIN stats s ON s.player_id = p.id
    WHERE p.is_me = 1 AND p.character_id IS NOT NULL
    GROUP BY p.character_id
    ORDER BY games DESC
  `).all();

  const byStage = db.prepare(`
    SELECT
      g.stage_id,
      COUNT(DISTINCT g.id)                                           AS games,
      SUM(CASE WHEN p.is_winner = 1 THEN 1 ELSE 0 END)              AS wins
    FROM games g
    LEFT JOIN players p ON p.game_id = g.id AND p.is_me = 1
    WHERE g.stage_id IS NOT NULL
    GROUP BY g.stage_id
    ORDER BY games DESC
  `).all();

  const recentGames = db.prepare(`
    SELECT
      g.id, g.played_at, g.stage_id, g.duration_frames,
      GROUP_CONCAT(p.character_id || ':' || COALESCE(p.connect_code,'?') || ':' || p.is_me) AS players_info
    FROM games g
    JOIN players p ON p.game_id = g.id
    GROUP BY g.id
    ORDER BY g.played_at DESC
    LIMIT 20
  `).all();

  return c.json({ totals, byCharacter, byStage, recentGames });
});

// ─── Games list ───────────────────────────────────────────────────────────────

api.get("/games", (c) => {
  const db = getDb();
  const page = Number(c.req.query("page") ?? 1);
  const limit = Number(c.req.query("limit") ?? 50);
  const offset = (page - 1) * limit;
  const stageId = c.req.query("stage");
  const charId = c.req.query("char");
  const code = c.req.query("code");

  let where = "WHERE 1=1";
  const params: any[] = [];
  if (stageId) { where += " AND g.stage_id = ?"; params.push(stageId); }

  const rows = db.prepare(`
    SELECT g.id, g.played_at, g.stage_id, g.duration_frames, g.platform,
           p.character_id AS my_char, p.is_winner AS i_won,
           op.connect_code AS opp_code, op.character_id AS opp_char, op.display_name AS opp_name
    FROM games g
    JOIN players p ON p.game_id = g.id AND p.is_me = 1
    LEFT JOIN players op ON op.game_id = g.id AND op.is_me = 0
    ${where}
    ORDER BY g.played_at DESC
    LIMIT ? OFFSET ?
  `).all([...params, limit, offset]);

  const total = (db.prepare(`SELECT COUNT(*) AS n FROM games g ${where}`).get(params) as any).n;

  return c.json({ rows, total, page, limit });
});

// ─── Opponent lookup ──────────────────────────────────────────────────────────

api.get("/opponent/:code", (c) => {
  const db = getDb();
  const code = c.req.param("code").toUpperCase();

  const summary = db.prepare(`
    SELECT
      COUNT(DISTINCT g.id)                                                    AS total_games,
      SUM(CASE WHEN me.is_winner = 1 THEN 1 ELSE 0 END)                      AS my_wins,
      SUM(CASE WHEN op.is_winner = 1 THEN 1 ELSE 0 END)                      AS their_wins,
      GROUP_CONCAT(DISTINCT op.character_id)                                  AS their_chars,
      GROUP_CONCAT(DISTINCT op.display_name)                                  AS their_names
    FROM games g
    JOIN players me ON me.game_id = g.id AND me.is_me = 1
    JOIN players op ON op.game_id = g.id AND op.connect_code = ?
  `).get(code) as any;

  const byStage = db.prepare(`
    SELECT
      g.stage_id,
      COUNT(*) AS games,
      SUM(CASE WHEN me.is_winner = 1 THEN 1 ELSE 0 END) AS wins
    FROM games g
    JOIN players me ON me.game_id = g.id AND me.is_me = 1
    JOIN players op ON op.game_id = g.id AND op.connect_code = ?
    WHERE g.stage_id IS NOT NULL
    GROUP BY g.stage_id
    ORDER BY games DESC
  `).all(code);

  const recent = db.prepare(`
    SELECT g.played_at, g.stage_id, g.duration_frames,
           me.character_id AS my_char, op.character_id AS opp_char,
           me.is_winner AS i_won
    FROM games g
    JOIN players me ON me.game_id = g.id AND me.is_me = 1
    JOIN players op ON op.game_id = g.id AND op.connect_code = ?
    ORDER BY g.played_at DESC
    LIMIT 10
  `).all(code);

  return c.json({ code, summary, byStage, recent });
});

// ─── DB stats (meta) ─────────────────────────────────────────────────────────

api.get("/db/stats", (c) => {
  const db = getDb();
  return c.json({
    games: (db.prepare("SELECT COUNT(*) AS n FROM games").get() as any).n,
    players: (db.prepare("SELECT COUNT(*) AS n FROM players").get() as any).n,
    errors: (db.prepare("SELECT COUNT(*) AS n FROM ingest_errors").get() as any).n,
  });
});
