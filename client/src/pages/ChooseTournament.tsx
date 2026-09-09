import { useEffect, useState } from "react";
import { api } from "../api";
import type { WorldCup } from "../types";

interface Props {
  selected: WorldCup | null;
  onPick: (t: WorldCup) => void;
}

export default function ChooseTournament({ selected, onPick }: Props) {
  const [cups, setCups] = useState<WorldCup[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.worldcups().then(setCups).catch((e) => setError(e.message));
  }, []);

  return (
    <section>
      <h1>Choose your World Cup</h1>
      <p className="hint">
        Every edition from 1930 (Uruguay) through 2026 (USA · Mexico · Canada).
      </p>
      {error && <p className="error">Cannot reach the backend: {error}</p>}
      {!cups && !error && <p className="hint">Loading tournaments…</p>}
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
              {c.winner ? `Winner: ${c.winner}` : "Winner pending (2026)"}
            </span>
          </button>
        ))}
      </div>
    </section>
  );
}