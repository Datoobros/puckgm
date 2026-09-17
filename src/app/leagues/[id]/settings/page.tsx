import Link from "next/link";
import { notFound } from "next/navigation";
import { getLeague, type LeagueSettings } from "@/lib/leagues/mutations";
import { Card, SectionLabel } from "@/components/Card";
import { Badge } from "@/components/Button";
import { LM_TOOL_CARDS } from "./tools";

export default async function LeagueManagerToolsPage(props: PageProps<"/leagues/[id]/settings">) {
  const { id: leagueId } = await props.params;

  const league = await getLeague(leagueId);
  if (!league) notFound();
  const settings = league.settingsJson as unknown as LeagueSettings;

  return (
    <div>
      <Link href={`/leagues/${leagueId}`} className="text-sm text-muted hover:underline">
        ← {league.name}
      </Link>
      <div className="mt-1 flex items-center gap-3">
        <h1 className="text-2xl font-semibold tracking-tight">League Manager Tools</h1>
        <Badge tone="muted">{settings.leagueType === "REDRAFT" ? "REDRAFT LEAGUE" : "DYNASTY LEAGUE"}</Badge>
      </div>
      <p className="mt-2 max-w-3xl text-sm text-muted">
        Everything a commissioner can do to this league lives here — membership, scoring, rosters,
        schedule, and the draft — one tool per page.
      </p>

      <div className="mt-8 grid grid-cols-1 gap-6 md:grid-cols-2 xl:grid-cols-3">
        {LM_TOOL_CARDS.map((card) => (
          <Card key={card.title}>
            <SectionLabel>{card.title}</SectionLabel>
            {card.rows.length === 0 ? (
              <p className="text-sm text-muted">Nothing here yet.</p>
            ) : (
              <div className="divide-y divide-border">
                {card.rows.map((row) => (
                  <div key={row.title} className="py-2 first:pt-0 last:pb-0">
                    {row.href ? (
                      <Link href={row.href(leagueId)} className="text-sm font-medium text-blue hover:underline">
                        {row.title}
                      </Link>
                    ) : (
                      <span className="text-sm font-medium text-muted">{row.title}</span>
                    )}
                    <p className="mt-0.5 text-xs text-muted">{row.description}</p>
                  </div>
                ))}
              </div>
            )}
          </Card>
        ))}
      </div>
    </div>
  );
}
