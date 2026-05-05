#!/usr/bin/env bun
/**
 * One-off: re-parse each `games.file_path` and UPDATE `players.end_stocks` / `is_winner`.
 * Same logic as ingest; missing files are skipped.
 *
 * Prefer stopping the web app and ingest while this runs to avoid SQLite contention.
 *
 *   bun scripts/refresh-player-stocks.ts
 */
import { getDb } from "../src/db/schema";
import {
  getRefreshPlayerStocksProgress,
  refreshPlayerEndStocksFromReplayFiles,
} from "../src/parser/ingest";

getDb();

const POLL_MS = 400;

function line(): string {
  const p = getRefreshPlayerStocksProgress();
  const pct = p.total > 0 ? Math.round((100 * p.done) / p.total) : 0;
  return `${p.done}/${p.total} (${pct}%) — games OK ${p.gamesProcessed}, parse errors ${p.parseErrors}, missing files ${p.missingFiles}`;
}

async function main() {
  const db = getDb();
  const n = (db.query("SELECT COUNT(*) AS n FROM games").get() as { n: number }).n;
  if (n === 0) {
    console.log("No games in the database. Nothing to refresh.");
    process.exit(0);
  }

  console.log(`Refreshing stocks from ${n} replay file(s). Live progress every ${POLL_MS}ms.\n`);

  const work = refreshPlayerEndStocksFromReplayFiles();
  const interval = setInterval(() => {
    const p = getRefreshPlayerStocksProgress();
    if (p.running) process.stdout.write(`\r${line()}   `);
  }, POLL_MS);

  try {
    const summary = await work;
    clearInterval(interval);
    process.stdout.write("\r");
    console.log(line());
    console.log("\nSummary:");
    console.log(`  Games re-parsed:     ${summary.gamesProcessed}`);
    console.log(`  Player rows updated: ${summary.playerRowsUpdated}`);
    console.log(`  Parse errors:        ${summary.parseErrors}`);
    console.log(`  Missing files:       ${summary.missingFiles}`);
  } catch (e) {
    clearInterval(interval);
    process.stdout.write("\r");
    const p = getRefreshPlayerStocksProgress();
    const msg = p.lastError ?? (e instanceof Error ? e.message : String(e));
    console.error("\nError:", msg);
    process.exit(1);
  }
}

await main();
