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
  return res.json() as Promise<T>;
}

export const api = {
  tournaments: () => req<import("./types").Tournament[]>("/api/tournaments"),
  tournament: (id: number) =>
    req<import("./types").TournamentDetail>(`/api/tournaments/${id}`),
  participants: (id: number) =>
    req<import("./types").Participant[]>(`/api/tournaments/${id}/participants`),
  matches: (id: number) =>
    req<import("./types").SimMatch[]>(`/api/tournaments/${id}/matches`),
  players: (teamId: number, tournamentId?: number) =>
    req<import("./types").Player[]>(
      `/api/teams/${teamId}/players` +
        (tournamentId ? `?tournament_id=${tournamentId}` : ""),
    ),
  simulate: (
    id: number,
    focusTeamId: number | null,
    boost: number,
  ) =>
    req<import("./types").SimulateResponse>(`/api/tournaments/${id}/simulate`, {
      method: "POST",
      body: JSON.stringify({ focus_team_id: focusTeamId, focus_boost: boost }),
    }),
  run: (id: number, focusTeamId: number | null) =>
    req<import("./types").RunPayload>(`/api/tournaments/${id}/run`, {
      method: "POST",
      body: JSON.stringify({ focus_team_id: focusTeamId }),
    }),
  runs: () => req<import("./types").RunListItem[]>("/api/runs"),
  runById: (id: number) =>
    req<import("./types").RunPayload>(`/api/runs/${id}`),
  me: () => req<import("./types").User>("/api/auth/me"),
};

export const googleSignInUrl = () => `${BASE}/api/auth/google`;