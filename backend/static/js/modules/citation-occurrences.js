/**
 * Shared citation-occurrence contract for both renderers (Markdown + Live Artifact HTML).
 *
 * One citation "occurrence" = one individual anchor for one source. A grouped
 * citation such as [1, 2] is one group with two occurrences. Repeated [1] markers
 * each get their own occurrence identity so the evidence panel can open the exact
 * claim the user clicked — not the first record for that source.
 *
 * The backend assigns the SAME indices by scanning answer text left-to-right and
 * skipping code/pre/attributes/escaped markers (see citation_evidence.py). Both
 * frontends must reproduce that order so dataset indices line up with stored
 * evidence records.
 */

/**
 * Skip text-node parents that must never become citation anchors. Mirrors the
 * backend masker (fenced/inline code, script/style, pre, existing links).
 */
const SKIP_TAG_NAMES = new Set(['A', 'CODE', 'PRE', 'SCRIPT', 'STYLE', 'TEXTAREA', 'TITLE', 'NOSCRIPT']);

export function shouldSkipTextNode(node, root) {
    let parent = node.parentElement;
    while (parent) {
        if (SKIP_TAG_NAMES.has(parent.tagName)) return true;
        if (parent === root) break;
        parent = parent.parentElement;
    }
    return false;
}

/**
 * Maintain canonical counters across one render pass.
 * Re-create per full re-render (streaming re-renders rebuild the DOM each time,
 * so the nth [1] in the current buffer always gets the same identity).
 */
export function createOccurrenceTracker() {
    let occurrenceIndex = 0;
    let groupIndex = 0;
    const markerCounts = new Map();

    function nextGroup() {
        return groupIndex++;
    }

    function recordMarker(marker) {
        const mo = markerCounts.get(marker) || 0;
        markerCounts.set(marker, mo + 1);
        return mo;
    }

    function nextOccurrence() {
        return occurrenceIndex++;
    }

    return {
        nextGroup,
        recordMarker,
        nextOccurrence,
        get occurrenceIndex() { return occurrenceIndex; },
        get groupIndex() { return groupIndex; },
    };
}

/**
 * Assign canonical data-evidence-* attributes to one marker anchor inside a
 * citation group. `groupIndex` is shared by all markers in the same group;
 * `markerIndex` is the position within that group. The caller obtains the group
 * index once per parsed `[n, m]` match and passes it in.
 * Returns the occurrence metadata that was assigned.
 */
export function assignOccurrenceAttributes(anchor, tracker, marker, groupIndex, markerIndex) {
    const occurrenceIndex = tracker.nextOccurrence();
    const markerOccurrenceIndex = tracker.recordMarker(String(marker));
    const occurrenceId = `citation-${occurrenceIndex}`;
    anchor.dataset.evidenceSourceId = String(marker);
    anchor.dataset.evidenceOccurrenceId = occurrenceId;
    anchor.dataset.evidenceOccurrenceIndex = String(occurrenceIndex);
    anchor.dataset.evidenceGroupIndex = String(groupIndex);
    anchor.dataset.evidenceMarkerIndex = String(markerIndex);
    anchor.dataset.evidenceMarkerOccurrenceIndex = String(markerOccurrenceIndex);
    return { occurrenceId, occurrenceIndex, groupIndex, markerIndex, markerOccurrenceIndex };
}
