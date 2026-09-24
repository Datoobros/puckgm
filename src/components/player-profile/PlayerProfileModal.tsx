"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Modal } from "@/components/Modal";
import { Card, SectionLabel } from "@/components/Card";
import { Button } from "@/components/Button";
import { PlayerHeadshot } from "@/components/PlayerHeadshot";
import { SKATER_COLUMNS, GOALIE_COLUMNS } from "@/lib/players/columns";
import { getPlayerProfileAction, toggleWatchlistAction } from "@/app/leagues/[id]/players/actions";
import { PlayerProfileActions } from "@/components/player-profile/PlayerProfileActions";
import type { PlayerProfile, PlayerLeagueStatus } from "@/lib/players/profile";

// "Connor McDavid" -> "C. McDavid" — same compact-name rule as the
// scoreboard's top-scorer rows (scoreboard/page.tsx's shortPlayerName,
// not exported).
function shortPlayerName(fullName: string): string {
  const parts = fullName.trim().split(/\s+/);
  if (parts.length < 2) return fullName;
  return `${parts[0][0]}. ${parts[parts.length - 1]}`;
}

function formatGameDate(dateStr: string): string {
  const [, m, d] = dateStr.split("-");
  return `${Number(m)}/${Number(d)}`;
}

function formatEventTimestamp(iso: string): string {
  return new Date(iso)
    .toLocaleString(undefined, {
      weekday: "short",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    })
    .toUpperCase();
}

function managerLabel(status: PlayerLeagueStatus): string {
  if (status.waivers) return `Waivers (from ${status.waivers.demotingTeamName})`;
  if (status.ownedBy) return status.ownedBy.teamName;
  return "Free Agent";
}

export function PlayerProfileModal({
  leagueId,
  playerId,
  nav,
  onNavigate,
  onClose,
}: {
  leagueId: string;
  playerId: string;
  nav?: { players: { id: string; fullName: string }[] };
  onNavigate: (playerId: string) => void;
  onClose: () => void;
}) {
  const router = useRouter();
  const [profile, setProfile] = useState<PlayerProfile | null>(null);
  const [fetching, setFetching] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showAllGames, setShowAllGames] = useState(false);
  const [watching, setWatching] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    setShowAllGames(false);
    setFetching(true);
    getPlayerProfileAction(leagueId, playerId)
      .then((p) => {
        if (cancelled) return;
        setProfile(p);
        setWatching(p.watching);
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : "Couldn't load player.");
      })
      .finally(() => {
        if (!cancelled) setFetching(false);
      });
    return () => {
      cancelled = true;
    };
  }, [leagueId, playerId]);

  async function reload() {
    setFetching(true);
    setError(null);
    try {
      const p = await getPlayerProfileAction(leagueId, playerId);
      setProfile(p);
      setWatching(p.watching);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't load player.");
    } finally {
      setFetching(false);
    }
  }

  const navIndex = nav ? nav.players.findIndex((p) => p.id === playerId) : -1;
  const prevPlayer = nav && navIndex > 0 ? nav.players[navIndex - 1] : null;
  const nextPlayer = nav && navIndex !== -1 && navIndex < nav.players.length - 1 ? nav.players[navIndex + 1] : null;

  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if (e.key === "ArrowLeft" && prevPlayer) onNavigate(prevPlayer.id);
      if (e.key === "ArrowRight" && nextPlayer) onNavigate(nextPlayer.id);
    }
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [prevPlayer, nextPlayer, onNavigate]);

  async function handleToggleWatch() {
    setWatching((w) => !w);
    try {
      await toggleWatchlistAction(leagueId, playerId);
      router.refresh();
    } catch {
      setWatching((w) => !w);
    }
  }

  const statCols = profile ? (profile.player.isGoalie ? GOALIE_COLUMNS : SKATER_COLUMNS).filter((c) => c.key !== "gp") : [];

  return (
    <Modal open bare size="xl" title={profile?.player.fullName ?? "Player"} onClose={onClose}>
      <div className="relative mx-auto flex max-w-3xl flex-col gap-3 py-6">
        <div className="sticky top-2 z-20 flex justify-end px-2">
          {/* Solid dark circle, not just white text — once scrolled past the
           * header card this sits directly over white Card backgrounds
           * (same viewport position, content scrolled underneath), where
           * plain white text would disappear. */}
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="flex h-8 w-8 items-center justify-center rounded-full bg-black/70 text-lg leading-none text-white shadow hover:bg-black/85"
          >
            ✕
          </button>
        </div>

        {(prevPlayer || nextPlayer) && (
          <>
            <div className="pointer-events-none sticky top-1/2 z-10 hidden md:block">
              {prevPlayer && (
                <button
                  type="button"
                  onClick={() => onNavigate(prevPlayer.id)}
                  className="pointer-events-auto absolute -left-24 top-0 -translate-y-1/2 whitespace-nowrap rounded-md bg-white px-3 py-2 text-sm font-medium text-foreground shadow hover:bg-surface-tint"
                >
                  ‹ {shortPlayerName(prevPlayer.fullName)}
                </button>
              )}
              {nextPlayer && (
                <button
                  type="button"
                  onClick={() => onNavigate(nextPlayer.id)}
                  className="pointer-events-auto absolute -right-24 top-0 -translate-y-1/2 whitespace-nowrap rounded-md bg-white px-3 py-2 text-sm font-medium text-foreground shadow hover:bg-surface-tint"
                >
                  {shortPlayerName(nextPlayer.fullName)} ›
                </button>
              )}
            </div>
            <div className="flex items-center justify-center gap-3 text-sm md:hidden">
              {prevPlayer ? (
                <button type="button" onClick={() => onNavigate(prevPlayer.id)} className="text-blue hover:underline">
                  ‹ {shortPlayerName(prevPlayer.fullName)}
                </button>
              ) : (
                <span />
              )}
              <span className="text-muted">·</span>
              {nextPlayer ? (
                <button type="button" onClick={() => onNavigate(nextPlayer.id)} className="text-blue hover:underline">
                  {shortPlayerName(nextPlayer.fullName)} ›
                </button>
              ) : (
                <span />
              )}
            </div>
          </>
        )}

        {error ? (
          <Card>
            <p className="text-sm text-danger">{error}</p>
            <Button type="button" variant="ghost" size="sm" className="mt-2" onClick={reload}>
              Retry
            </Button>
          </Card>
        ) : !profile ? (
          <Card>
            <p className="text-sm text-muted">Loading…</p>
          </Card>
        ) : (
          <div className={`flex flex-col gap-3 ${fetching ? "opacity-60" : ""}`}>
            <Card className="relative">
              {profile.status.viewerTeamId && (
                <button
                  type="button"
                  onClick={handleToggleWatch}
                  title={watching ? "Remove from watchlist" : "Add to watchlist"}
                  className={`absolute right-3 top-3 text-lg ${watching ? "text-gold" : "text-muted/40 hover:text-muted"}`}
                >
                  {watching ? "★" : "☆"}
                </button>
              )}
              <div className="flex flex-col gap-4 md:flex-row">
                <div className="relative shrink-0 self-start">
                  <PlayerHeadshot url={profile.player.headshotUrl} alt={profile.player.fullName} size={120} shape="square" />
                  {profile.player.nhlTeamLogoUrl && (
                    // eslint-disable-next-line @next/next/no-img-element -- external NHL CDN, size varies, onError fallback needed
                    <img
                      src={profile.player.nhlTeamLogoUrl}
                      alt=""
                      className="absolute left-2 top-2 h-10 w-10"
                      onError={(e) => {
                        e.currentTarget.style.display = "none";
                      }}
                    />
                  )}
                  {profile.player.sweaterNumber !== null && (
                    <div className="mt-1 text-center text-sm font-medium text-muted">#{profile.player.sweaterNumber}</div>
                  )}
                </div>
                <div className="flex-1">
                  <div className="text-2xl">
                    <span className="font-normal">{profile.player.firstName}</span>{" "}
                    <span className="font-bold">{profile.player.lastName}</span>
                  </div>
                  <div className="text-sm text-muted">{profile.player.nhlTeamName ?? profile.player.currentNhlOrg ?? "—"}</div>
                  <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
                    <dt className="text-xs font-medium uppercase tracking-wide text-muted">Elig</dt>
                    <dd>{profile.player.positionLabel}</dd>
                    <dt className="text-xs font-medium uppercase tracking-wide text-muted">Manager</dt>
                    <dd>{managerLabel(profile.status)}</dd>
                    <dt className="text-xs font-medium uppercase tracking-wide text-muted">Status</dt>
                    <dd className={profile.player.healthStatus === "Healthy" ? "text-success" : "text-danger"}>
                      {profile.player.healthStatus} ●
                    </dd>
                    {profile.player.draftPedigree && (
                      <>
                        <dt className="text-xs font-medium uppercase tracking-wide text-muted">Draft</dt>
                        <dd>{profile.player.draftPedigree}</dd>
                      </>
                    )}
                  </dl>
                </div>
                <div className="flex shrink-0 gap-6 border-border pt-3 md:border-l md:pl-6 md:pt-0">
                  <div>
                    <div className="text-xs font-medium uppercase tracking-wide text-muted">Position Rank</div>
                    <div className="text-lg font-semibold">
                      {profile.rank ? `#${profile.rank.position} of ${profile.rank.groupSize} ${profile.rank.groupLabel}` : "--"}
                    </div>
                  </div>
                  <div>
                    <div className="text-xs font-medium uppercase tracking-wide text-muted">Average Points</div>
                    <div className="text-lg font-semibold">
                      {profile.averagePoints !== null ? profile.averagePoints.toFixed(1) : "--"}
                    </div>
                  </div>
                </div>
              </div>
            </Card>

            {profile.status.viewerTeamId && (
              <PlayerProfileActions
                key={playerId}
                leagueId={leagueId}
                playerId={playerId}
                playerName={profile.player.fullName}
                status={profile.status}
                onChanged={async () => {
                  await reload();
                  router.refresh();
                }}
              />
            )}

            <Card>
              <SectionLabel>Stats</SectionLabel>
              {profile.gameLog.length === 0 ? (
                <p className="text-sm text-muted">No NHL games ingested.</p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[480px] border-collapse text-sm">
                    <thead>
                      <tr className="border-b border-border text-left text-muted">
                        <th className="py-2 pr-2 font-medium" />
                        <th className="py-2 pr-2 text-right font-medium">GP</th>
                        <th className="py-2 pr-2 text-right font-medium">ATOI</th>
                        {statCols.map((c) => (
                          <th key={c.key} className="py-2 pr-2 text-right font-medium">
                            {c.label}
                          </th>
                        ))}
                        <th className="py-2 pr-2 text-right font-medium">FPTS</th>
                      </tr>
                    </thead>
                    <tbody>
                      {profile.seasons.map((season) => {
                        const gp = season.stats.gamesIngested;
                        return (
                          <tr key={season.label} className="border-b border-border">
                            <td className="py-2 pr-2">{season.label}</td>
                            <td className="py-2 pr-2 text-right tabular-nums">{gp}</td>
                            <td className="py-2 pr-2 text-right tabular-nums">{gp === 0 ? "—" : (season.atoi ?? "—")}</td>
                            {statCols.map((c) => (
                              <td key={c.key} className="py-2 pr-2 text-right tabular-nums">
                                {gp === 0 ? "—" : c.format ? c.format(c.get(season.stats)) : c.get(season.stats)}
                              </td>
                            ))}
                            <td className="py-2 pr-2 text-right tabular-nums">{gp === 0 ? "—" : season.stats.points.toFixed(1)}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </Card>

            <Card>
              <SectionLabel>Game Log</SectionLabel>
              {profile.gameLog.length === 0 ? (
                <p className="text-sm text-muted">No games yet.</p>
              ) : (
                <>
                  <div className="overflow-x-auto">
                    <table className="w-full min-w-[560px] border-collapse text-sm">
                      <thead>
                        <tr className="border-b border-border text-left text-muted">
                          <th className="py-2 pr-2 font-medium">Date</th>
                          <th className="py-2 pr-2 font-medium">Opp</th>
                          <th className="py-2 pr-2 text-right font-medium">TOI</th>
                          {statCols.map((c) => (
                            <th key={c.key} className="py-2 pr-2 text-right font-medium">
                              {c.label}
                            </th>
                          ))}
                          <th className="py-2 pr-2 text-right font-medium">FPTS</th>
                        </tr>
                      </thead>
                      <tbody>
                        {profile.gameLog.slice(0, showAllGames ? 25 : 5).map((g) => (
                          <tr key={g.gameId} className="border-b border-border">
                            <td className="py-2 pr-2 whitespace-nowrap">{formatGameDate(g.date)}</td>
                            <td className="py-2 pr-2" title={g.result ?? undefined}>
                              {g.opponent ?? "—"}
                            </td>
                            <td className="py-2 pr-2 text-right tabular-nums">{g.toi ?? "—"}</td>
                            {statCols.map((c) => (
                              <td key={c.key} className="py-2 pr-2 text-right tabular-nums">
                                {c.format ? c.format(c.get(g.stats)) : c.get(g.stats)}
                              </td>
                            ))}
                            <td className="py-2 pr-2 text-right tabular-nums">{g.stats.points.toFixed(1)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  {!showAllGames && profile.gameLog.length > 5 && (
                    <button
                      type="button"
                      onClick={() => setShowAllGames(true)}
                      className="mt-2 block w-full text-center text-sm text-blue hover:underline"
                    >
                      Show More
                    </button>
                  )}
                </>
              )}
            </Card>

            <Card>
              <SectionLabel>All Transactions</SectionLabel>
              {profile.transactions.length === 0 ? (
                <p className="text-sm text-muted">No transactions in this league yet.</p>
              ) : (
                <div className="-mx-4 divide-y divide-border">
                  {profile.transactions.map((event) => (
                    <div key={event.id}>
                      <div className="bg-surface-tint px-4 py-1 text-xs font-medium uppercase tracking-wide text-muted">
                        {formatEventTimestamp(event.at)}
                      </div>
                      <div className="px-4 py-2 text-sm">
                        <p>
                          <strong>{event.verb}</strong> {event.headline}
                        </p>
                        {event.details.map((d, i) => (
                          <p key={i} className="text-muted">
                            {d.fromTeam} traded <strong className="text-foreground">{d.asset}</strong>
                            {d.assetSuffix} to {d.toTeam}
                          </p>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </Card>
          </div>
        )}
      </div>
    </Modal>
  );
}
