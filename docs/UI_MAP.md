# Kineto Dashboard — Full UI & Data Map (2026-11-10)

Crawled read-only. One row per control: **what it does · reads · writes · event emitted/listened.**
Companion plan: READ PIPELINE (one derivation in `src/lib/finance.ts`, see bottom).

---

## 1. Shell — Dock.astro + DashboardLayout.astro (all screens)

| Control | Where | Does | Reads | Writes | Events |
|---|---|---|---|---|---|
| 5 nav items (Calendar / Pacienți / Acasă / Rapoarte / Setări) | Dock.astro:43-63, tap handler :198-217 | SPA navigate (replace history), active pill | `location.pathname` | — | — |
| "+" / Adaugă banner | AddEventBanner.astro:11 | Open AddSession or AddPatient sheet | — | — | `openAddSession` / `openAddPatient` |
| Patients red dot | Dock.astro:162-167 | Alert = `['terminat','ultima_sedinta'].includes(status_abonament) && !dismissed` OR **`p.achitat === false`** | `getPatients()` (post-`applyPackageTruth`) + localStorage `kineto_dismissed_renewals` | — | refreshed on patients/sessions/paymentsUpdated |
| Home dot | Dock.astro:159 | Pending wrap-ups (today's sessions past end-time, still `programat`) | `getPendingWrapUps()` | — | same |
| Global handlers installed by DashboardLayout | :106-860 | card swipe/expand, `editSession`, `deleteSession`, `cancelSession`, `markSessionAbsent`, `confirmSession`→wrap-up, `toggleSessionCounted`→`setSessionCounted`, group variants, `renewSubscription`→`renewWithPrompt`, link interceptor, SIGNED_OUT cleanup | | `programari` (delete/cancel/absent/complete) | `sessionsUpdated`, `patientsUpdated`, `paymentsUpdated`, `openAddSession`, `openWrapUp`, `openRenewalSheet` |
| PaymentSheet / AddSessionSheet / AddPatientSheet / RenewalSheet / ShareScheduleSheet / SessionWrapUpSheet | mounted :87-92, `transition:persist` | global overlays | | | listen `openPaymentSheet` :986, `openAddSession` :1511, `openAddPatient` :772, `openRenewalSheet` :646, `openShareScheduleSheet` :643, `openWrapUp` :1165 |
| SW registration | :847-857 | `/sw.js` update per load | | | — |

## 2. Dashboard home (index.astro → DashboardOverview)

DashboardOverview: pure composition (WeeklyCalendarCard + AddEventBanner + AgendaBlock). No controls of its own.

### WeeklyCalendarCard.astro
| Control | Where | Does | Reads | Writes | Events |
|---|---|---|---|---|---|
| Day buttons `[data-calendar-item]` | rendered :227/:283, click :998→`selectDay` :740 | Select day, header/pill, persist selection | button data attrs; `localStorage.selectedCalendarDate` | `window.currentCalendarDate`, localStorage | `calendarDateSelected {date}` :831 → AgendaBlock :66, calendar.astro :367 |
| Expand/collapse `#calendar-expand-btn` | :188, handler :886 | Week strip ↔ month grid morph | — | DOM classes only | — |
| Drag/swipe on strip | :732-737 | Horizontal scroll + snap | scrollLeft | — | auto-`calendarDateSelected` after settle (:1085, 150ms) |
| Lazy month loading | :500-548 | Moves `<template>` months into strip | — | DOM | — |

### AgendaBlock.astro (today's session cards)
Data feed `renderAgendaBlock` :178: `getSettings()` + `getAppointmentsByDate()` (embed **includes plan**, no status_plata) + `fetchPaymentsForPatients()` + `fetchOpenPackages()` + `applyBeyondSupplyMarks()`; caches to localStorage :287.
| Control | Where | Does | Reads | Writes | Events |
|---|---|---|---|---|---|
| Enable-notifications banner button | :87, handler :95 | Push subscribe via `/api/push-subscribe`, confirmation ping | `isPushSubscribed()` | push_subscriptions (POST) | — |
| Session card buttons | rendered by sessionCard.ts (see §5) | edit/cancel/delete/confirm/wrap-up/renew/toggle-counted/payment badge/phone/drive | | | |
| Auto-prompt timer | :304-357, every 60s | If a session ended ≤3min ago and not finalized → `window.confirmSession(id)` once (sessionStorage dedupe) | today's appointments | — | `openWrapUp` |
| Listeners | :66, :371, :376, :380 | re-render on day select / sessions / patients / page-load | | | skips re-render for `source:'dashboardDelete'` |

## 3. Calendar page (calendar.astro)

Timeline feed `renderTimeline` :369: `getSettings()` + `getAppointmentsByDate(date)` + `fetchPaymentsForPatients` + `fetchOpenPackages` + `applyBeyondSupplyMarks`; raw HTML slot rows :544-606.
| Control | Where | Does | Reads | Writes | Events |
|---|---|---|---|---|---|
| `+ Adaugă ședință` (per slot / after lunch) | :596-602, :563-569 | Open AddSessionSheet prefilled | — | — | `openAddSession {time,date}` |
| Lunch card `[data-lunch-card]` | :556, listener :351-361 | Open per-day lunch edit modal | `getSettings()` | — | — |
| Modal: hour/minute buttons, `lunch-edit-save` | :65-98, :106; save :323-326 | Validate + persist per-day lunch override | settings | `settings.lunch_breaks` (saveSettings) | `settingsUpdated` |
| Session cards | sessionCard.ts | see §5 | | | |
| Long-press drag & drop | :855-915 | Move to slot/day or swap patients on occupied slot | card data attrs | `updateAppointment` (weekend guard client-side, DB trigger `valideaza_programare` rejects overlaps); group = sequential w/ rollback :800-810; swap = `swapAppointmentPatients` | `sessionsUpdated` + programmatic day click |
| Listeners | :632-639 | coalesced re-render | | | |
| ⚠️ Dead branch :399-406 | payment badge | `else if (a.pacienti?.status_plata) pStatus = ...` — embed never selects status_plata → always undefined | | | **delete in pipeline** |

## 4. Patients page (patients.astro → PatientList + AddPatientSheet)

### PatientList.astro
| Control | Where | Does | Reads | Writes | Events |
|---|---|---|---|---|---|
| `#patient-search` | :9, :199-204 | Debounced 250ms search | | | |
| `#add-patient-btn` | :12-20, :227-229 | Open create sheet | — | — | `openAddPatient` |
| Filter chips `[data-filter]` all/belaqva/ghimbav/**unpaid**/**paid**/expired | :75-80, :298-309 | Single-select toggle; rebuilt from `settings.active_categories` | `getSettings()` | — | re-render |
| Sort chips `[data-sort]` name/expired/progress/payment | :88-91, :286-295 | Sort list | row fields | — | re-render |
| Card swipe + summary tap | markup :611/:677 (handlers in DashboardLayout) | reveal actions / expand | — | — | — |
| `.history-btn` / `.open-payment-btn` (badge) | :597/:720-726; :772-776, :789-794 | Open PaymentSheet | — | — | `openPaymentSheet {patientId}` |
| `.edit-btn` | :600, :766-770→:437-443 | Open edit sheet prefilled | — | — | `openAddPatient {isEdit:true, patient}` |
| `.delete-btn` | :603, :778-786→:415-435 | Confirm → soft delete `sters_la=now()` | — | `pacienti.sters_la` | `patientsUpdated {source:'patientListDelete', deletedId}` (self skips re-render) |
| `.call-patient-btn` / `.open-drive-btn` | :729-739 | tel: link / drive link (http(s) validated) | telefon, drive_link | — | — |
| `.share-schedule-btn` | :744-756, :796-807 | Open share sheet | — | — | `openShareScheduleSheet {...}` |
| `.renew-subscription-btn` | :669/:673, :809-816 | Open renewal sheet (only when exhausted & not dismissed) | `isRenewalDismissed` | — | `openRenewalSheet` via `window.renewSubscription` |

**"Neachitați" filter (⚠️ drift #2):** PatientList.astro:472-473 sets `serverFilter.achitat=false/true` → `getPatients` applies `.eq('achitat', …)` **in SQL on the stored column** (patientService.ts:78) *before* `applyPackageTruth` runs → filters on the legacy flag, not the money truth. `expired` filter is client-side (`folosite >= total`).

**Badge (already truth-based):** rendered :632-664 from `applyPackageTruth` fields — One Time: "Achitat"/"Rest: X RON"/"Fără ședințe"; packages: partial `suma/cost`, "Achitat", default "Neachitat". Sort-by-payment (:517) uses post-truth `achitat`.

### AddPatientSheet.astro (create/edit)
| Control | Where | Does | Writes |
|---|---|---|---|
| `#patientName`, `#patientPhone`, `#patientDriveLink` | :39/:161/:178 | identity fields | pacienti (validated: required name; http(s) drive link) |
| Plan chips `[data-plan]` + hidden `#patientPlan` | :57-70, :295-311 | Abonament / Ședință unică; defaults on create only (never overwrites price/sessions on edit) | pacienti.plan |
| `#btn-nu-reinnoi` toggle | :74-85, :326-333 | "Nu reînnoi" (Abonament only) | pacienti.nu_reinnoi |
| Location chips | :94-107 | Belaqva / Ghimbav | pacienti.locatie |
| Cost steppers −/+10 | :121-130 | price | pacienti.cost (via RPC, see below) |
| Sessions steppers −/+1 | :136-145 | package size | pacienti.sedinte_total |
| `#save-patient-btn` | :196-198, :492-574 | create → `addPatient` (dup-name check, `achitat:false`); edit → `updatePatient` | | emits `patientsUpdated` :549 |
| `#btn-renew-sticky` (edit only) | :193-195, :610-618 | Close + open RenewalSheet | — | `openRenewalSheet` |

**`updatePatient` routing (patientService.ts:297-379):** plan normalized both sides (`normalizePlan`, commit a703f4ab — fixes legacy 'Abonament' rows false-switching) → if changed, RPC **`switch_plan`** (closes/opens package, resets counter, note `Schimbare tip abonament: X → Y` in `istoric_evenimente`), strip plan/total/cost from plain update. If `cost` changed → RPC **`update_package_price`** (rewrites open package `pret` + note `Modificare preț pachet: X → Y RON`; One Time → note `Modificare preț ședință: X → Y RON`; always `pacienti.cost`; paid history never repriced). Remaining fields → plain UPDATE.

### RenewalSheet.astro
| Control | Where | Does | Reads | Writes | Events |
|---|---|---|---|---|---|
| Price steppers ±50 `#renewal-price-input` | :51-61 | edit price (`priceTouched`) | — | local | — |
| Sessions steppers ±1 | :67-78 | edit count; auto-price = count × per-session unless price touched | — | local | — |
| `#renewal-start-date` | :83-88 | package start date (default today) | — | passed as `p_data_start` | — |
| Payment mode buttons (Neachitat/Parțial/Achitat) | :96-116, :413-423 | select payment mode; Parțial reveals amount (prefill price/2) | — | local | — |
| `#btn-confirm-renewal` | :135-141, :535-598 | `resetPatientSubscription` → RPC **`renew_package`**; optional pending appointment `createAppointment` | `getSettings`, `getPatient`, `getPatientPackages`; previous-debt card = openPkg.pret − Σ plati :508-521 | abonamente close/open (+over-delivery debt carried), plati (if paid), pacienti (reset counters, achitat, abonament_start) | `patientsUpdated` + `sessionsUpdated` :587-588; `clearRenewalDismissal` |

### ShareScheduleSheet.astro — read-only UI, no DB writes
| Control | Where | Does |
|---|---|---|
| `#share-message-textarea` | :46-51 | editable preview (auto-resize) |
| `#btn-copy-schedule` | :68-77, :374-399 | clipboard + toast |
| `#btn-share-schedule` | :80-89, :402-442 | `navigator.share` or `wa.me/{phone}?text=` (RO 0→40) |

Reads `programari` (upcoming, not finalizat/anulat/absent) + `pacienti` directly.

## 5. Session cards (sessionCard.ts — used by agenda + calendar)

### Single card
| Control | Where | Does | Writes | Events |
|---|---|---|---|---|
| Payment badge | :504 | Open PaymentSheet | — | `openPaymentSheet {patientId}` |
| Reînnoiește + dismiss ✕ | :381-382 | renewal banner (only when subscription exhausted, not dismissed, **not One Time**) | localStorage dismissals | `openRenewalSheet` / `patientsUpdated`+`sessionsUpdated` |
| Edit (pencil, swipe) | :430, handler DashboardLayout:652 | open edit sheet | — | `openAddSession {isEdit}` |
| Anulează | :438, :706-720 | confirm → `cancelAppointment` (status='anulat', motiv) | programari | `sessionsUpdated` |
| Șterge | :447, :675-704 | confirm → `deleteAppointment` | programari | `sessionsUpdated{source:'dashboardDelete'}`, `patientsUpdated`, `paymentsUpdated` |
| Card summary tap / swipe-left | :459-461 (DashboardLayout :281-523) | expand details / reveal actions | — | — |
| Phone / Drive | :514, :525 | tel: / drive_link tab | — | — |
| CONFIRMĂ ȘEDINȚA | :536, :736-752 | open wrap-up (past/today only) | — | `openWrapUp {appointment}` |
| "Se scade din pachet" Da/Nu | :545, :755-765 | include/exclude from counter | `setSessionCounted` → programari.contorizeaza (trigger adjusts sedinte_folosite) | `sessionsUpdated`+`patientsUpdated` |

### Group card / members
Group edit :824, group cancel :833 (no confirm), group delete :842, group confirm :882 (`completeSession` per member ≤ today). Member rows: edit :595, Absent → `markAbsent` :603, delete :611, payment badge → `openPaymentSheet` :640/:743, tel/drive same.

### ⚠️ Local money math here (drift #1)
- `fetchPaymentsForPatients` :48: sumaIncasata per patient = plati linked to **open package only**; patients with no open package (Ședință unică) get all-time sum; localStorage fallback :53-64.
- `deriveSinglePaymentBadge` :262-294: `restDePlata = max(0, costTotal − sumaIncasata)`; green "Achitat" if `paymentStatus` ∈ {Achitat integral, Achitat} or sum ≥ costTotal; amber partial if suma > 0 && rest > 0; else rose "Neachitat". **LEGACY formula — One Time without open package: costTotal=cost, sumaIncasata=all-time → wrong badge after price change or pool allocation.** Member variant :288.
- `paymentStatus` computed in calendar.astro:399-406 / AgendaBlock:239-246 (same formula; includes dead status_plata fallback).

## 6. AddSessionSheet.astro

Opened via `openAddSession`; manager :242.
| Control | Where | Does | Reads | Writes | Events |
|---|---|---|---|---|---|
| `#search-patient-input` + patient radios | :24, :351-416 | pick patient (single) or group; shows exhaustion warning | patientsCache | — | — |
| `#btn-group-session-toggle` | :53, :1313 | group mode (multi-select + location) | — | — | — |
| Date trigger + picker days/month nav | :71, :579-602 | pick date (weekends disabled) | — | hidden input | — |
| Time trigger + hour/minute grids + confirm | :88, :640-677 | pick time bounded by work hours | `getSettings()` | hidden input | — |
| Group location buttons | :117-120 | Belaqva/Ghimbav | — | hidden input | — |
| `#submit-btn` (form) | :130, :927-1097 | create/edit (group edit = delete+update+create; create per patient w/ rollback) | | `createAppointment` / `updateAppointment` → programari (trigger validates overlaps) | `sessionsUpdated` :1088 |
| Beyond-supply guard `confirmIfBeyondSupply` | :905-925 | **skipped entirely for One Time** :909; else warn-only confirm | `getPackageUsage`, `getFutureDemand`, `wouldExceedSupply` | — | — |
| `askRenewIfExhausted` popup | :991-994, :842-843 | exhausted package → renew mini-popup (skips One Time, nu_reinnoi) | | | |
| `renew-mini-yes/setup/no` | :224-227, :870-895 | renew same settings via RPC `renew_package` / open RenewalSheet / proceed | `getPackageUsage` | abonamente via RPC | `patientsUpdated` :875 / `openRenewalSheet` :886 |

## 7. SessionWrapUpSheet.astro

Opened via `openWrapUp`; manager :222; clicks delegated :321-397.
| Control | Where | Does | Writes | Events |
|---|---|---|---|---|
| `#btn-confirm-wrapup` | :145, :562-757 | **finalize sequence**: 1) `completeSession` (status='finalizat', trigger bumps sedinte_folosite) → emits immediately; 2) fresh `getPatient`; 3) paid-on-the-spot → `addPayment(..., appt.id)` → RPC `record_payment` linked to session; 4) One Time & done → `resetPatientSubscription(1, cost)` (RPC resets usage) + reschedule per recurrence; 5) Subscription done & not nu_reinnoi → close + `openRenewalSheet {pendingAppointment}`; 6) else beyond-supply guard (**skipped One Time** :703) + `createAppointment` next slot | programari, plati (RPC), abonamente (RPC) | `sessionsUpdated`+`patientsUpdated` :587-589, later `openRenewalSheet` |
| `#btn-absent-wrapup` | :139, :759 | `markAbsent` | programari status='absent' | `sessionsUpdated`+`patientsUpdated` |
| Recurrence options (same/custom/none) + nested date/time pickers | :51-84, :120-211 | schedule next session | settings | local | — |
| `#btn-paid-on-the-spot` | :103, :399 | toggle; on confirm writes payment at patient's `cost` — **rendered only for One Time** :494-511 | | plati via RPC | |
| `#btn-renew-package` | :38, :409 | open RenewalSheet | | | `openRenewalSheet` :416 |
| Close (backdrop/drag/Esc) | :6-9, :288-305 | close | | | `sessionWrapupClosed` → sessionNotifier drains queue :210 |

Renewal alert decision `initView` :484-492: shown when `folosite+1 >= total` AND plan ∉ {One Time, Ședință unică} AND !nu_reinnoi. One Time counter renders "Unică".

## 8. PaymentSheet.astro (per-patient wallet/history)

Manager :132; opened via `openPaymentSheet`; clicks delegated :299-374.
| Control | Where | Does | Writes | Events |
|---|---|---|---|---|
| Session row `pay-session` | :773, :490 | ask amount (prefill patient.cost) → custom view | | |
| Session row `del-session-payments` | :771, :497 | confirm → `deletePlata` per id | plati DELETE | `patientsUpdated`+`sessionsUpdated`+`paymentsUpdated` :484-487 |
| Package row `pay-package` / `del-package-payments` | :850/:849, :509/:521 | pay rest (`record_payment` w/ abonamentId) / confirm → `deletePackagePlati` | plati (RPC/DELETE) | same trio |
| `#btn-fully-paid` | :82, :456 | `remaining = cost − suma_incasata`; if >0 `addPayment(remaining)` else `setPaymentStatus(true)` | plati RPC / pacienti.achitat | same trio :472-474 |
| `#btn-partially-paid` → custom amount | :75, :412-448 | partial package payment | plati RPC | same |
| `#btn-reset-payment` | :89, :533 | confirm → `resetPayments` (deletes plati of open packages, achitat=false) | plati DELETE + pacienti | same, then close |

**One Time derivation (`loadPatientFinancials` :641 + `getSingleSessionsHistory` patientService.ts:522-576):**
- `platit` per session = linked plati (programare_id); unlinked pool (`Σ all plati − Σ linked`) allocated display-only oldest-first, `min(cost, pool)` per finalized unpaid session (`poolPaid:true`, no delete button).
- `done` = finalizat count; `covered = platit>0`; `paidCnt` = covered count; **`rest = (done − paidCnt) × current cost`** — paid sessions lock, price changes hit only future unpaid sessions.
- Badge :688-698: Fără ședințe / Achitat / "N plătite, M neplătite" / "Nicio ședință plătită".
- ⚠️ Inflation guard :653-659: `isFullyPaid` (incl. legacy `status_plata` — always undefined now) forces `totalPaid=cost` so remaining can't show debt for a flagged-paid package. **Delete in pipeline.**

**History `items[]` :736-923:** sessions (One Time) / packages newest-first (created_at date) / notes from `istoric_evenimente` + derived display-only plan-switch note for One Time patients whose packages are all closed (dated last closed_at). Single sort descending by date :914. Uncounted sessions (`contorizeaza=false`) appended after the sorted list, not sorted in.

## 9. Reports page (ReportsView.astro)

| Control | Where | Does | Reads |
|---|---|---|---|
| `#report-title` day picker + prev/next + day grid | :27-34, :214-218, :520-552 | pick/step base date (step = 1d/7d/1mo/3mo/1yr by tab) | |
| Stats tabs Zi/Săpt/Lună/Trim/An | :43-47, :1262 | load period stats | `getTodayStats`…`getYearStats` (reportsService.ts:74/101/180/238/293) — programari counts + `fetchAllEffectivePayments` (Σ plati.suma in range; legacy fallback: achitat=true & zero-lifetime-plati → +cost once) |
| Chart tabs | :116-119, :1263 | load chart | same period fns, bucketed chartData |
| Ședințe / Absenți cards | :55, :67, :1406/:1503 | drill-down sheets | `getDetailedSessions(start,end,'all'/'absent')` :461/:474 |
| Încasat card + `#chart-period-total-btn` + weekly rows | :75, :172, :1113 | income sheets | `getDetailedPayments(start,end)` :359 |
| Unpaid cards ×2 + per-row click | :95, :101, :1696, :1790 | Plăți Restante sheet; row click → PaymentSheet | `getUnpaidPatients()` :501 → **`openPaymentSheet {patientId}`** |

**`getUnpaidPatients` exact formula (already money-truth):** package debt = Σ per abonamente (status != 'anulat') `max(0, pret − Σ plati.suma)` per patient; One Time = same session-coverage algorithm as `applyPackageTruth` (linked + oldest-first pool at current cost), `rest = unpaid sessions × current cost`. No repricing of paid history.
Reload triggers :1383-1385 on sessions/patients/paymentsUpdated.

## 10. Settings (SettingsHub / SettingsView / LogsView)

| Control | Where | Does | Stores |
|---|---|---|---|
| Profile card → SettingsView profile section | hub :8, view :67-106 | name/phone/email/username | `profiles.*` (+ auth metadata; email via auth update) |
| Day chips ×7 | view :146-152, :574 | working days | `settings.zile_lucratoare` |
| Work start/end + default lunch | view :170-265, time modal :457-495 | schedule | `settings.work_start/end, lunch_start/end` |
| Break day chips + shared times | view :277-340 | per-day lunch overrides | `settings.lunch_breaks` |
| Session duration / break buffer steppers | view :355-373 | timing | `settings.session_duration`, `break_buffer` |
| Default price stepper | view :383-387 | prefills patient price | `settings.default_price` |
| Category chips ×5 | view :400-412 | patient-list filter categories | `settings.categories`, `active_categories` |
| `#btn-save-settings` | view :448, :1031 | section-aware validated save | settings row (upsert) → `setSettingsCache` → `settingsUpdated` |
| `#btn-export-excel` | view :429-435, :1008 | CSV export `Raport_Kineto_Calendar_<date>.csv` | pacienti (post-truth) + programari joined; **no plati** |
| `#btn-test-notification` | view :124, :696 | toggle push subscribe | push_subscriptions |
| `#btn-clear-cache` (hub :151) | :244 | SW unregister + caches + localStorage (keeps auth), reload | — |
| `#btn-logout` (hub :165) | :205 | delete push sub, logout, scrub storage, →/login | push_subscriptions DELETE |
| Logs view: export/copy, test-error, clear, filters | LogsView.astro:20-48 | localStorage logs (`errorLogger`) synced to `error_logs` table | |

## 11. Background services

- **sessionNotifier.ts** (client, init from DashboardLayout:528): polls `getAppointmentsByDate(today)`+settings every 20s; end-of-session window → dedupe (localStorage) → `openWrapUp` + Web Notification (SW); missed wrap-ups queued (`promptMissedSessionWrapUp` → `window.confirmSession`); drains on `sessionWrapupClosed`.
- **check-reminders** (`src/pages/api/check-reminders.ts` + Supabase edge fn w/ cron): start/end alert windows ±min, dedupe vs `notificari` table, push to all user devices; edge fn cleans dead subscriptions (404/410).
- **convex/**: legacy mirror, not in the read path.
- **store.ts**: settings cache singleton; `setSettingsCache` emits `settingsUpdated`.

## 12. Data layer (patientService.ts / appointmentService.ts)

- `getPatients(filter)` :15: `pacienti_view *`, server filters locatie/**achitat (legacy column, :78)**/search(ilike escaped)/inactivi; inactivity sweep (30d, may write status_abonament='inactiv'); all rows → `applyPackageTruth`.
- `applyPackageTruth` :104-190: overlays pachet_curent + plati; `achitat = explicit flag || (cost>0 && paid>=cost)` :142; One Time branch :149-186 sets `ot_done`, `ot_rest` (same pool algorithm, display-only).
- `getAppointmentsByDate` embed: `pacienti(prenume,nume,telefon,locatie,status_abonament,sedinte_folosite,sedinte_total,achitat,cost,nu_reinnoi,plan,id)` — **no status_plata** (all such reads are dead branches).
- Legacy reads to delete in pipeline: calendar.astro:404, AgendaBlock:244 (status_plata), patientService:716 (status_plata fallback in getPatientPayments), PaymentSheet:652-653 (status_plata in isFullyPaid); raw-embed `achitat` badge reads (calendar:400, AgendaBlock:240) replaced by finance.ts state; Dock:164 + PatientList:472 + reportsService legacy `achitat=true` income fallback (:36-37, :409-410) to re-route through finance state.

---

# READ PIPELINE PLAN (approved direction)

One derivation — `src/lib/finance.ts`:
```
computeFinancialState(patient, {sessions, payments, packages, events}) →
  { plan, cost, done, paidCnt, rest, badge, historyItems }   // = today's PaymentSheet algorithm
computeAll(patients, deps)  // absorbs applyPackageTruth
```
Rules: screens render state only; legacy columns never read for display; writes → RPC → event {patientId} → recompute affected patient only.
Order: (1) finance.ts + self-check (Matthias: rest 0 at any price) (2) PaymentSheet (3) sessionCard badges + dead branches (4) PatientList filter + Dock dot (5) statistics (6) store cache + smoke test.
