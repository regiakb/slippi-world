/**
 * Resolve a player's netplay name and connect code from a replay.
 *
 * Slippi Dolphin writes them twice: in the Game Start block (`settings.players[i]`) and again in the
 * closing UBJSON metadata (`metadata.players[i].names`). Melee Unlocked only fills the Game Start
 * block and leaves `metadata.players[i].names` empty (`{}`), so reading only the metadata loses the
 * connect code — and with it `is_me` and every per-user stat. Prefer the Game Start block (it is
 * also the only one available while a game is being streamed live) and fall back to metadata.
 */
type SettingsPlayerLike = {
  displayName?: string | null;
  connectCode?: string | null;
  nametag?: string | null;
};

type MetadataPlayerLike = {
  names?: { netplay?: string | null; code?: string | null } | null;
} | null | undefined;

function clean(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t ? t : null;
}

export function resolvePlayerIdentity(
  p: SettingsPlayerLike,
  metaPlayer: MetadataPlayerLike
): { displayName: string | null; connectCode: string | null } {
  const connectCode = clean(p.connectCode) ?? clean(metaPlayer?.names?.code);
  const displayName =
    clean(p.displayName) ?? clean(metaPlayer?.names?.netplay) ?? clean(p.nametag);
  return { displayName, connectCode: connectCode ? connectCode.toUpperCase() : null };
}
