import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { RemnawaveClient } from '../client/index.js';
import { toolResult, toolError } from './helpers.js';

export function registerSystemTools(
    server: McpServer,
    client: RemnawaveClient,
) {
    server.tool(
        'system_stats',
        'Get overall Remnawave panel statistics (users, nodes, traffic, memory, CPU)',
        {
            tz: z.string().optional().describe('IANA timezone for day boundaries, e.g. Europe/Moscow'),
        },
        async (params) => {
            try {
                const result = await client.getStats(params);
                return toolResult(result);
            } catch (e) {
                return toolError(e);
            }
        },
    );

    server.tool(
        'system_bandwidth_stats',
        'Get bandwidth statistics (last 24h / 7d / 30d buckets)',
        {
            // Панель считает границы суток по этой зоне; без неё «за сутки» посчитано по UTC.
            tz: z.string().optional().describe('IANA timezone, e.g. Europe/Moscow'),
        },
        async (params) => {
            try {
                const result = await client.getBandwidthStats(params);
                return toolResult(result);
            } catch (e) {
                return toolError(e);
            }
        },
    );

    server.tool(
        'system_stats_http',
        'Get HTTP request counts per route and method — what actually hits the panel API',
        {},
        async () => {
            try {
                const result = await client.getHttpStats();
                return toolResult(result);
            } catch (e) {
                return toolError(e);
            }
        },
    );

    server.tool(
        'system_nodes_metrics',
        'Get detailed node metrics',
        {},
        async () => {
            try {
                const result = await client.getNodesMetrics();
                return toolResult(result);
            } catch (e) {
                return toolError(e);
            }
        },
    );

    server.tool(
        'system_nodes_statistics',
        'Get node statistics',
        {
            tz: z.string().optional().describe('IANA timezone for day boundaries, e.g. Europe/Moscow'),
        },
        async (params) => {
            try {
                const result = await client.getNodesStatistics(params);
                return toolResult(result);
            } catch (e) {
                return toolError(e);
            }
        },
    );

    server.tool(
        'system_health',
        'Check Remnawave panel health status',
        {},
        async () => {
            try {
                const result = await client.getHealth();
                return toolResult(result);
            } catch (e) {
                return toolError(e);
            }
        },
    );

    server.tool(
        'system_metadata',
        'Get Remnawave panel metadata and version information',
        {},
        async () => {
            try {
                const result = await client.getSystemMetadata();
                return toolResult(result);
            } catch (e) {
                return toolError(e);
            }
        },
    );

    server.tool(
        'system_generate_x25519',
        'Generate X25519 key pair for VLESS Reality',
        {},
        async () => {
            try {
                const result = await client.generateX25519();
                return toolResult(result);
            } catch (e) {
                return toolError(e);
            }
        },
    );

    server.tool(
        'auth_status',
        'Check current authentication status with Remnawave panel',
        {},
        async () => {
            try {
                const result = await client.getAuthStatus();
                return toolResult(result);
            } catch (e) {
                return toolError(e);
            }
        },
    );

    server.tool(
        'system_stats_recap',
        'Get system statistics recap',
        {},
        async () => {
            try {
                const result = await client.getStatsRecap();
                return toolResult(result);
            } catch (e) {
                return toolError(e);
            }
        },
    );

    server.tool(
        'system_srr_matcher',
        'Test subscription request routing rules',
        {
            responseRules: z.record(z.unknown()).describe('Response rules configuration object with version and rules array'),
        },
        async (params) => {
            try {
                const result = await client.testSrrMatcher(params);
                return toolResult(result);
            } catch (e) {
                return toolError(e);
            }
        },
    );
}
