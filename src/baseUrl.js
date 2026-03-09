"use strict";

import { promises as fs } from "fs";
import path from "path";
import os from "os";

const CONFIG_DIR = path.join(os.homedir(), ".dev-monitor");
const CONFIG_FILE = path.join(CONFIG_DIR, "config.json");

export const PRODUCTION_API_URL =
  "https://data-nexus-541643753386.asia-south1.run.app";
export const LOCAL_API_URL = "http://localhost:8080";

function normalizeUrl(url) {
  return String(url || "").replace(/\/$/, "");
}

function parseBool(value) {
  if (typeof value !== "string") return null;
  const v = value.trim().toLowerCase();
  if (["1", "true", "on", "yes"].includes(v)) return true;
  if (["0", "false", "off", "no"].includes(v)) return false;
  return null;
}

async function readConfig() {
  try {
    const raw = await fs.readFile(CONFIG_FILE, "utf8");
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

async function writeConfig(data) {
  await fs.mkdir(CONFIG_DIR, { recursive: true });
  await fs.writeFile(CONFIG_FILE, JSON.stringify(data, null, 2), "utf8");
  try {
    await fs.chmod(CONFIG_FILE, 0o600);
  } catch {
    // Best-effort; ignore chmod failures on unsupported systems.
  }
}

export async function isDeveloperModeEnabled() {
  const fromEnv = parseBool(process.env.DEV_MONITOR_DEVELOPER_MODE);
  if (fromEnv !== null) return fromEnv;

  const config = await readConfig();
  return config.developerMode === true;
}

export async function setDeveloperModeEnabled(enabled) {
  const config = await readConfig();
  config.developerMode = Boolean(enabled);
  await writeConfig(config);
}

export async function getBaseUrl() {
  const devMode = await isDeveloperModeEnabled();
  return normalizeUrl(devMode ? LOCAL_API_URL : PRODUCTION_API_URL);
}

export async function getEndpointStatus() {
  const developerMode = await isDeveloperModeEnabled();
  return {
    developerMode,
    baseUrl: normalizeUrl(developerMode ? LOCAL_API_URL : PRODUCTION_API_URL),
    source: developerMode ? "developer-mode" : "production-default",
  };
}
