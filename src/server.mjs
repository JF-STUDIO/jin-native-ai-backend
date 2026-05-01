import { createReadStream, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import crypto from "node:crypto";
import http from "node:http";
import { openAsBlob } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
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
  adminPin: env("ADMIN_PIN", env("METROVAN_ADMIN_PIN")),
  adminEmails: env("ADMIN_EMAILS", env("METROVAN_ADMIN_EMAILS")).split(",").map(value => value.trim().toLowerCase()).filter(Boolean),
  adminSessionSecret: env("ADMIN_SESSION_SECRET", env("METROVAN_ADMIN_SESSION_SECRET", env("ADMIN_PIN", env("METROVAN_ADMIN_PIN")))),
  adminSessionTtlSeconds: numberEnv("ADMIN_SESSION_TTL_SECONDS", 60 * 60 * 6)
};

const s3 = createS3Client();

function defaultDb() {
  return {
    projects: [],
    assets: [],
    jobs: []
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
  if (pathname === "/api/health") return sendJson(res, 200, {
    ok: true,
    r2Mode: config.r2Mock ? "mock" : "r2",
    runningHubMode: config.runningHubMock ? "mock" : "runninghub"
  });

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
  const targets = [];
  for (const file of body.files) {
    const assetId = id("asset");
    const extension = extensionFor(file.fileName, file.contentType);
    const storageKey = [config.r2KeyPrefix, "users/demo/projects", projectId, "originals", `${assetId}${extension}`]
      .filter(Boolean)
      .join("/");
    const contentType = String(file.contentType || "application/octet-stream");
    const uploadUrl = await createPutUrl(storageKey, contentType);
    const asset = {
      id: assetId,
      projectId,
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
  const job = {
    id: id("job"),
    projectId,
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
  item.resultUrl = createPublicGetUrl(resultKey);
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
