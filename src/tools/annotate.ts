import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

/**
 * Две вещи, которые дешевле сделать в ОДНОМ месте, чем в 172 вызовах регистрации.
 *
 * 1. АННОТАЦИИ. Без `annotations.readOnlyHint` клиент обязан считать инструмент разрушительным:
 *    в Codex `requires_mcp_tool_approval` берёт `destructive_hint.unwrap_or(true)`, поэтому
 *    подтверждения требовало ВСЁ, включая чтение, а в `codex exec` (политика `never`) чтение
 *    панели просто падало. Помечаем читающие инструменты; мутации намеренно остаются без
 *    аннотаций, то есть продолжают спрашивать.
 *    ⚠️ Аннотации — это ПОДСКАЗКИ, а не enforcement (спецификация MCP). Ручные списки
 *    подтверждений в конфигах обоих агентов снимать можно только после прогона, который
 *    покажет, что одиночная мутация всё ещё спрашивается, а новый инструмент не разрешается сам.
 *    ⚠️ И `isReadOnly` — РЕГУЛЯРКА ПО ИМЕНИ, а не разбор того, что инструмент делает: инструмент,
 *    названный не по конвенции, будет размечен неверно. Поэтому списки подтверждений в конфигах
 *    остаются независимой защитой, а не дублем.
 *
 * 2. ВЫЧИСТКА СЕКРЕТОВ ИЗ ОТВЕТА. Панель отдаёт приватные ключи Reality прямо в теле ответа
 *    `nodes_list`, `nodes_get`, конфиг-профилей И ресурса `remnawave://nodes`, а `JSON.stringify`
 *    клал их в расшифровку сессии целиком. Запрет «не звать сырые инструменты» держался только
 *    на тексте инструкции и обходился предодобрением. Чистим в коде — тогда обходить нечего.
 *
 * ⛔ ГРАНИЦЫ ВЫЧИСТКИ — заявлять шире, чем сделано, нельзя (разбор Codex 13.09.2026, SAD-465).
 * Чистятся: `content[].text`, `contents[].text` (ресурсы) и `structuredContent` — первые два
 * только если текст разбирается как JSON. НЕ чистятся: текст, который JSON'ом не является
 * (секрет в прозе останется), содержимое НЕ текстовых частей (image/audio/blob), и текст
 * исключения — если обработчик бросил, ответ формирует SDK мимо этой обёртки.
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

/** Чистит JSON внутри `text`. Не JSON — оставляет как есть: ломать чужой формат хуже. */
function redactTextParts(parts: unknown): void {
    if (!Array.isArray(parts)) return;
    for (const part of parts as Array<{ text?: unknown }>) {
        if (!part || typeof part.text !== 'string') continue;
        try {
            part.text = JSON.stringify(redact(JSON.parse(part.text)), null, 2);
        } catch {
            // не JSON — трогать нечего
        }
    }
}

/** Ответ инструмента (`content`, `structuredContent`) и ответ ресурса (`contents`). */
function redactResult(result: unknown): unknown {
    const r = result as { content?: unknown; contents?: unknown; structuredContent?: unknown };
    if (!r || typeof r !== 'object') return result;
    redactTextParts(r.content);
    redactTextParts(r.contents);
    if (r.structuredContent && typeof r.structuredContent === 'object') {
        r.structuredContent = redact(r.structuredContent);
    }
    return result;
}

/** Ключи аннотаций MCP — по ним узнаём аргумент, который вызывающий передал сам. */
const ANNOTATION_KEYS = new Set([
    'title', 'readOnlyHint', 'destructiveHint', 'idempotentHint', 'openWorldHint',
]);

function isAnnotations(value: unknown): boolean {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const keys = Object.keys(value as object);
    return keys.length > 0 && keys.every((k) => ANNOTATION_KEYS.has(k));
}

function wrapCallback(name: string, cb: unknown): unknown {
    if (typeof cb !== 'function') return cb;
    const fn = cb as (...a: unknown[]) => unknown;
    if (SECRET_PRODUCERS.has(name)) return fn;
    return async (...args: unknown[]) => redactResult(await fn(...args));
}

/**
 * Обёртка над сервером: каждый обработчик проходит вычистку, читающие инструменты получают
 * аннотацию. Регистрирующий код при этом не меняется ни на строку.
 *
 * 🔑 Обёрнуты ВСЕ четыре способа регистрации, какие есть у McpServer 1.27.1 — `tool`,
 * `registerTool`, `resource`, `registerResource`, — а не только `tool`. Прежняя версия знала
 * один, и `registerAllResources` ходил мимо: ресурс `remnawave://nodes` отдавал приватные ключи
 * Reality в обход вычистки (разбор Codex 13.09.2026). ⚠️ Вне обёртки остаётся правка уже
 * зарегистрированного инструмента через `RegisteredTool.update({ callback })` — так у нас никто
 * не делает, и если понадобится, вычистку придётся навесить на новый обработчик руками.
 */
export function withAnnotations(server: McpServer): McpServer {
    const WRAPPED = new Set(['tool', 'registerTool', 'resource', 'registerResource']);
    return new Proxy(server, {
        get(target, prop, receiver) {
            const value = Reflect.get(target, prop, receiver);
            // Остальные методы отдаём привязанными к настоящему серверу: вызванные на прокси,
            // они получили бы `this` = прокси, и любое обращение к внутреннему состоянию SDK
            // пошло бы через эти же ловушки.
            if (typeof prop !== 'string' || !WRAPPED.has(prop)) {
                return typeof value === 'function' ? value.bind(target) : value;
            }
            const original = value as (...a: unknown[]) => unknown;
            const annotate = prop === 'tool' || prop === 'registerTool';
            return (name: string, ...rest: unknown[]) => {
                const args = [...rest];
                args[args.length - 1] = wrapCallback(name, args[args.length - 1]);

                if (annotate && isReadOnly(name)) {
                    const hint = { readOnlyHint: true };
                    const config = args[0] as Record<string, unknown> | undefined;
                    if (prop === 'registerTool' && config && typeof config === 'object') {
                        // registerTool(name, config, cb) — аннотации живут полем конфига.
                        config.annotations = { ...(config.annotations as object ?? {}), ...hint };
                    } else if (args.length > 1 && isAnnotations(args[args.length - 2])) {
                        // Вызывающий передал свои аннотации — ДОПОЛНЯЕМ их, а не добавляем
                        // второй объект: два подряд SDK разобрал бы как аннотации и колбэк.
                        args[args.length - 2] = { ...(args[args.length - 2] as object), ...hint };
                    } else {
                        args.splice(args.length - 1, 0, hint);
                    }
                }
                return original.apply(target, [name, ...args]);
            };
        },
    });
}
