import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const file = process.env.RULES_FILE || '/config/rules.json';

function load() {
  if (!existsSync(file)) return [];
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    console.error(`[store] ${file} is unreadable, starting empty: ${err.message}`);
    return [];
  }
}

let rules = load();

export function listRules() {
  return rules;
}

export function replaceRules(next) {
  rules = next;
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(rules, null, 2)}\n`);
  renameSync(tmp, file);
  return rules;
}
