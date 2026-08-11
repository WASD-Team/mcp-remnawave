import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { RemnawaveClient } from '../client/index.js';
import { toolResult, toolError, listQueryParams } from './helpers.js';

export function registerSubscriptionTools(
    server: McpServer,
    client: RemnawaveClient,
) {
    server.tool(
        'subscriptions_list',
        'List all subscriptions with pagination',
        {
            start: z.number().default(0).describe('Offset for pagination'),
            size: z.number().default(25).describe('Number of subscriptions'),
        },
        async ({ start, size }) => {
            try {
                const result = await client.getSubscriptions(start, size);
                return toolResult(result);
            } catch (e) {
                return toolError(e);
            }
        },
    );

    server.tool(
        'subscriptions_get_by_id',
        'Get subscription details by numeric user ID',
        {
            userId: z.string().describe('Numeric user ID (API 3.x replaced by-uuid with by-id)'),
        },
        async ({ userId }) => {
            try {
                const result = await client.getSubscriptionByUserId(userId);
                return toolResult(result);
            } catch (e) {
                return toolError(e);
            }
        },
    );

    server.tool(
        'subscriptions_get_by_username',
        'Get subscription details by username',
        {
            username: z.string().describe('Username'),
        },
        async ({ username }) => {
            try {
                const result =
                    await client.getSubscriptionByUsername(username);
                return toolResult(result);
            } catch (e) {
                return toolError(e);
            }
        },
    );

    server.tool(
        'subscriptions_get_by_short_uuid',
        'Get subscription details by short UUID',
        {
            shortUuid: z.string().describe('Short UUID'),
        },
        async ({ shortUuid }) => {
            try {
                const result =
                    await client.getSubscriptionByShortUuid(shortUuid);
                return toolResult(result);
            } catch (e) {
                return toolError(e);
            }
        },
    );

    server.tool(
        'subscription_info',
        'Get subscription info by short UUID (public endpoint)',
        {
            shortUuid: z.string().describe('Short UUID'),
        },
        async ({ shortUuid }) => {
            try {
                const result =
                    await client.getSubscriptionInfo(shortUuid);
                return toolResult(result);
            } catch (e) {
                return toolError(e);
            }
        },
    );

    server.tool(
        'subscriptions_get_raw_by_short_uuid',
        'Get raw subscription config by short UUID',
        {
            shortUuid: z.string().describe('Short UUID'),
            withDisabledHosts: z
                .boolean()
                .optional()
                .describe('Include hosts that are disabled — useful when a location is missing for the user'),
        },
        async ({ shortUuid, ...params }) => {
            try { return toolResult(await client.getSubscriptionByShortUuidRaw(shortUuid, params)); } catch (e) { return toolError(e); }
        },
    );

    server.tool(
        'subscriptions_get_subpage_config',
        'Get subscription page configuration as it would be served to a client presenting the given headers (the panel runs them through the subscription-response-rules matcher)',
        {
            shortUuid: z.string().describe('Short UUID'),
            requestHeaders: z
                .record(z.string(), z.string())
                .optional()
                .describe(
                    'Headers to match subscription response rules against, e.g. ' +
                        '{"user-agent": "FlClash X/v0.4.2 core/v1.19.28 Platform/macos"}. ' +
                        'The panel requires this field to be present; omit it to see what an ' +
                        'unidentified client gets.',
                ),
        },
        async ({ shortUuid, requestHeaders }) => {
            try { return toolResult(await client.getSubscriptionSubpageConfig(shortUuid, requestHeaders ?? {})); } catch (e) { return toolError(e); }
        },
    );

    server.tool(
        'subscriptions_get_connection_keys',
        'Get connection keys for a subscription',
        { userId: z.string().describe('Numeric user ID') },
        async ({ userId }) => {
            try { return toolResult(await client.getConnectionKeysByUserId(userId)); } catch (e) { return toolError(e); }
        },
    );

    server.tool(
        'subscription_request_history_list',
        'List subscription request history (paginated; filter by userId to see one user)',
        listQueryParams,
        async (params) => {
            try { return toolResult(await client.getSubscriptionRequestHistory(params)); } catch (e) { return toolError(e); }
        },
    );

    server.tool(
        'subscription_request_history_stats',
        'Get subscription request history statistics',
        {},
        async () => {
            try { return toolResult(await client.getSubscriptionRequestHistoryStats()); } catch (e) { return toolError(e); }
        },
    );
}
