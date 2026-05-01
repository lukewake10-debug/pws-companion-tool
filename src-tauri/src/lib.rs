use chrono::{DateTime, Local, Utc};
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use std::{
    collections::HashSet,
    fs,
    io::Read,
    path::{Path, PathBuf},
    time::SystemTime,
};
use walkdir::WalkDir;

const SQLITE_HEADER: &[u8] = b"SQLite format 3\0";
const APP_DIR_NAME: &str = "pws-save-auditor";

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct SaveCandidate {
    file_name: String,
    full_path: String,
    last_modified: Option<String>,
    file_size: u64,
    detected_by: Vec<String>,
    readable: bool,
    warning: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct SnapshotMetadata {
    id: String,
    imported_date: String,
    source_file_name: String,
    source_path: String,
    file_size: u64,
    source_last_modified: Option<String>,
    snapshot_path: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct DatabaseInspection {
    path: String,
    tables: Vec<TableInfo>,
    likely_mappings: LikelyMappings,
    warnings: Vec<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct TableInfo {
    name: String,
    columns: Vec<ColumnInfo>,
    row_count: Option<i64>,
    sample_rows: Vec<serde_json::Value>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ColumnInfo {
    name: String,
    data_type: String,
    not_null: bool,
    primary_key: bool,
}

#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
struct LikelyMappings {
    workers_table: Option<String>,
    companies_table: Option<String>,
    contracts_table: Option<String>,
    brands_or_shows_table: Option<String>,
    titles_table: Option<String>,
    events_table: Option<String>,
    matches_table: Option<String>,
    segments_table: Option<String>,
    storylines_table: Option<String>,
    tag_teams_table: Option<String>,
    stables_or_factions_table: Option<String>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct AppConfig {
    selected_save_path: Option<String>,
    selected_promotion: Option<String>,
    ignored_workers: Vec<String>,
}

#[tauri::command]
fn scan_pws_saves() -> Result<Vec<SaveCandidate>, String> {
    let roots = steam_deck_search_roots();
    let mut candidates = Vec::new();
    let mut seen = HashSet::new();

    for root in roots {
        if !root.exists() {
            continue;
        }

        for entry in WalkDir::new(root)
            .follow_links(false)
            .max_depth(9)
            .into_iter()
            .filter_map(Result::ok)
            .filter(|entry| entry.file_type().is_file())
        {
            let path = entry.path();
            let mut detected_by = Vec::new();

            if has_save_extension(path) {
                detected_by.push("extension".to_string());
            }

            if has_sqlite_header(path) {
                detected_by.push("sqlite_header".to_string());
            }

            if detected_by.is_empty() {
                continue;
            }

            let path_key = path.to_string_lossy().to_string();
            if !seen.insert(path_key) {
                continue;
            }

            candidates.push(candidate_from_path(path, detected_by));
        }
    }

    candidates.sort_by(|a, b| b.last_modified.cmp(&a.last_modified));
    Ok(candidates)
}

#[tauri::command]
fn create_snapshot(source_path: String) -> Result<SnapshotMetadata, String> {
    let source = PathBuf::from(&source_path);
    if !source.exists() {
        return Err("Selected save file no longer exists.".to_string());
    }
    if !source.is_file() {
        return Err("Selected path is not a save file.".to_string());
    }

    let metadata = fs::metadata(&source)
        .map_err(|error| format!("Save file unreadable: {error}"))?;

    let snapshot_dir = app_data_dir()?.join("snapshots");
    fs::create_dir_all(&snapshot_dir)
        .map_err(|error| format!("Snapshot folder could not be created: {error}"))?;

    let imported = Utc::now();
    let source_file_name = source
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("pws-save")
        .to_string();
    let safe_name = sanitize_file_name(&source_file_name);
    let extension = source
        .extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| format!(".{ext}"))
        .unwrap_or_else(|| ".db".to_string());
    let id = imported.format("%Y%m%d-%H%M%S").to_string();
    let snapshot_path = snapshot_dir.join(format!("{safe_name}-{id}{extension}"));

    fs::copy(&source, &snapshot_path)
        .map_err(|error| format!("Snapshot copy failed. Save and close PWS, then try again. Details: {error}"))?;

    let snapshot_metadata = SnapshotMetadata {
        id,
        imported_date: imported.to_rfc3339(),
        source_file_name,
        source_path,
        file_size: metadata.len(),
        source_last_modified: metadata.modified().ok().map(system_time_to_rfc3339),
        snapshot_path: snapshot_path.to_string_lossy().to_string(),
    };

    let metadata_dir = snapshot_dir.join("metadata");
    fs::create_dir_all(&metadata_dir)
        .map_err(|error| format!("Snapshot metadata folder could not be created: {error}"))?;
    let metadata_path = metadata_dir.join(format!("{}.json", snapshot_metadata.id));
    let metadata_json = serde_json::to_string_pretty(&snapshot_metadata)
        .map_err(|error| format!("Snapshot metadata could not be saved: {error}"))?;
    fs::write(metadata_path, metadata_json)
        .map_err(|error| format!("Snapshot metadata could not be written: {error}"))?;

    Ok(snapshot_metadata)
}

#[tauri::command]
fn inspect_sqlite_database(snapshot_path: String) -> Result<DatabaseInspection, String> {
    let path = PathBuf::from(&snapshot_path);
    if !path.exists() {
        return Err("Snapshot file was not found.".to_string());
    }
    if !has_sqlite_header(&path) {
        return Err("The selected snapshot does not appear to be a SQLite database.".to_string());
    }

    let connection = Connection::open_with_flags(
        &path,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_URI,
    )
    .map_err(|error| format!("Database not recognised or unreadable: {error}"))?;

    let mut table_stmt = connection
        .prepare(
            "SELECT name FROM sqlite_master \
             WHERE type = 'table' AND name NOT LIKE 'sqlite_%' \
             ORDER BY name",
        )
        .map_err(|error| format!("Could not inspect database tables: {error}"))?;

    let table_names = table_stmt
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(|error| format!("Could not list database tables: {error}"))?
        .filter_map(Result::ok)
        .collect::<Vec<_>>();

    let mut tables = Vec::new();
    for table_name in table_names {
        tables.push(inspect_table(&connection, &table_name)?);
    }

    let likely_mappings = infer_likely_mappings(&tables);
    let mut warnings = Vec::new();
    if likely_mappings.workers_table.is_none() {
        warnings.push("No worker table detected. Mapping is required.".to_string());
    }
    if likely_mappings.companies_table.is_none() {
        warnings.push("No company or promotion table detected. Mapping is required.".to_string());
    }
    if likely_mappings.matches_table.is_none() {
        warnings.push("No match table detected. Ratings analytics will need mapping.".to_string());
    }

    Ok(DatabaseInspection {
        path: snapshot_path,
        tables,
        likely_mappings,
        warnings,
    })
}

#[tauri::command]
fn read_app_config() -> Result<AppConfig, String> {
    let path = config_path()?;
    if !path.exists() {
        return Ok(AppConfig {
            selected_save_path: None,
            selected_promotion: None,
            ignored_workers: Vec::new(),
        });
    }

    let content = fs::read_to_string(path)
        .map_err(|error| format!("Could not read local app settings: {error}"))?;
    serde_json::from_str(&content)
        .map_err(|error| format!("Could not parse local app settings: {error}"))
}

#[tauri::command]
fn save_app_config(config: AppConfig) -> Result<(), String> {
    let path = config_path()?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("Could not create local settings folder: {error}"))?;
    }
    let content = serde_json::to_string_pretty(&config)
        .map_err(|error| format!("Could not serialize local settings: {error}"))?;
    fs::write(path, content)
        .map_err(|error| format!("Could not save local settings: {error}"))
}

fn inspect_table(connection: &Connection, table_name: &str) -> Result<TableInfo, String> {
    let escaped_name = escape_identifier(table_name);
    let mut columns_stmt = connection
        .prepare(&format!("PRAGMA table_info({escaped_name})"))
        .map_err(|error| format!("Could not inspect columns for {table_name}: {error}"))?;

    let columns = columns_stmt
        .query_map([], |row| {
            Ok(ColumnInfo {
                name: row.get::<_, String>(1)?,
                data_type: row.get::<_, String>(2)?,
                not_null: row.get::<_, i64>(3)? == 1,
                primary_key: row.get::<_, i64>(5)? == 1,
            })
        })
        .map_err(|error| format!("Could not read columns for {table_name}: {error}"))?
        .filter_map(Result::ok)
        .collect::<Vec<_>>();

    let row_count = connection
        .query_row(&format!("SELECT COUNT(*) FROM {escaped_name}"), [], |row| row.get(0))
        .ok();
    let sample_rows = sample_rows(connection, table_name, &columns)?;

    Ok(TableInfo {
        name: table_name.to_string(),
        columns,
        row_count,
        sample_rows,
    })
}

fn sample_rows(
    connection: &Connection,
    table_name: &str,
    columns: &[ColumnInfo],
) -> Result<Vec<serde_json::Value>, String> {
    if columns.is_empty() {
        return Ok(Vec::new());
    }

    let escaped_name = escape_identifier(table_name);
    let mut stmt = connection
        .prepare(&format!("SELECT * FROM {escaped_name} LIMIT 3"))
        .map_err(|error| format!("Could not sample {table_name}: {error}"))?;
    let column_names = columns
        .iter()
        .map(|column| column.name.clone())
        .collect::<Vec<_>>();

    let rows = stmt
        .query_map([], |row| {
            let mut map = serde_json::Map::new();
            for (index, name) in column_names.iter().enumerate() {
                let value = row
                    .get_ref(index)
                    .map(sql_value_to_json)
                    .unwrap_or(serde_json::Value::Null);
                map.insert(name.clone(), value);
            }
            Ok(serde_json::Value::Object(map))
        })
        .map_err(|error| format!("Could not read samples from {table_name}: {error}"))?
        .filter_map(Result::ok)
        .collect();

    Ok(rows)
}

fn sql_value_to_json(value: rusqlite::types::ValueRef<'_>) -> serde_json::Value {
    match value {
        rusqlite::types::ValueRef::Null => serde_json::Value::Null,
        rusqlite::types::ValueRef::Integer(value) => serde_json::Value::Number(value.into()),
        rusqlite::types::ValueRef::Real(value) => serde_json::Number::from_f64(value)
            .map(serde_json::Value::Number)
            .unwrap_or(serde_json::Value::Null),
        rusqlite::types::ValueRef::Text(value) => {
            serde_json::Value::String(String::from_utf8_lossy(value).to_string())
        }
        rusqlite::types::ValueRef::Blob(value) => {
            serde_json::Value::String(format!("<{} bytes>", value.len()))
        }
    }
}

fn infer_likely_mappings(tables: &[TableInfo]) -> LikelyMappings {
    LikelyMappings {
        workers_table: find_table(tables, &["worker", "wrestler", "talent", "person"]),
        companies_table: find_table(tables, &["company", "promotion", "fed"]),
        contracts_table: find_table(tables, &["contract"]),
        brands_or_shows_table: find_table(tables, &["brand", "show"]),
        titles_table: find_table(tables, &["title", "championship"]),
        events_table: find_table(tables, &["event", "show"]),
        matches_table: find_table(tables, &["match", "bout"]),
        segments_table: find_table(tables, &["segment", "angle"]),
        storylines_table: find_table(tables, &["storyline", "feud"]),
        tag_teams_table: find_table(tables, &["tag", "team"]),
        stables_or_factions_table: find_table(tables, &["stable", "faction"]),
    }
}

fn find_table(tables: &[TableInfo], keywords: &[&str]) -> Option<String> {
    tables
        .iter()
        .find(|table| {
            let table_name = table.name.to_lowercase();
            let column_blob = table
                .columns
                .iter()
                .map(|column| column.name.to_lowercase())
                .collect::<Vec<_>>()
                .join(" ");

            keywords
                .iter()
                .any(|keyword| table_name.contains(keyword) || column_blob.contains(keyword))
        })
        .map(|table| table.name.clone())
}

fn steam_deck_search_roots() -> Vec<PathBuf> {
    let mut roots = Vec::new();
    if let Some(home) = dirs::home_dir() {
        roots.push(home.join(".local/share/Steam/steamapps/compatdata/1157700"));
        roots.push(home.join(".steam/steam/steamapps/compatdata/1157700"));
        roots.push(home.join(".local/share/Steam/userdata"));
        roots.push(home.join(".steam/steam/userdata"));
        roots.push(home.join(".local/share/Steam/steamapps/compatdata/1157700/pfx/drive_c/users/steamuser/AppData/Roaming/ProWrestlingSimulator/saves"));
        roots.push(home.join(".steam/steam/steamapps/compatdata/1157700/pfx/drive_c/users/steamuser/AppData/Roaming/ProWrestlingSimulator/saves"));
    }
    roots
}

fn candidate_from_path(path: &Path, detected_by: Vec<String>) -> SaveCandidate {
    let metadata = fs::metadata(path);
    let readable = fs::File::open(path).is_ok();
    let warning = if readable {
        None
    } else {
        Some("Save file appears locked or unreadable. Save and close PWS before refreshing.".to_string())
    };

    SaveCandidate {
        file_name: path
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("Unknown save")
            .to_string(),
        full_path: path.to_string_lossy().to_string(),
        last_modified: metadata
            .as_ref()
            .ok()
            .and_then(|metadata| metadata.modified().ok())
            .map(system_time_to_rfc3339),
        file_size: metadata.map(|metadata| metadata.len()).unwrap_or(0),
        detected_by,
        readable,
        warning,
    }
}

fn has_save_extension(path: &Path) -> bool {
    path.extension()
        .and_then(|extension| extension.to_str())
        .map(|extension| matches!(extension.to_lowercase().as_str(), "db" | "sqlite" | "save"))
        .unwrap_or(false)
}

fn has_sqlite_header(path: &Path) -> bool {
    let mut file = match fs::File::open(path) {
        Ok(file) => file,
        Err(_) => return false,
    };
    let mut header = [0_u8; 16];
    file.read_exact(&mut header).is_ok() && header == SQLITE_HEADER
}

fn system_time_to_rfc3339(time: SystemTime) -> String {
    let date_time: DateTime<Local> = time.into();
    date_time.to_rfc3339()
}

fn app_data_dir() -> Result<PathBuf, String> {
    dirs::data_local_dir()
        .or_else(dirs::data_dir)
        .map(|dir| dir.join(APP_DIR_NAME))
        .ok_or_else(|| "Could not locate local app data folder.".to_string())
}

fn config_path() -> Result<PathBuf, String> {
    Ok(app_data_dir()?.join("config.json"))
}

fn sanitize_file_name(value: &str) -> String {
    value
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || matches!(character, '-' | '_' | '.') {
                character
            } else {
                '-'
            }
        })
        .collect()
}

fn escape_identifier(identifier: &str) -> String {
    format!("\"{}\"", identifier.replace('"', "\"\""))
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .invoke_handler(tauri::generate_handler![
            scan_pws_saves,
            create_snapshot,
            inspect_sqlite_database,
            read_app_config,
            save_app_config
        ])
        .run(tauri::generate_context!())
        .expect("error while running PWS Save Auditor");
}
