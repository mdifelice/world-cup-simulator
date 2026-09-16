import { useEffect, useState } from "react";
import { api } from "../api";
import { flagFor, useI18n } from "../i18n";
import type { Tournament } from "../types";

interface Props {
  selected: Tournament | null;
  onPick: (t: Tournament) => void;
  onHistory: () => void;
}

const TROPHY_IMAGES: Record<string, string> = {
  fifa: "https://upload.wikimedia.org/wikipedia/commons/thumb/1/10/FIFA_World_Cup_Trophy_%28Ank_Kumar%2C_Infosys_Limited%29_04.jpg/120px-FIFA_World_Cup_Trophy_%28Ank_Kumar%2C_Infosys_Limited%29_04.jpg",
  jules:
    "https://upload.wikimedia.org/wikipedia/commons/thumb/a/ae/FIFA_World_Cup_Trophy_at_National_Football_Museum%2C_Manchester_02.jpg/120px-FIFA_World_Cup_Trophy_at_National_Football_Museum%2C_Manchester_02.jpg",
};

const hostFlags = (host: string) =>
  host
    .split(/[/·]+/)
    .map((h) => h.trim())
    .filter(Boolean)
    .map(flagFor)
    .join(" ");

export default function ChooseTournament({ selected, onPick, onHistory }: Props) {
  const [cups, setCups] = useState<Tournament[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { t } = useI18n();

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
              <img
                className="cup-trophy"
                src={TROPHY_IMAGES[c.year >= 1974 ? "fifa" : "jules"]}
                alt=""
                loading="lazy"
              />
              <span className="cup-era">{t("choose.era", { year: c.year })}</span>
              <span className="cup-year">{c.year}</span>
              <span className="cup-winner">
                {c.winner
                  ? <>🏆 {c.winner.toUpperCase()}</>
                  : c.ready
                    ? t("choose.winnerPending", { year: c.year })
                    : null}
              </span>
              <span className="cup-host">
                {hostFlags(c.host) ? <span className="cup-flags">{hostFlags(c.host)}</span> : null}
                <span className="cup-host-name">{c.host}</span>
              </span>
            </span>
          </button>
        ))}
      </div>
    </section>
  );
}