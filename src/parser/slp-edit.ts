import { copyFileSync, existsSync, openSync, readSync, writeSync, closeSync, fstatSync } from "node:fs";

const CMD_EVENT_PAYLOADS = 0x35;
const CMD_GAME_END = 0x39;

const GAME_END_METHOD_TIME = 1;
const GAME_END_METHOD_GAME = 2;
const GAME_END_METHOD_NO_CONTEST = 7;

export interface SlpWinnerEditResult {
  ok: boolean;
  error?: string;
  backupPath?: string;
  previousMethod?: number;
  newMethod?: number;
}

/**
 * Rewrite the Game End event (0x39) of a .slp so `winnerPort` wins and `loserPort` loses.
 * Edits bytes in place (same length), so the UBJSON container and metadata stay valid.
 *
 * Game End layout: [0x0 cmd][0x1 method u8][0x2 lrasInitiator s8][0x3..0x6 placements s8 per port]
 * - placements (SLP >= 3.13.0) are what Slippi Launcher / slippi-js use for normal game ends.
 * - TIME ends are resolved from last-frame stocks, so they're switched to GAME to make placements count.
 * - LRAS/no-contest ends are resolved by "who quit", so the initiator is set to the loser.
 * A one-time backup `<file>.bak` is written before the first edit.
 */
export function setSlpWinner(filePath: string, winnerPort: number, loserPort: number): SlpWinnerEditResult {
  if (!existsSync(filePath)) return { ok: false, error: "replay file not found" };

  const fd = openSync(filePath, "r+");
  try {
    const fileSize = fstatSync(fd).size;
    const head = Buffer.alloc(15);
    readSync(fd, head, 0, head.length, 0);

    let rawStart = 0;
    let rawEnd = fileSize;
    if (head[0] === "{".charCodeAt(0)) {
      if (head.subarray(1, 11).toString("latin1") !== "U\x03raw[$U#l") {
        return { ok: false, error: "unrecognized .slp header" };
      }
      rawStart = 15;
      const lenBuf = Buffer.alloc(4);
      readSync(fd, lenBuf, 0, 4, 11);
      const rawLen = lenBuf.readUInt32BE(0);
      rawEnd = rawLen > 0 ? Math.min(fileSize, rawStart + rawLen) : fileSize;
    }

    const raw = Buffer.alloc(rawEnd - rawStart);
    readSync(fd, raw, 0, raw.length, rawStart);
    if (raw[0] !== CMD_EVENT_PAYLOADS) return { ok: false, error: "missing event payloads block" };

    const payloadsSize = raw.readUInt8(1);
    const sizes = new Map<number, number>();
    for (let i = 2; i + 2 < payloadsSize + 1; i += 3) {
      sizes.set(raw.readUInt8(i), raw.readUInt16BE(i + 1));
    }
    sizes.set(CMD_EVENT_PAYLOADS, payloadsSize);

    let gameEndOffset = -1;
    let pos = 0;
    while (pos < raw.length) {
      const cmd = raw.readUInt8(pos);
      const size = sizes.get(cmd);
      if (size === undefined) break;
      if (cmd === CMD_GAME_END) gameEndOffset = pos;
      pos += size + 1;
    }
    if (gameEndOffset < 0) return { ok: false, error: "replay has no game end event (incomplete game?)" };

    const gameEndSize = sizes.get(CMD_GAME_END) ?? 0;
    const hasLras = gameEndSize >= 2;
    const hasPlacements = gameEndSize >= 6;
    const previousMethod = raw.readUInt8(gameEndOffset + 1);

    const ev = Buffer.from(raw.subarray(gameEndOffset, gameEndOffset + gameEndSize + 1));
    let newMethod = previousMethod;

    if (previousMethod === GAME_END_METHOD_NO_CONTEST) {
      if (!hasLras) return { ok: false, error: "replay too old to store LRAS initiator" };
      ev.writeInt8(loserPort, 0x2);
    } else if (!hasPlacements) {
      return { ok: false, error: "replay too old to store placements (needs SLP >= 3.13.0)" };
    } else if (previousMethod === GAME_END_METHOD_TIME) {
      newMethod = GAME_END_METHOD_GAME;
      ev[0x1] = newMethod;
    }

    if (hasPlacements) {
      for (let port = 0; port < 4; port++) {
        const position = port === winnerPort ? 0 : port === loserPort ? 1 : -1;
        ev.writeInt8(position, 0x3 + port);
      }
    }

    const backupPath = `${filePath}.bak`;
    if (!existsSync(backupPath)) copyFileSync(filePath, backupPath);

    writeSync(fd, ev, 0, ev.length, rawStart + gameEndOffset);
    return { ok: true, backupPath, previousMethod, newMethod };
  } finally {
    closeSync(fd);
  }
}
