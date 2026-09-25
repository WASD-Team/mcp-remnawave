/**
 * Регрессии на запросы к панели: fetch подменён, проверяется, что именно уходит
 * в сеть. Тулзы регистрируются в фейковый server, чтобы дёргать их хендлеры.
 *
 * Ловит класс ошибок, который не видят ни компилятор, ни ответ панели:
 * частичный PATCH молча сбрасывает непереданные поля (выключенный хост
 * включался обратно), листинг без пагинации молча отдаёт первые 25 записей.
 *
 * Запуск: npm test
 */
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { RemnawaveClient } from '../src/client/index.js';
import { registerHostTools } from '../src/tools/hosts.js';
import { registerNodePluginTools } from '../src/tools/node-plugins.js';
import { registerSettingsTools } from '../src/tools/settings.js';
import { registerSquadTools } from '../src/tools/squads.js';
import { registerExternalSquadTools } from '../src/tools/external-squads.js';
import { registerNodeTools } from '../src/tools/nodes.js';
import { registerSubscriptionTools } from '../src/tools/subscriptions.js';
import { registerHwidTools } from '../src/tools/hwid.js';
import { registerSystemTools } from '../src/tools/system.js';
import { registerUserTools } from '../src/tools/users.js';
import { registerBandwidthStatsTools } from '../src/tools/bandwidth-stats.js';
import { registerInboundTools } from '../src/tools/inbounds.js';
import { registerAllResources } from '../src/resources/index.js';
import { withAnnotations } from '../src/tools/annotate.js';

type Handler = (args: any) => Promise<any>;
const handlers = new Map<string, Handler>();
const fakeServer: any = {
    tool: (name: string, _d: unknown, _s: unknown, handler: Handler) => handlers.set(name, handler),
};

const requests: { method: string; url: string; body: any }[] = [];
let nextResponse: unknown = {};

globalThis.fetch = (async (url: any, opts: any) => {
    requests.push({
        method: opts?.method,
        url: String(url),
        body: opts?.body ? JSON.parse(opts.body) : undefined,
    });
    // nextResponse === undefined изображает пустое тело: так отвечает DELETE.
    return new Response(nextResponse === undefined ? null : JSON.stringify(nextResponse), {
        status: nextResponse === undefined ? 204 : 200,
        headers: { 'content-type': 'application/json' },
    });
}) as any;

const client = new RemnawaveClient({
    baseUrl: 'https://panel.test',
    apiToken: 'test-token',
} as any);

registerHostTools(fakeServer, client, false);
registerNodePluginTools(fakeServer, client, false);
registerSettingsTools(fakeServer, client, false);
registerSquadTools(fakeServer, client, false);
registerExternalSquadTools(fakeServer, client, false);
registerNodeTools(fakeServer, client, false);
registerSubscriptionTools(fakeServer, client);
registerHwidTools(fakeServer, client, false);
registerSystemTools(fakeServer, client);
registerUserTools(fakeServer, client, false);
registerInboundTools(fakeServer, client, false);
registerBandwidthStatsTools(fakeServer, client);

let failed = 0;
function check(name: string, condition: boolean, detail = '') {
    console.log(`${condition ? '  ok  ' : '  ПРОВАЛ'} ${name}${detail ? ' — ' + detail : ''}`);
    if (!condition) failed++;
}

// --- 1. hosts_update не должен терять поля, которых нет в вызове -------------
const HOST = {
    uuid: 'host-1',
    viewPosition: 7,
    remark: 'Amsterdam (RU-relay)',
    address: 'rw-node-07.infra.overgear.in',
    port: 10444,
    isDisabled: true,
    tags: ['GENERAL'],
    securityLayer: 'DEFAULT',
    sockoptParams: { tcpKeepAliveIdle: 5 },
    inbound: { configProfileUuid: 'cp-1', configProfileInboundUuid: 'in-1' },
    nodes: ['node-1'],
    excludedInternalSquads: ['squad-1'],
    excludeFromSubscriptionTypes: [],
};

requests.length = 0;
nextResponse = { response: HOST };
await handlers.get('hosts_update')!({ uuid: 'host-1', remark: 'Amsterdam (RU-relay) [2]' });

const [read, write] = requests;
console.log('\n1. hosts_update — обновляем один remark у выключенного хоста');
check('сперва читает хост', read?.method === 'GET' && read.url.endsWith('/api/hosts/host-1'), read?.url);
check('isDisabled сохранён', write?.body?.isDisabled === true, `пришло ${JSON.stringify(write?.body?.isDisabled)}`);
check('remark обновлён', write?.body?.remark === 'Amsterdam (RU-relay) [2]');
check('tags сохранены', JSON.stringify(write?.body?.tags) === '["GENERAL"]');
check('inbound сохранён', write?.body?.inbound?.configProfileUuid === 'cp-1');
check('nodes сохранены', JSON.stringify(write?.body?.nodes) === '["node-1"]');
check('sockoptParams сохранены', write?.body?.sockoptParams?.tcpKeepAliveIdle === 5);
check('viewPosition не отправлен', !('viewPosition' in (write?.body ?? {})));

// --- 2. tags вместо tag ------------------------------------------------------
console.log('\n2. hosts_create/update — тег массивом');
requests.length = 0;
nextResponse = { response: HOST };
await handlers.get('hosts_create')!({
    remark: 'test', address: 'a', port: 443,
    configProfileUuid: 'cp-1', configProfileInboundUuid: 'in-1',
    tags: ['GENERAL'],
});
check('create шлёт tags массивом', JSON.stringify(requests[0]?.body?.tags) === '["GENERAL"]');
check('create не шлёт tag строкой', !('tag' in (requests[0]?.body ?? {})));

requests.length = 0;
nextResponse = { response: HOST };
await handlers.get('hosts_update')!({ uuid: 'host-1', tags: ['DEVELOPERS'] });
check('update шлёт tags массивом', JSON.stringify(requests[1]?.body?.tags) === '["DEVELOPERS"]');

// --- 3. node_plugins_update принимает pluginConfig ---------------------------
console.log('\n3. node_plugins_update — конфиг плагина');
const PLUGIN = {
    uuid: 'plugin-1', viewPosition: 0, name: 'General',
    pluginConfig: { torrentBlocker: { enabled: true, blockDuration: 900 } },
};
requests.length = 0;
nextResponse = { response: PLUGIN };
await handlers.get('node_plugins_update')!({
    uuid: 'plugin-1',
    pluginConfig: { torrentBlocker: { enabled: true, blockDuration: 1800 } },
});
check('pluginConfig доходит', requests[1]?.body?.pluginConfig?.torrentBlocker?.blockDuration === 1800);
check('name не затёрт', requests[1]?.body?.name === 'General');
check('viewPosition не отправлен', !('viewPosition' in (requests[1]?.body ?? {})));

requests.length = 0;
nextResponse = { response: PLUGIN };
await handlers.get('node_plugins_update')!({ uuid: 'plugin-1', name: 'General 2' });
check('переименование не сносит pluginConfig', requests[1]?.body?.pluginConfig?.torrentBlocker?.blockDuration === 900);

// --- 4. листинги: пагинация и фильтры ---------------------------------------
console.log('\n4. Листинги — start/size/filters/sorting уходят в query');
requests.length = 0;
nextResponse = { response: { total: 0, devices: [] } };
await client.getAllHwidDevices({ size: 1000, filters: [{ id: 'platform', value: 'Windows' }] });
const hwidUrl = decodeURIComponent(requests[0].url);
check('size в query', hwidUrl.includes('size=1000'), hwidUrl);
check('filters JSON-строкой', hwidUrl.includes('filters=[{"id":"platform","value":"Windows"}]'));

requests.length = 0;
nextResponse = { response: { total: 0, records: [] } };
await client.getSubscriptionRequestHistory({
    size: 5,
    filters: [{ id: 'userId', value: '118' }],
    sorting: [{ id: 'requestAt', desc: true }],
});
const histUrl = decodeURIComponent(requests[0].url);
check('фильтр по userId в query', histUrl.includes('filters=[{"id":"userId","value":"118"}]'), histUrl);
check('sorting в query', histUrl.includes('sorting=[{"id":"requestAt","desc":true}]'));

requests.length = 0;
nextResponse = { response: {} };
await client.getAllHwidDevices();
check('без параметров query пустой', !requests[0].url.includes('?'), requests[0].url);

// --- 5. subscription_settings_update не сносит правила SRR ------------------
console.log('\n5. subscription_settings_update — частичная правка');
const SETTINGS = {
    uuid: 'settings-1',
    serveJsonAtBaseSubscription: false,
    isShowCustomRemarks: true,
    customRemarks: { expired: ['Подписка истекла'] },
    customResponseHeaders: { announce: 'старый текст' },
    randomizeHosts: false,
    responseRules: { rules: [{ name: 'Happ' }, { name: 'Mihomo' }] },
    hwidSettings: { maxDevices: 10 },
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-08-01T00:00:00Z',
};
requests.length = 0;
nextResponse = { response: SETTINGS };
await handlers.get('subscription_settings_update')!({
    customResponseHeaders: { announce: 'новый текст' },
});
const settingsWrite = requests[1];
check('сперва читает настройки', requests[0]?.method === 'GET');
check('заголовок обновлён', settingsWrite?.body?.customResponseHeaders?.announce === 'новый текст');
check('правила SRR сохранены', settingsWrite?.body?.responseRules?.rules?.length === 2);
check('customRemarks сохранены', !!settingsWrite?.body?.customRemarks?.expired);
check('hwidSettings сохранены', settingsWrite?.body?.hwidSettings?.maxDevices === 10);
check('uuid отправлен', settingsWrite?.body?.uuid === 'settings-1');
check('createdAt/updatedAt не отправлены',
    !('createdAt' in (settingsWrite?.body ?? {})) && !('updatedAt' in (settingsWrite?.body ?? {})));

// --- 6. сквады: поштучно ≠ «весь парк» --------------------------------------
// add-users/remove-users в 3.x означают «все пользователи панели» и тела не
// принимают. Слать туда список — молча раздать доступ всему парку.
console.log('\n6. Сквады — поштучные действия отделены от действий над всем парком');
requests.length = 0;
nextResponse = { response: {} };
await handlers.get('squads_add_users')!({ squadUuid: 'squad-1', userIds: [118] });
check('add идёт на add-many-users', requests[0]?.url.endsWith('/bulk-actions/add-many-users'), requests[0]?.url);
check('add методом POST', requests[0]?.method === 'POST');
check('userIds числами в теле', JSON.stringify(requests[0]?.body) === '{"userIds":[118]}', JSON.stringify(requests[0]?.body));

requests.length = 0;
await handlers.get('squads_remove_users')!({ squadUuid: 'squad-1', userIds: [118] });
check('remove идёт на remove-many-users', requests[0]?.url.endsWith('/bulk-actions/remove-many-users'), requests[0]?.url);
check('remove методом DELETE', requests[0]?.method === 'DELETE', `пришло ${requests[0]?.method}`);
check('userIds числами в теле', JSON.stringify(requests[0]?.body) === '{"userIds":[118]}');

requests.length = 0;
await handlers.get('squads_add_all_users')!({ squadUuid: 'squad-1' });
check('«весь парк» идёт на add-users без тела',
    requests[0]?.url.endsWith('/bulk-actions/add-users') && requests[0]?.body === undefined, requests[0]?.url);

requests.length = 0;
await handlers.get('squads_remove_all_users')!({ squadUuid: 'squad-1' });
check('«весь парк» remove — DELETE на remove-users',
    requests[0]?.method === 'DELETE' && requests[0]?.url.endsWith('/bulk-actions/remove-users'));

requests.length = 0;
await handlers.get('external_squads_remove_all_users')!({ squadUuid: 'ext-1' });
check('внешний сквад: remove методом DELETE', requests[0]?.method === 'DELETE', `пришло ${requests[0]?.method}`);

check('поштучных тулзов для внешних сквадов нет',
    !handlers.has('external_squads_add_users') && !handlers.has('external_squads_remove_users'));

// --- 7. пустой ответ на DELETE не должен выглядеть как ошибка ---------------
console.log('\n7. DELETE с пустым телом');
requests.length = 0;
nextResponse = undefined;
const deleted = await handlers.get('hosts_delete')!({ uuid: 'host-1' });
check('удаление не падает на разборе ответа', deleted?.isError !== true,
    JSON.stringify(deleted?.content?.[0]?.text ?? '').slice(0, 80));
check('запрос всё-таки ушёл', requests[0]?.method === 'DELETE');
nextResponse = {};

// --- 8. обязательное тело запроса (SAD-176) ---------------------------------
// Класс ошибки: панель отвечает безликим «Validation failed», тул выглядит сломанным
// целиком, а не хватает одного поля. Автоматическая сверка всех вызовов с контрактом —
// npm run check:bodies; здесь фиксируется ровно то, что уходит в сеть.
console.log('\n8. обязательное тело запроса');
requests.length = 0;
await handlers.get('nodes_restart')!({ uuid: 'node-1', forceRestart: true });
check('restart идёт POST на actions/restart',
    requests[0]?.method === 'POST' && requests[0]?.url.endsWith('/nodes/node-1/actions/restart'),
    `${requests[0]?.method} ${requests[0]?.url}`);
check('forceRestart уходит в теле', JSON.stringify(requests[0]?.body) === '{"forceRestart":true}',
    JSON.stringify(requests[0]?.body));

requests.length = 0;
await handlers.get('nodes_restart')!({ uuid: 'node-1', forceRestart: false });
check('forceRestart:false не теряется и не подменяется',
    JSON.stringify(requests[0]?.body) === '{"forceRestart":false}', JSON.stringify(requests[0]?.body));

requests.length = 0;
await handlers.get('nodes_restart_all')!({ forceRestart: false });
check('restart_all тоже посылает тело',
    JSON.stringify(requests[0]?.body) === '{"forceRestart":false}', JSON.stringify(requests[0]?.body));

// GET с телом — так объявлено в контракте и так реализовано в панели: заголовки идут
// в матчер правил SRR. Без тела приходило «Validation failed». Подменённый fetch тут не
// годится: настоящий fetch тело у GET отвергает сам, и тест, ловивший вызов fetch,
// показывал зелёное при сломанном туле. Поэтому — живой локальный сервер.
const seen: { method?: string; body: string; auth?: string }[] = [];
const panel = createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => (raw += chunk));
    req.on('end', () => {
        seen.push({ method: req.method, body: raw, auth: req.headers.authorization });
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ response: { subpageConfigUuid: null, webpageAllowed: true } }));
    });
});
await new Promise<void>((resolve) => panel.listen(0, '127.0.0.1', resolve));
const { port } = panel.address() as AddressInfo;
const realTransportTools = new Map<string, Handler>();
registerSubscriptionTools({
    tool: (name: string, _d: unknown, _s: unknown, handler: Handler) => realTransportTools.set(name, handler),
} as any, new RemnawaveClient({ baseUrl: `http://127.0.0.1:${port}`, apiToken: 'test-token' } as any));

const noHeaders = await realTransportTools.get('subscriptions_get_subpage_config')!({ shortUuid: 'short-1' });
check('subpage-config: GET с телом реально уходит в сеть',
    !noHeaders?.isError && seen[0]?.method === 'GET' && seen[0]?.body === '{"requestHeaders":{}}',
    `${seen[0]?.method} ${seen[0]?.body} ${noHeaders?.isError ? JSON.stringify(noHeaders).slice(0, 120) : ''}`);
check('и с авторизацией', seen[0]?.auth === 'Bearer test-token');

const withUa = await realTransportTools.get('subscriptions_get_subpage_config')!({
    shortUuid: 'short-1',
    requestHeaders: { 'user-agent': 'FlClash X/v0.4.2' },
});
check('переданные заголовки доходят до панели',
    seen[1]?.body === '{"requestHeaders":{"user-agent":"FlClash X/v0.4.2"}}', seen[1]?.body);
check('ответ панели разобран',
    JSON.stringify(withUa).includes('webpageAllowed'), JSON.stringify(withUa).slice(0, 120));
panel.close();

// --- 9. детали ошибки валидации не должны терятьcя ---------------------------
// Панель присылает разбор в `errors`, а клиент брал только `message` — и «Validation failed»
// приходилось расшифровывать локальным safeParse. Ответ ниже — реальный, снят с панели.
console.log('\n9. детали ошибки валидации');
const realFetch = globalThis.fetch;
globalThis.fetch = (async () =>
    new Response(
        JSON.stringify({
            statusCode: 400,
            message: 'Validation failed',
            errors: [
                {
                    expected: 'boolean',
                    code: 'invalid_type',
                    path: ['forceRestart'],
                    message: 'Invalid input: expected boolean, received undefined',
                },
            ],
        }),
        { status: 400, headers: { 'content-type': 'application/json' } },
    )) as any;

const failedRestart = await handlers.get('nodes_restart')!({ uuid: 'node-1', forceRestart: true });
const errorText = String(failedRestart?.content?.[0]?.text ?? '');
check('в тексте ошибки видно поле', errorText.includes('forceRestart'), errorText.slice(0, 120));
check('и ожидаемый тип', errorText.includes('boolean'));
globalThis.fetch = realFetch;

// --- 10. параметры запроса доходят до панели (SAD-205) -----------------------
// Класс: тул зарегистрирован с пустой схемой, панель молча применяет дефолты, и ответ
// выглядит полным. `hwid_top_users` отдавал 5 записей при total = 50, и по этой верхушке
// принимались решения о HWID-лимите. Сплошную сверку с контрактом делает
// `npm run check:contract`; здесь фиксируется, что параметры реально уходят в query.
console.log('\n10. query-параметры листингов и статистики');
requests.length = 0;
nextResponse = { response: { users: [], total: 0 } };
await handlers.get('hwid_top_users')!({ size: 100 });
check('hwid_top_users шлёт size в query', decodeURIComponent(requests[0]?.url ?? '').includes('size=100'),
    requests[0]?.url);

requests.length = 0;
await handlers.get('hwid_top_users')!({});
check('без параметров query пустой (дефолты панели)', !requests[0]?.url.includes('?'), requests[0]?.url);

requests.length = 0;
nextResponse = { response: {} };
await handlers.get('system_bandwidth_stats')!({ tz: 'Europe/Moscow' });
check('system_bandwidth_stats шлёт tz', decodeURIComponent(requests[0]?.url ?? '').includes('tz=Europe/Moscow'),
    requests[0]?.url);

requests.length = 0;
nextResponse = { response: { routes: [], total: 0 } };
await handlers.get('system_stats_http')!({});
check('system_stats_http идёт на /system/stats/http',
    requests[0]?.url.endsWith('/api/system/stats/http'), requests[0]?.url);

// Обязательные start/end: без них панель отвечает 400, поэтому в схеме они не optional.
requests.length = 0;
nextResponse = { response: {} };
await handlers.get('bandwidth_nodes_usage')!({ start: '2026-08-01', end: '2026-08-11' });
const bwUrl = decodeURIComponent(requests[0]?.url ?? '');
check('bandwidth_nodes_usage шлёт период', bwUrl.includes('start=2026-08-01') && bwUrl.includes('end=2026-08-11'), bwUrl);

requests.length = 0;
await handlers.get('bandwidth_squad_user_usage')!({
    squadUuid: 'squad-1', userId: '118', start: '2026-08-01', end: '2026-08-11',
});
check('bandwidth_squad_user_usage: оба пути-параметра на месте',
    requests[0]?.url.includes('/internal-squads/squad-1/users/118/usage'), requests[0]?.url);

requests.length = 0;
nextResponse = { response: { userId: 118, activeNodes: [] } };
await handlers.get('users_accessible_nodes')!({ userId: '118' });
check('users_accessible_nodes идёт на accessible-nodes',
    requests[0]?.url.endsWith('/api/users/118/accessible-nodes'), requests[0]?.url);

requests.length = 0;
nextResponse = { response: { total: 0, users: [] } };
await handlers.get('users_list')!({ filters: [{ id: 'status', value: 'ACTIVE' }], filterModes: { status: 'equals' } });
const usersUrl = decodeURIComponent(requests[0]?.url ?? '');
check('users_list шлёт фильтры и режим сопоставления',
    usersUrl.includes('filters=[{"id":"status","value":"ACTIVE"}]') && usersUrl.includes('filterModes={"status":"equals"}'),
    usersUrl);


// --- Аннотации и вычистка секретов (SAD-465) --------------------------------
// Обёртка `withAnnotations` делает две вещи в одном месте: помечает читающие инструменты
// `readOnlyHint` и вырезает секреты из ответа. Обе проверяются здесь, потому что молчащая
// обёртка неотличима от работающей: ключи просто снова поедут в расшифровку сессии.
const annHandlers = new Map<string, Handler>();
const annMeta = new Map<string, any>();
const annServer: any = {
    tool: (name: string, ...rest: any[]) => {
        const handler = rest.pop();
        const maybeAnn = rest[rest.length - 1];
        annMeta.set(name, maybeAnn && typeof maybeAnn === 'object' && 'readOnlyHint' in maybeAnn ? maybeAnn : undefined);
        annHandlers.set(name, handler);
    },
};
registerNodeTools(withAnnotations(annServer), client, false);
registerSystemTools(withAnnotations(annServer), client);

check('читающий инструмент помечен readOnlyHint',
    annMeta.get('nodes_list')?.readOnlyHint === true, JSON.stringify(annMeta.get('nodes_list')));
check('мутация НЕ помечена readOnlyHint — значит продолжает спрашивать',
    annMeta.get('nodes_update') === undefined, JSON.stringify(annMeta.get('nodes_update')));

nextResponse = { response: [{ uuid: 'n1', name: 'ru1', privateKey: 'СЕКРЕТ-КЛЮЧ-REALITY' }] };
const listed = await annHandlers.get('nodes_list')!({});
check('приватный ключ вычищен из ответа',
    !JSON.stringify(listed).includes('СЕКРЕТ-КЛЮЧ-REALITY'), String(listed?.content?.[0]?.text).slice(0, 90));
check('остальные поля ответа не пострадали',
    JSON.stringify(listed).includes('ru1'));

nextResponse = { response: [{ uuid: 'n1', name: 'ru1',
    vlessUuid: 'VLESS-ЧЕЛОВЕКА', trojanPassword: 'TROJAN-ЧЕЛОВЕКА', ssPassword: 'SS-ЧЕЛОВЕКА' }] };
const creds = JSON.stringify(await annHandlers.get('nodes_list')!({}));
check('учётные данные подключения пользователя вычищены',
    !/VLESS-ЧЕЛОВЕКА|TROJAN-ЧЕЛОВЕКА|SS-ЧЕЛОВЕКА/.test(creds), creds.slice(0, 120));

nextResponse = { response: { privateKey: 'ЭТОТ-КЛЮЧ-НУЖЕН', publicKey: 'pub' } };
const gen = await annHandlers.get('system_generate_x25519')!({});
check('генератор ключей НЕ вычищается — иначе он бесполезен',
    JSON.stringify(gen).includes('ЭТОТ-КЛЮЧ-НУЖЕН'));

// --- Вычистка за пределами `content[].text` (разбор Codex 13.09.2026) -------
// Прежняя обёртка знала ровно один способ регистрации (`tool`) и ровно одно место в ответе
// (`content[].text`). Мимо шли РЕСУРСЫ: `remnawave://nodes` отдавал приватные ключи Reality
// целиком. Ниже — по одной проверке на каждую дыру, которую это открывало.
const resHandlers = new Map<string, Handler>();
const resServer: any = {
    tool: () => {},
    resource: (name: string, ...rest: any[]) => resHandlers.set(name, rest.pop()),
    prompt: () => {},
};
registerAllResources(withAnnotations(resServer), client);

nextResponse = { response: [{ uuid: 'n1', name: 'ru1', privateKey: 'КЛЮЧ-ИЗ-РЕСУРСА' }] };
const nodesResource = await resHandlers.get('panel-nodes')!();
check('ресурс remnawave://nodes тоже вычищается',
    !JSON.stringify(nodesResource).includes('КЛЮЧ-ИЗ-РЕСУРСА'),
    String(nodesResource?.contents?.[0]?.text).slice(0, 80));
check('и остальные поля ресурса на месте',
    JSON.stringify(nodesResource).includes('ru1'));

// Шаблон объявляет {uuid}; прежний код читал params.userId и слал в панель undefined.
requests.length = 0;
nextResponse = { response: { uuid: 'u-1', username: 'ivan' } };
await resHandlers.get('user-details')!({ href: 'remnawave://users/u-1' }, { uuid: 'u-1' });
check('ресурс user-details берёт uuid из шаблона, а не несуществующий userId',
    requests[0]?.url.endsWith('/api/users/u-1'), requests[0]?.url);

// structuredContent — отдельная ветка ответа, JSON.stringify кладёт её в расшифровку так же.
const structHandlers = new Map<string, Handler>();
const structServer: any = {
    tool: (name: string, ...rest: any[]) => structHandlers.set(name, rest.pop()),
};
const wrapped = withAnnotations(structServer);
(wrapped as any).tool('probe_get', 'проба', {}, async () => ({
    content: [{ type: 'text', text: 'не JSON, трогать нечего' }],
    structuredContent: { privateKey: 'КЛЮЧ-В-STRUCTURED', name: 'ru1' },
}));
const structured = await structHandlers.get('probe_get')!({});
check('structuredContent вычищается наравне с content',
    !JSON.stringify(structured).includes('КЛЮЧ-В-STRUCTURED'), JSON.stringify(structured?.structuredContent));
check('не-JSON текст обёртка не ломает',
    String(structured?.content?.[0]?.text) === 'не JSON, трогать нечего');

// Аннотации вызывающего обёртка ДОПОЛНЯЕТ. Добавь она второй объект — SDK разобрал бы его
// как аннотации, а прежние аннотации как схему параметров.
const mergeMeta = new Map<string, any>();
const mergeServer: any = {
    tool: (name: string, ...rest: any[]) => {
        rest.pop();
        mergeMeta.set(name, rest[rest.length - 1]);
    },
};
(withAnnotations(mergeServer) as any).tool('probe_get', 'проба', {}, { title: 'Проба' }, async () => ({}));
check('свои аннотации вызывающего не затираются и не удваиваются',
    mergeMeta.get('probe_get')?.title === 'Проба' && mergeMeta.get('probe_get')?.readOnlyHint === true,
    JSON.stringify(mergeMeta.get('probe_get')));

// ─── заливка конфига с заглушкой вычистки должна ОТКАЗАТЬ ────────────────────────────────
// 🔴 Класс отказа, ради которого проверка существует: у модели единственный способ править
// тело конфига — прочитать профиль и залить обратно, а читается он уже без приватных ключей.
// Заливка такого конфига записала бы «вычищено сервером MCP» вместо ключа Reality и положила
// бы маскировку на всём парке. Проверяем и отказ, и то, что в сеть при этом НИЧЕГО не ушло.
requests.length = 0;
const redactedConfig = {
    inbounds: [
        { tag: 'reality-nl', streamSettings: { realitySettings: { privateKey: '«вычищено сервером MCP»' } } },
    ],
};
const refused = await handlers.get('config_profiles_update')!({
    uuid: '00000000-0000-0000-0000-000000000001',
    config: redactedConfig,
});
check('заливка вычищенного конфига отказывает',
    refused?.isError === true && /вычищено сервером MCP/.test(JSON.stringify(refused)),
    JSON.stringify(refused).slice(0, 120));
check('при отказе в панель не ушло ни одного запроса',
    requests.length === 0, `запросов: ${requests.length}`);

// Чистый конфиг проходит — иначе проверка заблокировала бы штатную работу.
requests.length = 0;
nextResponse = { response: { uuid: 'p1' } };
await handlers.get('config_profiles_update')!({
    uuid: '00000000-0000-0000-0000-000000000001',
    config: { inbounds: [{ tag: 'reality-nl', streamSettings: { realitySettings: { privateKey: 'настоящий-ключ' } } }] },
});
check('конфиг без заглушек заливается как раньше',
    requests.length === 1 && requests[0].method === 'PATCH',
    JSON.stringify(requests[0]?.method));

console.log(failed === 0 ? '\nВСЕ ПРОВЕРКИ ПРОЙДЕНЫ' : `\nПРОВАЛОВ: ${failed}`);
process.exit(failed === 0 ? 0 : 1);
