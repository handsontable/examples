// Bot filter and UA classifiers, moved here from
// `workers/api/src/analytics.ts` (DEV-2030) so both the anonymous-audience
// counters there and the o11y ingest gates (ADR §B.5 `BOT_RE` filter, §4 blob15
// `device`) share one definition. `analytics.ts` now imports these — byte-identical
// regexes, no behaviour change (T00 task "Owns" row).

export const BOT_RE =
  /bot|crawler|spider|crawling|slurp|bingpreview|headlesschrome|lighthouse|curl\/|wget\/|python-requests|node-fetch|axios\/|monitoring|uptime|pingdom|semrush|ahrefs|facebookexternalhit|whatsapp|telegrambot|preview/i;

export const isBot = (userAgent: string): boolean => BOT_RE.test(userAgent);

/** Coarse device class (§4 blob15). Deliberately three buckets — anything finer
 *  starts to look like a fingerprint. */
export function deviceOf(ua: string): string {
  if (/ipad|tablet|playbook|silk/i.test(ua)) return "tablet";
  if (/mobi|iphone|ipod|android.*mobile|windows phone/i.test(ua)) return "mobile";
  return "desktop";
}

export function browserOf(ua: string): string {
  if (/edg\//i.test(ua)) return "edge";
  if (/opr\/|opera/i.test(ua)) return "opera";
  if (/chrome|crios|chromium/i.test(ua)) return "chrome";
  if (/firefox|fxios/i.test(ua)) return "firefox";
  if (/safari/i.test(ua)) return "safari";
  return "other";
}

export function osOf(ua: string): string {
  if (/windows/i.test(ua)) return "windows";
  if (/iphone|ipad|ipod|ios/i.test(ua)) return "ios";
  if (/mac os x|macintosh/i.test(ua)) return "macos";
  if (/android/i.test(ua)) return "android";
  if (/linux|x11|cros/i.test(ua)) return "linux";
  return "other";
}
