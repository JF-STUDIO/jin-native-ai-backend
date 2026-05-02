import { createWriteStream, existsSync, mkdirSync, rmSync } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import zlib from "node:zlib";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..");
const DIST_DIR = path.join(ROOT, "dist");
const STAGING_DIR = path.join(DIST_DIR, "jin-native-ai-backend-deploy");

const includePaths = [
  "src",
  "scripts",
  "package.json",
  "package-lock.json",
  "README.md",
  ".env.example",
  "render.production.env.example",
  "render.yaml"
];

const excludedNames = new Set([
  ".git",
  "node_modules",
  "data",
  "dist",
  ".env",
  ".env.local",
  "admin-credentials.txt",
  ".DS_Store"
]);

mkdirSync(DIST_DIR, { recursive: true });
rmSync(STAGING_DIR, { recursive: true, force: true });
mkdirSync(STAGING_DIR, { recursive: true });

for (const relativePath of includePaths) {
  const source = path.join(ROOT, relativePath);
  if (!existsSync(source)) continue;
  const destination = path.join(STAGING_DIR, relativePath);
  await copyEntry(source, destination);
}

const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
const archivePath = path.join(DIST_DIR, `jin-native-ai-backend-deploy-${timestamp}.tar.gz`);
createTarGz(STAGING_DIR, archivePath);

const patchPath = path.join(DIST_DIR, `jin-native-ai-backend-changes-${timestamp}.patch`);
const diff = spawnSync("git", ["diff", "--binary", "--", "."], {
  cwd: ROOT,
  encoding: "utf8"
});
if (diff.status === 0) {
  const untrackedDiff = gitUntrackedDiff();
  await writeTextFile(patchPath, `${diff.stdout}${untrackedDiff}`);
}

console.log("Deploy package created");
console.log("======================");
console.log(`Archive: ${archivePath}`);
console.log(`Patch:   ${patchPath}`);
console.log("");
console.log("Excluded: .env, data, admin credentials, node_modules, .git");

async function copyEntry(source, destination) {
  const info = await stat(source);
  const name = path.basename(source);
  if (excludedNames.has(name)) return;

  if (info.isDirectory()) {
    mkdirSync(destination, { recursive: true });
    for (const child of await readdir(source)) {
      if (excludedNames.has(child)) continue;
      await copyEntry(path.join(source, child), path.join(destination, child));
    }
    return;
  }

  mkdirSync(path.dirname(destination), { recursive: true });
  const bytes = await import("node:fs/promises").then(fs => fs.readFile(source));
  await import("node:fs/promises").then(fs => fs.writeFile(destination, bytes));
}

async function writeTextFile(filePath, text) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  await import("node:fs/promises").then(fs => fs.writeFile(filePath, text));
}

function createTarGz(sourceDir, outputPath) {
  const tar = spawnSync("tar", ["-czf", outputPath, "-C", path.dirname(sourceDir), path.basename(sourceDir)], {
    encoding: "utf8"
  });
  if (tar.status !== 0) {
    const fallbackPath = outputPath.replace(/\.tar\.gz$/, ".json.gz");
    const gzip = zlib.createGzip();
    const output = createWriteStream(fallbackPath);
    gzip.pipe(output);
    gzip.end(JSON.stringify({ error: "tar unavailable", sourceDir }, null, 2));
    console.log(`tar failed, wrote fallback: ${fallbackPath}`);
  }
}

function gitUntrackedDiff() {
  const result = spawnSync("git", ["ls-files", "--others", "--exclude-standard"], {
    cwd: ROOT,
    encoding: "utf8"
  });
  if (result.status !== 0) return "";

  let output = "";
  const files = result.stdout
    .split(/\r?\n/)
    .map(value => value.trim())
    .filter(Boolean)
    .filter(isDeployFile);

  for (const file of files) {
    const diff = spawnSync("git", ["diff", "--no-index", "--", "/dev/null", file], {
      cwd: ROOT,
      encoding: "utf8"
    });
    if (diff.stdout) output += `${diff.stdout}\n`;
  }
  return output;
}

function isDeployFile(relativePath) {
  const segments = relativePath.split(/[\\/]/);
  if (segments.some(segment => excludedNames.has(segment))) return false;
  return includePaths.some(includePath => (
    relativePath === includePath || relativePath.startsWith(`${includePath}/`)
  ));
}
