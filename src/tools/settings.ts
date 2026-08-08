import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { RemnawaveClient } from '../client/index.js';
import { toolResult, toolError } from './helpers.js';

export function registerSettingsTools(server: McpServer, client: RemnawaveClient, readonly: boolean) {
    server.tool('settings_get', 'Get Remnawave panel settings', {}, async () => {
        try { return toolResult(await client.getSettings()); } catch (e) { return toolError(e); }
    });

    server.tool(
        'subscription_settings_get',
        'Get subscription settings: custom response headers, custom remarks, SRR response rules, HWID settings',
        {},
        async () => {
            try { return toolResult(await client.getSubscriptionSettings()); } catch (e) { return toolError(e); }
        },
    );

    if (readonly) return;

    server.tool('settings_update', 'Update Remnawave panel settings', {
        settings: z.record(z.unknown()).describe('Settings key-value pairs to update'),
    }, async ({ settings }) => {
        try { return toolResult(await client.updateSettings(settings)); } catch (e) { return toolError(e); }
    });

    server.tool(
        'subscription_settings_update',
        'Update subscription settings. Only the fields you pass change; everything else is preserved',
        {
            serveJsonAtBaseSubscription: z.boolean().optional().describe('Serve JSON at base subscription URL'),
            isShowCustomRemarks: z.boolean().optional().describe('Show custom remarks'),
            customRemarks: z.record(z.unknown()).optional().describe('Custom remarks object (expired, disabled, limited, HWIDNotSupported, ...)'),
            customResponseHeaders: z.record(z.unknown()).optional().describe('Custom response headers sent to clients (announce, profile-*, flclashx-*)'),
            randomizeHosts: z.boolean().optional().describe('Randomize host order in subscription'),
            responseRules: z.record(z.unknown()).optional().describe('SRR rules: which client user-agent gets which template'),
            hwidSettings: z.record(z.unknown()).optional().describe('HWID policy settings'),
        },
        async (params) => {
            try {
                // PATCH затирает всё, чего нет в теле: частичный запрос снёс бы
                // правила SRR и заголовки клиентов. Читаем текущие настройки и
                // накладываем переданные поля поверх.
                const current = (await client.getSubscriptionSettings()) as {
                    response?: Record<string, unknown>;
                };
                const settings = current?.response;
                if (!settings) {
                    throw new Error('Subscription settings not found, refusing to update blindly');
                }

                // createdAt/updatedAt возвращаются панелью, но телом не принимаются.
                const { createdAt: _createdAt, updatedAt: _updatedAt, ...merged } = settings;
                const body: Record<string, unknown> = { ...merged };
                for (const [key, value] of Object.entries(params)) {
                    if (value !== undefined) body[key] = value;
                }

                return toolResult(await client.updateSubscriptionSettings(body));
            } catch (e) { return toolError(e); }
        },
    );
}
