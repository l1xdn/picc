import fs from 'fs';
import os from 'os';
import path from 'path';

// Node's native env-file loader does not overwrite variables already supplied
// by the process. Keep secrets outside the repository by default while still
// supporting a project-local, gitignored .env for development.
const candidates = [
    process.env.PICC_ENV_FILE,
    path.resolve('.env'),
    path.join(os.homedir(), '.config', 'antigravity-proxy', '.env')
].filter(Boolean);

for (const filePath of [...new Set(candidates)]) {
    if (!fs.existsSync(filePath)) continue;
    process.loadEnvFile(filePath);
}
