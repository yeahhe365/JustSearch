"""Citation evidence: map answer [n] markers to source text fragments.

Phase-2 approach (occurrence-aware, conservative):
1. Enrich client-facing sources with short snippet/excerpt (no full content).
2. Extract every citation occurrence (one anchor = one identity), split compound
   claims into atomic propositions, and evaluate each independently.
3. Locate the best candidate passage in the cited source via mixed-language
   tokenization (English words + CJK n-grams + structured anchors) plus explicit
   guards: subject/entity agreement, unit consistency, negation/polarity, and
   boilerplate penalties. A matching date or number alone never proves a claim.
4. Honest four-level status: verified-literal | likely | related | missing.
5. Optional bounded semantic verification is layered on by the chat router; this
   module remains deterministic and directly testable.
"""

from __future__ import annotations

import html
import re
import unicodedata
from typing import Any, Iterable

from urllib.parse import urlparse


# --- public length constants (kept stable for callers) ----------------------
_SNIPPET_TARGET = 480
_EXCERPT_TARGET = 720
_QUOTE_WINDOW = 320
_CLAIM_LOOKBACK = 160

# --- internal scoring constants ---------------------------------------------
_MAX_SOURCE_CHARS = 20000          # bound segmentation cost for very large pages
_MAX_CANDIDATES = 40                # cap deeply-scored candidate passages per source
_MAX_CLAIM_CHARS = 320
_MAX_QUOTE_CHARS = 480
_MAX_ATOMIC_CLAIMS = 4
_EVIDENCE_SCHEMA_VERSION = 2

# Final-score thresholds for the 4-level public status set.
_THRESHOLD_VERIFIED = 0.90
_THRESHOLD_LIKELY = 0.68
_THRESHOLD_RELATED = 0.38
# Subject/anchor sub-gates required to earn the stronger statuses.
_VERIFIED_SUBJECT = 0.80
_VERIFIED_ANCHOR = 0.90
_LIKELY_SUBJECT = 0.55
# A literal span must be this long to count as a meaningful proposition.
_LITERAL_CJK_MIN = 8

# Feature weights.
_W_LATIN = 1.0
_W_CJK_BIGRAM = 1.0
_W_CJK_TRIGRAM = 1.35
_W_CJK_FOURGRAM = 1.65
_W_ANCHOR = 1.5

# Scoring component weights (sum ~ 1.0).
_W_LEXICAL = 0.35
_W_SUBJECT = 0.20
_W_ANCHOR_SCORE = 0.20
_W_CONTEXT = 0.15
_W_COHERENCE = 0.10

# Penalties.
_PEN_UNIT_CONFLICT = 0.45
_PEN_POLARITY_CONFLICT = 0.50
_PEN_BOILERPLATE = 0.35
_PEN_ANCHOR_MISSING = 0.30

_WS_RE = re.compile(r"\s+")
_CITATION_RE = re.compile(r"\[(\d+(?:\s*,\s*\d+)*)\]")
# A genuinely-structured HTML tag, not the "<"/">" of prose like "2 < x > 10".
_HTML_TAG_STRUCTURE_RE = re.compile(r"</?[a-zA-Z][\w\-]*(\s[^>]*)?/?>")

# --- date / number anchor patterns ------------------------------------------
# Numbers with optional unit. Captures the numeric value and a trailing unit so
# we can compare dimensions instead of bare digits.
_NUMBER_UNIT_RE = re.compile(
    r"(?<![\w.])"
    r"(?P<num>\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+\.\d+%?|\d{4,}|\d+%|\d+\.\d+|\d+)"
    r"(?P<unit>\s*(?:%|％|USD|EUR|GBP|CNY|RMB|km|cm|mm|kg|ms|GHz|MHz|fps|rpm|"
    r"hour|hours|GB|MB|TB|KB|万亿|千万|百万|亿|万|元|块|美金|美元|欧元|英镑|人民币|"
    r"个|人|次|天|日|月|年|岁|度|分|秒|倍|名|篇|页|条|项|场|局)?)"
    r"(?![\w.])",
    re.I,
)

# Critical anchors: full dates or "substantial" numbers. A bare short integer
# (e.g. 5, 7, 42) is intentionally NOT a critical anchor on its own.
_CRITICAL_DATE_RE = re.compile(
    r"20\d{2}\s*年\s*\d{1,2}\s*月\s*\d{1,2}\s*日?|"
    r"20\d{2}[-/.]\d{1,2}[-/.]\d{1,2}|"
    r"(?:January|February|March|April|May|June|July|August|September|October|November|December)"
    r"\s+\d{1,2},?\s+20\d{2}|"
    r"\d{1,2}\s+(?:January|February|March|April|May|June|July|August|September|October|November|December)"
    r"\s+20\d{2}",
    re.I,
)
_CRITICAL_NUMBER_RE = re.compile(
    r"(?<![\w.])"
    r"(?:\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+\.\d+%?|\d{4,}|\d+%|\d+\.\d+)"
    r"(?![\w.])"
)

_CJK_RUN_RE = re.compile(r"[一-鿿]+")
_LATIN_WORD_RE = re.compile(r"[A-Za-z][A-Za-z0-9]*")

# Negation / polarity markers (scoped to the local predicate window).
_NEGATION_RE = re.compile(
    r"\b(?:not|no|never|without|cannot|can'?t|won'?t|doesn'?t|isn'?t|aren'?t|"
    r"wasn'?t|weren'?t|hasn'?t|haven'?t|hadn'?t|did\s+not|does\s+not|"
    r"failed\s+to|denied|neither|nor)\b",
    re.I,
)
_NEGATION_CN_RE = re.compile(r"(?:不|未|没有|没|并非|非|否认|未能|不会|不能|无|勿|别|莫|尚未|暂未)")
_DIRECTION_POS_RE = re.compile(
    r"\b(?:increase|increased|increases|rise|rose|risen|grow|grew|grown|up|"
    r"higher|above|before|earlier|more|gain|gained|exceed|exceeds|surpass)\b",
    re.I,
)
_DIRECTION_NEG_RE = re.compile(
    r"\b(?:decrease|decreased|decreases|fall|fell|fallen|drop|dropped|down|"
    r"lower|below|after|later|less|loss|lost|shrink|shrank)\b",
    re.I,
)
_DIRECTION_CN_POS_RE = re.compile(r"(?:增长|增加|上升|提高|超过|高于|提前|多于|上涨|攀升)")
_DIRECTION_CN_NEG_RE = re.compile(r"(?:下降|减少|降低|低于|推迟|少于|下跌|回落|缩水|下滑)")

# Boilerplate signals. Bare "关注" intentionally excluded — it's a common content
# word, not a structural boilerplate marker.
_BOILERPLATE_RE = re.compile(
    r"(?:copyright|©|\(c\)|all\s+rights\s+reserved|cookie\s+(?:notice|banner|policy)|"
    r"privacy\s+policy|terms\s+of\s+(?:service|use)|sign\s+(?:in|up)|log\s+(?:in|out)|"
    r"subscribe|newsletter|related\s+(?:posts|articles)|share\s+(?:on|this)|"
    r"back\s+to\s+top|main\s+menu|site\s+navigation|版权所有|隐私政策|服务条款|"
    r"相关推荐|返回顶部|网站导航|订阅我们|登录注册|关注我们\s*[:：]|footer|site-footer)",
    re.I,
)

# Unit dimensions for conflict detection.
_UNIT_DIMENSIONS = {
    "%": "percent", "％": "percent",
    "元": "currency", "块": "currency", "美金": "currency", "美元": "currency",
    "欧元": "currency", "英镑": "currency", "人民币": "currency",
    "usd": "currency", "eur": "currency", "gbp": "currency", "cny": "currency", "rmb": "currency",
    "km": "length", "cm": "length", "mm": "length",
    "kg": "mass",
    "ms": "time", "hour": "time", "hours": "time",
    "天": "time", "日": "time", "月": "time", "年": "time", "岁": "time",
    "gb": "storage", "mb": "storage", "tb": "storage", "kb": "storage",
    "ghz": "frequency", "mhz": "frequency",
    "fps": "rate", "rpm": "rate",
    "万": "scale", "亿": "scale", "万亿": "scale", "百万": "scale", "千万": "scale",
    "倍": "multiplier", "度": "temperature", "分": "score", "秒": "time",
}

# Statuses (public 4-level + legacy aliases normalized by callers).
STATUS_VERIFIED = "verified-literal"
STATUS_LIKELY = "likely"
STATUS_RELATED = "related"
STATUS_MISSING = "missing"
_LEGACY_STATUS_MAP = {
    "matched": STATUS_LIKELY,      # legacy exact-anchor matches cannot be trusted as literal
    "weak": STATUS_RELATED,
    "missing": STATUS_MISSING,
}


def normalize_display_status(status: Any) -> str:
    """Map any status (legacy or new) to the 4-level public set."""
    s = str(status or "").strip().lower()
    if s in _LEGACY_STATUS_MAP:
        return _LEGACY_STATUS_MAP[s]
    if s in (STATUS_VERIFIED, STATUS_LIKELY, STATUS_RELATED, STATUS_MISSING):
        return s
    return STATUS_RELATED


# --- small text helpers ------------------------------------------------------

def _clean_ws(text: str) -> str:
    return _WS_RE.sub(" ", (text or "")).strip()


def useful_char_count(text: str) -> int:
    if not text:
        return 0
    return len(re.sub(r"\s+", "", text))


def _domain_of(url: str) -> str:
    try:
        host = (urlparse(url or "").hostname or "").lower()
        return host[4:] if host.startswith("www.") else host
    except Exception:
        return ""


def _normalize_text(text: str) -> str:
    """NFKC + entity decode + case fold + whitespace collapse. Preserves signs."""
    t = unicodedata.normalize("NFKC", str(text or ""))
    t = html.unescape(t)
    t = t.replace("　", " ")          # full-width space
    t = t.replace("，", ",").replace("。", ". ").replace("？", "? ").replace("！", "! ")
    t = t.replace("（", "(").replace("）", ")").replace("：", ": ").replace("；", "; ")
    t = t.replace("“", '"').replace("”", '"').replace("‘", "'").replace("’", "'")
    t = _WS_RE.sub(" ", t).strip()
    return t.lower()


def _visible_text(text: str) -> str:
    """Strip HTML/markdown markup to visible text, preserving offsets loosely."""
    t = str(text or "")
    # Remove fenced code blocks entirely (they are not prose claims).
    t = re.sub(r"```[^\n]*\n?[\s\S]*?```", " ", t)
    t = re.sub(r"`[^`]*`", " ", t)
    # Block tags → space; keep inner text of inline tags.
    t = _HTML_TAG_STRUCTURE_RE.sub(" ", t)
    t = html.unescape(t)
    return _clean_ws(t)


# --- snippet / excerpt (public, unchanged behavior) -------------------------

def build_snippet(content: str, max_len: int = _SNIPPET_TARGET) -> str:
    """First readable slice of page content for previews."""
    text = _clean_ws(content)
    if not text:
        return ""
    if len(text) <= max_len:
        return text
    cut = text[:max_len]
    for sep in ("。", "！", "？", ". ", "; ", "；", " "):
        idx = cut.rfind(sep)
        if idx > max_len * 0.55:
            cut = cut[: idx + (0 if sep.startswith(" ") else len(sep))]
            break
    return cut.rstrip() + "…"


def build_excerpt(content: str, hints: Iterable[str] | None = None, max_len: int = _EXCERPT_TARGET) -> str:
    """Prefer a content window that covers hint keywords (query-ish), else snippet."""
    text = content or ""
    if not text.strip():
        return ""
    hint_features: dict[str, float] = {}
    for hint in hints or []:
        for tok, w in _tokenize_features(str(hint)).items():
            hint_features[tok] = max(hint_features.get(tok, 0.0), w)
    if not hint_features:
        return build_snippet(text, max_len=max_len)

    lower = text.lower()
    best_i = 0
    best_score = -1.0
    step = max(40, max_len // 4)
    for i in range(0, max(1, len(text) - max_len + 1), step):
        window = lower[i : i + max_len]
        score = sum(w for tok, w in hint_features.items() if tok in window)
        if score > best_score:
            best_score = score
            best_i = i
            if score >= sum(hint_features.values()) * 0.8:
                break
    excerpt = _clean_ws(text[best_i : best_i + max_len])
    if best_i > 0:
        excerpt = "…" + excerpt
    if best_i + max_len < len(text):
        excerpt = excerpt.rstrip() + "…"
    return excerpt


def client_source_payload(
    sources: list[dict[str, Any]] | None,
    *,
    query_hint: str | None = None,
) -> list[dict[str, Any]]:
    """Slim source objects for SSE / history UI (no full page content).

    Sources without an ``id`` (common in imported history packages) keep
    title/url and receive sequential integer ids so export/UI citations work.
    """
    payload: list[dict[str, Any]] = []
    used_ids: set[Any] = set()
    next_auto_id = 1

    def _allocate_id(raw_id: Any) -> Any:
        nonlocal next_auto_id
        if raw_id is None or raw_id == "":
            while next_auto_id in used_ids:
                next_auto_id += 1
            sid = next_auto_id
            next_auto_id += 1
            used_ids.add(sid)
            return sid

        if isinstance(raw_id, int) or (isinstance(raw_id, str) and raw_id.isdigit()):
            sid = int(raw_id)
        else:
            sid = raw_id

        if sid in used_ids:
            # Collision after import/merge — keep the item, assign a free int id.
            while next_auto_id in used_ids:
                next_auto_id += 1
            sid = next_auto_id
            next_auto_id += 1
        used_ids.add(sid)
        if isinstance(sid, int) and sid >= next_auto_id:
            next_auto_id = sid + 1
        return sid

    for source in sources or []:
        if not isinstance(source, dict):
            continue
        url = str(source.get("url") or "").strip()
        raw_title = source.get("title")
        title = str(raw_title or url or "").strip()
        # Drop empty shells that have neither title nor URL.
        if not title and not url:
            continue
        sid = _allocate_id(source.get("id"))
        if not title:
            title = f"Source {sid}"
        content = str(source.get("content") or "")
        snippet = str(source.get("snippet") or "").strip() or build_snippet(content)
        excerpt = str(source.get("excerpt") or "").strip()
        if not excerpt and content:
            excerpt = build_excerpt(content, hints=[query_hint or "", title])
        item: dict[str, Any] = {
            "id": sid,
            "title": title,
        }
        if url:
            item["url"] = url
        date = source.get("date")
        if date not in (None, ""):
            item["date"] = date
        if snippet:
            item["snippet"] = snippet
        if excerpt:
            item["excerpt"] = excerpt
        chars = source.get("content_chars")
        if isinstance(chars, int):
            item["content_chars"] = chars
        elif content:
            item["content_chars"] = len(content)
        domain = _domain_of(url)
        if domain:
            item["domain"] = domain
        payload.append(item)
    return payload


# --- mixed-language tokenization -------------------------------------------

def _cjk_ngrams(run: str) -> dict[str, float]:
    """Weighted CJK n-grams (bigram/trigram/four-gram) for one CJK run."""
    feats: dict[str, float] = {}
    n = len(run)
    for i in range(n - 1):
        feats[run[i : i + 2]] = max(feats.get(run[i : i + 2], 0.0), _W_CJK_BIGRAM)
    for i in range(n - 2):
        feats[run[i : i + 3]] = max(feats.get(run[i : i + 3], 0.0), _W_CJK_TRIGRAM)
    for i in range(n - 3):
        feats[run[i : i + 4]] = max(feats.get(run[i : i + 4], 0.0), _W_CJK_FOURGRAM)
    return feats


def _tokenize_features(text: str) -> dict[str, float]:
    """Weighted lexical features: Latin words, CJK n-grams, structured anchors."""
    norm = _normalize_text(text)
    feats: dict[str, float] = {}
    for m in _LATIN_WORD_RE.finditer(norm):
        tok = m.group(0)
        if len(tok) >= 2:
            feats[tok] = max(feats.get(tok, 0.0), _W_LATIN)
    for run in _CJK_RUN_RE.findall(norm):
        if len(run) == 1:
            # Single CJK chars are too noisy; skip unless part of a longer run.
            continue
        for tok, w in _cjk_ngrams(run).items():
            feats[tok] = max(feats.get(tok, 0.0), w)
    # Anchors as exact tokens.
    for m in _CRITICAL_DATE_RE.finditer(norm):
        feats[m.group(0).strip()] = max(feats.get(m.group(0).strip(), 0.0), _W_ANCHOR)
    for m in _CRITICAL_NUMBER_RE.finditer(norm):
        feats[m.group(0).strip()] = max(feats.get(m.group(0).strip(), 0.0), _W_ANCHOR)
    return feats


# --- structured anchor extraction (with units) ------------------------------

def _extract_structured_anchors(text: str) -> list[dict[str, Any]]:
    """Return [{value, unit, dimension, kind, surface}] for critical anchors."""
    norm = _normalize_text(text)
    out: list[dict[str, Any]] = []
    seen: set[tuple[str, str]] = set()
    for m in _CRITICAL_DATE_RE.finditer(norm):
        surface = m.group(0).strip()
        key = ("date", surface)
        if key in seen:
            continue
        seen.add(key)
        out.append({"value": surface, "unit": "", "dimension": "date", "kind": "date", "surface": surface})
    for m in _NUMBER_UNIT_RE.finditer(norm):
        num = m.group("num")
        unit = (m.group("unit") or "").strip().lower()
        # Only critical numbers (skip bare short ints unless they carry a unit/dimension).
        is_critical = bool(_CRITICAL_NUMBER_RE.fullmatch(num)) or bool(unit)
        if not is_critical:
            continue
        dimension = _UNIT_DIMENSIONS.get(unit, "")
        # Disambiguate: a 4-digit year with no unit is a date-ish year, not a count.
        kind = "number"
        if not unit and re.fullmatch(r"20\d{2}", num):
            dimension = "year"
        key = (num, unit)
        if key in seen:
            continue
        seen.add(key)
        out.append({"value": num, "unit": unit, "dimension": dimension, "kind": kind, "surface": m.group(0).strip()})
    return out


def _numbers_equal(a: str, b: str) -> bool:
    """Two numeric surface forms are equal after stripping grouping/whitespace."""
    return _normalize_number(a) == _normalize_number(b)


def _normalize_number(value: str) -> str:
    return str(value or "").strip().lower().replace(",", "").replace(" ", "")


def _anchor_conflict(a: dict[str, Any], b: dict[str, Any]) -> bool:
    """Two anchors share a value but disagree on dimension/unit.

    A bare year (dimension 'year') is NOT treated as conflicting with a date
    anchor (dimension 'date') because a year legitimately appears inside a date.
    """
    dim_a = a.get("dimension", "")
    dim_b = b.get("dimension", "")
    # year vs date are compatible (a year is part of a date).
    dim_compat = {dim_a, dim_b} <= {"year", "date"} or dim_a == dim_b or not dim_a or not dim_b
    if not dim_compat:
        return True
    unit_a = (a.get("unit") or "").strip().lower()
    unit_b = (b.get("unit") or "").strip().lower()
    if unit_a and unit_b:
        # Normalize equivalent currency/scale synonyms before comparing.
        if _normalize_unit(unit_a) != _normalize_unit(unit_b):
            return True
    return False


_CURRENCY_ALIASES = {
    "usd": "currency", "$": "currency", "美金": "currency", "美元": "currency",
    "eur": "currency", "€": "currency", "欧元": "currency",
    "gbp": "currency", "£": "currency", "英镑": "currency",
    "cny": "currency", "rmb": "currency", "人民币": "currency", "元": "currency", "块": "currency",
}


def _normalize_unit(unit: str) -> str:
    u = (unit or "").strip().lower()
    if u in _CURRENCY_ALIASES:
        return _CURRENCY_ALIASES[u]
    return u


# --- subject / polarity / boilerplate detection -----------------------------

def _extract_subject_terms(claim: str) -> list[str]:
    """Lightweight entity candidates: capitalized Latin, CJK runs, quoted names."""
    norm = _normalize_text(claim)
    terms: list[str] = []
    # Capitalized multiword / mixed-case Latin names from the ORIGINAL (pre-fold) text.
    raw = str(claim or "")
    for m in re.finditer(r"[A-Z][A-Za-z0-9\-]+(?:\s+[A-Z][A-Za-z0-9\-]+){0,2}", raw):
        t = m.group(0).strip().lower()
        if len(t) >= 2 and t not in terms:
            terms.append(t)
    # Quoted names.
    for m in re.finditer(r"[\"“”]([^\"“”]{2,24})[\"“”]", raw):
        t = m.group(1).strip().lower()
        if t and t not in terms:
            terms.append(t)
    # CJK runs of length >= 2.
    for run in _CJK_RUN_RE.findall(norm):
        if len(run) >= 2 and run not in terms:
            terms.append(run)
    return terms[:8]


def _polarity(text: str) -> tuple[int, list[str]]:
    """Return (polarity_sign, reasons). +1 affirmative/increase, -1 negated/decrease, 0 unknown."""
    t = str(text or "")
    neg = _NEGATION_RE.findall(t) or _NEGATION_CN_RE.findall(t)
    if neg:
        return (-1, ["negation"])
    pos = bool(_DIRECTION_POS_RE.search(t) or _DIRECTION_CN_POS_RE.search(t))
    neg_dir = bool(_DIRECTION_NEG_RE.search(t) or _DIRECTION_CN_NEG_RE.search(t))
    if pos and not neg_dir:
        return (1, ["direction-pos"])
    if neg_dir and not pos:
        return (-1, ["direction-neg"])
    # Ordinary affirmative proposition (contains predicate-like language) gets +1
    # so an explicit negation in the candidate can be detected as opposite polarity.
    if _looks_propositional(t):
        return (1, ["affirmative"])
    return (0, [])


def _looks_propositional(text: str) -> bool:
    t = str(text or "")
    # English verb-ish endings / common predicates.
    if re.search(r"\b(?:is|are|was|were|has|have|had|will|can|supports?|enabled?|launched?|released?|costs?|contains?|uses?|includes?|provides?)\b", t, re.I):
        return True
    # Chinese common predicate characters/words.
    if re.search(r"(?:是|为|有|发布|推出|支持|增长|下降|达到|位于|包含|提供|采用|售价|价格|成本|收入|利润|启用|开启|关闭)", t):
        return True
    return False


def _is_boilerplate(passage: str) -> bool:
    return bool(_BOILERPLATE_RE.search(str(passage or "")))


def _is_meaningful_subject(term: str, claim: str) -> bool:
    """A subject candidate is meaningful if it's a CJK run, a capitalized name,
    or a quoted name — NOT a generic common word like 'august'/'the'/'memory'."""
    t = term.strip().lower()
    if not t:
        return False
    # CJK runs are always meaningful subjects.
    if _CJK_RUN_RE.fullmatch(t):
        return True
    if len(t) <= 2:
        return False
    # Reject month names and very common english nouns that leak through capitalization.
    _COMMON = {
        "august", "january", "february", "march", "april", "may", "june", "july",
        "september", "october", "november", "december", "the", "this", "that",
        "memory", "usage", "feature", "price", "cost", "release", "launch",
    }
    if t in _COMMON:
        return False
    return True


def _shares_predicate(claim: str, candidate_lower: str) -> bool:
    """Heuristic: claim and candidate share a substantive predicate token."""
    claim_feats = _tokenize_features(claim)
    if not claim_feats:
        return False
    # Count substantive shared tokens (length >= 3 latin or any cjk n-gram).
    shared = 0
    for tok, w in claim_feats.items():
        is_substantive = (
            (len(tok) >= 3 and re.fullmatch(r"[a-z0-9]+", tok))
            or bool(_CJK_RUN_RE.fullmatch(tok))
        )
        if is_substantive and tok in candidate_lower:
            shared += 1
    return shared >= 2


# --- atomic claim splitting --------------------------------------------------

_SENTENCE_SPLIT_RE = re.compile(r"(?<=[。！？!?;；])\s*")
_CONJUNCTION_RE = re.compile(
    r"\s+(?:and|but|while|whereas|however|whereas|so|because|although|though|"
    r"进而|并且|而且|同时|但是|但|然而|而|于是|因此|所以|此外|另外)\s+",
    re.I,
)


def _strip_claim_markup(text: str) -> str:
    t = _visible_text(text)
    t = t.strip(" *_`\"'「」『』.,;:，；：")
    return t


def split_atomic_claims(claim: str) -> list[str]:
    """Split a compound claim into atomic propositions (conservative)."""
    raw = _strip_claim_markup(claim)
    if not raw:
        return []
    # Sentence-level split first.
    parts = [p.strip() for p in _SENTENCE_SPLIT_RE.split(raw) if p.strip()]
    atoms: list[str] = []
    for part in parts:
        # Conjunction split, but only where both sides look propositional.
        sub = _CONJUNCTION_RE.split(part)
        if len(sub) <= 1:
            atoms.append(part)
            continue
        for s in sub:
            s = s.strip(" ,，;；")
            if not s:
                continue
            # Keep fragment only if it has a critical anchor or >= 3 latin tokens or >= 4 cjk chars.
            cjk = sum(len(r) for r in _CJK_RUN_RE.findall(s))
            latin = len(_LATIN_WORD_RE.findall(s))
            has_anchor = bool(_CRITICAL_DATE_RE.search(s) or _CRITICAL_NUMBER_RE.search(s))
            if has_anchor or latin >= 3 or cjk >= 4:
                atoms.append(s)
    # Drop near-empty / non-propositional atoms.
    atoms = [a for a in atoms if useful_char_count(a) >= 4]
    if not atoms:
        atoms = [raw]
    return atoms[:_MAX_ATOMIC_CLAIMS]


# --- occurrence extraction ---------------------------------------------------

def _mask_non_citation_regions(answer: str) -> str:
    """Length-preserving masking of regions that must not produce citation anchors."""
    t = str(answer or "")
    # Escape \[n\] (and \[n, m\]) → spaces.
    t = re.sub(r"\\\[[^\]]*\\\]", lambda m: " " * len(m.group(0)), t)
    t = re.sub(r"\\\[[^\]]*\]", lambda m: " " * len(m.group(0)), t)
    t = re.sub(r"\\\]", lambda m: " " * len(m.group(0)), t)
    # Fenced code blocks.
    t = re.sub(r"```[^\n]*\n?[\s\S]*?```", lambda m: re.sub(r"\S", " ", m.group(0)), t)
    # Inline code.
    t = re.sub(r"`[^`]*`", lambda m: " " * len(m.group(0)), t)
    # HTML/script/style/code/pre contents.
    t = re.sub(
        r"<(script|style|code|pre)\b[^>]*>[\s\S]*?</\1>",
        lambda m: re.sub(r"\S", " ", m.group(0)),
        t,
        flags=re.I,
    )
    # HTML tag attributes (keep the tag boundary chars but blank interiors so [n]
    # inside attributes is not matched). Replace attribute text with spaces.
    t = re.sub(r"<[a-zA-Z][^>]*>", lambda m: "<" + re.sub(r"\S", " ", m.group(0)[1:-1]) + ">", t)
    return t


def _claim_before_citation(answer: str, match_start: int) -> str:
    start = max(0, match_start - _CLAIM_LOOKBACK)
    chunk = answer[start:match_start]
    for sep in ("\n", "。", "！", "？", ". ", "; ", "；"):
        idx = chunk.rfind(sep)
        if idx >= 0:
            chunk = chunk[idx + len(sep):]
    return _strip_claim_markup(chunk)


def extract_citation_occurrences(answer: str) -> list[dict[str, Any]]:
    """Structured citation occurrences in document order.

    Each item: {occurrence_id, occurrence_index, group_index, marker_index,
    marker_occurrence_index, marker, marker_start, marker_end, claim, atoms}.
    """
    masked = _mask_non_citation_regions(answer)
    occurrences: list[dict[str, Any]] = []
    occurrence_index = 0
    group_index = 0
    marker_counts: dict[str, int] = {}
    for gi, match in enumerate(_CITATION_RE.finditer(masked)):
        group_index = gi
        ids_raw = [p.strip() for p in match.group(1).split(",") if p.strip().isdigit()]
        if not ids_raw:
            continue
        claim = _claim_before_citation(answer, match.start())
        atoms = split_atomic_claims(claim)
        for marker_index, mid in enumerate(ids_raw):
            mo = marker_counts.get(mid, 0)
            occ = {
                "occurrence_id": f"citation-{occurrence_index}",
                "occurrence_index": occurrence_index,
                "group_index": group_index,
                "marker_index": marker_index,
                "marker_occurrence_index": mo,
                "marker": mid,
                "marker_start": match.start(),
                "marker_end": match.end(),
                "claim": claim[:_MAX_CLAIM_CHARS],
                "atoms": atoms,
            }
            occurrences.append(occ)
            marker_counts[mid] = mo + 1
            occurrence_index += 1
    return occurrences


# --- candidate segmentation & scoring ---------------------------------------

def _split_sentence_spans(text: str) -> list[tuple[int, int]]:
    """Split ``text`` into sentence-ish spans, always in ORIGINAL-text offsets.

    Shared by ``_segment_candidates`` and ``_anchor_candidates_around`` so both
    produce candidates whose (start, end) refer to the same coordinate system.
    Normalization elsewhere can change text length (``。`` → ``". "``, entity
    decoding, whitespace folding); locating anchors inside the normalized copy
    and then slicing the original shifted every offset, which turned verified
    matches into related/missing verdicts.
    """
    spans: list[tuple[int, int]] = []
    start = 0
    for m in re.finditer(r"[。！？!?；;\n]+|\.\s+", text or ""):
        if m.end() > start:
            spans.append((start, m.end()))
            start = m.end()
    if start < len(text or ""):
        spans.append((start, len(text or "")))
    return spans


def _merge_candidates_by_start(
    cands: list[dict[str, Any]], min_gap: int = 30
) -> list[dict[str, Any]]:
    """按 start 排序并合并相距小于 ``min_gap`` 的候选，保留更长的一条。

    ``_segment_candidates`` 与 ``_find_evidence_for_claim`` 共用同一去重规则，
    抽出此助手避免两处逻辑漂移。
    """
    ordered = sorted(cands, key=lambda c: c["start"])
    merged: list[dict[str, Any]] = []
    for c in ordered:
        if merged and c["start"] - merged[-1]["start"] < min_gap:
            # Prefer the longer / more coherent of the two.
            if len(c["text"]) > len(merged[-1]["text"]):
                merged[-1] = c
            continue
        merged.append(c)
    return merged


def _segment_candidates(text: str) -> list[dict[str, Any]]:
    """Split source text into bounded candidate passages with offsets."""
    raw = text[:_MAX_SOURCE_CHARS]
    if not raw.strip():
        return []
    parts = _split_sentence_spans(raw)
    candidates: list[dict[str, Any]] = []
    seen_starts: set[int] = set()
    for s, e in parts:
        seg = raw[s:e]
        if not seg.strip():
            continue
        # Single sentence.
        key = s
        if key not in seen_starts and len(seg) <= _MAX_QUOTE_CHARS + 120:
            candidates.append({"text": seg, "start": s, "end": e, "coherent": True})
            seen_starts.add(key)
        # Adjacent two-sentence window for context.
        win_end = min(len(raw), e + _QUOTE_WINDOW)
        win = raw[s:win_end]
        if len(win) > 12 and s + 1 not in seen_starts:
            candidates.append({"text": win, "start": s, "end": win_end, "coherent": len(seg) >= 12})
            seen_starts.add(s + 1)
    # Deduplicate heavily overlapping candidates, keep earliest.
    candidates.sort(key=lambda c: c["start"])
    deduped: list[dict[str, Any]] = []
    for c in candidates:
        if deduped and c["start"] - deduped[-1]["start"] < 30:
            # Prefer the longer / more coherent of the two.
            if len(c["text"]) > len(deduped[-1]["text"]):
                deduped[-1] = c
            continue
        deduped.append(c)
    return deduped[:_MAX_CANDIDATES]


def _anchor_regex(surface: str) -> re.Pattern | None:
    """Compile an anchor surface into a regex that matches the ORIGINAL text.

    The surface comes from ``_extract_structured_anchors`` running on
    ``_normalize_text`` output, so it is already case-folded and whitespace
    collapsed. We escape each whitespace-separated token and join with a
    flexible ``\\s+`` so a single normalised anchor still matches the original
    regardless of how the text was folded. Matching is case-insensitive.
    """
    parts = [re.escape(tok) for tok in re.split(r"\s+", (surface or "").strip()) if tok]
    if not parts:
        return None
    return re.compile(r"\s+".join(parts), re.IGNORECASE)


def _anchor_candidates_around(text: str, anchors: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Build candidates as the whole sentence containing each critical anchor.

    Offsets are ORIGINAL-text coordinates (same as ``_segment_candidates``),
    because we locate each anchor by searching the unmodified ``text`` rather
    than a normalized copy. Previously this function searched inside
    ``_normalize_text(text)`` and used that offset to slice ``text`` — which
    drifted whenever normalisation changed length, corrupting every
    anchor-derived quote window.
    """
    spans = _split_sentence_spans(text)
    if not spans:
        return []
    out: list[dict[str, Any]] = []
    for anchor in anchors:
        surface = str(anchor.get("surface") or anchor.get("value") or "").strip()
        pattern = _anchor_regex(surface)
        if not pattern:
            continue
        for s, e in spans:
            if pattern.search(text[s:e]):
                out.append({"text": text[s:e], "start": s, "end": e, "coherent": True})
    return out


def _score_candidate(
    claim_data: dict[str, Any],
    candidate: dict[str, Any],
    ctext_full: str = "",
) -> dict[str, Any]:
    """Score one candidate passage against one atomic claim. Returns signals + status."""
    ctext = candidate["text"]
    clower = _normalize_text(ctext)
    reasons: list[str] = []

    # Lexical recall (weighted claim features present in candidate).
    claim_feats = claim_data["features"]
    if claim_feats:
        present = {tok: w for tok, w in claim_feats.items() if tok in clower}
        lexical_recall = sum(present.values()) / sum(claim_feats.values())
    else:
        present = {}
        lexical_recall = 0.0

    # Subject agreement.
    subjects = claim_data["subjects"]
    # Filter out spurious 1-2 char "subjects" that are really common words.
    subjects = [s for s in subjects if _is_meaningful_subject(s, claim_data["raw"])]
    if subjects:
        subj_hits = sum(1 for s in subjects if s in clower)
        subject_score = subj_hits / len(subjects)
    else:
        subj_hits = 0
        subject_score = 0.5  # neutral when no subject can be extracted

    # Anchor agreement (with unit consistency).
    claim_anchors = claim_data["anchors"]
    if claim_anchors:
        anchor_ok = 0
        anchor_conflict = 0
        cand_anchors = _extract_structured_anchors(ctext)
        for a in claim_anchors:
            same_value = [ca for ca in cand_anchors if _numbers_equal(ca["value"], a["value"])]
            if not same_value:
                # Try normalized-number match (comma-stripped) with correct offset handling.
                compact = a["value"].replace(",", "")
                if compact and compact in clower.replace(",", ""):
                    anchor_ok += 1
                continue
            # Value matched — now check unit/dimension consistency.
            if any(_anchor_conflict(a, ca) for ca in same_value):
                anchor_conflict += 1
                reasons.append("unit-conflict")
            else:
                anchor_ok += 1
        anchor_score = anchor_ok / len(claim_anchors)
        if anchor_conflict:
            reasons.append("anchor-unit-conflict")
    else:
        anchor_score = 0.5
        anchor_conflict = 0

    # Context (non-anchor, non-subject predicate overlap).
    context_tokens = [t for t in claim_feats if t not in claim_data["anchor_surfaces"] and t not in subjects]
    if context_tokens:
        ctx_hits = sum(1 for t in context_tokens if t in clower)
        context_score = ctx_hits / len(context_tokens)
    else:
        context_score = 0.5

    coherence = 1.0 if candidate.get("coherent", True) else 0.6

    base = (
        _W_LEXICAL * lexical_recall
        + _W_SUBJECT * subject_score
        + _W_ANCHOR_SCORE * anchor_score
        + _W_CONTEXT * context_score
        + _W_COHERENCE * coherence
    )

    # Polarity / negation conflict (scoped to a shared predicate).
    claim_pol, _ = _polarity(claim_data["raw"])
    cand_pol, _ = _polarity(ctext)
    # Only count as a conflict when both sides share a substantive predicate
    # (so a stray "no" elsewhere doesn't fire) and one is negated vs the other.
    shared_predicate = _shares_predicate(claim_data["raw"], clower)
    polarity_conflict = (
        claim_pol != 0
        and cand_pol != 0
        and claim_pol != cand_pol
        and shared_predicate
    )
    # Additionally: if the candidate contains an explicit negation AND the claim does not,
    # over a shared predicate, treat that as a conflict even when direction words are absent.
    if not polarity_conflict and shared_predicate:
        cand_negated = bool(_NEGATION_RE.search(ctext) or _NEGATION_CN_RE.search(ctext))
        claim_negated = bool(_NEGATION_RE.search(claim_data["raw"]) or _NEGATION_CN_RE.search(claim_data["raw"]))
        if cand_negated != claim_negated:
            polarity_conflict = True
    if polarity_conflict:
        reasons.append("polarity-conflict")

    # Boilerplate penalty.
    boilerplate = _is_boilerplate(ctext)
    if boilerplate:
        reasons.append("boilerplate")

    # Anchor-required-but-missing penalty.
    anchor_missing = bool(claim_anchors) and anchor_score == 0
    if anchor_missing:
        reasons.append("anchor-missing")

    score = base
    hard_conflict = False
    if anchor_conflict:
        score -= _PEN_UNIT_CONFLICT
        hard_conflict = True
    if polarity_conflict:
        score -= _PEN_POLARITY_CONFLICT
        hard_conflict = True
    if boilerplate:
        score -= _PEN_BOILERPLATE
    if anchor_missing:
        score -= _PEN_ANCHOR_MISSING
    score = max(0.0, min(1.0, score))

    # Literal-span gate: a meaningful normalized claim span must appear verbatim.
    literal_span_ok = _literal_span_present(claim_data["raw"], clower)

    signals = {
        "lexical": round(lexical_recall, 3),
        "subject": round(subject_score, 3),
        "anchors": round(anchor_score, 3),
        "context": round(context_score, 3),
        "coherence": coherence,
        "boilerplate": 1.0 if boilerplate else 0.0,
        "polarity_conflict": 1.0 if polarity_conflict else 0.0,
        "unit_conflict": 1.0 if anchor_conflict else 0.0,
        "literal_span": 1.0 if literal_span_ok else 0.0,
    }

    # Status assignment (conservative; precision over recall).
    if (
        not hard_conflict
        and literal_span_ok
        and score >= _THRESHOLD_VERIFIED
        and subject_score >= _VERIFIED_SUBJECT
        and anchor_score >= _VERIFIED_ANCHOR
        and not boilerplate
        and not polarity_conflict
    ):
        status = STATUS_VERIFIED
        method = "literal-span"
    elif (
        not hard_conflict
        and score >= _THRESHOLD_LIKELY
        and subject_score >= _LIKELY_SUBJECT
        and not boilerplate
        and not polarity_conflict
    ):
        status = STATUS_LIKELY
        method = "guarded-overlap"
    elif score >= _THRESHOLD_RELATED or subj_hits > 0 or hard_conflict or polarity_conflict:
        status = STATUS_RELATED
        method = "topic-overlap" if not (hard_conflict or polarity_conflict) else "conflict"
    else:
        status = STATUS_MISSING
        method = "no-overlap"

    return {
        "quote": _format_quote(ctext_full, candidate["start"], candidate["end"]),
        "score": round(score, 3),
        "status": status,
        "method": method,
        "char_start": candidate["start"],
        "char_end": candidate["end"],
        "signals": signals,
        "reasons": reasons,
    }


def _literal_span_present(claim: str, candidate_lower: str) -> bool:
    """True if a meaningful normalized proposition span appears verbatim in candidate."""
    norm = _normalize_text(claim).strip(" .;:!?")
    candidate_norm = _normalize_text(candidate_lower)
    # Strongest path: the entire meaningful normalized claim appears contiguously.
    if len(norm) >= 12 and norm in candidate_norm:
        return True
    # Try CJK runs of sufficient length.
    cjk_runs = [r for r in _CJK_RUN_RE.findall(norm) if len(r) >= _LITERAL_CJK_MIN]
    for run in cjk_runs:
        if run in candidate_norm:
            return True
    # Try a Latin token sequence. Numeric anchors are checked separately, so two
    # substantive Latin tokens + a critical anchor can still form a literal proposition.
    latin_tokens = _LATIN_WORD_RE.findall(norm)
    substantive = [t for t in latin_tokens if len(t) >= 3]
    if len(substantive) >= 2:
        for width in range(min(6, len(substantive)), 1, -1):
            for i in range(0, len(substantive) - width + 1):
                window = " ".join(substantive[i : i + width])
                if window in candidate_norm:
                    return True
    return False


def _format_quote(text: str, start: int, end: int) -> str:
    quote = _clean_ws(text[start:end])
    if start > 0:
        quote = "…" + quote
    if end < len(text):
        quote = quote + "…"
    if len(quote) > _MAX_QUOTE_CHARS + 4:
        quote = quote[: _MAX_QUOTE_CHARS] + "…"
    return quote


# --- public matching entry points -------------------------------------------

def _find_evidence_for_claim(claim: str, content: str) -> dict[str, Any]:
    """Stage matcher: candidate retrieval + guarded scoring for one atomic claim."""
    text = content or ""
    if not text.strip():
        return {
            "quote": "", "score": 0.0, "status": STATUS_MISSING, "method": "none",
            "char_start": None, "char_end": None, "signals": {}, "reasons": [],
        }
    raw_claim = _strip_claim_markup(claim)
    if not raw_claim:
        return {
            "quote": build_snippet(text, max_len=_QUOTE_WINDOW),
            "score": 0.0, "status": STATUS_MISSING, "method": "empty-claim",
            "char_start": 0, "char_end": min(len(text), _QUOTE_WINDOW), "signals": {}, "reasons": [],
        }

    claim_data = {
        "raw": raw_claim,
        "features": _tokenize_features(raw_claim),
        "anchors": _extract_structured_anchors(raw_claim),
        "subjects": _extract_subject_terms(raw_claim),
        "anchor_surfaces": {a["surface"].lower() for a in _extract_structured_anchors(raw_claim)},
    }

    candidates = _segment_candidates(text)
    anchor_cands = _anchor_candidates_around(text, claim_data["anchors"])
    # Merge, dedup by start proximity, cap.
    merged = anchor_cands + candidates
    merged.sort(key=lambda c: c["start"])
    deduped: list[dict[str, Any]] = []
    for c in merged:
        if deduped and c["start"] - deduped[-1]["start"] < 30:
            if len(c["text"]) > len(deduped[-1]["text"]):
                deduped[-1] = c
            continue
        deduped.append(c)
    deduped = deduped[:_MAX_CANDIDATES]
    if not deduped:
        deduped = [{"text": text[:_QUOTE_WINDOW], "start": 0, "end": min(len(text), _QUOTE_WINDOW), "coherent": False}]

    best: dict[str, Any] | None = None
    for cand in deduped:
        result = _score_candidate(claim_data, cand, text)
        if best is None or _status_rank(result["status"]) > _status_rank(best["status"]) or (
            _status_rank(result["status"]) == _status_rank(best["status"]) and result["score"] > best["score"]
        ):
            best = result
    return best or {
        "quote": "", "score": 0.0, "status": STATUS_MISSING, "method": "none",
        "char_start": None, "char_end": None, "signals": {}, "reasons": [],
    }


_STATUS_RANK = {STATUS_MISSING: 0, STATUS_RELATED: 1, STATUS_LIKELY: 2, STATUS_VERIFIED: 3}


def _status_rank(status: str) -> int:
    return _STATUS_RANK.get(normalize_display_status(status), 0)


def build_citation_evidences(
    answer: str,
    sources: list[dict[str, Any]] | None,
) -> list[dict[str, Any]]:
    """Build per-occurrence, per-atomic-claim evidence list (schema v2)."""
    source_by_id: dict[str, dict[str, Any]] = {}
    for src in sources or []:
        if not isinstance(src, dict) or src.get("id") is None:
            continue
        source_by_id[str(src["id"])] = src

    evidences: list[dict[str, Any]] = []
    for occ in extract_citation_occurrences(answer):
        mid = str(occ["marker"])
        src = source_by_id.get(mid)
        atoms = occ.get("atoms") or [occ["claim"]]
        if not any(a.strip() for a in atoms):
            atoms = [occ["claim"] or "search"]

        url = str(src.get("url") or "") if src else ""
        title = str((src or {}).get("title") or url or f"Source {mid}")
        domain = _domain_of(url) or str((src or {}).get("domain") or "")
        date = (src or {}).get("date") or ""

        if not src:
            for claim_index, atom in enumerate(atoms):
                evidences.append(_base_evidence(occ, mid, mid, atom, claim_index, {
                    "quote": "", "score": 0.0, "status": STATUS_MISSING, "method": "no-source",
                    "char_start": None, "char_end": None, "signals": {}, "reasons": ["no-source"],
                }, title, url, domain, date))
            continue

        content = str(src.get("content") or "")
        if not content:
            content = str(src.get("excerpt") or src.get("snippet") or "")

        for claim_index, atom in enumerate(atoms):
            hit = _find_evidence_for_claim(atom, content)
            evidences.append(_base_evidence(occ, mid, src.get("id", mid), atom, claim_index, hit, title, url, domain, date))

    return evidences


def _base_evidence(
    occ: dict[str, Any],
    marker: str,
    source_id: Any,
    claim: str,
    claim_index: int,
    hit: dict[str, Any],
    title: str,
    url: str,
    domain: str,
    date: Any,
) -> dict[str, Any]:
    return {
        "schema_version": _EVIDENCE_SCHEMA_VERSION,
        "occurrence_id": occ["occurrence_id"],
        "occurrence_index": occ["occurrence_index"],
        "group_index": occ["group_index"],
        "marker_index": occ["marker_index"],
        "marker_occurrence_index": occ["marker_occurrence_index"],
        "marker": marker,
        "source_id": source_id,
        "claim_index": claim_index,
        "claim": str(claim)[:_MAX_CLAIM_CHARS],
        "quote": hit.get("quote", ""),
        "score": hit.get("score", 0.0),
        "status": hit.get("status", STATUS_MISSING),
        "method": hit.get("method", "none"),
        "char_start": hit.get("char_start"),
        "char_end": hit.get("char_end"),
        "signals": hit.get("signals", {}),
        "reasons": hit.get("reasons", []),
        "verification": None,
        "title": title,
        "url": url,
        "domain": domain,
        "date": date,
    }


def apply_verification_verdicts(
    evidences: list[dict[str, Any]],
    verdicts: dict[str, dict[str, Any]],
) -> list[dict[str, Any]]:
    """Conservatively merge LLM verification verdicts keyed by occurrence_id:claim_index.

    A SUPPORTED verdict may upgrade ``related`` → ``likely`` (never to verified-literal).
    A CONTRADICTED verdict caps the status at ``related``. NOT_ENOUGH_INFO is a no-op.
    Failures (missing/unknown ids) leave evidence unchanged.
    """
    for ev in evidences:
        key = f"{ev.get('occurrence_id')}:{ev.get('claim_index', 0)}"
        v = verdicts.get(key)
        if not v or not isinstance(v, dict):
            continue
        verdict = str(v.get("verdict", "")).strip().upper()
        ev["verification"] = {
            "verdict": verdict,
            "confidence": v.get("confidence"),
            "reason": str(v.get("reason", ""))[:200],
        }
        current = normalize_display_status(ev.get("status"))
        if verdict == "SUPPORTED":
            if current == STATUS_RELATED:
                ev["status"] = STATUS_LIKELY
                ev.setdefault("reasons", []).append("llm-supported")
        elif verdict == "CONTRADICTED":
            if current in (STATUS_VERIFIED, STATUS_LIKELY):
                ev["status"] = STATUS_RELATED
                ev.setdefault("reasons", []).append("llm-contradicted")
        # NOT_ENOUGH_INFO: no change.
    return evidences


def select_verification_candidates(
    evidences: list[dict[str, Any]],
    *,
    max_items: int = 3,
    min_score: float = 0.50,
    max_score: float = 0.74,
) -> list[dict[str, Any]]:
    """Pick borderline / high-impact / conflict records for optional LLM verification."""
    candidates = []
    for ev in evidences:
        status = normalize_display_status(ev.get("status"))
        reasons = ev.get("reasons") or []
        score = float(ev.get("score") or 0.0)
        if status == STATUS_VERIFIED:
            continue
        if status == STATUS_MISSING and not reasons:
            continue
        is_borderline = min_score <= score <= max_score
        is_conflict = any(r in reasons for r in ("polarity-conflict", "anchor-unit-conflict", "unit-conflict"))
        is_high_impact = bool(ev.get("signals", {}).get("anchors", 0))
        if is_borderline or is_conflict or (is_high_impact and status == STATUS_RELATED):
            candidates.append(ev)
    # Prioritize conflicts, then borderline closest to threshold, then high-impact.
    candidates.sort(
        key=lambda e: (
            0 if any(r in (e.get("reasons") or []) for r in ("polarity-conflict", "anchor-unit-conflict", "unit-conflict")) else 1,
            -abs(float(e.get("score") or 0.0) - (min_score + max_score) / 2),
        )
    )
    return candidates[:max_items]
