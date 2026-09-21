import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync, rmSync, readdirSync } from "node:fs";

const output = new URL("../.test-dist/", import.meta.url);
rmSync(output, { recursive: true, force: true });
const build = spawnSync(
  process.execPath,
  ["node_modules/typescript/bin/tsc", "-p", "test/tsconfig.json"],
  { stdio: "inherit" },
);
if (build.status !== 0) process.exit(build.status ?? 1);
mkdirSync(output, { recursive: true });
// Compile tests separately: the package remains ESM and ships only dist/.
writeFileSync(new URL("package.json", output), '{"type":"commonjs"}\n');
const tests = readdirSync(new URL("test/", output)).filter((file) =>
  file.endsWith(".test.js"),
);
const result = spawnSync(
  process.execPath,
  [
    "--test",
    ...process.argv.slice(2),
    ...tests.map((file) => `.test-dist/test/${file}`),
  ],
  { stdio: "inherit" },
);
process.exit(result.status ?? 1);
