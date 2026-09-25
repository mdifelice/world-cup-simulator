import { Fragment, useEffect, useRef, useState } from "react";
import { useI18n, flagFor } from "../i18n";
import PlayerCard from "../components/PlayerCard";
import FormationPanel from "../components/FormationPanel";
import Bracket from "../components/Bracket";
import { computeOverallStandings, finalPositionOf } from "../sim/standings";
import type { LineupConfig, MatchBan, RunMatch, RunPayload } from "../types";

/** Row used by the "Player Stats" table (engine stats or revealed-match fallback). */
interface Entry {
  id: number;
  name: string;
  team_id: number;
  team_name: string;
  photo?: string | null;
  goals: number;
  assists: number;
  matches: number;
}

interface Props {
  run: RunPayload | null;
  revealedIds: Set<number>;
  runError: string | null;
  revealedMatches: RunMatch[];
  interactive: boolean;
  onFF: () => void;
  ffRunning: boolean;
  canFF: boolean;
  scrollToId?: number | null;
  onSimulate: (m: RunMatch) => void;
  onReplay: (m: RunMatch) => void;
  onOpenDetail: (m: RunMatch) => void;
  isConfigured: (m: RunMatch) => boolean;
  formationMatch: RunMatch | null;
  formationInitial?: LineupConfig;
  /** Read-only formation (team eliminated or cup finished). */
  formationDisabled?: boolean;
  /** Player ids suspended for the formation panel's match. */
  formationUnavailable?: number[];
  /** Match bans with reason and match counts for the formation panel's match. */
  formationBans?: MatchBan[];
  /** True when the inline editor's XI is complete and ready to play. */
  draftReady: boolean;
  onDraft?: (cfg: LineupConfig | null) => void;
  onStart: () => void;
  onShare: () => void;
}

interface Row {
  id: number;
  name: string;
  p: number;
  w: number;
  d: number;
  l: number;
  gf: number;
  ga: number;
  gd: number;
  pts: number;
}

const initials = (name: string) =>
  (name.split(/\s+/).map((w) => w[0]).join("") || name).slice(0, 3).toUpperCase();

const codeOf = (map: Map<number, string>, id: number, name: string) =>
  map.get(id) ?? initials(name);

/** "1930-07-13" or "2026-06-24T19:00" → "13/07" (let the user hover for the year). */
const shortDate = (iso: string): string => {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) return iso;
  return `${m[3]}/${m[2]}`;
};

export default function Overview({
  run,
  revealedIds,
  runError,
  revealedMatches,
  interactive,
  onFF,
  ffRunning,
  canFF,
  scrollToId,
  onSimulate,
  onReplay,
  onOpenDetail,
  isConfigured,
  formationMatch,
  formationInitial,
  formationDisabled = false,
  formationUnavailable,
  formationBans,
  draftReady,
  onDraft,
  onStart,
  onShare,
}: Props) {
  const focusId = run?.focus_team_id ?? null;
  const total = run?.matches.length ?? 0;
  const { t, stage, country } = useI18n();
  const [bracketOpen, setBracketOpen] = useState(false);
  const [scorersOpen, setScorersOpen] = useState(false);
  const [standingsOpen, setStandingsOpen] = useState(false);
  const [countryFilter, setCountryFilter] = useState("");

  // Scroll a row into view inside the matches list only, never the page.
  const matchScrollRef = useRef<HTMLDivElement>(null);
  const scrollRowIntoView = (row: HTMLElement | null, behavior: ScrollBehavior) => {
    const el = matchScrollRef.current;
    if (!el || !row) return;
    const delta =
      row.getBoundingClientRect().top - el.getBoundingClientRect().top;
    if (delta < 0 || delta + row.offsetHeight > el.clientHeight) {
      el.scrollTo({ top: el.scrollTop + delta - 8, behavior });
    }
  };

  useEffect(() => {
    if (scrollToId == null) return;
    const row = matchScrollRef.current?.querySelector<HTMLElement>(
      `.match-row[data-id="${scrollToId}"]`,
    );
    scrollRowIntoView(row ?? null, "smooth");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scrollToId]);

  // While fast-forwarding, keep the current match in view (list only).
  useEffect(() => {
    if (revealedIds.size <= 0) return;
    const row = matchScrollRef.current?.querySelector<HTMLElement>(".match-row.next");
    scrollRowIntoView(row ?? null, "smooth");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [revealedIds.size]);

  const runCodes = new Map<number, string>();
  for (const g of run?.groups ?? []) {
    for (const t of g.teams) {
      if (t.code) runCodes.set(t.id, t.code);
    }
  }

  const revealedMatchIds = new Set(revealedMatches.map((m) => m.id));
  // The bracket appears once the knockout stage starts; unplayed rounds show as
  // TBD placeholders until their results are revealed.
  const hasKnockout = run?.matches.some((m) =>
    ["R32", "R16", "QF", "SF", "F", "THIRD"].includes(m.stage_key),
  ) ?? false;

  /** Overall multi-phase standings with the final position of the focus team
   *  (only meaningful once the team is out / the cup is decided). */
  const overallStandings = run ? computeOverallStandings(run, revealedIds) : [];
  const focusFinalPosition =
    focusId != null && run ? finalPositionOf(run, revealedIds, focusId) : null;

  /** Standings for a group/league phase: members come from the seeded groups
   *  when available, otherwise from the phase's own fixtures (union-find). */
  const groupTables = (
    stageKey: string,
    stageName: string,
    all: RunMatch[],
    revealed: RunMatch[],
  ) => {
    let members: { name: string; teams: { id: number; name: string }[] }[];
    if (stageKey === "GROUP" && (run?.groups?.length ?? 0) > 0) {
      members = run!.groups.map((g) => ({
        name: g.name,
        teams: g.teams.map((t) => ({ id: t.id, name: t.name })),
      }));
    } else {
      const parent = new Map<number, number>();
      const find = (x: number): number => {
        while (parent.get(x) !== x) {
          parent.set(x, parent.get(parent.get(x)!)!);
          x = parent.get(x)!;
        }
        return x;
      };
      const nameOf = new Map<number, string>();
      for (const m of all) {
        nameOf.set(m.home_team_id, m.home_team_name);
        nameOf.set(m.away_team_id, m.away_team_name);
        for (const id of [m.home_team_id, m.away_team_id]) if (!parent.has(id)) parent.set(id, id);
        const a = find(m.home_team_id);
        const b = find(m.away_team_id);
        if (a !== b) parent.set(a, b);
      }
      const comps = new Map<number, { id: number; name: string }[]>();
      for (const id of parent.keys()) {
        const root = find(id);
        if (!comps.has(root)) comps.set(root, []);
        comps.get(root)!.push({ id, name: nameOf.get(id) ?? "" });
      }
      const letters = "ABCDEFGHIJKL";
      const list = [...comps.values()];
      members = list.map((teams, i) => ({
        name: list.length === 1 ? stageName : `Group ${letters[i] ?? i + 1}`,
        teams,
      }));
    }

    const map = new Map<string, Row[]>();
    const letterOf = new Map<number, string>();
    for (const g of members) {
      for (const t of g.teams) letterOf.set(t.id, g.name);
      map.set(
        g.name,
        g.teams.map((t) => ({
          id: t.id,
          name: t.name,
          p: 0,
          w: 0,
          d: 0,
          l: 0,
          gf: 0,
          ga: 0,
          gd: 0,
          pts: 0,
        })),
      );
    }
    for (const m of revealed) {
      if (m.stage_key !== stageKey) continue;
      const rows = map.get(letterOf.get(m.home_team_id) ?? "");
      if (!rows) continue;
      const h = rows.find((r) => r.id === m.home_team_id);
      const a = rows.find((r) => r.id === m.away_team_id);
      if (!h || !a) continue;
      h.p += 1;
      a.p += 1;
      h.gf += m.home_score;
      h.ga += m.away_score;
      a.gf += m.away_score;
      a.ga += m.home_score;
      if (m.home_score > m.away_score) {
        h.w += 1;
        a.l += 1;
        h.pts += 3;
      } else if (m.home_score < m.away_score) {
        a.w += 1;
        h.l += 1;
        a.pts += 3;
      } else {
        h.d += 1;
        a.d += 1;
        h.pts += 1;
        a.pts += 1;
      }
    }
    for (const rows of map.values()) {
      for (const r of rows) r.gd = r.gf - r.ga;
      rows.sort(
        (x, y) => y.pts - x.pts || y.gd - x.gd || y.gf - x.gf || x.name.localeCompare(y.name),
      );
    }
    return members.map((g) => ({ name: g.name, rows: map.get(g.name) ?? [] }));
  };

  /** One card per phase that has started, newest first. Group/league phases
   *  show their tables, knockout phases show the bracket for that round. */
  const phases = (() => {
    if (!run) return [] as {
      key: string;
      name: string;
      groupType: boolean;
      lastDay: number;
      tables: { name: string; rows: Row[] }[];
      ties: { m: RunMatch; played: boolean }[];
    }[];
    const byId = new Map(run.matches.map((m) => [m.id, m]));
    const order: RunMatch[] = [];
    for (const id of run.order) {
      const m = byId.get(id);
      if (m) order.push(m);
    }
    const map = new Map<string, { name: string; lastDay: number; matches: RunMatch[] }>();
    for (const m of order) {
      let p = map.get(m.stage_key);
      if (!p) {
        p = { name: m.stage_name, lastDay: m.day, matches: [] };
        map.set(m.stage_key, p);
      }
      p.matches.push(m);
      p.lastDay = Math.max(p.lastDay, m.day);
    }
    const out = [];
    const firstKey = order[0]?.stage_key;
    for (const [key, p] of map.entries()) {
      const revealed = p.matches.filter((m) => revealedMatchIds.has(m.id));
      const groupType = key === "GROUP" || key === "FINAL";
      // Show the opening group stage from kickoff (all-zero tables); every
      // later phase only once its first match has been played.
      if (revealed.length === 0 && !(key === firstKey && groupType)) continue;
      out.push({
        key,
        name: p.name,
        groupType,
        lastDay: p.lastDay,
        tables: groupType ? groupTables(key, p.name, p.matches, revealed) : [],
        ties: groupType
          ? []
          : [...p.matches]
              .sort((a, b) => b.day - a.day || b.id - a.id)
              .map((m) => ({ m, played: revealedMatchIds.has(m.id) })),
      });
    }
    out.sort((a, b) => b.lastDay - a.lastDay);
    return out;
  })();

  // Right-sidebar autoscroll: on the first paint reveal the focus team's group;
  // when a brand-new round appears, jump back to the top.
  const groupScrollRef = useRef<HTMLDivElement>(null);
  const phaseCountRef = useRef(0);
  useEffect(() => {
    const el = groupScrollRef.current;
    if (!el) return;
    if (phases.length > phaseCountRef.current) {
      if (phaseCountRef.current === 0 && focusId != null) {
        const target = el.querySelector<HTMLElement>(".focus-row");
        if (target) {
          const top =
            target.getBoundingClientRect().top -
            el.getBoundingClientRect().top +
            el.scrollTop;
          el.scrollTo({ top: Math.max(0, top - 12), behavior: "auto" });
          phaseCountRef.current = phases.length;
          return;
        }
      }
      el.scrollTo({ top: 0, behavior: "smooth" });
    }
    phaseCountRef.current = phases.length;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phases.length, focusId]);

  /** Full scorer table (up to 50) from completed matches, with assists and own
 *  goals ignored. Assists are credited from the goal assist field so every one
 *  of a scorer's teammates' assists shows on them. */
  const goalScorersAll = (() => {
    const by = new Map<number, Entry>();
    // Only use completed matches (revealedMatches) so the table is empty
    // before any game is played, matching the share dialog behavior.
    for (const m of revealedMatches) {
      const scorerIdsInMatch = new Set<number>();
      for (const g of m.goals) {
        if (g.own_goal) continue;
        const teamName = m.home_team_id === g.team_id ? m.home_team_name : m.away_team_name;
        let e = by.get(g.scorer_id);
        if (!e) {
          e = {
            id: g.scorer_id,
            name: g.scorer,
            team_id: g.team_id,
            team_name: teamName,
            photo: g.scorer_photo,
            goals: 0,
            assists: 0,
            matches: 0,
          };
          by.set(g.scorer_id, e);
        }
        e.goals += 1;
        scorerIdsInMatch.add(g.scorer_id);
        if (g.assist_id != null && g.assist_id !== g.scorer_id) {
          let a = by.get(g.assist_id);
          if (!a) {
            a = {
              id: g.assist_id,
              name: g.assist ?? "",
              team_id: g.team_id,
              team_name: teamName,
              photo: g.assist_photo,
              goals: 0,
              assists: 0,
              matches: 0,
            };
            by.set(g.assist_id, a);
          }
          a.assists += 1;
          scorerIdsInMatch.add(g.assist_id);
        }
      }
      // Increment matches played for each player who scored or assisted in this match
      for (const id of scorerIdsInMatch) {
        const e = by.get(id);
        if (e) e.matches += 1;
      }
    }
    return [...by.values()]
      .sort((a, b) => b.goals - a.goals || b.assists - a.assists || a.name.localeCompare(b.name))
      .map((e) => e);
  })();
  // Prefer the engine's authoritative per-player stats once the whole cup is
  // revealed: every player who took the field appears (even with no goals) and
  // "matches" is actual games played. Until then, only count completed
  // (revealed) matches so the table grows with the reveal, never ahead of it.
  const fullyRevealed = total > 0 && revealedIds.size >= total;
  const scorersAll: Entry[] =
    fullyRevealed && run?.player_stats?.length
      ? run.player_stats.map((s) => ({
          id: s.player_id,
          name: s.name,
          team_id: s.team_id,
          team_name: s.team_name,
          photo: s.photo,
          goals: s.goals,
          assists: s.assists,
          matches: s.games,
        }))
      : goalScorersAll;
  // Sidebar keeps the classic top-10 scorers table.
  const scorers = scorersAll.filter((s) => s.goals > 0).slice(0, 10);

  const matchRatings = run?.ratings ?? {};

  type SortKey = "rank" | "name" | "goals" | "assists" | "rating" | "matches" | "photo";
  const [sortKey, setSortKey] = useState<SortKey>("goals");
  const [sortDesc, setSortDesc] = useState(true);

  const filteredScorers =
    countryFilter === ""
      ? scorersAll
      : scorersAll.filter((s) => s.team_name === countryFilter);

  const sortScorers = (arr: typeof filteredScorers) => {
    return [...arr].sort((a, b) => {
      let va: number | string, vb: number | string;
      if (sortKey === "goals") { va = a.goals; vb = b.goals; }
      else if (sortKey === "assists") { va = a.assists; vb = b.assists; }
      else if (sortKey === "rating") { va = matchRatings[a.id] ?? 0; vb = matchRatings[b.id] ?? 0; }
      else if (sortKey === "matches") { va = a.matches; vb = b.matches; }
      else if (sortKey === "rank") { va = 0; vb = 0; } // rank is just display order
      else if (sortKey === "photo") { va = a.photo ? 1 : 0; vb = b.photo ? 1 : 0; } // photo presence
      else { va = a.name; vb = b.name; } // name
      if (va !== vb) {
        if (typeof va === "number") return sortDesc ? (vb as number) - (va as number) : (va as number) - (vb as number);
        return sortDesc ? (vb as string).localeCompare(va as string) : (va as string).localeCompare(vb as string);
      }
      return a.name.localeCompare(b.name);
    });
  };

  const sortedScorers = sortScorers(filteredScorers).slice(0, 50);
  const scorerCountries = [...new Set(scorersAll.map((s) => s.team_name))].sort(
    (a, b) => a.localeCompare(b),
  );

  const allRevealed = fullyRevealed;
  const champion = run?.champion ?? null;

  const isMine = (m: RunMatch) => focusId != null && (m.home_team_id === focusId || m.away_team_id === focusId);

  const firstUnrevealed = (r: RunPayload, shown: Set<number>) =>
    r.matches.find((m) => !shown.has(m.id)) ?? null;

  // While a round is in progress only that round is shown; matches from later
  // rounds (the next matchday / knockout round) stay hidden until the current
  // one is fully revealed. All matches of a round share the same `day`.
  const currentDay = (() => {
    if (!run) return null;
    return firstUnrevealed(run, revealedIds)?.day ?? null;
  })();
  const nextMatch = run ? firstUnrevealed(run, revealedIds) : null;

  return (
    <section>
      <div className="page-head">
        <div>
          <h1>
            {run
              ? t("cup.title", { year: run.year, host: run.host ?? "" })
              : t("step.tournament")}
          </h1>
          <p className="hint">
            {focusId ? t("cup.managing") : t("cup.neutral")}
          </p>
        </div>
        {run && !allRevealed && (
          <div className="top-actions cmd">
            <button
              className={"btn big" + (ffRunning ? " ff-on" : "")}
              onClick={onFF}
              disabled={!ffRunning && !canFF}
              title={ffRunning ? t("hub.ffStop") : t("hub.ff")}
            >
              {ffRunning ? t("hub.ffStop") : t("hub.ff")}
            </button>
          </div>
        )}
      </div>

      {runError && (
        <div className="empty bar">
          <p className="error">{t("cup.startError", { msg: runError })}</p>
          <button className="btn primary big" onClick={onStart}>{t("cup.retry")}</button>
        </div>
      )}
      {!run && !runError && !interactive && (
        <div className="bar">
          <p className="hint">{t("cup.startHint")}</p>
          <button className="btn primary big" onClick={onStart}>{t("cup.start")}</button>
        </div>
      )}
      {!run && !runError && interactive && (
        <p className="hint">{t("squad.loading")}</p>
      )}

      {allRevealed && champion && (
        <div className="champ-card">
          <span className="champ-cup">{flagFor(champion)}</span>
          <div className="champ-text">
            <strong>{t("hub.championTitle", { team: country(champion) })}</strong>
            <span>{t("hub.championSub")}</span>
          </div>
          <button className="btn primary big" onClick={onShare}>{t("hub.championShare")}</button>
        </div>
      )}

      {run && (
        <>
          <div className="hub-grid">
            <div className="hub-main">
              <div className="match-scroll" ref={matchScrollRef}>
                {run.matches.length === 0 && <p className="hint">{t("cup.noMatches")}</p>}
                {run.matches
                  .filter(
                    (m) =>
                      currentDay == null ||
                      m.day <= currentDay ||
                      m.stage_key === "GROUP",
                  )
                  .slice()
                  .sort((a, b) => (a.date ?? "").localeCompare(b.date ?? "") || a.id - b.id)
                  .map((m) => {
                  const done = revealedIds.has(m.id);
                  const isNext = m.id === nextMatch?.id;
                  const mine = isMine(m);
                  // Play button only enabled if all previous matches in chronological order are done
                  const idx = run.order.indexOf(m.id);
                  const allPreviousDone = run.order.slice(0, idx).every((id) => revealedIds.has(id));
                  return (
                    <div
                      key={m.id}
                      data-id={m.id}
                      className={
                        "match-row" +
                        (done ? " done" : "") +
                        (isNext ? " next" : "") +
                        (mine ? " mine" : "") +
                        (m.id === scrollToId ? " ff-target" : "")
                      }
                      onClick={done ? () => onOpenDetail(m) : undefined}
                      title={done ? t("hub.viewResult") : undefined}
                      role={done ? "button" : undefined}
                    >
                      <span className="mr-round">
                        <span className="mr-stage">{stage(m.stage_name)}</span>
                        {m.date && <span className="mr-date">{shortDate(m.date)}</span>}
                      </span>
                      <span className={"mr-team home" + (m.home_team_id === focusId ? " focus-tag" : "")}>
                        {flagFor(m.home_team_name)} {country(m.home_team_name)}
                      </span>
                      <span className="mr-score">
                        {done ? (
                          <>
                            <span className="mr-score-main">
                              {m.home_score}–{m.away_score}
                              {(m.reds?.length ?? 0) > 0 && (
                                <span className="red-card tiny" aria-hidden />
                              )}
                            </span>
                            {m.penalties && (
                              <span className="pens">
                                {t("match.pensScore", {
                                  home: m.penalties.home_score,
                                  away: m.penalties.away_score,
                                })}
                              </span>
                            )}
                          </>
                        ) : (
                          "–"
                        )}
                      </span>
                      <span className={"mr-team away" + (m.away_team_id === focusId ? " focus-tag" : "")}>
                        {flagFor(m.away_team_name)} {country(m.away_team_name)}
                      </span>
                      <span className="mr-action">
                        {!done && mine && interactive && allPreviousDone && (
                          <button
                            className="btn play msg"
                            onClick={(e) => {
                              e.stopPropagation();
                              onReplay(m);
                            }}
                            disabled={
                              !isConfigured(m) &&
                              !(formationMatch?.id === m.id && draftReady)
                            }
                            title={
                              isConfigured(m) ||
                              (formationMatch?.id === m.id && draftReady)
                                ? undefined
                                : t("hub.playDisabled")
                            }
                          >
                            ▶ {t("hub.play")}
                          </button>
                        )}
                        {!done && !mine && allPreviousDone && (
                          <button className="btn sim msg" onClick={() => onSimulate(m)}>
                            {t("hub.simulate")}
                          </button>
                        )}
                        {done && <span className="mr-done">✓</span>}
                      </span>
                    </div>
                  );
                })}
              </div>

              {interactive && focusId != null && formationMatch && run && (
                <div>
                  <FormationPanel
                    key={formationMatch.id}
                    tournamentId={run.tournament_id}
                    teamId={focusId}
                    teamName={
                      formationMatch.home_team_id === focusId
                        ? formationMatch.home_team_name
                        : formationMatch.away_team_name
                    }
                    match={formationMatch}
                    shirtNumbers={run.shirt_numbers}
                    initial={formationInitial}
                    year={run.year}
                    disabled={formationDisabled}
                    unavailable={formationUnavailable}
                    bans={formationBans}
                    onReady={onDraft}
                    finalPosition={formationDisabled ? focusFinalPosition : null}
                  />
                </div>
              )}
            </div>

            <aside className="hub-side">
              <div className="group-scroll" ref={groupScrollRef}>
                {run && hasKnockout && (
                  <div className="table-card">
                    <h2
                      className="table-title t-click"
                      role="button"
                      tabIndex={0}
                      onClick={() => setBracketOpen(true)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          setBracketOpen(true);
                        }
                      }}
                      title={t("cup.expand")}
                    >
                      {t("cup.bracket")} <span className="t-expand" aria-hidden>⤢</span>
                    </h2>
                    <Bracket
                      matches={run.matches}
                      order={run.order}
                      revealedIds={revealedIds}
                      focusId={focusId}
                      codes={runCodes}
                      onOpen={onOpenDetail}
                    />
                  </div>
                )}
                {phases
                  .filter((p) => p.groupType)
                  .flatMap((p) =>
                    p.tables.map((tb) => (
                      <div key={p.key + tb.name} className="table-card">
                        <h2
                          className="table-title t-click"
                          role="button"
                          tabIndex={0}
                          onClick={() => setStandingsOpen(true)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter" || e.key === " ") {
                              e.preventDefault();
                              setStandingsOpen(true);
                            }
                          }}
                          title={t("cup.expand")}
                        >
                          {stage(tb.name)} <span className="t-expand" aria-hidden>⤢</span>
                        </h2>
                        <table className="mini-table">
                          <thead>
                            <tr>
                              <th></th><th className="l">{t("cup.team")}</th>
                              <th>{t("cup.p")}</th><th>{t("cup.w")}</th><th>{t("cup.d")}</th><th>{t("cup.l")}</th>
                              <th>{t("cup.gd")}</th><th>{t("cup.pts")}</th>
                            </tr>
                          </thead>
                          <tbody>
                            {tb.rows.map((r, i) => (
                              <tr key={r.id} className={focusId === r.id ? "focus-row" : ""}>
                                <td className="num">{i + 1}</td>
                                <td className="l team-cell">
                                  <span className="code-cell">
                                    {flagFor(r.name)} {codeOf(runCodes, r.id, r.name)}
                                  </span>
                                </td>
                                <td className="num">{r.p}</td>
                                <td className="num">{r.w}</td>
                                <td className="num">{r.d}</td>
                                <td className="num">{r.l}</td>
                                <td className="num">{r.gd > 0 ? `+${r.gd}` : r.gd}</td>
                                <td className="num strong">{r.pts}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )),
                  )}
              </div>

              {scorers.length > 0 && (
                <div className="table-card">
                  <h2
                    className="table-title t-click"
                    role="button"
                    tabIndex={0}
                    onClick={() => setScorersOpen(true)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        setScorersOpen(true);
                      }
                    }}
                    title={t("cup.expand")}
                  >
                    {t("cup.scorers")} <span className="t-expand" aria-hidden>⤢</span>
                  </h2>
                  <div className="stat-list">
                    {scorers.map((s, i) => (
                      <PlayerCard
                        key={s.id}
                        player={{ id: s.id, name: s.name, photo_url: s.photo }}
                        variant="stat"
                        tone={s.id % 4}
                        number={i + 1}
                        sub={flagFor(s.team_name)}
                        right={`${s.goals}`}
                      />
                    ))}
                  </div>
                </div>
              )}
            </aside>
          </div>
        </>
      )}

      {bracketOpen && run && hasKnockout && (
        <div className="modal-backdrop" onClick={() => setBracketOpen(false)}>
          <div className="share-modal bracket-modal" onClick={(e) => e.stopPropagation()}>
            <div className="share-head">
              <div className="share-title">{t("cup.bracket")}</div>
              <button
                className="live-x"
                onClick={() => setBracketOpen(false)}
                aria-label={t("match.close")}
                title={t("match.close")}
              >
                ✕
              </button>
            </div>
            <div className="bracket-modal-scroll">
              <Bracket
                matches={run.matches}
                order={run.order}
                revealedIds={revealedIds}
                focusId={focusId}
                codes={runCodes}
                onOpen={(m) => {
                  onOpenDetail(m);
                }}
                scale={1.5}
                className="bk-lg"
                fullName
              />
            </div>
          </div>
        </div>
      )}

      {scorersOpen && scorersAll.length > 0 && (
        <div className="modal-backdrop" onClick={() => setScorersOpen(false)}>
          <div className="share-modal scorers-modal" onClick={(e) => e.stopPropagation()}>
            <div className="share-head">
              <div className="share-title">{t("cup.playerStats")}</div>
              <button
                className="live-x"
                onClick={() => setScorersOpen(false)}
                aria-label={t("match.close")}
                title={t("match.close")}
              >
                ✕
              </button>
            </div>
            <div className="scorers-toolbar">
              <select
                className="scorers-filter"
                value={countryFilter}
                onChange={(e) => setCountryFilter(e.target.value)}
                aria-label={t("cup.scorersAll")}
              >
                <option value="">{t("cup.scorersAll")}</option>
                {scorerCountries.map((c) => (
                  <option key={c} value={c}>
                    {flagFor(c)} {country(c)}
                  </option>
                ))}
              </select>
            </div>
            <div className="scorers-table">
              <div className="scorers-header">
                <span
                  className={`scorers-col scorers-col-rank ${sortKey === "rank" ? "active" : ""}`}
                  onClick={() => { if (sortKey === "rank") setSortDesc(!sortDesc); else { setSortKey("rank"); setSortDesc(true); } }}
                  title={t("cup.sort")}
                >
                  #{sortKey === "rank" && (sortDesc ? " ▼" : " ▲")}
                </span>
                <span
                  className={`scorers-col scorers-col-photo ${sortKey === "photo" ? "active" : ""}`}
                  onClick={() => { if (sortKey === "photo") setSortDesc(!sortDesc); else { setSortKey("photo"); setSortDesc(true); } }}
                  title={t("cup.sort")}
                >
                  {sortKey === "photo" && (sortDesc ? " ▼" : " ▲")}
                </span>
                <span
                  className={`scorers-col scorers-col-name ${sortKey === "name" ? "active" : ""}`}
                  onClick={() => { if (sortKey === "name") setSortDesc(!sortDesc); else { setSortKey("name"); setSortDesc(true); } }}
                  title={t("cup.sort")}
                >
                  {t("cup.player")}
                  {sortKey === "name" && (sortDesc ? " ▼" : " ▲")}
                </span>
                <span
                  className={`scorers-col scorers-col-goals ${sortKey === "goals" ? "active" : ""}`}
                  onClick={() => { if (sortKey === "goals") setSortDesc(!sortDesc); else { setSortKey("goals"); setSortDesc(true); } }}
                  title={t("cup.sort")}
                >
                  {t("cup.goals")}
                  {sortKey === "goals" && (sortDesc ? " ▼" : " ▲")}
                </span>
                <span
                  className={`scorers-col scorers-col-assists ${sortKey === "assists" ? "active" : ""}`}
                  onClick={() => { if (sortKey === "assists") setSortDesc(!sortDesc); else { setSortKey("assists"); setSortDesc(true); } }}
                  title={t("cup.sort")}
                >
                  {t("cup.assists")}
                  {sortKey === "assists" && (sortDesc ? " ▼" : " ▲")}
                </span>
                <span
                  className={`scorers-col scorers-col-rating ${sortKey === "rating" ? "active" : ""}`}
                  onClick={() => { if (sortKey === "rating") setSortDesc(!sortDesc); else { setSortKey("rating"); setSortDesc(true); } }}
                  title={t("cup.ratingHint")}
                >
                  {t("cup.rating")}
                  {sortKey === "rating" && (sortDesc ? " ▼" : " ▲")}
                </span>
                <span
                  className={`scorers-col scorers-col-matches ${sortKey === "matches" ? "active" : ""}`}
                  onClick={() => { if (sortKey === "matches") setSortDesc(!sortDesc); else { setSortKey("matches"); setSortDesc(true); } }}
                  title={t("cup.sort")}
                >
                  {t("cup.matches")}
                  {sortKey === "matches" && (sortDesc ? " ▼" : " ▲")}
                </span>
              </div>
              <div className="scorers-scroll">
                {sortedScorers.map((s, i) => (
                  <div key={s.id} className="scorers-row" style={{ minHeight: "52px" }}>
                    <span className="scorers-rank">{i + 1}</span>
                    <span className="scorers-photo">
                      {s.photo ? (
                        <img src={s.photo} alt="" onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = "none"; }} />
                      ) : (
                        <svg viewBox="0 0 24 24" width="34" height="34" aria-hidden="true">
                          <circle cx="12" cy="8" r="4.5" fill="currentColor" opacity="0.85" />
                          <path d="M3.5 20.5c1.4-4.2 4.6-6 8.5-6s7.1 1.8 8.5 6" fill="currentColor" opacity="0.85" />
                        </svg>
                      )}
                    </span>
                    <span className="scorers-name">
                      <span className="scorers-surname">{s.name}</span>
                      <span className="scorers-sub">{flagFor(s.team_name)}</span>
                    </span>
                    <span className="scorers-cell">{s.goals}</span>
                    <span className="scorers-cell">{s.assists}</span>
                    <span className="scorers-cell scorers-rating">
                      {(matchRatings[s.id] ?? 0).toFixed(1)}
                    </span>
                    <span className="scorers-cell">{s.matches}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}
    {standingsOpen && run && (
        <div className="modal-backdrop" onClick={() => setStandingsOpen(false)}>
          <div className="share-modal standings-modal" onClick={(e) => e.stopPropagation()}>
            <div className="share-head">
              <div className="share-title">{t("cup.standings")}</div>
              <button
                className="live-x"
                onClick={() => setStandingsOpen(false)}
                aria-label={t("match.close")}
                title={t("match.close")}
              >
                ✕
              </button>
            </div>
            <div className="standings-scroll">
              <table className="mini-table standings-table">
                <thead>
                  <tr>
                    <th></th><th className="l">{t("cup.team")}</th>
                    <th>{t("cup.p")}</th><th>{t("cup.w")}</th><th>{t("cup.d")}</th><th>{t("cup.l")}</th>
                    <th>{t("cup.gd")}</th><th>{t("cup.pts")}</th>
                  </tr>
                </thead>
                <tbody>
                  {overallStandings.map((r, i) => {
                    const bucketLabel =
                      r.bucketLabel === "alive"
                        ? t("hub.alive")
                        : r.bucketLabel === "group"
                          ? t("cup.stageGroup")
                          : r.bucketLabel === "champ"
                            ? t("share.pos.1")
                            : r.bucketLabel === "runnerup"
                              ? t("share.pos.2")
                              : r.bucketLabel === "third"
                                ? t("share.pos.3")
                                : r.bucketLabel === "fourth"
                                  ? t("share.pos.4")
                                  : r.reachedName
                                    ? stage(r.reachedName)
                                    : t("stage.group");
                    const newBucket = i === 0 || overallStandings[i - 1].bucket !== r.bucket;
                    return (
                      <Fragment key={r.id}>
                        {newBucket && (
                          <tr className="standings-bucket">
                            <td colSpan={8}>{bucketLabel}</td>
                          </tr>
                        )}
                        <tr className={focusId === r.id ? "focus-row" : ""}>
                          <td className="num">{i + 1}</td>
                          <td className="l team-cell">
                            <span className="code-cell">
                              {flagFor(r.name)} {country(r.name)}
                            </span>
                          </td>
                          <td className="num">{r.p}</td>
                          <td className="num">{r.w}</td>
                          <td className="num">{r.d}</td>
                          <td className="num">{r.l}</td>
                          <td className="num">{r.gd > 0 ? `+${r.gd}` : r.gd}</td>
                          <td className="num strong">{r.pts}</td>
                        </tr>
                      </Fragment>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}