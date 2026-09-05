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
    { href: `/leagues/${leagueId}/scoreboard`, label: "Scoreboard" },
    { href: `/leagues/${leagueId}/standings`, label: "Standings" },
    { href: `/leagues/${leagueId}/teams`, label: "Other Teams" },
  ].filter((l): l is { href: string; label: string } => l !== null);

  return (
    <nav className="flex items-center gap-1 border-b border-border bg-surface px-6 py-2">
      {links.map((link) => {
        const isActive = pathname === link.href;
        return (
          <Link
            key={link.href}
            href={link.href}
            className={`rounded px-3 py-1.5 text-sm font-medium transition-colors ${
              isActive ? "bg-gold text-gold-foreground" : "text-muted hover:text-foreground"
            }`}
          >
            {link.label}
          </Link>
        );
      })}
      {isCommissioner && (
        <Link
          href={`/leagues/${leagueId}/settings`}
          className={`ml-auto rounded px-3 py-1.5 text-sm font-medium transition-colors ${
            pathname === `/leagues/${leagueId}/settings` ? "bg-gold text-gold-foreground" : "text-gold hover:text-gold/80"
          }`}
        >
          Commissioner Settings
        </Link>
      )}
    </nav>
  );
}
