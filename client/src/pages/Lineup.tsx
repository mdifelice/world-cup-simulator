import { useEffect, useMemo, useState } from "react";
import type { Dispatch, SetStateAction } from "react";
import { api } from "../api";
import { FORMATIONS } from "../formations";
import type { Player, Team } from "../types";
import { ATTRIBUTES, positionFamily } from "../types";
import Pitch from "../components/Pitch";
import { lineupStrength, playersForPosition } from "../App";
import type { GameState } from "../App";

interface Props {
  team: Team;
  state: GameState;
  setState: Dispatch<SetStateAction<GameState>>;
  onDone: () => void;
}

/** Mirrors the backend position-weighted overall rating. */
export function overall(player: Player): number {
  const w = WEIGHTS[positionFamily(player.position)] ?? WEIGHTS.MF;
  const sum = ATTRIBUTES.reduce(
    (acc, a, i) => acc + (w[i] ?? 0) * (player[a] ?? player.rating),
    0,
  );
  const total = w.reduce((a, b) => a + b, 0);
  return total > 0 ? Math.round(sum / total) : player.rating;
}

// Position-weighted attribute indices (order matches ATTRIBUTES).
const WEIGHTS: Record<string, number[]> = {
  GK: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0.25, 0.22, 0.18, 0, 0.15, 0.05, 0, 0.06, 0.04],
  DF: [0, 0.08, 0.1, 0.14, 0.1, 0.1, 0.06, 0.32, 0.1, 0, 0, 0, 0, 0, 0.06, 0.05, 0.07, 0.04],
  MF: [0, 0.1, 0.12, 0.12, 0.14, 0.22, 0.12, 0.12, 0.14, 0.04, 0, 0, 0, 0, 0.07, 0.02, 0.05, 0.05],
  FW: [0, 0.1, 0.06, 0.14, 0.12, 0.14, 0.12, 0.09, 0.17, 0.06, 0, 0, 0, 0, 0.07, 0, 0.05, 0.03],
};

/** Build a plausible fictional squad from the team's rating. */
export function makePlaceholderSquad(team: Team): Player[] {
  const base = team.rating;
  const roster: Player[] = [];
  const layout = [
    "GK", "GK", "GK",
    "CB", "CB", "CB", "CB", "CB", "LB", "LB", "RB", "RB", "LWB", "RWB",
    "CDM", "CDM", "CM", "CM", "CM", "CAM", "LM", "RM", "LW", "RW", "CF", "ST", "ST",
  ];
  let n = 0;
  const mk = (pos: string, delta: number): Player => {
    const r = Math.min(95, Math.max(42, base + delta + (n % 3)));
    const family = positionFamily(pos);
    const attrs: Partial<Record<(typeof ATTRIBUTES)[number], number>> = {};
    const shift = (i: number, off: number) => {
      const key = ATTRIBUTES[i];
      attrs[key] = Math.min(99, Math.max(1, base - 4 + off + (n % 5)));
    };
    for (let i = 0; i < ATTRIBUTES.length; i++) {
      const w = (WEIGHTS[family] ?? WEIGHTS.MF)[i] ?? 0;
      shift(i, w > 0 ? (pos === "GK" && i >= 10 ? 4 : 3) : -5);
    }
    return {
      id: -(++n),
      team_id: team.id,
      name: `${pos} Player ${n}`,
      position: pos,
      shirt_number: n + 1,
      rating: r,
      overall: r,
      ...(attrs as Record<(typeof ATTRIBUTES)[number], number>),
    };
  };
  layout.forEach((pos, i) => roster.push(mk(pos, FAMILY_DELTA[positionFamily(pos)] + (i % 3) - 1)));
  return roster;
}

const FAMILY_DELTA: Record<string, number> = { GK: 4, DF: -1, MF: 0, FW: 2 };

export default function Lineup({ team, state, setState, onDone }: Props) {
  const [error, setError] = useState<string | null>(null);
  const [slot, setSlot] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    api
      .players(team.id, state.tournament?.id)
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
                        <span className="squad-rating">{overall(p)}</span>
                      </button>
                    </li>
                  ))}
                </ul>
                <button
                  className="btn ghost"
                  onClick={() => setState((st) => ({ ...st, lineup: st.lineup.map(() => null) }))}
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
        {["GK", "DF", "MF", "FW"].map((p) => (
          <span key={p}>{p}</span>
        ))}{" "}
        — squad roster by position
      </p>
    </section>
  );
}