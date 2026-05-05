import { SlippiGame } from "@slippi/slippi-js/node";

const MIN_FRAMES = 1800; // 30s × 60fps
export type ParseMode = "fast" | "full";

export interface ParseResult {
  ok: true;
  filePath: string;
  game: {
    playedAt: string | null;
    stageId: number | null;
    durationFrames: number;
    platform: string | null;
    slpVersion: string | null;
    isTeams: boolean;
  };
  players: Array<{
    port: number;
    characterId: number | null;
    characterColor: number | null;
    displayName: string | null;
    connectCode: string | null;
    startStocks: number | null;
    endStocks: number | null;
    isWinner: boolean | null;
  }>;
  stats: Array<{
    port: number;
    neutralWins: number | null;
    neutralLosses: number | null;
    conversionsTotal: number | null;
    conversionRate: number | null;
    openingsPerKill: number | null;
    damagePerOpening: number | null;
    lcancelSuccess: number | null;
    lcancelTotal: number | null;
    lcancelRate: number | null;
    damageDone: number | null;
    damageTaken: number | null;
    inputsPerMinute: number | null;
    digitalActionsPerMinute: number | null;
    totalKills: number | null;
  }>;
}

export interface ParseError {
  ok: false;
  filePath: string;
  error: string;
}

export async function parseSlp(filePath: string, mode: ParseMode = "full"): Promise<ParseResult | ParseError> {
  try {
    // Parse directly from path to avoid loading full file bytes in JS memory.
    const game = new SlippiGame(filePath);
    const settings = game.getSettings();
    const metadata = game.getMetadata();

    if (!settings) {
      return { ok: false, filePath, error: "No settings found" };
    }
    const playerCount = settings.players?.length ?? 0;
    if (playerCount !== 2) {
      return { ok: false, filePath, error: `skip_not_1v1:${playerCount}` };
    }

    const lastFrame = metadata?.lastFrame ?? 0;
    if (lastFrame < MIN_FRAMES) {
      return { ok: false, filePath, error: `too_short:${lastFrame}` };
    }

    let gameStats: ReturnType<typeof game.getStats> | null = null;
    if (mode === "full") {
      try {
        gameStats = game.getStats();
      } catch {
        // stats calc fails on some old replays — proceed without
      }
    }

    const winnersSet = new Set<number>();

    // Primary: use placements from getGameEnd (available in most modern SLPs)
    try {
      const gameEnd = game.getGameEnd();
      if (gameEnd?.placements?.length) {
        const minPos = Math.min(...gameEnd.placements.filter(p => p.position >= 0).map(p => p.position));
        for (const p of gameEnd.placements) {
          if (p.position === minPos) winnersSet.add(p.playerIndex);
        }
      }
    } catch { /* old format, fall through */ }

    // Fallback: alive stocks → tie-break by damage % (full mode only)
    if (mode === "full" && winnersSet.size === 0 && gameStats?.stocks) {
      const alive = new Map<number, { count: number; pct: number }>();
      for (const stock of gameStats.stocks) {
        if (stock.endFrame == null) {
          const cur = alive.get(stock.playerIndex);
          alive.set(stock.playerIndex, {
            count: (cur?.count ?? 0) + 1,
            pct: Math.min(cur?.pct ?? Infinity, stock.currentPercent ?? 0),
          });
        }
      }
      if (alive.size > 0) {
        const maxStocks = Math.max(...[...alive.values()].map(v => v.count));
        const top = [...alive.entries()].filter(([, v]) => v.count === maxStocks);
        if (top.length === 1) {
          winnersSet.add(top[0][0]);
        } else {
          // equal stocks → lower damage % wins
          const minPct = Math.min(...top.map(([, v]) => v.pct));
          for (const [port, v] of top) {
            if (v.pct === minPct) winnersSet.add(port);
          }
        }
      }
    }

    const latestFrame = game.getLatestFrame();
    const endStocksByPort = new Map<number, number>();
    if (latestFrame?.players) {
      for (const [playerIndex, frameData] of Object.entries(latestFrame.players)) {
        const stocksRemaining = (frameData as any)?.post?.stocksRemaining;
        if (typeof stocksRemaining === "number") {
          endStocksByPort.set(Number(playerIndex), stocksRemaining);
        }
      }
    }

    const players = (settings.players ?? []).map((p) => {
      const metaPlayer = metadata?.players?.[p.playerIndex];
      const statsFallbackStocks = gameStats?.stocks
        ? gameStats.stocks.filter((s) => s.playerIndex === p.playerIndex && s.endFrame == null).length
        : null;
      return {
        port: p.playerIndex,
        characterId: p.characterId ?? null,
        characterColor: p.characterColor ?? null,
        displayName: metaPlayer?.names?.netplay ?? p.displayName ?? null,
        connectCode: metaPlayer?.names?.code ?? null,
        startStocks: p.startStocks ?? null,
        endStocks: endStocksByPort.get(p.playerIndex) ?? statsFallbackStocks,
        isWinner: winnersSet.size > 0 ? winnersSet.has(p.playerIndex) : null,
      };
    });

    const statsArr = mode === "full"
      ? (settings.players ?? []).map((p) => {
          const overall = gameStats?.overall?.find((o) => o.playerIndex === p.playerIndex);
          const actionCounts = gameStats?.actionCounts?.find((a) => a.playerIndex === p.playerIndex);
          const lc = actionCounts?.lCancelCount;
          const lcancelSuccess = lc != null ? lc.success : null;
          const lcancelFail = lc != null ? lc.fail : null;
          const lcancelTotal =
            lcancelSuccess !== null && lcancelFail !== null ? lcancelSuccess + lcancelFail : null;

          return {
            port: p.playerIndex,
            neutralWins: overall?.neutralWinRatio?.count ?? null,
            neutralLosses:
              overall?.neutralWinRatio != null && overall.neutralWinRatio.ratio
                ? Math.round(overall.neutralWinRatio.count / overall.neutralWinRatio.ratio - overall.neutralWinRatio.count)
                : null,
            conversionsTotal: overall?.successfulConversions?.count ?? null,
            conversionRate: overall?.successfulConversions?.ratio ?? null,
            openingsPerKill: overall?.openingsPerKill?.ratio ?? null,
            damagePerOpening: overall?.damagePerOpening?.ratio ?? null,
            lcancelSuccess,
            lcancelTotal,
            lcancelRate: lcancelTotal && lcancelTotal > 0 ? (lcancelSuccess ?? 0) / lcancelTotal : null,
            damageDone: overall?.totalDamage ?? null,
            damageTaken: null,
            inputsPerMinute: overall?.inputsPerMinute?.ratio ?? null,
            digitalActionsPerMinute: overall?.digitalInputsPerMinute?.ratio ?? null,
            totalKills: overall?.killCount ?? null,
          };
        })
      : [];

    return { ok: true, filePath, game: {
      playedAt: metadata?.startAt ?? null,
      stageId: settings.stageId ?? null,
      durationFrames: lastFrame,
      platform: metadata?.playedOn ?? null,
      slpVersion: settings.slpVersion ?? null,
      isTeams: settings.isTeams ?? false,
    }, players, stats: statsArr };
  } catch (err: any) {
    return { ok: false, filePath, error: err?.message ?? String(err) };
  }
}
