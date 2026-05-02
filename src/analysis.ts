import { emptyCreativeNotes } from "./data";
import type {
  DatabaseInspection,
  CompanyCandidate,
  Diagnostic,
  ImportSummary,
  MappingProfile,
  MatchRecord,
  PushMismatchResult,
  RivalryRecord,
  SaveAnalysis,
  SegmentRecord,
  Severity,
  TableInfo,
  TitleRecord,
  WeeklyPriority,
  WorkerOverallBreakdown,
  WorkerProfile,
} from "./types";

const unknown = "Unmapped";

export function buildSaveAnalysis(
  inspection: DatabaseInspection | null,
  selectedPromotion: string,
  ignoredWorkers: string[],
  mappingProfile?: MappingProfile,
): SaveAnalysis {
  if (!inspection) {
    return emptyAnalysis();
  }

  const companyLookup = buildEntityLookup(inspection, ["company", "promotion", "fed"]);
  const workerLookup = buildEntityLookup(inspection, ["worker", "wrestler", "talent", "person"]);
  const promotions = derivePromotions(inspection, companyLookup);
  const companyCandidates = buildCompanyCandidates(inspection, promotions);
  const pwsSchema = isPwsSchema(inspection);
  const selectedCompany = pwsSchema
    ? resolvePwsSelectedCompany(inspection, selectedPromotion)
    : { id: selectedPromotion, name: selectedPromotion };
  const workers = pwsSchema
    ? extractPwsWorkers(inspection, selectedCompany.id, selectedCompany.name, ignoredWorkers)
    : extractWorkers(inspection, selectedPromotion, ignoredWorkers, companyLookup, mappingProfile);
  const titles = pwsSchema
    ? extractPwsTitles(inspection, selectedCompany.id)
    : extractTitles(inspection, selectedPromotion, companyLookup, workerLookup, mappingProfile);
  const matches = pwsSchema
    ? filterRecordsToRoster(extractPwsMatches(inspection, selectedCompany.id), workers)
    : filterRecordsToRoster(extractMatches(inspection, workerLookup, mappingProfile), workers);
  const segments = pwsSchema
    ? filterRecordsToRoster(extractPwsSegments(inspection, selectedCompany.id), workers)
    : filterRecordsToRoster(extractSegments(inspection, workerLookup, mappingProfile), workers);
  const rivalries = pwsSchema ? extractPwsRivalries(inspection, selectedCompany.id) : [];
  const enrichedWorkers = dedupeAnalysisWorkers(enrichWorkers(workers, matches, segments, titles));
  const pushMismatch = buildPushMismatch(enrichedWorkers);
  const diagnostics = buildDiagnostics(enrichedWorkers, titles, matches, segments, pushMismatch, rivalries);
  const weeklyPriorities = buildWeeklyPriorities(diagnostics);
  const unmapped = buildUnmappedList(inspection, workers, matches, segments, titles);
  const importSummary = buildImportSummary(selectedCompany.name, companyCandidates, enrichedWorkers, titles, matches, segments, unmapped);

  return {
    workers: enrichedWorkers,
    titles,
    matches,
    segments,
    rivalries,
    diagnostics,
    weeklyPriorities,
    pushMismatch,
    promotions,
    companyCandidates,
    importSummary,
    tableSummary: inspection.tables.map((table) => ({
      name: table.name,
      rowCount: table.rowCount ?? table.sampleRows.length,
      columns: table.columns.map((column) => column.name),
    })),
    unmapped,
  };
}

function emptyAnalysis(): SaveAnalysis {
  return {
    workers: [],
    titles: [],
    matches: [],
    segments: [],
    rivalries: [],
    diagnostics: [],
    weeklyPriorities: [],
    pushMismatch: [],
    promotions: ["ROH", "Custom company"],
    companyCandidates: [],
    importSummary: {
      detectedCompany: "Not detected",
      confidence: 0,
      confidenceLevel: "Low",
      activeRosterCount: 0,
      titlesFound: 0,
      recentEventsFound: 0,
      matchesFound: 0,
      segmentsFound: 0,
      unmappedFields: ["Import a PWS save file to inspect database tables."],
    },
    tableSummary: [],
    unmapped: ["Import a PWS save file to inspect database tables."],
  };
}

function extractWorkers(
  inspection: DatabaseInspection,
  selectedPromotion: string,
  ignoredWorkers: string[],
  companyLookup: Record<string, string>,
  mappingProfile?: MappingProfile,
): WorkerProfile[] {
  const table = findMappedTable(inspection, mappingProfile, "Worker Name") || findWorkerTable(inspection);
  if (!table) return [];

  const selectedCompanyIds = findSelectedCompanyIds(inspection, selectedPromotion);
  const workerLinks = findCompanyWorkerLinks(inspection, table, selectedCompanyIds, selectedPromotion);
  const linkedWorkerIds = new Set([...workerLinks.keys()]);

  const workers = table.sampleRows
    .map((baseRow, index) => {
      const id = pickString(baseRow, ["id", "worker_id", "workerid", "wrestler_id", "wrestlerid", "person_id", "personid", "uid"]) || slug(`worker-${index}`);
      if (linkedWorkerIds.size && !linkedWorkerIds.has(normalize(id))) return null;

      const linkedRow = workerLinks.get(normalize(id));
      const row = linkedRow ? { ...baseRow, ...linkedRow } : baseRow;
      const first = pickString(row, ["first_name", "firstname", "first"]);
      const last = pickString(row, ["last_name", "lastname", "last"]);
      const name =
        pickMappedString(row, table, mappingProfile, "Worker Name", [
          "name",
          "worker_name",
          "workername",
          "wrestler_name",
          "wrestlername",
          "ring_name",
          "ringname",
          "display_name",
          "short_name",
          "fullname",
          "full_name",
        ]) ||
        [first, last].filter(Boolean).join(" ").trim() ||
        "";
      if (!name) return null;

      const rawCompany =
        pickMappedString(row, table, mappingProfile, "Company", [
          "company",
          "promotion",
          "fed",
          "company_id",
          "companyid",
          "promotion_id",
          "promotionid",
          "fed_id",
          "contract_company",
        ]) || (linkedRow ? selectedPromotion : selectedPromotion);
      const company = linkedRow ? selectedPromotion : resolveLookup(companyLookup, rawCompany);
      const popularity = pickMappedNumber(row, table, mappingProfile, "Popularity", ["popularity", "pop", "overness", "popularity_value", "popularityvalue"]) ?? 0;
      const momentum = pickMappedNumber(row, table, mappingProfile, "Momentum", ["momentum"]) ?? 0;
      const overall = buildFallbackOverall({ popularity, momentum });

      const worker: WorkerProfile = {
        id: slug(`${id}-${name}`),
        rawId: id,
        name,
        overallRating: overall.overall,
        overallBreakdown: overall.breakdown,
        company,
        brandOrShow: resolveLookup(
          companyLookup,
          pickMappedString(row, table, mappingProfile, "Brand or Show", ["brand", "show", "brand_or_show", "show_id", "brand_id"]) || "",
        ),
        push: pickMappedString(row, table, mappingProfile, "Push", ["push", "card_position", "cardposition", "position", "push_name"]) || unknown,
        disposition:
          pickMappedString(row, table, mappingProfile, "Disposition", ["disposition", "alignment", "face_heel", "faceheel", "heel_face", "alignment_name"]) ||
          unknown,
        popularity,
        momentum,
        morale: pickMappedNumber(row, table, mappingProfile, "Morale", ["morale", "happiness"]) ?? 0,
        fatigue: pickMappedNumber(row, table, mappingProfile, "Fatigue", ["fatigue", "tiredness", "condition"]) ?? 0,
        injuryStatus: pickMappedString(row, table, mappingProfile, "Injury Status", ["injury_status", "injurystatus", "injury", "injured", "health_status"]) || unknown,
        contractStatus: pickMappedString(row, table, mappingProfile, "Contract Status", ["contract_status", "contractstatus", "contract", "contract_type", "status"]) || unknown,
        currentTitles: [],
        recentRecord: unknown,
        recentWins: 0,
        recentLosses: 0,
        recentOpponents: [],
        recentMatchCount: 0,
        recentSegmentCount: 0,
        recentMatchRatingAverage: null,
        last5MatchAverage: null,
        last10MatchAverage: null,
        recentSegmentRatingAverage: null,
        last5SegmentAverage: null,
        last10SegmentAverage: null,
        bestRecentMatch: null,
        worstRecentMatch: null,
        lastBooked: unknown,
        warnings: [],
        creativeNotes: { ...emptyCreativeNotes, ignoreFromAudit: ignoredWorkers.includes(slug(`${id}-${name}`)) },
      };

      return worker;
    })
    .filter(Boolean) as WorkerProfile[];

  const selected = workers.filter(
    (worker) =>
      promotionMatches(worker.company, selectedPromotion) ||
      promotionMatches(worker.brandOrShow, selectedPromotion) ||
      selectedPromotion === "Custom company",
  );

  return selected.length ? selected : workers;
}

function isPwsSchema(inspection: DatabaseInspection): boolean {
  return ["saveinfo", "promotions", "contracts", "workers", "segments", "opponents", "eventinstance"].every((name) =>
    Boolean(getTable(inspection, name)),
  );
}

function resolvePwsSelectedCompany(inspection: DatabaseInspection, selectedPromotion: string): { id: string; name: string } {
  const saveinfo = getTable(inspection, "saveinfo")?.sampleRows[0];
  const promotions = getTable(inspection, "promotions")?.sampleRows || [];
  const savedPromotionId = saveinfo ? pickString(saveinfo, ["saveUserPromotion"]) : null;
  const selected =
    promotions.find((row) => savedPromotionId && String(row.promotionID) === String(savedPromotionId)) ||
    promotions.find((row) => promotionMatches(String(row.shortName || ""), selectedPromotion) || promotionMatches(String(row.fullName || ""), selectedPromotion)) ||
    promotions[0];
  return {
    id: String(selected?.promotionID || savedPromotionId || selectedPromotion),
    name: String(selected?.shortName || selected?.fullName || selectedPromotion),
  };
}

function extractPwsWorkers(
  inspection: DatabaseInspection,
  promotionId: string,
  companyName: string,
  ignoredWorkers: string[],
): WorkerProfile[] {
  const contracts = getTable(inspection, "contracts")?.sampleRows || [];
  const workers = getTable(inspection, "workers")?.sampleRows || [];
  const brands = new Map((getTable(inspection, "brands")?.sampleRows || []).map((row) => [String(row.brandID), String(row.brandName || "")]));
  const workerById = new Map(workers.map((row) => [String(row.workerID), row]));

  const activeContractsByWorker = new Map<string, Record<string, unknown>>();
  contracts
    .filter((contract) => String(contract.promotionID) === String(promotionId))
    .filter((contract) => Number(contract.finalised) === 1 && Number(contract.expired) === 0 && Number(contract.suspended) === 0)
    .filter((contract) => !/announcer|referee|staff|personality/i.test(String(contract.push || "")))
    .forEach((contract) => {
      const workerId = String(contract.workerID || "");
      const current = activeContractsByWorker.get(workerId);
      if (!current || Number(contract.contractID || 0) > Number(current.contractID || 0)) {
        activeContractsByWorker.set(workerId, contract);
      }
    });

  return [...activeContractsByWorker.values()]
    .map((contract) => {
      const worker = workerById.get(String(contract.workerID)) || {};
      const name = String(worker.name || contract.contractName || `Worker ${contract.workerID}`);
      const id = String(contract.workerID || contract.contractID || name);
      const overall = buildPwsOverall(worker, contract);
      return {
        id: slug(`${id}-${name}`),
        rawId: id,
        name,
        overallRating: overall.overall,
        overallBreakdown: overall.breakdown,
        company: companyName,
        brandOrShow: brands.get(String(contract.brand)) || "",
        push: String(contract.push || unknown),
        disposition: String(contract.role || unknown),
        popularity: Math.round(pickNumber(worker, ["northAmericaPop", "starPower", "popularity"]) ?? 0),
        momentum: Math.round(pickNumber(contract, ["momentum"]) ?? 0),
        morale: Math.round(pickNumber(contract, ["morale"]) ?? 0),
        fatigue: Math.round(pickNumber(worker, ["fatigue"]) ?? 0),
        injuryStatus: String(worker.injuryType || worker.status || unknown),
        contractStatus: String(contract.contractType || unknown),
        currentTitles: [],
        recentRecord: unknown,
        recentWins: 0,
        recentLosses: 0,
        recentOpponents: [],
        recentMatchCount: 0,
        recentSegmentCount: 0,
        recentMatchRatingAverage: null,
        last5MatchAverage: null,
        last10MatchAverage: null,
        recentSegmentRatingAverage: null,
        last5SegmentAverage: null,
        last10SegmentAverage: null,
        bestRecentMatch: null,
        worstRecentMatch: null,
        lastBooked: String(contract.lastAppearance || unknown),
        warnings: [],
        creativeNotes: { ...emptyCreativeNotes, ignoreFromAudit: ignoredWorkers.includes(slug(`${id}-${name}`)) },
      };
    });
}

function extractPwsTitles(inspection: DatabaseInspection, promotionId: string): TitleRecord[] {
  const titles = getTable(inspection, "titles")?.sampleRows || [];
  const workers = new Map((getTable(inspection, "workers")?.sampleRows || []).map((row) => [String(row.workerID), String(row.name || "")]));
  const saveDate = String(getTable(inspection, "saveinfo")?.sampleRows[0]?.saveCurrentDate || "");

  return titles
    .filter((title) => String(title.promotionID) === String(promotionId) && Number(title.inactive) === 0)
    .map((title) => {
      const championIds = [title.currentChampion, title.currentChampion2, title.currentChampion3]
        .map((value) => String(value || "").trim())
        .filter(Boolean);
      const champions = championIds.map((id) => workers.get(id) || id).filter(Boolean);
      const won = String(title.won || unknown);
      return {
        id: String(title.titleID || title.name),
        name: String(title.name || unknown),
        company: String(promotionId),
        champion: champions.join(", ") || unknown,
        lastDefenceDate: won,
        daysSinceLastDefence: daysBetween(won, saveDate),
        recentDefences: Number(title.defences || 0),
        recentChallengers: [],
        warningStatus: titleSeverityFromDays(daysBetween(won, saveDate)),
        prestige: Math.round(Number(title.prestige || 0)),
        type: String(title.type || ""),
        genderLimits: String(title.genderLimits || ""),
      };
    })
    .sort((a, b) => (b.prestige ?? 0) - (a.prestige ?? 0) || a.name.localeCompare(b.name));
}

function extractPwsRivalries(inspection: DatabaseInspection, promotionId: string): RivalryRecord[] {
  const storylines = getTable(inspection, "storylines")?.sampleRows || [];
  const storylineWorkers = getTable(inspection, "storylineworkers")?.sampleRows || [];
  const histories = getTable(inspection, "storylinehistories")?.sampleRows || [];
  const contracts = new Map((getTable(inspection, "contracts")?.sampleRows || []).map((row) => [String(row.contractID), row]));
  const workers = new Map((getTable(inspection, "workers")?.sampleRows || []).map((row) => [String(row.workerID), String(row.name || "")]));
  const participantsByStoryline = groupRows(storylineWorkers, "storylineID");
  const historiesByStoryline = groupRows(histories, "storylineID");

  return storylines
    .filter((storyline) => String(storyline.promotionID) === String(promotionId))
    .filter((storyline) => Number(storyline.active) === 1 || !storyline.endDate)
    .map((storyline) => {
      const participantRows = participantsByStoryline.get(String(storyline.storylineID)) || [];
      const participants = unique(
        participantRows
          .map((row) => {
            const contract = contracts.get(String(row.contractID));
            return contract ? workers.get(String(contract.workerID)) || "" : "";
          })
          .filter(Boolean),
      );
      const ratings = (historiesByStoryline.get(String(storyline.storylineID)) || [])
        .map((row) => pickNumber(row, ["segmentRating"]))
        .filter(isNumber);
      const recent = ratings.slice(0, 5);
      const previous = ratings.slice(5, 10);
      const latestRating = ratings[0] ?? null;
      const averageRating = averageOrNull(recent);
      const previousAverage = averageOrNull(previous);
      const trend: RivalryRecord["trend"] =
        averageRating === null || previousAverage === null
          ? "Unmapped"
          : averageRating >= previousAverage + 4
            ? "Rising"
            : averageRating <= previousAverage - 4
              ? "Cooling"
              : "Stable";
      const status: Severity = trend === "Cooling" ? "High" : participants.length < 2 ? "Medium" : "Low";
      const healthLabel: RivalryRecord["healthLabel"] =
        participants.length < 2
          ? "Needs Participants"
          : trend === "Cooling"
            ? "Stale"
            : trend === "Rising"
              ? "Hot"
              : trend === "Unmapped"
                ? "Needs Data"
                : "Healthy";
      return {
        id: String(storyline.storylineID),
        name: String(storyline.storylineName || "Unnamed storyline"),
        active: Number(storyline.active) === 1,
        startDate: String(storyline.startDate || unknown),
        endDate: String(storyline.endDate || ""),
        participants,
        recentSegmentCount: ratings.length,
        averageRating,
        latestRating,
        trend,
        status,
        healthLabel,
        recommendation:
          trend === "Cooling"
            ? "Refresh the rivalry with a decisive angle, stipulation, turn, or a new supporting participant."
            : participants.length < 2
              ? "Add or confirm storyline participants so the rivalry can be audited properly."
              : "Keep building; recent segment ratings look usable.",
      };
    })
    .sort((a, b) => severityRank(b.status) - severityRank(a.status) || (b.averageRating ?? 0) - (a.averageRating ?? 0));
}

function extractPwsMatches(inspection: DatabaseInspection, promotionId: string): MatchRecord[] {
  return extractPwsRecords(inspection, promotionId, "Match") as MatchRecord[];
}

function extractPwsSegments(inspection: DatabaseInspection, promotionId: string): SegmentRecord[] {
  return extractPwsRecords(inspection, promotionId, "Angle") as SegmentRecord[];
}

function extractPwsRecords(
  inspection: DatabaseInspection,
  promotionId: string,
  segmentType: "Match" | "Angle",
): Array<MatchRecord | SegmentRecord> {
  const segments = getTable(inspection, "segments")?.sampleRows || [];
  const opponents = getTable(inspection, "opponents")?.sampleRows || [];
  const workers = new Map((getTable(inspection, "workers")?.sampleRows || []).map((row) => [String(row.workerID), String(row.name || "")]));
  const eventInstances = getTable(inspection, "eventinstance")?.sampleRows || [];
  const events = getTable(inspection, "events")?.sampleRows || [];
  const eventById = new Map(events.map((event) => [String(event.eventID), event]));
  const instanceById = new Map(
    eventInstances
      .filter((instance) => {
        const event = eventById.get(String(instance.eventID));
        return event && String(event.promotionID) === String(promotionId) && Number(instance.complete) === 1;
      })
      .map((instance) => [String(instance.instanceID), instance]),
  );
  const opponentsBySegment = groupRows(opponents, "segmentID");

  const records = segments
    .filter((segment) => String(segment.segmentType).toLowerCase() === segmentType.toLowerCase())
    .filter((segment) => instanceById.has(String(segment.showID)))
    .map((segment, index) => {
      const instance = instanceById.get(String(segment.showID));
      const event = instance ? eventById.get(String(instance.eventID)) : null;
      const participantRows = opponentsBySegment.get(String(segment.segmentID)) || [];
      const participants = unique(participantRows.map((row) => workers.get(String(row.workerID)) || String(row.workerName || "")).filter(Boolean));
      const sideParticipants = buildOpponentSides(participantRows, workers);
      const winner = workers.get(String(segment.winnerWorkerID)) || workers.get(String(segment.winner)) || String(segment.winnerName || "");
      const losers = unique(participantRows.filter((row) => winner && (workers.get(String(row.workerID)) || "") !== winner).map((row) => workers.get(String(row.workerID)) || "").filter(Boolean));
      const common = {
        id: String(segment.segmentID || `${segmentType}-${index}`),
        eventName: String(instance?.customName || event?.eventName || unknown),
        eventDate: String(instance?.airDate || unknown),
        participants,
        rating: pickNumber(segment, ["rating"]),
        showRating: pickNumber(instance || {}, ["score", "rawScore"]),
        length: String(segment.segmentLength || unknown),
      };

      if (segmentType === "Match") {
        return {
          ...common,
          showType: String(event?.importance || unknown),
          matchOrder: pickNumber(segment, ["segmentorder"]),
          matchType: String(segment.gimmick || segment.matchStoryID || segment.winType || unknown),
          sideParticipants,
          winner: winner || unknown,
          loser: losers.join(", ") || unknown,
          titleInvolved: "",
        } satisfies MatchRecord;
      }

      return {
        ...common,
        segmentOrder: pickNumber(segment, ["segmentorder"]),
        segmentType: String(segment.angleType || segment.purpose || "Angle"),
        storyline: String(segment.matchStoryID || ""),
        titleInvolved: String(segment.angleTitleChange || ""),
      } satisfies SegmentRecord;
    });

  return records;
}

function findWorkerTable(inspection: DatabaseInspection): TableInfo | null {
  return findBestTable(inspection.tables, {
    table: ["worker", "wrestler", "talent", "person", "people", "employee", "staff"],
    columns: ["name", "push", "popularity", "overness", "momentum", "morale", "fatigue", "disposition"],
  });
}

function buildCompanyCandidates(inspection: DatabaseInspection, promotions: string[]): CompanyCandidate[] {
  // PWS saves can vary by version/mod, so company detection blends filename,
  // company rows, roster/contract links, titles and event ownership instead of
  // relying on one hardcoded ROH table name.
  const filename = inspection.path.split(/[\\/]/).pop() || inspection.path;
  const workerTable = findWorkerTable(inspection);
  const titleTable = findBestTable(inspection.tables, {
    table: ["title", "championship", "belt"],
    columns: ["company", "promotion", "holder", "champion"],
  });
  const eventTable = findBestTable(inspection.tables, {
    table: ["event", "show", "card"],
    columns: ["company", "promotion", "date", "rating"],
  });
  const savedCompany = isPwsSchema(inspection) ? resolvePwsSelectedCompany(inspection, "") : null;

  return promotions
    .filter((promotion) => promotion !== "Custom company")
    .map((promotion) => {
      const reasons: string[] = [];
      let score = 0;
      const companyIds = findSelectedCompanyIds(inspection, promotion);
      const isSavedCompany = savedCompany && promotionMatches(savedCompany.name, promotion);

      if (isSavedCompany) {
        score += 50;
        reasons.push("saveinfo marks this as the user-booked promotion");
      }

      if (promotionMatches(filename, promotion)) {
        score += 30;
        reasons.push(`filename contains ${promotion}`);
      }
      if (companyIds.size > 1) {
        score += 20;
        reasons.push("company table contains a matching promotion record");
      }

      const activeRosterCount =
        isPwsSchema(inspection) && savedCompany && isSavedCompany
          ? countPwsActiveWrestlers(inspection, savedCompany.id)
          : workerTable
            ? findCompanyWorkerLinks(inspection, workerTable, companyIds, promotion).size
            : 0;
      if (activeRosterCount > 0) {
        score += Math.min(30, 10 + Math.floor(activeRosterCount / 4));
        reasons.push(`${activeRosterCount} active workers linked`);
      }

      const titlesCount = isPwsSchema(inspection) && savedCompany && isSavedCompany
        ? (getTable(inspection, "titles")?.sampleRows || []).filter((title) => String(title.promotionID) === String(savedCompany.id) && Number(title.inactive) === 0).length
        : titleTable
        ? titleTable.sampleRows.filter((row) => {
            const raw = pickString(row, ["company", "promotion", "company_id", "promotion_id", "fed"]) || "";
            return promotionMatches(raw, promotion) || companyIds.has(normalize(raw));
          }).length
        : 0;
      if (titlesCount > 0) {
        score += Math.min(12, titlesCount * 2);
        reasons.push(`${titlesCount} titles linked`);
      }

      const recentEventsCount = isPwsSchema(inspection) && savedCompany && isSavedCompany
        ? countPwsRecentEvents(inspection, savedCompany.id)
        : eventTable
        ? eventTable.sampleRows.filter((row) => {
            const raw = pickString(row, ["company", "promotion", "company_id", "promotion_id", "company_name", "promotion_name", "fed"]) || "";
            return promotionMatches(raw, promotion) || companyIds.has(normalize(raw));
          }).length
        : 0;
      if (recentEventsCount > 0) {
        score += Math.min(18, recentEventsCount * 2);
        reasons.push(`${recentEventsCount} recent events found`);
      }

      if (!reasons.length) reasons.push("detected from database company values");

      return {
        name: promotion,
        confidence: Math.min(99, score),
        activeRosterCount,
        recentEventsCount,
        titlesCount,
        reasons,
      };
    })
    .sort((a, b) => b.confidence - a.confidence || b.activeRosterCount - a.activeRosterCount || b.recentEventsCount - a.recentEventsCount);
}

function buildImportSummary(
  selectedPromotion: string,
  companyCandidates: CompanyCandidate[],
  workers: WorkerProfile[],
  titles: TitleRecord[],
  matches: MatchRecord[],
  segments: SegmentRecord[],
  unmapped: string[],
): ImportSummary {
  const selectedCandidate =
    companyCandidates.find((candidate) => promotionMatches(candidate.name, selectedPromotion)) ||
    companyCandidates[0];
  const confidence = selectedCandidate?.confidence ?? (workers.length ? 55 : 0);
  return {
    detectedCompany: selectedCandidate?.name || selectedPromotion || "Not detected",
    confidence,
    confidenceLevel: confidence >= 80 ? "High" : confidence >= 50 ? "Medium" : "Low",
    activeRosterCount: workers.length,
    titlesFound: titles.length,
    recentEventsFound: countUniqueEvents(matches, segments),
    matchesFound: matches.length,
    segmentsFound: segments.length,
    unmappedFields: unmapped,
  };
}

function countPwsActiveWrestlers(inspection: DatabaseInspection, promotionId: string): number {
  return (getTable(inspection, "contracts")?.sampleRows || []).filter(
    (contract) =>
      String(contract.promotionID) === String(promotionId) &&
      Number(contract.finalised) === 1 &&
      Number(contract.expired) === 0 &&
      Number(contract.suspended) === 0 &&
      !/announcer|referee|staff|personality/i.test(String(contract.push || "")),
  ).length;
}

function countPwsRecentEvents(inspection: DatabaseInspection, promotionId: string): number {
  const events = new Map((getTable(inspection, "events")?.sampleRows || []).map((event) => [String(event.eventID), event]));
  return (getTable(inspection, "eventinstance")?.sampleRows || []).filter((instance) => {
    const event = events.get(String(instance.eventID));
    return event && String(event.promotionID) === String(promotionId) && Number(instance.complete) === 1;
  }).length;
}

function countUniqueEvents(matches: MatchRecord[], segments: SegmentRecord[]): number {
  const events = new Set(
    [...matches.map((match) => `${match.eventName}-${match.eventDate}`), ...segments.map((segment) => `${segment.eventName}-${segment.eventDate}`)]
      .filter((value) => value && !value.includes(unknown)),
  );
  return events.size;
}

function findSelectedCompanyIds(inspection: DatabaseInspection, selectedPromotion: string): Set<string> {
  const ids = new Set<string>();
  const companyTables = inspection.tables.filter((table) => /company|promotion|fed/i.test(table.name));
  companyTables.forEach((table) => {
    table.sampleRows.forEach((row) => {
      const name = pickString(row, ["name", "company", "promotion", "fed", "company_name", "promotion_name", "short_name", "abbreviation"]);
      if (!name || !promotionMatches(name, selectedPromotion)) return;
      ids.add(normalize(name));
      ["id", "company_id", "companyid", "promotion_id", "promotionid", "fed_id", "fedid", "uid"].forEach((key) => {
        const id = pickString(row, [key]);
        if (id) ids.add(normalize(id));
      });
    });
  });
  ids.add(normalize(selectedPromotion));
  return ids;
}

function buildEventLookup(inspection: DatabaseInspection): Map<string, { name: string; date: string }> {
  const lookup = new Map<string, { name: string; date: string }>();
  const eventTables = inspection.tables.filter((table) => /event|show|card/i.test(table.name));
  eventTables.forEach((table) => {
    table.sampleRows.forEach((row, index) => {
      const id = pickString(row, ["id", "event_id", "eventid", "show_id", "showid", "card_id", "cardid", "uid"]) || `${table.name}-${index}`;
      const name = pickString(row, ["name", "event", "event_name", "show", "show_name", "card", "card_name"]) || unknown;
      const date = pickString(row, ["date", "event_date", "show_date", "datetime", "held_on"]) || unknown;
      lookup.set(normalize(id), { name, date });
    });
  });
  return lookup;
}

function buildRecordParticipants(
  inspection: DatabaseInspection,
  recordTable: TableInfo,
  workerLookup: Record<string, string>,
  kind: "match" | "segment",
): Map<string, string[]> {
  const recordIds = new Set(
    recordTable.sampleRows
      .map((row) => pickString(row, ["id", `${kind}_id`, `${kind}id`, "angle_id", "angleid", "uid"]))
      .filter(Boolean)
      .map((id) => normalize(id || "")),
  );
  const result = new Map<string, string[]>();

  inspection.tables.forEach((table) => {
    const columns = table.columns.map((column) => column.name);
    const recordColumn =
      kind === "match"
        ? bestColumn(columns, ["match_id", "matchid", "bout_id", "boutid", "result_id", "resultid"])
        : bestColumn(columns, ["segment_id", "segmentid", "angle_id", "angleid", "promo_id", "promoid"]);
    const workerColumn = bestColumn(columns, ["worker_id", "workerid", "wrestler_id", "wrestlerid", "person_id", "personid", "participant_id", "participantid"]);
    if (!recordColumn || !workerColumn) return;
    if (!/participant|worker|wrestler|match|segment|angle|people|person/i.test(table.name)) return;

    table.sampleRows.forEach((row) => {
      const recordId = normalize(String(row[recordColumn] ?? ""));
      const workerId = String(row[workerColumn] ?? "");
      if (!recordIds.has(recordId)) return;
      const participant = resolveLookup(workerLookup, workerId);
      if (!participant || participant === workerId) return;
      result.set(recordId, [...(result.get(recordId) || []), participant]);
    });
  });

  return result;
}

function findCompanyWorkerLinks(
  inspection: DatabaseInspection,
  workerTable: TableInfo,
  selectedCompanyIds: Set<string>,
  selectedPromotion: string,
): Map<string, Record<string, unknown>> {
  // Active roster membership is usually stored outside the worker table.
  // This scans relationship-style tables for worker/company foreign-key pairs
  // and merges the matching row back into the worker profile extraction.
  const workerIds = new Set(
    workerTable.sampleRows
      .map((row) => pickString(row, ["id", "worker_id", "workerid", "wrestler_id", "wrestlerid", "person_id", "personid", "uid"]))
      .filter(Boolean)
      .map((id) => normalize(id || "")),
  );
  const links = new Map<string, Record<string, unknown>>();

  inspection.tables.forEach((table) => {
    const columns = table.columns.map((column) => column.name);
    const workerColumn = bestColumn(columns, ["worker_id", "workerid", "wrestler_id", "wrestlerid", "person_id", "personid", "employee_id", "talent_id"]);
    const companyColumn = bestColumn(columns, ["company_id", "companyid", "promotion_id", "promotionid", "fed_id", "fedid", "company", "promotion", "fed"]);
    if (!workerColumn || !companyColumn) return;

    const tableLooksUseful = /contract|roster|employment|company|promotion|worker|wrestler|talent/i.test(table.name);
    if (!tableLooksUseful) return;

    table.sampleRows.forEach((row) => {
      const workerId = normalize(String(row[workerColumn] ?? ""));
      const companyId = normalize(String(row[companyColumn] ?? ""));
      if (!workerIds.has(workerId)) return;
      if (!selectedCompanyIds.has(companyId) && companyId !== normalize(selectedPromotion)) return;
      if (isInactiveLink(row)) return;
      links.set(workerId, row);
    });
  });

  return links;
}

function extractTitles(
  inspection: DatabaseInspection,
  selectedPromotion: string,
  companyLookup: Record<string, string>,
  workerLookup: Record<string, string>,
  mappingProfile?: MappingProfile,
): TitleRecord[] {
  const table = findMappedTable(inspection, mappingProfile, "Current Title") || findMappedTable(inspection, mappingProfile, "Title Holder") || findBestTable(inspection.tables, {
    table: ["title", "championship", "belt"],
    columns: ["champion", "holder", "company", "promotion", "prestige"],
  });
  if (!table) return [];

  return table.sampleRows
    .map((row, index) => {
      const name = pickMappedString(row, table, mappingProfile, "Current Title", ["name", "title", "title_name", "championship", "belt_name"]) || `Title ${index + 1}`;
      const company = resolveLookup(
        companyLookup,
        pickMappedString(row, table, mappingProfile, "Company", ["company", "promotion", "company_id", "promotion_id", "fed"]) || selectedPromotion,
      );
      const champion = resolveLookup(
        workerLookup,
        pickMappedString(row, table, mappingProfile, "Title Holder", ["champion", "holder", "title_holder", "champion_id", "holder_id", "worker_id"]) || unknown,
      );
      const lastDefenceDate = pickString(row, ["last_defence", "lastdefence", "last_defense", "lastdefense", "last_defence_date"]) || unknown;
      return {
        id: pickString(row, ["id", "title_id", "titleid", "uid"]) || slug(name),
        name,
        company,
        champion,
        lastDefenceDate,
        daysSinceLastDefence: daysSince(lastDefenceDate),
        recentDefences: pickNumber(row, ["recent_defences", "defences", "defenses"]) ?? 0,
        recentChallengers: splitParticipants(pickString(row, ["challengers", "recent_challengers"]) || ""),
        warningStatus: titleSeverity(lastDefenceDate),
      };
    })
    .filter((title) => promotionMatches(title.company, selectedPromotion) || selectedPromotion === "Custom company" || title.company === unknown);
}

function extractMatches(inspection: DatabaseInspection, workerLookup: Record<string, string>, mappingProfile?: MappingProfile): MatchRecord[] {
  const table = findMappedTable(inspection, mappingProfile, "Match Rating") || findMappedTable(inspection, mappingProfile, "Match Participants") || findBestTable(inspection.tables, {
    table: ["match", "bout", "result"],
    columns: ["rating", "winner", "loser", "participant", "event", "show"],
  });
  if (!table) return [];

  const participantsByMatch = buildRecordParticipants(inspection, table, workerLookup, "match");
  const eventLookup = buildEventLookup(inspection);

  return table.sampleRows.map((row, index) => {
    const recordId = pickString(row, ["id", "match_id", "matchid", "uid"]) || `match-${index}`;
    const participants = splitParticipants(
      pickMappedString(row, table, mappingProfile, "Match Participants", ["participants", "workers", "worker_names", "wrestlers", "competitors"]) ||
        (participantsByMatch.get(normalize(recordId)) || []).join(", ") ||
        [
          pickString(row, ["worker1", "worker_1", "participant1", "participant_1"]),
          pickString(row, ["worker2", "worker_2", "participant2", "participant_2"]),
          pickString(row, ["team1", "team_1"]),
          pickString(row, ["team2", "team_2"]),
        ]
          .filter(Boolean)
          .map((value) => resolveLookup(workerLookup, value || ""))
        .join(", "),
    ).map((value) => resolveLookup(workerLookup, value));
    const eventId = pickString(row, ["event_id", "eventid", "show_id", "showid", "card_id", "cardid"]);
    const event = eventId ? eventLookup.get(normalize(eventId)) : null;

    return {
      id: recordId,
      eventName: pickMappedString(row, table, mappingProfile, "Event Name", ["event", "event_name", "show", "show_name", "card"]) || event?.name || unknown,
      eventDate: pickMappedString(row, table, mappingProfile, "Event Date", ["date", "event_date", "show_date", "datetime"]) || event?.date || unknown,
      showType: pickMappedString(row, table, mappingProfile, "Show Type", ["show_type", "showtype", "event_type", "type"]) || unknown,
      matchOrder: pickMappedNumber(row, table, mappingProfile, "Match Order", ["match_order", "order", "segment_order", "position"]),
      matchType: pickMappedString(row, table, mappingProfile, "Match Type", ["match_type", "matchtype", "type", "stipulation"]) || unknown,
      participants,
      winner: resolveLookup(workerLookup, pickMappedString(row, table, mappingProfile, "Match Winner", ["winner", "winner_id", "winnerid"]) || unknown),
      loser: resolveLookup(workerLookup, pickMappedString(row, table, mappingProfile, "Match Loser", ["loser", "loser_id", "loserid"]) || unknown),
      titleInvolved: pickString(row, ["title", "title_name", "title_involved", "championship"]) || "",
      rating: pickMappedNumber(row, table, mappingProfile, "Match Rating", ["rating", "match_rating", "matchrating", "score"]),
      showRating: pickMappedNumber(row, table, mappingProfile, "Show Rating", ["show_rating", "showrating", "event_rating"]),
      length: pickMappedString(row, table, mappingProfile, "Match Length", ["length", "duration", "match_length", "time"]) || unknown,
    };
  });
}

function extractSegments(inspection: DatabaseInspection, workerLookup: Record<string, string>, mappingProfile?: MappingProfile): SegmentRecord[] {
  const table = findMappedTable(inspection, mappingProfile, "Segment Rating") || findMappedTable(inspection, mappingProfile, "Segment Participants") || findBestTable(inspection.tables, {
    table: ["segment", "angle", "promo", "skit"],
    columns: ["rating", "participant", "event", "show", "storyline"],
  });
  if (!table) return [];

  const participantsBySegment = buildRecordParticipants(inspection, table, workerLookup, "segment");
  const eventLookup = buildEventLookup(inspection);

  return table.sampleRows.map((row, index) => {
    const recordId = pickString(row, ["id", "segment_id", "angle_id", "uid"]) || `segment-${index}`;
    const participants = splitParticipants(
      pickMappedString(row, table, mappingProfile, "Segment Participants", ["participants", "workers", "worker_names", "people"]) ||
        (participantsBySegment.get(normalize(recordId)) || []).join(", ") ||
        [pickString(row, ["worker1", "participant1"]), pickString(row, ["worker2", "participant2"])]
          .filter(Boolean)
          .join(", "),
    ).map((value) => resolveLookup(workerLookup, value));
    const eventId = pickString(row, ["event_id", "eventid", "show_id", "showid", "card_id", "cardid"]);
    const event = eventId ? eventLookup.get(normalize(eventId)) : null;

    return {
      id: recordId,
      eventName: pickMappedString(row, table, mappingProfile, "Event Name", ["event", "event_name", "show", "show_name"]) || event?.name || unknown,
      eventDate: pickMappedString(row, table, mappingProfile, "Event Date", ["date", "event_date", "show_date", "datetime"]) || event?.date || unknown,
      segmentOrder: pickMappedNumber(row, table, mappingProfile, "Segment Order", ["segment_order", "order", "position"]),
      segmentType: pickMappedString(row, table, mappingProfile, "Segment Type", ["segment_type", "angle_type", "type"]) || unknown,
      participants,
      storyline: pickString(row, ["storyline", "feud", "story"]) || "",
      titleInvolved: pickString(row, ["title", "title_name", "title_involved"]) || "",
      rating: pickMappedNumber(row, table, mappingProfile, "Segment Rating", ["rating", "segment_rating", "angle_rating", "score"]),
      showRating: pickMappedNumber(row, table, mappingProfile, "Show Rating", ["show_rating", "showrating", "event_rating"]),
      length: pickMappedString(row, table, mappingProfile, "Segment Length", ["length", "duration", "segment_length", "time"]) || unknown,
    };
  });
}

function enrichWorkers(
  workers: WorkerProfile[],
  matches: MatchRecord[],
  segments: SegmentRecord[],
  titles: TitleRecord[],
): WorkerProfile[] {
  return workers.map((worker) => {
    const workerKey = normalize(worker.name);
    const workerMatches = matches
      .filter((match) => recordIncludes(match.participants, worker.name) || normalize(match.winner) === workerKey || normalize(match.loser) === workerKey)
      .sort((a, b) => dateSortValue(b.eventDate) - dateSortValue(a.eventDate));
    const workerSegments = segments
      .filter((segment) => recordIncludes(segment.participants, worker.name))
      .sort((a, b) => dateSortValue(b.eventDate) - dateSortValue(a.eventDate));
    const wins = workerMatches.filter((match) => normalize(match.winner) === workerKey).length;
    const losses = workerMatches.filter((match) => normalize(match.loser) === workerKey).length;
    const matchRatings = workerMatches.map((match) => match.rating).filter(isNumber);
    const segmentRatings = workerSegments.map((segment) => segment.rating).filter(isNumber);
    const currentTitles = titles.filter((title) => normalize(title.champion) === workerKey).map((title) => title.name);
    const warnings = buildWorkerWarnings(worker, wins, losses, matchRatings, segmentRatings);
    const bestRecentMatch = [...workerMatches]
      .filter((match) => isNumber(match.rating))
      .sort((a, b) => (b.rating ?? 0) - (a.rating ?? 0))[0];
    const worstRecentMatch = [...workerMatches]
      .filter((match) => isNumber(match.rating))
      .sort((a, b) => (a.rating ?? 0) - (b.rating ?? 0))[0];

    return {
      ...worker,
      currentTitles,
      recentRecord: workerMatches.length ? `${wins}-${losses}` : unknown,
      recentWins: wins,
      recentLosses: losses,
      recentOpponents: unique(
        workerMatches.flatMap((match) => match.participants.filter((participant) => normalize(participant) !== workerKey)),
      ).slice(0, 10),
      recentMatchCount: workerMatches.length,
      recentSegmentCount: workerSegments.length,
      recentMatchRatingAverage: averageOrNull(matchRatings.slice(0, 10)),
      last5MatchAverage: averageOrNull(matchRatings.slice(0, 5)),
      last10MatchAverage: averageOrNull(matchRatings.slice(0, 10)),
      recentSegmentRatingAverage: averageOrNull(segmentRatings.slice(0, 10)),
      last5SegmentAverage: averageOrNull(segmentRatings.slice(0, 5)),
      last10SegmentAverage: averageOrNull(segmentRatings.slice(0, 10)),
      bestRecentMatch: bestRecentMatch ? `${bestRecentMatch.eventName}: ${bestRecentMatch.rating}` : null,
      worstRecentMatch: worstRecentMatch ? `${worstRecentMatch.eventName}: ${worstRecentMatch.rating}` : null,
      lastBooked: latestKnownDate([...workerMatches.map((match) => match.eventDate), ...workerSegments.map((segment) => segment.eventDate)]),
      warnings,
    };
  });
}

function buildWorkerWarnings(
  worker: WorkerProfile,
  wins: number,
  losses: number,
  matchRatings: number[],
  segmentRatings: number[],
): string[] {
  const warnings: string[] = [];
  if (worker.fatigue >= 70) warnings.push("High fatigue risk");
  if (worker.morale > 0 && worker.morale <= 35) warnings.push("Low morale risk");
  if (losses >= wins + 3 && wins + losses >= 4) warnings.push("Losing too often");
  if (/main|upper/i.test(worker.push) && losses > wins && wins + losses >= 3) warnings.push("Credibility risk for Push group");
  if (averageOrNull(matchRatings.slice(0, 5)) !== null && averageOrNull(segmentRatings.slice(0, 5)) !== null) {
    const matchAverage = averageOrNull(matchRatings.slice(0, 5)) ?? 0;
    const segmentAverage = averageOrNull(segmentRatings.slice(0, 5)) ?? 0;
    if (matchAverage - segmentAverage >= 10) warnings.push("Better in matches than segments");
    if (segmentAverage - matchAverage >= 10) warnings.push("Better in segments than matches");
  }
  if (!warnings.length) warnings.push("No major warnings");
  return warnings;
}

function dedupeAnalysisWorkers(workers: WorkerProfile[]): WorkerProfile[] {
  const byWorker = new Map<string, WorkerProfile>();
  workers.forEach((worker) => {
    const key = worker.rawId ? `id:${worker.rawId}` : `name:${normalize(worker.name)}`;
    const current = byWorker.get(key);
    if (!current || workerQualityScore(worker) > workerQualityScore(current)) {
      byWorker.set(key, worker);
    }
  });
  return [...byWorker.values()].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
}

function workerQualityScore(worker: WorkerProfile): number {
  return (
    (worker.popularity || 0) +
    (worker.momentum || 0) +
    (worker.recentMatchCount || 0) * 5 +
    (worker.recentSegmentCount || 0) * 3 +
    (worker.currentTitles.length ? 100 : 0)
  );
}

function topRosterSlice(workers: WorkerProfile[], ratio: number): WorkerProfile[] {
  const sorted = [...workers].sort((a, b) => workerImportanceScore(b) - workerImportanceScore(a));
  return sorted.slice(0, Math.max(1, Math.ceil(sorted.length * ratio)));
}

function workerImportanceScore(worker: WorkerProfile): number {
  return (
    pushTier(worker.push) * 100 +
    (worker.popularity || 0) * 0.8 +
    (worker.momentum || 0) * 0.6 +
    (worker.currentTitles.length ? 75 : 0)
  );
}

function buildPwsOverall(worker: Record<string, unknown>, contract: Record<string, unknown>): { overall: number; breakdown: WorkerOverallBreakdown } {
  const starPower = pwsNumber(worker, ["starPower"]);
  const popularity = pwsNumber(worker, ["northAmericaPop", "popularity"]);
  const wrestlingAbility = averageScore([
    pwsNumber(worker, ["wrestlingSkill"]),
    averageScore([
      pwsNumber(worker, ["brawling"]),
      pwsNumber(worker, ["technical"]),
      pwsNumber(worker, ["aerial"]),
      pwsNumber(worker, ["puroresu"]),
    ]),
    pwsNumber(worker, ["basics"]),
    pwsNumber(worker, ["athleticism"]),
  ]);
  const psychology = pwsNumber(worker, ["psychology"]);
  const entertainment = averageScore([
    pwsNumber(worker, ["entertainment"]),
    pwsNumber(worker, ["charisma"]),
    pwsNumber(worker, ["acting"]),
  ]);
  const marketability = averageScore([
    starPower,
    pwsNumber(worker, ["sexAppeal"]),
    pwsNumber(worker, ["intimidation"]),
    pwsNumber(worker, ["charisma"]),
    pwsNumber(worker, ["entertainment"]),
    popularity,
  ]);
  const reliability = averageScore([
    pwsNumber(worker, ["consistency"]),
    pwsNumber(worker, ["safety"]),
    pwsNumber(worker, ["stamina"]),
    pwsNumber(worker, ["toughness"]),
    pwsNumber(worker, ["resilience"]),
  ]);
  const momentum = pwsNumber(contract, ["momentum"]);
  const breakdown = {
    marketability,
    starPower,
    popularity,
    wrestlingAbility,
    psychology,
    entertainment,
    reliability,
  };

  return {
    overall: weightedOverall([
      [marketability, 0.2],
      [starPower, 0.15],
      [popularity, 0.15],
      [wrestlingAbility, 0.2],
      [psychology, 0.15],
      [entertainment, 0.1],
      [reliability, 0.03],
      [momentum, 0.02],
    ]),
    breakdown,
  };
}

function buildFallbackOverall(values: { popularity: number; momentum: number }): { overall: number; breakdown: WorkerOverallBreakdown } {
  const popularity = clampScore(values.popularity);
  const momentum = clampScore(values.momentum);
  const baseline = averageScore([popularity, momentum]);
  const breakdown = {
    marketability: popularity,
    starPower: baseline,
    popularity,
    wrestlingAbility: baseline,
    psychology: baseline,
    entertainment: baseline,
    reliability: baseline,
  };
  return {
    overall: weightedOverall([
      [breakdown.marketability, 0.2],
      [breakdown.starPower, 0.15],
      [breakdown.popularity, 0.15],
      [breakdown.wrestlingAbility, 0.2],
      [breakdown.psychology, 0.15],
      [breakdown.entertainment, 0.1],
      [breakdown.reliability, 0.05],
    ]),
    breakdown,
  };
}

function buildPushMismatch(workers: WorkerProfile[]): PushMismatchResult[] {
  const popularityValues = workers.map((worker) => worker.popularity).filter((value) => value > 0);
  const momentumValues = workers.map((worker) => worker.momentum).filter((value) => value > 0);

  return workers.map((worker) => {
    const score = pushFitScore(worker, popularityValues, momentumValues);
    const recommendedTier = recommendedPushTier(score);
    const officialTier = pushTier(worker.push);
    const recommendedTierValue = pushTier(recommendedTier);
    const delta = officialTier - recommendedTierValue;
    const upwardDelta = recommendedTierValue - officialTier;
    const label =
      worker.creativeNotes.creativeOverrideActive
        ? "Creative Override Active"
        : delta >= 2
          ? "High Push Mismatch"
          : delta === 1 && worker.momentum < 50
            ? "Medium Push Mismatch"
            : upwardDelta >= 2
              ? "Under-positioned"
              : upwardDelta === 1 && worker.momentum >= 65
                ? "Possible Upward Movement"
                : "Correctly Positioned";

    return {
      worker,
      officialPush: worker.push,
      recommendedTier,
      score,
      label,
      severity: label.includes("High") ? "High" : label.includes("Medium") || label.includes("Under") ? "Medium" : "Low",
      mismatchDelta: Math.abs(officialTier - recommendedTierValue),
      evidence: [
        `Popularity ${worker.popularity || unknown}`,
        `Momentum ${worker.momentum || unknown}`,
        `Recent record ${worker.recentRecord}`,
        `Match average ${worker.recentMatchRatingAverage ?? unknown}`,
        `Segment average ${worker.recentSegmentRatingAverage ?? unknown}`,
      ],
      suggestedAction:
        label === "Possible Upward Movement" || label === "Under-positioned"
          ? "Test them against a higher Push worker, use a title eliminator, or review their in-game Push if the trend continues."
          : label.includes("Mismatch")
            ? "Give credible wins, move them away from immediate title focus, cool them down, or mark Creative Override Active if intentional."
            : "Keep current direction and monitor ratings, momentum, morale and fatigue.",
    };
  });
}

function buildDiagnostics(
  workers: WorkerProfile[],
  titles: TitleRecord[],
  matches: MatchRecord[],
  segments: SegmentRecord[],
  pushMismatch: PushMismatchResult[],
  rivalries: RivalryRecord[],
): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const add = (
    problem: string,
    severity: Severity,
    evidence: string,
    whyItMatters: string,
    suggestedFix: string,
    exampleBookingAction: string,
  ) =>
    diagnostics.push({
      id: slug(`${problem}-${diagnostics.length}`),
      problem,
      severity,
      evidence,
      whyItMatters,
      suggestedFix,
      exampleBookingAction,
    });

  titles
    .filter((title) => title.warningStatus !== "Low")
    .slice(0, 6)
    .forEach((title) =>
      add(
        "Champion has not defended recently.",
        title.warningStatus,
        `${title.name} champion ${title.champion || unknown}; last defence ${title.lastDefenceDate}.`,
        "Long title inactivity can make the championship feel less important.",
        "Book a title defence or establish a clear number one contender.",
        "Run a contender match on the next show and announce the title match for the next major event.",
      ),
    );

  const topHalfWorkers = topRosterSlice(workers, 0.5);
  const importantWorkers = topRosterSlice(workers, 0.65);

  importantWorkers
    .filter((worker) => worker.warnings.some((warning) => warning.includes("fatigue")))
    .sort((a, b) => workerImportanceScore(b) - workerImportanceScore(a) || b.fatigue - a.fatigue)
    .slice(0, 5)
    .forEach((worker) =>
      add(
        "High fatigue risk.",
        worker.fatigue >= 85 ? "Critical" : "High",
        `${worker.name} fatigue is ${worker.fatigue}.`,
        "Overusing tired workers can damage availability and booking flexibility.",
        "Rest the worker or use a safer segment instead of another demanding match.",
        "Feature them in a protected promo, manager angle or tag match with limited involvement.",
      ),
    );

  importantWorkers
    .filter((worker) => worker.morale <= 35)
    .sort((a, b) => workerImportanceScore(b) - workerImportanceScore(a) || a.morale - b.morale)
    .slice(0, 5)
    .forEach((worker) =>
      add(
        "Low morale risk.",
        /main|upper/i.test(worker.push) && worker.morale <= 35 ? "Critical" : worker.morale <= 20 ? "High" : "Medium",
        `${worker.name} morale is ${worker.morale}.`,
        "Low morale can turn a useful roster member into an availability or contract risk.",
        "Give the worker a clear creative beat, a win, or a lighter schedule depending on their role.",
        "Book a decisive TV win or a protected segment that reinforces their direction.",
      ),
    );

  topHalfWorkers
    .filter((worker) => worker.lastBooked === unknown || (daysSince(worker.lastBooked) ?? 0) >= 30)
    .sort((a, b) => workerImportanceScore(b) - workerImportanceScore(a))
    .slice(0, 8)
    .forEach((worker) =>
      add(
        "Worker has not been booked recently.",
        /main/i.test(worker.push) ? "Critical" : /upper/i.test(worker.push) ? "High" : "Medium",
        `${worker.name} last booked: ${worker.lastBooked}. Official Push: ${worker.push}.`,
        "Long gaps can cool momentum, especially for workers expected to matter on the card.",
        "Either book them soon, add a Creative Plan, or mark Ignore from Audit if they are intentionally inactive.",
        "Use them in a fresh match, short angle, or contender-building segment on the next show.",
      ),
    );

  const mainEventWorkers = workers.filter((worker) => /main/i.test(worker.push));
  if (mainEventWorkers.length > 0 && mainEventWorkers.length / Math.max(1, workers.length) > 0.18) {
    add(
      "Main Event Push group may be overused.",
      "Medium",
      `${mainEventWorkers.length} of ${workers.length} active workers have Main Event Push.`,
      "Too many Main Event workers can make the official card structure feel flat.",
      "Protect the true top tier and review whether some workers need a rebuild before being presented at that level.",
      "Give the strongest contenders meaningful wins while cooling directionless Main Event workers away from title focus.",
    );
  }

  const faceCount = workers.filter((worker) => /face|baby/i.test(worker.disposition)).length;
  const heelCount = workers.filter((worker) => /heel/i.test(worker.disposition)).length;
  if (faceCount && heelCount && Math.max(faceCount, heelCount) / Math.max(1, Math.min(faceCount, heelCount)) >= 1.8) {
    add(
      "Disposition balance looks uneven.",
      "Medium",
      `${faceCount} face/babyface workers and ${heelCount} heel workers detected.`,
      "A lopsided alignment split can make fresh programmes harder to book.",
      "Plan a turn, bring in an opposing act, or rotate matchups to avoid repeating the same pairings.",
      "Set up a Planned Turn for a midcard act who can help the weaker side of the roster.",
    );
  }

  pushMismatch
    .filter((item) => item.label !== "Correctly Positioned")
    .slice(0, 6)
    .forEach((item) =>
      add(
        item.label,
        item.severity,
        `${item.worker.name}: Official Push ${item.officialPush}; recommended ${item.recommendedTier}; score ${item.score}.`,
        "Official Push should broadly match current popularity, momentum, credibility, ratings and availability unless there is an intentional creative reason.",
        item.suggestedAction,
        item.label.includes("Upward") || item.label.includes("Under")
          ? "Book them against a higher Push worker or put them in a title eliminator."
          : "Give two or three credible wins, or mark Creative Override Active if this is deliberate.",
      ),
    );

  if (!matches.length) {
    add(
      "No completed match ratings mapped yet.",
      "Medium",
      "No match table or match rating field was confidently detected.",
      "Ratings analytics are strongest when they use completed match results from the save.",
      "Confirm Match Rating, Match Participants, Event Name and Event Date in Database Mapping.",
      "Map match fields once, then re-import the save.",
    );
  }

  if (!segments.length) {
    add(
      "No completed segment ratings mapped yet.",
      "Medium",
      "No segment or angle rating field was confidently detected.",
      "Segment trends are needed to identify strong promo performers and cooling storylines.",
      "Confirm Segment Rating, Segment Participants, Segment Type and Event Date in Database Mapping.",
      "Map segment fields once, then re-import the save.",
    );
  }

  const repetitivePairs = repeatedPairings(matches);
  repetitivePairs.slice(0, 3).forEach((pair) =>
    add(
      "Repetitive matchup risk.",
      "Medium",
      `${pair.pair} appears ${pair.count} times in imported completed matches.`,
      "Repeated matches can cool off otherwise useful programmes.",
      "Rotate the matchup format or move the rivalry forward with a different booking beat.",
      "Use a different opponent, stipulation escalation, angle, or contender path instead of repeating the same matchup.",
    ),
  );

  rivalries
    .filter((rivalry) => rivalry.status !== "Low")
    .slice(0, 5)
    .forEach((rivalry) =>
      add(
        rivalry.trend === "Cooling" ? "Storyline is cooling." : "Storyline mapping needs attention.",
        rivalry.status,
        `${rivalry.name}: ${rivalry.trend}; average rating ${rivalry.averageRating ?? unknown}; participants ${rivalry.participants.join(", ") || unknown}.`,
        "Cold or unclear rivalries make weekly booking feel less purposeful.",
        rivalry.recommendation,
        "Book a focused angle this week, then follow with a match or clear next step on the next show.",
      ),
    );

  return diagnostics.sort((a, b) => diagnosticPriorityScore(b) - diagnosticPriorityScore(a));
}

function buildWeeklyPriorities(diagnostics: Diagnostic[]): WeeklyPriority[] {
  const sorted = [...diagnostics]
    .sort((a, b) => diagnosticPriorityScore(b) - diagnosticPriorityScore(a))
    .slice(0, 5);
  return sorted.map((diagnostic, index) => ({
    priorityNumber: index + 1,
    issue: diagnostic.problem,
    suggestedAction: diagnostic.suggestedFix,
    relatedItem: diagnostic.evidence,
    severity: diagnostic.severity,
    supportingEvidence: diagnostic.whyItMatters,
  }));
}

function diagnosticPriorityScore(diagnostic: Diagnostic): number {
  let score = severityRank(diagnostic.severity) * 100;
  if (/Main Event|Upper Midcard|champion|title|Official Push Main Event|Official Push Upper/i.test(diagnostic.evidence)) score += 35;
  if (/not been booked|Low morale|High fatigue|Push Mismatch/i.test(diagnostic.problem)) score += 20;
  if (/Lower Midcard|Enhancement|Opener/i.test(diagnostic.evidence)) score -= 35;
  return score;
}

function filterRecordsToRoster<T extends { participants: string[] }>(records: T[], workers: WorkerProfile[]): T[] {
  if (!workers.length) return records;
  const rosterNames = new Set(workers.map((worker) => normalize(worker.name)));
  const filtered = records.filter((record) => record.participants.some((participant) => rosterNames.has(normalize(participant))));
  return filtered.length ? filtered : records;
}

function buildUnmappedList(
  inspection: DatabaseInspection,
  workers: WorkerProfile[],
  matches: MatchRecord[],
  segments: SegmentRecord[],
  titles: TitleRecord[],
): string[] {
  const items: string[] = [];
  if (!workers.length) items.push("Worker table was not confidently extracted.");
  if (!titles.length) items.push("Titles or current champions were not confidently extracted.");
  if (!matches.length) items.push("Completed matches and match ratings were not confidently extracted.");
  if (!segments.length) items.push("Segments or angles and segment ratings were not confidently extracted.");
  if (inspection.warnings.length) items.push(...inspection.warnings);
  return items;
}

function buildEntityLookup(inspection: DatabaseInspection, tableKeywords: string[]): Record<string, string> {
  const table = findBestTable(inspection.tables, {
    table: tableKeywords,
    columns: ["name", "id"],
  });
  const lookup: Record<string, string> = {};
  table?.sampleRows.forEach((row) => {
    const id = pickString(row, ["id", `${tableKeywords[0]}_id`, `${tableKeywords[0]}id`, "uid"]);
    const name = pickString(row, ["name", `${tableKeywords[0]}_name`, `${tableKeywords[0]}name`, "display_name", "full_name"]);
    if (id && name) {
      lookup[id] = name;
      lookup[normalize(id)] = name;
    }
  });
  return lookup;
}

function getTable(inspection: DatabaseInspection, name: string): TableInfo | null {
  return inspection.tables.find((table) => normalize(table.name) === normalize(name)) || null;
}

function groupRows(rows: Record<string, unknown>[], key: string): Map<string, Record<string, unknown>[]> {
  return rows.reduce((result, row) => {
    const value = String(row[key] ?? "");
    result.set(value, [...(result.get(value) || []), row]);
    return result;
  }, new Map<string, Record<string, unknown>[]>());
}

function buildOpponentSides(rows: Record<string, unknown>[], workers: Map<string, string>): string[][] {
  const sides = new Map<string, string[]>();
  rows
    .filter((row) => Number(row.isRingside || 0) !== 1)
    .forEach((row) => {
      const side = String(row.opponentSet ?? "0");
      const worker = workers.get(String(row.workerID)) || String(row.workerName || "");
      if (!worker) return;
      sides.set(side, unique([...(sides.get(side) || []), worker]));
    });
  return [...sides.entries()]
    .sort(([left], [right]) => Number(left) - Number(right))
    .map(([, sideWorkers]) => sideWorkers.sort((left, right) => left.localeCompare(right)));
}

function derivePromotions(inspection: DatabaseInspection, companyLookup: Record<string, string>): string[] {
  const values = new Set(Object.values(companyLookup).filter(Boolean));
  inspection.tables.forEach((table) => {
    table.sampleRows.slice(0, 300).forEach((row) => {
      const value = pickString(row, ["company", "promotion", "fed", "company_name", "promotion_name"]);
      if (value && !/^\d+$/.test(value)) values.add(value);
    });
  });
  values.add("Custom company");
  return [...values];
}

function findMappedTable(
  inspection: DatabaseInspection,
  mappingProfile: MappingProfile | undefined,
  field: string,
): TableInfo | null {
  const mapped = mappingProfile?.fields[field];
  if (!mapped) return null;
  const [tableName] = splitMappedColumn(mapped);
  return inspection.tables.find((table) => table.name === tableName) || null;
}

function pickMappedString(
  row: Record<string, unknown>,
  table: TableInfo,
  mappingProfile: MappingProfile | undefined,
  field: string,
  fallbackKeys: string[],
): string | null {
  const mappedColumn = mappedColumnForTable(mappingProfile, table.name, field);
  if (mappedColumn) {
    const value = pickString(row, [mappedColumn]);
    if (value) return value;
  }
  return pickString(row, fallbackKeys);
}

function pickMappedNumber(
  row: Record<string, unknown>,
  table: TableInfo,
  mappingProfile: MappingProfile | undefined,
  field: string,
  fallbackKeys: string[],
): number | null {
  const mappedColumn = mappedColumnForTable(mappingProfile, table.name, field);
  if (mappedColumn) {
    const value = pickNumber(row, [mappedColumn]);
    if (value !== null) return value;
  }
  return pickNumber(row, fallbackKeys);
}

function mappedColumnForTable(
  mappingProfile: MappingProfile | undefined,
  tableName: string,
  field: string,
): string | null {
  const mapped = mappingProfile?.fields[field];
  if (!mapped) return null;
  const [mappedTable, mappedColumn] = splitMappedColumn(mapped);
  return mappedTable === tableName ? mappedColumn : null;
}

function splitMappedColumn(value: string): [string, string] {
  const index = value.indexOf(".");
  if (index === -1) return [value, ""];
  return [value.slice(0, index), value.slice(index + 1)];
}

function findBestTable(tables: TableInfo[], options: { table: string[]; columns: string[] }): TableInfo | null {
  const scored = tables
    .map((table) => {
      const tableName = normalize(table.name);
      const columns = table.columns.map((column) => normalize(column.name));
      const columnBlob = columns.join(" ");
      const tableScore = options.table.reduce((score, keyword) => score + (tableName.includes(normalize(keyword)) ? 8 : 0), 0);
      const columnScore = options.columns.reduce((score, keyword) => score + (columnBlob.includes(normalize(keyword)) ? 3 : 0), 0);
      const rowScore = Math.min(8, Math.floor((table.rowCount ?? table.sampleRows.length) / 10));
      return { table, score: tableScore + columnScore + rowScore };
    })
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || (b.table.rowCount ?? 0) - (a.table.rowCount ?? 0));
  return scored[0]?.table ?? null;
}

function bestColumn(columns: string[], candidates: string[]): string | null {
  const normalized = columns.map((column) => ({ original: column, normalized: normalize(column) }));
  for (const candidate of candidates) {
    const wanted = normalize(candidate);
    const exact = normalized.find((column) => column.normalized === wanted);
    if (exact) return exact.original;
  }
  for (const candidate of candidates) {
    const wanted = normalize(candidate);
    const fuzzy = normalized.find((column) => column.normalized.includes(wanted) || wanted.includes(column.normalized));
    if (fuzzy) return fuzzy.original;
  }
  return null;
}

function isInactiveLink(row: Record<string, unknown>): boolean {
  const status = pickString(row, ["status", "contract_status", "contractstatus", "employment_status", "active", "is_active"]);
  if (!status) return false;
  if (/inactive|expired|released|left|fired|retired|false|0/i.test(status)) return true;
  return false;
}

function pickString(row: Record<string, unknown>, keys: string[]): string | null {
  const map = lowerCaseKeys(row);
  for (const key of keys) {
    const direct = map[normalize(key)];
    if (direct !== undefined && direct !== null && String(direct).trim()) return String(direct);
  }
  for (const key of keys) {
    const wanted = normalize(key);
    const fuzzy = Object.entries(map).find(([candidate]) => candidate.includes(wanted) || wanted.includes(candidate));
    if (fuzzy?.[1] !== undefined && fuzzy[1] !== null && String(fuzzy[1]).trim()) return String(fuzzy[1]);
  }
  return null;
}

function pickNumber(row: Record<string, unknown>, keys: string[]): number | null {
  const value = pickString(row, keys);
  if (!value) return null;
  const numeric = Number(String(value).replace(/[^0-9.-]/g, ""));
  return Number.isFinite(numeric) ? numeric : null;
}

function pwsNumber(row: Record<string, unknown>, keys: string[]): number {
  return clampScore(pickNumber(row, keys) ?? 0);
}

function averageScore(values: number[]): number {
  const valid = values.filter((value) => Number.isFinite(value) && value > 0);
  if (!valid.length) return 0;
  return Math.round(valid.reduce((sum, value) => sum + value, 0) / valid.length);
}

function weightedOverall(entries: Array<[number, number]>): number {
  const valid = entries.filter(([value]) => Number.isFinite(value) && value > 0);
  const totalWeight = valid.reduce((sum, [, weight]) => sum + weight, 0);
  if (!totalWeight) return 0;
  return Math.round(valid.reduce((sum, [value, weight]) => sum + clampScore(value) * weight, 0) / totalWeight);
}

function clampScore(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, Math.round(value)));
}

function lowerCaseKeys(row: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(row).map(([key, value]) => [normalize(key), value]));
}

function resolveLookup(lookup: Record<string, string>, value: string): string {
  return lookup[value] || lookup[normalize(value)] || value || unknown;
}

function splitParticipants(value: string): string[] {
  return value
    .split(/[,;/|&+]|\bvs\.?\b|\bVS\b|\bv\b/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function recordIncludes(values: string[], workerName: string): boolean {
  const worker = normalize(workerName);
  return values.some((value) => normalize(value) === worker || normalize(value).includes(worker) || worker.includes(normalize(value)));
}

function averageOrNull(values: number[]): number | null {
  if (!values.length) return null;
  return Math.round(values.reduce((sum, value) => sum + value, 0) / values.length);
}

function isNumber(value: number | null): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function latestKnownDate(values: string[]): string {
  const dates = values
    .map((value) => ({ value, time: Date.parse(value) }))
    .filter((item) => Number.isFinite(item.time))
    .sort((a, b) => b.time - a.time);
  return dates[0]?.value || unknown;
}

function dateSortValue(value: string): number {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function daysSince(value: string): number | null {
  const time = parsePwsDate(value);
  if (!Number.isFinite(time)) return null;
  return Math.max(0, Math.floor((Date.now() - time) / 86_400_000));
}

function daysBetween(startValue: string, endValue: string): number | null {
  const start = parsePwsDate(startValue);
  const end = parsePwsDate(endValue);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  return Math.max(0, Math.floor((end - start) / 86_400_000));
}

function parsePwsDate(value: string): number {
  if (!value || value === unknown) return Number.NaN;
  const parts = value.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (parts) return new Date(Number(parts[1]), Number(parts[2]) - 1, Number(parts[3])).getTime();
  return Date.parse(value);
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function titleSeverity(value: string): Severity {
  const days = daysSince(value);
  return titleSeverityFromDays(days);
}

function titleSeverityFromDays(days: number | null): Severity {
  if (days === null) return "Medium";
  if (days >= 90) return "Critical";
  if (days >= 60) return "High";
  if (days >= 35) return "Medium";
  return "Low";
}

function pushFitScore(worker: WorkerProfile, popularityValues: number[], momentumValues: number[]): number {
  const popularity = percentile(worker.popularity, popularityValues);
  const momentum = percentile(worker.momentum, momentumValues);
  const record = recordCredibility(worker.recentRecord);
  const ratings = averageOrNull([worker.recentMatchRatingAverage, worker.recentSegmentRatingAverage].filter(isNumber)) ?? 50;
  const availability = availabilityScore(worker);
  return Math.round(popularity * 0.35 + momentum * 0.25 + record * 0.15 + ratings * 0.15 + availability * 0.1);
}

function percentile(value: number, values: number[]): number {
  if (!value || !values.length) return 50;
  const below = values.filter((candidate) => candidate <= value).length;
  return Math.round((below / values.length) * 100);
}

function recordCredibility(record: string): number {
  const match = record.match(/(\d+)-(\d+)/);
  if (!match) return 50;
  const wins = Number(match[1]);
  const losses = Number(match[2]);
  const total = wins + losses;
  return total ? Math.round((wins / total) * 100) : 50;
}

function availabilityScore(worker: WorkerProfile): number {
  let score = 100;
  if (worker.fatigue) score -= Math.min(70, worker.fatigue);
  if (worker.morale && worker.morale < 50) score -= 20;
  if (/injur|hurt|out/i.test(worker.injuryStatus)) score -= 60;
  return Math.max(0, score);
}

function recommendedPushTier(score: number): string {
  if (score >= 85) return "Main Event";
  if (score >= 70) return "Upper Midcard";
  if (score >= 45) return "Midcard";
  if (score >= 25) return "Lower Midcard";
  return "Opener or Enhancement";
}

function pushTier(push: string): number {
  const value = normalize(push);
  if (value.includes("mainevent")) return 5;
  if (value.includes("upper")) return 4;
  if (value.includes("midcard") && !value.includes("lower")) return 3;
  if (value.includes("lower")) return 2;
  if (value.includes("opener") || value.includes("enhancement")) return 1;
  return 3;
}

function repeatedPairings(matches: MatchRecord[]): Array<{ pair: string; count: number }> {
  const counts = new Map<string, number>();
  matches.forEach((match) => {
    const sides = canonicalMatchSides(match);
    if (sides.length < 2) return;
    const pair = sides.join(" vs ");
    counts.set(pair, (counts.get(pair) ?? 0) + 1);
  });
  return [...counts.entries()]
    .map(([pair, count]) => ({ pair, count }))
    .filter((item) => item.count >= 3)
    .sort((a, b) => b.count - a.count);
}

function canonicalMatchSides(match: MatchRecord): string[] {
  const sides = match.sideParticipants
    ?.map((side) => unique(side.map((worker) => worker.trim()).filter(Boolean)).sort((left, right) => left.localeCompare(right)))
    .filter((side) => side.length);
  if (sides && sides.length >= 2) {
    return sides.map((side) => side.join(" & ")).sort((left, right) => left.localeCompare(right));
  }
  if (match.participants.length === 2) {
    return match.participants.map((participant) => participant.trim()).filter(Boolean).sort((left, right) => left.localeCompare(right));
  }
  return [];
}

function severityRank(severity: Severity): number {
  return { Low: 1, Medium: 2, High: 3, Critical: 4 }[severity];
}

function normalize(value: string): string {
  return String(value || "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

function promotionMatches(value: string, selectedPromotion: string): boolean {
  const left = normalize(value);
  const right = normalize(selectedPromotion);
  if (!left || !right) return false;
  if (left === right || left.includes(right) || right.includes(left)) return true;
  if (right === "roh" && left.includes("ringofhonor")) return true;
  const initials = String(value || "")
    .split(/\s+/)
    .map((part) => part[0])
    .join("")
    .toLowerCase();
  return normalize(initials) === right;
}

function slug(value: string): string {
  return normalize(value).replace(/(.{48}).+/, "$1") || "item";
}
