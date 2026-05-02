const baseUrl = new URL(process.env.BACKEND_URL || "https://jin-native-ai-backend.onrender.com");
baseUrl.pathname = baseUrl.pathname.replace(/\/$/, "");

const checks = [];

await checkJson("/api/health", "health", response => {
  const hasNewFields = response.body.storageMode && response.body.aiProcessingMode;
  const isStrict = response.body.iapValidationMode === "strict";
  return {
    ok: response.status === 200 && hasNewFields && isStrict,
    detail: hasNewFields
      ? `storage=${response.body.storageMode}, ai=${response.body.aiProcessingMode}, iap=${response.body.iapValidationMode}`
      : "Health endpoint is still using the old response shape."
  };
});

await checkJson("/api/readiness", "readiness", response => {
  const failed = Array.isArray(response.body.checks)
    ? response.body.checks.filter(check => !check.ok).map(check => check.key || check.label)
    : [];
  return {
    ok: response.status === 200 && response.body.ok === true && failed.length === 0,
    detail: response.status === 404
      ? "Readiness endpoint is missing; deploy the latest backend."
      : failed.length
        ? `Failed checks: ${failed.join(", ")}`
        : `ok=${response.body.ok}`
  };
});

await checkPage("/privacy", "privacy page", "隐私政策");
await checkPage("/terms", "terms page", "服务条款");
await checkPage("/support", "support page", "支持中心");

printReport(checks);
process.exitCode = checks.every(check => check.ok) ? 0 : 1;

async function checkJson(path, label, validate) {
  try {
    const response = await fetch(urlFor(path));
    const text = await response.text();
    const body = text ? JSON.parse(text) : {};
    const result = validate({ status: response.status, body });
    checks.push({ label, status: response.status, ...result });
  } catch (error) {
    checks.push({ label, ok: false, detail: error.message || "Request failed" });
  }
}

async function checkPage(path, label, expectedText) {
  try {
    const response = await fetch(urlFor(path));
    const text = await response.text();
    checks.push({
      label,
      status: response.status,
      ok: response.status === 200 && text.includes(expectedText),
      detail: response.status === 404 ? "Page is missing; deploy the latest backend." : `contains expected text=${text.includes(expectedText)}`
    });
  } catch (error) {
    checks.push({ label, ok: false, detail: error.message || "Request failed" });
  }
}

function urlFor(path) {
  const url = new URL(baseUrl);
  url.pathname = `${baseUrl.pathname}${path}`.replace(/\/+/g, "/");
  return url;
}

function printReport(items) {
  console.log(`Live backend verification: ${baseUrl.toString().replace(/\/$/, "")}`);
  console.log("==============================================");
  for (const item of items) {
    const status = item.status ? ` (${item.status})` : "";
    console.log(`${item.ok ? "PASS" : "FAIL"} ${item.label}${status}`);
    if (item.detail) console.log(`  ${item.detail}`);
  }
  const failed = items.filter(item => !item.ok).length;
  console.log("");
  console.log(failed ? `Result: ${failed} live check(s) failed.` : "Result: live backend is ready.");
}
