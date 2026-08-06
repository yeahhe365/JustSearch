#!/usr/bin/env node
/**
 * JustSearch frontend build script.
 *
 * - Bundles app JS (main.js + modules) via esbuild into dist/js/app.js
 * - Concatenates vendor libs into dist/js/vendor.js
 * - Concatenates the source CSS sections (css/sections/*.css) in order,
 *   minifies, and writes dist/css/style.css
 * - Copies fonts / assets / vendor highlight themes to dist/
 * - Generates dist/index.html from the source index.html with:
 *     • script/link paths rewritten to the dist files
 *     • automatic ?v= cache-busting hash per asset (no manual bumps)
 *
 * Run: npm run build
 * Dev: npm run dev   (same but no minify, outputs to build/dev/)
 */
import { build, transform } from 'esbuild';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, copyFileSync, writeFileSync, rmSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const STATIC = join(ROOT, 'backend', 'static');
const SRC_HTML = join(STATIC, 'index.html');

const isDev = process.argv.includes('--dev');
const OUT_DIR = join(STATIC, isDev ? 'build/dev' : 'dist');

const CSS_SECTION_ORDER = [
    'base.css',
    'sidebar.css',
    'chat.css',
    'input-modal.css',
    'markdown.css',
    'live-artifacts.css',
    'overlays.css',
    'responsive.css',
    'polish.css',
];

/** Content hash (8 hex chars) for cache-busting. */
function assetHash(buf) {
    return createHash('sha256').update(buf).digest('hex').slice(0, 8);
}

function ensureDir(p) {
    mkdirSync(p, { recursive: true });
}

function copyDir(src, dest) {
    if (!existsSync(src)) return;
    ensureDir(dest);
    for (const name of readdirSync(src)) {
        const s = join(src, name);
        const d = join(dest, name);
        if (statSync(s).isDirectory()) {
            copyDir(s, d);
        } else if (existsSync(s)) {
            copyFileSync(s, d);
        }
    }
}

async function bundleAppJs() {
    const outfile = join(OUT_DIR, 'js', 'app.js');
    ensureDir(dirname(outfile));
    await build({
        entryPoints: [join(STATIC, 'js', 'main.js')],
        outfile,
        bundle: true,
        format: 'esm',
        target: 'es2020',
        minify: !isDev,
        sourcemap: isDev,
        legalComments: 'none',
        logLevel: 'info',
    });
    return readFileSync(outfile);
}

/** Vendor libs are pre-minified UMD globals; concatenate in dependency order. */
function bundleVendorJs() {
    const VENDOR_JS = ['markdown-it.min.js', 'purify.min.js', 'highlight.min.js'];
    const parts = VENDOR_JS.map((f) => readFileSync(join(STATIC, 'vendor', f), 'utf8'));
    const out = join(OUT_DIR, 'js', 'vendor.js');
    ensureDir(dirname(out));
    writeFileSync(out, `/*! bundled vendor: ${VENDOR_JS.join(', ')} */\n${parts.join('\n')}\n`);
    return readFileSync(out);
}

async function buildCss() {
    let css = '';
    for (const name of CSS_SECTION_ORDER) {
        const file = join(STATIC, 'css', 'sections', name);
        if (existsSync(file)) css += `/* === ${name} (inlined) === */\n${readFileSync(file, 'utf8')}\n`;
    }
    // Keep the dev-served style.css in sync with sections so the app works
    // even before a production build (sections remain the single source).
    writeFileSync(join(STATIC, 'css', 'style.css'), css);
    const { code } = await transform(css, {
        loader: 'css',
        minify: !isDev,
        sourcemap: false,
    });
    const out = join(OUT_DIR, 'css', 'style.css');
    ensureDir(dirname(out));
    writeFileSync(out, isDev ? css : code);
    return Buffer.from(isDev ? css : code);
}

/**
 * Rewrite the source index.html asset references to the dist output and stamp
 * each asset with an automatic ?v=<hash> so browsers re-fetch on change.
 */
function generateIndexHtml(assets) {
    let html = readFileSync(SRC_HTML, 'utf8');

    const v = (path, buf) => `${path}?v=${assetHash(buf)}`;

    // App JS bundle.
    html = html.replace(
        /<script type="module" src="\/static\/js\/main\.js[^"]*"><\/script>/,
        `<script type="module" src="${v('/static/dist/js/app.js', assets.appJs)}"></script>`,
    );

    // Vendor JS bundle: replace the three individual vendor <script> tags
    // (markdown-it, purify, highlight) with a single concatenated vendor.js.
    // The highlight <link> theme stylesheets stay — chat.js toggles
    // #hljs-dark / #hljs-light at runtime.
    html = html.replace(
        /<script src="\/static\/vendor\/markdown-it[^"]*"><\/script>\s*/,
        '',
    );
    html = html.replace(
        /<script src="\/static\/vendor\/purify[^"]*"><\/script>\s*/,
        '',
    );
    html = html.replace(
        /<script src="\/static\/vendor\/highlight[^"]*"><\/script>/,
        `<script src="${v('/static/dist/js/vendor.js', assets.vendorJs)}"></script>`,
    );

    // Main stylesheet (style.css preload + noscript fallback).
    html = html.replace(
        /\/static\/css\/style\.css\?v=\d+/g,
        v('/static/dist/css/style.css', assets.styleCss),
    );

    // highlight theme stylesheets are copied to dist/vendor and keep their ids
    // (chat.js toggles #hljs-dark / #hljs-light .disabled at runtime).
    html = html.replace(
        /\/static\/vendor\/highlight-github-dark\.min\.css\?v=[\d.]+/g,
        v('/static/dist/vendor/highlight-github-dark.min.css', assets.hljsDark),
    );
    html = html.replace(
        /\/static\/vendor\/highlight-github\.min\.css\?v=[\d.]+/g,
        v('/static/dist/vendor/highlight-github.min.css', assets.hljsLight),
    );

    // Fonts CSS keeps its own path + hash.
    html = html.replace(
        /\/static\/fonts\/fonts\.css\?v=\d+/g,
        v('/static/fonts/fonts.css', readFileSync(join(STATIC, 'fonts', 'fonts.css'))),
    );

    // Static images / icons: keep paths, just version with content hash.
    // (Subdirectories such as assets/providers are referenced at runtime by JS,
    // not from index.html, so they are skipped here.)
    const assetDir = join(STATIC, 'assets');
    if (existsSync(assetDir)) {
        for (const name of readdirSync(assetDir)) {
            const assetPath = join(assetDir, name);
            if (statSync(assetPath).isDirectory()) continue;
            const buf = readFileSync(assetPath);
            html = html.replace(
                new RegExp(`/static/assets/${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\?v=\\d+`, 'g'),
                `/static/assets/${name}?v=${assetHash(buf)}`,
            );
        }
    }

    const out = join(OUT_DIR, 'index.html');
    ensureDir(dirname(out));
    writeFileSync(out, html);
}

async function main() {
    console.log(`Building JustSearch frontend → ${OUT_DIR}${isDev ? ' (dev, unminified)' : ''}`);

    // Fresh output dir.
    rmSync(OUT_DIR, { recursive: true, force: true });
    ensureDir(OUT_DIR);

    const appJs = await bundleAppJs();
    const vendorJs = bundleVendorJs();
    const styleCss = await buildCss();

    // Copy fonts, assets, manifest, vendor highlight themes.
    copyDir(join(STATIC, 'fonts'), join(OUT_DIR, 'fonts'));
    copyDir(join(STATIC, 'assets'), join(OUT_DIR, 'assets'));
    if (existsSync(join(STATIC, 'manifest.json'))) {
        copyFileSync(join(STATIC, 'manifest.json'), join(OUT_DIR, 'manifest.json'));
    }
    ensureDir(join(OUT_DIR, 'vendor'));
    for (const name of ['highlight-github-dark.min.css', 'highlight-github.min.css']) {
        const src = join(STATIC, 'vendor', name);
        if (existsSync(src)) copyFileSync(src, join(OUT_DIR, 'vendor', name));
    }

    const assets = {
        appJs,
        vendorJs,
        styleCss,
        hljsDark: readFileSync(join(OUT_DIR, 'vendor', 'highlight-github-dark.min.css')),
        hljsLight: readFileSync(join(OUT_DIR, 'vendor', 'highlight-github.min.css')),
    };

    generateIndexHtml(assets);

    const size = (buf) => `${(buf.length / 1024).toFixed(1)} KiB`;
    console.log('');
    console.log('  app.js      ', size(appJs));
    console.log('  vendor.js   ', size(vendorJs));
    console.log('  style.css   ', size(styleCss));
    console.log('');
    console.log('Done.');
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
