import ast
import re
import struct
import zlib
from pathlib import Path


PROJECT_ROOT = Path(__file__).resolve().parents[1]


def _read_rgba_png(path):
    data = path.read_bytes()
    assert data.startswith(b"\x89PNG\r\n\x1a\n")

    offset = 8
    width = height = color_type = None
    compressed = bytearray()
    while offset < len(data):
        chunk_length = struct.unpack(">I", data[offset : offset + 4])[0]
        chunk_type = data[offset + 4 : offset + 8]
        chunk_data = data[offset + 8 : offset + 8 + chunk_length]
        offset += 12 + chunk_length

        if chunk_type == b"IHDR":
            width, height, bit_depth, color_type, compression, filter_method, interlace = struct.unpack(
                ">IIBBBBB", chunk_data
            )
            assert bit_depth == 8
            assert color_type == 6
            assert compression == 0
            assert filter_method == 0
            assert interlace == 0
        elif chunk_type == b"IDAT":
            compressed.extend(chunk_data)
        elif chunk_type == b"IEND":
            break

    assert width is not None and height is not None
    raw = zlib.decompress(bytes(compressed))
    stride = width * 4
    rows = []
    previous = bytearray(stride)
    cursor = 0

    for _ in range(height):
        filter_type = raw[cursor]
        cursor += 1
        current = bytearray(raw[cursor : cursor + stride])
        cursor += stride

        for index, value in enumerate(current):
            left = current[index - 4] if index >= 4 else 0
            above = previous[index]
            upper_left = previous[index - 4] if index >= 4 else 0

            if filter_type == 1:
                current[index] = (value + left) & 0xFF
            elif filter_type == 2:
                current[index] = (value + above) & 0xFF
            elif filter_type == 3:
                current[index] = (value + ((left + above) // 2)) & 0xFF
            elif filter_type == 4:
                predictor = left + above - upper_left
                pa = abs(predictor - left)
                pb = abs(predictor - above)
                pc = abs(predictor - upper_left)
                predicted = left if pa <= pb and pa <= pc else above if pb <= pc else upper_left
                current[index] = (value + predicted) & 0xFF
            else:
                assert filter_type == 0

        rows.append(bytes(current))
        previous = current

    def pixel(x, y):
        index = x * 4
        return tuple(rows[y][index : index + 4])

    return width, height, pixel


def test_readme_project_structure_matches_current_files():
    readme = (PROJECT_ROOT / "README.md").read_text(encoding="utf-8")

    stale_references = [
        "chat_manager.py",
        "settings_manager.py",
        "benchmark_freshqa.py",
        "settings.json) 和聊天记录 (`chats/`)",
        "backend/chats",
    ]
    for reference in stale_references:
        assert reference not in readme

    current_references = [
        "database.py",
        "extension_bridge.py",
        "openai_client.py",
        "crawler/",
        "sections/",
        "source-renderer.js",
        "data/",
    ]
    for reference in current_references:
        assert reference in readme


def test_browser_manager_does_not_import_browser_context_private_search_state():
    # 桥接重构后 browser_context 已删除;此断言改为确保 browser_manager 不再 import 它。
    source_path = PROJECT_ROOT / "backend/app/browser_manager.py"
    tree = ast.parse(source_path.read_text(encoding="utf-8"))

    imports_browser_context = any(
        isinstance(node, ast.ImportFrom) and node.module == "browser_context"
        for node in ast.walk(tree)
    )
    assert not imports_browser_context


def test_search_result_cleanup_is_split_from_browser_manager():
    cleanup_path = PROJECT_ROOT / "backend/app/search_result_cleanup.py"
    manager_path = PROJECT_ROOT / "backend/app/browser_manager.py"

    assert cleanup_path.is_file()

    cleanup_source = cleanup_path.read_text(encoding="utf-8")
    manager_source = manager_path.read_text(encoding="utf-8")

    assert "def clean_fallback_title" in cleanup_source
    assert "def is_generic_search_aux_title" in cleanup_source
    assert "def is_search_engine_internal_page" in cleanup_source
    assert "def _clean_fallback_title" not in manager_source
    assert "def _is_generic_search_aux_title" not in manager_source
    assert "def _is_search_engine_internal_page" not in manager_source


def test_captcha_verification_uses_real_chrome_bridge_not_remote_modal():
    """Bridge redesign: captcha is solved in the user's real Chrome; no remote modal."""
    manager_source = (
        PROJECT_ROOT / "backend/app/browser_manager.py"
    ).read_text(encoding="utf-8")
    chat_source = (
        PROJECT_ROOT / "backend/static/js/modules/chat.js"
    ).read_text(encoding="utf-8")
    bridge_source = (
        PROJECT_ROOT / "backend/static/js/modules/bridge.js"
    ).read_text(encoding="utf-8")

    # Legacy remote-browser verification helpers must stay gone.
    assert "async def _wait_for_manual_verification" not in manager_source
    assert "async def _handle_verification_pages" not in manager_source
    assert "register_interaction_session" not in manager_source
    assert "openBrowserModal" not in chat_source
    assert not (PROJECT_ROOT / "backend/static/js/modules/browser-modal.js").is_file()
    # Chat requires the Chrome extension bridge before searching.
    assert "ensureBridgeConnected" in chat_source
    assert "fetchBridgeStatus" in bridge_source


def test_frontend_opens_browser_modal_for_all_search_verification_actions():
    # Kept for historical test name; behavior is "no modal" after bridge redesign.
    chat_source = (
        PROJECT_ROOT / "backend/static/js/modules/chat.js"
    ).read_text(encoding="utf-8")

    assert "openBrowserModal" not in chat_source
    assert "ensureBridgeConnected" in chat_source


def test_bridge_install_guidance_is_wired_in_frontend():
    index_source = (PROJECT_ROOT / "backend/static/index.html").read_text(
        encoding="utf-8"
    )
    main_source = (PROJECT_ROOT / "backend/static/js/main.js").read_text(
        encoding="utf-8"
    )
    chat_source = (PROJECT_ROOT / "backend/static/js/modules/chat.js").read_text(
        encoding="utf-8"
    )
    bridge_source = (PROJECT_ROOT / "backend/static/js/modules/bridge.js").read_text(
        encoding="utf-8"
    )
    settings_source = (
        PROJECT_ROOT / "backend/static/js/modules/settings-modal.js"
    ).read_text(encoding="utf-8")
    database_source = (PROJECT_ROOT / "backend/app/database.py").read_text(
        encoding="utf-8"
    )
    stats_source = (PROJECT_ROOT / "backend/app/routers/stats.py").read_text(
        encoding="utf-8"
    )
    chat_router_source = (PROJECT_ROOT / "backend/app/routers/chat.py").read_text(
        encoding="utf-8"
    )

    assert 'id="bridge-status-btn"' in index_source
    assert 'id="bridge-install-modal"' in index_source
    assert 'id="bridge-download-btn"' in index_source
    assert 'id="tab-bridge"' in index_source
    assert 'data-tab="bridge"' in index_source
    assert 'id="bridge-require-before-send-input"' in index_source
    assert 'id="settings-bridge-recheck-btn"' in index_source
    assert 'id="settings-bridge-hero"' in index_source
    assert 'bridge-actions-row' in index_source
    assert 'bridge-help-steps' in index_source
    assert 'settings-field-row' in index_source
    assert "startBridgeStatusPolling" in main_source
    assert "applyBridgePreferencesFromSettings" in main_source
    assert "ensureBridgeConnected" in chat_source
    assert "wireBridgeSettingsPanel" in settings_source
    assert "bridge_require_before_send" in database_source
    assert "BRIDGE_REQUIRED" in chat_router_source
    assert "/api/extension/download" in stats_source
    assert "fetchBridgeStatus" in bridge_source
    assert "openBridgeInstallModal" in bridge_source
    assert "getBridgePreferences" in bridge_source


def test_google_engine_uses_official_multicolor_icon():
    index_source = (PROJECT_ROOT / "backend/static/index.html").read_text(
        encoding="utf-8"
    )
    chat_source = (
        PROJECT_ROOT / "backend/static/js/modules/chat.js"
    ).read_text(encoding="utf-8")
    google_item_match = re.search(
        r'<div class="quick-dropdown-item" data-value="google">(.*?)</div>',
        index_source,
        re.DOTALL,
    )

    assert google_item_match is not None
    google_markup = google_item_match.group(1)
    assert 'class="engine-icon logo-google"' in google_markup
    assert 'fill="currentColor"' not in google_markup
    assert google_markup.count('<path') >= 4
    assert 'fill="#4285F4"' in google_markup
    assert 'fill="#EA4335"' in google_markup
    assert 'fill="#FBBC05"' in google_markup
    assert 'fill="#34A853"' in google_markup
    assert "appendChild(activeSvg.cloneNode(true))" in chat_source


def test_sidebar_brand_uses_logo_asset():
    """Sidebar brand is icon-only (logo asset), not split Just/Search text spans."""
    index_source = (PROJECT_ROOT / "backend/static/index.html").read_text(
        encoding="utf-8"
    )
    style_source = (PROJECT_ROOT / "backend/static/css/style.css").read_text(
        encoding="utf-8"
    )

    assert 'class="sidebar-brand"' in index_source
    assert "sidebar-brand-logo" in index_source
    assert "/static/assets/justsearch-icon.png" in index_source
    assert ".sidebar-brand" in style_source
    assert ".sidebar-brand-logo" in style_source


def test_sidebar_collapse_controls_toggle_sidebar():
    """Desktop collapse / expand / mini toggle share the same sidebar toggle handler."""
    index_source = (PROJECT_ROOT / "backend/static/index.html").read_text(
        encoding="utf-8"
    )
    sidebar_js = (
        PROJECT_ROOT / "backend/static/js/modules/sidebar.js"
    ).read_text(encoding="utf-8")

    assert 'id="collapse-sidebar-btn"' in index_source
    assert 'id="expand-sidebar-btn"' in index_source or "expand-sidebar-btn" in sidebar_js
    assert "const toggleSidebar = () => {" in sidebar_js
    assert "elements.collapseSidebarBtn?.addEventListener('click', toggleSidebar);" in sidebar_js
    assert "elements.expandSidebarBtn?.addEventListener('click', toggleSidebar);" in sidebar_js


def test_crawler_security_and_redirect_helpers_are_split_out():
    crawler_dir = PROJECT_ROOT / "backend/app/crawler"
    security_path = crawler_dir / "security.py"
    redirects_path = crawler_dir / "redirects.py"
    page_crawler_path = PROJECT_ROOT / "backend/app/page_crawler.py"

    assert (crawler_dir / "__init__.py").is_file()
    assert security_path.is_file()
    assert redirects_path.is_file()

    page_crawler_source = page_crawler_path.read_text(encoding="utf-8")
    assert "from .crawler.security import is_private_url" in page_crawler_source
    assert "from .crawler.redirects import resolve_redirect_url" in page_crawler_source
    assert "def is_private_url" not in page_crawler_source
    assert "def resolve_redirect_url" not in page_crawler_source


def test_crawler_content_helpers_are_split_out():
    content_path = PROJECT_ROOT / "backend/app/crawler/content.py"
    page_crawler_path = PROJECT_ROOT / "backend/app/page_crawler.py"

    assert content_path.is_file()

    content_source = content_path.read_text(encoding="utf-8")
    page_crawler_source = page_crawler_path.read_text(encoding="utf-8")

    assert "async def extract_page_content" in content_source
    assert "async def extract_og_metadata" in content_source
    assert "_try_defuddle_extract" in content_source
    assert "extract_content" in content_source
    # 桥接重构后 install_resource_blocker 已移除(真实浏览器无需 page.route 拦截)。
    assert "install_resource_blocker" not in content_source
    assert "const rawHref = a.getAttribute('href')" in content_source
    assert "const href = a.href || rawHref" in content_source
    assert "from .crawler.content import" in page_crawler_source
    assert "_JS_EXTRACT_CONTENT" not in page_crawler_source
    assert "def _extract_og_metadata" not in page_crawler_source
    assert "def _install_resource_blocker" not in page_crawler_source

    # Defuddle is bundled in the bridge extension (ToMarkdown-compatible engine).
    extension_root = PROJECT_ROOT / "extension"
    assert (extension_root / "lib" / "defuddle.full.js").is_file()
    assert (extension_root / "content" / "defuddle-extract.js").is_file()
    handlers_source = (extension_root / "lib" / "handlers.js").read_text(encoding="utf-8")
    assert "extractContent" in handlers_source
    assert "defuddle.full.js" in handlers_source
    bridge_source = (PROJECT_ROOT / "backend/app/extension_bridge.py").read_text(encoding="utf-8")
    assert "async def extract_content" in bridge_source


def test_legacy_migration_is_split_from_database_module():
    migration_path = PROJECT_ROOT / "backend/app/legacy_migration.py"
    database_path = PROJECT_ROOT / "backend/app/database.py"

    assert migration_path.is_file()

    migration_source = migration_path.read_text(encoding="utf-8")
    database_source = database_path.read_text(encoding="utf-8")

    assert "async def migrate_legacy_data" in migration_source
    assert "async def _migrate_chats_dir" in migration_source
    assert "async def _migrate_settings_file" in migration_source
    assert "def _migrate_chats_dir" not in database_source
    assert "def _migrate_settings_file" not in database_source


def test_legacy_chats_directory_is_not_part_of_source_tree():
    assert not (PROJECT_ROOT / "backend/chats/.gitkeep").exists()


def test_browser_context_module_has_been_removed_in_bridge_refactor():
    # 桥接重构后 browser_context.py 已删除;确保没有残留文件,也没有模块再 import 它。
    assert not (PROJECT_ROOT / "backend/app/browser_context.py").exists()


def test_frontend_interaction_modules_are_split_out():
    modules_dir = PROJECT_ROOT / "backend/static/js/modules"
    expected_modules = [
        "history-view.js",
        "settings-modal.js",
        "sidebar.js",
    ]

    for filename in expected_modules:
        assert (modules_dir / filename).is_file()


def test_frontend_uses_generated_logo_asset():
    logo_path = PROJECT_ROOT / "backend/static/assets/justsearch-logo.png"
    dark_logo_path = PROJECT_ROOT / "backend/static/assets/justsearch-logo-dark.png"
    favicon_path = PROJECT_ROOT / "backend/static/assets/justsearch-favicon.png"
    favicon16_path = PROJECT_ROOT / "backend/static/assets/justsearch-favicon-16.png"
    favicon32_path = PROJECT_ROOT / "backend/static/assets/justsearch-favicon-32.png"
    index_source = (PROJECT_ROOT / "backend/static/index.html").read_text(
        encoding="utf-8"
    )
    manifest_source = (PROJECT_ROOT / "backend/static/manifest.json").read_text(
        encoding="utf-8"
    )

    assert logo_path.is_file()
    assert dark_logo_path.is_file()
    assert favicon_path.is_file()
    assert dark_logo_path.read_bytes()[25] in {4, 6}
    # PNG color type 6 is truecolor with alpha, 4 is grayscale with alpha.
    assert favicon_path.read_bytes()[25] in {4, 6}
    # Tight-cropped tab favicons (16/32) fill the canvas so the mark reads
    # clearly at browser-tab size; the 512 PWA icon keeps its safe-zone padding.
    for small, size in ((favicon16_path, 16), (favicon32_path, 32)):
        assert small.is_file()
        assert small.read_bytes()[25] in {4, 6}
        width, height, _ = _read_rgba_png(small)
        assert (width, height) == (size, size)
    assert "/static/assets/justsearch-favicon-16.png" in index_source
    assert "/static/assets/justsearch-favicon-32.png" in index_source
    assert "/static/assets/justsearch-logo.png" in index_source
    assert "/static/assets/justsearch-logo-dark.png" in index_source
    assert "/static/assets/justsearch-favicon.png" in index_source
    assert "/static/assets/justsearch-favicon.png" in manifest_source
    assert "class=\"brand-logo\"" not in index_source
    assert "sidebar-logo" not in index_source
    assert "hero-brand-logo-light" in index_source
    assert "hero-brand-logo-dark" in index_source


def test_frontend_tests_do_not_depend_on_local_absolute_paths():
    forbidden_fragments = [
        "/Users/",
        "AMC-WebUI",
        "node_modules/jsdom/lib/api.js",
    ]
    offenders = []

    for source_path in sorted((PROJECT_ROOT / "tests/frontend").glob("*.mjs")):
        source = source_path.read_text(encoding="utf-8")
        if any(fragment in source for fragment in forbidden_fragments):
            offenders.append(str(source_path.relative_to(PROJECT_ROOT)))

    assert offenders == []


def test_favicon_uses_transparent_three_tier_stepped_mark():
    """Favicon is the transparent cyan-gradient stepped-L mark (no white plate).

    The mark is stroked (not filled), so the canvas is mostly transparent;
    only the nested L-shaped paths carry colour. We assert the brand palette
    (dark navy tier + cyan gradient tiers) is present and the whole mark sits
    inside the canvas with a transparent border (so dark browser tabs are not
    framed by a hard box).
    """
    favicon_path = PROJECT_ROOT / "backend/static/assets/justsearch-favicon.png"
    width, height, pixel = _read_rgba_png(favicon_path)

    assert (width, height) == (512, 512)

    # Outer corners and canvas border stay transparent.
    for point in [(0, 0), (511, 0), (0, 511), (511, 511)]:
        assert pixel(*point)[3] == 0
    for point in [(256, 16), (16, 256), (496, 256), (256, 496)]:
        assert pixel(*point)[3] <= 20

    # Collect every visible (non-transparent) pixel and its colour.
    seen_colors: dict[tuple[int, int, int], int] = {}
    icon_pixels_x = []
    icon_pixels_y = []
    for y in range(height):
        for x in range(width):
            red, green, blue, alpha = pixel(x, y)
            if alpha <= 20:
                continue
            icon_pixels_x.append(x)
            icon_pixels_y.append(y)
            key = (red, green, blue)
            seen_colors[key] = seen_colors.get(key, 0) + 1

    assert icon_pixels_x and icon_pixels_y

    def _near(target, actual, tol=24):
        return all(abs(t - a) <= tol for t, a in zip(target, actual))

    # The dark navy tier and the cyan gradient tiers must all be present.
    dark_present = any(_near((0x2D, 0x3B, 0x4D), c) for c in seen_colors)
    cyan_present = any(_near((0x00, 0xB8, 0xEC), c) for c in seen_colors)
    cyan_light_present = any(_near((0x70, 0xE0, 0xFA), c) for c in seen_colors)
    assert dark_present, f"dark navy tier #2D3B4D missing; colors={list(seen_colors)[:8]}"
    assert cyan_present, f"cyan tier #00B8EC missing; colors={list(seen_colors)[:8]}"
    assert cyan_light_present, f"light cyan tier #70E0FA missing; colors={list(seen_colors)[:8]}"

    # Mark is inset from the plate edge and reasonably large.
    assert min(icon_pixels_x) >= 16
    assert max(icon_pixels_x) <= 496
    assert min(icon_pixels_y) >= 16
    assert max(icon_pixels_y) <= 496
    assert max(icon_pixels_x) - min(icon_pixels_x) + 1 >= 200
    assert max(icon_pixels_y) - min(icon_pixels_y) + 1 >= 200


def test_frontend_relative_imports_resolve_to_files():
    js_root = PROJECT_ROOT / "backend/static/js"
    import_pattern = re.compile(
        r"(?:from\s+['\"](?P<static>[^'\"]+)['\"]|import\(\s*['\"](?P<dynamic>[^'\"]+)['\"]\s*\))"
    )

    missing = []
    for source_path in sorted(js_root.rglob("*.js")):
        source = source_path.read_text(encoding="utf-8")
        for match in import_pattern.finditer(source):
            import_path = match.group("static") or match.group("dynamic")
            if not import_path.startswith("."):
                continue

            import_file_path = import_path.split("?", 1)[0].split("#", 1)[0]
            resolved = (source_path.parent / import_file_path).resolve()
            candidates = [resolved]
            if resolved.suffix == "":
                candidates.append(resolved.with_suffix(".js"))

            if not any(candidate.is_file() for candidate in candidates):
                missing.append(f"{source_path.relative_to(PROJECT_ROOT)} -> {import_path}")

    assert missing == []


def test_app_surface_suppresses_context_menu_outside_editable_controls():
    source = (PROJECT_ROOT / "backend/static/js/main.js").read_text(encoding="utf-8")

    assert "setupContextMenuSuppression();" in source
    assert "function setupContextMenuSuppression()" in source
    assert "document.addEventListener('contextmenu'" in source
    assert ".hero-header, .hero-brand-logo, .hero-container" in source
    assert "event.preventDefault();" in source
    assert "target.closest('input, textarea, select, [contenteditable=\"true\"]')" in source
    assert "{ capture: true }" in source


def test_sidebar_does_not_expose_export_all_button():
    index_source = (PROJECT_ROOT / "backend/static/index.html").read_text(
        encoding="utf-8"
    )
    sidebar_source = (
        PROJECT_ROOT / "backend/static/js/modules/sidebar.js"
    ).read_text(encoding="utf-8")

    assert "export-all-btn" not in index_source
    assert "导出全部对话" not in index_source
    assert "export-all-btn" not in sidebar_source
    assert "/api/history/export/all" not in sidebar_source


def test_settings_history_reset_uses_history_renderer_cache_path():
    source = (PROJECT_ROOT / "backend/static/js/modules/settings-modal.js").read_text(
        encoding="utf-8"
    )

    assert "renderHistory" in source
    assert "renderHistory([], state.currentSessionId" in source
    assert "historyList.innerHTML = ''" not in source


def test_settings_system_panel_exposes_history_import_export_controls():
    index_source = (PROJECT_ROOT / "backend/static/index.html").read_text(
        encoding="utf-8"
    )
    settings_source = (
        PROJECT_ROOT / "backend/static/js/modules/settings-modal.js"
    ).read_text(encoding="utf-8")
    api_source = (
        PROJECT_ROOT / "backend/static/js/modules/api.js"
    ).read_text(encoding="utf-8")

    assert 'id="import-history-btn"' in index_source
    assert 'id="export-history-btn"' in index_source
    assert 'id="history-import-input"' in index_source
    assert "importHistoryAPI" in settings_source
    assert "exportHistoryAPI" in api_source
    assert "/api/history/import" in api_source
    assert "/api/history/export/all?format=json" in api_source


def test_settings_modal_closes_mobile_sidebar_before_opening():
    source = (PROJECT_ROOT / "backend/static/js/modules/settings-modal.js").read_text(
        encoding="utf-8"
    )

    open_settings_source = source.split(
        "const openSettings = async () => {", 1
    )[1].split("};", 1)[0]
    assert "const sidebar = document.getElementById('sidebar');" in open_settings_source
    assert "const mobileOverlay = document.getElementById('mobile-overlay');" in open_settings_source
    assert "sidebar.classList.remove('mobile-open');" in open_settings_source
    assert "mobileOverlay.classList.remove('active');" in open_settings_source


def test_settings_modal_uses_amc_inspired_layout_tokens():
    index_source = (PROJECT_ROOT / "backend/static/index.html").read_text(
        encoding="utf-8"
    )
    settings_css = (
        PROJECT_ROOT / "backend/static/css/sections/input-modal.css"
    ).read_text(encoding="utf-8")
    polish_css = (
        PROJECT_ROOT / "backend/static/css/sections/polish.css"
    ).read_text(encoding="utf-8")

    expected_markup_hooks = [
        "settings-modal-content amc-settings-modal",
        "settings-sidebar-close-btn",
        "settings-mobile-title",
        "settings-section-kicker",
        "settings-card",
        "settings-field-row",
        "settings-danger-zone",
    ]
    for hook in expected_markup_hooks:
        assert hook in index_source

    expected_style_tokens = [
        "--amc-modal-width",
        "--amc-sidebar-width",
        "background: var(--bg)",
        "width: var(--amc-sidebar-width)",
        "max-width: var(--amc-content-width)",
        ".settings-danger-zone",
        "@media (max-width: 760px)",
    ]
    for token in expected_style_tokens:
        assert token in settings_css

    assert "#settings-modal .settings-modal-content" in polish_css
    assert "width: 100vw;" in polish_css
    assert "border-radius: 0;" in polish_css


def test_settings_modal_has_amc_inspired_about_page():
    index_source = (PROJECT_ROOT / "backend/static/index.html").read_text(
        encoding="utf-8"
    )
    settings_css = (
        PROJECT_ROOT / "backend/static/css/sections/input-modal.css"
    ).read_text(encoding="utf-8")
    settings_js = (
        PROJECT_ROOT / "backend/static/js/modules/settings-modal.js"
    ).read_text(encoding="utf-8")

    expected_markup = [
        'data-tab="about"',
        'id="tab-about"',
        'class="about-hero"',
        'class="about-logo"',
        'id="about-version"',
        'class="about-version-pill"',
        'class="about-action-link github-primary"',
        'id="about-stars-count"',
        'class="about-meta-grid"',
    ]
    for hook in expected_markup:
        assert hook in index_source

    expected_styles = [
        ".about-hero",
        ".about-version-pill",
        ".about-action-row",
        ".about-meta-grid",
        ".about-action-link.github-primary",
    ]
    for token in expected_styles:
        assert token in settings_css

    assert "about-version" in settings_js
    assert "about-stars-count" in settings_js


def test_settings_modal_avoids_internal_divider_lines():
    settings_css = (
        PROJECT_ROOT / "backend/static/css/sections/input-modal.css"
    ).read_text(encoding="utf-8")

    assert "border-top: 1px solid var(--border);" not in settings_css
    assert "border-right: 1px solid var(--border);" not in settings_css
    assert "border-bottom: 1px solid var(--border);" not in settings_css
    assert "border-top: 1px solid color-mix(in srgb, var(--border) 70%, transparent);" not in settings_css
    assert "border-top: 1px solid rgba(255, 255, 255, 0.12);" not in settings_css
    assert "border-bottom: 1px solid rgba(255, 255, 255, 0.15);" not in settings_css


def test_provider_connection_test_shows_inline_loading_and_result():
    settings_js = (
        PROJECT_ROOT / "backend/static/js/modules/settings-modal.js"
    ).read_text(encoding="utf-8")
    polish_css = (
        PROJECT_ROOT / "backend/static/css/sections/polish.css"
    ).read_text(encoding="utf-8")

    assert "runProviderConnectionTest" in settings_js
    assert "testBtn.classList.add('is-testing')" in settings_js
    assert "testBtn.classList.remove('is-testing')" in settings_js
    assert "testBtn.disabled = true" in settings_js
    assert "testBtn.disabled = false" in settings_js
    assert "renderConnectionTestResult(resultEl," in settings_js
    assert "API 连接验证通过" not in settings_js
    assert "settings.connGemini25Unsupported" in settings_js
    assert "isUnsupportedGemini25Model" in settings_js
    assert "progress_activity" in settings_js
    assert ".provider-test-btn.is-testing" in polish_css
    assert ".provider-test-result.is-error" in polish_css
    assert ".provider-test-result.is-success" in polish_css


def test_provider_cards_are_collapsible_in_settings_modal():
    settings_js = (
        PROJECT_ROOT / "backend/static/js/modules/settings-modal.js"
    ).read_text(encoding="utf-8")
    settings_css = (
        PROJECT_ROOT / "backend/static/css/sections/input-modal.css"
    ).read_text(encoding="utf-8")

    assert "provider-collapse-btn" in settings_js
    assert "provider-card-body" in settings_js
    assert "aria-expanded" in settings_js
    assert "provider-card collapsed" in settings_js
    assert ".provider-card.collapsed .provider-card-body" in settings_css
    assert ".provider-collapse-btn" in settings_css


def test_provider_cards_show_status_badge_and_fold_model_list():
    settings_js = (
        PROJECT_ROOT / "backend/static/js/modules/settings-modal.js"
    ).read_text(encoding="utf-8")
    settings_css = (
        PROJECT_ROOT / "backend/static/css/sections/input-modal.css"
    ).read_text(encoding="utf-8")
    polish_css = (
        PROJECT_ROOT / "backend/static/css/sections/polish.css"
    ).read_text(encoding="utf-8")

    expected_js_tokens = [
        "provider-status-badge",
        "updateProviderBadge",
        "model-panel-toggle",
        "model-panel-summary",
        "setModelPanelCollapsed",
        "updateModelPanelSummary",
    ]
    for token in expected_js_tokens:
        assert token in settings_js

    expected_input_css_tokens = [
        ".model-panel-header",
        ".model-panel-toggle",
        ".model-panel-summary",
        ".model-settings-group.collapsed .model-list-container",
    ]
    for token in expected_input_css_tokens:
        assert token in settings_css

    assert ".provider-status-badge" in polish_css
    assert '.provider-status-badge[data-state="ready"]' in polish_css
    assert ".provider-status-badge[data-state=\"missing\"]" in polish_css


def test_api_settings_support_workflow_step_model_selection():
    index_source = (PROJECT_ROOT / "backend/static/index.html").read_text(
        encoding="utf-8"
    )
    settings_js = (
        PROJECT_ROOT / "backend/static/js/modules/settings-modal.js"
    ).read_text(encoding="utf-8")
    settings_css = (
        PROJECT_ROOT / "backend/static/css/sections/input-modal.css"
    ).read_text(encoding="utf-8")
    chat_source = (PROJECT_ROOT / "backend/app/routers/chat.py").read_text(
        encoding="utf-8"
    )
    workflow_source = (PROJECT_ROOT / "backend/app/workflow.py").read_text(
        encoding="utf-8"
    )

    assert 'id="workflow-step-models-container"' in index_source
    assert "workflow_step_models: collectWorkflowStepModels()" in settings_js
    assert "renderWorkflowStepModels" in settings_js
    assert "getConfiguredModelOptions" in settings_js
    assert ".workflow-step-model-row" in settings_css
    assert "_resolve_workflow_step_models" in chat_source
    assert "step_model_configs=workflow_step_models" in chat_source
    assert "self._llm_for_step(\"analysis\")" in workflow_source
    assert "self._llm_for_step(\"relevance\")" in workflow_source
    assert "self._llm_for_step(\"interaction\")" in workflow_source
    assert "self._llm_for_step(\"answer\")" in workflow_source


def test_settings_modal_auto_saves_without_manual_buttons():
    index_source = (PROJECT_ROOT / "backend/static/index.html").read_text(
        encoding="utf-8"
    )
    settings_js = (
        PROJECT_ROOT / "backend/static/js/modules/settings-modal.js"
    ).read_text(encoding="utf-8")
    chat_js = (
        PROJECT_ROOT / "backend/static/js/modules/chat.js"
    ).read_text(encoding="utf-8")

    assert 'id="save-settings-btn"' not in index_source
    assert 'id="cancel-settings-btn"' not in index_source
    assert "saveSettingsBtn" not in settings_js
    assert "cancelSettingsBtn" not in settings_js
    assert "requestSettingsAutoSave" in settings_js
    assert "flushSettingsAutoSave" in settings_js
    assert "canAutoSaveSettings" in settings_js
    assert "rememberCurrentSettingsPayload" in settings_js
    assert "await API.fetchSettings();" in settings_js
    assert "const closeSettingsModal = async () => {" in settings_js
    assert "API.saveSettingsAPI(newSettings)" in settings_js
    assert "radio.addEventListener('change', () => {" in settings_js
    assert "requestSettingsAutoSave({ immediate: true });" in settings_js
    assert "row.querySelector('select').addEventListener('change'" in settings_js
    assert "设置已保存" not in settings_js
    assert "'保存设置失败'" not in settings_js
    assert "settings.saveFailed" in settings_js
    assert "后保存" not in chat_js


def test_api_settings_panel_preserves_provider_state_during_auto_save():
    settings_js = (
        PROJECT_ROOT / "backend/static/js/modules/settings-modal.js"
    ).read_text(encoding="utf-8")

    assert "function resolveProviderDefaultId" in settings_js
    assert "getSelectedDefaultProviderId()" in settings_js
    assert "getProviderCollapseStates" in settings_js
    assert "preserveCollapsed: true" in settings_js
    assert "expandedProviderId: newProvider.id" in settings_js
    assert "function createProviderCard(provider, logo, defaultProviderId, index, options = {})" in settings_js
    assert "serialize({ save = true } = {})" in settings_js
    assert "requestSettingsAutoSave();" in settings_js
    assert "serialize({ save: false })" in settings_js
    assert "card.dataset.savedProviderId" in settings_js
    assert "previous_id: card.dataset.savedProviderId || providerId" in settings_js
    assert "previous_provider_id: providerCard.dataset.savedProviderId || providerId" in settings_js
    assert "markSavedProviderIdentities();" in settings_js
    assert "providerIdMap" in settings_js


def test_settings_modal_has_search_engine_availability_check():
    index_source = (PROJECT_ROOT / "backend/static/index.html").read_text(
        encoding="utf-8"
    )
    settings_js = (
        PROJECT_ROOT / "backend/static/js/modules/settings-modal.js"
    ).read_text(encoding="utf-8")
    api_js = (PROJECT_ROOT / "backend/static/js/modules/api.js").read_text(
        encoding="utf-8"
    )
    settings_css = (
        PROJECT_ROOT / "backend/static/css/sections/input-modal.css"
    ).read_text(encoding="utf-8")

    assert 'id="check-engines-btn"' in index_source
    assert 'id="engine-check-results"' in index_source
    assert 'export async function checkEnginesAPI' in api_js
    assert "API.checkEnginesAPI" in settings_js
    assert "checkEnginesBtn.disabled = true" in settings_js
    assert "checkEnginesBtn.disabled = false" in settings_js
    assert "renderEngineCheckResults" in settings_js
    assert ".engine-check-results" in settings_css
    assert ".engine-check-result.available" in settings_css
    assert ".engine-check-result.unavailable" in settings_css


def test_docker_compose_does_not_include_searxng():
    compose_source = (PROJECT_ROOT / "docker-compose.yml").read_text(
        encoding="utf-8"
    )

    assert "searxng" not in compose_source.lower()
    assert "SEARXNG" not in compose_source
    assert "justsearch:" in compose_source or "container_name: justsearch" in compose_source


def test_runtime_security_defaults_are_not_wide_open():
    env_example = (PROJECT_ROOT / ".env.example").read_text(encoding="utf-8")
    compose_source = (PROJECT_ROOT / "docker-compose.yml").read_text(
        encoding="utf-8"
    )
    main_source = (PROJECT_ROOT / "backend/app/main.py").read_text(
        encoding="utf-8"
    )

    # Host HTTP is mapped to 8001 (container still listens on 8000).
    local_origins = (
        "http://localhost:8001,http://127.0.0.1:8001,"
        "http://localhost,http://127.0.0.1"
    )
    assert f"CORS_ORIGINS={local_origins}" in env_example
    assert f"CORS_ORIGINS=${{CORS_ORIGINS:-{local_origins}}}" in compose_source
    assert '"127.0.0.1:8001:8000"' in compose_source
    assert '"8000:8000"' not in compose_source
    assert '"0.0.0.0:8001:8000"' not in compose_source
    assert "JUSTSEARCH_AUTH_ENABLED=true" in env_example
    assert "JUSTSEARCH_AUTH_ENABLED=${JUSTSEARCH_AUTH_ENABLED:-true}" in compose_source
    assert 'load_dotenv(os.path.join(_PROJECT_ROOT, ".env"))' in main_source


def test_default_search_engine_is_google_across_app():
    database_source = (PROJECT_ROOT / "backend/app/database.py").read_text(
        encoding="utf-8"
    )
    settings_example = (
        PROJECT_ROOT / "backend/settings.json.example"
    ).read_text(encoding="utf-8")
    chat_source = (
        PROJECT_ROOT / "backend/static/js/modules/chat.js"
    ).read_text(encoding="utf-8")
    settings_source = (
        PROJECT_ROOT / "backend/static/js/modules/settings-modal.js"
    ).read_text(encoding="utf-8")

    assert '"search_engine": "google"' in database_source
    assert '"search_engine": "google"' in settings_example
    assert "state.settings.search_engine || 'google'" in chat_source
    assert "settings.search_engine || 'google'" in settings_source


def test_default_max_search_results_is_fifty_across_app():
    database_source = (PROJECT_ROOT / "backend/app/database.py").read_text(
        encoding="utf-8"
    )
    chat_source = (PROJECT_ROOT / "backend/app/routers/chat.py").read_text(
        encoding="utf-8"
    )
    settings_source = (PROJECT_ROOT / "backend/app/routers/settings.py").read_text(
        encoding="utf-8"
    )
    browser_manager_source = (PROJECT_ROOT / "backend/app/browser_manager.py").read_text(
        encoding="utf-8"
    )
    workflow_source = (PROJECT_ROOT / "backend/app/workflow.py").read_text(
        encoding="utf-8"
    )
    settings_js = (
        PROJECT_ROOT / "backend/static/js/modules/settings-modal.js"
    ).read_text(encoding="utf-8")
    index_source = (PROJECT_ROOT / "backend/static/index.html").read_text(
        encoding="utf-8"
    )
    settings_example = (PROJECT_ROOT / "backend/settings.json.example").read_text(
        encoding="utf-8"
    )

    assert '"max_results": "50"' in database_source
    assert "max_results: Optional[int] = None" in chat_source
    assert 'defaults.get("max_results", 50)' in chat_source
    assert "max_results: Optional[int] = 50" in settings_source
    assert 'min(50, int(update["max_results"]))' in settings_source
    assert 'max_results: int = 50' in browser_manager_source
    assert 'max_results: int = 50' in workflow_source
    assert "normalizeNumberSetting(settings.max_results, 50, 1, 50)" in settings_js
    assert "normalizeNumberSetting(settings.max_iterations, 5, 1, 10)" in settings_js
    assert "max_results: normalizeNumberSetting(document.getElementById('max-results-input').value, 50, 1, 50)" in settings_js
    assert "max_iterations: normalizeNumberSetting(document.getElementById('max-iterations-input').value, 5, 1, 10)" in settings_js
    assert 'id="max-results-input" placeholder="50" min="1" max="50"' in index_source
    assert '"max_results": 50' in settings_example


def test_llm_requests_apply_bounded_context_budgets():
    llm_source = (PROJECT_ROOT / "backend/app/llm_client.py").read_text(
        encoding="utf-8"
    )
    crawler_source = (PROJECT_ROOT / "backend/app/crawler/content.py").read_text(
        encoding="utf-8"
    )
    chat_source = (PROJECT_ROOT / "backend/app/routers/chat.py").read_text(
        encoding="utf-8"
    )
    settings_source = (PROJECT_ROOT / "backend/app/routers/settings.py").read_text(
        encoding="utf-8"
    )
    workflow_source = (PROJECT_ROOT / "backend/app/workflow.py").read_text(
        encoding="utf-8"
    )
    settings_js = (
        PROJECT_ROOT / "backend/static/js/modules/settings-modal.js"
    ).read_text(encoding="utf-8")
    index_source = (PROJECT_ROOT / "backend/static/index.html").read_text(
        encoding="utf-8"
    )
    settings_example = (PROJECT_ROOT / "backend/settings.json.example").read_text(
        encoding="utf-8"
    )

    # New: a bounded prompt-source budget and a bounded history budget must
    # exist and be wired into the generation/context paths.
    assert "_PROMPT_SOURCE_CHAR_BUDGET" in llm_source
    assert "_budget_sources_for_prompt" in llm_source
    assert "_HISTORY_CHAR_BUDGET" in llm_source
    assert "（节选）" in llm_source
    # The bounded budgets are configurable from settings/UI.
    assert "history_window" in settings_source
    assert "history_char_budget" in settings_source
    assert "assistant_turn_char_budget" in settings_source
    assert "history-window-input" in index_source
    assert "history-char-budget-input" in index_source
    assert "assistant-turn-char-budget-input" in index_source
    assert "history_window" in settings_js
    assert "history_char_budget" in settings_js
    assert "assistant_turn_char_budget" in settings_js
    assert "history_options" in workflow_source

    # Legacy red lines stay: the old coarse-grained implementations must not
    # come back.
    assert "_smart_truncate" not in llm_source
    assert "chars_per_source" not in llm_source
    assert "elements[:50]" not in llm_source
    assert "el['text'][:100]" not in llm_source
    assert "max_context_turns" not in llm_source
    assert "_truncate_for_log(query)" not in llm_source
    # ``history[-`` is a hygiene red line; the codebase must use
    # ``list(history)[-N:]`` (which does not contain the banned substring).
    assert "history[-" not in llm_source
    # Crawler domain keeps its own separate cap naming; do not reuse the
    # llm-side budget name there.
    assert "_MAX_CONTENT_LENGTH" not in crawler_source
    assert "内容过长" not in crawler_source
    assert "内容已截取" not in llm_source
    assert "答案已截断" not in llm_source
    assert "max_context_turns" not in chat_source
    assert "max_context_turns" not in settings_source
    assert "max_context_turns" not in workflow_source
    assert "max-context-turns-input" not in settings_js
    assert "max-context-turns-input" not in index_source
    assert "max_context_turns" not in settings_example


def test_progress_summary_does_not_show_token_usage():
    chat_source = (
        PROJECT_ROOT / "backend/static/js/modules/chat.js"
    ).read_text(encoding="utf-8")

    assert "prompt_tokens" not in chat_source
    assert "completion_tokens" not in chat_source
    assert "tokens`" not in chat_source


def test_input_area_has_no_character_counter():
    index_source = (PROJECT_ROOT / "backend/static/index.html").read_text(
        encoding="utf-8"
    )
    chat_source = (
        PROJECT_ROOT / "backend/static/js/modules/chat.js"
    ).read_text(encoding="utf-8")
    css_source = "\n".join(
        path.read_text(encoding="utf-8")
        for path in sorted((PROJECT_ROOT / "backend/static/css").rglob("*.css"))
    )

    assert "char-count" not in index_source
    assert "charCount" not in chat_source
    assert "Update character count" not in chat_source
    assert ".char-count" not in css_source


def test_frontend_typography_avoids_fuzzy_text_rendering():
    css_sources = {
        path.relative_to(PROJECT_ROOT).as_posix(): path.read_text(encoding="utf-8")
        for path in sorted((PROJECT_ROOT / "backend/static/css").rglob("*.css"))
    }
    css_source = "\n".join(css_sources.values())

    assert "-webkit-font-smoothing: antialiased" not in css_source
    assert "-moz-osx-font-smoothing: grayscale" not in css_source

    negative_letter_spacing = []
    for filename, source in css_sources.items():
        for match in re.finditer(r"letter-spacing\s*:\s*-[^;]+;", source):
            negative_letter_spacing.append(f"{filename}: {match.group(0)}")

    assert negative_letter_spacing == []


def test_initial_release_version_uses_semver_and_v_display_prefix():
    version_source = (PROJECT_ROOT / "backend/app/version.py").read_text(encoding="utf-8")
    dockerfile_source = (PROJECT_ROOT / "Dockerfile").read_text(encoding="utf-8")
    settings_js = (
        PROJECT_ROOT / "backend/static/js/modules/settings-modal.js"
    ).read_text(encoding="utf-8")

    version_match = re.search(r'__version__\s*=\s*"(\d+\.\d+\.\d+)"', version_source)
    assert version_match is not None, "version.py must define a semver __version__"
    semver = version_match.group(1)
    assert f'org.opencontainers.image.version="{semver}"' in dockerfile_source
    assert "formatVersionText" in settings_js
    assert "`v${rawVersion}`" in settings_js


def test_confirm_dialog_resolves_when_dismissed_without_buttons():
    source = (PROJECT_ROOT / "backend/static/js/modules/ui.js").read_text(encoding="utf-8")
    show_confirm = source.split("export function showConfirm", 1)[1].split(
        "export const elements", 1
    )[0]

    assert "function onKeyDown" in show_confirm
    assert "event.key === 'Escape'" in show_confirm
    assert "document.addEventListener('keydown', onKeyDown)" in show_confirm
    assert "modal.addEventListener('click', onBackdropClick)" in show_confirm
    assert "document.removeEventListener('keydown', onKeyDown)" in show_confirm
    assert "modal.removeEventListener('click', onBackdropClick)" in show_confirm


def test_source_rendering_helpers_are_split_from_ui_module():
    source_renderer_path = PROJECT_ROOT / "backend/static/js/modules/source-renderer.js"
    ui_path = PROJECT_ROOT / "backend/static/js/modules/ui.js"
    chat_path = PROJECT_ROOT / "backend/static/js/modules/chat.js"

    assert source_renderer_path.is_file()

    renderer_source = source_renderer_path.read_text(encoding="utf-8")
    ui_source = ui_path.read_text(encoding="utf-8")
    chat_source = chat_path.read_text(encoding="utf-8")

    assert "export function extractSources" in renderer_source
    assert "export function normalizeCitationSources" in renderer_source
    assert "export function hasCitationSources" in renderer_source
    assert "export function linkCitationsInElement" in renderer_source
    assert "export function renderWithCitations" in renderer_source
    assert "function getFaviconUrl" in renderer_source
    assert "hasCitationSources" in ui_source
    assert "normalizeCitationSources" in ui_source
    assert "hasCitationSources" in chat_source
    assert "from './source-renderer.js?v=12'" in ui_source
    assert "from './source-renderer.js?v=12'" in chat_source
    assert "from './ui.js?v=40'" in (
        PROJECT_ROOT / "backend/static/js/modules/history-view.js"
    ).read_text(encoding="utf-8")
    assert "from './ui.js?v=40'" in (
        PROJECT_ROOT / "backend/static/js/modules/settings-modal.js"
    ).read_text(encoding="utf-8")
    assert "from './ui.js?v=40'" in (
        PROJECT_ROOT / "backend/static/js/modules/sidebar.js"
    ).read_text(encoding="utf-8")
    assert "export function extractSources" not in ui_source
    assert "function hasCitationSources" not in ui_source
    assert "function hasCitationSources" not in chat_source
    assert "export function renderWithCitations" not in ui_source
    assert "function getFaviconUrl" not in ui_source


def test_css_is_split_into_named_sections():
    css_dir = PROJECT_ROOT / "backend/static/css"
    sections_dir = css_dir / "sections"
    style_source = (css_dir / "style.css").read_text(encoding="utf-8")
    expected_sections = [
        "base.css",
        "sidebar.css",
        "chat.css",
        "input-modal.css",
        "markdown.css",
        "live-artifacts.css",
        "overlays.css",
        "responsive.css",
        "polish.css",
    ]

    for filename in expected_sections:
        assert (sections_dir / filename).is_file()
        # style.css 是各分片按序拼接的产物：每个分片以 inlined 标记开头
        assert f"=== {filename} (inlined) ===" in style_source

    # 拼接后应有实质内容
    assert len(style_source.splitlines()) > 100


def test_sidebar_stylesheet_changes_are_cache_busted():
    index_source = (PROJECT_ROOT / "backend/static/index.html").read_text(
        encoding="utf-8"
    )
    style_source = (
        PROJECT_ROOT / "backend/static/css/style.css"
    ).read_text(encoding="utf-8")
    main_source = (
        PROJECT_ROOT / "backend/static/js/main.js"
    ).read_text(encoding="utf-8")

    # style.css 现为各分片拼接（不再用 @import）；index.html 引用带缓存版本号的单文件
    assert 'href="/static/css/style.css?v=50"' in index_source
    assert 'src="/static/js/main.js?v=85"' in index_source
    assert "=== base.css (inlined) ===" in style_source
    assert "=== sidebar.css (inlined) ===" in style_source
    assert "=== chat.css (inlined) ===" in style_source
    assert "=== input-modal.css (inlined) ===" in style_source
    assert "=== markdown.css (inlined) ===" in style_source
    assert "=== live-artifacts.css (inlined) ===" in style_source
    assert "=== responsive.css (inlined) ===" in style_source
    assert "=== polish.css (inlined) ===" in style_source
    assert "edit-message-banner" in style_source
    assert "from './modules/auth.js?v=1'" in main_source
    assert "from './modules/state.js?v=5'" in main_source
    assert "from './modules/ui.js?v=40'" in main_source
    assert "from './modules/chat.js?v=52'" in main_source
    assert "from './modules/history-view.js?v=25'" in main_source
    assert "from './modules/settings-modal.js?v=56'" in main_source
    assert "from './modules/sidebar.js?v=21'" in main_source
    assert "from './modules/model-selector.js?v=16'" in main_source
    assert "from './modules/api.js?v=14'" in main_source
    assert "import('./modules/utils.js?v=13')" in main_source
    assert "search-intensity.js?v=3" in (PROJECT_ROOT / "backend/static/js/modules/chat.js").read_text(encoding="utf-8")
    assert "from './modules/shortcuts-help.js?v=2'" in main_source
    assert "from './modules/provider-catalog.js?v=2'" in main_source
    assert "from './completion-feedback.js?v=1'" in (PROJECT_ROOT / "backend/static/js/modules/chat.js").read_text(encoding="utf-8")
    assert 'id="shortcuts-help-modal"' in index_source
    assert 'id="model-manager-modal"' in index_source
    assert 'id="completion-notification-input"' in index_source
    assert 'id="completion-sound-input"' in index_source
    assert 'id="search-intensity-bar"' in index_source
    assert "loadSelectedModelPreference" in main_source
    assert "findOptionForModelPreference" in main_source
    assert "SELECTED_MODEL_STORAGE_KEY" in (PROJECT_ROOT / "backend/static/js/modules/model-selector.js").read_text(encoding="utf-8")


def test_module_version_strings_consistent_across_references():
    """Same module must be referenced with the same ?v= version everywhere.

    Browsers treat module URLs differing only by query string as separate module
    instances — each with its own private module-level state — and cache them
    independently. A per-file bump that misses one importer silently forks the
    module (and lets users run a mixed old/new build), so this asserts
    consistency instead of hardcoding per-module versions.
    """
    modules_dir = PROJECT_ROOT / "backend/static/js/modules"
    version_re = re.compile(
        r"(?:from|import)\s*\(?\s*['\"]\./modules/([A-Za-z0-9_\-]+\.js)\?v=(\d+)['\"]"
    )
    module_versions: dict[str, set[str]] = {}
    js_dir = PROJECT_ROOT / "backend/static/js"
    for path in [js_dir / "main.js", *modules_dir.glob("*.js")]:
        src = path.read_text(encoding="utf-8")
        for module, version in version_re.findall(src):
            module_versions.setdefault(module, set()).add(version)

    assert module_versions, "no versioned module references found"
    for module, versions in sorted(module_versions.items()):
        assert len(versions) == 1, (
            f"module {module} referenced with inconsistent versions {sorted(versions)}; "
            "browsers load each ?v= as a separate module instance — unify the version string"
        )


def test_auth_token_persists_with_data_volume_and_401_recovers():
    auth_py = (PROJECT_ROOT / "backend/app/auth.py").read_text(encoding="utf-8")
    auth_js = (
        PROJECT_ROOT / "backend/static/js/modules/auth.js"
    ).read_text(encoding="utf-8")

    assert '_TOKEN_FILE_ENV_VAR = "JUSTSEARCH_AUTH_TOKEN_FILE"' in auth_py
    assert 'return _DATA_DIR / ".auth_token"' in auth_py
    assert "def get_legacy_auth_token_path" in auth_py
    assert "_migrate_legacy_auth_token(token_path)" in auth_py
    assert "AUTH_RETRY_KEY = 'justsearch_auth_retry'" in auth_js
    assert "clearStoredAuthToken(win)" in auth_js
    assert "win.location.reload()" in auth_js
    assert "handleUnauthorizedResponse(response)" in auth_js


def test_live_artifacts_are_integrated_with_chat_rendering():
    style_source = (
        PROJECT_ROOT / "backend/static/css/style.css"
    ).read_text(encoding="utf-8")
    live_artifacts_js = (
        PROJECT_ROOT / "backend/static/js/modules/live-artifacts.js"
    ).read_text(encoding="utf-8")
    chat_source = (
        PROJECT_ROOT / "backend/static/js/modules/chat.js"
    ).read_text(encoding="utf-8")
    ui_source = (
        PROJECT_ROOT / "backend/static/js/modules/ui.js"
    ).read_text(encoding="utf-8")

    assert "=== live-artifacts.css (inlined) ===" in style_source
    assert "export function renderLiveArtifactsForMessage" in live_artifacts_js
    assert "function extractLiveArtifacts" in live_artifacts_js
    assert "function extractRawHtmlArtifacts" in live_artifacts_js
    assert "function extractInlineLiveArtifact" in live_artifacts_js
    assert "function extractLiveArtifactInteraction" in live_artifacts_js
    assert "function parseLiveArtifactInteractionSpec" in live_artifacts_js
    assert "function renderLiveArtifactInteraction" in live_artifacts_js
    assert "function renderInlineArtifactFrame" in live_artifacts_js
    assert "data-amc-stream-preview-root" in live_artifacts_js
    assert "STREAM_RENDER_EVENT" in live_artifacts_js
    assert "function postInlineArtifactStream" in live_artifacts_js
    assert "sanitizeStreamDocument" in live_artifacts_js
    assert "Content-Security-Policy" in live_artifacts_js
    assert "PREVIEW_CONTENT_SECURITY_POLICY" in live_artifacts_js
    assert "frame-src 'none'" in live_artifacts_js
    assert "form-action 'none'" in live_artifacts_js
    assert "function injectPreviewSecurityPolicy" in live_artifacts_js
    assert "function injectPreviewBaseFontSize" in live_artifacts_js
    assert "function injectPreviewTheme" in live_artifacts_js
    assert "export function refreshLiveArtifactFontSizes" in live_artifacts_js
    assert "export function refreshLiveArtifactPreviews" in live_artifacts_js
    assert "--amc-live-artifact-font-size" in live_artifacts_js
    assert "data-amc-live-artifact-theme" in live_artifacts_js
    assert "--amc-live-artifact-text" in live_artifacts_js
    assert "--amc-live-artifact-surface" in live_artifacts_js
    assert "--amc-live-artifact-accent" in live_artifacts_js
    assert "event: 'diagnostic'" in live_artifacts_js
    assert "resource-error" in live_artifacts_js
    assert "runtime-error" in live_artifacts_js
    assert "csp-violation" in live_artifacts_js
    assert "function normalizePreviewDiagnostic" in live_artifacts_js
    assert "amc-live-artifact-interaction" in live_artifacts_js
    assert "dataset.liveArtifactInteraction" in live_artifacts_js
    assert "amc-live-artifact-interaction:v1" in live_artifacts_js
    assert "function buildArtifactCode" in live_artifacts_js
    assert "function hideSupportingCodeBlocks" in live_artifacts_js
    assert "function shouldMergeSupportingBlocks" in live_artifacts_js
    assert "parseInfoAttributes" in live_artifacts_js
    assert "__liveArtifactsTestHooks" in live_artifacts_js
    assert "live-artifacts-frame" in live_artifacts_js
    assert "data-artifact-view=\"code\"" in live_artifacts_js
    assert "sandbox=\"allow-scripts allow-forms allow-modals allow-popups\"" in live_artifacts_js
    assert "sourceLink.tagName === 'A'" in live_artifacts_js
    assert "renderLiveArtifactsForMessage(contentWrapper" in chat_source
    assert "function renderCurrentAssistantAnswer(isStreaming)" in chat_source
    assert "renderCurrentAssistantAnswer(true)" in chat_source
    assert "renderLiveArtifactsForMessage(answerBody" in ui_source


def test_thinking_box_uses_amc_style_spinner():
    chat_css = (
        PROJECT_ROOT / "backend/static/css/sections/chat.css"
    ).read_text(encoding="utf-8")
    ui_js = (
        PROJECT_ROOT / "backend/static/js/modules/ui.js"
    ).read_text(encoding="utf-8")

    assert ".log-spinner.rotating::before" in chat_css
    assert ".log-spinner.rotating::after" not in chat_css
    assert ".material-symbols-rounded.log-spinner" in chat_css
    assert "position: absolute;" in chat_css
    assert "inset: 2px;" in chat_css
    assert "display: block;" in chat_css
    assert "conic-gradient" in chat_css
    for accent in ("#00d1ff", "#6978ff", "#b15cff", "#ff5ab3", "#ff8a3d", "#ffd166"):
        assert accent in chat_css
    assert "@keyframes amcThinkingSpin" in chat_css
    assert "@keyframes amcThinkingDot" not in chat_css
    assert "@keyframes amcThoughtSweep" in chat_css
    assert "animation: none;" in chat_css
    assert "ui.thinking" in ui_js


def test_message_bubbles_follow_amc_visual_pattern():
    base_css = (
        PROJECT_ROOT / "backend/static/css/sections/base.css"
    ).read_text(encoding="utf-8")
    chat_css = (
        PROJECT_ROOT / "backend/static/css/sections/chat.css"
    ).read_text(encoding="utf-8")
    markdown_css = (
        PROJECT_ROOT / "backend/static/css/sections/markdown.css"
    ).read_text(encoding="utf-8")
    input_modal_css = (
        PROJECT_ROOT / "backend/static/css/sections/input-modal.css"
    ).read_text(encoding="utf-8")

    # Canonical AMC palette tokens (Pearl light / Onyx dark) backing the
    # message bubbles. The user bubble is a neutral tint, never the accent.
    for token in [
        "--theme-bg-user-message: #eef0f5;",  # Pearl user bubble (neutral)
        "--theme-user-message-text: #1a1a1f;",
        "--theme-bg-model-message: #fefefe;",  # Pearl model message
        "--theme-bg-code-block: #f6f7f9;",
        "--theme-bg-user-message: #202028;",  # Onyx user bubble (neutral, not accent blue)
        "--theme-user-message-text: #f5f5f7;",
        "--theme-bg-model-message: transparent;",  # Onyx model message
        "--theme-bg-code-block: #141418;",
    ]:
        assert token in base_css

    # Message bubbles read their colors through the AMC-style aliases.
    for token in [
        "--amc-message-user-bg: var(--theme-bg-user-message);",
        "--amc-message-user-text: var(--theme-user-message-text);",
        "--amc-message-model-bg: var(--theme-bg-model-message);",
        "--amc-message-code-bg: var(--theme-bg-code-block);",
    ]:
        assert token in base_css

    for token in [
        "max-width: 1056px;",
        "margin-top: 24px;",
        ".message.grouped",
        "margin-top: 6px;",
        ".message-row",
        ".message-side",
        ".message-avatar",
        ".assistant-avatar",
        ".user-avatar",
        ".error-avatar",
        "background: var(--amc-message-user-bg);",
        "padding: 16px 20px;",
        "border-top-right-radius: 4px;",
        "max-width: 80%;",
        "background-color: var(--amc-message-model-bg);",
        "max-width: calc(100% - 56px);",
        ".message-answer-body",
        ".message-content.is-collapsible.is-collapsed .message-user-text",
        ".message-collapse-toggle",
        ".message-action-rail",
        "position: static;",
        ".edit-message-btn",
        "opacity: 0;",
        "pointer-events: none;",
        ".message:hover .message-action-rail",
        ".message:focus-within .message-action-rail",
    ]:
        assert token in chat_css

    assert ".message.assistant .message-action-rail" not in chat_css
    assert ".message.user .message-action-rail" not in chat_css
    assert "background: linear-gradient(135deg, var(--primary), var(--primary-hover))" not in chat_css
    assert "/* --- Regenerate Button --- */" not in input_modal_css
    assert ".message-content:hover .msg-delete-btn" not in input_modal_css
    assert "background-color: var(--amc-message-code-bg);" in markdown_css
    assert "border-left: 3px solid currentColor;" in markdown_css


def test_composer_extras_follow_amc_pattern():
    """Suggestion chips, slash-command menu and generation status pill exist and
    are wired from chat.js (AMC ChatSuggestions / SlashCommandMenu /
    LiveStatusBanner equivalents)."""
    index_source = (
        PROJECT_ROOT / "backend/static/index.html"
    ).read_text(encoding="utf-8")
    chat_source = (
        PROJECT_ROOT / "backend/static/js/modules/chat.js"
    ).read_text(encoding="utf-8")
    extras_source = (
        PROJECT_ROOT / "backend/static/js/modules/composer-extras.js"
    ).read_text(encoding="utf-8")

    assert 'id="suggestion-chips"' in index_source
    assert 'id="suggestion-chips-track"' in index_source
    assert 'id="slash-command-menu"' in index_source
    assert 'id="generation-status"' in index_source
    assert 'id="generation-status-stop"' in index_source
    assert "from './composer-extras.js?v=2'" in chat_source
    assert "export const SUGGESTIONS" in extras_source
    assert "export const SLASH_COMMANDS" in extras_source
    assert "export function setupComposerExtras" in extras_source


def test_message_area_extras_follow_amc_pattern():
    """Text-selection toolbar, ↑/↓ scroll navigation and per-message markdown
    export mirror AMC's TextSelectionToolbar / ScrollNavigation / Export."""
    index_source = (
        PROJECT_ROOT / "backend/static/index.html"
    ).read_text(encoding="utf-8")
    chat_source = (
        PROJECT_ROOT / "backend/static/js/modules/chat.js"
    ).read_text(encoding="utf-8")
    ui_source = (
        PROJECT_ROOT / "backend/static/js/modules/ui.js"
    ).read_text(encoding="utf-8")
    utils_source = (
        PROJECT_ROOT / "backend/static/js/modules/utils.js"
    ).read_text(encoding="utf-8")
    selection_source = (
        PROJECT_ROOT / "backend/static/js/modules/text-selection.js"
    ).read_text(encoding="utf-8")

    assert 'id="text-selection-toolbar"' in index_source
    assert 'id="scroll-to-top-btn"' in index_source
    assert 'id="scroll-to-bottom-btn"' in index_source
    assert "setupTextSelectionToolbar" in chat_source
    assert "from './text-selection.js?v=1'" in chat_source
    assert "export function setupTextSelectionToolbar" in selection_source
    assert "createExportMessageButton" in ui_source
    assert "export function createExportMessageButton" in utils_source
    assert "scrollToTopBtn" in ui_source


def test_settings_search_follows_amc_pattern():
    index_source = (
        PROJECT_ROOT / "backend/static/index.html"
    ).read_text(encoding="utf-8")
    settings_source = (
        PROJECT_ROOT / "backend/static/js/modules/settings-modal.js"
    ).read_text(encoding="utf-8")
    search_source = (
        PROJECT_ROOT / "backend/static/js/modules/settings-search.js"
    ).read_text(encoding="utf-8")

    assert 'id="settings-search-input"' in index_source
    assert 'id="settings-search-results"' in index_source
    assert "from './settings-search.js?v=2'" in settings_source
    assert "export function setupSettingsSearch" in search_source


def test_message_side_actions_follow_amc_interaction_pattern():
    utils_source = (
        PROJECT_ROOT / "backend/static/js/modules/utils.js"
    ).read_text(encoding="utf-8")
    ui_source = (
        PROJECT_ROOT / "backend/static/js/modules/ui.js"
    ).read_text(encoding="utf-8")
    chat_source = (
        PROJECT_ROOT / "backend/static/js/modules/chat.js"
    ).read_text(encoding="utf-8")
    source_renderer = (
        PROJECT_ROOT / "backend/static/js/modules/source-renderer.js"
    ).read_text(encoding="utf-8")
    responsive_css = (
        PROJECT_ROOT / "backend/static/css/sections/responsive.css"
    ).read_text(encoding="utf-8")

    for token in [
        "export function createMessageActionRail",
        "role', 'toolbar'",
        "dataset.action",
        "copy-message",
        "edit-message",
        "regenerate-message",
        "delete-message",
        "is-success",
    ]:
        assert token in utils_source

    for token in [
        "export function createMessageShell",
        "normalizeMessageRole",
        "MESSAGE_GROUP_WINDOW_MS",
        "isGroupedWithPrevious",
        "createMessageAvatar",
        "message-row",
        "message-side",
        "message-avatar",
        "is-collapsible",
        "message-collapse-toggle",
        "message-answer-body",
        "sideColumn.appendChild(createMessageActions",
        "previousUserContent",
        "createEditMessageButton",
        "createRegenerateButton",
        "createDeleteMessageButton",
        "onRegenerate",
        "onEdit",
        "onMessageDeleted",
    ]:
        assert token in ui_source

    assert "createMessageActionRail([copyBtn, regenBtn], t('ui.assistantActions'))" in chat_source
    assert "createMessageShell('assistant')" in chat_source
    assert "contentWrapper.className = 'message-answer-body'" in chat_source
    assert "sideColumn.appendChild(createMessageActionRail" in chat_source
    # AMC-style edit/resend: composer staging + truncate-from-index resend
    assert "beginEditMessage" in chat_source
    assert "truncateFromIndex" in chat_source
    assert "setEditingMessage" in chat_source
    assert "clearEditingMessage" in chat_source
    assert "previousUserIndex" in ui_source
    assert "edit-message-banner" in (
        PROJECT_ROOT / "backend/static/index.html"
    ).read_text(encoding="utf-8")
    assert "from './utils.js?v=13'" in chat_source
    assert "from './utils.js?v=13'" in ui_source
    assert "from './utils.js?v=13'" in source_renderer
    assert ".message-row" in responsive_css
    assert ".message-side" in responsive_css
    assert ".message-avatar" in responsive_css
    assert ".message.user .message-content" in responsive_css
    assert ".message.assistant .message-content," in responsive_css
    assert ".message-action-rail" in responsive_css
    assert "opacity: 1;" in responsive_css
    assert "pointer-events: auto;" in responsive_css
    assert ".message.assistant .message-action-rail" not in responsive_css
    assert ".message.user .message-action-rail" not in responsive_css


def test_history_rename_updates_cached_history_source():
    source = (PROJECT_ROOT / "backend/static/js/modules/history-view.js").read_text(
        encoding="utf-8"
    )

    assert "function updateCachedHistoryTitle" in source
    assert "updateCachedHistoryTitle(chatId, newTitle)" in source


def test_history_empty_state_uses_dom_helper_instead_of_html_strings():
    source = (PROJECT_ROOT / "backend/static/js/modules/history-view.js").read_text(
        encoding="utf-8"
    )
    css = "\n".join(
        path.read_text(encoding="utf-8")
        for path in sorted((PROJECT_ROOT / "backend/static/css").rglob("*.css"))
    )

    assert "function renderEmptyHistory" in source
    assert "icon.setAttribute('aria-hidden', 'true')" in source
    assert ".history-no-results .history-no-results-icon" in css
    assert "history-no-results\"><span" not in source
    assert "style=\"font-size" not in source


def test_sidebar_history_groups_have_frontend_controls():
    index_source = (PROJECT_ROOT / "backend/static/index.html").read_text(
        encoding="utf-8"
    )
    history_source = (
        PROJECT_ROOT / "backend/static/js/modules/history-view.js"
    ).read_text(encoding="utf-8")
    api_source = (PROJECT_ROOT / "backend/static/js/modules/api.js").read_text(
        encoding="utf-8"
    )
    sidebar_css = (
        PROJECT_ROOT / "backend/static/css/sections/sidebar.css"
    ).read_text(encoding="utf-8")

    assert 'id="new-group-btn"' in index_source
    assert "fetchChatGroups" in api_source
    assert "createChatGroupAPI" in api_source
    assert "moveChatToGroupAPI" in api_source
    assert "renderChatGroups" in history_source
    assert "setupHistoryDragAndDrop" in history_source
    assert "data-group-id" in history_source
    assert ".chat-group-header" in sidebar_css
    assert ".chat-group-drop-target" in sidebar_css


def test_new_group_button_uses_amc_folders_icon():
    index_source = (PROJECT_ROOT / "backend/static/index.html").read_text(
        encoding="utf-8"
    )

    new_group_markup = index_source.split('id="new-group-btn"', 1)[1].split(
        "</button>",
        1,
    )[0]

    assert 'data-testid="new-group-folder-icon"' in new_group_markup
    assert 'width="18"' in new_group_markup
    assert 'height="18"' in new_group_markup
    assert 'viewBox="0 0 24 24"' in new_group_markup
    assert 'stroke-width="2"' in new_group_markup
    assert 'd="M20 17a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3.9a2 2 0 0 1-1.69-.9l-.81-1.2A2 2 0 0 0 11.93 4H8a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2Z"' in new_group_markup
    assert 'd="M2 8v11a2 2 0 0 0 2 2h14"' in new_group_markup
    assert 'd="M12 10v6"' not in new_group_markup
    assert 'd="M9 13h6"' not in new_group_markup


def test_sidebar_custom_groups_render_sessions_by_date():
    history_source = (
        PROJECT_ROOT / "backend/static/js/modules/history-view.js"
    ).read_text(encoding="utf-8")
    sidebar_css = (
        PROJECT_ROOT / "backend/static/css/sections/sidebar.css"
    ).read_text(encoding="utf-8")

    render_date_signature = re.search(
        r"function renderDateGroups\((?P<args>[^)]*)\)",
        history_source,
    )
    chat_group_render = history_source.split(
        "function renderChatGroups",
        1,
    )[1].split("function renderDateGroups", 1)[0]

    assert render_date_signature is not None
    assert "target = elements.historyList" in render_date_signature.group("args")
    assert "renderDateGroups(ordered, currentSessionId, callbacks, list)" in chat_group_render
    assert "sessions.forEach(chat => list.appendChild(createHistoryItem" not in chat_group_render
    assert ".chat-group-session-list .history-group" in sidebar_css
    assert ".chat-group-session-list .history-group-header" in sidebar_css


def test_history_api_timestamps_include_utc_timezone():
    database_source = (PROJECT_ROOT / "backend/app/database.py").read_text(
        encoding="utf-8"
    )
    history_router_source = (
        PROJECT_ROOT / "backend/app/routers/history.py"
    ).read_text(encoding="utf-8")

    assert "timezone" in database_source
    assert "def _format_utc_timestamp" in database_source
    assert "datetime.fromisoformat" in database_source
    assert "value.replace(tzinfo=timezone.utc)" in database_source
    assert ".isoformat().replace('+00:00', 'Z')" in database_source
    assert "value[:-1] + '+00:00'" in database_source
    assert "msg_dict[\"timestamp\"] = _format_utc_timestamp(m.created_at)" in database_source
    assert "\"timestamp\": _format_utc_timestamp(sess.updated_at)" in database_source
    assert "\"timestamp\": _format_utc_timestamp(s.updated_at)" in database_source
    assert "\"timestamp\": _format_utc_timestamp(group.updated_at)" in database_source
    assert "from ..database import (" in history_router_source
    assert "_format_utc_timestamp" in history_router_source
    assert "\"timestamp\": _format_utc_timestamp(row[3])" in history_router_source


def test_sidebar_search_action_matches_amc_layout():
    index_source = (PROJECT_ROOT / "backend/static/index.html").read_text(
        encoding="utf-8"
    )
    history_source = (
        PROJECT_ROOT / "backend/static/js/modules/history-view.js"
    ).read_text(encoding="utf-8")
    sidebar_css = (
        PROJECT_ROOT / "backend/static/css/sections/sidebar.css"
    ).read_text(encoding="utf-8")

    action_stack = index_source.split('<div class="new-chat-wrapper">', 1)[1].split(
        '<div class="history-list"',
        1,
    )[0]

    assert action_stack.index('id="new-chat-btn"') < action_stack.index(
        'id="history-search-open-btn"'
    )
    assert action_stack.index('id="history-search-open-btn"') < action_stack.index(
        'id="new-group-btn"'
    )
    assert 'id="history-search-box"' in action_stack
    assert 'id="history-search-close-btn"' in action_stack
    assert 'class="history-search-btn"' in action_stack

    assert ".history-search-btn" in sidebar_css
    assert ".history-search-box[hidden]" in sidebar_css
    assert ".history-search-close-btn" in sidebar_css

    assert "export function openHistorySearch" in history_source
    assert "historySearchOpenBtn.hidden = true" in history_source
    assert "historySearchBox.hidden = false" in history_source
    assert "historySearchInput.value = ''" in history_source


def test_sidebar_collapse_uses_crossfade_instead_of_display_toggle():
    sidebar_css = (
        PROJECT_ROOT / "backend/static/css/sections/sidebar.css"
    ).read_text(encoding="utf-8")
    responsive_css = (
        PROJECT_ROOT / "backend/static/css/sections/responsive.css"
    ).read_text(encoding="utf-8")

    expanded_collapsed_rule = re.search(
        r"#sidebar\.collapsed\s+\.sidebar-expanded-pane\s*\{(?P<body>.*?)\}",
        sidebar_css,
        re.DOTALL,
    )
    mini_base_rule = re.search(
        r"\.sidebar-collapsed-pane\s*\{(?P<body>.*?)\}",
        sidebar_css,
        re.DOTALL,
    )
    mini_collapsed_rule = re.search(
        r"#sidebar\.collapsed\s+\.sidebar-collapsed-pane\s*\{(?P<body>.*?)\}",
        sidebar_css,
        re.DOTALL,
    )
    responsive_expanded_rule = re.search(
        r"#sidebar\.collapsed\s+\.sidebar-expanded-pane\s*\{(?P<body>.*?)\}",
        responsive_css,
        re.DOTALL,
    )
    responsive_mini_rule = re.search(
        r"#sidebar\.collapsed\s+\.sidebar-collapsed-pane\s*\{(?P<body>.*?)\}",
        responsive_css,
        re.DOTALL,
    )

    assert expanded_collapsed_rule is not None
    assert mini_base_rule is not None
    assert mini_collapsed_rule is not None
    assert "display: none" not in expanded_collapsed_rule.group("body")
    assert "display: none" not in mini_base_rule.group("body")
    assert "display: flex" not in mini_collapsed_rule.group("body")
    assert "visibility:" in expanded_collapsed_rule.group("body")
    assert "pointer-events: none" in expanded_collapsed_rule.group("body")
    assert "transform:" in expanded_collapsed_rule.group("body")
    assert "transform:" in mini_collapsed_rule.group("body")
    assert responsive_expanded_rule is not None
    assert responsive_mini_rule is not None
    assert "display: flex !important" not in responsive_expanded_rule.group("body")
    assert "display: none !important" not in responsive_mini_rule.group("body")


def test_sidebar_mini_icons_match_expanded_icon_size_and_direction():
    index_source = (PROJECT_ROOT / "backend/static/index.html").read_text(
        encoding="utf-8"
    )
    sidebar_css = (
        PROJECT_ROOT / "backend/static/css/sections/sidebar.css"
    ).read_text(encoding="utf-8")

    collapsed_markup = index_source.split('<div class="sidebar-collapsed-pane">', 1)[
        1
    ].split('    </div>\n\n    <div id="main">', 1)[0]
    assert 'width="20" height="20"' not in collapsed_markup
    assert collapsed_markup.count('width="18" height="18"') >= 5
    assert index_source.count('class="icon-svg sidebar-collapse-icon"') >= 3
    assert 'class="icon-svg sidebar-expand-icon"' not in index_source
    assert ".sidebar-expand-icon" in sidebar_css
    assert "transform: scaleX(-1);" in sidebar_css


def test_sidebar_polish_uses_precise_cursor_hover_and_stable_shortcuts():
    sidebar_css = (
        PROJECT_ROOT / "backend/static/css/sections/sidebar.css"
    ).read_text(encoding="utf-8")

    assert "cursor: ew-resize" not in sidebar_css
    assert "#sidebar.collapsed:hover" not in sidebar_css
    assert "transition: all" not in sidebar_css
    assert "min-width:" in re.search(
        r"\.sidebar-kbd\s*\{(?P<body>.*?)\}",
        sidebar_css,
        re.DOTALL,
    ).group("body")
    assert "text-align: right" in sidebar_css
    assert ".new-chat-btn:hover .sidebar-kbd" in sidebar_css


def test_sidebar_header_primary_controls_are_twenty_percent_larger():
    sidebar_css = (
        PROJECT_ROOT / "backend/static/css/sections/sidebar.css"
    ).read_text(encoding="utf-8")

    brand_rule = re.search(
        r"\.sidebar-brand-name\s*\{(?P<body>.*?)\}",
        sidebar_css,
        re.DOTALL,
    )
    header_button_rule = re.search(
        r"\.sidebar-header-buttons\s+\.icon-btn\s*\{(?P<body>.*?)\}",
        sidebar_css,
        re.DOTALL,
    )
    header_icon_rule = re.search(
        r"\.sidebar-header-buttons\s+\.icon-svg\s*\{(?P<body>.*?)\}",
        sidebar_css,
        re.DOTALL,
    )

    assert brand_rule is not None
    assert header_button_rule is not None
    assert header_icon_rule is not None
    assert "font-size: 19.8px;" in brand_rule.group("body")
    assert "width: 41px !important;" in header_button_rule.group("body")
    assert "height: 41px;" in header_button_rule.group("body")
    assert "width: 21.6px;" in header_icon_rule.group("body")
    assert "height: 21.6px;" in header_icon_rule.group("body")


def test_model_selector_trigger_has_no_provider_icon():
    index_source = (PROJECT_ROOT / "backend/static/index.html").read_text(encoding="utf-8")
    selector_source = (
        PROJECT_ROOT / "backend/static/js/modules/model-selector.js"
    ).read_text(encoding="utf-8")

    trigger_match = re.search(
        r'<div class="model-select-trigger"[^>]*>(.*?)</div>',
        index_source,
        re.DOTALL,
    )

    assert trigger_match is not None
    assert "model-icon-svg" not in trigger_match.group(1)
    assert "model-item-icon-svg" in selector_source


def test_collapsed_model_selectors_show_model_name_without_provider():
    main_source = (PROJECT_ROOT / "backend/static/js/main.js").read_text(
        encoding="utf-8"
    )
    selector_source = (
        PROJECT_ROOT / "backend/static/js/modules/model-selector.js"
    ).read_text(encoding="utf-8")
    settings_source = (
        PROJECT_ROOT / "backend/static/js/modules/settings-modal.js"
    ).read_text(encoding="utf-8")

    assert "option.dataset.modelDisplayName = displayName" in main_source
    assert "triggerText.textContent = activeOption.dataset.modelDisplayName || activeOption.text" in selector_source
    assert "if (opt === activeOption)" in selector_source
    assert "<optgroup" in settings_source
    assert "modelLabel: displayName" in settings_source
    assert "label: `${displayName} · ${providerName}`" not in settings_source


def test_gemini_25_models_are_filtered_from_frontend_options():
    main_source = (PROJECT_ROOT / "backend/static/js/main.js").read_text(
        encoding="utf-8"
    )
    settings_source = (
        PROJECT_ROOT / "backend/static/js/modules/settings-modal.js"
    ).read_text(encoding="utf-8")
    provider_models_source = (
        PROJECT_ROOT / "backend/static/js/modules/provider-models.js"
    ).read_text(encoding="utf-8")

    assert "getSupportedModelItems(provider.model_id)" in main_source
    assert "from './modules/provider-models.js?v=1'" in main_source
    assert "from './provider-models.js?v=1'" in settings_source
    assert "export function splitModelItem" in provider_models_source
    assert "export function getSupportedModelItems" in provider_models_source
    assert "isUnsupportedGemini25Model" in settings_source
    assert ".filter(model => model && !isUnsupportedGemini25Model(model))" in provider_models_source
    assert "function splitModelItem" not in main_source
    assert "function splitModelItem" not in settings_source


def test_deep_search_config_only_in_settings():
    """Deep search (interactive) is configured only in the settings modal, not as a
    quick toggle inside the input box."""
    index_source = (PROJECT_ROOT / "backend/static/index.html").read_text(encoding="utf-8")

    assert "quick-interactive-btn" not in index_source
    assert 'id="interactive-search-input"' in index_source
    assert "交互式深度搜索" in index_source


def test_live_artifacts_toggle_wires_amc_live_artifacts_mode():
    index_source = (PROJECT_ROOT / "backend/static/index.html").read_text(encoding="utf-8")
    chat_source = (PROJECT_ROOT / "backend/static/js/modules/chat.js").read_text(
        encoding="utf-8"
    )
    api_source = (PROJECT_ROOT / "backend/static/js/modules/api.js").read_text(
        encoding="utf-8"
    )
    state_source = (PROJECT_ROOT / "backend/static/js/modules/state.js").read_text(
        encoding="utf-8"
    )
    router_source = (PROJECT_ROOT / "backend/app/routers/chat.py").read_text(
        encoding="utf-8"
    )
    workflow_source = (PROJECT_ROOT / "backend/app/workflow.py").read_text(
        encoding="utf-8"
    )
    prompts_source = (PROJECT_ROOT / "backend/app/prompts.py").read_text(
        encoding="utf-8"
    )

    assert 'id="quick-live-artifacts-btn"' in index_source
    assert "Live Artifacts" in index_source
    assert "auto_awesome" in index_source
    assert "liveArtifactsMode: state.liveArtifactsMode" in chat_source
    assert "setLiveArtifactsMode(nextValue)" in chat_source
    assert "state.settings.live_artifacts_mode = nextValue" in chat_source
    assert "live_artifacts_mode: Boolean(liveArtifactsMode)" in api_source
    assert "liveArtifactsMode: false" in state_source
    assert "'live_artifacts_mode'" in state_source
    assert "live_artifacts_mode: Optional[bool]" in router_source
    assert "def _coerce_bool(value, default: bool = False) -> bool:" in router_source
    assert 'saved_live_artifacts_mode = _coerce_bool(defaults.get("live_artifacts_mode"), False)' in router_source
    assert "if request.canvas_mode:" in router_source
    assert "live_artifacts_mode=live_artifacts_mode" in router_source
    assert "live_artifacts_mode: bool = False" in workflow_source
    assert "live_artifacts_mode=self.live_artifacts_mode" in workflow_source
    assert "LIVE_ARTIFACTS_PROMPT" in prompts_source
    assert "LIVE_ARTIFACTS_PROMPT_ZH" in prompts_source
    assert "LIVE_ARTIFACTS_PROMPT_EN" in prompts_source
    assert "select_live_artifacts_protocol" in prompts_source
    assert "ANSWER_GENERATION_LIVE_ARTIFACTS_PROMPT" in prompts_source
    assert "[Live Artifacts Inline Protocol - zh]" in prompts_source
    assert "[Live Artifacts Inline Protocol - en]" in prompts_source
    assert "JustSearch 的 Live Artifacts Designer" in prompts_source
    assert "Live Artifacts Designer for JustSearch" in prompts_source
    assert "AMC-WebUI" not in prompts_source
    assert "不要退回纯文本" in prompts_source
    # AMC-aligned fence wording (includes amc-live-artifact-html).
    assert "不要放进 css、text、markdown、html 或 amc-live-artifact-html 代码块" in prompts_source
    assert "Do not wrap it in css, text, markdown, html, or amc-live-artifact-html fences" in prompts_source
    # AMC aesthetic + density tiers + golden examples.
    assert "美学目标" in prompts_source
    assert "丰富档黄金范例" in prompts_source
    assert "Aesthetic goal" in prompts_source
    assert "Rich-tier golden example" in prompts_source
    assert "HARD CONSTRAINTS" in prompts_source
    # JustSearch search overlay still forbids fixed viewport shells.
    assert "100vh" in prompts_source
    assert "height:100%" in prompts_source or "height:100%" in prompts_source.replace(" ", "")
    assert "never ship only a hero title" in prompts_source
    assert "var(--amc-live-artifact-font-size)" in prompts_source
    # AMC uses compact token pipes: text|muted|subtle|... and surface|surface-muted|...
    assert "--amc-live-artifact-text" in prompts_source
    assert "--amc-live-artifact-surface" in prompts_source
    assert "--amc-live-artifact-accent" in prompts_source
    assert "--amc-live-artifact-success-surface" in prompts_source
    assert "var(--amc-live-artifact-border)" in prompts_source
    assert "The actual answer content in Markdown" not in prompts_source.split("ANSWER_GENERATION_LIVE_ARTIFACTS_PROMPT", 1)[1]
    assert "complete document with <!doctype html>" not in prompts_source
    # AMC protocol intentionally omits details/summary fold guidance.
    assert "details/summary" not in prompts_source.split("LIVE_ARTIFACTS_PROMPT_ZH", 1)[1].split("CITATION_VERIFICATION_PROMPT", 1)[0]


def test_browser_modal_module_has_been_removed_in_bridge_refactor():
    # 桥接重构后验证码在用户真实 Chrome 里就地解决,不再有远程 modal。
    assert not (PROJECT_ROOT / "backend/static/js/modules/browser-modal.js").exists()
    index_source = (PROJECT_ROOT / "backend/static/index.html").read_text(encoding="utf-8")
    assert 'id="browser-type-input"' not in index_source
    assert 'id="browser-modal"' not in index_source


def test_chat_router_has_no_browser_websocket_in_bridge_refactor():
    chat_router_source = (PROJECT_ROOT / "backend/app/routers/chat.py").read_text(
        encoding="utf-8"
    )
    assert "ws/browser" not in chat_router_source
    assert "interaction" not in chat_router_source


def test_escape_shortcut_closes_topmost_modal_only():
    source = (PROJECT_ROOT / "backend/static/js/main.js").read_text(encoding="utf-8")

    assert "document.querySelectorAll('.modal.active')" in source
    assert "activeModals[activeModals.length - 1]" in source
    assert "document.querySelector('.modal.active')" not in source


def test_openai_clients_use_project_factory_with_user_agent():
    factory_path = PROJECT_ROOT / "backend/app/openai_client.py"
    source = factory_path.read_text(encoding="utf-8")
    tree = ast.parse(source)

    assert "JustSearch/" in source
    assert "__version__" in source
    assert "LOCAL_PROVIDER_API_KEY" in source
    assert "api_key=api_key or LOCAL_PROVIDER_API_KEY" in source

    factory_calls = [
        node
        for node in ast.walk(tree)
        if isinstance(node, ast.Call)
        and getattr(node.func, "id", None) == "AsyncOpenAI"
    ]
    assert len(factory_calls) == 1

    call = factory_calls[0]
    keyword_names = {keyword.arg for keyword in call.keywords}
    assert "default_headers" in keyword_names

    headers_keyword = next(
        keyword for keyword in call.keywords if keyword.arg == "default_headers"
    )
    assert isinstance(headers_keyword.value, ast.Dict)
    header_keys = [
        key.value
        for key in headers_keyword.value.keys
        if isinstance(key, ast.Constant)
    ]
    assert "User-Agent" in header_keys


def test_openai_clients_are_not_constructed_outside_project_factory():
    direct_usages = []
    for source_path in sorted((PROJECT_ROOT / "backend/app").rglob("*.py")):
        if source_path.name == "openai_client.py":
            continue

        tree = ast.parse(source_path.read_text(encoding="utf-8"))
        for node in ast.walk(tree):
            if isinstance(node, ast.ImportFrom) and node.module == "openai":
                imported_names = {alias.name for alias in node.names}
                if "AsyncOpenAI" in imported_names:
                    direct_usages.append(str(source_path.relative_to(PROJECT_ROOT)))
            if (
                isinstance(node, ast.Call)
                and getattr(node.func, "id", None) == "AsyncOpenAI"
            ):
                direct_usages.append(str(source_path.relative_to(PROJECT_ROOT)))

    assert direct_usages == []
