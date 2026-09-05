import { auth } from "@clerk/nextjs/server";
import { createLeagueAction } from "@/app/leagues/actions";
import { LeagueTypeAndRosterFields } from "./LeagueTypeAndRosterFields";

export default async function NewLeaguePage() {
  await auth.protect();

  return (
    <div className="mx-auto max-w-xl px-6 py-12">
      <h1 className="text-2xl font-semibold tracking-tight">Create a league</h1>
      <p className="mt-1 text-sm text-muted">
        League type, forward positions, and roster composition can&apos;t be changed after this —
        see DESIGN.md §2.4. Everything else here is a starting value you can revisit later.
      </p>

      <form action={createLeagueAction} className="mt-8 space-y-6">
        <div className="grid grid-cols-2 gap-4">
          <label className="block">
            <span className="text-sm text-muted">League name</span>
            <input
              name="name"
              required
              className="mt-1 w-full rounded border border-border bg-transparent px-3 py-2 text-sm outline-none focus:border-blue"
            />
          </label>
          <label className="block">
            <span className="text-sm text-muted">Season</span>
            <input
              name="season"
              type="number"
              required
              defaultValue={2027}
              className="mt-1 w-full rounded border border-border bg-transparent px-3 py-2 text-sm outline-none focus:border-blue"
            />
          </label>
        </div>

        <label className="block">
          <span className="text-sm text-muted">Your team name</span>
          <input
            name="teamName"
            required
            className="mt-1 w-full rounded border border-border bg-transparent px-3 py-2 text-sm outline-none focus:border-blue"
          />
        </label>

        <LeagueTypeAndRosterFields />

        <button
          type="submit"
          className="rounded bg-navy px-4 py-2 text-sm font-medium text-navy-foreground"
        >
          Create league
        </button>
      </form>
    </div>
  );
}
