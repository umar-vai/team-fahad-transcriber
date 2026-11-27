/** Labels shared by pages. */
export const SOURCE_LABEL: Record<string, string> = {
  upload: "File", link: "Link", youtube: "YouTube", live: "Live voice", drive: "Drive", bridge: "Bridge PC",
};
export const SOURCE_ICON: Record<string, string> = {
  upload: "audio", link: "link", youtube: "youtube", live: "mic", drive: "cloud", bridge: "monitor",
};
export const MODE_LABEL: Record<string, string> = {
  smart: "Smart clean", detailed: "Subtitles", verbatim: "Verbatim", shayari: "Shayari",
};
export function lengthLabel(seconds: number | null | undefined): string {
  if (!seconds) return "";
  const s = Math.round(seconds);
  return s >= 3600 ? `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m` : s >= 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s}s`;
}
