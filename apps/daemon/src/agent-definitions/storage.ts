import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  type AgentDefinition,
  AgentDefinitionSchema,
  type AgentsConfig,
  AgentsConfigSchema,
  type CreateAgentDefinitionInput,
  type UpdateAgentDefinitionInput,
} from "@citadel/contracts";
import { DEFAULT_AGENTS_CONFIG, isPredefinedAgentId, predefinedAgentSeed, predefinedAgentSeeds } from "./seed.js";

export type AgentDefinitionsStorageState = "ready" | "unavailable";

export type AgentDefinitionsStorageError =
  | "agent_storage_unavailable"
  | "predefined_agent_cannot_be_deleted"
  | "predefined_agent_cannot_be_reset_by_custom_id"
  | "custom_agent_cannot_reuse_predefined_id"
  | "agent_not_found"
  | "name_collides";

export class AgentDefinitionsError extends Error {
  constructor(
    public readonly code: AgentDefinitionsStorageError,
    message?: string,
  ) {
    super(message ?? code);
  }
}

export type AgentDefinitionsStorage = {
  state(): AgentDefinitionsStorageState;
  list(): AgentDefinition[];
  get(id: string): AgentDefinition | undefined;
  create(input: CreateAgentDefinitionInput): AgentDefinition;
  update(id: string, patch: UpdateAgentDefinitionInput): AgentDefinition;
  remove(id: string): void;
  resetToDefaults(id: string): AgentDefinition;
  readConfig(): AgentsConfig;
  writeConfig(patch: Partial<AgentsConfig>): AgentsConfig;
};

export type AgentDefinitionsStorageOptions = {
  // Directory containing the per-definition JSON files. Defaults to
  // ~/.citadel/agents. Override only for tests.
  baseDir?: string;
  // Path to the config JSON. Defaults to ~/.citadel/agents.config.json.
  configPath?: string;
};

const SLUG_RE = /^[a-z0-9][a-z0-9_-]*$/;

export function createAgentDefinitionsStorage(options: AgentDefinitionsStorageOptions = {}): AgentDefinitionsStorage {
  const home = os.homedir();
  const baseDir = options.baseDir ?? path.join(home, ".citadel", "agents");
  const configPath = options.configPath ?? path.join(home, ".citadel", "agents.config.json");
  let bootError: string | null = null;

  const ensureDir = (): boolean => {
    try {
      fs.mkdirSync(baseDir, { recursive: true });
      // After mkdir, prove we can write a sentinel.
      const sentinel = path.join(baseDir, ".citadel-write-test");
      fs.writeFileSync(sentinel, "");
      fs.unlinkSync(sentinel);
      bootError = null;
      return true;
    } catch (err) {
      bootError = err instanceof Error ? err.message : String(err);
      return false;
    }
  };

  const writeDefinition = (def: AgentDefinition) => {
    const filePath = path.join(baseDir, `${def.id}.json`);
    const data = JSON.stringify(def, null, 2);
    fs.writeFileSync(filePath, data);
  };

  const writeIfDriftedOrMissing = (def: AgentDefinition) => {
    const filePath = path.join(baseDir, `${def.id}.json`);
    const desired = JSON.stringify(def, null, 2);
    let current: string | null = null;
    try {
      current = fs.readFileSync(filePath, "utf8");
    } catch {
      current = null;
    }
    if (current === null) {
      fs.writeFileSync(filePath, desired);
      return;
    }
    const equal =
      createHash("sha256").update(current).digest("hex") === createHash("sha256").update(desired).digest("hex");
    if (!equal) {
      // Only overwrite if the on-disk file is unparseable. For valid but
      // edited predefined definitions, the user's edits stand.
      try {
        const parsed = JSON.parse(current);
        AgentDefinitionSchema.parse(parsed);
        return;
      } catch {
        fs.writeFileSync(filePath, desired);
      }
    }
  };

  const seedIfNeeded = () => {
    for (const seed of predefinedAgentSeeds()) {
      writeIfDriftedOrMissing(seed);
    }
  };

  const readAllDefinitions = (): AgentDefinition[] => {
    if (!ensureDir()) return [];
    seedIfNeeded();
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(baseDir, { withFileTypes: true });
    } catch (err) {
      bootError = err instanceof Error ? err.message : String(err);
      return [];
    }
    const out: AgentDefinition[] = [];
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      if (!entry.name.endsWith(".json")) continue;
      const filePath = path.join(baseDir, entry.name);
      try {
        const raw = fs.readFileSync(filePath, "utf8");
        const parsed = JSON.parse(raw);
        const def = AgentDefinitionSchema.parse(parsed);
        out.push(def);
      } catch {
        // Skip malformed files; do not throw. Predefined ids will be re-seeded
        // on the next call if we deleted the bad file, but for safety we just
        // skip. A future operator-facing log surface could expose this.
      }
    }
    // Stable order: predefined first (alpha), then custom (alpha by name).
    const predefined = out.filter((d) => d.kind === "predefined").sort((a, b) => a.id.localeCompare(b.id));
    const custom = out.filter((d) => d.kind === "custom").sort((a, b) => a.name.localeCompare(b.name));
    return [...predefined, ...custom];
  };

  const idForName = (name: string): string => {
    const slug = name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");
    if (slug.length >= 2 && SLUG_RE.test(slug)) return slug;
    // Fall back to a stable timestamp-derived id if the name is exotic.
    return `agent-${Date.now().toString(36)}`;
  };

  const uniqueCustomId = (name: string, existing: AgentDefinition[]): string => {
    const base = idForName(name);
    if (isPredefinedAgentId(base)) {
      return uniqueCustomId(`${name}-custom`, existing);
    }
    const taken = new Set(existing.map((d) => d.id));
    if (!taken.has(base)) return base;
    for (let i = 2; i < 1000; i += 1) {
      const candidate = `${base}-${i}`;
      if (!taken.has(candidate)) return candidate;
    }
    return `${base}-${Date.now().toString(36)}`;
  };

  return {
    state() {
      ensureDir();
      return bootError ? "unavailable" : "ready";
    },
    list() {
      return readAllDefinitions();
    },
    get(id: string) {
      return readAllDefinitions().find((d) => d.id === id);
    },
    create(input) {
      if (!ensureDir()) throw new AgentDefinitionsError("agent_storage_unavailable", bootError ?? "");
      const all = readAllDefinitions();
      if (all.some((d) => d.name.toLowerCase() === input.name.toLowerCase())) {
        throw new AgentDefinitionsError("name_collides");
      }
      const id = uniqueCustomId(input.name, all);
      if (isPredefinedAgentId(id)) {
        throw new AgentDefinitionsError("custom_agent_cannot_reuse_predefined_id");
      }
      const now = new Date().toISOString();
      const def: AgentDefinition = {
        id,
        kind: "custom",
        name: input.name,
        systemPrompt: input.systemPrompt,
        runtime: input.runtime,
        model: input.model,
        createdAt: now,
        updatedAt: now,
      };
      writeDefinition(def);
      return def;
    },
    update(id, patch) {
      if (!ensureDir()) throw new AgentDefinitionsError("agent_storage_unavailable", bootError ?? "");
      const all = readAllDefinitions();
      const current = all.find((d) => d.id === id);
      if (!current) throw new AgentDefinitionsError("agent_not_found");
      if (patch.name !== undefined && patch.name !== current.name) {
        const collision = all.some((d) => d.id !== id && d.name.toLowerCase() === patch.name?.toLowerCase());
        if (collision) throw new AgentDefinitionsError("name_collides");
      }
      const next: AgentDefinition = {
        ...current,
        name: patch.name ?? current.name,
        systemPrompt: patch.systemPrompt ?? current.systemPrompt,
        runtime: patch.runtime ?? current.runtime,
        model: patch.model === undefined ? current.model : (patch.model ?? undefined),
        updatedAt: new Date().toISOString(),
      };
      writeDefinition(next);
      return next;
    },
    remove(id) {
      if (!ensureDir()) throw new AgentDefinitionsError("agent_storage_unavailable", bootError ?? "");
      if (isPredefinedAgentId(id)) {
        throw new AgentDefinitionsError("predefined_agent_cannot_be_deleted");
      }
      const filePath = path.join(baseDir, `${id}.json`);
      try {
        fs.unlinkSync(filePath);
      } catch {
        throw new AgentDefinitionsError("agent_not_found");
      }
    },
    resetToDefaults(id) {
      if (!ensureDir()) throw new AgentDefinitionsError("agent_storage_unavailable", bootError ?? "");
      if (!isPredefinedAgentId(id)) {
        throw new AgentDefinitionsError("predefined_agent_cannot_be_reset_by_custom_id");
      }
      const seed = predefinedAgentSeed(id);
      writeDefinition(seed);
      return seed;
    },
    readConfig() {
      try {
        const raw = fs.readFileSync(configPath, "utf8");
        const parsed = JSON.parse(raw);
        return AgentsConfigSchema.parse(parsed);
      } catch {
        return { ...DEFAULT_AGENTS_CONFIG };
      }
    },
    writeConfig(patch) {
      const current = this.readConfig();
      const next = AgentsConfigSchema.parse({ ...current, ...patch });
      try {
        fs.mkdirSync(path.dirname(configPath), { recursive: true });
        fs.writeFileSync(configPath, JSON.stringify(next, null, 2));
      } catch (err) {
        bootError = err instanceof Error ? err.message : String(err);
        throw new AgentDefinitionsError("agent_storage_unavailable", bootError);
      }
      return next;
    },
  };
}
