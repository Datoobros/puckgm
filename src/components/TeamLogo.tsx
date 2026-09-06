"use client";

import { useState } from "react";

/** Shield/crest placeholder for a team with no logo set (or a broken URL) —
 * expected for most teams, not an error state. Mirrors PlayerHeadshot's
 * load-failure fallback shape. */
export function TeamLogo({
  url,
  alt,
  size = 56,
}: {
  url: string | null;
  alt: string;
  size?: number;
}) {
  const [failed, setFailed] = useState(false);

  if (!url || failed) {
    return (
      <svg
        width={size}
        height={size}
        viewBox="0 0 24 24"
        fill="currentColor"
        role="img"
        aria-label={alt}
        className="shrink-0 rounded-xl bg-surface-tint text-muted"
      >
        <path d="M12 2 4 5v6c0 5 3.4 8.9 8 11 4.6-2.1 8-6 8-11V5l-8-3Z" />
      </svg>
    );
  }

  return (
    <img
      src={url}
      alt={alt}
      width={size}
      height={size}
      className="shrink-0 rounded-xl bg-surface-tint object-cover"
      onError={() => setFailed(true)}
    />
  );
}
