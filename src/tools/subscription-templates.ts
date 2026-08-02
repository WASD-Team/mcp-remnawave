import { readFile, writeFile } from 'node:fs/promises';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { RemnawaveClient } from '../client/index.js';
import { toolResult, toolError } from './helpers.js';

const MAX_TEMPLATE_BYTES = 5 * 1024 * 1024;

/** Template types whose body is carried as base64 YAML rather than JSON. */
const YAML_TEMPLATE_TYPES = new Set(['MIHOMO', 'STASH', 'CLASH', 'SINGBOX', 'XRAY_BASE64']);

interface TemplateRecord {
    uuid: string;
    name: string;
    templateType: string;
    viewPosition?: number;
    templateJson?: unknown;
    encodedTemplateYaml?: string | null;
}

/**
 * Template bodies are large (a real mihomo template is ~18 KB, ~25 KB once
 * base64-encoded). Returning them inline floods the model context, so list/get
 * report sizes by default and hand out the body only on request.
 */
function summarize(t: TemplateRecord) {
    const yaml = t.encodedTemplateYaml
        ? Buffer.from(t.encodedTemplateYaml, 'base64').toString('utf8')
        : null;
    return {
        uuid: t.uuid,
        name: t.name,
        templateType: t.templateType,
        viewPosition: t.viewPosition,
        body: yaml
            ? { kind: 'yaml', bytes: Buffer.byteLength(yaml, 'utf8'), lines: yaml.split('\n').length }
            : t.templateJson
              ? { kind: 'json', bytes: Buffer.byteLength(JSON.stringify(t.templateJson), 'utf8') }
              : { kind: 'empty' },
    };
}

function unwrap(res: unknown): TemplateRecord[] {
    const response = (res as { response?: unknown })?.response ?? res;
    if (Array.isArray(response)) return response as TemplateRecord[];
    const templates = (response as { templates?: unknown })?.templates;
    return Array.isArray(templates) ? (templates as TemplateRecord[]) : [];
}

function unwrapOne(res: unknown): TemplateRecord {
    return ((res as { response?: unknown })?.response ?? res) as TemplateRecord;
}

/**
 * Cheap sanity checks before pushing a template to the panel. A broken body
 * reaches every client on their next subscription refresh, so a malformed file
 * must fail here rather than in 200 clients.
 */
function assertPlausible(templateType: string, content: string) {
    if (!content.trim()) throw new Error('File is empty');

    if (YAML_TEMPLATE_TYPES.has(templateType)) {
        if (content.trimStart().startsWith('{')) {
            throw new Error(
                `Template ${templateType} expects YAML, but the file looks like JSON`,
            );
        }
        if (templateType === 'MIHOMO' || templateType === 'CLASH' || templateType === 'STASH') {
            for (const key of ['proxies:', 'rules:']) {
                if (!content.includes(key)) {
                    throw new Error(`YAML is missing a top-level "${key}" section`);
                }
            }
        }
        return;
    }

    try {
        JSON.parse(content);
    } catch (e) {
        throw new Error(`Template ${templateType} expects JSON, but the file does not parse: ${
            e instanceof Error ? e.message : String(e)
        }`);
    }
}

export function registerSubscriptionTemplateTools(
    server: McpServer,
    client: RemnawaveClient,
    readonly: boolean,
) {
    server.tool(
        'subscription_templates_list',
        'List subscription templates (mihomo, xray-json, ...) with body sizes instead of bodies',
        {},
        async () => {
            try {
                return toolResult(unwrap(await client.getSubscriptionTemplates()).map(summarize));
            } catch (e) {
                return toolError(e);
            }
        },
    );

    server.tool(
        'subscription_templates_get',
        'Get one subscription template. By default returns metadata and size only; pass saveToPath to write the body to a file, or includeContent to inline it',
        {
            uuid: z.string().describe('Template UUID'),
            saveToPath: z
                .string()
                .optional()
                .describe('Absolute path to write the template body to (preferred over includeContent)'),
            includeContent: z
                .boolean()
                .optional()
                .describe('Inline the body in the response — large, use only for small templates'),
        },
        async ({ uuid, saveToPath, includeContent }) => {
            try {
                const tpl = unwrapOne(await client.getSubscriptionTemplate(uuid));
                const body = tpl.encodedTemplateYaml
                    ? Buffer.from(tpl.encodedTemplateYaml, 'base64').toString('utf8')
                    : tpl.templateJson
                      ? JSON.stringify(tpl.templateJson, null, 2)
                      : '';

                if (saveToPath) {
                    await writeFile(saveToPath, body, 'utf8');
                    return toolResult({ ...summarize(tpl), savedTo: saveToPath });
                }
                return toolResult(
                    includeContent ? { ...summarize(tpl), content: body } : summarize(tpl),
                );
            } catch (e) {
                return toolError(e);
            }
        },
    );

    if (readonly) return;

    server.tool(
        'subscription_templates_update_from_file',
        'Deploy a subscription template to the panel from a local file. Reads the file, picks the right field for the template type (base64 YAML or JSON) and PATCHes it — the body never passes through the model context',
        {
            uuid: z.string().describe('Template UUID (see subscription_templates_list)'),
            filePath: z.string().describe('Absolute path to the template file'),
            name: z.string().optional().describe('New template name'),
        },
        async ({ uuid, filePath, name }) => {
            try {
                const current = unwrapOne(await client.getSubscriptionTemplate(uuid));
                const content = await readFile(filePath, 'utf8');
                const bytes = Buffer.byteLength(content, 'utf8');
                if (bytes > MAX_TEMPLATE_BYTES) {
                    throw new Error(`File is ${bytes} bytes, over the ${MAX_TEMPLATE_BYTES} limit`);
                }
                assertPlausible(current.templateType, content);

                const params: Record<string, unknown> = { uuid };
                if (name) params.name = name;
                if (YAML_TEMPLATE_TYPES.has(current.templateType)) {
                    params.encodedTemplateYaml = Buffer.from(content, 'utf8').toString('base64');
                } else {
                    params.templateJson = JSON.parse(content);
                }

                const updated = unwrapOne(await client.updateSubscriptionTemplate(params));
                return toolResult({
                    deployed: { ...summarize(updated), templateType: current.templateType },
                    from: { filePath, bytes, lines: content.split('\n').length },
                    reminder:
                        'Verify against the live subscription — clients pick the new template up on their next refresh',
                });
            } catch (e) {
                return toolError(e);
            }
        },
    );
}
