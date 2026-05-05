import { SlippiGame } from "@slippi/slippi-js/node";
import type { LiveTrace } from "../live/live-trace";
import { liveParseVerbose } from "../live/live-trace";

/**
 * Same approach as slippi-ops MatchTracker: SlippiGame with processOnTheFly + one instance per path
 * so the parser keeps up while the .slp is still being written.
 * @see https://github.com/visgotti/slippi-ops/blob/master/libs/tracker-core/src/MatchTracker.ts
 */
let liveGameCache: { path: string; game: SlippiGame } | null = null;

function getLiveSlippiGame(filePath: string): SlippiGame {
  if (!liveGameCache || liveGameCache.path !== filePath) {
    liveGameCache = { path: filePath, game: new SlippiGame(filePath, { processOnTheFly: true }) };
  }
  return liveGameCache.game;
}

/** Call when tearing down (optional); switching paths already replaces the cache. */
export function clearLiveSlippiGameCache() {
  liveGameCache = null;
}

export type LivePlayer = {
  port: number;
  characterId: number | null;
  characterColor: number | null;
  displayName: string | null;
  connectCode: string | null;
  startStocks: number | null;
  endStocks: number | null;
  /** Damage % from latest frame (slippi-ops-style live read). */
  percent: number | null;
};

export type LiveSnapshotOk = {
  ok: true;
  filePath: string;
  /** Slippi parser has seen GAME_END — treat as finished and go back to watching. */
  gameEnded: boolean;
  game: {
    stageId: number | null;
    durationFrames: number;
    platform: string | null;
    slpVersion: string | null;
    isTeams: boolean;
    playedAt: string | null;
  };
  players: LivePlayer[];
};

export type LiveSnapshotErr = {
  ok: false;
  filePath: string;
  error: string;
};

/** Read game settings + latest frame from a replay that may still be writing (in progress). */
export function parseLiveReplay(filePath: string, trace?: LiveTrace): LiveSnapshotOk | LiveSnapshotErr {
  const v = liveParseVerbose();
  try {
    trace?.step("parse:getGame");
    const game = getLiveSlippiGame(filePath);
    if (v) trace?.step("parse:getSettings:before");
    const settings = game.getSettings();
    if (v) trace?.step("parse:getSettings:after", { has: Boolean(settings) });
    if (v) trace?.step("parse:getMetadata:before");
    const metadata = game.getMetadata();
    if (v) trace?.step("parse:getMetadata:after", { lastFrame: metadata?.lastFrame ?? null });

    if (!settings) {
      return { ok: false, filePath, error: "No settings found" };
    }

    const playerCount = settings.players?.length ?? 0;
    if (playerCount !== 2) {
      return { ok: false, filePath, error: `not_1v1:${playerCount}` };
    }

    const lastFrame = metadata?.lastFrame ?? 0;
    const endStocksByPort = new Map<number, number>();
    const percentByPort = new Map<number, number>();
    try {
      if (v) trace?.step("parse:getLatestFrame:before");
      const latestFrame = game.getLatestFrame();
      if (v) trace?.step("parse:getLatestFrame:after", { frame: latestFrame?.frame ?? null });
      if (latestFrame?.players) {
        for (const [playerIndex, frameData] of Object.entries(latestFrame.players)) {
          const idx = Number(playerIndex);
          const post = (frameData as { post?: { stocksRemaining?: number; percent?: number } })?.post;
          if (typeof post?.stocksRemaining === "number") {
            endStocksByPort.set(idx, post.stocksRemaining);
          }
          if (typeof post?.percent === "number") {
            percentByPort.set(idx, post.percent);
          }
        }
      }
    } catch {
      // Incomplete file — stocks may be missing until more data is written.
    }

    const players: LivePlayer[] = (settings.players ?? []).map((p) => {
      const metaPlayer = metadata?.players?.[p.playerIndex];
      const codeFromSettings =
        typeof p.connectCode === "string" && p.connectCode.trim() ? p.connectCode.trim() : null;
      const codeFromMeta = metaPlayer?.names?.code?.trim() || null;
      const nameFromSettings =
        (typeof p.displayName === "string" && p.displayName.trim() ? p.displayName.trim() : null) ??
        (typeof p.nametag === "string" && p.nametag.trim() ? p.nametag.trim() : null);
      const nameFromMeta = metaPlayer?.names?.netplay?.trim() || null;
      return {
        port: p.playerIndex,
        characterId: p.characterId ?? null,
        characterColor: p.characterColor ?? null,
        displayName: nameFromSettings ?? nameFromMeta ?? null,
        connectCode: codeFromSettings ?? codeFromMeta ?? null,
        startStocks: p.startStocks ?? null,
        endStocks: endStocksByPort.get(p.playerIndex) ?? null,
        percent: percentByPort.get(p.playerIndex) ?? null,
      };
    });

    if (v) trace?.step("parse:getGameEnd:before");
    const gameEnded = game.getGameEnd() != null;
    if (v) trace?.step("parse:getGameEnd:after", { gameEnded });

    return {
      ok: true,
      filePath,
      gameEnded,
      game: {
        stageId: settings.stageId ?? null,
        durationFrames: lastFrame,
        platform: metadata?.playedOn ?? null,
        slpVersion: settings.slpVersion ?? null,
        isTeams: settings.isTeams ?? false,
        playedAt: metadata?.startAt ?? null,
      },
      players,
    };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, filePath, error: msg };
  }
}
