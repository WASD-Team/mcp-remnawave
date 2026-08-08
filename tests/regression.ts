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
import { RemnawaveClient } from '../src/client/index.js';
import { registerHostTools } from '../src/tools/hosts.js';
import { registerNodePluginTools } from '../src/tools/node-plugins.js';
import { registerSettingsTools } from '../src/tools/settings.js';
import { registerSquadTools } from '../src/tools/squads.js';
import { registerExternalSquadTools } from '../src/tools/external-squads.js';

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
    return new Response(JSON.stringify(nextResponse), {
        status: 200,
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

console.log(failed === 0 ? '\nВСЕ ПРОВЕРКИ ПРОЙДЕНЫ' : `\nПРОВАЛОВ: ${failed}`);
process.exit(failed === 0 ? 0 : 1);
