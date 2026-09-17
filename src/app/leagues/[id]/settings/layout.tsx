import { notFound } from "next/navigation";
import { auth } from "@clerk/nextjs/server";
import { getLeague, isLeagueCommissioner } from "@/lib/leagues/mutations";

// UX-only gate — every sub-page renders inside this shell, so a
// non-commissioner never sees the hub or any tool page. Each Server Action
// underneath still re-checks isLeagueCommissioner itself: this layout can't
// protect a direct action call that bypasses the rendered page.
export default async function SettingsLayout(props: LayoutProps<"/leagues/[id]/settings">) {
  const { userId } = await auth.protect();
  const { id: leagueId } = await props.params;

  const league = await getLeague(leagueId);
  if (!league) notFound();

  if (!(await isLeagueCommissioner(leagueId, userId))) {
    return (
      <div className="mx-auto max-w-2xl px-6 py-12">
        <p className="text-sm text-muted">Only the league commissioner can view or change settings.</p>
      </div>
    );
  }

  return <div className="mx-auto max-w-7xl px-6 py-8">{props.children}</div>;
}
