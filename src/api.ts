/**
 * Vault Connect API client.
 *
 * Config resolution (priority):
 * 1. OP_CONNECT_HOST + OP_CONNECT_TOKEN (op CLI compat)
 * 2. crcl config (~/.config/crcl/config + credentials)
 *
 * CLI flags --profile and --org override crcl config values.
 */

import { existsSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { execSync } from "node:child_process"

const DEFAULT_VAULT_HOST = "https://vault.circles.ac"
const DEV_VAULT_HOST = "https://vault.crcl.es"

type IniData = Record<string, Record<string, string>>

function parseIni(text: string): IniData {
  const data: IniData = {}
  let section = ""
  for (const raw of text.split("\n")) {
    const line = raw.trim()
    if (!line || line.startsWith("#") || line.startsWith(";")) continue
    const secMatch = line.match(/^\[(.+)\]$/)
    if (secMatch) {
      section = secMatch[1]!
      if (!data[section]) data[section] = {}
      continue
    }
    const eqIdx = line.indexOf("=")
    if (eqIdx > 0 && section) {
      data[section]![line.slice(0, eqIdx).trim()] = line.slice(eqIdx + 1).trim()
    }
  }
  return data
}

function crclConfigDir(): string {
  const xdg = process.env.XDG_CONFIG_HOME
  return join(xdg || join(process.env.HOME || homedir(), ".config"), "crcl")
}

function readCrclConfig(): IniData {
  const path = join(crclConfigDir(), "config")
  if (existsSync(path)) {
    try { return parseIni(readFileSync(path, "utf-8")) } catch { /* ignore */ }
  }
  return {}
}

function readCrclCredentials(): IniData {
  const path = join(crclConfigDir(), "credentials")
  if (existsSync(path)) {
    try { return parseIni(readFileSync(path, "utf-8")) } catch { /* ignore */ }
  }
  return {}
}

/** Get a fresh token via crcl auth token (handles refresh) */
function getCrclToken(profile: string): string | null {
  try {
    const args = profile !== "default" ? `--profile ${profile}` : ""
    return execSync(`crcl auth token ${args}`, { encoding: "utf-8", timeout: 10000, stdio: ["pipe", "pipe", "pipe"] }).trim()
  } catch {
    return null
  }
}

// Global overrides set by CLI flags
let _profileOverride: string | undefined
let _orgOverride: string | undefined

export function setOverrides(opts: { profile?: string; org?: string }) {
  _profileOverride = opts.profile
  _orgOverride = opts.org
}

export function getConfig() {
  // 1. OP_CONNECT_* env vars (op CLI compat)
  if (process.env.OP_CONNECT_HOST && process.env.OP_CONNECT_TOKEN) {
    const url = new URL(process.env.OP_CONNECT_HOST)
    const org = url.pathname.replace(/^\//, "").replace(/\/$/, "")
    const baseUrl = `${url.origin}/${org}`
    return { baseUrl, token: process.env.OP_CONNECT_TOKEN, org }
  }

  // 2. crcl config
  const profile = _profileOverride || process.env.CRCL_PROFILE || "default"
  const config = readCrclConfig()
  const section = config[profile] || {}

  const org = _orgOverride || process.env.CRCL_ORG || section.org
  if (!org) {
    console.error("Error: No org configured. Set --org, CRCL_ORG, or run 'crcl orgs switch <slug>'")
    process.exit(1)
  }

  // Determine vault host based on profile
  const isDevProfile = section.api_url?.includes("-dev") || section.auth_url?.includes("-dev")
  const host = isDevProfile ? DEV_VAULT_HOST : DEFAULT_VAULT_HOST
  const baseUrl = `${host}/${org}`

  // Get token (try cached credentials first, then crcl auth token)
  const creds = readCrclCredentials()
  let token = creds[profile]?.access_token

  // Check if token is expired
  if (token) {
    try {
      const payload = JSON.parse(Buffer.from(token.split(".")[1]!, "base64url").toString())
      if (payload.exp && payload.exp * 1000 < Date.now()) {
        token = undefined // expired, need refresh
      }
    } catch {
      token = undefined
    }
  }

  // Refresh via crcl auth token if needed
  if (!token) {
    token = getCrclToken(profile) || undefined
  }

  if (!token) {
    console.error("Error: Not authenticated. Run 'crcl login'" + (profile !== "default" ? ` --profile ${profile}` : ""))
    process.exit(1)
  }

  return { baseUrl, token, org }
}

export async function api<T = unknown>(
  path: string,
  opts: { method?: string; body?: unknown } = {}
): Promise<T> {
  const { baseUrl, token } = getConfig()
  const url = `${baseUrl}${path}`
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
  }
  if (opts.body) {
    headers["Content-Type"] = "application/json"
  }

  const res = await fetch(url, {
    method: opts.method || "GET",
    headers,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  })

  if (!res.ok) {
    const text = await res.text()
    let message: string
    try {
      message = JSON.parse(text).message || text
    } catch {
      message = text
    }
    console.error(`[ERROR] ${res.status}: ${message}`)
    process.exit(1)
  }

  if (res.status === 204) return undefined as T
  return (await res.json()) as T
}

/** Resolve vault by name or ID */
export async function resolveVault(nameOrId: string): Promise<string> {
  type Vault = { id: string; name: string }
  const vaults = await api<Vault[]>("/v1/vaults")
  const match = vaults.find(
    (v) => v.id === nameOrId || v.name.toLowerCase() === nameOrId.toLowerCase()
  )
  if (!match) {
    console.error(`[ERROR] Vault "${nameOrId}" not found`)
    process.exit(1)
  }
  return match.id
}

/** Resolve item by name or ID within a vault */
export async function resolveItem(
  vaultId: string,
  nameOrId: string
): Promise<string> {
  type Item = { id: string; title: string }
  const items = await api<Item[]>(
    `/v1/vaults/${vaultId}/items?filter=${encodeURIComponent(`title eq "${nameOrId}"`)}`
  )
  if (items.length > 0) return items[0]!.id

  const { baseUrl, token } = getConfig()
  const res = await fetch(`${baseUrl}/v1/vaults/${vaultId}/items/${nameOrId}`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  if (res.ok) {
    const item = (await res.json()) as Item
    return item.id
  }

  console.error(`[ERROR] Item "${nameOrId}" not found in vault`)
  process.exit(1)
}
