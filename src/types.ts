import type { LucideIcon } from "lucide-react";

export type Severity = "Low" | "Medium" | "High" | "Critical";

export type TabKey =
  | "save-import"
  | "dashboard"
  | "weekly-priorities"
  | "roster-audit"
  | "push-groups"
  | "push-mismatch"
  | "ratings-analytics"
  | "titles"
  | "booking-warnings"
  | "ppv-build-checker"
  | "snapshot-comparison"
  | "settings";

export interface NavItem {
  key: TabKey;
  label: string;
  icon: LucideIcon;
}

export interface SaveCandidate {
  fileName: string;
  fullPath: string;
  lastModified: string | null;
  fileSize: number;
  detectedBy: string[];
  readable: boolean;
  warning: string | null;
}

export interface SnapshotMetadata {
  id: string;
  importedDate: string;
  sourceFileName: string;
  sourcePath: string;
  fileSize: number;
  sourceLastModified: string | null;
  snapshotPath: string;
}

export interface ColumnInfo {
  name: string;
  dataType: string;
  notNull: boolean;
  primaryKey: boolean;
}

export interface TableInfo {
  name: string;
  columns: ColumnInfo[];
  rowCount: number | null;
  sampleRows: Record<string, unknown>[];
}

export interface LikelyMappings {
  workersTable: string | null;
  companiesTable: string | null;
  contractsTable: string | null;
  brandsOrShowsTable: string | null;
  titlesTable: string | null;
  eventsTable: string | null;
  matchesTable: string | null;
  segmentsTable: string | null;
  storylinesTable: string | null;
  tagTeamsTable: string | null;
  stablesOrFactionsTable: string | null;
}

export interface DatabaseInspection {
  path: string;
  tables: TableInfo[];
  likelyMappings: LikelyMappings;
  warnings: string[];
}

export interface AppConfig {
  selectedSavePath: string | null;
  selectedPromotion: string | null;
  ignoredWorkers: string[];
}

export interface MappingProfile {
  id: string;
  name: string;
  fields: Record<string, string>;
  pushTierOrder: Record<string, number>;
}

export interface WorkerProfile {
  id: string;
  name: string;
  company: string;
  brandOrShow: string;
  push: string;
  disposition: string;
  popularity: number;
  momentum: number;
  morale: number;
  fatigue: number;
  injuryStatus: string;
  contractStatus: string;
  currentTitles: string[];
  recentRecord: string;
  recentMatchRatingAverage: number | null;
  recentSegmentRatingAverage: number | null;
  lastBooked: string;
  warnings: string[];
  creativeNotes: CreativeNotes;
}

export interface CreativeNotes {
  bookingIntent: string;
  creativePlan: string;
  protectedBookingNote: string;
  plannedTitleDirection: string;
  plannedTurn: string;
  plannedFeud: string;
  longTermPlan: string;
  shortTermPlan: string;
  doNotBook: boolean;
  doNotBeat: boolean;
  keepStrong: boolean;
  coolDown: boolean;
  repackage: boolean;
  creativeOverrideActive: boolean;
  ignoreFromAudit: boolean;
}

export interface Diagnostic {
  id: string;
  problem: string;
  severity: Severity;
  evidence: string;
  whyItMatters: string;
  suggestedFix: string;
  exampleBookingAction: string;
}

export interface WeeklyPriority {
  priorityNumber: number;
  issue: string;
  suggestedAction: string;
  relatedItem: string;
  severity: Severity;
  supportingEvidence: string;
}

export interface PushFitSettings {
  popularityWeight: number;
  momentumWeight: number;
  credibilityWeight: number;
  ratingsWeight: number;
  availabilityWeight: number;
  thresholds: {
    mainEvent: number;
    upperMidcard: number;
    midcard: number;
    lowerMidcard: number;
  };
}
