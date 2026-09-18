import Link from "next/link";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { auth } from "@clerk/nextjs/server";
import { getLeague, teamHasHistory } from "@/lib/leagues/mutations";
import { getUserDisplayName } from "@/lib/users/display";
import { listKnownUsers } from "@/lib/users/directory";
import {
  reassignTeamManagerAction,
  orphanTeamAction,
  regenerateTeamClaimCodeAction,
  addTeamAsCommissionerAction,
  regenerateInviteCodeAction,
  inviteManagerByEmailAction,
  inviteToLeagueByEmailAction,
} from "@/app/leagues/actions";
import { Card, SectionLabel } from "@/components/Card";
import { Button, Badge } from "@/components/Button";
import { ConfirmActionButton } from "@/components/ConfirmActionButton";
import { DeleteTeamButton } from "@/components/DeleteTeamButton";
import { InviteByEmailForm } from "@/components/InviteByEmailForm";

export default async function ManagersPage(props: PageProps<"/leagues/[id]/settings/managers">) {
  const { userId } = await auth.protect();
  const { id: leagueId } = await props.params;
  const sp = await props.searchParams;
  const justInvited = (Array.isArray(sp.invited) ? sp.invited[0] : sp.invited) === "1";

  const league = await getLeague(leagueId);
  if (!league) notFound();

  const h = await headers();
  const origin = `${h.get("x-forwarded-proto") ?? "https"}://${h.get("host")}`;
  const inviteUrl = league.inviteCode ? `${origin}/invite/${league.inviteCode}` : null;

  // Excludes anyone already managing (primary or co-) a team in this
  // league from the Reassign picker — reassigning to someone who already
  // has a team here would just fail setTeamManager's own check anyway.
  const takenUserIds = new Set(league.teams.flatMap((t) => [t.managerUserId, t.secondManagerUserId].filter((id): id is string => !!id)));
  const knownUsers = (await listKnownUsers()).filter((u) => !takenUserIds.has(u.id));

  const teams = await Promise.all(
    league.teams.map(async (t) => ({
      id: t.id,
      name: t.name,
      managerUserId: t.managerUserId,
      managerName: await getUserDisplayName(t.managerUserId),
      state: t.state,
      isCoCommissioner: t.isCoCommissioner,
      claimCode: t.claimCode,
      invitedEmail: t.invitedEmail,
      // A commissioner-owned placeholder (added via "Add a team", never
      // claimed) or an orphaned team has no real manager to displace, so
      // inviting needs no confirm — anything else is replacing a live person.
      isPlaceholderOrOrphaned: t.managerUserId === userId || t.state === "ORPHAN_FROZEN",
      hasHistory: await teamHasHistory(t.id),
    })),
  );

  return (
    <div>
      <Link href={`/leagues/${leagueId}/settings`} className="text-sm text-muted hover:underline">
        ← LM Tools
      </Link>
      <h1 className="mt-1 text-2xl font-semibold tracking-tight">Edit Managers and Send Invitations</h1>
      <p className="mt-2 max-w-2xl text-sm text-muted">
        Reassign a team to a new manager, freeze an abandoned team, hand off a team via claim link, or
        remove a team with no real history yet.
      </p>
      <p className="mt-1 max-w-2xl text-xs text-muted">
        ⓘ Invitations are sent by our sign-in provider (Clerk). Someone who already has an account is
        assigned immediately instead of being emailed.
      </p>

      {justInvited && (
        <Card className="mt-4 !border-success/20 !bg-success-tint">
          <p className="text-sm font-medium text-success">Invitation sent.</p>
        </Card>
      )}

      <div className="mt-6 overflow-x-auto">
        <Card className="!p-0">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b border-border text-xs uppercase tracking-wide text-muted">
                <th className="px-4 py-3 font-medium">Team</th>
                <th className="px-4 py-3 font-medium">Manager</th>
                <th className="px-4 py-3 font-medium">Status</th>
                <th className="px-4 py-3 font-medium">Actions</th>
              </tr>
            </thead>
            <tbody>
              {teams.map((team) => (
                <tr key={team.id} className="border-b border-border last:border-0 align-top">
                  <td className="px-4 py-3 font-medium">{team.name}</td>
                  <td className="px-4 py-3 text-muted">{team.managerName}</td>
                  <td className="px-4 py-3">
                    <div className="flex flex-wrap gap-1">
                      {team.state === "ORPHAN_FROZEN" && <Badge tone="warning">Orphaned — frozen</Badge>}
                      {team.isCoCommissioner && <Badge tone="gold">Co-commissioner</Badge>}
                      {team.invitedEmail ? (
                        <Badge tone="muted">Invited: {team.invitedEmail} (pending)</Badge>
                      ) : (
                        team.claimCode && <Badge tone="muted">Invited: pending claim</Badge>
                      )}
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex flex-col items-start gap-2">
                      <form action={reassignTeamManagerAction.bind(null, leagueId, team.id)} className="flex items-center gap-1">
                        <select
                          name="newManagerUserId"
                          required
                          defaultValue=""
                          className="rounded border border-border bg-surface px-2 py-1 text-xs text-foreground"
                        >
                          <option value="" disabled>
                            Select a user…
                          </option>
                          {knownUsers.map((u) => (
                            <option key={u.id} value={u.id}>
                              {u.name}
                              {u.email ? ` (${u.email})` : ""}
                            </option>
                          ))}
                        </select>
                        <Button type="submit" size="sm">Reassign</Button>
                      </form>

                      {team.isPlaceholderOrOrphaned ? (
                        <InviteByEmailForm action={inviteManagerByEmailAction.bind(null, leagueId, team.id)} label="Invite by email" />
                      ) : (
                        <InviteByEmailForm
                          action={inviteManagerByEmailAction.bind(null, leagueId, team.id)}
                          label="Replace manager by email"
                          confirmText={`Replace ${team.managerName}'s access to "${team.name}" with whoever accepts this invite? Someone with an existing account is assigned immediately instead of being emailed.`}
                        />
                      )}

                      {team.state !== "ORPHAN_FROZEN" && (
                        <ConfirmActionButton
                          action={orphanTeamAction.bind(null, leagueId, team.id)}
                          confirmText={`Mark "${team.name}" as orphaned? Its roster freezes (no trades, adds/drops, waivers, or FAAB) until reassigned.`}
                          label="Orphan"
                          size="sm"
                        />
                      )}

                      <div className="flex items-center gap-1">
                        <form action={regenerateTeamClaimCodeAction.bind(null, leagueId, team.id)}>
                          <Button type="submit" size="sm">
                            {team.claimCode ? "Regenerate claim link" : "Generate claim link"}
                          </Button>
                        </form>
                      </div>
                      {team.claimCode && (
                        <p className="select-all rounded border border-border bg-surface-tint px-2 py-1 text-[11px] break-all">
                          {origin}/invite/team/{team.claimCode}
                        </p>
                      )}

                      {team.hasHistory ? (
                        <span
                          className="text-xs text-muted"
                          title="Has roster, draft pick, trade, waiver, FAAB, or schedule history"
                        >
                          Can&apos;t delete — has real history
                        </span>
                      ) : (
                        <DeleteTeamButton leagueId={leagueId} teamId={team.id} teamName={team.name} />
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      </div>

      <div className="mt-6">
        <SectionLabel>Add a team</SectionLabel>
        <Card>
          <form action={addTeamAsCommissionerAction.bind(null, leagueId)} className="flex items-center gap-2">
            <input
              name="teamName"
              required
              placeholder="New team name"
              className="rounded border border-border bg-transparent px-2 py-1 text-xs outline-none focus:border-blue"
            />
            <Button type="submit" size="sm">Add Team</Button>
          </form>
          <p className="mt-2 text-xs text-muted">
            A commissioner-added team starts owned by you administratively — generate its claim link and
            hand it to the real manager.
          </p>
        </Card>
      </div>

      <div className="mt-6">
        <SectionLabel>League invite link</SectionLabel>
        <Card>
          <p className="text-xs text-muted">
            The site itself is open to anyone signed in — this link is what actually lets someone join{" "}
            <em>this</em> league. Share it with whoever you want in; regenerating it invalidates the old
            link.
          </p>
          {inviteUrl ? (
            <p className="mt-2 select-all rounded border border-border bg-surface-tint px-3 py-2 text-sm">
              {inviteUrl}
            </p>
          ) : (
            <p className="mt-2 text-sm text-muted">No invite link generated yet.</p>
          )}
          <form action={regenerateInviteCodeAction.bind(null, leagueId)} className="mt-3">
            <Button type="submit" size="sm">
              {inviteUrl ? "Regenerate link" : "Generate invite link"}
            </Button>
          </form>
          <div className="mt-4 border-t border-border pt-4">
            <p className="text-xs text-muted">
              Or invite someone by email — they get their own new team on sign-up, same as clicking the
              link above.
            </p>
            <div className="mt-2">
              <InviteByEmailForm action={inviteToLeagueByEmailAction.bind(null, leagueId)} label="Invite to league by email" />
            </div>
          </div>
        </Card>
      </div>

      <p className="mt-6 text-xs text-muted">
        Need to grant co-commissioner access instead? See{" "}
        <Link href={`/leagues/${leagueId}/settings/powers`} className="hover:underline">
          Assign League Manager Powers
        </Link>
        .
      </p>
    </div>
  );
}
