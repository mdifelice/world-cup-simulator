//! Server-side roster generation.
//!
//! Editions with imported squads use their real `player_callups`. Everyone else
//! gets a deterministic fictional squad (26 players) so the whole flow — rosters,
//! scorers, awards — works even before the scraper is run for that edition.
//! Generation is a pure function of `(tournament_id, team_id)`, so the roster
//! shown before a run is identical to the one the engine uses.

use rusqlite::{params, Connection};

use crate::sim;

#[derive(Debug, Clone)]
pub struct SquadPlayer {
    /// Negative when generated (never persisted, per-run).
    pub id: i64,
    pub name: String,
    pub position: String,
    pub shirt_number: Option<i32>,
    pub overall: f64,
}

/// 26-man squad layout: (position, number of players).
const LAYOUT: &[(&str, usize)] = &[
    ("GK", 3),
    ("CB", 4),
    ("LB", 2),
    ("RB", 2),
    ("CDM", 3),
    ("CM", 4),
    ("CAM", 2),
    ("LW", 2),
    ("RW", 2),
    ("ST", 2),
];

/// Returns the squad for a team in a tournament: real call-ups when they
/// exist, otherwise a deterministic generated roster.
pub fn squad_for_team(
    conn: &Connection,
    tournament_id: i64,
    team_id: i64,
    shirt_numbers: bool,
) -> rusqlite::Result<Vec<SquadPlayer>> {
    let real = read_callups(conn, tournament_id, team_id)?;
    if !real.is_empty() {
        return Ok(real);
    }
    let (name, rating): (String, i32) = conn
        .query_row(
            "SELECT name, rating FROM teams WHERE id = ?1",
            [team_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .unwrap_or(("The Team".to_string(), 70));
    Ok(generate(tournament_id, team_id, &name, rating, shirt_numbers))
}

fn read_callups(
    conn: &Connection,
    tournament_id: i64,
    team_id: i64,
) -> rusqlite::Result<Vec<SquadPlayer>> {
    let mut stmt = conn.prepare(
        "SELECT p.id, p.name, c.position, c.shirt_number,
                p.pace, p.stamina, p.strength, p.dribbling, p.passing,
                p.shooting, p.tackling, p.vision, p.positioning, p.composure,
                p.reflexes, p.handling, p.kicking, p.aerial,
                p.decisions, p.aggression, p.concentration, p.leadership
         FROM player_callups c
         JOIN players p ON p.id = c.player_id
         WHERE c.tournament_id = ?1 AND c.team_id = ?2
         ORDER BY c.shirt_number IS NULL, c.shirt_number, p.name",
    )?;
    let rows = stmt.query_map(params![tournament_id, team_id], |r| {
        let attrs = [
            r.get::<_, Option<i32>>(4)?,
            r.get::<_, Option<i32>>(5)?,
            r.get::<_, Option<i32>>(6)?,
            r.get::<_, Option<i32>>(7)?,
            r.get::<_, Option<i32>>(8)?,
            r.get::<_, Option<i32>>(9)?,
            r.get::<_, Option<i32>>(10)?,
            r.get::<_, Option<i32>>(11)?,
            r.get::<_, Option<i32>>(12)?,
            r.get::<_, Option<i32>>(13)?,
            r.get::<_, Option<i32>>(14)?,
            r.get::<_, Option<i32>>(15)?,
            r.get::<_, Option<i32>>(16)?,
            r.get::<_, Option<i32>>(17)?,
            r.get::<_, Option<i32>>(18)?,
            r.get::<_, Option<i32>>(19)?,
            r.get::<_, Option<i32>>(20)?,
            r.get::<_, Option<i32>>(21)?,
        ];
        let position: String = r.get(2)?;
        let overall = sim::composite_rating(&position, &attrs);
        Ok(SquadPlayer {
            id: r.get(0)?,
            name: r.get(1)?,
            position,
            shirt_number: r.get(3)?,
            overall,
        })
    })?;
    rows.collect()
}

/// Deterministic fictional squad for an edition/team with no imported players.
fn generate(
    tournament_id: i64,
    team_id: i64,
    team_name: &str,
    rating: i32,
    shirt_numbers: bool,
) -> Vec<SquadPlayer> {
    let seed = (tournament_id as u64)
        .wrapping_mul(10_007)
        .wrapping_add(team_id as u64)
        .wrapping_mul(40_793)
        | 1;
    let mut rng = GenRng(seed);
    let (firsts, lasts) = pool_for(team_name);
    let mut out = Vec::new();
    let mut idx = 0usize;
    for &(pos, count) in LAYOUT {
        for _ in 0..count {
            let family = crate::models::position_family(pos);
            let delta = match family {
                "GK" => 3,
                "DF" => -2,
                "MF" => 0,
                _ => 1,
            };
            let overall = (rating as f64 + delta as f64 + (rng.f() * 9.0 - 4.5))
                .clamp(55.0, 96.0);
            let name = format!(
                "{}. {}",
                firsts[(rng.f() * firsts.len() as f64) as usize],
                lasts[(rng.f() * lasts.len() as f64) as usize]
            );
            let number = shirt_numbers.then(|| idx as i32 + 1);
            out.push(SquadPlayer {
                id: -((team_id as i64) * 1000 + idx as i64 + 1),
                name,
                position: pos.to_string(),
                shirt_number: number,
                overall,
            });
            idx += 1;
        }
    }
    out
}

/// Mini xorshift PRNG for deterministic names.
struct GenRng(u64);

impl GenRng {
    fn next(&mut self) -> u64 {
        let mut x = self.0;
        x ^= x << 13;
        x ^= x >> 7;
        x ^= x << 17;
        self.0 = x;
        x
    }
    fn f(&mut self) -> f64 {
        (self.next() >> 11) as f64 / (1u64 << 53) as f64
    }
}

// ---------------------------------------------------------------------------
// Regional name pools (coarse flavours — enough for a simulator).
// ---------------------------------------------------------------------------

fn pool_for(team: &str) -> (&'static [&'static str], &'static [&'static str]) {
    if contains(team, &["brazil", "portugal"]) {
        (IBERIAN_F, IBERIAN_L)
    } else if contains(team, &["spain", "mexico"]) {
        (IBERIAN_F, IBERIAN_L)
    } else if contains(
        team,
        &[
            "argentina", "uruguay", "ecuador", "chile", "paraguay", "colombia",
            "peru", "bolivia", "venezuela", "costa rica", "panama", "honduras",
        ],
    ) {
        (LATIN_F, LATIN_L)
    } else if contains(team, &["england", "wales", "scotland", "ireland", "united kingdom"]) {
        (BRITISH_F, BRITISH_L)
    } else if contains(team, &["france", "germany", "netherlands", "belgium", "switzerland", "austria"]) {
        (WEST_EUROPE_F, WEST_EUROPE_L)
    } else if contains(team, &["italy", "croatia", "serbia", "slovenia", "bosnia", "montenegro", "greece"]) {
        (SOUTH_EUROPE_F, SOUTH_EUROPE_L)
    } else if contains(team, &["sweden", "norway", "denmark", "finland", "iceland"]) {
        (NORDIC_F, NORDIC_L)
    } else if contains(team, &["poland", "czech", "slovakia", "hungary", "ukraine", "russia", "turkey"]) {
        (EAST_EUROPE_F, EAST_EUROPE_L)
    } else if contains(
        team,
        &[
            "morocco", "algeria", "tunisia", "egypt", "senegal", "ivory",
            "ghana", "cameroon", "nigeria", "south africa", "congo", "mali",
            "guinea",
        ],
    ) {
        (AFRICA_F, AFRICA_L)
    } else if contains(team, &["saudi", "qatar", "iran", "iraq", "jordan", "uae", "kuwait", "oman"]) {
        (MIDDLE_EAST_F, MIDDLE_EAST_L)
    } else if contains(team, &["japan", "korea", "china", "vietnam", "thailand"]) {
        (ASIA_F, ASIA_L)
    } else if contains(team, &["australia", "new zealand"]) {
        (OCEANIA_F, OCEANIA_L)
    } else if contains(team, &["united states", "canada"]) {
        (NORTH_AMERICA_F, NORTH_AMERICA_L)
    } else {
        (GENERIC_F, GENERIC_L)
    }
}

fn contains(team: &str, keys: &[&str]) -> bool {
    let t = team.to_lowercase();
    keys.iter().any(|k| t.contains(k))
}

const IBERIAN_F: &[&str] = &[
    "Lucas", "Tiago", "Rafael", "Marcos", "Diego", "Nuno", "Joao", "Pedro",
    "Fernando", "Bruno", "Gustavo", "Vitor",
];
const IBERIAN_L: &[&str] = &[
    "Silva", "Costa", "Pereira", "Gomez", "Fernandez", "Sousa", "Moreira",
    "Ramos", "Oliveira", "Lopes", "Martins", "Ribeiro",
];

const LATIN_F: &[&str] = &[
    "Mateo", "Santiago", "Leo", "Facundo", "Thiago", "Nicolas", "Javier",
    "Lautaro", "Emiliano", "Rodrigo", "Angel", "Franco",
];
const LATIN_L: &[&str] = &[
    "Gonzalez", "Rodriguez", "Perez", "Martinez", "Lopez", "Diaz", "Herrera",
    "Acosta", "Romero", "Alvarez", "Benitez", "Fuentes",
];

const BRITISH_F: &[&str] = &[
    "Jack", "Harry", "George", "Oliver", "Lewis", "Callum", "Mason", "Reece",
    "Marcus", "Conor", "Aaron", "Aaron",
];
const BRITISH_L: &[&str] = &[
    "Walker", "Brown", "Davies", "Ward", "Evans", "Bennett", "Green", "Sutton",
    "Collins", "Bell", "Hughes", "Thompson",
];

const WEST_EUROPE_F: &[&str] = &[
    "Lukas", "Mats", "Thilo", "Robin", "Kevin", "Yann", "Axel", "Milan",
    "Nico", "Bastian", "Florian", "Timo",
];
const WEST_EUROPE_L: &[&str] = &[
    "Muller", "Weber", "Fischer", "Schneider", "Koch", "Richter", "Vandenberg",
    "De Vries", "Janssens", "Peeters", "Dupont", "Fournier",
];

const SOUTH_EUROPE_F: &[&str] = &[
    "Marco", "Luca", "Andrea", "Lovre", "Mario", "Josip", "Marko", "Filip",
    "Matteo", "Giorgio", "Antonio", "Stefan",
];
const SOUTH_EUROPE_L: &[&str] = &[
    "Rossi", "Conti", "Ferrari", "Esposito", "Kovac", "Horvat", "Maric",
    "Petrovic", "Bianchi", "Ricci", "Velez", "Simic",
];

const NORDIC_F: &[&str] = &[
    "Henrik", "Bjorn", "Lars", "Erik", "Ola", "Mads", "Sigurd", "Jonas",
    "Christian", "Anders", "Magnus", "Emil",
];
const NORDIC_L: &[&str] = &[
    "Larsen", "Nielsen", "Hansen", "Johansen", "Berg", "Andersson", "Eriksson",
    "Jensen", "Olsen", "Sorensen", "Lindberg", "Moeller",
];

const EAST_EUROPE_F: &[&str] = &[
    "Piotr", "Jakub", "Wojtek", "Dimitri", "Sergey", "Tomas", "Petr", "Zoltan",
    "Vlad", "Andriy", "Marek", "Tadeusz",
];
const EAST_EUROPE_L: &[&str] = &[
    "Kowalski", "Nowak", "Nowicki", "Zielinski", "Novak", "Svoboda", "Kovalev",
    "Petrov", "Volkov", "Bogdan", "Szabo", "Maric",
];

const AFRICA_F: &[&str] = &[
    "Adama", "Moussa", "Yacoub", "Chinedu", "Kwame", "Idrissa", "Bakary",
    "Seydou", "Abubakar", "Papiss", "Kalilou", "Oumar",
];
const AFRICA_L: &[&str] = &[
    "Traore", "Okafor", "Diallo", "Ndiaye", "Mensah", "Kamara", "Ayew",
    "Sane", "Doumbia", "Okeke", "Toure", "Ba",
];

const MIDDLE_EAST_F: &[&str] = &[
    "Omar", "Karim", "Yusuf", "Amir", "Hassan", "Tariq", "Sami", "Nasser",
    "Fahad", "Zaid", "Wissam", "Ibrahim",
];
const MIDDLE_EAST_L: &[&str] = &[
    "Al-Sayed", "Hassan", "Khalil", "Nasser", "Al-Rashid", "Farouk", "Salem",
    "Attar", "Al-Amin", "Hamad", "Khadra", "Mansour",
];

const ASIA_F: &[&str] = &[
    "Kenji", "Haruto", "Daiki", "Min-soo", "Ji-ho", "Seung", "Takeshi", "Yuto",
    "Kenta", "Riku", "Hyun", "Sung-min",
];
const ASIA_L: &[&str] = &[
    "Tanaka", "Sato", "Suzuki", "Takahashi", "Kim", "Park", "Lee", "Cho",
    "Kobayashi", "Yamamoto", "Kato", "Yoshida",
];

const OCEANIA_F: &[&str] = &[
    "Jack", "Luke", "Mitchell", "Brayden", "Declan", "Riley", "Trent", "Brody",
    "Cooper", "Hayden", "Flynn", "Kane",
];
const OCEANIA_L: &[&str] = &[
    "Smith", "Jones", "Wilson", "Brown", "Taylor", "Davis", "Roberts", "White",
    "Cameron", "Rogers", "Cooper", "Murray",
];

const NORTH_AMERICA_F: &[&str] = &[
    "Tyler", "Derek", "Brayden", "Carter", "Logan", "Ethan", "Mason", "Cole",
    "Joshua", "Austin", "Jordan", "Cameron",
];
const NORTH_AMERICA_L: &[&str] = &[
    "Johnson", "Miller", "Davis", "Garcia", "Wilson", "Anderson", "Thomas",
    "Taylor", "Moore", "Jackson", "Martin", "Lee",
];

const GENERIC_F: &[&str] = &[
    "Lucas", "Mateo", "Diego", "Marco", "Leo", "Ivan", "Nikola", "Adama",
    "Karim", "Sven", "Piotr", "Nuno", "Bjorn", "Emre", "Tiago", "Omar",
    "Alec", "Theo", "Mats", "Daniel", "Joel", "Samir", "Elias", "Bruno",
    "Hugo", "Rafael", "Kenji", "Noah",
];
const GENERIC_L: &[&str] = &[
    "Silva", "Kowalski", "Petrov", "Moreau", "Nakamura", "Ali", "Jansen",
    "Rossi", "Nowak", "Ahmed", "Novak", "Gomez", "Fischer", "Dos Santos",
    "Mueller", "Larsen", "Okafor", "Herrera", "Dubois", "Yilmaz", "Costa",
    "Garcia", "Berg", "Khan", "Moreira", "Weiss", "Ndiaye", "Kim",
];