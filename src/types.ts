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
  | "rivalries"
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
  overallRating: number;
  overallBreakdown: WorkerOverallBreakdown;
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
  recentWins?: number;
  recentLosses?: number;
  recentOpponents?: string[];
  recentMatchCount?: number;
  recentSegmentCount?: number;
  recentMatchRatingAverage: number | null;
  last5MatchAverage?: number | null;
  last10MatchAverage?: number | null;
  recentSegmentRatingAverage: number | null;
  last5SegmentAverage?: number | null;
  last10SegmentAverage?: number | null;
  bestRecentMatch?: string | null;
  worstRecentMatch?: string | null;
  lastBooked: string;
  warnings: string[];
  creativeNotes: CreativeNotes;
}

export interface WorkerOverallBreakdown {
  marketability: number;
  starPower: number;
  popularity: number;
  wrestlingAbility: number;
  psychology: number;
  entertainment: number;
  reliability: number;
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
  prestige?: number;
  type?: string;
  genderLimits?: string;
}

export interface RivalryRecord {
  id: string;
  name: string;
  active: boolean;
  startDate: string;
  endDate: string;
  participants: string[];
  recentSegmentCount: number;
  averageRating: number | null;
  latestRating: number | null;
  trend: "Rising" | "Cooling" | "Stable" | "Unmapped";
  status: Severity;
  healthLabel: "Hot" | "Healthy" | "Stale" | "Needs Data" | "Needs Participants";
  recommendation: string;
}

export interface PushMismatchResult {
  worker: WorkerProfile;
  officialPush: string;
  recommendedTier: string;
  score: number;
  label: string;
  severity: Severity;
  mismatchDelta: number;
  evidence: string[];
  suggestedAction: string;
}

export interface CompanyCandidate {
  name: string;
  confidence: number;
  activeRosterCount: number;
  recentEventsCount: number;
  titlesCount: number;
  reasons: string[];
}

export interface ImportSummary {
  detectedCompany: string;
  confidence: number;
  confidenceLevel: "High" | "Medium" | "Low";
  activeRosterCount: number;
  titlesFound: number;
  recentEventsFound: number;
  matchesFound: number;
  segmentsFound: number;
  unmappedFields: string[];
}

export interface SaveAnalysis {
  workers: WorkerProfile[];
  titles: TitleRecord[];
  matches: MatchRecord[];
  segments: SegmentRecord[];
  rivalries: RivalryRecord[];
  diagnostics: Diagnostic[];
  weeklyPriorities: WeeklyPriority[];
  pushMismatch: PushMismatchResult[];
  promotions: string[];
  companyCandidates: CompanyCandidate[];
  importSummary: ImportSummary;
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
