const MOBILE_SCRATCHPAD_QUERY = "/?scratchpad=1";
const MOBILE_SCRATCHPAD_MEDIA = "(max-width: 820px)";

type LocationLike = Pick<Location, "pathname" | "search" | "hash">;
type HistoryLike = Pick<History, "replaceState">;
type MatchMediaLike = (query: string) => Pick<MediaQueryList, "matches" | "media">;

export function bootstrapMobileScratchpad(
  location: LocationLike,
  history: HistoryLike,
  matchMedia: MatchMediaLike = window.matchMedia.bind(window),
): boolean {
  if (location.pathname !== "/" || location.search !== "" || location.hash !== "") return false;
  if (!matchMedia(MOBILE_SCRATCHPAD_MEDIA).matches) return false;
  history.replaceState(null, "", MOBILE_SCRATCHPAD_QUERY);
  return true;
}
