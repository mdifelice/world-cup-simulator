import { useEffect, useState } from "react";
import { api } from "../api";
import type { Participant, WorldCup } from "../types";

interface Props {
  tournament: WorldCup;
  selected: Participant | null;
  onPick: (t: Participant, all: Participant[]) => void;
}

export default function ChooseTeam({ tournament, selected, onPick }: Props) {
  const [teams, setTeams] = useState<Participant[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setTeams(null);
    api
      .participants(tournament.id)
      .then(setTeams)
      .catch((e) => setError(e.message));
  }, [tournament.id]);

  return (
    <section>
      <h1>
        {tournament.year} — pick your nation
      </h1>
      <p className="hint">
        Take control of any team that played the {tournament.year} World Cup.
      </p>
      {error && <p className="error">{error}</p>}
      {!teams && !error && <p className="hint">Loading participants…</p>}
      {teams && teams.length === 0 && (
        <div className="empty">
          <p>
            No squads uploaded for {tournament.year} yet. Load them with the
            scraper or the upload API, or start with 2022 (bundled demo data).
          </p>
          {tournament.year !== 2022 && (
            <p className="hint">
              Tip: use the scrapper tool to load {tournament.year} squads, then
              press Restart.
            </p>
          )}
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
    </section>
  );
}