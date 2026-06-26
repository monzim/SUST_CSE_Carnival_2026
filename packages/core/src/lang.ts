/**
 * Tiny language helpers shared by the safety scanner and the fallback builder.
 *
 * We only need a binary "is this Bangla?" decision so customer-facing text is
 * emitted in the complaint's language. Detection is script-based (any Bengali
 * codepoint), which is robust for the mixed EN/BN complaints in this domain.
 */
import type { TicketRequest } from "./schema.js";

/** Bengali Unicode block. */
const BENGALI = /[ঀ-৿]/;

/** True if the text contains any Bengali script. */
export function hasBangla(text: string): boolean {
  return BENGALI.test(text);
}

/**
 * Decide the language for customer-facing text: honour an explicit `bn`/`en`
 * request language, otherwise sniff the complaint's script. `mixed` and unset
 * fall back to script detection so a Bangla complaint always gets a Bangla
 * reply even when `language` was omitted.
 */
export function replyLanguage(request: TicketRequest): "en" | "bn" {
  if (request.language === "bn") return "bn";
  if (request.language === "en") return "en";
  return hasBangla(request.complaint) ? "bn" : "en";
}
