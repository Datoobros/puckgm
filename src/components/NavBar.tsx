"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

// No global "Players" link — players are always viewed within a league now
// (scoring is league-specific), so that link lives in LeagueNav instead.
const LINKS = [
  { href: "/", label: "Home" },
  { href: "/leagues", label: "Leagues" },
];

export function NavBar() {
  const pathname = usePathname();

  return (
    <nav className="flex items-center gap-1">
      {LINKS.map((link) => {
        const isActive =
          link.href === "/" ? pathname === "/" : pathname.startsWith(link.href);
        return (
          <Link
            key={link.href}
            href={link.href}
            className={`rounded px-3 py-1.5 text-sm font-medium transition-colors ${
              isActive ? "bg-gold text-gold-foreground" : "text-navy-foreground/70 hover:text-navy-foreground"
            }`}
          >
            {link.label}
          </Link>
        );
      })}
    </nav>
  );
}
