// fetch-oracles.mjs — download each edition's run oracle from the dev server
// into client/tests/fixtures/oracle-{year}.json.gz so the test suite is fully
// hermetic (no server required at test time).
//
//   node scripts/fetch-oracles.mjs [baseUrl]
//
// Defaults to http://127.0.0.1:8080. Re-run after reseeding the server to
// refresh the snapshots; the invariant/determinism tests then compare against
// exactly what the server serves today.
import { mkdirSync, writeFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const base = process.argv[2] ?? "http://127.0.0.1:8080";
const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, "..", "tests", "fixtures");
mkdirSync(outDir, { recursive: true });

const tournaments = await (await fetch(`${base}/api/tournaments`)).json();
for (const t of tournaments) {
  const oracle = await (await fetch(`${base}/api/tournaments/${t.id}/oracle`)).json();
  const file = join(outDir, `oracle-${t.year}.json.gz`);
  writeFileSync(file, gzipSync(Buffer.from(JSON.stringify(oracle)), { level: 9 }));
  console.log(`oracle ${t.year}: ${oracle.participants.length} teams, ${oracle.phases.length} phases -> ${file}`);
}
console.log(`done: ${tournaments.length} oracles -> ${outDir}`);