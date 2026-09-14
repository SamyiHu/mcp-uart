import type { HubBackend } from "./backend.js";
import type { SerialManager } from "../serial-manager.js";

/** Adapt SerialManager to the HubBackend interface. */
export function createSerialBackend(manager: SerialManager): HubBackend {
  return {
    listPorts: () => manager.listPorts(),
    open: (config) => manager.open(config),
    close: (id) => manager.close(id),
    write: (id, data, encoding) => manager.write(id, data, encoding),
    getInfo: (id) => manager.getInfo(id),
    listConnections: () => manager.listConnections(),
    peekMessages: (id, filter) => manager.peekMessages(id, filter),
    readFiltered: (id, filter, opts) => manager.readFiltered(id, filter, opts),
    reconfigure: (id, updates) => manager.reconfigure(id, updates),
    setSignals: (id, signals) => manager.setSignals(id, signals),
    onMessage: (id, cb) => manager.onMessage(id, cb),
  };
}
