import { Show } from "@clerk/nextjs";
import { currentUser } from "@clerk/nextjs/server";

export default async function Home() {
  const user = await currentUser();

  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-4 px-6 text-center">
      <h1 className="text-3xl font-semibold tracking-tight">puckgm</h1>
      <p className="max-w-md text-zinc-600 dark:text-zinc-400">
        Dynasty fantasy hockey GM sim. Early days — player stats and leagues
        are the first things built.
      </p>
      <Show when="signed-in">
        <p className="text-sm text-zinc-500">
          Signed in as {user?.primaryEmailAddress?.emailAddress ?? user?.id}
        </p>
      </Show>
      <Show when="signed-out">
        <p className="text-sm text-zinc-500">
          Sign in above to get started.
        </p>
      </Show>
    </div>
  );
}
