// One-off cleanup (plans/draft-fix-batch.md Task 4, run once after Tasks
// 1-3 shipped): deletes the botched first startup draft run against the
// user's real "Experimenting" league (2026-09-16) — every pick was recorded
// ~4 times by the pre-Task-1 race condition (228 open RosterSlot rows for 60
// real picks, 228 DRAFT_PICK log rows, 70 players double-rostered). The fix
// is code-level (Tasks 1-3); this just removes the corrupted data so the
// user can run a correct draft through the fixed code.
//
// Scoped to this league by EXACT name AND id, and to this exact draft by id
// — aborts on any mismatch, since this DB is shared between local dev and
// production (PROGRESS.md). Also aborts if any TradeItem references one of
// this draft's picks, or if any open RosterSlot for the league's teams
// predates the draft (i.e. existed before this draft ran — the league had 0
// open slots beforehand per the 2026-09-15 reset, so every open slot found
// here should be a bug artifact of this exact draft, not real history).
//
// Deletes (not closes) roster slots and picks, since these are bug
// artifacts, not history worth an audit trail. Writes exactly one
// TransactionLog COMMISSIONER_RESET row recording the cleanup itself.
//
// Usage:
//   npx tsx scripts/reset-experimenting-botched-draft.ts --dry-run   # prints what it would do, writes nothing
//   npx tsx scripts/reset-experimenting-botched-draft.ts             # does it for real

import { prisma } from "@/lib/db";
import { getFreeAgencyStatus } from "@/lib/draft/mutations";

const LEAGUE_NAME = "Experimenting";
const LEAGUE_ID = "cmts0s1uu0000lc0405mux8c5";
const DRAFT_ID = "cmu4ml8b60003l304ps7kjoa6";

const DRY_RUN = process.argv.includes("--dry-run");

async function main() {
  const league = await prisma.league.findUnique({ where: { id: LEAGUE_ID }, include: { teams: true } });
  if (!league || league.name !== LEAGUE_NAME) {
    throw new Error(
      `Refusing to run — expected league id "${LEAGUE_ID}" named "${LEAGUE_NAME}", found: ` +
        (league ? `id "${league.id}" named "${league.name}".` : "no league with that id at all."),
    );
  }
  const teamIds = league.teams.map((t) => t.id);
  console.log(`${DRY_RUN ? "[DRY RUN] " : ""}Target league: "${league.name}" (${league.id}), teams: ${league.teams.map((t) => t.name).join(", ")}`);

  const draft = await prisma.draft.findUnique({ where: { id: DRAFT_ID } });
  if (!draft || draft.leagueId !== league.id) {
    throw new Error(
      `Refusing to run — expected draft id "${DRAFT_ID}" belonging to league "${league.id}", found: ` +
        (draft ? `draft "${draft.id}" belongs to league "${draft.leagueId}" instead.` : "no draft with that id at all."),
    );
  }
  console.log(`Target draft: ${draft.id} (${draft.type}, season ${draft.season}, status ${draft.status}, created ${draft.createdAt.toISOString()})`);

  const picks = await prisma.draftPick.findMany({ where: { draftId: draft.id } });
  console.log(`\nDraft picks: ${picks.length}`);

  const tradeItemsOnPicks = await prisma.tradeItem.count({ where: { draftPickId: { in: picks.map((p) => p.id) } } });
  console.log(`TradeItems referencing these picks: ${tradeItemsOnPicks}`);
  if (tradeItemsOnPicks > 0) {
    throw new Error(`Aborting — ${tradeItemsOnPicks} TradeItem row(s) reference this draft's picks. Expected 0.`);
  }

  const openSlots = await prisma.rosterSlot.findMany({
    where: { teamId: { in: teamIds }, effectiveTo: null },
    include: { team: true, player: true },
    orderBy: [{ team: { name: "asc" } }, { effectiveFrom: "asc" }],
  });
  console.log(`\nOpen roster slots for this league's teams: ${openSlots.length}`);

  const predating = openSlots.filter((s) => s.effectiveFrom < draft.createdAt);
  if (predating.length > 0) {
    console.log(`\nOpen slots that PREDATE the draft (effectiveFrom < ${draft.createdAt.toISOString()}):`);
    for (const s of predating) {
      console.log(`  ${s.team.name}: ${s.player.fullName} (${s.slotType}), effectiveFrom=${s.effectiveFrom.toISOString()}`);
    }
    throw new Error(`Aborting — ${predating.length} open roster slot(s) predate this draft's createdAt. Expected 0 (every open slot should be a product of this draft).`);
  }
  console.log(`All ${openSlots.length} open roster slots have effectiveFrom >= draft.createdAt — confirmed they're all artifacts of this draft.`);

  const draftPickLogs = await prisma.transactionLog.findMany({
    where: { leagueId: league.id, type: "DRAFT_PICK", createdAt: { gte: draft.createdAt } },
  });
  console.log(`\nDRAFT_PICK TransactionLog rows (leagueId=${league.id}, createdAt >= draft.createdAt): ${draftPickLogs.length}`);

  const lineupEntries = await prisma.lineupEntry.findMany({ where: { teamId: { in: teamIds } } });
  console.log(`LineupEntry rows for this league's teams: ${lineupEntries.length}`);

  console.log("\nWould delete:" + (DRY_RUN ? "" : " (applying now)"));
  console.log(`  ${lineupEntries.length} LineupEntry row(s)`);
  console.log(`  ${openSlots.length} RosterSlot row(s)`);
  console.log(`  ${draftPickLogs.length} TransactionLog DRAFT_PICK row(s)`);
  console.log(`  ${picks.length} DraftPick row(s)`);
  console.log(`  1 Draft row (${draft.id})`);
  console.log(`  Then write 1 TransactionLog COMMISSIONER_RESET row.`);

  if (DRY_RUN) {
    console.log("\n[DRY RUN] Nothing was written.");
    return;
  }

  await prisma.$transaction([
    prisma.lineupEntry.deleteMany({ where: { teamId: { in: teamIds } } }),
    prisma.rosterSlot.deleteMany({ where: { teamId: { in: teamIds }, effectiveTo: null } }),
    prisma.transactionLog.deleteMany({ where: { leagueId: league.id, type: "DRAFT_PICK", createdAt: { gte: draft.createdAt } } }),
    prisma.draftPick.deleteMany({ where: { draftId: draft.id } }),
    prisma.draft.delete({ where: { id: draft.id } }),
    prisma.transactionLog.create({
      data: {
        leagueId: league.id,
        type: "COMMISSIONER_RESET",
        payload: { reason: "botched startup draft removed", draftId: draft.id },
      },
    }),
  ]);

  console.log("\nApplied. Re-checking...");

  const [afterSlots, afterLineups, afterDrafts] = await Promise.all([
    prisma.rosterSlot.count({ where: { teamId: { in: teamIds }, effectiveTo: null } }),
    prisma.lineupEntry.count({ where: { teamId: { in: teamIds } } }),
    prisma.draft.count({ where: { leagueId: league.id } }),
  ]);
  const faStatus = await getFreeAgencyStatus(league.id);

  console.log(`\nAFTER:`);
  console.log(`  open roster slots: ${afterSlots}`);
  console.log(`  lineup rows:       ${afterLineups}`);
  console.log(`  drafts:            ${afterDrafts}`);
  console.log(`  free agency:       ${faStatus.open ? "OPEN" : `closed (${faStatus.reason})`}`);
}

main()
  .catch((e) => {
    console.error("SCRIPT ERROR:", e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
