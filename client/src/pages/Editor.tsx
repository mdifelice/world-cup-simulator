import { useCallback, useEffect, useMemo, useState, type ChangeEvent } from "react";
import type {
  CreateMatch,
  DbMatch,
  Participant,
  Phase,
  PhaseDraft,
  Player,
  PlayerDraft,
  PositionFamiliarity,
  Team,
  Tournament,
  TournamentDetail,
} from "../types";
import { POSITIONS, encodePos, parsePosItem } from "../types";
import { api } from "../api";
import { useI18n } from "../i18n";

/** Order of the 18 match-engine attributes (mirrors the server). */
const ATTRIBUTES = [
  "pace", "stamina", "strength", "dribbling", "passing", "shooting",
  "tackling", "vision", "positioning", "composure", "reflexes", "handling",
  "kicking", "aerial", "decisions", "aggression", "concentration", "leadership",
] as const;

type AttrKey = (typeof ATTRIBUTES)[number];

/** Attribute emphasis per granular position (mirrors server attrs.rs
 *  `position_weights`) — drives the position-aware random generator. */
const POS_WEIGHTS: Record<string, Partial<Record<AttrKey, number>>> = {
  GK: { reflexes: 1, handling: 1, kicking: 1, positioning: 0.7, decisions: 0.6, composure: 0.6, concentration: 0.5, aerial: 0.5, strength: 0.4, pace: 0.2 },
  CB: { tackling: 1, aerial: 1, strength: 1, positioning: 0.9, decisions: 0.8, aggression: 0.7, concentration: 0.7, pace: 0.5, composure: 0.5, passing: 0.4 },
  RB: { pace: 1, stamina: 1, tackling: 0.8, positioning: 0.7, dribbling: 0.6, passing: 0.6, aggression: 0.5, vision: 0.4, aerial: 0.4 },
  LB: { pace: 1, stamina: 1, tackling: 0.8, positioning: 0.7, dribbling: 0.6, passing: 0.6, aggression: 0.5, vision: 0.4, aerial: 0.4 },
  WB: { pace: 1, stamina: 1, dribbling: 0.8, passing: 0.7, positioning: 0.6, tackling: 0.6, vision: 0.6, aggression: 0.5, shooting: 0.4 },
  DM: { tackling: 1, stamina: 0.9, positioning: 0.8, decisions: 0.8, vision: 0.7, passing: 0.8, strength: 0.7, aggression: 0.7, composure: 0.6 },
  CM: { passing: 1, vision: 1, stamina: 0.9, decisions: 0.8, positioning: 0.7, dribbling: 0.7, composure: 0.7, tackling: 0.5, shooting: 0.4 },
  AM: { passing: 1, vision: 1, dribbling: 0.9, shooting: 0.7, decisions: 0.7, positioning: 0.7, composure: 0.8, stamina: 0.5 },
  RW: { pace: 1, dribbling: 1, shooting: 0.8, passing: 0.7, positioning: 0.7, vision: 0.6, stamina: 0.6, composure: 0.5 },
  LW: { pace: 1, dribbling: 1, shooting: 0.8, passing: 0.7, positioning: 0.7, vision: 0.6, stamina: 0.6, composure: 0.5 },
  ST: { shooting: 1, positioning: 0.9, pace: 0.9, aerial: 0.8, strength: 0.6, dribbling: 0.7, composure: 0.8, passing: 0.4 },
};

/** Generate a full attribute set biased towards a position. `bias` (0..10)
 *  concentrates stats into the position's key attributes; `level` shifts the
 *  whole curve up (stars) or down (bench fillers). */
const randomForPosition = (
  pos: string,
  bias: number,
  level: number,
): Partial<Record<AttrKey, number>> => {
  const w = POS_WEIGHTS[pos] ?? {};
  const maxW = Math.max(...Object.values(w), 1);
  const out: Partial<Record<AttrKey, number>> = {};
  for (const a of ATTRIBUTES) {
    const wv = w[a] ?? 0;
    const target = 52 + (wv / maxW) * 28 * (bias / 10) + level;
    const jitter = Math.random() * 16 - 8;
    out[a] = Math.max(2, Math.min(99, Math.round(target + jitter)));
  }
  return out;
};

const PHASE_KEY_SUGGESTIONS = ["GROUP", "R32", "R16", "QF", "SF", "THIRD", "F"];

const emptyDraft: PlayerDraft = {
  name: "",
  position: "CM",
  positions: [],
  shirt_number: null,
  pace: 60, stamina: 60, strength: 60, dribbling: 60, passing: 60,
  shooting: 60, tackling: 60, vision: 60, positioning: 60, composure: 60,
  reflexes: 60, handling: 60, kicking: 60, aerial: 60, decisions: 60,
  aggression: 60, concentration: 60, leadership: 60,
};

const num = (v: string | number | null | undefined, fallback = ""): string =>
  v === null || v === undefined ? String(fallback) : String(v);

export default function Editor() {
  const { t } = useI18n();
  const [tournaments, setTournaments] = useState<Tournament[]>([]);
  const [teams, setTeams] = useState<Team[]>([]);
  const [tid, setTid] = useState<number | null>(null);
  const [detail, setDetail] = useState<TournamentDetail | null>(null);
  const [participants, setParticipants] = useState<Participant[]>([]);
  const [matches, setMatches] = useState<DbMatch[]>([]);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showEdit, setShowEdit] = useState(false);
  const [showPhases, setShowPhases] = useState(false);
  const [confirmDeleteT, setConfirmDeleteT] = useState(false);

  const refreshTournaments = useCallback(async () => {
    setTournaments(await api.tournaments());
  }, []);

  useEffect(() => {
    api
      .tournaments()
      .then(setTournaments)
      .catch((e) => setError(String(e)));
    api
      .teams()
      .then(setTeams)
      .catch(() => undefined);
  }, []);

  const loadTournament = useCallback(async (id: number) => {
    setError(null);
    try {
      const [d, p, m] = await Promise.all([
        api.tournamentDetail(id),
        api.participants(id),
        api.matches(id),
      ]);
      setTid(id);
      setDetail(d);
      setParticipants(p);
      setMatches(m);
    } catch (e) {
      setError(String(e));
    }
  }, []);

  useEffect(() => {
    if (tid) void loadTournament(tid);
    else {
      setDetail(null);
      setParticipants([]);
      setMatches([]);
    }
  }, [tid, loadTournament]);

  /** Run a mutation, surface errors, then reload affected lists. */
  const run = useCallback(
    async (fn: () => Promise<unknown>, refresh: () => Promise<unknown>) => {
      setBusy(true);
      setError(null);
      setMsg(null);
      try {
        await fn();
        await refresh();
        setMsg(t("editor.saved"));
      } catch (e) {
        setError(String(e));
      } finally {
        setBusy(false);
      }
    },
    [t],
  );

  return (
    <div className="lab-page">
      <header className="lab-header lab-header-row">
        <h1>{t("editor.title")}</h1>
      </header>

      {error && (
        <div className="editor-banner editor-error" role="alert">
          {error}
          <button className="btn" onClick={() => setError(null)}>✕</button>
        </div>
      )}
      {msg && (
        <div className="editor-banner editor-ok">
          {msg}
          <button className="btn" onClick={() => setMsg(null)}>✕</button>
        </div>
      )}

      <div className="editor-layout">
        {/* ------------------------------------------------------------ */}
        {/* Tournaments */}
        {/* ------------------------------------------------------------ */}
        <section className="editor-section">
          <h3>{t("editor.tournaments")}</h3>
          <div className="editor-row editor-wrap">
            <select
              className="editor-select"
              value={tid ?? ""}
              onChange={(e) => setTid(e.target.value ? parseInt(e.target.value, 10) : null)}
            >
              <option value="">—</option>
              {tournaments.map((tr) => (
                <option key={tr.id} value={tr.id}>
                  {tr.year} {tr.name}
                </option>
              ))}
            </select>
            {tournaments.length === 0 && <span className="editor-muted">{t("editor.noTournaments")}</span>}
          </div>
          <TournamentForm
            busy={busy}
            onCreated={async () => {
              await refreshTournaments();
            }}
          />
        </section>

        {detail && (
          <>
            {/* -------------------------------------------------------- */}
            {/* Tournament meta + phases */}
            {/* -------------------------------------------------------- */}
            <section className="editor-section">
              <h3>
                {detail.name} · {detail.year}
                {detail.ready && <span className="editor-ready">✓</span>}
              </h3>
              <div className="editor-row editor-actions-row">
                <button className="btn" disabled={busy} onClick={() => setShowEdit(true)}>
                  {t("editor.editTournament")}
                </button>
                <button className="btn" disabled={busy} onClick={() => setShowPhases(true)}>
                  {t("editor.phases")}
                </button>
                <button className="btn danger" disabled={busy} onClick={() => setConfirmDeleteT(true)}>
                  {t("editor.delete")}
                </button>
              </div>
              {showEdit && (
                <TournamentMeta
                  detail={detail}
                  busy={busy}
                  onClose={() => setShowEdit(false)}
                  onSaved={() => void loadTournament(tid!)}
                />
              )}
              {showPhases && (
                <PhasesEditor
                  tid={tid!}
                  phases={detail.phases}
                  busy={busy}
                  onClose={() => setShowPhases(false)}
                  onSaved={async () => {
                    await loadTournament(tid!);
                    setMsg(t("editor.phasesSaved"));
                  }}
                />
              )}
              {confirmDeleteT && (
                <div className="modal-backdrop" onClick={() => setConfirmDeleteT(false)}>
                  <div
                    className="share-modal editor-player-modal"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <p>{t("editor.confirmDeleteTournament")}</p>
                    <div className="editor-row">
                      <button className="btn" onClick={() => setConfirmDeleteT(false)}>
                        {t("editor.cancel")}
                      </button>
                      <button
                        className="btn danger"
                        onClick={async () => {
                          setConfirmDeleteT(false);
                          await api.deleteTournament(tid!);
                          setTid(null);
                          await refreshTournaments();
                        }}
                      >
                        {t("editor.delete")}
                      </button>
                    </div>
                  </div>
                </div>
              )}
            </section>

            {/* -------------------------------------------------------- */}
            {/* Teams & participants */}
            {/* -------------------------------------------------------- */}
            <section className="editor-section">
              <h3>{t("editor.teams")}</h3>
              <div className="editor-row">
                <TeamForm
                  busy={busy}
                  onCreated={async () => {
                    setTeams(await api.teams());
                  }}
                />
              </div>
              <ParticipantList
                teams={teams}
                participants={participants}
                busy={busy}
                onAdd={(list) =>
                  run(() => api.addParticipants(tid!, list), () => loadTournament(tid!))
                }
                onSetGroup={(teamId, g) =>
                  run(() => api.updateParticipant(tid!, teamId, g), () => loadTournament(tid!))
                }
                onRemove={(teamId) =>
                  run(() => api.deleteParticipant(tid!, teamId), () => loadTournament(tid!))
                }
              />
              <TeamEditList teams={teams} busy={busy} onRefresh={refreshTournaments}
                participants={participants} onChanged={() => void loadTournament(tid!)} />
            </section>

            {/* -------------------------------------------------------- */}
            {/* Fixtures */}
            {/* -------------------------------------------------------- */}
            <section className="editor-section">
              <h3>{t("editor.fixtures")}</h3>
              <div className="editor-row">
                <button
                  className="btn"
                  disabled={busy}
                  onClick={() =>
                    void run(() => api.generateFixture(tid!), () => loadTournament(tid!))
                  }
                >
                  {t("editor.generateFixture")}
                </button>
                <button
                  className="btn"
                  disabled={busy}
                  onClick={() =>
                    void run(() => api.tournamentDetail(tid!), () => loadTournament(tid!))
                  }
                >
                  {t("editor.reload")}
                </button>
              </div>
              <MatchList
                matches={matches}
                participants={participants}
                stageSuggestions={(detail.phases.map((p) => p.key)).concat(PHASE_KEY_SUGGESTIONS)}
                busy={busy}
                onAdd={(list) =>
                  run(() => api.createMatches(tid!, list), () => loadTournament(tid!))
                }
                onEdit={(mid, data) =>
                  run(() => api.updateMatch(tid!, mid, data), () => loadTournament(tid!))
                }
                onDelete={(mid) =>
                  run(() => api.deleteMatch(tid!, mid), () => loadTournament(tid!))
                }
              />
            </section>

            {/* -------------------------------------------------------- */}
            {/* Squads (players of a chosen participant) */}
            {/* -------------------------------------------------------- */}
            <section className="editor-section">
              <h3>{t("editor.squads")}</h3>
              <PlayersEditor
                participants={participants}
                tid={tid!}
                busy={busy}
              />
            </section>

            {/* -------------------------------------------------------- */}
            {/* JSON bulk import */}
            {/* -------------------------------------------------------- */}
            <section className="editor-section">
              <h3>{t("editor.import")}</h3>
              <ImportPanel tid={tid!} busy={busy} onDone={(n) => { setMsg(t("editor.importOk", { n })); void loadTournament(tid!); }} />
            </section>
          </>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tournament create / edit
// ---------------------------------------------------------------------------

function TournamentForm({
  busy,
  onCreated,
}: {
  busy: boolean;
  onCreated: () => void | Promise<void>;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [year, setYear] = useState(new Date().getFullYear());
  const [host, setHost] = useState("");
  const [shirtNumbers, setShirtNumbers] = useState(true);

  const save = async () => {
    await api.createTournament({ name, year, host, shirt_numbers: shirtNumbers });
    setName("");
    setHost("");
    setOpen(false);
    await onCreated();
  };

  return (
    <div className="editor-inline">
      <button className="btn" onClick={() => setOpen((o) => !o)}>
        {open ? t("editor.cancel") : "＋ " + t("editor.newTournament")}
      </button>
      {open && (
        <div className="modal-backdrop" onClick={() => setOpen(false)}>
          <div className="share-modal editor-player-modal" onClick={(e) => e.stopPropagation()}>
            <div className="editor-card">
              <div className="editor-field">
                <label>{t("editor.name")}</label>
                <input value={name} onChange={(e) => setName(e.target.value)} />
              </div>
              <div className="editor-field">
                <label>{t("editor.year")}</label>
                <input
                  type="number"
                  value={year}
                  onChange={(e) => setYear(parseInt(e.target.value) || 0)}
                />
              </div>
              <div className="editor-field">
                <label>{t("editor.host")}</label>
                <input value={host} onChange={(e) => setHost(e.target.value)} />
              </div>
              <label className="editor-check">
                <input
                  type="checkbox"
                  checked={shirtNumbers}
                  onChange={(e) => setShirtNumbers(e.target.checked)}
                />
                {t("editor.shirtNumbers")}
              </label>
              <button
                className="btn primary"
                disabled={busy || !name.trim() || !year}
                onClick={save}
              >
                {t("editor.create")}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function TournamentMeta({
  detail,
  busy,
  onClose,
  onSaved,
}: {
  detail: TournamentDetail;
  busy: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { t } = useI18n();
  const [name, setName] = useState(detail.name);
  const [year, setYear] = useState(detail.year);
  const [host, setHost] = useState(detail.host);
  const [winner, setWinner] = useState(detail.winner ?? "");
  const [startDate, setStartDate] = useState(detail.start_date ?? "");
  const [endDate, setEndDate] = useState(detail.end_date ?? "");
  const [logo, setLogo] = useState(detail.logo ?? "");
  const [shirtNumbers, setShirtNumbers] = useState(detail.shirt_numbers);

  useEffect(() => {
    setName(detail.name);
    setYear(detail.year);
    setHost(detail.host);
    setWinner(detail.winner ?? "");
    setStartDate(detail.start_date ?? "");
    setEndDate(detail.end_date ?? "");
    setLogo(detail.logo ?? "");
    setShirtNumbers(detail.shirt_numbers);
  }, [detail]);

  const save = async () => {
    await api.updateTournament(detail.id, {
      name,
      year,
      host,
      winner: winner.trim() ? winner.trim() : null,
      start_date: startDate.trim() ? startDate.trim() : null,
      end_date: endDate.trim() ? endDate.trim() : null,
      logo: logo.trim() ? logo.trim() : null,
      shirt_numbers: shirtNumbers,
    });
    onClose();
    onSaved();
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="share-modal editor-player-modal" onClick={(e) => e.stopPropagation()}>
        <div className="editor-card editor-grid">
          <div className="editor-field">
            <label>{t("editor.name")}</label>
            <input value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div className="editor-field">
            <label>{t("editor.year")}</label>
            <input type="number" value={year} onChange={(e) => setYear(parseInt(e.target.value) || 0)} />
          </div>
          <div className="editor-field">
            <label>{t("editor.host")}</label>
            <input value={host} onChange={(e) => setHost(e.target.value)} />
          </div>
          <div className="editor-field">
            <label>{t("editor.winner")}</label>
            <input value={winner} onChange={(e) => setWinner(e.target.value)} />
          </div>
          <div className="editor-field">
            <label>{t("editor.startDate")}</label>
            <input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} />
          </div>
          <div className="editor-field">
            <label>{t("editor.endDate")}</label>
            <input type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} />
          </div>
          <div className="editor-field">
            <label>{t("editor.logo")}</label>
            <input value={logo} onChange={(e) => setLogo(e.target.value)} />
          </div>
          <label className="editor-check">
            <input
              type="checkbox"
              checked={shirtNumbers}
              onChange={(e) => setShirtNumbers(e.target.checked)}
            />
            {t("editor.shirtNumbers")}
          </label>
          <button
            className="btn primary"
            disabled={busy || !name.trim() || !year}
            onClick={save}
          >
            {t("editor.save")}
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Phases (replaces phases and wipes fixtures)
// ---------------------------------------------------------------------------

function PhasesEditor({
  tid,
  phases,
  busy,
  onClose,
  onSaved,
}: {
  tid: number;
  phases: Phase[];
  busy: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { t } = useI18n();
  const [rows, setRows] = useState<PhaseDraft[]>([]);

  useEffect(() => {
    setRows(
      phases.map((p) => ({
        key: p.key,
        name: p.name,
        phase_type: p.phase_type,
        group_count: p.group_count,
        entry_teams: p.entry_teams,
      })),
    );
  }, [phases]);

  const save = async () => {
    await api.setPhases(tid, rows);
    onClose();
    onSaved();
  };

  const set = (i: number, patch: Partial<PhaseDraft>) =>
    setRows((r) => r.map((row, j) => (j === i ? { ...row, ...patch } : row)));

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="share-modal editor-player-modal" onClick={(e) => e.stopPropagation()}>
        <div className="editor-card editor-phases">
          <p className="editor-muted">{t("editor.phasesHint")}</p>
          <table className="editor-table">
            <thead>
              <tr>
                <th>{t("editor.phaseKey")}</th>
                <th>{t("editor.name")}</th>
                <th>{t("editor.phaseType")}</th>
                <th>{t("editor.groups")}</th>
                <th>{t("editor.entries")}</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={i}>
                  <td>
                    <input
                      list="editor-phase-keys"
                      value={r.key}
                      onChange={(e) => set(i, { key: e.target.value })}
                    />
                  </td>
                  <td>
                    <input value={r.name} onChange={(e) => set(i, { name: e.target.value })} />
                  </td>
                  <td>
                    <select
                      value={r.phase_type}
                      onChange={(e) => set(i, { phase_type: e.target.value })}
                    >
                      <option value="GROUP">GROUP</option>
                      <option value="KNOCKOUT">KNOCKOUT</option>
                    </select>
                  </td>
                  <td>
                    <input
                      type="number"
                      value={num(r.group_count, "")}
                      onChange={(e) =>
                        set(i, { group_count: e.target.value === "" ? null : parseInt(e.target.value) })
                      }
                    />
                  </td>
                  <td>
                    <input
                      type="number"
                      value={num(r.entry_teams, "")}
                      onChange={(e) =>
                        set(i, { entry_teams: e.target.value === "" ? null : parseInt(e.target.value) })
                      }
                    />
                  </td>
                  <td>
                    <button className="btn" onClick={() => setRows((x) => x.filter((_, j) => j !== i))}>
                      ✕
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <datalist id="editor-phase-keys">
            {PHASE_KEY_SUGGESTIONS.map((k) => (
              <option key={k} value={k} />
            ))}
          </datalist>
          <div className="editor-row">
            <button className="btn" onClick={() => setRows((r) => [...r, { key: "", name: "", phase_type: "KNOCKOUT", group_count: null, entry_teams: null }])}>
              ＋
            </button>
            <button
              className="btn primary"
              disabled={busy || rows.some((r) => !r.key.trim())}
              onClick={save}
            >
              {t("editor.savePhases")}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Participants
// ---------------------------------------------------------------------------

function ParticipantList({
  teams,
  participants,
  busy,
  onAdd,
  onSetGroup,
  onRemove,
}: {
  teams: Team[];
  participants: Participant[];
  busy: boolean;
  onAdd: (list: Array<{ team_id: number; group_letter?: string }>) => void;
  onSetGroup: (teamId: number, group: string | null) => void;
  onRemove: (teamId: number) => void;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [sel, setSel] = useState<number | "">("");
  const [group, setGroup] = useState("");

  const inCup = useMemo(() => new Set(participants.map((p) => p.id)), [participants]);
  const available = useMemo(() => teams.filter((tm) => !inCup.has(tm.id)), [teams, inCup]);

  const add = () => {
    if (sel === "") return;
    onAdd([{ team_id: sel, group_letter: group.trim() || undefined }]);
    setSel("");
    setGroup("");
  };

  return (
    <div className="editor-inline">
      <button className="btn" onClick={() => setOpen((o) => !o)}>
        {open ? t("editor.cancel") : t("editor.participants")}
      </button>
      {open && (
        <div className="modal-backdrop" onClick={() => setOpen(false)}>
          <div className="share-modal editor-player-modal" onClick={(e) => e.stopPropagation()}>
            <div className="editor-card">
          {participants.length === 0 && <p className="editor-muted">{t("editor.noParticipants")}</p>}
          <table className="editor-table">
            <thead>
              <tr>
                <th>{t("editor.team")}</th>
                <th>{t("editor.group")}</th>
                <th>{t("editor.rating")}</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {participants.map((p) => (
                <tr key={p.id}>
                  <td>
                    {p.flag} {p.name} <span className="editor-muted">({p.code ?? "—"})</span>
                  </td>
                  <td>
                    <select
                      value={p.group_letter ?? ""}
                      disabled={busy}
                      onChange={(e) => onSetGroup(p.id, e.target.value || null)}
                    >
                      <option value="">—</option>
                      {Array.from({ length: 26 }, (_, i) => (
                        <option key={i} value={String.fromCharCode(65 + i)}>
                          {String.fromCharCode(65 + i)}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td>{p.rating}</td>
                  <td>
                    <button className="btn" disabled={busy} onClick={() => onRemove(p.id)}>
                      ✕
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="editor-row">
            <select value={sel} onChange={(e) => setSel(e.target.value === "" ? "" : parseInt(e.target.value))}>
              <option value="">{t("editor.selectTeam")}</option>
              {available.map((tm) => (
                <option key={tm.id} value={tm.id}>
                  {tm.flag} {tm.name}
                </option>
              ))}
            </select>
            <input
              placeholder={t("editor.group")}
              value={group}
              onChange={(e) => setGroup(e.target.value.toUpperCase())}
            />
            <button className="btn primary" disabled={busy || sel === ""} onClick={add}>
              ＋
            </button>
            </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Teams: create (done inline above), edit / delete list
// ---------------------------------------------------------------------------

function TeamEditList({
  teams,
  busy,
  onRefresh,
  participants,
  onChanged,
}: {
  teams: Team[];
  busy: boolean;
  onRefresh: () => Promise<void>;
  participants: Participant[];
  onChanged: () => void;
}) {
  const { t } = useI18n();
  const [editing, setEditing] = useState<Team | null>(null);
  const [draft, setDraft] = useState<Team | null>(null);

  useEffect(() => setDraft(editing), [editing]);

  const save = async () => {
    if (!editing || !draft) return;
    await api.updateTeam(editing.id, {
      name: draft.name,
      code: draft.code,
      flag: draft.flag,
      rating: draft.rating,
      pedigree: draft.pedigree,
      home_support: draft.home_support,
      form: draft.form,
      morale: draft.morale,
    });
    setEditing(null);
    await onRefresh();
    onChanged();
  };

  const del = async (tm: Team) => {
    if (!confirm(t("editor.confirmDeleteTeam"))) return;
    await api.deleteTeam(tm.id);
    await onRefresh();
    onChanged();
  };

  if (teams.length === 0) return null;

  return (
    <div>
      <table className="editor-table">
        <thead>
          <tr>
            <th>{t("editor.team")}</th>
            <th>{t("editor.rating")}</th>
            <th>{t("editor.stat.pedigree")}</th>
            <th>{t("editor.stat.homeSupport")}</th>
            <th>{t("editor.stat.form")}</th>
            <th>{t("editor.stat.morale")}</th>
            <th>{t("editor.inCup")}</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {teams.map((tm) => {
            const inCup = participants.some((p) => p.id === tm.id);
            return (
              <tr key={tm.id}>
                <td>
                  {tm.flag} {tm.name} <span className="editor-muted">({tm.code ?? "—"})</span>
                </td>
                <td>{tm.rating}</td>
                <td>{tm.pedigree}</td>
                <td>{tm.home_support}</td>
                <td>{tm.form}</td>
                <td>{tm.morale}</td>
                <td>{inCup ? "✓" : "—"}</td>
                <td className="editor-nowrap">
                  <button className="btn" disabled={busy} onClick={() => setEditing(tm)}>
                    {t("editor.edit")}
                  </button>{" "}
                  <button className="btn" disabled={busy} onClick={() => del(tm)}>
                    ✕
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>

      {editing && draft && (
        <div className="modal-backdrop" onClick={() => setEditing(null)}>
          <div className="share-modal editor-player-modal" onClick={(e) => e.stopPropagation()}>
            <div className="editor-card editor-grid">
          <div className="editor-field">
            <label>{t("editor.name")}</label>
            <input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
          </div>
          <div className="editor-field">
            <label>{t("editor.code")}</label>
            <input value={draft.code ?? ""} onChange={(e) => setDraft({ ...draft, code: e.target.value || null })} />
          </div>
          <div className="editor-field">
            <label>{t("editor.flag")}</label>
            <input value={draft.flag ?? ""} onChange={(e) => setDraft({ ...draft, flag: e.target.value || null })} />
          </div>
          {(["rating", "pedigree", "home_support", "form", "morale"] as const).map((k) => (
            <div className="editor-field" key={k}>
              <label>{t(`editor.stat.${k}`)}</label>
              <input
                type="number"
                min={0}
                max={99}
                value={draft[k]}
                onChange={(e) => setDraft({ ...draft, [k]: parseInt(e.target.value) || 0 })}
              />
            </div>
          ))}
          <div className="editor-row">
            <button className="btn primary" disabled={busy} onClick={save}>
              {t("editor.save")}
            </button>
            <button className="btn" onClick={() => setEditing(null)}>
              {t("editor.cancel")}
            </button>
            </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Team create form
// ---------------------------------------------------------------------------

function TeamForm({
  busy,
  onCreated,
}: {
  busy: boolean;
  onCreated: () => void | Promise<void>;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [code, setCode] = useState("");
  const [flag, setFlag] = useState("");
  const [rating, setRating] = useState(70);

  const save = async () => {
    await api.createTeam({ name, code: code.trim() || null, flag: flag.trim() || null, rating });
    setName("");
    setCode("");
    setFlag("");
    setOpen(false);
    await onCreated();
  };

  return (
    <div className="editor-inline">
      <button className="btn" onClick={() => setOpen((o) => !o)}>
        {open ? t("editor.cancel") : "＋ " + t("editor.newTeam")}
      </button>
      {open && (
        <div className="modal-backdrop" onClick={() => setOpen(false)}>
          <div className="share-modal editor-player-modal" onClick={(e) => e.stopPropagation()}>
            <div className="editor-card editor-grid">
          <div className="editor-field">
            <label>{t("editor.name")}</label>
            <input value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div className="editor-field">
            <label>{t("editor.code")}</label>
            <input value={code} onChange={(e) => setCode(e.target.value)} />
          </div>
          <div className="editor-field">
            <label>{t("editor.flag")}</label>
            <input value={flag} onChange={(e) => setFlag(e.target.value)} />
          </div>
          <div className="editor-field">
            <label>{t("editor.rating")}</label>
            <input type="number" min={0} max={99} value={rating} onChange={(e) => setRating(parseInt(e.target.value) || 0)} />
          </div>
          <button className="btn primary" disabled={busy || !name.trim()} onClick={save}>
            {t("editor.create")}
          </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function MatchList({
  matches,
  participants,
  stageSuggestions,
  busy,
  onAdd,
  onEdit,
  onDelete,
}: {
  matches: DbMatch[];
  participants: Participant[];
  stageSuggestions: string[];
  busy: boolean;
  onAdd: (list: CreateMatch[]) => void;
  onEdit: (id: number, data: CreateMatch) => void;
  onDelete: (id: number) => void;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [showAdd, setShowAdd] = useState(false);
  // add form
  const [stage, setStage] = useState("GROUP");
  const [roundNum, setRoundNum] = useState(1);
  const [matchday, setMatchday] = useState(1);
  const [home, setHome] = useState<number | "">("");
  const [away, setAway] = useState<number | "">("");
  const [kickoff, setKickoff] = useState("");
  // edit form
  const [editingMatch, setEditingMatch] = useState<DbMatch | null>(null);

  const add = () => {
    if (home === "" || away === "") return;
    onAdd([
      {
        stage,
        round_num: roundNum,
        matchday: matchday || null,
        home_team_id: home,
        away_team_id: away,
        kickoff: kickoff.trim() || null,
      },
    ]);
    setShowAdd(false);
    setStage("GROUP");
    setRoundNum(1);
    setMatchday(1);
    setHome("");
    setAway("");
    setKickoff("");
  };

  const startEdit = (m: DbMatch) =>
    setEditingMatch({
      ...m,
      stage: m.stage,
      round_num: m.round_num,
      matchday: m.matchday,
      home_team_id: m.home_team_id,
      away_team_id: m.away_team_id,
      kickoff: m.kickoff ?? "",
    });

  return (
    <>
      <button className="btn" onClick={() => setOpen(true)}>
        {t("editor.matches")}
      </button>

      {open && (
        <div className="modal-backdrop" onClick={() => setOpen(false)}>
          <div
            className="share-modal editor-player-modal editor-matches-modal"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="editor-card editor-phases">
              <div className="editor-row">
                <button className="btn" disabled={busy} onClick={() => setShowAdd(true)}>
                  ＋ {t("editor.addMatch")}
                </button>
                <span className="editor-muted">{matches.length} · {t("editor.matches")}</span>
              </div>
              {matches.length === 0 ? (
                <p className="editor-muted">{t("editor.noFixtures")}</p>
              ) : (
                <table className="editor-table">
                  <thead>
                    <tr>
                      <th>{t("editor.stage")}</th>
                      <th>{t("editor.md")}</th>
                      <th>{t("editor.home")}</th>
                      <th></th>
                      <th>{t("editor.away")}</th>
                      <th>{t("editor.score")}</th>
                      <th>{t("editor.status")}</th>
                      <th></th>
                    </tr>
                  </thead>
                  <tbody>
                    {matches.map((m) => (
                      <tr key={m.id}>
                        <td>{m.stage}</td>
                        <td>{m.matchday ?? "—"}</td>
                        <td>{m.home_team_name}</td>
                        <td className="editor-muted">—</td>
                        <td>{m.away_team_name}</td>
                        <td>
                          {m.home_score === null ? "–" : `${m.home_score}–${m.away_score}`}
                        </td>
                        <td>{m.status}</td>
                        <td className="editor-nowrap">
                          <button className="btn" disabled={busy} onClick={() => startEdit(m)}>
                            {t("editor.edit")}
                          </button>{" "}
                          <button className="btn" disabled={busy} onClick={() => onDelete(m.id)}>
                            ✕
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </div>
        </div>
      )}

      {showAdd && (
        <div className="modal-backdrop" onClick={() => setShowAdd(false)}>
          <div
            className="share-modal editor-player-modal"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="editor-card editor-grid">
              <div className="editor-field">
                <label>{t("editor.stage")}</label>
                <InputList placeholder={t("editor.stage")} value={stage} onChange={setStage} suggestions={stageSuggestions} />
              </div>
              <div className="editor-field">
                <label>{t("editor.roundNum")}</label>
                <input type="number" min={1} className="editor-small" value={roundNum} onChange={(e) => setRoundNum(parseInt(e.target.value) || 1)} />
              </div>
              <div className="editor-field">
                <label>{t("editor.md")}</label>
                <input type="number" min={1} className="editor-small" value={matchday} onChange={(e) => setMatchday(parseInt(e.target.value) || 0)} />
              </div>
              <div className="editor-field">
                <label>{t("editor.home")}</label>
                <select value={home} onChange={(e) => setHome(e.target.value === "" ? "" : parseInt(e.target.value))}>
                  <option value="">{t("editor.home")}</option>
                  {participants.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </div>
              <div className="editor-field">
                <label>{t("editor.away")}</label>
                <select value={away} onChange={(e) => setAway(e.target.value === "" ? "" : parseInt(e.target.value))}>
                  <option value="">{t("editor.away")}</option>
                  {participants.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </div>
              <div className="editor-field">
                <label>{t("editor.kickoff")}</label>
                <input placeholder={t("editor.kickoff")} value={kickoff} onChange={(e) => setKickoff(e.target.value)} />
              </div>
              <div className="editor-row">
                <button className="btn primary" disabled={busy || home === "" || away === ""} onClick={add}>
                  {t("editor.addMatch")}
                </button>
                <button className="btn" onClick={() => setShowAdd(false)}>
                  {t("editor.cancel")}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {editingMatch && (
        <div className="modal-backdrop" onClick={() => setEditingMatch(null)}>
          <div
            className="share-modal editor-player-modal"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="editor-card editor-grid">
              <div className="editor-field">
                <label>{t("editor.stage")}</label>
                <input
                  list="editor-phase-keys"
                  value={editingMatch.stage}
                  onChange={(e) => setEditingMatch({ ...editingMatch, stage: e.target.value })}
                />
              </div>
              <div className="editor-field">
                <label>{t("editor.roundNum")}</label>
                <input
                  type="number"
                  min={0}
                  value={editingMatch.round_num}
                  onChange={(e) => setEditingMatch({ ...editingMatch, round_num: parseInt(e.target.value) || 0 })}
                />
              </div>
              <div className="editor-field">
                <label>{t("editor.md")}</label>
                <input
                  type="number"
                  min={0}
                  value={num(editingMatch.matchday, "")}
                  onChange={(e) => setEditingMatch({ ...editingMatch, matchday: e.target.value === "" ? null : parseInt(e.target.value) })}
                />
              </div>
              <div className="editor-field">
                <label>{t("editor.home")}</label>
                <select
                  value={editingMatch.home_team_id}
                  onChange={(e) => setEditingMatch({ ...editingMatch, home_team_id: parseInt(e.target.value) })}
                >
                  {participants.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </div>
              <div className="editor-field">
                <label>{t("editor.away")}</label>
                <select
                  value={editingMatch.away_team_id}
                  onChange={(e) => setEditingMatch({ ...editingMatch, away_team_id: parseInt(e.target.value) })}
                >
                  {participants.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </div>
              <div className="editor-field">
                <label>{t("editor.kickoff")}</label>
                <input
                  value={editingMatch.kickoff ?? ""}
                  onChange={(e) => setEditingMatch({ ...editingMatch, kickoff: e.target.value || null })}
                />
              </div>
              <div className="editor-field">
                <p className="editor-muted">
                  {t("editor.score")}: {editingMatch.home_score === null ? "–" : `${editingMatch.home_score}–${editingMatch.away_score}`} · {editingMatch.status}
                </p>
              </div>
              <div className="editor-row">
                <button
                  className="btn primary"
                  disabled={busy}
                  onClick={() => {
                    onEdit(editingMatch.id, {
                      stage: editingMatch.stage,
                      round_num: editingMatch.round_num,
                      matchday: editingMatch.matchday,
                      home_team_id: editingMatch.home_team_id,
                      away_team_id: editingMatch.away_team_id,
                      kickoff: editingMatch.kickoff,
                    });
                    setEditingMatch(null);
                  }}
                >
                  {t("editor.save")}
                </button>
                <button className="btn" onClick={() => setEditingMatch(null)}>
                  {t("editor.cancel")}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

function InputList({
  value,
  onChange,
  placeholder,
  suggestions,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
  suggestions: string[];
}) {
  return (
    <>
      <input
        list="editor-stage-list"
        placeholder={placeholder}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
      <datalist id="editor-stage-list">
        {suggestions.map((s) => (
          <option key={s} value={s} />
        ))}
      </datalist>
    </>
  );
}

// ---------------------------------------------------------------------------
// Squads
// ---------------------------------------------------------------------------

const posTokenCell = (p: Player): string => {
  const i = (p.position ?? "").indexOf(":");
  return i < 0 ? p.position : p.position.slice(0, i);
};

const positionsCell = (p: Player): string =>
  (p.positions ?? []).length === 0
    ? "—"
    : (p.positions ?? [])
        .map((item) => {
          const { position, family } = parsePosItem(item);
          return family >= 100 ? position : `${position} ${family}%`;
        })
        .join(" · ");

function PlayersEditor({
  participants,
  tid,
  busy,
}: {
  participants: Participant[];
  tid: number;
  busy: boolean;
}) {
  const { t } = useI18n();
  const [teamId, setTeamId] = useState<number | null>(null);
  const [players, setPlayers] = useState<Player[]>([]);
  const [editing, setEditing] = useState<Player | "new" | null>(null);
  const [confirmDel, setConfirmDel] = useState<Player | null>(null);

  const refreshScoped = useCallback(async (id: number) => {
    setPlayers(await api.players(id, tid));
  }, [tid]);

  useEffect(() => {
    if (teamId !== null) void refreshScoped(teamId);
    else setPlayers([]);
  }, [teamId, refreshScoped]);

  const del = async () => {
    if (!confirmDel || teamId === null) return;
    await api.deletePlayer(teamId, confirmDel.id, tid);
    setConfirmDel(null);
    await refreshScoped(teamId);
  };

  return (
    <div className="editor-inline">
      <select
        className="editor-team-select"
        value={teamId ?? ""}
        onChange={(e) => setTeamId(e.target.value === "" ? null : parseInt(e.target.value))}
      >
        <option value="">{t("editor.selectTeam")}</option>
        {participants.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name}
          </option>
        ))}
      </select>

      {teamId !== null && (
        <>
          <button className="btn" onClick={() => setEditing("new")}>
            {editing ? t("editor.cancel") : "＋ " + t("editor.newPlayer")}
          </button>

          <table className="editor-table editor-players">
            <thead>
              <tr>
                <th className="editor-th-photo"></th>
                <th>#</th>
                <th>{t("editor.player")}</th>
                <th>{t("editor.position")}</th>
                <th>{t("editor.overall")}</th>
                <th>{t("editor.positions2")}</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {players.map((p) => (
                <tr key={p.id}>
                  <td className="editor-td-photo">
                    {p.photo_url ? (
                      <img className="editor-list-photo" src={p.photo_url} alt="" onError={(e) => ((e.target as HTMLImageElement).style.display = "none")} />
                    ) : (
                      <span className="editor-list-photo editor-photo-fallback" aria-hidden>
                        <svg viewBox="0 0 24 24" width="16" height="16">
                          <circle cx="12" cy="8" r="4.5" fill="currentColor" opacity="0.85" />
                          <path
                            d="M3.5 20.5c1.4-4.2 4.6-6 8.5-6s7.1 1.8 8.5 6"
                            fill="currentColor"
                            opacity="0.85"
                          />
                        </svg>
                      </span>
                    )}
                  </td>
                  <td>{p.shirt_number ?? "—"}</td>
                  <td>{p.name}</td>
                  <td>{posTokenCell(p)}</td>
                  <td>{Math.round(p.overall)}</td>
                  <td className="editor-muted">{positionsCell(p)}</td>
                  <td className="editor-nowrap">
                    <button className="btn" disabled={busy} onClick={() => setEditing(p)}>
                      {t("editor.edit")}
                    </button>{" "}
                    <button className="btn" disabled={busy} onClick={() => setConfirmDel(p)}>
                      ✕
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          {confirmDel && (
            <div className="modal-backdrop" onClick={() => setConfirmDel(null)}>
              <div className="share-modal editor-player-modal" onClick={(e) => e.stopPropagation()}>
                <p>{t("editor.confirmDeletePlayer", { name: confirmDel.name })}</p>
                <div className="editor-row">
                  <button className="btn" onClick={() => setConfirmDel(null)}>
                    {t("editor.cancel")}
                  </button>
                  <button className="btn danger" onClick={() => void del()}>
                    {t("editor.delete")}
                  </button>
                </div>
              </div>
            </div>
          )}

          {editing && (
            <div className="modal-backdrop" onClick={() => setEditing(null)}>
              <div className="share-modal editor-player-modal" onClick={(e) => e.stopPropagation()}>
                <PlayerForm
                  tid={tid}
                  participant={participants.find((p) => p.id === teamId)}
                  player={editing === "new" ? null : editing}
                  onDone={async () => {
                    setEditing(null);
                    await refreshScoped(teamId);
                  }}
                />
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function PlayerForm({
  tid,
  participant,
  player,
  onDone,
}: {
  tid: number;
  participant: Participant | undefined;
  player: Player | null;
  onDone: () => void;
}) {
  const { t } = useI18n();
  const [photoErr, setPhotoErr] = useState(false);
  const [bias, setBias] = useState(5);
  const [posRows, setPosRows] = useState<PositionFamiliarity[]>(() =>
    player
      ? (player.positions?.length
          ? player.positions
          : player.position
            ? [player.position]
            : []
        ).map(parsePosItem)
      : [{ position: emptyDraft.position, family: 100 }],
  );
  const [draft, setDraft] = useState<PlayerDraft>(() =>
    player
      ? {
          name: player.name,
          position: player.position,
          positions: player.positions ?? [],
          photo_url: player.photo_url ?? null,
          shirt_number: player.shirt_number ?? null,
          pace: player.pace ?? 60,
          stamina: player.stamina ?? 60,
          strength: player.strength ?? 60,
          dribbling: player.dribbling ?? 60,
          passing: player.passing ?? 60,
          shooting: player.shooting ?? 60,
          tackling: player.tackling ?? 60,
          vision: player.vision ?? 60,
          positioning: player.positioning ?? 60,
          composure: player.composure ?? 60,
          reflexes: player.reflexes ?? 60,
          handling: player.handling ?? 60,
          kicking: player.kicking ?? 60,
          aerial: player.aerial ?? 60,
          decisions: player.decisions ?? 60,
          aggression: player.aggression ?? 60,
          concentration: player.concentration ?? 60,
          leadership: player.leadership ?? 60,
        }
      : { ...emptyDraft },
  );

  const save = async () => {
    const payload: PlayerDraft = {
      ...draft,
      position: posRows[0]?.position ?? "",
      positions: posRows.map(encodePos),
    };
    if (!participant) return;
    if (player) {
      await api.updatePlayer(participant.id, player.id, tid, payload);
    } else {
      await api.createPlayers(participant.id, tid, [payload]);
    }
    onDone();
  };

  const setAttr = (k: AttrKey, v: number) => setDraft((d) => ({ ...d, [k]: v }));

  const randomize = (level: number, b = bias) =>
    setDraft((d) => ({ ...d, ...randomForPosition(posRows[0]?.position ?? "CM", b, level) }));

  const updPos = (i: number, patch: Partial<PositionFamiliarity>) =>
    setPosRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)));

  const addPos = () =>
    setPosRows((rs) => {
      const used = new Set(rs.map((r) => r.position));
      const free = POSITIONS.find((p) => !used.has(p)) ?? "CM";
      return [...rs, { position: free, family: 100 }];
    });

  const onFile = (e: ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (!f) return;
    const reader = new FileReader();
    reader.onload = () => {
      void api
        .uploadPhoto(reader.result as string)
        .then((url) => {
          setPhotoErr(false);
          setDraft({ ...draft, photo_url: url });
        })
        .catch(() => setPhotoErr(true));
    };
    reader.readAsDataURL(f);
  };

  return (
    <div className="editor-card editor-player-form">
      <div className="editor-row">
        <div className="editor-field">
          <label>{t("editor.player")}</label>
          <input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
        </div>
        <div className="editor-field editor-field-wide">
          <label>{t("editor.positions2")}</label>
          <div className="editor-pos-list">
            {posRows.map((r, i) => (
              <div className="editor-pos-row" key={i}>
                {i === 0 && <span className="editor-pos-flag">{t("editor.main")}</span>}
                <select
                  value={r.position}
                  onChange={(e) => updPos(i, { position: e.target.value })}
                >
                  {POSITIONS.map((p) => (
                    <option key={p} value={p}>
                      {p}
                    </option>
                  ))}
                </select>
                <span className="editor-attr-val">{r.family}%</span>
                <input
                  className="editor-fam-slider"
                  type="range"
                  min={50}
                  max={100}
                  value={r.family}
                  onChange={(e) => updPos(i, { family: parseInt(e.target.value) })}
                />
                {i > 0 && (
                  <button
                    className="btn"
                    title={t("editor.removePosition")}
                    onClick={() => setPosRows((rs) => rs.filter((_, j) => j !== i))}
                  >
                    ✕
                  </button>
                )}
              </div>
            ))}
          </div>
          <div className="editor-row">
            <button
              className="btn"
              disabled={posRows.length >= POSITIONS.length}
              onClick={addPos}
            >
              ＋ {t("editor.addPosition")}
            </button>
            <span className="editor-muted">{t("editor.famHint")}</span>
          </div>
        </div>
        <div className="editor-field">
          <label>{t("editor.shirt")}</label>
          <input
            type="number"
            min={0}
            value={num(draft.shirt_number, "")}
            onChange={(e) =>
              setDraft({ ...draft, shirt_number: e.target.value === "" ? null : parseInt(e.target.value) })
            }
          />
        </div>
        <div className="editor-field">
          <label>{t("editor.photo")}</label>
          <div className="editor-photo-row">
            {draft.photo_url && !photoErr ? (
              <img
                className="editor-photo-preview"
                src={draft.photo_url}
                alt=""
                onError={() => setPhotoErr(true)}
              />
            ) : (
              <span className="editor-photo-preview editor-photo-fallback" aria-hidden>
                <svg viewBox="0 0 24 24" width="20" height="20">
                  <circle cx="12" cy="8" r="4.5" fill="currentColor" opacity="0.85" />
                  <path
                    d="M3.5 20.5c1.4-4.2 4.6-6 8.5-6s7.1 1.8 8.5 6"
                    fill="currentColor"
                    opacity="0.85"
                  />
                </svg>
              </span>
            )}
            <input type="file" accept="image/*" onChange={onFile} />
            <span className="editor-muted">{t("editor.photoUploadHint")}</span>
            {draft.photo_url && (
              <button
                className="btn"
                title={t("editor.photoClear")}
                onClick={() => {
                  setPhotoErr(false);
                  setDraft({ ...draft, photo_url: null });
                }}
              >
                ✕
              </button>
            )}
          </div>
        </div>
      </div>
      <div className="editor-random-row">
        <label>
          {t("editor.randomBias")} <span className="editor-attr-val">{bias}</span>
        </label>
        <input
          type="range"
          min={0}
          max={10}
          value={bias}
          onChange={(e) => setBias(parseInt(e.target.value))}
        />
        <button className="btn" onClick={() => randomize(0)}>
          {t("editor.randomize")}
        </button>
        <button className="btn" onClick={() => randomize(12, 10)}>
          {t("editor.star")}
        </button>
        <button className="btn" onClick={() => randomize(-8)}>
          {t("editor.squad")}
        </button>
        <span className="editor-muted">{t("editor.randomBiasHint", { pos: posRows[0]?.position ?? "" })}</span>
      </div>
      <div className="editor-attr-grid">
        {ATTRIBUTES.map((a) => (
          <div className="editor-field" key={a}>
            <label>
              {t(`editor.attr.${a}`)}
              <span className="editor-attr-val">{draft[a]}</span>
            </label>
            <input
              type="range"
              min={1}
              max={99}
              value={draft[a]}
              onChange={(e) => setAttr(a, parseInt(e.target.value))}
            />
          </div>
        ))}
      </div>
      <div className="editor-row">
        <button
          className="btn primary"
          disabled={!draft.name.trim()}
          onClick={save}
        >
          {t("editor.save")}
        </button>
        <button className="btn" onClick={onDone}>
          {t("editor.cancel")}
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// JSON import
// ---------------------------------------------------------------------------

function ImportPanel({
  tid,
  busy,
  onDone,
}: {
  tid: number;
  busy: boolean;
  onDone: (n: number) => void;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [err, setErr] = useState<string | null>(null);

  const run = async () => {
    setErr(null);
    try {
      const parsed = JSON.parse(text);
      if (!parsed || !Array.isArray(parsed.teams))
        throw new Error(t("editor.importBad"));
      const n = await api.importTournament(tid, parsed);
      onDone(n);
      setText("");
    } catch (e) {
      setErr(String(e));
    }
  };

  return (
    <div className="editor-inline">
      <button className="btn" onClick={() => setOpen((o) => !o)}>
        {open ? t("editor.cancel") : t("editor.importJson")}
      </button>
      {open && (
        <div className="editor-card">
          <p className="editor-muted">{t("editor.importHint")}</p>
          <textarea
            rows={8}
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder='{ "teams": [ { "name": "Iceland", "rating": 78, "group_letter": "A", "players": [ { "name": "A. Gudjohnsen", "position": "ST", "rating": 82 } ] } ] }'
          />
          {err && <p className="editor-banner editor-error">{err}</p>}
          <button className="btn primary" disabled={busy || !text.trim()} onClick={run}>
            {t("editor.import")}
          </button>
        </div>
      )}
    </div>
  );
}