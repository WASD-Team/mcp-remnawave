import { z } from 'zod';

/**
 * Параметры листингов панели (start/size/filters/sorting).
 *
 * Без них тул отдаёт первую страницу дефолтного размера (25 записей), и это
 * молча выглядит как «столько всего и есть». Панель ограничивает size 1000.
 */
export const listQueryParams = {
    start: z.number().optional().describe('Offset, default 0'),
    size: z.number().optional().describe('Page size, default 25, max 1000'),
    filters: z
        .array(
            z.object({
                id: z.string().describe('Field name to filter by'),
                value: z.string().describe('Value to match'),
            }),
        )
        .optional()
        .describe('Field filters, e.g. [{"id":"userId","value":"118"}]'),
    sorting: z
        .array(
            z.object({
                id: z.string().describe('Field name to sort by'),
                desc: z.boolean().describe('Descending order'),
            }),
        )
        .optional()
        .describe('Sort order, e.g. [{"id":"requestAt","desc":true}]'),
};

export function toolResult(data: unknown) {
    return {
        content: [
            {
                type: 'text' as const,
                text: JSON.stringify(data, null, 2),
            },
        ],
    };
}

export function toolError(error: unknown) {
    const message =
        error instanceof Error ? error.message : String(error);
    return {
        content: [
            {
                type: 'text' as const,
                text: `Error: ${message}`,
            },
        ],
        isError: true,
    };
}
