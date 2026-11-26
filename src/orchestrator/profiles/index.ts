/**
 * Profile registry — runtime-loaded from the profiles/ directory.
 *
 * Adding a chip = drop a <name>.json file next to this module (src at dev
 * time, dist after build). No code change, no re-registration — the loader
 * picks it up automatically. The engine (session.ts/manager.ts) is
 * chip-agnostic.
 */
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";
import type { OrchestratorProfile } from "../types.js";

let cache: Record<string, OrchestratorProfile> | null = null;

function profilesDir(): string {
  // dist/orchestrator/profiles/index.js -> dist/orchestrator/profiles/  (built)
  // src/orchestrator/profiles/index.ts -> src/orchestrator/profiles/    (dev)
  return path.dirname(fileURLToPath(import.meta.url));
}

function loadProfiles(): Record<string, OrchestratorProfile> {
  const result: Record<string, OrchestratorProfile> = {};
  let files: string[] = [];
  try {
    files = fs.readdirSync(profilesDir()).filter((f) => f.endsWith(".json"));
  } catch {
    return result;
  }
  for (const f of files) {
    try {
      const p = JSON.parse(fs.readFileSync(path.join(profilesDir(), f), "utf-8")) as OrchestratorProfile;
      if (!p.name || !p.frame || !Array.isArray(p.commands)) {
        console.error(`[orchestrator] profile ${f} missing name/frame/commands — skipped`);
        continue;
      }
      result[p.name] = p;
    } catch (e: any) {
      console.error(`[orchestrator] failed to parse profile ${f}: ${e.message}`);
    }
  }
  return result;
}

function profiles(): Record<string, OrchestratorProfile> {
  if (!cache) cache = loadProfiles();
  return cache;
}

/** Reload profiles from disk (picks up newly dropped files). */
export function reloadProfiles(): number {
  cache = loadProfiles();
  return Object.keys(cache).length;
}

/** Every loaded profile (panel/profile browser); insertion order of the directory. */
export function allProfiles(): OrchestratorProfile[] {
  return Object.values(profiles());
}

export function getProfile(name: string): OrchestratorProfile {
  const p = profiles()[name];
  if (!p) {
    throw new Error(
      `Unknown Orchestrator profile '${name}'. Available: ${Object.keys(profiles()).join(", ") || "(none)"}`
    );
  }
  return p;
}

export function listProfiles(): Array<{
  name: string;
  chip: string;
  description: string;
  serial: { baudRate: number; wiring?: string };
  commands: Array<{ name: string; title: string; fpgaSuitable: boolean }>;
  smoke: string[];
  lowPower: string[];
}> {
  return Object.values(profiles()).map((p) => ({
    name: p.name,
    chip: p.chip,
    description: p.description,
    serial: { baudRate: p.serial.baudRate, wiring: p.serial.wiring },
    commands: p.commands.map((c) => ({
      name: c.name,
      title: c.title,
      fpgaSuitable: c.fpgaSuitable ?? false,
    })),
    smoke: p.smoke ?? [],
    lowPower: p.lowPower ?? [],
  }));
}
