import { newId } from "./ids";
import type { ToolContext } from "./tools.server";

/**
 * Short-lived tokens that let an external agent process call back into this
 * turn's tools.
 *
 * The grok CLI cannot ask a human mid-turn — measured every way its docs offer:
 * `--permission-mode`, a private `GROK_HOME`, its own leader socket, and
 * `_meta.yoloMode`. Its ACP sessions auto-approve their built-in tools whatever
 * the workstation's config says, so a seat given write tools would edit the
 * disk unannounced.
 *
 * The way round it is not to use grok's tools at all. Legion hands it *our*
 * tools over MCP; they execute in this process, where the approval registry
 * already lives, so grok's own permission model never enters into it. A token
 * is what ties an incoming tool call back to the turn that is allowed to make
 * it — it names the chamber, the seat and the user, so a leaked token cannot
 * reach another chamber, and it dies when the turn does.
 */
/**
 * What a seat may reach through the bridge.
 *
 * `all` is for a seat with no tools of its own — grok, whose own writers are
 * switched off. `room` is for one that already has good workspace tools and
 * only lacks the things that are about the chat itself: Codex can edit and run
 * commands under its own approvals, so handing it a second set would be two
 * ways to do the same job, each with its own prompt.
 */
export type SeatScope = "all" | "room";

type Grant = { ctx: ToolContext; scope: SeatScope; expiresAt: number };

const globalRef = globalThis as typeof globalThis & { __legionSeatGrants__?: Map<string, Grant> };
function grants(): Map<string, Grant> {
  globalRef.__legionSeatGrants__ ??= new Map();
  return globalRef.__legionSeatGrants__;
}

/** Longer than a turn, short enough that a stray token is not a standing key. */
const GRANT_TTL_MS = 20 * 60_000;

export function mintSeatGrant(ctx: ToolContext, scope: SeatScope = "all"): string {
  const token = `sg_${newId()}`;
  grants().set(token, { ctx, scope, expiresAt: Date.now() + GRANT_TTL_MS });
  return token;
}

export function readSeatGrant(token: string): { ctx: ToolContext; scope: SeatScope } | null {
  const grant = grants().get(token);
  if (!grant) return null;
  if (grant.expiresAt < Date.now()) {
    grants().delete(token);
    return null;
  }
  return { ctx: grant.ctx, scope: grant.scope };
}

/** Called when the turn ends: the token has no reason to outlive it. */
export function revokeSeatGrant(token: string): void {
  grants().delete(token);
  // Opportunistic sweep, so a crashed turn's token cannot accumulate.
  const now = Date.now();
  for (const [key, grant] of grants()) if (grant.expiresAt < now) grants().delete(key);
}
