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
const browserDefaultSampleLimit = 50;

const browserTableSampleLimits: Record<string, number> = {
  saveinfo: 5,
  promotions: 500,
  contracts: 6000,
  workers: 4000,
  brands: 500,
  titles: 1000,
  titlehistory: 15000,
  events: 2000,
  eventinstance: 6000,
  segments: 25000,
  opponents: 30000,
  matchtitles: 10000,
  storylines: 3000,
  storylineworkers: 6000,
  storylinehistories: 8000,
  tagteams: 3000,
  promotiontagteams: 3000,
  stables: 1000,
  stableworkers: 3000,
};

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
  const pwsSchema = ["saveinfo", "promotions", "contracts", "workers", "events", "eventinstance", "segments", "opponents"].every((name) =>
    tableNames.some((tableName) => tableName.toLowerCase() === name),
  );

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
    const sampleRows = pwsSchema
      ? pwsSampleRows(database, tableName, columns)
      : defaultSampleRows(database, tableName, columns);

    return {
      name: tableName,
      columns,
      rowCount,
      sampleRows,
    };
  });
}

function defaultSampleRows(database: import("sql.js").Database, tableName: string, columns: ColumnInfo[]): Record<string, unknown>[] {
  const escapedName = escapeIdentifier(tableName);
  const primaryKey = columns.find((column) => column.primaryKey)?.name;
  const orderClause = primaryKey ? ` ORDER BY "${primaryKey.replace(/"/g, '""')}" DESC` : "";
  const sampleLimit = sampleLimitForTable(tableName);
  return rowsFromExec(database.exec(`SELECT * FROM ${escapedName}${orderClause} LIMIT ${sampleLimit}`));
}

function pwsSampleRows(database: import("sql.js").Database, tableName: string, columns: ColumnInfo[]): Record<string, unknown>[] {
  const normalized = tableName.toLowerCase();
  const userPromotionSql = "(SELECT saveUserPromotion FROM saveinfo LIMIT 1)";
  const recentInstancesSql = `
    SELECT i.instanceID
    FROM eventinstance i
    JOIN events e ON e.eventID = i.eventID
    WHERE e.promotionID = ${userPromotionSql} AND i.complete = 1
    ORDER BY i.airDate DESC, i.instanceID DESC
    LIMIT 120
  `;
  const recentSegmentsSql = `
    SELECT s.segmentID
    FROM segments s
    WHERE s.showID IN (${recentInstancesSql})
  `;

  try {
    if (normalized === "saveinfo") return rowsFromExec(database.exec("SELECT * FROM saveinfo LIMIT 1"));
    if (normalized === "promotions") return rowsFromExec(database.exec(`SELECT * FROM promotions WHERE promotionID = ${userPromotionSql} OR shortName IS NOT NULL ORDER BY promotionID LIMIT 500`));
    if (normalized === "contracts") {
      return rowsFromExec(database.exec(`
        SELECT * FROM contracts
        WHERE promotionID = ${userPromotionSql}
          AND finalised = 1
          AND expired = 0
          AND suspended = 0
        ORDER BY contractID DESC
        LIMIT 300
      `));
    }
    if (normalized === "workers") {
      return rowsFromExec(database.exec(`
        SELECT * FROM workers
        WHERE workerID IN (
          SELECT workerID FROM contracts WHERE promotionID = ${userPromotionSql}
          UNION SELECT currentChampion FROM titles WHERE promotionID = ${userPromotionSql} AND currentChampion IS NOT NULL
          UNION SELECT currentChampion2 FROM titles WHERE promotionID = ${userPromotionSql} AND currentChampion2 IS NOT NULL AND currentChampion2 != ''
          UNION SELECT currentChampion3 FROM titles WHERE promotionID = ${userPromotionSql} AND currentChampion3 IS NOT NULL AND currentChampion3 != ''
          UNION SELECT workerID FROM opponents WHERE segmentID IN (${recentSegmentsSql})
        )
        LIMIT 1500
      `));
    }
    if (normalized === "events") return rowsFromExec(database.exec(`SELECT * FROM events WHERE promotionID = ${userPromotionSql} ORDER BY eventID DESC LIMIT 500`));
    if (normalized === "eventinstance") {
      return rowsFromExec(database.exec(`
        SELECT i.* FROM eventinstance i
        JOIN events e ON e.eventID = i.eventID
        WHERE e.promotionID = ${userPromotionSql} AND i.complete = 1
        ORDER BY i.airDate DESC, i.instanceID DESC
        LIMIT 120
      `));
    }
    if (normalized === "segments") {
      return rowsFromExec(database.exec(`
        SELECT * FROM segments
        WHERE showID IN (${recentInstancesSql})
        ORDER BY showID DESC, segmentorder ASC
        LIMIT 2500
      `));
    }
    if (normalized === "opponents") {
      return rowsFromExec(database.exec(`
        SELECT * FROM opponents
        WHERE segmentID IN (${recentSegmentsSql})
        LIMIT 8000
      `));
    }
    if (normalized === "titles") return rowsFromExec(database.exec(`SELECT * FROM titles WHERE promotionID = ${userPromotionSql} LIMIT 200`));
    if (normalized === "titlehistory") return rowsFromExec(database.exec(`SELECT * FROM titlehistory WHERE titleID IN (SELECT titleID FROM titles WHERE promotionID = ${userPromotionSql}) ORDER BY titleHistoryID DESC LIMIT 1000`));
    if (normalized === "brands") return rowsFromExec(database.exec(`SELECT * FROM brands WHERE promotionID = ${userPromotionSql} LIMIT 100`));
    if (normalized === "matchtitles") return rowsFromExec(database.exec(`SELECT * FROM matchtitles WHERE segmentID IN (${recentSegmentsSql}) LIMIT 1000`));
    if (normalized === "storylines") return rowsFromExec(database.exec(`SELECT * FROM storylines WHERE promotionID = ${userPromotionSql} ORDER BY storylineID DESC LIMIT 500`));
    if (normalized === "storylineworkers") return rowsFromExec(database.exec("SELECT * FROM storylineworkers ORDER BY storylineWorkerID DESC LIMIT 1000"));
    if (normalized === "storylinehistories") return rowsFromExec(database.exec("SELECT * FROM storylinehistories ORDER BY historyID DESC LIMIT 1000"));
    if (normalized === "tagteams") return rowsFromExec(database.exec("SELECT * FROM tagteams ORDER BY tagID DESC LIMIT 1000"));
    if (normalized === "promotiontagteams") return rowsFromExec(database.exec(`SELECT * FROM promotiontagteams WHERE promotionID = ${userPromotionSql} LIMIT 1000`));
    if (normalized === "stables") return rowsFromExec(database.exec(`SELECT * FROM stables WHERE promotionID = ${userPromotionSql} LIMIT 500`));
    if (normalized === "stableworkers") return rowsFromExec(database.exec("SELECT * FROM stableworkers ORDER BY stableWorkerID DESC LIMIT 1000"));
  } catch (error) {
    console.warn(`PWS targeted sample failed for ${tableName}`, error);
  }

  return rowsFromExec(database.exec(`SELECT * FROM ${escapeIdentifier(tableName)} LIMIT ${browserDefaultSampleLimit}`));
}

function rowsFromExec(result: Array<{ columns: string[]; values: unknown[][] }>): Record<string, unknown>[] {
  return (
    result[0]?.values.map((row: unknown[]) =>
      Object.fromEntries(result[0].columns.map((column: string, index: number) => [column, row[index]])),
    ) ?? []
  );
}

function sampleLimitForTable(tableName: string): number {
  return browserTableSampleLimits[tableName.toLowerCase()] ?? browserDefaultSampleLimit;
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
