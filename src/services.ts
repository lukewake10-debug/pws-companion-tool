import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { demoInspection, demoSave, demoSnapshot } from "./data";
import type {
  AppConfig,
  DatabaseInspection,
  SaveCandidate,
  SnapshotMetadata,
} from "./types";

const configKey = "pws-save-auditor-config";

const isTauri = () => typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

const defaultConfig: AppConfig = {
  selectedSavePath: null,
  selectedPromotion: null,
  ignoredWorkers: [],
};

export async function scanPwsSaves(): Promise<SaveCandidate[]> {
  if (!isTauri()) {
    return [demoSave];
  }
  return invoke<SaveCandidate[]>("scan_pws_saves");
}

export async function browseForSave(): Promise<string | null> {
  if (!isTauri()) {
    return demoSave.fullPath;
  }

  const selection = await open({
    multiple: false,
    directory: false,
    title: "Select a PWS save file",
    filters: [
      {
        name: "PWS save or SQLite database",
        extensions: ["db", "sqlite", "save"],
      },
      {
        name: "All files",
        extensions: ["*"],
      },
    ],
  });

  return typeof selection === "string" ? selection : null;
}

export async function createSnapshot(sourcePath: string): Promise<SnapshotMetadata> {
  if (!isTauri()) {
    return {
      ...demoSnapshot,
      sourcePath,
      sourceFileName: sourcePath.split(/[\\/]/).pop() || "selected-save.db",
    };
  }
  return invoke<SnapshotMetadata>("create_snapshot", { sourcePath });
}

export async function inspectSqliteDatabase(snapshotPath: string): Promise<DatabaseInspection> {
  if (!isTauri()) {
    return { ...demoInspection, path: snapshotPath };
  }
  return invoke<DatabaseInspection>("inspect_sqlite_database", { snapshotPath });
}

export async function readAppConfig(): Promise<AppConfig> {
  if (!isTauri()) {
    const saved = localStorage.getItem(configKey);
    return saved ? JSON.parse(saved) : defaultConfig;
  }
  return invoke<AppConfig>("read_app_config");
}

export async function saveAppConfig(config: AppConfig): Promise<void> {
  if (!isTauri()) {
    localStorage.setItem(configKey, JSON.stringify(config));
    return;
  }
  await invoke("save_app_config", { config });
}

export function formatBytes(bytes: number): string {
  if (bytes === 0) {
    return "0 B";
  }
  const units = ["B", "KB", "MB", "GB"];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / 1024 ** index).toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
}

export function formatDate(value: string | null): string {
  if (!value) {
    return "Unknown";
  }
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}
