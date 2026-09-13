import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { RemnawaveClient } from '../client/index.js';
import { toolResult, toolError } from './helpers.js';

export function registerSquadTools(
    server: McpServer,
    client: RemnawaveClient,
    readonly: boolean,
) {
    server.tool(
        'squads_list',
        'List all internal squads',
        {},
        async () => {
            try {
                const result = await client.getInternalSquads();
                return toolResult(result);
            } catch (e) {
                return toolError(e);
            }
        },
    );

    server.tool(
        'squads_accessible_nodes',
        'Get nodes accessible to a specific squad',
        {
            uuid: z.string().uuid().describe('Squad UUID'),
        },
        async ({ uuid }) => {
            try {
                const result = await client.getSquadAccessibleNodes(uuid);
                return toolResult(result);
            } catch (e) {
                return toolError(e);
            }
        },
    );

    if (readonly) return;

    server.tool(
        'squads_create',
        'Create a new internal squad',
        {
            name: z.string().describe('Squad name'),
            inbounds: z.array(z.string().uuid()).describe('Array of inbound UUIDs'),
        },
        async (params) => {
            try {
                const result = await client.createInternalSquad(params);
                return toolResult(result);
            } catch (e) {
                return toolError(e);
            }
        },
    );

    server.tool(
        'squads_update',
        'Update an internal squad',
        {
            uuid: z.string().uuid().describe('Squad UUID'),
            name: z.string().optional().describe('New squad name'),
            // ⚠️ ЗАМЕНА, НЕ ДОБАВЛЕНИЕ: переданный список полностью вытесняет прежний.
            // Пустой массив оставит сквад без инбаундов — его пользователи молча перестанут
            // получать узлы в подписке. Сперва squads_list, потом полный новый список.
            inbounds: z
                .array(z.string())
                .optional()
                .describe('Inbound UUIDs for this squad — REPLACES the current list entirely'),
        },
        async (params) => {
            try {
                const result = await client.updateInternalSquad(params);
                return toolResult(result);
            } catch (e) {
                return toolError(e);
            }
        },
    );

    server.tool(
        'squads_delete',
        'Delete an internal squad',
        {
            uuid: z.string().uuid().describe('Squad UUID to delete'),
        },
        async ({ uuid }) => {
            try {
                await client.deleteInternalSquad(uuid);
                return toolResult({
                    success: true,
                    message: `Squad ${uuid} deleted`,
                });
            } catch (e) {
                return toolError(e);
            }
        },
    );

    server.tool(
        'squads_add_users',
        'Add the listed users to an internal squad',
        {
            squadUuid: z.string().uuid().describe('Squad UUID'),
            userIds: z
                .array(z.number())
                .describe('Numeric user IDs to add (API 3.x has no user uuid)'),
        },
        async ({ squadUuid, userIds }) => {
            try {
                const result = await client.addUsersToSquad(squadUuid, userIds);
                return toolResult(result);
            } catch (e) {
                return toolError(e);
            }
        },
    );

    server.tool(
        'squads_remove_users',
        'Remove the listed users from an internal squad',
        {
            squadUuid: z.string().uuid().describe('Squad UUID'),
            userIds: z
                .array(z.number())
                .describe('Numeric user IDs to remove (API 3.x has no user uuid)'),
        },
        async ({ squadUuid, userIds }) => {
            try {
                const result = await client.removeUsersFromSquad(squadUuid, userIds);
                return toolResult(result);
            } catch (e) {
                return toolError(e);
            }
        },
    );

    // Действия над всем парком вынесены в отдельные тулзы с говорящими именами:
    // в API это те же bulk-actions/add-users и remove-users, которые легко
    // принять за «добавить перечисленных» — они не принимают списка вообще.
    server.tool(
        'squads_add_all_users',
        'DANGER: add EVERY user of the panel to an internal squad',
        {
            squadUuid: z.string().uuid().describe('Squad UUID'),
        },
        async ({ squadUuid }) => {
            try {
                return toolResult(await client.addAllUsersToSquad(squadUuid));
            } catch (e) {
                return toolError(e);
            }
        },
    );

    server.tool(
        'squads_remove_all_users',
        'DANGER: remove EVERY user from an internal squad',
        {
            squadUuid: z.string().uuid().describe('Squad UUID'),
        },
        async ({ squadUuid }) => {
            try {
                return toolResult(await client.removeAllUsersFromSquad(squadUuid));
            } catch (e) {
                return toolError(e);
            }
        },
    );
}
