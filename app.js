/* ============================================================
   Performance Alignment Intelligence — for L'AINE HR
   Core application logic
   Rule-based scoring core, enhanced with client-side AI-assisted
   semantic matching (a small on-device embedding model — no data
   leaves the browser, no API key, no per-run cost). Falls back to
   keyword-only matching if the model can't load. See README.md
   for rationale and the optional LLM-based upgrade path.
   ============================================================ */
"use strict";

/* ============================== CONFIG ============================== */

const REQUIRED_FIELDS = {
  companyGoals: ["Company_Goal_ID","Company_Goal_Title","Strategic_Pillar","Goal_Description","Success_Measure","Target","Timeline","Priority","Goal_Owner"],
  departmentalGoals: ["Department_Goal_ID","Linked_Company_Goal_ID","Department","Department_Goal_Title","Goal_Description","KPI","Target","Timeline","Goal_Owner"],
  individualGoals: ["Individual_Goal_ID","Linked_Department_Goal_ID","Employee_ID","Employee_Name","Department","Job_Title","Individual_Goal_Title","KPI","Target","Timeline","Weight"],
  weeklyTasks: ["Task_ID","Week","Month","Employee_ID","Employee_Name","Department","Linked_Individual_Goal_ID","Planned_Task","Expected_Output","Actual_Output","Status","Progress_Percentage","Evidence","Challenge","Supervisor_Comment"]
};

const ID_FIELD = { companyGoals: "Company_Goal_ID", departmentalGoals: "Department_Goal_ID", individualGoals: "Individual_Goal_ID", weeklyTasks: "Task_ID" };
const DATASET_LABEL = { companyGoals: "Company Goals", departmentalGoals: "Departmental Goals", individualGoals: "Individual Employee Goals", weeklyTasks: "Weekly KPI Planner" };
const DATASET_ORDER = ["companyGoals","departmentalGoals","individualGoals","weeklyTasks"];

const CLASSIFICATIONS = [
  "Directly aligned",
  "Indirectly aligned",
  "Routine/Business-as-usual",
  "Misaligned",
  "Unclear due to insufficient information"
];

const CHIP_CLASS_BY_CLASSIFICATION = {
  "Directly aligned": "chip-direct",
  "Indirectly aligned": "chip-indirect",
  "Routine/Business-as-usual": "chip-routine",
  "Misaligned": "chip-misaligned",
  "Unclear due to insufficient information": "chip-unclear"
};

const STATUS_POINTS = { "Completed": 10, "On Track": 8, "In Progress": 6, "Delayed": 3, "Blocked": 1, "Not Started": 0 };
const STATUS_CHIP_CLASS = { "Completed": "chip-complete", "On Track": "chip-direct", "In Progress": "chip-indirect", "Delayed": "chip-at-risk", "Blocked": "chip-misaligned", "Not Started": "chip-neutral" };

const STEPS = ["Upload", "Validate", "Analyse", "Report", "Export"];

const SECTION_TITLES = {
  "executive-summary": ["Executive Summary", "A real-time view of how weekly work ties back to company strategy."],
  "upload-centre": ["Upload Centre", "Upload the four required datasets, or load sample data to explore the app."],
  "data-validation": ["Data Validation", "Review data quality issues before running goal-alignment analysis."],
  "goal-mapping": ["Goal Mapping", "Explore the full Company → Department → Individual → Task hierarchy."],
  "alignment-analysis": ["Alignment Analysis", "Every weekly task, classified and scored against the goal hierarchy."],
  "employee-reports": ["Employee Reports", "Alignment detail and manager follow-up guidance, by employee."],
  "department-reports": ["Department Reports", "Goal support and risk summary, by department."],
  "organisational-reports": ["Organisational Reports", "Company goal performance and departmental contribution."],
  "trend-over-time": ["Trend Over Time", "How the overall alignment score has moved across every published snapshot."],
  "risk-gap-reports": ["Risk & Gap Reports", "Misaligned and unclear tasks, and goals that need attention."],
  "export-centre": ["Export Centre", "Export polished summaries for stakeholders and leadership."],
  "manage-users": ["Manage Users", "Create and remove named logins, and see who holds which role."]
};

/* ============================== UTILITIES ============================== */

function escapeHtml(str) {
  if (str === null || str === undefined) return "";
  return String(str).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function s(v) { return (v === null || v === undefined) ? "" : String(v).trim(); }
function isBlank(v) { return s(v) === ""; }
function fmtPct(n) { return Math.round(n) + "%"; }
function fmtScore(n) { return Math.round(n); }
function todayString() {
  const d = new Date();
  return d.toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" });
}
function uniqueValues(arr, key) {
  const seen = new Set();
  arr.forEach((r) => { const v = s(r[key]); if (v) seen.add(v); });
  return Array.from(seen).sort();
}
function byIdMap(arr, idField) {
  const map = {};
  arr.forEach((r) => { const id = s(r[idField]); if (id && !(id in map)) map[id] = r; });
  return map;
}
function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}
function avg(nums) { return nums.length ? nums.reduce((a, b) => a + b, 0) / nums.length : 0; }
function clamp01(n) { return Math.max(0, Math.min(1, n)); }

/* ============================== STATE ============================== */

const STATE = {
  datasets: { companyGoals: null, departmentalGoals: null, individualGoals: null, weeklyTasks: null },
  fileMeta: { companyGoals: null, departmentalGoals: null, individualGoals: null, weeklyTasks: null },
  usingSampleData: false,
  validation: null,           // { errors:[], warnings:[], excludedKeys:Set, columnErrorDatasets:Set }
  validationAcknowledged: false,
  analysisRun: false,
  reportViewed: false,
  exportedOnce: false,
  hierarchy: null,
  classifiedTasks: null,      // array of {...task, _score:{...}}
  individualGoalSupport: null,// map Individual_Goal_ID -> support summary
  departmentGoalSupport: null,
  companyGoalSupport: null,
  departmentRollups: null,    // map Department -> support summary (pooled)
  currentSection: "executive-summary",
  filters: { department: "all", employee: "all", companyGoal: "all", period: "all", riskStatus: "all" },
  activeRiskTab: "tasks",
  charts: {},
  deferredInstallPrompt: null,
  sidebarOpen: false,
  currentUser: null,
  workflowItems: null,     // map "itemType:itemKey" -> {status, assigned_to, comment_count}, null until first loaded
  snapshotHistory: null,    // array from /api/snapshots/history, null until first loaded
  execFilters: { period: "all", department: "all" }  // independent filters for the Executive Summary
};

/* ============================== AUTH & API CLIENT ==============================
   The server is the source of truth for "who is logged in" and "what are
   they allowed to do" — ROLE_PERMISSIONS/can() here is a UI-convenience
   MIRROR of the same table in netlify/functions/_shared/auth.js, used only
   to decide what to show/hide. Every actual write is re-checked server-side,
   so a stale or tampered client copy of this table cannot grant real access. */

const ROLE_PERMISSIONS = {
  admin: { manageUsers: true, pushSnapshot: true, editWorkflow: true },
  hr_manager: { manageUsers: false, pushSnapshot: true, editWorkflow: true },
  head_of_dept: { manageUsers: false, pushSnapshot: false, editWorkflow: true },
  executive: { manageUsers: false, pushSnapshot: false, editWorkflow: false }
};
const ROLE_LABEL = { admin: "Admin", hr_manager: "HR Manager", head_of_dept: "Head of Department", executive: "Executive" };

function can(user, permission) {
  if (!user) return false;
  const perms = ROLE_PERMISSIONS[user.role];
  return !!(perms && perms[permission]);
}

// Thin fetch wrapper: always sends/receives JSON, always includes the
// session cookie, and throws a normal Error (with the server's message)
// on any non-2xx response so callers can just try/catch.
async function api(path, options) {
  const opts = options || {};
  const fetchOpts = {
    method: opts.method || "GET",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" }
  };
  if (opts.body !== undefined) fetchOpts.body = JSON.stringify(opts.body);
  let res;
  try {
    res = await fetch(path, fetchOpts);
  } catch (networkErr) {
    throw new Error("Could not reach the server. Check your connection and try again.");
  }
  let data = null;
  try { data = await res.json(); } catch (e) { /* empty body is fine for some responses */ }
  if (!res.ok) {
    const message = (data && data.error) || ("Request failed (" + res.status + ").");
    throw new Error(message);
  }
  return data || {};
}

// GET /api/snapshots/current can return JSONB columns either as already-
// parsed objects or as raw JSON strings depending on the Postgres driver's
// type-parsing config — handle both rather than assume one.
function asObject(value, fallback) {
  if (value === null || value === undefined) return fallback;
  if (typeof value === "string") {
    try { return JSON.parse(value); } catch (e) { return fallback; }
  }
  return value;
}

async function checkAuth() {
  try {
    const data = await api("/api/auth/me");
    STATE.currentUser = data.user || null;
  } catch (err) {
    STATE.currentUser = null;
  }
  return STATE.currentUser;
}

function wireLoginScreen() {
  const form = document.getElementById("loginForm");
  if (!form) return;
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const errorBox = document.getElementById("loginError");
    const submitBtn = document.getElementById("loginSubmitBtn");
    const email = document.getElementById("loginEmail").value.trim();
    const password = document.getElementById("loginPassword").value;
    if (errorBox) errorBox.hidden = true;
    submitBtn.disabled = true;
    submitBtn.textContent = "Signing in\u2026";
    try {
      const data = await api("/api/auth/login", { method: "POST", body: { email, password } });
      STATE.currentUser = data.user;
      document.getElementById("loginPassword").value = "";
      await enterApp();
    } catch (err) {
      if (errorBox) { errorBox.textContent = err.message || "Could not sign in."; errorBox.hidden = false; }
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = "Sign in";
    }
  });
}

async function handleLogout() {
  try { await api("/api/auth/logout", { method: "POST" }); } catch (e) { /* clear local state regardless */ }
  STATE.currentUser = null;
  STATE.workflowItems = null;
  STATE.snapshotHistory = null;
  document.getElementById("app").hidden = true;
  document.getElementById("loginScreen").hidden = false;
  const form = document.getElementById("loginForm");
  if (form) form.reset();
}

// Shows/hides nav items the current role isn't permitted to use, fills in
// the topbar identity chip, and reveals the app shell. Called once after a
// successful login or a successful boot-time session check.
async function enterApp() {
  const user = STATE.currentUser;
  document.getElementById("loginScreen").hidden = true;
  document.getElementById("app").hidden = false;

  document.getElementById("currentUserName").textContent = user.name;
  document.getElementById("currentUserRole").textContent = ROLE_LABEL[user.role] || user.role;

  const uploadNav = document.querySelector('[data-section="upload-centre"]');
  const validationNav = document.querySelector('[data-section="data-validation"]');
  const manageUsersNav = document.getElementById("manageUsersNavBtn");
  if (uploadNav) uploadNav.hidden = !can(user, "pushSnapshot");
  if (validationNav) validationNav.hidden = !can(user, "pushSnapshot");
  if (manageUsersNav) manageUsersNav.hidden = !can(user, "manageUsers");

  // If the role that just logged in can't reach the section we're parked
  // on (e.g. a stale deep link), fall back to the Executive Summary.
  if (STATE.currentSection === "manage-users" && !can(user, "manageUsers")) STATE.currentSection = "executive-summary";
  if ((STATE.currentSection === "upload-centre" || STATE.currentSection === "data-validation") && !can(user, "pushSnapshot")) STATE.currentSection = "executive-summary";

  await loadCurrentSnapshotFromServer();
  renderSection();
}

// Pulls the shared "current" snapshot (if any) into STATE.datasets and runs
// the existing local validation/analysis pipeline on it. The server only
// ever stores the raw uploaded tables — classification stays entirely
// client-side, exactly as it was before the backend existed.
async function loadCurrentSnapshotFromServer() {
  try {
    const data = await api("/api/snapshots/current");
    if (!data.snapshot) return;
    const datasets = asObject(data.snapshot.datasets, null);
    if (!datasets) return;
    DATASET_ORDER.forEach((key) => {
      if (datasets[key]) {
        STATE.datasets[key] = datasets[key];
        STATE.fileMeta[key] = { name: "Shared data (published " + new Date(data.snapshot.created_at).toLocaleDateString() + ")", source: "server", rowCount: Array.isArray(datasets[key]) ? datasets[key].length : 0 };
      }
    });
    STATE.usingSampleData = false;
    runValidation();
    if (!STATE.validation.errors.length) {
      STATE.validationAcknowledged = true;
      runAnalysis();
    }
  } catch (err) {
    console.warn("Could not load shared snapshot from server:", err);
    showToast("Could not load shared data from the server. You can still load sample data or upload your own.", "error");
  }
}

// Publishes the just-analysed datasets so every other logged-in user sees
// them too. Only fires for roles with pushSnapshot permission, and never
// for sample-data exploration (that stays purely local on purpose).
async function pushSnapshotToServer() {
  if (!can(STATE.currentUser, "pushSnapshot")) return;
  if (STATE.usingSampleData) {
    showToast("Sample data analysed locally \u2014 not published to the shared dashboard.", "success");
    return;
  }
  try {
    const kpi = computeExecutiveKPIs();
    const scores = (STATE.classifiedTasks || []).map((t) => t._score.total);
    const overallAvgScore = scores.length ? Math.round(avg(scores)) : null;
    await api("/api/snapshots", {
      method: "POST",
      body: {
        datasets: STATE.datasets,
        kpi,
        departmentRollups: STATE.departmentRollups,
        overallAvgScore,
        label: todayString()
      }
    });
    STATE.snapshotHistory = null; // force the trend view to refetch next time it's opened
    showToast("Published \u2014 everyone viewing this dashboard will now see this data.", "success");
  } catch (err) {
    showToast(err.message || "Could not publish this snapshot to the server.", "error");
  }
}

/* ============================== SAMPLE DATA ==============================
   Mirrors templates/sample_*.csv exactly (same rows, same deliberate
   data-quality issues) so "Load Sample Data" demonstrates every
   validation rule and all five classifications without a file upload. */

function rowsToObjects(header, rows) {
  return rows.map((r) => { const o = {}; header.forEach((h, i) => { o[h] = r[i]; }); return o; });
}

const SAMPLE_COMPANY_GOALS_HEADER = ["Company_Goal_ID","Company_Goal_Title","Strategic_Pillar","Goal_Description","Success_Measure","Target","Timeline","Priority","Goal_Owner"];
const SAMPLE_COMPANY_GOALS_ROWS = [
  ["CG-001","Expand Market Leadership","Growth","Increase market share across key segments through stronger customer acquisition and retention.","Market share percentage","18% market share","FY2026","High","Chief Commercial Officer"],
  ["CG-002","Drive Operational Excellence","Efficiency","Improve operational efficiency and reduce cost-to-serve across all business units.","Cost-to-serve reduction","12% cost reduction","FY2026","High","Chief Operating Officer"],
  ["CG-003","Strengthen People and Culture","People","Build a high-performing, engaged workforce aligned with company values.","Employee engagement score","80% engagement","FY2026","Medium","Chief HR Officer"]
];

const SAMPLE_DEPARTMENTAL_GOALS_HEADER = ["Department_Goal_ID","Linked_Company_Goal_ID","Department","Department_Goal_Title","Goal_Description","KPI","Target","Timeline","Goal_Owner"];
const SAMPLE_DEPARTMENTAL_GOALS_ROWS = [
  ["DG-001","CG-001","Sales","Grow New Business Revenue","Increase new business revenue from target enterprise accounts.","New business revenue","GHS 4.2M","Q3 2026","Head of Sales"],
  ["DG-002","CG-001","Marketing","Increase Qualified Pipeline","Generate a higher volume and quality of marketing-sourced leads.","Marketing-qualified leads","600 MQLs","Q3 2026","Head of Marketing"],
  ["DG-003","CG-002","Operations","Reduce Process Turnaround Time","Streamline core operational processes to reduce turnaround time.","Average turnaround time","3 days","Q3 2026","Head of Operations"],
  ["DG-004","CG-002","IT","Improve System Uptime and Reliability","Reduce downtime and improve reliability of core business systems.","System uptime percentage","99.5% uptime","Q3 2026","Head of IT"],
  ["DG-005","CG-003","HR","Improve Employee Engagement","Implement initiatives that improve engagement and retention.","Engagement score","80% engagement","Q3 2026","Head of HR"],
  ["DG-006","CG-099","Finance","Improve Financial Reporting Accuracy","Improve the accuracy and timeliness of financial reporting.","Reporting error rate","Less than 1% error rate","Q3 2026","Head of Finance"]
];

const SAMPLE_INDIVIDUAL_GOALS_HEADER = ["Individual_Goal_ID","Linked_Department_Goal_ID","Employee_ID","Employee_Name","Department","Job_Title","Individual_Goal_Title","KPI","Target","Timeline","Weight"];
const SAMPLE_INDIVIDUAL_GOALS_ROWS = [
  ["IG-001","DG-001","EMP-001","Jane Mensah","Sales","Senior Account Manager","Close New Enterprise Accounts","New accounts closed","6 accounts","Q3 2026","40"],
  ["IG-002","DG-001","EMP-002","Kojo Owusu","Sales","Account Executive","Grow Existing Account Revenue","Upsell revenue","GHS 800K","Q3 2026","35"],
  ["IG-003","DG-002","EMP-003","Ama Boateng","Marketing","Marketing Manager","Increase Marketing-Qualified Leads","MQLs generated","150 MQLs","Q3 2026","30"],
  ["IG-004","DG-003","EMP-004","Yaw Asante","Operations","Operations Analyst","Reduce Order Processing Time","Average processing time","2.5 days","Q3 2026","35"],
  ["IG-005","DG-004","EMP-005","Linda Adjei","IT","Systems Administrator","Maintain Core System Uptime","Uptime percentage","99.5%","Q3 2026","30"],
  ["IG-006","DG-005","EMP-006","Kwame Darko","HR","HR Business Partner","Improve Department Engagement Scores","Engagement score","80%","Q3 2026","30"],
  ["IG-007","DG-002","EMP-003","Ama Boateng","Marketing","Marketing Manager","Launch Brand Awareness Campaign","Campaign reach","500K impressions","Q3 2026","25"],
  ["IG-008","DG-099","EMP-007","Esi Owusu","Finance","Financial Analyst","Improve Monthly Close Accuracy","Reporting error rate","Less than 1%","Q3 2026","30"]
];

const SAMPLE_WEEKLY_TASKS_HEADER = ["Task_ID","Week","Month","Employee_ID","Employee_Name","Department","Linked_Individual_Goal_ID","Planned_Task","Expected_Output","Actual_Output","Status","Progress_Percentage","Evidence","Challenge","Supervisor_Comment"];
const SAMPLE_WEEKLY_TASKS_ROWS = [
  ["TASK-001","Week 1","June","EMP-001","Jane Mensah","Sales","IG-001","Finalize contract negotiation with Accra Logistics Ltd for new enterprise package","Signed contract for new enterprise account","Contract signed and onboarding scheduled","Completed","100","Signed contract PDF; CRM record updated","","Excellent close, ahead of plan"],
  ["TASK-002","Week 2","June","EMP-001","Jane Mensah","Sales","IG-001","Prepare and deliver enterprise proposal for Volta Manufacturing","Proposal submitted to client","Proposal submitted, awaiting response","On Track","70","Proposal document shared via email","Client procurement delays","Monitor client response closely"],
  ["TASK-003","Week 3","June","EMP-001","Jane Mensah","Sales","IG-001","Attend weekly sales pipeline review meeting","Pipeline updated in CRM","Pipeline reviewed and updated","Completed","100","CRM screenshot","","Routine but useful"],
  ["TASK-004","Week 4","June","EMP-001","Jane Mensah","Sales","IG-001","Support marketing with customer testimonial video for case study","Testimonial video filmed","Video filmed, in editing","In Progress","50","Raw footage link shared","",""],
  ["TASK-005","Week 1","June","EMP-002","Kojo Owusu","Sales","IG-002","Identify upsell opportunities in top 10 existing accounts","List of upsell opportunities with revenue potential","Identified 6 upsell opportunities worth GHS 220K","Completed","100","Upsell tracker spreadsheet","","Strong analysis"],
  ["TASK-006","Week 2","June","EMP-002","Kojo Owusu","Sales","IG-002","Submit weekly expense report","Expense report submitted","Submitted on time","Completed","100","Finance system confirmation","",""],
  ["TASK-007","Week 3","June","EMP-002","Kojo Owusu","Sales","IG-002","Negotiate renewal pricing with Tema Foods account","","","","","","Client budget freeze","Need an update from Kojo"],
  ["TASK-008","Week 4","June","EMP-002","Kojo Owusu","Sales","IG-002","Follow up on outstanding invoices for Q2 accounts","Reduced overdue invoice balance","2 of 5 invoices collected","Delayed","40","Finance ledger extract","Client finance team unresponsive","Escalate if no movement next week"],
  ["","Week 4","June","EMP-002","Kojo Owusu","Sales","IG-002","Update CRM notes for pipeline accounts","CRM notes updated","Notes updated","Completed","100","","",""],
  ["TASK-009","Week 1","June","EMP-003","Ama Boateng","Marketing","IG-003","Launch LinkedIn lead-generation ad campaign targeting SME segment","40 marketing-qualified leads generated","52 MQLs generated","Completed","100","Campaign dashboard export; CRM lead report","","Exceeded target, great work"],
  ["TASK-010","Week 2","June","EMP-003","Ama Boateng","Marketing","IG-003","Optimize landing page conversion rate for lead capture form","Increase landing page conversion by 2 points","Conversion improved by 1.3 points","On Track","65","Analytics report screenshot","","Keep iterating on page copy"],
  ["TASK-011","Week 1","June","EMP-003","Ama Boateng","Marketing","IG-007","Coordinate brand awareness billboard placement in Accra and Kumasi","Billboards live in 2 cities reaching 500K+ impressions","Billboards live in Accra only","Delayed","45","Photos of billboard installation","Kumasi vendor delay","Push vendor for revised timeline"],
  ["TASK-012","Week 3","June","EMP-003","Ama Boateng","Marketing","IG-003","Attend internal marketing team standup","Status updates shared","Updates shared","Completed","100","Meeting notes","",""],
  ["TASK-013","Week 4","June","EMP-003","Ama Boateng","Marketing","IG-007","","Press release drafted","","Not Started","0","","","Awaiting brief from PR agency"],
  ["TASK-014","Week 1","June","EMP-004","Yaw Asante","Operations","IG-004","Map current order-to-fulfillment process and identify bottlenecks","Process map with identified bottlenecks","Process map completed, 3 bottlenecks identified","Completed","100","Process map document","","Thorough work, ready for next phase"],
  ["TASK-015","Week 2","June","EMP-004","Yaw Asante","Operations","IG-004","Pilot revised order-routing workflow in warehouse","Reduce processing time by half a day in pilot","Pilot reduced processing time by 0.3 days","On Track","60","Pilot results report","IT system integration delay","Good progress, continue monitoring"],
  ["TASK-016","Week 3","June","EMP-004","Yaw Asante","Sales","IG-004","Coordinate with Sales team on order volume forecasts","Forecast shared with Operations","Forecast shared","Completed","100","Email confirmation","",""],
  ["TASK-017","Week 4","June","EMP-004","Yaw Asante","Operations","IG-004","Submit monthly timesheet","Timesheet submitted","Submitted","Completed","100","HR system log","",""],
  ["TASK-018","Week 1","June","EMP-005","Linda Adjei","IT","IG-005","Patch and upgrade core ERP server infrastructure","Zero unplanned downtime during patch window","Patch completed with zero downtime","Completed","100","Patch deployment log; uptime monitor report","","Clean execution"],
  ["TASK-019","Week 2","June","EMP-005","Linda Adjei","IT","IG-005","Investigate recurring login latency issue reported by Sales team","Root cause identified and fix proposed","Root cause identified, fix scheduled next sprint","In Progress","55","Diagnostic log export","Limited access to legacy auth module","Coordinate with vendor if needed"],
  ["TASK-020","Week 3","June","EMP-005","Linda Adjei","IT","IG-005","Run monthly system backup verification","Backup integrity confirmed","Backup verified successfully","Completed","120","Backup verification report","",""],
  ["TASK-021","Week 1","June","EMP-006","Kwame Darko","HR","IG-006","Design and launch Q3 employee engagement pulse survey","Survey launched to all staff with 70%+ response rate","Survey launched, 74% response rate achieved","Completed","100","Survey results dashboard","","Great participation rate"],
  ["TASK-022","Week 2","June","EMP-006","Kwame Darko","HR","IG-006","Organize monthly team social event","Event held with good attendance","Event held, 80% attendance","Completed","100","Event photos; attendance sheet","","Nice morale boost"],
  ["TASK-001","Week 3","June","EMP-006","Kwame Darko","HR","IG-006","Review HR policy handbook updates","Updated handbook circulated for feedback","Draft circulated for feedback","In Progress","50","Draft document link","","Finalize by end of month"],
  ["TASK-023","Week 4","June","EMP-006","Kwame Darko","HR","IG-099","Coordinate offsite training logistics","Training venue and logistics confirmed","Venue confirmed, catering pending","On Track","75","Vendor confirmation email","",""],
  ["TASK-024","Week 1","June","EMP-007","Esi Owusu","Finance","IG-008","Reconcile general ledger accounts for May close","Zero unreconciled discrepancies","All accounts reconciled, 2 minor adjustments made","Completed","100","Reconciliation worksheet","","Clean close"],
  ["TASK-025","Week 2","June","EMP-007","Esi Owusu","Finance","IG-008","Prepare ad-hoc data request for external auditor","Data package delivered to auditor","Delivered on time","Completed","100","Email confirmation from auditor","",""],
  ["TASK-026","Week 3","June","EMP-002","Kojo Owusu","Sales","IG-002","Reorganize the office supply storage room","Storage room reorganized","","In Progress","30","","",""]
];

function getSampleData() {
  return {
    companyGoals: rowsToObjects(SAMPLE_COMPANY_GOALS_HEADER, SAMPLE_COMPANY_GOALS_ROWS),
    departmentalGoals: rowsToObjects(SAMPLE_DEPARTMENTAL_GOALS_HEADER, SAMPLE_DEPARTMENTAL_GOALS_ROWS),
    individualGoals: rowsToObjects(SAMPLE_INDIVIDUAL_GOALS_HEADER, SAMPLE_INDIVIDUAL_GOALS_ROWS),
    weeklyTasks: rowsToObjects(SAMPLE_WEEKLY_TASKS_HEADER, SAMPLE_WEEKLY_TASKS_ROWS)
  };
}
/* ============================== FILE PARSING ============================== */

function normalizeRow(row) {
  const out = {};
  Object.keys(row).forEach((k) => {
    const key = s(k);
    if (!key) return;
    let v = row[k];
    if (v === undefined || v === null) v = "";
    out[key] = typeof v === "string" ? v.trim() : String(v).trim();
  });
  return out;
}

function readCSVFile(file) {
  return new Promise((resolve, reject) => {
    Papa.parse(file, {
      header: true,
      skipEmptyLines: true,
      complete: (res) => {
        try {
          if (res.errors && res.errors.length) {
            const fatal = res.errors.filter((e) => e.type !== "FieldMismatch");
            if (fatal.length && (!res.data || !res.data.length)) { reject(new Error(fatal[0].message)); return; }
          }
          resolve((res.data || []).map(normalizeRow).filter((r) => Object.values(r).some((v) => v !== "")));
        } catch (err) { reject(err); }
      },
      error: (err) => reject(err)
    });
  });
}

function readExcelFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const data = new Uint8Array(e.target.result);
        const wb = XLSX.read(data, { type: "array" });
        const sheet = wb.Sheets[wb.SheetNames[0]];
        const rows = XLSX.utils.sheet_to_json(sheet, { defval: "", raw: false });
        resolve(rows.map(normalizeRow).filter((r) => Object.values(r).some((v) => v !== "")));
      } catch (err) { reject(err); }
    };
    reader.onerror = () => reject(new Error("Could not read file."));
    reader.readAsArrayBuffer(file);
  });
}

function readDataFile(file) {
  const ext = file.name.split(".").pop().toLowerCase();
  if (ext === "csv") return readCSVFile(file);
  if (ext === "xlsx" || ext === "xls") return readExcelFile(file);
  return Promise.reject(new Error("Unsupported file type. Please upload a .csv or .xlsx file."));
}

/* ============================== RAW KPI PLANNER INGESTION ==============================
   Accepts the KPI Planner tool's own export exactly as downloaded -- concatenated weekly
   blocks, a title row, a header row on line 2, and block-summary rows in between -- and
   converts it into the Weekly KPI Planner schema automatically: task rows are matched to
   the employee's record in the already-loaded Individual Employee Goals, auto-linked to
   the most relevant individual goal by keyword overlap, and Expected_Output/Status are
   normalised to fields the scoring engine understands. No manual reformatting required.
   ============================================================ */

function readRawRows2D(file) {
  const ext = file.name.split(".").pop().toLowerCase();
  if (ext === "csv") {
    return new Promise((resolve, reject) => {
      Papa.parse(file, {
        header: false, skipEmptyLines: false,
        complete: (res) => resolve(res.data || []),
        error: (err) => reject(err)
      });
    });
  }
  if (ext === "xlsx" || ext === "xls") {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = (e) => {
        try {
          const data = new Uint8Array(e.target.result);
          const wb = XLSX.read(data, { type: "array", cellDates: true });
          const sheet = wb.Sheets[wb.SheetNames[0]];
          resolve(XLSX.utils.sheet_to_json(sheet, { header: 1, raw: true, defval: null }));
        } catch (err) { reject(err); }
      };
      reader.onerror = () => reject(new Error("Could not read file."));
      reader.readAsArrayBuffer(file);
    });
  }
  return Promise.reject(new Error("Unsupported file type. Please upload a .csv or .xlsx file."));
}

function looksLikeRawPlannerExport(rows2D) {
  if (!rows2D || rows2D.length < 2) return false;
  const header = (rows2D[1] || []).map((v) => s(v).toUpperCase());
  return header.includes("TASK") && header.includes("CREATED BY") && !header.includes("TASK_ID");
}

function parseUKDate(v) {
  if (!v) return null;
  if (v instanceof Date && !isNaN(v)) return v;
  const str = s(v);
  const datePart = str.split(" ")[0];
  const m = datePart.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!m) return null;
  const d = new Date(Number(m[3]), Number(m[2]) - 1, Number(m[1]));
  return isNaN(d) ? null : d;
}

function isoWeekInfo(date) {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNum = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - dayNum + 3);
  const firstThursday = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
  const week = 1 + Math.round(((d - firstThursday) / 86400000 - 3 + (firstThursday.getUTCDay() + 6) % 7) / 7);
  const monday = new Date(date); monday.setDate(monday.getDate() - ((date.getDay() + 6) % 7));
  const sunday = new Date(monday); sunday.setDate(monday.getDate() + 6);
  return { isoYear: d.getUTCFullYear(), isoWeek: week, monday, sunday };
}

const MONTH_ABBR = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
function fmtDayMonth(date) { return MONTH_ABBR[date.getMonth()] + " " + String(date.getDate()).padStart(2, "0"); }
function weekLabel(date) {
  const { isoWeek, monday, sunday } = isoWeekInfo(date);
  return "Week " + isoWeek + " (" + fmtDayMonth(monday) + " - " + fmtDayMonth(sunday) + ", " + date.getFullYear() + ")";
}
function monthLabel(date) { return MONTH_ABBR[date.getMonth()] + "-" + String(date.getFullYear()).slice(2); }

function extractRawPlannerTasks(rows2D) {
  const tasks = [];
  for (let i = 2; i < rows2D.length; i++) {
    const r = rows2D[i] || [];
    const num = r[0], task = r[1];
    const isSeparator = (num === null || num === undefined || s(num) === "") && (task === null || task === undefined || s(task) === "");
    if (isSeparator || s(task) === "") continue;
    tasks.push({
      task: s(task), priority: s(r[2]),
      startDate: parseUKDate(r[3]), endDate: parseUKDate(r[4]),
      status: s(r[5]), createdBy: s(r[8]).replace(/\s+/g, " ").trim()
    });
  }
  return tasks;
}

const RAW_PLANNER_STOPWORDS = new Set(["a","an","the","to","of","in","on","for","and","or","with","by","is","are","this","that","at","as","from","be","it","its","their","will","was","were","has","have","had","into","per","via"]);
function rawPlannerTokenize(text) {
  return String(text || "").toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/)
    .filter(Boolean).filter((w) => w.length >= 3 && !RAW_PLANNER_STOPWORDS.has(w));
}

function bestIndividualGoalMatch(taskText, goalsForEmployee) {
  const taskTokens = new Set(rawPlannerTokenize(taskText));
  let best = null, bestOverlap = 0;
  goalsForEmployee.forEach((g) => {
    const goalTokens = rawPlannerTokenize((g.Individual_Goal_Title || "") + " " + (g.KPI || "") + " " + (g.Target || ""));
    let overlap = 0;
    goalTokens.forEach((t) => { if (taskTokens.has(t)) overlap++; });
    if (overlap >= 2 && overlap > bestOverlap) { bestOverlap = overlap; best = g; }
  });
  return best;
}

function normalizeStatusForPlanner(rawStatus, endDate) {
  const v = s(rawStatus).toLowerCase();
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const overdue = !!(endDate && endDate < today);
  if (v === "completed") return "Completed";
  if (v === "in progress") return overdue ? "Delayed" : "In Progress";
  if (v === "not started") return overdue ? "Delayed" : "Not Started";
  return overdue ? "Delayed" : (rawStatus ? s(rawStatus) : "Not Started");
}

function transformRawPlannerToWeeklyTasks(rows2D, individualGoalsDataset) {
  const rawTasks = extractRawPlannerTasks(rows2D);
  const byEmployee = {}; // normalized employee name -> { Employee_ID, Employee_Name, Department, goals: [] }
  (individualGoalsDataset || []).forEach((g) => {
    const key = s(g.Employee_Name).replace(/\s+/g, " ").trim().toUpperCase();
    if (!key) return;
    if (!byEmployee[key]) byEmployee[key] = { Employee_ID: s(g.Employee_ID), Employee_Name: s(g.Employee_Name), Department: s(g.Department), goals: [] };
    byEmployee[key].goals.push(g);
  });

  const weekSeq = {};
  const out = [];
  const unmatchedNames = new Set();
  rawTasks.forEach((t) => {
    if (!t.startDate) return;
    const key = t.createdBy.toUpperCase();
    const person = byEmployee[key];
    if (!person) unmatchedNames.add(t.createdBy);

    const { isoWeek } = isoWeekInfo(t.startDate);
    const seqKey = t.startDate.getFullYear() + "-W" + isoWeek;
    weekSeq[seqKey] = (weekSeq[seqKey] || 0) + 1;
    const taskId = "WT-" + t.startDate.getFullYear() + "-W" + isoWeek + "-" + String(weekSeq[seqKey]).padStart(4, "0");

    const status = normalizeStatusForPlanner(t.status, t.endDate);
    const match = person ? bestIndividualGoalMatch(t.task, person.goals) : null;

    out.push({
      Task_ID: taskId,
      Week: weekLabel(t.startDate),
      Month: monthLabel(t.startDate),
      Employee_ID: person ? person.Employee_ID : "",
      Employee_Name: person ? person.Employee_Name : t.createdBy,
      Department: person ? person.Department : "",
      Linked_Individual_Goal_ID: match ? s(match.Individual_Goal_ID) : "",
      Planned_Task: t.task,
      Expected_Output: "Completed / updated: " + t.task,
      Actual_Output: status === "Completed" ? "Completed" : "",
      Status: status,
      Progress_Percentage: status === "Completed" ? "100" : "0",
      Evidence: "",
      Challenge: status === "Delayed" ? "Planner flagged this task as overdue." : "",
      Supervisor_Comment: ""
    });
  });
  return { rows: out, unmatchedNames: Array.from(unmatchedNames) };
}

/* ============================== SEMANTIC MATCHING (client-side embeddings) ==============================
   Adds paraphrase/synonym-aware matching on top of the keyword-overlap checks above. Uses a small
   sentence-embedding model (all-MiniLM-L6-v2, ~23MB quantized) loaded on demand from a CDN via dynamic
   import -- runs entirely in the browser, no server round-trip, no API key, no per-run cost, and no
   data ever leaves the browser. If the model can't load (offline, blocked network), everything falls
   back silently to the keyword-only matching already used elsewhere in this file, so nothing regresses.
   Upgrade path: once an ANTHROPIC_API_KEY is configured as a Cloudflare Pages secret, this can be
   swapped for LLM-judged matching on the cases embeddings are least confident about -- higher accuracy,
   small ongoing cost. See README.md.
   ============================================================ */

const EMBED_MODEL_ID = "Xenova/all-MiniLM-L6-v2";
const EMBED_CDN_URL = "https://cdn.jsdelivr.net/npm/@xenova/transformers@2.17.2/+esm";
const SEMANTIC_STRONG = 0.55;    // near-paraphrase / clearly the same intent -- auto-link, no review flag
const SEMANTIC_MODERATE = 0.38;  // plausibly the same intent -- auto-link, flagged for human review

let _embedPipelinePromise = null;
let _embedUnavailable = false;
const _embedVectorCache = new Map(); // normalized text -> embedding vector

function getEmbedPipeline() {
  if (_embedUnavailable) return Promise.reject(new Error("Semantic matching unavailable in this session."));
  if (!_embedPipelinePromise) {
    _embedPipelinePromise = import(EMBED_CDN_URL)
      .then(({ pipeline, env }) => {
        env.allowLocalModels = false;
        return pipeline("feature-extraction", EMBED_MODEL_ID);
      })
      .catch((err) => { _embedUnavailable = true; throw err; });
  }
  return _embedPipelinePromise;
}

function embedCacheKey(text) { return String(text || "").trim().toLowerCase().slice(0, 800); }

async function embedTexts(texts) {
  const extractor = await getEmbedPipeline();
  const keys = texts.map(embedCacheKey);
  const toCompute = [];
  const seen = new Set();
  keys.forEach((k) => { if (k && !_embedVectorCache.has(k) && !seen.has(k)) { toCompute.push(k); seen.add(k); } });
  if (toCompute.length) {
    const out = await extractor(toCompute, { pooling: "mean", normalize: true });
    const dim = out.dims[1];
    toCompute.forEach((k, i) => { _embedVectorCache.set(k, Array.from(out.data.slice(i * dim, (i + 1) * dim))); });
  }
  return keys.map((k) => _embedVectorCache.get(k) || null);
}

function cosineSim(a, b) {
  if (!a || !b) return 0;
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return dot; // vectors are pre-normalized by the pipeline, so dot product === cosine similarity
}

/* Blended matcher: semantic cosine similarity (catches paraphrases/synonyms -- "resolve staff issues"
   matching "improve retention") plus a small keyword-overlap nudge (rewards exact shared terminology).
   Returns {candidate, confidence, score} on a match, {candidate:null, closest, closestScore} if nothing
   clears the bar (kept so Data Validation can show the closest near-miss for a human to judge), or
   {unavailable:true} if the model couldn't be reached (caller falls back to keyword-only). */
async function semanticBestMatch(sourceText, candidates, getCandidateText) {
  if (!candidates.length) return null;
  const candTexts = candidates.map(getCandidateText);
  let srcVec, candVecs;
  try {
    const vecs = await embedTexts([sourceText, ...candTexts]);
    srcVec = vecs[0];
    candVecs = vecs.slice(1);
  } catch (err) {
    return { unavailable: true };
  }
  const srcTokens = new Set(rawPlannerTokenize(sourceText));
  let best = null;
  candidates.forEach((c, i) => {
    const semantic = cosineSim(srcVec, candVecs[i]);
    const candTokens = rawPlannerTokenize(candTexts[i]);
    let overlap = 0;
    candTokens.forEach((t) => { if (srcTokens.has(t)) overlap++; });
    const combined = Math.min(1, semantic + Math.min(overlap * 0.06, 0.18));
    if (!best || combined > best.combined) best = { candidate: c, semantic, combined };
  });
  if (best.combined >= SEMANTIC_MODERATE) {
    return { candidate: best.candidate, confidence: best.combined >= SEMANTIC_STRONG ? "strong" : "moderate", score: best.combined };
  }
  return { candidate: null, closest: best.candidate, closestScore: best.combined };
}

/* Post-load pass: for any row whose cascade link is blank, try to auto-suggest it using semantic
   matching against the appropriate candidate set. Mutates STATE.datasets in place (only blank links --
   an explicit value already in the uploaded file is never overwritten), tags each row it touches with
   _autoLinked/_linkConfidence/_linkScore (or _closestCandidateId/_closestCandidateTitle/_closestScore
   when nothing clears the bar) for transparent reporting in Data Validation, then re-runs validation
   and re-renders. A run ID guards against a stale in-flight pass clobbering a newer upload. */
STATE.semanticRunId = 0;

async function runSemanticAutoLink() {
  if (!allDatasetsLoaded()) return;
  const myRunId = ++STATE.semanticRunId;
  let touched = 0, flaggedForReview = 0, modelFailed = false;

  // 1) Departmental Goals -> Company Goals
  const companyGoals = STATE.datasets.companyGoals || [];
  for (const row of STATE.datasets.departmentalGoals || []) {
    if (myRunId !== STATE.semanticRunId) return;
    if (s(row.Linked_Company_Goal_ID) || !companyGoals.length) continue;
    const result = await semanticBestMatch(
      (row.Department_Goal_Title || "") + ". " + (row.Goal_Description || ""),
      companyGoals,
      (g) => (g.Company_Goal_Title || "") + ". " + (g.Goal_Description || "")
    );
    if (!result) continue;
    if (result.unavailable) { modelFailed = true; break; }
    if (result.candidate) {
      row.Linked_Company_Goal_ID = s(result.candidate.Company_Goal_ID);
      row._autoLinked = true; row._linkConfidence = result.confidence; row._linkScore = result.score;
      touched++; if (result.confidence === "moderate") flaggedForReview++;
    } else if (result.closest) {
      row._closestCandidateId = s(result.closest.Company_Goal_ID);
      row._closestCandidateTitle = s(result.closest.Company_Goal_Title);
      row._closestScore = result.closestScore;
    }
  }

  // 2) Individual Goals -> Departmental Goals (candidates span every department -- alignment can be
  //    cross-department, e.g. an HR-Tech-flavoured target owned by someone outside the HR Tech dept)
  if (!modelFailed) {
    const deptGoals = STATE.datasets.departmentalGoals || [];
    for (const row of STATE.datasets.individualGoals || []) {
      if (myRunId !== STATE.semanticRunId) return;
      if (s(row.Linked_Department_Goal_ID) || !deptGoals.length) continue;
      const result = await semanticBestMatch(
        (row.Individual_Goal_Title || "") + ". " + (row.KPI || "") + ". " + (row.Target || ""),
        deptGoals,
        (g) => (g.Department_Goal_Title || "") + ". " + (g.Goal_Description || "") + ". " + (g.KPI || "")
      );
      if (!result) continue;
      if (result.unavailable) { modelFailed = true; break; }
      if (result.candidate) {
        row.Linked_Department_Goal_ID = s(result.candidate.Department_Goal_ID);
        row._autoLinked = true; row._linkConfidence = result.confidence; row._linkScore = result.score;
        row._crossDepartment = !!(s(result.candidate.Department) && s(row.Department) && s(result.candidate.Department) !== s(row.Department));
        touched++; if (result.confidence === "moderate") flaggedForReview++;
      } else if (result.closest) {
        row._closestCandidateId = s(result.closest.Department_Goal_ID);
        row._closestCandidateTitle = s(result.closest.Department_Goal_Title);
        row._closestScore = result.closestScore;
      }
    }
  }

  // 3) Weekly Tasks -> Individual Goals (scoped to the same employee only -- a task can only be
  //    evidence toward that employee's own targets)
  if (!modelFailed) {
    const goalsByEmployee = {};
    (STATE.datasets.individualGoals || []).forEach((g) => {
      const key = s(g.Employee_ID);
      if (!key) return;
      (goalsByEmployee[key] = goalsByEmployee[key] || []).push(g);
    });
    for (const row of STATE.datasets.weeklyTasks || []) {
      if (myRunId !== STATE.semanticRunId) return;
      if (s(row.Linked_Individual_Goal_ID)) continue;
      const myGoals = goalsByEmployee[s(row.Employee_ID)] || [];
      if (!myGoals.length) continue;
      const result = await semanticBestMatch(
        (row.Planned_Task || "") + ". " + (row.Expected_Output || ""),
        myGoals,
        (g) => (g.Individual_Goal_Title || "") + ". " + (g.KPI || "") + ". " + (g.Target || "")
      );
      if (!result) continue;
      if (result.unavailable) { modelFailed = true; break; }
      if (result.candidate) {
        row.Linked_Individual_Goal_ID = s(result.candidate.Individual_Goal_ID);
        row._autoLinked = true; row._linkConfidence = result.confidence; row._linkScore = result.score;
        touched++; if (result.confidence === "moderate") flaggedForReview++;
      } else if (result.closest) {
        row._closestCandidateId = s(result.closest.Individual_Goal_ID);
        row._closestCandidateTitle = s(result.closest.Individual_Goal_Title);
        row._closestScore = result.closestScore;
      }
    }
  }

  if (myRunId !== STATE.semanticRunId) return;
  STATE.semanticMatchingAvailable = !modelFailed;
  if (touched > 0) {
    runValidation();
    renderSection();
    showToast(
      modelFailed
        ? "AI-assisted matching stopped partway (network/model issue) -- " + touched + " link(s) auto-suggested before that using keyword matching only."
        : "AI-assisted matching linked " + touched + " previously-blank goal link(s)" + (flaggedForReview ? " (" + flaggedForReview + " flagged for review -- see Data Validation)" : "") + ".",
      "success"
    );
  } else if (modelFailed) {
    showToast("AI-assisted matching couldn't load this session (offline or blocked network) -- falling back to keyword-only matching.", "error");
  }
}

function clearAnalysisState() {
  STATE.validation = null;
  STATE.validationAcknowledged = false;
  STATE.analysisRun = false;
  STATE.hierarchy = null;
  STATE.classifiedTasks = null;
  STATE.individualGoalSupport = null;
  STATE.departmentGoalSupport = null;
  STATE.companyGoalSupport = null;
  STATE.departmentRollups = null;
}

function allDatasetsLoaded() {
  return DATASET_ORDER.every((k) => Array.isArray(STATE.datasets[k]) && STATE.datasets[k].length > 0);
}

async function handleFileForSlot(slotKey, file) {
  try {
    let rows;
    if (slotKey === "weeklyTasks") {
      const rows2D = await readRawRows2D(file);
      if (looksLikeRawPlannerExport(rows2D)) {
        if (!STATE.datasets.individualGoals || !STATE.datasets.individualGoals.length) {
          showToast("Upload Individual Employee Goals first, then re-upload your KPI Planner export -- that's what lets tasks auto-link to the right employee.", "error");
          return;
        }
        const converted = transformRawPlannerToWeeklyTasks(rows2D, STATE.datasets.individualGoals);
        if (!converted.rows.length) { showToast("No task rows found in " + file.name, "error"); return; }
        rows = converted.rows;
        if (converted.unmatchedNames.length) {
          showToast(converted.unmatchedNames.length + " name(s) in the planner didn't match an employee on file (e.g. \"" + converted.unmatchedNames[0] + "\") -- check spelling/spacing in Individual Employee Goals.", "error");
        }
        showToast("Raw KPI Planner export detected: " + rows.length + " tasks parsed and auto-linked automatically -- no reformatting needed.", "success");
      } else {
        rows = await readDataFile(file);
      }
    } else {
      rows = await readDataFile(file);
    }
    if (!rows.length) { showToast("No data rows found in " + file.name, "error"); return; }
    STATE.datasets[slotKey] = rows;
    STATE.fileMeta[slotKey] = { name: file.name, count: rows.length, source: "upload" };
    STATE.usingSampleData = DATASET_ORDER.every((k) => STATE.fileMeta[k] && STATE.fileMeta[k].source === "sample");
    clearAnalysisState();
    showToast(DATASET_LABEL[slotKey] + " loaded: " + rows.length + " rows.", "success");
    renderSection();
    if (allDatasetsLoaded()) {
      runValidation();
      showToast("All datasets loaded. Validation is ready to review.", "success");
      runSemanticAutoLink();
    }
  } catch (err) {
    showToast("Could not read " + file.name + ": " + err.message, "error");
  }
}

function loadSampleData() {
  const sample = getSampleData();
  DATASET_ORDER.forEach((k) => {
    STATE.datasets[k] = sample[k];
    STATE.fileMeta[k] = { name: "sample_" + k.replace(/([A-Z])/g, "_$1").toLowerCase() + ".csv", count: sample[k].length, source: "sample" };
  });
  STATE.usingSampleData = true;
  clearAnalysisState();
  runValidation();
  showToast("Sample data loaded across all four datasets.", "success");
  renderSection();
  runSemanticAutoLink();
}

function removeDatasetSlot(slotKey) {
  STATE.datasets[slotKey] = null;
  STATE.fileMeta[slotKey] = null;
  STATE.usingSampleData = false;
  clearAnalysisState();
  renderSection();
}

/* ============================== UPLOAD CENTRE WIRING ============================== */

function wireUploadCentre() {
  DATASET_ORDER.forEach((slotKey) => {
    const dz = document.getElementById("dz-" + slotKey);
    const input = document.getElementById("file-" + slotKey);
    const removeBtn = document.getElementById("remove-" + slotKey);
    if (!dz || !input) return;
    dz.addEventListener("click", () => input.click());
    dz.addEventListener("dragover", (e) => { e.preventDefault(); dz.classList.add("dragover"); });
    dz.addEventListener("dragleave", () => dz.classList.remove("dragover"));
    dz.addEventListener("drop", (e) => {
      e.preventDefault(); dz.classList.remove("dragover");
      if (e.dataTransfer.files && e.dataTransfer.files[0]) handleFileForSlot(slotKey, e.dataTransfer.files[0]);
    });
    input.addEventListener("change", (e) => { if (e.target.files && e.target.files[0]) handleFileForSlot(slotKey, e.target.files[0]); });
    if (removeBtn) removeBtn.addEventListener("click", (e) => { e.stopPropagation(); removeDatasetSlot(slotKey); });
  });
  const sampleBtn = document.getElementById("loadSampleDataBtn");
  if (sampleBtn) sampleBtn.addEventListener("click", loadSampleData);
  const goValidateBtn = document.getElementById("goToValidationBtn");
  if (goValidateBtn) goValidateBtn.addEventListener("click", () => navigateTo("data-validation"));
}
/* ============================== VALIDATION ENGINE ============================== */

function checkMissingColumns(dataset, rows) {
  const issues = [];
  if (!rows.length) return { issues, missing: [] };
  const headerSet = new Set(Object.keys(rows[0]));
  const missing = REQUIRED_FIELDS[dataset].filter((f) => !headerSet.has(f));
  if (missing.length) {
    issues.push({
      severity: "error", dataset, code: "missing-columns",
      message: "Missing required column(s) in " + DATASET_LABEL[dataset] + ": " + missing.join(", "),
      meta: "Re-upload this file with all required columns before analysis can run."
    });
  }
  return { issues, missing };
}

function checkIdsAndGetExclusions(dataset, rows) {
  const issues = [];
  const excluded = new Set(); // row indices (0-based) excluded from analysis
  const idField = ID_FIELD[dataset];
  const seen = new Map();
  rows.forEach((row, idx) => {
    const val = s(row[idField]);
    if (!val) {
      issues.push({ severity: "error", dataset, code: "missing-id", message: "Missing " + idField + " on " + DATASET_LABEL[dataset] + " row " + (idx + 1) + ".", meta: "This row is excluded from analysis until an ID is added." });
      excluded.add(idx);
      return;
    }
    if (seen.has(val)) {
      issues.push({ severity: "error", dataset, code: "duplicate-id", message: "Duplicate " + idField + " \"" + val + "\" on " + DATASET_LABEL[dataset] + " row " + (idx + 1) + " (first seen on row " + (seen.get(val) + 1) + ").", meta: "Only the first occurrence is used in analysis; this row is excluded." });
      excluded.add(idx);
    } else {
      seen.set(val, idx);
    }
  });
  return { issues, excluded };
}

function runValidation() {
  const issues = [];
  const suggestions = [];
  const excludedRowKeys = new Set();   // `${dataset}:${idx}`
  const columnErrorDatasets = new Set();

  DATASET_ORDER.forEach((dataset) => {
    const rows = STATE.datasets[dataset] || [];
    const { issues: colIssues, missing } = checkMissingColumns(dataset, rows);
    issues.push(...colIssues);
    if (missing.length) { columnErrorDatasets.add(dataset); return; } // can't check IDs reliably without the ID column
    if (!REQUIRED_FIELDS[dataset].includes(ID_FIELD[dataset])) return;
    const { issues: idIssues, excluded } = checkIdsAndGetExclusions(dataset, rows);
    issues.push(...idIssues);
    excluded.forEach((idx) => excludedRowKeys.add(dataset + ":" + idx));
  });

  // Build clean ID sets (excluding rows already flagged for missing/duplicate IDs) for linkage checks
  const cleanIds = {};
  DATASET_ORDER.forEach((dataset) => {
    const rows = STATE.datasets[dataset] || [];
    cleanIds[dataset] = new Set(rows
      .map((row, idx) => ({ row, idx }))
      .filter(({ idx }) => !excludedRowKeys.has(dataset + ":" + idx))
      .map(({ row }) => s(row[ID_FIELD[dataset]])));
  });

  // Cross-dataset linkage warnings
  if (!columnErrorDatasets.has("departmentalGoals") && !columnErrorDatasets.has("companyGoals")) {
    (STATE.datasets.departmentalGoals || []).forEach((row, idx) => {
      if (excludedRowKeys.has("departmentalGoals:" + idx)) return;
      const link = s(row.Linked_Company_Goal_ID);
      if (link && !cleanIds.companyGoals.has(link)) {
        issues.push({ severity: "warning", dataset: "departmentalGoals", code: "broken-link-company", message: "Departmental Goal " + row.Department_Goal_ID + " links to missing Company Goal \"" + link + "\".", meta: "This goal will appear as an unresolved link in Goal Mapping and analysis." });
      } else if (!link) {
        if (row._autoLinked) {
          suggestions.push({ severity: "suggestion", dataset: "departmentalGoals", code: "ai-link-company", message: "Departmental Goal " + row.Department_Goal_ID + " was auto-linked by AI-assisted matching (" + row._linkConfidence + " confidence, " + Math.round(row._linkScore * 100) + "% match).", meta: row._linkConfidence === "moderate" ? "Moderate confidence \u2014 please review this link." : "" });
        } else {
          issues.push({ severity: "warning", dataset: "departmentalGoals", code: "blank-link-company", message: "Departmental Goal " + row.Department_Goal_ID + " has no Linked_Company_Goal_ID.", meta: row._closestCandidateTitle ? "Closest match considered: \u201c" + row._closestCandidateTitle + "\u201d (" + Math.round((row._closestScore || 0) * 100) + "% similarity) \u2014 below the confidence threshold for auto-linking." : "" });
        }
      }
    });
  }
  if (!columnErrorDatasets.has("individualGoals") && !columnErrorDatasets.has("departmentalGoals")) {
    (STATE.datasets.individualGoals || []).forEach((row, idx) => {
      if (excludedRowKeys.has("individualGoals:" + idx)) return;
      const link = s(row.Linked_Department_Goal_ID);
      if (link && !cleanIds.departmentalGoals.has(link)) {
        issues.push({ severity: "warning", dataset: "individualGoals", code: "broken-link-dept", message: "Individual Goal " + row.Individual_Goal_ID + " (" + row.Employee_Name + ") links to missing Departmental Goal \"" + link + "\".", meta: "Tasks under this goal will be classified as Unclear due to insufficient information." });
      } else if (!link) {
        if (row._autoLinked) {
          suggestions.push({ severity: "suggestion", dataset: "individualGoals", code: "ai-link-dept", message: "Individual Goal " + row.Individual_Goal_ID + " (" + row.Employee_Name + ") was auto-linked by AI-assisted matching (" + row._linkConfidence + " confidence, " + Math.round(row._linkScore * 100) + "% match)" + (row._crossDepartment ? " \u2014 note: matched goal belongs to a different department." : "") + ".", meta: row._linkConfidence === "moderate" ? "Moderate confidence \u2014 please review this link." : "" });
        } else {
          issues.push({ severity: "warning", dataset: "individualGoals", code: "blank-link-dept", message: "Individual Goal " + row.Individual_Goal_ID + " (" + row.Employee_Name + ") has no Linked_Department_Goal_ID.", meta: row._closestCandidateTitle ? "Closest match considered: \u201c" + row._closestCandidateTitle + "\u201d (" + Math.round((row._closestScore || 0) * 100) + "% similarity) \u2014 below the confidence threshold for auto-linking." : "" });
        }
      }
    });
  }
  if (!columnErrorDatasets.has("weeklyTasks") && !columnErrorDatasets.has("individualGoals")) {
    (STATE.datasets.weeklyTasks || []).forEach((row, idx) => {
      if (excludedRowKeys.has("weeklyTasks:" + idx)) return;
      const link = s(row.Linked_Individual_Goal_ID);
      const taskRef = s(row.Task_ID) || ("row " + (idx + 1));
      if (link && !cleanIds.individualGoals.has(link)) {
        issues.push({ severity: "warning", dataset: "weeklyTasks", code: "broken-link-indiv", message: "Task " + taskRef + " (" + row.Employee_Name + ") links to missing Individual Goal \"" + link + "\".", meta: "This task will be classified as Unclear due to insufficient information." });
      } else if (!link) {
        if (row._autoLinked) {
          suggestions.push({ severity: "suggestion", dataset: "weeklyTasks", code: "ai-link-indiv", message: "Task " + taskRef + " (" + row.Employee_Name + ") was auto-linked by AI-assisted matching (" + row._linkConfidence + " confidence, " + Math.round(row._linkScore * 100) + "% match).", meta: row._linkConfidence === "moderate" ? "Moderate confidence \u2014 please review this link." : "" });
        } else {
          issues.push({ severity: "warning", dataset: "weeklyTasks", code: "blank-link-indiv", message: "Task " + taskRef + " (" + row.Employee_Name + ") has no Linked_Individual_Goal_ID.", meta: row._closestCandidateTitle ? "Closest match considered: \u201c" + row._closestCandidateTitle + "\u201d (" + Math.round((row._closestScore || 0) * 100) + "% similarity) \u2014 below the confidence threshold for auto-linking." : "" });
        }
      }
    });
  }

  // Row-content warnings on Weekly Tasks
  if (!columnErrorDatasets.has("weeklyTasks")) {
    (STATE.datasets.weeklyTasks || []).forEach((row, idx) => {
      if (excludedRowKeys.has("weeklyTasks:" + idx)) return;
      const taskRef = s(row.Task_ID) || ("row " + (idx + 1));
      if (isBlank(row.Planned_Task)) issues.push({ severity: "warning", dataset: "weeklyTasks", code: "blank-task", message: "Task " + taskRef + " (" + row.Employee_Name + ") has a blank task description.", meta: "Cannot be scored for relevance; will be classified as Unclear due to insufficient information." });
      if (isBlank(row.Expected_Output)) issues.push({ severity: "warning", dataset: "weeklyTasks", code: "missing-output", message: "Task " + taskRef + " (" + row.Employee_Name + ") is missing an expected output.", meta: "Reduces the measurability component of the alignment score." });
      if (isBlank(row.Status)) issues.push({ severity: "warning", dataset: "weeklyTasks", code: "missing-status", message: "Task " + taskRef + " (" + row.Employee_Name + ") is missing a status.", meta: "Reduces the progress component of the alignment score." });
      if (isBlank(row.Evidence)) issues.push({ severity: "warning", dataset: "weeklyTasks", code: "missing-evidence", message: "Task " + taskRef + " (" + row.Employee_Name + ") has no evidence attached.", meta: "Reduces the evidence component of the alignment score." });
      const pctRaw = s(row.Progress_Percentage);
      if (pctRaw !== "") {
        const pct = Number(pctRaw);
        if (Number.isNaN(pct) || pct < 0 || pct > 100) {
          issues.push({ severity: "warning", dataset: "weeklyTasks", code: "invalid-progress", message: "Task " + taskRef + " (" + row.Employee_Name + ") has an invalid progress percentage \"" + pctRaw + "\" (expected 0\u2013100).", meta: "" });
        }
      }
    });

    // Department mismatch: canonical department per employee, from Individual Goals
    const employeeDept = {};
    (STATE.datasets.individualGoals || []).forEach((row) => {
      const emp = s(row.Employee_ID);
      if (emp && !employeeDept[emp]) employeeDept[emp] = s(row.Department);
    });
    (STATE.datasets.weeklyTasks || []).forEach((row, idx) => {
      if (excludedRowKeys.has("weeklyTasks:" + idx)) return;
      const emp = s(row.Employee_ID);
      const taskRef = s(row.Task_ID) || ("row " + (idx + 1));
      const canonical = employeeDept[emp];
      if (canonical && s(row.Department) && s(row.Department) !== canonical) {
        issues.push({ severity: "warning", dataset: "weeklyTasks", code: "dept-mismatch", message: "Task " + taskRef + " (" + row.Employee_Name + ") shows Department \"" + row.Department + "\", but the employee's goal record shows \"" + canonical + "\".", meta: "Verify which department this task should be attributed to." });
      }
    });
  }

  const errors = issues.filter((i) => i.severity === "error");
  const warnings = issues.filter((i) => i.severity === "warning");
  STATE.validation = { errors, warnings, suggestions, excludedRowKeys, columnErrorDatasets };
  return STATE.validation;
}

function canProceedToAnalysis() {
  return !!STATE.validation && STATE.validation.columnErrorDatasets.size === 0;
}
/* ============================== RELEVANCE SCORING ============================== */

const STOPWORDS = new Set(["a","an","the","to","of","in","on","for","and","or","with","by","is","are","this","that","at","as","from","be","it","its","their","will","was","were","has","have","had","into","per","via"]);

function tokenize(text) {
  if (!text) return [];
  return String(text).toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/)
    .filter(Boolean).filter((w) => w.length >= 3 && !STOPWORDS.has(w)).map((w) => w.replace(/s$/, ""));
}
function tokenSet(text) { return new Set(tokenize(text)); }
function containmentRatio(goalTokens, taskTokenSet) {
  if (!goalTokens.size) return 0;
  let hits = 0;
  goalTokens.forEach((t) => { if (taskTokenSet.has(t)) hits++; });
  return hits / goalTokens.size;
}
function computeRelevance(task, individualGoal, deptGoal, companyGoal) {
  const taskTokens = tokenSet((task.Planned_Task || "") + " " + (task.Expected_Output || ""));
  const primaryGoalTokens = tokenSet((individualGoal ? individualGoal.Individual_Goal_Title : "") + " " + (individualGoal ? individualGoal.KPI : ""));
  const secondaryGoalTokens = tokenSet((deptGoal ? deptGoal.Department_Goal_Title : "") + " " + (deptGoal ? deptGoal.KPI : "") + " " + (companyGoal ? companyGoal.Company_Goal_Title : ""));
  const primaryRatio = containmentRatio(primaryGoalTokens, taskTokens);
  const secondaryRatio = containmentRatio(secondaryGoalTokens, taskTokens);
  const combined = clamp01(primaryRatio * 0.7 + secondaryRatio * 0.3);
  return Math.round(combined * 25);
}

/* ============================== CLASSIFICATION ENGINE ============================== */

function classifyTask(task, ctx) {
  const linkId = s(task.Linked_Individual_Goal_ID);
  const individualGoal = linkId ? ctx.individualGoalsById[linkId] || null : null;
  let deptGoal = null, companyGoal = null, linkagePoints = 0, linkageValid = false;

  if (individualGoal) {
    const dgId = s(individualGoal.Linked_Department_Goal_ID);
    deptGoal = dgId ? ctx.departmentGoalsById[dgId] || null : null;
    if (deptGoal) {
      const cgId = s(deptGoal.Linked_Company_Goal_ID);
      companyGoal = cgId ? ctx.companyGoalsById[cgId] || null : null;
      linkagePoints = companyGoal ? 25 : 10;
      linkageValid = !!companyGoal;
    } else {
      linkagePoints = 10;
    }
  }

  const relevancePoints = computeRelevance(task, individualGoal, deptGoal, companyGoal);

  const expectedOutput = s(task.Expected_Output);
  const measurabilityPoints = !expectedOutput ? 0 : (expectedOutput.length < 12 ? 12 : 20);

  const evidence = s(task.Evidence);
  const actualOutput = s(task.Actual_Output);
  const evidenceCount = (evidence ? 1 : 0) + (actualOutput ? 1 : 0);
  const evidencePoints = evidenceCount === 2 ? 20 : evidenceCount === 1 ? 10 : 0;

  const statusRaw = s(task.Status);
  let progressPoints;
  if (!statusRaw) progressPoints = 0;
  else if (statusRaw in STATUS_POINTS) progressPoints = STATUS_POINTS[statusRaw];
  else progressPoints = 5;

  const total = linkagePoints + relevancePoints + measurabilityPoints + evidencePoints + progressPoints;

  const plannedTask = s(task.Planned_Task);
  const criticalMissing = !plannedTask || (!expectedOutput && !evidence && !statusRaw);

  let classification, reasonTag;
  if (criticalMissing) {
    classification = "Unclear due to insufficient information";
    reasonTag = !plannedTask ? "missing-task" : "missing-core-fields";
  } else if (!individualGoal || !linkageValid) {
    classification = "Unclear due to insufficient information";
    reasonTag = !individualGoal ? "goal-not-found" : "broken-chain";
  } else {
    const relevanceRatio = relevancePoints / 25;
    const executionScore = measurabilityPoints + evidencePoints + progressPoints; // 0-50
    if (relevanceRatio > 0) {
      if (total >= 80) { classification = "Directly aligned"; reasonTag = "strong-score"; }
      else if (total >= 55) { classification = "Indirectly aligned"; reasonTag = "moderate-score"; }
      else if (executionScore >= 25) { classification = "Routine/Business-as-usual"; reasonTag = "low-relevance-ok-execution"; }
      else { classification = "Misaligned"; reasonTag = "low-score"; }
    } else {
      if (executionScore >= 30) { classification = "Routine/Business-as-usual"; reasonTag = "no-relevance-ok-execution"; }
      else { classification = "Misaligned"; reasonTag = "no-relevance-poor-execution"; }
    }
  }

  return {
    individualGoal, deptGoal, companyGoal,
    linkagePoints, linkageValid, relevancePoints, measurabilityPoints, evidencePoints, progressPoints,
    total, classification, reasonTag
  };
}

/* ============================== GOAL SUPPORT SUMMARIES ============================== */

function summarizeTasks(tasks) {
  const taskCount = tasks.length;
  const avgScore = avg(tasks.map((t) => t._score.total));
  const byClass = {};
  CLASSIFICATIONS.forEach((c) => { byClass[c] = 0; });
  tasks.forEach((t) => { byClass[t._score.classification] = (byClass[t._score.classification] || 0) + 1; });
  const strongCount = (byClass["Directly aligned"] || 0) + (byClass["Indirectly aligned"] || 0);
  const strongRatio = taskCount ? strongCount / taskCount : 0;
  let supportLevel;
  if (taskCount === 0) supportLevel = "No Activity Support";
  else if (avgScore >= 65 && strongRatio >= 0.5) supportLevel = "Strong Support";
  else supportLevel = "Weak Support";
  const challengeCount = tasks.filter((t) => !isBlank(t.Challenge)).length;
  const evidenceMissingCount = tasks.filter((t) => isBlank(t.Evidence)).length;
  const atRisk = supportLevel !== "Strong Support" || challengeCount >= 2 || (taskCount > 0 && evidenceMissingCount / taskCount > 0.4);
  const riskReasons = [];
  if (supportLevel === "No Activity Support") riskReasons.push("No weekly tasks logged against this goal");
  if (supportLevel === "Weak Support") riskReasons.push("Linked tasks show low alignment scores or limited direct contribution");
  if (challengeCount >= 2) riskReasons.push(challengeCount + " linked tasks reported a challenge or blocker");
  if (taskCount > 0 && evidenceMissingCount / taskCount > 0.4) riskReasons.push("Over 40% of linked tasks have no evidence attached");
  return { taskCount, avgScore, byClass, strongCount, strongRatio, supportLevel, challengeCount, evidenceMissingCount, atRisk, riskReasons };
}

/* ============================== ANALYSIS ORCHESTRATOR ============================== */

function cleanRows(dataset) {
  const rows = STATE.datasets[dataset] || [];
  const excluded = (STATE.validation && STATE.validation.excludedRowKeys) || new Set();
  return rows.filter((row, idx) => !excluded.has(dataset + ":" + idx));
}

function runAnalysis() {
  const companyGoals = cleanRows("companyGoals");
  const departmentalGoals = cleanRows("departmentalGoals");
  const individualGoals = cleanRows("individualGoals");
  const weeklyTasks = cleanRows("weeklyTasks");

  const companyGoalsById = byIdMap(companyGoals, "Company_Goal_ID");
  const departmentGoalsById = byIdMap(departmentalGoals, "Department_Goal_ID");
  const individualGoalsById = byIdMap(individualGoals, "Individual_Goal_ID");
  const ctx = { companyGoalsById, departmentGoalsById, individualGoalsById };

  const classifiedTasks = weeklyTasks.map((task) => {
    const score = classifyTask(task, ctx);
    return Object.assign({}, task, { _score: score });
  });

  // Per-individual-goal support
  const individualGoalSupport = {};
  individualGoals.forEach((ig) => {
    const tasks = classifiedTasks.filter((t) => s(t.Linked_Individual_Goal_ID) === s(ig.Individual_Goal_ID));
    individualGoalSupport[ig.Individual_Goal_ID] = summarizeTasks(tasks);
  });

  // Per-department-goal support (pool tasks of all individual goals under that dept goal)
  const departmentGoalSupport = {};
  departmentalGoals.forEach((dg) => {
    const childIgs = individualGoals.filter((ig) => s(ig.Linked_Department_Goal_ID) === s(dg.Department_Goal_ID));
    const igIds = new Set(childIgs.map((ig) => s(ig.Individual_Goal_ID)));
    const tasks = classifiedTasks.filter((t) => igIds.has(s(t.Linked_Individual_Goal_ID)));
    departmentGoalSupport[dg.Department_Goal_ID] = summarizeTasks(tasks);
  });

  // Per-company-goal support (pool across all descendant dept goals)
  const companyGoalSupport = {};
  companyGoals.forEach((cg) => {
    const childDgs = departmentalGoals.filter((dg) => s(dg.Linked_Company_Goal_ID) === s(cg.Company_Goal_ID));
    const childIgs = individualGoals.filter((ig) => childDgs.some((dg) => s(dg.Department_Goal_ID) === s(ig.Linked_Department_Goal_ID)));
    const igIds = new Set(childIgs.map((ig) => s(ig.Individual_Goal_ID)));
    const tasks = classifiedTasks.filter((t) => igIds.has(s(t.Linked_Individual_Goal_ID)));
    companyGoalSupport[cg.Company_Goal_ID] = summarizeTasks(tasks);
  });

  // Department rollups, pooled by the task's own Department field (robust to multiple dept goals per dept)
  const departmentRollups = {};
  uniqueValues(weeklyTasks, "Department").forEach((dept) => {
    const tasks = classifiedTasks.filter((t) => s(t.Department) === dept);
    departmentRollups[dept] = summarizeTasks(tasks);
  });

  // Hierarchy tree for Goal Mapping
  const orphanDeptGoals = [];
  const orphanIndividualGoals = [];
  const orphanTasks = classifiedTasks.filter((t) => !t._score.individualGoal);

  const hierarchy = {
    companyGoals: companyGoals.map((cg) => {
      const childDgs = departmentalGoals.filter((dg) => s(dg.Linked_Company_Goal_ID) === s(cg.Company_Goal_ID));
      return Object.assign({}, cg, {
        support: companyGoalSupport[cg.Company_Goal_ID],
        deptGoals: childDgs.map((dg) => {
          const childIgs = individualGoals.filter((ig) => s(ig.Linked_Department_Goal_ID) === s(dg.Department_Goal_ID));
          return Object.assign({}, dg, {
            support: departmentGoalSupport[dg.Department_Goal_ID],
            individualGoals: childIgs.map((ig) => Object.assign({}, ig, {
              support: individualGoalSupport[ig.Individual_Goal_ID],
              tasks: classifiedTasks.filter((t) => s(t.Linked_Individual_Goal_ID) === s(ig.Individual_Goal_ID))
            }))
          });
        })
      });
    })
  };
  departmentalGoals.forEach((dg) => {
    if (!companyGoalsById[s(dg.Linked_Company_Goal_ID)]) {
      const childIgs = individualGoals.filter((ig) => s(ig.Linked_Department_Goal_ID) === s(dg.Department_Goal_ID));
      orphanDeptGoals.push(Object.assign({}, dg, {
        support: departmentGoalSupport[dg.Department_Goal_ID],
        individualGoals: childIgs.map((ig) => Object.assign({}, ig, {
          support: individualGoalSupport[ig.Individual_Goal_ID],
          tasks: classifiedTasks.filter((t) => s(t.Linked_Individual_Goal_ID) === s(ig.Individual_Goal_ID))
        }))
      }));
    }
  });
  individualGoals.forEach((ig) => {
    if (!departmentGoalsById[s(ig.Linked_Department_Goal_ID)]) {
      orphanIndividualGoals.push(Object.assign({}, ig, {
        support: individualGoalSupport[ig.Individual_Goal_ID],
        tasks: classifiedTasks.filter((t) => s(t.Linked_Individual_Goal_ID) === s(ig.Individual_Goal_ID))
      }));
    }
  });
  hierarchy.orphanDeptGoals = orphanDeptGoals;
  hierarchy.orphanIndividualGoals = orphanIndividualGoals;
  hierarchy.orphanTasks = orphanTasks;

  STATE.classifiedTasks = classifiedTasks;
  STATE.individualGoalSupport = individualGoalSupport;
  STATE.departmentGoalSupport = departmentGoalSupport;
  STATE.companyGoalSupport = companyGoalSupport;
  STATE.departmentRollups = departmentRollups;
  STATE.hierarchy = hierarchy;
  STATE.analysisRun = true;
}
/* ============================== REASON TEXT & RECOMMENDATIONS ============================== */

const REASON_TAG_TEXT = {
  "missing-task": "No task description was provided.",
  "missing-core-fields": "Expected output, evidence, and status were all left blank.",
  "goal-not-found": "The linked Individual Goal ID does not exist in the goals dataset.",
  "broken-chain": "The goal chain is incomplete above the individual goal (missing department or company goal link).",
  "strong-score": "Strong linkage, relevance, and execution.",
  "moderate-score": "Valid linkage with moderate relevance and execution.",
  "low-relevance-ok-execution": "Well executed, but shows little direct relevance to the linked goal's wording.",
  "low-score": "Valid linkage, but low relevance and weak execution.",
  "no-relevance-ok-execution": "Reasonably executed, but the task text shows no clear connection to the linked goal \u2014 likely routine work.",
  "no-relevance-poor-execution": "No clear connection to the linked goal, and limited evidence of execution."
};

function generateTaskFollowUp(task) {
  const sc = task._score;
  const emp = task.Employee_Name || "the employee";
  const goalTitle = sc.individualGoal ? sc.individualGoal.Individual_Goal_Title : null;
  switch (sc.classification) {
    case "Directly aligned":
      return null;
    case "Indirectly aligned":
      return "Recognize the contribution. Consider whether this task could be framed to more directly target \"" + goalTitle + "\" going forward.";
    case "Routine/Business-as-usual":
      return "Reasonable day-to-day work. If " + emp + " is logging mostly routine tasks, check whether enough weekly time is allocated to \"" + (goalTitle || "their stated goal") + "\".";
    case "Misaligned":
      return "Discuss with " + emp + " how this task connects to \"" + (goalTitle || "their linked goal") + "\", or confirm whether it should be logged differently.";
    case "Unclear due to insufficient information":
      if (sc.reasonTag === "missing-task") return "Ask " + emp + " to provide a task description for this entry before it can be assessed.";
      if (sc.reasonTag === "missing-core-fields") return "Ask " + emp + " to add an expected output, evidence, or status for this task.";
      if (sc.reasonTag === "goal-not-found") return "Confirm the correct Individual Goal ID for this task \u2014 the one provided was not found in the goals dataset.";
      if (sc.reasonTag === "broken-chain") return "This task's goal chain is incomplete upstream. Resolve the missing department or company goal link before this can be confidently classified.";
      return "Insufficient information to classify this task confidently.";
    default:
      return null;
  }
}

function generateGoalRecommendation(support, title, owner) {
  owner = owner || "the goal owner";
  let base;
  if (support.supportLevel === "No Activity Support") base = "No weekly tasks have been logged against \"" + title + "\" yet. Confirm with " + owner + " whether work has started and ensure it is being tracked in the Weekly KPI Planner.";
  else if (support.supportLevel === "Weak Support") base = "\"" + title + "\" has some linked activity, but alignment scores are modest. Recommend a check-in with " + owner + " to clarify priorities and strengthen the connection between weekly tasks and this goal.";
  else base = "\"" + title + "\" is well supported by linked weekly activity. Continue the current cadence and review again next reporting period.";
  if (support.challengeCount >= 2) base += " Multiple linked tasks reported recurring challenges \u2014 review blockers with the team.";
  return base;
}

/* ============================== EXECUTIVE KPIs & ROLLUPS ============================== */

function pooledGoalSupportRecords() {
  const records = [];
  (STATE.datasets.companyGoals ? cleanRows("companyGoals") : []).forEach((cg) => {
    const sup = STATE.companyGoalSupport[cg.Company_Goal_ID];
    if (sup) records.push({ level: "Company", id: cg.Company_Goal_ID, title: cg.Company_Goal_Title, owner: cg.Goal_Owner, department: null, support: sup });
  });
  cleanRows("departmentalGoals").forEach((dg) => {
    const sup = STATE.departmentGoalSupport[dg.Department_Goal_ID];
    if (sup) records.push({ level: "Department", id: dg.Department_Goal_ID, title: dg.Department_Goal_Title, owner: dg.Goal_Owner, department: dg.Department, support: sup });
  });
  cleanRows("individualGoals").forEach((ig) => {
    const sup = STATE.individualGoalSupport[ig.Individual_Goal_ID];
    if (sup) records.push({ level: "Individual", id: ig.Individual_Goal_ID, title: ig.Individual_Goal_Title, owner: ig.Employee_Name, department: ig.Department, support: sup });
  });
  return records;
}

function computeExecutiveKPIs() {
  const totalCompanyGoals = cleanRows("companyGoals").length;
  const totalDeptGoals = cleanRows("departmentalGoals").length;
  const totalIndividualGoals = cleanRows("individualGoals").length;
  const tasks = STATE.classifiedTasks || [];
  const totalTasks = tasks.length;

  const classificationCounts = {};
  CLASSIFICATIONS.forEach((c) => { classificationCounts[c] = 0; });
  tasks.forEach((t) => { classificationCounts[t._score.classification]++; });
  const classificationPct = {};
  CLASSIFICATIONS.forEach((c) => { classificationPct[c] = totalTasks ? (classificationCounts[c] / totalTasks) * 100 : 0; });

  const goalRecords = pooledGoalSupportRecords();
  const strongSupportGoals = goalRecords.filter((r) => r.support.supportLevel === "Strong Support").length;
  const weakSupportGoals = goalRecords.filter((r) => r.support.supportLevel === "Weak Support").length;
  const noActivityGoals = goalRecords.filter((r) => r.support.supportLevel === "No Activity Support").length;

  const departmentsAtRisk = Object.keys(STATE.departmentRollups || {}).filter((d) => STATE.departmentRollups[d].atRisk).length;

  const unclearEmployeeIds = new Set();
  tasks.forEach((t) => { if (t._score.classification === "Unclear due to insufficient information") unclearEmployeeIds.add(s(t.Employee_ID)); });

  return {
    totalCompanyGoals, totalDeptGoals, totalIndividualGoals, totalTasks,
    classificationCounts, classificationPct,
    strongSupportGoals, weakSupportGoals, noActivityGoals,
    departmentsAtRisk, employeesNeedingClarification: unclearEmployeeIds.size
  };
}

function computeAtRiskGoalsList() {
  const records = pooledGoalSupportRecords().filter((r) => r.support.atRisk);
  records.sort((a, b) => {
    const order = { "No Activity Support": 0, "Weak Support": 1, "Strong Support": 2 };
    if (order[a.support.supportLevel] !== order[b.support.supportLevel]) return order[a.support.supportLevel] - order[b.support.supportLevel];
    return a.support.avgScore - b.support.avgScore;
  });
  return records;
}

// KPI compliance: for a given period/dept filter, returns who submitted, who didn't,
// and counts of not-started and at-risk (delayed/blocked) tasks.
function computeKPICompliance(periodFilter, deptFilter) {
  const allTasks = STATE.classifiedTasks || [];
  let tasks = allTasks;
  if (deptFilter && deptFilter !== "all") tasks = tasks.filter((t) => s(t.Department) === deptFilter);
  if (periodFilter && periodFilter !== "all") {
    if (periodFilter.startsWith("month:")) {
      const month = periodFilter.slice(6);
      tasks = tasks.filter((t) => s(t.Month) === month);
    } else {
      const parts = periodFilter.split("|");
      tasks = tasks.filter((t) => s(t.Month) === parts[0] && s(t.Week) === parts[1]);
    }
  }
  const roster = employeeRoster().filter((e) => deptFilter === "all" || e.Department === deptFilter);
  const submittedIds = new Set(tasks.map((t) => s(t.Employee_ID)).filter(Boolean));
  const submitted = roster.filter((e) => submittedIds.has(e.Employee_ID));
  const notSubmitted = roster.filter((e) => !submittedIds.has(e.Employee_ID));
  const notStarted = tasks.filter((t) => {
    const st = s(t.Status);
    const pct = Number(t.Progress_Percentage);
    return st === "Not Started" || (!st && pct === 0);
  });
  const overdue = tasks.filter((t) => { const st = s(t.Status); return st === "Delayed" || st === "Blocked"; });
  return { submitted, notSubmitted, notStarted, overdue, tasks, roster };
}

function computeEmployeesNeedingClarification() {
  const byEmployee = {};
  (STATE.classifiedTasks || []).forEach((t) => {
    if (t._score.classification !== "Unclear due to insufficient information") return;
    const key = s(t.Employee_ID) || t.Employee_Name;
    if (!byEmployee[key]) byEmployee[key] = { Employee_ID: t.Employee_ID, Employee_Name: t.Employee_Name, Department: t.Department, tasks: [] };
    byEmployee[key].tasks.push(t);
  });
  return Object.values(byEmployee).sort((a, b) => b.tasks.length - a.tasks.length);
}

function employeeRoster() {
  const byId = {};
  cleanRows("individualGoals").forEach((ig) => {
    const id = s(ig.Employee_ID);
    if (!id) return;
    if (!byId[id]) byId[id] = { Employee_ID: id, Employee_Name: ig.Employee_Name, Department: ig.Department, Job_Title: ig.Job_Title };
  });
  (STATE.classifiedTasks || []).forEach((t) => {
    const id = s(t.Employee_ID);
    if (id && !byId[id]) byId[id] = { Employee_ID: id, Employee_Name: t.Employee_Name, Department: t.Department, Job_Title: "" };
  });
  return Object.values(byId).sort((a, b) => a.Employee_Name.localeCompare(b.Employee_Name));
}
/* ============================== SHARED UI BUILDERS ============================== */

const ICON_EMPTY = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M21 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6"/><path d="M3 13l3.5-8h11L21 13"/><path d="M3 13h5.5a3.5 3.5 0 007 0H21"/></svg>';
const ICON_CHECK_CIRCLE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M8 12.5l3 3 5-6"/></svg>';
const ICON_DOWNLOAD = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4v12"/><path d="M6 11l6 6 6-6"/><path d="M4 20h16"/></svg>';

function chipHtml(label, cls) { return '<span class="chip ' + cls + '">' + escapeHtml(label) + "</span>"; }
function classificationChip(classification) { return chipHtml(classification, CHIP_CLASS_BY_CLASSIFICATION[classification] || "chip-neutral"); }
function statusChipHtml(status) { return chipHtml(status || "Not set", STATUS_CHIP_CLASS[status] || "chip-neutral"); }
function supportChipHtml(level) {
  const map = { "Strong Support": "chip-direct", "Weak Support": "chip-at-risk", "No Activity Support": "chip-unclear" };
  return chipHtml(level, map[level] || "chip-neutral");
}

function kpiCardHtml(opts) {
  return '<div class="kpi-card"><div class="kpi-label">' + escapeHtml(opts.label) + '</div><div class="kpi-value' + (opts.small ? " small" : "") + '">' + opts.value +
    '</div>' + (opts.sub ? '<div class="kpi-sub' + (opts.subClass ? " " + opts.subClass : "") + '">' + opts.sub + "</div>" : "") + "</div>";
}

function emptyStateHtml(opts) {
  return '<div class="empty-state"><div class="empty-state-icon">' + (opts.icon || ICON_EMPTY) + '</div><div class="empty-state-title">' +
    escapeHtml(opts.title) + '</div><div class="empty-state-text">' + escapeHtml(opts.text) + "</div>" + (opts.actionHtml || "") + "</div>";
}

function linkageChainHtml(nodes) {
  let html = '<div class="linkage-chain">';
  nodes.forEach((n, i) => {
    html += '<div class="chain-node' + (n.broken ? " broken" : "") + '" title="' + escapeHtml(n.label) + '">' + escapeHtml(n.label) + "</div>";
    if (i < nodes.length - 1) {
      const lineBroken = n.broken || nodes[i + 1].broken;
      html += '<div class="chain-link-line' + (lineBroken ? " broken" : "") + '"></div>';
    }
  });
  return html + "</div>";
}

function tableHtml(columns, rows) {
  const thead = "<tr>" + columns.map((c) => "<th>" + escapeHtml(c.label) + "</th>").join("") + "</tr>";
  const tbody = rows.map((r) => "<tr>" + columns.map((c) => '<td class="' + (c.cellClass || "") + '">' + (c.render ? c.render(r) : escapeHtml(r[c.key])) + "</td>").join("") + "</tr>").join("");
  return '<div class="table-wrap"><table class="data-table"><thead>' + thead + "</thead><tbody>" + (tbody || "") + "</tbody></table></div>";
}

function issueRowHtml(issue) {
  return '<div class="issue-row ' + issue.severity + '"><span class="issue-badge">' + issue.severity + '</span><div class="issue-text"><div>' +
    escapeHtml(issue.message) + "</div>" + (issue.meta ? '<div class="issue-meta">' + escapeHtml(issue.meta) + "</div>" : "") + "</div></div>";
}

function scoreBarHtml(total) {
  const pct = Math.max(0, Math.min(100, total));
  const color = total >= 80 ? "var(--direct)" : total >= 60 ? "var(--indirect)" : total >= 40 ? "var(--routine)" : "var(--misaligned)";
  return '<div class="score-bar-track"><div class="score-bar-fill" style="width:' + pct + "%;background:" + color + '"></div></div>';
}

function reportBlockHtml(title, scoreHtml, bodyHtml, recommendText, badge, extraHtml) {
  return '<div class="report-block"><div class="report-block-head"><div class="report-block-title">' + (badge ? badge + " " : "") + escapeHtml(title) + "</div>" + (scoreHtml || "") + "</div>" +
    bodyHtml + (recommendText ? '<div class="recommend-box"><strong>Recommended action: </strong>' + escapeHtml(recommendText) + "</div>" : "") + (extraHtml || "") + "</div>";
}

function tabsHtml(tabs, activeKey) {
  return '<div class="tabs">' + tabs.map((t) => '<button class="tab-btn' + (t.key === activeKey ? " active" : "") + '" data-tab="' + t.key + '">' + escapeHtml(t.label) + "</button>").join("") + "</div>";
}

/* ============================== STEP INDICATOR ============================== */

function renderStepIndicator() {
  const complete = [
    allDatasetsLoaded(),
    !!STATE.validation && canProceedToAnalysis(),
    STATE.analysisRun,
    STATE.reportViewed,
    STATE.exportedOnce
  ];
  let currentIdx = complete.findIndex((c) => !c);
  if (currentIdx === -1) currentIdx = STEPS.length - 1;
  let html = "";
  STEPS.forEach((label, i) => {
    const cls = complete[i] ? "done" : (i === currentIdx ? "current" : "");
    html += '<div class="step-pill ' + cls + '"><span class="step-dot"></span>' + label + "</div>";
    if (i < STEPS.length - 1) html += '<span class="step-arrow">\u2192</span>';
  });
  const el = document.getElementById("topbarSteps");
  if (el) el.innerHTML = html;
}

/* ============================== FILTER BAR ============================== */

function periodOptions() {
  const tasks = cleanRows("weeklyTasks");
  const seen = new Map();
  tasks.forEach((t) => {
    const month = s(t.Month), week = s(t.Week);
    if (!month && !week) return;
    const key = month + "|" + week;
    if (!seen.has(key)) seen.set(key, { value: key, label: (month ? month + " \u2013 " : "") + week, wn: parseInt((week.match(/\d+/) || ["0"])[0], 10), month });
  });
  const sorted = Array.from(seen.values()).sort((a, b) => a.wn - b.wn);
  // Interleave a month-summary option before the first week of each month
  const result = [];
  const seenMonths = new Set();
  sorted.forEach((opt) => {
    if (opt.month && !seenMonths.has(opt.month)) {
      result.push({ value: "month:" + opt.month, label: opt.month + " \u2014 all weeks" });
      seenMonths.add(opt.month);
    }
    result.push(opt);
  });
  return result;
}

function filterSelectHtml(filterKey, label, options) {
  const opts = ['<option value="all"' + (STATE.filters[filterKey] === "all" ? " selected" : "") + ">All</option>"]
    .concat(options.map((o) => '<option value="' + escapeHtml(o.value) + '"' + (STATE.filters[filterKey] === o.value ? " selected" : "") + ">" + escapeHtml(o.label) + "</option>"));
  return '<div class="filter-group"><label>' + escapeHtml(label) + '</label><select data-filter="' + filterKey + '" class="filter-select">' + opts.join("") + "</select></div>";
}

function filterBarHtml(showKeys) {
  let html = '<div class="filter-bar">';
  if (showKeys.includes("department")) html += filterSelectHtml("department", "Department", uniqueValues(cleanRows("weeklyTasks"), "Department").map((d) => ({ value: d, label: d })));
  if (showKeys.includes("employee")) {
    const deptFilter = STATE.filters.department;
    const roster = employeeRoster().filter((e) => deptFilter === "all" || e.Department === deptFilter);
    html += filterSelectHtml("employee", "Employee", roster.map((e) => ({ value: e.Employee_ID, label: e.Employee_Name })));
  }
  if (showKeys.includes("companyGoal")) {
    const opts = cleanRows("companyGoals").map((cg) => ({ value: cg.Company_Goal_ID, label: cg.Company_Goal_Title }));
    opts.push({ value: "__unlinked__", label: "Unlinked / broken chain" });
    html += filterSelectHtml("companyGoal", "Company Goal", opts);
  }
  if (showKeys.includes("period")) html += filterSelectHtml("period", "Period", periodOptions());
  if (showKeys.includes("riskStatus")) html += filterSelectHtml("riskStatus", "Risk Status", [{ value: "at-risk", label: "At-risk tasks" }, { value: "on-track", label: "On-track tasks" }]);
  html += '<button class="btn btn-ghost btn-sm filter-reset" id="filterResetBtn">Reset filters</button></div>';
  return html;
}

function applyTaskFilters(tasks, keys) {
  keys = keys || ["department", "employee", "companyGoal", "period", "riskStatus"];
  let filtered = tasks;
  const f = STATE.filters;
  if (keys.includes("department") && f.department !== "all") filtered = filtered.filter((t) => s(t.Department) === f.department);
  if (keys.includes("employee") && f.employee !== "all") filtered = filtered.filter((t) => s(t.Employee_ID) === f.employee);
  if (keys.includes("companyGoal") && f.companyGoal !== "all") {
    if (f.companyGoal === "__unlinked__") filtered = filtered.filter((t) => !t._score.companyGoal);
    else filtered = filtered.filter((t) => t._score.companyGoal && s(t._score.companyGoal.Company_Goal_ID) === f.companyGoal);
  }
  if (keys.includes("period") && f.period !== "all") {
    if (f.period.startsWith("month:")) {
      const month = f.period.slice(6);
      filtered = filtered.filter((t) => s(t.Month) === month);
    } else {
      const parts = f.period.split("|");
      filtered = filtered.filter((t) => s(t.Month) === parts[0] && s(t.Week) === parts[1]);
    }
  }
  if (keys.includes("riskStatus") && f.riskStatus !== "all") {
    const atRiskSet = new Set(["Misaligned", "Unclear due to insufficient information"]);
    filtered = f.riskStatus === "at-risk" ? filtered.filter((t) => atRiskSet.has(t._score.classification)) : filtered.filter((t) => !atRiskSet.has(t._score.classification));
  }
  return filtered;
}

function wireFilterBar(rerenderFn) {
  document.querySelectorAll(".filter-select").forEach((sel) => {
    sel.addEventListener("change", (e) => {
      const key = e.target.getAttribute("data-filter");
      STATE.filters[key] = e.target.value;
      // When department changes, clear the employee selection if that employee
      // isn't in the newly selected department (avoids a stale cross-dept employee filter)
      if (key === "department" && STATE.filters.employee !== "all") {
        const emp = employeeRoster().find((em) => em.Employee_ID === STATE.filters.employee);
        if (!emp || (STATE.filters.department !== "all" && emp.Department !== STATE.filters.department)) {
          STATE.filters.employee = "all";
        }
      }
      rerenderFn();
    });
  });
  const resetBtn = document.getElementById("filterResetBtn");
  if (resetBtn) resetBtn.addEventListener("click", () => { STATE.filters = { department: "all", employee: "all", companyGoal: "all", period: "all", riskStatus: "all" }; rerenderFn(); });
}
/* ============================== SECTION: EXECUTIVE SUMMARY & UPLOAD CENTRE ============================== */

const ICON_UPLOAD = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 16V4"/><path d="M6 9l6-6 6 6"/><path d="M4 20h16"/></svg>';
const ICON_INFO = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" style="width:15px;height:15px"><circle cx="12" cy="12" r="9"/><path d="M12 8v.01"/><path d="M11 11h1v5h1"/></svg>';
const ICON_LOCK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="11" width="14" height="10" rx="1.5"/><path d="M8 11V7a4 4 0 018 0v4"/></svg>';

function accessDeniedHtml(text) {
  return emptyStateHtml({ icon: ICON_LOCK, title: "You don't have access to this section", text: text || "This section is restricted to certain roles. Contact your administrator if you believe this is a mistake." });
}

const TEMPLATE_FILE = {
  companyGoals: "templates/sample_company_goals.csv",
  departmentalGoals: "templates/sample_departmental_goals.csv",
  individualGoals: "templates/sample_individual_goals.csv",
  weeklyTasks: "templates/sample_weekly_kpi_planner.csv"
};
const DATASET_DESC = {
  companyGoals: "Top-level strategic goals owned by company leadership.",
  departmentalGoals: "Departmental goals, each linked to a company goal.",
  individualGoals: "Each employee's individual goals, linked to a departmental goal.",
  weeklyTasks: "Weekly planned tasks per employee, linked to an individual goal."
};
const VALIDATION_CODE_LABEL = {
  "broken-link-company": "departmental goal(s) linked to a missing company goal",
  "blank-link-company": "departmental goal(s) with no company goal link",
  "broken-link-dept": "individual goal(s) linked to a missing departmental goal",
  "blank-link-dept": "individual goal(s) with no departmental goal link",
  "broken-link-indiv": "weekly task(s) linked to a missing individual goal",
  "blank-link-indiv": "weekly task(s) with no individual goal link",
  "blank-task": "weekly task(s) with a blank description",
  "missing-output": "weekly task(s) missing an expected output",
  "missing-status": "weekly task(s) missing a status",
  "missing-evidence": "weekly task(s) with no evidence attached",
  "invalid-progress": "weekly task(s) with an invalid progress percentage",
  "dept-mismatch": "weekly task(s) with a department/employee-record mismatch"
};

function uploadCardHtml(slotKey) {
  const meta = STATE.fileMeta[slotKey];
  const fields = REQUIRED_FIELDS[slotKey];
  return '<div class="upload-card">' +
    '<div class="upload-card-head"><div class="upload-card-title">' + DATASET_LABEL[slotKey] + "</div>" + (meta ? '<span class="chip chip-complete">Loaded</span>' : "") + "</div>" +
    '<div class="upload-card-desc">' + escapeHtml(DATASET_DESC[slotKey]) + "</div>" +
    '<div class="dropzone" id="dz-' + slotKey + '"><div class="dropzone-icon">' + ICON_UPLOAD + '</div><div class="dropzone-text"><strong>Click to browse</strong> or drag a file here<br>.csv or .xlsx</div>' +
    '<input type="file" id="file-' + slotKey + '" accept=".csv,.xlsx,.xls"></div>' +
    (meta ? '<div class="upload-status-row"><span class="upload-filename" title="' + escapeHtml(meta.name) + '">' + escapeHtml(meta.name) + '</span><span class="muted-link" id="remove-' + slotKey + '">Remove</span></div><div class="kpi-sub">' + meta.count + " rows loaded</div>" : "") +
    '<div class="field-required-list">Required columns: ' + fields.map((f) => "<code>" + f + "</code>").join(" ") + "</div>" +
    '<div style="margin-top:10px"><a class="muted-link" href="' + TEMPLATE_FILE[slotKey] + '" download>Download CSV template</a></div>' +
    "</div>";
}

function renderUploadCentre() {
  if (!can(STATE.currentUser, "pushSnapshot")) return accessDeniedHtml("Uploading and publishing data is limited to roles that can push a shared snapshot (Admin and HR Manager).");
  let html = '<div class="flex-between" style="margin-bottom:16px"><div class="small-caps-label">Step 1 of 5 \u00b7 Upload</div><button class="btn btn-secondary btn-sm" id="loadSampleDataBtn">Load Sample Data</button></div>';
  html += '<div class="upload-grid">' + DATASET_ORDER.map(uploadCardHtml).join("") + "</div>";
  if (allDatasetsLoaded()) {
    html += '<div class="accept-warnings-bar"><div class="accept-warnings-text"><strong>All four datasets are loaded.</strong> Continue to Data Validation to review data-quality checks before running the alignment analysis.</div><button class="btn btn-primary" id="goToValidationBtn">Review Validation \u2192</button></div>';
  }
  return html;
}

function renderMissingDataPanel() {
  if (!STATE.validation) return "";
  const excludedCount = STATE.validation.excludedRowKeys.size;
  const byCode = {};
  STATE.validation.warnings.forEach((w) => { byCode[w.code] = (byCode[w.code] || 0) + 1; });
  const items = Object.keys(byCode).map((code) => byCode[code] + " " + (VALIDATION_CODE_LABEL[code] || code)).sort();
  if (!items.length && !excludedCount) return "";
  let html = '<div class="missing-data-panel"><div class="missing-data-title">' + ICON_INFO + " Missing Data Required</div><div>For a fuller, more confident analysis, resolve the following:</div><ul class=\"missing-data-list\">";
  if (excludedCount) html += "<li>" + excludedCount + " row(s) excluded from analysis due to missing or duplicate IDs \u2014 see Data Validation for details.</li>";
  items.forEach((i) => { html += "<li>" + escapeHtml(i) + "</li>"; });
  html += "</ul></div>";
  return html;
}

function execFilterBarHtml() {
  const deptOpts = uniqueValues(cleanRows("weeklyTasks"), "Department").map((d) => ({ value: d, label: d }));
  const deptSelect = '<div class="filter-group"><label>Department</label><select id="execDeptFilter" class="filter-select">' +
    '<option value="all"' + (STATE.execFilters.department === "all" ? " selected" : "") + ">All departments</option>" +
    deptOpts.map((o) => '<option value="' + escapeHtml(o.value) + '"' + (STATE.execFilters.department === o.value ? " selected" : "") + ">" + escapeHtml(o.label) + "</option>").join("") +
    "</select></div>";
  const periodOpts = periodOptions();
  const periodSelect = '<div class="filter-group"><label>Period</label><select id="execPeriodFilter" class="filter-select">' +
    '<option value="all"' + (STATE.execFilters.period === "all" ? " selected" : "") + ">All periods</option>" +
    periodOpts.map((o) => '<option value="' + escapeHtml(o.value) + '"' + (STATE.execFilters.period === o.value ? " selected" : "") + ">" + escapeHtml(o.label) + "</option>").join("") +
    "</select></div>";
  return '<div class="filter-bar">' + deptSelect + periodSelect +
    '<button class="btn btn-ghost btn-sm" id="execFilterResetBtn">Reset filters</button></div>';
}

function renderExecutiveSummary() {
  if (!allDatasetsLoaded()) {
    return emptyStateHtml({ title: "No data loaded yet", text: "Upload your four HR datasets, or load sample data, to see organisation-wide alignment insights here.", actionHtml: '<button class="btn btn-primary" id="emptyGoUpload">Go to Upload Centre</button>' });
  }
  if (!STATE.analysisRun) {
    const ready = canProceedToAnalysis();
    return emptyStateHtml({
      icon: ICON_CHECK_CIRCLE,
      title: ready ? "Data loaded \u2014 ready to analyse" : "Validation issues need attention",
      text: ready ? "All datasets are loaded with no blocking errors. Run the goal-alignment analysis to populate this dashboard." : "Some datasets have missing required columns. Review Data Validation and re-upload corrected files.",
      actionHtml: ready ? '<button class="btn btn-primary" id="emptyRunAnalysis">Run Goal-Alignment Analysis</button>' : '<button class="btn btn-primary" id="emptyGoValidation">Review Validation Issues</button>'
    });
  }
  const kpi = computeExecutiveKPIs();

  // Broken-link alert: when many tasks can't link to a goal, surface a clear explanation
  const brokenLinkCount = STATE.validation ? STATE.validation.warnings.filter((w) => w.code === "broken-link-indiv").length : 0;
  let html = "";
  if (brokenLinkCount > 0) {
    const pct = kpi.totalTasks ? Math.round(brokenLinkCount / kpi.totalTasks * 100) : 0;
    html += '<div class="card" style="border-color:var(--at-risk);margin-bottom:18px">' +
      '<div class="card-title" style="color:var(--at-risk)">' + ICON_INFO + ' ' + brokenLinkCount + ' task' + (brokenLinkCount > 1 ? 's' : '') + ' (' + pct + '%) have a broken goal link \u2014 this reduces your Direct Alignment score</div>' +
      '<div class="card-note" style="margin-top:6px">These tasks reference an <strong>Individual Goal ID</strong> that doesn\u2019t exist in the Individual Goals file. Until the IDs match exactly (case-sensitive), these tasks score as \u201cUnclear\u201d rather than \u201cDirectly Aligned\u201d. Open <strong>Data Validation</strong> to see which tasks are affected, then correct the <code>Linked_Individual_Goal_ID</code> column in your Weekly KPI Planner.</div>' +
      '</div>';
  }

  // Coverage
  html += '<div class="small-caps-label" style="margin-bottom:10px">Coverage</div><div class="kpi-grid">';
  html += kpiCardHtml({ label: "Company Goals", value: kpi.totalCompanyGoals });
  html += kpiCardHtml({ label: "Departmental Goals", value: kpi.totalDeptGoals });
  html += kpiCardHtml({ label: "Individual Goals", value: kpi.totalIndividualGoals });
  html += kpiCardHtml({ label: "Weekly Tasks Analysed", value: kpi.totalTasks });
  html += "</div>";

  // Alignment breakdown
  html += '<div class="small-caps-label" style="margin-bottom:10px">Alignment Breakdown</div><div class="kpi-grid">';
  CLASSIFICATIONS.forEach((c) => { html += kpiCardHtml({ label: c, value: fmtPct(kpi.classificationPct[c]), small: true, sub: kpi.classificationCounts[c] + " tasks" }); });
  html += "</div>";

  // Goal support & risk
  html += '<div class="small-caps-label" style="margin-bottom:10px">Goal Support &amp; Risk</div><div class="kpi-grid">';
  html += kpiCardHtml({ label: "Strong Support Goals", value: kpi.strongSupportGoals });
  html += kpiCardHtml({ label: "Weak Support Goals", value: kpi.weakSupportGoals, subClass: kpi.weakSupportGoals > 0 ? "accent-risk" : "", sub: kpi.weakSupportGoals > 0 ? "Needs attention" : "" });
  html += kpiCardHtml({ label: "No Activity Support", value: kpi.noActivityGoals, subClass: kpi.noActivityGoals > 0 ? "accent-risk" : "", sub: kpi.noActivityGoals > 0 ? "No linked tasks logged" : "" });
  html += kpiCardHtml({ label: "Departments at Risk", value: kpi.departmentsAtRisk, subClass: kpi.departmentsAtRisk > 0 ? "accent-risk" : "" });
  html += kpiCardHtml({ label: "Employees Needing Clarification", value: kpi.employeesNeedingClarification, subClass: kpi.employeesNeedingClarification > 0 ? "accent-risk" : "" });
  html += "</div>";

  // KPI compliance section (period/dept filterable)
  const comp = computeKPICompliance(STATE.execFilters.period, STATE.execFilters.department);
  const submissionRate = comp.roster.length ? Math.round(comp.submitted.length / comp.roster.length * 100) : 0;
  const periodLabel = STATE.execFilters.period === "all" ? "all periods" : (STATE.execFilters.period.startsWith("month:") ? STATE.execFilters.period.slice(6) : STATE.execFilters.period.split("|").filter(Boolean).join(" \u2013 "));
  const deptLabel = STATE.execFilters.department === "all" ? "all departments" : STATE.execFilters.department;

  html += '<div class="small-caps-label" style="margin-bottom:10px">KPI Compliance</div>';
  html += '<div class="card-note" style="margin:-4px 0 10px">Showing ' + periodLabel + ' \u00b7 ' + deptLabel + '</div>';
  html += execFilterBarHtml();
  html += '<div class="kpi-grid">';
  html += kpiCardHtml({ label: "Staff Who Submitted", value: comp.submitted.length, sub: comp.roster.length + " expected \u00b7 " + submissionRate + "%" });
  html += kpiCardHtml({ label: "Staff Who Have Not Submitted", value: comp.notSubmitted.length, subClass: comp.notSubmitted.length > 0 ? "accent-risk" : "" });
  html += kpiCardHtml({ label: "Tasks Not Started", value: comp.notStarted.length, subClass: comp.notStarted.length > 0 ? "accent-risk" : "", sub: comp.notStarted.length > 0 ? "Progress 0% or Not Started" : "" });
  html += kpiCardHtml({ label: "Tasks Overdue / Blocked", value: comp.overdue.length, subClass: comp.overdue.length > 0 ? "accent-risk" : "", sub: comp.overdue.length > 0 ? "Delayed or Blocked status" : "" });
  html += "</div>";

  if (comp.notSubmitted.length) {
    html += '<div class="card-title" style="margin:14px 0 8px;font-size:13px">Staff who have not submitted' + (STATE.execFilters.period !== "all" ? " for this period" : "") + '</div>';
    html += tableHtml([
      { label: "Name", render: (e) => escapeHtml(e.Employee_Name) },
      { label: "Department", render: (e) => escapeHtml(e.Department) },
      { label: "Job Title", render: (e) => escapeHtml(e.Job_Title || "\u2014") }
    ], comp.notSubmitted);
  }

  html += '<div class="grid-2" style="margin-top:20px">' +
    '<div class="card"><div class="card-title">Alignment Classification Breakdown</div><div class="card-note">Share of all weekly tasks in each category.</div><canvas id="donutChart" height="260"></canvas></div>' +
    '<div class="card"><div class="card-title">Average Alignment Score by Department</div><div class="card-note">Mean task score (0\u2013100) per department.</div><canvas id="deptBarChart" height="260"></canvas></div>' +
    "</div>";

  html += renderMissingDataPanel();
  return html;
}

function wireExecutiveSummary() {
  const deptSel = document.getElementById("execDeptFilter");
  const periodSel = document.getElementById("execPeriodFilter");
  const resetBtn = document.getElementById("execFilterResetBtn");
  if (deptSel) deptSel.addEventListener("change", (e) => { STATE.execFilters.department = e.target.value; renderSection(); });
  if (periodSel) periodSel.addEventListener("change", (e) => { STATE.execFilters.period = e.target.value; renderSection(); });
  if (resetBtn) resetBtn.addEventListener("click", () => { STATE.execFilters = { period: "all", department: "all" }; renderSection(); });
}
/* ============================== SECTION: DATA VALIDATION ============================== */

function renderDataValidation() {
  if (!can(STATE.currentUser, "pushSnapshot")) return accessDeniedHtml("Data validation is part of the upload/publish workflow, limited to roles that can push a shared snapshot (Admin and HR Manager).");
  if (!allDatasetsLoaded()) {
    return emptyStateHtml({ title: "No data to validate yet", text: "Upload all four datasets, or load sample data, before running validation.", actionHtml: '<button class="btn btn-primary" id="emptyGoUpload">Go to Upload Centre</button>' });
  }
  if (!STATE.validation) runValidation();
  const v = STATE.validation;
  const canProceed = canProceedToAnalysis();

  let html = '<div class="kpi-grid" style="margin-bottom:20px">';
  html += kpiCardHtml({ label: "Errors", value: v.errors.length, subClass: v.errors.length ? "accent-risk" : "" });
  html += kpiCardHtml({ label: "Warnings", value: v.warnings.length, subClass: v.warnings.length ? "accent-risk" : "" });
  html += kpiCardHtml({ label: "AI-Suggested Links", value: v.suggestions.length });
  html += kpiCardHtml({ label: "Rows Excluded From Analysis", value: v.excludedRowKeys.size });
  html += kpiCardHtml({ label: "Status", value: canProceed ? "Ready" : "Blocked", subClass: canProceed ? "" : "accent-risk" });
  html += "</div>";
  html += '<div class="card-note" style="margin:-8px 0 20px;font-size:12.5px">Goal links are matched using AI-assisted semantic matching (a small on-device model that understands paraphrasing and synonyms, not just shared keywords), with a keyword-overlap fallback if it can\u2019t load. Auto-suggested links are listed below for your review \u2014 nothing is accepted silently.</div>';

  if (!canProceed) {
    html += '<div class="card" style="border-color:var(--misaligned);margin-bottom:20px"><div class="card-title" style="color:var(--misaligned)">Cannot proceed to analysis yet</div><div class="card-note">The following dataset(s) are missing required columns: ' +
      Array.from(v.columnErrorDatasets).map((d) => DATASET_LABEL[d]).join(", ") + ". Re-upload the corrected file(s) in the Upload Centre.</div></div>";
  }

  if (v.errors.length) { html += '<div class="small-caps-label" style="margin-bottom:10px">Errors</div>' + v.errors.map(issueRowHtml).join(""); }
  if (v.warnings.length) { html += '<div class="small-caps-label" style="margin:20px 0 10px">Warnings</div>' + v.warnings.map(issueRowHtml).join(""); }
  if (v.suggestions.length) { html += '<div class="small-caps-label" style="margin:20px 0 10px">AI-Suggested Links (Review Recommended)</div>' + v.suggestions.map(issueRowHtml).join(""); }
  if (!v.errors.length && !v.warnings.length && !v.suggestions.length) { html += emptyStateHtml({ icon: ICON_CHECK_CIRCLE, title: "No issues found", text: "All four datasets passed validation cleanly." }); }

  if (canProceed) {
    // Broken goal-link banner — shown prominently if many tasks can't link to a goal
    const brokenLinks = v.warnings.filter((w) => w.code === "broken-link-indiv");
    const blankLinks = v.warnings.filter((w) => w.code === "blank-link-indiv");
    const totalLinkIssues = brokenLinks.length + blankLinks.length;
    if (totalLinkIssues > 0) {
      const pct = STATE.classifiedTasks && STATE.classifiedTasks.length ? Math.round(totalLinkIssues / STATE.classifiedTasks.length * 100) : 0;
      html += '<div class="card" style="border-color:var(--at-risk);margin-bottom:18px">' +
        '<div class="card-title" style="color:var(--at-risk)">' + ICON_INFO + ' Goal-link issue detected \u2014 ' + totalLinkIssues + ' task' + (totalLinkIssues > 1 ? 's' : '') + ' (' + pct + '%) cannot be Directly Aligned</div>' +
        '<div class="card-note" style="margin-top:6px">' +
        (brokenLinks.length ? '<strong>' + brokenLinks.length + ' broken link' + (brokenLinks.length > 1 ? 's' : '') + ':</strong> the <code>Linked_Individual_Goal_ID</code> value in your Weekly KPI Planner doesn\u2019t match any <code>Individual_Goal_ID</code> in the Individual Goals file. Check for typos, extra spaces, or case differences. ' : '') +
        (blankLinks.length ? '<strong>' + blankLinks.length + ' blank link' + (blankLinks.length > 1 ? 's' : '') + ':</strong> these tasks have no <code>Linked_Individual_Goal_ID</code> at all. ' : '') +
        'Until fixed, these tasks will score as \u201cUnclear due to insufficient information\u201d instead of \u201cDirectly Aligned\u201d. See the individual warnings below for the specific tasks affected.</div>' +
        '</div>';
    }
    html += '<div class="accept-warnings-bar"><div class="accept-warnings-text">' +
      (v.warnings.length ? "Warnings above won\u2019t block analysis, but resolving them will improve scoring confidence." : "No blocking issues.") +
      '</div><button class="btn btn-primary" id="proceedToAnalysisBtn">' + (STATE.analysisRun ? "Re-run Analysis" : "Proceed to Analysis") + "</button></div>";
  }
  return html;
}

function wireDataValidation() {
  const btn = document.getElementById("proceedToAnalysisBtn");
  if (btn) btn.addEventListener("click", async () => {
    STATE.validationAcknowledged = true;
    runAnalysis();
    showToast("Analysis complete. " + STATE.classifiedTasks.length + " tasks classified.", "success");
    navigateTo("executive-summary");
    await pushSnapshotToServer();
  });
}

/* ============================== SECTION: GOAL MAPPING ============================== */

const ICON_CHEVRON = '<svg class="chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6l6 6-6 6"/></svg>';

function goalMetaText(support) {
  return support.taskCount + (support.taskCount === 1 ? " task" : " tasks") + " \u00b7 avg score " + Math.round(support.avgScore || 0);
}

function treeSummaryHtml(title, tag, support) {
  return "<summary>" +
    '<div style="display:flex;align-items:center;gap:10px;min-width:0;overflow:hidden"><span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + escapeHtml(title) + "</span>" +
    (tag ? '<span class="tree-summary-meta">' + escapeHtml(tag) + "</span>" : "") + "</div>" +
    '<div style="display:flex;align-items:center;gap:10px;flex-shrink:0"><span class="tree-summary-meta">' + goalMetaText(support) + "</span>" +
    supportChipHtml(support.supportLevel) + ICON_CHEVRON + "</div>" +
    "</summary>";
}

function taskMiniTableHtml(tasks) {
  return tableHtml([
    { key: "Task_ID", label: "Task" },
    { label: "Planned Task", render: (t) => escapeHtml(t.Planned_Task || "\u2014") },
    { label: "Classification", render: (t) => classificationChip(t._score.classification) },
    { label: "Score", render: (t) => '<div style="display:flex;align-items:center;gap:8px"><span>' + t._score.total + "</span>" + scoreBarHtml(t._score.total) + "</div>" }
  ], tasks);
}

function individualGoalNodeHtml(ig, chainPrefix) {
  const chain = chainPrefix.concat([{ label: ig.Individual_Goal_Title }]);
  let html = '<details class="tree-node level-indiv">' + treeSummaryHtml(ig.Individual_Goal_Title, ig.Employee_Name, ig.support) + '<div class="tree-children">';
  html += linkageChainHtml(chain);
  html += ig.tasks.length ? taskMiniTableHtml(ig.tasks) : '<div class="empty-state-text" style="padding:6px 0">No weekly tasks linked to this goal.</div>';
  html += "</div></details>";
  return html;
}

function departmentGoalNodeHtml(dg, chainPrefix) {
  let html = '<details class="tree-node level-dept">' + treeSummaryHtml(dg.Department_Goal_Title, dg.Department, dg.support) + '<div class="tree-children">';
  html += dg.individualGoals.length
    ? dg.individualGoals.map((ig) => individualGoalNodeHtml(ig, chainPrefix.concat([{ label: dg.Department_Goal_Title }]))).join("")
    : '<div class="empty-state-text" style="padding:6px 0">No individual goals linked to this departmental goal.</div>';
  html += "</div></details>";
  return html;
}

function companyGoalNodeHtml(cg) {
  let html = '<details class="tree-node" open>' + treeSummaryHtml(cg.Company_Goal_Title, cg.Strategic_Pillar, cg.support) + '<div class="tree-children">';
  html += cg.deptGoals.length
    ? cg.deptGoals.map((dg) => departmentGoalNodeHtml(dg, [{ label: cg.Company_Goal_Title }])).join("")
    : '<div class="empty-state-text" style="padding:6px 0">No departmental goals linked to this company goal.</div>';
  html += "</div></details>";
  return html;
}

function renderGoalMapping() {
  if (!STATE.analysisRun) {
    return emptyStateHtml({ title: "Run analysis first", text: "Goal Mapping shows the resolved company \u2192 department \u2192 individual \u2192 task chain once the alignment analysis has run.", actionHtml: '<button class="btn btn-primary" id="emptyGoValidation">Go to Data Validation</button>' });
  }
  const h = STATE.hierarchy;
  let html = '<div class="tree-root">' + h.companyGoals.map(companyGoalNodeHtml).join("") + "</div>";

  if (h.orphanDeptGoals.length) {
    html += '<div class="small-caps-label" style="margin:24px 0 10px">Unlinked Departmental Goals</div><div class="tree-root">' +
      h.orphanDeptGoals.map((dg) => departmentGoalNodeHtml(dg, [{ label: "Missing Company Goal", broken: true }])).join("") + "</div>";
  }
  if (h.orphanIndividualGoals.length) {
    html += '<div class="small-caps-label" style="margin:24px 0 10px">Unlinked Individual Goals</div><div class="tree-root">' +
      h.orphanIndividualGoals.map((ig) => individualGoalNodeHtml(ig, [{ label: "Missing Departmental Goal", broken: true }])).join("") + "</div>";
  }
  if (h.orphanTasks.length) {
    html += '<div class="small-caps-label" style="margin:24px 0 10px">Unlinked Weekly Tasks</div>' + taskMiniTableHtml(h.orphanTasks);
  }
  return html;
}
/* ============================== SECTION: ALIGNMENT ANALYSIS ============================== */

function alignmentTableHtml(tasks) {
  return tableHtml([
    { key: "Task_ID", label: "Task ID" },
    { label: "Employee", render: (t) => escapeHtml(t.Employee_Name) },
    { label: "Department", render: (t) => escapeHtml(t.Department) },
    { label: "Planned Task", render: (t) => escapeHtml(t.Planned_Task || "\u2014") },
    { label: "Classification", render: (t) => classificationChip(t._score.classification) },
    { label: "Score", render: (t) => '<div style="display:flex;align-items:center;gap:8px;min-width:110px"><span>' + t._score.total + "</span>" + scoreBarHtml(t._score.total) + "</div>" },
    { label: "Status", render: (t) => statusChipHtml(t.Status) },
    { label: "Linked Goal", render: (t) => escapeHtml(t._score.individualGoal ? t._score.individualGoal.Individual_Goal_Title : "\u2014") }
  ], tasks);
}

function renderAlignmentAnalysis() {
  if (!STATE.analysisRun) {
    return emptyStateHtml({ title: "Run analysis first", text: "The Alignment Analysis table appears once the goal-alignment analysis has run.", actionHtml: '<button class="btn btn-primary" id="emptyGoValidation">Go to Data Validation</button>' });
  }
  const filtered = applyTaskFilters(STATE.classifiedTasks);
  let html = filterBarHtml(["department", "employee", "companyGoal", "period", "riskStatus"]);
  html += '<div class="kpi-sub" style="margin:10px 2px">Showing ' + filtered.length + " of " + STATE.classifiedTasks.length + " tasks</div>";
  html += filtered.length ? alignmentTableHtml(filtered) : emptyStateHtml({ title: "No tasks match these filters", text: "Try resetting filters to see all tasks." });
  return html;
}

function wireAlignmentAnalysis() { wireFilterBar(() => renderSection()); }
/* ============================== SECTION: EMPLOYEE / DEPARTMENT / ORGANISATIONAL REPORTS ============================== */

function goalReportBlockHtml(record, showLevel, workflowHtml) {
  const scoreHtml = '<div style="display:flex;align-items:center;gap:10px;min-width:170px"><span class="kpi-value small">' + Math.round(record.support.avgScore || 0) + "</span>" + scoreBarHtml(record.support.avgScore) + supportChipHtml(record.support.supportLevel) + "</div>";
  const body = '<div class="card-note" style="margin:4px 0 10px">' + record.support.taskCount + (record.support.taskCount === 1 ? " linked task" : " linked tasks") +
    " \u00b7 owner: " + escapeHtml(record.owner || "\u2014") + (record.department ? " \u00b7 " + escapeHtml(record.department) : "") + "</div>";
  const recommend = generateGoalRecommendation(record.support, record.title, record.owner);
  const badge = showLevel && record.level ? chipHtml(record.level, "chip-neutral") : "";
  return reportBlockHtml(record.title, scoreHtml, body, recommend, badge, workflowHtml);
}

function renderEmployeeReports() {
  if (!STATE.analysisRun) return emptyStateHtml({ title: "Run analysis first", text: "Employee Reports appear once the goal-alignment analysis has run.", actionHtml: '<button class="btn btn-primary" id="emptyGoValidation">Go to Data Validation</button>' });
  let html = filterBarHtml(["department", "employee", "period"]);
  const roster = employeeRoster().filter((e) =>
    (STATE.filters.department === "all" || e.Department === STATE.filters.department) &&
    (STATE.filters.employee === "all" || e.Employee_ID === STATE.filters.employee));
  if (!roster.length) return html + emptyStateHtml({ title: "No employees match these filters", text: "Try resetting filters to see all employees." });

  // Pre-compute who has submitted for the selected period (for the compliance badge)
  const periodFilter = STATE.filters.period;
  let periodTasks = STATE.classifiedTasks || [];
  if (periodFilter !== "all") {
    if (periodFilter.startsWith("month:")) {
      const month = periodFilter.slice(6);
      periodTasks = periodTasks.filter((t) => s(t.Month) === month);
    } else {
      const parts = periodFilter.split("|");
      periodTasks = periodTasks.filter((t) => s(t.Month) === parts[0] && s(t.Week) === parts[1]);
    }
  }
  const submittedIds = new Set(periodTasks.map((t) => s(t.Employee_ID)).filter(Boolean));

  roster.forEach((emp) => {
    const empGoals = cleanRows("individualGoals").filter((ig) => s(ig.Employee_ID) === emp.Employee_ID);
    const empTasks = applyTaskFilters((STATE.classifiedTasks || []).filter((t) => s(t.Employee_ID) === emp.Employee_ID), ["period"]);
    const hasSubmitted = submittedIds.has(emp.Employee_ID);
    const complianceBadge = periodFilter !== "all"
      ? (hasSubmitted ? '<span class="chip chip-complete" style="margin-left:8px">Submitted</span>' : '<span class="chip chip-at-risk" style="margin-left:8px">Not submitted</span>')
      : "";
    html += '<div class="card" style="margin-bottom:18px"><div class="card-title">' + escapeHtml(emp.Employee_Name) + complianceBadge + '</div><div class="card-note" style="margin-bottom:10px">' +
      (emp.Job_Title ? escapeHtml(emp.Job_Title) + " \u00b7 " : "") + escapeHtml(emp.Department) + "</div>";
    if (empGoals.length) {
      empGoals.forEach((ig) => {
        html += goalReportBlockHtml({ title: ig.Individual_Goal_Title, owner: emp.Employee_Name, department: emp.Department, support: STATE.individualGoalSupport[ig.Individual_Goal_ID] });
      });
    } else {
      html += '<div class="empty-state-text" style="padding:6px 0 14px">No individual goals on record for this employee.</div>';
    }
    html += empTasks.length ? alignmentTableHtml(empTasks) : '<div class="empty-state-text" style="padding:6px 0">No weekly tasks for the selected period.</div>';
    html += "</div>";
  });
  return html;
}

function renderDepartmentReports() {
  if (!STATE.analysisRun) return emptyStateHtml({ title: "Run analysis first", text: "Department Reports appear once the goal-alignment analysis has run.", actionHtml: '<button class="btn btn-primary" id="emptyGoValidation">Go to Data Validation</button>' });
  let html = filterBarHtml(["department", "companyGoal", "period"]);
  let depts = Object.keys(STATE.departmentRollups || {});
  if (STATE.filters.department !== "all") depts = depts.filter((d) => d === STATE.filters.department);
  if (!depts.length) return html + emptyStateHtml({ title: "No departments match these filters", text: "Try resetting filters to see all departments." });

  // Pre-compute submission compliance per dept for the selected period
  const comp = computeKPICompliance(STATE.filters.period, "all");
  const submittedByDept = {};
  comp.submitted.forEach((e) => { submittedByDept[e.Department] = (submittedByDept[e.Department] || 0) + 1; });
  const rosterByDept = {};
  comp.roster.forEach((e) => { rosterByDept[e.Department] = (rosterByDept[e.Department] || 0) + 1; });

  depts.forEach((dept) => {
    const deptGoals = cleanRows("departmentalGoals").filter((dg) => s(dg.Department) === dept &&
      (STATE.filters.companyGoal === "all" || s(dg.Linked_Company_Goal_ID) === STATE.filters.companyGoal));
    const deptTasks = applyTaskFilters((STATE.classifiedTasks || []).filter((t) => s(t.Department) === dept), ["companyGoal", "period"]);
    const rollup = STATE.departmentRollups[dept];
    const totalStaff = rosterByDept[dept] || 0;
    const submittedStaff = submittedByDept[dept] || 0;
    const submissionPct = totalStaff ? Math.round(submittedStaff / totalStaff * 100) : 0;
    const submissionText = totalStaff
      ? submittedStaff + " of " + totalStaff + " staff submitted (" + submissionPct + "%)" + (STATE.filters.period !== "all" ? " this period" : "")
      : "";
    html += '<div class="card" style="margin-bottom:18px"><div class="flex-between" style="margin-bottom:4px"><div class="card-title">' + escapeHtml(dept) + "</div>" + supportChipHtml(rollup.supportLevel) + "</div>" +
      '<div class="card-note" style="margin-bottom:4px">' + rollup.taskCount + " weekly tasks \u00b7 average score " + Math.round(rollup.avgScore) + "</div>" +
      (submissionText ? '<div class="card-note" style="margin-bottom:10px">' +
        '<span class="' + (submissionPct < 80 ? "accent-risk" : "") + '">' + escapeHtml(submissionText) + "</span></div>" : "");
    if (deptGoals.length) {
      deptGoals.forEach((dg) => { html += goalReportBlockHtml({ title: dg.Department_Goal_Title, owner: dg.Goal_Owner, department: dept, support: STATE.departmentGoalSupport[dg.Department_Goal_ID] }); });
    } else {
      html += '<div class="empty-state-text" style="padding:6px 0 14px">No departmental goal record matches the current filters.</div>';
    }
    html += deptTasks.length ? alignmentTableHtml(deptTasks) : '<div class="empty-state-text" style="padding:6px 0">No weekly tasks for the selected filters.</div>';
    html += "</div>";
  });
  return html;
}

function renderOrganisationalReports() {
  if (!STATE.analysisRun) return emptyStateHtml({ title: "Run analysis first", text: "Organisational Reports appear once the goal-alignment analysis has run.", actionHtml: '<button class="btn btn-primary" id="emptyGoValidation">Go to Data Validation</button>' });
  let html = filterBarHtml(["companyGoal", "period"]);
  let companyGoals = cleanRows("companyGoals");
  if (STATE.filters.companyGoal !== "all" && STATE.filters.companyGoal !== "__unlinked__") companyGoals = companyGoals.filter((cg) => s(cg.Company_Goal_ID) === STATE.filters.companyGoal);
  else if (STATE.filters.companyGoal === "__unlinked__") companyGoals = [];
  if (!companyGoals.length) return html + emptyStateHtml({ title: "No company goals match these filters", text: "Try resetting filters to see all company goals." });

  companyGoals.forEach((cg) => {
    const childDgs = cleanRows("departmentalGoals").filter((dg) => s(dg.Linked_Company_Goal_ID) === s(cg.Company_Goal_ID));
    html += '<div class="card" style="margin-bottom:18px"><div class="card-note" style="margin-bottom:2px">' + escapeHtml(cg.Strategic_Pillar) + " \u00b7 " + escapeHtml(cg.Priority) + " priority \u00b7 " + escapeHtml(cg.Timeline) + "</div>";
    html += goalReportBlockHtml({ title: cg.Company_Goal_Title, owner: cg.Goal_Owner, department: null, support: STATE.companyGoalSupport[cg.Company_Goal_ID] });
    if (childDgs.length) {
      html += tableHtml([
        { label: "Departmental Goal", render: (dg) => escapeHtml(dg.Department_Goal_Title) },
        { label: "Department", render: (dg) => escapeHtml(dg.Department) },
        { label: "Support", render: (dg) => supportChipHtml(STATE.departmentGoalSupport[dg.Department_Goal_ID].supportLevel) },
        { label: "Avg Score", render: (dg) => Math.round(STATE.departmentGoalSupport[dg.Department_Goal_ID].avgScore) }
      ], childDgs);
    } else {
      html += '<div class="empty-state-text" style="padding:6px 0 14px">No departmental goals link to this company goal.</div>';
    }
    html += "</div>";
  });
  return html;
}

function wireEmployeeReports() { wireFilterBar(() => renderSection()); }
function wireDepartmentReports() { wireFilterBar(() => renderSection()); }
function wireOrganisationalReports() { wireFilterBar(() => renderSection()); }
/* ============================== SECTION: RISK & GAP REPORTS ============================== */

/* ---------------------------------- workflow tracking ----------------------------------
   Status/assignment/comments for flagged tasks and at-risk goals. The list of
   items (status + assignee + comment count) is fetched once per section visit
   and cached in STATE.workflowItems; individual comment threads are fetched
   lazily, only once a panel is actually expanded. */

const STATUS_LABEL = { open: "Open", in_progress: "In Progress", resolved: "Resolved" };
let workflowListLoadInFlight = false;

function ensureWorkflowItemsLoaded() {
  if (STATE.workflowItems !== null || workflowListLoadInFlight) return;
  workflowListLoadInFlight = true;
  api("/api/workflow").then((data) => {
    const map = {};
    (data.items || []).forEach((it) => { map[it.item_type + ":" + it.item_key] = it; });
    STATE.workflowItems = map;
    workflowListLoadInFlight = false;
    if (STATE.currentSection === "risk-gap-reports") renderSection();
  }).catch((err) => {
    workflowListLoadInFlight = false;
    console.warn("Could not load workflow tracking data:", err);
  });
}

function workflowPanelHtml(itemType, itemKey, record) {
  const status = (record && record.status) || "open";
  const assignedTo = (record && record.assigned_to) || "";
  const commentCount = record ? Number(record.comment_count || 0) : 0;
  const canEdit = can(STATE.currentUser, "editWorkflow");

  const editRow = canEdit ? (
    '<div class="workflow-edit-row">' +
      '<select class="workflow-status-select">' +
        Object.keys(STATUS_LABEL).map((st) => '<option value="' + st + '"' + (st === status ? " selected" : "") + '>' + STATUS_LABEL[st] + "</option>").join("") +
      "</select>" +
      '<input type="text" class="workflow-assignee-input" placeholder="Assign to\u2026" value="' + escapeHtml(assignedTo) + '">' +
      '<button class="btn btn-secondary btn-sm workflow-save-btn">Save</button>' +
    "</div>"
  ) : "";

  const commentForm = canEdit ? (
    '<div class="workflow-comment-row">' +
      '<textarea class="workflow-comment-input" placeholder="Add a comment\u2026" rows="2"></textarea>' +
      '<button class="btn btn-secondary btn-sm workflow-comment-btn">Comment</button>' +
    "</div>"
  ) : "";

  return '<details class="workflow-panel" data-item-type="' + itemType + '" data-item-key="' + escapeHtml(itemKey) + '">' +
    "<summary>" +
      '<span class="status-badge status-' + status + '">' + STATUS_LABEL[status] + "</span>" +
      (assignedTo ? '<span class="workflow-assignee">' + escapeHtml(assignedTo) + "</span>" : "") +
      '<span class="workflow-comment-count">' + commentCount + (commentCount === 1 ? " comment" : " comments") + "</span>" +
      ICON_CHEVRON +
    "</summary>" +
    '<div class="workflow-panel-body">' +
      editRow +
      '<div class="workflow-comments-list" data-loaded="0"><div class="workflow-comment-empty">Loading comments\u2026</div></div>' +
      commentForm +
    "</div>" +
  "</details>";
}

function workflowCommentItemHtml(c) {
  const when = new Date(c.created_at).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
  return '<div class="workflow-comment-item"><div class="workflow-comment-author">' + escapeHtml(c.author_name) +
    '<span class="workflow-comment-date">' + when + "</span></div><div class=\"workflow-comment-body\">" + escapeHtml(c.body) + "</div></div>";
}

async function loadWorkflowComments(panel) {
  const list = panel.querySelector(".workflow-comments-list");
  const itemType = panel.getAttribute("data-item-type");
  const itemKey = panel.getAttribute("data-item-key");
  try {
    const data = await api("/api/workflow/comments?itemType=" + encodeURIComponent(itemType) + "&itemKey=" + encodeURIComponent(itemKey));
    list.dataset.loaded = "1";
    list.innerHTML = (data.comments && data.comments.length)
      ? data.comments.map(workflowCommentItemHtml).join("")
      : '<div class="workflow-comment-empty">No comments yet.</div>';
  } catch (err) {
    list.innerHTML = '<div class="workflow-comment-empty">Could not load comments.</div>';
  }
}

async function saveWorkflowStatus(panel) {
  const itemType = panel.getAttribute("data-item-type");
  const itemKey = panel.getAttribute("data-item-key");
  const status = panel.querySelector(".workflow-status-select").value;
  const assignedTo = panel.querySelector(".workflow-assignee-input").value.trim();
  const btn = panel.querySelector(".workflow-save-btn");
  btn.disabled = true; btn.textContent = "Saving\u2026";
  try {
    await api("/api/workflow/status", { method: "POST", body: { itemType, itemKey, status, assignedTo } });
    const key = itemType + ":" + itemKey;
    const existing = (STATE.workflowItems && STATE.workflowItems[key]) || { comment_count: 0 };
    if (!STATE.workflowItems) STATE.workflowItems = {};
    STATE.workflowItems[key] = Object.assign({}, existing, { status, assigned_to: assignedTo });

    const badge = panel.querySelector(".status-badge");
    badge.className = "status-badge status-" + status;
    badge.textContent = STATUS_LABEL[status];
    let assigneeEl = panel.querySelector(".workflow-assignee");
    if (assignedTo) {
      if (!assigneeEl) {
        assigneeEl = document.createElement("span");
        assigneeEl.className = "workflow-assignee";
        badge.insertAdjacentElement("afterend", assigneeEl);
      }
      assigneeEl.textContent = assignedTo;
    } else if (assigneeEl) {
      assigneeEl.remove();
    }
    showToast("Workflow status saved.", "success");
  } catch (err) {
    showToast(err.message || "Could not save status.", "error");
  } finally {
    btn.disabled = false; btn.textContent = "Save";
  }
}

async function submitWorkflowComment(panel) {
  const itemType = panel.getAttribute("data-item-type");
  const itemKey = panel.getAttribute("data-item-key");
  const textarea = panel.querySelector(".workflow-comment-input");
  const body = textarea.value.trim();
  if (!body) return;
  const btn = panel.querySelector(".workflow-comment-btn");
  btn.disabled = true;
  try {
    const data = await api("/api/workflow/comment", { method: "POST", body: { itemType, itemKey, body } });
    const list = panel.querySelector(".workflow-comments-list");
    if (list.dataset.loaded === "1") {
      const empty = list.querySelector(".workflow-comment-empty");
      if (empty) empty.remove();
      list.insertAdjacentHTML("beforeend", workflowCommentItemHtml(data.comment));
    }
    textarea.value = "";
    const key = itemType + ":" + itemKey;
    if (!STATE.workflowItems) STATE.workflowItems = {};
    const existing = STATE.workflowItems[key] || { status: "open", assigned_to: null, comment_count: 0 };
    existing.comment_count = Number(existing.comment_count || 0) + 1;
    STATE.workflowItems[key] = existing;
    panel.querySelector(".workflow-comment-count").textContent = existing.comment_count + (existing.comment_count === 1 ? " comment" : " comments");
    showToast("Comment added.", "success");
  } catch (err) {
    showToast(err.message || "Could not add comment.", "error");
  } finally {
    btn.disabled = false;
  }
}

function wireWorkflowPanels() {
  document.querySelectorAll(".workflow-panel").forEach((panel) => {
    panel.addEventListener("toggle", () => {
      if (panel.open && panel.querySelector(".workflow-comments-list").dataset.loaded !== "1") loadWorkflowComments(panel);
    });
    const saveBtn = panel.querySelector(".workflow-save-btn");
    if (saveBtn) saveBtn.addEventListener("click", () => saveWorkflowStatus(panel));
    const commentBtn = panel.querySelector(".workflow-comment-btn");
    if (commentBtn) commentBtn.addEventListener("click", () => submitWorkflowComment(panel));
  });
}

function flaggedTaskBlockHtml(t) {
  const scoreHtml = '<div style="display:flex;align-items:center;gap:10px;min-width:170px"><span class="kpi-value small">' + t._score.total + "</span>" + scoreBarHtml(t._score.total) + classificationChip(t._score.classification) + "</div>";
  const body = '<div class="card-note" style="margin:4px 0 10px">' + escapeHtml(t.Employee_Name) + " \u00b7 " + escapeHtml(t.Department) + " \u00b7 Task " + escapeHtml(t.Task_ID) + "</div>" +
    "<div style=\"margin-bottom:8px\">" + escapeHtml(t.Planned_Task || "\u2014") + "</div>" +
    '<div class="card-note">Why: ' + escapeHtml(REASON_TAG_TEXT[t._score.reasonTag] || "") + "</div>";
  const recommend = generateTaskFollowUp(t);
  const key = "task:" + t.Task_ID;
  const wf = workflowPanelHtml("task", t.Task_ID, STATE.workflowItems && STATE.workflowItems[key]);
  return reportBlockHtml(t.Task_ID, scoreHtml, body, recommend, null, wf);
}

/* ============================== SECTION: RISK & GAP REPORTS ============================== */

function renderRiskGapReports() {
  if (!STATE.analysisRun) return emptyStateHtml({ title: "Run analysis first", text: "Risk & Gap Reports appear once the goal-alignment analysis has run.", actionHtml: '<button class="btn btn-primary" id="emptyGoValidation">Go to Data Validation</button>' });
  ensureWorkflowItemsLoaded();
  const tabs = [{ key: "tasks", label: "Misaligned & Unclear Tasks" }, { key: "goals", label: "At-Risk Goals" }];
  const active = STATE.activeRiskTab || "tasks";
  let html = tabsHtml(tabs, active);

  if (active === "tasks") {
    const flagged = (STATE.classifiedTasks || []).filter((t) => t._score.classification === "Misaligned" || t._score.classification === "Unclear due to insufficient information");
    html += '<div class="kpi-sub" style="margin:14px 2px 10px">' + flagged.length + " flagged task(s) \u00b7 track follow-up below</div>";
    html += flagged.length ? flagged.map(flaggedTaskBlockHtml).join("")
      : emptyStateHtml({ icon: ICON_CHECK_CIRCLE, title: "No flagged tasks", text: "No tasks are currently classified as Misaligned or Unclear due to insufficient information." });
  } else {
    const atRiskGoals = computeAtRiskGoalsList();
    html += '<div class="kpi-sub" style="margin:14px 2px 10px">' + atRiskGoals.length + " at-risk goal(s) \u00b7 track follow-up below</div>";
    html += atRiskGoals.length
      ? atRiskGoals.map((r) => {
          const itemKey = r.level + ":" + r.id;
          const wf = workflowPanelHtml("goal", itemKey, STATE.workflowItems && STATE.workflowItems["goal:" + itemKey]);
          return goalReportBlockHtml(r, true, wf);
        }).join("")
      : emptyStateHtml({ icon: ICON_CHECK_CIRCLE, title: "No at-risk goals", text: "All goals currently show strong support from linked weekly activity." });
  }
  return html;
}

function wireRiskGapReports() {
  document.querySelectorAll(".tab-btn").forEach((btn) => {
    btn.addEventListener("click", () => { STATE.activeRiskTab = btn.getAttribute("data-tab"); renderSection(); });
  });
  wireWorkflowPanels();
}
/* ============================== SECTION: EXPORT CENTRE ============================== */

const ICON_PDF = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M7 3h7l4 4v13a1 1 0 01-1 1H7a1 1 0 01-1-1V4a1 1 0 011-1z"/><path d="M14 3v4h4"/><path d="M9 13h6M9 16h6M9 10h2"/></svg>';
const ICON_PPTX = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="13" rx="1.5"/><path d="M8 21h8"/><path d="M12 17v4"/><path d="M7.5 13l3-3.5L13 12l3.5-4"/></svg>';
const ICON_XLSX = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="3.5" y="3.5" width="17" height="17" rx="1.5"/><path d="M3.5 9.5h17M3.5 14.5h17M9.5 3.5v17M14.5 3.5v17"/></svg>';

function exportCardHtml(opts) {
  return '<div class="export-card"><div class="export-card-icon">' + opts.icon + '</div><div class="export-card-title">' + escapeHtml(opts.title) + '</div><div class="export-card-desc">' +
    escapeHtml(opts.desc) + '</div><button class="btn btn-primary btn-sm" id="' + opts.btnId + '">' + escapeHtml(opts.btnLabel) + "</button></div>";
}

function renderExportCentre() {
  if (!STATE.analysisRun) return emptyStateHtml({ title: "Run analysis first", text: "Export options become available once the goal-alignment analysis has run.", actionHtml: '<button class="btn btn-primary" id="emptyGoValidation">Go to Data Validation</button>' });
  let html = '<div class="export-grid">';
  html += exportCardHtml({ icon: ICON_PDF, title: "Executive Summary (PDF)", desc: "A concise PDF brief with KPI totals, classification breakdown, department performance, and at-risk goals.", btnId: "exportPdfBtn", btnLabel: "Download PDF" });
  html += exportCardHtml({ icon: ICON_PPTX, title: "Executive Summary (PowerPoint)", desc: "A branded 6-slide deck for leadership readouts: KPI snapshot, alignment breakdown, department performance, and recommended next steps.", btnId: "exportPptxBtn", btnLabel: "Download PPTX" });
  html += exportCardHtml({ icon: ICON_XLSX, title: "Full Data Export (Excel)", desc: "A multi-sheet workbook with the complete task-level audit trail and every report view, for further analysis.", btnId: "exportExcelBtn", btnLabel: "Download Excel" });
  html += "</div>";
  html += renderMissingDataPanel();
  return html;
}

function wireExportCentre() {
  const pdfBtn = document.getElementById("exportPdfBtn"); if (pdfBtn) pdfBtn.addEventListener("click", () => exportPDF());
  const pptxBtn = document.getElementById("exportPptxBtn"); if (pptxBtn) pptxBtn.addEventListener("click", () => exportPPTX());
  const xlsBtn = document.getElementById("exportExcelBtn"); if (xlsBtn) xlsBtn.addEventListener("click", () => exportExcel());
}
/* ============================== EXECUTIVE CHARTS (Chart.js) ============================== */

const CLASS_COLORS = {
  "Directly aligned": "#1F8A5C",
  "Indirectly aligned": "#2F6FB0",
  "Routine/Business-as-usual": "#9C7A29",
  "Misaligned": "#B0473F",
  "Unclear due to insufficient information": "#6B5B95"
};

function renderExecutiveCharts() {
  if (!STATE.analysisRun) return;
  const donutCanvas = document.getElementById("donutChart");
  const barCanvas = document.getElementById("deptBarChart");
  if (!donutCanvas || !barCanvas || typeof Chart === "undefined") return;

  if (STATE.charts.donut) { try { STATE.charts.donut.destroy(); } catch (e) {} STATE.charts.donut = null; }
  if (STATE.charts.deptBar) { try { STATE.charts.deptBar.destroy(); } catch (e) {} STATE.charts.deptBar = null; }

  const kpi = computeExecutiveKPIs();
  const labels = CLASSIFICATIONS;
  const data = labels.map((l) => kpi.classificationCounts[l]);
  const colors = labels.map((l) => CLASS_COLORS[l]);

  STATE.charts.donut = new Chart(donutCanvas, {
    type: "doughnut",
    data: { labels, datasets: [{ data, backgroundColor: colors, borderWidth: 0 }] },
    options: { plugins: { legend: { position: "bottom", labels: { boxWidth: 11, font: { size: 10.5 } } } }, cutout: "62%", maintainAspectRatio: true }
  });

  const depts = Object.keys(STATE.departmentRollups || {}).sort();
  const barData = depts.map((d) => Math.round(STATE.departmentRollups[d].avgScore));
  const barColors = depts.map((d) => (STATE.departmentRollups[d].atRisk ? "#C9792E" : "#2F6FB0"));

  STATE.charts.deptBar = new Chart(barCanvas, {
    type: "bar",
    data: { labels: depts, datasets: [{ data: barData, backgroundColor: barColors, borderRadius: 4, maxBarThickness: 46 }] },
    options: { plugins: { legend: { display: false } }, scales: { y: { min: 0, max: 100, ticks: { stepSize: 20 } } }, maintainAspectRatio: true }
  });
}

/* ============================== SECTION: TREND OVER TIME ============================== */

let trendHistoryLoadInFlight = false;

function ensureSnapshotHistoryLoaded() {
  if (STATE.snapshotHistory !== null || trendHistoryLoadInFlight) return;
  trendHistoryLoadInFlight = true;
  api("/api/snapshots/history").then((data) => {
    STATE.snapshotHistory = data.snapshots || [];
    trendHistoryLoadInFlight = false;
    if (STATE.currentSection === "trend-over-time") renderSection();
  }).catch((err) => {
    trendHistoryLoadInFlight = false;
    console.warn("Could not load snapshot history:", err);
  });
}

function renderTrendOverTime() {
  ensureSnapshotHistoryLoaded();
  const history = STATE.snapshotHistory;
  if (history === null) return emptyStateHtml({ title: "Loading trend data\u2026", text: "Fetching published snapshots from the server." });
  if (!history.length) {
    return emptyStateHtml({ title: "No history yet", text: "Each time someone with publishing permission runs analysis on real (non-sample) data, a snapshot is saved here. Trend lines will build up as that happens over time." });
  }
  const latest = history[history.length - 1];
  let html = '<div class="trend-meta-row">' +
    '<div class="trend-meta-item">Snapshots published: <strong>' + history.length + "</strong></div>" +
    '<div class="trend-meta-item">Latest average score: <strong>' + Math.round(latest.overall_avg_score || 0) + "</strong></div>" +
    '<div class="trend-meta-item">First recorded: <strong>' + new Date(history[0].created_at).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" }) + "</strong></div>" +
  "</div>";
  html += '<div class="card"><div class="card-title">Overall Alignment Score Over Time</div><div class="card-note">Average task alignment score (0\u2013100) at each published snapshot.</div><canvas id="trendChart" height="280"></canvas></div>';
  html += tableHtml([
    { label: "Published", render: (h) => new Date(h.created_at).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" }) },
    { label: "Label", render: (h) => escapeHtml(h.label || "\u2014") },
    { label: "Avg Score", render: (h) => String(Math.round(h.overall_avg_score || 0)) },
    { label: "Published By", render: (h) => escapeHtml(h.created_by_name || "\u2014") }
  ], history.slice().reverse());
  return html;
}

function renderTrendChart() {
  const history = STATE.snapshotHistory;
  const canvas = document.getElementById("trendChart");
  if (!history || !history.length || !canvas || typeof Chart === "undefined") return;
  if (STATE.charts.trend) { try { STATE.charts.trend.destroy(); } catch (e) {} STATE.charts.trend = null; }
  const labels = history.map((h) => new Date(h.created_at).toLocaleDateString(undefined, { month: "short", day: "numeric" }));
  const data = history.map((h) => Math.round(h.overall_avg_score || 0));
  STATE.charts.trend = new Chart(canvas, {
    type: "line",
    data: { labels, datasets: [{ data, borderColor: "#2F6FB0", backgroundColor: "rgba(47,111,176,0.12)", fill: true, tension: 0.25, pointRadius: 4, pointBackgroundColor: "#2F6FB0" }] },
    options: { plugins: { legend: { display: false } }, scales: { y: { min: 0, max: 100, ticks: { stepSize: 20 } } }, maintainAspectRatio: true }
  });
}

/* ============================== SECTION: MANAGE USERS ============================== */

function userRoleOptionsHtml(selected) {
  return Object.keys(ROLE_LABEL).map((r) => '<option value="' + r + '"' + (r === selected ? " selected" : "") + '>' + ROLE_LABEL[r] + "</option>").join("");
}

function renderManageUsers() {
  if (!can(STATE.currentUser, "manageUsers")) return accessDeniedHtml("Managing users is limited to Admins.");
  let html = '<div class="card" style="margin-bottom:20px"><div class="card-title">Add a user</div><div class="card-note" style="margin-bottom:12px">They\u2019ll be able to sign in immediately with the password you set below \u2014 share it with them through a separate, secure channel.</div>';
  html += '<form id="addUserForm" class="add-user-form">' +
    '<div class="form-field"><label for="newUserName">Name</label><input id="newUserName" type="text" required></div>' +
    '<div class="form-field"><label for="newUserEmail">Email</label><input id="newUserEmail" type="email" required></div>' +
    '<div class="form-field"><label for="newUserPassword">Temporary password</label><input id="newUserPassword" type="text" minlength="8" required></div>' +
    '<div class="form-field"><label for="newUserRole">Role</label><select id="newUserRole">' + userRoleOptionsHtml("executive") + "</select></div>" +
    '<div class="form-field"><button class="btn btn-primary" type="submit" id="addUserBtn">Add User</button></div>' +
  "</form></div>";
  html += '<div id="usersTableHost"><div class="empty-state-text">Loading users\u2026</div></div>';
  return html;
}

function usersTableHtml(users) {
  return tableHtml([
    { label: "Name", render: (u) => escapeHtml(u.name) },
    { label: "Email", render: (u) => escapeHtml(u.email) },
    { label: "Role", render: (u) => ROLE_LABEL[u.role] || escapeHtml(u.role) },
    { label: "Department", render: (u) => escapeHtml(u.department || "\u2014") },
    { label: "Added", render: (u) => new Date(u.created_at).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" }) },
    { label: "", render: (u) => (u.id === STATE.currentUser.id ? "" : '<button class="btn btn-ghost btn-sm delete-user-btn" data-user-id="' + u.id + '">Remove</button>') }
  ], users);
}

async function loadAndRenderUsersTable() {
  const host = document.getElementById("usersTableHost");
  if (!host) return;
  try {
    const data = await api("/api/users");
    host.innerHTML = usersTableHtml(data.users || []);
    host.querySelectorAll(".delete-user-btn").forEach((btn) => {
      btn.addEventListener("click", async () => {
        if (!confirm("Remove this user? They will be signed out immediately and will no longer be able to log in.")) return;
        try {
          await api("/api/users/" + btn.getAttribute("data-user-id"), { method: "DELETE" });
          showToast("User removed.", "success");
          loadAndRenderUsersTable();
        } catch (err) {
          showToast(err.message || "Could not remove user.", "error");
        }
      });
    });
  } catch (err) {
    host.innerHTML = '<div class="empty-state-text">Could not load users: ' + escapeHtml(err.message || "") + "</div>";
  }
}

function wireManageUsers() {
  if (!can(STATE.currentUser, "manageUsers")) return;
  loadAndRenderUsersTable();
  const form = document.getElementById("addUserForm");
  if (!form) return;
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const btn = document.getElementById("addUserBtn");
    btn.disabled = true; btn.textContent = "Adding\u2026";
    try {
      await api("/api/users", {
        method: "POST",
        body: {
          name: document.getElementById("newUserName").value.trim(),
          email: document.getElementById("newUserEmail").value.trim(),
          password: document.getElementById("newUserPassword").value,
          role: document.getElementById("newUserRole").value
        }
      });
      showToast("User added.", "success");
      form.reset();
      loadAndRenderUsersTable();
    } catch (err) {
      showToast(err.message || "Could not add user.", "error");
    } finally {
      btn.disabled = false; btn.textContent = "Add User";
    }
  });
}
/* ============================== EXPORT: PDF (jsPDF + autoTable) ============================== */

function exportPDF() {
  if (!STATE.analysisRun) { showToast("Run the analysis before exporting.", "error"); return; }
  try {
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF({ unit: "pt", format: "a4" });
    const pageWidth = doc.internal.pageSize.getWidth();
    const pageHeight = doc.internal.pageSize.getHeight();
    const margin = 40;
    const dateStr = todayString();
    const footerLine = "Performance Alignment Intelligence \u00b7 for L\u2019AINE HR \u00b7 Generated " + dateStr;

    doc.setFillColor(15, 42, 74);
    doc.rect(0, 0, pageWidth, 64, "F");
    doc.setTextColor(255, 255, 255);
    doc.setFont("helvetica", "bold"); doc.setFontSize(16);
    doc.text("Performance Alignment Intelligence", margin, 32);
    doc.setFont("helvetica", "normal"); doc.setFontSize(10);
    doc.text("Executive Summary \u00b7 for L\u2019AINE HR \u00b7 Generated " + dateStr, margin, 48);

    let y = 92;
    const sectionHeading = (text) => { doc.setFont("helvetica", "bold"); doc.setFontSize(12); doc.setTextColor(15, 42, 74); doc.text(text, margin, y); y += 8; };
    const ensureSpace = (needed) => { if (y + needed > pageHeight - 60) { doc.addPage(); y = 50; } };
    const tableDefaults = { margin: { left: margin, right: margin }, theme: "grid", headStyles: { fillColor: [27, 63, 110], textColor: 255, fontSize: 9 }, bodyStyles: { fontSize: 9 }, styles: { cellPadding: 5 } };

    const kpi = computeExecutiveKPIs();
    sectionHeading("Key Metrics");
    doc.autoTable(Object.assign({}, tableDefaults, {
      startY: y,
      head: [["Metric", "Value"]],
      body: [
        ["Company Goals", String(kpi.totalCompanyGoals)],
        ["Departmental Goals", String(kpi.totalDeptGoals)],
        ["Individual Goals", String(kpi.totalIndividualGoals)],
        ["Weekly Tasks Analysed", String(kpi.totalTasks)],
        ["Strong Support Goals", String(kpi.strongSupportGoals)],
        ["Weak Support Goals", String(kpi.weakSupportGoals)],
        ["No Activity Support Goals", String(kpi.noActivityGoals)],
        ["Departments at Risk", String(kpi.departmentsAtRisk)],
        ["Employees Needing Clarification", String(kpi.employeesNeedingClarification)]
      ]
    }));
    y = doc.lastAutoTable.finalY + 26;

    ensureSpace(100);
    sectionHeading("Alignment Classification Breakdown");
    doc.autoTable(Object.assign({}, tableDefaults, {
      startY: y,
      head: [["Classification", "Count", "% of Tasks"]],
      body: CLASSIFICATIONS.map((c) => [c, String(kpi.classificationCounts[c]), fmtPct(kpi.classificationPct[c])])
    }));
    y = doc.lastAutoTable.finalY + 26;

    ensureSpace(100);
    sectionHeading("Department Performance");
    const depts = Object.keys(STATE.departmentRollups).sort();
    doc.autoTable(Object.assign({}, tableDefaults, {
      startY: y,
      head: [["Department", "Tasks", "Avg Score", "Support Level", "At Risk"]],
      body: depts.map((d) => { const r = STATE.departmentRollups[d]; return [d, String(r.taskCount), String(Math.round(r.avgScore)), r.supportLevel, r.atRisk ? "Yes" : "No"]; })
    }));
    y = doc.lastAutoTable.finalY + 26;

    ensureSpace(100);
    sectionHeading("At-Risk Goals");
    const atRisk = computeAtRiskGoalsList();
    doc.autoTable(Object.assign({}, tableDefaults, {
      startY: y,
      head: [["Level", "Goal", "Owner", "Support Level", "Avg Score"]],
      body: atRisk.length ? atRisk.map((r) => [r.level, r.title, r.owner || "\u2014", r.support.supportLevel, String(Math.round(r.support.avgScore))]) : [["\u2014", "No at-risk goals identified.", "", "", ""]]
    }));

    const pageCount = doc.internal.getNumberOfPages();
    for (let i = 1; i <= pageCount; i++) {
      doc.setPage(i);
      doc.setFont("helvetica", "normal"); doc.setFontSize(8); doc.setTextColor(120, 130, 140);
      doc.text(footerLine, margin, pageHeight - 24);
      doc.text("Page " + i + " of " + pageCount, pageWidth - margin, pageHeight - 24, { align: "right" });
    }

    doc.save("PAI_Executive_Summary.pdf");
    STATE.exportedOnce = true;
    showToast("Executive Summary PDF downloaded.", "success");
    renderStepIndicator();
  } catch (err) {
    console.error(err);
    showToast("Could not generate PDF: " + err.message, "error");
  }
}
/* ============================== EXPORT: EXCEL (SheetJS) ============================== */

function exportExcel() {
  if (!STATE.analysisRun) { showToast("Run the analysis before exporting.", "error"); return; }
  try {
    const wb = XLSX.utils.book_new();
    const kpi = computeExecutiveKPIs();

    const summaryAOA = [
      ["Performance Alignment Intelligence \u2014 Executive Summary"],
      ["Generated", todayString()],
      [],
      ["Key Metrics"],
      ["Company Goals", kpi.totalCompanyGoals],
      ["Departmental Goals", kpi.totalDeptGoals],
      ["Individual Goals", kpi.totalIndividualGoals],
      ["Weekly Tasks Analysed", kpi.totalTasks],
      ["Strong Support Goals", kpi.strongSupportGoals],
      ["Weak Support Goals", kpi.weakSupportGoals],
      ["No Activity Support Goals", kpi.noActivityGoals],
      ["Departments at Risk", kpi.departmentsAtRisk],
      ["Employees Needing Clarification", kpi.employeesNeedingClarification],
      [],
      ["Alignment Classification Breakdown"],
      ["Classification", "Count", "% of Tasks"]
    ].concat(CLASSIFICATIONS.map((c) => [c, kpi.classificationCounts[c], Number(kpi.classificationPct[c].toFixed(1))]))
     .concat([[], ["Department Performance"], ["Department", "Tasks", "Avg Score", "Support Level", "At Risk"]])
     .concat(Object.keys(STATE.departmentRollups).sort().map((d) => { const r = STATE.departmentRollups[d]; return [d, r.taskCount, Math.round(r.avgScore), r.supportLevel, r.atRisk ? "Yes" : "No"]; }));

    const summarySheet = XLSX.utils.aoa_to_sheet(summaryAOA);
    summarySheet["!cols"] = [{ wch: 34 }, { wch: 18 }, { wch: 14 }, { wch: 18 }, { wch: 12 }];
    XLSX.utils.book_append_sheet(wb, summarySheet, "Summary");

    const empRows = [];
    employeeRoster().forEach((emp) => {
      const goals = cleanRows("individualGoals").filter((ig) => s(ig.Employee_ID) === emp.Employee_ID);
      if (!goals.length) { empRows.push({ Employee_ID: emp.Employee_ID, Employee_Name: emp.Employee_Name, Department: emp.Department, Job_Title: emp.Job_Title, Individual_Goal: "\u2014", Support_Level: "\u2014", Avg_Score: "", Linked_Tasks: 0, Recommended_Action: "No individual goals on record." }); return; }
      goals.forEach((ig) => {
        const sup = STATE.individualGoalSupport[ig.Individual_Goal_ID];
        empRows.push({ Employee_ID: emp.Employee_ID, Employee_Name: emp.Employee_Name, Department: emp.Department, Job_Title: emp.Job_Title, Individual_Goal: ig.Individual_Goal_Title, Support_Level: sup.supportLevel, Avg_Score: Math.round(sup.avgScore), Linked_Tasks: sup.taskCount, Recommended_Action: generateGoalRecommendation(sup, ig.Individual_Goal_Title, emp.Employee_Name) });
      });
    });
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(empRows), "Employee Report");

    const deptRows = cleanRows("departmentalGoals").map((dg) => {
      const sup = STATE.departmentGoalSupport[dg.Department_Goal_ID];
      return { Department: dg.Department, Department_Goal: dg.Department_Goal_Title, KPI: dg.KPI, Target: dg.Target, Goal_Owner: dg.Goal_Owner, Support_Level: sup.supportLevel, Avg_Score: Math.round(sup.avgScore), Linked_Tasks: sup.taskCount, Recommended_Action: generateGoalRecommendation(sup, dg.Department_Goal_Title, dg.Goal_Owner) };
    });
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(deptRows), "Department Report");

    const orgRows = cleanRows("companyGoals").map((cg) => {
      const sup = STATE.companyGoalSupport[cg.Company_Goal_ID];
      return { Company_Goal: cg.Company_Goal_Title, Strategic_Pillar: cg.Strategic_Pillar, Priority: cg.Priority, Timeline: cg.Timeline, Goal_Owner: cg.Goal_Owner, Support_Level: sup.supportLevel, Avg_Score: Math.round(sup.avgScore), Linked_Tasks: sup.taskCount, Recommended_Action: generateGoalRecommendation(sup, cg.Company_Goal_Title, cg.Goal_Owner) };
    });
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(orgRows), "Organisational Report");

    const flagged = (STATE.classifiedTasks || []).filter((t) => t._score.classification === "Misaligned" || t._score.classification === "Unclear due to insufficient information");
    const flaggedRows = flagged.map((t) => ({ Task_ID: t.Task_ID, Employee_Name: t.Employee_Name, Department: t.Department, Planned_Task: t.Planned_Task, Classification: t._score.classification, Score: t._score.total, Reason: REASON_TAG_TEXT[t._score.reasonTag] || "", Recommended_Action: generateTaskFollowUp(t) || "" }));
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(flaggedRows.length ? flaggedRows : [{ Note: "No flagged tasks." }]), "Flagged Tasks");

    const atRiskRows = computeAtRiskGoalsList().map((r) => ({ Level: r.level, Goal: r.title, Owner: r.owner || "", Department: r.department || "", Support_Level: r.support.supportLevel, Avg_Score: Math.round(r.support.avgScore), Linked_Tasks: r.support.taskCount, Risk_Reasons: r.support.riskReasons.join("; ") }));
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(atRiskRows.length ? atRiskRows : [{ Note: "No at-risk goals." }]), "At-Risk Goals");

    const rawRows = (STATE.classifiedTasks || []).map((t) => ({
      Task_ID: t.Task_ID, Week: t.Week, Month: t.Month, Employee_ID: t.Employee_ID, Employee_Name: t.Employee_Name, Department: t.Department,
      Linked_Individual_Goal_ID: t.Linked_Individual_Goal_ID, Planned_Task: t.Planned_Task, Expected_Output: t.Expected_Output, Actual_Output: t.Actual_Output,
      Status: t.Status, Progress_Percentage: t.Progress_Percentage, Evidence: t.Evidence, Challenge: t.Challenge, Supervisor_Comment: t.Supervisor_Comment,
      Linkage_Points: t._score.linkagePoints, Relevance_Points: t._score.relevancePoints, Measurability_Points: t._score.measurabilityPoints, Evidence_Points: t._score.evidencePoints, Progress_Points: t._score.progressPoints,
      Total_Score: t._score.total, Classification: t._score.classification, Reason_Tag: t._score.reasonTag
    }));
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rawRows), "Raw Task Classification");

    XLSX.writeFile(wb, "PAI_Full_Data_Export.xlsx");
    STATE.exportedOnce = true;
    showToast("Full data Excel export downloaded.", "success");
    renderStepIndicator();
  } catch (err) {
    console.error(err);
    showToast("Could not generate Excel export: " + err.message, "error");
  }
}
/* ============================== EXPORT: POWERPOINT (PptxGenJS) ==============================
   Colors below are bare hex (NO leading '#') per PptxGenJS requirements; using '#' corrupts
   the generated file. Mirrors the web app's navy/blue palette and classification colors. */

const PPTX_COLOR = { navy900: "0F2A4A", navy700: "1B3F6E", blue500: "2F6FB0", sky100: "EAF1FA", ink900: "1A2433", ink600: "5B6B82", line: "E2E8F0", white: "FFFFFF", atRisk: "C9792E" };
const PPTX_CLASS_COLOR = { "Directly aligned": "1F8A5C", "Indirectly aligned": "2F6FB0", "Routine/Business-as-usual": "9C7A29", "Misaligned": "B0473F", "Unclear due to insufficient information": "6B5B95" };

function pptxFooterText(dateStr) { return "Performance Alignment Intelligence \u00b7 for L\u2019AINE HR \u00b7 Generated " + dateStr; }

function pptxAddFooter(slide, pageNum, totalPages, dateStr, dark) {
  const color = dark ? PPTX_COLOR.sky100 : PPTX_COLOR.ink600;
  slide.addText(pptxFooterText(dateStr), { x: 0.6, y: 5.22, w: 7.4, h: 0.3, fontSize: 9, color, fontFace: "Calibri", align: "left", valign: "middle", margin: 0 });
  slide.addText(pageNum + " / " + totalPages, { x: 8.6, y: 5.22, w: 0.8, h: 0.3, fontSize: 9, color, fontFace: "Calibri", align: "right", valign: "middle", margin: 0 });
}

function pptxSectionHeader(slide, title, subtitle) {
  slide.addText(title, { x: 0.6, y: 0.4, w: 8.8, h: 0.55, fontSize: 24, bold: true, color: PPTX_COLOR.navy700, fontFace: "Calibri", margin: 0 });
  if (subtitle) slide.addText(subtitle, { x: 0.6, y: 0.95, w: 8.8, h: 0.35, fontSize: 12, color: PPTX_COLOR.ink600, fontFace: "Calibri", margin: 0 });
}

function pptxKpiTile(pptx, slide, x, y, w, h, value, label, accent) {
  slide.addShape(pptx.shapes.ROUNDED_RECTANGLE, { x, y, w, h, fill: { color: PPTX_COLOR.white }, line: { color: PPTX_COLOR.line, width: 1 }, rectRadius: 0.06 });
  slide.addText([
    { text: String(value), options: { fontSize: 28, bold: true, color: accent ? PPTX_COLOR.atRisk : PPTX_COLOR.navy900, breakLine: true, fontFace: "Calibri" } },
    { text: label, options: { fontSize: 11, color: PPTX_COLOR.ink600, fontFace: "Calibri" } }
  ], { x: x + 0.2, y: y + 0.18, w: w - 0.4, h: h - 0.34, valign: "top", margin: 0 });
}

function pptxLegendRow(pptx, slide, x, y, w, color, label, count, pct) {
  slide.addShape(pptx.shapes.RECTANGLE, { x, y: y + 0.05, w: 0.14, h: 0.14, fill: { color } });
  slide.addText(label, { x: x + 0.24, y: y - 0.04, w: w - 1.1, h: 0.32, fontSize: 11, bold: true, color: PPTX_COLOR.ink900, fontFace: "Calibri", valign: "middle", margin: 0 });
  slide.addText(count + " (" + pct + "%)", { x: x + w - 0.95, y: y - 0.04, w: 0.95, h: 0.32, fontSize: 10, color: PPTX_COLOR.ink600, fontFace: "Calibri", align: "right", valign: "middle", margin: 0 });
}

function buildAlignmentNarrative(kpi) {
  const strongPct = Math.round(kpi.classificationPct["Directly aligned"] + kpi.classificationPct["Indirectly aligned"]);
  const flaggedCount = kpi.classificationCounts["Misaligned"] + kpi.classificationCounts["Unclear due to insufficient information"];
  const routineCount = kpi.classificationCounts["Routine/Business-as-usual"];
  const s1 = strongPct + "% of weekly tasks are directly or indirectly aligned to stated goals, showing a clear line of sight between daily work and organisational priorities.";
  const s2 = flaggedCount ? (flaggedCount + (flaggedCount === 1 ? " task requires" : " tasks require") + " follow-up due to misalignment or insufficient information.") : "No tasks currently require follow-up for misalignment or insufficient information \u2014 a strong result.";
  const s3 = routineCount + (routineCount === 1 ? " task reflects" : " tasks reflect") + " routine, business-as-usual work that keeps operations running without directly advancing a specific goal.";
  return s1 + " " + s2 + " " + s3;
}

function buildDeptCallouts(rollups) {
  const depts = Object.keys(rollups);
  if (!depts.length) return ["No department data available."];
  const sorted = depts.slice().sort((a, b) => rollups[b].avgScore - rollups[a].avgScore);
  const top = sorted[0];
  const atRiskDepts = depts.filter((d) => rollups[d].atRisk);
  const lines = [top + " leads with an average alignment score of " + Math.round(rollups[top].avgScore) + "."];
  lines.push(atRiskDepts.length ? ((atRiskDepts.length === 1 ? atRiskDepts[0] + " is" : atRiskDepts.join(", ") + " are") + " flagged at risk and would benefit from a closer review.") : "No departments are currently flagged at risk.");
  return lines;
}

function buildRiskBullets(atRiskGoals) {
  const top = atRiskGoals.slice(0, 3);
  const bullets = top.map((r) => r.level + " \u2014 \u201c" + r.title + "\u201d: " + generateGoalRecommendation(r.support, r.title, r.owner));
  if (atRiskGoals.length > top.length) bullets.push((atRiskGoals.length - top.length) + " additional at-risk goal(s) are detailed in the full Risk & Gap report.");
  if (!bullets.length) bullets.push("No goals are currently flagged at risk \u2014 a strong result across the organisation.");
  return bullets;
}

function buildNextSteps(kpi) {
  const steps = [];
  steps.push(kpi.departmentsAtRisk > 0 ? ("Review the " + kpi.departmentsAtRisk + " at-risk department(s) flagged in this report with department heads.") : "Continue current departmental cadences \u2014 no departments are currently flagged at risk.");
  steps.push(kpi.employeesNeedingClarification > 0 ? ("Follow up with " + kpi.employeesNeedingClarification + " employee(s) whose tasks were classified as unclear due to insufficient information.") : "No employees currently need clarification on unclear tasks.");
  steps.push("Resolve the data-quality gaps identified in Data Validation, then re-run this analysis next reporting period.");
  steps.push("Use the Performance Alignment Intelligence dashboard for the full task-level detail behind this summary.");
  return steps;
}
async function exportPPTX() {
  if (!STATE.analysisRun) { showToast("Run the analysis before exporting.", "error"); return; }
  try {
    const pptx = new PptxGenJS();
    pptx.layout = "LAYOUT_16x9";
    pptx.author = "Performance Alignment Intelligence";
    pptx.company = "L'AINE HR";
    pptx.title = "Performance Alignment Intelligence \u2014 Executive Summary";

    const dateStr = todayString();
    const kpi = computeExecutiveKPIs();
    const totalSlides = 6;

    /* Slide 1 \u2014 Title */
    const slide1 = pptx.addSlide();
    slide1.background = { color: PPTX_COLOR.navy900 };
    slide1.addText("Performance Alignment Intelligence", { x: 0.7, y: 1.95, w: 8.6, h: 1.0, fontSize: 40, bold: true, color: PPTX_COLOR.white, align: "center", fontFace: "Calibri", margin: 0 });
    slide1.addText("Executive Summary \u2014 for L\u2019AINE HR", { x: 0.7, y: 2.95, w: 8.6, h: 0.5, fontSize: 18, color: PPTX_COLOR.sky100, align: "center", fontFace: "Calibri", margin: 0 });
    slide1.addText("Generated " + dateStr, { x: 0.7, y: 3.55, w: 8.6, h: 0.4, fontSize: 11, color: PPTX_COLOR.sky100, align: "center", fontFace: "Calibri", margin: 0 });
    pptxAddFooter(slide1, 1, totalSlides, dateStr, true);

    /* Slide 2 \u2014 KPI Snapshot */
    const slide2 = pptx.addSlide();
    pptxSectionHeader(slide2, "Key Metrics", "Snapshot across goals and weekly task activity.");
    const overallAvg = Math.round(avg((STATE.classifiedTasks || []).map((t) => t._score.total)));
    const tiles = [
      { value: kpi.totalTasks, label: "Weekly Tasks Analysed", accent: false },
      { value: kpi.strongSupportGoals, label: "Strong Support Goals", accent: false },
      { value: kpi.departmentsAtRisk, label: "Departments at Risk", accent: kpi.departmentsAtRisk > 0 },
      { value: kpi.weakSupportGoals + kpi.noActivityGoals, label: "Goals Needing Attention", accent: (kpi.weakSupportGoals + kpi.noActivityGoals) > 0 },
      { value: kpi.employeesNeedingClarification, label: "Employees Needing Clarification", accent: kpi.employeesNeedingClarification > 0 },
      { value: overallAvg, label: "Overall Avg Alignment Score", accent: false }
    ];
    const tileW = 2.8, tileH = 1.35, gapX = 0.2, gapY = 0.25;
    const colX = [0.6, 0.6 + tileW + gapX, 0.6 + 2 * (tileW + gapX)];
    const rowY = [1.5, 1.5 + tileH + gapY];
    tiles.forEach((t, i) => { pptxKpiTile(pptx, slide2, colX[i % 3], rowY[Math.floor(i / 3)], tileW, tileH, t.value, t.label, t.accent); });
    pptxAddFooter(slide2, 2, totalSlides, dateStr, false);

    /* Slide 3 \u2014 Alignment Breakdown */
    const slide3 = pptx.addSlide();
    pptxSectionHeader(slide3, "Alignment Classification Breakdown", "Share of all weekly tasks in each category.");
    const chartLabels = CLASSIFICATIONS;
    const chartValues = chartLabels.map((c) => kpi.classificationCounts[c]);
    const chartColorsArr = chartLabels.map((c) => PPTX_CLASS_COLOR[c]);
    slide3.addChart(pptx.charts.DOUGHNUT, [{ name: "Classification", labels: chartLabels, values: chartValues }], {
      x: 0.6, y: 1.5, w: 4.3, h: 3.55, chartColors: chartColorsArr, showLegend: false, showValue: false, showPercent: false, holeSize: 55
    });
    let legendY = 1.55;
    chartLabels.forEach((c) => { pptxLegendRow(pptx, slide3, 5.3, legendY, 4.1, PPTX_CLASS_COLOR[c], c, kpi.classificationCounts[c], Math.round(kpi.classificationPct[c])); legendY += 0.42; });
    slide3.addText(buildAlignmentNarrative(kpi), { x: 5.3, y: legendY + 0.18, w: 4.1, h: 1.3, fontSize: 11.5, color: PPTX_COLOR.ink900, fontFace: "Calibri", valign: "top", margin: 0 });
    pptxAddFooter(slide3, 3, totalSlides, dateStr, false);

    /* Slide 4 \u2014 Department Performance */
    const slide4 = pptx.addSlide();
    pptxSectionHeader(slide4, "Average Alignment Score by Department", "Mean task score (0\u2013100) per department this period.");
    const depts = Object.keys(STATE.departmentRollups || {}).sort();
    const deptValues = depts.map((d) => Math.round(STATE.departmentRollups[d].avgScore));
    const deptColors = depts.map((d) => (STATE.departmentRollups[d].atRisk ? PPTX_COLOR.atRisk : PPTX_COLOR.blue500));
    slide4.addChart(pptx.charts.BAR, [{ name: "Avg Score", labels: depts, values: deptValues }], {
      x: 0.6, y: 1.5, w: 5.0, h: 3.6, barDir: "col", chartColors: deptColors, showLegend: false,
      valAxisMinVal: 0, valAxisMaxVal: 100, showValue: true, dataLabelPosition: "outEnd", dataLabelColor: PPTX_COLOR.ink900, dataLabelFontSize: 9,
      catAxisLabelColor: PPTX_COLOR.ink600, valAxisLabelColor: PPTX_COLOR.ink600, valGridLine: { color: PPTX_COLOR.line, size: 0.5 }, catGridLine: { style: "none" }
    });
    const calloutLines = buildDeptCallouts(STATE.departmentRollups || {});
    slide4.addText(calloutLines.map((l, i) => ({ text: l, options: { breakLine: i < calloutLines.length - 1, fontSize: 12.5, color: PPTX_COLOR.ink900, fontFace: "Calibri", paraSpaceAfter: 12 } })), { x: 5.9, y: 1.6, w: 3.5, h: 3.3, valign: "top", margin: 0 });
    pptxAddFooter(slide4, 4, totalSlides, dateStr, false);

    /* Slide 5 \u2014 Risks & Actions */
    const slide5 = pptx.addSlide();
    pptxSectionHeader(slide5, "Key Risks & Recommended Actions", "Top items requiring attention this period.");
    const riskBullets = buildRiskBullets(computeAtRiskGoalsList());
    slide5.addText(riskBullets.map((l, i) => ({ text: l, options: { bullet: true, breakLine: i < riskBullets.length - 1, fontSize: 12.5, color: PPTX_COLOR.ink900, fontFace: "Calibri", paraSpaceAfter: 14 } })), { x: 0.6, y: 1.55, w: 8.8, h: 3.5, valign: "top", margin: 0 });
    pptxAddFooter(slide5, 5, totalSlides, dateStr, false);

    /* Slide 6 \u2014 Next Steps */
    const slide6 = pptx.addSlide();
    slide6.background = { color: PPTX_COLOR.navy900 };
    slide6.addText("Recommended Next Steps", { x: 0.7, y: 0.55, w: 8.6, h: 0.7, fontSize: 30, bold: true, color: PPTX_COLOR.white, fontFace: "Calibri", margin: 0 });
    const nextSteps = buildNextSteps(kpi);
    slide6.addText(nextSteps.map((l, i) => ({ text: l, options: { bullet: true, breakLine: i < nextSteps.length - 1, fontSize: 14, color: PPTX_COLOR.sky100, fontFace: "Calibri", paraSpaceAfter: 14 } })), { x: 0.8, y: 1.6, w: 8.4, h: 3.0, valign: "top", margin: 0 });
    slide6.addText("Performance Alignment Intelligence \u00b7 for L\u2019AINE HR", { x: 0.7, y: 4.75, w: 8.6, h: 0.35, fontSize: 12, color: PPTX_COLOR.sky100, align: "center", fontFace: "Calibri", margin: 0 });
    pptxAddFooter(slide6, 6, totalSlides, dateStr, true);

    await pptx.writeFile({ fileName: "PAI_Executive_Summary.pptx" });
    STATE.exportedOnce = true;
    showToast("Executive Summary PowerPoint downloaded.", "success");
    renderStepIndicator();
  } catch (err) {
    console.error(err);
    showToast("Could not generate PowerPoint: " + err.message, "error");
  }
}
/* ============================== TOASTS ============================== */

function showToast(message, type) {
  const host = document.getElementById("toastHost");
  if (!host) return;
  const el = document.createElement("div");
  el.className = "toast" + (type ? " toast-" + type : "");
  el.textContent = message;
  host.appendChild(el);
  setTimeout(() => { el.remove(); }, 4200);
}

/* ============================== NAVIGATION & MASTER ROUTER ============================== */

function navigateTo(section) {
  STATE.currentSection = section;
  renderSection();
  const content = document.getElementById("content");
  if (content) content.scrollTop = 0;
  const sidebar = document.getElementById("sidebar");
  if (sidebar) sidebar.classList.remove("open");
}

const SECTION_RENDERERS = {
  "executive-summary": renderExecutiveSummary,
  "upload-centre": renderUploadCentre,
  "data-validation": renderDataValidation,
  "goal-mapping": renderGoalMapping,
  "alignment-analysis": renderAlignmentAnalysis,
  "employee-reports": renderEmployeeReports,
  "department-reports": renderDepartmentReports,
  "organisational-reports": renderOrganisationalReports,
  "trend-over-time": renderTrendOverTime,
  "risk-gap-reports": renderRiskGapReports,
  "export-centre": renderExportCentre,
  "manage-users": renderManageUsers
};
const SECTION_WIRERS = {
  "executive-summary": wireExecutiveSummary,
  "upload-centre": wireUploadCentre,
  "data-validation": wireDataValidation,
  "alignment-analysis": wireAlignmentAnalysis,
  "employee-reports": wireEmployeeReports,
  "department-reports": wireDepartmentReports,
  "organisational-reports": wireOrganisationalReports,
  "risk-gap-reports": wireRiskGapReports,
  "export-centre": wireExportCentre,
  "manage-users": wireManageUsers
};
const REPORT_LIKE_SECTIONS = ["alignment-analysis", "employee-reports", "department-reports", "organisational-reports", "risk-gap-reports"];

function renderSection() {
  const content = document.getElementById("content");
  if (!content) return;
  const titleInfo = SECTION_TITLES[STATE.currentSection] || ["", ""];
  const renderFn = SECTION_RENDERERS[STATE.currentSection];
  const bodyHtml = renderFn ? renderFn() : emptyStateHtml({ title: "Section not found", text: "Choose a section from the sidebar." });

  content.innerHTML = '<div class="section-header"><div class="section-title">' + escapeHtml(titleInfo[0]) + '</div><div class="section-subtitle">' + escapeHtml(titleInfo[1]) + "</div></div>" + bodyHtml;

  if (REPORT_LIKE_SECTIONS.includes(STATE.currentSection) && STATE.analysisRun) STATE.reportViewed = true;

  const wireFn = SECTION_WIRERS[STATE.currentSection];
  if (wireFn) wireFn();
  if (STATE.currentSection === "executive-summary") renderExecutiveCharts();
  if (STATE.currentSection === "trend-over-time") renderTrendChart();

  const goUpload = document.getElementById("emptyGoUpload"); if (goUpload) goUpload.addEventListener("click", () => navigateTo("upload-centre"));
  const goValidation = document.getElementById("emptyGoValidation"); if (goValidation) goValidation.addEventListener("click", () => navigateTo("data-validation"));
  const runAnalysisBtn = document.getElementById("emptyRunAnalysis"); if (runAnalysisBtn) runAnalysisBtn.addEventListener("click", () => { runAnalysis(); renderSection(); });

  document.querySelectorAll(".nav-item").forEach((btn) => { btn.classList.toggle("active", btn.getAttribute("data-section") === STATE.currentSection); });

  renderStepIndicator();
}

/* ============================== GLOBAL CHROME (sidebar / hamburger / logout) ============================== */

function wireGlobalChrome() {
  document.querySelectorAll(".nav-item").forEach((btn) => {
    btn.addEventListener("click", () => navigateTo(btn.getAttribute("data-section")));
  });
  const hamburger = document.getElementById("hamburgerBtn");
  const sidebar = document.getElementById("sidebar");
  if (hamburger && sidebar) hamburger.addEventListener("click", () => sidebar.classList.toggle("open"));
  const logoutBtn = document.getElementById("logoutBtn");
  if (logoutBtn) logoutBtn.addEventListener("click", handleLogout);
}

/* ============================== PWA: INSTALL PROMPT & SERVICE WORKER ============================== */

function wirePwaInstall() {
  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    STATE.deferredInstallPrompt = e;
    const btn = document.getElementById("installBtn");
    if (btn) btn.hidden = false;
  });
  const installBtn = document.getElementById("installBtn");
  if (installBtn) {
    installBtn.addEventListener("click", async () => {
      if (!STATE.deferredInstallPrompt) return;
      installBtn.hidden = true;
      STATE.deferredInstallPrompt.prompt();
      try {
        const choice = await STATE.deferredInstallPrompt.userChoice;
        if (choice && choice.outcome === "accepted") showToast("Performance Alignment Intelligence installed.", "success");
      } catch (e) {}
      STATE.deferredInstallPrompt = null;
    });
  }
  window.addEventListener("appinstalled", () => {
    const btn = document.getElementById("installBtn");
    if (btn) btn.hidden = true;
  });
}

function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) return;
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("./sw.js").catch((err) => {
      console.warn("Service worker registration failed (expected when not running on a real http(s) deployment):", err);
    });
  });
}

/* ============================== BOOTSTRAP ============================== */
// Boot order: wire static chrome → wire login screen → check for an existing
// session → if found, enter the app directly; otherwise show the login screen.

document.addEventListener("DOMContentLoaded", async () => {
  wireGlobalChrome();
  wirePwaInstall();
  registerServiceWorker();
  wireLoginScreen();

  const user = await checkAuth();
  if (user) {
    await enterApp();
  } else {
    // No session — show login screen (it's visible by default; #app is hidden).
    // Nothing else to do; wireLoginScreen() already attached the submit handler.
  }
});
