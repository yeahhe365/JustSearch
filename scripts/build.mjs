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
import { spawnSync } from 'node:child_process';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const STATIC = join(ROOT, 'backend', 'static');
const SRC_HTML = join(STATIC, 'index.html');

const isDev = process.argv.includes('--dev');
const OUT_DIR = join(STATIC, isDev ? 'build/dev' : 'dist');

const CSS_SECTION_ORDER = [
    'base.css',
    'tailwind.css',
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
    // AMC对齐：esbuild splitting + 动态 import 懒块（settings-modal 等）
    const outdir = join(OUT_DIR, 'js');
    ensureDir(outdir);
    // 清理旧 app.js（splitting 改为目录输出，避免残留）
    try { rmSync(join(outdir, 'app.js'), { force: true }); } catch {}
    await build({
        entryPoints: [join(STATIC, 'js', 'main.js')],
        bundle: true,
        format: 'esm',
        splitting: true,
        outdir,
        chunkNames: 'chunks/[name]-[hash]',
        target: 'es2020',
        minify: !isDev,
        sourcemap: isDev,
        legalComments: 'none',
        logLevel: 'info',
    });
    // 主入口为 main.js（被 import 的settings-modal 会成为 chunks/xxx.js）
    const mainPath = join(outdir, 'main.js');
    // 兼容旧路径：保留 app.js 符号链接指向 main.js，供 generateIndexHtml 与旧缓存兼容
    try {
        const buf = readFileSync(mainPath);
        writeFileSync(join(outdir, 'app.js'), buf);
        return buf;
    } catch {
        // fallback：若 esbuild 输出 app.js（未启用 splitting 的旧构建）
        const fallback = join(outdir, 'app.js');
        if (existsSync(fallback)) return readFileSync(fallback);
        throw new Error('main.js not found after bundle');
    }
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

async function buildTailwindCss() {
    const input = join(STATIC, 'css', 'tailwind-input.css');
    const output = join(STATIC, 'css', 'sections', 'tailwind.css');
    if (!existsSync(input)) return;
    try {
        const bin = join(ROOT, 'node_modules', '.bin', 'tailwindcss');
        const useBin = existsSync(bin);
        const args = useBin
            ? ['-i', input, '-o', output]
            : ['@tailwindcss/cli', '-i', input, '-o', output];
        if (!isDev) args.push('--minify');
        console.log(`[tailwind] ${useBin ? bin : 'npx'} ${args.join(' ')}`);
        const result = spawnSync(useBin ? bin : 'npx', args, { stdio: 'inherit', cwd: ROOT });
        if (result.status !== 0) {
            console.warn('[tailwind] build failed, writing fallback');
            if (!existsSync(output)) writeFileSync(output, '/* tailwind fallback — CLI failed */\n');
        } else if (!existsSync(output)) {
            writeFileSync(output, '/* tailwind generated empty */\n');
        } else {
            console.log(`[tailwind] generated ${output} (${(readFileSync(output).length / 1024).toFixed(1)} KiB)`);
        }
    } catch (e) {
        console.warn('[tailwind] error', e?.message || e);
        if (!existsSync(output)) writeFileSync(output, '/* tailwind error fallback */\n');
    }
}

async function buildCss() {
    await buildTailwindCss();
    let css = '';
    for (const name of CSS_SECTION_ORDER) {
        const file = join(STATIC, 'css', 'sections', name);
        if (existsSync(file)) css += `/* === ${name} (inlined) === */\n${readFileSync(file, 'utf8')}\n`;
    }
    // Generated from css/sections/*.css (build.mjs). Do not hand-edit —
    // this file is rewritten on every build; sections are the single source.
    css = `/* GENERATED — do not hand-edit. Source: backend/static/css/sections/*.css */\n${css}`;
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
    // AMC对齐：vendor 延迟加载（defer），避免阻塞首屏解析
    html = html.replace(
        /<script[^>]*src="\/static\/vendor\/markdown-it[^"]*"[^>]*><\/script>\s*/,
        '',
    );
    html = html.replace(
        /<script[^>]*src="\/static\/vendor\/purify[^"]*"[^>]*><\/script>\s*/,
        '',
    );
    html = html.replace(
        /<script[^>]*src="\/static\/vendor\/highlight[^"]*"[^>]*><\/script>/,
        `<script defer src="${v('/static/dist/js/vendor.js', assets.vendorJs)}"></script>`,
    );

    // Main stylesheet — AMC 对齐：同步阻塞式，避免 preload onload 闪白
    html = html.replace(
        /\/static\/css\/style\.css\?v=\d+/g,
        v('/static/dist/css/style.css', assets.styleCss),
    );
    // 若源码仍残留 preload 模式，兜底清理（兼容旧产物）
    html = html.replace(/<link rel="preload"[^>]*as="style"[^>]*>/g, (m) => {
        if (m.includes('style.css') || m.includes('fonts.css')) return '';
        return m;
    });
    html = html.replace(/<noscript>[\s\S]*?<\/noscript>/g, '');

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

    // Post-assertions: if index.html drifts (non-numeric ?v=, renamed path,
    // removed query), the rewrites above would silently leave stale unhashed
    // references pointing at source assets that dist never ships. Fail loudly.
    const stalePatterns = [
        /src="\/static\/js\/main\.js[^"]*"/,
        /\/static\/css\/style\.css\?v=\d+/,
        /src="\/static\/vendor\/(?:markdown-it|purify|highlight)[^"]*"/,
    ];
    for (const pattern of stalePatterns) {
        if (pattern.test(html)) {
            throw new Error(`generateIndexHtml: stale reference matching ${pattern} survived rewrite — update the rewrite rules`);
        }
    }

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
    // PWA: copy sw.js (对齐 AMC VitePWA)
    if (existsSync(join(STATIC, 'sw.js'))) {
        copyFileSync(join(STATIC, 'sw.js'), join(OUT_DIR, 'sw.js'));
        // keep source also accessible via /static/sw.js
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
