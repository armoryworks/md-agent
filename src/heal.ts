import { normalizeProvider, resolveModelFor, type Provider, type RoleSpec } from "./persist.js";

/**
 * One rung of a seat's fallback ladder: where the seat moves when its provider
 * runs dry. `provider` defaults to claude, `model` to the seat's own tier,
 * resolved on the rung's provider — `{}` alone means "same tier on claude".
 */
export interface FallbackRung {
  provider?: Provider;
  model?: string;
}

/** A recorded move down the ladder, kept on the seat in state.json. */
export interface HealRecord {
  at: string;
  from: { provider: Provider; model: string };
  to: { provider: Provider; model: string };
  reason: string;
  /** Unix seconds when the exhausted provider said it resets, when it did. */
  resetsAt?: number;
}

/** A seat's ladder: its own `fallback`, else the run's default, else none. */
export function fallbackLadder(
  role: Pick<RoleSpec, "fallback">,
  runDefault?: FallbackRung | FallbackRung[]
): FallbackRung[] {
  const own = role.fallback ?? runDefault;
  if (!own) return [];
  return Array.isArray(own) ? own : [own];
}

/** A rung made concrete for a seat: provider defaulted, tier resolved per provider. */
export function rungTarget(
  role: Pick<RoleSpec, "model">,
  rung: FallbackRung
): { provider: Provider; model: string } {
  const provider = normalizeProvider(rung.provider ?? "claude");
  return { provider, model: rung.model ?? role.model ?? "sonnet" };
}

/**
 * The next rung a seat can take after `failed` ran dry: rungs already used are
 * skipped (one per recorded heal), and so is any rung on the provider that just
 * failed — a quota is per account, not per model, so moving to another model of
 * the same provider would hit the same wall.
 */
export function nextRung(
  role: Pick<RoleSpec, "model" | "fallback" | "healed">,
  failed: Provider,
  runDefault?: FallbackRung | FallbackRung[]
): FallbackRung | null {
  const ladder = fallbackLadder(role, runDefault);
  const used = role.healed?.length ?? 0;
  for (let i = used; i < ladder.length; i++) {
    if (rungTarget(role, ladder[i]).provider !== failed) return ladder[i];
  }
  return null;
}

/**
 * Move a seat down the ladder in place: the old identity is recorded on
 * `healed`, the new provider/model take over, and provider-specific turn caps
 * that no longer apply are dropped so the new provider's defaults rule.
 */
export function applyFallback(
  role: RoleSpec,
  rung: FallbackRung,
  reason: string,
  resetsAt?: number
): HealRecord {
  const from = { provider: normalizeProvider(role.provider), model: resolveModelFor(normalizeProvider(role.provider), role.model) };
  const target = rungTarget(role, rung);
  const rec: HealRecord = {
    at: new Date().toISOString(),
    from,
    to: { provider: target.provider, model: resolveModelFor(target.provider, target.model) },
    reason,
    resetsAt,
  };
  role.healed = [...(role.healed ?? []), rec];
  role.provider = target.provider;
  role.model = target.model;
  if (from.provider !== target.provider) {
    delete role.turnTimeoutSec;
    if (target.provider !== "agy") delete role.turnMaxSteps;
  }
  return rec;
}

/** `agy·gemini-3.8-flash-medium`, for logs and notes. */
export function identity(x: { provider: Provider; model: string }): string {
  return `${x.provider}·${x.model}`;
}

/**
 * Launch-time healing: every seat on a provider the preflight found dry is
 * moved to its first usable rung; the providers those rungs need are returned
 * so the caller can probe them too. A seat on the dry provider with no usable
 * rung is an error — the run cannot start without it.
 */
export function preflightHeal(
  roles: RoleSpec[],
  failed: Provider,
  detail: string,
  runDefault?: FallbackRung | FallbackRung[]
): { healed: { role: RoleSpec; rec: HealRecord }[]; needProviders: Set<Provider> } {
  const healed: { role: RoleSpec; rec: HealRecord }[] = [];
  const needProviders = new Set<Provider>();
  const stuck: string[] = [];
  for (const role of roles) {
    if (role.stopped || normalizeProvider(role.provider) !== failed) continue;
    const rung = nextRung(role, failed, runDefault);
    if (!rung) {
      stuck.push(role.name);
      continue;
    }
    const rec = applyFallback(role, rung, `${failed} not ready at preflight: ${detail}`);
    healed.push({ role, rec });
    needProviders.add(rec.to.provider);
  }
  if (stuck.length) {
    throw new Error(
      `[preflight] agent "${failed}" is not ready — ${detail}\n` +
        `Seat(s) ${stuck.join(", ")} have no fallback on another provider. ` +
        `Add "fallback": [{"provider":"claude","model":"haiku"}] to the seat (or a run-level "fallback"), fix the provider, or set MD_AGENT_SKIP_PREFLIGHT=1.`
    );
  }
  return { healed, needProviders };
}
