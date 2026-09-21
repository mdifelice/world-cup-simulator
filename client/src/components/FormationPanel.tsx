import { useEffect, useMemo, useState } from "react";
import { api } from "../api";
import { useI18n } from "../i18n";
import LineupEditor from "./LineupEditor";
import type { LineupConfig, Player, RunMatch } from "../types";

interface Props {
  tournamentId: number;
  teamId: number;
  teamName: string;
  match: RunMatch;
  shirtNumbers: boolean;
  initial?: LineupConfig;
  year?: number;
  disabled?: boolean;
  unavailable?: number[];
  onReady?: (cfg: LineupConfig | null) => void;
}

export default function FormationPanel({
  tournamentId,
  teamId,
  teamName,
  match,
  shirtNumbers,
  initial,
  year,
  disabled = false,
  unavailable,
  onReady,
}: Props) {
  const { t, stage, country } = useI18n();
  const [squad, setSquad] = useState<Player[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setSquad(null);
    setError(null);
    api
      .players(teamId, tournamentId)
      .then(setSquad)
      .catch((e) => setError(e.message));
  }, [teamId, tournamentId]);

  const opponent =
    match.home_team_id === teamId ? match.away_team_name : match.home_team_name;

  const suspendedNames = useMemo(
    () =>
      (squad ?? [])
        .filter((p) => (unavailable ?? []).includes(p.id))
        .map((p) => p.name),
    [squad, unavailable],
  );

  return (
    <div className="form-panel form-wrap">
      <div className="form-head">
        <h2 className="sec-title">{t("hub.formation")}</h2>
        <p className="hint">
          {country(teamName)} · {t("lineup.subtitle", {
            day: match.day,
            stage: stage(match.stage_name),
            opponent: country(opponent),
          })}
        </p>
      </div>
      {error && <p className="error">{error}</p>}
      {!squad && !error && <p className="hint">{t("squad.loading")}</p>}
      {squad && (
        <>
          {suspendedNames.length > 0 && (
            <p className="sus-note">
              <span className="red-card tiny" aria-hidden />
              {t("lineup.suspendedNote", { names: suspendedNames.join(", ") })}
            </p>
          )}
          <LineupEditor
            shirtNumbers={shirtNumbers}
            squad={squad}
            initial={initial}
            year={year}
            disabled={disabled}
            unavailable={unavailable}
            onReady={onReady}
          />
        </>
      )}
    </div>
  );
}