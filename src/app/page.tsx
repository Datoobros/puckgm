import Link from "next/link";
import { Show } from "@clerk/nextjs";
import { currentUser } from "@clerk/nextjs/server";

export default async function Home() {
  const user = await currentUser();

  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-4 px-6 text-center">
      <h1 className="text-3xl font-semibold tracking-tight">puckgm</h1>
      <p className="max-w-md text-zinc-600 dark:text-zinc-400">
        Dynasty fantasy hockey GM sim. Early days — player stats are the
        first thing built.
      </p>
      <Show when="signed-in">
        <p className="text-sm text-zinc-500">
          Signed in as {user?.primaryEmailAddress?.emailAddress ?? user?.id}
        </p>
        <div className="flex gap-3">
          <Link
            href="/players"
            className="rounded bg-foreground px-4 py-2 text-sm font-medium text-background"
          >
            Browse players
          </Link>
          <Link
            href="/leagues"
            className="rounded border border-black/10 px-4 py-2 text-sm font-medium dark:border-white/15"
          >
            Leagues
          </Link>
        </div>
      </Show>
      <Show when="signed-out">
        <p className="text-sm text-zinc-500">
          Sign in above, then head to the players page to see real stats.
        </p>
      </Show>
    </div>
  );
}
