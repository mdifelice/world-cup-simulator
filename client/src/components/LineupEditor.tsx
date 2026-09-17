import { useEffect, useMemo, useRef, useState } from "react";
import { canonSlot, useI18n } from "../i18n";
import type { LineupConfig, Player, Strategy } from "../types";
import {
  bestEffectiveIn,
  FORMATIONS,
  playerSurname,
  playerPositions,
  positionFamilies,
  positionFamily,
  ratingStars,
  slotPenalty,
  slotsFor,
  starsString,
  STRATEGIES,
} from "../types";

export interface LineupEditorProps {
  shirtNumbers: boolean;
  squad: Player[];
  initial?: LineupConfig;
  /** Read-only mode: the XI is shown but nothing can be changed. */
  disabled?: boolean;
  /** Player ids serving a suspension: locked out of the XI and auto-pick. */
  unavailable?: number[];
  /** Reports the current lineup every time it changes: the config when the XI
   *  is complete, null otherwise. The parent decides when to commit/play. */
  onReady?: (cfg: LineupConfig | null) => void;
}

/** Anchor (percent) of each slot on the pitch. The goal is at the top. */
const SLOT_POS: Record<string, { x: number; y: number }> = {
  GK: { x: 50, y: 86 },
  RWB: { x: 86, y: 66 },
  LWB: { x: 14, y: 66 },
  RMF: { x: 86, y: 44 },
  LMF: { x: 14, y: 44 },
  DMF: { x: 50, y: 60 },
  AMF: { x: 50, y: 38 },
  RFW: { x: 86, y: 22 },
  LFW: { x: 14, y: 22 },
  FW: { x: 50, y: 20 },
};

/** Horizontal distance (in % of pitch width) between repeated slots sharing an
 *  anchor, e.g. the two central defenders. Wide enough for the captions. */
const SLOT_SPREAD = 34;

/** Lay the 11 slots out, spreading repeated slots (DF, or a second FW/DMF)
 *  horizontally so their always-visible captions never stack on top of
 *  each other and never leave the pitch. Captions sit above the marker in the
 *  top half, below it in the bottom half. */
function layout(slots: string[]) {
  const anchors = slots.map((s) =>
    s === "DF" ? { x: 50, y: 70 } : SLOT_POS[s],
  );
  const counts = new Map<string, number>();
  for (const a of anchors) {
    const k = `${a.x}:${a.y}`;
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  const seen = new Map<string, number>();
  return slots.map((slot, i) => {
    const a = anchors[i];
    const k = `${a.x}:${a.y}`;
    const j = seen.get(k) ?? 0;
    seen.set(k, j + 1);
    const n = counts.get(k)!;
    const dx = n > 1 ? (j - (n - 1) / 2) * SLOT_SPREAD : 0;
    const up = a.y < 50;
    return { slot, x: a.x + dx, y: a.y, up };
  });
}

const FAMILIES = ["GK", "DF", "MF", "FW"] as const;

export default function LineupEditor({
  shirtNumbers,
  squad,
  initial,
  disabled = false,
  unavailable,
  onReady,
}: LineupEditorProps) {
  const { t, pos } = useI18n();
  const [formation, setFormation] = useState<string>(initial?.formation ?? "4-4-2");
  const [strategy, setStrategy] = useState<Strategy>(initial?.strategy ?? "normal");
  const [armedId, setArmedId] = useState<number | null>(null);

  const blocked = useMemo(() => new Set(unavailable ?? []), [unavailable]);

  const slots = useMemo(() => slotsFor(formation, strategy), [formation, strategy]);
  const markers = useMemo(() => layout(slots), [slots]);

  // One assignment per pitch slot (11), so repeated slots each get their own
  // player and no player can appear twice.
  const [assignments, setAssignments] = useState<(number | null)[]>(() => {
    const lists = initial?.starting ?? {};
    const out: (number | null)[] = [];
    const used = new Set<number>();
    for (const slot of slotsFor(initial?.formation ?? "4-4-2", initial?.strategy ?? "normal")) {
      const ids = lists[slot] ?? [];
      const pid = ids.find((p) => !used.has(p) && !blocked.has(p));
      out.push(pid ?? null);
      if (pid != null) used.add(pid);
    }
    return out;
  });

  // Changing formation/strategy reshapes the XI, so drop all picks (but not on
  // first mount, which would wipe the `initial` lineup).
  const firstRender = useRef(true);
  useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false;
      return;
    }
    setAssignments(new Array(slotsFor(formation, strategy).length).fill(null));
  }, [formation, strategy]);

  const idsIn = new Set(assignments.filter((p): p is number => p != null));
  const filled =
    assignments.every((p) => p != null) && idsIn.size === slots.length;

  const assignTo = (slotIndex: number, player: Player) => {
    if (disabled || blocked.has(player.id)) return;
    setAssignments((cur) =>
      cur.map((pid, i) => (pid === player.id ? null : i === slotIndex ? player.id : pid)),
    );
    setArmedId(null);
  };

  const clearSlot = (slotIndex: number) => {
    if (disabled) return;
    setAssignments((cur) => cur.map((pid, i) => (i === slotIndex ? null : pid)));
  };

  const effFor = (p: Player, slot: string) =>
    bestEffectiveIn(playerPositions(p), p.rating ?? p.overall, slot);
  const positionsLabel = (p: Player) =>
    playerPositions(p).map((x) => pos(x)).join(" / ");

  /** A player "owns" a slot when one of their positions carries no out-of-
   *  position penalty for it. Auto-pick only uses owners, so a star forward is
   *  never picked ahead of a real defender (or a keeper ahead of an outfielder). */
  const owns = (p: Player, slot: string) =>
    playerPositions(p).some((x) => slotPenalty(x, slot) === 0);

  const bestIn = (slot: string, used: Set<number>) => {
    let best: Player | null = null;
    let bestEff = -Infinity;
    for (const p of squad) {
      if (used.has(p.id) || blocked.has(p.id)) continue;
      const eff = effFor(p, slot);
      if (eff > bestEff) {
        bestEff = eff;
        best = p;
      }
    }
    return best;
  };

  const pickAuto = () => {
    if (disabled) return;
    const next: (number | null)[] = new Array(slots.length).fill(null);
    const used = new Set<number>();
    const pool = squad.filter((p) => !blocked.has(p.id));
    const ownersOf = (slot: string) => pool.filter((p) => owns(p, slot));

    // Match every slot to a different owner (maximum bipartite matching), so a
    // slot with no specialist left is the only one that can end up without an
    // owner. Better-rated owners are tried first for each slot.
    const playerSlot = new Map<number, number>();
    const augment = (slotIndex: number, seen: Set<number>): boolean => {
      const candidates = ownersOf(slots[slotIndex]).sort((a, b) => effFor(b, slots[slotIndex]) - effFor(a, slots[slotIndex]));
      for (const p of candidates) {
        if (seen.has(p.id)) continue;
        seen.add(p.id);
        const holder = playerSlot.get(p.id);
        if (holder === undefined || augment(holder, seen)) {
          playerSlot.set(p.id, slotIndex);
          next[slotIndex] = p.id;
          return true;
        }
      }
      return false;
    };
    for (let i = 0; i < slots.length; i++) augment(i, new Set());

    for (const p of playerSlot.keys()) used.add(p);

    // Only slots with no owner available fall back to the best penalised pick.
    for (let i = 0; i < slots.length; i++) {
      if (next[i] != null) continue;
      const best = bestIn(slots[i], used);
      if (best) {
        next[i] = best.id;
        used.add(best.id);
      }
    }

    setAssignments(next);
    setArmedId(null);
  };

  // Players grouped by position family (GK → DF → MF → FW), best first within
  // each row, so the picker reads like the team-selection screen.
  const grouped = useMemo(() => {
    const by = new Map<string, Player[]>();
    for (const f of FAMILIES) by.set(f, []);
    for (const p of squad) {
      const fams = positionFamilies(playerPositions(p));
      for (const f of fams) by.get(f)?.push(p);
    }
    for (const list of by.values()) {
      list.sort((a, b) => (b.rating ?? b.overall) - (a.rating ?? a.overall));
    }
    return by;
  }, [squad]);

  const buildCfg = (): LineupConfig | null => {
    if (!filled) return null;
    const starting: Record<string, number[]> = {};
    slots.forEach((slot, i) => {
      const pid = assignments[i];
      if (pid == null) return;
      (starting[slot] ??= []).push(pid);
    });
    return { formation, strategy, starting };
  };

  const chosenName = (i: number) =>
    assignments[i] != null ? squad.find((p) => p.id === assignments[i]) : undefined;

  // The editor only reports readiness — it never commits or simulates on its
  // own. Filling the last slot (or clicking auto-pick) simply enables Play.
  useEffect(() => {
    onReady?.(buildCfg());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filled, assignments]);

  const anyPicked = assignments.some((p) => p != null);

  return (
    <div className="form-editor">
      <div className="form-body">
        <div className="form-left">
          <div className="chip-grid">
            {Object.keys(FORMATIONS).map((f) => (
              <button
                key={f}
                className={"chip btn" + (formation === f ? " active" : "")}
                onClick={() => setFormation(f)}
                disabled={disabled}
              >
                {f}
              </button>
            ))}
          </div>
          <div className="chip-grid">
            {STRATEGIES.map((s) => (
              <button
                key={s}
                className={"chip btn" + (strategy === s ? " active" : "")}
                onClick={() => setStrategy(s)}
                disabled={disabled}
              >
                {t(`strategy.${s}`)}
              </button>
            ))}
            <button
              className="btn secondary chip"
              onClick={pickAuto}
              title={t("lineup.auto")}
              disabled={anyPicked || disabled}
            >
              ⚙ {t("lineup.auto")}
            </button>
          </div>

          <div className={"pitch" + (armedId != null ? " arm-mode" : "") + (disabled ? " locked" : "")}>
          <div className="pitch-line mid" />
          <div className="pitch-line circle" />
          <div className="pitch-line pa top" />
          <div className="pitch-line pa bottom" />
          <div className="pitch-line sgt top" />
          <div className="pitch-line sgt bottom" />
          <div className="pitch-spot top" />
          <div className="pitch-spot bottom" />
          {markers.map(({ slot, x, y, up }, i) => {
            const chosen = chosenName(i);
            const armedPlayer =
              armedId != null ? squad.find((p) => p.id === armedId) : null;
            // While a player is armed, only the slots matching one of their
            // position families pulse; every other slot still accepts them.
            const natural =
              armedPlayer != null &&
              positionFamilies(playerPositions(armedPlayer)).has(positionFamily(slot));
            return (
              <button
                key={slot + ":" + x + ":" + i}
                data-slot={slot}
                className={
                  "slot-marker" +
                  (chosen ? " filled" : "") +
                  (natural ? " pulsing" : "") +
                  (armedPlayer ? " arm-target" : "")
                }
                style={{ left: `${x}%`, top: `${y}%` }}
                disabled={disabled}
                onClick={() => armedPlayer && assignTo(i, armedPlayer)}
                onDoubleClick={() => chosen && clearSlot(i)}
                title={
                  chosen
                    ? `${chosen.name} — ${t("lineup.ready")} · ${t("lineup.dblClear")}`
                    : armedPlayer
                      ? t("lineup.place", { player: armedPlayer.name })
                      : t("lineup.armFirst")
                }
              >
                <span className="marker-face">
                  {chosen ? (
                    chosen.photo_url ? (
                      <img
                        src={chosen.photo_url}
                        alt=""
                        onError={(e) => {
                          (e.currentTarget as HTMLImageElement).style.display = "none";
                        }}
                      />
                    ) : (
                      <span className="marker-fallback" aria-hidden>
                        <svg viewBox="0 0 24 24" width="22" height="22">
                          <circle cx="12" cy="8" r="4.5" fill="currentColor" opacity="0.85" />
                          <path
                            d="M3.5 20.5c1.4-4.2 4.6-6 8.5-6s7.1 1.8 8.5 6"
                            fill="currentColor"
                            opacity="0.85"
                          />
                        </svg>
                      </span>
                    )
                  ) : (
                    <span className="slot-tag">{pos(canonSlot(slot))}</span>
                  )}
                </span>
                {chosen && (
                  <span className={"marker-cap" + (up ? " up" : "")}>
                    <span className="mc-pos">{pos(canonSlot(slot))}</span>
                    <span className="mc-name">
                      {shirtNumbers && chosen.shirt_number != null
                        ? `${chosen.shirt_number} - `
                        : ""}
                      {playerSurname(chosen.name)}
                    </span>
                  </span>
                )}
                {chosen && !disabled && (
                  <span
                    className="slot-clear"
                    role="button"
                    aria-label="clear"
                    onClick={(e) => {
                      e.stopPropagation();
                      clearSlot(i);
                    }}
                  >
                    ✕
                  </span>
                )}
              </button>
            );
          })}
          </div>
        </div>

        <div className="player-picks">
          <h2 className="pos-title" title={armedId != null ? t("lineup.tapSlot") : undefined}>
            {t("lineup.players")}
          </h2>
          <div className="pick-scroll">
            {FAMILIES.flatMap((fam) => grouped.get(fam) ?? []).map((p) => {
              const used = idsIn.has(p.id);
              const sus = blocked.has(p.id);
              const isArmed = armedId === p.id;
              return (
                <button
                  key={p.id}
                  className={
                    "pc-pick" +
                    (isArmed ? " armed" : "") +
                    (used ? " used" : "") +
                    (sus ? " suspended" : "")
                  }
                  onClick={() => setArmedId((cur) => (cur === p.id ? null : p.id))}
                  disabled={disabled || sus}
                  title={`${positionsLabel(p)} · ✦${Math.round(p.rating ?? p.overall)}`}
                >
                  <span className="pp-photo">
                    {p.photo_url ? (
                      <img
                        src={p.photo_url}
                        alt=""
                        onError={(e) => {
                          (e.currentTarget as HTMLImageElement).style.display = "none";
                        }}
                      />
                    ) : (
                      <span className="pp-empty" aria-hidden>
                        <svg viewBox="0 0 24 24">
                          <circle cx="12" cy="8" r="4" />
                          <path d="M4 20c0-4 3.5-6.5 8-6.5s8 2.5 8 6.5" />
                        </svg>
                      </span>
                    )}
                  </span>
                  <span className="pp-text">
                    <span className="pp-name">{playerSurname(p.name)}</span>
                    <span className="pp-pos">{positionsLabel(p)}</span>
                  </span>
                  {sus ? (
                    <span className="pp-badge sus">{t("lineup.suspended")}</span>
                  ) : used ? (
                    <span className="pp-badge">{t("lineup.picked")}</span>
                  ) : null}
                  <span className="pp-stars">
                    {starsString(ratingStars(p.rating ?? p.overall))}
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}