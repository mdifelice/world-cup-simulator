import { useEffect, useState } from "react";
import { useI18n } from "../i18n";
import { listRuns, loadRun, type HistoryEntry } from "../sim/history";
import type { RunPayload } from "../types";

interface Props {
  onOpen: (run: RunPayload) => void;
  onStartFlow: () => void;
}

export default function History({ onOpen, onStartFlow }: Props) {
  const [entries, setEntries] = useState<HistoryEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { t, country } = useI18n();

  useEffect(() => {
    setEntries(listRuns());
  }, []);

  const open = (entry: HistoryEntry) => {
    const run = loadRun(entry.id);
    if (run) onOpen(run);
    else setError(t("history.missing"));
  };

  return (
    <section>
      <div className="page-head">
        <div>
          <h1>{t("history.title")}</h1>
          <p className="hint">{t("history.hint")}</p>
        </div>
        <button className="btn secondary" onClick={onStartFlow}>{t("history.back")}</button>
      </div>

      {error && <p className="error">{error}</p>}
      {!entries && <p className="hint">{t("history.loading")}</p>}
      {entries && entries.length === 0 && (
        <div className="empty">
          <p>{t("history.empty")}</p>
        </div>
      )}
      {entries && entries.length > 0 && (
        <div className="card-list">
          {entries.map((r) => (
            <div key={r.id} className="card run-card">
              <span className="run-year">{r.year}</span>
              <span className="run-name">{r.tournament_name}</span>
              {r.champion && <span className="run-champ">🏆 {country(r.champion)}</span>}
              <span className="run-date dim">{r.created_at}</span>
              <button className="btn secondary" onClick={() => open(r)}>
                {t("history.relive")}
              </button>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}