import { useMemo, useState } from "react";
import { flagFor, useI18n } from "../i18n";
import type { PlayerAward, RunMatch, RunPayload } from "../types";

interface Props {
  run: RunPayload;
  focusTeam: { id: number; name: string } | null;
  onClose: () => void;
  onPlayAgain: () => void;
}

interface PodiumRow {
  medal: string;
  name: string;
  sub: string;
}

const flagName = (n: string) => [flagFor(n), n].filter(Boolean).join(" ");

export default function ShareModal({ run, focusTeam, onClose, onPlayAgain }: Props) {
  const { t, country } = useI18n();
  const [copied, setCopied] = useState(false);

  const { podium, yourPos, best, scorers, assists, title, host } =
    useMemo(() => {
      const finalMatch = run.matches.find((m) => m.stage_key === "F") ?? null;
      const thirdMatch = run.matches.find((m) => m.stage_key === "THIRD") ?? null;
      const winnerOf = (m: RunMatch) =>
        m.penalties
          ? m.penalties.winner_id
          : m.home_score === m.away_score
            ? null
            : m.home_score > m.away_score
              ? m.home_team_id
              : m.away_team_id;

      const champName = run.champion ?? "";
      const runnerUp =
        finalMatch && champName
          ? finalMatch.home_team_name === champName
            ? finalMatch.away_team_name
            : finalMatch.home_team_name
          : null;
      const thirdWinner =
        thirdMatch && winnerOf(thirdMatch) != null
          ? thirdMatch.home_team_id === winnerOf(thirdMatch)
            ? thirdMatch.home_team_name
            : thirdMatch.away_team_name
          : null;
      const thirdLoser =
        thirdMatch && thirdWinner
          ? thirdWinner === thirdMatch.home_team_name
            ? thirdMatch.away_team_name
            : thirdMatch.home_team_name
          : null;

      const podium: PodiumRow[] = [
        { medal: "🥇", name: champName, sub: t("share.pos.1") },
        { medal: "🥈", name: runnerUp ?? "", sub: t("share.pos.2") },
        { medal: "🥉", name: thirdWinner ?? "", sub: t("share.pos.3") },
      ].filter((p) => p.name !== "");

      // Focus team placement when not on the podium.
      let yourPos: string | null = null;
      const focusName = focusTeam?.name;
      if (focusName && focusTeam && !podium.some((p) => p.name === focusName)) {
        const inFinal =
          finalMatch &&
          (finalMatch.home_team_name === focusName ||
            finalMatch.away_team_name === focusName);
        const inThird =
          thirdMatch &&
          (thirdMatch.home_team_name === focusName ||
            thirdMatch.away_team_name === focusName);
        let key: string;
        if (champName === focusName) key = "1";
        else if (inFinal) key = "2";
        else if (inThird) key = thirdLoser === focusName ? "4" : "3";
        else {
          const byId = new Map(run.matches.map((m) => [m.id, m]));
          let last: RunMatch | null = null;
          for (const id of run.order) {
            const m = byId.get(id);
            if (
              m &&
              (m.home_team_name === focusName || m.away_team_name === focusName)
            ) {
              last = m;
            }
          }
          key = last
            ? last.stage_key === "R32"
              ? "1732"
              : last.stage_key === "R16"
                ? "916"
                : last.stage_key === "QF"
                  ? "58"
                  : "group"
            : "group";
        }
        yourPos = t(`share.pos.${key}`);
      }

      const best = [run.awards.golden, run.awards.silver, run.awards.bronze].filter(
        (a): a is PlayerAward => a != null,
      );
      const scorers = [...run.awards.top_scorers]
        .sort((a, b) => b.goals - a.goals || b.assists - a.assists)
        .slice(0, 3);
      const assists = [...run.awards.top_scorers]
        .sort((a, b) => b.assists - a.assists || b.goals - a.goals)
        .slice(0, 3);
      const title = t("share.title", { year: run.year });
      const host = t("share.host", { host: country(run.host ?? "") });

      return { podium, yourPos, best, scorers, assists, title, host };
    }, [run, focusTeam, t, country]);

  const medals = ["🥇", "🥈", "🥉"];

  // Plain-text résumé of the whole run, so the modal can be "shared" without
  // generating an image — copy the summary and paste it anywhere.
  const summaryText = useMemo(() => {
    const lines = [
      `${title} — ${host}`,
      ...podium.map((p) => `${p.medal} ${flagName(p.name)} — ${p.sub}`),
      yourPos ? t("share.yourPos", { pos: yourPos }) : null,
      best.length
        ? `${t("share.bestPlayers")}: ${best.map((a) => flagName(a.name)).join(", ")}`
        : null,
      scorers.length
        ? `${t("share.bestScorer")}: ${scorers
            .map((a) => `${flagName(a.name)} (${a.goals})`)
            .join(", ")}`
        : null,
      assists.length
        ? `${t("share.bestAssists")}: ${assists
            .map((a) => `${flagName(a.name)} (${a.assists})`)
            .join(", ")}`
        : null,
    ];
    return lines.filter(Boolean).join("\n");
  }, [t, title, host, podium, yourPos, best, scorers, assists]);

  const copySummary = async () => {
    try {
      await navigator.clipboard.writeText(summaryText);
    } catch {
      // Clipboard may be unavailable (permissions/context) — still ack.
    }
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="share-modal" onClick={(e) => e.stopPropagation()}>
        <div className="share-head">
          <div>
            <div className="share-title">{title}</div>
            <div className="share-sub">{host}</div>
          </div>
          <button className="live-x" onClick={onClose} title={t("share.close")}>
            ✕
          </button>
        </div>

        <div className="share-body">
          <div className="podium-list">
            {podium.map((p) => (
              <div key={p.medal} className={"podium-row p" + (podium.indexOf(p) + 1)}>
                <span className="podium-medal">{p.medal}</span>
                <span className="podium-name">{flagName(p.name)}</span>
                <span className="podium-sub">{p.sub}</span>
              </div>
            ))}
          </div>

          {yourPos && (
            <div className="your-pos">
              {t("share.yourPos", { pos: yourPos })}
            </div>
          )}

          {best.length > 0 && (
            <div className="share-block">
              <h4>{t("share.bestPlayers")}</h4>
              {best.map((a, i) => (
                <div key={a.player_id || i} className="share-row">
                  <span className="share-medal">{medals[i] ?? "⭐"}</span>
                  <span className="share-name">{flagName(a.name)}</span>
                  <span className="share-detail">{flagName(a.team_name)}</span>
                </div>
              ))}
            </div>
          )}

          {scorers.length > 0 && (
            <div className="share-block">
              <h4>{t("share.bestScorer")}</h4>
              {scorers.map((a) => (
                <div key={a.player_id} className="share-row">
                  <span className="share-medal">⚽</span>
                  <span className="share-name">{flagName(a.name)}</span>
                  <span className="share-detail">{flagName(a.team_name)}</span>
                  <span className="share-num">{a.goals}</span>
                  <span className="share-tag">{t("final.goals")}</span>
                </div>
              ))}
            </div>
          )}

          {assists.length > 0 && (
            <div className="share-block">
              <h4>{t("share.bestAssists")}</h4>
              {assists.map((a) => (
                <div key={a.player_id} className="share-row">
                  <span className="share-medal">🎯</span>
                  <span className="share-name">{flagName(a.name)}</span>
                  <span className="share-detail">{flagName(a.team_name)}</span>
                  <span className="share-num">{a.assists}</span>
                  <span className="share-tag">{t("final.assists")}</span>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="share-actions bar">
          <button className="btn primary big" onClick={copySummary}>
            {copied ? t("share.copied") : t("share.viewSummary")}
          </button>
          <button className="btn big" onClick={onPlayAgain}>
            {t("share.playAgain")}
          </button>
          <button className="btn secondary big" onClick={onClose}>
            {t("share.close")}
          </button>
        </div>
      </div>
    </div>
  );
}