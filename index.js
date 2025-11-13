import express from "express";
import bodyParser from "body-parser";
import axios from "axios";
import fs from "fs/promises";
import path from "path";
import os from "os";
import yaml from "js-yaml";

const app = express();
app.use(bodyParser.json({ limit: "1mb" }));

const EXTRA_ALLOWLIST = [
  ".cue",
  ".log",
  ".png",
  ".jpg",
  ".jpeg",
  ".txt",
  ".m3u",
  ".m3u8",
  ".yml",
  ".yaml",
];

function getConfigPath() {
  const home = os.homedir();
  if (process.platform === "win32") {
    return path.join(
      process.env.APPDATA || path.join(home, "AppData", "Roaming"),
      "lidarr-import-extras",
      "config.yml"
    );
  }
  return path.join(home, ".config", "lidarr-import-extras", "config.yml");
}

async function loadConfig() {
  const configPath = getConfigPath();
  try {
    const raw = await fs.readFile(configPath, "utf8");
    const cfg = yaml.load(raw);
    console.log(`Loaded config from ${configPath}`);
    return cfg;
  } catch (err) {
    console.warn(`⚠️ Config file not found at ${configPath}, using defaults.`);
    return {
      port: 15032,
      qbittorrent: {
        url: "http://localhost:8080",
        username: "admin",
        password: "secret",
      },
      pathMappings: [],
    };
  }
}

function applyPathMappings(inputPath, mappings) {
  if (!mappings || !Array.isArray(mappings)) return inputPath;
  for (const map of mappings) {
    if (inputPath.startsWith(map.from)) {
      const remapped = inputPath.replace(map.from, map.to);
      console.log(`Path remapped: ${inputPath} → ${remapped}`);
      return remapped;
    }
  }
  return inputPath;
}

function findCommonParentDir(paths) {
  if (!paths || paths.length === 0) {
    throw new Error("No paths provided to findCommonParentDir");
  }

  // Convert all paths to their directories
  const dirs = paths.map((p) => path.dirname(path.resolve(p)));

  // Split each directory into components
  const splitDirs = dirs.map((p) => p.split(path.sep));

  // Find minimum length
  const minLen = Math.min(...splitDirs.map((sp) => sp.length));

  const commonParts = [];
  for (let i = 0; i < minLen; i++) {
    const part = splitDirs[0][i];
    if (splitDirs.every((sp) => sp[i] === part)) {
      commonParts.push(part);
    } else {
      break;
    }
  }

  if (commonParts.length === 0) {
    return null;
  }

  return commonParts.join(path.sep);
}

async function qbtLogin(cfg) {
  const res = await axios.post(
    `${cfg.qbittorrent.url}/api/v2/auth/login`,
    `username=${cfg.qbittorrent.username}&password=${cfg.qbittorrent.password}`,
    {
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      withCredentials: true,
    }
  );
  if (res.data !== "Ok.") {
    throw new Error("qBittorrent login failed");
  }
  return res.headers["set-cookie"];
}

async function getTorrentFolder(cfg, downloadId, cookie) {
  // Get general info for the save path
  const info = await axios.get(
    `${cfg.qbittorrent.url}/api/v2/torrents/info?hashes=${downloadId}`,
    {
      headers: { Cookie: cookie.join("; ") },
    }
  );

  if (!info.data?.length) {
    throw new Error(`Torrent ${downloadId} not found in qBittorrent`);
  }

  const savePath = applyPathMappings(info.data[0].save_path, cfg.pathMappings);

  // Get file list for the torrent
  const files = await axios.get(
    `${cfg.qbittorrent.url}/api/v2/torrents/files?hash=${downloadId}`,
    {
      headers: { Cookie: cookie.join("; ") },
    }
  );

  if (!files.data?.length) {
    throw new Error(`No files listed for torrent ${downloadId}`);
  }

  const fileNames = files.data.map((f) => path.join(savePath, f.name));
  const commonPrefix = findCommonParentDir(fileNames);

  if (!commonPrefix) {
    throw new Error("Could not identify common root for torrent folder files");
  }

  return commonPrefix;
}

function isExtraFile(filename) {
  return EXTRA_ALLOWLIST.includes(path.extname(filename).toLowerCase());
}

async function removeExistingExtras(albumPath) {
  const files = await fs.readdir(albumPath);
  for (const file of files) {
    const full = path.join(albumPath, file);
    try {
      const st = await fs.lstat(full);
      if (st.isFile() && isExtraFile(file)) {
        await fs.unlink(full);
        console.log(`Removed existing: ${full}`);
      }
    } catch {}
  }
}

async function linkExtrasRecursive(originalDir, albumPath, base = "") {
  const entries = await fs.readdir(originalDir, { withFileTypes: true });

  for (const entry of entries) {
    const entryPath = path.join(originalDir, entry.name);

    if (entry.isDirectory()) {
      await linkExtrasRecursive(
        entryPath,
        albumPath,
        base ? `${base}-${entry.name}` : entry.name
      );
    } else if (entry.isFile() && isExtraFile(entry.name)) {
      const destFile = base ? `${base}-${entry.name}` : entry.name;
      const dest = path.join(albumPath, destFile);
      try {
        await fs.unlink(dest);
      } catch {}
      await fs.link(entryPath, dest);
      console.log(`Linked: ${entryPath} -> ${dest}`);
    }
  }
}

const cfg = await loadConfig();
app.locals.cfg = cfg;

app.post("/webhook", async (req, res) => {
  const body = req.body;

  if (body.eventType == "Test") {
    return res.status(200).send("OK");
  }

  if (!body.trackFiles || !body.downloadId) {
    console.error("Invalid payload structure:", body);
    return res.status(400).send("Invalid payload");
  }

  console.log("Received import webhook:", body);

  try {
    const cfg = app.locals.cfg;
    const albumPath = findCommonParentDir(body.trackFiles.map((f) => f.path));
    if (!albumPath) {
      throw new Error("Could not identify common root for lidarr track files");
    }
    console.log(`Processing album: ${albumPath}`);

    await removeExistingExtras(albumPath);
    const cookie = await qbtLogin(cfg);
    const originalDir = await getTorrentFolder(cfg, body.downloadId, cookie);
    await linkExtrasRecursive(originalDir, albumPath);
    res.status(200).send("OK");
  } catch (err) {
    console.error("Error processing webhook:", err.message);
    res.status(200).send("OK");
  }
});

const port = cfg.port || 15032;

app.listen(port, () => {
  console.log(`lidarr-import-extras listening on port ${port}`);
});
