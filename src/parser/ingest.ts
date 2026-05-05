import { existsSync, readdirSync } from "fs";
import { join, extname } from "path";
import { cpus } from "os";
import { getDb } from "../db/schema";
import { parseSlp } from "./worker";
import type { ParseResult, ParseError, ParseMode } from "./worker";

const BATCH_SIZE = 100;
const MAX_WORKERS = 16;
const DEFAULT_WORKERS = Math.max(1, Math.min(MAX_WORKERS, Number(process.env.INGEST_WORKERS ?? 6)));
const BACKFILL_BATCH_SIZE = Math.max(50, Number(process.env.BACKFILL_BATCH_SIZE ?? 300));
const BACKFILL_WORKERS = Math.max(1, Math.min(MAX_WORKERS, Number(process.env.BACKFILL_WORKERS ?? Math.max(1, Math.floor(DEFAULT_WORKERS / 2)))));
const backfillAbort = { stop: false };
let activeIngestPool: ParserWorkerPool | null = null;
let activeBackfillPool: ParserWorkerPool | null = null;

export interface IngestProgress {
  total: number;
  parsed: number;
  processed: number;
  inserted: number;
  skipped: number;
  errors: number;
  tooShort: number;
  startedAtMs: number;
  /** Wall time when phase 1 (fast DB ingest) finished. */
  endedAtMs?: number;
}

export interface BackfillProgress {
  running: boolean;
  total: number;
  processed: number;
  updated: number;
  errors: number;
  startedAtMs: number;
  /** Wall time when phase 2 (stats backfill) finished. */
  endedAtMs?: number;
}

let backfillStatus: BackfillProgress = {
  running: false,
  total: 0,
  processed: 0,
  updated: 0,
  errors: 0,
  startedAtMs: 0,
  endedAtMs: undefined,
};

function collectSlpFiles(dir: string): string[] {
  const files: string[] = [];
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        files.push(...collectSlpFiles(full));
      } else if (entry.isFile() && extname(entry.name).toLowerCase() === ".slp") {
        files.push(full);
      }
    }
  } catch {
    // unreadable dir, skip
  }
  return files;
}

class ParserWorkerPool {
  private workers: Worker[] = [];
  private workerCount: number;
  private initialized = false;
  private nextWorker = 0;
  private nextMsgId = 1;
  private pending = new Map<number, {
    resolve: (value: ParseResult | ParseError) => void;
    reject: (reason?: unknown) => void;
  }>();

  constructor(workerCount = DEFAULT_WORKERS) {
    this.workerCount = Math.max(1, workerCount);
  }

  private init() {
    if (this.initialized) return;
    this.initialized = true;
    for (let i = 0; i < this.workerCount; i++) {
      const worker = new Worker(new URL("./parse.worker.ts", import.meta.url).href, { type: "module" });
      worker.onmessage = (ev: MessageEvent<{ id: number; idx: number; result: ParseResult | ParseError }>) => {
        const msg = this.pending.get(ev.data.id);
        if (!msg) return;
        this.pending.delete(ev.data.id);
        msg.resolve(ev.data.result);
      };
      worker.onerror = (err) => {
        // Pool-level failure: reject all pending jobs.
        for (const [, msg] of this.pending) {
          msg.reject(err);
        }
        this.pending.clear();
      };
      this.workers.push(worker);
    }
  }

  private parseOne(filePath: string, idx: number, mode: ParseMode): Promise<ParseResult | ParseError> {
    this.init();
    const worker = this.workers[this.nextWorker % this.workers.length];
    if (!worker) {
      return Promise.reject(new Error("Parser worker pool is not initialized"));
    }
    this.nextWorker++;
    const id = this.nextMsgId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      worker.postMessage({ id, idx, filePath, mode });
    });
  }

  async parseBatch(
    files: string[],
    mode: ParseMode,
    onItemDone?: (idx: number, result: ParseResult | ParseError) => void
  ): Promise<Array<ParseResult | ParseError>> {
    if (files.length === 0) return [];
    return Promise.all(
      files.map((filePath, idx) => {
        return this.parseOne(filePath, idx, mode).then((result) => {
          onItemDone?.(idx, result);
          return result;
        });
      })
    );
  }

  shutdown(reason: unknown = new Error("Parser worker pool shutdown")) {
    for (const [, msg] of this.pending) {
      msg.reject(reason);
    }
    for (const w of this.workers) w.terminate();
    this.workers = [];
    this.initialized = false;
    this.nextWorker = 0;
    this.pending.clear();
  }
}

export function stopParserWork() {
  backfillAbort.stop = true;
  const wasBackfill = backfillStatus.running;
  activeIngestPool?.shutdown(new Error("Ingest cancelled"));
  activeBackfillPool?.shutdown(new Error("Backfill cancelled"));
  backfillStatus.running = false;
  if (wasBackfill) backfillStatus.endedAtMs = Date.now();
}

export function getBackfillStatus(): BackfillProgress {
  return { ...backfillStatus };
}

type BackfillJob = {
  gameId: number;
  filePath: string;
};

/** Avoid duplicate concurrent auto-ingests for the same path from LIVE polling. */
const liveAutoIngestPending = new Set<string>();

/**
 * If this finished replay is not in the DB yet, parse and insert it (then stats backfill),
 * so LIVE “recent games” can refresh without a full manual ingest.
 * Skips when main ingest or backfill is already running, or path is already imported.
 */
export async function tryIngestCompletedLiveReplay(
  filePath: string,
  mainIngestRunning = false
): Promise<void> {
  if (mainIngestRunning) return;
  if (refreshPlayerStocksRunning) return;
  if (getBackfillStatus().running) return;
  if (liveAutoIngestPending.has(filePath)) return;

  const db = getDb();
  const exists = db.query("SELECT 1 AS n FROM games WHERE file_path = $p").get({ $p: filePath });
  if (exists) return;

  liveAutoIngestPending.add(filePath);
  try {
    const myCodes = new Set(
      (db.query("SELECT code FROM my_codes").all() as { code: string }[]).map((r) => r.code.toUpperCase())
    );

    const insertGame = db.prepare(`
    INSERT OR IGNORE INTO games (file_path, file_hash, played_at, stage_id, duration_frames, platform, slp_version, is_teams)
    VALUES ($filePath, $fileHash, $playedAt, $stageId, $durationFrames, $platform, $slpVersion, $isTeams)
  `);
    const insertPlayer = db.prepare(`
    INSERT INTO players (game_id, port, character_id, character_color, display_name, connect_code, is_me, start_stocks, end_stocks, is_winner)
    VALUES ($gameId, $port, $characterId, $characterColor, $displayName, $connectCode, $isMe, $startStocks, $endStocks, $isWinner)
  `);
    const insertError = db.prepare("INSERT INTO ingest_errors (file_path, error) VALUES ($path, $error)");

    const result = await parseSlp(filePath, "fast");
    if (!result.ok) {
      if (!result.error.startsWith("too_short:") && !result.error.startsWith("skip_not_1v1:")) {
        insertError.run({ $path: result.filePath, $error: `live_auto:${result.error}` });
      }
      return;
    }

    const jobs: BackfillJob[] = [];
    db.transaction(() => {
      const info = insertGame.run({
        $filePath: result.filePath,
        $fileHash: result.filePath,
        $playedAt: result.game.playedAt,
        $stageId: result.game.stageId,
        $durationFrames: result.game.durationFrames,
        $platform: result.game.platform,
        $slpVersion: result.game.slpVersion,
        $isTeams: result.game.isTeams ? 1 : 0,
      });
      if (info.changes === 0) return;
      const gameId = info.lastInsertRowid as number;

      for (const p of result.players) {
        const isMe = p.connectCode ? myCodes.has(p.connectCode.toUpperCase()) : false;
        insertPlayer.run({
          $gameId: gameId,
          $port: p.port,
          $characterId: p.characterId,
          $characterColor: p.characterColor,
          $displayName: p.displayName,
          $connectCode: p.connectCode,
          $isMe: isMe ? 1 : 0,
          $startStocks: p.startStocks,
          $endStocks: p.endStocks,
          $isWinner: p.isWinner === null ? null : p.isWinner ? 1 : 0,
        });
      }

      jobs.push({ gameId, filePath: result.filePath });
    })();

    if (jobs.length > 0) {
      void backfillStatsInBackground(jobs, myCodes, insertError);
    }
  } finally {
    liveAutoIngestPending.delete(filePath);
  }
}

async function backfillStatsInBackground(
  jobs: BackfillJob[],
  myCodes: Set<string>,
  insertError: ReturnType<ReturnType<typeof getDb>["prepare"]>
) {
  if (jobs.length === 0) return;
  backfillAbort.stop = false;
  backfillStatus = {
    running: true,
    total: jobs.length,
    processed: 0,
    updated: 0,
    errors: 0,
    startedAtMs: Date.now(),
    endedAtMs: undefined,
  };
  const db = getDb();
  const pool = new ParserWorkerPool(BACKFILL_WORKERS);
  activeBackfillPool = pool;
  const deleteStatsByGame = db.prepare("DELETE FROM stats WHERE game_id = $gameId");
  const selectPlayersByGame = db.prepare("SELECT id, port FROM players WHERE game_id = $gameId");
  const updatePlayer = db.prepare(`
    UPDATE players
    SET end_stocks = $endStocks,
        is_winner = $isWinner,
        is_me = $isMe
    WHERE game_id = $gameId AND port = $port
  `);
  const insertStats = db.prepare(`
    INSERT INTO stats (game_id, player_id, neutral_wins, neutral_losses, conversions_total, conversion_rate,
      openings_per_kill, damage_per_opening, lcancel_success, lcancel_total, lcancel_rate,
      damage_done, damage_taken, inputs_per_minute, digital_actions_per_minute, total_kills)
    VALUES ($gameId, $playerId, $neutralWins, $neutralLosses, $conversionsTotal, $conversionRate,
      $openingsPerKill, $damagePerOpening, $lcancelSuccess, $lcancelTotal, $lcancelRate,
      $damageDone, $damageTaken, $inputsPerMinute, $digitalActionsPerMinute, $totalKills)
  `);

  try {
    for (let i = 0; i < jobs.length; i += BACKFILL_BATCH_SIZE) {
      if (backfillAbort.stop) break;
      const batch = jobs.slice(i, i + BACKFILL_BATCH_SIZE);
      let results: Array<ParseResult | ParseError>;
      try {
        results = await pool.parseBatch(batch.map((j) => j.filePath), "full");
      } catch {
        if (backfillAbort.stop) break;
        results = await Promise.all(batch.map((j) => parseSlp(j.filePath, "full")));
      }

      db.transaction(() => {
        for (let j = 0; j < batch.length; j++) {
          const job = batch[j];
          const result = results[j];
          if (!job || !result) continue;
          backfillStatus.processed++;
          if (!result.ok) {
            if (result.error.startsWith("skip_not_1v1:")) {
              continue;
            }
            insertError.run({ $path: result.filePath, $error: `backfill:${result.error}` });
            backfillStatus.errors++;
            continue;
          }

          const players = (selectPlayersByGame.all({ $gameId: job.gameId }) as Array<{ id: number; port: number }>);
          const playerByPort = new Map(players.map((p) => [p.port, p.id]));
          deleteStatsByGame.run({ $gameId: job.gameId });

          for (const p of result.players) {
            const isMe = p.connectCode ? myCodes.has(p.connectCode.toUpperCase()) : false;
            updatePlayer.run({
              $gameId: job.gameId,
              $port: p.port,
              $endStocks: p.endStocks,
              $isWinner: p.isWinner === null ? null : p.isWinner ? 1 : 0,
              $isMe: isMe ? 1 : 0,
            });
          }

          for (const s of result.stats) {
            const playerId = playerByPort.get(s.port);
            if (!playerId) continue;
            insertStats.run({
              $gameId: job.gameId,
              $playerId: playerId,
              $neutralWins: s.neutralWins,
              $neutralLosses: s.neutralLosses,
              $conversionsTotal: s.conversionsTotal,
              $conversionRate: s.conversionRate,
              $openingsPerKill: s.openingsPerKill,
              $damagePerOpening: s.damagePerOpening,
              $lcancelSuccess: s.lcancelSuccess,
              $lcancelTotal: s.lcancelTotal,
              $lcancelRate: s.lcancelRate,
              $damageDone: s.damageDone,
              $damageTaken: s.damageTaken,
              $inputsPerMinute: s.inputsPerMinute,
              $digitalActionsPerMinute: s.digitalActionsPerMinute,
              $totalKills: s.totalKills,
            });
          }
          backfillStatus.updated++;
        }
      })();
    }
  } finally {
    pool.shutdown();
    activeBackfillPool = null;
    backfillStatus.endedAtMs = Date.now();
    backfillStatus.running = false;
  }
}

export async function ingest(
  onProgress?: (p: IngestProgress) => void,
  abortRef?: { stop: boolean }
): Promise<IngestProgress> {
  backfillAbort.stop = false;
  backfillStatus = {
    running: false,
    total: 0,
    processed: 0,
    updated: 0,
    errors: 0,
    startedAtMs: 0,
    endedAtMs: undefined,
  };
  const parserPool = new ParserWorkerPool();
  activeIngestPool = parserPool;
  let workerPoolHealthy = true;
  const db = getDb();

  const dirs = db.query("SELECT path FROM watch_dirs").all() as { path: string }[];
  const myCodes = new Set(
    (db.query("SELECT code FROM my_codes").all() as { code: string }[]).map((r) => r.code.toUpperCase())
  );

  const allFiles: string[] = [];
  for (const { path } of dirs) {
    allFiles.push(...collectSlpFiles(path));
  }

  const existingPaths = new Set(
    (db.query("SELECT file_path FROM games").all() as { file_path: string }[]).map((r) => r.file_path)
  );

  const toProcess = allFiles.filter((f) => !existingPaths.has(f));

  const progress: IngestProgress = {
    total: toProcess.length,
    parsed: 0,
    processed: 0,
    inserted: 0,
    skipped: 0,
    errors: 0,
    tooShort: 0,
    startedAtMs: Date.now(),
  };
  onProgress?.(progress);

  const insertGame = db.prepare(`
    INSERT OR IGNORE INTO games (file_path, file_hash, played_at, stage_id, duration_frames, platform, slp_version, is_teams)
    VALUES ($filePath, $fileHash, $playedAt, $stageId, $durationFrames, $platform, $slpVersion, $isTeams)
  `);
  const insertPlayer = db.prepare(`
    INSERT INTO players (game_id, port, character_id, character_color, display_name, connect_code, is_me, start_stocks, end_stocks, is_winner)
    VALUES ($gameId, $port, $characterId, $characterColor, $displayName, $connectCode, $isMe, $startStocks, $endStocks, $isWinner)
  `);
  const insertError = db.prepare("INSERT INTO ingest_errors (file_path, error) VALUES ($path, $error)");
  const backfillJobs: BackfillJob[] = [];

  try {
    for (let i = 0; i < toProcess.length; i += BATCH_SIZE) {
      if (abortRef?.stop) break;

      const batch = toProcess.slice(i, i + BATCH_SIZE);

      // Parse with worker threads. Fallback to main-thread parsing on worker errors.
      let results: Array<ParseResult | ParseError>;
      if (workerPoolHealthy) {
        try {
          results = await parserPool.parseBatch(
            batch,
            "fast",
            () => {
              progress.parsed++;
              onProgress?.(progress);
            }
          );
        } catch {
          if (abortRef?.stop) break;
          workerPoolHealthy = false;
          parserPool.shutdown();
          results = await Promise.all(
            batch.map((f) =>
              parseSlp(f, "fast").then((result) => {
                progress.parsed++;
                onProgress?.(progress);
                return result;
              })
            )
          );
        }
      } else {
        results = await Promise.all(
          batch.map((f) =>
            parseSlp(f, "fast").then((result) => {
              progress.parsed++;
              onProgress?.(progress);
              return result;
            })
          )
        );
      }

      // write batch in a single transaction
      db.transaction(() => {
        for (const result of results) {
          progress.processed++;

          if (!result.ok) {
            if (result.error.startsWith("too_short:")) {
              progress.tooShort++;
            } else if (result.error.startsWith("skip_not_1v1:")) {
              progress.skipped++;
            } else {
              insertError.run({ $path: result.filePath, $error: result.error });
              progress.errors++;
            }
            continue;
          }

          const info = insertGame.run({
            $filePath: result.filePath,
            // Keep schema compatibility without expensive hashing.
            $fileHash: result.filePath,
            $playedAt: result.game.playedAt,
            $stageId: result.game.stageId,
            $durationFrames: result.game.durationFrames,
            $platform: result.game.platform,
            $slpVersion: result.game.slpVersion,
            $isTeams: result.game.isTeams ? 1 : 0,
          });

          if (info.changes === 0) {
            progress.skipped++;
            continue;
          }

          const gameId = info.lastInsertRowid as number;

          for (const p of result.players) {
            const isMe = p.connectCode ? myCodes.has(p.connectCode.toUpperCase()) : false;
            insertPlayer.run({
              $gameId: gameId,
              $port: p.port,
              $characterId: p.characterId,
              $characterColor: p.characterColor,
              $displayName: p.displayName,
              $connectCode: p.connectCode,
              $isMe: isMe ? 1 : 0,
              $startStocks: p.startStocks,
              $endStocks: p.endStocks,
              $isWinner: p.isWinner === null ? null : p.isWinner ? 1 : 0,
            });
          }

          backfillJobs.push({ gameId, filePath: result.filePath });

          progress.inserted++;
        }
      })();

      onProgress?.(progress);
    }
  } finally {
    parserPool.shutdown();
    activeIngestPool = null;
  }

  progress.endedAtMs = Date.now();

  if (!abortRef?.stop) {
    void backfillStatsInBackground(backfillJobs, myCodes, insertError);
  }

  onProgress?.(progress);
  return progress;
}

let refreshPlayerStocksRunning = false;

export type RefreshPlayerStocksProgress = {
  running: boolean;
  total: number;
  done: number;
  parseErrors: number;
  missingFiles: number;
  gamesProcessed: number;
  playerRowsUpdated: number;
};

let refreshStocksProgress: RefreshPlayerStocksProgress = {
  running: false,
  total: 0,
  done: 0,
  parseErrors: 0,
  missingFiles: 0,
  gamesProcessed: 0,
  playerRowsUpdated: 0,
};
let refreshStocksLastResult: {
  gamesProcessed: number;
  playerRowsUpdated: number;
  parseErrors: number;
  missingFiles: number;
} | null = null;
let refreshStocksLastError: string | null = null;

export function isRefreshPlayerStocksRunning(): boolean {
  return refreshPlayerStocksRunning;
}

export function getRefreshPlayerStocksProgress(): RefreshPlayerStocksProgress & {
  lastResult: typeof refreshStocksLastResult;
  lastError: string | null;
} {
  return {
    ...refreshStocksProgress,
    lastResult: refreshStocksLastResult,
    lastError: refreshStocksLastError,
  };
}

/**
 * Re-parse each stored `games.file_path` with Slippi and UPDATE only
 * `players.end_stocks` and `players.is_winner` (same logic as current ingest).
 * Use after fixing parser behavior so old rows match new replays. Skips missing files.
 */
export async function refreshPlayerEndStocksFromReplayFiles(): Promise<{
  gamesProcessed: number;
  playerRowsUpdated: number;
  parseErrors: number;
  missingFiles: number;
}> {
  if (refreshPlayerStocksRunning) {
    throw new Error("refresh_player_stocks already running");
  }
  refreshPlayerStocksRunning = true;
  refreshStocksLastError = null;
  refreshStocksLastResult = null;
  refreshStocksProgress = {
    running: true,
    total: 0,
    done: 0,
    parseErrors: 0,
    missingFiles: 0,
    gamesProcessed: 0,
    playerRowsUpdated: 0,
  };
  try {
    const db = getDb();
    const games = db.query("SELECT id, file_path FROM games ORDER BY id").all() as { id: number; file_path: string }[];
    const updatePlayer = db.prepare(`
      UPDATE players
      SET end_stocks = $endStocks,
          is_winner = $isWinner
      WHERE game_id = $gameId AND port = $port
    `);

    let gamesProcessed = 0;
    let playerRowsUpdated = 0;
    let parseErrors = 0;
    let missingFiles = 0;

    refreshStocksProgress.total = games.length;

    for (const g of games) {
      if (!existsSync(g.file_path)) {
        missingFiles++;
      } else {
        const result = await parseSlp(g.file_path, "full");
        if (!result.ok) {
          parseErrors++;
        } else {
          gamesProcessed++;
          db.transaction(() => {
            for (const p of result.players) {
              const info = updatePlayer.run({
                $gameId: g.id,
                $port: p.port,
                $endStocks: p.endStocks,
                $isWinner: p.isWinner === null ? null : p.isWinner ? 1 : 0,
              });
              playerRowsUpdated += Number(info.changes ?? 0);
            }
          })();
        }
      }

      refreshStocksProgress.done++;
      refreshStocksProgress.parseErrors = parseErrors;
      refreshStocksProgress.missingFiles = missingFiles;
      refreshStocksProgress.gamesProcessed = gamesProcessed;
      refreshStocksProgress.playerRowsUpdated = playerRowsUpdated;
    }

    const summary = { gamesProcessed, playerRowsUpdated, parseErrors, missingFiles };
    refreshStocksLastResult = summary;
    return summary;
  } catch (e) {
    refreshStocksLastError = e instanceof Error ? e.message : String(e);
    throw e;
  } finally {
    refreshPlayerStocksRunning = false;
    refreshStocksProgress.running = false;
  }
}
