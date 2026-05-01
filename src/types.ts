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
  rawId?: string;
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

export interface MatchRecord {
  id: string;
  eventName: string;
  eventDate: string;
  showType: string;
  matchOrder: number | null;
  matchType: string;
  participants: string[];
  winner: string;
  loser: string;
  titleInvolved: string;
  rating: number | null;
  showRating: number | null;
  length: string;
}

export interface SegmentRecord {
  id: string;
  eventName: string;
  eventDate: string;
  segmentOrder: number | null;
  segmentType: string;
  participants: string[];
  storyline: string;
  titleInvolved: string;
  rating: number | null;
  showRating: number | null;
  length: string;
}

export interface TitleRecord {
  id: string;
  name: string;
  company: string;
  champion: string;
  lastDefenceDate: string;
  daysSinceLastDefence: number | null;
  recentDefences: number;
  recentChallengers: string[];
  warningStatus: Severity;
}

export interface PushMismatchResult {
  worker: WorkerProfile;
  officialPush: string;
  recommendedTier: string;
  score: number;
  label: string;
  severity: Severity;
  evidence: string[];
  suggestedAction: string;
}

export interface SaveAnalysis {
  workers: WorkerProfile[];
  titles: TitleRecord[];
  matches: MatchRecord[];
  segments: SegmentRecord[];
  diagnostics: Diagnostic[];
  weeklyPriorities: WeeklyPriority[];
  pushMismatch: PushMismatchResult[];
  promotions: string[];
  tableSummary: Array<{
    name: string;
    rowCount: number;
    columns: string[];
  }>;
  unmapped: string[];
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
