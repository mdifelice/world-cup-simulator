import { useEffect, useState } from "react";
import { api } from "../api";
import { useI18n } from "../i18n";
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
  const { t } = useI18n();

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
      <h1>{t("team.title", { year: tournament.year })}</h1>
      <p className="hint">{t("team.hint", { year: tournament.year })}</p>
      {error && <p className="error">{error}</p>}
      {!teams && !error && <p className="hint">{t("team.loading")}</p>}
      {teams && teams.length === 0 && (
        <div className="empty">
          <p>{t("team.empty", { year: tournament.year })}</p>
        </div>
      )}
      <div className="card-grid">
        {teams?.map((team) => (
          <button
            key={team.id}
            className={"card team-card" + (selected?.id === team.id ? " picked" : "")}
            onClick={() => onPick(team, teams)}
          >
            <span className="team-flag">{team.flag ?? "🌍"}</span>
            <span className="team-name">{team.name}</span>
            <span className="team-rating">OVR {team.rating}</span>
          </button>
        ))}
      </div>
      {teams && teams.length > 0 && (
        <p className="hint bar-hint">
          <button className="link" onClick={onNeutral}>
            {t("team.neutral")}
          </button>
        </p>
      )}
    </section>
  );
}