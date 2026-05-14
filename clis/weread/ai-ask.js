import { cli, Strategy } from '@jackwener/opencli/registry';
import { AuthRequiredError, CommandExecutionError, EmptyResultError, TimeoutError } from '@jackwener/opencli/errors';
import { WEREAD_DOMAIN, WEREAD_UA, WEREAD_WEB_ORIGIN } from './utils.js';
import { normalizePositiveInteger, normalizeRequiredString, normalizeSearchText, resolveBookTarget } from './book-resolve.js';

const AI_PROXY_URL = `${WEREAD_WEB_ORIGIN}/web/ai/proxy`;
const MAX_TIMEOUT_SECONDS = 180;
const DEFAULT_TIMEOUT_SECONDS = 45;
const DEFAULT_CHAPTER_UID = 1;
const MAX_POLLS = 120;
const MAX_CITATION_EXCERPT = 240;
const NO_CITATION_ITEMS = Object.freeze([]);

function buildCookieHeader(cookies) {
    return cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join('; ');
}

async function getWereadCookieHeader(page) {
    const [apiCookies, domainCookies] = await Promise.all([
        page.getCookies({ url: AI_PROXY_URL }),
        page.getCookies({ domain: WEREAD_DOMAIN }),
    ]);
    const merged = new Map();
    for (const cookie of domainCookies)
        merged.set(cookie.name, cookie);
    for (const cookie of apiCookies)
        merged.set(cookie.name, cookie);
    return buildCookieHeader(Array.from(merged.values()));
}

function getAiErrorCode(data) {
    const code = data?.errcode ?? data?.errCode;
    return code == null ? null : Number(code);
}

function throwForAiError(data, path) {
    const code = getAiErrorCode(data);
    if (code == null || code === 0)
        return;
    if (code === -2010 || code === -2012) {
        throw new AuthRequiredError(WEREAD_DOMAIN, 'Not logged in to WeRead');
    }
    if (code === 10000 || code === -2513) {
        throw new CommandExecutionError(
            `WeRead AI Ask rejected the request for ${path}: errcode ${code}`,
            'AI 问书 may require paid membership, a supported book, or opening the feature once in WeRead first',
        );
    }
    const message = normalizeSearchText(data?.errmsg || data?.errMsg || `WeRead AI error ${code}`);
    throw new CommandExecutionError(`${path} failed: ${message}`);
}

async function postAiProxyWithCookies(page, path, params) {
    const cookieHeader = await getWereadCookieHeader(page);
    let resp;
    try {
        resp = await fetch(AI_PROXY_URL, {
            method: 'POST',
            headers: {
                'User-Agent': WEREAD_UA,
                'Accept': 'application/json, text/plain, */*',
                'Content-Type': 'application/json',
                'Origin': WEREAD_WEB_ORIGIN,
                'Referer': `${WEREAD_WEB_ORIGIN}/`,
                ...(cookieHeader ? { 'Cookie': cookieHeader } : {}),
            },
            body: JSON.stringify({
                path,
                method: 'POST',
                params,
                timeout: 5000,
            }),
        });
    }
    catch (error) {
        throw new CommandExecutionError(`${path} request failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    let data;
    try {
        data = await resp.json();
    }
    catch {
        throw new CommandExecutionError(`${path} returned invalid JSON`, 'WeRead may have returned an HTML error page');
    }
    if (resp.status === 401) {
        throw new AuthRequiredError(WEREAD_DOMAIN, 'Not logged in to WeRead');
    }
    if (!resp.ok) {
        throw new CommandExecutionError(`${path} request failed: HTTP ${resp.status}`);
    }
    throwForAiError(data, path);
    return data;
}

function getInitialChapterUid(book) {
    const chapters = Array.isArray(book.chapters) ? book.chapters : [];
    for (const chapter of chapters) {
        const uid = Number(chapter?.chapterUid);
        if (Number.isInteger(uid) && uid > 0)
            return uid;
    }
    return DEFAULT_CHAPTER_UID;
}

function normalizeCitationExcerpt(value) {
    const text = normalizeSearchText(value);
    if (text.length <= MAX_CITATION_EXCERPT)
        return text;
    return `${text.slice(0, MAX_CITATION_EXCERPT)}...`;
}

function parseCitationContent(content) {
    if (typeof content !== 'string' || !content.trim())
        return NO_CITATION_ITEMS;
    try {
        const parsed = JSON.parse(content);
        if (Array.isArray(parsed))
            return parsed;
    }
    catch {
        return [{ content }];
    }
    return NO_CITATION_ITEMS;
}

function parseExtraSections(extraSections) {
    const sections = Array.isArray(extraSections?.sections) ? extraSections.sections : NO_CITATION_ITEMS;
    const citations = [];
    for (const section of sections) {
        const items = parseCitationContent(section?.content);
        for (const item of items) {
            const title = normalizeSearchText(item?.title);
            const excerpt = normalizeCitationExcerpt(item?.content || item?.abstract || item?.text);
            if (!title && !excerpt)
                continue;
            citations.push({
                index: citations.length + 1,
                title: title || null,
                excerpt: excerpt || null,
                url: normalizeSearchText(item?.url) || null,
            });
        }
    }
    return citations;
}

function normalizeAnswerMarkdown(text) {
    return String(text || '')
        .replace(/<citation\s+idx=['"]?(\d+)['"]?\s*><\/citation>/gi, '[$1]')
        .replace(/\r\n/g, '\n')
        .replace(/\s+\n/g, '\n')
        .trim();
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function askBookAi(page, book, question, chapterUid, timeoutSeconds) {
    let chatId = '';
    let sessionId = '';
    let latest = null;
    let completed = false;
    const deadline = Date.now() + timeoutSeconds * 1000;
    for (let poll = 0; poll < MAX_POLLS; poll++) {
        if (Date.now() > deadline) {
            throw new TimeoutError('weread ai-ask', timeoutSeconds);
        }
        const data = await postAiProxyWithCookies(page, '/ai/chatv2', {
            query: question,
            chatid: chatId,
            session_id: sessionId,
            accept_text_type: 1,
            bookId: book.bookId,
            weread_opt: {
                current_chapter_uid: chapterUid,
                query_context: '',
            },
            isPlugin: false,
            scene: 1,
        });
        latest = data;
        chatId = normalizeSearchText(data?.chatid) || chatId;
        sessionId = normalizeSearchText(data?.session_id) || sessionId;
        const resultHasMore = Number(data?.result?.has_more) === 1;
        const thinkingHasMore = Number(data?.thinking_result?.has_more) === 1;
        if (!resultHasMore && !thinkingHasMore) {
            completed = true;
            break;
        }
        const interval = Number(data?.request_interval);
        await sleep(Number.isFinite(interval) && interval >= 0 ? interval : 100);
    }
    if (!completed) {
        throw new TimeoutError('weread ai-ask', timeoutSeconds);
    }
    const answer = normalizeAnswerMarkdown(latest?.result?.text);
    if (!answer) {
        throw new EmptyResultError('weread ai-ask', 'WeRead AI returned an empty answer');
    }
    return {
        book_title: book.title || null,
        author: book.author || null,
        book_id: book.bookId,
        reader_url: book.readerUrl || null,
        chapter_uid: chapterUid,
        question,
        answer,
        citations: parseExtraSections(latest?.extra_sections),
        chat_id: chatId || null,
        session_id: sessionId || null,
    };
}

function formatMarkdownResult(result) {
    const title = result.book_title || `WeRead book ${result.book_id}`;
    const lines = [`# AI 问书: ${title}`];
    if (result.author)
        lines.push(`- author: ${result.author}`);
    lines.push(`- book_id: \`${result.book_id}\``);
    lines.push(`- chapter_uid: ${result.chapter_uid}`);
    lines.push(`- question: ${result.question}`);
    if (result.reader_url)
        lines.push(`- url: ${result.reader_url}`);
    lines.push('');
    lines.push(result.answer);
    if (result.citations.length > 0) {
        lines.push('');
        lines.push('## Citations');
        for (const citation of result.citations) {
            const label = citation.title || `Citation ${citation.index}`;
            lines.push(`${citation.index}. ${label}`);
            if (citation.excerpt)
                lines.push(`   ${citation.excerpt}`);
            if (citation.url)
                lines.push(`   ${citation.url}`);
        }
    }
    return lines.join('\n');
}

cli({
    site: 'weread',
    name: 'ai-ask',
    access: 'read',
    description: 'Ask WeRead AI about a book resolved by title, bookId, or reader URL',
    domain: WEREAD_DOMAIN,
    strategy: Strategy.COOKIE,
    defaultFormat: 'md',
    columns: undefined,
    args: [
        { name: 'book', positional: true, required: true, help: 'Book title keyword, numeric bookId, or reader URL' },
        { name: 'question', positional: true, required: true, help: 'Question to ask WeRead AI about the selected book' },
        { name: 'book-rank', type: 'int', default: 1, help: 'Which book search result to use when book is a title keyword' },
        { name: 'chapter-uid', type: 'int', help: 'Reader chapter UID to seed the AI context (defaults to the first known chapter, or 1)' },
        { name: 'timeout', type: 'int', default: DEFAULT_TIMEOUT_SECONDS, help: 'Max seconds to wait for the AI answer (1-180)' },
        { name: 'raw', type: 'boolean', default: false, help: 'Output structured fields instead of markdown text' },
    ],
    func: async (page, args) => {
        const bookTarget = normalizeRequiredString(args.book, 'book');
        const question = normalizeRequiredString(args.question, 'question');
        const bookRank = normalizePositiveInteger(args['book-rank'], 1, 'book-rank');
        const timeoutSeconds = normalizePositiveInteger(args.timeout, DEFAULT_TIMEOUT_SECONDS, 'timeout', MAX_TIMEOUT_SECONDS);
        const book = await resolveBookTarget(bookTarget, bookRank, 'weread ai-ask');
        const chapterUid = args['chapter-uid'] == null
            ? getInitialChapterUid(book)
            : normalizePositiveInteger(args['chapter-uid'], DEFAULT_CHAPTER_UID, 'chapter-uid');
        const result = await askBookAi(page, book, question, chapterUid, timeoutSeconds);
        if (Boolean(args.raw))
            return [result];
        return [{ markdown: formatMarkdownResult(result) }];
    },
});

export const __test__ = {
    formatMarkdownResult,
    normalizeAnswerMarkdown,
    parseExtraSections,
};
