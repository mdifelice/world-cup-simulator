import { useEffect, useMemo, useState } from "react";
import { api } from "../api";
import type { Player, Team, Tournament } from "../types";
import { positionFamily } from "../types";

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

  const totalOvr = useMemo(() => {
    const s = squad ?? [];
    if (!s.length) return null;
    return Math.round(s.reduce((a, p) => a + (p.overall || 0), 0) / s.length);
  }, [squad]);

  return (
    <section>
      <div className="page-head">
        <div>
          <h1>{team.flag ?? "🌍"} {team.name} — squad</h1>
          <p className="hint">
            {tournament.year} · 26 players · {squad?.length ?? "…"} on the list
            {totalOvr != null ? <> · average ✦ {totalOvr}</> : ""}
          </p>
        </div>
        <button className="btn secondary" onClick={onBack}>← another team</button>
      </div>
      {error && <p className="error">{error}</p>}
      {!squad && !error && <p className="hint">Loading squad…</p>}
      {squad && squad.length === 0 && (
        <div className="empty"><p>No squad list for this team.</p></div>
      )}
      {squad && squad.length > 0 && (
        <>
          {FAMILIES.map((f) => {
            const ps = groups.get(f)!;
            if (!ps.length) return null;
            return (
              <div key={f} className="pos-block">
                <h2 className="pos-title">{f}</h2>
                <div className="player-list">
                  {ps.map((p) => (
                    <div key={p.id} className="player-row">
                      <span className="player-num">
                        {tournament.shirt_numbers ? p.shirt_number ?? "—" : p.position}
                      </span>
                      <span className="player-name">{p.name}</span>
                      <span className="player-pos">{p.position}</span>
                      <span className="player-ovr">✦ {Math.round(p.overall)}</span>
                    </div>
                  ))}
                </div>
              </div>
            );
          })}
          <div className="bar-hint">
            <button className="btn primary big" onClick={onDone}>
              Start the World Cup →
            </button>
          </div>
        </>
      )}
    </section>
  );
}