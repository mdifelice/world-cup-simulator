import { useEffect, useMemo, useState } from "react";
import { api } from "../api";
import { useI18n } from "../i18n";
import type { Player, Team, Tournament } from "../types";
import { positionFamily, ratingStars, starsString } from "../types";

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
  const { t, pos, country } = useI18n();

  useEffect(() => {
    setSquad(null);
    setError(null);
    api
      .players(team.id, tournament.id)
      .then(setSquad)
      .catch((e) => setError(e.message));
  }, [team.id, tournament.id]);

  const groups = useMemo(() => {
    const ps = new Map<string, Player[]>();
    for (const f of FAMILIES) ps.set(f, []);
    for (const p of squad ?? []) {
      const f = positionFamily(p.position);
      ps.get(f)!.push(p);
    }
    for (const list of ps.values()) {
      list.sort((a, b) => (b.rating ?? b.overall) - (a.rating ?? a.overall));
    }
    return ps;
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
                <div className="squad-list">
                  {ps.map((p) => (
                    <div key={p.id} className="pc-pick static">
                      <span className="rr-pos">{p.position}</span>
                      <span className="rr-photo">
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
                      <span className="rr-num">
                        {p.shirt_number != null ? p.shirt_number : ""}
                      </span>
                      <span className="rr-text">
                        <span className="rr-name">{p.name}</span>
                        <span className="rr-pos2">{pos(p.position)}</span>
                      </span>
                      <span className="rr-stars">
                        {starsString(ratingStars(p.rating ?? p.overall))}
                      </span>
                    </div>
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