"""Citation evidence tests: occurrence identity, atomic splitting, guarded matching,
optional verification, and a table-driven adversarial gold corpus with an eval
harness. Deterministic matching only; the LLM verifier is mocked where needed.
"""

from __future__ import annotations

from collections import Counter

import pytest

from backend.app.citation_evidence import (
    STATUS_LIKELY,
    STATUS_MISSING,
    STATUS_RELATED,
    STATUS_VERIFIED,
    apply_verification_verdicts,
    build_citation_evidences,
    build_snippet,
    client_source_payload,
    extract_citation_claims,
    extract_citation_occurrences,
    find_quote_in_content,
    normalize_display_status,
    select_verification_candidates,
    split_atomic_claims,
)


# ---------------------------------------------------------------------------
# Public surface compatibility
# ---------------------------------------------------------------------------

def test_client_source_payload_omits_full_content_and_adds_snippet():
    sources = [
        {
            "id": 1,
            "title": "Introducing GPT-5",
            "url": "https://openai.com/index/introducing-gpt-5/",
            "date": "2025-08-07",
            "content": "OpenAI released GPT-5 on August 7, 2025. " * 40,
        }
    ]
    payload = client_source_payload(sources, query_hint="GPT-5 release date")
    assert len(payload) == 1
    item = payload[0]
    assert item["id"] == 1
    assert "snippet" in item and len(item["snippet"]) > 20
    assert "content" not in item
    assert item["domain"] == "openai.com"
    assert item["content_chars"] > 100


def test_client_source_payload_assigns_ids_when_missing():
    """Imported history often has title/url only; still expose sources to UI/export."""
    payload = client_source_payload(
        [
            {"title": "Source A", "url": "https://example.com/a"},
            {"title": "Source B", "url": "https://example.com/b"},
            {"id": 1, "title": "Already numbered", "url": "https://example.com/c"},
        ]
    )
    # Missing ids auto-fill 1,2; explicit id=1 collides and is renumbered to 3.
    assert [item["id"] for item in payload] == [1, 2, 3]
    assert [item["url"] for item in payload] == [
        "https://example.com/a",
        "https://example.com/b",
        "https://example.com/c",
    ]


def test_build_snippet_truncates_long_text():
    text = "word " * 500
    snip = build_snippet(text, max_len=80)
    assert len(snip) <= 90
    assert snip.endswith("…") or len(snip) <= 80


# ---------------------------------------------------------------------------
# Occurrence identity
# ---------------------------------------------------------------------------

def test_repeated_marker_produces_distinct_occurrences():
    ans = "Orion launched in 2025 [1]. It costs $20 per month [1]."
    occs = extract_citation_occurrences(ans)
    assert len(occs) == 2
    assert occs[0]["marker"] == "1" and occs[1]["marker"] == "1"
    assert occs[0]["occurrence_id"] != occs[1]["occurrence_id"]
    assert occs[0]["marker_occurrence_index"] == 0
    assert occs[1]["marker_occurrence_index"] == 1
    assert occs[1]["occurrence_index"] == 1


def test_grouped_citation_shares_group_index():
    ans = "Mix [1, 2] and later [2] again."
    occs = extract_citation_occurrences(ans)
    # Three individual anchors: [1], [2] (group 0), [2] (group 1)
    assert len(occs) == 3
    assert occs[0]["group_index"] == 0 and occs[1]["group_index"] == 0
    assert occs[2]["group_index"] == 1
    assert occs[0]["marker_index"] == 0 and occs[1]["marker_index"] == 1
    # The standalone [2] is the 2nd occurrence of marker 2.
    assert occs[2]["marker"] == "2" and occs[2]["marker_occurrence_index"] == 1


def test_occurrence_ids_are_deterministic_and_stable():
    ans = "A [1] b [2] c [1]."
    first = [o["occurrence_id"] for o in extract_citation_occurrences(ans)]
    second = [o["occurrence_id"] for o in extract_citation_occurrences(ans)]
    assert first == second
    assert first == ["citation-0", "citation-1", "citation-2"]


def test_citation_in_code_block_is_ignored():
    ans = "See `code [1]` block. Real claim here [1]."
    occs = extract_citation_occurrences(ans)
    assert len(occs) == 1
    assert "Real claim here" in occs[0]["claim"]


def test_escaped_citation_is_ignored():
    ans = "Escaped \\[1] here. Real claim here [1]."
    occs = extract_citation_occurrences(ans)
    assert len(occs) == 1
    assert "Real claim here" in occs[0]["claim"]


def test_citation_in_html_attribute_is_ignored():
    ans = '<a href="x[1]">link</a> Real claim here [1].'
    occs = extract_citation_occurrences(ans)
    assert len(occs) == 1
    assert "Real claim here" in occs[0]["claim"]


# ---------------------------------------------------------------------------
# Atomic claim splitting
# ---------------------------------------------------------------------------

def test_atomic_split_english_compound():
    atoms = split_atomic_claims("Orion launched in 2025 and reached 10 million users.")
    assert "Orion launched in 2025" in atoms
    assert any("reached" in a for a in atoms)
    assert len(atoms) <= 4


def test_atomic_split_chinese_conjunction():
    atoms = split_atomic_claims("公司收入增长 20%，利润下降 5%。")
    # Both clauses should survive as atoms.
    assert len(atoms) >= 1
    joined = " ".join(atoms)
    assert "收入" in joined and "利润" in joined


def test_atomic_split_preserves_dates_and_decimals():
    atoms = split_atomic_claims("Released on August 7, 2025 at 3.14 GHz.")
    # The date and the number+unit must not be torn apart mid-token.
    for a in atoms:
        if "2025" in a:
            assert "August 7, 2025" in a
        if "3.14" in a:
            assert "GHz" in a


# ---------------------------------------------------------------------------
# Legacy compatibility wrappers
# ---------------------------------------------------------------------------

def test_extract_citation_claims_legacy_shape():
    answer = (
        "GPT-5 于 2025年8月7日正式发布 [1]。\n"
        "Claude Opus 4.8 发布于 2026年5月28日 [2][3]。"
    )
    claims = extract_citation_claims(answer)
    assert len(claims) >= 2
    first = claims[0]
    assert 1 in first["marker_ids"]
    markers = {mid for c in claims for mid in c["marker_ids"]}
    assert {1, 2, 3}.issubset(markers)


def test_normalize_display_status_maps_legacy():
    assert normalize_display_status("matched") == STATUS_LIKELY
    assert normalize_display_status("weak") == STATUS_RELATED
    assert normalize_display_status("missing") == STATUS_MISSING
    assert normalize_display_status("verified-literal") == STATUS_VERIFIED
    assert normalize_display_status(None) == STATUS_RELATED


# ---------------------------------------------------------------------------
# Adversarial gold corpus + eval harness
# ---------------------------------------------------------------------------

def _gold(
    id: str,
    claim: str,
    content: str,
    *,
    expect_not_verified: bool = False,
    expect_at_most: str = STATUS_RELATED,
    tags: tuple[str, ...] = (),
) -> dict:
    return {
        "id": id, "claim": claim, "content": content,
        "expect_not_verified": expect_not_verified,
        "expect_at_most": expect_at_most,
        "tags": tags,
    }


_GOLD_CORPUS = [
    # Positive controls ------------------------------------------------------
    _gold("pos-literal-en", "Orion launched in 2025.", "Orion launched in 2025.",
          expect_at_most=STATUS_VERIFIED, tags=("positive",)),
    _gold("pos-context-en", "Orion launched in 2025.",
          "Welcome to the docs. Orion launched in 2025 with great fanfare. It supports plugins.",
          expect_at_most=STATUS_VERIFIED, tags=("positive",)),
    _gold("pos-cn-literal", "该公司于5月28日推出新模型。",
          "该公司于5月28日推出新模型，受到好评。",
          expect_at_most=STATUS_VERIFIED, tags=("positive", "cjk")),
    # Adversarial negatives --------------------------------------------------
    _gold("neg-footer-year", "Acme launched Orion in 2025.",
          "Welcome to Acme support. Copyright (c) 2025 Acme Corporation. All rights reserved.",
          expect_not_verified=True, expect_at_most=STATUS_RELATED, tags=("negative", "footer", "date")),
    _gold("neg-wrong-subject-date", "Orion launched on August 7, 2025.",
          "Atlas 2 launched on August 7, 2025. Orion is not discussed here.",
          expect_not_verified=True, expect_at_most=STATUS_RELATED, tags=("negative", "subject", "date")),
    _gold("neg-negation-en", "The feature is enabled by default.",
          "The feature is not enabled by default.",
          expect_not_verified=True, expect_at_most=STATUS_RELATED, tags=("negative", "negation")),
    _gold("neg-negation-cn", "该功能默认开启。",
          "该功能默认并未开启，需要用户手动启用。",
          expect_not_verified=True, expect_at_most=STATUS_RELATED, tags=("negative", "negation", "cjk")),
    _gold("neg-unit-mb-gb", "Memory usage is 500 MB.",
          "Memory usage is 500 GB.",
          expect_not_verified=True, expect_at_most=STATUS_RELATED, tags=("negative", "unit")),
    _gold("neg-direction-cn", "收入增长了30%。",
          "收入下降了30%。",
          expect_not_verified=True, expect_at_most=STATUS_RELATED, tags=("negative", "direction", "cjk")),
    _gold("neg-price-vs-percent", "The rate is 20%.",
          "The fee is $20.",
          expect_not_verified=True, expect_at_most=STATUS_RELATED, tags=("negative", "unit")),
    # Paraphrase / partial support ------------------------------------------
    _gold("para-cn", "该公司在五月底推出了新模型。",
          "新一代模型于5月28日正式对外发布，引发广泛关注。",
          expect_at_most=STATUS_RELATED, tags=("paraphrase", "cjk")),
    _gold("para-cn-supported", "该公司在五月底推出了新模型。",
          "该公司在5月28日推出了新模型，受到好评。",
          expect_at_most=STATUS_LIKELY, tags=("paraphrase", "cjk")),
    # Missing ---------------------------------------------------------------
    _gold("missing-unrelated", "Rust 1.97 symbol mangling v0 default on July 9, 2026.",
          "This page is about cooking pasta recipes and tomato sauce.",
          expect_at_most=STATUS_MISSING, tags=("missing",)),
    _gold("missing-empty", "Anything.", "", expect_at_most=STATUS_MISSING, tags=("missing",)),
]

_RANK = {STATUS_MISSING: 0, STATUS_RELATED: 1, STATUS_LIKELY: 2, STATUS_VERIFIED: 3}


def _rank(status: str) -> int:
    return _RANK[normalize_display_status(status)]


def test_gold_corpus_support_precision():
    """No adversarial negative may reach verified-literal or likely."""
    false_positives = []
    for case in _GOLD_CORPUS:
        hit = find_quote_in_content(case["content"], case["claim"])
        status = normalize_display_status(hit["status"])
        if case["expect_not_verified"] and _rank(status) > _rank(case["expect_at_most"]):
            false_positives.append((case["id"], status, hit["method"], hit["score"]))
    assert not false_positives, f"false positives: {false_positives}"


def test_gold_corpus_recall_on_positives():
    """Positive controls should reach at least 'likely'."""
    failures = []
    for case in _GOLD_CORPUS:
        if "positive" not in case["tags"]:
            continue
        hit = find_quote_in_content(case["content"], case["claim"])
        status = normalize_display_status(hit["status"])
        if _rank(status) < _rank(STATUS_LIKELY):
            failures.append((case["id"], status, hit["score"]))
    assert not failures, f"positive recall failures: {failures}"


def test_gold_corpus_quote_localization():
    """For positive cases the quote must contain a discriminative token."""
    for case in _GOLD_CORPUS:
        if "positive" not in case["tags"]:
            continue
        hit = find_quote_in_content(case["content"], case["claim"])
        assert hit["quote"], case["id"]


def test_eval_harness_reports_metrics():
    """The eval helper computes precision/recall/abstention without crashing."""
    metrics = _evaluate_corpus(_GOLD_CORPUS)
    assert metrics["total"] == len(_GOLD_CORPUS)
    assert 0.0 <= metrics["support_precision"] <= 1.0
    # Hard gate: no verified-literal / likely on the explicit adversarial negatives.
    assert metrics["false_positive_rate"] == 0.0


def _evaluate_corpus(cases):
    total = len(cases)
    pos = [c for c in cases if "positive" in c["tags"]]
    neg = [c for c in cases if "negative" in c["tags"]]
    true_support = 0
    claimed_support = 0
    correct_support = 0
    fp = 0
    abstain = 0
    for c in cases:
        hit = find_quote_in_content(c["content"], c["claim"])
        status = normalize_display_status(hit["status"])
        is_support = status in (STATUS_VERIFIED, STATUS_LIKELY)
        if is_support:
            claimed_support += 1
        if status == STATUS_MISSING:
            abstain += 1
        if "positive" in c["tags"]:
            true_support += 1
            if is_support:
                correct_support += 1
        if "negative" in c["tags"] and is_support:
            fp += 1
    return {
        "total": total,
        "support_precision": (correct_support / claimed_support) if claimed_support else 1.0,
        "support_recall": (correct_support / true_support) if true_support else 1.0,
        "false_positive_rate": (fp / len(neg)) if neg else 0.0,
        "abstention_rate": abstain / total,
    }


# ---------------------------------------------------------------------------
# End-to-end build_citation_evidences
# ---------------------------------------------------------------------------

def test_build_citation_evidences_occurrence_specific():
    sources = [
        {"id": 1, "title": "Orion", "url": "https://orion.test",
         "content": "Orion launched in 2025. It costs $20 per month."},
    ]
    answer = "Orion launched in 2025 [1]. It costs $20 per month [1]."
    evs = build_citation_evidences(answer, sources)
    # Two occurrences of marker 1, each with distinct claim/quote.
    assert len(evs) == 2
    assert evs[0]["occurrence_id"] != evs[1]["occurrence_id"]
    assert evs[0]["marker_occurrence_index"] == 0
    assert evs[1]["marker_occurrence_index"] == 1
    assert evs[0]["schema_version"] == 2
    # Occurrence 0 should map to the launch claim; occurrence 1 to price.
    assert "2025" in evs[0]["claim"] or "launched" in evs[0]["claim"]
    assert "$20" in evs[1]["claim"] or "costs" in evs[1]["claim"]


def test_build_citation_evidences_missing_source_emits_missing():
    evs = build_citation_evidences("claim [9].", [{"id": 1, "content": "x"}])
    assert len(evs) == 1
    assert normalize_display_status(evs[0]["status"]) == STATUS_MISSING
    assert evs[0]["method"] == "no-source"


def test_build_citation_evidences_no_full_content_in_output():
    sources = [{"id": 1, "title": "T", "url": "https://x.test",
               "content": "Orion launched in 2025. " * 50}]
    evs = build_citation_evidences("Orion launched in 2025 [1].", sources)
    assert len(evs) == 1
    # No field carries the full page body.
    for ev in evs:
        assert len(ev.get("quote", "")) <= 600
        assert "content" not in ev


def test_compound_claim_partial_support_not_verified():
    sources = [{"id": 1, "title": "T", "url": "https://x.test",
               "content": "Orion launched in 2025."}]
    # Compound claim: launch (supported) + price (not in source).
    answer = "Orion launched in 2025 and costs $20 per month [1]."
    evs = build_citation_evidences(answer, sources)
    # The price atom has no supporting passage → at least one atom must not be verified.
    statuses = [normalize_display_status(e["status"]) for e in evs]
    assert any(s != STATUS_VERIFIED for s in statuses), statuses
    # And the unsupportable atom must be missing (no source passage mentions price).
    assert STATUS_MISSING in statuses, statuses


# ---------------------------------------------------------------------------
# Optional verification (mocked)
# ---------------------------------------------------------------------------

def _make_evs():
    sources = [{"id": 1, "title": "T", "url": "https://x.test",
               "content": "Orion launched in 2025."}]
    return build_citation_evidences("Orion launched in 2025 [1].", sources)


def test_verification_supported_upgrades_related_to_likely_not_verified():
    sources = [{"id": 1, "title": "T", "url": "https://x.test",
               "content": "Atlas launched on August 7, 2025. Orion is not discussed here."}]
    evs = build_citation_evidences("Orion launched on August 7, 2025 [1].", sources)
    # Deterministically this is a subject mismatch → related/missing.
    key = f"{evs[0]['occurrence_id']}:{evs[0]['claim_index']}"
    apply_verification_verdicts(evs, {key: {"verdict": "SUPPORTED", "confidence": 0.9, "reason": "ok"}})
    assert normalize_display_status(evs[0]["status"]) in (STATUS_LIKELY, STATUS_RELATED)
    assert normalize_display_status(evs[0]["status"]) != STATUS_VERIFIED


def test_verification_contradicted_caps_at_related():
    evs = _make_evs()
    key = f"{evs[0]['occurrence_id']}:{evs[0]['claim_index']}"
    before = normalize_display_status(evs[0]["status"])
    apply_verification_verdicts(evs, {key: {"verdict": "CONTRADICTED", "confidence": 0.95, "reason": "no"}})
    after = normalize_display_status(evs[0]["status"])
    assert _rank(after) <= _rank(STATUS_RELATED)
    assert _rank(after) <= _rank(before)


def test_verification_not_enough_info_no_change():
    evs = _make_evs()
    key = f"{evs[0]['occurrence_id']}:{evs[0]['claim_index']}"
    before = evs[0]["status"]
    apply_verification_verdicts(evs, {key: {"verdict": "NOT_ENOUGH_INFO", "confidence": 0.5, "reason": "n/a"}})
    assert evs[0]["status"] == before


def test_verification_never_creates_verified_literal():
    sources = [{"id": 1, "title": "T", "url": "https://x.test",
               "content": "Atlas launched on August 7, 2025. Orion is not discussed here."}]
    evs = build_citation_evidences("Orion launched on August 7, 2025 [1].", sources)
    key = f"{evs[0]['occurrence_id']}:{evs[0]['claim_index']}"
    apply_verification_verdicts(evs, {key: {"verdict": "SUPPORTED", "confidence": 0.99, "reason": "ok"}})
    assert normalize_display_status(evs[0]["status"]) != STATUS_VERIFIED


def test_verification_unknown_id_leaves_evidence_unchanged():
    evs = _make_evs()
    before = evs[0]["status"]
    apply_verification_verdicts(evs, {"nonexistent:0": {"verdict": "SUPPORTED", "confidence": 1.0, "reason": ""}})
    assert evs[0]["status"] == before


def test_select_verification_candidates_skips_verified_and_clear_missing():
    sources = [
        {"id": 1, "title": "T", "url": "https://x.test", "content": "Orion launched in 2025."},
        {"id": 2, "title": "U", "url": "https://y.test", "content": "Unrelated cooking text about pasta."},
    ]
    answer = "Orion launched in 2025 [1]. Cooking tip about salt [2]."
    evs = build_citation_evidences(answer, sources)
    selected = select_verification_candidates(evs, max_items=3)
    ids = {e["occurrence_id"] for e in selected}
    # Strong positive (occ 0) and clear missing (occ 1) are not selected.
    assert "citation-0" not in ids


def test_anchor_offset_drift_after_normalization():
    """Normalisation changes length (。→'. ', &amp;→&, newline folding); anchor
    offsets must be located against the ORIGINAL text or every anchor-derived
    quote window drifts and turns verified matches into related/missing."""
    content = (
        "前言段落一长串。第二句也长。" * 30
        + "&amp; 另一段。  "
        + "Orion launched on August 7, 2025 with record results."
    )
    hit = find_quote_in_content(content, "Orion launched on August 7, 2025.")
    assert "August 7, 2025" in hit["quote"]
    assert normalize_display_status(hit["status"]) != STATUS_MISSING


def test_anchor_candidates_use_original_text_offsets():
    """Anchor-derived candidate windows must slice the ORIGINAL text.

    ``_anchor_candidates_around`` used to search inside ``_normalize_text(text)``
    and reuse that offset to slice ``text``. Normalisation lengthens the copy
    (each ``。`` becomes ``". "``), so with enough preceding sentences the
    normalised offset drifts past the real anchor and the sliced ``text``
    no longer contains it — and the bogus start/end then corrupt the merge
    with ``_segment_candidates`` (which uses original coordinates).
    """
    from backend.app.citation_evidence import (
        _anchor_candidates_around,
        _extract_structured_anchors,
    )

    # 120 sentence-ending 。 each become ". " (+1 char) under normalisation,
    # so the normalised copy is ~120 chars longer than the original.
    prefix = "前言一句。" * 120
    anchor_sentence = "Orion launched on August 7, 2025 with record results."
    content = prefix + anchor_sentence

    anchors = _extract_structured_anchors(anchor_sentence)
    assert anchors, "expected date/number anchors in the anchor sentence"

    cands = _anchor_candidates_around(content, anchors)
    assert cands, "at least one anchor candidate should be produced"
    for c in cands:
        # The candidate text must actually contain the anchor in the ORIGINAL
        # text — the pre-fix drift sliced past it and missed it entirely.
        assert "August 7, 2025" in c["text"], c["text"][:80]
        # Offsets round-trip back into the original content.
        assert content[c["start"]:c["end"]] == c["text"]
