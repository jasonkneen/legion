import { useEffect, useState } from "react";
import { chamberPulse, type ChamberPulse } from "./pulse-actions";
import { pulseCadence, pulseWants, type PulseWants } from "./pulse-policy";

/**
 * One poll for the whole chamber, shared by every panel that needs it.
 *
 * Each subscriber says what it needs — the plan, the activity log, the file
 * changes — and the union decides what one request asks the server for. So four
 * panels open still means one timer and one round trip, and closing the
 * activity panel genuinely stops the server running `git status`.
 *
 * Polling stops while the tab is hidden. A background chamber used to keep
 * asking indefinitely, which is the sort of cost nobody notices until there are
 * six tabs open.
 */
export type { PulseWants };

type Subscriber = { wants: PulseWants; live: boolean; notify: (pulse: ChamberPulse) => void };

type Room = {
  subscribers: Set<Subscriber>;
  timer?: ReturnType<typeof setInterval>;
  interval: number;
  inFlight: boolean;
  last?: ChamberPulse;
};

const rooms = new Map<string, Room>();

function room(conversationId: string): Room {
  let existing = rooms.get(conversationId);
  if (!existing) {
    existing = { subscribers: new Set(), interval: 0, inFlight: false };
    rooms.set(conversationId, existing);
  }
  return existing;
}

async function tick(conversationId: string): Promise<void> {
  const r = rooms.get(conversationId);
  if (!r || r.inFlight || !r.subscribers.size) return;
  if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
  r.inFlight = true;
  try {
    const pulse = await chamberPulse({ data: { conversationId, ...pulseWants([...r.subscribers]) } });
    r.last = pulse;
    for (const s of r.subscribers) s.notify(pulse);
  } catch {
    // A failed poll is not worth surfacing: the next one is a second away, and
    // the panels keep showing what they last knew.
  } finally {
    r.inFlight = false;
  }
}

function retime(conversationId: string): void {
  const r = room(conversationId);
  const interval = pulseCadence([...r.subscribers]);
  if (r.timer && r.interval === interval) return;
  if (r.timer) clearInterval(r.timer);
  r.interval = interval;
  r.timer = setInterval(() => void tick(conversationId), interval);
}

/**
 * Subscribe to a chamber's pulse.
 *
 * `wants` must be stable across renders — pass a literal from the caller's own
 * props, not a fresh object each time, or the effect resubscribes on every
 * render. The two booleans are spread into the dependency list to make that
 * safe regardless.
 */
export function usePulse(
  conversationId: string,
  live: boolean,
  wants: PulseWants = {},
): ChamberPulse | undefined {
  const [pulse, setPulse] = useState<ChamberPulse | undefined>(() => rooms.get(conversationId)?.last);
  const wantActivity = Boolean(wants.activity);
  const wantChanges = Boolean(wants.changes);

  useEffect(() => {
    if (!conversationId) return;
    const r = room(conversationId);
    const sub: Subscriber = {
      wants: { activity: wantActivity, changes: wantChanges },
      live,
      notify: setPulse,
    };
    r.subscribers.add(sub);
    retime(conversationId);
    void tick(conversationId);

    // A tab that comes back should be current immediately, not one cadence later.
    const onVisible = () => {
      if (document.visibilityState === "visible") void tick(conversationId);
    };
    document.addEventListener("visibilitychange", onVisible);

    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      r.subscribers.delete(sub);
      if (!r.subscribers.size && r.timer) {
        clearInterval(r.timer);
        r.timer = undefined;
        r.interval = 0;
      } else if (r.subscribers.size) {
        // The one that left may have been the reason for the fast cadence.
        retime(conversationId);
      }
    };
  }, [conversationId, live, wantActivity, wantChanges]);

  return pulse;
}
