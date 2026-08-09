import logging
import os
import json
import time

logger = logging.getLogger(__name__)

# Cache for selector config with hot-reload support
_config_cache: dict = {}
_config_mtime: float = 0.0

_FALLBACK_SELECTOR_CONFIG = {
    "google": {
        "base_url": "https://www.google.com/search?q={query}&num={num}&hl=en",
        "selectors": {
            "result_container": ["div.g", "#rso > div"],
            "title": "h3, div[role='heading']",
            "link": "a[href]:not([href^=\"#\"]):not([href^=\"/search\"])",
            "snippet": "div[style*='-webkit-line-clamp'], .VwiC3b, [data-sncf]",
            "date": ".LEwnzc, span.f",
        },
        "wait_selector": "#rso, [data-ved]",
    }
}


def _normalize_engine_config(engine: str, raw_config: dict) -> dict:
    if not isinstance(raw_config, dict):
        raise ValueError(f"{engine}: engine config must be an object")

    base_url = str(raw_config.get("base_url", "")).strip()
    wait_selector = str(raw_config.get("wait_selector", "")).strip()
    selectors = raw_config.get("selectors")
    if not base_url:
        raise ValueError(f"{engine}: base_url is required")
    if not wait_selector:
        raise ValueError(f"{engine}: wait_selector is required")
    if not isinstance(selectors, dict):
        raise ValueError(f"{engine}: selectors must be an object")

    result_container = selectors.get("result_container")
    if isinstance(result_container, str):
        result_container = [result_container.strip()]
    elif isinstance(result_container, list):
        result_container = [
            str(selector).strip()
            for selector in result_container
            if str(selector).strip()
        ]
    else:
        result_container = []
    if not result_container:
        raise ValueError(f"{engine}: selectors.result_container is required")

    normalized_selectors = {
        "result_container": result_container,
        "title": str(selectors.get("title", "")).strip(),
        "link": str(selectors.get("link", "")).strip(),
        "snippet": str(selectors.get("snippet", "")).strip(),
        "date": str(selectors.get("date", "")).strip(),
    }
    missing_selector_fields = [
        field
        for field in ("title", "link", "snippet")
        if not normalized_selectors[field]
    ]
    if missing_selector_fields:
        raise ValueError(
            f"{engine}: missing selector fields: {', '.join(missing_selector_fields)}"
        )

    return {
        "base_url": base_url,
        "selectors": normalized_selectors,
        "wait_selector": wait_selector,
    }


def _normalize_selector_config(raw_config: dict) -> dict:
    if not isinstance(raw_config, dict):
        raise ValueError("selector config root must be an object")

    normalized = {}
    invalid_engines = []
    for engine, engine_config in raw_config.items():
        engine_name = str(engine or "").strip()
        if not engine_name:
            invalid_engines.append("<empty>: engine name is required")
            continue
        try:
            normalized[engine_name] = _normalize_engine_config(engine_name, engine_config)
        except ValueError as e:
            invalid_engines.append(str(e))

    if invalid_engines:
        logger.warning(
            "[SearchEngine] 忽略无效搜索引擎配置: %s",
            "; ".join(invalid_engines),
        )
    if not normalized:
        raise ValueError("selector config does not contain any valid engines")
    return normalized


def load_selectors(engine: str = "google") -> dict:
    """Load search engine CSS selectors from config file.
    
    Supports hot-reload: if the config file has been modified since last load,
    it will be re-read automatically.
    
    Returns the full engine config dict. Callers extract the specific engine by name.
    """
    global _config_cache, _config_mtime

    config_path = os.path.join(os.path.dirname(__file__), 'search_selectors.json')
    
    try:
        # Check for file modification (hot-reload)
        current_mtime = os.path.getmtime(config_path)
        if current_mtime != _config_mtime:
            with open(config_path, 'r', encoding='utf-8') as f:
                loaded_config = _normalize_selector_config(json.load(f))
            _config_cache = loaded_config
            _config_mtime = current_mtime
            logger.info("[SearchEngine] 重新加载搜索引擎配置 (mtime=%.0f)", _config_mtime)
    except (OSError, json.JSONDecodeError, ValueError) as e:
        logger.error("[SearchEngine] 加载搜索引擎配置失败: %s", e)
    
    config = _config_cache or _FALLBACK_SELECTOR_CONFIG

    if engine is None:
        return config

    if engine in config:
        return config[engine]
    # Engine not in config — return the stable default engine.
    return config.get("google", {})


def get_all_engines() -> list:
    """Return a list of all available search engine names."""
    config = load_selectors(None)
    return list(config.keys()) if config else ["google"]
