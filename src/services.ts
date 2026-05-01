import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import initSqlJs from "sql.js/dist/sql-asm.js";
import { demoInspection, demoSnapshot } from "./data";
import type {
  AppConfig,
  ColumnInfo,
  DatabaseInspection,
  SaveCandidate,
  SnapshotMetadata,
  TableInfo,
} from "./types";

const configKey = "pws-save-auditor-config";
const browserSampleLimit = 2000;

export const isTauri = () => typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

const defaultConfig: AppConfig = {
  selectedSavePath: null,
  selectedPromotion: null,
  ignoredWorkers: [],
};

export async function scanPwsSaves(): Promise<SaveCandidate[]> {
  if (!isTauri()) {
    return [];
  }
  return invoke<SaveCandidate[]>("scan_pws_saves");
}

export async function browseForSave(): Promise<string | null> {
  if (!isTauri()) {
    return null;
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

export async function inspectBrowserSaveFile(file: File): Promise<{
  save: SaveCandidate;
  snapshot: SnapshotMetadata;
  inspection: DatabaseInspection;
}> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (!hasSqliteHeader(bytes)) {
    throw new Error("Selected file does not appear to be a SQLite database.");
  }

  const SQL = await initSqlJs();
  const database = new SQL.Database(bytes);

  try {
    const tables = inspectBrowserTables(database);
    const inspection: DatabaseInspection = {
      path: `browser-local://${file.name}`,
      tables,
      likelyMappings: inferLikelyMappings(tables),
      warnings: [],
    };

    if (!inspection.likelyMappings.workersTable) {
      inspection.warnings.push("No worker table detected. Mapping is required.");
    }
    if (!inspection.likelyMappings.companiesTable) {
      inspection.warnings.push("No company or promotion table detected. Mapping is required.");
    }
    if (!inspection.likelyMappings.matchesTable) {
      inspection.warnings.push("No match table detected. Ratings analytics will need mapping.");
    }

    const now = new Date().toISOString();
    const save: SaveCandidate = {
      fileName: file.name,
      fullPath: `Browser import: ${file.name}`,
      lastModified: file.lastModified ? new Date(file.lastModified).toISOString() : null,
      fileSize: file.size,
      detectedBy: ["browser_file_picker", "sqlite_header"],
      readable: true,
      warning: null,
    };
    const snapshot: SnapshotMetadata = {
      id: `browser-${Date.now()}`,
      importedDate: now,
      sourceFileName: file.name,
      sourcePath: save.fullPath,
      fileSize: file.size,
      sourceLastModified: save.lastModified,
      snapshotPath: inspection.path,
    };

    return { save, snapshot, inspection };
  } finally {
    database.close();
  }
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

function hasSqliteHeader(bytes: Uint8Array): boolean {
  const header = "SQLite format 3\u0000";
  if (bytes.length < header.length) {
    return false;
  }
  return [...header].every((character, index) => bytes[index] === character.charCodeAt(0));
}

function inspectBrowserTables(database: import("sql.js").Database): TableInfo[] {
  const result = database.exec(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
  );
  const tableNames = result[0]?.values.map((row) => String(row[0])) ?? [];

  return tableNames.map((tableName) => {
    const escapedName = escapeIdentifier(tableName);
    const pragma = database.exec(`PRAGMA table_info(${escapedName})`);
    const columns: ColumnInfo[] =
      pragma[0]?.values.map((row) => ({
        name: String(row[1]),
        dataType: String(row[2] ?? ""),
        notNull: Number(row[3]) === 1,
        primaryKey: Number(row[5]) === 1,
      })) ?? [];

    const rowCountResult = database.exec(`SELECT COUNT(*) AS count FROM ${escapedName}`);
    const rowCount = Number(rowCountResult[0]?.values[0]?.[0] ?? 0);
    const sampleResult = database.exec(`SELECT * FROM ${escapedName} LIMIT ${browserSampleLimit}`);
    const sampleRows =
      sampleResult[0]?.values.map((row) =>
        Object.fromEntries(sampleResult[0].columns.map((column, index) => [column, row[index]])),
      ) ?? [];

    return {
      name: tableName,
      columns,
      rowCount,
      sampleRows,
    };
  });
}

function inferLikelyMappings(tables: TableInfo[]): DatabaseInspection["likelyMappings"] {
  return {
    workersTable: findTable(tables, ["worker", "wrestler", "talent", "person"]),
    companiesTable: findTable(tables, ["company", "promotion", "fed"]),
    contractsTable: findTable(tables, ["contract"]),
    brandsOrShowsTable: findTable(tables, ["brand", "show"]),
    titlesTable: findTable(tables, ["title", "championship"]),
    eventsTable: findTable(tables, ["event", "show"]),
    matchesTable: findTable(tables, ["match", "bout"]),
    segmentsTable: findTable(tables, ["segment", "angle"]),
    storylinesTable: findTable(tables, ["storyline", "feud"]),
    tagTeamsTable: findTable(tables, ["tag", "team"]),
    stablesOrFactionsTable: findTable(tables, ["stable", "faction"]),
  };
}

function findTable(tables: TableInfo[], keywords: string[]): string | null {
  const scored = tables
    .map((table) => {
      const tableName = table.name.toLowerCase();
      const columns = table.columns.map((column) => column.name.toLowerCase()).join(" ");
      const score = keywords.reduce((total, keyword) => {
        const tableHit = tableName.includes(keyword) ? 3 : 0;
        const columnHit = columns.includes(keyword) ? 1 : 0;
        return total + tableHit + columnHit;
      }, 0);
      return { table, score };
    })
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || (b.table.rowCount ?? 0) - (a.table.rowCount ?? 0));

  return scored[0]?.table.name ?? null;
}

function escapeIdentifier(identifier: string): string {
  return `"${identifier.replace(/"/g, '""')}"`;
}
