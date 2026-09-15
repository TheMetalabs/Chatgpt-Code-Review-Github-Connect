export const LIVE_COOLDOWN_MS = 8_000;
export const LIVE_HOUR_CAP = 20;
export const LIVE_HOUR_MS = 60 * 60 * 1000;

export type LiveLimiterState = {
  inFlight: number;
  lastAt: number;
  hourStart: number;
  hourCount: number;
};

export function createLiveLimiter(): LiveLimiterState {
  return { inFlight: 0, lastAt: 0, hourStart: 0, hourCount: 0 };
}

function countThisHour(now: number, lim: LiveLimiterState) {
  if (!lim.hourStart || now - lim.hourStart >= LIVE_HOUR_MS) return 0;
  return lim.hourCount;
}

export function liveAdmit(
  now: number,
  lim: LiveLimiterState,
): { ok: true } | { ok: false; error: string } {
  if (lim.inFlight > 0) {
    return { ok: false, error: "Live agent is already running. Wait for it to finish." };
  }
  if (lim.lastAt > 0 && now - lim.lastAt < LIVE_COOLDOWN_MS) {
    return { ok: false, error: "Live agent is cooling down. Retry in a few seconds." };
  }
  if (countThisHour(now, lim) >= LIVE_HOUR_CAP) {
    return { ok: false, error: "Live agent hourly cap reached. Retry later." };
  }
  if (!lim.hourStart || now - lim.hourStart >= LIVE_HOUR_MS) {
    lim.hourStart = now;
    lim.hourCount = 0;
  }
  lim.inFlight = 1;
  lim.hourCount += 1;
  return { ok: true };
}

export function liveRelease(now: number, lim: LiveLimiterState) {
  lim.inFlight = 0;
  lim.lastAt = now;
}
