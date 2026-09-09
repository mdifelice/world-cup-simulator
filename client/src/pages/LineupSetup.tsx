import { useEffect, useMemo, useState } from "react";
import { api } from "../api";
import { useI18n } from "../i18n";
import type {
  LineupConfig,
  Player,
  RunMatch,
  Strategy,
  Team,
  Tournament,
} from "../types";
import { effectiveIn, FORMATIONS, slotPenalty, slotsFor, STRATEGIES } from "../types";

interface Props {
  tournament: Tournament;
  team: Team;
  match: RunMatch;
  initial?: LineupConfig;
  onConfirm: (cfg: LineupConfig) => void;
  onBack: () => void;
}

export default function LineupSetup({
  tournament,
  team,
  match,
  initial,
  onConfirm,
  onBack,
}: Props) {
  const { t, stage } = useI18n();
  const [squad, setSquad] = useState<Player[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [formation, setFormation] = useState<string>(initial?.formation ?? "4-4-2");
  const [strategy, setStrategy] = useState<Strategy>(initial?.strategy ?? "normal");
  const [selection, setSelection] = useState<Record<string, number>>(
    initial?.starting ?? {},
  );

  const opponent = match.home_team_id === team.id
    ? match.away_team_name
    : match.home_team_name;

  useEffect(() => {
    setSquad(null);
    setError(null);
    api
      .players(team.id, tournament.id)
      .then(setSquad)
      .catch((e) => setError(e.message));
  }, [team.id, tournament.id]);

  const slots = useMemo(() => slotsFor(formation, strategy), [formation, strategy]);

  // When the formation/strategy changes, drop picks whose slot no longer exists.
  useEffect(() => {
    setSelection((sel) => {
      const next: Record<string, number> = {};
      for (const s of slotsFor(formation, strategy)) {
        if (sel[s] != null) next[s] = sel[s];
      }
      return next;
    });
  }, [formation, strategy]);

  const usedBySlot = (slot: string) => selection[slot] != null;

  const sortedForSlot = (slot: string): Player[] =>
    (squad ?? [])
      .slice()
      .sort(
        (a, b) =>
          effectiveIn(b.position, b.overall, slot) -
          effectiveIn(a.position, a.overall, slot),
      );

  const pickAuto = () => {
    const next: Record<string, number> = {};
    const used = new Set<number>();
    for (const slot of slots) {
      let best: Player | null = null;
      let bestEff = -Infinity;
      for (const p of squad ?? []) {
        if (used.has(p.id)) continue;
        const eff = effectiveIn(p.position, p.overall, slot);
        if (eff > bestEff) {
          bestEff = eff;
          best = p;
        }
      }
      if (best) {
        next[slot] = best.id;
        used.add(best.id);
      }
    }
    setSelection(next);
  };

  const filled = squad
    ? slots.every((s) => selection[s] != null) && new Set(Object.values(selection)).size === slots.length
    : false;

  const assign = (slot: string, playerId: string) => {
    const id = Number(playerId);
    if (!id) {
      setSelection((sel) => {
        const next = { ...sel };
        delete next[slot];
        return next;
      });
      return;
    }
    // A player can only appear once: remove them from any other slot.
    setSelection((sel) => {
      const next: Record<string, number> = {};
      for (const [s, pid] of Object.entries(sel)) {
        if (pid === id) continue;
        next[s] = pid;
      }
      next[slot] = id;
      return next;
    });
  };

  const confirm = () => {
    if (!filled) return;
    onConfirm({ formation, strategy, starting: { ...selection } });
  };

  return (
    <section>
      <div className="page-head">
        <div>
          <h1>
            {team.flag ?? "🌍"} {team.name} {t("lineup.title")}
          </h1>
          <p className="hint">
            {match ? t("lineup.subtitle", { day: match.day, stage: stage(match.stage_name), opponent }) : ""}
          </p>
        </div>
        <button className="btn secondary" onClick={onBack}>{t("lineup.cancel")}</button>
      </div>

      {error && <p className="error">{error}</p>}
      {!squad && !error && <p className="hint">{t("squad.loading")}</p>}

      {squad && (
        <div className="lineup-layout">
          <div className="lineup-cfg">
            <h2 className="pos-title">{t("lineup.formation")}</h2>
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

            <h2 className="pos-title">{t("lineup.strategy")}</h2>
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
            </div>

            <div className="bar">
              <button className="btn secondary big" onClick={pickAuto}>
                {t("lineup.auto")}
              </button>
            </div>

            <h2 className="pos-title">{t("lineup.slots")}</h2>
            <div className="slot-list">
              {slots.map((slot) => {
                const chosen = selection[slot];
                const chosenPlayer = chosen != null ? squad.find((p) => p.id === chosen) : undefined;
                return (
                  <div key={slot} className={"slot-row" + (usedBySlot(slot) ? " set" : "")}>
                    <span className="slot-label">{slot}</span>
                    <select
                      className="slot-select"
                      value={chosen ?? ""}
                      onChange={(e) => assign(slot, e.target.value)}
                    >
                      <option value="">{t("lineup.pick")}</option>
                      {sortedForSlot(slot).map((p) => {
                        const pen = slotPenalty(p.position, slot);
                        const eff = effectiveIn(p.position, p.overall, slot);
                        return (
                          <option key={p.id} value={p.id}>
                            {p.name} ({p.position}) ✦{Math.round(eff)}
                            {pen > 0 ? ` · ${t("lineup.pen", { n: -pen * 2 })}` : ""}
                          </option>
                        );
                      })}
                    </select>
                    {chosenPlayer && (
                      <span className="slot-chosen">
                        {chosenPlayer.name}{" "}
                        <span className="dim">
                          ✦{Math.round(effectiveIn(chosenPlayer.position, chosenPlayer.overall, slot))}
                        </span>
                      </span>
                    )}
                  </div>
                );
              })}
            </div>

            <div className="bar-hint">
              <p className="hint">{t("lineup.hint")}</p>
              <button
                className="btn primary big"
                disabled={!filled}
                onClick={confirm}
                title={filled ? t("lineup.ready") : ""}
              >
                {t("lineup.confirm")}
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}