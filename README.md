# PWS Save Auditor

PWS Save Auditor is a local-only desktop companion app for Pro Wrestling Sim players. It is designed for Steam Deck desktop mode and for large booking saves where the save file should be the source of truth.

The app is not an AI booker and does not replace the in-game booker. It imports a PWS save, copies it into a local snapshot folder, inspects the copied SQLite database, and presents booking diagnostics, roster review, Push group analysis, ratings analytics, title health, PPV build checks, and snapshot comparison surfaces.

## Current Scope

Phase 1 is scaffolded:

- Tauri 2 shell with React, TypeScript, Vite, and Tailwind CSS
- Steam Deck friendly 1280x800 dark interface
- Save Import first-launch workflow
- Automatic Steam Deck save-path scanning in the Tauri backend
- Manual browse fallback
- Read-only snapshot copying before analysis
- SQLite header detection
- SQLite table and column inspection
- Mapping screen for uncertain database structures
- Promotion selection from imported database samples
- Roster review screen with ignored-worker persistence
- Basic dashboard with save health, roster, Push, title, fatigue, morale, and rating surfaces
- Placeholder tabs for later audit engines

## Safety Model

The original PWS save is never modified.

Refresh Save copies the selected save into:

```text
~/.local/share/pws-save-auditor/snapshots/
```

The copied snapshot is then opened read-only for SQLite inspection. If the save appears unreadable or locked, the app warns the user and recommends saving and closing PWS before refreshing.

## Steam Deck Paths

The backend scans the likely PWS Steam app ID `1157700` paths:

```text
/home/deck/.local/share/Steam/steamapps/compatdata/1157700/
/home/deck/.steam/steam/steamapps/compatdata/1157700/
/home/deck/.local/share/Steam/userdata/
/home/deck/.steam/steam/userdata/
```

It also checks the likely Proton save folder:

```text
pfx/drive_c/users/steamuser/AppData/Roaming/ProWrestlingSimulator/saves
```

Files with `.db`, `.sqlite`, and `.save` extensions are considered, and files with a SQLite header are detected even when the extension is unusual.

## Development

Install frontend dependencies:

```bash
npm install
```

Run the web UI:

```bash
npm run dev
```

Build the web UI:

```bash
npm run build
```

## Browser Mode

The project also builds as a browser app for Steam Deck Gaming Mode. Browser mode cannot scan Steam folders automatically, but it can read a save file selected by the user with the file picker. SQLite inspection runs locally in the browser through `sql.js`; the save is not uploaded to a server.

The GitHub Pages workflow publishes the browser build from `dist/`.

In browser mode:

- open the app URL in the Deck browser
- choose the PWS save file manually
- inspect tables and mapping locally
- use the dashboard/planning screens alongside PWS

Automatic save discovery and snapshot copying remain desktop/Tauri features.

Run the Tauri app on a machine with Rust installed:

```bash
npm run tauri dev
```

## Steam Deck Blank Window Note

The Tauri backend sets WebKitGTK environment flags before startup to avoid a known Steam Deck desktop-mode failure mode where the app window opens but stays plain white.

## Notes

This project intentionally uses PWS terms carefully. `Push` means the official in-game card position read from the save, not a planning note. User-created fields use terms like Booking Intent, Creative Plan, Protected Booking Note, Planned Title Direction, and Creative Override Active.
