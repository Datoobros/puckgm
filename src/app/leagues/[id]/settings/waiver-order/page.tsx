import Link from "next/link";
import { notFound } from "next/navigation";
import { getLeague, type LeagueSettings } from "@/lib/leagues/mutations";
import { getOrInitWaiverPriority } from "@/lib/waivers/mutations";
import { Card, SectionLabel } from "@/components/Card";
import { Badge } from "@/components/Button";
import { WaiverOrderEditor } from "./WaiverOrderEditor";

export default async function WaiverOrderPage(props: PageProps<"/leagues/[id]/settings/waiver-order">) {
  const { id: leagueId } = await props.params;
  const sp = await props.searchParams;
  const justSaved = (Array.isArray(sp.saved) ? sp.saved[0] : sp.saved) === "1";

  const league = await getLeague(leagueId);
  if (!league) notFound();
  const settings = league.settingsJson as unknown as LeagueSettings;

  const priority = await getOrInitWaiverPriority(leagueId);
  const nameById = new Map(league.teams.map((t) => [t.id, t.name]));
  const teams = priority.map((id) => ({ id, name: nameById.get(id) ?? id }));

  return (
    <div className="mx-auto max-w-xl">
      <Link href={`/leagues/${leagueId}/settings`} className="text-sm text-muted hover:underline">
        ← LM Tools
      </Link>
      <div className="mt-1 flex items-center gap-3">
        <h1 className="text-2xl font-semibold tracking-tight">Edit Waiver Order</h1>
        <Badge tone="muted">{settings.leagueType === "REDRAFT" ? "REDRAFT LEAGUE" : "DYNASTY LEAGUE"}</Badge>
      </div>
      <p className="mt-2 text-sm text-muted">
        1 = first claim. A team that wins a claim rotates to the bottom automatically.
      </p>

      {justSaved && (
        <Card className="mt-4 !border-success/20 !bg-success-tint">
          <p className="text-sm font-medium text-success">Settings saved.</p>
        </Card>
      )}

      <div className="mt-8">
        <SectionLabel>Priority order</SectionLabel>
        <WaiverOrderEditor leagueId={leagueId} teams={teams} />
      </div>
    </div>
  );
}
