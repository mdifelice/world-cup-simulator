/** Pure helpers for the match clock and incident minute display.
 *
 * Everything works in the walked-minute space, in which added time never shifts
 * the regular minute numbering: the HT stoppage plays 45+1, 45+2, ..., the
 * second half then resumes at 46' and runs to 90', and the FT stoppage shows
 * 90+1, 90+2, .... The extra-time halves mirror this around 105' and 120'.
 */
export interface ClockCtx {
  extra_time: boolean;
  addedHT: number;
  addedFT: number;
  addedET1: number;
  addedET2: number;
}

/** Sum of the regulation stoppage minutes (half + full time). */
export const stoppageShift = (c: ClockCtx): number => c.addedHT + c.addedFT;

/** Fixed display width of one added-time minute (a narrow band at a half's end). */
const BAND = 0.28;

/** Total width of the display axis, in display units. */
export function axisSpan(c: ClockCtx): number {
  const reg = c.extra_time ? 120 : 90;
  return (
    reg +
    (c.addedHT + c.addedFT) * BAND +
    (c.extra_time ? (c.addedET1 + c.addedET2) * BAND : 0)
  );
}

/** Display-axis position (in display units) of a walked minute n.
 *
 * Regulation play maps one-to-one. Each period's added time compresses into a
 * narrow band right after the period's last regular minute, so stoppage only
 * ever extends the axis at the end of each half - it never pushes new bars
 * towards the start of the match.
 */
export function axisPos(c: ClockCtx, n: number): number {
  const bandHT = c.addedHT * BAND;
  const bandFT = c.addedFT * BAND;
  if (n <= 45) return n;
  if (n <= 45 + c.addedHT) return 45 + ((n - 45) * BAND);
  if (n <= 90 + c.addedHT) return 45 + bandHT + (n - 45 - c.addedHT);
  if (n <= 90 + c.addedHT + c.addedFT) return 90 + bandHT + ((n - 90 - c.addedHT) * BAND);
  const bandET1 = c.addedET1 * BAND;
  const d0 = 90 + bandHT + bandFT;
  if (!c.extra_time) return d0 + (n - 90 - c.addedHT - c.addedFT);
  const SH = stoppageShift(c);
  if (n <= 105 + SH) return d0 + (n - 90 - SH);
  if (n <= 105 + SH + c.addedET1) return d0 + 15 + ((n - 105 - SH) * BAND);
  if (n <= 120 + SH + c.addedET1) return d0 + 15 + bandET1 + (n - 105 - SH - c.addedET1);
  return d0 + 30 + bandET1 + ((n - 120 - SH - c.addedET1) * BAND);
}

/** Display label of a walked minute n. */
export function labelOf(c: ClockCtx, n: number): string {
  const SH = stoppageShift(c);
  if (n <= 45) return `${n}'`;
  if (n <= 45 + c.addedHT) return `45+${n - 45}'`;
  if (n <= 90 + c.addedHT) return `${n - c.addedHT}'`;
  if (n <= 90 + c.addedHT + c.addedFT) return `90+${n - 90 - c.addedHT}'`;
  if (!c.extra_time) return `${n - SH}'`;
  if (n <= 105 + SH) return `${n - SH}'`;
  if (n <= 105 + SH + c.addedET1) return `105+${n - 105 - SH}'`;
  if (n <= 120 + SH + c.addedET1) return `${n - SH - c.addedET1}'`;
  return `120+${n - 120 - SH - c.addedET1}'`;
}

/** Base minute of the stoppage an added-time incident belongs to. */
export function addedBase(c: ClockCtx, mv: number, et: boolean): number {
  return et
    ? mv <= 105 + c.addedET1
      ? 105
      : 120
    : mv <= 45 + c.addedHT
      ? 45
      : 90;
}

/** Walked-minute slot of an incident on the fixed axis.
 *
 * Stored minute values overlap across halves (a 46' can be a first-half
 * added-time goal or a second-half one), so the added-time flag settles it:
 * first-half stoppage incidents sit just before the HT line, everything else
 * in the second half and beyond is shifted right by the half-time stoppage.
 */
export function seqForMinute(c: ClockCtx, v: number, et: boolean, added: boolean): number {
  if (!et) {
    // HT stoppage goals (stored 46..45+addedHT) sit right before the HT line;
    // FT stoppage goals (stored 90+m) sit after the second half, pushed right
    // by the half-time stoppage.
    if (added) return v <= 45 + c.addedHT ? v : v + c.addedHT;
    return v <= 45 ? v : v + c.addedHT;
  }
  if (!c.extra_time) return v + c.addedHT;
  const SH = stoppageShift(c);
  const baseSH = 90 + SH;
  // The engine stores stoppage goals one past the period's last raw minute:
  // ET1 stoppage goals land on 106..105+addedET1, ET2 regular goals on the
  // same span when 106..120. The added-time flag settles that overlap.
  if (added) {
    if (v <= 105 + c.addedET1) return baseSH + 15 + (v - 105);
    return baseSH + 30 + c.addedET1 + (v - 120);
  }
  if (v <= 105) return baseSH + (v - 90);
  return baseSH + 15 + c.addedET1 + (v - 105);
}

/** Minute text (e.g. "45+2" vs "50") for an incident. */
export function minuteText(c: ClockCtx, mv: number, et: boolean, added: boolean): string {
  return added
    ? `${addedBase(c, mv, et)}+${mv - addedBase(c, mv, et)}`
    : String(mv);
}

/** Full "m'" label for an incident row. */
export function incLabel(c: ClockCtx, mv: number, et: boolean, added: boolean): string {
  return `${minuteText(c, mv, et, added)}'`;
}