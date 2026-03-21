import https from "node:https";
import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { version } = require("../package.json");

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = "circlesac/vlt-cli";

const PLATFORMS = {
  "darwin-x64":   { artifact: "vlt-darwin-amd64",   ext: ".tar.gz" },
  "darwin-arm64": { artifact: "vlt-darwin-arm64",   ext: ".tar.gz" },
  "linux-x64":    { artifact: "vlt-linux-amd64",    ext: ".tar.gz" },
  "linux-arm64":  { artifact: "vlt-linux-arm64",    ext: ".tar.gz" },
  "win32-x64":    { artifact: "vlt-windows-amd64",  ext: ".zip"    },
};

function download(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      if (res.statusCode === 302 || res.statusCode === 301) {
        return download(res.headers.location).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`));
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve(Buffer.concat(chunks)));
      res.on("error", reject);
    });
  });
}

if (process.env.CI) process.exit(0);

const platform = `${process.platform}-${process.arch}`;
const info = PLATFORMS[platform];
if (!info) {
  console.error(`Unsupported platform: ${platform}`);
  process.exit(1);
}

const { artifact, ext } = info;
const url = `https://github.com/${REPO}/releases/download/v${version}/${artifact}${ext}`;
const nativeDir = path.join(__dirname, "native");
fs.mkdirSync(nativeDir, { recursive: true });

const data = await download(url);
const tmp = path.join(nativeDir, `tmp${ext}`);
fs.writeFileSync(tmp, data);

if (ext === ".zip") {
  execSync(`powershell -Command "Expand-Archive -Force '${tmp}' '${nativeDir}'"`, { cwd: nativeDir });
} else {
  execSync(`tar xzf "${tmp}"`, { cwd: nativeDir });
}
fs.unlinkSync(tmp);

if (process.platform !== "win32") {
  fs.chmodSync(path.join(nativeDir, "vlt"), 0o755);
}
