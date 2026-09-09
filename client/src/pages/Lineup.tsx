import { useEffect, useMemo, useState } from "react";
import type { Dispatch, SetStateAction } from "react";
import { api } from "../api";
import { FORMATIONS, POSITION_ORDER } from "../formations";
import type { Player, Team } from "../types";
import Pitch from "../components/Pitch";
import { lineupStrength, playersForPosition } from "../App";
import type { GameState } from "../App";

interface Props {
  team: Team;
  state: GameState;
  setState: Dispatch<SetStateAction<GameState>>;
  onDone: () => void;
}

function makePlaceholderSquad(team: Team): Player[] {
  const r = team.rating;
  const mk = (i: number, pos: Player["position"], rating: number): Player => ({
    id: -i,
    team_id: team.id,
    name: `${pos} Player ${i}`,
    position: pos,
    shirt_number: i,
    rating,
  });
  const squad: Player[] = [];
  let n = 0;
  for (const pos of ["GK", "GK", "GK", "DF", "DF", "DF", "DF", "DF", "DF", "DF",
                   "MF", "MF", "MF", "MF", "MF", "MF", "MF", "MF",
                   "FW", "FW", "FW", "FW", "FW", "FW"] as Player["position"][]) {
    const delta =
      pos === "GK" ? 2 : pos === "DF" ? -2 : pos === "MF" ? 0 : 3;
    squad.push(mk(++n, pos, Math.min(96, Math.max(40, r + delta + (n % 3)))));
  }
  return squad;
}

export default function Lineup({ team, state, setState, onDone }: Props) {
  const [error, setError] = useState<string | null>(null);
  const [slot, setSlot] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    api
      .players(team.id)
      .then((players) => {
        const squad = players.length ? players : makePlaceholderSquad(team);
        const formation = state.formation ?? FORMATIONS[0];
        let lineup: (Player | null)[] = [];
        // auto-draft the best XI for the default formation
        for (const s of formation.slots) {
          const pool = playersForPosition(squad, s.pos);
          const pick = pool.find((p) => !lineup.includes(p)) ?? null;
          lineup.push(pick);
        }
        setState((st) => ({ ...st, squad, formation, lineup }));
      })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [team.id]);

  const { squad, formation, lineup } = state;

  const candidates = useMemo(() => {
    if (!formation || slot === null) return [];
    return playersForPosition(squad, formation.slots[slot].pos).filter(
      (p) => !lineup.some((lp) => lp?.id === p.id),
    );
  }, [squad, formation, slot, lineup]);

  const avg = lineupStrength(lineup);
  const boost = Math.max(0, Math.min(6, Math.round(avg - team.rating)));

  const assign = (p: Player) => {
    if (formation && slot !== null) {
      const next = [...lineup];
      next[slot] = p;
      setState((st) => ({ ...st, lineup: next }));
      setSlot(null);
    }
  };

  if (loading) return <p className="hint">Loading squad…</p>;
  if (error) return <p className="error">{error}</p>;

  return (
    <section className="lineup">
      <h1>{team.name} — choose your formation</h1>

      <div className="formation-bar">
        {FORMATIONS.map((f) => (
          <button
            key={f.id}
            className={"chip" + (formation?.id === f.id ? " active" : "")}
            onClick={() => {
              const lineup: (Player | null)[] = [];
              for (const s of f.slots) {
                const pool = playersForPosition(squad, s.pos);
                lineup.push(pool.find((p) => !lineup.includes(p)) ?? null);
              }
              setState((st) => ({ ...st, formation: f, lineup }));
              setSlot(null);
            }}
          >
            {f.label}
          </button>
        ))}
      </div>

      <div className="lineup-grid">
        <Pitch
          formation={formation!}
          lineup={lineup}
          selected={slot}
          onSelect={(i) => setSlot(slot === i ? null : i)}
        />

        <div className="sidemenu">
          <div className="stats">
            <div className="stat">
              <span>Avg rating</span>
              <strong>{avg}</strong>
            </div>
            <div className="stat">
              <span>Team OVR</span>
              <strong>{team.rating}</strong>
            </div>
            <div className="stat">
              <span>Tactical boost</span>
              <strong className={boost > 0 ? "good" : ""}>+{boost}</strong>
            </div>
          </div>

          <div className="slot-picker">
            {slot === null ? (
              <p className="hint">Tap any pitch slot to pick a player.</p>
            ) : (
              <>
                <h3>
                  {formation!.label} · {formation!.slots[slot].pos}
                </h3>
                <ul>
                  {candidates.map((p) => (
                    <li key={p.id}>
                      <button className="squad-row" onClick={() => assign(p)}>
                        <span className="squad-pos">{p.position}</span>
                        <span className="squad-name">
                          {p.shirt_number != null ? `${p.shirt_number} · ` : ""}
                          {p.name}
                        </span>
                        <span className="squad-rating">{p.rating}</span>
                      </button>
                    </li>
                  ))}
                </ul>
                <button
                  className="btn ghost"
                  onClick={() => setState((st) => ({ ...st, lineup: st.lineup.map(() => null), boosting: false }))}
                >
                  Clear lineup
                </button>
              </>
            )}
          </div>

          <button className="btn primary big" onClick={onDone} disabled={!lineup.every(Boolean)}>
            Continue ›
          </button>
          {!lineup.every(Boolean) && (
            <p className="hint">Fill every slot to continue.</p>
          )}
        </div>
      </div>

      <p className="pos-legend">
        {POSITION_ORDER.map((p) => (
          <span key={p}>{p}</span>
        ))}{" "}
        — squad roster by position
      </p>
    </section>
  );
}