import { clerkClient } from "@clerk/nextjs/server";

/** Best-effort display name for a Clerk user id — display only, never used
 * for auth. Falls back to a shortened id on lookup failure (deleted
 * account, transient API error) rather than throwing — a missing name
 * shouldn't break a page that's just trying to show who manages a team. */
export async function getUserDisplayName(userId: string): Promise<string> {
  try {
    const client = await clerkClient();
    const user = await client.users.getUser(userId);
    return user.fullName || user.username || user.emailAddresses[0]?.emailAddress || `User ${userId.slice(-6)}`;
  } catch {
    return `User ${userId.slice(-6)}`;
  }
}
