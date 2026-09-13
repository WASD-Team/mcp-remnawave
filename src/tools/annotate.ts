import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

/**
 * Две вещи, которые дешевле сделать в ОДНОМ месте, чем в 167 вызовах `server.tool`.
 *
 * 1. АННОТАЦИИ. Без `annotations.readOnlyHint` клиент обязан считать инструмент разрушительным:
 *    в Codex `requires_mcp_tool_approval` берёт `destructive_hint.unwrap_or(true)`, поэтому
 *    подтверждения требовало ВСЁ, включая чтение, а в `codex exec` (политика `never`) чтение
 *    панели просто падало. Помечаем читающие инструменты; мутации намеренно остаются без
 *    аннотаций, то есть продолжают спрашивать.
 *    ⚠️ Аннотации — это ПОДСКАЗКИ, а не enforcement (спецификация MCP). Ручные списки
 *    подтверждений в конфигах обоих агентов снимать можно только после прогона, который
 *    покажет, что одиночная мутация всё ещё спрашивается, а новый инструмент не разрешается сам.
 *
 * 2. ВЫЧИСТКА СЕКРЕТОВ ИЗ ОТВЕТА. Панель отдаёт приватные ключи Reality прямо в теле ответа
 *    `nodes_list`, `nodes_get` и конфиг-профилей, а `JSON.stringify` клал их в расшифровку
 *    сессии целиком. Запрет «не звать сырые инструменты» держался только на тексте инструкции
 *    и обходился предодобрением. Чистим в коде — тогда обходить нечего.
 */

/** Ключи, значение которых не должно попадать в вывод ни при каких условиях. */
const SECRET_KEYS = /^(privateKey|private_key|password|secret|secretKey|apiKey|api_key|token|accessToken|refreshToken)$/i;

/**
 * Инструменты, чей СМЫСЛ — выдать секрет. Для них вычистка отключена: иначе генератор ключей
 * возвращал бы «***» и становился бесполезным.
 */
const SECRET_PRODUCERS = new Set([
    'system_generate_x25519',
    'keygen_get',
    'api_tokens_create',
]);

const READ_ONLY = [
    /_list$/, /_get$/, /_get_.+$/, /^system_/, /_stats$/, /_stats_.+$/,
    /^auth_status$/, /^inbounds_list$/, /_usage$/, /_top_users$/,
    /^subscription_info$/, /^subscriptions_get_.+$/, /_resolve$/,
    /_accessible_nodes$/, /_metadata$/, /_history_list$/, /_reports$/,
];

function isReadOnly(name: string): boolean {
    if (/(create|update|delete|enable|disable|restart|reset|revoke|bulk|add|remove|upsert|truncate|execute|reorder|clone|drop)/i.test(name)) {
        return false;
    }
    return READ_ONLY.some((re) => re.test(name));
}

function redact(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(redact);
    if (value && typeof value === 'object') {
        const out: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
            out[k] = SECRET_KEYS.test(k) && typeof v === 'string' && v.length > 0
                ? '«вычищено сервером MCP»'
                : redact(v);
        }
        return out;
    }
    return value;
}

/** Чистит текстовое содержимое ответа, если оно разбирается как JSON. Иначе оставляет как есть. */
function redactResult(result: unknown): unknown {
    const r = result as { content?: Array<{ type?: string; text?: string }> };
    if (!r || !Array.isArray(r.content)) return result;
    for (const part of r.content) {
        if (part?.type !== 'text' || typeof part.text !== 'string') continue;
        try {
            part.text = JSON.stringify(redact(JSON.parse(part.text)), null, 2);
        } catch {
            // не JSON — трогать нечего
        }
    }
    return result;
}

/**
 * Возвращает обёртку над сервером: каждый `tool(...)` получает аннотации по имени, а его
 * результат проходит вычистку. Регистрирующий код при этом не меняется ни на строку.
 */
export function withAnnotations(server: McpServer): McpServer {
    return new Proxy(server, {
        get(target, prop, receiver) {
            if (prop !== 'tool') return Reflect.get(target, prop, receiver);
            return (name: string, ...rest: unknown[]) => {
                const cb = rest.pop() as (...a: unknown[]) => unknown;
                const final = SECRET_PRODUCERS.has(name)
                    ? cb
                    : async (...args: unknown[]) => redactResult(await cb(...args));
                const annotations = isReadOnly(name) ? { readOnlyHint: true } : undefined;
                const args = annotations ? [...rest, annotations, final] : [...rest, final];
                return (target.tool as (...a: unknown[]) => unknown)(name, ...args);
            };
        },
    });
}
