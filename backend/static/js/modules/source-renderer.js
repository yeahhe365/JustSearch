import { getSafeUrl, md } from './utils.js?v=14';
import { t } from './i18n.js?v=1';
import {
    assignOccurrenceAttributes,
    createOccurrenceTracker,
    shouldSkipTextNode,
} from './citation-occurrences.js?v=1';

const _faviconCache = new Map();

function getFaviconUrl(url) {
    try {
        const parsedUrl = new URL(url);
        if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
            return null;
        }
        const domain = parsedUrl.hostname;
        if (_faviconCache.has(domain)) {
            return _faviconCache.get(domain);
        }
        const faviconUrl = `https://www.google.com/s2/favicons?domain=${domain}&sz=32`;
        _faviconCache.set(domain, faviconUrl);
        return faviconUrl;
    } catch {
        return null;
    }
}

export function extractSources(text) {
    const sources = [];
    const regex = /\[(\d+)\] \[([^\]]*)\]\(([^)]+)\)/g;
    let match;
    while ((match = regex.exec(String(text || ''))) !== null) {
        sources.push({ id: match[1], title: match[2], url: match[3] });
    }
    return sources;
}

function coerceSourceList(sources) {
    if (Array.isArray(sources)) return sources;
    if (typeof sources !== 'string') return [];

    const raw = sources.trim();
    if (!raw) return [];
    try {
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed : [];
    } catch {
        return [];
    }
}

export function normalizeCitationSources(sources) {
    return coerceSourceList(sources)
        .map((source, index) => {
            if (typeof source === 'string') {
                const url = source.trim();
                return url ? { id: String(index + 1), title: url, url } : null;
            }
            if (!source || typeof source !== 'object') return null;
            const id = String(source.id ?? index + 1).trim();
            if (!id) return null;
            const url = String(source.url || '').trim();
            const title = String(source.title || url || `Source ${id}`).replace(/\s+/g, ' ').trim();
            return { ...source, id, title, url };
        })
        .filter(Boolean);
}

export function hasCitationSources(sources) {
    return normalizeCitationSources(sources).length > 0;
}

function mergeSources(primarySources, fallbackSources) {
    const sourceById = new Map();
    [...normalizeCitationSources(fallbackSources), ...normalizeCitationSources(primarySources)].forEach((source, index) => {
        const id = String(source?.id ?? index + 1).trim();
        if (!id) return;
        sourceById.set(id, { ...source, id });
    });
    return Array.from(sourceById.values());
}

export function linkCitationsInElement(root, sources) {
    const resolvedSources = normalizeCitationSources(sources);
    if (!root || resolvedSources.length === 0 || typeof document === 'undefined') return false;

    const filter = (typeof NodeFilter !== 'undefined' && NodeFilter)
        || (typeof window !== 'undefined' && window.NodeFilter);
    if (!filter || typeof document.createTreeWalker !== 'function') return false;

    const sourceById = new Map(
        resolvedSources
            .map((source, index) => [String(source.id ?? index + 1).trim(), source])
    );

    const walker = document.createTreeWalker(root, filter.SHOW_TEXT, {
        acceptNode: function(node) {
            if (!/\[\d+(?:,\s*\d+)*\]/.test(node.textContent || '')) {
                return filter.FILTER_REJECT;
            }
            return shouldSkipTextNode(node, root) ? filter.FILTER_REJECT : filter.FILTER_ACCEPT;
        }
    });

    const nodesToReplace = [];
    while (walker.nextNode()) {
        nodesToReplace.push(walker.currentNode);
    }

    const tracker = createOccurrenceTracker();

    nodesToReplace.forEach(node => {
        const content = node.textContent || '';
        const fragment = document.createDocumentFragment();

        const regex = /\[(\d+(?:,\s*\d+)*)\]/g;
        let lastIndex = 0;
        let match;

        while ((match = regex.exec(content)) !== null) {
            if (match.index > lastIndex) {
                fragment.appendChild(document.createTextNode(content.substring(lastIndex, match.index)));
            }

            const ids = match[1].split(',').map(id => id.trim());
            const linkSpan = document.createElement('span');
            linkSpan.className = 'citation-group';
            const groupIndex = tracker.nextGroup();

            ids.forEach((id, idx) => {
                const source = sourceById.get(id);
                if (source) {
                    const safeUrl = getSafeUrl(source.url);
                    const anchor = document.createElement('a');
                    // href kept as fallback / middle-click; primary click opens evidence panel.
                    anchor.href = safeUrl || '#';
                    anchor.className = 'citation-link';
                    if (source.snippet) anchor.dataset.evidenceSnippet = String(source.snippet).slice(0, 200);
                    if (safeUrl) {
                        anchor.target = '_blank';
                        anchor.rel = 'noopener noreferrer';
                    }
                    const statusHint = source.excerpt || source.snippet || source.title || source.url || '';
                    anchor.title = statusHint
                        ? `${source.title || source.url || id}\n${t('source.viewEvidence')}`
                        : (source.title || source.url || t('source.label', { id }));
                    anchor.setAttribute('aria-label', t('source.viewEvidenceAria', { id }));

                    const faviconUrl = getFaviconUrl(safeUrl);
                    if (faviconUrl) {
                        const img = document.createElement('img');
                        img.src = faviconUrl;
                        img.className = 'citation-favicon';
                        img.alt = '';
                        img.loading = 'lazy';
                        img.onerror = () => img.remove();
                        anchor.appendChild(img);
                    }

                    anchor.appendChild(document.createTextNode(id));
                    assignOccurrenceAttributes(anchor, tracker, id, groupIndex, idx);
                    linkSpan.appendChild(anchor);

                    if (idx < ids.length - 1) {
                        const comma = document.createElement('span');
                        comma.textContent = ',';
                        comma.style.color = 'var(--text-muted)';
                        comma.style.marginRight = '2px';
                        linkSpan.appendChild(comma);
                    }
                } else {
                    linkSpan.appendChild(document.createTextNode(`[${id}]`));
                }
            });

            fragment.appendChild(linkSpan);
            lastIndex = regex.lastIndex;
        }

        if (lastIndex < content.length) {
            fragment.appendChild(document.createTextNode(content.substring(lastIndex)));
        }

        if (fragment.childNodes.length > 0) {
            node.parentNode.replaceChild(fragment, node);
        }
    });

    return nodesToReplace.length > 0;
}

export function renderWithCitations(text, sources) {
    const safeText = String(text || '');
    const resolvedSources = mergeSources(sources, extractSources(safeText));
    const html = md.render(safeText);
    if (resolvedSources.length === 0) return html;

    const div = document.createElement('div');
    div.innerHTML = html;
    linkCitationsInElement(div, resolvedSources);

    const hasCitations = html.match(/\[\d+(?:,\s*\d+)*\]/);
    if (hasCitations && resolvedSources.length > 0) {
        const refsBlock = document.createElement('div');
        refsBlock.className = 'references-block';

        const ol = document.createElement('ol');
        resolvedSources.forEach((source, idx) => {
            const li = document.createElement('li');
            li.id = `ref-${source.id ?? idx + 1}`;
            li.value = Number(source.id) || idx + 1;

            const safeUrl = getSafeUrl(source.url);
            const faviconUrl = getFaviconUrl(safeUrl);
            if (faviconUrl) {
                const img = document.createElement('img');
                img.src = faviconUrl;
                img.className = 'ref-favicon';
                img.alt = '';
                img.loading = 'lazy';
                img.onerror = () => img.remove();
                li.appendChild(img);
            }

            const anchor = document.createElement('a');
            anchor.href = safeUrl || '#';
            anchor.textContent = source.title || source.url;
            if (safeUrl) {
                anchor.target = '_blank';
                anchor.rel = 'noopener noreferrer';
            }

            li.appendChild(anchor);
            ol.appendChild(li);
        });

        refsBlock.appendChild(ol);
        div.appendChild(refsBlock);
    }

    return div.innerHTML;
}
