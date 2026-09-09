import { useEffect, useState } from "react";
import { api } from "../api";
import type { Participant, Tournament } from "../types";

interface Props {
  tournament: Tournament;
  selected: Participant | null;
  onPick: (t: Participant, all: Participant[]) => void;
  onNeutral: () => void;
}

export default function TeamPick({ tournament, selected, onPick, onNeutral }: Props) {
  const [teams, setTeams] = useState<Participant[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setTeams(null);
    setError(null);
    api
      .participants(tournament.id)
      .then(setTeams)
      .catch((e) => setError(e.message));
  }, [tournament.id]);

  return (
    <section>
      <h1>{tournament.year} — pick your nation</h1>
      <p className="hint">
        Take the touchline for any team in the {tournament.year} World Cup. Your
        nation's matches get live momentum charts as they happen.
      </p>
      {error && <p className="error">{error}</p>}
      {!teams && !error && <p className="hint">Loading participants…</p>}
      {teams && teams.length === 0 && (
        <div className="empty">
          <p>No participants loaded for {tournament.year} yet.</p>
        </div>
      )}
      <div className="card-grid">
        {teams?.map((t) => (
          <button
            key={t.id}
            className={"card team-card" + (selected?.id === t.id ? " picked" : "")}
            onClick={() => onPick(t, teams)}
          >
            <span className="team-flag">{t.flag ?? "🌍"}</span>
            <span className="team-name">{t.name}</span>
            <span className="team-rating">OVR {t.rating}</span>
          </button>
        ))}
      </div>
      {teams && teams.length > 0 && (
        <p className="hint bar-hint">
          …or{" "}
          <button className="link" onClick={onNeutral}>
            watch the whole tournament as a neutral
          </button>
          .
        </p>
      )}
    </section>
  );
}