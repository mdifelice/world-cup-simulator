import { useEffect, useMemo, useRef, useState } from "react";
import type {
  Participant,
  Phase,
  Player,
  RunMatch,
  RunPayload,
  SimMatch,
  Tournament,
  User,
} from "./types";
import { positionFamily } from "./types";
import { type Formation } from "./formations";
import { api, readToken, setToken } from "./api";
import { localeName, useI18n, type Locale } from "./i18n";
import ChooseTournament from "./pages/ChooseTournament";
import TeamPick from "./pages/TeamPick";
import Roster from "./pages/Roster";
import Overview from "./pages/Overview";
import MatchView from "./pages/MatchView";
import Finals from "./pages/Finals";
import History from "./pages/History";

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

export type Step = "tournament" | "team" | "roster" | "overview" | "match" | "finish" | "history";

interface Flow {
  tournament: Tournament | null;
  team: Participant | null;
  participants: Participant[];
  run: RunPayload | null;
  revealed: number;
  openMatchId: number | null;
  runError: string | null;
}

const emptyFlow: Flow = {
  tournament: null,
  team: null,
  participants: [],
  run: null,
  revealed: 0,
  openMatchId: null,
  runError: null,
};

export default function App() {
  const [step, setStep] = useState<Step>("tournament");
  const [flow, setFlow] = useState<Flow>(emptyFlow);
  const [user, setUser] = useState<User | null>(null);
  const runGuard = useRef<number | null>(null);
  const { t, locale, setLocale } = useI18n();

  // Silent #token= capture from the OAuth redirect (login stays hidden).
  useEffect(() => {
    const h = window.location.hash;
    if (h.startsWith("#token=")) {
      setToken(h.slice(7).trim());
      window.history.replaceState(null, "", window.location.pathname);
    }
  }, []);

  useEffect(() => {
    if (!readToken()) return;
    api.me().then(setUser).catch(() => setUser(null));
  }, [step]);

  const revealedSet = useMemo(
    () => new Set((flow.run?.order ?? []).slice(0, flow.revealed)),
    [flow.run, flow.revealed],
  );
  const revealedMatches = useMemo(
    () => (flow.run?.matches ?? []).filter((m) => revealedSet.has(m.id)),
    [flow.run, revealedSet],
  );
  const maxShownDay = useMemo(
    () => revealedMatches.reduce((mx, m) => Math.max(mx, m.day), 0),
    [revealedMatches],
  );

  const runOnce = (id: number, teamId: number | null) => {
    if (runGuard.current === id) return;
    runGuard.current = id;
    setFlow((f) => ({ ...f, run: null, revealed: 0, runError: null }));
    api
      .run(id, teamId)
      .then((run) =>
        setFlow((f) => ({ ...f, run, revealed: 0, openMatchId: null })),
      )
      .catch((e) =>
        setFlow((f) => ({ ...f, runError: e.message ?? String(e) })),
      );
  };

  const revealThrough = (day: number) =>
    setFlow((f) => {
      if (!f.run) return f;
      const target = day;
      let n = 0;
      for (const id of f.run.order) {
        const m = f.run.matches.find((x) => x.id === id);
        if (!m || m.day > target) break;
        n += 1;
      }
      return { ...f, revealed: Math.max(f.revealed, n) };
    });

  const nextMatchday = () => revealThrough(maxShownDay + 1);

  const revealAll = () =>
    setFlow((f) => (f.run ? { ...f, revealed: f.run.matches.length } : f));

  const jumpToFocus = () =>
    setFlow((f) => {
      if (!f.run || f.run.focus_team_id == null) return f;
      const next = f.run.order.find((id, i) => {
        if (i >= f.revealed) {
          const m = f.run!.matches.find((x) => x.id === id);
          return !!m && (m.home_team_id === f.run!.focus_team_id || m.away_team_id === f.run!.focus_team_id);
        }
        return false;
      });
      if (!next) return { ...f, revealed: f.run.matches.length };
      const m = f.run.matches.find((x) => x.id === next)!;
      const target = m.day;
      let n = 0;
      for (const id of f.run.order) {
        const x = f.run.matches.find((y) => y.id === id);
        if (!x || x.day > target) break;
        n += 1;
      }
      return { ...f, revealed: Math.max(f.revealed, n), openMatchId: m.id };
    });

  const openMatch = (m: RunMatch) =>
    setFlow((f) => ({ ...f, openMatchId: m.id }));

  const pickTournament = (t: Tournament) => {
    setFlow({ ...emptyFlow, tournament: t });
    runGuard.current = null;
    setStep("team");
  };

  const pickTeam = (team: Participant, all: Participant[]) =>
    setFlow((f) => ({ ...f, team, participants: all }));
  const startNeutral = () => {
    const id = flow.tournament?.id;
    if (!id) return;
    setFlow((f) => ({ ...f, team: null }));
    runOnce(id, null);
    setStep("overview");
  };

  const startCup = () => {
    const id = flow.tournament?.id;
    if (!id) return;
    runOnce(id, flow.team?.id ?? null);
    setStep("overview");
  };

  const openRun = (run: RunPayload) => {
    const t: Tournament = {
      id: run.tournament_id,
      name: run.tournament_name,
      year: run.year,
      host: run.host,
      winner: run.champion,
      start_date: null,
      end_date: null,
      shirt_numbers: run.shirt_numbers,
    };
    setFlow((f) => ({ ...f, tournament: t, run, revealed: 0, openMatchId: null }));
    setStep("overview");
  };

  const reset = () => {
    setFlow(emptyFlow);
    runGuard.current = null;
    setStep("tournament");
  };

  const steps: { key: Step; label: string }[] = [
    { key: "tournament", label: t("step.worldcup") },
    { key: "team", label: t("step.team") },
    { key: "roster", label: t("step.squad") },
    { key: "overview", label: t("step.tournament") },
    { key: "match", label: t("step.match") },
    { key: "finish", label: t("step.ceremonies") },
    { key: "history", label: t("step.history") },
  ];

  const activeIndex = steps.findIndex((s) => s.key === step);
  const go = (s: Step) => {
    const idx = steps.findIndex((x) => x.key === s);
    if (idx < 0) return;
    if (idx < activeIndex) setStep(s);
  };

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand" onClick={reset}>
          <span className="brand-ball">⚽</span> {t("app.brand")}
        </div>
        <nav className="steps">
          {steps.map((s) => (
            <button
              key={s.key}
              className={"step" + (step === s.key ? " active" : "") + (s.key === "history" ? " side" : "")}
              onClick={() => (s.key === "history" ? setStep("history") : go(s.key))}
            >
              <span className="step-num">{steps.findIndex((x) => x.key === s.key) + 1}</span>
              {s.label}
            </button>
          ))}
        </nav>
        <div className="top-actions">
          {user && <span className="chip">{user.display_name ?? user.email ?? t("app.signedin")}</span>}
          <select
            className="lang"
            value={locale}
            onChange={(e) => setLocale(e.target.value as Locale)}
            title="Language / Idioma"
          >
            <option value="en">{localeName("en")}</option>
            <option value="es">{localeName("es")}</option>
          </select>
        </div>
      </header>

      <main className="content">
        {step === "tournament" && (
          <ChooseTournament selected={flow.tournament} onPick={pickTournament} />
        )}
        {step === "team" && flow.tournament && (
          <TeamPick
            tournament={flow.tournament}
            selected={flow.team}
            onPick={(t, all) => {
              pickTeam(t, all);
              setStep("roster");
            }}
            onNeutral={startNeutral}
          />
        )}
        {step === "roster" && flow.tournament && flow.team && (
          <Roster
            tournament={flow.tournament}
            team={flow.team}
            onDone={startCup}
            onBack={() => setStep("team")}
          />
        )}
        {step === "overview" && flow.tournament && (
          <Overview
            run={flow.run}
            revealed={flow.revealed}
            runError={flow.runError}
            revealedMatches={revealedMatches}
            maxShownDay={maxShownDay}
            onNext={nextMatchday}
            onAll={revealAll}
            onJump={jumpToFocus}
            onOpen={openMatch}
            onStart={() => runOnce(flow.tournament!.id, flow.team?.id ?? null)}
            onFinish={() => setStep("finish")}
          />
        )}
        {step === "match" && flow.run && flow.openMatchId != null &&
          (() => {
            const m = flow.run.matches.find((x) => x.id === flow.openMatchId);
            if (!m) return null;
            return (
              <MatchView
                match={m}
                focusTeamId={flow.run.focus_team_id}
                shirtNumbers={flow.run.shirt_numbers}
                onBack={() => setStep("overview")}
                onOpenPrev={() => {
                  const order = flow.run!.order;
                  const idx = order.indexOf(m.id);
                  if (idx > 0) openMatch(flow.run!.matches.find((x) => x.id === order[idx - 1])!);
                  else setStep("overview");
                }}
              />);
          })()
        }
        {step === "match" && (!flow.run || flow.openMatchId == null) && (
          <p className="hint">{t("app.noMatchOpen")}</p>
        )}
        {step === "finish" && flow.run && (
          <Finals
            run={flow.run}
            teamId={flow.team?.id ?? null}
            onReplay={startCup}
            onHistory={() => setStep("history")}
            onHome={reset}
          />
        )}
        {step === "history" && (
          <History
            onOpen={openRun}
            onStartFlow={() => {
              if (flow.tournament) setStep("overview");
              else setStep("tournament");
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
    .sort((a, b) => (b.overall || b.rating) - (a.overall || a.rating));
}

export function lineupStrength(lineup: (Player | null)[]): number {
  const filled = lineup.filter((p): p is Player => !!p);
  if (!filled.length) return 0;
  return Math.round(
    filled.reduce((s, p) => s + (p.overall || p.rating), 0) / filled.length,
  );
}