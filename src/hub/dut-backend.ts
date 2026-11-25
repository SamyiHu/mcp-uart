/**
 * DUT façade for the Hub.
 *
 * The Hub speaks ports and frames; the DUT layer speaks profiles (frame format,
 * command table, judge rules). This adapter is the single place that answers
 * "which connection?" — the agent and the panel share one session, so a call
 * either names a connection or inherits whichever one holds a DUT session.
 *
 * A panel-owned connect opens the port with the profile's serial settings and
 * the same hex/raw framing the MCP `dut_connect` tool uses, so a session
 * started from the panel behaves exactly like one started by the agent.
 */
import type { SerialManager } from "../serial-manager.js";
import { DutManager } from "../dut/manager.js";
import { allProfiles, getProfile } from "../dut/profiles/index.js";
import type { BaudRate, DataBits, Parity, SerialConfig, StopBits } from "../types.js";
import type { DutRunResult } from "../dut/types.js";
import type { DutEvent, DutProfileSummary, DutSmokeResult, DutStatus, HubDut } from "./backend.js";

/**
 * The port settings `dut_connect` uses: profile baud, decoded text, raw framing.
 *
 * `encoding` used to be "hex", which made `SerialMessage.data` a hex STRING
 * identical to `raw`. Every consumer that wanted text (the console's ASCII
 * column, `serial_read`, `serial_extract`) then saw hex twice. The DUT engine
 * itself reads raw bytes through a data hook, so it is unaffected by this.
 */
export function dutSerialConfig(
  path: string,
  profileName: string,
  baudRate?: number
): SerialConfig {
  const profile = getProfile(profileName);
  return {
    path,
    baudRate: (baudRate ?? profile.serial.baudRate) as BaudRate,
    dataBits: (profile.serial.dataBits ?? 8) as DataBits,
    stopBits: (profile.serial.stopBits ?? 1) as StopBits,
    parity: (profile.serial.parity ?? "none") as Parity,
    flowControl: "none",
    encoding: "utf8",
    protocol: "raw",
    bufferSize: 4000,
    autoReconnect: false,
    dtr: true,
    rts: true,
  };
}

export function createDutBackend(dut: DutManager, manager: SerialManager): HubDut {
  /** One long-running run at a time: the serial line is single-owner. */
  let busy: null | "smoke" = null;

  function pickConnection(preferred?: string | null): string | null {
    if (preferred && dut.hasSession(preferred)) return preferred;
    const sessions = dut.listSessions();
    return sessions.length > 0 ? sessions[0].connectionId : null;
  }

  function status(preferred?: string | null): DutStatus {
    const connectionId = pickConnection(preferred);
    if (connectionId === null) {
      return { connected: false, connectionId: null, profile: null, chip: null, port: null, baudRate: null, stats: null };
    }
    const session = dut.getSession(connectionId);
    let port: string | null = null;
    let baudRate: number | null = null;
    try {
      const info = manager.getInfo(connectionId);
      port = info.config.path;
      baudRate = info.config.baudRate;
    } catch {
      /* connection gone but session not cleaned up yet — keep the DUT view usable */
    }
    return {
      connected: true,
      connectionId,
      profile: session.profile.name,
      chip: session.profile.chip,
      port,
      baudRate,
      stats: { ...session.stats },
    };
  }

  function requireConnection(preferred?: string | null): string {
    const connectionId = pickConnection(preferred);
    if (connectionId === null) throw new Error("No DUT session. Pick a profile and connect first.");
    return connectionId;
  }

  return {
    busy: () => busy !== null,

    profiles(): DutProfileSummary[] {
      return allProfiles().map((profile) => ({
        name: profile.name,
        chip: profile.chip,
        description: profile.description,
        serial: {
          baudRate: profile.serial.baudRate,
          dataBits: profile.serial.dataBits,
          stopBits: profile.serial.stopBits,
          parity: profile.serial.parity,
          wiring: profile.serial.wiring,
        },
        frame: { ...profile.frame },
        commands: profile.commands.map((command) => ({
          name: command.name,
          title: command.title,
          fpgaSuitable: command.fpgaSuitable ?? false,
          note: command.note,
        })),
        smoke: [...(profile.smoke ?? [])],
        lowPower: [...(profile.lowPower ?? [])],
      }));
    },

    status,

    async connect(options) {
      const connectionId = options.connectionId ?? null;
      if (connectionId !== null) {
        // Attach to a port that is already open (MCP opened it, or the panel did).
        if (!dut.hasSession(connectionId)) dut.attach(connectionId, options.profile);
        return { connectionId, opened: false, status: status(connectionId) };
      }
      if (!options.path) throw new Error("path is required to open a DUT port");
      const config = dutSerialConfig(options.path, options.profile, options.baudRate);
      const opened = await manager.open(config);
      try {
        dut.attach(opened.connectionId, options.profile);
      } catch (error) {
        await manager.close(opened.connectionId).catch(() => undefined);
        throw error;
      }
      return { connectionId: opened.connectionId, opened: true, status: status(opened.connectionId) };
    },

    async disconnect(options = {}) {
      const connectionId = pickConnection(options.connectionId);
      if (connectionId === null) return;
      if (dut.hasSession(connectionId)) dut.detach(connectionId);
      if (options.closePort === true) await manager.close(connectionId);
    },

    async runCommand(name, connectionId) {
      if (busy !== null) throw new Error("A smoke run is already in progress.");
      return dut.runCommand(requireConnection(connectionId), name);
    },

    async runSmoke(options, onEvent?: (event: DutEvent) => void): Promise<DutSmokeResult> {
      const connectionId = requireConnection(options.connectionId);
      if (busy !== null) throw new Error("A smoke run is already in progress.");
      busy = "smoke";
      const started = Date.now();
      try {
        const result = await dut.runSmoke(connectionId, options.includeLowPower === true, {
          onStart: (total, profile) => onEvent?.({ kind: "smoke-start", profile, total }),
          onStep: (step, index, total) => onEvent?.({ kind: "smoke-step", index, total, step }),
        });
        const summary = {
          profile: result.profile,
          passed: result.passed,
          failed: result.failed,
          report: result.report,
          allPassed: result.allPassed,
          elapsedMs: Date.now() - started,
        };
        onEvent?.({ kind: "smoke-done", summary });
        return { ...summary, steps: result.steps };
      } finally {
        busy = null;
      }
    },
  };
}
