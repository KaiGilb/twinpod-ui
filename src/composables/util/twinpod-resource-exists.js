// UNIT_TYPE=Util

/**
 * twinpod-resource-exists
 *
 * Detect whether a TwinPod GET response represents a real user resource
 * or fabricated semantic-node metadata.
 *
 * Background — the TwinPod 200-not-404 quirk:
 *   TwinPod does NOT return 404 for resources that don't exist. Instead it
 *   returns 200 OK with auto-generated JSON-LD metadata describing the URL
 *   as a semantic node (typed against Cochrane PICO, SIO, schema.org, etc.).
 *   The `content-location` header points to an internal node like `/node/t_iN`
 *   rather than the requested path.
 *
 *   App code that gates on `response.status === 404` to detect "first-time
 *   user" or "no content yet" branches never fires. This helper centralises
 *   the correct detection so each consumer only needs to supply a per-resource
 *   shape predicate.
 *
 * Detection strategy (shape-primary — Cycle 19 follow-up #7):
 *   The response body shape is authoritative. TwinPod assigns the SAME
 *   `/node/t_*` content-location pattern to BOTH:
 *     (a) auto-fabricated responses for non-existent paths, AND
 *     (b) genuine files written via plain PUT (no Slug/Link/rdfs:label
 *         headers, e.g. `useCreditLedger.writeTrialStart`'s
 *         `application/json` PUT to `/apps/TomTwin/thebrain-credits.json`).
 *   So content-location alone cannot distinguish a real file from a
 *   fabricated one — only the response body shape can. If the parsed body
 *   matches the caller's expected shape, the response is real, regardless
 *   of content-location. Shape-fail is treated as fabricated/not-our-resource.
 *
 *   Confirmed by Cycle 19 testing on tst-testertom: a real
 *   `thebrain-credits.json` written via plain PUT was incorrectly rejected
 *   by the previous content-location-primary logic, causing the whitelist
 *   grant to re-fire on every session.
 *
 * Reference: 9 - Standard/Reference_Code_TwinPod-DefaultContainers.md
 *            § Major quirk: TwinPod returns 200 (not 404) for non-existent
 *            resources.
 *
 * @param {Response} _response - Fetch Response (caller must have already
 *   verified `response.ok === true`; this helper does not re-check status).
 *   Currently unused — retained in the signature so callers don't change
 *   and so future detection variants (e.g. multi-signal tiebreakers) have
 *   the response handle available without another refactor.
 * @param {object} data - Already-parsed JSON body of the response.
 * @param {(d: object) => boolean} hasExpectedShape - Per-resource shape
 *   predicate, returns true if `data` looks like a genuine user resource.
 * @returns {boolean} true if the response is the user's actual resource;
 *   false if fabricated TwinPod node metadata (or shape-malformed).
 */
export function isRealTwinPodResource(_response, data, hasExpectedShape) {
  // Shape is authoritative. content-location is unreliable as a primary
  // signal because TwinPod assigns /node/t_* to real plain-PUT files too.
  return hasExpectedShape(data) === true
}
