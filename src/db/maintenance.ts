import { existsSync } from "node:fs";
import { SlippiGame } from "@slippi/slippi-js/node";
import { getDb } from "./schema";
import { resolvePlayerIdentity } from "../parser/player-identity";

type Db = ReturnType<typeof getDb>;

/**
 * A game's identity independent of where its .slp lives: start time + stage + length + characters per port.
 * Replays get moved around (Melee Unlocked writes to the replay root, Slippi Launcher / the user later sorts
 * them into YYYY-MM folders, archives go to a NAS…). The DB used to key games by path only, so every move
 * produced a second copy of the same game and doubled its stats.
 */
export function gameIdentityKey(
  game: { playedAt: string | null; stageId: number | null; durationFrames: number },
  players: Array<{ port: number; characterId: number | null }>
): string | null {
  if (!game.playedAt) return null;
  const chars = [...players]
    .sort((a, b) => a.port - b.port)
    .map((p) => `${p.port}:${p.characterId ?? ""}`)
    .join(",");
  return `${game.playedAt}|${game.stageId ?? ""}|${game.durationFrames}|${chars}`;
}

const IDENTITY_SQL = `
  SELECT g.id, g.file_path,
    g.played_at || '|' || IFNULL(g.stage_id, '') || '|' || g.duration_frames || '|' || IFNULL((
      SELECT group_concat(k, ',') FROM (
        SELECT p.port || ':' || IFNULL(p.character_id, '') AS k FROM players p WHERE p.game_id = g.id ORDER BY p.port
      )
    ), '') AS identity
  FROM games g
  WHERE g.played_at IS NOT NULL
`;

/**
 * If this game is already in the DB under another path, return it (and re-point it at the new path when the
 * old file is gone, i.e. the replay was moved). Returns null when the game is new.
 */
export function relinkIfKnownGame(
  db: Db,
  newPath: string,
  game: { playedAt: string | null; stageId: number | null; durationFrames: number },
  players: Array<{ port: number; characterId: number | null }>
): { id: number; relinked: boolean } | null {
  const key = gameIdentityKey(game, players);
  if (!key) return null;
  const rows = db
    .query(
      `SELECT * FROM (${IDENTITY_SQL} AND g.played_at = $playedAt AND g.duration_frames = $dur) WHERE identity = $key`
    )
    .all({ $playedAt: game.playedAt, $dur: game.durationFrames, $key: key }) as Array<{
    id: number;
    file_path: string;
  }>;
  const hit = rows[0];
  if (!hit) return null;
  if (hit.file_path !== newPath && !existsSync(hit.file_path)) {
    db.prepare("UPDATE games SET file_path = $p, file_hash = $p WHERE id = $id").run({ $p: newPath, $id: hit.id });
    return { id: hit.id, relinked: true };
  }
  return { id: hit.id, relinked: false };
}

function kvGet(db: Db, key: string): string | undefined {
  return (db.query("SELECT value FROM app_kv WHERE key = $k").get({ $k: key }) as { value: string } | null)?.value;
}

function kvSet(db: Db, key: string, value: string) {
  db.prepare("INSERT INTO app_kv (key, value) VALUES ($k, $v) ON CONFLICT(key) DO UPDATE SET value = $v").run({
    $k: key,
    $v: value,
  });
}

function backupDb(db: Db, tag: string) {
  const dbPath = (db as unknown as { filename?: string }).filename;
  if (!dbPath || dbPath === ":memory:") return;
  const out = `${dbPath}.bak-${tag}-${new Date().toISOString().slice(0, 10)}`;
  if (existsSync(out)) return;
  try {
    db.run(`VACUUM INTO '${out.replace(/'/g, "''")}'`);
    console.log(`[maintenance] backup written: ${out}`);
  } catch (err) {
    console.warn("[maintenance] backup failed:", err);
  }
}

/** Merge rows that are the same game stored under different paths. Keeps edited results and existing files. */
export function dedupeGames(db: Db = getDb()): { groups: number; removed: number } {
  const rows = db.query(`
    SELECT x.id, x.file_path, x.identity, g.result_edited,
      (SELECT COUNT(*) FROM stats s WHERE s.game_id = x.id) AS n_stats
    FROM (${IDENTITY_SQL}) x JOIN games g ON g.id = x.id
  `).all() as Array<{ id: number; file_path: string; identity: string; result_edited: number; n_stats: number }>;

  const byKey = new Map<string, typeof rows>();
  for (const r of rows) {
    const list = byKey.get(r.identity);
    if (list) list.push(r);
    else byKey.set(r.identity, [r]);
  }
  const groups = [...byKey.values()].filter((g) => g.length > 1);
  if (groups.length === 0) return { groups: 0, removed: 0 };

  backupDb(db, "dedupe");
  const delStats = db.prepare("DELETE FROM stats WHERE game_id = $id");
  const delPlayers = db.prepare("DELETE FROM players WHERE game_id = $id");
  const delGame = db.prepare("DELETE FROM games WHERE id = $id");
  const setPath = db.prepare("UPDATE games SET file_path = $p, file_hash = $p WHERE id = $id");
  let removed = 0;

  db.transaction(() => {
    for (const group of groups) {
      const withExists = group.map((r) => ({ ...r, exists: existsSync(r.file_path) }));
      withExists.sort(
        (a, b) =>
          b.result_edited - a.result_edited ||
          Number(b.exists) - Number(a.exists) ||
          Number(b.n_stats > 0) - Number(a.n_stats > 0) ||
          a.id - b.id
      );
      const keeper = withExists[0]!;
      const livePath = keeper.exists ? null : withExists.find((r) => r.exists)?.file_path ?? null;
      for (const r of withExists.slice(1)) {
        delStats.run({ $id: r.id });
        delPlayers.run({ $id: r.id });
        delGame.run({ $id: r.id });
        removed++;
      }
      if (livePath) setPath.run({ $p: livePath, $id: keeper.id });
    }
  })();
  return { groups: groups.length, removed };
}

/**
 * Games ingested before the Melee Unlocked fix have no connect codes (they were only read from metadata).
 * Re-read names/codes from each replay's Game Start block and recompute is_me.
 */
export function repairMissingPlayerCodes(db: Db = getDb()): { checked: number; fixed: number } {
  const myCodes = new Set(
    (db.query("SELECT code FROM my_codes").all() as { code: string }[]).map((r) => r.code.toUpperCase())
  );
  const games = db.query(`
    SELECT g.id, g.file_path FROM games g
    WHERE NOT EXISTS (SELECT 1 FROM players p WHERE p.game_id = g.id AND IFNULL(p.connect_code, '') <> '')
  `).all() as Array<{ id: number; file_path: string }>;

  const update = db.prepare(`
    UPDATE players SET connect_code = $code, display_name = IFNULL($name, display_name), is_me = $isMe
    WHERE game_id = $gameId AND port = $port
  `);
  let checked = 0;
  let fixed = 0;
  for (const g of games) {
    if (!existsSync(g.file_path)) continue;
    checked++;
    try {
      const settings = new SlippiGame(g.file_path).getSettings();
      const players = settings?.players ?? [];
      const ids = players.map((p) => ({ port: p.playerIndex, ...resolvePlayerIdentity(p, null) }));
      if (!ids.some((p) => p.connectCode)) continue;
      db.transaction(() => {
        for (const p of ids) {
          update.run({
            $gameId: g.id,
            $port: p.port,
            $code: p.connectCode,
            $name: p.displayName,
            $isMe: p.connectCode && myCodes.has(p.connectCode) ? 1 : 0,
          });
        }
      })();
      fixed++;
    } catch {
      // unreadable replay — leave as is
    }
  }
  return { checked, fixed };
}

const MAINTENANCE_VERSION = "1";

/** One-off repairs, run in the background at startup (re-run only when MAINTENANCE_VERSION changes). */
export function runStartupMaintenance() {
  const db = getDb();
  if (kvGet(db, "maintenance_version") === MAINTENANCE_VERSION) return;
  setTimeout(() => {
    try {
      const d = dedupeGames(db);
      if (d.removed) console.log(`[maintenance] merged ${d.groups} duplicated games (${d.removed} rows removed)`);
      const r = repairMissingPlayerCodes(db);
      if (r.fixed) console.log(`[maintenance] restored connect codes in ${r.fixed}/${r.checked} games`);
      kvSet(db, "maintenance_version", MAINTENANCE_VERSION);
    } catch (err) {
      console.error("[maintenance] failed:", err);
    }
  }, 500);
}
