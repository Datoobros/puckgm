"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

// Opposing Teams/LM Tools would just duplicate what the League page already
// shows (the team list, and the commissioner tools card) rather than being
// real distinct destinations, so they're left out.
export function LeagueNav({ leagueId, myTeamId }: { leagueId: string; myTeamId: string | null }) {
  const pathname = usePathname();

  const links = [
    myTeamId ? { href: `/leagues/${leagueId}/teams/${myTeamId}`, label: "My Team" } : null,
    { href: `/leagues/${leagueId}`, label: "League" },
    { href: `/leagues/${leagueId}/scoreboard`, label: "Scoreboard" },
    { href: `/leagues/${leagueId}/standings`, label: "Standings" },
    { href: `/leagues/${leagueId}/players`, label: "Players" },
  ].filter((l): l is { href: string; label: string } => l !== null);

  return (
    <nav className="flex items-center gap-1 border-b border-black/10 bg-black/[.02] px-6 py-2 dark:border-white/10 dark:bg-white/[.03]">
      {links.map((link) => {
        const isActive = pathname === link.href;
        return (
          <Link
            key={link.href}
            href={link.href}
            className={`rounded px-3 py-1.5 text-sm font-medium transition-colors ${
              isActive
                ? "bg-foreground text-background"
                : "text-zinc-500 hover:text-foreground"
            }`}
          >
            {link.label}
          </Link>
        );
      })}
    </nav>
  );
}
