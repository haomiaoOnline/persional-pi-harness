import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, "..");
const PACKAGE_ROOT = join(REPO_ROOT, "packages", "coding-agent");

function createIsolatedEnvironment(root) {
  const home = join(root, "home");
  const temporary = join(root, "tmp");
  const cache = join(root, "cache");
  const npmCache = join(cache, "npm");

  for (const directory of [home, temporary, cache, npmCache, join(home, ".config")]) {
    mkdirSync(directory, { recursive: true });
  }

  // 只把测试所需的非敏感系统变量带入子进程，避免把开发机凭证带进回归套件。
  const environment = {
    PATH: process.env.PATH ?? "",
    HOME: home,
    USERPROFILE: home,
    TMPDIR: temporary,
    TMP: temporary,
    TEMP: temporary,
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_CACHE_HOME: cache,
    LANG: "C",
    LC_ALL: "C",
    TZ: "UTC",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
    NPM_CONFIG_USERCONFIG: join(root, "npm-userconfig"),
    NPM_CONFIG_GLOBALCONFIG: join(root, "npm-globalconfig"),
    NPM_CONFIG_CACHE: npmCache,
    PI_NO_LOCAL_LLM: "1",
    PPH_PERSONAL_REGRESSION: "1",
    PI_SKIP_VERSION_CHECK: "1",
    AWS_EC2_METADATA_DISABLED: "true",
  };

  for (const name of ["SystemRoot", "WINDIR", "ComSpec", "PATHEXT"]) {
    if (process.env[name]) environment[name] = process.env[name];
  }

  return environment;
}

function main() {
  const isolatedRoot = mkdtempSync(join(tmpdir(), "pph-personal-regression-"));
  try {
    const vitest = resolve(REPO_ROOT, "node_modules", "vitest", "vitest.mjs");
    const testFiles = [
      "test/config.test.ts",
      "test/package-distribution.test.ts",
      "test/personal-pi-regression.test.ts",
    ];
    const result = spawnSync(
      process.execPath,
      [vitest, "--run", "--config", "vitest.config.ts", ...testFiles],
      {
        cwd: PACKAGE_ROOT,
        env: createIsolatedEnvironment(isolatedRoot),
        stdio: "inherit",
      },
    );

    if (result.error) throw result.error;
    process.exitCode = result.status ?? 1;
  } finally {
    rmSync(isolatedRoot, { recursive: true, force: true });
  }
}

main();
