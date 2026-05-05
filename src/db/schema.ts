import { Database } from "bun:sqlite";
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "path";

function ensureDirAndDbPath(baseDir: string) {
  if (!existsSync(baseDir)) mkdirSync(baseDir, { recursive: true });
  return join(baseDir, "slippi-world.db");
}

function defaultDbPath() {
  const home = homedir();
  const preferredDir =
    process.platform === "win32"
      ? join(process.env.APPDATA ?? join(home, "AppData", "Roaming"), "slippi-world")
      : process.platform === "darwin"
        ? join(home, "Library", "Application Support", "slippi-world")
        : join(process.env.XDG_DATA_HOME ?? join(home, ".local", "share"), "slippi-world");
  const fallbackDirs = [
    preferredDir,
    join(home, ".slippi-world"),
    join("/tmp", "slippi-world"),
  ];
  try {
    for (const dir of fallbackDirs) {
      try {
        return ensureDirAndDbPath(dir);
      } catch {
        // Try next candidate
      }
    }
  } catch {
    // noop - handled by final fallback below
  }
  // Last-resort writable path for odd launcher environments
  return join("/tmp", `slippi-world-${process.pid}.db`);
}

const DB_PATH = process.env.DB_PATH ?? defaultDbPath();

let _db: Database | null = null;

export function getDb(): Database {
  if (!_db) {
    _db = new Database(DB_PATH);
    _db.run("PRAGMA journal_mode = WAL");
    _db.run("PRAGMA synchronous = NORMAL");
    _db.run("PRAGMA foreign_keys = ON");
    initSchema(_db);
  }
  return _db;
}

function initSchema(db: Database) {
  db.run(`
    CREATE TABLE IF NOT EXISTS my_codes (
      code TEXT PRIMARY KEY
    )
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS watch_dirs (
      id   INTEGER PRIMARY KEY AUTOINCREMENT,
      path TEXT UNIQUE NOT NULL
    )
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS app_kv (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS games (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      file_path       TEXT UNIQUE NOT NULL,
      file_hash       TEXT UNIQUE NOT NULL,
      played_at       DATETIME,
      stage_id        INTEGER,
      duration_frames INTEGER NOT NULL,
      platform        TEXT,
      slp_version     TEXT,
      is_teams        INTEGER NOT NULL DEFAULT 0,
      ingested_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS players (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      game_id         INTEGER NOT NULL REFERENCES games(id) ON DELETE CASCADE,
      port            INTEGER NOT NULL,
      character_id    INTEGER,
      character_color INTEGER,
      display_name    TEXT,
      connect_code    TEXT,
      is_me           INTEGER NOT NULL DEFAULT 0,
      start_stocks    INTEGER,
      end_stocks      INTEGER,
      is_winner       INTEGER
    )
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS stats (
      id                         INTEGER PRIMARY KEY AUTOINCREMENT,
      game_id                    INTEGER NOT NULL REFERENCES games(id) ON DELETE CASCADE,
      player_id                  INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
      neutral_wins               INTEGER,
      neutral_losses             INTEGER,
      conversions_total          INTEGER,
      conversion_rate            REAL,
      openings_per_kill          REAL,
      damage_per_opening         REAL,
      lcancel_success            INTEGER,
      lcancel_total              INTEGER,
      lcancel_rate               REAL,
      damage_done                REAL,
      damage_taken               REAL,
      inputs_per_minute          REAL,
      digital_actions_per_minute REAL,
      total_kills                INTEGER
    )
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS ingest_errors (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      file_path   TEXT NOT NULL,
      error       TEXT NOT NULL,
      occurred_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);
  db.run("CREATE INDEX IF NOT EXISTS idx_players_game_id     ON players(game_id)");
  db.run("CREATE INDEX IF NOT EXISTS idx_players_connect_code ON players(connect_code)");
  db.run("CREATE INDEX IF NOT EXISTS idx_stats_game_id       ON stats(game_id)");
  db.run("CREATE INDEX IF NOT EXISTS idx_stats_player_id     ON stats(player_id)");
  db.run("CREATE INDEX IF NOT EXISTS idx_games_played_at     ON games(played_at)");
  db.run("CREATE INDEX IF NOT EXISTS idx_games_stage         ON games(stage_id)");
}
