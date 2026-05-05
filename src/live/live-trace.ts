/** Set LIVE_DEBUG=0 (or false/off) to silence [live] logs. Default: on. Use LIVE_DEBUG=verbose for per-phase parse timings. */

let liveReqSeq = 0;

export function liveTraceDisabled(): boolean {
  const v = (process.env.LIVE_DEBUG ?? "1").toLowerCase();
  return v === "0" || v === "false" || v === "off";
}

export function liveParseVerbose(): boolean {
  const v = (process.env.LIVE_DEBUG ?? "").toLowerCase();
  return v === "2" || v === "verbose";
}

export type LiveTrace = {
  readonly id: number;
  step(name: string, extra?: Record<string, unknown>): void;
  finish(summary: Record<string, unknown>): void;
};

export function startLiveTrace(): LiveTrace {
  if (liveTraceDisabled()) {
    return {
      id: 0,
      step() {},
      finish() {},
    };
  }
  const id = ++liveReqSeq;
  const t0 = performance.now();
  const prefix = `[live #${id}]`;
  console.log(`${prefix} START`);
  return {
    id,
    step(name, extra) {
      const ms = Math.round(performance.now() - t0);
      if (extra && Object.keys(extra).length) console.log(`${prefix} +${ms}ms ${name}`, extra);
      else console.log(`${prefix} +${ms}ms ${name}`);
    },
    finish(summary) {
      const ms = Math.round(performance.now() - t0);
      console.log(`${prefix} END +${ms}ms`, summary);
      if (ms >= 3000) console.error(`${prefix} SLOW +${ms}ms (possible stall inside Slippi or disk I/O)`);
      else if (ms >= 1000) console.warn(`${prefix} slow +${ms}ms`);
    },
  };
}

export function logLiveStartupHint() {
  if (liveTraceDisabled()) {
    console.log("[live] LIVE_DEBUG=0 — /api/live request tracing is off.");
    return;
  }
  console.log(
    "[live] Tracing ON: each GET /api/live logs START → steps → END on this Bun console. Set LIVE_DEBUG=verbose for parse sub-steps. Set LIVE_DEBUG=0 to disable.",
  );
}
