import type { PrReviewer } from "@citadel/contracts";
import { formatLabel } from "./labels.js";

const AVATAR_PALETTE: ReadonlyArray<readonly [string, string]> = [
  ["#8e6b4a", "#4a3622"],
  ["#5a7a8e", "#2a4252"],
  ["#7a5a8e", "#3a2a52"],
  ["#5a8e6b", "#2a4a36"],
  ["#8e5a6b", "#522a36"],
  ["#5a6b8e", "#2a3652"],
] as const;
const AVATAR_DEFAULT: readonly [string, string] = ["#8e6b4a", "#4a3622"];

export function ReviewerAvatars({ reviewers }: { reviewers: PrReviewer[] }) {
  if (!reviewers.length) return <span className="ins-pr-avatars" aria-hidden />;
  const visible = reviewers.slice(0, 3);
  const extra = reviewers.length - visible.length;
  return (
    <span className="ins-pr-avatars">
      {visible.map((reviewer) => (
        <span
          key={reviewer.login}
          className={`ins-av ins-av--${reviewer.state}`}
          style={{ background: avatarGradient(reviewer.login) }}
          title={`${reviewer.name ?? reviewer.login} · ${formatLabel(reviewer.state)}`}
        >
          {reviewerInitials(reviewer)}
        </span>
      ))}
      {extra > 0 ? (
        <span className="ins-av ins-av-more" title={`+${extra} more reviewers`}>
          +{extra}
        </span>
      ) : null}
    </span>
  );
}

export function aggregateReviewerCounts(reviewers: PrReviewer[]) {
  let approved = 0;
  let changes = 0;
  let pending = 0;
  for (const reviewer of reviewers) {
    if (reviewer.state === "approved") approved += 1;
    else if (reviewer.state === "changes_requested") changes += 1;
    else if (reviewer.state === "pending") pending += 1;
  }
  return { approved, changes, pending };
}

function reviewerInitials(reviewer: PrReviewer) {
  const source = reviewer.name?.trim() || reviewer.login;
  const tokens = source.split(/[\s_.-]+/).filter(Boolean);
  if (tokens.length >= 2) return `${tokens[0]?.[0] ?? ""}${tokens[1]?.[0] ?? ""}`.toUpperCase();
  return source.slice(0, 2).toUpperCase();
}

function avatarGradient(seed: string) {
  let hash = 0;
  for (let i = 0; i < seed.length; i += 1) hash = (hash * 31 + seed.charCodeAt(i)) >>> 0;
  const pair = AVATAR_PALETTE[hash % AVATAR_PALETTE.length] ?? AVATAR_DEFAULT;
  return `linear-gradient(135deg, ${pair[0]}, ${pair[1]})`;
}
