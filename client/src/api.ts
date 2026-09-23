const BASE = "";

export const TOKEN_KEY = "wcs_token";

export function readToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

export function setToken(token: string) {
  localStorage.setItem(TOKEN_KEY, token);
}

export function clearToken() {
  localStorage.removeItem(TOKEN_KEY);
}

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const token = readToken();
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token) headers["Authorization"] = `Bearer ${token}`;
  const res = await fetch(`${BASE}${path}`, { headers, ...init });
  if (!res.ok) {
    let msg = `${res.status} ${res.statusText}`;
    try {
      const body = await res.json();
      msg = body.error ?? msg;
    } catch {
      /* keep default message */
    }
    throw new Error(msg);
  }
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

export const api = {
  tournaments: () => req<import("./types").Tournament[]>("/api/tournaments"),
  participants: (id: number) =>
    req<import("./types").Participant[]>(`/api/tournaments/${id}/participants`),
  players: (teamId: number, tournamentId?: number) =>
    req<import("./types").Player[]>(
      `/api/teams/${teamId}/players` +
        (tournamentId ? `?tournament_id=${tournamentId}` : ""),
    ),
  /** Data-only run oracle: tournament meta, phases, participants, squads,
   *  manual groups and scheduled group fixtures. No simulation happens
   *  server-side — the client runs the tournament from this snapshot. */
  oracle: (id: number) =>
    req<import("./sim/run").Oracle>(`/api/tournaments/${id}/oracle`),
  me: () => req<import("./types").User>("/api/auth/me"),
  /* ------------------------------------------------------------------ *
   * Editor CRUD (open to everyone, like /lab)
   * ------------------------------------------------------------------ */
  tournamentDetail: (id: number) =>
    req<import("./types").TournamentDetail>(`/api/tournaments/${id}`),
  createTournament: (data: import("./types").TournamentDraft) =>
    req<import("./types").Tournament>("/api/tournaments", {
      method: "POST",
      body: JSON.stringify(data),
    }),
  updateTournament: (id: number, data: Record<string, unknown>) =>
    req<import("./types").Tournament>(`/api/tournaments/${id}`, {
      method: "PUT",
      body: JSON.stringify(data),
    }),
  deleteTournament: (id: number) =>
    req<undefined>(`/api/tournaments/${id}`, { method: "DELETE" }),
  setPhases: (id: number, phases: import("./types").PhaseDraft[]) =>
    req<number>(`/api/tournaments/${id}/phases`, {
      method: "POST",
      body: JSON.stringify({ phases }),
    }),
  addParticipants: (
    id: number,
    list: Array<{ team_id: number; group_letter?: string }>,
  ) =>
    req<number>(`/api/tournaments/${id}/participants`, {
      method: "POST",
      body: JSON.stringify({ participations: list }),
    }),
  updateParticipant: (id: number, teamId: number, groupLetter: string | null) =>
    req<import("./types").Participant>(`/api/tournaments/${id}/participants/${teamId}`, {
      method: "PUT",
      body: JSON.stringify({ group_letter: groupLetter }),
    }),
  deleteParticipant: (id: number, teamId: number) =>
    req<undefined>(`/api/tournaments/${id}/participants/${teamId}`, {
      method: "DELETE",
    }),
  matches: (id: number) =>
    req<import("./types").DbMatch[]>(`/api/tournaments/${id}/matches`),
  createMatches: (id: number, list: import("./types").CreateMatch[]) =>
    req<number>(`/api/tournaments/${id}/matches`, {
      method: "POST",
      body: JSON.stringify(list),
    }),
  updateMatch: (id: number, matchId: number, data: import("./types").CreateMatch) =>
    req<import("./types").DbMatch>(`/api/tournaments/${id}/matches/${matchId}`, {
      method: "PUT",
      body: JSON.stringify(data),
    }),
  deleteMatch: (id: number, matchId: number) =>
    req<undefined>(`/api/tournaments/${id}/matches/${matchId}`, {
      method: "DELETE",
    }),
  generateFixture: (id: number) =>
    req<number>(`/api/tournaments/${id}/fixture/generate`, { method: "POST" }),
  importTournament: (id: number, payload: unknown) =>
    req<number>(`/api/tournaments/${id}/import`, {
      method: "POST",
      body: JSON.stringify(payload),
    }),
  createPlayers: (
    teamId: number,
    tournamentId: number,
    players: import("./types").PlayerDraft[],
  ) =>
    req<number>(`/api/teams/${teamId}/players`, {
      method: "POST",
      body: JSON.stringify({ tournament_id: tournamentId, players }),
    }),
  teams: () => req<import("./types").Team[]>("/api/teams"),
  createTeam: (data: {
    name: string;
    code?: string | null;
    flag?: string | null;
    rating?: number;
  }) =>
    req<import("./types").Team>("/api/teams", {
      method: "POST",
      body: JSON.stringify(data),
    }),
  updateTeam: (id: number, data: Record<string, unknown>) =>
    req<import("./types").Team>(`/api/teams/${id}`, {
      method: "PUT",
      body: JSON.stringify(data),
    }),
  deleteTeam: (id: number) =>
    req<undefined>(`/api/teams/${id}`, { method: "DELETE" }),
  updatePlayer: (
    teamId: number,
    playerId: number,
    tournamentId: number,
    data: import("./types").PlayerDraft,
  ) =>
    req<import("./types").Player>(
      `/api/teams/${teamId}/players/${playerId}?tournament_id=${tournamentId}`,
      { method: "PUT", body: JSON.stringify(data) },
    ),
  deletePlayer: (teamId: number, playerId: number, tournamentId: number) =>
    req<undefined>(
      `/api/teams/${teamId}/players/${playerId}?tournament_id=${tournamentId}`,
      { method: "DELETE" },
    ),
  /** Upload a photo (data URL) → served URL. */
  uploadPhoto: (dataUrl: string) =>
    req<{ url: string }>("/api/photos", {
      method: "POST",
      body: JSON.stringify({ data: dataUrl }),
    }).then((r) => r.url),
};

export const googleSignInUrl = () => `${BASE}/api/auth/google`;