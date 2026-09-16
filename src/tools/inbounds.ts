import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { RemnawaveClient } from '../client/index.js';
import { toolResult, toolError } from './helpers.js';

/** Маркер, которым `annotate.ts` заменяет секреты в ответе модели. */
const REDACTED = '«вычищено сервером MCP»';

/**
 * 🔴 Ловушка, из-за которой эта проверка существует (16.09.2026).
 *
 * Ответы модели проходят вычистку: `privateKey` каждого инбаунда приезжает как REDACTED.
 * Модели при этом доступен только один способ правки тела конфига — прочитать профиль и
 * залить его обратно, и он КАТАСТРОФИЧЕН: заглушка записалась бы вместо настоящего ключа
 * Reality, то есть легла бы вся маскировка на ВСЁМ парке сразу (профиль у нас один).
 * Снаружи это выглядело бы как «ноды живы, а клиенты не подключаются».
 *
 * 🔑 Поэтому отказ здесь, а не предупреждение в описании: описание модель читает, но не
 * обязана слушаться, а тут физически нет способа испортить конфиг незаметно. Рабочий путь
 * для тела конфига — `projects/RWXRAY/nodes/deploy-config.py`: он берёт токен из окружения,
 * сохраняет бэкап, сливает поля локаций из живой панели и сверяет результат после заливки.
 */
function findRedacted(value: unknown, path = 'config'): string | null {
    if (typeof value === 'string') {
        return value.includes(REDACTED) ? path : null;
    }
    if (Array.isArray(value)) {
        for (let i = 0; i < value.length; i += 1) {
            const hit = findRedacted(value[i], `${path}[${i}]`);
            if (hit) return hit;
        }
        return null;
    }
    if (value && typeof value === 'object') {
        for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
            const hit = findRedacted(v, `${path}.${k}`);
            if (hit) return hit;
        }
    }
    return null;
}

export function registerInboundTools(
    server: McpServer,
    client: RemnawaveClient,
    readonly: boolean,
) {
    server.tool(
        'config_profiles_list',
        'List all config profiles',
        {},
        async () => {
            try {
                const result = await client.getConfigProfiles();
                return toolResult(result);
            } catch (e) {
                return toolError(e);
            }
        },
    );

    server.tool(
        'config_profiles_get',
        'Get a config profile by UUID',
        {
            uuid: z.string().uuid().describe('Config profile UUID'),
        },
        async ({ uuid }) => {
            try {
                const result = await client.getConfigProfileByUuid(uuid);
                return toolResult(result);
            } catch (e) {
                return toolError(e);
            }
        },
    );

    server.tool(
        'inbounds_list',
        'List all inbounds from all config profiles',
        {},
        async () => {
            try {
                const result = await client.getAllInbounds();
                return toolResult(result);
            } catch (e) {
                return toolError(e);
            }
        },
    );

    server.tool(
        'config_profiles_get_inbounds',
        'Get inbounds for a specific config profile',
        {
            uuid: z.string().uuid().describe('Config profile UUID'),
        },
        async ({ uuid }) => {
            try {
                const result = await client.getInboundsByProfileUuid(uuid);
                return toolResult(result);
            } catch (e) {
                return toolError(e);
            }
        },
    );

    server.tool(
        'config_profiles_get_computed_config',
        'Get computed configuration for a config profile',
        {
            uuid: z.string().uuid().describe('Config profile UUID'),
        },
        async ({ uuid }) => {
            try {
                const result = await client.getComputedConfigByProfileUuid(uuid);
                return toolResult(result);
            } catch (e) {
                return toolError(e);
            }
        },
    );

    if (readonly) return;

    server.tool(
        'config_profiles_create',
        'Create a new config profile',
        {
            name: z.string().describe('Profile name'),
            config: z.record(z.unknown()).describe('Config profile configuration object'),
        },
        async (params) => {
            try {
                const result = await client.createConfigProfile(params);
                return toolResult(result);
            } catch (e) {
                return toolError(e);
            }
        },
    );

    server.tool(
        'config_profiles_update',
        'Update a config profile',
        {
            uuid: z.string().uuid().describe('Profile UUID'),
            name: z.string().optional().describe('New name'),
            // ⚠️ Тело xray-конфига целиком. Панель принимает его как есть и рестартует xray
            // НА ВСЕХ нодах профиля разом. Для боевого профиля пользоваться
            // projects/RWXRAY/nodes/deploy-config.py: он делает бэкап, сверку и проверку
            // фактического egress после заливки.
            config: z
                .record(z.string(), z.unknown())
                .optional()
                .describe(
                    'Full xray config object — replaces the profile config and restarts every node '
                    + 'on the profile. ⛔ Do NOT build it from a profile you read through this MCP: '
                    + 'private keys come back redacted and you would overwrite them with the '
                    + 'placeholder. Use projects/RWXRAY/nodes/deploy-config.py for the config body.',
                ),
        },
        async (params) => {
            try {
                // Проверка идёт ДО запроса к панели: отказать дешевле, чем откатывать парк.
                if (params.config) {
                    const hit = findRedacted(params.config);
                    if (hit) {
                        return toolError(
                            new Error(
                                `отказ: в ${hit} лежит «${REDACTED}» — это заглушка вычистки, а не `
                                + 'настоящее значение. Заливка перезаписала бы секрет заглушкой и '
                                + 'положила бы Reality на всём парке. Тело конфига правится через '
                                + 'projects/RWXRAY/nodes/deploy-config.py (бэкап, поля локаций из '
                                + 'живой панели, сверка после заливки).',
                            ),
                        );
                    }
                }
                const result = await client.updateConfigProfile(params);
                return toolResult(result);
            } catch (e) {
                return toolError(e);
            }
        },
    );

    server.tool(
        'config_profiles_delete',
        'Delete a config profile',
        {
            uuid: z.string().uuid().describe('Profile UUID'),
        },
        async ({ uuid }) => {
            try {
                await client.deleteConfigProfile(uuid);
                return toolResult({ success: true, message: `Profile ${uuid} deleted` });
            } catch (e) {
                return toolError(e);
            }
        },
    );

    server.tool(
        'config_profiles_reorder',
        'Reorder config profiles',
        {
            items: z.array(z.object({
                viewPosition: z.number().describe('Sort position (0-based)'),
                uuid: z.string().uuid().describe('Config profile UUID'),
            })).describe('Ordered array of { viewPosition, uuid } objects'),
        },
        async (params) => {
            try {
                const result = await client.reorderConfigProfiles(params);
                return toolResult(result);
            } catch (e) {
                return toolError(e);
            }
        },
    );
}
