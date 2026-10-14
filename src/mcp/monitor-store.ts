import {
  addMonitor,
  deleteMonitor,
  getMonitor,
  loadMonitors,
  updateMonitorSnapshots,
  updateMonitorSeenIds,
} from "../storage/monitors.js";
import type { MonitorStore } from "./types.js";

export const localMonitorStore: MonitorStore = {
  add: addMonitor,
  list: loadMonitors,
  get: getMonitor,
  updateSeenIds: updateMonitorSeenIds,
  updateSnapshots: updateMonitorSnapshots,
  delete: deleteMonitor,
};
