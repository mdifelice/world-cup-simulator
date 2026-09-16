import { useEffect, useState } from "react";
import { api } from "../api";
import { flagFor, useI18n } from "../i18n";
import type { Tournament } from "../types";

interface Props {
  selected: Tournament | null;
  onPick: (t: Tournament) => void;
  onHistory: () => void;
}

const FIFA_TROPHY = (
  <svg className="cup-trophy" viewBox="0 0 40 48" aria-hidden="true">
    <defs>
      <linearGradient id="tg" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stopColor="#f6d475" />
        <stop offset=".55" stopColor="#d4a017" />
        <stop offset="1" stopColor="#a97f10" />
      </linearGradient>
    </defs>
    <rect x="15" y="42" width="10" height="4" rx="2" fill="url(#tg)" />
    <rect x="12" y="39" width="16" height="4" rx="2" fill="url(#tg)" />
    <path d="M14 8 H26 V22 C26 28 22 34 20 36 C18 34 14 28 14 22 Z" fill="url(#tg)" />
    <circle cx="20" cy="6" r="4" fill="url(#tg)" />
    <path d="M14 11 C7 15 5 22 8 28" stroke="url(#tg)" strokeWidth="4" fill="none" strokeLinecap="round" />
    <path d="M26 11 C33 15 35 22 32 28" stroke="url(#tg)" strokeWidth="4" fill="none" strokeLinecap="round" />
  </svg>
);

const JULES_RIMET = (
  <svg className="cup-trophy" viewBox="0 0 40 48" aria-hidden="true">
    <defs>
      <linearGradient id="tr" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stopColor="#f6d475" />
        <stop offset=".55" stopColor="#d4a017" />
        <stop offset="1" stopColor="#a97f10" />
      </linearGradient>
    </defs>
    <rect x="15" y="42" width="10" height="4" rx="2" fill="url(#tr)" />
    <rect x="13" y="39" width="14" height="4" rx="2" fill="url(#tr)" />
    <path d="M15 39 H25 V24 C25 20 20 18 20 18 C20 18 15 20 15 24 Z" fill="url(#tr)" />
    <circle cx="20" cy="13" r="3" fill="url(#tr)" />
    <path d="M20 18 V8" stroke="url(#tr)" strokeWidth="2.5" strokeLinecap="round" />
    <path d="M14 11 C10 8 8 13 11 16" stroke="url(#tr)" strokeWidth="2.5" fill="none" strokeLinecap="round" />
    <path d="M26 11 C30 8 32 13 29 16" stroke="url(#tr)" strokeWidth="2.5" fill="none" strokeLinecap="round" />
  </svg>
);

const hostFlags = (host: string) =>
  host
    .split(/[/·]+/)
    .map((h) => h.trim())
    .filter(Boolean)
    .map(flagFor)
    .join(" ");

const trophyFor = (year: number) => (year >= 1974 ? FIFA_TROPHY : JULES_RIMET);

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
              {trophyFor(c.year)}
              <span className="cup-era">{t("choose.era", { year: c.year })}</span>
              <span className="cup-year">{c.year}</span>
              {hostFlags(c.host) ? <span className="cup-flags">{hostFlags(c.host)}</span> : null}
              <span className="cup-host">{c.host}</span>
              <span className="cup-winner">
                {c.winner
                  ? <>🏆 {c.winner}</>
                  : c.ready
                    ? t("choose.winnerPending", { year: c.year })
                    : null}
              </span>
            </span>
          </button>
        ))}
      </div>
    </section>
  );
}
