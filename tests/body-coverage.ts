/**
 * Сверка КАЖДОГО вызова клиента с обязательными полями тела в контракте.
 *
 * Запуск: npm run check:bodies
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
}

// Список, а не одна команда на ключ: у разных эндпоинтов бывает одинаковый «метод + путь»
// (`SNIPPETS.CREATE` и `SNIPPETS.DELETE` — оба POST на `/api/snippets/`). Раньше последняя
// перезаписывала первую, и отчёт приписывал тулу поля чужой команды.
const commands = new Map<string, Command[]>();

for (const [name, value] of Object.entries(contract as Record<string, any>)) {
    const details = value?.endpointDetails;
    if (!details?.REQUEST_METHOD || value.url === undefined) continue;

    const rawUrl = typeof value.url === 'function' ? value.url(':p') : value.url;
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

    const key = `${String(details.REQUEST_METHOD).toUpperCase()} ${normalize(rawUrl)}`;
    commands.set(key, [...(commands.get(key) ?? []), { name, key, requiredFields, bodyFields }]);
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
    calls.push({
        method,
        path,
        key: `${method} ${normalize(path)}`,
        hasBody: parts.length > 1,
        line: source.slice(0, match.index).split('\n').length,
        clientMethod: enclosingMethod(source, match.index!),
    });
}

// --- 3. отчёт ----------------------------------------------------------------
console.log(`Команд в контракте: ${commands.size}, вызовов в клиенте: ${calls.length}\n`);

const missingBody: string[] = [];
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
let toolsChecked = 0;
let reshapedBodies = 0;

for (const file of readdirSync(TOOLS_DIR).filter((name) => name.endsWith('.ts'))) {
    const text = readFileSync(join(TOOLS_DIR, file), 'utf8');

    for (const match of text.matchAll(/server\.tool(?:<[^>]*>)?\(/g)) {
        const openParen = match.index! + match[0].length - 1;
        const args = readArgs(text, openParen);
        if (args === null) continue;

        const parts = splitTopLevel(args);
        const nameLiteral = parts[0]?.match(/^['"`]([\w.-]+)['"`]$/);
        if (!nameLiteral) continue;

        // схема — первый аргумент-объект; до него идут имя и (обычно) описание
        const schemaPart = parts.find((part) => part.startsWith('{'));
        const handlerPart = parts.find((part) => part.includes('client.'));
        if (!schemaPart || !handlerPart) continue;

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

        // ключи верхнего уровня схемы тула
        const inner = schemaPart.slice(1, -1);
        const toolFields = new Set(
            splitTopLevel(inner)
                .map((entry) => {
                    // поле может быть предварено комментарием — он не часть ключа
                    const code = entry
                        .split('\n')
                        .filter((line) => !line.trim().startsWith('//'))
                        .join('\n')
                        .trim();
                    return code.match(/^['"]?(\w+)['"]?\s*:/)?.[1];
                })
                .filter((name): name is string => Boolean(name)),
        );

        toolsChecked++;
        const missing = command.bodyFields.filter((field) => !toolFields.has(field));
        if (missing.length) {
            gaps.push({ tool: nameLiteral[1], command: command.name, missing, file });
        }
    }
}

console.log(
    `Тулов сверено со схемой тела: ${toolsChecked}` +
        (reshapedBodies ? `, тело собирается вручную: ${reshapedBodies}` : '') +
        (ambiguousRoutes ? `, неоднозначный маршрут: ${ambiguousRoutes}` : ''),
);
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

if (missingBody.length) {
    console.log('ОБЯЗАТЕЛЬНОЕ ТЕЛО НЕ ОТПРАВЛЯЕТСЯ:');
    for (const line of missingBody) console.log(line);
    console.log(`\nПРОВАЛОВ: ${missingBody.length}`);
    process.exit(1);
}

console.log('Все вызовы с обязательным телом его отправляют.');
