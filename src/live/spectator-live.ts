import {
  Command,
  ConnectionEvent,
  ConnectionStatus,
  DolphinConnection,
  SlpParser,
  SlpStream,
  SlpStreamEvent,
  SlpStreamMode,
} from "@slippi/slippi-js/node";
import type { LivePlayer, LiveSnapshotOk } from "../parser/live-snapshot";
import { resolvePlayerIdentity } from "../parser/player-identity";
import { liveTraceDisabled } from "./live-trace";

/**
 * Live game feed straight from the emulator's Slippi spectator server (ENet, default 127.0.0.1:51441).
 *
 * Slippi Dolphin streams the replay to disk while the game is played, so tailing the newest .slp works
 * there. Melee Unlocked instead keeps the replay in memory and writes the whole .slp in one go when the
 * game ends ("replay: recording written to … (N bytes, 1 ms)"), so the file-based live view only ever saw
 * finished games. Both emulators serve the same spectator protocol the Slippi Launcher uses, so we
 * subscribe to it and parse the event stream as it arrives. The file watcher stays as a fallback.
 *
 * Env: SPECTATOR_HOST (default 127.0.0.1), SPECTATOR_PORT (default 51441), SPECTATOR=0 to disable.
 */

const HOST = process.env.SPECTATOR_HOST?.trim() || "127.0.0.1";
const PORT = Number(process.env.SPECTATOR_PORT ?? 51441) || 51441;
const RECONNECT_MS = 3000;
/** After this long without any data while "in game", treat the feed as stale (emulator froze/closed). */
const STALE_MS = 15_000;

export type SpectatorStatus = {
  enabled: boolean;
  host: string;
  port: number;
  connected: boolean;
  emulator: { nick: string | null; version: string | null } | null;
  /** A game's Game Start block has been received and its Game End has not. */
  inGame: boolean;
  lastDataAtMs: number | null;
};

function log(...args: unknown[]) {
  if (!liveTraceDisabled()) console.log("[spectator]", ...args);
}

class SpectatorFeed {
  private conn: DolphinConnection | null = null;
  private stream = new SlpStream({ mode: SlpStreamMode.AUTO, suppressErrors: true });
  private parser = new SlpParser();
  private hasGame = false;
  private gameEnded = false;
  private startedAtIso: string | null = null;
  private lastDataAtMs: number | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  private connected = false;
  private emulator: { nick: string | null; version: string | null } | null = null;

  constructor(private readonly host: string, private readonly port: number) {
    this.stream.on(SlpStreamEvent.COMMAND, ({ command, payload }) => {
      if (command === Command.MESSAGE_SIZES) {
        // Every game starts with the Event Payloads command: reset per-game state.
        this.parser.reset();
        this.hasGame = true;
        this.gameEnded = false;
        this.startedAtIso = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
        return;
      }
      try {
        this.parser.handleCommand(command, payload);
      } catch {
        // Malformed / partial event — keep the feed alive.
      }
      if (command === Command.GAME_START) log("game start");
      if (command === Command.GAME_END) {
        this.gameEnded = true;
        log("game end");
      }
    });
  }

  start() {
    this.stopped = false;
    void this.connect();
  }

  stop() {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    try {
      this.conn?.disconnect();
    } catch {
      // ignore
    }
    this.conn = null;
  }

  private scheduleReconnect() {
    if (this.stopped || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect();
    }, RECONNECT_MS);
  }

  private async connect() {
    if (this.stopped) return;
    const conn = new DolphinConnection();
    this.conn = conn;

    conn.on(ConnectionEvent.STATUS_CHANGE, (status) => {
      if (this.conn !== conn) return;
      if (status === ConnectionStatus.CONNECTED) {
        if (!this.connected) log(`connected to ${this.host}:${this.port}`);
        this.connected = true;
      } else if (status === ConnectionStatus.DISCONNECTED) {
        if (this.connected) log("disconnected");
        this.connected = false;
        this.emulator = null;
        // A new connection replays from the current game's start (cursor 0), so drop partial state.
        this.stream.restart();
        this.hasGame = false;
        this.gameEnded = false;
        this.conn = null;
        this.scheduleReconnect();
      }
    });
    conn.on(ConnectionEvent.HANDSHAKE, (details) => {
      this.emulator = { nick: details.consoleNick || null, version: details.version || null };
      log("handshake", this.emulator);
    });
    conn.on(ConnectionEvent.DATA, (data) => {
      this.lastDataAtMs = Date.now();
      try {
        this.stream.process(data);
      } catch {
        // suppressErrors is on; just in case
      }
    });
    conn.on(ConnectionEvent.ERROR, () => {
      // Cursor mismatches etc. — the stream keeps going.
    });

    try {
      await conn.connect(this.host, this.port);
    } catch (err) {
      log("connect failed:", err instanceof Error ? err.message : String(err));
      if (this.conn === conn) this.conn = null;
      this.scheduleReconnect();
    }
  }

  status(): SpectatorStatus {
    return {
      enabled: true,
      host: this.host,
      port: this.port,
      connected: this.connected,
      emulator: this.emulator,
      inGame: this.isInGame(),
      lastDataAtMs: this.lastDataAtMs,
    };
  }

  private isInGame(): boolean {
    if (!this.connected || !this.hasGame || this.gameEnded) return false;
    if (!this.parser.getSettings()) return false;
    if (this.lastDataAtMs != null && Date.now() - this.lastDataAtMs > STALE_MS) return false;
    return true;
  }

  /** Snapshot of the game in progress, shaped like the file-based live snapshot. */
  snapshot(): LiveSnapshotOk | null {
    if (!this.isInGame()) return null;
    const settings = this.parser.getSettings();
    if (!settings) return null;

    const endStocks = new Map<number, number>();
    const percent = new Map<number, number>();
    const latest = this.parser.getLatestFrame();
    for (const [idx, fd] of Object.entries(latest?.players ?? {})) {
      const post = (fd as { post?: { stocksRemaining?: number | null; percent?: number | null } } | undefined)?.post;
      if (typeof post?.stocksRemaining === "number") endStocks.set(Number(idx), post.stocksRemaining);
      if (typeof post?.percent === "number") percent.set(Number(idx), post.percent);
    }

    const players: LivePlayer[] = (settings.players ?? []).map((p) => {
      const { displayName, connectCode } = resolvePlayerIdentity(p, null);
      return {
        port: p.playerIndex,
        characterId: p.characterId ?? null,
        characterColor: p.characterColor ?? null,
        displayName,
        connectCode,
        startStocks: p.startStocks ?? null,
        endStocks: endStocks.get(p.playerIndex) ?? null,
        percent: percent.get(p.playerIndex) ?? null,
      };
    });

    return {
      ok: true,
      filePath: `spectator://${this.host}:${this.port}`,
      gameEnded: false,
      game: {
        stageId: settings.stageId ?? null,
        // Same meaning as metadata.lastFrame in a finished replay (frame index, starts at -123).
        durationFrames: Math.max(0, this.parser.getLatestFrameNumber()),
        platform: "dolphin",
        slpVersion: settings.slpVersion ?? null,
        isTeams: settings.isTeams ?? false,
        playedAt: this.startedAtIso,
      },
      players,
    };
  }
}

let feed: SpectatorFeed | null = null;

function spectatorDisabled(): boolean {
  const v = (process.env.SPECTATOR ?? "1").toLowerCase();
  return v === "0" || v === "false" || v === "off";
}

export function startSpectatorFeed() {
  if (feed || spectatorDisabled()) return;
  feed = new SpectatorFeed(HOST, PORT);
  feed.start();
  log(`listening for a Slippi spectator server on ${HOST}:${PORT} (Melee Unlocked / Slippi Dolphin)`);
}

export function stopSpectatorFeed() {
  feed?.stop();
  feed = null;
}

export function getSpectatorStatus(): SpectatorStatus {
  return (
    feed?.status() ?? {
      enabled: false,
      host: HOST,
      port: PORT,
      connected: false,
      emulator: null,
      inGame: false,
      lastDataAtMs: null,
    }
  );
}

export function getSpectatorSnapshot(): LiveSnapshotOk | null {
  return feed?.snapshot() ?? null;
}
