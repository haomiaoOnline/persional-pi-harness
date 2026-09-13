import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const promptSource = readFileSync(join(packageRoot, "src", "prompt.ts"), "utf8");
const forbiddenFields = [
  "schema_version",
  "task_revision",
  "graph_revision",
  "lease_epoch",
  "idempotency_key",
  "action_digest",
];
const leaked = forbiddenFields.filter((field) => new RegExp(`(?:\\.|['\"])${field}(?:['\"]|\\b)`).test(promptSource));

if (leaked.length > 0) {
  console.error(`protocol metadata appears in Prompt assembly: ${leaked.join(", ")}`);
  process.exitCode = 1;
} else {
  console.log("protocol metadata isolation: PASS");
}
