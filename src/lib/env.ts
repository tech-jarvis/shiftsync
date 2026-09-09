import path from "node:path";
import { config } from "dotenv";

/**
 * Environment loading for non-Next entry points.
 *
 * Next.js reads .env.local itself, but vitest and tsx (the seed script) do not,
 * and `dotenv/config` only reads plain `.env`. Loading both here in Next's own
 * precedence order -- .env.local wins -- means tests, scripts and the app all
 * read exactly the same configuration.
 *
 * `override: false` keeps real environment variables authoritative, so CI and
 * production settings are never clobbered by a stray local file.
 */
for (const file of [".env.local", ".env"]) {
  config({ path: path.resolve(process.cwd(), file), override: false, quiet: true });
}

export function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `${name} is not set. Copy .env.example to .env.local, then run \`pnpm db:start\`.`,
    );
  }
  return value;
}
