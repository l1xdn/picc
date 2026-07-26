#!/usr/bin/env node
const { execFileSync } = require('child_process');
const fs = require('fs');

const patterns = [
    ['private key', /-----BEGIN(?: [A-Z]+)? PRIVATE KEY-----/],
    ['Google OAuth client ID', /\b\d{6,}-[a-z0-9]{20,}\.apps\.googleusercontent\.com\b/i],
    ['Google OAuth client secret', /\bGOCSPX-[A-Za-z0-9_-]{16,}\b/],
    ['OpenAI-style API key', /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/],
    ['GitHub token', /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/],
    ['AWS access key', /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/],
    ['Slack token', /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/],
    ['Stripe live key', /\b[rs]k_live_[A-Za-z0-9]{20,}\b/],
    ['credential assignment', /\b(?:client[_-]?secret|access[_-]?token|refresh[_-]?token|api[_-]?key|password)\b\s*["']?\s*[:=]\s*["'][^"'\s]{16,}["']/i]
];

const output = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z']);
const files = output.toString('utf8').split('\0').filter(Boolean);
const findings = [];

for (const file of files) {
    let content;
    try {
        const buffer = fs.readFileSync(file);
        if (buffer.includes(0)) continue;
        content = buffer.toString('utf8');
    } catch {
        continue;
    }
    content.split(/\r?\n/).forEach((line, index) => {
        if (/^\s*(?:#|\/\/)/.test(line) && /(?:example|placeholder|redacted|your[-_])/i.test(line)) return;
        for (const [kind, pattern] of patterns) {
            if (pattern.test(line) && !/\[REDACTED\]|your[-_]|example\.com|example\.test|changeme|\{env:/i.test(line)) {
                findings.push(`${file}:${index + 1}: possible ${kind}`);
            }
        }
    });
}

if (findings.length) {
    console.error('Potential secrets found (values are intentionally not printed):');
    findings.forEach(finding => console.error(`  ${finding}`));
    process.exit(1);
}

console.log(`✓ Secret scan passed (${files.length} files checked)`);
