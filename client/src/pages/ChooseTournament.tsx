import { useEffect, useState } from "react";
import { api } from "../api";
import { flagFor, useI18n } from "../i18n";
import type { Tournament } from "../types";

interface Props {
  selected: Tournament | null;
  onPick: (t: Tournament) => void;
}

/** Hosts come as "United States / Mexico · Canada" — turn each into a flag. */
const hostFlags = (host: string) =>
  host
    .split(/[/·]+/)
    .map((h) => h.trim())
    .filter(Boolean)
    .map(flagFor)
    .join(" ");

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
      <div className="card-grid cup-grid">
        {cups?.map((c) => (
          <button
            key={c.id}
            className={"card cup-card m3" + (selected?.id === c.id ? " picked" : "")}
            onClick={() => onPick(c)}
          >
            <span className="cup-banner" />
            <span className="cup-pad">
              <span className="cup-era">{t("choose.era", { year: c.year })}</span>
              <span className="cup-year">{c.year}</span>
              {c.host && (() => {
                const flags = hostFlags(c.host);
                return flags ? <span className="cup-flags">{flags}</span> : null;
              })()}
              <span className="cup-host">{c.host}</span>
            </span>
            <span className="cup-winner">
              {c.winner
                ? <>🏆 {c.winner}</>
                : t("choose.winnerPending", { year: c.year })}
            </span>
          </button>
        ))}
      </div>
    </section>
  );
}