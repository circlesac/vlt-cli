#!/usr/bin/env bun

import { defineCommand, runMain } from "citty"
import { api, resolveVault, resolveItem, getConfig, setOverrides } from "./api"
import { createReadStream, readFileSync } from "node:fs"
import { writeFileSync } from "node:fs"
import { spawnSync } from "node:child_process"

type Item = {
  id: string
  title: string
  version: number
  vault: { id: string }
  category: string
  tags: string[]
  favorite: boolean
  fields?: { id: string; label: string; value: string; type: string; purpose?: string }[]
  sections?: object[]
  urls?: { href: string; primary?: boolean }[]
  created_at: string
  updated_at: string
}

type Vault = {
  id: string
  name: string
  description: string
  type: string
  items: number
  created_at: string
  updated_at: string
}

// ── Secret Reference Parser ─────────────────────────────────────────────────
// Format: op://<vault>/<item>/<field>

function parseSecretRef(ref: string): { vault: string; item: string; field: string } {
  const match = ref.match(/^op:\/\/([^/]+)\/([^/]+)\/([^/?]+)/)
  if (!match) {
    console.error(`[ERROR] Invalid secret reference: ${ref}`)
    console.error("Expected format: op://<vault>/<item>/<field>")
    process.exit(1)
  }
  return { vault: match[1]!, item: match[2]!, field: match[3]! }
}

async function readSecret(ref: string): Promise<string> {
  const { vault, item, field } = parseSecretRef(ref)
  const vaultId = await resolveVault(vault)
  const itemId = await resolveItem(vaultId, item)
  const fullItem = await api<Item>(`/v1/vaults/${vaultId}/items/${itemId}`)

  const f = fullItem.fields?.find(
    (f) => f.label === field || f.id === field || f.purpose?.toLowerCase() === field.toLowerCase()
  )
  if (!f) {
    console.error(`[ERROR] Field "${field}" not found on item "${item}"`)
    process.exit(1)
  }
  return f.value
}

// ── Field Assignment Parser ─────────────────────────────────────────────────
// Format: [section.]field[type]=value  (op CLI compatible)

function parseAssignment(arg: string): { label: string; value: string; type: string; section?: string } {
  const eqIdx = arg.indexOf("=")
  if (eqIdx < 0) {
    console.error(`[ERROR] Invalid assignment: ${arg}`)
    process.exit(1)
  }
  const left = arg.slice(0, eqIdx)
  const value = arg.slice(eqIdx + 1)

  // Check for [type] suffix
  const typeMatch = left.match(/^(.+)\[(\w+)\]$/)
  const label = typeMatch ? typeMatch[1]! : left
  const type = typeMatch ? typeMatch[2]!.toUpperCase() : "STRING"

  // Check for section prefix
  const dotIdx = label.indexOf(".")
  if (dotIdx > 0) {
    return { section: label.slice(0, dotIdx), label: label.slice(dotIdx + 1), value, type }
  }
  return { label, value, type }
}

// ── Commands ────────────────────────────────────────────────────────────────

const formatFlag = {
  format: { type: "string" as const, description: "Output format: json or human-readable" },
}

const vaultFlag = {
  vault: { type: "string" as const, description: "Vault name or ID" },
}

// read
const readCommand = defineCommand({
  meta: { name: "read", description: "Read a secret reference" },
  args: {
    reference: { type: "positional" as const, description: "Secret reference (op://vault/item/field)", required: true },
    "no-newline": { type: "boolean" as const, alias: "n", description: "No trailing newline" },
    "out-file": { type: "string" as const, alias: "o", description: "Write to file instead of stdout" },
  },
  async run({ args }) {
    const value = await readSecret(args.reference)
    if (args["out-file"]) {
      writeFileSync(args["out-file"], value, { mode: 0o600 })
    } else if (args["no-newline"]) {
      process.stdout.write(value)
    } else {
      console.log(value)
    }
  },
})

// inject
const injectCommand = defineCommand({
  meta: { name: "inject", description: "Inject secrets into a template" },
  args: {
    "in-file": { type: "string" as const, alias: "i", description: "Input template file (default: stdin)" },
    "out-file": { type: "string" as const, alias: "o", description: "Output file (default: stdout)" },
  },
  async run({ args }) {
    let template: string
    if (args["in-file"]) {
      template = readFileSync(args["in-file"], "utf-8")
    } else {
      // Read from stdin
      const chunks: Buffer[] = []
      for await (const chunk of process.stdin) chunks.push(chunk as Buffer)
      template = Buffer.concat(chunks).toString("utf-8")
    }

    // Replace all {{op://...}} references
    const refs = [...template.matchAll(/\{\{(op:\/\/[^}]+)\}\}/g)]
    let result = template
    for (const match of refs) {
      const value = await readSecret(match[1]!)
      result = result.replace(match[0]!, value)
    }

    if (args["out-file"]) {
      writeFileSync(args["out-file"], result, { mode: 0o600 })
    } else {
      process.stdout.write(result)
    }
  },
})

// run
const runCommand = defineCommand({
  meta: { name: "run", description: "Run a command with secrets injected as env vars" },
  args: {
    "no-masking": { type: "boolean" as const, description: "Don't mask secrets in output" },
  },
  async run({ rawArgs }) {
    // Find -- separator
    const dashIdx = rawArgs.indexOf("--")
    if (dashIdx < 0 || dashIdx === rawArgs.length - 1) {
      console.error("Usage: vault run [flags] -- <command> [args...]")
      process.exit(1)
    }
    const cmd = rawArgs.slice(dashIdx + 1)

    // Scan env vars for op:// references
    const env = { ...process.env }
    for (const [key, val] of Object.entries(env)) {
      if (val?.startsWith("op://")) {
        env[key] = await readSecret(val)
      }
    }

    const result = spawnSync(cmd[0]!, cmd.slice(1), { stdio: "inherit", env })
    process.exit(result.status ?? 1)
  },
})

// vault list
const vaultListCommand = defineCommand({
  meta: { name: "list", description: "List all vaults" },
  args: { ...formatFlag },
  async run({ args }) {
    const vaults = await api<Vault[]>("/v1/vaults")
    if (args.format === "json") {
      console.log(JSON.stringify(vaults, null, 2))
    } else {
      console.log(`${"ID".padEnd(28)} ${"NAME".padEnd(24)} ITEMS`)
      console.log("─".repeat(60))
      for (const v of vaults) {
        console.log(`${v.id.padEnd(28)} ${v.name.padEnd(24)} ${v.items}`)
      }
    }
  },
})

// vault get
const vaultGetCommand = defineCommand({
  meta: { name: "get", description: "Get vault details" },
  args: {
    vault: { type: "positional" as const, description: "Vault name or ID", required: true },
    ...formatFlag,
  },
  async run({ args }) {
    const vaultId = await resolveVault(args.vault)
    const vault = await api<Vault>(`/v1/vaults/${vaultId}`)
    if (args.format === "json") {
      console.log(JSON.stringify(vault, null, 2))
    } else {
      console.log(`ID:          ${vault.id}`)
      console.log(`Name:        ${vault.name}`)
      console.log(`Description: ${vault.description}`)
      console.log(`Items:       ${vault.items}`)
      console.log(`Created:     ${vault.created_at}`)
      console.log(`Updated:     ${vault.updated_at}`)
    }
  },
})

// vault create
const vaultCreateCommand = defineCommand({
  meta: { name: "create", description: "Create a new vault" },
  args: {
    name: { type: "positional" as const, description: "Vault name", required: true },
    description: { type: "string" as const, description: "Vault description" },
    ...formatFlag,
  },
  async run({ args }) {
    const vault = await api<Vault>("/v1/vaults", {
      method: "POST",
      body: { name: args.name, description: args.description || "" },
    })
    if (args.format === "json") {
      console.log(JSON.stringify(vault, null, 2))
    } else {
      console.log(`ID:   ${vault.id}`)
      console.log(`Name: ${vault.name}`)
    }
  },
})

// vault edit
const vaultEditCommand = defineCommand({
  meta: { name: "edit", description: "Edit a vault" },
  args: {
    vault: { type: "positional" as const, description: "Vault name or ID", required: true },
    name: { type: "string" as const, description: "New vault name" },
    description: { type: "string" as const, description: "New description" },
    ...formatFlag,
  },
  async run({ args }) {
    const vaultId = await resolveVault(args.vault)
    const body: Record<string, string> = {}
    if (args.name) body.name = args.name
    if (args.description) body.description = args.description
    const vault = await api<Vault>(`/v1/vaults/${vaultId}`, { method: "PUT", body })
    if (args.format === "json") {
      console.log(JSON.stringify(vault, null, 2))
    } else {
      console.log(`ID:   ${vault.id}`)
      console.log(`Name: ${vault.name}`)
    }
  },
})

// vault delete
const vaultDeleteCommand = defineCommand({
  meta: { name: "delete", description: "Delete a vault" },
  args: {
    vault: { type: "positional" as const, description: "Vault name or ID", required: true },
  },
  async run({ args }) {
    const vaultId = await resolveVault(args.vault)
    await api(`/v1/vaults/${vaultId}`, { method: "DELETE" })
    console.log(`Vault "${args.vault}" deleted.`)
  },
})

const vaultCommand = defineCommand({
  meta: { name: "vault", description: "Manage vaults" },
  subCommands: {
    list: vaultListCommand,
    get: vaultGetCommand,
    create: vaultCreateCommand,
    edit: vaultEditCommand,
    delete: vaultDeleteCommand,
  },
})

// item list
const itemListCommand = defineCommand({
  meta: { name: "list", description: "List items in a vault" },
  args: {
    ...vaultFlag, ...formatFlag,
    tags: { type: "string" as const, description: "Filter by tags (comma-separated)" },
    categories: { type: "string" as const, description: "Filter by categories (comma-separated)" },
  },
  async run({ args }) {
    if (!args.vault) {
      console.error("[ERROR] --vault is required")
      process.exit(1)
    }
    const vaultId = await resolveVault(args.vault)
    const params = new URLSearchParams()
    if (args.tags) params.set("tags", args.tags)
    if (args.categories) params.set("categories", args.categories)
    const qs = params.toString() ? `?${params}` : ""
    const items = await api<Item[]>(`/v1/vaults/${vaultId}/items${qs}`)
    if (args.format === "json") {
      console.log(JSON.stringify(items, null, 2))
    } else {
      console.log(`${"ID".padEnd(28)} ${"TITLE".padEnd(30)} CATEGORY`)
      console.log("─".repeat(70))
      for (const item of items) {
        console.log(`${item.id.padEnd(28)} ${item.title.padEnd(30)} ${item.category}`)
      }
    }
  },
})

// item get
const itemGetCommand = defineCommand({
  meta: { name: "get", description: "Get item details" },
  args: {
    item: { type: "positional" as const, description: "Item name or ID", required: true },
    ...vaultFlag,
    ...formatFlag,
    reveal: { type: "boolean" as const, description: "Don't conceal sensitive fields" },
    fields: { type: "string" as const, description: "Return specific fields (comma-separated)" },
    otp: { type: "boolean" as const, description: "Output one-time password" },
  },
  async run({ args }) {
    if (!args.vault) {
      console.error("[ERROR] --vault is required")
      process.exit(1)
    }
    const vaultId = await resolveVault(args.vault)
    const itemId = await resolveItem(vaultId, args.item)
    const item = await api<Item>(`/v1/vaults/${vaultId}/items/${itemId}`)

    if (args.fields) {
      const specs = args.fields.split(",").map((f) => f.trim())
      const matched = item.fields?.filter((f) => {
        return specs.some((spec) => {
          if (spec.startsWith("label=")) return f.label === spec.slice(6)
          if (spec.startsWith("type=")) return f.type.toLowerCase() === spec.slice(5).toLowerCase()
          return f.label === spec // bare label
        })
      }) || []
      if (args.format === "json") {
        console.log(JSON.stringify(matched, null, 2))
      } else {
        for (const f of matched) {
          const val = !args.reveal && f.type === "CONCEALED" ? "••••••••" : f.value
          console.log(`${f.label}: ${val}`)
        }
      }
      return
    }

    if (args.format === "json") {
      console.log(JSON.stringify(item, null, 2))
    } else {
      console.log(`ID:       ${item.id}`)
      console.log(`Title:    ${item.title}`)
      console.log(`Category: ${item.category}`)
      console.log(`Vault:    ${item.vault.id}`)
      console.log(`Version:  ${item.version}`)
      if (item.urls?.length) console.log(`URL:      ${item.urls[0]!.href}`)
      if (item.fields?.length) {
        console.log(`\nFields:`)
        for (const f of item.fields) {
          const val = !args.reveal && f.type === "CONCEALED" ? "••••••••" : f.value
          console.log(`  ${f.label}: ${val}`)
        }
      }
    }
  },
})

// item create
const itemCreateCommand = defineCommand({
  meta: { name: "create", description: "Create a new item" },
  args: {
    ...vaultFlag,
    ...formatFlag,
    category: { type: "string" as const, description: "Item category (login, password, api_credential, secure_note, etc.)" },
    title: { type: "string" as const, description: "Item title" },
    url: { type: "string" as const, description: "URL for the item" },
    tags: { type: "string" as const, description: "Comma-separated tags" },
    favorite: { type: "boolean" as const, description: "Mark as favorite" },
    "generate-password": { type: "string" as const, description: "Generate a random password" },
  },
  async run({ args, rawArgs }) {
    if (!args.vault) {
      console.error("[ERROR] --vault is required")
      process.exit(1)
    }
    const vaultId = await resolveVault(args.vault)

    // Check for stdin template (op item create ... -)
    let templateFields: object[] = []
    if (rawArgs.includes("-")) {
      const chunks: Buffer[] = []
      for await (const chunk of process.stdin) chunks.push(chunk as Buffer)
      const tpl = JSON.parse(Buffer.concat(chunks).toString("utf-8"))
      templateFields = tpl.fields || []
    }

    // Parse assignment args (positional args after flags)
    const assignments = rawArgs.filter((a) => a.includes("=") && !a.startsWith("--") && a !== "-")
    const fields = [...templateFields as any[], ...assignments.map((a) => {
      const parsed = parseAssignment(a)
      const purpose = ["username", "password"].includes(parsed.label.toLowerCase())
        ? parsed.label.toUpperCase()
        : undefined
      const type = parsed.label.toLowerCase() === "password" ? "CONCEALED" : parsed.type
      return { id: parsed.label, label: parsed.label, value: parsed.value, type, purpose }
    })]

    // Override template fields with assignments
    for (const assign of assignments) {
      const parsed = parseAssignment(assign)
      const existing = fields.findIndex((f: any) => f.label === parsed.label || f.id === parsed.label)
      if (existing >= 0) {
        (fields[existing] as any).value = parsed.value
      }
    }

    // Generate password if requested
    if (args["generate-password"] !== undefined) {
      const len = parseInt(args["generate-password"]) || 32
      const charset = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!@.-_*"
      const bytes = new Uint8Array(len)
      crypto.getRandomValues(bytes)
      const password = Array.from(bytes, (b) => charset[b % charset.length]).join("")
      fields.push({ id: "password", label: "password", value: password, type: "CONCEALED", purpose: "PASSWORD" })
    }

    const urls = args.url ? [{ primary: true, href: args.url }] : []
    const tags = args.tags ? args.tags.split(",").map((t) => t.trim()) : []

    const item = await api<Item>(`/v1/vaults/${vaultId}/items`, {
      method: "POST",
      body: {
        title: args.title || "Untitled",
        category: (args.category || "LOGIN").toUpperCase(),
        fields,
        urls,
        tags,
        favorite: args.favorite || false,
      },
    })

    if (args.format === "json") {
      console.log(JSON.stringify(item, null, 2))
    } else {
      console.log(`ID:    ${item.id}`)
      console.log(`Title: ${item.title}`)
      console.log(`Vault: ${item.vault.id}`)
    }
  },
})

// item edit
const itemEditCommand = defineCommand({
  meta: { name: "edit", description: "Edit an item" },
  args: {
    item: { type: "positional" as const, description: "Item name or ID", required: true },
    ...vaultFlag,
    ...formatFlag,
    title: { type: "string" as const, description: "New title" },
  },
  async run({ args, rawArgs }) {
    if (!args.vault) {
      console.error("[ERROR] --vault is required")
      process.exit(1)
    }
    const vaultId = await resolveVault(args.vault)
    const itemId = await resolveItem(vaultId, args.item)

    // Get current item
    const current = await api<Item>(`/v1/vaults/${vaultId}/items/${itemId}`)

    // Parse assignment args for field updates
    const assignments = rawArgs.filter((a) => a.includes("=") && !a.startsWith("--"))
    const updatedFields = [...(current.fields || [])]

    for (const a of assignments) {
      const parsed = parseAssignment(a)
      const existing = updatedFields.findIndex((f) => f.label === parsed.label || f.id === parsed.label)
      if (existing >= 0) {
        updatedFields[existing] = { ...updatedFields[existing]!, value: parsed.value }
      } else {
        const type = parsed.label.toLowerCase() === "password" ? "CONCEALED" : parsed.type
        updatedFields.push({ id: parsed.label, label: parsed.label, value: parsed.value, type })
      }
    }

    const item = await api<Item>(`/v1/vaults/${vaultId}/items/${itemId}`, {
      method: "PUT",
      body: {
        title: args.title ?? current.title,
        category: current.category,
        fields: updatedFields,
        sections: current.sections,
        urls: current.urls,
        tags: current.tags,
        favorite: current.favorite,
      },
    })

    if (args.format === "json") {
      console.log(JSON.stringify(item, null, 2))
    } else {
      console.log(`ID:      ${item.id}`)
      console.log(`Title:   ${item.title}`)
      console.log(`Version: ${item.version}`)
    }
  },
})

// item delete
const itemDeleteCommand = defineCommand({
  meta: { name: "delete", description: "Delete an item" },
  args: {
    item: { type: "positional" as const, description: "Item name or ID", required: true },
    ...vaultFlag,
  },
  async run({ args }) {
    if (!args.vault) {
      console.error("[ERROR] --vault is required")
      process.exit(1)
    }
    const vaultId = await resolveVault(args.vault)
    const itemId = await resolveItem(vaultId, args.item)
    await api(`/v1/vaults/${vaultId}/items/${itemId}`, { method: "DELETE" })
    console.log(`Item "${args.item}" deleted.`)
  },
})

// item template (client-side, matches op item template output)
const ITEM_TEMPLATES: Record<string, { title: string; category: string; fields: object[] }> = {
  LOGIN: {
    title: "", category: "LOGIN",
    fields: [
      { id: "username", type: "STRING", purpose: "USERNAME", label: "username", value: "" },
      { id: "password", type: "CONCEALED", purpose: "PASSWORD", label: "password", value: "" },
      { id: "notesPlain", type: "STRING", purpose: "NOTES", label: "notesPlain", value: "" },
    ],
  },
  PASSWORD: {
    title: "", category: "PASSWORD",
    fields: [
      { id: "password", type: "CONCEALED", purpose: "PASSWORD", label: "password", value: "" },
      { id: "notesPlain", type: "STRING", purpose: "NOTES", label: "notesPlain", value: "" },
    ],
  },
  API_CREDENTIAL: {
    title: "", category: "API_CREDENTIAL",
    fields: [
      { id: "notesPlain", type: "STRING", purpose: "NOTES", label: "notesPlain", value: "" },
      { id: "username", type: "STRING", label: "username", value: "" },
      { id: "credential", type: "CONCEALED", label: "credential", value: "" },
      { id: "type", type: "MENU", label: "type", value: "" },
      { id: "filename", type: "STRING", label: "filename", value: "" },
      { id: "validFrom", type: "DATE", label: "valid from", value: "" },
      { id: "expires", type: "DATE", label: "expires", value: "" },
      { id: "hostname", type: "STRING", label: "hostname", value: "" },
    ],
  },
  SECURE_NOTE: {
    title: "", category: "SECURE_NOTE",
    fields: [
      { id: "notesPlain", type: "STRING", purpose: "NOTES", label: "notesPlain", value: "" },
    ],
  },
  DATABASE: {
    title: "", category: "DATABASE",
    fields: [
      { id: "notesPlain", type: "STRING", purpose: "NOTES", label: "notesPlain", value: "" },
      { id: "database_type", type: "MENU", label: "type", value: "" },
      { id: "hostname", type: "STRING", label: "server", value: "" },
      { id: "port", type: "STRING", label: "port", value: "" },
      { id: "database", type: "STRING", label: "database", value: "" },
      { id: "username", type: "STRING", label: "username", value: "" },
      { id: "password", type: "CONCEALED", label: "password", value: "" },
      { id: "sid", type: "STRING", label: "SID", value: "" },
      { id: "alias", type: "STRING", label: "alias", value: "" },
      { id: "options", type: "STRING", label: "connection options", value: "" },
    ],
  },
  SERVER: {
    title: "", category: "SERVER",
    fields: [
      { id: "notesPlain", type: "STRING", purpose: "NOTES", label: "notesPlain", value: "" },
      { id: "url", type: "STRING", label: "URL", value: "" },
      { id: "username", type: "STRING", label: "username", value: "" },
      { id: "password", type: "CONCEALED", label: "password", value: "" },
    ],
  },
}

const TEMPLATE_LIST = [
  { uuid: "001", name: "Login" },
  { uuid: "002", name: "Credit Card" },
  { uuid: "003", name: "Secure Note" },
  { uuid: "004", name: "Identity" },
  { uuid: "005", name: "Password" },
  { uuid: "006", name: "Document" },
  { uuid: "100", name: "Software License" },
  { uuid: "101", name: "Bank Account" },
  { uuid: "102", name: "Database" },
  { uuid: "103", name: "Driver License" },
  { uuid: "104", name: "Outdoor License" },
  { uuid: "105", name: "Membership" },
  { uuid: "106", name: "Passport" },
  { uuid: "107", name: "Reward Program" },
  { uuid: "108", name: "Social Security Number" },
  { uuid: "109", name: "Wireless Router" },
  { uuid: "110", name: "Server" },
  { uuid: "111", name: "Email Account" },
  { uuid: "112", name: "API Credential" },
  { uuid: "113", name: "Medical Record" },
  { uuid: "114", name: "SSH Key" },
  { uuid: "115", name: "Crypto Wallet" },
]

const itemTemplateListCommand = defineCommand({
  meta: { name: "list", description: "List item templates" },
  args: { ...formatFlag },
  run({ args }) {
    if (args.format === "json") {
      console.log(JSON.stringify(TEMPLATE_LIST, null, 2))
    } else {
      console.log(`${"UUID".padEnd(6)} NAME`)
      console.log("─".repeat(30))
      for (const t of TEMPLATE_LIST) {
        console.log(`${t.uuid.padEnd(6)} ${t.name}`)
      }
    }
  },
})

const itemTemplateGetCommand = defineCommand({
  meta: { name: "get", description: "Get an item template" },
  args: {
    category: { type: "positional" as const, description: "Category name", required: true },
    ...formatFlag,
  },
  run({ args }) {
    const key = args.category.toUpperCase().replace(/ /g, "_")
    const template = ITEM_TEMPLATES[key]
    if (!template) {
      console.error(`[ERROR] Unknown category: ${args.category}`)
      console.error(`Available: ${Object.keys(ITEM_TEMPLATES).join(", ")}`)
      process.exit(1)
    }
    console.log(JSON.stringify(template, null, 2))
  },
})

const itemTemplateCommand = defineCommand({
  meta: { name: "template", description: "Manage item templates" },
  subCommands: {
    list: itemTemplateListCommand,
    get: itemTemplateGetCommand,
  },
})

// item move
const itemMoveCommand = defineCommand({
  meta: { name: "move", description: "Move an item between vaults" },
  args: {
    item: { type: "positional" as const, description: "Item name or ID", required: true },
    "current-vault": { type: "string" as const, description: "Source vault", required: true },
    "destination-vault": { type: "string" as const, description: "Destination vault", required: true },
    ...formatFlag,
  },
  async run({ args }) {
    const srcVaultId = await resolveVault(args["current-vault"]!)
    const destVaultId = await resolveVault(args["destination-vault"]!)
    const itemId = await resolveItem(srcVaultId, args.item)
    const item = await api<Item>(`/v1/vaults/${srcVaultId}/items/${itemId}/move`, {
      method: "POST",
      body: { vault: destVaultId },
    })
    if (args.format === "json") {
      console.log(JSON.stringify(item, null, 2))
    } else {
      console.log(`Item "${args.item}" moved to vault "${args["destination-vault"]}".`)
    }
  },
})

const itemCommand = defineCommand({
  meta: { name: "item", description: "Manage items in your vaults" },
  subCommands: {
    list: itemListCommand,
    get: itemGetCommand,
    create: itemCreateCommand,
    edit: itemEditCommand,
    delete: itemDeleteCommand,
    move: itemMoveCommand,
    template: itemTemplateCommand,
  },
})

// document create
const documentCreateCommand = defineCommand({
  meta: { name: "create", description: "Upload a document" },
  args: {
    file: { type: "positional" as const, description: "File path", required: true },
    ...vaultFlag,
    title: { type: "string" as const, description: "Document title" },
    ...formatFlag,
  },
  async run({ args }) {
    if (!args.vault) { console.error("[ERROR] --vault is required"); process.exit(1) }
    const vaultId = await resolveVault(args.vault)

    // Create a LOGIN item to hold the document reference, then upload file
    const title = args.title || args.file.split("/").pop() || "Document"
    const item = await api<Item>(`/v1/vaults/${vaultId}/items`, {
      method: "POST",
      body: { title, category: "DOCUMENT", fields: [] },
    })

    // Upload file
    const fileContent = readFileSync(args.file)
    const { baseUrl, token } = getConfig()
    const form = new FormData()
    form.append("file", new Blob([fileContent]), args.file.split("/").pop() || "file")
    const res = await fetch(`${baseUrl}/v1/vaults/${vaultId}/items/${item.id}/files`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: form,
    })
    if (!res.ok) {
      console.error(`[ERROR] Failed to upload file: ${res.status}`)
      process.exit(1)
    }

    if (args.format === "json") {
      console.log(JSON.stringify({ id: item.id, title, vault_id: vaultId }, null, 2))
    } else {
      console.log(`ID:    ${item.id}`)
      console.log(`Title: ${title}`)
    }
  },
})

// document list
const documentListCommand = defineCommand({
  meta: { name: "list", description: "List documents" },
  args: { ...vaultFlag, ...formatFlag },
  async run({ args }) {
    if (!args.vault) { console.error("[ERROR] --vault is required"); process.exit(1) }
    const vaultId = await resolveVault(args.vault)
    const items = await api<Item[]>(`/v1/vaults/${vaultId}/items`)
    const docs = items.filter((i) => i.category === "DOCUMENT")
    if (args.format === "json") {
      console.log(JSON.stringify(docs, null, 2))
    } else {
      console.log(`${"ID".padEnd(28)} TITLE`)
      console.log("─".repeat(50))
      for (const d of docs) console.log(`${d.id.padEnd(28)} ${d.title}`)
    }
  },
})

// document get (download)
const documentGetCommand = defineCommand({
  meta: { name: "get", description: "Download a document" },
  args: {
    document: { type: "positional" as const, description: "Document name or ID", required: true },
    ...vaultFlag,
    output: { type: "string" as const, alias: "o", description: "Output file path" },
  },
  async run({ args }) {
    if (!args.vault) { console.error("[ERROR] --vault is required"); process.exit(1) }
    const vaultId = await resolveVault(args.vault)
    const itemId = await resolveItem(vaultId, args.document)
    type FileInfo = { id: string; name: string; size: number; content_path: string }
    const fileList = await api<FileInfo[]>(`/v1/vaults/${vaultId}/items/${itemId}/files`)
    if (fileList.length === 0) {
      console.error("[ERROR] No files attached to this document")
      process.exit(1)
    }
    const file = fileList[0]!
    const { baseUrl, token } = getConfig()
    const res = await fetch(`${baseUrl}/${file.content_path}`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    if (!res.ok) {
      console.error(`[ERROR] Failed to download: ${res.status}`)
      process.exit(1)
    }
    const content = Buffer.from(await res.arrayBuffer())
    if (args.output) {
      writeFileSync(args.output, content)
      console.log(`Saved to ${args.output}`)
    } else {
      process.stdout.write(content)
    }
  },
})

const documentCommand = defineCommand({
  meta: { name: "document", description: "Manage documents" },
  subCommands: {
    create: documentCreateCommand,
    list: documentListCommand,
    get: documentGetCommand,
  },
})

// whoami
const whoamiCommand = defineCommand({
  meta: { name: "whoami", description: "Show connection info" },
  run() {
    const { baseUrl, org } = getConfig()
    console.log(`Host: ${baseUrl}`)
    console.log(`Org:  ${org}`)
  },
})

// ── Main ────────────────────────────────────────────────────────────────────

export const main = defineCommand({
  meta: {
    name: "vlt",
    description: "1Password-compatible secrets CLI for Circles Vault",
  },
  args: {
    profile: { type: "string" as const, description: "crcl profile to use (default: default)" },
    org: { type: "string" as const, description: "Organization slug override" },
  },
  setup({ args }) {
    setOverrides({ profile: args.profile, org: args.org })
  },
  subCommands: {
    read: readCommand,
    inject: injectCommand,
    run: runCommand,
    vault: vaultCommand,
    item: itemCommand,
    document: documentCommand,
    whoami: whoamiCommand,
  },
})

if (import.meta.main) {
  runMain(main)
}
