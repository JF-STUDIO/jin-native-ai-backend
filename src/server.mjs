import { createReadStream, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import crypto from "node:crypto";
import http from "node:http";
import { openAsBlob } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..");
const DATA_DIR = path.join(ROOT, "data");
const DB_FILE = path.join(DATA_DIR, "db.json");
const ADMIN_CONFIG_FILE = path.join(DATA_DIR, "admin-config.json");
const MOCK_R2_DIR = path.join(DATA_DIR, "mock-r2");
const MAX_BODY_BYTES = 20 * 1024 * 1024;

loadDotEnv(path.join(ROOT, ".env"));
mkdirSync(DATA_DIR, { recursive: true });
mkdirSync(MOCK_R2_DIR, { recursive: true });

const config = {
  port: numberEnv("PORT", 8787),
  publicApiBaseUrl: env("PUBLIC_API_BASE_URL", "http://127.0.0.1:8787"),
  r2Mock: boolEnv("R2_MOCK", true),
  runningHubMock: boolEnv("RUNNINGHUB_MOCK", true),
  r2AccountId: env("R2_ACCOUNT_ID", env("CLOUDFLARE_ACCOUNT_ID")),
  r2Endpoint: env("R2_ENDPOINT", env("METROVAN_OBJECT_STORAGE_ENDPOINT")),
  r2Bucket: env("R2_BUCKET", env("METROVAN_OBJECT_STORAGE_BUCKET")),
  r2AccessKeyId: env("R2_ACCESS_KEY_ID", env("METROVAN_OBJECT_STORAGE_ACCESS_KEY_ID")),
  r2SecretAccessKey: env("R2_SECRET_ACCESS_KEY", env("METROVAN_OBJECT_STORAGE_SECRET_ACCESS_KEY")),
  r2Region: env("R2_REGION", env("METROVAN_OBJECT_STORAGE_REGION", "auto")),
  r2PublicBaseUrl: env("R2_PUBLIC_BASE_URL"),
  r2KeyPrefix: env("R2_KEY_PREFIX", "native-app").replace(/^\/+|\/+$/g, ""),
  r2UploadExpiresSeconds: numberEnv("R2_UPLOAD_EXPIRES_SECONDS", numberEnv("METROVAN_OBJECT_UPLOAD_EXPIRES_SECONDS", 900)),
  r2ResultExpiresSeconds: numberEnv("R2_RESULT_EXPIRES_SECONDS", 21600),
  runningHubApiKey: env("RUNNINGHUB_API_KEY", env("METROVAN_RUNNINGHUB_API_KEY")),
  runningHubWorkflowId: env("RUNNINGHUB_WORKFLOW_ID", env("METROVAN_RUNNINGHUB_DEFAULT_WORKFLOW_ID")),
  runningHubInstanceType: env("RUNNINGHUB_INSTANCE_TYPE", env("METROVAN_RUNNINGHUB_DEFAULT_INSTANCE_TYPE", "plus")),
  runningHubInputNodeId: env("RUNNINGHUB_INPUT_NODE_ID", env("METROVAN_RUNNINGHUB_DEFAULT_INPUT_NODE_ID", "61")),
  runningHubInputField: env("RUNNINGHUB_INPUT_FIELD", env("METROVAN_RUNNINGHUB_DEFAULT_INPUT_FIELD", "image")),
  runningHubInputMode: env("RUNNINGHUB_INPUT_MODE", env("METROVAN_RUNNINGHUB_DEFAULT_INPUT_MODE", "image")),
  runningHubOutputNodeId: env("RUNNINGHUB_OUTPUT_NODE_ID", env("METROVAN_RUNNINGHUB_DEFAULT_OUTPUT_NODE_ID")),
  runningHubOutputField: env("RUNNINGHUB_OUTPUT_FIELD", env("METROVAN_RUNNINGHUB_DEFAULT_OUTPUT_FIELD", "output")),
  runningHubOutputMode: env("RUNNINGHUB_OUTPUT_MODE", env("METROVAN_RUNNINGHUB_DEFAULT_OUTPUT_MODE", "file")),
  runningHubOutputPollSeconds: numberEnv("RUNNINGHUB_OUTPUT_POLL_SECONDS", 3600),
  bundleId: env("APPLE_BUNDLE_ID", "com.jin.realestatemarketing"),
  iapValidationMode: env("APPLE_IAP_VALIDATION_MODE", "decode").toLowerCase(),
  defaultStartingCredits: numberEnv("DEFAULT_STARTING_CREDITS", 0),
  adminPin: env("ADMIN_PIN", env("METROVAN_ADMIN_PIN")),
  adminEmails: env("ADMIN_EMAILS", env("METROVAN_ADMIN_EMAILS")).split(",").map(value => value.trim().toLowerCase()).filter(Boolean),
  adminSessionSecret: env("ADMIN_SESSION_SECRET", env("METROVAN_ADMIN_SESSION_SECRET", env("ADMIN_PIN", env("METROVAN_ADMIN_PIN")))),
  adminSessionTtlSeconds: numberEnv("ADMIN_SESSION_TTL_SECONDS", 60 * 60 * 6)
};

const IAP_PRODUCTS = {
  "com.jinrealestate.pro.monthly": { credits: 30, type: "auto_renewable_subscription" },
  "com.jinrealestate.credits.20": { credits: 20, type: "consumable" },
  "com.jinrealestate.credits.100": { credits: 100, type: "consumable" }
};

const APPLE_ROOT_CA_SHA256_FINGERPRINTS = new Set([
  "63343ABFB89A6A03EBB57E9B3F5FA7BE7C4F5C756F3017B3A8C488C3653E9179"
]);

const s3 = createS3Client();

function defaultDb() {
  return {
    projects: [],
    assets: [],
    jobs: [],
    accounts: [],
    creditLedger: [],
    iapTransactions: []
  };
}

function readDb() {
  if (!existsSync(DB_FILE)) {
    const db = defaultDb();
    writeDb(db);
    return db;
  }
  try {
    return { ...defaultDb(), ...JSON.parse(readFileSync(DB_FILE, "utf8")) };
  } catch {
    return defaultDb();
  }
}

function writeDb(db) {
  writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
}

function defaultAdminConfig() {
  return {
    runningHub: {
      apiKey: "",
      workflowId: "",
      instanceType: "",
      inputNodeId: "",
      inputField: "",
      inputMode: "",
      outputNodeId: "",
      outputField: "",
      outputMode: ""
    },
    updatedAt: null
  };
}

function readAdminConfig() {
  if (!existsSync(ADMIN_CONFIG_FILE)) return defaultAdminConfig();
  try {
    return { ...defaultAdminConfig(), ...JSON.parse(readFileSync(ADMIN_CONFIG_FILE, "utf8")) };
  } catch {
    return defaultAdminConfig();
  }
}

function writeAdminConfig(adminConfig) {
  writeFileSync(ADMIN_CONFIG_FILE, JSON.stringify(adminConfig, null, 2));
}

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,PUT,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type,Authorization",
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body)
  });
  res.end(body);
}

function sendText(res, status, text) {
  res.writeHead(status, {
    "Access-Control-Allow-Origin": "*",
    "Content-Type": "text/plain; charset=utf-8",
    "Content-Length": Buffer.byteLength(text)
  });
  res.end(text);
}

function sendHtml(res, status, html) {
  res.writeHead(status, {
    "Access-Control-Allow-Origin": "*",
    "Content-Type": "text/html; charset=utf-8",
    "Content-Length": Buffer.byteLength(html)
  });
  res.end(html);
}

function legalPage(kind, baseUrl = config.publicApiBaseUrl.replace(/\/$/, "")) {
  const pages = {
    privacy: {
      title: "隐私政策",
      intro: "本政策说明经纪营销助手如何处理经纪人资料、房源信息、上传照片、生成内容、购买与积分记录。",
      sections: [
        ["我们收集的数据", "您主动填写的经纪人姓名、公司、联系方式、执照号；房源地址、价格、面积、备注；您选择上传的照片、Logo、证件照、PDF 或参考素材；App 自动生成的账号标识、积分账本、生成任务记录和购买交易标识。"],
        ["云端 AI 处理", "当您选择生成照片精修、视频、文案或营销素材时，相关照片和文件会上传至我们的云端服务，并可能由合作的云存储与 AI 处理服务提供商处理。我们不会在用户界面披露具体供应商名称，也不会将上传素材用于与本功能无关的广告或数据交易。"],
        ["使用目的", "我们使用这些数据来完成 AI 生成、保存生成结果、提供积分和订阅服务、排查故障、保护服务安全、响应用户支持与删除请求。"],
        ["第三方共享", "我们只在完成服务所需范围内与云存储、AI 处理、Apple In-App Purchase 和基础设施服务提供商共享必要数据。我们要求相关服务提供商按照合理的安全和保密要求处理数据。"],
        ["保存与删除", "本机资料保存在您的设备上。云端上传素材、生成任务和积分账本会保留用于完成服务、排查问题和用户再次访问；您可以在 App 的“我的 > 隐私政策与条款”中删除云端账号数据。删除后，已上传素材、生成任务和自动账号关联记录会从我们的服务中删除，法律或财务合规必须保留的购买记录除外。"],
        ["儿童隐私", "本 App 面向房地产专业人士，不面向儿童使用。"],
        ["联系我们", "如需隐私、支持或删除协助，请联系 zhoujin0618@gmail.com。"]
      ]
    },
    terms: {
      title: "服务条款",
      intro: "使用经纪营销助手即表示您同意以下条款。请在发布任何 AI 生成内容前自行核对。",
      sections: [
        ["适用范围", "经纪营销助手为房地产经纪提供照片精修、视频、房源文案、名片和宣传物料生成工具。"],
        ["用户责任", "您必须确认自己有权上传和使用房源照片、Logo、证件照、参考文件和房源信息。AI 生成内容可能包含错误，发布前必须由您核对地址、价格、面积、MLS 描述、执照信息和当地广告合规要求。"],
        ["禁止用途", "不得上传违法、侵权、误导性、歧视性或未经授权的素材；不得使用本服务生成虚假房源信息、保证收益、保证成交或其他违反房地产广告规则的内容。"],
        ["订阅与积分", "数字生成服务通过 Apple In-App Purchase 购买。订阅取消、退款和账单由 Apple 管理。删除 App 内账号数据不会自动取消 Apple 订阅。"],
        ["服务可用性", "AI 处理依赖云端服务，可能受到网络、第三方服务、素材质量和工作流配置影响。我们会尽力保持服务可用，但不保证任何生成结果一定适合发布或商业使用。"],
        ["联系我们", "如需支持，请联系 zhoujin0618@gmail.com。"]
      ]
    },
    support: {
      title: "支持中心",
      intro: "如果您在使用经纪营销助手时遇到问题，可以通过以下方式排查或联系我们。",
      sections: [
        ["常见问题", "AI 修图需要先选择照片，并在首次生成前同意云端 AI 处理。生成失败时，本次扣除的积分会自动退回。"],
        ["订阅与购买", "订阅和积分包由 Apple In-App Purchase 处理。您可以在 iPhone 的 Apple ID 订阅管理页面取消订阅。"],
        ["数据删除", "请在 App 中打开“我的 > 隐私政策与条款 > 删除云端账号数据”，即可发起删除自动账号关联的云端素材和生成任务。"],
        ["联系我们", "邮箱：zhoujin0618@gmail.com。请附上设备型号、App 版本、问题截图和大致发生时间，方便排查。"]
      ]
    }
  };
  const page = pages[kind] || pages.support;
  const nav = [
    ["隐私政策", `${baseUrl}/privacy`],
    ["服务条款", `${baseUrl}/terms`],
    ["支持中心", `${baseUrl}/support`]
  ].map(([label, href]) => `<a href="${escapeHtml(href)}">${escapeHtml(label)}</a>`).join("");
  const sections = page.sections.map(([title, body]) => `
    <section>
      <h2>${escapeHtml(title)}</h2>
      <p>${escapeHtml(body)}</p>
    </section>
  `).join("");
  return `<!doctype html>
<html lang="zh-Hans">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(page.title)} - 经纪营销助手</title>
  <style>
    :root { color-scheme: light dark; --brand: #176d5a; --ink: #17201d; --muted: #6d766f; --line: #e5ebe7; --bg: #f7faf8; --card: #ffffff; }
    @media (prefers-color-scheme: dark) { :root { --ink: #f3f6f4; --muted: #a9b2ad; --line: #33423b; --bg: #101614; --card: #17201d; } }
    body { margin: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: var(--bg); color: var(--ink); line-height: 1.65; }
    main { max-width: 820px; margin: 0 auto; padding: 36px 18px 56px; }
    header { margin-bottom: 18px; }
    .eyebrow { color: var(--brand); font-size: 13px; font-weight: 700; letter-spacing: .03em; text-transform: uppercase; }
    h1 { font-size: clamp(30px, 6vw, 48px); line-height: 1.08; margin: 8px 0 12px; }
    h2 { font-size: 19px; margin: 0 0 8px; }
    p { margin: 0; color: var(--muted); }
    nav { display: flex; gap: 10px; flex-wrap: wrap; margin: 22px 0; }
    nav a { color: var(--brand); text-decoration: none; font-weight: 700; padding: 8px 12px; border: 1px solid var(--line); border-radius: 999px; background: var(--card); }
    section { background: var(--card); border: 1px solid var(--line); border-radius: 14px; padding: 18px; margin: 12px 0; }
    footer { color: var(--muted); font-size: 13px; margin-top: 22px; }
  </style>
</head>
<body>
  <main>
    <header>
      <div class="eyebrow">经纪营销助手</div>
      <h1>${escapeHtml(page.title)}</h1>
      <p>${escapeHtml(page.intro)}</p>
      <nav>${nav}</nav>
    </header>
    ${sections}
    <footer>最后更新：2026-05-01</footer>
  </main>
</body>
</html>`;
}

function requestBaseUrl(req) {
  const forwardedProto = String(req.headers["x-forwarded-proto"] || "").split(",")[0].trim();
  const forwardedHost = String(req.headers["x-forwarded-host"] || "").split(",")[0].trim();
  const proto = forwardedProto || (req.socket.encrypted ? "https" : "http");
  const host = forwardedHost || req.headers.host || new URL(config.publicApiBaseUrl).host;
  return `${proto}://${host}`.replace(/\/$/, "");
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", chunk => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(Object.assign(new Error("Request body too large"), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(Object.assign(new Error("Invalid JSON"), { status: 400 }));
      }
    });
    req.on("error", reject);
  });
}

async function readRawBodyToFile(req, filePath) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const chunks = [];
  let size = 0;
  await new Promise((resolve, reject) => {
    req.on("data", chunk => {
      size += chunk.length;
      if (size > 1024 * 1024 * 1024) {
        reject(Object.assign(new Error("Upload too large"), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", resolve);
    req.on("error", reject);
  });
  await writeFile(filePath, Buffer.concat(chunks));
}

async function handleApi(req, res, pathname) {
  if (req.method === "OPTIONS") return sendJson(res, 204, {});

  if (["GET", "HEAD"].includes(req.method) && pathname === "/privacy") {
    return sendHtml(res, 200, legalPage("privacy", requestBaseUrl(req)));
  }

  if (["GET", "HEAD"].includes(req.method) && pathname === "/terms") {
    return sendHtml(res, 200, legalPage("terms", requestBaseUrl(req)));
  }

  if (["GET", "HEAD"].includes(req.method) && pathname === "/support") {
    return sendHtml(res, 200, legalPage("support", requestBaseUrl(req)));
  }

  if (pathname === "/api/health") return sendJson(res, 200, {
    ok: true,
    storageMode: config.r2Mock ? "mock" : "cloud",
    aiProcessingMode: config.runningHubMock ? "mock" : "cloud",
    iapValidationMode: config.iapValidationMode
  });

  if (pathname === "/api/readiness") {
    const report = productionReadinessReport();
    return sendJson(res, report.ok ? 200 : 503, report);
  }

  if (req.method === "POST" && pathname === "/api/account/bootstrap") {
    return bootstrapAccount(req, res);
  }

  if (req.method === "GET" && pathname === "/api/account/credits") {
    return getAccountCredits(req, res);
  }

  if (req.method === "POST" && pathname === "/api/account/credits/spend") {
    return spendCredits(req, res);
  }

  if (req.method === "POST" && pathname === "/api/account/credits/refund") {
    return refundCredits(req, res);
  }

  if (req.method === "POST" && pathname === "/api/account/delete") {
    return deleteAccountData(req, res);
  }

  if (req.method === "POST" && pathname === "/api/iap/transactions") {
    return recordIapTransaction(req, res);
  }

  if (req.method === "POST" && pathname === "/api/apple/notifications") {
    return recordAppleServerNotification(req, res);
  }

  if (req.method === "POST" && pathname === "/api/admin/login") {
    return adminLogin(req, res);
  }

  if (req.method === "GET" && pathname === "/api/admin/config") {
    const admin = requireAdmin(req, res);
    if (!admin) return;
    return sendJson(res, 200, getAdminPublicConfig());
  }

  if (req.method === "PATCH" && pathname === "/api/admin/runninghub") {
    const admin = requireAdmin(req, res);
    if (!admin) return;
    return updateRunningHubAdminConfig(req, res);
  }

  if (req.method === "POST" && pathname === "/api/admin/test-runninghub") {
    const admin = requireAdmin(req, res);
    if (!admin) return;
    return testRunningHubAdminConfig(res);
  }

  if (req.method === "GET" && pathname === "/api/projects") {
    return sendJson(res, 200, { projects: readDb().projects });
  }

  if (req.method === "POST" && pathname === "/api/projects") {
    const body = await readJsonBody(req);
    const now = new Date().toISOString();
    const project = {
      id: id("project"),
      title: String(body.title ?? body.address ?? "Untitled Project"),
      context: String(body.context ?? body.city ?? ""),
      category: String(body.category ?? "照片修图"),
      note: String(body.note ?? ""),
      createdAt: now,
      updatedAt: now
    };
    const db = readDb();
    db.projects.unshift(project);
    writeDb(db);
    return sendJson(res, 201, project);
  }

  const uploadTargetMatch = pathname.match(/^\/api\/projects\/([^/]+)\/upload-targets$/);
  if (req.method === "POST" && uploadTargetMatch) {
    return createUploadTargets(req, res, uploadTargetMatch[1]);
  }

  const completeMatch = pathname.match(/^\/api\/projects\/([^/]+)\/uploads\/complete$/);
  if (req.method === "POST" && completeMatch) {
    return completeUploads(req, res, completeMatch[1]);
  }

  const jobMatch = pathname.match(/^\/api\/projects\/([^/]+)\/photo-retouch-jobs$/);
  if (req.method === "POST" && jobMatch) {
    return createPhotoRetouchJob(req, res, jobMatch[1]);
  }

  const jobStatusMatch = pathname.match(/^\/api\/projects\/([^/]+)\/jobs\/([^/]+)$/);
  if (req.method === "GET" && jobStatusMatch) {
    return getJobStatus(res, jobStatusMatch[1], jobStatusMatch[2]);
  }

  const assetsMatch = pathname.match(/^\/api\/projects\/([^/]+)\/assets$/);
  if (req.method === "GET" && assetsMatch) {
    const projectId = assetsMatch[1];
    const assets = readDb().assets.filter(asset => asset.projectId === projectId);
    return sendJson(res, 200, { assets: assets.map(publicAsset) });
  }

  if (config.r2Mock && req.method === "PUT" && pathname.startsWith("/mock-r2/")) {
    const key = decodeURIComponent(pathname.replace("/mock-r2/", ""));
    const filePath = path.join(MOCK_R2_DIR, safeStorageKey(key));
    await readRawBodyToFile(req, filePath);
    return sendJson(res, 200, { ok: true });
  }

  if (config.r2Mock && req.method === "GET" && pathname.startsWith("/mock-r2/")) {
    const key = decodeURIComponent(pathname.replace("/mock-r2/", ""));
    const filePath = path.join(MOCK_R2_DIR, safeStorageKey(key));
    if (!existsSync(filePath)) return sendText(res, 404, "Not found");
    res.writeHead(200, { "Access-Control-Allow-Origin": "*", "Content-Type": "image/jpeg" });
    return createReadStream(filePath).pipe(res);
  }

  return sendJson(res, 404, { error: "Not found" });
}

async function bootstrapAccount(req, res) {
  const body = await readJsonBody(req);
  const account = ensureAccount(String(body.appAccountToken || getAppAccountToken(req) || ""), String(body.email || ""));
  return sendJson(res, 200, publicAccount(account));
}

function getAccountCredits(req, res) {
  const account = getRequiredAccount(req, res);
  if (!account) return;
  return sendJson(res, 200, publicAccount(account));
}

async function spendCredits(req, res) {
  const body = await readJsonBody(req);
  const account = getRequiredAccount(req, res, String(body.appAccountToken || ""));
  if (!account) return;

  const amount = Math.max(0, Math.floor(Number(body.amount || 0)));
  if (!amount) return sendJson(res, 400, { error: "amount is required" });
  const idempotencyKey = String(body.idempotencyKey || "").trim();
  if (!idempotencyKey) return sendJson(res, 400, { error: "idempotencyKey is required" });

  const db = readDb();
  const existing = db.creditLedger.find(entry =>
    entry.accountId === account.id && entry.idempotencyKey === idempotencyKey
  );
  if (existing) {
    const current = db.accounts.find(entry => entry.id === account.id) || account;
    return sendJson(res, 200, {
      account: publicAccount(current),
      ledgerEntry: existing,
      idempotent: true
    });
  }

  const current = db.accounts.find(entry => entry.id === account.id);
  if (!current) return sendJson(res, 404, { error: "Account not found" });
  if (current.creditBalance < amount) {
    return sendJson(res, 402, {
      error: "Insufficient credits",
      account: publicAccount(current)
    });
  }

  const entry = addCreditLedgerEntry(db, current, {
    amount: -amount,
    reason: String(body.reason || "generation_spend"),
    source: "generation",
    idempotencyKey,
    metadata: asRecord(body.metadata) || {}
  });
  writeDb(db);
  return sendJson(res, 200, {
    account: publicAccount(current),
    ledgerEntry: entry,
    idempotent: false
  });
}

async function refundCredits(req, res) {
  const body = await readJsonBody(req);
  const account = getRequiredAccount(req, res, String(body.appAccountToken || ""));
  if (!account) return;

  const amount = Math.max(0, Math.floor(Number(body.amount || 0)));
  if (!amount) return sendJson(res, 400, { error: "amount is required" });
  const idempotencyKey = String(body.idempotencyKey || "").trim();
  if (!idempotencyKey) return sendJson(res, 400, { error: "idempotencyKey is required" });

  const db = readDb();
  const existing = db.creditLedger.find(entry =>
    entry.accountId === account.id && entry.idempotencyKey === idempotencyKey
  );
  if (existing) {
    const current = db.accounts.find(entry => entry.id === account.id) || account;
    return sendJson(res, 200, {
      account: publicAccount(current),
      ledgerEntry: existing,
      idempotent: true
    });
  }

  const current = db.accounts.find(entry => entry.id === account.id);
  if (!current) return sendJson(res, 404, { error: "Account not found" });
  const entry = addCreditLedgerEntry(db, current, {
    amount,
    reason: String(body.reason || "generation_refund"),
    source: "refund",
    idempotencyKey,
    metadata: asRecord(body.metadata) || {}
  });
  writeDb(db);
  return sendJson(res, 200, {
    account: publicAccount(current),
    ledgerEntry: entry,
    idempotent: false
  });
}

async function deleteAccountData(req, res) {
  const body = await readJsonBody(req);
  const account = getRequiredAccount(req, res, String(body.appAccountToken || ""));
  if (!account) return;

  const db = readDb();
  const assets = db.assets.filter(asset => asset.accountId === account.id || asset.appAccountToken === account.appAccountToken);
  const jobs = db.jobs.filter(job => job.accountId === account.id || job.appAccountToken === account.appAccountToken);
  const storageKeys = new Set();
  for (const asset of assets) {
    if (asset.originalStorageKey) storageKeys.add(asset.originalStorageKey);
    if (asset.resultStorageKey) storageKeys.add(asset.resultStorageKey);
  }

  const deleteErrors = [];
  for (const storageKey of storageKeys) {
    try {
      await deleteObjectFromStorage(storageKey);
    } catch (error) {
      deleteErrors.push({ storageKey, message: error.message || "Delete failed" });
    }
  }

  db.assets = db.assets.filter(asset => asset.accountId !== account.id && asset.appAccountToken !== account.appAccountToken);
  db.jobs = db.jobs.filter(job => job.accountId !== account.id && job.appAccountToken !== account.appAccountToken);
  db.projects = db.projects.filter(project => project.accountId !== account.id && project.appAccountToken !== account.appAccountToken);
  db.creditLedger = db.creditLedger.filter(entry => entry.accountId !== account.id);
  db.iapTransactions = db.iapTransactions.filter(entry => entry.accountId !== account.id);
  db.accounts = db.accounts.filter(entry => entry.id !== account.id);
  writeDb(db);

  return sendJson(res, deleteErrors.length ? 207 : 200, {
    ok: deleteErrors.length === 0,
    deleted: {
      assets: assets.length,
      jobs: jobs.length,
      storageObjects: storageKeys.size
    },
    errors: deleteErrors
  });
}

async function recordIapTransaction(req, res) {
  const body = await readJsonBody(req);
  const account = getRequiredAccount(req, res, String(body.appAccountToken || ""));
  if (!account) return;

  try {
    const transaction = verifyAndDecodeSignedTransaction(String(body.signedTransactionInfo || ""));
    const productId = String(transaction.productId || transaction.productID || body.productId || "");
    const product = IAP_PRODUCTS[productId];
    if (!product) return sendJson(res, 400, { error: "Unknown product id" });

    if (config.bundleId && transaction.bundleId && transaction.bundleId !== config.bundleId) {
      return sendJson(res, 400, { error: "Bundle id mismatch" });
    }

    const transactionAccountToken = String(transaction.appAccountToken || "").toLowerCase();
    if (transactionAccountToken && transactionAccountToken !== account.appAccountToken.toLowerCase()) {
      return sendJson(res, 409, { error: "Transaction belongs to another account token" });
    }

    const transactionId = String(transaction.transactionId || transaction.transactionID || "");
    if (!transactionId) return sendJson(res, 400, { error: "Transaction id is missing" });

    const db = readDb();
    const existing = db.iapTransactions.find(entry => entry.transactionId === transactionId);
    const current = db.accounts.find(entry => entry.id === account.id) || account;
    if (existing) {
      if (existing.accountId !== current.id) {
        return sendJson(res, 409, { error: "Transaction has already been assigned to another account" });
      }
      return sendJson(res, 200, {
        account: publicAccount(current),
        creditDelta: 0,
        transaction: publicIapTransaction(existing),
        idempotent: true
      });
    }

    const iapTransaction = {
      id: id("iap"),
      accountId: current.id,
      appAccountToken: current.appAccountToken,
      transactionId,
      originalTransactionId: String(transaction.originalTransactionId || transaction.originalTransactionID || ""),
      productId,
      type: product.type,
      environment: String(transaction.environment || ""),
      purchaseDate: transaction.purchaseDate || transaction.signedDate || null,
      signedTransactionInfo: String(body.signedTransactionInfo || ""),
      validationMode: config.iapValidationMode,
      createdAt: new Date().toISOString()
    };
    db.iapTransactions.push(iapTransaction);

    const creditDelta = product.credits;
    if (creditDelta > 0) {
      addCreditLedgerEntry(db, current, {
        amount: creditDelta,
        reason: "iap_purchase",
        source: "iap",
        productId,
        transactionId,
        idempotencyKey: `iap:${transactionId}`,
        metadata: {
          originalTransactionId: iapTransaction.originalTransactionId,
          environment: iapTransaction.environment
        }
      });
    }
    writeDb(db);

    return sendJson(res, 200, {
      account: publicAccount(current),
      creditDelta,
      transaction: publicIapTransaction(iapTransaction),
      idempotent: false
    });
  } catch (error) {
    return sendJson(res, error.status || 400, { error: error.message || "Invalid transaction" });
  }
}

async function recordAppleServerNotification(req, res) {
  const body = await readJsonBody(req);
  try {
    const notification = verifyAndDecodeSignedTransaction(String(body.signedPayload || ""));
    const data = asRecord(notification.data) || {};
    const signedTransactionInfo = String(data.signedTransactionInfo || "");
    if (!signedTransactionInfo) return sendJson(res, 200, { ok: true, ignored: true });

    const transaction = verifyAndDecodeSignedTransaction(signedTransactionInfo);
    const appAccountToken = String(transaction.appAccountToken || "");
    if (!appAccountToken) return sendJson(res, 200, { ok: true, ignored: true, reason: "missing appAccountToken" });

    const account = ensureAccount(appAccountToken, "");
    const productId = String(transaction.productId || transaction.productID || "");
    const product = IAP_PRODUCTS[productId];
    if (!product) return sendJson(res, 200, { ok: true, ignored: true, reason: "unknown product" });

    const transactionId = String(transaction.transactionId || transaction.transactionID || "");
    if (!transactionId) return sendJson(res, 200, { ok: true, ignored: true, reason: "missing transactionId" });

    const db = readDb();
    const existing = db.iapTransactions.find(entry => entry.transactionId === transactionId);
    if (existing) return sendJson(res, 200, { ok: true, idempotent: true });

    const current = db.accounts.find(entry => entry.id === account.id) || account;
    const iapTransaction = {
      id: id("iap"),
      accountId: current.id,
      appAccountToken: current.appAccountToken,
      transactionId,
      originalTransactionId: String(transaction.originalTransactionId || transaction.originalTransactionID || ""),
      productId,
      type: product.type,
      environment: String(transaction.environment || ""),
      purchaseDate: transaction.purchaseDate || transaction.signedDate || null,
      signedTransactionInfo,
      validationMode: config.iapValidationMode,
      createdAt: new Date().toISOString()
    };
    db.iapTransactions.push(iapTransaction);
    if (product.credits > 0) {
      addCreditLedgerEntry(db, current, {
        amount: product.credits,
        reason: "iap_server_notification",
        source: "apple_notification",
        productId,
        transactionId,
        idempotencyKey: `iap:${transactionId}`,
        metadata: {
          originalTransactionId: iapTransaction.originalTransactionId,
          notificationType: notification.notificationType || ""
        }
      });
    }
    writeDb(db);
    return sendJson(res, 200, { ok: true, idempotent: false });
  } catch (error) {
    return sendJson(res, error.status || 400, { error: error.message || "Invalid notification" });
  }
}

function getRequiredAccount(req, res, fallbackToken = "") {
  const appAccountToken = String(fallbackToken || getAppAccountToken(req) || "").trim();
  if (!appAccountToken) {
    sendJson(res, 401, { error: "X-App-Account-Token is required" });
    return null;
  }
  return ensureAccount(appAccountToken, "");
}

function getOptionalAccount(req) {
  const appAccountToken = getAppAccountToken(req);
  return appAccountToken ? ensureAccount(appAccountToken, "") : null;
}

function getAppAccountToken(req) {
  return String(req.headers["x-app-account-token"] || req.headers["x-user-id"] || "").trim();
}

function ensureAccount(appAccountToken, email) {
  const normalizedToken = normalizeAccountToken(appAccountToken);
  if (!normalizedToken) {
    throw Object.assign(new Error("appAccountToken is required"), { status: 400 });
  }

  const db = readDb();
  const stableAccountId = accountIdForToken(normalizedToken);
  let account = db.accounts.find(entry => entry.appAccountToken.toLowerCase() === normalizedToken.toLowerCase())
    || db.accounts.find(entry => entry.id === stableAccountId);
  if (account) {
    if (email && !account.email) account.email = email;
    account.appAccountToken = normalizedToken;
    account.updatedAt = new Date().toISOString();
    writeDb(db);
    return account;
  }

  const now = new Date().toISOString();
  account = {
    id: stableAccountId,
    appAccountToken: normalizedToken,
    email: String(email || "").trim().toLowerCase(),
    creditBalance: 0,
    createdAt: now,
    updatedAt: now
  };
  db.accounts.push(account);

  if (config.defaultStartingCredits > 0) {
    addCreditLedgerEntry(db, account, {
      amount: config.defaultStartingCredits,
      reason: "starting_credits",
      source: "system",
      idempotencyKey: `starting:${account.id}`
    });
  }

  writeDb(db);
  return account;
}

function accountIdForToken(appAccountToken) {
  const digest = crypto.createHash("sha256").update(String(appAccountToken)).digest("hex").slice(0, 20);
  return `acct_${digest}`;
}

function normalizeAccountToken(value) {
  const text = String(value || "").trim();
  if (!text || text.length > 128) return "";
  return text;
}

function addCreditLedgerEntry(db, account, values) {
  const now = new Date().toISOString();
  const entry = {
    id: id("ledger"),
    accountId: account.id,
    amount: Number(values.amount || 0),
    balanceAfter: account.creditBalance + Number(values.amount || 0),
    reason: String(values.reason || ""),
    source: String(values.source || ""),
    productId: values.productId ? String(values.productId) : null,
    transactionId: values.transactionId ? String(values.transactionId) : null,
    idempotencyKey: values.idempotencyKey ? String(values.idempotencyKey) : null,
    metadata: asRecord(values.metadata) || {},
    createdAt: now
  };
  account.creditBalance = entry.balanceAfter;
  account.updatedAt = now;
  db.creditLedger.push(entry);
  return entry;
}

function publicAccount(account) {
  return {
    id: account.id,
    appAccountToken: account.appAccountToken,
    creditBalance: account.creditBalance,
    createdAt: account.createdAt,
    updatedAt: account.updatedAt
  };
}

function publicIapTransaction(transaction) {
  return {
    id: transaction.id,
    transactionId: transaction.transactionId,
    originalTransactionId: transaction.originalTransactionId,
    productId: transaction.productId,
    type: transaction.type,
    environment: transaction.environment,
    createdAt: transaction.createdAt
  };
}

function verifyAndDecodeSignedTransaction(jws) {
  const text = String(jws || "").trim();
  const parts = text.split(".");
  if (parts.length !== 3) {
    throw Object.assign(new Error("signedTransactionInfo must be a JWS string"), { status: 400 });
  }

  const [encodedHeader, encodedPayload, encodedSignature] = parts;
  const header = parseBase64UrlJson(encodedHeader, "JWS header");
  const payload = parseBase64UrlJson(encodedPayload, "JWS payload");
  if (config.iapValidationMode === "strict") {
    verifyJwsSignature({ encodedHeader, encodedPayload, encodedSignature, header });
  }
  return payload;
}

function verifyJwsSignature({ encodedHeader, encodedPayload, encodedSignature, header }) {
  if (header.alg !== "ES256") {
    throw Object.assign(new Error("Unsupported JWS algorithm"), { status: 400 });
  }
  const x5c = Array.isArray(header.x5c) ? header.x5c : [];
  if (x5c.length < 3) {
    throw Object.assign(new Error("JWS certificate chain is missing"), { status: 400 });
  }

  const certificates = x5c.map(value => new crypto.X509Certificate(Buffer.from(String(value), "base64")));
  const rootCertificate = certificates[certificates.length - 1];
  const rootFingerprint = normalizeFingerprint(rootCertificate.fingerprint256);
  if (!APPLE_ROOT_CA_SHA256_FINGERPRINTS.has(rootFingerprint)) {
    throw Object.assign(new Error("JWS root certificate is not trusted"), { status: 400 });
  }
  if (!rootCertificate.verify(rootCertificate.publicKey)) {
    throw Object.assign(new Error("JWS root certificate could not be verified"), { status: 400 });
  }

  const now = Date.now();
  for (const certificate of certificates) {
    const validFrom = Date.parse(certificate.validFrom);
    const validTo = Date.parse(certificate.validTo);
    if (Number.isFinite(validFrom) && now < validFrom) {
      throw Object.assign(new Error("JWS certificate is not valid yet"), { status: 400 });
    }
    if (Number.isFinite(validTo) && now > validTo) {
      throw Object.assign(new Error("JWS certificate has expired"), { status: 400 });
    }
  }

  if (certificates[1] && !certificates[0].verify(certificates[1].publicKey)) {
    throw Object.assign(new Error("JWS leaf certificate could not be verified"), { status: 400 });
  }
  if (certificates[2] && !certificates[1].verify(certificates[2].publicKey)) {
    throw Object.assign(new Error("JWS intermediate certificate could not be verified"), { status: 400 });
  }

  const signingInput = Buffer.from(`${encodedHeader}.${encodedPayload}`);
  const signature = base64UrlDecode(encodedSignature);
  const ok = crypto.verify(
    "sha256",
    signingInput,
    { key: certificates[0].publicKey, dsaEncoding: "ieee-p1363" },
    signature
  );
  if (!ok) {
    throw Object.assign(new Error("JWS signature verification failed"), { status: 400 });
  }
}

function parseBase64UrlJson(value, label) {
  try {
    return JSON.parse(base64UrlDecode(value).toString("utf8"));
  } catch {
    throw Object.assign(new Error(`${label} is invalid`), { status: 400 });
  }
}

function base64UrlDecode(value) {
  return Buffer.from(String(value), "base64url");
}

function normalizeFingerprint(value) {
  return String(value || "").replace(/:/g, "").toUpperCase();
}

async function adminLogin(req, res) {
  if (!config.adminPin || !config.adminSessionSecret) {
    return sendJson(res, 503, { error: "Admin is not configured." });
  }
  const body = await readJsonBody(req);
  const email = String(body.email ?? "").trim().toLowerCase();
  const pin = String(body.pin ?? "");
  if (config.adminEmails.length && !config.adminEmails.includes(email)) {
    return sendJson(res, 401, { error: "该账号不是管理员。" });
  }
  if (!safeEqual(pin, config.adminPin)) {
    return sendJson(res, 401, { error: "管理员 PIN 不正确。" });
  }
  return sendJson(res, 200, {
    token: createAdminToken(),
    expiresIn: config.adminSessionTtlSeconds,
    role: "admin"
  });
}

function requireAdmin(req, res) {
  const authorization = String(req.headers.authorization ?? "");
  const token = authorization.startsWith("Bearer ") ? authorization.slice(7).trim() : "";
  if (!verifyAdminToken(token)) {
    sendJson(res, 401, { error: "需要管理员验证。" });
    return null;
  }
  return { ok: true };
}

function getAdminPublicConfig() {
  const runningHub = getRunningHubConfig();
  return {
    r2: {
      configured: Boolean(config.r2Bucket && config.r2AccessKeyId && config.r2SecretAccessKey && (config.r2Endpoint || config.r2AccountId)),
      mode: config.r2Mock ? "mock" : "r2",
      bucket: redactMiddle(config.r2Bucket),
      keyPrefix: config.r2KeyPrefix
    },
    runningHub: {
      configured: Boolean(runningHub.apiKey && runningHub.workflowId && runningHub.inputNodeId && runningHub.inputField),
      mode: config.runningHubMock ? "mock" : "runninghub",
      apiKeyConfigured: Boolean(runningHub.apiKey),
      workflowId: runningHub.workflowId,
      instanceType: runningHub.instanceType,
      inputNodeId: runningHub.inputNodeId,
      inputField: runningHub.inputField,
      inputMode: runningHub.inputMode,
      outputNodeId: runningHub.outputNodeId,
      outputField: runningHub.outputField,
      outputMode: runningHub.outputMode
    }
  };
}

async function updateRunningHubAdminConfig(req, res) {
  const body = await readJsonBody(req);
  const adminConfig = readAdminConfig();
  const current = adminConfig.runningHub ?? {};
  const next = { ...current };
  for (const key of [
    "workflowId",
    "instanceType",
    "inputNodeId",
    "inputField",
    "inputMode",
    "outputNodeId",
    "outputField",
    "outputMode"
  ]) {
    if (body[key] !== undefined) next[key] = String(body[key] ?? "").trim();
  }
  if (body.apiKey !== undefined && String(body.apiKey).trim()) {
    next.apiKey = String(body.apiKey).trim();
  }
  adminConfig.runningHub = next;
  adminConfig.updatedAt = new Date().toISOString();
  writeAdminConfig(adminConfig);
  return sendJson(res, 200, getAdminPublicConfig());
}

function testRunningHubAdminConfig(res) {
  const runningHub = getRunningHubConfig();
  const missing = [];
  for (const key of ["apiKey", "workflowId", "inputNodeId", "inputField"]) {
    if (!runningHub[key]) missing.push(key);
  }
  return sendJson(res, missing.length ? 400 : 200, {
    ok: missing.length === 0,
    missing,
    message: missing.length ? "RunningHub 配置不完整。" : "RunningHub 基础配置已就绪。"
  });
}

async function createUploadTargets(req, res, projectId) {
  const body = await readJsonBody(req);
  if (!Array.isArray(body.files) || body.files.length === 0) {
    return sendJson(res, 400, { error: "files is required" });
  }

  const now = new Date().toISOString();
  const db = readDb();
  const account = getOptionalAccount(req);
  const targets = [];
  for (const file of body.files) {
    const assetId = id("asset");
    const extension = extensionFor(file.fileName, file.contentType);
    const userPath = account ? `users/${account.id}` : "users/demo";
    const storageKey = [config.r2KeyPrefix, userPath, "projects", projectId, "originals", `${assetId}${extension}`]
      .filter(Boolean)
      .join("/");
    const contentType = String(file.contentType || "application/octet-stream");
    const uploadUrl = await createPutUrl(storageKey, contentType);
    const asset = {
      id: assetId,
      projectId,
      accountId: account?.id || null,
      appAccountToken: account?.appAccountToken || null,
      fileName: String(file.fileName || `${assetId}${extension}`),
      contentType,
      byteCount: Number(file.byteCount || 0),
      originalStorageKey: storageKey,
      resultStorageKey: null,
      status: "waiting_upload",
      createdAt: now,
      updatedAt: now
    };
    db.assets.push(asset);
    targets.push({
      id: id("upload"),
      assetId,
      storageKey,
      uploadUrl,
      expiresAt: new Date(Date.now() + config.r2UploadExpiresSeconds * 1000).toISOString()
    });
  }
  writeDb(db);
  return sendJson(res, 200, { targets });
}

async function completeUploads(req, res, projectId) {
  const body = await readJsonBody(req);
  const assetIds = Array.isArray(body.assetIds) ? body.assetIds.map(String) : [];
  const db = readDb();
  const now = new Date().toISOString();
  for (const asset of db.assets) {
    if (asset.projectId === projectId && assetIds.includes(asset.id)) {
      asset.status = "uploaded";
      asset.updatedAt = now;
    }
  }
  writeDb(db);
  return sendJson(res, 200, {
    assets: db.assets
      .filter(asset => asset.projectId === projectId && assetIds.includes(asset.id))
      .map(publicAsset)
  });
}

async function createPhotoRetouchJob(req, res, projectId) {
  const body = await readJsonBody(req);
  const assetIds = Array.isArray(body.assetIds) ? body.assetIds.map(String) : [];
  if (!assetIds.length) return sendJson(res, 400, { error: "assetIds is required" });

  const db = readDb();
  const now = new Date().toISOString();
  const account = getOptionalAccount(req);
  const job = {
    id: id("job"),
    projectId,
    accountId: account?.id || null,
    appAccountToken: account?.appAccountToken || null,
    status: "queued",
    style: String(body.style || "bright-natural"),
    options: body.options || {},
    total: assetIds.length,
    completed: 0,
    failed: 0,
    items: assetIds.map(assetId => ({
      assetId,
      status: "queued",
      progress: 0,
      resultUrl: null,
      errorMessage: null
    })),
    runningHubTaskId: null,
    createdAt: now,
    updatedAt: now
  };
  db.jobs.push(job);
  writeDb(db);

  if (config.runningHubMock) {
    queueMockJob(job.id);
  } else {
    queueRunningHubJob(job.id).catch(error => {
      console.error("RunningHub job failed", error);
      markJobFailed(job.id, error);
    });
  }

  return sendJson(res, 202, publicJob(job));
}

function getJobStatus(res, projectId, jobId) {
  const job = readDb().jobs.find(entry => entry.projectId === projectId && entry.id === jobId);
  if (!job) return sendJson(res, 404, { error: "Job not found" });
  return sendJson(res, 200, publicJob(job));
}

function queueMockJob(jobId) {
  setTimeout(async () => {
    const db = readDb();
    const job = db.jobs.find(entry => entry.id === jobId);
    if (!job) return;
    job.status = "processing";
    for (const item of job.items) {
      item.status = "processing";
      item.progress = 0.5;
    }
    job.updatedAt = new Date().toISOString();
    writeDb(db);
  }, 600);

  setTimeout(async () => {
    const db = readDb();
    const job = db.jobs.find(entry => entry.id === jobId);
    if (!job) return;
    for (const item of job.items) {
      const asset = db.assets.find(entry => entry.id === item.assetId);
      if (!asset) continue;
      const resultKey = asset.originalStorageKey.replace("/originals/", "/results/").replace(/\.[^.]+$/, ".jpg");
      await copyMockObject(asset.originalStorageKey, resultKey);
      asset.resultStorageKey = resultKey;
      asset.status = "completed";
      asset.updatedAt = new Date().toISOString();
      item.status = "completed";
      item.progress = 1;
      item.resultUrl = createPublicGetUrl(resultKey);
    }
    job.status = "completed";
    job.completed = job.items.length;
    job.failed = 0;
    job.updatedAt = new Date().toISOString();
    writeDb(db);
  }, 2500);
}

async function queueRunningHubJob(jobId) {
  const runningHubConfig = getRunningHubConfig();
  const db = readDb();
  const job = db.jobs.find(entry => entry.id === jobId);
  if (!job) return;
  job.status = "processing";
  job.updatedAt = new Date().toISOString();
  writeDb(db);

  ensureRunningHubConfigured(runningHubConfig);

  for (const item of job.items) {
    const currentDb = readDb();
    const currentJob = currentDb.jobs.find(entry => entry.id === jobId);
    const currentItem = currentJob?.items.find(entry => entry.assetId === item.assetId);
    const asset = currentDb.assets.find(entry => entry.id === item.assetId);
    if (!currentJob || !currentItem || !asset) continue;

    currentItem.status = "processing";
    currentItem.progress = 0.1;
    currentJob.updatedAt = new Date().toISOString();
    writeDb(currentDb);

    try {
      const originalPath = await stageObjectToTempFile(asset.originalStorageKey, asset.fileName);
      const upload = await uploadFileToRunningHub(originalPath, runningHubConfig);
      const taskId = await createRunningHubTask(upload, runningHubConfig);
      await updateJobItem(jobId, item.assetId, { progress: 0.35, runningHubTaskId: taskId });
      const outputUrls = await waitRunningHubTask(taskId, runningHubConfig, async progress => {
        await updateJobItem(jobId, item.assetId, { progress });
      });
      const outputUrl = outputUrls[0];
      if (!outputUrl) throw new Error("RunningHub result is missing output URL.");

      const resultKey = asset.originalStorageKey.replace("/originals/", "/results/").replace(/\.[^.]+$/, ".jpg");
      const resultPath = tempFilePath(`${asset.id}-result.jpg`);
      await downloadUrlToFile(outputUrl, resultPath);
      await putFileToObjectStorage(resultPath, resultKey, "image/jpeg");
      await rm(originalPath, { force: true });
      await rm(resultPath, { force: true });

      await markJobItemCompleted(jobId, item.assetId, resultKey);
    } catch (error) {
      await markJobItemFailed(jobId, item.assetId, error);
    }
  }

  finalizeRunningHubJob(jobId);
}

async function updateJobItem(jobId, assetId, patch) {
  const db = readDb();
  const job = db.jobs.find(entry => entry.id === jobId);
  const item = job?.items.find(entry => entry.assetId === assetId);
  if (!job || !item) return;
  Object.assign(item, patch);
  job.updatedAt = new Date().toISOString();
  writeDb(db);
}

async function markJobItemCompleted(jobId, assetId, resultKey) {
  const db = readDb();
  const job = db.jobs.find(entry => entry.id === jobId);
  const item = job?.items.find(entry => entry.assetId === assetId);
  const asset = db.assets.find(entry => entry.id === assetId);
  if (!job || !item || !asset) return;

  asset.resultStorageKey = resultKey;
  asset.status = "completed";
  asset.updatedAt = new Date().toISOString();
  item.status = "completed";
  item.progress = 1;
  item.resultUrl = await createReadableObjectUrl(resultKey);
  job.completed = job.items.filter(entry => entry.status === "completed").length;
  job.failed = job.items.filter(entry => entry.status === "failed").length;
  job.updatedAt = new Date().toISOString();
  writeDb(db);
}

async function markJobItemFailed(jobId, assetId, error) {
  const db = readDb();
  const job = db.jobs.find(entry => entry.id === jobId);
  const item = job?.items.find(entry => entry.assetId === assetId);
  const asset = db.assets.find(entry => entry.id === assetId);
  if (!job || !item) return;

  if (asset) {
    asset.status = "failed";
    asset.updatedAt = new Date().toISOString();
  }
  item.status = "failed";
  item.progress = 0;
  item.errorMessage = error.message || "AI processing failed";
  job.failed = job.items.filter(entry => entry.status === "failed").length;
  job.updatedAt = new Date().toISOString();
  writeDb(db);
}

function finalizeRunningHubJob(jobId) {
  const db = readDb();
  const job = db.jobs.find(entry => entry.id === jobId);
  if (!job) return;
  job.completed = job.items.filter(entry => entry.status === "completed").length;
  job.failed = job.items.filter(entry => entry.status === "failed").length;
  job.status = job.failed === job.items.length ? "failed" : "completed";
  job.updatedAt = new Date().toISOString();
  writeDb(db);
}

function markJobFailed(jobId, error) {
  const db = readDb();
  const job = db.jobs.find(entry => entry.id === jobId);
  if (!job) return;
  job.status = "failed";
  job.failed = job.items.length - job.completed;
  for (const item of job.items) {
    if (item.status !== "completed") {
      item.status = "failed";
      item.errorMessage = error.message || "AI processing failed";
    }
  }
  job.updatedAt = new Date().toISOString();
  writeDb(db);
}

function publicJob(job) {
  return {
    jobId: job.id,
    status: job.status,
    total: job.total,
    completed: job.completed,
    failed: job.failed,
    items: job.items
  };
}

function publicAsset(asset) {
  return {
    id: asset.id,
    status: asset.status,
    originalUrl: createPublicGetUrl(asset.originalStorageKey),
    resultUrl: asset.resultStorageKey ? createPublicGetUrl(asset.resultStorageKey) : null
  };
}

async function createPutUrl(storageKey, contentType) {
  if (config.r2Mock) {
    return `${config.publicApiBaseUrl}/mock-r2/${encodeURIComponent(storageKey)}`;
  }
  ensureR2Configured();
  const command = new PutObjectCommand({
    Bucket: config.r2Bucket,
    Key: storageKey,
    ContentType: contentType
  });
  return getSignedUrl(s3, command, { expiresIn: config.r2UploadExpiresSeconds });
}

async function createSignedGetUrl(storageKey) {
  if (config.r2Mock) {
    return `${config.publicApiBaseUrl}/mock-r2/${encodeURIComponent(storageKey)}`;
  }
  ensureR2Configured();
  const command = new GetObjectCommand({
    Bucket: config.r2Bucket,
    Key: storageKey
  });
  return getSignedUrl(s3, command, { expiresIn: config.r2ResultExpiresSeconds });
}

function createPublicGetUrl(storageKey) {
  if (!storageKey) return null;
  if (config.r2Mock) return `${config.publicApiBaseUrl}/mock-r2/${encodeURIComponent(storageKey)}`;
  if (config.r2PublicBaseUrl) return `${config.r2PublicBaseUrl.replace(/\/$/, "")}/${storageKey}`;
  return null;
}

async function createReadableObjectUrl(storageKey) {
  return createPublicGetUrl(storageKey) || await createSignedGetUrl(storageKey);
}

async function copyMockObject(sourceKey, resultKey) {
  const sourcePath = path.join(MOCK_R2_DIR, safeStorageKey(sourceKey));
  const resultPath = path.join(MOCK_R2_DIR, safeStorageKey(resultKey));
  await mkdir(path.dirname(resultPath), { recursive: true });
  if (existsSync(sourcePath)) {
    await copyFile(sourcePath, resultPath);
  } else {
    throw new Error(`Mock source object not found: ${sourceKey}`);
  }
}

async function stageObjectToTempFile(storageKey, originalName) {
  const targetPath = tempFilePath(`${id("original")}${extensionFor(originalName, "")}`);
  if (config.r2Mock) {
    const sourcePath = path.join(MOCK_R2_DIR, safeStorageKey(storageKey));
    if (!existsSync(sourcePath)) throw new Error(`Source object not found: ${storageKey}`);
    await mkdir(path.dirname(targetPath), { recursive: true });
    await copyFile(sourcePath, targetPath);
    return targetPath;
  }
  await downloadUrlToFile(await createSignedGetUrl(storageKey), targetPath);
  return targetPath;
}

async function putFileToObjectStorage(filePath, storageKey, contentType) {
  if (config.r2Mock) {
    const targetPath = path.join(MOCK_R2_DIR, safeStorageKey(storageKey));
    await mkdir(path.dirname(targetPath), { recursive: true });
    await copyFile(filePath, targetPath);
    return;
  }
  ensureR2Configured();
  await s3.send(new PutObjectCommand({
    Bucket: config.r2Bucket,
    Key: storageKey,
    Body: createReadStream(filePath),
    ContentType: contentType
  }));
}

async function deleteObjectFromStorage(storageKey) {
  if (!storageKey) return;
  if (config.r2Mock) {
    const targetPath = path.join(MOCK_R2_DIR, safeStorageKey(storageKey));
    await rm(targetPath, { force: true });
    return;
  }
  ensureR2Configured();
  await s3.send(new DeleteObjectCommand({
    Bucket: config.r2Bucket,
    Key: storageKey
  }));
}

async function downloadUrlToFile(url, targetPath) {
  const response = await fetch(url);
  if (!response.ok || !response.body) {
    throw new Error(`Download failed: ${response.status}`);
  }
  await mkdir(path.dirname(targetPath), { recursive: true });
  await writeFile(targetPath, Buffer.from(await response.arrayBuffer()));
}

async function uploadFileToRunningHub(filePath, runningHubConfig) {
  const endpoints = [
    { mode: "new", url: "https://www.runninghub.cn/openapi/v2/media/upload/binary" },
    { mode: "legacy", url: "https://www.runninghub.cn/task/openapi/upload" }
  ];
  let lastError;
  for (const endpoint of endpoints) {
    try {
      const form = new FormData();
      if (endpoint.mode === "legacy") {
        form.append("apiKey", runningHubConfig.apiKey);
        form.append("fileType", "input");
      }
      const blob = await openAsBlob(filePath);
      form.append("file", blob, path.basename(filePath));
      const response = await fetch(endpoint.url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${runningHubConfig.apiKey}`,
          Accept: "application/json"
        },
        body: form
      });
      const parsed = await parseRunningHubResponse(response);
      const data = asRecord(parsed.data) || parsed;
      return {
        fileName: firstNonEmpty(data.fileName, data.file_name, data.name),
        fileId: firstNonEmpty(data.fileId, data.file_id, data.id, data.fid),
        fileUrl: firstNonEmpty(data.fileUrl, data.file_url, data.url, data.downloadUrl, data.download_url)
      };
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error(`RunningHub upload failed: ${lastError?.message || lastError}`);
}

async function createRunningHubTask(upload, runningHubConfig) {
  const nodeInfoList = [
    {
      nodeId: runningHubConfig.inputNodeId,
      fieldName: runningHubConfig.inputField,
      field: runningHubConfig.inputField,
      fieldValue: runningHubInputValue(upload, runningHubConfig)
    }
  ];
  const response = await fetch("https://www.runninghub.cn/task/openapi/create", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${runningHubConfig.apiKey}`,
      Accept: "application/json"
    },
    body: JSON.stringify({
      apiKey: runningHubConfig.apiKey,
      workflowId: runningHubConfig.workflowId,
      nodeInfoList,
      ...(runningHubConfig.instanceType ? { instanceType: runningHubConfig.instanceType } : {})
    })
  });
  const parsed = await parseRunningHubResponse(response);
  const data = asRecord(parsed.data);
  const taskId = firstNonEmpty(data?.taskId, parsed.taskId, typeof parsed.data === "string" ? parsed.data : "");
  if (!taskId) throw new Error("RunningHub create response missing taskId.");
  return taskId;
}

async function waitRunningHubTask(taskId, runningHubConfig, onProgress) {
  const deadline = Date.now() + runningHubConfig.outputPollSeconds * 1000;
  while (Date.now() < deadline) {
    const status = await getRunningHubStatus(taskId, runningHubConfig);
    const normalized = status.status.toLowerCase();
    if (status.progress > 0) {
      await onProgress(Math.max(0.35, Math.min(0.9, status.progress / 100)));
    }
    if (["success", "done", "completed", "finish", "finished"].some(value => normalized.includes(value))) break;
    if (["error", "failed", "cancel", "aborted"].some(value => normalized.includes(value))) {
      throw new Error(`RunningHub task failed: ${status.status}`);
    }
    await sleep(3000);
  }

  for (let attempt = 0; attempt < 30; attempt += 1) {
    const outputs = await getRunningHubOutputs(taskId, runningHubConfig);
    if (outputs.length) return outputs;
    await sleep(Math.min(15000, 3000 + attempt * 1000));
  }
  throw new Error("RunningHub outputs are not ready.");
}

async function getRunningHubStatus(taskId, runningHubConfig) {
  const response = await fetch("https://www.runninghub.cn/task/openapi/status", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${runningHubConfig.apiKey}`,
      Accept: "application/json"
    },
    body: JSON.stringify({ apiKey: runningHubConfig.apiKey, taskId })
  });
  const parsed = await parseRunningHubResponse(response);
  const data = asRecord(parsed.data);
  return {
    status: firstNonEmpty(data?.status, data?.state, data?.taskStatus, parsed.status, typeof parsed.data === "string" ? parsed.data : "running"),
    progress: Number(data?.progress || data?.percent || data?.percentage || 0)
  };
}

async function getRunningHubOutputs(taskId, runningHubConfig) {
  const endpoints = ["outputs", "output", "result", "results"];
  let lastError;
  for (const endpoint of endpoints) {
    try {
      const response = await fetch(`https://www.runninghub.cn/task/openapi/${endpoint}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${runningHubConfig.apiKey}`,
          Accept: "application/json"
        },
        body: JSON.stringify({ apiKey: runningHubConfig.apiKey, taskId })
      });
      const parsed = await parseRunningHubResponse(response);
      return extractFileUrls(parsed);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

async function parseRunningHubResponse(response) {
  const text = await response.text();
  if (!response.ok) throw new Error(`RunningHub request failed: ${response.status} ${text}`);
  const parsed = text ? JSON.parse(text) : {};
  const code = parsed.code === undefined || parsed.code === null ? "0" : String(parsed.code);
  if (code && code !== "0") throw new Error(String(parsed.msg || "RunningHub returned failure."));
  return parsed;
}

function runningHubInputValue(upload, runningHubConfig) {
  const mode = runningHubConfig.inputMode.toLowerCase();
  if (mode.includes("url") || mode.includes("link")) return upload.fileUrl || upload.fileId || upload.fileName;
  if (mode.includes("id")) return upload.fileId || upload.fileName || upload.fileUrl;
  return upload.fileName || upload.fileId || upload.fileUrl;
}

function extractFileUrls(value, bucket = []) {
  if (Array.isArray(value)) {
    for (const item of value) extractFileUrls(item, bucket);
    return Array.from(new Set(bucket));
  }
  const record = asRecord(value);
  if (!record) return Array.from(new Set(bucket));
  const url = firstNonEmpty(record.fileUrl, record.file_url, record.url, record.downloadUrl, record.download_url);
  if (url) bucket.push(url);
  for (const child of Object.values(record)) extractFileUrls(child, bucket);
  return Array.from(new Set(bucket));
}

function asRecord(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}

function firstNonEmpty(...values) {
  return values.map(value => value === undefined || value === null ? "" : String(value).trim()).find(Boolean) || "";
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function getRunningHubConfig() {
  const adminConfig = readAdminConfig().runningHub ?? {};
  return {
    apiKey: firstNonEmpty(adminConfig.apiKey, config.runningHubApiKey),
    workflowId: firstNonEmpty(adminConfig.workflowId, config.runningHubWorkflowId),
    instanceType: firstNonEmpty(adminConfig.instanceType, config.runningHubInstanceType),
    inputNodeId: firstNonEmpty(adminConfig.inputNodeId, config.runningHubInputNodeId),
    inputField: firstNonEmpty(adminConfig.inputField, config.runningHubInputField),
    inputMode: firstNonEmpty(adminConfig.inputMode, config.runningHubInputMode, "image"),
    outputNodeId: firstNonEmpty(adminConfig.outputNodeId, config.runningHubOutputNodeId),
    outputField: firstNonEmpty(adminConfig.outputField, config.runningHubOutputField),
    outputMode: firstNonEmpty(adminConfig.outputMode, config.runningHubOutputMode, "file"),
    outputPollSeconds: config.runningHubOutputPollSeconds
  };
}

function productionReadinessReport() {
  const runningHub = getRunningHubConfig();
  const objectStorageReady = config.r2Mock || Boolean(
    config.r2Bucket
      && config.r2AccessKeyId
      && config.r2SecretAccessKey
      && (config.r2Endpoint || config.r2AccountId)
  );
  const aiProcessingReady = config.runningHubMock || Boolean(
    runningHub.apiKey
      && runningHub.workflowId
      && runningHub.inputNodeId
      && runningHub.inputField
  );
  const checks = [
    {
      key: "publicApiBaseUrl",
      label: "Public API base URL",
      ok: Boolean(config.publicApiBaseUrl && !config.publicApiBaseUrl.includes("127.0.0.1"))
    },
    {
      key: "objectStorage",
      label: "Cloud object storage",
      ok: !config.r2Mock && objectStorageReady
    },
    {
      key: "aiProcessing",
      label: "Cloud AI processing",
      ok: !config.runningHubMock && aiProcessingReady
    },
    {
      key: "appleBundleId",
      label: "Apple bundle id",
      ok: config.bundleId === "com.jin.realestatemarketing"
    },
    {
      key: "iapStrictValidation",
      label: "Apple IAP strict validation",
      ok: config.iapValidationMode === "strict"
    },
    {
      key: "startingCredits",
      label: "Production starting credits",
      ok: config.defaultStartingCredits === 0
    },
    {
      key: "adminAccess",
      label: "Hidden admin access",
      ok: Boolean(config.adminPin && config.adminEmails.includes("zhoujin0618@gmail.com"))
    },
    {
      key: "adminSessionSecret",
      label: "Admin session secret",
      ok: Boolean(config.adminSessionSecret && config.adminSessionSecret.length >= 32 && config.adminSessionSecret !== config.adminPin)
    }
  ];

  return {
    ok: checks.every(check => check.ok),
    generatedAt: new Date().toISOString(),
    modes: {
      storage: config.r2Mock ? "mock" : "cloud",
      aiProcessing: config.runningHubMock ? "mock" : "cloud",
      iapValidation: config.iapValidationMode
    },
    checks
  };
}

function createAdminToken() {
  const expiresAt = Math.floor(Date.now() / 1000) + config.adminSessionTtlSeconds;
  const payload = base64UrlEncode(JSON.stringify({ scope: "admin", expiresAt }));
  const signature = signAdminPayload(payload);
  return `${payload}.${signature}`;
}

function verifyAdminToken(token) {
  if (!token || !config.adminSessionSecret) return false;
  const [payload, signature] = token.split(".");
  if (!payload || !signature || !safeEqual(signature, signAdminPayload(payload))) return false;
  try {
    const parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    return parsed.scope === "admin" && Number(parsed.expiresAt) > Math.floor(Date.now() / 1000);
  } catch {
    return false;
  }
}

function signAdminPayload(payload) {
  return crypto.createHmac("sha256", config.adminSessionSecret).update(payload).digest("base64url");
}

function base64UrlEncode(value) {
  return Buffer.from(value).toString("base64url");
}

function safeEqual(left, right) {
  const leftBuffer = Buffer.from(String(left));
  const rightBuffer = Buffer.from(String(right));
  if (leftBuffer.length !== rightBuffer.length) return false;
  return crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function redactMiddle(value) {
  const text = String(value ?? "");
  if (text.length <= 8) return text ? "••••" : "";
  return `${text.slice(0, 4)}••••${text.slice(-4)}`;
}

function createS3Client() {
  if (boolEnv("R2_MOCK", true)) return null;
  const endpoint = config.r2Endpoint || (config.r2AccountId ? `https://${config.r2AccountId}.r2.cloudflarestorage.com` : "");
  return new S3Client({
    region: config.r2Region || "auto",
    endpoint,
    credentials: {
      accessKeyId: config.r2AccessKeyId,
      secretAccessKey: config.r2SecretAccessKey
    }
  });
}

function ensureR2Configured() {
  const missing = [];
  for (const key of ["r2Bucket", "r2AccessKeyId", "r2SecretAccessKey"]) {
    if (!config[key]) missing.push(key);
  }
  if (!config.r2Endpoint && !config.r2AccountId) missing.push("r2Endpoint/r2AccountId");
  if (missing.length) throw Object.assign(new Error(`R2 is not configured: ${missing.join(", ")}`), { status: 500 });
}

function ensureRunningHubConfigured(runningHubConfig = getRunningHubConfig()) {
  const missing = [];
  for (const key of ["apiKey", "workflowId", "inputNodeId", "inputField"]) {
    if (!runningHubConfig[key]) missing.push(key);
  }
  if (missing.length) throw Object.assign(new Error(`RunningHub is not configured: ${missing.join(", ")}`), { status: 500 });
}

function extensionFor(fileName, contentType) {
  const ext = path.extname(String(fileName || "")).toLowerCase();
  if (ext) return ext;
  if (contentType === "image/png") return ".png";
  if (contentType === "image/heic") return ".heic";
  if (contentType === "image/webp") return ".webp";
  return ".jpg";
}

function safeStorageKey(value) {
  return String(value).replace(/\\/g, "/").split("/").filter(Boolean).join(path.sep);
}

function tempFilePath(fileName) {
  return path.join(DATA_DIR, "tmp", safeStorageKey(fileName));
}

function id(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

function env(name, fallback = "") {
  return process.env[name] || fallback;
}

function numberEnv(name, fallback) {
  const parsed = Number(process.env[name]);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function boolEnv(name, fallback) {
  const value = process.env[name];
  if (value === undefined) return fallback;
  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

function loadDotEnv(filePath) {
  if (!existsSync(filePath)) return;
  const text = readFileSync(filePath, "utf8");
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const index = trimmed.indexOf("=");
    if (index <= 0) continue;
    const key = trimmed.slice(0, index).trim();
    const value = trimmed.slice(index + 1).trim().replace(/^["']|["']$/g, "");
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    await handleApi(req, res, url.pathname);
  } catch (error) {
    console.error(error);
    sendJson(res, error.status || 500, { error: error.message || "Server error" });
  }
});

server.listen(config.port, "0.0.0.0", () => {
  console.log(`R2 + RunningHub backend listening on http://127.0.0.1:${config.port}`);
});
