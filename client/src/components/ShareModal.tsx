import { useMemo, useRef, useState } from "react";
import { toPng } from "html-to-image";
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

const flagName = (country: (s: string) => string, n: string) =>
  [flagFor(n), country(n)].filter(Boolean).join(" ");

export default function ShareModal({ run, focusTeam, onClose, onPlayAgain }: Props) {
  const { t, country } = useI18n();
  const [sharing, setSharing] = useState(false);
  const captureRef = useRef<HTMLDivElement>(null);

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

  /** Render the summary as a PNG and share it (image only); fall back to
   *  downloading the image. */
  const share = async () => {
    const node = captureRef.current;
    if (!node || sharing) return;
    setSharing(true);
    try {
      const pad = 28;
      const w = node.offsetWidth;
      const h = node.offsetHeight;
      const dataUrl = await toPng(node, {
        pixelRatio: 2,
        cacheBust: true,
        backgroundColor: "#ffffff",
        // Grow the canvas by the padding so the bottom/right margin is not cut.
        width: w + pad * 2,
        height: h + pad * 2,
        style: {
          padding: `${pad}px`,
          background: "#ffffff",
          width: `${w + pad * 2}px`,
          boxSizing: "border-box",
        },
      });
      const blob = await (await fetch(dataUrl)).blob();
      const file = new File([blob], `world-cup-${run.year}.png`, {
        type: "image/png",
      });
      const nav = navigator as Navigator & {
        canShare?: (data: ShareData) => boolean;
      };
      if (nav.share && nav.canShare?.({ files: [file] })) {
        await nav.share({ files: [file] });
      } else {
        const a = document.createElement("a");
        a.href = dataUrl;
        a.download = `world-cup-${run.year}.png`;
        a.click();
      }
    } catch {
      // Image generation failed — nothing else to do.
    } finally {
      setSharing(false);
    }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="share-modal" onClick={(e) => e.stopPropagation()}>
        <div className="share-scroll">
        <div className="share-capture" ref={captureRef}>
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
                <span className="podium-name">{flagName(country, p.name)}</span>
                <span className="podium-sub">{p.sub}</span>
              </div>
            ))}
          </div>

          {yourPos && focusTeam && (
            <div className="your-pos">
              {t("share.yourPos", {
                team: flagName(country, focusTeam.name),
                pos: yourPos,
              })}
            </div>
          )}

          {best.length > 0 && (
            <div className="share-block">
              <h4>{t("share.bestPlayers")}</h4>
              {best.map((a, i) => (
                <div key={a.player_id || i} className="share-row">
                  <span className="share-medal">{medals[i] ?? "⭐"}</span>
                  {a.photo ? <img className="share-photo" src={a.photo} alt="" /> : null}
                  <span className="share-name">{a.name}</span>
                  <span className="share-detail">{flagFor(a.team_name)}</span>
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
                  {a.photo ? <img className="share-photo" src={a.photo} alt="" /> : null}
                  <span className="share-name">{a.name}</span>
                  <span className="share-detail">{flagFor(a.team_name)}</span>
                  <span className="share-num">{a.goals}</span>
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
                  {a.photo ? <img className="share-photo" src={a.photo} alt="" /> : null}
                  <span className="share-name">{a.name}</span>
                  <span className="share-detail">{flagFor(a.team_name)}</span>
                  <span className="share-num">{a.assists}</span>
                </div>
              ))}
            </div>
          )}
        </div>
        </div>
        </div>

        <div className="share-actions bar">
          <button className="btn primary big" onClick={share} disabled={sharing}>
            {sharing ? t("share.sharing") : t("share.share")}
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