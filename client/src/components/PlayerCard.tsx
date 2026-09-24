import type { ReactNode } from "react";
import { useI18n } from "../i18n";
import { playerSurname, ratingStars, starsString, posToken } from "../types";

/** Everything a card needs to render; callers may fill in gaps from aggregates. */
export interface PlayerCardData {
  id: number;
  name: string;
  position?: string;
  positions?: string[];
  photo_url?: string | null;
  shirt_number?: number | null;
  overall?: number;
  /** Market-style star rating (falls back to `overall` when absent). */
  rating?: number;
}

interface Props {
  player: PlayerCardData;
  variant?: "grid" | "row" | "medal" | "mini" | "stat";
  /** Hue index for the placeholder photo when there is no picture (0..3). */
  tone?: number;
  /** Star count override (effective rating for a slot, award score…). */
  stars?: number | null;
  positions?: string[];
  /** Number shown top-left; defaults to the shirt number. */
  number?: string | number | null;
  /** Small line under the surname (e.g. team on scorer lists). */
  sub?: ReactNode;
  /** Block pinned to the right edge (e.g. goals on scorer lists). */
  right?: ReactNode;
  /** Top ribbon (used by awards). */
  band?: ReactNode;
  stamp?: ReactNode;
  title?: string;
  selected?: boolean;
  dimmed?: boolean;
  className?: string;
  onClick?: () => void;
}

export default function PlayerCard({
  player,
  variant = "grid",
  tone = 0,
  stars,
  positions,
  number,
  sub,
  right,
  band,
  stamp,
  title,
  selected,
  dimmed,
  className,
  onClick,
}: Props) {
  const { pos } = useI18n();
  const posList =
    positions ??
    (player.positions && player.positions.length > 0
      ? player.positions
      : player.position
        ? [player.position]
        : []);
  // Granular positions collapse onto the canonical set ("LB"/"LWB" → LDF), so
  // drop badges once the label repeats.
  const posLabels = Array.from(new Set(posList.map((p) => pos(posToken(p)))));
  const starCount =
    stars ??
    (player.rating != null
      ? ratingStars(player.rating)
      : player.overall != null
        ? ratingStars(player.overall)
        : null);
  const num = number ?? player.shirt_number ?? null;

  const cls = [
    "pcard",
    `pc-${variant}`,
    `tone-${((tone % 4) + 4) % 4}`,
    selected ? "pc-selected" : "",
    dimmed ? "pc-dimmed" : "",
    className ?? "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div className={cls} title={title} onClick={onClick}>
      <div className="pc-photo">
        {player.photo_url ? (
          <img
            src={player.photo_url}
            alt=""
            onError={(e) => {
              (e.currentTarget as HTMLImageElement).style.display = "none";
            }}
          />
        ) : (
          <span className="pc-photo-empty" aria-hidden="true">
            <svg viewBox="0 0 24 24">
              <circle cx="12" cy="8" r="4" />
              <path d="M4 20c0-4 3.5-6.5 8-6.5s8 2.5 8 6.5" />
            </svg>
          </span>
        )}
      </div>
      <div className="pc-scrim" />
      {band && <div className="pc-band">{band}</div>}
      {num != null && <span className="pc-num">{num}</span>}
      {posLabels.length > 0 && (
        <div className="pc-pos">
          {posLabels.map((p, i) => (
            <span key={i}>{p}</span>
          ))}
        </div>
      )}
      <div className="pc-low">
        {starCount != null && <div className="pc-stars">{starsString(starCount)}</div>}
        <div className="pc-surname">{playerSurname(player.name)}</div>
        {sub && <div className="pc-sub">{sub}</div>}
      </div>
      {right && <div className="pc-right">{right}</div>}
      {dimmed && stamp && <div className="pc-stamp">{stamp}</div>}
    </div>
  );
}