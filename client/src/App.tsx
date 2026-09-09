import { useEffect, useMemo, useRef, useState } from "react";
import type {
  LineupConfig,
  Participant,
  RunMatch,
  RunPayload,
  Tournament,
  User,
} from "./types";
import { api, readToken, setToken } from "./api";
import { localeName, useI18n, type Locale } from "./i18n";
import ChooseTournament from "./pages/ChooseTournament";
import TeamPick from "./pages/TeamPick";
import Roster from "./pages/Roster";
import Overview from "./pages/Overview";
import MatchView from "./pages/MatchView";
import Finals from "./pages/Finals";
import History from "./pages/History";
import LineupSetup from "./pages/LineupSetup";

export type Step =
  | "tournament"
  | "team"
  | "roster"
  | "overview"
  | "match"
  | "lineup"
  | "finish"
  | "history";

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

/** Stable identity shared with the server for referencing a match's lineup. */
const matchKey = (m: Pick<RunMatch, "stage_key" | "day" | "home_team_id" | "away_team_id">) =>
  `${m.stage_key}|${m.day}|${m.home_team_id}|${m.away_team_id}`;

export default function App() {
  const [step, setStep] = useState<Step>("tournament");
  const [flow, setFlow] = useState<Flow>(emptyFlow);
  const [user, setUser] = useState<User | null>(null);
  const [configs, setConfigs] = useState<Record<string, LineupConfig>>({});
  const [seed, setSeed] = useState<number | null>(null);
  const [interactive, setInteractive] = useState(false);
  const [pendingTarget, setPendingTarget] = useState<{ day: number; open: boolean } | null>(null);
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

  const focusId = flow.run?.focus_team_id ?? null;

  const focusMatches = useMemo(() => {
    if (!flow.run || focusId == null) return [] as RunMatch[];
    const byId = new Map(flow.run.matches.map((m) => [m.id, m]));
    const out: RunMatch[] = [];
    for (const id of flow.run.order) {
      const m = byId.get(id);
      if (m && (m.home_team_id === focusId || m.away_team_id === focusId)) out.push(m);
    }
    return out;
  }, [flow.run, focusId]);

  const nextUnconfiguredFocus = focusMatches.find((m) => !configs[matchKey(m)]) ?? null;

  const revealCountForDay = (run: RunPayload, day: number) => {
    let n = 0;
    for (const id of run.order) {
      const m = run.matches.find((x) => x.id === id);
      if (!m || m.day > day) break;
      n += 1;
    }
    return n;
  };

  /** Re-simulate the whole run. Same seed + same lineups → identical results,
   *  so only the newly-configured match changes. */
  const postRun = (
    save: boolean,
    target: { day: number; open: boolean } | null,
    lineups: Record<string, LineupConfig>,
  ) => {
    const id = flow.tournament?.id;
    if (!id) return;
    if (runGuard.current === id) return;
    runGuard.current = id;
    setFlow((f) => ({ ...f, run: null, revealed: 0, runError: null }));
    api
      .run(id, flow.team?.id ?? null, {
        seed: seed ?? undefined,
        lineups,
        save,
      })
      .then((run) => {
        setSeed(run.seed);
        runGuard.current = null;
        setFlow((f) => ({
          ...f,
          run,
          revealed: target ? revealCountForDay(run, target.day) : 0,
          openMatchId:
            target?.open
              ? (run.matches.find(
                  (m) =>
                    m.day === target.day &&
                    (m.home_team_id === run.focus_team_id || m.away_team_id === run.focus_team_id),
                )?.id ?? null)
              : null,
          runError: null,
        }));
      })
      .catch((e) => {
        runGuard.current = null;
        setFlow((f) => ({ ...f, runError: e.message ?? String(e) }));
      });
  };

  /** Persist the current (deterministic) run to history without disturbing
   *  the reveal state — used when the cup is complete. */
  const saveRunSilently = () => {
    const id = flow.tournament?.id;
    if (!id || !flow.run || flow.run.run_id != null) return;
    if (runGuard.current === id) return;
    runGuard.current = id;
    api
      .run(id, flow.team?.id ?? null, { seed: seed ?? undefined, lineups: configs, save: true })
      .then((run) => {
        runGuard.current = null;
        setSeed(run.seed);
        setFlow((f) => ({ ...f, run }));
      })
      .catch(() => {
        runGuard.current = null;
      });
  };

  const confirmLineup = (cfg: LineupConfig) => {
    const target = pendingTarget;
    setPendingTarget(null);
    if (!target || !flow.run) {
      setStep("overview");
      return;
    }
    const m = flow.run.matches.find(
      (x) => x.day === target.day && (x.home_team_id === focusId || x.away_team_id === focusId),
    );
    const key = m ? matchKey(m) : `day:${target.day}`;
    const newConfigs = { ...configs, [key]: cfg };
    setConfigs(newConfigs);
    const remaining = focusMatches.filter((x) => !newConfigs[matchKey(x)]);
    postRun(remaining.length === 0, target, newConfigs);
    setStep(target.open ? "match" : "overview");
  };

  const gateToSetup = () => {
    if (!nextUnconfiguredFocus) return false;
    setPendingTarget({ day: nextUnconfiguredFocus.day, open: false });
    setStep("lineup");
    return true;
  };

  const revealThrough = (day: number) =>
    setFlow((f) => {
      if (!f.run) return f;
      let n = 0;
      for (const id of f.run.order) {
        const m = f.run.matches.find((x) => x.id === id);
        if (!m || m.day > day) break;
        n += 1;
      }
      return { ...f, revealed: Math.max(f.revealed, n) };
    });

  const nextMatchday = () => {
    if (interactive && nextUnconfiguredFocus && nextUnconfiguredFocus.day <= maxShownDay + 1) {
      gateToSetup();
      return;
    }
    revealThrough(maxShownDay + 1);
  };

  const revealAll = () => {
    if (interactive && gateToSetup()) return;
    setFlow((f) => (f.run ? { ...f, revealed: f.run.matches.length } : f));
    if (interactive && flow.run?.run_id == null && user) saveRunSilently();
  };

  const jumpToFocus = () => {
    if (interactive && nextUnconfiguredFocus) {
      setPendingTarget({ day: nextUnconfiguredFocus.day, open: true });
      setStep("lineup");
      return;
    }
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
      const day = m.day;
      let n = 0;
      for (const id of f.run.order) {
        const x = f.run.matches.find((y) => y.id === id);
        if (!x || x.day > day) break;
        n += 1;
      }
      return { ...f, revealed: Math.max(f.revealed, n), openMatchId: m.id };
    });
  };

  const openMatch = (m: RunMatch) => setFlow((f) => ({ ...f, openMatchId: m.id }));

  const pickTournament = (t: Tournament) => {
    setFlow({ ...emptyFlow, tournament: t });
    setConfigs({});
    setSeed(null);
    setInteractive(false);
    setPendingTarget(null);
    runGuard.current = null;
    setStep("team");
  };

  const pickTeam = (team: Participant, all: Participant[]) =>
    setFlow((f) => ({ ...f, team, participants: all }));

  const startCup = () => {
    const id = flow.tournament?.id;
    if (!id) return;
    setInteractive(true);
    setConfigs({});
    setSeed(null);
    postRun(false, null, {});
    setStep("overview");
  };

  const startNeutral = () => {
    const id = flow.tournament?.id;
    if (!id) return;
    setFlow((f) => ({ ...f, team: null }));
    setInteractive(true);
    setConfigs({});
    setSeed(null);
    postRun(true, null, {});
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
    setInteractive(false);
    setConfigs({});
    setSeed(run.seed);
    setFlow((f) => ({ ...f, tournament: t, run, revealed: 0, openMatchId: null }));
    setStep("overview");
  };

  const reset = () => {
    setFlow(emptyFlow);
    setConfigs({});
    setSeed(null);
    setInteractive(false);
    setPendingTarget(null);
    runGuard.current = null;
    setStep("tournament");
  };

  const goFinish = () => {
    if (interactive && gateToSetup()) return;
    if (interactive && flow.run?.run_id == null && user) saveRunSilently();
    setStep("finish");
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

  // The lineup step sits between overview and the rest of the flow.
  const activeIndex =
    step === "lineup"
      ? steps.findIndex((s) => s.key === "overview")
      : steps.findIndex((s) => s.key === step);
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
            onStart={() => postRun(false, null, configs)}
            onFinish={goFinish}
          />
        )}
        {step === "lineup" &&
          flow.tournament &&
          flow.team &&
          flow.run &&
          (() => {
            const targetDay = pendingTarget?.day;
            const m =
              targetDay == null
                ? null
                : flow.run.matches.find(
                    (x) => x.day === targetDay && (x.home_team_id === focusId || x.away_team_id === focusId),
                  );
            if (!m) {
              return (
                <section>
                  <p className="hint">{t("app.noMatchOpen")}</p>
                  <button className="btn primary" onClick={() => { setPendingTarget(null); setStep("overview"); }}>
                    {t("lineup.cancel")}
                  </button>
                </section>
              );
            }
            const key = matchKey(m);
            return (
              <LineupSetup
                tournament={flow.tournament}
                team={flow.team}
                match={m}
                initial={configs[key]}
                onConfirm={confirmLineup}
                onBack={() => { setPendingTarget(null); setStep("overview"); }}
              />
            );
          })()}
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