import { useEffect, useMemo, useState } from "react";
import { api } from "../api";
import { useI18n } from "../i18n";
import type { Player, Team, Tournament } from "../types";
import { positionFamily } from "../types";
import PlayerCard from "../components/PlayerCard";

interface Props {
  tournament: Tournament;
  team: Team;
  onDone: () => void;
  onBack: () => void;
}

const FAMILIES = ["GK", "DF", "MF", "FW"] as const;

export default function Roster({ tournament, team, onDone, onBack }: Props) {
  const [squad, setSquad] = useState<Player[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { t, country, pos } = useI18n();

  useEffect(() => {
    setSquad(null);
    setError(null);
    api
      .players(team.id, tournament.id)
      .then(setSquad)
      .catch((e) => setError(e.message));
  }, [team.id, tournament.id]);

  const groups = useMemo(() => {
    const by = new Map<string, Player[]>();
    for (const f of FAMILIES) by.set(f, []);
    for (const p of squad ?? []) {
      const f = positionFamily(p.position);
      by.get(f)!.push(p);
    }
    return by;
  }, [squad]);

  return (
    <section>
      <div className="page-head">
        <div>
          <h1>{team.flag ?? "🌍"} {country(team.name)}</h1>
          <p className="hint">
            {t("squad.hint", { year: tournament.year, count: squad?.length ?? "…" })}
          </p>
        </div>
        <div className="page-actions">
          <button className="btn secondary" onClick={onBack}>{t("squad.back")}</button>
          <button className="btn primary big" onClick={onDone} disabled={!squad?.length}>
            {t("squad.start")}
          </button>
        </div>
      </div>
      {error && <p className="error">{error}</p>}
      {!squad && !error && <p className="hint">{t("squad.loading")}</p>}
      {squad && squad.length === 0 && (
        <div className="empty"><p>{t("squad.empty")}</p></div>
      )}
      {squad && squad.length > 0 && (
        <>
          {FAMILIES.map((f) => {
            const ps = groups.get(f)!;
            if (!ps.length) return null;
            return (
              <div key={f} className="pos-block">
                <h2 className="pos-title">{t(`pos.${f}`)}</h2>
                <div className="squad-grid">
                  {ps.map((p, i) => (
                    <PlayerCard
                      key={p.id}
                      player={{
                        id: p.id,
                        name: p.name,
                        position: p.position,
                        photo_url: p.photo_url,
                        shirt_number: p.shirt_number ?? undefined,
                        overall: p.overall,
                        rating: p.rating,
                      }}
                      variant="grid"
                      tone={i}
                      number={
                        tournament.shirt_numbers
                          ? p.shirt_number ?? null
                          : pos(p.position)
                      }
                    />
                  ))}
                </div>
              </div>
            );
          })}
        </>
      )}
    </section>
  );
}