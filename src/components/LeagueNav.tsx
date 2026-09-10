"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

export function LeagueNav({
  leagueId,
  myTeamId,
  isCommissioner,
}: {
  leagueId: string;
  myTeamId: string | null;
  isCommissioner: boolean;
}) {
  const pathname = usePathname();

  const links = [
    { href: `/leagues/${leagueId}`, label: "League" },
    myTeamId ? { href: `/leagues/${leagueId}/teams/${myTeamId}`, label: "My Team" } : null,
    { href: `/leagues/${leagueId}/players`, label: "Players" },
    { href: `/leagues/${leagueId}/trades`, label: "Trades" },
    { href: `/leagues/${leagueId}/draft`, label: "Draft" },
    { href: `/leagues/${leagueId}/scoreboard`, label: "Scoreboard" },
    { href: `/leagues/${leagueId}/standings`, label: "Standings" },
    { href: `/leagues/${leagueId}/teams`, label: "Other Teams" },
  ].filter((l): l is { href: string; label: string } => l !== null);

  return (
    <nav className="flex items-center gap-4 border-b border-border bg-surface px-6">
      {links.map((link) => {
        const isActive = pathname === link.href;
        return (
          <Link
            key={link.href}
            href={link.href}
            className={`border-b-2 px-0.5 py-2.5 text-sm font-medium transition-colors ${
              isActive ? "border-blue text-foreground" : "border-transparent text-muted hover:text-foreground"
            }`}
          >
            {link.label}
          </Link>
        );
      })}
      {isCommissioner && (
        <Link
          href={`/leagues/${leagueId}/settings`}
          className={`ml-auto border-b-2 px-0.5 py-2.5 text-sm font-medium transition-colors ${
            pathname === `/leagues/${leagueId}/settings` ? "border-gold text-gold" : "border-transparent text-gold hover:text-gold/80"
          }`}
        >
          Commissioner Settings
        </Link>
      )}
    </nav>
  );
}
