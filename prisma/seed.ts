/**
 * Development / test seed — TEMPORARY placeholder data.
 *
 * Real venue layout, seat map and prices are not settled (DECISIONS E-003, E-004), so nothing here
 * is operational data. Everything is labelled "[DEV SEED]" and uses deterministic ids, which makes
 * the seed idempotent: running it again inserts nothing new (INSERT ... ON CONFLICT DO NOTHING).
 *
 * Safety: refuses to run unless NAZIR_RUNTIME_ENV is `local` or `test` (a missing value counts as
 * production) and the database name matches the environment. See src/server/db/seed-guard.ts.
 *
 * Run:  npm run db:seed      (== prisma db seed)
 */
import { createHash } from "node:crypto";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client";
import { assertDevSeedAllowed, SeedNotAllowedError } from "../src/server/db/seed-guard";
import { DatabaseConfigError } from "../src/server/config/database-config";

/** Deterministic UUID (v5-shaped) so reruns hit the same primary keys. */
function detUuid(key: string): string {
  const h = createHash("sha1").update(`nazir-dev-seed:${key}`).digest();
  h[6] = (h[6] & 0x0f) | 0x50;
  h[8] = (h[8] & 0x3f) | 0x80;
  const x = h.subarray(0, 16).toString("hex");
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20, 32)}`;
}

const VENUE_ID = detUuid("venue");
const SHOW_ID = detUuid("show");
const SESSION_IDS = [detUuid("session:1"), detUuid("session:2")];

// Placeholder layout: 2 sections, 78 seats. Prices are NOT real.
const SECTIONS = [
  { name: "VIP", rows: ["A", "B", "C"], seatsPerRow: 10, price: BigInt(150000) },
  { name: "R", rows: ["D", "E", "F", "G"], seatsPerRow: 12, price: BigInt(110000) },
];

function buildSeats() {
  const seats: {
    id: string;
    venueId: string;
    svgSeatId: string;
    sectionName: string;
    rowLabel: string;
    seatNumber: string;
    seatLabel: string;
    price: bigint;
  }[] = [];
  for (const sec of SECTIONS) {
    for (const row of sec.rows) {
      for (let n = 1; n <= sec.seatsPerRow; n++) {
        const svgSeatId = `${sec.name}-${row}-${n}`;
        seats.push({
          id: detUuid(`seat:${svgSeatId}`),
          venueId: VENUE_ID,
          svgSeatId,
          sectionName: sec.name,
          rowLabel: row,
          seatNumber: String(n),
          seatLabel: `${sec.name} ${row}열 ${n}번`,
          price: sec.price,
        });
      }
    }
  }
  return seats;
}

async function main() {
  const { runtimeEnv, database } = assertDevSeedAllowed(process.env);
  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }) });
  try {
    const day = 24 * 60 * 60 * 1000;
    const base = Date.now() + 30 * day;
    const seats = buildSeats();

    await prisma.$transaction(async (tx) => {
      await tx.venue.createMany({
        data: [
          {
            id: VENUE_ID,
            name: "[DEV SEED] 임시 공연장",
            address: "임시 주소 (실제 공연장 아님)",
            seatMapVersion: "DEV-SEED",
          },
        ],
        skipDuplicates: true,
      });
      await tx.show.createMany({
        data: [
          {
            id: SHOW_ID,
            venueId: VENUE_ID,
            title: "[DEV SEED] 임시 뮤지컬",
            slug: "dev-seed-musical",
            description: "개발·테스트 전용 임시 공연입니다. 실제 판매 데이터가 아닙니다.",
            status: "PUBLISHED",
          },
        ],
        skipDuplicates: true,
      });
      await tx.showSession.createMany({
        data: SESSION_IDS.map((id, i) => ({
          id,
          showId: SHOW_ID,
          venueId: VENUE_ID,
          startsAt: new Date(base + i * day),
          endsAt: new Date(base + i * day + 3 * 60 * 60 * 1000),
          salesStatus: "ON_SALE",
          maxSeatsPerIdentity: 4,
        })),
        skipDuplicates: true,
      });
      await tx.seat.createMany({
        data: seats.map((s) => ({
          id: s.id,
          venueId: s.venueId,
          svgSeatId: s.svgSeatId,
          sectionName: s.sectionName,
          rowLabel: s.rowLabel,
          seatNumber: s.seatNumber,
          seatLabel: s.seatLabel,
        })),
        skipDuplicates: true,
      });
      await tx.sessionSeat.createMany({
        data: SESSION_IDS.flatMap((sessionId) =>
          seats.map((s) => ({
            id: detUuid(`session-seat:${sessionId}:${s.svgSeatId}`),
            showSessionId: sessionId,
            seatId: s.id,
            venueId: VENUE_ID,
            price: s.price,
            status: "AVAILABLE",
          })),
        ),
        skipDuplicates: true,
      });
    });

    const [venues, shows, sessions, physical, sellable] = await Promise.all([
      prisma.venue.count({ where: { id: VENUE_ID } }),
      prisma.show.count({ where: { id: SHOW_ID } }),
      prisma.showSession.count({ where: { showId: SHOW_ID } }),
      prisma.seat.count({ where: { venueId: VENUE_ID } }),
      prisma.sessionSeat.count({ where: { venueId: VENUE_ID } }),
    ]);
    console.log(
      `[seed] ${runtimeEnv}/${database.database}: venues=${venues} shows=${shows} sessions=${sessions} seats=${physical} session_seats=${sellable} (DEV SEED, placeholder data)`,
    );
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  if (e instanceof SeedNotAllowedError || e instanceof DatabaseConfigError) {
    console.error(`[seed] ${e.message}`);
  } else {
    console.error("[seed] failed:", e instanceof Error ? e.message : e);
  }
  process.exit(1);
});
