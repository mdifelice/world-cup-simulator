import { useMemo, useState } from "react";
import type { Participant, Phase, Player, SimMatch, Tournament } from "./types";
import { positionFamily } from "./types";
import { type Formation } from "./formations";
import ChooseTournament from "./pages/ChooseTournament";
import ChooseTeam from "./pages/ChooseTeam";
import Lineup from "./pages/Lineup";
import Simulation from "./pages/Simulation";

export interface GameState {
  tournament: Tournament | null;
  phases: Phase[];
  team: Participant | null;
  participants: Participant[];
  squad: Player[];
  formation: Formation | null;
  lineup: (Player | null)[];
  results: SimMatch[] | null;
  champion: string | null;
}

const initialState: GameState = {
  tournament: null,
  phases: [],
  team: null,
  participants: [],
  squad: [],
  formation: null,
  lineup: [],
  results: null,
  champion: null,
};

export type Step = "tournament" | "team" | "lineup" | "simulate";

export default function App() {
  const [step, setStep] = useState<Step>("tournament");
  const [state, setState] = useState<GameState>(initialState);

  const steps: { key: Step; label: string }[] = [
    { key: "tournament", label: "World Cup" },
    { key: "team", label: "Team" },
    { key: "lineup", label: "Formation" },
    { key: "simulate", label: "Tournament" },
  ];

  const canGoTo: Record<Step, boolean> = useMemo(
    () => ({
      tournament: true,
      team: !!state.tournament,
      lineup: !!state.team,
      simulate: state.lineup.some(Boolean) && !!state.formation,
    }),
    [state],
  );

  const index = steps.findIndex((s) => s.key === step);
  const go = (s: Step) => {
    if (canGoTo[s] || steps.findIndex((x) => x.key === s) < index) setStep(s);
  };

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="brand-ball">⚽</span> World Cup Simulator
        </div>
        <nav className="steps">
          {steps.map((s, i) => (
            <button
              key={s.key}
              className={
                "step" +
                (step === s.key ? " active" : "") +
                (canGoTo[s.key] ? " enabled" : "")
              }
              onClick={() => go(s.key)}
            >
              <span className="step-num">{i + 1}</span>
              {s.label}
            </button>
          ))}
        </nav>
      </header>

      <main className="content">
        {step === "tournament" && (
          <ChooseTournament
            selected={state.tournament}
            onPick={(t) => {
              setState({ ...initialState, tournament: t });
              setStep("team");
            }}
          />
        )}
        {step === "team" && state.tournament && (
          <ChooseTeam
            tournament={state.tournament}
            selected={state.team}
            onPhases={(phases) => setState((st) => ({ ...st, phases }))}
            onPick={(t, all) => {
              setState({
                ...state,
                team: t,
                participants: all,
                squad: [],
                lineup: [],
                results: null,
              });
              setStep("lineup");
            }}
          />
        )}
        {step === "lineup" && state.team && (
          <Lineup
            team={state.team}
            state={state}
            setState={setState}
            onDone={() => setStep("simulate")}
          />
        )}
        {step === "simulate" && state.tournament && (
          <Simulation
            state={state}
            setState={setState}
            onRestart={() => {
              setState(initialState);
              setStep("tournament");
            }}
          />
        )}
      </main>
    </div>
  );
}

// shared helpers: players for a formation family (or exact position), highest rated first
export function playersForPosition(squad: Player[], pos: string): Player[] {
  const isFamily = ["GK", "DF", "MF", "FW"].includes(pos);
  return squad
    .filter((p) =>
      isFamily ? positionFamily(p.position) === pos : p.position === pos,
    )
    .sort((a, b) => b.rating - a.rating);
}

export function lineupStrength(lineup: (Player | null)[]): number {
  const filled = lineup.filter((p): p is Player => !!p);
  if (!filled.length) return 0;
  return Math.round(filled.reduce((s, p) => s + p.rating, 0) / filled.length);
}