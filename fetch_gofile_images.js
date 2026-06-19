#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const vm = require("node:vm");
const { spawn } = require("node:child_process");
const { Readable } = require("node:stream");

const CONTENT_ID = process.argv[2] || "L0kyoa";
const OUT_DIR = path.resolve(process.argv[3] || "gofile_images");
const DEBUG = process.argv.includes("--debug");
const INCLUDE_VIDEOS = process.argv.includes("--videos");
const API_BASE = "https://api.gofile.io";
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36";
const LANGUAGE = "zh-CN";
let officialGenerateWT = null;

function loadOfficialGenerateWT() {
  const wtPath = path.resolve("wt.obf.js");
  if (!fs.existsSync(wtPath)) {
    return null;
  }

  const sandbox = {
    navigator: {
      userAgent: USER_AGENT,
      language: LANGUAGE,
    },
    Date,
    Math,
    String,
    parseInt,
    decodeURIComponent,
  };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(wtPath, "utf8"), sandbox);
  return sandbox.generateWT;
}

function generateWT(accountToken) {
  if (!officialGenerateWT) {
    officialGenerateWT = loadOfficialGenerateWT();
  }

  if (typeof officialGenerateWT === "function") {
    return officialGenerateWT(accountToken);
  }

  const timeBucket = Math.floor(Date.now() / 1000 / 14400).toString();
  const payload = [
    USER_AGENT,
    LANGUAGE,
    accountToken,
    timeBucket,
    "9844d94d963d30",
  ].join("::");

  return crypto.createHash("sha256").update(payload).digest("hex");
}

function headersObject(headers) {
  if (!headers) return {};
  if (headers instanceof Headers) return Object.fromEntries(headers.entries());
  return headers;
}

function isFetchTransportError(error) {
  return (
    error &&
    (error.name === "TypeError" ||
      /fetch failed|network|ECONN|ETIMEDOUT|ENOTFOUND|EAI_AGAIN/i.test(error.message || ""))
  );
}

function runCurl(args) {
  return new Promise((resolve, reject) => {
    const child = spawn("curl", args, {
      stdio: ["ignore", "pipe", "pipe"],
    });

    const stderr = [];
    const stdout = [];

    if (child.stdout) child.stdout.on("data", (chunk) => stdout.push(chunk));
    if (child.stderr) child.stderr.on("data", (chunk) => stderr.push(chunk));

    child.on("error", reject);
    child.on("close", (code) => {
      const errText = Buffer.concat(stderr).toString("utf8");
      if (code !== 0) {
        reject(new Error(`curl exited ${code}: ${errText || Buffer.concat(stdout).toString("utf8")}`));
        return;
      }

      resolve(Buffer.concat(stdout).toString("utf8"));
    });
  });
}

async function curlText(url, options = {}) {
  const method = options.method || "GET";
  const args = ["-sS", "-L", "--fail-with-body", "-X", method];

  for (const [name, value] of Object.entries(headersObject(options.headers))) {
    args.push("-H", `${name}: ${value}`);
  }

  if (options.body != null) {
    args.push("--data-binary", String(options.body));
  }

  args.push(url);
  return runCurl(args);
}

async function fetchText(url, options = {}) {
  try {
    const response = await fetch(url, options);
    const text = await response.text();

    if (!response.ok) {
      throw new Error(`${response.status} ${response.statusText}: ${text.slice(0, 400)}`);
    }

    return text;
  } catch (error) {
    if (!isFetchTransportError(error)) throw error;
    console.warn(`Node fetch failed for ${url}; retrying with curl.`);
    return curlText(url, options);
  }
}

function safeName(name) {
  return String(name || "unnamed")
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 180);
}

async function requestJson(url, options = {}) {
  const text = await fetchText(url, options);
  const data = JSON.parse(text);
  if (data.status !== "ok") {
    throw new Error(`API status ${data.status}: ${text.slice(0, 400)}`);
  }

  return data;
}

async function createGuestToken() {
  const data = await requestJson(`${API_BASE}/accounts`, { method: "POST" });
  return data.data.token;
}

async function getContent(contentId, token, page = 1) {
  const url = new URL(`${API_BASE}/contents/${contentId}`);
  url.search = new URLSearchParams({
    contentFilter: "",
    page: String(page),
    pageSize: "1000",
    sortField: "createTime",
    sortDirection: "-1",
  }).toString();

  return requestJson(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      "X-Website-Token": generateWT(token),
      "X-BL": LANGUAGE,
      "User-Agent": USER_AGENT,
    },
  });
}

function childrenOf(contentData) {
  const children = contentData.children || {};
  return Array.isArray(children) ? children : Object.values(children);
}

function imageUrl(item) {
  return item.link || item.downloadPage || item.directLink || item.preview;
}

async function downloadFile(url, destination, token) {
  const headers = {
    Cookie: `accountToken=${token}`,
    Authorization: `Bearer ${token}`,
    "User-Agent": USER_AGENT,
    Referer: "https://gofile.io/",
  };

  await fs.promises.mkdir(path.dirname(destination), { recursive: true });

  try {
    const response = await fetch(url, { headers });

    if (!response.ok) {
      throw new Error(`${response.status} ${response.statusText}`);
    }

    const file = fs.createWriteStream(destination);
    await new Promise((resolve, reject) => {
      Readable.fromWeb(response.body).pipe(file);
      file.on("finish", resolve);
      file.on("error", reject);
    });
  } catch (error) {
    if (!isFetchTransportError(error)) throw error;

    console.warn(`Node fetch failed while downloading ${url}; retrying with curl.`);
    const args = ["-sS", "-L", "--fail-with-body"];
    for (const [name, value] of Object.entries(headers)) {
      args.push("-H", `${name}: ${value}`);
    }
    args.push("-o", destination, url);
    await runCurl(args);
  }
}

async function walk(contentId, token, relativeDir, results) {
  const content = await getContent(contentId, token);
  const data = content.data;
  const baseDir = path.join(relativeDir, safeName(data.name || contentId));
  const children = childrenOf(data);

  if (DEBUG) {
    const debugPath = path.join(OUT_DIR, `${safeName(contentId)}.json`);
    await fs.promises.mkdir(path.dirname(debugPath), { recursive: true });
    await fs.promises.writeFile(debugPath, JSON.stringify(content, null, 2));
  }

  console.log(`Folder: ${data.name || contentId} (${children.length} item(s))`);

  for (const item of children) {
    if (DEBUG) {
      console.log(`  ${item.type || "unknown"} ${item.mimetype || ""} ${item.name || item.id}`);
    }
    if (item.type === "folder") {
      await walk(item.id || item.code, token, baseDir, results);
      continue;
    }

    const mimetype = item.mimetype || "";
    const isWanted =
      mimetype.startsWith("image/") || (INCLUDE_VIDEOS && mimetype.startsWith("video/"));

    if (!isWanted) {
      continue;
    }

    const url = imageUrl(item);
    if (!url) {
      console.warn(`No download URL for image: ${item.name}`);
      continue;
    }

    const filename = safeName(item.name || item.id);
    const destination = path.join(OUT_DIR, baseDir, filename);
    console.log(`Downloading: ${item.name}`);

    await downloadFile(url, destination, token);
    results.push({
      name: item.name,
      size: item.size,
      mimetype,
      path: destination,
      url,
    });
  }
}

async function main() {
  await fs.promises.mkdir(OUT_DIR, { recursive: true });
  const token = await createGuestToken();
  const results = [];

  await walk(CONTENT_ID, token, "", results);

  const manifest = path.join(OUT_DIR, "manifest.json");
  await fs.promises.writeFile(manifest, JSON.stringify(results, null, 2));

  console.log("");
  console.log(`Downloaded ${results.length} image(s).`);
  console.log(`Output: ${OUT_DIR}`);
  console.log(`Manifest: ${manifest}`);
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
