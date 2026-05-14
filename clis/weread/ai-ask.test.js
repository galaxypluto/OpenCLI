import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getRegistry } from '@jackwener/opencli/registry';
import './ai-ask.js';

function jsonResponse(body, status = 200) {
    return {
        ok: status >= 200 && status < 300,
        status,
        json: () => Promise.resolve(body),
    };
}

function textResponse(body, status = 200) {
    return {
        ok: status >= 200 && status < 300,
        status,
        text: () => Promise.resolve(body),
    };
}

function readerHtml({ bookId = 'book-1', title = '史记', author = '司马迁', chapters = [] } = {}) {
    const state = {
        reader: {
            infoId: 'reader-1',
            bookId,
            bookInfo: { bookId, title, author, encodeId: 'reader-1' },
            chapterInfos: chapters,
        },
    };
    return `
      <html>
        <head>
          <script type="application/ld+json">{"@Id":"${bookId}","name":"${title}","author":{"name":"${author}"},"url":"https://weread.qq.com/web/reader/reader-1"}</script>
        </head>
        <body>
          <script>window.__INITIAL_STATE__=${JSON.stringify(state)};(function(){var s;(s=document.currentScript).parentNode.removeChild(s);}());</script>
        </body>
      </html>
    `;
}

function mockPage() {
    return {
        getCookies: vi.fn(async (query) => {
            if (query?.domain)
                return [{ name: 'wr_name', value: 'alice', domain: '.weread.qq.com' }];
            return [{ name: 'wr_vid', value: 'vid123', domain: 'weread.qq.com' }];
        }),
    };
}

describe('weread/ai-ask', () => {
    const command = getRegistry().get('weread/ai-ask');

    beforeEach(() => {
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
    });

    it('registers ai-ask with markdown default output', () => {
        expect(command?.defaultFormat).toBe('md');
    });

    it('resolves a book by title and polls WeRead AI until the final answer', async () => {
        expect(command?.func).toBeTypeOf('function');
        const page = mockPage();
        const fetchMock = vi.fn()
            .mockResolvedValueOnce(jsonResponse({
            books: [
                { bookInfo: { title: '史记', author: '司马迁', bookId: 'book-1' } },
            ],
        }))
            .mockResolvedValueOnce(textResponse(`
          <li class="wr_bookList_item">
            <a class="wr_bookList_item_link" href="/web/reader/reader-1"></a>
            <p class="wr_bookList_item_title">史记</p>
            <p class="wr_bookList_item_author">司马迁</p>
          </li>
        `))
            .mockResolvedValueOnce(textResponse(readerHtml({
            bookId: 'book-1',
            title: '史记',
            author: '司马迁',
            chapters: [{ chapterUid: 7, title: '卷一 五帝本纪第一' }],
        })))
            .mockResolvedValueOnce(jsonResponse({
            errcode: 0,
            chatid: 'chat-1',
            session_id: 'session-1',
            request_interval: 0,
            result: { text: '', has_more: 1 },
            thinking_result: { text: '<think>hidden</think>', has_more: 1 },
        }))
            .mockResolvedValueOnce(jsonResponse({
            errcode: 0,
            chatid: 'chat-1',
            session_id: 'session-1',
            result: { text: '《史记》是一部贯通古今的纪传体通史<citation idx="1"></citation>。', has_more: 0 },
            thinking_result: { text: '<think>hidden</think>', has_more: 0 },
            extra_sections: {
                sections: [
                    {
                        content: JSON.stringify([
                            { title: '史记导读', content: '介绍《史记》的体例和历史范围。' },
                        ]),
                    },
                ],
            },
        }));
        vi.stubGlobal('fetch', fetchMock);

        const result = await command.func(page, { book: '史记', question: '这本书讲什么？', 'book-rank': 1 });

        const firstAiBody = JSON.parse(fetchMock.mock.calls[3][1].body);
        expect(fetchMock.mock.calls[3][0]).toBe('https://weread.qq.com/web/ai/proxy');
        expect(firstAiBody).toMatchObject({
            path: '/ai/chatv2',
            method: 'POST',
            params: {
                query: '这本书讲什么？',
                chatid: '',
                session_id: '',
                bookId: 'book-1',
                weread_opt: { current_chapter_uid: 7, query_context: '' },
            },
        });
        expect(JSON.parse(fetchMock.mock.calls[4][1].body).params).toMatchObject({
            chatid: 'chat-1',
            session_id: 'session-1',
        });
        expect(fetchMock.mock.calls[3][1].headers.Cookie).toBe('wr_name=alice; wr_vid=vid123');
        expect(result).toEqual([
            {
                markdown: [
                    '# AI 问书: 史记',
                    '- author: 司马迁',
                    '- book_id: `book-1`',
                    '- chapter_uid: 7',
                    '- question: 这本书讲什么？',
                    '- url: https://weread.qq.com/web/reader/reader-1',
                    '',
                    '《史记》是一部贯通古今的纪传体通史[1]。',
                    '',
                    '## Citations',
                    '1. 史记导读',
                    '   介绍《史记》的体例和历史范围。',
                ].join('\n'),
            },
        ]);
        expect(result[0].markdown).not.toContain('<think>');
    });

    it('returns structured raw output without exposing thinking_result text', async () => {
        expect(command?.func).toBeTypeOf('function');
        const page = mockPage();
        vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(jsonResponse({
            errcode: 0,
            chatid: 'chat-raw',
            session_id: 'session-raw',
            result: { text: 'answer', has_more: 0 },
            thinking_result: { text: '<think>hidden</think>', has_more: 0 },
        })));

        const result = await command.func(page, { book: '12345', question: '问题', raw: true });

        expect(result).toEqual([
            expect.objectContaining({
                book_id: '12345',
                question: '问题',
                answer: 'answer',
                chat_id: 'chat-raw',
                session_id: 'session-raw',
            }),
        ]);
        expect(result[0]).not.toHaveProperty('thinking_result');
        expect(result[0]).not.toHaveProperty('thinking');
    });

    it('maps unsupported or membership-gated AI responses to COMMAND_EXEC', async () => {
        expect(command?.func).toBeTypeOf('function');
        const page = mockPage();
        vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(jsonResponse({ errcode: 10000 })));

        await expect(command.func(page, { book: '12345', question: '问题' })).rejects.toMatchObject({
            code: 'COMMAND_EXEC',
            message: 'WeRead AI Ask rejected the request for /ai/chatv2: errcode 10000',
        });
    });
});
