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
import History from "./pages/History";
import LiveMatch from "./components/LiveMatch";
import MatchDetail from "./components/MatchDetail";
import ShareModal from "./components/ShareModal";

export type Step =
  | "tournament"
  | "team"
  | "roster"
  | "overview"
  | "history";

interface Flow {
  tournament: Tournament | null;
  team: Participant | null;
  participants: Participant[];
  run: RunPayload | null;
  revealed: number;
  runError: string | null;
}

const emptyFlow: Flow = {
  tournament: null,
  team: null,
  participants: [],
  run: null,
  revealed: 0,
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
  const runGuard = useRef<number | null>(null);
  const [scrollToMatch, setScrollToMatch] = useState<number | null>(null);
  const [liveMatch, setLiveMatch] = useState<RunMatch | null>(null);
  const [matchDetail, setMatchDetail] = useState<RunMatch | null>(null);
  const [formationFlash, setFormationFlash] = useState(0);
  const [ffRunning, setFfRunning] = useState(false);
  const ffTimer = useRef<number | null>(null);
  const [shareOpen, setShareOpen] = useState(false);
  const { locale, setLocale } = useI18n();

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

  /** The next focus match that still needs a lineup — drives the inline
   *  formation panel on the hub and gates the Play button. */
  const inlineMatch = focusMatches.find((m) => !configs[matchKey(m)]) ?? null;

  /** Match helpers used by the match-by-match fast-forward. */
  const isFocusMatch = (run: RunPayload, id: number) => {
    if (run.focus_team_id == null) return false;
    const m = run.matches.find((x) => x.id === id);
    return !!m && (m.home_team_id === run.focus_team_id || m.away_team_id === run.focus_team_id);
  };

  const runRef = useRef<RunPayload | null>(flow.run);
  runRef.current = flow.run;
  const revealedRef = useRef(flow.revealed);
  revealedRef.current = flow.revealed;

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
          runError: null,
        }));
        if (target?.open) {
          const fm = run.matches.find(
            (m) =>
              m.day === target.day &&
              (m.home_team_id === run.focus_team_id || m.away_team_id === run.focus_team_id),
          );
          if (fm) setLiveMatch(fm);
        }
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

  /** The inline formation panel auto-submits the lineup once the XI is full.
   *  Re-run the (deterministic) sim so only the configured match changes. */
  const applyLineup = (cfg: LineupConfig) => {
    if (!flow.run || !inlineMatch) return;
    const key = matchKey(inlineMatch);
    const newConfigs = { ...configs, [key]: cfg };
    setConfigs(newConfigs);
    const remaining = focusMatches.filter((x) => !newConfigs[matchKey(x)]);
    postRun(remaining.length === 0, { day: inlineMatch.day, open: false }, newConfigs);
  };

  const revealAll = () => {
    if (!flow.run) return;
    if (interactive && inlineMatch) {
      const idx = flow.run.order.indexOf(inlineMatch.id);
      setFlow((f) => (f.run ? { ...f, revealed: Math.max(f.revealed, idx) } : f));
      setFormationFlash((n) => n + 1);
      return;
    }
    setFlow((f) => (f.run ? { ...f, revealed: f.run.matches.length } : f));
    if (interactive && flow.run?.run_id == null && user) saveRunSilently();
  };

  const jumpToFocus = () => {
    if (!flow.run || flow.run.focus_team_id == null) return;
    const run = flow.run;
    if (interactive && inlineMatch) {
      const idx = run.order.indexOf(inlineMatch.id);
      setFlow((f) => (f.run ? { ...f, revealed: Math.max(f.revealed, idx) } : f));
      setFormationFlash((n) => n + 1);
      return;
    }
    const next = run.order.find((id, i) => i >= flow.revealed && isFocusMatch(run, id));
    if (!next) {
      setFlow((f) => (f.run ? { ...f, revealed: f.run.matches.length } : f));
      return;
    }
    const m = run.matches.find((x) => x.id === next);
    if (!m) return;
    let n = 0;
    for (const id of run.order) {
      const x = run.matches.find((y) => y.id === id);
      if (!x || x.day > m.day) break;
      n += 1;
    }
    setFlow((f) => (f.run ? { ...f, revealed: Math.max(f.revealed, n) } : f));
  };

  const stopFF = () => {
    if (ffTimer.current != null) {
      window.clearInterval(ffTimer.current);
      ffTimer.current = null;
    }
    setFfRunning(false);
  };

  useEffect(() => {
    return () => {
      if (ffTimer.current != null) window.clearInterval(ffTimer.current);
    };
  }, []);

  /** Hub fast-forward: simulate match by match (result only, 500ms apart),
   *  stopping right before the next focus match so it can be played. */
  const runFastForward = () => {
    if (!flow.run || ffRunning) return;
    const run = flow.run;
    const cur = flow.revealed;
    const first = run.order[cur];
    if (first == null || isFocusMatch(run, first)) return;
    setFfRunning(true);
    ffTimer.current = window.setInterval(() => {
      const r = runRef.current;
      const at = revealedRef.current;
      if (!r) {
        stopFF();
        return;
      }
      if (at >= r.matches.length || isFocusMatch(r, r.order[at])) {
        stopFF();
        return;
      }
      setFlow((f) => (f.run ? { ...f, revealed: f.revealed + 1 } : f));
    }, 500);
  };

  // Ask before abandoning an in-progress interactive run with a refresh.
  useEffect(() => {
    if (!interactive || !flow.run || flow.revealed >= (flow.run.matches.length || 0)) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [interactive, flow.run, flow.revealed]);

  const revealUpTo = (idx: number) =>
    setFlow((f) => (f.run ? { ...f, revealed: Math.max(f.revealed, idx + 1) } : f));

  const replayMatch = (m: RunMatch) => {
    stopFF();
    setScrollToMatch(m.id);
    setLiveMatch(m);
  };

  /** Fast-forward from the live popup: simulate everything to the end of the
   *  current round (same stage), then close back to the hub. */
  const ffFromLive = (m: RunMatch) => {
    if (!flow.run) {
      setLiveMatch(null);
      return;
    }
    stopFF();
    const run = flow.run;
    let last = 0;
    for (const id of run.order) {
      const x = run.matches.find((y) => y.id === id);
      if (!x || x.stage_key !== m.stage_key) break;
      last += 1;
    }
    setFlow((f) => (f.run ? { ...f, revealed: Math.max(f.revealed, last) } : f));
    setLiveMatch(null);
  };

  const pickTournament = (t: Tournament) => {
    setFlow({ ...emptyFlow, tournament: t });
    setConfigs({});
    setSeed(null);
    setInteractive(false);
    setLiveMatch(null);
    setShareOpen(false);
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
      ready: true,
      start_date: null,
      end_date: null,
      shirt_numbers: run.shirt_numbers,
    };
    setInteractive(false);
    setConfigs({});
    setSeed(run.seed);
    setFlow((f) => ({ ...f, tournament: t, run, revealed: 0 }));
    setStep("overview");
  };

  const reset = () => {
    setFlow(emptyFlow);
    setConfigs({});
    setSeed(null);
    setInteractive(false);
    setLiveMatch(null);
    setShareOpen(false);
    runGuard.current = null;
    setStep("tournament");
  };

  const liveReveal = (m: RunMatch) => {
    setFlow((f) => {
      if (!f.run) return f;
      const idx = f.run.order.indexOf(m.id);
      if (idx < 0 || idx + 1 <= f.revealed) return f;
      return { ...f, revealed: idx + 1 };
    });
  };

  /** Open the run-summary share popup; archive the completed run first. */
  const openShare = () => {
    if (interactive && user && flow.run?.run_id == null) saveRunSilently();
    setShareOpen(true);
  };

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand" onClick={reset}>
          <span className="brand-ball" aria-hidden="true">⚽</span>
          <div>
            <div className="wm-line1">WORLD CUP</div>
            <div className="wm-line2">Simulator</div>
          </div>
        </div>
        <div className="top-actions">
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
          <ChooseTournament
            selected={flow.tournament}
            onPick={pickTournament}
            onHistory={() => setStep("history")}
          />
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
            interactive={interactive}
            onJump={jumpToFocus}
            onAll={revealAll}
            onFF={runFastForward}
            ffRunning={ffRunning}
            scrollToId={scrollToMatch}
            onSimulate={revealUpTo}
            onReplay={replayMatch}
            onOpenDetail={setMatchDetail}
            isConfigured={(m) => !!configs[matchKey(m)]}
            formationMatch={inlineMatch}
            formationInitial={
              inlineMatch ? configs[matchKey(inlineMatch)] : undefined
            }
            onFormationConfirm={applyLineup}
            formationFlash={formationFlash}
            onStart={() => postRun(false, null, configs)}
            onShare={openShare}
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

      {liveMatch && flow.run && (
        <LiveMatch
          match={liveMatch}
          focusTeamId={flow.run.focus_team_id}
          onReveal={liveReveal}
          onFF={ffFromLive}
        />
      )}

      {matchDetail && (
        <MatchDetail
          match={matchDetail}
          focusTeamId={flow.run?.focus_team_id}
          onClose={() => setMatchDetail(null)}
        />
      )}

      {shareOpen && flow.run && (
        <ShareModal
          run={flow.run}
          focusTeam={
            flow.team && flow.team.id === flow.run.focus_team_id
              ? { id: flow.team.id, name: flow.team.name }
              : null
          }
          onClose={() => setShareOpen(false)}
          onPlayAgain={startCup}
        />
      )}
    </div>
  );
}