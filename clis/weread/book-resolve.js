import { ArgumentError, CommandExecutionError, EmptyResultError } from '@jackwener/opencli/errors';
import { WEREAD_UA, WEREAD_WEB_ORIGIN } from './utils.js';

export function decodeHtmlText(value) {
    return String(value || '')
        .replace(/<[^>]+>/g, '')
        .replace(/&#x([0-9a-fA-F]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)))
        .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&quot;/g, '"')
        .trim();
}

export function normalizeSearchText(value) {
    return String(value || '').replace(/\s+/g, ' ').trim();
}

export function normalizePositiveInteger(value, defaultValue, label, maxValue) {
    const raw = value ?? defaultValue;
    const n = Number(raw);
    if (!Number.isInteger(n) || n <= 0) {
        throw new ArgumentError(`${label} must be a positive integer`);
    }
    if (maxValue != null && n > maxValue) {
        throw new ArgumentError(`${label} must be <= ${maxValue}`);
    }
    return n;
}

export function normalizeRequiredString(value, label) {
    const text = normalizeSearchText(value);
    if (!text) {
        throw new ArgumentError(`${label} is required`);
    }
    return text;
}

export async function fetchJson(url, label) {
    let resp;
    try {
        resp = await fetch(url.toString(), {
            headers: { 'User-Agent': WEREAD_UA },
        });
    }
    catch (error) {
        throw new CommandExecutionError(`${label} request failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!resp.ok) {
        throw new CommandExecutionError(`${label} request failed: HTTP ${resp.status}`);
    }
    try {
        return await resp.json();
    }
    catch {
        throw new CommandExecutionError(`${label} returned invalid JSON`);
    }
}

export async function fetchText(url, label) {
    let resp;
    try {
        resp = await fetch(url.toString(), {
            headers: { 'User-Agent': WEREAD_UA },
        });
    }
    catch (error) {
        throw new CommandExecutionError(`${label} request failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!resp.ok) {
        throw new CommandExecutionError(`${label} request failed: HTTP ${resp.status}`);
    }
    return resp.text();
}

function buildReaderUrlFromInfoId(infoId) {
    const text = normalizeSearchText(infoId);
    return text ? `${WEREAD_WEB_ORIGIN}/web/reader/${text}` : '';
}

export function extractReaderInitialState(html) {
    const marker = 'window.__INITIAL_STATE__=';
    const start = html.indexOf(marker);
    if (start < 0)
        return null;
    const jsonStart = start + marker.length;
    const cleanupStart = html.indexOf(';(function(){var s;', jsonStart);
    const scriptEnd = html.indexOf('</script>', jsonStart);
    const jsonEnd = cleanupStart >= 0 ? cleanupStart : scriptEnd;
    if (jsonEnd < 0)
        return null;
    try {
        return JSON.parse(html.slice(jsonStart, jsonEnd));
    }
    catch {
        return null;
    }
}

function extractJsonLdBookInfo(html) {
    const match = html.match(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/i);
    if (!match)
        return {};
    try {
        const data = JSON.parse(match[1]);
        const info = {};
        info.bookId = normalizeSearchText(data?.['@Id']);
        info.title = normalizeSearchText(data?.name);
        info.author = normalizeSearchText(data?.author?.name);
        info.readerUrl = normalizeSearchText(data?.url);
        return info;
    }
    catch {
        return {};
    }
}

export function parseReaderMetadata(html, readerUrl) {
    const state = extractReaderInitialState(html);
    const reader = state?.reader ?? {};
    const info = reader.bookInfo ?? {};
    const jsonLd = extractJsonLdBookInfo(html);
    const chapters = Array.isArray(reader.chapterInfos) ? reader.chapterInfos : [];
    const infoId = normalizeSearchText(reader.infoId) || normalizeSearchText(info.encodeId);
    const metadata = {};
    metadata.bookId = normalizeSearchText(info.bookId) || normalizeSearchText(reader.bookId) || jsonLd.bookId;
    metadata.title = normalizeSearchText(info.title) || jsonLd.title;
    metadata.author = normalizeSearchText(info.author) || jsonLd.author;
    metadata.readerUrl = normalizeSearchText(readerUrl) || buildReaderUrlFromInfoId(infoId) || jsonLd.readerUrl;
    metadata.chapters = chapters;
    return metadata;
}

async function loadReaderMetadata(readerUrl) {
    if (!readerUrl)
        return null;
    const html = await fetchText(readerUrl, 'WeRead reader page');
    const metadata = parseReaderMetadata(html, readerUrl);
    return metadata.bookId ? metadata : null;
}

export function parseSearchHtmlEntries(html) {
    const items = Array.from(html.matchAll(/<li[^>]*class="wr_bookList_item"[^>]*>([\s\S]*?)<\/li>/g));
    return items.map((match) => {
        const chunk = match[1];
        const hrefMatch = chunk.match(/<a[^>]*href="([^"]+)"[^>]*class="wr_bookList_item_link"[^>]*>|<a[^>]*class="wr_bookList_item_link"[^>]*href="([^"]+)"[^>]*>/);
        const titleMatch = chunk.match(/<p[^>]*class="wr_bookList_item_title"[^>]*>([\s\S]*?)<\/p>/);
        const authorMatch = chunk.match(/<p[^>]*class="wr_bookList_item_author"[^>]*>([\s\S]*?)<\/p>/);
        const href = hrefMatch?.[1] || hrefMatch?.[2] || '';
        const entry = {};
        entry.title = decodeHtmlText(titleMatch?.[1] || '');
        entry.author = decodeHtmlText(authorMatch?.[1] || '');
        entry.readerUrl = href ? new URL(href, WEREAD_WEB_ORIGIN).toString() : '';
        return entry;
    }).filter((entry) => entry.title && entry.readerUrl);
}

async function loadSearchHtmlEntries(bookQuery) {
    const url = new URL('/web/search/books', WEREAD_WEB_ORIGIN);
    url.searchParams.set('keyword', bookQuery);
    return parseSearchHtmlEntries(await fetchText(url, 'WeRead search page'));
}

export function resolveReaderUrlForBook(book, htmlEntries) {
    const title = normalizeSearchText(book.title);
    const author = normalizeSearchText(book.author);
    if (!title)
        return '';
    if (author) {
        const exact = htmlEntries.filter((entry) => normalizeSearchText(entry.title) === title && normalizeSearchText(entry.author) === author);
        if (exact.length === 1)
            return exact[0].readerUrl;
    }
    const sameTitle = htmlEntries.filter((entry) => normalizeSearchText(entry.title) === title);
    return sameTitle.length === 1 ? sameTitle[0].readerUrl : '';
}

async function searchBookByQuery(bookQuery, bookRank, commandName) {
    const url = new URL('/web/search/global', `${WEREAD_WEB_ORIGIN}/web`);
    url.searchParams.set('keyword', bookQuery);
    const data = await fetchJson(url, 'WeRead book search');
    const books = Array.isArray(data?.books) ? data.books : [];
    if (books.length === 0) {
        throw new EmptyResultError(commandName, `No WeRead books found for "${bookQuery}"`);
    }
    if (bookRank > books.length) {
        throw new ArgumentError(`book-rank must be <= ${books.length}`, `Only ${books.length} book search result(s) were returned for "${bookQuery}"`);
    }
    const bookInfo = books[bookRank - 1]?.bookInfo ?? {};
    const selected = {
        bookId: normalizeSearchText(bookInfo.bookId),
        title: normalizeSearchText(bookInfo.title),
        author: normalizeSearchText(bookInfo.author),
        readerUrl: '',
        chapters: [],
    };
    if (!selected.bookId) {
        throw new EmptyResultError(commandName, `The selected book for "${bookQuery}" has no bookId`);
    }
    const htmlEntries = await loadSearchHtmlEntries(bookQuery);
    selected.readerUrl = resolveReaderUrlForBook(selected, htmlEntries);
    const readerMetadata = await loadReaderMetadata(selected.readerUrl);
    return {
        ...selected,
        ...Object.fromEntries(Object.entries(readerMetadata ?? {}).filter(([, value]) => value != null && value !== '' && !(Array.isArray(value) && value.length === 0))),
    };
}

export async function resolveBookTarget(target, bookRank, commandName = 'weread book') {
    if (/^https?:\/\//i.test(target)) {
        const metadata = await loadReaderMetadata(target);
        if (!metadata?.bookId) {
            throw new EmptyResultError(commandName, 'Could not parse a bookId from the reader URL');
        }
        return metadata;
    }
    if (/^\d+$/.test(target)) {
        const metadata = {};
        metadata.bookId = target;
        metadata.title = '';
        metadata.author = '';
        metadata.readerUrl = '';
        metadata.chapters = [];
        return metadata;
    }
    return searchBookByQuery(target, bookRank, commandName);
}
