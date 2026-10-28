import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

// All tests run inside the Workers runtime (Miniflare) with real local D1 and R2 bindings.
export default defineConfig(async () => {
  const migrations = await readD1Migrations("./migrations");
  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: "./wrangler.jsonc" },
        miniflare: {
          // Test-only configuration: a fake Access team whose signing key the tests generate.
          bindings: {
            TEST_MIGRATIONS: migrations,
            ACCESS_TEAM_DOMAIN: "test-team.cloudflareaccess.com",
            ACCESS_AUD: "test-audience",
            ALLOWED_EMAILS: "helper@example.com, Joyce@Example.com",
            // Override any local .dev.vars: tests exercise real Access JWT checks.
            AUTH_MODE: "access",
            DEV_USER_EMAIL: "",
          },
        },
      }),
    ],
    test: {
      include: ["test/**/*.test.ts"],
      setupFiles: ["./test/apply-migrations.ts"],
    },
  };
});
