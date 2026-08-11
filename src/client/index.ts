import { REST_API } from '@remnawave/backend-contract';
import { Config } from '../config.js';

export class RemnawaveClient {
    private baseUrl: string;
    private headers: Record<string, string>;

    constructor(config: Config) {
        this.baseUrl = config.baseUrl;
        this.headers = {
            Authorization: `Bearer ${config.apiToken}`,
            'Content-Type': 'application/json',
        };
        if (config.apiKey) {
            this.headers['X-Api-Key'] = config.apiKey;
        }
        if (config.cfAccessClientId) {
            this.headers['CF-Access-Client-Id'] = config.cfAccessClientId;
        }
        if (config.cfAccessClientSecret) {
            this.headers['CF-Access-Client-Secret'] = config.cfAccessClientSecret;
        }
    }

    private async request<T = unknown>(
        method: string,
        path: string,
        body?: unknown,
    ): Promise<T> {
        const url = `${this.baseUrl}${path}`;
        const options: RequestInit = {
            method,
            headers: this.headers,
        };
        if (body !== undefined) {
            options.body = JSON.stringify(body);
        }
        const res = await fetch(url, options);
        if (!res.ok) {
            let errorMessage: string;
            try {
                const errorBody = (await res.json()) as {
                    message?: string;
                    errors?: { path?: unknown[]; message?: string; expected?: string }[];
                };
                errorMessage = errorBody.message || JSON.stringify(errorBody);
                // ⚠️ Панель ПРИСЫЛАЕТ разбор ошибок валидации в `errors` (поле, ожидаемый тип),
                // а мы раньше брали только `message` — и получали безликое «Validation failed»,
                // из-за которого приходилось воспроизводить проверку локальным safeParse.
                // Детали были в ответе всё это время. Проверено на живой панели 10.08.2026:
                // restart без тела → errors: [{ path: ['forceRestart'], expected: 'boolean' }].
                if (Array.isArray(errorBody.errors) && errorBody.errors.length > 0) {
                    const details = errorBody.errors
                        .map((issue) => {
                            const field = Array.isArray(issue.path) ? issue.path.join('.') : '';
                            const expected = issue.expected ? ` (expected ${issue.expected})` : '';
                            return `${field || '?'}${expected}: ${issue.message ?? ''}`.trim();
                        })
                        .join('; ');
                    errorMessage = `${errorMessage} — ${details}`;
                }
            } catch {
                errorMessage = `HTTP ${res.status} ${res.statusText}`;
            }
            throw new Error(`Remnawave API error: ${errorMessage}`);
        }
        // На DELETE панель отвечает пустым телом. Безусловный res.json() падал
        // на нём с «Unexpected end of JSON input», и удавшееся удаление
        // выглядело как ошибка — при том что объект уже был удалён.
        const text = await res.text();
        return (text ? JSON.parse(text) : null) as T;
    }

    // body у GET — не блажь: контракт панели требует тело у GET subpage-config
    // (заголовки для матчинга правил SRR). Остальные GET'ы вызывают без него.
    private async get<T = unknown>(path: string, body?: unknown): Promise<T> {
        return this.request<T>('GET', path, body);
    }

    /**
     * Query-строка для листингов панели (start/size/filters/sorting).
     * Скалярные значения идут как есть, объекты и массивы — JSON'ом: фильтры и
     * сортировка объявлены в контракте как JSON-строка, которую панель парсит.
     */
    private buildQuery(params: Record<string, unknown>): string {
        const search = new URLSearchParams();
        for (const [key, value] of Object.entries(params)) {
            if (value === undefined || value === null) continue;
            search.set(
                key,
                typeof value === 'object' ? JSON.stringify(value) : String(value),
            );
        }
        const query = search.toString();
        return query ? `?${query}` : '';
    }

    private async post<T = unknown>(path: string, body?: unknown): Promise<T> {
        return this.request<T>('POST', path, body);
    }

    private async patch<T = unknown>(
        path: string,
        body?: unknown,
    ): Promise<T> {
        return this.request<T>('PATCH', path, body);
    }

    private async put<T = unknown>(path: string, body?: unknown): Promise<T> {
        return this.request<T>('PUT', path, body);
    }

    private async delete<T = unknown>(path: string, body?: unknown): Promise<T> {
        return this.request<T>('DELETE', path, body);
    }

    // Users

    // filters/sorting панель принимает JSON-строкой в query — это единственный способ
    // искать людей по полю (например `status`) без выгрузки всего парка страницами.
    async getUsers(params: Record<string, unknown> = {}) {
        return this.get(`${REST_API.USERS.GET}${this.buildQuery(params)}`);
    }

    async getUserById(userId: string) {
        return this.get(REST_API.USERS.GET_BY_ID(userId));
    }

    async getUserByUsername(username: string) {
        return this.get(REST_API.USERS.GET_BY.USERNAME(username));
    }

    async getUserSubscriptionRequestHistory(userId: string) {
        return this.get(REST_API.USERS.SUBSCRIPTION_REQUEST_HISTORY(userId));
    }

    // Какие ноды реально доступны человеку, с разбивкой по сквадам и инбаундам.
    // Закрывает вопрос «почему у него нет этой локации» без ручного обхода сквадов.
    async getUserAccessibleNodes(userId: string) {
        return this.get(REST_API.USERS.ACCESSIBLE_NODES(userId));
    }

    async getUserByShortUuid(shortUuid: string) {
        return this.get(REST_API.USERS.GET_BY.SHORT_UUID(shortUuid));
    }

    // API 3.x: точечные by-telegram-id / by-email / by-tag удалены.
    // Остался users/stream с фильтрами и курсорной пагинацией, поэтому
    // ответ здесь — страница {users, nextCursor, hasMore}, а не один юзер.
    async getUsersByFilter(filter: Record<string, string | number>) {
        const query = new URLSearchParams(
            Object.entries(filter).map(([key, value]) => [key, String(value)]),
        ).toString();
        return this.get(`${REST_API.USERS.STREAM}?${query}`);
    }

    async getUserByTelegramId(telegramId: string) {
        return this.getUsersByFilter({ telegramId });
    }

    async getUserByEmail(email: string) {
        return this.getUsersByFilter({ email });
    }

    async getUserByTag(tag: string) {
        return this.getUsersByFilter({ tag });
    }

    async getUserTags() {
        return this.get(REST_API.USERS.TAGS.GET);
    }

    async resolveUsers(params: Record<string, unknown>) {
        return this.post(REST_API.USERS.RESOLVE, params);
    }

    async createUser(params: Record<string, unknown>) {
        return this.post(REST_API.USERS.CREATE, params);
    }

    async updateUser(params: Record<string, unknown>) {
        return this.patch(REST_API.USERS.UPDATE, params);
    }

    async deleteUser(userId: string) {
        return this.delete(REST_API.USERS.DELETE(userId));
    }

    async enableUser(userId: string) {
        return this.post(REST_API.USERS.ACTIONS.ENABLE(userId));
    }

    async disableUser(userId: string) {
        return this.post(REST_API.USERS.ACTIONS.DISABLE(userId));
    }

    async revokeUserSubscription(userId: string) {
        return this.post(REST_API.USERS.ACTIONS.REVOKE_SUBSCRIPTION(userId));
    }

    async resetUserTraffic(userId: string) {
        return this.post(REST_API.USERS.ACTIONS.RESET_TRAFFIC(userId));
    }

    async bulkDeleteUsersByStatus(params: Record<string, unknown>) {
        return this.post(REST_API.USERS.BULK.DELETE_BY_STATUS, params);
    }

    async bulkUpdateUsers(params: Record<string, unknown>) {
        return this.post(REST_API.USERS.BULK.UPDATE, params);
    }

    async bulkResetUsersTraffic(params: Record<string, unknown>) {
        return this.post(REST_API.USERS.BULK.RESET_TRAFFIC, params);
    }

    async bulkRevokeUsersSubscription(params: Record<string, unknown>) {
        return this.post(REST_API.USERS.BULK.REVOKE_SUBSCRIPTION, params);
    }

    async bulkDeleteUsers(params: Record<string, unknown>) {
        return this.post(REST_API.USERS.BULK.DELETE, params);
    }

    async bulkUpdateUserSquads(params: Record<string, unknown>) {
        return this.post(REST_API.USERS.BULK.UPDATE_SQUADS, params);
    }

    async bulkExtendUsersExpiration(params: Record<string, unknown>) {
        return this.post(REST_API.USERS.BULK.EXTEND_EXPIRATION_DATE, params);
    }

    async bulkAllUpdateUsers(params: Record<string, unknown>) {
        return this.post(REST_API.USERS.BULK.ALL.UPDATE, params);
    }

    async bulkAllResetUsersTraffic() {
        return this.post(REST_API.USERS.BULK.ALL.RESET_TRAFFIC);
    }

    async bulkAllExtendUsersExpiration(params: Record<string, unknown>) {
        return this.post(REST_API.USERS.BULK.ALL.EXTEND_EXPIRATION_DATE, params);
    }

    // Nodes

    async getNodes() {
        return this.get(REST_API.NODES.GET);
    }

    async getNodeByUuid(uuid: string) {
        return this.get(REST_API.NODES.GET_BY_UUID(uuid));
    }

    async getNodeTags() {
        return this.get(REST_API.NODES.TAGS.GET);
    }

    async createNode(params: Record<string, unknown>) {
        return this.post(REST_API.NODES.CREATE, params);
    }

    async updateNode(params: Record<string, unknown>) {
        return this.patch(REST_API.NODES.UPDATE, params);
    }

    async deleteNode(uuid: string) {
        return this.delete(REST_API.NODES.DELETE(uuid));
    }

    async enableNode(uuid: string) {
        return this.post(REST_API.NODES.ACTIONS.ENABLE(uuid));
    }

    async disableNode(uuid: string) {
        return this.post(REST_API.NODES.ACTIONS.DISABLE(uuid));
    }

    // forceRestart обязателен по контракту (RestartNodeCommand.RequestBodySchema) — без тела
    // панель отвечает «Validation failed» без указания поля. Смысл флага (проверено по коду
    // remnawave/node, xray.service.ts): false — нода сверит хеши конфига и, если он не менялся
    // и xray жив, НЕ перезапустится вовсе; true — пропускает проверку и рестартует безусловно.
    async restartNode(uuid: string, forceRestart: boolean) {
        return this.post(REST_API.NODES.ACTIONS.RESTART(uuid), { forceRestart });
    }

    async restartAllNodes(forceRestart: boolean) {
        return this.post(REST_API.NODES.ACTIONS.RESTART_ALL, { forceRestart });
    }

    async resetNodeTraffic(uuid: string) {
        return this.post(REST_API.NODES.ACTIONS.RESET_TRAFFIC(uuid));
    }

    async reorderNodes(nodes: Array<{ viewPosition: number; uuid: string }>) {
        return this.post(REST_API.NODES.ACTIONS.REORDER, { nodes });
    }

    async bulkNodeProfileModification(params: Record<string, unknown>) {
        return this.post(REST_API.NODES.BULK_ACTIONS.PROFILE_MODIFICATION, params);
    }

    async bulkNodeActions(params: Record<string, unknown>) {
        return this.post(REST_API.NODES.BULK_ACTIONS.ACTIONS, params);
    }

    async bulkUpdateNodes(params: Record<string, unknown>) {
        return this.post(REST_API.NODES.BULK_ACTIONS.UPDATE, params);
    }

    // Hosts

    async getHosts() {
        return this.get(REST_API.HOSTS.GET);
    }

    async getHostByUuid(uuid: string) {
        return this.get(REST_API.HOSTS.GET_BY_UUID(uuid));
    }

    async getHostTags() {
        return this.get(REST_API.HOSTS.TAGS.GET);
    }

    async createHost(params: Record<string, unknown>) {
        return this.post(REST_API.HOSTS.CREATE, params);
    }

    async updateHost(params: Record<string, unknown>) {
        return this.patch(REST_API.HOSTS.UPDATE, params);
    }

    async deleteHost(uuid: string) {
        return this.delete(REST_API.HOSTS.DELETE(uuid));
    }

    async bulkEnableHosts(params: Record<string, unknown>) {
        return this.post(REST_API.HOSTS.BULK.ENABLE_HOSTS, params);
    }

    async bulkDisableHosts(params: Record<string, unknown>) {
        return this.post(REST_API.HOSTS.BULK.DISABLE_HOSTS, params);
    }

    async bulkDeleteHosts(params: Record<string, unknown>) {
        return this.post(REST_API.HOSTS.BULK.DELETE_HOSTS, params);
    }

    // API 3.x: отдельные bulk/set-inbound и bulk/set-port убраны —
    // всё через PATCH bulk/update с телом {uuids, <любые поля хоста>}.
    async bulkSetHostInbound(params: Record<string, unknown>) {
        return this.patch(REST_API.HOSTS.BULK.UPDATE, params);
    }

    async bulkSetHostPort(params: Record<string, unknown>) {
        return this.patch(REST_API.HOSTS.BULK.UPDATE, params);
    }

    // System

    // `tz` определяет, по какой зоне нарезаны сутки в ответе; без него — по UTC.
    async getStats(params: Record<string, unknown> = {}) {
        return this.get(
            `${REST_API.SYSTEM.STATS.SYSTEM_STATS}${this.buildQuery(params)}`,
        );
    }

    async getBandwidthStats(params: Record<string, unknown> = {}) {
        return this.get(
            `${REST_API.SYSTEM.STATS.BANDWIDTH_STATS}${this.buildQuery(params)}`,
        );
    }

    async getHttpStats() {
        return this.get(REST_API.SYSTEM.STATS.HTTP);
    }

    async getNodesMetrics() {
        return this.get(REST_API.SYSTEM.STATS.NODES_METRICS);
    }

    async getNodesStatistics(params: Record<string, unknown> = {}) {
        return this.get(
            `${REST_API.SYSTEM.STATS.NODES_STATS}${this.buildQuery(params)}`,
        );
    }

    async getStatsRecap() {
        return this.get(REST_API.SYSTEM.STATS.RECAP);
    }

    async getHealth() {
        return this.get(REST_API.SYSTEM.HEALTH);
    }

    async getSystemMetadata() {
        return this.get(REST_API.SYSTEM.METADATA);
    }

    async generateX25519() {
        return this.get(REST_API.SYSTEM.TOOLS.GENERATE_X25519);
    }

    async testSrrMatcher(params: Record<string, unknown>) {
        return this.post(REST_API.SYSTEM.TESTERS.SRR_MATCHER, params);
    }

    // Subscriptions

    async getSubscriptions(start = 0, size = 25) {
        return this.get(
            `${REST_API.SUBSCRIPTIONS.GET}?start=${start}&size=${size}`,
        );
    }

    async getSubscriptionByUserId(userId: string) {
        return this.get(REST_API.SUBSCRIPTIONS.GET_BY.ID(userId));
    }

    async getSubscriptionByUsername(username: string) {
        return this.get(REST_API.SUBSCRIPTIONS.GET_BY.USERNAME(username));
    }

    async getSubscriptionByShortUuid(shortUuid: string) {
        return this.get(REST_API.SUBSCRIPTIONS.GET_BY.SHORT_UUID(shortUuid));
    }

    async getSubscriptionByShortUuidRaw(
        shortUuid: string,
        params: Record<string, unknown> = {},
    ) {
        return this.get(
            `${REST_API.SUBSCRIPTIONS.GET_BY.SHORT_UUID_RAW(shortUuid)}${this.buildQuery(params)}`,
        );
    }

    // GET с обязательным телом — необычно, но так объявлено в контракте
    // (GetSubpageConfigByShortUuidCommand) и так же реализовано в панели: контроллер берёт
    // body.requestHeaders и прогоняет их через матчер правил SRR. То есть ответ зависит от
    // заголовков: это «какой subpage-конфиг получит клиент, представившийся вот так».
    // Без тела панель отвечала безликим «Validation failed».
    async getSubscriptionSubpageConfig(shortUuid: string, requestHeaders: Record<string, string>) {
        return this.get(REST_API.SUBSCRIPTIONS.SUBPAGE.GET_CONFIG(shortUuid), { requestHeaders });
    }

    async getConnectionKeysByUserId(userId: string) {
        return this.get(REST_API.SUBSCRIPTIONS.GET_CONNECTION_KEYS_BY_USER_ID(userId));
    }

    async getSubscriptionInfo(shortUuid: string) {
        return this.get(REST_API.SUBSCRIPTION.GET_INFO(shortUuid));
    }

    async getSubscriptionRequestHistory(params: Record<string, unknown> = {}) {
        return this.get(
            `${REST_API.SUBSCRIPTION_REQUEST_HISTORY.GET}${this.buildQuery(params)}`,
        );
    }

    async getSubscriptionRequestHistoryStats() {
        return this.get(REST_API.SUBSCRIPTION_REQUEST_HISTORY.STATS);
    }

    // Config Profiles / Inbounds

    async getConfigProfiles() {
        return this.get(REST_API.CONFIG_PROFILES.GET);
    }

    async getConfigProfileByUuid(uuid: string) {
        return this.get(REST_API.CONFIG_PROFILES.GET_BY_UUID(uuid));
    }

    async getAllInbounds() {
        return this.get(REST_API.CONFIG_PROFILES.GET_ALL_INBOUNDS);
    }

    async getInboundsByProfileUuid(uuid: string) {
        return this.get(REST_API.CONFIG_PROFILES.GET_INBOUNDS_BY_PROFILE_UUID(uuid));
    }

    async getComputedConfigByProfileUuid(uuid: string) {
        return this.get(REST_API.CONFIG_PROFILES.GET_COMPUTED_CONFIG_BY_PROFILE_UUID(uuid));
    }

    async createConfigProfile(params: Record<string, unknown>) {
        return this.post(REST_API.CONFIG_PROFILES.CREATE, params);
    }

    async updateConfigProfile(params: Record<string, unknown>) {
        return this.patch(REST_API.CONFIG_PROFILES.UPDATE, params);
    }

    async deleteConfigProfile(uuid: string) {
        return this.delete(REST_API.CONFIG_PROFILES.DELETE(uuid));
    }

    async reorderConfigProfiles(params: Record<string, unknown>) {
        return this.post(REST_API.CONFIG_PROFILES.ACTIONS.REORDER, params);
    }

    // Internal Squads

    async getInternalSquads() {
        return this.get(REST_API.INTERNAL_SQUADS.GET);
    }

    async getSquadAccessibleNodes(uuid: string) {
        return this.get(REST_API.INTERNAL_SQUADS.ACCESSIBLE_NODES(uuid));
    }

    async createInternalSquad(params: Record<string, unknown>) {
        return this.post(REST_API.INTERNAL_SQUADS.CREATE, params);
    }

    async updateInternalSquad(params: Record<string, unknown>) {
        return this.patch(REST_API.INTERNAL_SQUADS.UPDATE, params);
    }

    async deleteInternalSquad(uuid: string) {
        return this.delete(REST_API.INTERNAL_SQUADS.DELETE(uuid));
    }

    // ⚠️ add-users / remove-users в 3.x — это действия НАД ВСЕМ ПАРКОМ
    // («Add all users to internal squad»), тела они не принимают. Для списка
    // пользователей есть отдельные add-many-users / remove-many-users, и
    // userIds там строго числовые.
    async addUsersToSquad(squadUuid: string, userIds: number[]) {
        return this.post(
            REST_API.INTERNAL_SQUADS.BULK_ACTIONS.ADD_MANY_USERS(squadUuid),
            { userIds },
        );
    }

    async removeUsersFromSquad(squadUuid: string, userIds: number[]) {
        return this.delete(
            REST_API.INTERNAL_SQUADS.BULK_ACTIONS.REMOVE_MANY_USERS(squadUuid),
            { userIds },
        );
    }

    async addAllUsersToSquad(squadUuid: string) {
        return this.post(REST_API.INTERNAL_SQUADS.BULK_ACTIONS.ADD_USERS(squadUuid));
    }

    async removeAllUsersFromSquad(squadUuid: string) {
        return this.delete(REST_API.INTERNAL_SQUADS.BULK_ACTIONS.REMOVE_USERS(squadUuid));
    }

    // HWID

    async getUserHwidDevices(userId: string) {
        return this.get(REST_API.HWID.GET_USER_HWID_DEVICES(userId));
    }

    async getAllHwidDevices(params: Record<string, unknown> = {}) {
        return this.get(
            `${REST_API.HWID.GET_ALL_HWID_DEVICES}${this.buildQuery(params)}`,
        );
    }

    async getHwidStats() {
        return this.get(REST_API.HWID.STATS);
    }

    // ⚠️ Без query панель отдаёт ровно 5 записей (`size` по умолчанию), и ответ выглядит
    // полным: `users[] = 5` при `total = 50`. Из-за этого мы принимали решения по HWID-лимиту
    // по верхушке списка (SAD-205). `size` в контракте ограничен сотней.
    async getHwidTopUsers(params: Record<string, unknown> = {}) {
        return this.get(
            `${REST_API.HWID.TOP_USERS_BY_DEVICES}${this.buildQuery(params)}`,
        );
    }

    async createUserHwidDevice(params: Record<string, unknown>) {
        return this.post(REST_API.HWID.CREATE_USER_HWID_DEVICE, params);
    }

    // API 3.x: create/delete-user-hwid-device.command требуют числовой userId
    // в теле запроса, а не userUuid — иначе панель отклонит запрос валидацией.
    async deleteHwidDevice(userId: number, hwid: string) {
        return this.post(REST_API.HWID.DELETE_USER_HWID_DEVICE, {
            userId,
            hwid,
        });
    }

    async deleteAllUserHwidDevices(userId: number) {
        return this.post(REST_API.HWID.DELETE_ALL_USER_HWID_DEVICES, {
            userId,
        });
    }

    // Bandwidth Stats
    //
    // ⚠️ У всех четырёх `start` и `end` (YYYY-MM-DD) ОБЯЗАТЕЛЬНЫ — без них панель отвечает 400.
    // До 11.08.2026 два метода ниже звали эти пути без query вовсе, то есть были нерабочими, и
    // заметить это было нечем: тулов под них не существовало, компилятор молчал (SAD-205).
    //
    // Не покрыты осознанно: POST-двойники `nodes/usage` и `nodes/users` — они делают то же
    // самое, но с фильтром по списку `nodesUuids`; выборку по одной ноде закрывает
    // `getNodeUsersBandwidth`. ⛔ `nodes/realtime` НЕ добавлять: путь объявлен в контракте
    // 3.0.0–3.3.0, но панель 3.2.1 отдаёт на него 404 (проверено живым запросом 11.08.2026).

    async getNodesBandwidth(params: Record<string, unknown>) {
        return this.get(
            `${REST_API.BANDWIDTH_STATS.NODES.GET}${this.buildQuery(params)}`,
        );
    }

    async getNodeUsersBandwidth(uuid: string, params: Record<string, unknown>) {
        return this.get(
            `${REST_API.BANDWIDTH_STATS.NODES.GET_USERS(uuid)}${this.buildQuery(params)}`,
        );
    }

    async getUserBandwidthByUserId(
        userId: string,
        params: Record<string, unknown>,
    ) {
        return this.get(
            `${REST_API.BANDWIDTH_STATS.USERS.GET_BY_ID(userId)}${this.buildQuery(params)}`,
        );
    }

    async getInternalSquadBandwidth(
        uuid: string,
        params: Record<string, unknown>,
    ) {
        return this.get(
            `${REST_API.BANDWIDTH_STATS.INTERNAL_SQUADS.GET_USAGE(uuid)}${this.buildQuery(params)}`,
        );
    }

    async getInternalSquadUserBandwidth(
        squadUuid: string,
        userId: string,
        params: Record<string, unknown>,
    ) {
        return this.get(
            `${REST_API.BANDWIDTH_STATS.INTERNAL_SQUADS.USER_USAGE(squadUuid, userId)}${this.buildQuery(params)}`,
        );
    }

    // Auth

    async getAuthStatus() {
        return this.get(REST_API.AUTH.GET_STATUS);
    }

    // API Tokens

    async getApiTokens() {
        return this.get(REST_API.API_TOKENS.GET);
    }

    async createApiToken(params: Record<string, unknown>) {
        return this.post(REST_API.API_TOKENS.CREATE, params);
    }

    async deleteApiToken(uuid: string) {
        return this.delete(REST_API.API_TOKENS.DELETE(uuid));
    }

    // Keygen

    async getKeygen() {
        return this.get(REST_API.KEYGEN.GET);
    }

    // Infra Billing

    async getBillingProviders() {
        return this.get(REST_API.INFRA_BILLING.GET_PROVIDERS);
    }

    async getBillingProviderByUuid(uuid: string) {
        return this.get(REST_API.INFRA_BILLING.GET_PROVIDER_BY_UUID(uuid));
    }

    async createBillingProvider(params: Record<string, unknown>) {
        return this.post(REST_API.INFRA_BILLING.CREATE_PROVIDER, params);
    }

    async updateBillingProvider(params: Record<string, unknown>) {
        return this.patch(REST_API.INFRA_BILLING.UPDATE_PROVIDER, params);
    }

    async deleteBillingProvider(uuid: string) {
        return this.delete(REST_API.INFRA_BILLING.DELETE_PROVIDER(uuid));
    }

    async getBillingNodes() {
        return this.get(REST_API.INFRA_BILLING.GET_BILLING_NODES);
    }

    async createBillingNode(params: Record<string, unknown>) {
        return this.post(REST_API.INFRA_BILLING.CREATE_BILLING_NODE, params);
    }

    async updateBillingNode(params: Record<string, unknown>) {
        return this.patch(REST_API.INFRA_BILLING.UPDATE_BILLING_NODE, params);
    }

    async deleteBillingNode(uuid: string) {
        return this.delete(REST_API.INFRA_BILLING.DELETE_BILLING_NODE(uuid));
    }

    async getBillingHistory(params: Record<string, unknown> = {}) {
        return this.get(
            `${REST_API.INFRA_BILLING.GET_BILLING_HISTORY}${this.buildQuery(params)}`,
        );
    }

    async createBillingHistory(params: Record<string, unknown>) {
        return this.post(REST_API.INFRA_BILLING.CREATE_BILLING_HISTORY, params);
    }

    async deleteBillingHistory(uuid: string) {
        return this.delete(REST_API.INFRA_BILLING.DELETE_BILLING_HISTORY(uuid));
    }

    // Snippets

    async getSnippets() {
        return this.get(REST_API.SNIPPETS.GET);
    }

    async createSnippet(params: Record<string, unknown>) {
        return this.post(REST_API.SNIPPETS.CREATE, params);
    }

    async updateSnippet(params: Record<string, unknown>) {
        return this.patch(REST_API.SNIPPETS.UPDATE, params);
    }

    // ⚠️ Именно DELETE с телом, а не POST: у сниппетов все четыре команды висят на одном пути
    // `/api/snippets/` и различаются только методом (`DeleteSnippetCommand` — delete). POST здесь
    // попадал в обработчик создания. Найдено 10.08.2026 отчётом `check:bodies` (SAD-179): тул
    // получил поля чужой команды, и это вскрыло подмену метода.
    async deleteSnippet(params: Record<string, unknown>) {
        return this.delete(REST_API.SNIPPETS.DELETE, params);
    }

    // External Squads

    async getExternalSquads() {
        return this.get(REST_API.EXTERNAL_SQUADS.GET);
    }

    async getExternalSquadByUuid(uuid: string) {
        return this.get(REST_API.EXTERNAL_SQUADS.GET_BY_UUID(uuid));
    }

    async createExternalSquad(params: Record<string, unknown>) {
        return this.post(REST_API.EXTERNAL_SQUADS.CREATE, params);
    }

    async updateExternalSquad(params: Record<string, unknown>) {
        return this.patch(REST_API.EXTERNAL_SQUADS.UPDATE, params);
    }

    async deleteExternalSquad(uuid: string) {
        return this.delete(REST_API.EXTERNAL_SQUADS.DELETE(uuid));
    }

    // У внешних сквадов «поштучного» варианта в 3.x нет вовсе: только
    // add-users / remove-users над всем парком, оба без тела.
    async addAllUsersToExternalSquad(squadUuid: string) {
        return this.post(REST_API.EXTERNAL_SQUADS.BULK_ACTIONS.ADD_USERS(squadUuid));
    }

    async removeAllUsersFromExternalSquad(squadUuid: string) {
        return this.delete(REST_API.EXTERNAL_SQUADS.BULK_ACTIONS.REMOVE_USERS(squadUuid));
    }

    async reorderExternalSquads(params: Record<string, unknown>) {
        return this.post(REST_API.EXTERNAL_SQUADS.ACTIONS.REORDER, params);
    }

    // Settings

    async getSettings() {
        return this.get(REST_API.REMNAAWAVE_SETTINGS.GET);
    }

    // Настройки подписки — отдельный контроллер, не /api/settings: там живут
    // customResponseHeaders, customRemarks, hwidSettings и правила SRR.
    async getSubscriptionSettings() {
        return this.get(REST_API.SUBSCRIPTION_SETTINGS.GET);
    }

    async updateSubscriptionSettings(params: Record<string, unknown>) {
        return this.patch(REST_API.SUBSCRIPTION_SETTINGS.UPDATE, params);
    }

    async updateSettings(params: Record<string, unknown>) {
        return this.patch(REST_API.REMNAAWAVE_SETTINGS.UPDATE, params);
    }

    // Subscription Page Configs

    async getSubscriptionPageConfigs() {
        return this.get(REST_API.SUBSCRIPTION_PAGE_CONFIGS.GET_ALL);
    }

    async getSubscriptionPageConfig(uuid: string) {
        return this.get(REST_API.SUBSCRIPTION_PAGE_CONFIGS.GET(uuid));
    }

    async createSubscriptionPageConfig(params: Record<string, unknown>) {
        return this.post(REST_API.SUBSCRIPTION_PAGE_CONFIGS.CREATE, params);
    }

    async updateSubscriptionPageConfig(params: Record<string, unknown>) {
        return this.patch(REST_API.SUBSCRIPTION_PAGE_CONFIGS.UPDATE, params);
    }

    async deleteSubscriptionPageConfig(uuid: string) {
        return this.delete(REST_API.SUBSCRIPTION_PAGE_CONFIGS.DELETE(uuid));
    }

    async reorderSubscriptionPageConfigs(params: Record<string, unknown>) {
        return this.post(REST_API.SUBSCRIPTION_PAGE_CONFIGS.ACTIONS.REORDER, params);
    }

    async cloneSubscriptionPageConfig(params: Record<string, unknown>) {
        return this.post(REST_API.SUBSCRIPTION_PAGE_CONFIGS.ACTIONS.CLONE, params);
    }

    // Node Plugins

    async getNodePlugins() {
        return this.get(REST_API.NODE_PLUGINS.GET_ALL);
    }

    async getNodePlugin(uuid: string) {
        return this.get(REST_API.NODE_PLUGINS.GET(uuid));
    }

    async createNodePlugin(params: Record<string, unknown>) {
        return this.post(REST_API.NODE_PLUGINS.CREATE, params);
    }

    async updateNodePlugin(params: Record<string, unknown>) {
        return this.patch(REST_API.NODE_PLUGINS.UPDATE, params);
    }

    async deleteNodePlugin(uuid: string) {
        return this.delete(REST_API.NODE_PLUGINS.DELETE(uuid));
    }

    async reorderNodePlugins(params: Record<string, unknown>) {
        return this.post(REST_API.NODE_PLUGINS.ACTIONS.REORDER, params);
    }

    async cloneNodePlugin(params: Record<string, unknown>) {
        return this.post(REST_API.NODE_PLUGINS.ACTIONS.CLONE, params);
    }

    async executeNodePlugin(params: Record<string, unknown>) {
        return this.post(REST_API.NODE_PLUGINS.EXECUTOR, params);
    }

    // ⚠️ Без пагинации отдаёт первые 25 отчётов и выглядит полным ответом — а по этим
    // отчётам мы судили о торрентах на нодах (тот же класс, что `hwid_top_users`, SAD-205).
    async getTorrentBlockerReports(params: Record<string, unknown> = {}) {
        return this.get(
            `${REST_API.NODE_PLUGINS.TORRENT_BLOCKER.GET_REPORTS}${this.buildQuery(params)}`,
        );
    }

    async getTorrentBlockerStats() {
        return this.get(REST_API.NODE_PLUGINS.TORRENT_BLOCKER.GET_REPORTS_STATS);
    }

    async truncateTorrentBlockerReports() {
        return this.delete(REST_API.NODE_PLUGINS.TORRENT_BLOCKER.TRUNCATE_REPORTS);
    }

    // Connections (в API 3.x модуль ip-control переименован в connections)

    async fetchIps(userId: string) {
        return this.post(REST_API.CONNECTIONS.CONNECTIONS_BY_USER(userId));
    }

    async getFetchIpsResult(jobId: string) {
        return this.get(REST_API.CONNECTIONS.CONNECTIONS_BY_USER_RESULT(jobId));
    }

    async dropConnections(params: Record<string, unknown>) {
        return this.post(REST_API.CONNECTIONS.DROP_CONNECTIONS, params);
    }

    async fetchUsersIps(nodeUuid: string) {
        return this.post(REST_API.CONNECTIONS.CONNECTIONS_BY_NODE(nodeUuid));
    }

    async getFetchUsersIpsResult(jobId: string) {
        return this.get(REST_API.CONNECTIONS.CONNECTIONS_BY_NODE_RESULT(jobId));
    }

    // Metadata

    async getNodeMetadata(uuid: string) {
        return this.get(REST_API.METADATA.NODE.GET(uuid));
    }

    async upsertNodeMetadata(uuid: string, params: Record<string, unknown>) {
        return this.put(REST_API.METADATA.NODE.UPSERT(uuid), params);
    }

    async getUserMetadata(userId: string) {
        return this.get(REST_API.METADATA.USER.GET(userId));
    }

    async upsertUserMetadata(userId: string, params: Record<string, unknown>) {
        return this.put(REST_API.METADATA.USER.UPSERT(userId), params);
    }

    async getSubscriptionTemplates() {
        return this.get(REST_API.SUBSCRIPTION_TEMPLATE.GET_ALL);
    }

    async getSubscriptionTemplate(uuid: string) {
        return this.get(REST_API.SUBSCRIPTION_TEMPLATE.GET(uuid));
    }

    async updateSubscriptionTemplate(params: Record<string, unknown>) {
        return this.patch(REST_API.SUBSCRIPTION_TEMPLATE.UPDATE, params);
    }
}
