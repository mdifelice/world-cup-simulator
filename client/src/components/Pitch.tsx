import type { Player } from "../types";
import { positionColor, type Formation } from "../formations";

interface Props {
  formation: Formation;
  /** players assigned to each slot index (may be null until filled) */
  lineup: (Player | null)[];
  selected: number | null;
  onSelect: (slotIndex: number) => void;
  compact?: boolean;
}

export default function Pitch({
  formation,
  lineup,
  selected,
  onSelect,
  compact,
}: Props) {
  return (
    <svg
      viewBox="0 0 100 147"
      className={"pitch" + (compact ? " pitch-compact" : "")}
    >
      <defs>
        <pattern id="stripes" width="20" height="147" patternUnits="userSpaceOnUse">
          <rect width="10" height="147" fill="#2f8f46" />
          <rect x="10" width="10" height="147" fill="#37a050" />
        </pattern>
      </defs>
      <rect width="100" height="147" rx="2" fill="url(#stripes)" />
      <g stroke="#f2f2e8" strokeWidth="0.5" fill="none" opacity="0.9">
        <rect x="1.5" y="1.5" width="97" height="144" rx="2" />
        <line x1="50" y1="1.5" x2="50" y2="145.5" />
        <circle cx="50" cy="73.5" r="9.5" />
        {/* left penalty area */}
        <rect x="1.5" y="30" width="14" height="87" />
        <rect x="1.5" y="44" width="5.5" height="59" />
        <circle cx="12" cy="73.5" r="0.8" fill="#f2f2e8" />
        {/* right penalty area */}
        <rect x="84.5" y="30" width="14" height="87" />
        <rect x="93.5" y="44" width="5" height="59" />
        <circle cx="88" cy="73.5" r="0.8" fill="#f2f2e8" />
      </g>

      {formation.slots.map((slot, i) => {
        const player = lineup[i];
        const isSel = selected === i;
        return (
          <g
            key={i}
            transform={`translate(${slot.x}, ${slot.y})`}
            onClick={() => onSelect(i)}
            style={{ cursor: "pointer" }}
          >
            <circle
              r={6.5}
              fill={isSel ? "#ffd84d" : positionColor[slot.pos]}
              stroke="#1a1a1a"
              strokeWidth={isSel ? 2 : 1}
              opacity={player ? 1 : 0.55}
            />
            {player ? (
              <text
                textAnchor="middle"
                y={2.5}
                fontSize="6"
                fontWeight="bold"
                fill="#fff"
              >
                {player.shirt_number !== null && player.shirt_number !== undefined
                  ? player.shirt_number
                  : ""}
              </text>
            ) : (
              <text textAnchor="middle" y={2} fontSize="7" fill="#fff" opacity="0.9">
                +
              </text>
            )}
            {player && !compact && (
              <text
                textAnchor="middle"
                y={12}
                fontSize="3.6"
                fill="#fff"
                fontWeight="600"
              >
                {player.name.length > 14 ? player.name.slice(0, 13) + "…" : player.name}
              </text>
            )}
          </g>
        );
      })}
    </svg>
  );
}