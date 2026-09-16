import { useEffect, useState } from "react";
import { api } from "../api";
import { useI18n } from "../i18n";
import LineupEditor from "../components/LineupEditor";
import type { LineupConfig, Player, RunMatch, Team, Tournament } from "../types";

interface Props {
  tournament: Tournament;
  team: Team;
  match: RunMatch;
  shirtNumbers: boolean;
  initial?: LineupConfig;
  onConfirm: (cfg: LineupConfig) => void;
  onBack: () => void;
}

export default function LineupPitch({
  tournament,
  team,
  match,
  shirtNumbers,
  initial,
  onConfirm,
  onBack,
}: Props) {
  const { t, stage } = useI18n();
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

  const opponent =
    match.home_team_id === team.id ? match.away_team_name : match.home_team_name;

  return (
    <section>
      <div className="page-head">
        <div>
          <h1>
            {team.flag ?? "🌍"} {team.name} {t("lineup.title")}
          </h1>
          <p className="hint">
            {t("lineup.subtitle", {
              day: match.day,
              stage: stage(match.stage_name),
              opponent,
            })}
          </p>
        </div>
        <button className="btn secondary" onClick={onBack}>{t("lineup.cancel")}</button>
      </div>

      {error && <p className="error">{error}</p>}
      {!squad && !error && <p className="hint">{t("squad.loading")}</p>}

      {squad && (
        <LineupEditor
          shirtNumbers={shirtNumbers}
          squad={squad}
          initial={initial}
          onConfirm={onConfirm}
        />
      )}
    </section>
  );
}