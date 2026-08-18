/**
 * How the chamber's shared poll decides its cadence and its payload.
 *
 * Pure, and separate from the hook, because both rules have a failure mode that
 * is invisible in the UI: a cadence that quietly drops to the idle rate during a
 * turn (an approval prompt then takes seconds to appear), and a payload that
 * quietly asks for expensive data no panel is showing.
 */
export type PulseWants = { activity?: boolean; changes?: boolean };

/** While a seat is working a human may be waiting on an approval; idle is upkeep. */
export const LIVE_MS = 1200;
export const IDLE_MS = 8000;

/** The most urgent subscriber sets the pace — never the last one to mount. */
export function pulseCadence(subscribers: { live: boolean }[]): number {
  return subscribers.some((s) => s.live) ? LIVE_MS : IDLE_MS;
}

/** Ask only for what some panel is actually showing. */
export function pulseWants(subscribers: { wants: PulseWants }[]): PulseWants {
  const wants: PulseWants = {};
  for (const s of subscribers) {
    if (s.wants.activity) wants.activity = true;
    if (s.wants.changes) wants.changes = true;
  }
  return wants;
}
