import { createContext, useContext, useEffect, useMemo, useState } from "react";

export type Locale = "en" | "es";

const STORAGE_KEY = "wcs_locale";

export type Vars = Record<string, string | number>;

export interface I18n {
  locale: Locale;
  setLocale: (l: Locale) => void;
  t: (key: string, vars?: Vars) => string;
  stage: (name: string, vars?: Vars) => string;
  /** Localise a country/team name (e.g. "Brazil" → "Brasil" in es). */
  country: (name: string) => string;
  /** Localise a position abbreviation, normalising it to the canonical set
   *  (GK, RDF, DF, LDF, DMF, RMF, LMF, AMF, RFW, FW, LFW) first. */
  pos: (code: string) => string;
}

const en: Record<string, string> = {
  "app.brand": "World Cup Simulator",
  "step.worldcup": "World Cup",
  "step.team": "Team",
  "step.squad": "Squad",
  "step.tournament": "Tournament",
  "step.match": "Match",
  "step.ceremonies": "Ceremonies",
  "step.history": "History",
  "app.signedin": "Signed in",
  "app.noMatchOpen": "No match open. Back to the tournament.",

  "choose.title": "Choose your World Cup",
  "choose.hint":
    "Every edition from 1930 (Uruguay) through 2026 (USA · Mexico · Canada).",
  "choose.loading": "Loading tournaments…",
  "choose.error": "Cannot reach the backend:",
  "choose.winner": "Winner: {name}",
  "choose.winnerPending": "Winner pending ({year})",
  "choose.era": "World Cup {year}",

  "team.title": "{year} — pick your nation",
  "team.hint":
    "Take the touchline for any team in the {year} World Cup. Your nation's matches get live momentum charts as they happen.",
  "team.loading": "Loading participants…",
  "team.empty": "No participants loaded for {year} yet.",
  "team.neutral": "Watch as a spectator",

  "squad.title": "— squad",
  "squad.hint": "{year} · {count} players listed",
  "squad.avg": "average",
  "squad.back": "← another team",
  "squad.loading": "Loading squad…",
  "squad.empty": "No squad list for this team.",
  "squad.start": "Start the World Cup →",
  "pos.GK": "Goalkeepers",
  "pos.DF": "Defenders",
  "pos.MF": "Midfielders",
  "pos.FW": "Forwards",

  "lineup.title": "— pre-match setup",
  "lineup.subtitle": "Matchday {day} · {stage} · vs {opponent}",
  "lineup.formation": "Formation",
  "lineup.strategy": "Strategy",
  "lineup.slots": "Starting XI — one player per slot",
  "lineup.pick": "— pick a player —",
  "lineup.players": "Players",
  "lineup.auto": "⚡ Auto-pick best XI",
  "lineup.confirm": "Save lineup & play →",
  "lineup.cancel": "← overview",
  "lineup.hint": "Out-of-position players take a rating penalty shown in the list.",
  "lineup.ready": "Lineup complete — go play it!",
  "lineup.pen": "{n} rating",
  "lineup.armFirst": "Pick a player, then tap a pulsing slot",
  "lineup.place": "Place {player} here",
  "lineup.notThere": "{player} can't play this post",
  "lineup.dblClear": "double-click to clear",
  "lineup.picked": "in XI",
  "lineup.suspended": "banned",
  "lineup.tapSlot": "Now tap a pulsing slot on the pitch",
  "strategy.defensive": "Defensive",
  "abbr.GK": "GK",
  "abbr.RDF": "RDF",
  "abbr.DF": "DF",
  "abbr.LDF": "LDF",
  "abbr.DMF": "DMF",
  "abbr.RMF": "RMF",
  "abbr.LMF": "LMF",
  "abbr.AMF": "AMF",
  "abbr.RFW": "RFW",
  "abbr.FW": "FW",
  "abbr.LFW": "LFW",
  "strategy.normal": "Normal",
  "strategy.attacking": "Attacking",

  "cup.title": "{year} · {host} World Cup",
  "cup.managing": "You are managing the tournament live.",
  "cup.neutral": "Neutral view — no team in the dugout.",
  "cup.revealed": "Matchday {day} · {revealed}/{total} revealed",
  "cup.startHint": "The draw is ready — time to kick off.",
  "cup.start": "Start the tournament",
  "cup.retry": "Retry",
  "cup.startError": "Could not start the tournament: {msg}",
  "cup.playDay1": "Play matchday 1",
  "cup.playDay": "Play matchday {day}",
  "cup.playAll": "Play all",
  "cup.ff": "▶▶ Play to my match",
  "cup.jump": "⚡ Jump to your match",
  "cup.ceremonies": "🏆 Ceremonies →",
  "cup.skipCeremonies": "Skip to ceremonies →",
  "cup.champion": "{team} are champions!",
  "cup.team": "Team",
  "cup.p": "P",
  "cup.w": "W",
  "cup.d": "D",
  "cup.l": "L",
  "cup.gf": "GF",
  "cup.ga": "GA",
  "cup.gd": "GD",
  "cup.pts": "Pts",
  "cup.bracket": "Bracket",
  "cup.scorers": "Top scorers",
  "cup.assisters": "Top assister",
  "cup.recent": "Recent results",
  "cup.complete": "· tournament complete",
  "cup.noMatches": "No matches played yet.",
  "cup.noResults": "No matches played yet.",
  "cup.noteAet": "AET",
  "cup.notePens": "Pens",
  "hub.play": "Play",
  "hub.simulate": "Simulate",
  "hub.ff": "Fast forward",
  "hub.ffStop": "Stop",
  "hub.viewResult": "View incidents",
  "hub.playDisabled": "Pick your formation below to unlock Play",
  "hub.championTitle": "{team} are World Champions!",
  "hub.championSub": "Podium, top scorers and best players.",
  "hub.championShare": "Share",
  "hub.formation": "Your squad",
  "hub.p1": "Start",
  "hub.pEnd": "End",

  "stage.group": "Group",
  "stage.final": "Final",
  "stage.semi": "Semi-final",
  "stage.quarter": "Quarter-final",
  "stage.r16": "Round of 16",
  "stage.r32": "Round of 32",
  "stage.r8": "Round of 8",
  "stage.third": "Third place",

  "match.day": "Matchday {day}",
  "match.aet": "after extra time",
  "match.pens": "penalties",
  "match.momentum": "{team} momentum",
  "match.ht": "HT",
  "match.ft": "FT",
  "match.etShort": "ET",
  "match.assist": "assist {name}",
  "match.pensScore": "Pens {home}–{away}",
  "match.ownGoal": "OG",
  "match.currentMomentum": "Current momentum",
  "match.close": "Close",

  "share.title": "{year} World Cup",
  "share.host": "Host: {host}",
  "share.yourPos": "Your team: {pos}",
  "share.bestPlayers": "Best players",
  "share.bestScorer": "Top scorers",
  "share.bestAssists": "Top assister",
  "share.pos.1": "Champions",
  "share.pos.2": "Runners-up",
  "share.pos.3": "Third place",
  "share.pos.4": "Fourth place",
  "share.pos.group": "out in the group stage",
  "share.pos.1732": "last 32",
  "share.pos.916": "last 16",
  "share.pos.58": "quarter-finals",
  "share.share": "Share",
  "share.sharing": "Preparing…",
  "share.playAgain": "🔁 Play it again",
  "share.close": "Close",

  "final.title": "{year} World Cup — {host}",
  "final.hint": "Final celebrations and awards.",
  "final.champions": "World Champions · {year}",
  "final.golden": "Golden Ball",
  "final.silver": "Silver Ball",
  "final.bronze": "Bronze Ball",
  "final.apps": "{count} apps · {goals} goals · {assists} assists",
  "final.score": "score {score}",
  "final.boot": "Golden Boot race — final",
  "final.player": "Player",
  "final.team": "Team",
  "final.pos": "Pos",
  "final.goals": "Goals",
  "final.assists": "Assists",
  "final.saved": "Run saved · history #{id}",
  "final.notSaved": "Not saved (sign in to keep a history)",
  "final.replay": "🔁 Play it again",
  "final.history": "History",
  "final.home": "New tournament",

  "history.title": "Your saved runs",
  "history.hint":
    "Every signed-in cup gets archived here so you can relive it.",
  "history.back": "Back to the cup",
  "history.loading": "Loading history…",
  "history.empty":
    "No runs saved yet. Play a tournament while signed in and it will show up here.",
  "history.relive": "Relive",
  "history.opening": "Loading…",
};

const es: Record<string, string> = {
  "app.brand": "Simulador de Mundial",
  "step.worldcup": "Mundial",
  "step.team": "Equipo",
  "step.squad": "Plantel",
  "step.tournament": "Torneo",
  "step.match": "Partido",
  "step.ceremonies": "Ceremonias",
  "step.history": "Historial",
  "app.signedin": "Conectado",
  "app.noMatchOpen": "No hay ningún partido abierto. Volver al torneo.",

  "choose.title": "Elige tu Mundial",
  "choose.hint":
    "Todas las ediciones, de 1930 (Uruguay) a 2026 (EE. UU. · México · Canadá).",
  "choose.loading": "Cargando torneos…",
  "choose.error": "No se puede contactar con el servidor:",
  "choose.winner": "Campeón: {name}",
  "choose.winnerPending": "Campeón por decidir ({year})",
  "choose.era": "Mundial {year}",

  "team.title": "{year} — elige a tu selección",
  "team.hint":
    "Siéntate en el banquillo de cualquier equipo del Mundial {year}. Los partidos de tu selección añaden gráficos de dominio durante el partido.",
  "team.loading": "Cargando participantes…",
  "team.empty": "Todavía no hay participantes cargados para {year}.",
  "team.neutral": "Ver como espectador",

  "squad.title": "— plantel",
  "squad.hint": "{year} · {count} jugadores convocados",
  "squad.avg": "media",
  "squad.back": "← otra selección",
  "squad.loading": "Cargando plantel…",
  "squad.empty": "No hay plantel para este equipo.",
  "squad.start": "Empezar el Mundial →",
  "pos.GK": "Porteros",
  "pos.DF": "Defensas",
  "pos.MF": "Mediocampistas",
  "pos.FW": "Delanteros",

  "lineup.title": "— preparación del partido",
  "lineup.subtitle": "Jornada {day} · {stage} · vs {opponent}",
  "lineup.formation": "Formación",
  "lineup.strategy": "Estrategia",
  "lineup.slots": "Once inicial: un jugador por puesto",
  "lineup.pick": "— elegir jugador —",
  "lineup.players": "Jugadores",
  "lineup.auto": "⚡ Alinear el mejor once",
  "lineup.confirm": "Guardar once y jugar →",
  "lineup.cancel": "← torneo",
  "lineup.hint": "Jugar en un puesto no natural resta valoración (se muestra en la lista).",
  "lineup.ready": "Once completo: ¡a jugar!",
  "lineup.pen": "{n} de valoración",
  "lineup.armFirst": "Elige un jugador y luego toca un hueco que parpadee",
  "lineup.place": "Colocar a {player} aquí",
  "lineup.notThere": "{player} no juega en este puesto",
  "lineup.dblClear": "doble clic para quitar",
  "lineup.picked": "en el XI",
  "lineup.suspended": "sancionado",
  "lineup.tapSlot": "Ahora toca un hueco que parpadea en el campo",
  "strategy.defensive": "Defensivo",
  "strategy.normal": "Normal",
  "strategy.attacking": "Ofensivo",
  "abbr.GK": "POR",
  "abbr.RDF": "LD",
  "abbr.DF": "DFC",
  "abbr.LDF": "LI",
  "abbr.DMF": "MCD",
  "abbr.RMF": "MD",
  "abbr.LMF": "MI",
  "abbr.AMF": "MP",
  "abbr.RFW": "ED",
  "abbr.FW": "DC",
  "abbr.LFW": "EI",

  "cup.title": "Mundial {year} · {host}",
  "cup.managing": "Estás dirigiendo el torneo en directo.",
  "cup.neutral": "Vista neutral: no hay equipo en el banquillo.",
  "cup.revealed": "Jornada {day} · {revealed}/{total} revelados",
  "cup.startHint": "El sorteo está listo: hora de empezar.",
  "cup.start": "Empezar el torneo",
  "cup.retry": "Reintentar",
  "cup.startError": "No se pudo empezar el torneo: {msg}",
  "cup.playDay1": "Jugar jornada 1",
  "cup.playDay": "Jugar jornada {day}",
  "cup.playAll": "Jugar todo",
  "cup.ff": "▶▶ Jugar hasta mi partido",
  "cup.jump": "⚡ Saltar a tu partido",
  "cup.ceremonies": "🏆 Ceremonias →",
  "cup.skipCeremonies": "Saltar a ceremonias →",
  "cup.champion": "¡{team} campeón del mundo!",
  "cup.team": "Equipo",
  "cup.p": "J",
  "cup.w": "G",
  "cup.d": "E",
  "cup.l": "P",
  "cup.gf": "GF",
  "cup.ga": "GC",
  "cup.gd": "DG",
  "cup.pts": "Pts",
  "cup.bracket": "Llaves",
  "cup.scorers": "Máximos goleadores",
  "cup.assisters": "Máximos asistentes",
  "cup.recent": "Resultados recientes",
  "cup.complete": "· torneo completo",
  "cup.noMatches": "Todavía no se ha jugado ningún partido.",
  "cup.noResults": "Todavía no se ha jugado ningún partido.",
  "cup.noteAet": "Tras prór.",
  "cup.notePens": "Penaltis",
  "hub.play": "Jugar",
  "hub.simulate": "Simular",
  "hub.ff": "Avance rápido",
  "hub.ffStop": "Detener",
  "hub.viewResult": "Ver los detalles",
  "hub.playDisabled": "Elige tu formación de abajo para poder jugar",
  "hub.championTitle": "¡{team} campeón del mundo!",
  "hub.championSub": "Podio, goleadores y mejores jugadores.",
  "hub.championShare": "Compartir",
  "hub.formation": "Tu plantel",
  "hub.p1": "Inicio",
  "hub.pEnd": "Final",

  "stage.group": "Grupo",
  "stage.final": "Final",
  "stage.semi": "Semifinal",
  "stage.quarter": "Cuartos de final",
  "stage.r16": "Octavos de final",
  "stage.r32": "Dieciseisavos",
  "stage.r8": "Cuartos",
  "stage.third": "Tercer puesto",

  "match.day": "Jornada {day}",
  "match.aet": "tras la prórroga",
  "match.pens": "penaltis",
  "match.momentum": "dominio de {team}",
  "match.ht": "Desc.",
  "match.ft": "Fin",
  "match.etShort": "Pr",
  "match.assist": "asistencia de {name}",
  "match.pensScore": "Penaltis {home}–{away}",
  "match.ownGoal": "e/p",
  "match.currentMomentum": "Impulso actual",
  "match.close": "Cerrar",

  "share.title": "Mundial {year}",
  "share.host": "Sede: {host}",
  "share.yourPos": "Tu equipo: {pos}",
  "share.bestPlayers": "Mejores jugadores",
  "share.bestScorer": "Máximos goleadores",
  "share.bestAssists": "Máximos asistentes",
  "share.pos.1": "Campeones",
  "share.pos.2": "Subcampeones",
  "share.pos.3": "Tercer puesto",
  "share.pos.4": "Cuarto puesto",
  "share.pos.group": "fuera en fase de grupos",
  "share.pos.1732": "dieciseisavos",
  "share.pos.916": "octavos",
  "share.pos.58": "cuartos de final",
  "share.share": "Compartir",
  "share.sharing": "Preparando…",
  "share.playAgain": "🔁 Jugar de nuevo",
  "share.close": "Cerrar",

  "final.title": "Mundial {year} — {host}",
  "final.hint": "Celebraciones finales y premios.",
  "final.champions": "Campeones del mundo · {year}",
  "final.golden": "Balón de Oro",
  "final.silver": "Balón de Plata",
  "final.bronze": "Balón de Bronce",
  "final.apps": "{count} partidos · {goals} goles · {assists} asistencias",
  "final.score": "puntuación {score}",
  "final.boot": "Bota de Oro — clasificación final",
  "final.player": "Jugador",
  "final.team": "Equipo",
  "final.pos": "Pos.",
  "final.goals": "Goles",
  "final.assists": "Asist.",
  "final.saved": "Partida guardada · historial #{id}",
  "final.notSaved": "No guardada (inicia sesión para guardarla en el historial)",
  "final.replay": "🔁 Jugar de nuevo",
  "final.history": "Historial",
  "final.home": "Nuevo torneo",

  "history.title": "Tus partidas guardadas",
  "history.hint":
    "Cada Mundial jugado estando conectado queda archivado aquí para que lo revivas.",
  "history.back": "Volver al mundial",
  "history.loading": "Cargando historial…",
  "history.empty":
    "Todavía no hay partidas guardadas. Juega un torneo conectado y aparecerá aquí.",
  "history.relive": "Revivir",
  "history.opening": "Cargando…",
};

const dicts: Record<Locale, Record<string, string>> = { en, es };

// Recognised round names map to dictionary keys; the group stage prefix keeps
// its letter (e.g. "Group stage B" → "Fase de grupos B").
const STAGE_PATTERNS: [RegExp, string][] = [
  [/^(?:round of (?:16|dieciseis|octavos)|octavos de final)$/i, "stage.r16"],
  [/^(?:round of (?:32|treintaidos|dieciseisavos)|dieciseisavos)$/i, "stage.r32"],
  [/^(?:round of 8|quarter-?finals?|quarters?|cuartos(?: de final)?)$/i, "stage.quarter"],
  [/^(?:semi-?finals?|semifinals?|semifinales?)$/i, "stage.semi"],
  [/^finals?$/i, "stage.final"],
  [/^(?:third place|tercer puesto|bronze final)$/i, "stage.third"],
];

const I18nCtx = createContext<I18n | null>(null);

export function I18nProvider({ children }: { children: React.ReactNode }) {
  const [locale, setLocale] = useState<Locale>(() => {
    const saved = window.localStorage.getItem(STORAGE_KEY);
    return saved === "es" ? "es" : "en";
  });

  useEffect(() => {
    window.localStorage.setItem(STORAGE_KEY, locale);
  }, [locale]);

  const value = useMemo<I18n>(() => {
    const t = (key: string, vars?: Vars): string => {
      let s = dicts[locale][key] ?? en[key] ?? key;
      if (vars) {
        for (const [k, v] of Object.entries(vars)) {
          s = s.split(`{${k}}`).join(String(v));
        }
      }
      return s;
    };
    const stage = (name: string, vars?: Vars): string => {
      const group = /^(?:Group stage|Fase de grupos|Group|Grupo)\s+([A-Z])$/i.exec(name.trim());
      if (group) return `${t("stage.group")} ${group[1]}`;
      for (const [re, key] of STAGE_PATTERNS) {
        if (re.test(name.trim())) return t(key, vars);
      }
      return name;
    };
    return {
      locale,
      setLocale: (l: Locale) => setLocale(l),
      t,
      stage,
      country: (name: string): string => countryNames[locale]?.[name] ?? name,
      pos: (code: string): string => t("abbr." + normalizePos(code)),
    };
  }, [locale]);

  return <I18nCtx.Provider value={value}>{children}</I18nCtx.Provider>;
}

export function useI18n(): I18n {
  const ctx = useContext(I18nCtx);
  if (!ctx) throw new Error("useI18n must be used inside <I18nProvider>");
  return ctx;
}

export function localeName(l: Locale): string {
  return l === "es" ? "Español" : "English";
}

/** Granular server positions → the shared canonical set used on the pitch and
 *  in every badge, so a player and a slot always speak the same vocabulary. */
const NORMALIZE_POS: Record<string, string> = {
  GK: "GK",
  GF: "GK",
  CB: "DF",
  DF: "DF",
  RB: "RDF",
  RWB: "RDF",
  RDF: "RDF",
  LB: "LDF",
  LWB: "LDF",
  LDF: "LDF",
  CDM: "DMF",
  CM: "DMF",
  DMF: "DMF",
  RM: "RMF",
  RMF: "RMF",
  LM: "LMF",
  LMF: "LMF",
  CAM: "AMF",
  AMF: "AMF",
  RW: "RFW",
  RFW: "RFW",
  ST: "FW",
  CF: "FW",
  FW: "FW",
  LW: "LFW",
  LFW: "LFW",
};

export const normalizePos = (code: string): string => NORMALIZE_POS[code] ?? code;

/** Internal pitch slot codes → canonical position codes (wing-backs read as
 *  full-backs: RWB → RDF, LWB → LDF). */
export const canonSlot = (slot: string): string =>
  slot === "RWB" ? "RDF" : slot === "LWB" ? "LDF" : slot;

// ---------------------------------------------------------------------------
// Localised country names and flag emojis
// ---------------------------------------------------------------------------

const countryNames: Record<Locale, Record<string, string>> = {
  en: {},
es: {
    Algeria: "Argelia",
    Argentina: "Argentina",
    Australia: "Australia",
    Austria: "Austria",
    Belgium: "Bélgica",
    "Bosnia and Herzegovina": "Bosnia y Herzegovina",
    Brazil: "Brasil",
    Cameroon: "Camerún",
    Canada: "Canadá",
    "Cape Verde": "Cabo Verde",
    Chile: "Chile",
    Colombia: "Colombia",
    "Costa Rica": "Costa Rica",
    Croatia: "Croacia",
    Curaçao: "Curazao",
    "Czech Republic": "Chequia",
    Denmark: "Dinamarca",
    "DR Congo": "RD del Congo",
    Ecuador: "Ecuador",
    Egypt: "Egipto",
    England: "Inglaterra",
    France: "Francia",
    Germany: "Alemania",
    Ghana: "Ghana",
    Haiti: "Haití",
    Iran: "Irán",
    Iraq: "Irak",
    "Ivory Coast": "Costa de Marfil",
    Italy: "Italia",
    Japan: "Japón",
    Jordan: "Jordania",
    Mexico: "México",
    Morocco: "Marruecos",
    Netherlands: "Países Bajos",
    "New Zealand": "Nueva Zelanda",
    Norway: "Noruega",
    Panama: "Panamá",
    Paraguay: "Paraguay",
    Poland: "Polonia",
    Portugal: "Portugal",
    Qatar: "Catar",
    Russia: "Rusia",
    "Saudi Arabia": "Arabia Saudita",
    Scotland: "Escocia",
    Senegal: "Senegal",
    Serbia: "Serbia",
    "South Africa": "Sudáfrica",
    "South Korea": "Corea del Sur",
    Spain: "España",
    Sweden: "Suecia",
    Switzerland: "Suiza",
    Tunisia: "Túnez",
    Turkey: "Turquía",
    "United States": "Estados Unidos",
    Uruguay: "Uruguay",
    Uzbekistan: "Uzbekistán",
    Wales: "Gales",
    "West Germany": "Alemania Federal",
  },
};

const FLAGS: Record<string, string> = {
  Algeria: "🇩🇿",
  Argentina: "🇦🇷",
  Australia: "🇦🇺",
  Austria: "🇦🇹",
  Belgium: "🇧🇪",
  "Bosnia and Herzegovina": "🇧🇦",
  Brazil: "🇧🇷",
  Cameroon: "🇨🇲",
  Canada: "🇨🇦",
  "Cape Verde": "🇨🇻",
  Chile: "🇨🇱",
  Colombia: "🇨🇴",
  "Costa Rica": "🇨🇷",
  Croatia: "🇭🇷",
  Curaçao: "🇨🇼",
  "Czech Republic": "🇨🇿",
  Denmark: "🇩🇰",
  "DR Congo": "🇨🇩",
  Ecuador: "🇪🇨",
  Egypt: "🇪🇬",
  England: "🏴󠁧󠁢󠁥󠁮󠁧󠁿",
  France: "🇫🇷",
  Germany: "🇩🇪",
  Ghana: "🇬🇭",
  Haiti: "🇭🇹",
  Iran: "🇮🇷",
  Iraq: "🇮🇶",
  "Ivory Coast": "🇨🇮",
  Italy: "🇮🇹",
  Japan: "🇯🇵",
  Jordan: "🇯🇴",
  Mexico: "🇲🇽",
  Morocco: "🇲🇦",
  Netherlands: "🇳🇱",
  "New Zealand": "🇳🇿",
  Norway: "🇳🇴",
  Panama: "🇵🇦",
  Paraguay: "🇵🇾",
  Poland: "🇵🇱",
  Portugal: "🇵🇹",
  Qatar: "🇶🇦",
  Russia: "🇷🇺",
  "Saudi Arabia": "🇸🇦",
  Scotland: "🏴󠁧󠁢󠁳󠁣󠁴󠁿",
  Senegal: "🇸🇳",
  Serbia: "🇷🇸",
  "South Africa": "🇿🇦",
  "South Korea": "🇰🇷",
  Spain: "🇪🇸",
  Sweden: "🇸🇪",
  Switzerland: "🇨🇭",
  Tunisia: "🇹🇳",
  Turkey: "🇹🇷",
  "United States": "🇺🇸",
  Uruguay: "🇺🇾",
  Uzbekistan: "🇺🇿",
  Wales: "🏴󠁧󠁢󠁷󠁬󠁳󠁿",
  "West Germany": "🇩🇪",
};

/** Emoji flag for a country name, or "" if unknown. */
export function flagFor(name: string): string {
  return FLAGS[name.trim()] ?? "";
}