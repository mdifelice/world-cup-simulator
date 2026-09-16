import { useEffect, useMemo, useRef, useState } from "react";
import { useI18n } from "../i18n";
import PlayerCard from "../components/PlayerCard";
import type { LineupConfig, Player, Strategy } from "../types";
import {
  bestEffectiveIn,
  FORMATIONS,
  playerPositions,
  playerSurname,
  positionFamilies,
  positionFamily,
  ratingStars,
  slotsFor,
  STRATEGIES,
} from "../types";

export interface LineupEditorProps {
  shirtNumbers: boolean;
  squad: Player[];
  initial?: LineupConfig;
  onConfirm: (cfg: LineupConfig) => void;
  /** Reports whether every slot is filled (false → the XI is incomplete). */
  onDirty?: (incomplete: boolean) => void;
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

/** Lay the 11 slots out, spreading repeated slots (DF, or a second FW/DMF)
 *  horizontally so they don't overlap on the pitch. */
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
    const dx = (j - (n - 1) / 2) * 26;
    return { slot, x: a.x + dx, y: a.y };
  });
}

const FAMILIES = ["GK", "DF", "MF", "FW"] as const;

export default function LineupEditor({
  shirtNumbers,
  squad,
  initial,
  onConfirm,
  onDirty,
}: LineupEditorProps) {
  const { t } = useI18n();
  const [formation, setFormation] = useState<string>(initial?.formation ?? "4-4-2");
  const [strategy, setStrategy] = useState<Strategy>(initial?.strategy ?? "normal");
  const [armedId, setArmedId] = useState<number | null>(null);

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
      const pid = ids.find((p) => !used.has(p));
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
    setAssignments((cur) =>
      cur.map((pid, i) => (pid === player.id ? null : i === slotIndex ? player.id : pid)),
    );
    setArmedId(null);
  };

  const clearSlot = (slotIndex: number) => {
    setAssignments((cur) => cur.map((pid, i) => (i === slotIndex ? null : pid)));
  };

  const effFor = (p: Player, slot: string) =>
    bestEffectiveIn(playerPositions(p), p.rating ?? p.overall, slot);
  const positionsLabel = (p: Player) => playerPositions(p).join(" / ");

  const pickAuto = () => {
    const next: (number | null)[] = new Array(slots.length).fill(null);
    const used = new Set<number>();
    for (let i = 0; i < slots.length; i++) {
      const slot = slots[i];
      let best: Player | null = null;
      let bestEff = -Infinity;
      for (const p of squad) {
        if (used.has(p.id)) continue;
        const eff = effFor(p, slot);
        if (eff > bestEff) {
          bestEff = eff;
          best = p;
        }
      }
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

  const confirm = () => {
    if (!filled) return;
    const starting: Record<string, number[]> = {};
    slots.forEach((slot, i) => {
      const pid = assignments[i];
      if (pid == null) return;
      (starting[slot] ??= []).push(pid);
    });
    onConfirm({ formation, strategy, starting });
  };

  const chosenName = (i: number) =>
    assignments[i] != null ? squad.find((p) => p.id === assignments[i]) : undefined;

  // The lineup applies by itself as soon as every slot has its own player —
  // no confirm button any more. Skipped on first mount so an `initial` lineup
  // isn't re-submitted (and re-simulated) for nothing. Incomplete edits are
  // reported to the parent so the Play button can be gated on them.
  const mounted = useRef(false);
  useEffect(() => {
    if (!mounted.current) {
      mounted.current = true;
      return;
    }
    if (filled) confirm();
    onDirty?.(!filled);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filled, assignments]);

  const anyPicked = assignments.some((p) => p != null);

  return (
    <div className="form-editor">
      <div className="chip-grid">
        {Object.keys(FORMATIONS).map((f) => (
          <button
            key={f}
            className={"chip btn" + (formation === f ? " active" : "")}
            onClick={() => setFormation(f)}
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
          >
            {t(`strategy.${s}`)}
          </button>
        ))}
        <button
          className="btn secondary chip"
          onClick={pickAuto}
          title={t("lineup.auto")}
          disabled={anyPicked}
        >
          ⚙ {t("lineup.auto")}
        </button>
      </div>

<div className="form-body">
        <div className={"pitch" + (armedId != null ? " arm-mode" : "")}>
          <div className="pitch-line mid" />
          <div className="pitch-line circle" />
          <div className="pitch-line pa top" />
          <div className="pitch-line pa bottom" />
          <div className="pitch-line sgt top" />
          <div className="pitch-line sgt bottom" />
          <div className="pitch-spot top" />
          <div className="pitch-spot bottom" />
          {markers.map(({ slot, x, y }, i) => {
            const chosen = chosenName(i);
            const armedPlayer =
              armedId != null ? squad.find((p) => p.id === armedId) : null;
            // While a player is selected ("armed"), only their main positions
            // (position families) pulse so you can see exactly where they fit.
            const fillable =
              armedPlayer != null &&
              positionFamilies(playerPositions(armedPlayer)).has(positionFamily(slot));
            return (
              <button
                key={slot + ":" + x + ":" + i}
                className={
                  "slot-marker" +
                  (chosen ? " filled" : "") +
                  (fillable ? " pulsing" : "") +
                  (armedPlayer ? " arm-target" : "")
                }
                style={{ left: `${x}%`, top: `${y}%` }}
                onClick={() => armedPlayer && fillable && assignTo(i, armedPlayer)}
                onDoubleClick={() => chosen && clearSlot(i)}
                title={
                  chosen
                    ? `${chosen.name} — ${t("lineup.ready")} · ${t("lineup.dblClear")}`
                    : armedPlayer
                      ? fillable
                        ? t("lineup.place", { player: armedPlayer.name })
                        : t("lineup.notThere", { player: armedPlayer.name })
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
                    <span className="slot-tag">{slot}</span>
                  )}
                </span>
                {chosen && (
                  <span className="marker-cap">
                    {playerSurname(chosen.name)} ·{" "}
                    {shirtNumbers && chosen.shirt_number != null
                      ? `#${chosen.shirt_number}`
                      : positionFamily(slot)}
                  </span>
                )}
                {chosen && (
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

        <div className="player-picks">
          <h2 className="pos-title" title={armedId != null ? t("lineup.tapSlot") : undefined}>
            {t("lineup.players")}
          </h2>
          <div className="pick-scroll">
            {FAMILIES.flatMap((fam) => grouped.get(fam) ?? []).map((p) => {
              const used = idsIn.has(p.id);
              const isArmed = armedId === p.id;
              return (
                <button
                  key={p.id}
                  className={"pc-pick" + (isArmed ? " armed" : "")}
                  onClick={() => setArmedId((cur) => (cur === p.id ? null : p.id))}
                  title={`${positionsLabel(p)} · ✦${Math.round(p.rating ?? p.overall)}`}
                >
                  <PlayerCard
                    player={p}
                    variant="stat"
                    tone={p.id % 4}
                    stars={ratingStars(p.rating ?? p.overall)}
                    number={shirtNumbers ? p.shirt_number : null}
                    sub={p.position}
                    selected={isArmed}
                    dimmed={used}
                    stamp={used ? t("lineup.picked") : null}
                  />
                </button>
              );
            })}
          </div>
        </div>
      </div>

      <div className="form-confirm">
        {filled ? (
          <span className="chip ok">{t("lineup.ready")}</span>
        ) : (
          <p className="hint">{t("lineup.slots")}</p>
        )}
      </div>
    </div>
  );
}