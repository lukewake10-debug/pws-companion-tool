import {
  AlertCircle,
  CheckCircle2,
  Database,
  FileDown,
  FileUp,
  FolderSearch,
  HardDriveDownload,
  Info,
  RefreshCcw,
  ShieldCheck,
  SlidersHorizontal,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { buildSaveAnalysis } from "./analysis";
import {
  defaultPushFitSettings,
  mappingFields,
  navItems,
} from "./data";
import {
  browseForSave,
  createSnapshot,
  formatBytes,
  formatDate,
  inspectBrowserSaveFile,
  inspectSqliteDatabase,
  isTauri,
  readAppConfig,
  saveAppConfig,
  scanPwsSaves,
} from "./services";
import type {
  AppConfig,
  DatabaseInspection,
  MappingProfile,
  SaveAnalysis,
  SaveCandidate,
  SnapshotMetadata,
  TabKey,
  WorkerProfile,
} from "./types";

const appConfigFallback: AppConfig = {
  selectedSavePath: null,
  selectedPromotion: null,
  ignoredWorkers: [],
};
const mappingProfileStorageKey = "pws-save-auditor-mapping-profile";

export function App() {
  const [activeTab, setActiveTab] = useState<TabKey>("save-import");
  const [config, setConfig] = useState<AppConfig>(appConfigFallback);
  const [saves, setSaves] = useState<SaveCandidate[]>([]);
  const [selectedSave, setSelectedSave] = useState<string | null>(null);
  const [snapshots, setSnapshots] = useState<SnapshotMetadata[]>([]);
  const [inspection, setInspection] = useState<DatabaseInspection | null>(null);
  const [mappingProfile, setMappingProfile] = useState<MappingProfile>({
    id: "default",
    name: "Default PWS Mapping",
    fields: {},
    pushTierOrder: {},
  });
  const [includedWorkers, setIncludedWorkers] = useState<Record<string, boolean>>({});
  const [status, setStatus] = useState("Ready");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    readAppConfig()
      .then((loaded) => {
        setConfig(loaded);
        setSelectedSave(loaded.selectedSavePath);
        const storedMapping = window.localStorage.getItem(mappingProfileStorageKey);
        if (storedMapping) {
          setMappingProfile(JSON.parse(storedMapping));
        }
      })
      .catch((reason) => setError(String(reason)));
  }, []);

  useEffect(() => {
    const nextWorkers = rosterWorkers.map((worker) => [
      worker.id,
      !config.ignoredWorkers.includes(worker.id),
    ]);
    setIncludedWorkers(Object.fromEntries(nextWorkers));
  }, [config.ignoredWorkers, inspection]);

  const selectedPromotion = config.selectedPromotion || "ROH";
  const latestSnapshot = snapshots[0] ?? null;
  const analysis = useMemo(() => buildSaveAnalysis(inspection, selectedPromotion, config.ignoredWorkers, mappingProfile), [
    inspection,
    selectedPromotion,
    config.ignoredWorkers,
    mappingProfile,
  ]);
  const rosterWorkers = analysis.workers;
  const activeRoster = rosterWorkers.filter((worker) => includedWorkers[worker.id] !== false);
  const pushGroups = groupBy(activeRoster, (worker) => worker.push || "Unmapped");
  const promotionOptions = [...new Set([selectedPromotion, ...(analysis.promotions.length ? analysis.promotions : ["ROH", "Custom company"])])];
  const tableColumnOptions = useMemo(() => buildTableColumnOptions(inspection), [inspection]);

  useEffect(() => {
    const bestCandidate = analysis.companyCandidates[0];
    if (!inspection || !bestCandidate || bestCandidate.confidence < 50) {
      return;
    }
    const currentLooksWrong =
      !config.selectedPromotion ||
      (bestCandidate.confidence >= 80 &&
        !promotionMatchesUi(bestCandidate.name, selectedPromotion) &&
        analysis.importSummary.activeRosterCount === 0);
    if (!currentLooksWrong) {
      return;
    }
    persistConfig({ ...config, selectedPromotion: bestCandidate.name }).catch((reason) => setError(String(reason)));
  }, [inspection, analysis.companyCandidates, config]);

  async function persistConfig(nextConfig: AppConfig) {
    setConfig(nextConfig);
    await saveAppConfig(nextConfig);
  }

  async function handleScan() {
    setError(null);
    setStatus("Scanning likely Steam Deck PWS save paths...");
    try {
      const found = await scanPwsSaves();
      setSaves(found);
      setStatus(found.length ? `Found ${found.length} possible save file(s).` : "No save found.");
    } catch (reason) {
      setError(String(reason));
      setStatus("Automatic detection failed.");
    }
  }

  async function handleBrowse() {
    setError(null);
    const path = await browseForSave();
    if (!path) {
      return;
    }
    setSelectedSave(path);
    await persistConfig({ ...config, selectedSavePath: path });
    setSaves((current) =>
      current.some((save) => save.fullPath === path)
        ? current
        : [
            {
              fileName: path.split(/[\\/]/).pop() || "Selected save",
              fullPath: path,
              lastModified: null,
              fileSize: 0,
              detectedBy: ["manual_browse"],
              readable: true,
              warning: null,
            },
            ...current,
          ],
    );
    setStatus("Manual save selected. Refresh Save will analyse a copied snapshot.");
  }

  async function handleRefresh() {
    if (!selectedSave) {
      setError("Select a PWS save before refreshing.");
      return;
    }

    setError(null);
    setStatus("Copying selected save into the local snapshot folder...");
    try {
      const snapshot = await createSnapshot(selectedSave);
      setSnapshots((current) => [snapshot, ...current]);
      setStatus("Inspecting copied SQLite snapshot...");
      const inspected = await inspectSqliteDatabase(snapshot.snapshotPath);
      setInspection(inspected);
      await persistConfig({ ...config, selectedSavePath: selectedSave });
      setStatus("Snapshot imported. Original PWS save was not modified.");
      setActiveTab("dashboard");
    } catch (reason) {
      setError(String(reason));
      setStatus("Refresh failed.");
    }
  }

  async function handleBrowserFile(file: File) {
    setError(null);
    setStatus("Reading selected PWS save locally in the browser...");
    try {
      const imported = await inspectBrowserSaveFile(file);
      setSaves((current) => [
        imported.save,
        ...current.filter((save) => save.fullPath !== imported.save.fullPath),
      ]);
      setSelectedSave(imported.save.fullPath);
      setSnapshots((current) => [imported.snapshot, ...current]);
      setInspection(imported.inspection);
      await persistConfig({ ...config, selectedSavePath: imported.save.fullPath });
      setStatus("Browser import complete. The save stayed local on this device.");
      setActiveTab("dashboard");
    } catch (reason) {
      setError(String(reason));
      setStatus("Browser import failed.");
    }
  }

  async function handlePromotionChange(value: string) {
    await persistConfig({ ...config, selectedPromotion: value });
  }

  async function handleWorkerInclude(workerId: string, included: boolean) {
    const nextIncluded = { ...includedWorkers, [workerId]: included };
    setIncludedWorkers(nextIncluded);
    const ignoredWorkers = Object.entries(nextIncluded)
      .filter(([, value]) => !value)
      .map(([id]) => id);
    await persistConfig({ ...config, ignoredWorkers });
  }

  function handleMappingProfileChange(profile: MappingProfile) {
    setMappingProfile(profile);
    window.localStorage.setItem(mappingProfileStorageKey, JSON.stringify(profile));
  }

  const shellProps = {
    activeTab,
    setActiveTab,
    selectedPromotion,
    latestSnapshot,
  };

  return (
    <div className="min-h-screen bg-deck-950 text-slate-100">
      <div className="flex h-screen min-h-[720px]">
        <aside className="flex w-72 shrink-0 flex-col border-r border-white/10 bg-deck-900">
          <div className="border-b border-white/10 p-5">
            <div className="flex items-center gap-3">
              <div className="grid h-12 w-12 place-items-center rounded-md bg-roh-gold text-deck-950">
                <Database size={28} />
              </div>
              <div>
                <h1 className="text-xl font-bold tracking-normal">PWS Save Auditor</h1>
                <p className="text-sm text-slate-400">Read-only local companion</p>
              </div>
            </div>
          </div>

          <nav className="flex-1 space-y-1 overflow-y-auto p-3">
            {navItems.map((item) => {
              const Icon = item.icon;
              const active = activeTab === item.key;
              return (
                <button
                  key={item.key}
                  type="button"
                  onClick={() => setActiveTab(item.key)}
                  className={`flex h-12 w-full items-center gap-3 rounded-md px-3 text-left text-base transition ${
                    active
                      ? "bg-roh-gold text-deck-950"
                      : "text-slate-300 hover:bg-white/10 hover:text-white"
                  }`}
                >
                  <Icon size={22} />
                  <span>{item.label}</span>
                </button>
              );
            })}
          </nav>

          <div className="border-t border-white/10 p-4 text-sm text-slate-400">
            <div className="flex items-start gap-2">
              <ShieldCheck className="mt-0.5 text-roh-cyan" size={18} />
              <p>Original saves are never written to. Analysis only uses copied snapshots.</p>
            </div>
          </div>
        </aside>

        <main className="flex min-w-0 flex-1 flex-col">
          <Header {...shellProps} />
          <div className="flex-1 overflow-y-auto px-7 py-6">
            {error ? (
              <div className="mb-5 flex items-start gap-3 rounded-md border border-roh-red/50 bg-roh-red/10 p-4 text-red-100">
                <AlertCircle className="mt-0.5" />
                <div>
                  <p className="font-semibold">Action needed</p>
                  <p className="text-sm text-red-100/85">{error}</p>
                </div>
              </div>
            ) : null}

            {activeTab === "save-import" ? (
              <SaveImport
                saves={saves}
                selectedSave={selectedSave}
                setSelectedSave={setSelectedSave}
                onScan={handleScan}
                onBrowse={handleBrowse}
                onBrowserFile={handleBrowserFile}
                onRefresh={handleRefresh}
                status={status}
                inspection={inspection}
                tableColumnOptions={tableColumnOptions}
                mappingProfile={mappingProfile}
                setMappingProfile={handleMappingProfileChange}
                analysis={analysis}
                promotionOptions={promotionOptions}
                selectedPromotion={selectedPromotion}
                onPromotionChange={handlePromotionChange}
                rosterWorkers={rosterWorkers}
                includedWorkers={includedWorkers}
                onWorkerInclude={handleWorkerInclude}
              />
            ) : null}
            {activeTab === "dashboard" ? (
              <Dashboard
                selectedPromotion={selectedPromotion}
                latestSnapshot={latestSnapshot}
                activeRoster={activeRoster}
                inspection={inspection}
                analysis={analysis}
                setActiveTab={setActiveTab}
              />
            ) : null}
            {activeTab === "weekly-priorities" ? <WeeklyPriorities analysis={analysis} /> : null}
            {activeTab === "roster-audit" ? <RosterAudit workers={activeRoster} /> : null}
            {activeTab === "push-groups" ? <PushGroups pushGroups={pushGroups} /> : null}
            {activeTab === "push-mismatch" ? <PushMismatch analysis={analysis} /> : null}
            {activeTab === "ratings-analytics" ? <RatingsAnalytics analysis={analysis} /> : null}
            {activeTab === "rivalries" ? <Rivalries analysis={analysis} /> : null}
            {activeTab === "titles" ? <Titles selectedPromotion={selectedPromotion} analysis={analysis} /> : null}
            {activeTab === "booking-warnings" ? <BookingWarnings analysis={analysis} /> : null}
            {activeTab === "ppv-build-checker" ? <PpvBuildChecker /> : null}
            {activeTab === "snapshot-comparison" ? (
              <SnapshotComparison snapshots={snapshots} />
            ) : null}
            {activeTab === "settings" ? (
              <SettingsPanel
                selectedSave={selectedSave}
                selectedPromotion={selectedPromotion}
                mappingProfile={mappingProfile}
                analysis={analysis}
              />
            ) : null}
          </div>
        </main>
      </div>
    </div>
  );
}

function Header({
  activeTab,
  selectedPromotion,
  latestSnapshot,
}: {
  activeTab: TabKey;
  setActiveTab: (tab: TabKey) => void;
  selectedPromotion: string;
  latestSnapshot: SnapshotMetadata | null;
}) {
  const label = navItems.find((item) => item.key === activeTab)?.label ?? "Dashboard";
  return (
    <header className="flex h-20 items-center justify-between border-b border-white/10 bg-deck-900 px-7">
      <div>
        <h2 className="text-2xl font-bold tracking-normal">{label}</h2>
        <p className="text-sm text-slate-400">
          Selected promotion: <span className="text-slate-100">{selectedPromotion}</span>
        </p>
      </div>
      <div className="flex items-center gap-3 text-sm">
        <StatusPill label={latestSnapshot ? "Snapshot current" : "No snapshot"} tone={latestSnapshot ? "good" : "warn"} />
        <span className="rounded-md border border-white/10 bg-deck-850 px-3 py-2 text-slate-300">
          1280x800 ready
        </span>
      </div>
    </header>
  );
}

function SaveImport(props: {
  saves: SaveCandidate[];
  selectedSave: string | null;
  setSelectedSave: (path: string) => void;
  onScan: () => void;
  onBrowse: () => void;
  onBrowserFile: (file: File) => void;
  onRefresh: () => void;
  status: string;
  inspection: DatabaseInspection | null;
  tableColumnOptions: string[];
  mappingProfile: MappingProfile;
  setMappingProfile: (profile: MappingProfile) => void;
  analysis: SaveAnalysis;
  promotionOptions: string[];
  selectedPromotion: string;
  onPromotionChange: (promotion: string) => void;
  rosterWorkers: WorkerProfile[];
  includedWorkers: Record<string, boolean>;
  onWorkerInclude: (workerId: string, included: boolean) => void;
}) {
  return (
    <div className="space-y-5">
      <section className="rounded-md border border-white/10 bg-deck-900 p-5 shadow-deck">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <h3 className="text-xl font-semibold tracking-normal">Import PWS Save</h3>
            <p className="mt-1 max-w-3xl text-slate-400">
              Desktop mode can scan and snapshot saves automatically. Browser mode reads a save you choose locally on this device and does not upload it.
            </p>
          </div>
          <div className="flex flex-wrap gap-3">
            {isTauri() ? (
              <>
                <BigButton icon={FolderSearch} label="Find PWS Saves Automatically" onClick={props.onScan} />
                <BigButton icon={HardDriveDownload} label="Manual Browse" onClick={props.onBrowse} variant="secondary" />
                <BigButton icon={RefreshCcw} label="Refresh Save" onClick={props.onRefresh} variant="accent" />
              </>
            ) : (
              <label className="flex h-12 cursor-pointer items-center gap-2 rounded-md bg-roh-gold px-4 text-base font-semibold text-deck-950 transition hover:bg-[#e5c77f]">
                <FileUp size={21} />
                <span>Choose PWS Save File</span>
                <input
                  type="file"
                  accept=".db,.sqlite,.save,application/octet-stream"
                  className="hidden"
                  onChange={(event) => {
                    const file = event.target.files?.[0];
                    if (file) {
                      props.onBrowserFile(file);
                    }
                    event.currentTarget.value = "";
                  }}
                />
              </label>
            )}
          </div>
        </div>
        <div className="mt-4 rounded-md border border-roh-cyan/25 bg-roh-cyan/10 p-4 text-sm text-cyan-100">
          <div className="flex items-center gap-2">
            <Info size={18} />
            <span>{props.status}</span>
          </div>
        </div>
      </section>

      <ImportPreview
        analysis={props.analysis}
        selectedPromotion={props.selectedPromotion}
        onPromotionChange={props.onPromotionChange}
      />

      <section className="grid gap-5 xl:grid-cols-[1.2fr_0.8fr]">
        <div className="rounded-md border border-white/10 bg-deck-900 p-5">
          <h3 className="mb-4 text-lg font-semibold tracking-normal">Detected Saves</h3>
          <div className="space-y-3">
            {props.saves.length === 0 ? (
              <EmptyState text={isTauri() ? "No save files detected yet. Run automatic detection or use Manual Browse." : "Choose a PWS save file from the browser. The file is read locally and is not uploaded."} />
            ) : (
              props.saves.map((save) => (
                <button
                  key={save.fullPath}
                  type="button"
                  onClick={() => props.setSelectedSave(save.fullPath)}
                  className={`w-full rounded-md border p-4 text-left transition ${
                    props.selectedSave === save.fullPath
                      ? "border-roh-gold bg-roh-gold/10"
                      : "border-white/10 bg-deck-850 hover:border-white/25"
                  }`}
                >
                  <div className="flex items-start justify-between gap-4">
                    <div>
                      <p className="text-lg font-semibold">{save.fileName}</p>
                      <p className="mt-1 break-all text-sm text-slate-400">{save.fullPath}</p>
                    </div>
                    <StatusPill label={save.readable ? "Readable" : "Locked"} tone={save.readable ? "good" : "bad"} />
                  </div>
                  <div className="mt-3 flex flex-wrap gap-2 text-sm text-slate-300">
                    <span>{formatDate(save.lastModified)}</span>
                    <span>{formatBytes(save.fileSize)}</span>
                    <span>{save.detectedBy.join(", ")}</span>
                  </div>
                  {save.warning ? <p className="mt-2 text-sm text-red-200">{save.warning}</p> : null}
                </button>
              ))
            )}
          </div>
        </div>

        <div className="rounded-md border border-white/10 bg-deck-900 p-5">
          <h3 className="mb-4 text-lg font-semibold tracking-normal">Read-Only Safety</h3>
          <SafetyList />
        </div>
      </section>

      <MappingScreen
        inspection={props.inspection}
        tableColumnOptions={props.tableColumnOptions}
        mappingProfile={props.mappingProfile}
        setMappingProfile={props.setMappingProfile}
      />

      <PromotionAndRoster
        promotionOptions={props.promotionOptions}
        selectedPromotion={props.selectedPromotion}
        onPromotionChange={props.onPromotionChange}
        rosterWorkers={props.rosterWorkers}
        includedWorkers={props.includedWorkers}
        onWorkerInclude={props.onWorkerInclude}
      />
    </div>
  );
}

function Dashboard({
  selectedPromotion,
  latestSnapshot,
  activeRoster,
  inspection,
  analysis,
  setActiveTab,
}: {
  selectedPromotion: string;
  latestSnapshot: SnapshotMetadata | null;
  activeRoster: WorkerProfile[];
  inspection: DatabaseInspection | null;
  analysis: SaveAnalysis;
  setActiveTab: (tab: TabKey) => void;
}) {
  const warningCount = analysis.diagnostics.filter((item) => item.severity === "High" || item.severity === "Critical").length;
  const titleWarnings = analysis.titles.filter((title) => title.warningStatus !== "Low").length;
  const avgMatch = average(activeRoster.map((worker) => worker.recentMatchRatingAverage ?? 0).filter(Boolean));
  const avgSegment = average(activeRoster.map((worker) => worker.recentSegmentRatingAverage ?? 0).filter(Boolean));
  const topPriority = analysis.weeklyPriorities[0];
  const coolingRivalries = analysis.rivalries.filter((rivalry) => rivalry.status !== "Low").length;

  return (
    <div className="space-y-5">
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        <Metric label="Roster" value={`${activeRoster.length} active`} severity="Low" onClick={() => setActiveTab("roster-audit")} />
        <Metric label="Booking Warnings" value={String(warningCount)} severity={warningCount ? "High" : "Low"} onClick={() => setActiveTab("booking-warnings")} />
        <Metric label="Title Audit" value={titleWarnings ? `${titleWarnings} warnings` : `${analysis.titles.length} active`} severity={titleWarnings ? "High" : "Low"} onClick={() => setActiveTab("titles")} />
        <Metric label="Rivalries" value={coolingRivalries ? `${coolingRivalries} need work` : `${analysis.rivalries.length} tracked`} severity={coolingRivalries ? "High" : "Low"} onClick={() => setActiveTab("rivalries")} />
        <Metric label="Match Rating Avg" value={avgMatch ? String(avgMatch) : "Needs data"} severity={avgMatch ? "Low" : "Medium"} onClick={() => setActiveTab("ratings-analytics")} />
        <Metric label="Segment Rating Avg" value={avgSegment ? String(avgSegment) : "Needs data"} severity={avgSegment ? "Low" : "Medium"} onClick={() => setActiveTab("ratings-analytics")} />
        <Metric label="Snapshot" value={latestSnapshot ? formatDate(latestSnapshot.importedDate) : "None"} severity={latestSnapshot ? "Low" : "High"} onClick={() => setActiveTab("save-import")} />
        <Metric label="Top Priority" value={topPriority ? topPriority.severity : "Clear"} severity={topPriority?.severity ?? "Low"} onClick={() => setActiveTab("weekly-priorities")} />
      </div>
      {analysis.unmapped.length ? (
        <section className="rounded-md border border-roh-gold/30 bg-roh-gold/10 p-5">
          <h3 className="text-lg font-semibold tracking-normal text-amber-100">Mapping Attention</h3>
          <div className="mt-3 grid gap-2 md:grid-cols-2">
            {analysis.unmapped.map((item) => (
              <div key={item} className="rounded-md bg-deck-900/70 px-3 py-2 text-sm text-amber-100">
                {item}
              </div>
            ))}
          </div>
        </section>
      ) : null}
      <section className="rounded-md border border-white/10 bg-deck-900 p-5">
        <h3 className="mb-4 text-lg font-semibold tracking-normal">Current Champions</h3>
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {analysis.titles.length ? (
            [...analysis.titles].sort((a, b) => (b.prestige ?? 0) - (a.prestige ?? 0) || a.name.localeCompare(b.name)).slice(0, 6).map((title) => (
              <div key={title.id} className="rounded-md border border-white/10 bg-deck-850 p-4">
                <p className="font-semibold">{title.name}</p>
                <p className="mt-1 text-sm text-roh-gold">{title.champion || "Champion unmapped"}</p>
                <p className="mt-2 text-sm text-slate-400">Last defence: {title.lastDefenceDate}</p>
              </div>
            ))
          ) : (
            <EmptyState text="Map Current Title and Title Holder to populate champions exactly from the save." />
          )}
        </div>
      </section>
    </div>
  );
}

function MappingScreen({
  inspection,
  tableColumnOptions,
  mappingProfile,
  setMappingProfile,
}: {
  inspection: DatabaseInspection | null;
  tableColumnOptions: string[];
  mappingProfile: MappingProfile;
  setMappingProfile: (profile: MappingProfile) => void;
}) {
  if (!inspection) {
    return null;
  }

  return (
    <section className="rounded-md border border-white/10 bg-deck-900 p-5">
      <div className="mb-4 flex items-start justify-between gap-4">
        <div>
          <h3 className="text-lg font-semibold tracking-normal">Database Mapping</h3>
          <p className="text-sm text-slate-400">
            Confirm fields once when PWS database structure is uncertain. Unmapped fields will not block the app.
          </p>
        </div>
        <StatusPill label={`${inspection.tables.length} tables inspected`} tone="good" />
      </div>
      {inspection.warnings.length ? (
        <div className="mb-4 rounded-md border border-roh-gold/35 bg-roh-gold/10 p-3 text-sm text-amber-100">
          {inspection.warnings.join(" ")}
        </div>
      ) : null}
      <div className="mb-5 grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        {Object.entries(inspection.likelyMappings).map(([key, value]) => (
          <div key={key} className="rounded-md border border-white/10 bg-deck-850 p-3">
            <p className="text-xs uppercase text-slate-500">{splitCamel(key)}</p>
            <p className="mt-1 text-sm font-semibold">{value || "Unmapped"}</p>
          </div>
        ))}
      </div>
      <div className="mb-5 max-h-80 overflow-y-auto rounded-md border border-white/10 bg-deck-850">
        <div className="sticky top-0 grid grid-cols-[1fr_6rem_2fr] gap-3 border-b border-white/10 bg-deck-900 px-3 py-2 text-xs uppercase text-slate-500">
          <span>Table</span>
          <span>Rows</span>
          <span>Columns</span>
        </div>
        {inspection.tables.map((table) => (
          <div key={table.name} className="grid grid-cols-[1fr_6rem_2fr] gap-3 border-b border-white/5 px-3 py-2 text-sm last:border-b-0">
            <span className="font-semibold text-slate-200">{table.name}</span>
            <span className="text-slate-400">{table.rowCount ?? table.sampleRows.length}</span>
            <span className="break-words text-slate-400">{table.columns.map((column) => column.name).join(", ")}</span>
          </div>
        ))}
      </div>
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        {mappingFields.map((field) => (
          <label key={field} className="block">
            <span className="mb-1 block text-sm text-slate-300">{field}</span>
            <select
              value={mappingProfile.fields[field] || ""}
              onChange={(event) =>
                setMappingProfile({
                  ...mappingProfile,
                  fields: { ...mappingProfile.fields, [field]: event.target.value },
                })
              }
              className="h-12 w-full rounded-md border border-white/10 bg-deck-850 px-3 text-slate-100 outline-none focus:border-roh-gold"
            >
              <option value="">Unmapped</option>
              {tableColumnOptions.map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </select>
          </label>
        ))}
      </div>
    </section>
  );
}

function ImportPreview({
  analysis,
  selectedPromotion,
  onPromotionChange,
}: {
  analysis: SaveAnalysis;
  selectedPromotion: string;
  onPromotionChange: (promotion: string) => void;
}) {
  if (!analysis.tableSummary.length) {
    return null;
  }

  const summary = analysis.importSummary;
  const bannerTone = summary.confidenceLevel === "High" ? "border-emerald-400/35 bg-emerald-400/10 text-emerald-100" : summary.confidenceLevel === "Medium" ? "border-roh-gold/35 bg-roh-gold/10 text-amber-100" : "border-roh-red/40 bg-roh-red/10 text-red-100";

  return (
    <section className={`rounded-md border p-5 ${bannerTone}`}>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h3 className="text-xl font-semibold tracking-normal">
            Detected company: {summary.detectedCompany}
          </h3>
          <p className="mt-1 text-sm opacity-90">
            Imported {summary.activeRosterCount} active workers, {summary.titlesFound} titles, {summary.recentEventsFound} recent events, {summary.matchesFound} matches and {summary.segmentsFound} segments.
          </p>
        </div>
        <StatusPill label={`${summary.confidence}% confidence`} tone={summary.confidenceLevel === "High" ? "good" : summary.confidenceLevel === "Medium" ? "warn" : "bad"} />
      </div>
      {analysis.companyCandidates.length ? (
        <div className="mt-4 grid gap-3 xl:grid-cols-3">
          {analysis.companyCandidates.slice(0, 6).map((candidate) => (
            <button
              key={candidate.name}
              type="button"
              onClick={() => onPromotionChange(candidate.name)}
              className={`rounded-md border p-4 text-left transition ${
                promotionMatchesUi(candidate.name, selectedPromotion)
                  ? "border-roh-gold bg-deck-900/70"
                  : "border-white/10 bg-deck-850/80 hover:border-white/25"
              }`}
            >
              <div className="flex items-start justify-between gap-3">
                <p className="font-semibold text-slate-100">{candidate.name}</p>
                <StatusPill label={`${candidate.confidence}%`} tone={candidate.confidence >= 80 ? "good" : candidate.confidence >= 50 ? "warn" : "bad"} />
              </div>
              <div className="mt-3 grid grid-cols-3 gap-2 text-xs text-slate-300">
                <span>{candidate.activeRosterCount} workers</span>
                <span>{candidate.recentEventsCount} events</span>
                <span>{candidate.titlesCount} titles</span>
              </div>
              <p className="mt-3 text-xs text-slate-400">{candidate.reasons.join("; ")}</p>
            </button>
          ))}
        </div>
      ) : null}
      {summary.unmappedFields.length ? (
        <p className="mt-4 text-sm opacity-90">
          Mapping still needed: {summary.unmappedFields.slice(0, 3).join(" ")}
        </p>
      ) : null}
    </section>
  );
}

function PromotionAndRoster({
  promotionOptions,
  selectedPromotion,
  onPromotionChange,
  rosterWorkers,
  includedWorkers,
  onWorkerInclude,
}: {
  promotionOptions: string[];
  selectedPromotion: string;
  onPromotionChange: (promotion: string) => void;
  rosterWorkers: WorkerProfile[];
  includedWorkers: Record<string, boolean>;
  onWorkerInclude: (workerId: string, included: boolean) => void;
}) {
  return (
    <section className="rounded-md border border-white/10 bg-deck-900 p-5">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-4">
        <div>
          <h3 className="text-lg font-semibold tracking-normal">Promotion and Roster Review</h3>
          <p className="text-sm text-slate-400">
            Company names are read from the save where available. Unticked workers stay ignored in future imports.
          </p>
        </div>
        <select
          value={selectedPromotion}
          onChange={(event) => onPromotionChange(event.target.value)}
          className="h-12 min-w-48 rounded-md border border-white/10 bg-deck-850 px-3 text-slate-100 outline-none focus:border-roh-gold"
        >
          {promotionOptions.map((promotion) => (
            <option key={promotion} value={promotion}>
              {promotion}
            </option>
          ))}
        </select>
      </div>
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        {rosterWorkers.map((worker) => (
          <label key={worker.id} className="flex items-start gap-3 rounded-md border border-white/10 bg-deck-850 p-4">
            <input
              type="checkbox"
              checked={includedWorkers[worker.id] !== false}
              onChange={(event) => onWorkerInclude(worker.id, event.target.checked)}
              className="mt-1 h-5 w-5 accent-roh-gold"
            />
            <span>
              <span className="block font-semibold">{worker.name}</span>
              <span className="mt-1 block text-sm text-slate-400">
                {worker.push} | {worker.disposition} | {worker.brandOrShow || "Brand or Show unmapped"}
              </span>
            </span>
          </label>
        ))}
      </div>
    </section>
  );
}

function WeeklyPriorities({ analysis }: { analysis: SaveAnalysis }) {
  const priorities = analysis.weeklyPriorities;
  return (
    <div className="space-y-3">
      {priorities.length ? priorities.map((priority) => (
        <div key={priority.priorityNumber} className="rounded-md border border-white/10 bg-deck-900 p-5">
          <div className="flex items-start justify-between gap-4">
            <div>
              <p className="text-sm text-slate-400">Priority {priority.priorityNumber}</p>
              <h3 className="mt-1 text-xl font-semibold tracking-normal">{priority.issue}</h3>
            </div>
            <SeverityPill severity={priority.severity} />
          </div>
          <p className="mt-3 text-slate-200">{priority.suggestedAction}</p>
          <p className="mt-2 text-sm text-slate-400">{priority.relatedItem} | {priority.supportingEvidence}</p>
        </div>
      )) : <EmptyState text="Import a save with roster, titles, match or segment data to generate weekly priorities." />}
    </div>
  );
}

type SortDirection = "asc" | "desc";

function RosterAudit({ workers }: { workers: WorkerProfile[] }) {
  const [search, setSearch] = useState("");
  const [pushFilter, setPushFilter] = useState("All");
  const [sort, setSort] = useState<{ key: keyof WorkerProfile; direction: SortDirection }>({ key: "name", direction: "asc" });
  const pushOptions = ["All", ...new Set(workers.map((worker) => worker.push).filter(Boolean).sort())];
  const filteredWorkers = workers
    .filter((worker) => {
      const haystack = `${worker.name} ${worker.push} ${worker.disposition} ${worker.injuryStatus} ${worker.currentTitles.join(" ")}`.toLowerCase();
      const matchesSearch = !search || haystack.includes(search.toLowerCase());
      const matchesWomen = search.toLowerCase() !== "women" && search.toLowerCase() !== "female" ? true : /female|women/i.test(`${worker.name} ${worker.currentTitles.join(" ")}`);
      const matchesPush = pushFilter === "All" || worker.push === pushFilter;
      return matchesSearch && matchesWomen && matchesPush;
    })
    .sort((a, b) => compareValues(a[sort.key], b[sort.key], sort.direction));

  function changeSort(key: keyof WorkerProfile) {
    setSort((current) => ({
      key,
      direction: current.key === key && current.direction === "asc" ? "desc" : "asc",
    }));
  }

  return (
    <section className="rounded-md border border-white/10 bg-deck-900">
      <div className="flex flex-wrap gap-3 border-b border-white/10 p-4">
        <input
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Search roster, type women, title, Push, warning..."
          className="h-11 min-w-72 flex-1 rounded-md border border-white/10 bg-deck-850 px-3 text-sm outline-none focus:border-roh-gold"
        />
        <select
          value={pushFilter}
          onChange={(event) => setPushFilter(event.target.value)}
          className="h-11 rounded-md border border-white/10 bg-deck-850 px-3 text-sm outline-none focus:border-roh-gold"
        >
          {pushOptions.map((option) => (
            <option key={option}>{option}</option>
          ))}
        </select>
      </div>
      <div className="overflow-x-auto">
        <table className="min-w-full text-left text-sm">
          <thead className="bg-deck-850 text-slate-400">
            <tr>
              <SortableTh label="Name" active={sort.key === "name"} direction={sort.direction} onClick={() => changeSort("name")} />
              <SortableTh label="Push" active={sort.key === "push"} direction={sort.direction} onClick={() => changeSort("push")} />
              <SortableTh label="Disposition" active={sort.key === "disposition"} direction={sort.direction} onClick={() => changeSort("disposition")} />
              <SortableTh label="Popularity" active={sort.key === "popularity"} direction={sort.direction} onClick={() => changeSort("popularity")} />
              <SortableTh label="Momentum" active={sort.key === "momentum"} direction={sort.direction} onClick={() => changeSort("momentum")} />
              <SortableTh label="Morale" active={sort.key === "morale"} direction={sort.direction} onClick={() => changeSort("morale")} />
              <SortableTh label="Fatigue" active={sort.key === "fatigue"} direction={sort.direction} onClick={() => changeSort("fatigue")} />
              <SortableTh label="Last Booked" active={sort.key === "lastBooked"} direction={sort.direction} onClick={() => changeSort("lastBooked")} />
              <th className="px-4 py-3 font-medium">Recent Record</th>
              <SortableTh label="Match Avg" active={sort.key === "recentMatchRatingAverage"} direction={sort.direction} onClick={() => changeSort("recentMatchRatingAverage")} />
              <SortableTh label="Segment Avg" active={sort.key === "recentSegmentRatingAverage"} direction={sort.direction} onClick={() => changeSort("recentSegmentRatingAverage")} />
              <th className="px-4 py-3 font-medium">Titles</th>
              <th className="px-4 py-3 font-medium">Warnings</th>
            </tr>
          </thead>
          <tbody>
            {filteredWorkers.map((worker) => (
              <tr key={worker.id} className="border-t border-white/10">
                <td className="px-4 py-3 font-semibold">{worker.name}</td>
                <td className="px-4 py-3">{worker.push}</td>
                <td className="px-4 py-3">{worker.disposition}</td>
                <td className="px-4 py-3">{worker.popularity}</td>
                <td className="px-4 py-3">{worker.momentum}</td>
                <td className="px-4 py-3">{worker.morale}</td>
                <td className="px-4 py-3">{worker.fatigue}</td>
                <td className="px-4 py-3">{worker.lastBooked}</td>
                <td className="px-4 py-3">{worker.recentRecord}</td>
                <td className="px-4 py-3">{worker.recentMatchRatingAverage ?? "Unmapped"}</td>
                <td className="px-4 py-3">{worker.recentSegmentRatingAverage ?? "Unmapped"}</td>
                <td className="px-4 py-3">{worker.currentTitles.join(", ") || "None"}</td>
                <td className="px-4 py-3">{worker.warnings.join(", ") || "None"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function PushGroups({ pushGroups }: { pushGroups: Record<string, WorkerProfile[]> }) {
  return (
    <div className="grid gap-4 xl:grid-cols-2">
      {Object.entries(pushGroups).map(([push, workers]) => {
        const faces = workers.filter((worker) => /face|baby/i.test(worker.disposition)).length;
        const heels = workers.filter((worker) => /heel/i.test(worker.disposition)).length;
        const wins = workers.reduce((sum, worker) => sum + (worker.recentWins ?? 0), 0);
        const losses = workers.reduce((sum, worker) => sum + (worker.recentLosses ?? 0), 0);
        const notBooked = workers.filter((worker) => worker.lastBooked === "Unmapped").length;
        return (
          <section key={push} className="rounded-md border border-white/10 bg-deck-900 p-5">
            <h3 className="text-xl font-semibold tracking-normal">{push}</h3>
            <div className="mt-4 grid grid-cols-2 gap-3 md:grid-cols-3">
              <MiniMetric label="Workers" value={workers.length} />
              <MiniMetric label="Face / Heel" value={`${faces} / ${heels}`} />
              <MiniMetric label="Avg Popularity" value={average(workers.map((worker) => worker.popularity))} />
              <MiniMetric label="Avg Momentum" value={average(workers.map((worker) => worker.momentum))} />
              <MiniMetric label="Avg Morale" value={average(workers.map((worker) => worker.morale))} />
              <MiniMetric label="Avg Fatigue" value={average(workers.map((worker) => worker.fatigue))} />
              <MiniMetric label="Match Avg" value={average(workers.map((worker) => worker.recentMatchRatingAverage ?? 0).filter(Boolean)) || "Unmapped"} />
              <MiniMetric label="Segment Avg" value={average(workers.map((worker) => worker.recentSegmentRatingAverage ?? 0).filter(Boolean)) || "Unmapped"} />
              <MiniMetric label="Recent W/L" value={`${wins}-${losses}`} />
              <MiniMetric label="Not Booked" value={notBooked} />
            </div>
            <div className="mt-4 space-y-2">
              {workers.map((worker) => (
                <div key={worker.id} className="rounded-md bg-deck-850 px-3 py-2 text-sm">
                  {worker.name} | pop {worker.popularity} | mom {worker.momentum} | fatigue {worker.fatigue}
                </div>
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
}

function PushMismatch({ analysis }: { analysis: SaveAnalysis }) {
  return (
    <div className="space-y-4">
      <section className="rounded-md border border-white/10 bg-deck-900 p-5">
        <div className="flex items-center gap-3">
          <SlidersHorizontal className="text-roh-gold" />
          <div>
            <h3 className="text-lg font-semibold tracking-normal">Push Fit Score Weighting</h3>
            <p className="text-sm text-slate-400">
              Popularity {defaultPushFitSettings.popularityWeight}% | Momentum {defaultPushFitSettings.momentumWeight}% | Booking credibility {defaultPushFitSettings.credibilityWeight}% | Ratings {defaultPushFitSettings.ratingsWeight}% | Availability {defaultPushFitSettings.availabilityWeight}%
            </p>
          </div>
        </div>
      </section>
      <div className="grid gap-4 xl:grid-cols-2">
        {analysis.pushMismatch.length ? (
          analysis.pushMismatch.map((item) => (
            <section key={item.worker.id} className="rounded-md border border-white/10 bg-deck-900 p-5">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <h3 className="text-lg font-semibold tracking-normal">{item.worker.name}</h3>
                  <p className="text-sm text-slate-400">Official Push: {item.officialPush}</p>
                  <p className="mt-1 text-sm text-slate-400">Recommended tier: {item.recommendedTier}</p>
                </div>
                <StatusPill label={item.label} tone={item.severity === "High" || item.severity === "Critical" ? "bad" : item.severity === "Medium" ? "warn" : "good"} />
              </div>
              <div className="mt-4 h-3 overflow-hidden rounded-full bg-deck-800">
                <div className="h-full bg-roh-gold" style={{ width: `${item.score}%` }} />
              </div>
              <p className="mt-3 text-sm text-slate-300">
                Push Fit Score {item.score}. Evidence: {item.evidence.join("; ")}.
              </p>
              <p className="mt-2 text-sm text-slate-400">Suggested action: {item.suggestedAction}</p>
            </section>
          ))
        ) : (
          <EmptyState text="Import roster data to calculate Push Fit Score and Push Mismatch diagnostics." />
        )}
      </div>
    </div>
  );
}

function RatingsAnalytics({ analysis }: { analysis: SaveAnalysis }) {
  const sortedMatches = [...analysis.workers].sort((a, b) => (b.recentMatchRatingAverage ?? 0) - (a.recentMatchRatingAverage ?? 0));
  const sortedSegments = [...analysis.workers].sort((a, b) => (b.recentSegmentRatingAverage ?? 0) - (a.recentSegmentRatingAverage ?? 0));
  const matchTypes = ratingAveragesByKey(analysis.matches, "matchType");
  const segmentTypes = ratingAveragesByKey(analysis.segments, "segmentType");
  const showRatings = ratingAveragesByKey([...analysis.matches, ...analysis.segments], "eventName");
  const chemistry = chemistryPairings(analysis);
  const betterInMatches = analysis.workers
    .filter((worker) => (worker.recentMatchRatingAverage ?? 0) - (worker.recentSegmentRatingAverage ?? 0) >= 10)
    .slice(0, 6);
  const betterInSegments = analysis.workers
    .filter((worker) => (worker.recentSegmentRatingAverage ?? 0) - (worker.recentMatchRatingAverage ?? 0) >= 10)
    .slice(0, 6);

  return (
    <div className="grid gap-4 xl:grid-cols-2">
      <Ranking title="Top Recent Match Performers" workers={sortedMatches} valueKey="recentMatchRatingAverage" />
      <Ranking title="Top Recent Segment Performers" workers={sortedSegments} valueKey="recentSegmentRatingAverage" />
      <ListCard title="Strongest Chemistry Pairings" items={chemistry.best.map((item) => `${item.name}: ${item.average} average across ${item.count} appearances`)} empty="Requires repeated mapped match or segment participants with ratings." />
      <ListCard title="Worst Chemistry Pairings" items={chemistry.worst.map((item) => `${item.name}: ${item.average} average across ${item.count} appearances`)} empty="Requires repeated mapped match or segment participants with ratings." />
      <ListCard title="Match Types Producing Best Ratings" items={matchTypes.map((item) => `${item.name}: ${item.average} average from ${item.count}`)} empty="Requires Match Type and Match Rating mapping." />
      <ListCard title="Segment Types Producing Best Ratings" items={segmentTypes.map((item) => `${item.name}: ${item.average} average from ${item.count}`)} empty="Requires Segment Type and Segment Rating mapping." />
      <ListCard title="Shows With Best Overall Ratings" items={showRatings.slice(0, 6).map((item) => `${item.name}: ${item.average} average from ${item.count}`)} empty="Requires Event Name and ratings mapping." />
      <ListCard title="Better In Matches Than Segments" items={betterInMatches.map((worker) => `${worker.name}: match ${worker.recentMatchRatingAverage}, segment ${worker.recentSegmentRatingAverage}`)} empty="No clear match-over-segment split detected yet." />
      <ListCard title="Better In Segments Than Matches" items={betterInSegments.map((worker) => `${worker.name}: segment ${worker.recentSegmentRatingAverage}, match ${worker.recentMatchRatingAverage}`)} empty="No clear segment-over-match split detected yet." />
    </div>
  );
}

function Titles({ selectedPromotion, analysis }: { selectedPromotion: string; analysis: SaveAnalysis }) {
  const [sort, setSort] = useState<{ key: "prestige" | "name" | "recentDefences" | "daysSinceLastDefence"; direction: SortDirection }>({ key: "prestige", direction: "desc" });
  const sortedTitles = [...analysis.titles].sort((a, b) => compareValues(a[sort.key], b[sort.key], sort.direction));
  function changeSort(key: typeof sort.key) {
    setSort((current) => ({ key, direction: current.key === key && current.direction === "asc" ? "desc" : "asc" }));
  }

  return (
    <section className="rounded-md border border-white/10 bg-deck-900 p-5">
      <h3 className="text-xl font-semibold tracking-normal">{selectedPromotion} Title Audit</h3>
      <div className="mt-4 overflow-x-auto rounded-md border border-white/10">
        {analysis.titles.length ? (
          <table className="min-w-full text-left text-sm">
            <thead className="bg-deck-850 text-slate-400">
              <tr>
                <SortableTh label="Championship" active={sort.key === "name"} direction={sort.direction} onClick={() => changeSort("name")} />
                <th className="px-4 py-3 font-medium">Champion</th>
                <SortableTh label="Prestige" active={sort.key === "prestige"} direction={sort.direction} onClick={() => changeSort("prestige")} />
                <th className="px-4 py-3 font-medium">Type</th>
                <SortableTh label="Defences" active={sort.key === "recentDefences"} direction={sort.direction} onClick={() => changeSort("recentDefences")} />
                <SortableTh label="Days Since Won" active={sort.key === "daysSinceLastDefence"} direction={sort.direction} onClick={() => changeSort("daysSinceLastDefence")} />
                <th className="px-4 py-3 font-medium">Status</th>
              </tr>
            </thead>
            <tbody>
              {sortedTitles.map((title) => (
                <tr key={title.id} className="border-t border-white/10">
                  <td className="px-4 py-3 font-semibold">{title.name}</td>
                  <td className="px-4 py-3 text-roh-gold">{title.champion || "Unmapped"}</td>
                  <td className="px-4 py-3">{title.prestige ?? "Unmapped"}</td>
                  <td className="px-4 py-3">{title.type || title.genderLimits || "Unmapped"}</td>
                  <td className="px-4 py-3">{title.recentDefences}</td>
                  <td className="px-4 py-3">{title.daysSinceLastDefence ?? "Unmapped"}</td>
                  <td className="px-4 py-3"><SeverityPill severity={title.warningStatus} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <EmptyState text="No title table was confidently mapped yet. Use Database Mapping to confirm Title, Title Holder and Last Defence fields if the save uses unusual column names." />
        )}
      </div>
    </section>
  );
}

function BookingWarnings({ analysis }: { analysis: SaveAnalysis }) {
  const diagnostics = [...analysis.diagnostics].sort((a, b) => severityValue(b.severity) - severityValue(a.severity));
  return (
    <div className="space-y-4">
      {diagnostics.length ? (
        diagnostics.map((diagnostic) => (
          <section key={diagnostic.id} className="rounded-md border border-white/10 bg-deck-900 p-5">
            <div className="flex items-start justify-between gap-4">
              <h3 className="text-xl font-semibold tracking-normal">{diagnostic.problem}</h3>
              <SeverityPill severity={diagnostic.severity} />
            </div>
            <p className="mt-3 text-sm text-slate-300">Evidence: {diagnostic.evidence}</p>
            <p className="mt-2 text-sm text-slate-400">Why it matters: {diagnostic.whyItMatters}</p>
            <p className="mt-2 text-sm text-slate-200">Suggested fix: {diagnostic.suggestedFix}</p>
            <p className="mt-2 text-sm text-roh-gold">Example booking action: {diagnostic.exampleBookingAction}</p>
          </section>
        ))
      ) : (
        <EmptyState text="No booking warnings yet. Import roster, title, match and segment data to generate diagnostics." />
      )}
    </div>
  );
}

function Rivalries({ analysis }: { analysis: SaveAnalysis }) {
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<{ key: "status" | "name" | "averageRating" | "latestRating" | "trend"; direction: SortDirection }>({ key: "status", direction: "desc" });
  const rivalries = analysis.rivalries
    .filter((rivalry) => `${rivalry.name} ${rivalry.participants.join(" ")} ${rivalry.trend}`.toLowerCase().includes(search.toLowerCase()))
    .sort((a, b) => sort.key === "status" ? compareValues(severityValue(a.status), severityValue(b.status), sort.direction) : compareValues(a[sort.key], b[sort.key], sort.direction));
  function changeSort(key: typeof sort.key) {
    setSort((current) => ({ key, direction: current.key === key && current.direction === "asc" ? "desc" : "asc" }));
  }

  return (
    <section className="rounded-md border border-white/10 bg-deck-900">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-white/10 p-4">
        <div>
          <h3 className="text-xl font-semibold tracking-normal">In-Game Rivalries</h3>
          <p className="text-sm text-slate-400">Read from PWS storylines and recent storyline segment ratings.</p>
        </div>
        <input
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Search rivalry or worker..."
          className="h-11 min-w-72 rounded-md border border-white/10 bg-deck-850 px-3 text-sm outline-none focus:border-roh-gold"
        />
      </div>
      {rivalries.length ? (
        <div className="overflow-x-auto">
          <table className="min-w-full text-left text-sm">
            <thead className="bg-deck-850 text-slate-400">
              <tr>
                <SortableTh label="Rivalry" active={sort.key === "name"} direction={sort.direction} onClick={() => changeSort("name")} />
                <th className="px-4 py-3 font-medium">Participants</th>
                <SortableTh label="Trend" active={sort.key === "trend"} direction={sort.direction} onClick={() => changeSort("trend")} />
                <SortableTh label="Average" active={sort.key === "averageRating"} direction={sort.direction} onClick={() => changeSort("averageRating")} />
                <SortableTh label="Latest" active={sort.key === "latestRating"} direction={sort.direction} onClick={() => changeSort("latestRating")} />
                <SortableTh label="Status" active={sort.key === "status"} direction={sort.direction} onClick={() => changeSort("status")} />
                <th className="px-4 py-3 font-medium">Recommendation</th>
              </tr>
            </thead>
            <tbody>
              {rivalries.map((rivalry) => (
                <tr key={rivalry.id} className="border-t border-white/10 align-top">
                  <td className="px-4 py-3 font-semibold">{rivalry.name}</td>
                  <td className="px-4 py-3">{rivalry.participants.join(", ") || "Unmapped"}</td>
                  <td className="px-4 py-3">{rivalry.trend}</td>
                  <td className="px-4 py-3">{rivalry.averageRating ?? "Unmapped"}</td>
                  <td className="px-4 py-3">{rivalry.latestRating ?? "Unmapped"}</td>
                  <td className="px-4 py-3"><SeverityPill severity={rivalry.status} /></td>
                  <td className="px-4 py-3 text-slate-300">{rivalry.recommendation}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="p-5">
          <EmptyState text="No active PWS storylines were found in this import." />
        </div>
      )}
    </section>
  );
}

function PpvBuildChecker() {
  return (
    <section className="rounded-md border border-white/10 bg-deck-900 p-5">
      <h3 className="text-xl font-semibold tracking-normal">Planned Major Event Card</h3>
      <div className="mt-4 grid gap-3 xl:grid-cols-2">
        {["Event name", "Event date", "Match list", "Titles involved", "Participants", "Match importance", "Planned winner", "Storyline or feud", "Build notes"].map((field) => (
          <label key={field} className="block">
            <span className="mb-1 block text-sm text-slate-300">{field}</span>
            <input className="h-12 w-full rounded-md border border-white/10 bg-deck-850 px-3 outline-none focus:border-roh-gold" placeholder={field} />
          </label>
        ))}
      </div>
      <div className="mt-5 grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        <Metric label="PPV Build Score" value="Pending card" severity="Medium" />
        <Metric label="Highest Rating Upside" value="Needs matches" severity="Medium" />
        <Metric label="Biggest Risk Match" value="Needs matches" severity="Medium" />
        <Metric label="Missing Titles" value="Needs card" severity="Medium" />
      </div>
    </section>
  );
}

function SnapshotComparison({ snapshots }: { snapshots: SnapshotMetadata[] }) {
  return (
    <section className="rounded-md border border-white/10 bg-deck-900 p-5">
      <h3 className="text-xl font-semibold tracking-normal">Snapshot Comparison</h3>
      {snapshots.length < 2 ? (
        <EmptyState text="No previous snapshot available for comparison. Import at least two snapshots to compare changes." />
      ) : (
        <div className="mt-4 space-y-3">
          {snapshots.map((snapshot) => (
            <div key={snapshot.id} className="rounded-md border border-white/10 bg-deck-850 p-4">
              <p className="font-semibold">{snapshot.sourceFileName}</p>
              <p className="text-sm text-slate-400">{formatDate(snapshot.importedDate)} | {formatBytes(snapshot.fileSize)}</p>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function SettingsPanel({
  selectedSave,
  selectedPromotion,
  mappingProfile,
  analysis,
}: {
  selectedSave: string | null;
  selectedPromotion: string;
  mappingProfile: MappingProfile;
  analysis: SaveAnalysis;
}) {
  const exportItems = [
    "Full save audit",
    "Weekly priorities",
    "Title audit",
    "Push Mismatch report",
    "Ratings Analytics report",
    "Snapshot comparison report",
  ];

  return (
    <div className="space-y-4">
      <section className="rounded-md border border-white/10 bg-deck-900 p-5">
        <h3 className="text-xl font-semibold tracking-normal">Local Settings</h3>
        <div className="mt-4 grid gap-3 xl:grid-cols-2">
          <AnalysisCard title="Selected save path" text={selectedSave || "No save selected"} />
          <AnalysisCard title="Selected promotion" text={selectedPromotion} />
          <AnalysisCard title="Mapping profile" text={mappingProfile.name} />
          <AnalysisCard title="Snapshot folder" text="~/.local/share/pws-save-auditor/snapshots/" />
        </div>
      </section>
      <section className="rounded-md border border-white/10 bg-deck-900 p-5">
        <h3 className="text-lg font-semibold tracking-normal">Audit Thresholds</h3>
        <div className="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-4">
          {["Days before not-booked warning", "Days before title inactive warning", "Fatigue warning threshold", "Morale warning threshold", "Rating decline threshold", "Recent matches used", "Recent segments used", "Repetitive match threshold"].map((field) => (
            <label key={field} className="block">
              <span className="mb-1 block text-sm text-slate-300">{field}</span>
              <input className="h-12 w-full rounded-md border border-white/10 bg-deck-850 px-3 outline-none focus:border-roh-gold" defaultValue="30" />
            </label>
          ))}
        </div>
      </section>
      <section className="rounded-md border border-white/10 bg-deck-900 p-5">
        <h3 className="text-lg font-semibold tracking-normal">Exports</h3>
        <div className="mt-4 flex flex-wrap gap-3">
          {exportItems.map((label) => (
            <BigButton key={label} icon={FileDown} label={label} variant="secondary" onClick={() => downloadReport(label, analysis)} />
          ))}
        </div>
      </section>
    </div>
  );
}

function BigButton({
  icon: Icon,
  label,
  onClick,
  variant = "primary",
}: {
  icon: typeof FolderSearch;
  label: string;
  onClick: () => void;
  variant?: "primary" | "secondary" | "accent";
}) {
  const className =
    variant === "accent"
      ? "bg-roh-gold text-deck-950 hover:bg-[#e5c77f]"
      : variant === "secondary"
        ? "border border-white/10 bg-deck-850 text-slate-100 hover:bg-white/10"
        : "bg-roh-cyan text-deck-950 hover:bg-[#7fd5e4]";
  return (
    <button type="button" onClick={onClick} className={`flex h-12 items-center gap-2 rounded-md px-4 text-base font-semibold transition ${className}`}>
      <Icon size={21} />
      <span>{label}</span>
    </button>
  );
}

function Metric({ label, value, severity, onClick }: { label: string; value: string; severity: "Low" | "Medium" | "High" | "Critical"; onClick?: () => void }) {
  const Component = onClick ? "button" : "div";
  return (
    <Component type={onClick ? "button" : undefined} onClick={onClick} className={`rounded-md border border-white/10 bg-deck-900 p-4 text-left ${onClick ? "transition hover:border-roh-gold hover:bg-deck-850" : ""}`}>
      <div className="flex items-start justify-between gap-3">
        <p className="text-sm text-slate-400">{label}</p>
        <SeverityPill severity={severity} />
      </div>
      <p className="mt-3 text-2xl font-bold tracking-normal">{value}</p>
    </Component>
  );
}

function MiniMetric({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="rounded-md bg-deck-850 p-3">
      <p className="text-xs text-slate-500">{label}</p>
      <p className="mt-1 font-semibold">{value}</p>
    </div>
  );
}

function SortableTh({
  label,
  active,
  direction,
  onClick,
}: {
  label: string;
  active: boolean;
  direction: SortDirection;
  onClick: () => void;
}) {
  return (
    <th className="px-4 py-3 font-medium">
      <button type="button" onClick={onClick} className="flex items-center gap-1 text-left hover:text-roh-gold">
        {label}
        <span className="text-xs">{active ? (direction === "asc" ? "▲" : "▼") : ""}</span>
      </button>
    </th>
  );
}

function Ranking({
  title,
  workers,
  valueKey,
}: {
  title: string;
  workers: WorkerProfile[];
  valueKey: "recentMatchRatingAverage" | "recentSegmentRatingAverage";
}) {
  return (
    <section className="rounded-md border border-white/10 bg-deck-900 p-5">
      <h3 className="text-lg font-semibold tracking-normal">{title}</h3>
      <div className="mt-4 space-y-2">
        {workers.slice(0, 5).map((worker, index) => (
          <div key={worker.id} className="flex items-center justify-between rounded-md bg-deck-850 px-3 py-3">
            <span>{index + 1}. {worker.name}</span>
            <span className="font-semibold text-roh-gold">{worker[valueKey] ?? "Unmapped"}</span>
          </div>
        ))}
      </div>
    </section>
  );
}

function ListCard({ title, items, empty }: { title: string; items: string[]; empty: string }) {
  return (
    <section className="rounded-md border border-white/10 bg-deck-900 p-5">
      <h3 className="text-lg font-semibold tracking-normal">{title}</h3>
      <div className="mt-3 space-y-2">
        {items.length ? (
          items.map((item) => (
            <div key={item} className="rounded-md bg-deck-850 px-3 py-2 text-sm text-slate-300">
              {item}
            </div>
          ))
        ) : (
          <p className="rounded-md border border-dashed border-white/15 bg-deck-850 p-3 text-sm text-slate-400">{empty}</p>
        )}
      </div>
    </section>
  );
}

function AnalysisCard({ title, text }: { title: string; text: string }) {
  return (
    <div className="rounded-md border border-white/10 bg-deck-850 p-4">
      <p className="font-semibold">{title}</p>
      <p className="mt-2 text-sm text-slate-400">{text}</p>
    </div>
  );
}

function EmptyState({ text }: { text: string }) {
  return <div className="rounded-md border border-dashed border-white/15 bg-deck-850 p-5 text-slate-400">{text}</div>;
}

function SafetyList() {
  const items = [
    "Never writes to the original PWS save.",
    "Refresh Save creates a timestamped snapshot first.",
    "SQLite inspection opens the copied snapshot read-only.",
    "All data stays local on the Steam Deck or PC.",
    "Locked or unreadable saves are shown as warnings.",
  ];
  return (
    <div className="space-y-3">
      {items.map((item) => (
        <div key={item} className="flex items-start gap-3 rounded-md bg-deck-850 p-3">
          <CheckCircle2 className="mt-0.5 text-roh-cyan" size={18} />
          <p className="text-sm text-slate-300">{item}</p>
        </div>
      ))}
    </div>
  );
}

function StatusPill({ label, tone }: { label: string; tone: "good" | "warn" | "bad" }) {
  const classes = {
    good: "border-emerald-400/30 bg-emerald-400/10 text-emerald-100",
    warn: "border-roh-gold/35 bg-roh-gold/10 text-amber-100",
    bad: "border-roh-red/40 bg-roh-red/10 text-red-100",
  };
  return <span className={`shrink-0 rounded-md border px-2.5 py-1 text-xs font-semibold ${classes[tone]}`}>{label}</span>;
}

function SeverityPill({ severity }: { severity: "Low" | "Medium" | "High" | "Critical" }) {
  const tone = severity === "Low" ? "good" : severity === "Medium" ? "warn" : "bad";
  return <StatusPill label={severity} tone={tone} />;
}

function buildTableColumnOptions(inspection: DatabaseInspection | null): string[] {
  if (!inspection) {
    return [];
  }
  return inspection.tables.flatMap((table) => table.columns.map((column) => `${table.name}.${column.name}`));
}

function groupBy<T>(items: T[], getKey: (item: T) => string): Record<string, T[]> {
  return items.reduce<Record<string, T[]>>((result, item) => {
    const key = getKey(item);
    result[key] = result[key] || [];
    result[key].push(item);
    return result;
  }, {});
}

function average(values: number[]): number {
  if (!values.length) {
    return 0;
  }
  return Math.round(values.reduce((sum, value) => sum + value, 0) / values.length);
}

function ratingAveragesByKey<T extends { rating: number | null }>(
  records: T[],
  key: keyof T,
): Array<{ name: string; average: number; count: number }> {
  const groups = new Map<string, number[]>();
  records.forEach((record) => {
    if (typeof record.rating !== "number") return;
    const name = String(record[key] || "Unmapped");
    if (!name || name === "Unmapped") return;
    groups.set(name, [...(groups.get(name) || []), record.rating]);
  });

  return [...groups.entries()]
    .map(([name, values]) => ({ name, average: average(values), count: values.length }))
    .sort((a, b) => b.average - a.average || b.count - a.count)
    .slice(0, 8);
}

function chemistryPairings(analysis: SaveAnalysis): {
  best: Array<{ name: string; average: number; count: number }>;
  worst: Array<{ name: string; average: number; count: number }>;
} {
  const pairRatings = new Map<string, number[]>();
  [...analysis.matches, ...analysis.segments].forEach((record) => {
    if (typeof record.rating !== "number" || record.participants.length < 2) return;
    const participants = [...new Set(record.participants.filter(Boolean))].sort();
    for (let left = 0; left < participants.length; left += 1) {
      for (let right = left + 1; right < participants.length; right += 1) {
        const pair = `${participants[left]} / ${participants[right]}`;
        pairRatings.set(pair, [...(pairRatings.get(pair) || []), record.rating]);
      }
    }
  });

  const pairings = [...pairRatings.entries()]
    .map(([name, values]) => ({ name, average: average(values), count: values.length }))
    .filter((item) => item.count >= 2);

  return {
    best: [...pairings].sort((a, b) => b.average - a.average || b.count - a.count).slice(0, 6),
    worst: [...pairings].sort((a, b) => a.average - b.average || b.count - a.count).slice(0, 6),
  };
}

function downloadReport(label: string, analysis: SaveAnalysis) {
  const fileBase = label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
  const payload = {
    report: label,
    exportedAt: new Date().toISOString(),
    workers: analysis.workers,
    titles: analysis.titles,
    weeklyPriorities: analysis.weeklyPriorities,
    diagnostics: analysis.diagnostics,
    pushMismatch: analysis.pushMismatch,
    matches: analysis.matches,
    segments: analysis.segments,
    tableSummary: analysis.tableSummary,
    unmapped: analysis.unmapped,
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `${fileBase || "pws-save-auditor-report"}.json`;
  anchor.click();
  URL.revokeObjectURL(url);
}

function compareValues(left: unknown, right: unknown, direction: SortDirection): number {
  const modifier = direction === "asc" ? 1 : -1;
  if (typeof left === "number" || typeof right === "number") {
    return (((Number(left) || 0) - (Number(right) || 0)) * modifier);
  }
  return String(left ?? "").localeCompare(String(right ?? "")) * modifier;
}

function severityValue(severity: "Low" | "Medium" | "High" | "Critical"): number {
  return { Low: 1, Medium: 2, High: 3, Critical: 4 }[severity];
}

function splitCamel(value: string): string {
  return value.replace(/([A-Z])/g, " $1").replace(/^./, (first) => first.toUpperCase());
}

function promotionMatchesUi(value: string, selectedPromotion: string): boolean {
  const normalize = (input: string) => input.toLowerCase().replace(/[^a-z0-9]/g, "");
  const left = normalize(value);
  const right = normalize(selectedPromotion);
  return left === right || left.includes(right) || right.includes(left);
}
