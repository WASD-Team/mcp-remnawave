import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { RemnawaveClient } from '../client/index.js';
import { toolResult, toolError } from './helpers.js';

/**
 * Полоса по нодам, сквадам и людям за период — то, что раньше приходилось добывать
 * `xray api statsquery` прямо на нодах (SAD-205).
 *
 * ⚠️ `start` и `end` (YYYY-MM-DD) обязательны у всех четырёх: без них панель отвечает 400.
 * Поэтому они не `optional` — иначе тул выглядел бы работающим и падал бы на панели.
 *
 * Не заведены осознанно: POST-двойники `bandwidth-stats/nodes/usage` и `.../nodes/users` —
 * та же выборка, но с фильтром по списку `nodesUuids`; по одной ноде отвечает
 * `bandwidth_nodes_top_users`. ⛔ `nodes/realtime` не заведён потому, что путь мёртв: он
 * объявлен в контракте 3.0.0–3.3.0, а панель 3.2.1 отдаёт 404 (проверено 11.08.2026).
 */
const period = {
    start: z.string().describe('Start date, YYYY-MM-DD (required by the panel)'),
    end: z.string().describe('End date, YYYY-MM-DD (required by the panel)'),
};

export function registerBandwidthStatsTools(
    server: McpServer,
    client: RemnawaveClient,
) {
    server.tool(
        'bandwidth_nodes_usage',
        'Bandwidth per node over a period — which locations carry the traffic',
        {
            ...period,
            topNodesLimit: z.number().optional().describe('How many top nodes to return'),
        },
        async (params) => {
            try {
                const result = await client.getNodesBandwidth(params);
                return toolResult(result);
            } catch (e) {
                return toolError(e);
            }
        },
    );

    server.tool(
        'bandwidth_nodes_top_users',
        'Top users by traffic on one node over a period — who is consuming a specific location',
        {
            uuid: z.string().uuid().describe('Node UUID'),
            ...period,
            topUsersLimit: z.number().optional().describe('How many top users to return'),
        },
        async ({ uuid, ...params }) => {
            try {
                const result = await client.getNodeUsersBandwidth(uuid, params);
                return toolResult(result);
            } catch (e) {
                return toolError(e);
            }
        },
    );

    server.tool(
        'bandwidth_user_usage',
        'Bandwidth of one user over a period, split by node',
        {
            userId: z.string().describe('Numeric user ID (API 3.x has no user uuid)'),
            ...period,
            topNodesLimit: z.number().optional().describe('How many top nodes to return'),
        },
        async ({ userId, ...params }) => {
            try {
                const result = await client.getUserBandwidthByUserId(userId, params);
                return toolResult(result);
            } catch (e) {
                return toolError(e);
            }
        },
    );

    server.tool(
        'bandwidth_squad_usage',
        'Bandwidth of one internal squad over a period, per user (cursor-paginated)',
        {
            uuid: z.string().uuid().describe('Internal squad UUID'),
            ...period,
            minTotalBytes: z
                .number()
                .optional()
                .describe('Only users whose total usage over the period is >= this (bytes)'),
            limit: z.number().optional().describe('How many users to return, max 1000'),
            cursor: z
                .string()
                .optional()
                .describe('nextCursor from the previous response; omit on the first request'),
        },
        async ({ uuid, ...params }) => {
            try {
                const result = await client.getInternalSquadBandwidth(uuid, params);
                return toolResult(result);
            } catch (e) {
                return toolError(e);
            }
        },
    );

    server.tool(
        'bandwidth_squad_user_usage',
        'Bandwidth of one user inside one internal squad over a period',
        {
            squadUuid: z.string().uuid().describe('Internal squad UUID'),
            userId: z.string().describe('Numeric user ID (API 3.x has no user uuid)'),
            ...period,
        },
        async ({ squadUuid, userId, ...params }) => {
            try {
                const result = await client.getInternalSquadUserBandwidth(
                    squadUuid,
                    userId,
                    params,
                );
                return toolResult(result);
            } catch (e) {
                return toolError(e);
            }
        },
    );
}
