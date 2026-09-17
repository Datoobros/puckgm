// Plain string helper, safe for both server and client components (no
// "use client", no server-only deps) — teams have no abbreviation field in
// the schema, so the Scoreboard redesign derives one instead of adding one.

/** First letter of each of up to 4 words in a team name, uppercased (e.g.
 * "Toronto Maple Leafs" -> "TML"); a single-word name uses its first 3
 * letters instead (e.g. "Sharks" -> "SHA") since there are no other words to
 * take initials from. */
export function teamInitials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length <= 1) {
    return (words[0] ?? "").slice(0, 3).toUpperCase();
  }
  return words
    .slice(0, 4)
    .map((w) => w[0]!.toUpperCase())
    .join("");
}
