import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { RemnawaveClient } from '../client/index.js';
import { toolResult, toolError } from './helpers.js';

export function registerExternalSquadTools(server: McpServer, client: RemnawaveClient, readonly: boolean) {
    server.tool('external_squads_list', 'List all external squads', {}, async () => {
        try { return toolResult(await client.getExternalSquads()); } catch (e) { return toolError(e); }
    });

    server.tool('external_squads_get', 'Get an external squad by UUID', {
        uuid: z.string().uuid().describe('Squad UUID'),
    }, async ({ uuid }) => {
        try { return toolResult(await client.getExternalSquadByUuid(uuid)); } catch (e) { return toolError(e); }
    });

    if (readonly) return;

    server.tool('external_squads_create', 'Create a new external squad', {
        name: z.string().describe('Squad name'),
    }, async (params) => {
        try { return toolResult(await client.createExternalSquad(params)); } catch (e) { return toolError(e); }
    });

    server.tool('external_squads_update', 'Update an external squad', {
        uuid: z.string().uuid().describe('Squad UUID'),
        name: z.string().optional().describe('New squad name'),
    }, async (params) => {
        try { return toolResult(await client.updateExternalSquad(params)); } catch (e) { return toolError(e); }
    });

    server.tool('external_squads_delete', 'Delete an external squad', {
        uuid: z.string().uuid().describe('Squad UUID'),
    }, async ({ uuid }) => {
        try { await client.deleteExternalSquad(uuid); return toolResult({ success: true, message: `Squad ${uuid} deleted` }); } catch (e) { return toolError(e); }
    });

    // У внешних сквадов поштучных действий в 3.x нет — только над всем парком.
    server.tool('external_squads_add_all_users', 'DANGER: add EVERY user of the panel to an external squad', {
        squadUuid: z.string().uuid().describe('Squad UUID'),
    }, async ({ squadUuid }) => {
        try { return toolResult(await client.addAllUsersToExternalSquad(squadUuid)); } catch (e) { return toolError(e); }
    });

    server.tool('external_squads_remove_all_users', 'DANGER: remove EVERY user from an external squad', {
        squadUuid: z.string().uuid().describe('Squad UUID'),
    }, async ({ squadUuid }) => {
        try { return toolResult(await client.removeAllUsersFromExternalSquad(squadUuid)); } catch (e) { return toolError(e); }
    });

    server.tool('external_squads_reorder', 'Reorder external squads', {
        items: z.array(z.object({
            viewPosition: z.number().describe('Sort position (0-based)'),
            uuid: z.string().uuid().describe('Squad UUID'),
        })).describe('Ordered array of { viewPosition, uuid } objects'),
    }, async (params) => {
        try { return toolResult(await client.reorderExternalSquads(params)); } catch (e) { return toolError(e); }
    });
}
