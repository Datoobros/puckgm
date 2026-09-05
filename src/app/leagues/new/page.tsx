import { auth } from "@clerk/nextjs/server";
import { createLeagueAction } from "@/app/leagues/actions";

const POSITIONS: { key: string; label: string; defaultValue: number }[] = [
  { key: "posC", label: "C", defaultValue: 2 },
  { key: "posLW", label: "LW", defaultValue: 2 },
  { key: "posRW", label: "RW", defaultValue: 2 },
  { key: "posD", label: "D", defaultValue: 4 },
  { key: "posG", label: "G", defaultValue: 2 },
  { key: "posUTIL", label: "UTIL", defaultValue: 1 },
  { key: "posBENCH", label: "Bench", defaultValue: 6 },
];

export default async function NewLeaguePage() {
  await auth.protect();

  return (
    <div className="mx-auto max-w-xl px-6 py-12">
      <h1 className="text-2xl font-semibold tracking-tight">Create a league</h1>
      <p className="mt-1 text-sm text-muted">
        Roster composition can&apos;t be changed after this — see DESIGN.md
        §2.4. Everything else here is a starting value you can revisit later.
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

        <fieldset>
          <legend className="text-sm text-muted">
            Active roster composition (locked forever once created)
          </legend>
          <div className="mt-2 grid grid-cols-4 gap-3 sm:grid-cols-7">
            {POSITIONS.map((pos) => (
              <label key={pos.key} className="block text-center">
                <span className="text-xs text-muted">{pos.label}</span>
                <input
                  name={pos.key}
                  type="number"
                  min={0}
                  required
                  defaultValue={pos.defaultValue}
                  className="mt-1 w-full rounded border border-border bg-transparent px-2 py-1.5 text-center text-sm outline-none focus:border-blue"
                />
              </label>
            ))}
          </div>
        </fieldset>

        <div className="grid grid-cols-2 gap-4">
          <label className="block">
            <span className="text-sm text-muted">Farm slots</span>
            <input
              name="farmSlots"
              type="number"
              min={0}
              defaultValue={6}
              className="mt-1 w-full rounded border border-border bg-transparent px-3 py-2 text-sm outline-none focus:border-blue"
            />
          </label>
          <label className="block">
            <span className="text-sm text-muted">IR slots</span>
            <input
              name="irSlots"
              type="number"
              min={0}
              defaultValue={2}
              className="mt-1 w-full rounded border border-border bg-transparent px-3 py-2 text-sm outline-none focus:border-blue"
            />
          </label>
        </div>

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
