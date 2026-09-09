import { useEffect, useState } from "react";
import { api } from "../api";
import type { RunListItem, RunPayload } from "../types";

interface Props {
  onOpen: (run: RunPayload) => void;
  onStartFlow: () => void;
}

export default function History({ onOpen, onStartFlow }: Props) {
  const [runs, setRuns] = useState<RunListItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [opening, setOpening] = useState<number | null>(null);

  useEffect(() => {
    setRuns(null);
    setError(null);
    api
      .runs()
      .then(setRuns)
      .catch((e) => setError(e.message));
  }, []);

  const open = (id: number) => {
    setOpening(id);
    api
      .runById(id)
      .then(onOpen)
      .catch((e) => setError(e.message))
      .finally(() => setOpening(null));
  };

  return (
    <section>
      <div className="page-head">
        <div>
          <h1>Your saved runs</h1>
          <p className="hint">Every signed-in cup gets archived here so you can relive it.</p>
        </div>
        <button className="btn secondary" onClick={onStartFlow}>Back to the cup</button>
      </div>

      {error && <p className="error">{error}</p>}
      {!runs && !error && <p className="hint">Loading history…</p>}
      {runs && runs.length === 0 && (
        <div className="empty">
          <p>No runs saved yet. Play a tournament while signed in and it will show up here.</p>
        </div>
      )}
      {runs && runs.length > 0 && (
        <div className="card-list">
          {runs.map((r) => (
            <div key={r.id} className="card run-card">
              <span className="run-year">{r.year}</span>
              <span className="run-name">{r.tournament_name}</span>
              {r.champion && <span className="run-champ">🏆 {r.champion}</span>}
              <span className="run-date dim">{r.created_at}</span>
              <button
                className="btn secondary"
                disabled={opening === r.id}
                onClick={() => open(r.id)}
              >
                {opening === r.id ? "Loading…" : "Relive"}
              </button>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}