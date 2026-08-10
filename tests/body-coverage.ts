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
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as contract from '@remnawave/backend-contract';

// от корня проекта, а НЕ от import.meta.url: esbuild кладёт бандл в node_modules/.cache,
// и относительный путь оттуда уводит в node_modules/src
const CLIENT = join(process.cwd(), 'src', 'client', 'index.ts');

const normalize = (path: string) => path.replace(/:[A-Za-z_]\w*/g, '{}').replace(/\{[^}]*\}/g, '{}');

// --- 1. команды контракта ----------------------------------------------------
interface Command {
    name: string;
    key: string;
    requiredFields: string[];
}

const commands = new Map<string, Command>();

for (const [name, value] of Object.entries(contract as Record<string, any>)) {
    const details = value?.endpointDetails;
    if (!details?.REQUEST_METHOD || value.url === undefined) continue;

    const rawUrl = typeof value.url === 'function' ? value.url(':p') : value.url;
    if (typeof rawUrl !== 'string') continue;

    // Обязательность тела определяем фактом, а не чтением схемы: пустой объект либо
    // проходит валидацию, либо нет. Так же разбирается и «какие поля не хватает» —
    // тем же способом, каким мы вскрывали безликое «Validation failed» панели.
    let requiredFields: string[] = [];
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
    commands.set(key, { name, key, requiredFields });
}

// --- 2. вызовы клиента -------------------------------------------------------
const source = readFileSync(CLIENT, 'utf8');

/** Аргументы вызова целиком, со сбалансированными скобками. */
function readArgs(text: string, openParen: number): string | null {
    let depth = 0;
    for (let i = openParen; i < text.length; i++) {
        const char = text[i];
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
    const parts: string[] = [];
    let depth = 0;
    let current = '';
    for (const char of args) {
        if ('([{'.includes(char)) depth++;
        else if (')]}'.includes(char)) depth--;
        if (char === ',' && depth === 0) {
            parts.push(current);
            current = '';
            continue;
        }
        current += char;
    }
    if (current.trim()) parts.push(current);
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
    });
}

// --- 3. отчёт ----------------------------------------------------------------
console.log(`Команд в контракте: ${commands.size}, вызовов в клиенте: ${calls.length}\n`);

const missingBody: string[] = [];
const unknownRoute: string[] = [];

for (const call of calls) {
    const command = commands.get(call.key);
    if (!command) {
        // Метод/путь вне контракта — этот класс ловила прошлая сверка со спекой,
        // здесь он попутный: без команды судить о теле всё равно нельзя.
        unknownRoute.push(`  ${call.key}  (client/index.ts:${call.line})`);
        continue;
    }
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

if (missingBody.length) {
    console.log('ОБЯЗАТЕЛЬНОЕ ТЕЛО НЕ ОТПРАВЛЯЕТСЯ:');
    for (const line of missingBody) console.log(line);
    console.log(`\nПРОВАЛОВ: ${missingBody.length}`);
    process.exit(1);
}

console.log('Все вызовы с обязательным телом его отправляют.');
