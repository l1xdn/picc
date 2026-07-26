import fs from 'fs';
import path from 'path';
import os from 'os';
import { logger } from './logger.js';

const CONFIG_DIR = path.join(os.homedir(), '.config', 'antigravity-proxy');

export function ensureSeededConfig() {
    try {
        if (!fs.existsSync(CONFIG_DIR)) {
            fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
        }

        const seeds = [
            { envVar: 'ACCOUNTS_JSON_BASE64', file: 'accounts.json' },
            { envVar: 'ROUTER_AUTH_BASE64', file: 'router-auth.json' },
            { envVar: 'ROUTER_API_KEYS_BASE64', file: 'router-api-keys.json' },
            { envVar: 'CONFIG_JSON_BASE64', file: 'config.json' }
        ];

        for (const seed of seeds) {
            const targetPath = path.join(CONFIG_DIR, seed.file);
            const envVal = process.env[seed.envVar];

            if (envVal) {
                try {
                    const decoded = Buffer.from(envVal, 'base64').toString('utf8');
                    JSON.parse(decoded); // Validate JSON
                    fs.writeFileSync(targetPath, decoded, { encoding: 'utf8', mode: 0o600 });
                    logger.info(`[Seed] Seeded ${seed.file} from environment variable ${seed.envVar}`);
                    continue;
                } catch (err) {
                    logger.error(`[Seed] Failed to decode/parse ${seed.envVar}:`, err.message);
                }
            }

            // Fallback: check app local seed directory
            const seedFilePath = path.resolve('seed', seed.file);
            if (!fs.existsSync(targetPath) && fs.existsSync(seedFilePath)) {
                try {
                    const content = fs.readFileSync(seedFilePath, 'utf8');
                    fs.writeFileSync(targetPath, content, { encoding: 'utf8', mode: 0o600 });
                    logger.info(`[Seed] Seeded ${seed.file} from local seed directory`);
                } catch (err) {
                    logger.error(`[Seed] Failed to copy seed file ${seed.file}:`, err.message);
                }
            }
        }
    } catch (err) {
        logger.error('[Seed] Error in ensureSeededConfig:', err);
    }
}
