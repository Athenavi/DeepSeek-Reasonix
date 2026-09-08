// Read progress is host-owned, keyed by read id, and upserted: a hundred pages
// of one logical read still render one status line, never a hundred notices.

/** WireReadStatus is one logical read's delivery state; ranges only, no text. */
export interface WireReadStatus {
  readId: string;
  generation?: number;
  seq?: number;
  path: string;
  intent?: string;
  state: string;
  covered?: [number, number][];
  missing?: [number, number][];
  sourceEnd?: number;
  hasMore?: boolean;
  reason?: string;
  recovery?: string;
  active?: boolean;
}

type ReadStatusHost = { readStatuses?: Record<string, WireReadStatus> };

/**
 * applyReadStatusFrame upserts one frame. A re-ordered frame never moves a read
 * backwards, and an unnamed frame is ignored.
 */
export function applyReadStatusFrame<T extends ReadStatusHost>(state: T, incoming: WireReadStatus | undefined): T {
  if (!incoming?.readId) return state;
  const previous = state.readStatuses?.[incoming.readId];
  if (previous && incoming.seq !== undefined && previous.seq !== undefined && incoming.seq < previous.seq) {
    return state;
  }
  return { ...state, readStatuses: { ...(state.readStatuses ?? {}), [incoming.readId]: incoming } };
}

/** ReadStatusKey is the closed set of labels one read status can produce. */
export type ReadStatusKey =
  | "composer.readStatusReading"
  | "composer.readStatusCovered"
  | "composer.readStatusDone"
  | "composer.readStatusPaused";

/** readStatusLabel renders the single active read as one short status line. */
export function readStatusLabel(
  statuses: Record<string, WireReadStatus> | undefined,
  t: (key: ReadStatusKey, vars?: Record<string, string | number>) => string,
): string {
  const active = Object.values(statuses ?? {}).filter((status) => status.active);
  if (active.length === 0) return "";
  const first = active[0];
  const file = first.path.split(/[\\/]/).pop() || first.path;
  const covered = first.covered?.length
    ? `${first.covered[0][0]}–${first.covered[first.covered.length - 1][1]}`
    : "";
  if (first.state === "blocked" || first.state === "needs_scope") {
    return t("composer.readStatusPaused", { file });
  }
  if (first.hasMore) {
    return covered ? t("composer.readStatusCovered", { file, range: covered }) : t("composer.readStatusReading", { file });
  }
  return covered ? t("composer.readStatusDone", { file, range: covered }) : t("composer.readStatusReading", { file });
}

/** TurnPhaseKey is the closed set of phase labels the composer can show. */
export type TurnPhaseKey =
  | "composer.turnPhaseChecking"
  | "composer.turnPhaseVerifying"
  | "composer.turnPhaseReviewing"
  | "composer.turnPhaseWorking"
  | "composer.runAnnounceRunning";

/** turnPhaseStatusLabel renders the host turn phase for the status line. */
export function turnPhaseStatusLabel(
  turnPhase: string | undefined,
  t: (key: TurnPhaseKey, vars?: Record<string, string | number>) => string,
): string {
  switch ((turnPhase ?? "").trim()) {
    case "checking":
      return t("composer.turnPhaseChecking");
    case "verifying":
      return t("composer.turnPhaseVerifying");
    case "reviewing":
      return t("composer.turnPhaseReviewing");
    case "working":
      return t("composer.turnPhaseWorking");
    default:
      return t("composer.runAnnounceRunning");
  }
}
