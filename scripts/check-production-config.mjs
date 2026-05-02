import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..");
const ADMIN_CONFIG_FILE = path.join(ROOT, "data", "admin-config.json");

loadDotEnv(path.join(ROOT, ".env"));

const expectedBundleId = "com.jin.realestatemarketing";
const adminConfig = readAdminConfig();
const runningHub = runningHubConfig(adminConfig.runningHub ?? {});

const checks = [];

requireValue("PUBLIC_API_BASE_URL", env("PUBLIC_API_BASE_URL"), "Set this to the public Render backend URL.");
check(
  "APPLE_BUNDLE_ID",
  env("APPLE_BUNDLE_ID", expectedBundleId) === expectedBundleId,
  `Expected ${expectedBundleId}.`
);
check(
  "APPLE_IAP_VALIDATION_MODE",
  env("APPLE_IAP_VALIDATION_MODE", "decode").toLowerCase() === "strict",
  "Set APPLE_IAP_VALIDATION_MODE=strict before App Store release."
);
check(
  "DEFAULT_STARTING_CREDITS",
  numberEnv("DEFAULT_STARTING_CREDITS", 0) === 0,
  "Set DEFAULT_STARTING_CREDITS=0 for paid production release."
);

if (boolEnv("R2_MOCK", true)) {
  fail("R2_MOCK", "Set R2_MOCK=false in production.");
} else {
  requireValue("R2_BUCKET", firstNonEmpty(env("R2_BUCKET"), env("METROVAN_OBJECT_STORAGE_BUCKET")), "Object storage bucket is required.");
  requireValue("R2_ACCESS_KEY_ID", firstNonEmpty(env("R2_ACCESS_KEY_ID"), env("METROVAN_OBJECT_STORAGE_ACCESS_KEY_ID")), "Object storage access key is required.");
  requireValue("R2_SECRET_ACCESS_KEY", firstNonEmpty(env("R2_SECRET_ACCESS_KEY"), env("METROVAN_OBJECT_STORAGE_SECRET_ACCESS_KEY")), "Object storage secret key is required.");
  requireValue("R2_ENDPOINT or R2_ACCOUNT_ID", firstNonEmpty(env("R2_ENDPOINT"), env("METROVAN_OBJECT_STORAGE_ENDPOINT"), env("R2_ACCOUNT_ID"), env("CLOUDFLARE_ACCOUNT_ID")), "Object storage endpoint or Cloudflare account id is required.");
}

if (boolEnv("RUNNINGHUB_MOCK", true)) {
  fail("RUNNINGHUB_MOCK", "Set RUNNINGHUB_MOCK=false in production.");
} else {
  requireValue("AI_API_KEY", runningHub.apiKey, "AI workflow API key is required.");
  requireValue("AI_WORKFLOW_ID", runningHub.workflowId, "AI workflow id is required.");
  requireValue("AI_INPUT_NODE_ID", runningHub.inputNodeId, "Input node id is required.");
  requireValue("AI_INPUT_FIELD", runningHub.inputField, "Input field is required.");
}

const adminEmails = env("ADMIN_EMAILS", env("METROVAN_ADMIN_EMAILS"))
  .split(",")
  .map(value => value.trim().toLowerCase())
  .filter(Boolean);
requireValue("ADMIN_PIN", env("ADMIN_PIN", env("METROVAN_ADMIN_PIN")), "Admin PIN is required for the hidden admin console.");
requireValue("ADMIN_EMAILS", adminEmails.join(","), "Set the allowed admin email list.");
check(
  "ADMIN_EMAILS includes owner",
  adminEmails.includes("zhoujin0618@gmail.com"),
  "ADMIN_EMAILS should include zhoujin0618@gmail.com."
);
const adminSecret = env("ADMIN_SESSION_SECRET", env("METROVAN_ADMIN_SESSION_SECRET"));
requireValue("ADMIN_SESSION_SECRET", adminSecret, "Use a strong random value that is not the admin PIN.");
check(
  "ADMIN_SESSION_SECRET strength",
  adminSecret.length >= 32 && adminSecret !== env("ADMIN_PIN", env("METROVAN_ADMIN_PIN")),
  "Use at least 32 characters and do not reuse ADMIN_PIN."
);

printReport(checks);

const failed = checks.filter(entry => !entry.ok);
process.exitCode = failed.length ? 1 : 0;

function runningHubConfig(adminRunningHub) {
  return {
    apiKey: firstNonEmpty(adminRunningHub.apiKey, env("RUNNINGHUB_API_KEY"), env("METROVAN_RUNNINGHUB_API_KEY")),
    workflowId: firstNonEmpty(adminRunningHub.workflowId, env("RUNNINGHUB_WORKFLOW_ID"), env("METROVAN_RUNNINGHUB_DEFAULT_WORKFLOW_ID")),
    inputNodeId: firstNonEmpty(adminRunningHub.inputNodeId, env("RUNNINGHUB_INPUT_NODE_ID"), env("METROVAN_RUNNINGHUB_DEFAULT_INPUT_NODE_ID")),
    inputField: firstNonEmpty(adminRunningHub.inputField, env("RUNNINGHUB_INPUT_FIELD"), env("METROVAN_RUNNINGHUB_DEFAULT_INPUT_FIELD", "image"))
  };
}

function requireValue(name, value, message) {
  check(name, Boolean(String(value || "").trim()), message);
}

function fail(name, message) {
  check(name, false, message);
}

function check(name, ok, message) {
  checks.push({ name, ok, message });
}

function printReport(items) {
  console.log("Production config check");
  console.log("=======================");
  for (const item of items) {
    console.log(`${item.ok ? "PASS" : "FAIL"} ${item.name}`);
    if (!item.ok) console.log(`  ${item.message}`);
  }

  const failed = items.filter(entry => !entry.ok).length;
  console.log("");
  console.log(failed ? `Result: ${failed} blocker(s) found.` : "Result: production config looks ready.");
}

function readAdminConfig() {
  if (!existsSync(ADMIN_CONFIG_FILE)) return {};
  try {
    return JSON.parse(readFileSync(ADMIN_CONFIG_FILE, "utf8"));
  } catch {
    return {};
  }
}

function loadDotEnv(filePath) {
  if (!existsSync(filePath)) return;
  const lines = readFileSync(filePath, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) continue;
    const index = trimmed.indexOf("=");
    const key = trimmed.slice(0, index).trim();
    const raw = trimmed.slice(index + 1).trim();
    if (!key || process.env[key] !== undefined) continue;
    process.env[key] = raw.replace(/^['"]|['"]$/g, "");
  }
}

function env(name, fallback = "") {
  return process.env[name] ?? fallback ?? "";
}

function numberEnv(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) ? value : fallback;
}

function boolEnv(name, fallback) {
  const value = process.env[name];
  if (value === undefined || value === "") return fallback;
  return ["1", "true", "yes", "on"].includes(String(value).toLowerCase());
}

function firstNonEmpty(...values) {
  return values.map(value => value === undefined || value === null ? "" : String(value).trim()).find(Boolean) || "";
}
