/**
 * Сверка КАЖДОГО вызова клиента с контрактом: обязательное тело и параметры запроса.
 *
 * Запуск: npm run check:contract (`check:bodies` — прежнее имя, оставлено алиасом)
 *
 * 🔴 Второй класс, добавленный 11.08.2026 (SAD-205): **контракт объявляет query-параметры, а
 * передать их нечем.** Так `hwid_top_users` был зарегистрирован с пустой схемой и всегда отдавал
 * первые 5 записей при `total = 50` — ответ выглядел полным, и по нему принимались решения о
 * HWID-лимите. Тем же были сломаны `system_bandwidth_stats` (не принимал `tz`, то есть «за
 * сутки» считалось по UTC) и два метода `bandwidth-stats`, звавшие панель без обязательных
 * `start`/`end` — они возвращали 400 всегда, а тулов под них не было вовсе, так что молчали.
 * ⚠️ Причина, по которой класс проскочил трижды: прежний разбор **не видел вызовов с query
 * вообще** — путь вида `` `${REST_API.X}${this.buildQuery(p)}` `` не начинается с `REST_API`,
 * и такой вызов молча выпадал из сверки. Теперь шаблонные строки разбираются.
 *
 * Зачем отдельная проверка. Прошлая сверка со спекой (SAD-138) ловила три класса:
 * мёртвый путь, неверный HTTP-метод, непокрытый эндпоинт. Она НЕ ловила четвёртый —
 * «тело обязательно по контракту, а клиент шлёт запрос без тела». Именно так был сломан
 * `nodes_restart` (SAD-176): панель отвечала `Validation failed` без указания поля, и
 * понять причину можно было только локальным `safeParse`. Компилятор тут бессилен: тело
 * у `post()` необязательное, а панель про пропущенное поле молчит.
 *
 * Как работает:
 *   1. из контракта берутся все команды (`endpointDetails` + `url`), обязательность тела
 *      определяется фактом — `RequestBodySchema.safeParse({})`;
 *   2. из `src/client/index.ts` регуляркой выдираются вызовы `this.<verb>(путь, тело?)`;
 *      путь вычисляется по-настоящему — выражение `REST_API.…(x)` исполняется с
 *      плейсхолдером вместо аргументов;
 *   3. пути нормализуются (`:uuid` и `{uuid}` → `{}`) и сопоставляются по «метод + путь».
 *
 * Проверка намеренно ничего не знает про конкретные эндпоинты: новый сломанный вызов
 * поймается сам, без правки этого файла.
 *
 * ⚠️ Граница применимости: проверяется, что второй аргумент вызову ПЕРЕДАН, а не что метод
 * его использует. Дыру закрывает `npm run typecheck`: у `get()` тело раньше вообще не было
 * объявлено, и лишний аргумент уронил бы компиляцию. Гонять обе проверки, а не одну.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as contract from '@remnawave/backend-contract';

// от корня проекта, а НЕ от import.meta.url: esbuild кладёт бандл в node_modules/.cache,
// и относительный путь оттуда уводит в node_modules/src
const CLIENT = join(process.cwd(), 'src', 'client', 'index.ts');
const TOOLS_DIR = join(process.cwd(), 'src', 'tools');

const normalize = (path: string) => path.replace(/:[A-Za-z_]\w*/g, '{}').replace(/\{[^}]*\}/g, '{}');

/**
 * Ключи верхнего уровня у zod-объекта. Форма хранения shape менялась между версиями zod,
 * поэтому перебираем известные места, а не полагаемся на одну: не нашли — возвращаем пусто,
 * и тул просто не участвует в сверке полей (лучше промолчать, чем врать).
 */
function objectKeys(schema: any): string[] {
    if (!schema) return [];
    for (const candidate of [schema.shape, schema._def?.shape, schema.def?.shape]) {
        const shape = typeof candidate === 'function' ? candidate() : candidate;
        if (shape && typeof shape === 'object') return Object.keys(shape);
    }
    return [];
}

// --- 1. команды контракта ----------------------------------------------------
interface Command {
    name: string;
    key: string;
    requiredFields: string[];
    bodyFields: string[];
    queryFields: string[];
    /** query-поля, без которых панель отвечает 400. */
    requiredQueryFields: string[];
}

// Список, а не одна команда на ключ: у разных эндпоинтов бывает одинаковый «метод + путь»
// (`SNIPPETS.CREATE` и `SNIPPETS.DELETE` — оба POST на `/api/snippets/`). Раньше последняя
// перезаписывала первую, и отчёт приписывал тулу поля чужой команды.
const commands = new Map<string, Command[]>();

for (const [name, value] of Object.entries(contract as Record<string, any>)) {
    const details = value?.endpointDetails;
    if (!details?.REQUEST_METHOD || value.url === undefined) continue;

    // ⚠️ Плейсхолдер нужен КАЖДОМУ параметру: у `internal-squads/{squadUuid}/users/{userId}/usage`
    // их два, и вызов с одним аргументом давал путь с `undefined` в середине — команда после
    // нормализации не совпадала ни с чем, и вызов молча числился «вне контракта» (11.08.2026).
    const rawUrl =
        typeof value.url === 'function'
            ? value.url(...Array.from({ length: Math.max(value.url.length, 1) }, () => ':p'))
            : value.url;
    if (typeof rawUrl !== 'string') continue;

    // Обязательность тела определяем фактом, а не чтением схемы: пустой объект либо
    // проходит валидацию, либо нет. Так же разбирается и «какие поля не хватает» —
    // тем же способом, каким мы вскрывали безликое «Validation failed» панели.
    let requiredFields: string[] = [];
    const bodyFields = objectKeys(value.RequestBodySchema);
    const schema = value.RequestBodySchema;
    if (schema?.safeParse) {
        const parsed = schema.safeParse({});
        if (!parsed.success) {
            requiredFields = [
                ...new Set(
                    (parsed.error?.issues ?? [])
                        .map((issue: any) => String(issue.path?.[0] ?? ''))
                        .filter(Boolean),
                ),
            ];
        }
    }

    // Тем же способом — фактом, а не чтением схемы — берём обязательные query-параметры.
    const queryFields = objectKeys(value.RequestQuerySchema);
    let requiredQueryFields: string[] = [];
    const querySchema = value.RequestQuerySchema;
    if (querySchema?.safeParse) {
        const parsed = querySchema.safeParse({});
        if (!parsed.success) {
            requiredQueryFields = [
                ...new Set(
                    (parsed.error?.issues ?? [])
                        .map((issue: any) => String(issue.path?.[0] ?? ''))
                        .filter(Boolean),
                ),
            ];
        }
    }

    const key = `${String(details.REQUEST_METHOD).toUpperCase()} ${normalize(rawUrl)}`;
    commands.set(key, [
        ...(commands.get(key) ?? []),
        { name, key, requiredFields, bodyFields, queryFields, requiredQueryFields },
    ]);
}

// --- 2. вызовы клиента -------------------------------------------------------
const source = readFileSync(CLIENT, 'utf8');

/**
 * Копия текста той же длины, где содержимое строк и комментариев затёрто пробелами.
 *
 * Нужна, потому что разбор шёл по сырым символам и спотыкался на запятых внутри строк и
 * комментариев: в `describe('… host:port, null to clear')` запятая рвала аргумент на два,
 * и следующий «аргумент» начинался с середины фразы — ключ схемы после такого не опознавался.
 * Ровно так проверка не увидела только что добавленный `configProfile` и отчиталась, что его нет.
 * Позиции сохраняются один к одному, поэтому нарезать можно исходный текст по индексам маски.
 */
function maskCode(text: string): string {
    const mask = text.split('');
    let index = 0;
    while (index < text.length) {
        const char = text[index];
        const next = text[index + 1];

        if (char === '/' && next === '/') {
            while (index < text.length && text[index] !== '\n') mask[index++] = ' ';
            continue;
        }
        if (char === '/' && next === '*') {
            while (index < text.length && !(text[index] === '*' && text[index + 1] === '/')) {
                mask[index++] = ' ';
            }
            // закрывающие */ тоже затираем, иначе `/` останется значимым символом
            if (index < text.length) mask[index++] = ' ';
            if (index < text.length) mask[index++] = ' ';
            continue;
        }
        if (char === "'" || char === '"' || char === '`') {
            const quote = char;
            index++; // кавычку оставляем как есть — она не влияет на баланс скобок
            while (index < text.length && text[index] !== quote) {
                if (text[index] === '\\') mask[index++] = ' ';
                if (index < text.length) mask[index++] = ' ';
            }
            index++;
            continue;
        }
        index++;
    }
    return mask.join('');
}

/** Аргументы вызова целиком, со сбалансированными скобками. */
function readArgs(text: string, openParen: number, mask = maskCode(text)): string | null {
    let depth = 0;
    for (let i = openParen; i < text.length; i++) {
        const char = mask[i];
        if (char === '(') depth++;
        else if (char === ')') {
            depth--;
            if (depth === 0) return text.slice(openParen + 1, i);
        }
    }
    return null;
}

/** Разбить аргументы по запятым верхнего уровня. */
function splitTopLevel(args: string): string[] {
    const mask = maskCode(args);
    const parts: string[] = [];
    let depth = 0;
    let start = 0;
    for (let i = 0; i < args.length; i++) {
        const char = mask[i];
        if ('([{'.includes(char)) depth++;
        else if (')]}'.includes(char)) depth--;
        else if (char === ',' && depth === 0) {
            parts.push(args.slice(start, i));
            start = i + 1;
        }
    }
    if (args.slice(start).trim()) parts.push(args.slice(start));
    return parts.map((part) => part.trim());
}

/**
 * Вычислить путь по-настоящему, а не угадать регуляркой: выражение вида
 * `REST_API.NODES.ACTIONS.RESTART(uuid)` исполняется с реальным REST_API, а аргументы
 * подменяются плейсхолдером. Конкатенация с query-строкой отбрасывается — она не влияет
 * на маршрут.
 */
function resolvePath(expression: string): string | null {
    let expr = expression.split('+')[0].trim();

    // Шаблонная строка вида `${REST_API.X.Y(uuid)}${this.buildQuery(params)}`: сам маршрут —
    // это первая подстановка, остальное (query) на путь не влияет. Без этой ветки любой вызов
    // с query выпадал из сверки молча, и ровно поэтому класс SAD-205 жил три итерации.
    if (expr.startsWith('`')) {
        const firstSubstitution = expr.match(/\$\{([^}]*(?:\([^()]*\))?[^}]*)\}/);
        if (!firstSubstitution) return null;
        expr = firstSubstitution[1].trim();
    }

    if (!expr.startsWith('REST_API')) return null;

    expr = expr.replace(/\(([^()]*)\)/g, (_match, inner: string) => {
        const count = splitTopLevel(inner).length;
        return `(${Array.from({ length: count }, () => "':p'").join(', ')})`;
    });

    try {
        const value = new Function('REST_API', `return ${expr};`)((contract as any).REST_API);
        return typeof value === 'string' ? value : null;
    } catch {
        return null;
    }
}

interface Call {
    method: string;
    path: string;
    key: string;
    hasBody: boolean;
    /** Вызов строит query-строку — `buildQuery(...)` или руками через `?`. */
    hasQuery: boolean;
    line: number;
    /** Метод клиента, внутри которого сделан вызов — по нему тул связывается с командой. */
    clientMethod: string | null;
}

/** Имя метода клиента, в теле которого находится позиция. Ищем ближайшее объявление выше. */
function enclosingMethod(text: string, position: number): string | null {
    const declarations = [...text.slice(0, position).matchAll(/^\s{4}(?:async\s+)?(\w+)\s*\(/gm)];
    const last = declarations.at(-1);
    return last ? last[1] : null;
}

const calls: Call[] = [];
const callPattern = /this\.(get|post|patch|put|delete)(?:<[^>]*>)?\(/g;

for (const match of source.matchAll(callPattern)) {
    const openParen = match.index! + match[0].length - 1;
    const args = readArgs(source, openParen);
    if (args === null) continue;

    const parts = splitTopLevel(args);
    const path = resolvePath(parts[0] ?? '');
    if (!path) continue;

    const method = match[1].toUpperCase();
    const pathExpression = parts[0] ?? '';
    calls.push({
        method,
        path,
        key: `${method} ${normalize(path)}`,
        hasBody: parts.length > 1,
        hasQuery: /buildQuery\s*\(/.test(pathExpression) || /\?\w+=/.test(pathExpression),
        line: source.slice(0, match.index).split('\n').length,
        clientMethod: enclosingMethod(source, match.index!),
    });
}

// --- 3. отчёт ----------------------------------------------------------------
console.log(`Команд в контракте: ${commands.size}, вызовов в клиенте: ${calls.length}\n`);

const missingBody: string[] = [];
const missingQuery: string[] = [];
const unknownRoute: string[] = [];

for (const call of calls) {
    const candidates = commands.get(call.key);
    if (!candidates?.length) {
        // Метод/путь вне контракта — этот класс ловила прошлая сверка со спекой,
        // здесь он попутный: без команды судить о теле всё равно нельзя.
        unknownRoute.push(`  ${call.key}  (client/index.ts:${call.line})`);
        continue;
    }
    // Тело обязательно, если его требует хоть одна команда этого маршрута.
    const command = candidates.find((item) => item.requiredFields.length > 0) ?? candidates[0];
    if (command.requiredFields.length > 0 && !call.hasBody) {
        missingBody.push(
            `  ✗ ${call.key} — контракт требует ${command.requiredFields
                .map((field) => `\`${field}\``)
                .join(', ')}, а тело не отправляется` +
                ` (${command.name}, client/index.ts:${call.line})`,
        );
    }

    // Обязательные query-параметры: без них панель отвечает 400, то есть метод нерабочий
    // всегда — а выглядит как обычный вызов.
    const queryCommand =
        candidates.find((item) => item.requiredQueryFields.length > 0) ?? candidates[0];
    if (queryCommand.requiredQueryFields.length > 0 && !call.hasQuery) {
        missingQuery.push(
            `  ✗ ${call.key} — контракт требует в query ${queryCommand.requiredQueryFields
                .map((field) => `\`${field}\``)
                .join(', ')}, а строка запроса не собирается` +
                ` (${queryCommand.name}, client/index.ts:${call.line})`,
        );
    }
}

if (unknownRoute.length) {
    console.log(`Путей вне контракта: ${unknownRoute.length}`);
    for (const line of unknownRoute) console.log(line);
    console.log();
}

// --- 4. поля контракта, которых нет в схеме тула ------------------------------
// Класс SAD-179: тело отправляется, но схема тула перечисляет лишь часть полей, и остальные
// передать нечем. Так `nodes_update` не умел `configProfile` — перевод ноды на другой профиль
// приходилось делать прямым вызовом API, а канарейка проверяла только «ядро стартовало».
// Отчёт информационный: неполнота бывает осознанной, решать глазами.
const methodToCommand = new Map<string, Command>();
let ambiguousRoutes = 0;
for (const call of calls) {
    if (!call.clientMethod) continue;
    const candidates = commands.get(call.key);
    // Маршрут с несколькими командами пропускаем: приписать тулу поля чужой команды хуже,
    // чем промолчать. Так `snippets_delete` получал поля `CreateSnippetCommand`.
    if (candidates && candidates.length > 1) {
        ambiguousRoutes++;
        continue;
    }
    // Первый вызов в методе и есть основной: клиент — тонкие обёртки «один метод — один запрос».
    if (candidates?.length === 1 && !methodToCommand.has(call.clientMethod)) {
        methodToCommand.set(call.clientMethod, candidates[0]);
    }
}

interface ToolGap {
    tool: string;
    command: string;
    missing: string[];
    file: string;
}

const gaps: ToolGap[] = [];
const queryGaps: ToolGap[] = [];
const emptySchemas: string[] = [];
let toolsChecked = 0;
let queryToolsChecked = 0;
let reshapedBodies = 0;

// общие схемы тулов живут здесь — под ними ходят все листинги
const helpersSource = readFileSync(join(TOOLS_DIR, 'helpers.ts'), 'utf8');

for (const file of readdirSync(TOOLS_DIR).filter((name) => name.endsWith('.ts'))) {
    const text = readFileSync(join(TOOLS_DIR, file), 'utf8');

    for (const match of text.matchAll(/server\.tool(?:<[^>]*>)?\(/g)) {
        const openParen = match.index! + match[0].length - 1;
        const args = readArgs(text, openParen);
        if (args === null) continue;

        const parts = splitTopLevel(args);
        const nameLiteral = parts[0]?.match(/^['"`]([\w.-]+)['"`]$/);
        if (!nameLiteral) continue;

        // Схема — либо объект-литерал, либо ссылка на общую константу (`listQueryParams`).
        // ⚠️ Вторую форму разбор раньше не понимал и молча пропускал тул целиком: под
        // `listQueryParams` ходят все листинги, то есть ровно те тулы, где потеря пагинации и
        // страшна. Раскрываем константу — из этого же файла или из helpers.ts.
        const handlerPart = parts.find((part) => part.includes('client.'));
        if (!handlerPart) continue;

        const literalSchema = parts.find((part) => part.startsWith('{'));
        const referencedSchema = parts
            .slice(1)
            .find((part) => /^[A-Za-z_]\w*$/.test(part) && part !== 'client');
        const schemaPart =
            literalSchema ??
            (referencedSchema
                ? (() => {
                      for (const source of [text, helpersSource]) {
                          const declaration = source.match(
                              new RegExp(`const ${referencedSchema}\\s*=\\s*(\\{[\\s\\S]*?\\n\\})`),
                          );
                          if (declaration) return declaration[1];
                      }
                      return undefined;
                  })()
                : undefined);
        if (!schemaPart) continue;

        // ключи верхнего уровня схемы тула — нужны и для тела, и для query
        const schemaKeys = new Set(
            splitTopLevel(schemaPart.slice(1, -1))
                .map((entry) => {
                    // поле может быть предварено комментарием — он не часть ключа
                    const code = entry
                        .split('\n')
                        .filter((line) => !line.trim().startsWith('//'))
                        .join('\n')
                        .trim();
                    // `...period` — общий набор полей, вынесенный в константу файла
                    const spread = code.match(/^\.\.\.(\w+)$/);
                    if (spread) {
                        const constant = text.match(
                            new RegExp(`const ${spread[1]}\\s*=\\s*\\{([\\s\\S]*?)\\n\\};`),
                        );
                        return constant
                            ? splitTopLevel(constant[1])
                                  .map((field) => field.match(/^['"]?(\w+)['"]?\s*:/)?.[1])
                                  .filter(Boolean)
                                  .join(' ')
                            : undefined;
                    }
                    return code.match(/^['"]?(\w+)['"]?\s*:/)?.[1];
                })
                .filter((name): name is string => Boolean(name))
                .flatMap((name) => name.split(' ')),
        );

        // --- query-параметры: схема тула не имеет права быть пустой ------------------
        // Класс SAD-205: контракт объявляет query, а у тула пустая схема `{}` — панель молча
        // применяет дефолты, и ответ выглядит полным. Проверяем по ЛЮБОМУ вызову клиента, не
        // требуя «params передаётся как есть»: у тулов с path-параметром аргументы
        // деструктурируются (`{ uuid, ...params }`), а имена query-полей всё равно совпадают.
        const anyClientCall = handlerPart.match(/client\.(\w+)\(/);
        const queryCommand = anyClientCall ? methodToCommand.get(anyClientCall[1]) : undefined;
        if (queryCommand && queryCommand.queryFields.length > 0) {
            queryToolsChecked++;
            if (schemaKeys.size === 0) {
                emptySchemas.push(
                    `  ✗ ${nameLiteral[1]} (tools/${file}) — пустая схема, а контракт ` +
                        `${queryCommand.name} принимает ` +
                        queryCommand.queryFields.map((field) => `\`${field}\``).join(', ') +
                        ': передать их нечем, панель применит дефолты молча',
                );
            } else {
                const missing = queryCommand.queryFields.filter((field) => !schemaKeys.has(field));
                if (missing.length) {
                    queryGaps.push({
                        tool: nameLiteral[1],
                        command: queryCommand.name,
                        missing,
                        file,
                    });
                }
            }
        }

        // Сверять «поле в поле» осмысленно только если тул отдаёт params как есть. Там, где
        // обработчик сам собирает тело (`nodes_bulk_update` лепит `{uuids, fields}` из плоской
        // схемы — так удобнее вызывающему), несовпадение имён нормально, и отчёт про «нет
        // `fields`» был бы ложью.
        // Двойное условие: обработчик принимает объект схемы целиком (`async (params)`) И отдаёт
        // его в клиент как есть. Одной проверки вызова мало — `subscription_templates_update_from_file`
        // деструктурирует аргументы, а тело собирает в локальной переменной с тем же именем `params`.
        const passesThrough =
            /async\s*\(\s*params\s*[),]/.test(handlerPart) &&
            /client\.(\w+)\(\s*params\s*\)/.test(handlerPart);
        const clientCall = passesThrough ? handlerPart.match(/client\.(\w+)\(\s*params\s*\)/) : null;
        if (!clientCall) {
            reshapedBodies++;
            continue;
        }
        const command = methodToCommand.get(clientCall[1]);
        if (!command || command.bodyFields.length === 0) continue;

        toolsChecked++;
        const missing = command.bodyFields.filter((field) => !schemaKeys.has(field));
        if (missing.length) {
            gaps.push({ tool: nameLiteral[1], command: command.name, missing, file });
        }
    }
}

console.log(
    `Тулов сверено со схемой тела: ${toolsChecked}, со схемой query: ${queryToolsChecked}` +
        (reshapedBodies ? `, тело собирается вручную: ${reshapedBodies}` : '') +
        (ambiguousRoutes ? `, неоднозначный маршрут: ${ambiguousRoutes}` : ''),
);

if (queryGaps.length) {
    console.log(`\nQUERY-ПОЛЯ КОНТРАКТА, КОТОРЫХ НЕТ В СХЕМЕ ТУЛА (${queryGaps.length}):`);
    for (const gap of queryGaps.sort((a, b) => b.missing.length - a.missing.length)) {
        console.log(
            `  ${gap.tool} (${gap.command}, tools/${gap.file}) — нет: ` +
                gap.missing.map((field) => `\`${field}\``).join(', '),
        );
    }
    console.log('Это отчёт: часть параметров может быть не нужна осознанно.');
}
if (gaps.length) {
    console.log(`\nПОЛЯ КОНТРАКТА, КОТОРЫХ НЕТ В СХЕМЕ ТУЛА (${gaps.length}):`);
    for (const gap of gaps.sort((a, b) => b.missing.length - a.missing.length)) {
        console.log(
            `  ${gap.tool} (${gap.command}, tools/${gap.file}) — нет: ` +
                gap.missing.map((field) => `\`${field}\``).join(', '),
        );
    }
    console.log('\nЭто отчёт, а не провал: часть полей может быть не нужна осознанно.');
} else {
    console.log('Схемы тулов покрывают все поля тела из контракта.');
}
console.log();

const failures = [
    ['ОБЯЗАТЕЛЬНОЕ ТЕЛО НЕ ОТПРАВЛЯЕТСЯ:', missingBody],
    ['ОБЯЗАТЕЛЬНЫЕ QUERY-ПАРАМЕТРЫ НЕ ОТПРАВЛЯЮТСЯ (панель ответит 400):', missingQuery],
    ['ПУСТАЯ СХЕМА ТУЛА ПРИ QUERY-ПАРАМЕТРАХ В КОНТРАКТЕ:', emptySchemas],
] as const;

const total = failures.reduce((sum, [, lines]) => sum + lines.length, 0);
if (total > 0) {
    for (const [title, lines] of failures) {
        if (!lines.length) continue;
        console.log(title);
        for (const line of lines) console.log(line);
        console.log();
    }
    console.log(`ПРОВАЛОВ: ${total}`);
    process.exit(1);
}

console.log('Все вызовы отправляют обязательное тело и параметры, пустых схем при query нет.');
