import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { RemnawaveClient } from '../client/index.js';
import { toolResult, toolError } from './helpers.js';

export function registerApiTokenTools(server: McpServer, client: RemnawaveClient, readonly: boolean) {
    server.tool('api_tokens_list', 'List all API tokens', {}, async () => {
        try { return toolResult(await client.getApiTokens()); } catch (e) { return toolError(e); }
    });

    if (readonly) return;

    // ⚠️ Поля названы ровно как в контракте (`CreateApiTokenCommand`). Раньше тул принимал
    // `tokenName` и не имел `expiresInDays`, обязательного по контракту, — панель отвечала на
    // такой вызов `Validation failed` без указания поля, то есть тул не работал вообще (SAD-179).
    server.tool('api_tokens_create', 'Create a new API token', {
        name: z.string().describe('Token name, 2-30 chars'),
        expiresInDays: z.number().describe('Lifetime in days, minimum 1 (required by contract)'),
        scopes: z
            .array(z.string())
            .optional()
            .describe('Permission scopes, defaults to ["*"] — full access'),
    }, async (params) => {
        try { return toolResult(await client.createApiToken(params)); } catch (e) { return toolError(e); }
    });

    server.tool('api_tokens_delete', 'Delete an API token', {
        uuid: z.string().describe('Token UUID to delete'),
    }, async ({ uuid }) => {
        try { await client.deleteApiToken(uuid); return toolResult({ success: true, message: `Token ${uuid} deleted` }); } catch (e) { return toolError(e); }
    });
}
