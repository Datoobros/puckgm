import Link from "next/link";
import { notFound } from "next/navigation";
import { auth } from "@clerk/nextjs/server";
import { prisma } from "@/lib/db";
import { getLeague, type LeagueSettings } from "@/lib/leagues/mutations";
import { getStandings } from "@/lib/matchups/standings";
import { standardSeedOrder } from "@/lib/matchups/playoffs";
import { Card, SectionLabel } from "@/components/Card";
import { TeamLogo } from "@/components/TeamLogo";

export default async function ProjectedBracketPage(props: PageProps<"/leagues/[id]/standings/bracket">) {
  await auth.protect();
  const { id: leagueId } = await props.params;
  const sp = await props.searchParams;
  const rawSeason = Array.isArray(sp.season) ? sp.season[0] : sp.season;

  const league = await getLeague(leagueId);
  if (!league) notFound();
  const settings = league.settingsJson as unknown as LeagueSettings;
  const season = rawSeason ? Number(rawSeason) : league.currentSeason;

  const playoffPeriods = await prisma.matchupPeriod.findMany({
    where: { leagueId, season, isPlayoffs: true },
  });
  const bracketSize = playoffPeriods.length > 0 ? 2 ** playoffPeriods.length : 0;

  const standings = bracketSize > 0 ? await getStandings(leagueId, season, settings.scoringConfig) : [];
  const seeded = standings.slice(0, bracketSize);
  const order = bracketSize > 0 ? standardSeedOrder(bracketSize) : [];
  const pairs: [number, number][] = [];
  for (let i = 0; i < order.length; i += 2) pairs.push([order[i], order[i + 1]]);

  return (
    <div className="mx-auto max-w-3xl px-6 py-8">
      <Link href={`/leagues/${leagueId}/standings`} className="text-sm text-muted hover:underline">
        ← Standings
      </Link>
      <h1 className="mt-2 text-2xl font-semibold tracking-tight">Projected Playoff Bracket</h1>
      <p className="mt-1 text-sm text-muted">
        If the playoffs started today, seeded from the current standings. Only the first round is projected — later
        rounds depend on results that haven&apos;t happened yet.
      </p>

      <div className="mt-6">
        <SectionLabel>Round 1</SectionLabel>
        {bracketSize === 0 ? (
          <Card>
            <p className="text-sm text-muted">This league has no playoff bracket configured.</p>
          </Card>
        ) : seeded.length < bracketSize ? (
          <Card>
            <p className="text-sm text-muted">Not enough teams have a standings record yet to seed a bracket.</p>
          </Card>
        ) : (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {pairs.map(([seedA, seedB]) => {
              const teamA = seeded[seedA - 1];
              const teamB = seeded[seedB - 1];
              return (
                <Card key={`${seedA}-${seedB}`}>
                  <div className="flex items-center gap-2 text-sm">
                    <span className="w-5 text-muted">{seedA}</span>
                    <TeamLogo url={teamA.logoUrl} alt={teamA.teamName} size={22} />
                    <span className="font-medium">{teamA.teamName}</span>
                  </div>
                  <div className="mt-1.5 flex items-center gap-2 text-sm">
                    <span className="w-5 text-muted">{seedB}</span>
                    <TeamLogo url={teamB.logoUrl} alt={teamB.teamName} size={22} />
                    <span className="font-medium">{teamB.teamName}</span>
                  </div>
                </Card>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
