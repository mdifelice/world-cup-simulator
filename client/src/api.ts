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
  participants: (id: number) =>
    req<import("./types").Participant[]>(`/api/tournaments/${id}/participants`),
  players: (teamId: number, tournamentId?: number) =>
    req<import("./types").Player[]>(
      `/api/teams/${teamId}/players` +
        (tournamentId ? `?tournament_id=${tournamentId}` : ""),
    ),
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