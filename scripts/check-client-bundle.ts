/**
 * PRV-08: after `next build`, verify the browser bundle contains no secret keys,
 * secret env var names, or Mock provider code.
 * Usage: npm run build && npm run check:bundle
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(process.cwd(), ".next", "static");
const FORBIDDEN: { label: string; re: RegExp }[] = [
  { label: "Toss secret key", re: /\b(test|live)_g?sk_[A-Za-z0-9]+/ },
  { label: "secret env var name", re: /\b(TOSS_SECRET_KEY|TOSS_SECURITY_KEY|NICE_CLIENT_SECRET|DATABASE_URL|DATABASE_URL_UNPOOLED|SHADOW_DATABASE_URL)\b/ },
  { label: "mock provider marker", re: /NAZIR_MOCK_PROVIDER_MODULE/ },
];

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(js|mjs|css|html|json)$/.test(name)) out.push(p);
  }
  return out;
}

let files: string[];
try {
  files = walk(ROOT);
} catch {
  console.error(`No build output at ${ROOT}. Run \`npm run build\` first.`);
  process.exit(1);
}

const hits: string[] = [];
for (const f of files) {
  const text = readFileSync(f, "utf8");
  for (const { label, re } of FORBIDDEN) if (re.test(text)) hits.push(`${label}: ${f}`);
}

if (hits.length > 0) {
  console.error(`Client bundle check FAILED:\n- ${hits.join("\n- ")}`);
  process.exit(1);
}
console.log(`Client bundle check passed (${files.length} files scanned).`);
