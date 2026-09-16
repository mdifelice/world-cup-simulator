import { useEffect, useState } from "react";
import { api } from "../api";
import { flagFor, useI18n } from "../i18n";
import { trophyForYear } from "../trophies";
import type { Tournament } from "../types";

interface Props {
  selected: Tournament | null;
  onPick: (t: Tournament) => void;
  onHistory: () => void;
}

const hostParts = (host: string) =>
  host
    .split(/[/·]+/)
    .map((h) => h.trim())
    .filter(Boolean);

export default function ChooseTournament({ selected, onPick, onHistory }: Props) {
  const [cups, setCups] = useState<Tournament[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { t, country } = useI18n();

  useEffect(() => {
    api.tournaments().then(setCups).catch((e) => setError(e.message));
  }, []);

  return (
    <section>
      <div className="page-head">
        <div>
          <h1>{t("choose.title")}</h1>
          <p className="hint">{t("choose.hint")}</p>
        </div>
        <button className="btn secondary" onClick={onHistory}>
          {t("step.history")}
        </button>
      </div>
      {error && <p className="error">{t("choose.error")} {error}</p>}
      {!cups && !error && <p className="hint">{t("choose.loading")}</p>}
      <div className="cup-grid">
        {cups?.map((c) => (
          <button
            key={c.id}
            className={
              "cup-card m3" +
              (selected?.id === c.id ? " picked" : "") +
              (c.ready ? "" : " disabled")
            }
            disabled={!c.ready}
            onClick={() => c.ready && onPick(c)}
          >
            <span className="cup-banner" />
            <span className="cup-pad">
              {c.winner ? (
                <img
                  className="cup-trophy"
                  src={trophyForYear(c.year)}
                  alt=""
                  loading="lazy"
                />
              ) : (
                <span className="cup-trophy-empty" aria-hidden="true" />
              )}
              <span className="cup-era">{t("choose.era", { year: c.year })}</span>
              <span className="cup-year">{c.year}</span>
              <span className="cup-winner">
                {c.winner
                  ? <>🏆 {country(c.winner).toUpperCase()}</>
                  : c.ready
                    ? t("choose.winnerPending", { year: c.year })
                    : null}
              </span>
              <span className="cup-host">
                {hostParts(c.host).length > 0 ? (
                  <span className="cup-flags">
                    {hostParts(c.host).map(flagFor).join(" ")}
                  </span>
                ) : null}
                <span className="cup-host-name">
                  {hostParts(c.host).map(country).join(" · ")}
                </span>
              </span>
            </span>
          </button>
        ))}
      </div>
    </section>
  );
}