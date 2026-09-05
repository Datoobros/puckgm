"use client";

import { useState } from "react";

/** Blank-silhouette fallback for a missing or broken headshot URL — NHL's
 * CDN doesn't have a photo for every player (rookie-draft-class prospects,
 * retired players, a broken/renamed URL), and that's expected, not an
 * error state. */
export function PlayerHeadshot({
  url,
  alt,
  size = 32,
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
        className="shrink-0 rounded-full bg-surface-tint text-muted"
      >
        <circle cx="12" cy="8.5" r="4" />
        <path d="M4 20.5c0-4.14 3.58-7.5 8-7.5s8 3.36 8 7.5" />
      </svg>
    );
  }

  return (
    <img
      src={url}
      alt={alt}
      width={size}
      height={size}
      className="shrink-0 rounded-full bg-surface-tint object-cover"
      onError={() => setFailed(true)}
    />
  );
}
