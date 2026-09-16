import { useEffect, useMemo, useState } from "react";
import { useI18n, flagFor } from "../i18n";
import { api } from "../api";
import PlayerCard from "../components/PlayerCard";
import type { Player, RunMatch, RunPayload } from "../types";
import { playerSurname, positionFamily } from "../types";

interface Props {
  run: RunPayload | null;
  revealed: number;
  runError: string | null;
  revealedMatches: RunMatch[];
  maxShownDay: number;
  onJump: () => void;
  onAll: () => void;
  scrollToId?: number | null;
  onSimulate: (idx: number) => void;
  onReplay: (m: RunMatch) => void;
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

export default function Overview({
  run,
  revealed,
  runError,
  revealedMatches,
  maxShownDay,
  onJump,
  onAll,
  scrollToId,
  onSimulate,
  onReplay,
  onStart,
  onShare,
}: Props) {
  const focusId = run?.focus_team_id ?? null;
  const total = run?.matches.length ?? 0;
  const { t, stage, country } = useI18n();

  const [squad, setSquad] = useState<Player[] | null>(null);

  useEffect(() => {
    setSquad(null);
    if (!run) return;
    if (run.focus_team_id != null) {
      api
        .players(run.focus_team_id, run.tournament_id)
        .then(setSquad)
        .catch(() => setSquad([]));
    }
  }, [run]);

  useEffect(() => {
    if (scrollToId == null) return;
    const el = document.querySelector<HTMLDivElement>(
      `.match-row[data-id="${scrollToId}"]`,
    );
    if (el) el.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [scrollToId]);

  const runCodes = useMemo(() => {
    const m = new Map<number, string>();
    for (const g of run?.groups ?? []) {
      for (const t of g.teams) {
        if (t.code) m.set(t.id, t.code);
      }
    }
    return m;
  }, [run]);

  const groups = useMemo(() => {
    const map = new Map<string, Row[]>();
    const letterOf = new Map<number, string>();
    for (const g of run?.groups ?? []) {
      for (const t of g.teams) letterOf.set(t.id, g.name);
    }
    for (const g of run?.groups ?? []) {
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
    for (const m of revealedMatches) {
      if (m.stage_key !== "GROUP") continue;
      const homeA = letterOf.get(m.home_team_id);
      const awayA = letterOf.get(m.away_team_id);
      const letter =
        homeA && awayA === homeA ? homeA : m.stage_name.endsWith(homeA ?? "") ? homeA : awayA;
      const rows = letter ? map.get(letter) : undefined;
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
    return map;
  }, [run, revealedMatches]);

  const scorers = useMemo(() => {
    interface Entry {
      id: number;
      name: string;
      team_id: number;
      team_name: string;
      photo?: string | null;
      goals: number;
    }
    const by = new Map<number, Entry>();
    for (const m of revealedMatches) {
      for (const g of m.goals) {
        const teamName = m.home_team_id === g.team_id ? m.home_team_name : m.away_team_name;
        let e = by.get(g.scorer_id);
        if (!e) {
          e = { id: g.scorer_id, name: g.scorer, team_id: g.team_id, team_name: teamName, photo: g.scorer_photo, goals: 0 };
          by.set(g.scorer_id, e);
        }
        e.goals += 1;
      }
    }
    return [...by.values()]
      .filter((e) => e.goals > 0)
      .sort((a, b) => b.goals - a.goals || a.name.localeCompare(b.name))
      .slice(0, 10);
  }, [revealedMatches]);

  const allRevealed = total > 0 && revealed >= total;
  const champion = run?.champion ?? null;

  const pages = useMemo(() => {
    const out: RunMatch[][] = [];
    for (let i = 0; i < (run?.matches.length ?? 0); i += 20) {
      out.push(run!.matches.slice(i, i + 20));
    }
    return out;
  }, [run]);

  const [page, setPage] = useState(0);
  useEffect(() => setPage(0), [run]);
  const cur = pages[page] ?? [];

  const isMine = (m: RunMatch) => focusId != null && (m.home_team_id === focusId || m.away_team_id === focusId);
  const idxOf = (m: RunMatch) => run!.order.indexOf(m.id);

  const formation = useMemo(() => {
    if (!squad || run == null || run.focus_team_id == null) return null;
    const fam = ["GK", "DF", "MF", "FW"] as const;
    const map = new Map<string, Player[]>();
    for (const f of fam) map.set(f, []);
    for (const p of squad) map.get(positionFamily(p.position))!.push(p);
    return fam
      .filter((f) => map.get(f)!.length > 0)
      .map((f) => ({
        f,
        ps: (map.get(f) ?? [])
          .slice()
          .sort((a, b) => (b.rating ?? b.overall) - (a.rating ?? a.overall)),
      }));
  }, [squad, run]);

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
            {focusId ? t("cup.managing") : t("cup.neutral")}{" "}
            {run ? t("cup.revealed", { day: maxShownDay || 0, revealed, total }) : ""}
          </p>
        </div>
      </div>

      {runError && (
        <div className="empty bar">
          <p className="error">{t("cup.startError", { msg: runError })}</p>
          <button className="btn primary big" onClick={onStart}>{t("cup.retry")}</button>
        </div>
      )}
      {!run && !runError && (
        <div className="bar">
          <p className="hint">{t("cup.startHint")}</p>
          <button className="btn primary big" onClick={onStart}>{t("cup.start")}</button>
        </div>
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
          <div className="cmd-bar bar">
            {!allRevealed && (
              <>
                <button className="btn primary big" onClick={onAll}>{t("cup.playAll")}</button>
                {focusId != null && (
                  <button className="btn big" onClick={onJump}>{t("cup.jump")}</button>
                )}
              </>
            )}
          </div>

          <div className="hub-grid">
            <div className="hub-main">
              {pages.length > 1 && (
                <div className="hub-pager">
                  {pages.map((_, i) => (
                    <button
                      key={i}
                      className={"pg" + (i === page ? " on" : "")}
                      onClick={() => setPage(i)}
                    >
                      {i === 0 ? t("hub.p1") : i === pages.length - 1 ? t("hub.pEnd") : `${i * 20 + 1}–${Math.min((i + 1) * 20, total)}`}
                    </button>
                  ))}
                </div>
              )}

              {cur.length === 0 && <p className="hint">{t("cup.noMatches")}</p>}
              {cur.map((m) => {
                const idx = idxOf(m);
                const done = idx < revealed;
                const next = idx === revealed;
                const mine = isMine(m);
                const locked = idx > revealed;
                return (
                  <div
                    key={m.id}
                    data-id={m.id}
                    className={
                      "match-row" +
                      (done ? " done" : "") +
                      (next ? " next" : "") +
                      (locked ? " locked" : "") +
                      (mine ? " mine" : "") +
                      (m.id === scrollToId ? " ff-target" : "")
                    }
                  >
                    <span className="mr-stage">
                      {stage(m.stage_name)} · {t("match.day", { day: m.day })}
                    </span>
                    <span className={"mr-team home" + (m.home_team_id === focusId ? " focus-tag" : "")}>
                      {flagFor(m.home_team_name)} {country(m.home_team_name)}
                    </span>
                    <span className="mr-score">
                      {done
                        ? `${m.home_score}–${m.away_score}${m.penalties ? ` · ${t("match.pensScore", { home: m.penalties.home_score, away: m.penalties.away_score })}` : ""}`
                        : "–"}
                    </span>
                    <span className={"mr-team away" + (m.away_team_id === focusId ? " focus-tag" : "")}>
                      {flagFor(m.away_team_name)} {country(m.away_team_name)}
                    </span>
                    <span className="mr-action">
                      {next && mine && (
                        <button className="btn play msg" onClick={() => onReplay(m)}>
                          ▶ {t("hub.play")}
                        </button>
                      )}
                      {next && !mine && (
                        <button className="btn sim msg" onClick={() => onSimulate(idx)}>
                          {t("hub.simulate")}
                        </button>
                      )}
                      {done && <span className="mr-done">✓</span>}
                    </span>
                  </div>
                );
              })}
              {pages.length > 1 && (
                <div className="hub-pager">
                  {pages.map((_, i) => (
                    <button
                      key={i}
                      className={"pg" + (i === page ? " on" : "")}
                      onClick={() => setPage(i)}
                    >
                      {i === 0 ? t("hub.p1") : i === pages.length - 1 ? t("hub.pEnd") : `${i * 20 + 1}–${Math.min((i + 1) * 20, total)}`}
                    </button>
                  ))}
                </div>
              )}

              {formation && (
                <div className="form-panel">
                  <h2 className="sec-title">{t("hub.formation")}</h2>
                  {formation.map(({ f, ps }) => (
                    <div key={f} className="pos-block">
                      <h3 className="pos-title">{t(`pos.${f}`)}</h3>
                      <div className="form-list">
                        {ps.map((p, i) => (
                          <PlayerCard
                            key={p.id}
                            player={p}
                            variant="stat"
                            tone={i % 4}
                            sub={p.position}
                            right={playerSurname(p.name)}
                          />
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <aside className="hub-side">
              <div className="group-tables">
                {[...groups.entries()].map(([letter, rows]) => (
                  <div key={letter} className="table-card">
                    <h2 className="table-title">{stage(letter)}</h2>
                    <table className="mini-table">
                      <thead>
                        <tr>
                          <th></th><th className="l">{t("cup.team")}</th>
                          <th>{t("cup.p")}</th><th>{t("cup.w")}</th><th>{t("cup.d")}</th><th>{t("cup.l")}</th>
                          <th>{t("cup.gd")}</th><th>{t("cup.pts")}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {rows.map((r, i) => (
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
                ))}
              </div>

              {scorers.length > 0 && (
                <div className="table-card">
                  <h2 className="table-title">{t("cup.scorers")}</h2>
                  <div className="stat-list">
                    {scorers.map((s, i) => (
                      <PlayerCard
                        key={s.id}
                        player={{ id: s.id, name: s.name, photo_url: s.photo }}
                        variant="stat"
                        tone={s.id % 4}
                        number={i + 1}
                        sub={country(s.team_name)}
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
    </section>
  );
}