import { clerkClient } from "@clerk/nextjs/server";

export interface KnownUser {
  id: string;
  name: string;
  email: string;
}

/** Same name-fallback chain as getUserDisplayName (display.ts), for the
 * Reassign picker's option labels. Best-effort: an empty list on failure
 * rather than throwing, matching display.ts's philosophy — a directory
 * lookup failing shouldn't break the page that's rendering it. */
export async function listKnownUsers(): Promise<KnownUser[]> {
  try {
    const client = await clerkClient();
    const { data } = await client.users.getUserList({ limit: 100, orderBy: "-created_at" });
    return data.map((user) => ({
      id: user.id,
      name: user.fullName || user.username || user.emailAddresses[0]?.emailAddress || `User ${user.id.slice(-6)}`,
      email: user.emailAddresses[0]?.emailAddress ?? "",
    }));
  } catch {
    return [];
  }
}

/** Clerk's getUserList emailAddress filter is a partial match (per its own
 * docs), so an exact match is enforced here — otherwise inviteManagerByEmail
 * could assign a team to the wrong person off a substring hit. */
export async function findUserByEmail(email: string): Promise<{ id: string } | null> {
  const normalized = email.trim().toLowerCase();
  try {
    const client = await clerkClient();
    const { data } = await client.users.getUserList({ emailAddress: [normalized] });
    const match = data.find((user) => user.emailAddresses.some((e) => e.emailAddress.toLowerCase() === normalized));
    return match ? { id: match.id } : null;
  } catch {
    return null;
  }
}
