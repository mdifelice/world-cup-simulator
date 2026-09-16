/** Official Wikimedia trophy icons bundled locally: the FIFA WC trophy is
 *  used from 1974 on, the Jules Rimet trophy for 1930–1970 editions. */
export const TROPHY_FIFA = "/trophies/fifa.svg";
export const TROPHY_JULES = "/trophies/jules.svg";

export const trophyForYear = (year?: number | null) =>
  year != null && year <= 1970 ? TROPHY_JULES : TROPHY_FIFA;