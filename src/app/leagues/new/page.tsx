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
      <p className="mt-1 text-sm text-zinc-500">
        Roster composition can&apos;t be changed after this — see DESIGN.md
        §2.4. Everything else here is a starting value you can revisit later.
      </p>

      <form action={createLeagueAction} className="mt-8 space-y-6">
        <div className="grid grid-cols-2 gap-4">
          <label className="block">
            <span className="text-sm text-zinc-500">League name</span>
            <input
              name="name"
              required
              className="mt-1 w-full rounded border border-black/10 bg-transparent px-3 py-2 text-sm outline-none focus:border-black/30 dark:border-white/15 dark:focus:border-white/30"
            />
          </label>
          <label className="block">
            <span className="text-sm text-zinc-500">Season</span>
            <input
              name="season"
              type="number"
              required
              defaultValue={2027}
              className="mt-1 w-full rounded border border-black/10 bg-transparent px-3 py-2 text-sm outline-none focus:border-black/30 dark:border-white/15 dark:focus:border-white/30"
            />
          </label>
        </div>

        <label className="block">
          <span className="text-sm text-zinc-500">Your team name</span>
          <input
            name="teamName"
            required
            className="mt-1 w-full rounded border border-black/10 bg-transparent px-3 py-2 text-sm outline-none focus:border-black/30 dark:border-white/15 dark:focus:border-white/30"
          />
        </label>

        <fieldset>
          <legend className="text-sm text-zinc-500">
            Active roster composition (locked forever once created)
          </legend>
          <div className="mt-2 grid grid-cols-4 gap-3 sm:grid-cols-7">
            {POSITIONS.map((pos) => (
              <label key={pos.key} className="block text-center">
                <span className="text-xs text-zinc-500">{pos.label}</span>
                <input
                  name={pos.key}
                  type="number"
                  min={0}
                  required
                  defaultValue={pos.defaultValue}
                  className="mt-1 w-full rounded border border-black/10 bg-transparent px-2 py-1.5 text-center text-sm outline-none focus:border-black/30 dark:border-white/15 dark:focus:border-white/30"
                />
              </label>
            ))}
          </div>
        </fieldset>

        <div className="grid grid-cols-2 gap-4">
          <label className="block">
            <span className="text-sm text-zinc-500">Farm slots</span>
            <input
              name="farmSlots"
              type="number"
              min={0}
              defaultValue={6}
              className="mt-1 w-full rounded border border-black/10 bg-transparent px-3 py-2 text-sm outline-none focus:border-black/30 dark:border-white/15 dark:focus:border-white/30"
            />
          </label>
          <label className="block">
            <span className="text-sm text-zinc-500">IR slots</span>
            <input
              name="irSlots"
              type="number"
              min={0}
              defaultValue={2}
              className="mt-1 w-full rounded border border-black/10 bg-transparent px-3 py-2 text-sm outline-none focus:border-black/30 dark:border-white/15 dark:focus:border-white/30"
            />
          </label>
        </div>

        <button
          type="submit"
          className="rounded bg-foreground px-4 py-2 text-sm font-medium text-background"
        >
          Create league
        </button>
      </form>
    </div>
  );
}
