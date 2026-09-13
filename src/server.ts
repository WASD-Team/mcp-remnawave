import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { RemnawaveClient } from './client/index.js';
import { Config } from './config.js';
import { registerAllTools } from './tools/index.js';
import { withAnnotations } from './tools/annotate.js';
import { registerAllResources } from './resources/index.js';
import { registerAllPrompts } from './prompts/index.js';

export function createServer(config: Config): McpServer {
    const server = new McpServer({
        name: 'remnawave-mcp',
        version: '1.0.0',
    });

    const client = new RemnawaveClient(config);

    // Обёртка проставляет аннотации по имени инструмента и вычищает секреты из ответа —
    // в одном месте вместо 172 вызовов. Разбор и границы — в src/tools/annotate.ts.
    // 🔑 Оборачиваем ОДИН раз и дальше пользуемся только обёрнутым сервером: ресурсы ходили
    // мимо вычистки, и `remnawave://nodes` отдавал приватные ключи Reality. Наружу тоже
    // возвращаем обёрнутый — иначе любая будущая регистрация в обход createServer снова
    // окажется нечищеной.
    const guarded = withAnnotations(server);

    registerAllTools(guarded, client, config.readonly);
    registerAllResources(guarded, client);
    registerAllPrompts(guarded);

    return guarded;
}
