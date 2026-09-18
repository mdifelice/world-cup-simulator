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
import { trophyForYear } from "./trophies";
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
  const [draft, setDraft] = useState<LineupConfig | null>(null);
  /** Last committed XI, reused (prefilled) for following matches. */
  const [lastLineup, setLastLineup] = useState<LineupConfig | null>(null);
  const [ffRunning, setFfRunning] = useState(false);
  const ffTimer = useRef<number | null>(null);
  const [shareOpen, setShareOpen] = useState(false);
  const [confirmLeave, setConfirmLeave] = useState(false);
  const [notifications, setNotifications] = useState<Array<{ id: number; message: string; type: "info" | "success" | "warning" }>>([]);
  const notifyId = useRef(0);
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

  // Once every focus match is configured (team eliminated or cup won/lost),
  // keep showing the last formation read-only instead of hiding the panel.
  const focusConfigured =
    focusMatches.length > 0 && focusMatches.every((m) => configs[matchKey(m)]);
  const panelMatch =
    inlineMatch ?? (focusConfigured ? focusMatches[focusMatches.length - 1] ?? null : null);
  const panelDisabled = inlineMatch == null && panelMatch != null;

  // Players banned for the panel's match: for an upcoming match that is the
  // red cards from the team's previous match (a one-match ban).
  const panelUnavailable = (() => {
    if (!panelMatch) return [] as number[];
    if (!inlineMatch) return panelMatch.unavailable ?? [];
    const i = focusMatches.indexOf(panelMatch);
    const prev = i > 0 ? focusMatches[i - 1] : null;
    return (prev?.reds ?? [])
      .filter((r) => r.team_id === focusId)
      .map((r) => r.player_id);
  })();

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

  /** Re-simulate the whole run. Same seed + same lineups → identical results,
   *  so only the newly-configured match changes. Reveals up to (and including)
   *  `target.matchId` only, so playing a match never simulates the ones after. */
  const postRun = (
    save: boolean,
    target: { matchId: number; open: boolean } | null,
    lineups: Record<string, LineupConfig>,
  ) => {
    const id = flow.tournament?.id;
    if (!id) return;
    if (runGuard.current === id) return;
    runGuard.current = id;
    // Keep the previous run (and the scroll position) visible while the
    // deterministic re-sim runs; the result is all but identical, so clearing
    // it would flash the list empty and bounce the scroll back to the top.
    setFlow((f) => ({ ...f, runError: null }));
    api
      .run(id, flow.team?.id ?? null, {
        seed: seed ?? undefined,
        lineups,
        save,
      })
      .then((run) => {
        setSeed(run.seed);
        runGuard.current = null;
        const idx = target ? run.order.indexOf(target.matchId) : -1;
        const revealed = idx >= 0 ? idx + 1 : 0;
        setFlow((f) => ({ ...f, run, revealed, runError: null }));
        if (target?.open) {
          const fm = run.matches.find((m) => m.id === target.matchId);
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

  /** Commit a drafted lineup and re-run the (deterministic) sim so only the
   *  configured match changes, revealing up to that match day; `open` also
   *  opens the live match popup once the run returns. */
  const commitLineup = (cfg: LineupConfig, open: boolean) => {
    if (!flow.run || !inlineMatch) return;
    const key = matchKey(inlineMatch);
    const newConfigs = { ...configs, [key]: cfg };
    setConfigs(newConfigs);
    setLastLineup(cfg);
    setDraft(null);
    const remaining = focusMatches.filter((x) => !newConfigs[matchKey(x)]);
    postRun(remaining.length === 0, { matchId: inlineMatch.id, open }, newConfigs);
  };

  const replayMatch = (m: RunMatch) => {
    stopFF();
    const key = matchKey(m);
    if (!configs[key] && draft && inlineMatch?.id === m.id) {
      commitLineup(draft, true);
      return;
    }
    setScrollToMatch(m.id);
    setLiveMatch(m);
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

  /** Hub fast-forward: simulate match by match (result only, 500ms apart) until
   *  the next focus match is reached so it can be played, or until the end of the
   *  tournament. It keeps going across round boundaries. */
  const runFastForward = () => {
    if (!flow.run || ffRunning) return;
    const run = flow.run;
    const cur = flow.revealed;
    const first = cur < run.order.length ? run.order[cur] : null;
    if (first == null || isFocusMatch(run, first)) return;
    const nextAt = (r: RunPayload, at: number) => {
      const id = r.order[at];
      return id != null ? r.matches.find((m) => m.id === id) ?? null : null;
    };
    setFfRunning(true);
    ffTimer.current = window.setInterval(() => {
      const r = runRef.current;
      const at = revealedRef.current;
      const m = r ? nextAt(r, at) : null;
      if (!r || !m || isFocusMatch(r, m.id)) {
        stopFF();
        return;
      }
      setFlow((f) => (f.run ? { ...f, revealed: f.revealed + 1 } : f));
    }, 500);
  };

  /** The Forward button can act only while the next pending match is not ours. */
  const canFF =
    !!flow.run &&
    flow.revealed < flow.run.order.length &&
    !isFocusMatch(
      flow.run,
      flow.run.order[flow.revealed] ?? -1,
    );

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

  const pickTournament = (t: Tournament) => {
    setFlow({ ...emptyFlow, tournament: t });
    setConfigs({});
    setLastLineup(null);
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
    setLastLineup(null);
    setSeed(null);
    postRun(false, null, {});
    setStep("overview");
  };

  const startNeutral = () => {
    const id = flow.tournament?.id;
    if (!id) return;
    // Explicitly clear team and all related state when starting as spectator
    setFlow((f) => ({ ...f, team: null, focus_team_id: null }));
    setInteractive(true);
    setConfigs({});
    setLastLineup(null);
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
    setLastLineup(null);
    setSeed(run.seed);
    setFlow((f) => ({ ...f, tournament: t, run, revealed: 0 }));
    setStep("overview");
  };

  const reset = () => {
    setFlow(emptyFlow);
    setConfigs({});
    setLastLineup(null);
    setSeed(null);
    setInteractive(false);
    setLiveMatch(null);
    setShareOpen(false);
    runGuard.current = null;
    setStep("tournament");
  };

  /** Logo click: ask before abandoning an in-progress interactive run. */
  const onBrandClick = () => {
    const inProgress =
      interactive && flow.run && flow.revealed < (flow.run.matches.length || 0);
    if (inProgress) setConfirmLeave(true);
    else reset();
  };

  const liveReveal = (m: RunMatch) => {
    const translate = t;
    setFlow((f) => {
      if (!f.run) return f;
      const idx = f.run.order.indexOf(m.id);
      if (idx < 0 || idx + 1 <= f.revealed) return f;
      const newRevealed = idx + 1;
      const run = f.run;
      // Check for round completion or elimination after state updates
      setTimeout(() => {
        checkRoundProgress(run, newRevealed, translate);
      }, 0);
      return { ...f, revealed: newRevealed };
    });
  };

  const checkRoundProgress = (run: RunPayload, newRevealed: number, t: (key: string) => string) => {
    const allMatches = run.matches;
    const revealedIds = new Set(run.order.slice(0, newRevealed));
    const revealedMatches = allMatches.filter((m) => revealedIds.has(m.id));
    const nextMatchIdx = newRevealed < run.order.length ? run.order[newRevealed] : null;
    const nextMatch = nextMatchIdx ? allMatches.find((m) => m.id === nextMatchIdx) : null;
    
    // Check if current stage is complete (all matches in that stage revealed)
    if (nextMatch) {
      const currentStage = revealedMatches.length > 0 ? revealedMatches[revealedMatches.length - 1].stage_key : null;
      const nextStage = nextMatch.stage_key;
      if (currentStage && currentStage !== nextStage) {
        // Stage transition - check if focus team advanced or was eliminated
        const focusId = run.focus_team_id;
        if (focusId != null) {
          // Check if focus team has more matches in the new stage
          const focusMatchesInNewStage = allMatches.filter(
            (m) => m.stage_key === nextStage && (m.home_team_id === focusId || m.away_team_id === focusId)
          );
          if (focusMatchesInNewStage.length === 0) {
            // Focus team has no more matches in this stage - check if they were in previous stage
            const focusMatchesInPrevStage = allMatches.filter(
              (m) => m.stage_key === currentStage && (m.home_team_id === focusId || m.away_team_id === focusId)
            );
            const lostPrevMatch = focusMatchesInPrevStage.some(
              (m) => revealedIds.has(m.id) &&
                ((m.home_team_id === focusId && m.home_score < m.away_score) ||
                 (m.away_team_id === focusId && m.away_score < m.home_score))
            );
            if (lostPrevMatch) {
              addNotification(t("hub.eliminated"), "warning");
            } else {
              addNotification(t("hub.roundPassed"), "success");
            }
          } else if (currentStage !== "GROUP") {
            // Advanced in knockout
            addNotification(t("hub.roundPassed"), "success");
          } else {
            // Group stage passed
            addNotification(t("hub.groupPassed"), "success");
          }
        }
      }
    }};

  const addNotification = (message: string, type: "info" | "success" | "warning" = "info") => {
    setNotifications((prev) => [...prev, { id: ++notifyId.current, message, type }]);
    // Auto-dismiss after 4 seconds
    setTimeout(() => {
      setNotifications((prev) => prev.filter((n) => n.id !== notifyId.current));
    }, 4000);
  };

  const closeLive = () => setLiveMatch(null);

  /** Open the run-summary share popup; archive the completed run first. */
  const openShare = () => {
    if (interactive && user && flow.run?.run_id == null) saveRunSilently();
    setShareOpen(true);
  };

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand" onClick={onBrandClick}>
          <img
            className="brand-ball"
            src={trophyForYear(flow.tournament?.year)}
            alt=""
            aria-hidden="true"
          />
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
            onBack={() => setStep("tournament")}
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
            interactive={interactive}
            onFF={ffRunning ? stopFF : runFastForward}
            ffRunning={ffRunning}
            canFF={canFF}
            scrollToId={scrollToMatch}
            onSimulate={revealUpTo}
            onReplay={replayMatch}
            onOpenDetail={setMatchDetail}
            isConfigured={(m) => !!configs[matchKey(m)]}
            formationMatch={panelMatch}
            formationInitial={
              panelMatch
                ? configs[matchKey(panelMatch)] ?? lastLineup ?? undefined
                : undefined
            }
            formationDisabled={panelDisabled}
            formationUnavailable={panelUnavailable}
            draftReady={inlineMatch ? !configs[matchKey(inlineMatch)] && !!draft : false}
            onDraft={setDraft}
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

      {/* Toast notifications */}
      {notifications.length > 0 && (
        <div className="toast-container" role="region" aria-live="polite">
          {notifications.map((n) => (
            <div key={n.id} className={`toast toast-${n.type}`}>
              {n.message}
            </div>
          ))}
        </div>
      )}

      {liveMatch && flow.run && (
        <LiveMatch
          match={liveMatch}
          focusTeamId={flow.run.focus_team_id}
          onReveal={liveReveal}
          onClose={closeLive}
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
          onPlayAgain={() => {
            setShareOpen(false);
            setStep("tournament");
          }}
        />
      )}

      {confirmLeave && (
        <div className="modal-backdrop" onClick={() => setConfirmLeave(false)}>
          <div className="confirm-modal" onClick={(e) => e.stopPropagation()}>
            <div className="confirm-title">{t("confirm.title")}</div>
            <div className="confirm-body">{t("confirm.body")}</div>
            <div className="confirm-actions">
              <button className="btn secondary" onClick={() => setConfirmLeave(false)}>
                {t("confirm.keep")}
              </button>
              <button
                className="btn danger"
                onClick={() => {
                  setConfirmLeave(false);
                  reset();
                }}
              >
                {t("confirm.leave")}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}