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
import type { DutProfile } from "../types.js";

let cache: Record<string, DutProfile> | null = null;

function profilesDir(): string {
  // dist/dut/profiles/index.js -> dist/dut/profiles/  (built)
  // src/dut/profiles/index.ts -> src/dut/profiles/    (dev)
  return path.dirname(fileURLToPath(import.meta.url));
}

function loadProfiles(): Record<string, DutProfile> {
  const result: Record<string, DutProfile> = {};
  let files: string[] = [];
  try {
    files = fs.readdirSync(profilesDir()).filter((f) => f.endsWith(".json"));
  } catch {
    return result;
  }
  for (const f of files) {
    try {
      const p = JSON.parse(fs.readFileSync(path.join(profilesDir(), f), "utf-8")) as DutProfile;
      if (!p.name || !p.frame || !Array.isArray(p.commands)) {
        console.error(`[dut] profile ${f} missing name/frame/commands — skipped`);
        continue;
      }
      result[p.name] = p;
    } catch (e: any) {
      console.error(`[dut] failed to parse profile ${f}: ${e.message}`);
    }
  }
  return result;
}

function profiles(): Record<string, DutProfile> {
  if (!cache) cache = loadProfiles();
  return cache;
}

/** Reload profiles from disk (picks up newly dropped files). */
export function reloadProfiles(): number {
  cache = loadProfiles();
  return Object.keys(cache).length;
}

export function getProfile(name: string): DutProfile {
  const p = profiles()[name];
  if (!p) {
    throw new Error(
      `Unknown DUT profile '${name}'. Available: ${Object.keys(profiles()).join(", ") || "(none)"}`
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
  }));
}
