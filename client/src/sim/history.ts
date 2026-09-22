// history.ts — browser-local storage of completed runs.
//
// The server no longer persists runs (or simulates them); completed
// tournaments are archived per-browser under a single localStorage key. The
// entry stores the full deterministic RunPayload, so a relived run replays the
// exact same seed → identical matches.

import type { RunPayload } from "../types";

const KEY = "wcs_runs";

export interface HistoryEntry {
  id: number;
  tournament_id: number;
  tournament_name: string;
  year: number;
  champion: string | null;
  created_at: string;
  /** Full replay payload; `run_id` stays null and the local entry id is the
   *  handle used to relive it. */
  run: RunPayload;
}

function parse(raw: string | null): HistoryEntry[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

function write(entries: HistoryEntry[]) {
  try {
    localStorage.setItem(KEY, JSON.stringify(entries));
  } catch {
    // Quota exceeded (large runs) — drop the archive rather than crash.
    try {
      localStorage.removeItem(KEY);
    } catch {
      /* ignore */
    }
  }
}

/** All archived runs, newest first. */
export function listRuns(): HistoryEntry[] {
  return parse(localStorage.getItem(KEY));
}

/** Persist a completed run; returns the created entry. */
export function saveRun(run: RunPayload): HistoryEntry {
  const entries = parse(localStorage.getItem(KEY));
  const id = entries.reduce((m, e) => Math.max(m, e.id), 0) + 1;
  const entry: HistoryEntry = {
    id,
    tournament_id: run.tournament_id,
    tournament_name: run.tournament_name,
    year: run.year,
    champion: run.champion,
    created_at: new Date().toISOString(),
    run,
  };
  entries.unshift(entry);
  write(entries);
  return entry;
}

/** Load the full payload for a relive. Returns null when missing. */
export function loadRun(id: number): RunPayload | null {
  const entry = parse(localStorage.getItem(KEY)).find((e) => e.id === id);
  return entry ? entry.run : null;
}

/** True when a run with this seed is already archived for the tournament. */
export function hasRun(tournamentId: number, seed: number): boolean {
  return parse(localStorage.getItem(KEY)).some(
    (e) => e.run.tournament_id === tournamentId && e.run.seed === seed,
  );
}