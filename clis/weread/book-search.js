import { cli, Strategy } from '@jackwener/opencli/registry';
import { EmptyResultError } from '@jackwener/opencli/errors';
import { WEREAD_WEB_ORIGIN } from './utils.js';
import {
    extractReaderInitialState,
    fetchJson,
    normalizePositiveInteger,
    normalizeRequiredString,
    normalizeSearchText,
    parseReaderMetadata,
    parseSearchHtmlEntries,
    resolveBookTarget,
    resolveReaderUrlForBook,
} from './book-resolve.js';

const MAX_LIMIT = 100;
const MAX_FRAGMENT_SIZE = 500;
const SEARCH_PAGE_SIZE = 50;

async function searchWithinBook(bookId, query, limit, fragmentSize) {
    const rows = [];
    let maxIdx = 0;
    while (rows.length < limit) {
        const remaining = limit - rows.length;
        const pageSize = remaining < SEARCH_PAGE_SIZE ? remaining : SEARCH_PAGE_SIZE;
        const url = new URL('/web/book/search', WEREAD_WEB_ORIGIN);
        url.searchParams.set('bookId', bookId);
        url.searchParams.set('keyword', query);
        url.searchParams.set('maxIdx', String(maxIdx));
        url.searchParams.set('count', String(pageSize));
        url.searchParams.set('fragmentSize', String(fragmentSize));
        url.searchParams.set('onlyCount', '0');
        const data = await fetchJson(url, 'WeRead in-book search');
        const result = Array.isArray(data?.result) ? data.result : [];
        if (result.length === 0)
            break;
        rows.push(...result);
        const lastSearchIdx = Number(result[result.length - 1]?.searchIdx);
        if (!Number.isFinite(lastSearchIdx) || lastSearchIdx <= maxIdx)
            break;
        maxIdx = lastSearchIdx;
        if (Number(data?.hasMore) !== 1)
            break;
    }
    if (rows.length === 0) {
        throw new EmptyResultError('weread book-search', `No matches for "${query}" in book ${bookId}`);
    }
    return rows.slice(0, limit);
}

function buildChapterMap(chapters) {
    const map = new Map();
    for (const chapter of chapters) {
        const chapterUid = Number(chapter?.chapterUid);
        if (!Number.isFinite(chapterUid))
            continue;
        map.set(chapterUid, {
            chapterIdx: Number.isFinite(Number(chapter?.chapterIdx)) ? Number(chapter.chapterIdx) : null,
            chapterTitle: normalizeSearchText(chapter?.title),
        });
    }
    return map;
}

function buildRows(book, matches) {
    const chapterMap = buildChapterMap(book.chapters ?? []);
    return matches.map((item, index) => {
        const chapterUid = Number(item?.chapterUid);
        const chapter = chapterMap.get(chapterUid) ?? {};
        const resultChapterIdx = Number(item?.chapterIdx);
        const chapterIdx = chapter.chapterIdx ?? (Number.isFinite(resultChapterIdx) ? resultChapterIdx : null);
        return {
            rank: index + 1,
            book_title: book.title || null,
            author: book.author || null,
            chapter_idx: chapterIdx,
            chapter_title: chapter.chapterTitle || null,
            snippet: normalizeSearchText(item?.abstract),
            search_idx: Number(item?.searchIdx) || index + 1,
            chapter_uid: Number.isFinite(chapterUid) ? chapterUid : null,
            book_id: book.bookId,
            url: book.readerUrl || null,
        };
    });
}

function formatMarkdownResults(book, query, rows) {
    const title = book.title || `WeRead book ${book.bookId}`;
    const lines = [`# ${title}`];
    if (book.author)
        lines.push(`- author: ${book.author}`);
    lines.push(`- book_id: \`${book.bookId}\``);
    lines.push(`- query: \`${query}\``);
    lines.push(`- matches: ${rows.length}`);
    if (book.readerUrl)
        lines.push(`- url: ${book.readerUrl}`);
    lines.push('');
    for (const row of rows) {
        const chapterLabel = row.chapter_title || `chapter ${row.chapter_uid ?? ''}`.trim();
        lines.push(`## ${row.rank}. ${chapterLabel}`);
        const details = [];
        if (row.chapter_idx !== null)
            details.push(`chapter_idx: ${row.chapter_idx}`);
        if (row.chapter_uid !== null)
            details.push(`chapter_uid: ${row.chapter_uid}`);
        details.push(`search_idx: ${row.search_idx}`);
        lines.push('');
        lines.push(`> ${row.snippet}`);
        lines.push('');
        for (const detail of details) {
            lines.push(`- ${detail}`);
        }
        if (row.rank < rows.length)
            lines.push('');
    }
    return lines.join('\n');
}

cli({
    site: 'weread',
    name: 'book-search',
    access: 'read',
    description: 'Search within a WeRead book after resolving it by title',
    domain: 'weread.qq.com',
    strategy: Strategy.PUBLIC,
    browser: false,
    defaultFormat: 'md',
    args: [
        { name: 'book', positional: true, required: true, help: 'Book title keyword, numeric bookId, or reader URL' },
        { name: 'query', positional: true, required: true, help: 'Keyword to search inside the selected book' },
        { name: 'book-rank', type: 'int', default: 1, help: 'Which book search result to use when book is a title keyword' },
        { name: 'limit', type: 'int', default: 20, help: 'Max in-book matches to return (1-100)' },
        { name: 'fragment-size', type: 'int', default: 150, help: 'Snippet length around each match (1-500)' },
        { name: 'raw', type: 'boolean', default: false, help: 'Output structured rows instead of markdown text' },
    ],
    func: async (args) => {
        const bookTarget = normalizeRequiredString(args.book, 'book');
        const query = normalizeRequiredString(args.query, 'query');
        const bookRank = normalizePositiveInteger(args['book-rank'], 1, 'book-rank');
        const limit = normalizePositiveInteger(args.limit, 20, 'limit', MAX_LIMIT);
        const fragmentSize = normalizePositiveInteger(args['fragment-size'], 150, 'fragment-size', MAX_FRAGMENT_SIZE);
        const book = await resolveBookTarget(bookTarget, bookRank, 'weread book-search');
        const matches = await searchWithinBook(book.bookId, query, limit, fragmentSize);
        const rows = buildRows(book, matches);
        if (Boolean(args.raw))
            return rows;
        return [{ markdown: formatMarkdownResults(book, query, rows) }];
    },
});

export const __test__ = {
    buildRows,
    extractReaderInitialState,
    formatMarkdownResults,
    parseReaderMetadata,
    parseSearchHtmlEntries,
    resolveReaderUrlForBook,
};
