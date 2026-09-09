import { useEffect, useState } from "react";
import { api } from "../api";
import { useI18n } from "../i18n";
import type { Tournament } from "../types";

interface Props {
  selected: Tournament | null;
  onPick: (t: Tournament) => void;
}

export default function ChooseTournament({ selected, onPick }: Props) {
  const [cups, setCups] = useState<Tournament[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { t } = useI18n();

  useEffect(() => {
    api.tournaments().then(setCups).catch((e) => setError(e.message));
  }, []);

  return (
    <section>
      <h1>{t("choose.title")}</h1>
      <p className="hint">{t("choose.hint")}</p>
      {error && <p className="error">{t("choose.error")} {error}</p>}
      {!cups && !error && <p className="hint">{t("choose.loading")}</p>}
      <div className="card-grid">
        {cups?.map((c) => (
          <button
            key={c.id}
            className={"card cup-card" + (selected?.id === c.id ? " picked" : "")}
            onClick={() => onPick(c)}
          >
            <span className="cup-year">{c.year}</span>
            <span className="cup-host">{c.host}</span>
            <span className="cup-winner">
              {c.winner
                ? t("choose.winner", { name: c.winner })
                : t("choose.winnerPending", { year: c.year })}
            </span>
          </button>
        ))}
      </div>
    </section>
  );
}