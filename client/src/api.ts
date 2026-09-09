const BASE = "";

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    headers: { "Content-Type": "application/json" },
    ...init,
  });
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
  worldcups: () => req<import("./types").WorldCup[]>("/api/worldcups"),
  participants: (wcId: number) =>
    req<import("./types").Participant[]>(`/api/worldcups/${wcId}/participants`),
  matches: (wcId: number) =>
    req<import("./types").SimMatch[]>(`/api/worldcups/${wcId}/matches`),
  players: (teamId: number) =>
    req<import("./types").Player[]>(`/api/teams/${teamId}/players`),
  simulate: (
    wcId: number,
    focusTeamId: number | null,
    boost: number,
  ) =>
    req<import("./types").SimulateResponse>(`/api/worldcups/${wcId}/simulate`, {
      method: "POST",
      body: JSON.stringify({
        focus_team_id: focusTeamId,
        focus_boost: boost,
      }),
    }),
};