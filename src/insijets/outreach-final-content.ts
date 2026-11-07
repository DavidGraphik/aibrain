import type {CampaignDraft} from './outreach-campaigns';

/** Synthetic public editorial sample. No contact data, provider calls or activation authority. */
export const OUTREACH_FINAL_CONTENT_VERSION = '2026-10-22';
export const OUTREACH_FINAL_SOURCE_SHA256 = '436c96b3c56a04f506ce75563112a1c77a18dad8a14c3907cbc10a3f33593509';
/** Private names and paths have been replaced; source hash binds this synthetic public sample. */
export const OUTREACH_FINAL_CONTENT = {
  "schemaVersion": "2.0",
  "preparedAt": "2026-10-22 Europe/Madrid",
  "title": "Example Charter — Example Representative feedback revision and Delivery 2 preparation",
  "scope": "Revised review assets and qualification rules. No verified recipient cohort or personalised recipient messages yet; connections and commercial decisions remain pending. No sending or activation authority.",
  "approvalState": "proposed_for_Luca_validation_not_client_approved",
  "preparedFor": "Example Representative / Example Charter",
  "personas": [
    {
      "id": "pa_ea",
      "name": "PA and EA",
      "sourceFitStatement": "Assistants who coordinate travel for an eligible principal; not generic administrative roles.",
      "fitAndDecisionRole": "Coordinator or gatekeeper for a qualifying principal; purchasing authority must be confirmed.",
      "sharePercent": 20,
      "monthOneEnabled": true,
      "status": "proposed_for_client_validation_not_activated",
      "regions": [
        "UK",
        "Switzerland",
        "Italy",
        "France",
        "Spain",
        "Germany"
      ],
      "signals": [
        {
          "id": "pa_ea-1",
          "group": "Travel responsibility",
          "signal": "Explicit itinerary or supplier coordination",
          "requiredEvidence": "Official current role description explicitly includes itinerary/supplier coordination, or dated client/recipient attestation of that remit. Title alone never confirms responsibility; record attestor, date and principal/account reference.",
          "admissibleSourceTypes": [
            "official company/organisation report, service or team page",
            "official management roster or event calendar",
            "client-attested professional requirement or remit"
          ],
          "evidenceRecordRequired": [
            "sourceURL_or_clientAttestationReference",
            "publisher",
            "publicationDate_if_available",
            "observedAt",
            "eventDate_or_fiscalPeriod_if_applicable",
            "claim",
            "reviewer"
          ],
          "freshnessRule": "Recheck before use; proposed 90-day role refresh.",
          "actualEvidenceCollected": false,
          "sourceStatus": "Operational check based on source group; proposed detailed evidence specification, pending Example Representative validation"
        },
        {
          "id": "pa_ea-2",
          "group": "Principal fit",
          "signal": "Qualifying principal relationship",
          "requiredEvidence": "Official reporting line or client confirmation links this assistant to the eligible principal. Hold until economic policy applicability and principal fit are confirmed.",
          "admissibleSourceTypes": [
            "official company/organisation report, service or team page",
            "official management roster or event calendar",
            "client-attested professional requirement or remit"
          ],
          "evidenceRecordRequired": [
            "sourceURL_or_clientAttestationReference",
            "publisher",
            "publicationDate_if_available",
            "observedAt",
            "eventDate_or_fiscalPeriod_if_applicable",
            "claim",
            "reviewer"
          ],
          "freshnessRule": "Recheck before use; proposed 90-day role refresh.",
          "actualEvidenceCollected": false,
          "sourceStatus": "Operational check based on source group; proposed detailed evidence specification, pending Example Representative validation"
        },
        {
          "id": "pa_ea-3",
          "group": "Schedule complexity",
          "signal": "Documented complex diary",
          "requiredEvidence": "Complexity means documented professional requirements such as consecutive meetings or a multi-stop roadshow, with dates and locations confirmed by the client/recipient. Public calendars alone do not prove individual attendance or private travel.",
          "admissibleSourceTypes": [
            "official company/organisation report, service or team page",
            "official management roster or event calendar",
            "client-attested professional requirement or remit"
          ],
          "evidenceRecordRequired": [
            "sourceURL_or_clientAttestationReference",
            "publisher",
            "publicationDate_if_available",
            "observedAt",
            "eventDate_or_fiscalPeriod_if_applicable",
            "claim",
            "reviewer"
          ],
          "freshnessRule": "Future event in next 60 days full timing weight; later announced event half timing weight; expired event zero. Recheck at enrolment.",
          "actualEvidenceCollected": false,
          "sourceStatus": "Operational check based on source group; proposed detailed evidence specification, pending Example Representative validation"
        },
        {
          "id": "pa_ea-4",
          "group": "Backup need",
          "signal": "Need for an additional provider",
          "requiredEvidence": "Backup means client/recipient explicitly asks for a supplementary aviation option. Record the statement and date; do not assume dissatisfaction with an incumbent supplier.",
          "admissibleSourceTypes": [
            "dated client/recipient confirmation within agreed scope"
          ],
          "evidenceRecordRequired": [
            "sourceURL_or_clientAttestationReference",
            "publisher",
            "publicationDate_if_available",
            "observedAt",
            "eventDate_or_fiscalPeriod_if_applicable",
            "claim",
            "reviewer"
          ],
          "freshnessRule": "Use current dated client attestation; recheck changes and eligibility immediately before enrolment.",
          "actualEvidenceCollected": false,
          "sourceStatus": "Operational check based on source group; proposed detailed evidence specification, pending Example Representative validation"
        },
        {
          "id": "pa_ea-5",
          "group": "Current role and reachability",
          "signal": "Current professional route to the coordinator",
          "requiredEvidence": "Current role and independently verified professional email identity are filters. One canonical account coordinates assistant and principal; overlapping contact plans remain held.",
          "admissibleSourceTypes": [
            "official professional channel, current role source, independent verification when authorised"
          ],
          "evidenceRecordRequired": [
            "sourceURL_or_clientAttestationReference",
            "publisher",
            "publicationDate_if_available",
            "observedAt",
            "eventDate_or_fiscalPeriod_if_applicable",
            "claim",
            "reviewer"
          ],
          "freshnessRule": "Recheck before use; proposed 90-day role/contact refresh; unknown/catch-all/risky held.",
          "actualEvidenceCollected": false,
          "sourceStatus": "Operational check based on source group; proposed detailed evidence specification, pending Example Representative validation"
        }
      ],
      "falsePositivesAndExclusions": [
        "Generic administrative/support role with no travel responsibility.",
        "Principal fit or reporting line not supported.",
        "An assistant and principal already being approached independently."
      ],
      "aiExtractsFromPermittedProfessionalEvidence": [
        "Travel remit and reporting line",
        "Current principal/organisation",
        "Sourced public professional schedule constraints"
      ],
      "requiresHumanReview": [
        "Authority to select suppliers",
        "Actual itinerary and passengers",
        "Whether an additional provider is wanted"
      ],
      "scoringFactors": [
        {
          "name": "Travel responsibility",
          "capPoints": 40,
          "sourceRule": "Evidence checklist: missing/partial/complete must be explained with source and date. Legacy40 cap is retained for source compatibility only; these factors add no points to v2.",
          "status": "source-proposed, not proven client-approved"
        },
        {
          "name": "Principal fit",
          "capPoints": 40,
          "sourceRule": "Evidence checklist: missing/partial/complete must be explained with source and date. Legacy40 cap is retained for source compatibility only; these factors add no points to v2.",
          "status": "source-proposed, not proven client-approved"
        },
        {
          "name": "Schedule complexity",
          "capPoints": 40,
          "sourceRule": "Evidence checklist: missing/partial/complete must be explained with source and date. Legacy40 cap is retained for source compatibility only; these factors add no points to v2.",
          "status": "source-proposed, not proven client-approved"
        },
        {
          "name": "Backup need",
          "capPoints": 40,
          "sourceRule": "Evidence checklist: missing/partial/complete must be explained with source and date. Legacy40 cap is retained for source compatibility only; these factors add no points to v2.",
          "status": "source-proposed, not proven client-approved"
        },
        {
          "name": "Current role and reachability",
          "capPoints": 40,
          "sourceRule": "Evidence checklist: missing/partial/complete must be explained with source and date. Legacy40 cap is retained for source compatibility only; these factors add no points to v2.",
          "status": "source-proposed, not proven client-approved"
        }
      ],
      "sourceNumericWeights": "Profile evidence checklist only; no second weighted score. Role, source, contact and economic facts are filters, not bonus points.",
      "aviationMaturityAdjustment": {
        "sharedRuleReference": "aviationMaturityRules",
        "personaApplication": "Ask about the office/client/principal arrangements only within this role; never infer the contact personally owns an aircraft or card. For intermediaries, no principal details without permission."
      },
      "sequence": {
        "language": "en",
        "status": "revised_from_Luca_feedback_draft_not_send_approved",
        "sendEnabled": false,
        "steps": [
          {
            "minimumCalendarDayOffset": 0,
            "subject": "Private flight planning for your office",
            "threadRule": "Same-thread continuation; never create a separate overlapping follow-up sequence.",
            "body": "{{greeting}}\n\nI'm Example Representative at Example Charter. We arrange private charter options around individual travel requirements.\n\nAre there any upcoming itineraries for {{principalFullName}} that are difficult to arrange with commercial airlines? We would be happy to review private flight options, without obligation, around your office's requirements.\n\nIf you prefer no further follow-up, just let me know.\n\nKind regards,\nExample Representative\nInsiJets"
          },
          {
            "minimumCalendarDayOffset": 7,
            "subject": "Re: Private flight planning for your office",
            "threadRule": "Same-thread continuation; never create a separate overlapping follow-up sequence.",
            "body": "{{greeting}}\n\nA useful starting point is the required arrival time and the office's fixed commitments. Could you share an outline route, dates and passenger count for one itinerary you would like assessed?\n\nIf you prefer no further follow-up, just let me know.\n\nKind regards,\nExample Representative\nInsiJets"
          },
          {
            "minimumCalendarDayOffset": 17,
            "subject": "Re: Private flight planning for your office",
            "threadRule": "Same-thread continuation; never create a separate overlapping follow-up sequence.",
            "body": "{{greeting}}\n\nI'll leave this with you for now. If a private flight request comes up for your principal, you can reply here with the outline. If you prefer no further follow-up, just let me know.\n\nKind regards,\nExample Representative\nInsiJets"
          }
        ],
        "eligibilityRequirement": "Actual responsibility for principal travel verified; principal link and eligibility recorded; suppress parallel principal approach."
      },
      "sourceRefs": [
        "ICP_CURRENT_BODY",
        "ICP_MEETING_COMMENTS",
        "WORKING_MIX",
        "EVIDENCE_PLAN",
        "CAMPAIGN_DEMOS"
      ],
      "refinementNote": "The five source group labels and fit statement are preserved; detailed evidence checks and finished persona-specific copy are proposed editorial refinements for validation."
    },
    {
      "id": "executives",
      "name": "Executives",
      "sourceFitStatement": "Top C-level executives with a confirmed relevant authority and professional travel need.",
      "fitAndDecisionRole": "Proposed explicit title list: CEO (Chief Executive Officer), COO (Chief Operating Officer), CFO (Chief Financial Officer), CIO (Chief Investment Officer), CCO (Chief Commercial Officer), CSO (Chief Strategy Officer). Confirm full title, current top C-level status and relevant remit; ambiguous abbreviations, senior leaders and generic directors do not qualify automatically.",
      "sharePercent": 15,
      "monthOneEnabled": true,
      "status": "proposed_for_client_validation_not_activated",
      "regions": [
        "UK",
        "Germany",
        "France",
        "Switzerland",
        "Italy",
        "Spain"
      ],
      "signals": [
        {
          "id": "executives-1",
          "group": "Multi-site remit",
          "signal": "Current multi-site remit",
          "requiredEvidence": "Name the relevant sites from official company locations and current executive remit. This proves geography only; require dated client/recipient itinerary attestation or verified professional commitment before claiming personal travel.",
          "admissibleSourceTypes": [
            "official company/organisation report, service or team page",
            "official management roster or event calendar",
            "client-attested professional requirement or remit"
          ],
          "evidenceRecordRequired": [
            "sourceURL_or_clientAttestationReference",
            "publisher",
            "publicationDate_if_available",
            "observedAt",
            "eventDate_or_fiscalPeriod_if_applicable",
            "claim",
            "reviewer"
          ],
          "freshnessRule": "Recheck before use; proposed 90-day role refresh.",
          "actualEvidenceCollected": false,
          "sourceStatus": "Operational check based on source group; proposed detailed evidence specification, pending Example Representative validation"
        },
        {
          "id": "executives-2",
          "group": "Route friction",
          "signal": "Checked route friction",
          "requiredEvidence": "Actual route/date requirement supported by client/recipient attestation or professional commitment, compared with dated airline timetables, connections, door-to-door time and ground transfer. A company footprint alone is not an itinerary. Retain sources, assumptions and reviewer; route-friction score is proposed 0/10/20.",
          "admissibleSourceTypes": [
            "official company/organisation report, service or team page",
            "official management roster or event calendar",
            "client-attested professional requirement or remit"
          ],
          "evidenceRecordRequired": [
            "sourceURL_or_clientAttestationReference",
            "publisher",
            "publicationDate_if_available",
            "observedAt",
            "eventDate_or_fiscalPeriod_if_applicable",
            "claim",
            "reviewer"
          ],
          "freshnessRule": "Future event in next 60 days full timing weight; later announced event half timing weight; expired event zero. Recheck at enrolment.",
          "actualEvidenceCollected": false,
          "sourceStatus": "Operational check based on source group; proposed detailed evidence specification, pending Example Representative validation"
        },
        {
          "id": "executives-3",
          "group": "Time pressure",
          "signal": "Dated time pressure",
          "requiredEvidence": "Official roadshow, board meeting or consecutive site-visit schedule; no assumed private calendar.",
          "admissibleSourceTypes": [
            "official company/organisation report, service or team page",
            "official management roster or event calendar",
            "client-attested professional requirement or remit"
          ],
          "evidenceRecordRequired": [
            "sourceURL_or_clientAttestationReference",
            "publisher",
            "publicationDate_if_available",
            "observedAt",
            "eventDate_or_fiscalPeriod_if_applicable",
            "claim",
            "reviewer"
          ],
          "freshnessRule": "Future event in next 60 days full timing weight; later announced event half timing weight; expired event zero. Recheck at enrolment.",
          "actualEvidenceCollected": false,
          "sourceStatus": "Operational check based on source group; proposed detailed evidence specification, pending Example Representative validation"
        },
        {
          "id": "executives-4",
          "group": "Decision access",
          "signal": "Decision or coordinator access",
          "requiredEvidence": "Current official team/remit evidence or client confirmation of the appropriate professional contact.",
          "admissibleSourceTypes": [
            "official company/organisation report, service or team page",
            "official management roster or event calendar",
            "client-attested professional requirement or remit"
          ],
          "evidenceRecordRequired": [
            "sourceURL_or_clientAttestationReference",
            "publisher",
            "publicationDate_if_available",
            "observedAt",
            "eventDate_or_fiscalPeriod_if_applicable",
            "claim",
            "reviewer"
          ],
          "freshnessRule": "Recheck before use; proposed 90-day role refresh.",
          "actualEvidenceCollected": false,
          "sourceStatus": "Operational check based on source group; proposed detailed evidence specification, pending Example Representative validation"
        },
        {
          "id": "executives-5",
          "group": "Recurring need",
          "signal": "Recurring operational need",
          "requiredEvidence": "Repeated documented business commitments or client-attested travel requirements, beyond a one-off hypothesis.",
          "admissibleSourceTypes": [
            "dated client/recipient confirmation within agreed scope"
          ],
          "evidenceRecordRequired": [
            "sourceURL_or_clientAttestationReference",
            "publisher",
            "publicationDate_if_available",
            "observedAt",
            "eventDate_or_fiscalPeriod_if_applicable",
            "claim",
            "reviewer"
          ],
          "freshnessRule": "Use current dated client attestation; recheck changes and eligibility immediately before enrolment.",
          "actualEvidenceCollected": false,
          "sourceStatus": "Operational check based on source group; proposed detailed evidence specification, pending Example Representative validation"
        }
      ],
      "falsePositivesAndExclusions": [
        "Job title or company size without a travel reason.",
        "Remote-only responsibility with no supported itinerary.",
        "Generic office footprint presented as personal travel."
      ],
      "aiExtractsFromPermittedProfessionalEvidence": [
        "Sites and current geographic remit",
        "Dated public business triggers",
        "Candidate route and airport evidence"
      ],
      "requiresHumanReview": [
        "Actual travel requirement",
        "Who coordinates/approves travel",
        "Whether charter is suitable for the specific trip"
      ],
      "scoringFactors": [
        {
          "name": "Multi-site remit",
          "capPoints": 40,
          "sourceRule": "Evidence checklist: missing/partial/complete must be explained with source and date. Legacy40 cap is retained for source compatibility only; these factors add no points to v2.",
          "status": "source-proposed, not proven client-approved"
        },
        {
          "name": "Route friction",
          "capPoints": 40,
          "sourceRule": "Evidence checklist: missing/partial/complete must be explained with source and date. Legacy40 cap is retained for source compatibility only; these factors add no points to v2.",
          "status": "source-proposed, not proven client-approved"
        },
        {
          "name": "Time pressure",
          "capPoints": 40,
          "sourceRule": "Evidence checklist: missing/partial/complete must be explained with source and date. Legacy40 cap is retained for source compatibility only; these factors add no points to v2.",
          "status": "source-proposed, not proven client-approved"
        },
        {
          "name": "Decision access",
          "capPoints": 40,
          "sourceRule": "Evidence checklist: missing/partial/complete must be explained with source and date. Legacy40 cap is retained for source compatibility only; these factors add no points to v2.",
          "status": "source-proposed, not proven client-approved"
        },
        {
          "name": "Recurring need",
          "capPoints": 40,
          "sourceRule": "Evidence checklist: missing/partial/complete must be explained with source and date. Legacy40 cap is retained for source compatibility only; these factors add no points to v2.",
          "status": "source-proposed, not proven client-approved"
        }
      ],
      "sourceNumericWeights": "Profile evidence checklist only; no second weighted score. Role, source, contact and economic facts are filters, not bonus points.",
      "aviationMaturityAdjustment": {
        "sharedRuleReference": "aviationMaturityRules",
        "personaApplication": "Use neutral unknown-maturity copy until the recipient/client confirms the actual travel arrangement. Never infer ownership or card use from scale, status or fame."
      },
      "sequence": {
        "language": "en",
        "status": "revised_from_Luca_feedback_draft_not_send_approved",
        "sendEnabled": false,
        "steps": [
          {
            "minimumCalendarDayOffset": 0,
            "subject": "Private flight options for your business travel",
            "threadRule": "Same-thread continuation; never create a separate overlapping follow-up sequence.",
            "body": "{{greeting}}\n\nYour role at {{companyName}}, with operations in {{siteA}} and {{siteB}}, prompted this introduction.\n\nI'm Example Representative at Example Charter. We arrange private charter options around individual travel requirements.\n\nMay I send you our company presentation and aircraft overview? If you have an upcoming trip, we can also prepare a current quotation around your itinerary.\n\nIf you prefer no further follow-up, just let me know.\n\nKind regards,\nExample Representative\nInsiJets"
          },
          {
            "minimumCalendarDayOffset": 7,
            "subject": "Re: Private flight options for your business travel",
            "threadRule": "Same-thread continuation; never create a separate overlapping follow-up sequence.",
            "body": "{{greeting}}\n\nFor a visit to several business locations, we would review the full journey around the meetings that are fixed. Could your travel coordinator share one proposed route and the time needed at each stop?\n\nIf you prefer no further follow-up, just let me know.\n\nKind regards,\nExample Representative\nInsiJets"
          },
          {
            "minimumCalendarDayOffset": 17,
            "subject": "Re: Private flight options for your business travel",
            "threadRule": "Same-thread continuation; never create a separate overlapping follow-up sequence.",
            "body": "{{greeting}}\n\nI'll leave this here for now. If you need an additional option for a planned or urgent trip, we would be happy to review the requirements and current availability. If you prefer no further follow-up, just let me know.\n\nKind regards,\nExample Representative\nInsiJets"
          }
        ],
        "eligibilityRequirement": "Confirmed eligible top C-level title and named sites, if used; sites do not prove actual travel; coordinate assistant/principal as one plan."
      },
      "sourceRefs": [
        "ICP_CURRENT_BODY",
        "ICP_MEETING_COMMENTS",
        "WORKING_MIX",
        "EVIDENCE_PLAN",
        "CAMPAIGN_DEMOS"
      ],
      "refinementNote": "The five source group labels and fit statement are preserved; detailed evidence checks and finished persona-specific copy are proposed editorial refinements for validation."
    },
    {
      "id": "business_owners",
      "name": "Business owners",
      "sourceFitStatement": "Verified owners with Example Representative-requested personal minimum20M net worth AND company net revenue20M in each of the last two years and positive trajectory. Currency, definition and application pending.",
      "fitAndDecisionRole": "Verified owner or delegated travel coordinator. Separate personal net worth minimum20M and company net revenue20M in each of the last two years with positive trajectory; currency, definition and profile applicability pending confirmation.",
      "sharePercent": 18,
      "monthOneEnabled": true,
      "status": "proposed_for_client_validation_not_activated",
      "regions": [
        "Germany",
        "Italy",
        "UK",
        "France",
        "Spain"
      ],
      "signals": [
        {
          "id": "business_owners-1",
          "group": "Financial fit",
          "signal": "Published scale and ownership",
          "requiredEvidence": "Separate evidence of ownership, personal net worth minimum20M, company net revenue20M for each of the last two years and positive trajectory. Do not infer wealth from company revenue, valuation or fame. Currency, definition of net revenue and persona applicability must be confirmed first; unknown holds.",
          "admissibleSourceTypes": [
            "official annual accounts/report plus official ownership evidence"
          ],
          "evidenceRecordRequired": [
            "sourceURL_or_clientAttestationReference",
            "publisher",
            "publicationDate_if_available",
            "observedAt",
            "eventDate_or_fiscalPeriod_if_applicable",
            "claim",
            "reviewer"
          ],
          "freshnessRule": "Recheck before use; proposed 180-day refresh. Retain fiscal year and current status.",
          "actualEvidenceCollected": false,
          "sourceStatus": "Operational check based on source group; proposed detailed evidence specification, pending Example Representative validation"
        },
        {
          "id": "business_owners-2",
          "group": "Regional operating base",
          "signal": "Regional operating base",
          "requiredEvidence": "Official company address and operations evidence outside a major airline hub; not an inferred home address.",
          "admissibleSourceTypes": [
            "official company/organisation report, service or team page",
            "official management roster or event calendar",
            "client-attested professional requirement or remit"
          ],
          "evidenceRecordRequired": [
            "sourceURL_or_clientAttestationReference",
            "publisher",
            "publicationDate_if_available",
            "observedAt",
            "eventDate_or_fiscalPeriod_if_applicable",
            "claim",
            "reviewer"
          ],
          "freshnessRule": "Recheck before use; proposed 90-day role refresh.",
          "actualEvidenceCollected": false,
          "sourceStatus": "Operational check based on source group; proposed detailed evidence specification, pending Example Representative validation"
        },
        {
          "id": "business_owners-3",
          "group": "Business expansion",
          "signal": "Dated expansion trigger",
          "requiredEvidence": "Official acquisition, new plant, export or cross-border site announcement with event/publication dates.",
          "admissibleSourceTypes": [
            "official company/organisation report, service or team page",
            "official management roster or event calendar",
            "client-attested professional requirement or remit"
          ],
          "evidenceRecordRequired": [
            "sourceURL_or_clientAttestationReference",
            "publisher",
            "publicationDate_if_available",
            "observedAt",
            "eventDate_or_fiscalPeriod_if_applicable",
            "claim",
            "reviewer"
          ],
          "freshnessRule": "Future event in next 60 days full timing weight; later announced event half timing weight; expired event zero. Recheck at enrolment.",
          "actualEvidenceCollected": false,
          "sourceStatus": "Operational check based on source group; proposed detailed evidence specification, pending Example Representative validation"
        },
        {
          "id": "business_owners-4",
          "group": "Principal access",
          "signal": "Principal or delegated access",
          "requiredEvidence": "Current official ownership/team evidence and a professional coordinator path.",
          "admissibleSourceTypes": [
            "official company/organisation report, service or team page",
            "official management roster or event calendar",
            "client-attested professional requirement or remit"
          ],
          "evidenceRecordRequired": [
            "sourceURL_or_clientAttestationReference",
            "publisher",
            "publicationDate_if_available",
            "observedAt",
            "eventDate_or_fiscalPeriod_if_applicable",
            "claim",
            "reviewer"
          ],
          "freshnessRule": "Recheck before use; proposed 90-day role refresh.",
          "actualEvidenceCollected": false,
          "sourceStatus": "Operational check based on source group; proposed detailed evidence specification, pending Example Representative validation"
        },
        {
          "id": "business_owners-5",
          "group": "Practical itinerary",
          "signal": "Practical cross-site itinerary",
          "requiredEvidence": "Supported business requirement, checked scheduled alternatives and viable airport/ground-transfer candidate.",
          "admissibleSourceTypes": [
            "official company/organisation report, service or team page",
            "official management roster or event calendar",
            "client-attested professional requirement or remit"
          ],
          "evidenceRecordRequired": [
            "sourceURL_or_clientAttestationReference",
            "publisher",
            "publicationDate_if_available",
            "observedAt",
            "eventDate_or_fiscalPeriod_if_applicable",
            "claim",
            "reviewer"
          ],
          "freshnessRule": "Future event in next 60 days full timing weight; later announced event half timing weight; expired event zero. Recheck at enrolment.",
          "actualEvidenceCollected": false,
          "sourceStatus": "Operational check based on source group; proposed detailed evidence specification, pending Example Representative validation"
        }
      ],
      "falsePositivesAndExclusions": [
        "Revenue/ownership unverified, stale or confused with funding/valuation.",
        "Company scale used to infer personal wealth or aircraft ownership.",
        "Local airport proximity with no real travel requirement."
      ],
      "aiExtractsFromPermittedProfessionalEvidence": [
        "Annual revenue/fiscal period/currency and ownership evidence",
        "Business sites and dated expansion",
        "Professional airport candidates"
      ],
      "requiresHumanReview": [
        "Actual trip and travel authority",
        "Currency conversion date if needed",
        "Airport/handler operational suitability"
      ],
      "scoringFactors": [
        {
          "name": "Financial fit",
          "capPoints": 40,
          "sourceRule": "Evidence checklist: missing/partial/complete must be explained with source and date. Legacy40 cap is retained for source compatibility only; these factors add no points to v2.",
          "status": "source-proposed, not proven client-approved"
        },
        {
          "name": "Regional operating base",
          "capPoints": 40,
          "sourceRule": "Evidence checklist: missing/partial/complete must be explained with source and date. Legacy40 cap is retained for source compatibility only; these factors add no points to v2.",
          "status": "source-proposed, not proven client-approved"
        },
        {
          "name": "Business expansion",
          "capPoints": 40,
          "sourceRule": "Evidence checklist: missing/partial/complete must be explained with source and date. Legacy40 cap is retained for source compatibility only; these factors add no points to v2.",
          "status": "source-proposed, not proven client-approved"
        },
        {
          "name": "Principal access",
          "capPoints": 40,
          "sourceRule": "Evidence checklist: missing/partial/complete must be explained with source and date. Legacy40 cap is retained for source compatibility only; these factors add no points to v2.",
          "status": "source-proposed, not proven client-approved"
        },
        {
          "name": "Practical itinerary",
          "capPoints": 40,
          "sourceRule": "Evidence checklist: missing/partial/complete must be explained with source and date. Legacy40 cap is retained for source compatibility only; these factors add no points to v2.",
          "status": "source-proposed, not proven client-approved"
        }
      ],
      "sourceNumericWeights": "Profile evidence checklist only; no second weighted score. Role, source, contact and economic facts are filters, not bonus points.",
      "aviationMaturityAdjustment": {
        "sharedRuleReference": "aviationMaturityRules",
        "personaApplication": "Use neutral unknown-maturity copy until the recipient/client confirms the actual travel arrangement. Never infer ownership or card use from scale, status or fame."
      },
      "sequence": {
        "language": "en",
        "status": "revised_from_Luca_feedback_draft_not_send_approved",
        "sendEnabled": false,
        "steps": [
          {
            "minimumCalendarDayOffset": 0,
            "subject": "Travel around your business expansion",
            "threadRule": "Same-thread continuation; never create a separate overlapping follow-up sequence.",
            "body": "{{greeting}}\n\nI saw {{companyName}}'s {{announcementDate}} announcement about {{expansionProject}}. Congratulations on the development.\n\nI'm Example Representative at Example Charter. We arrange private charter options around individual travel requirements.\n\nIf the expansion involves upcoming site visits, would it be useful to review private flight options for a specific itinerary?\n\nIf you prefer no further follow-up, just let me know.\n\nKind regards,\nExample Representative\nInsiJets"
          },
          {
            "minimumCalendarDayOffset": 7,
            "subject": "Re: Travel around your business expansion",
            "threadRule": "Same-thread continuation; never create a separate overlapping follow-up sequence.",
            "body": "{{greeting}}\n\nFor a site visit, we can review the airport options, visit duration and onward journey to the facility. Is there an outline itinerary you would like us to assess?\n\nIf you prefer no further follow-up, just let me know.\n\nKind regards,\nExample Representative\nInsiJets"
          },
          {
            "minimumCalendarDayOffset": 17,
            "subject": "Re: Travel around your business expansion",
            "threadRule": "Same-thread continuation; never create a separate overlapping follow-up sequence.",
            "body": "{{greeting}}\n\nI'll leave this with you. If a site visit comes up, let me know and we can review current private flight options. If you prefer no further follow-up, just let me know.\n\nKind regards,\nExample Representative\nInsiJets"
          }
        ],
        "eligibilityRequirement": "Confirmed owner and dated official expansion announcement; do not imply expansion establishes a flight need."
      },
      "sourceRefs": [
        "ICP_CURRENT_BODY",
        "ICP_MEETING_COMMENTS",
        "WORKING_MIX",
        "EVIDENCE_PLAN",
        "CAMPAIGN_DEMOS"
      ],
      "refinementNote": "The five source group labels and fit statement are preserved; detailed evidence checks and finished persona-specific copy are proposed editorial refinements for validation."
    },
    {
      "id": "investors",
      "name": "Investors",
      "sourceFitStatement": "Investment partners, principals and active investors with cross-border portfolios.",
      "fitAndDecisionRole": "Active investment partner/principal with cross-border portfolio responsibilities; coordinator route confirmed.",
      "sharePercent": 8,
      "monthOneEnabled": true,
      "status": "proposed_for_client_validation_not_activated",
      "regions": [
        "UK",
        "Switzerland",
        "Italy",
        "France",
        "Germany"
      ],
      "signals": [
        {
          "id": "investors-1",
          "group": "Active portfolio",
          "signal": "Active cross-border portfolio",
          "requiredEvidence": "Official current portfolio, investment role and board responsibilities; passive holdings alone insufficient.",
          "admissibleSourceTypes": [
            "official company/organisation report, service or team page",
            "official management roster or event calendar",
            "client-attested professional requirement or remit"
          ],
          "evidenceRecordRequired": [
            "sourceURL_or_clientAttestationReference",
            "publisher",
            "publicationDate_if_available",
            "observedAt",
            "eventDate_or_fiscalPeriod_if_applicable",
            "claim",
            "reviewer"
          ],
          "freshnessRule": "Recheck before use; proposed 90-day role refresh.",
          "actualEvidenceCollected": false,
          "sourceStatus": "Operational check based on source group; proposed detailed evidence specification, pending Example Representative validation"
        },
        {
          "id": "investors-2",
          "group": "Travel trigger",
          "signal": "Dated portfolio/roadshow trigger",
          "requiredEvidence": "Official fundraising, deal meeting, roadshow or client-attested portfolio visit and dates.",
          "admissibleSourceTypes": [
            "official company/organisation report, service or team page",
            "official management roster or event calendar",
            "client-attested professional requirement or remit"
          ],
          "evidenceRecordRequired": [
            "sourceURL_or_clientAttestationReference",
            "publisher",
            "publicationDate_if_available",
            "observedAt",
            "eventDate_or_fiscalPeriod_if_applicable",
            "claim",
            "reviewer"
          ],
          "freshnessRule": "Future event in next 60 days full timing weight; later announced event half timing weight; expired event zero. Recheck at enrolment.",
          "actualEvidenceCollected": false,
          "sourceStatus": "Operational check based on source group; proposed detailed evidence specification, pending Example Representative validation"
        },
        {
          "id": "investors-3",
          "group": "Geographic spread",
          "signal": "Geographic responsibility",
          "requiredEvidence": "Official portfolio locations and evidence of personal professional remit across them.",
          "admissibleSourceTypes": [
            "official company/organisation report, service or team page",
            "official management roster or event calendar",
            "client-attested professional requirement or remit"
          ],
          "evidenceRecordRequired": [
            "sourceURL_or_clientAttestationReference",
            "publisher",
            "publicationDate_if_available",
            "observedAt",
            "eventDate_or_fiscalPeriod_if_applicable",
            "claim",
            "reviewer"
          ],
          "freshnessRule": "Recheck before use; proposed 90-day role refresh.",
          "actualEvidenceCollected": false,
          "sourceStatus": "Operational check based on source group; proposed detailed evidence specification, pending Example Representative validation"
        },
        {
          "id": "investors-4",
          "group": "Professional authority",
          "signal": "Relevant professional authority",
          "requiredEvidence": "Current firm/team/board page or client confirmation of remit.",
          "admissibleSourceTypes": [
            "official company/organisation report, service or team page",
            "official management roster or event calendar",
            "client-attested professional requirement or remit"
          ],
          "evidenceRecordRequired": [
            "sourceURL_or_clientAttestationReference",
            "publisher",
            "publicationDate_if_available",
            "observedAt",
            "eventDate_or_fiscalPeriod_if_applicable",
            "claim",
            "reviewer"
          ],
          "freshnessRule": "Recheck before use; proposed 90-day role refresh.",
          "actualEvidenceCollected": false,
          "sourceStatus": "Operational check based on source group; proposed detailed evidence specification, pending Example Representative validation"
        },
        {
          "id": "investors-5",
          "group": "Coordination route",
          "signal": "Coordination route",
          "requiredEvidence": "Named professional travel/office contact with verified remit and account-owner check.",
          "admissibleSourceTypes": [
            "official professional channel, current role source, independent verification when authorised"
          ],
          "evidenceRecordRequired": [
            "sourceURL_or_clientAttestationReference",
            "publisher",
            "publicationDate_if_available",
            "observedAt",
            "eventDate_or_fiscalPeriod_if_applicable",
            "claim",
            "reviewer"
          ],
          "freshnessRule": "Recheck before use; proposed 90-day role/contact refresh; unknown/catch-all/risky held.",
          "actualEvidenceCollected": false,
          "sourceStatus": "Operational check based on source group; proposed detailed evidence specification, pending Example Representative validation"
        }
      ],
      "falsePositivesAndExclusions": [
        "Investing-only profile with no supported movement.",
        "Fund assets confused with personal wealth or travel budget.",
        "Speculation about confidential deals or nonpublic meetings."
      ],
      "aiExtractsFromPermittedProfessionalEvidence": [
        "Public portfolio and role",
        "Published roadshow/board triggers",
        "Professional coordination route"
      ],
      "requiresHumanReview": [
        "Actual itinerary and confidential context",
        "Authority/eligibility to contact",
        "No overlap with the same portfolio/principal account"
      ],
      "scoringFactors": [
        {
          "name": "Active portfolio",
          "capPoints": 40,
          "sourceRule": "Evidence checklist: missing/partial/complete must be explained with source and date. Legacy40 cap is retained for source compatibility only; these factors add no points to v2.",
          "status": "source-proposed, not proven client-approved"
        },
        {
          "name": "Travel trigger",
          "capPoints": 40,
          "sourceRule": "Evidence checklist: missing/partial/complete must be explained with source and date. Legacy40 cap is retained for source compatibility only; these factors add no points to v2.",
          "status": "source-proposed, not proven client-approved"
        },
        {
          "name": "Geographic spread",
          "capPoints": 40,
          "sourceRule": "Evidence checklist: missing/partial/complete must be explained with source and date. Legacy40 cap is retained for source compatibility only; these factors add no points to v2.",
          "status": "source-proposed, not proven client-approved"
        },
        {
          "name": "Professional authority",
          "capPoints": 40,
          "sourceRule": "Evidence checklist: missing/partial/complete must be explained with source and date. Legacy40 cap is retained for source compatibility only; these factors add no points to v2.",
          "status": "source-proposed, not proven client-approved"
        },
        {
          "name": "Coordination route",
          "capPoints": 40,
          "sourceRule": "Evidence checklist: missing/partial/complete must be explained with source and date. Legacy40 cap is retained for source compatibility only; these factors add no points to v2.",
          "status": "source-proposed, not proven client-approved"
        }
      ],
      "sourceNumericWeights": "Profile evidence checklist only; no second weighted score. Role, source, contact and economic facts are filters, not bonus points.",
      "aviationMaturityAdjustment": {
        "sharedRuleReference": "aviationMaturityRules",
        "personaApplication": "Use neutral unknown-maturity copy until the recipient/client confirms the actual travel arrangement. Never infer ownership or card use from scale, status or fame."
      },
      "sequence": {
        "language": "en",
        "status": "revised_from_Luca_feedback_draft_not_send_approved",
        "sendEnabled": false,
        "steps": [
          {
            "minimumCalendarDayOffset": 0,
            "subject": "Flight planning around your investor meetings",
            "threadRule": "Same-thread continuation; never create a separate overlapping follow-up sequence.",
            "body": "{{greeting}}\n\nYour announced participation in {{roadshowName}} on {{roadshowDate}} prompted this note.\n\nI'm Example Representative at Example Charter. We arrange private charter options around individual travel requirements.\n\nIf you are arranging travel around the event, we would be happy to review your requirements. May I send you a presentation about Example Charter and our aircraft network?\n\nIf you prefer no further follow-up, just let me know.\n\nKind regards,\nExample Representative\nInsiJets"
          },
          {
            "minimumCalendarDayOffset": 7,
            "subject": "Re: Flight planning around your investor meetings",
            "threadRule": "Same-thread continuation; never create a separate overlapping follow-up sequence.",
            "body": "{{greeting}}\n\nFor a roadshow or series of meetings, we can start with the cities and meeting times that cannot move. Could your coordinator share one itinerary they would like assessed?\n\nIf you prefer no further follow-up, just let me know.\n\nKind regards,\nExample Representative\nInsiJets"
          },
          {
            "minimumCalendarDayOffset": 17,
            "subject": "Re: Flight planning around your investor meetings",
            "threadRule": "Same-thread continuation; never create a separate overlapping follow-up sequence.",
            "body": "{{greeting}}\n\nI'll leave this here for now. If a roadshow or portfolio visit needs flight options, you or your coordinator can contact me. If you prefer no further follow-up, just let me know.\n\nKind regards,\nExample Representative\nInsiJets"
          }
        ],
        "eligibilityRequirement": "Named future roadshow and recipient participation verified; no inferred private transaction or journey."
      },
      "sourceRefs": [
        "ICP_CURRENT_BODY",
        "ICP_MEETING_COMMENTS",
        "WORKING_MIX",
        "EVIDENCE_PLAN",
        "CAMPAIGN_DEMOS"
      ],
      "refinementNote": "The five source group labels and fit statement are preserved; detailed evidence checks and finished persona-specific copy are proposed editorial refinements for validation."
    },
    {
      "id": "family_offices",
      "name": "Family offices and wealth managers",
      "sourceFitStatement": "Office leadership and the person responsible for principal travel.",
      "fitAndDecisionRole": "Family office operations and wealth/private-client service teams with a confirmed travel coordination or permitted introduction remit; investment-only roles are insufficient.",
      "sharePercent": 13,
      "monthOneEnabled": true,
      "status": "proposed_for_client_validation_not_activated",
      "regions": [
        "Switzerland",
        "UK",
        "Luxembourg",
        "Monaco",
        "Italy"
      ],
      "signals": [
        {
          "id": "family_offices-1",
          "group": "Principal-service fit",
          "signal": "Principal-service remit",
          "requiredEvidence": "Published principal/family operations proposition beyond investment management alone.",
          "admissibleSourceTypes": [
            "official company/organisation report, service or team page",
            "official management roster or event calendar",
            "client-attested professional requirement or remit"
          ],
          "evidenceRecordRequired": [
            "sourceURL_or_clientAttestationReference",
            "publisher",
            "publicationDate_if_available",
            "observedAt",
            "eventDate_or_fiscalPeriod_if_applicable",
            "claim",
            "reviewer"
          ],
          "freshnessRule": "Recheck before use; proposed 90-day role refresh.",
          "actualEvidenceCollected": false,
          "sourceStatus": "Operational check based on source group; proposed detailed evidence specification, pending Example Representative validation"
        },
        {
          "id": "family_offices-2",
          "group": "Travel remit",
          "signal": "Explicit travel/lifestyle responsibility",
          "requiredEvidence": "Official operations/concierge/travel role description or client confirmation.",
          "admissibleSourceTypes": [
            "official company/organisation report, service or team page",
            "official management roster or event calendar",
            "client-attested professional requirement or remit"
          ],
          "evidenceRecordRequired": [
            "sourceURL_or_clientAttestationReference",
            "publisher",
            "publicationDate_if_available",
            "observedAt",
            "eventDate_or_fiscalPeriod_if_applicable",
            "claim",
            "reviewer"
          ],
          "freshnessRule": "Recheck before use; proposed 90-day role refresh.",
          "actualEvidenceCollected": false,
          "sourceStatus": "Operational check based on source group; proposed detailed evidence specification, pending Example Representative validation"
        },
        {
          "id": "family_offices-3",
          "group": "International footprint",
          "signal": "International footprint",
          "requiredEvidence": "Official offices or service responsibilities across countries; not private family locations.",
          "admissibleSourceTypes": [
            "official company/organisation report, service or team page",
            "official management roster or event calendar",
            "client-attested professional requirement or remit"
          ],
          "evidenceRecordRequired": [
            "sourceURL_or_clientAttestationReference",
            "publisher",
            "publicationDate_if_available",
            "observedAt",
            "eventDate_or_fiscalPeriod_if_applicable",
            "claim",
            "reviewer"
          ],
          "freshnessRule": "Recheck before use; proposed 90-day role refresh.",
          "actualEvidenceCollected": false,
          "sourceStatus": "Operational check based on source group; proposed detailed evidence specification, pending Example Representative validation"
        },
        {
          "id": "family_offices-4",
          "group": "Relevant service need",
          "signal": "Relevant service need",
          "requiredEvidence": "Recipient/client-stated itinerary or backup-service requirement; no assumptions about family wealth.",
          "admissibleSourceTypes": [
            "dated client/recipient confirmation within agreed scope"
          ],
          "evidenceRecordRequired": [
            "sourceURL_or_clientAttestationReference",
            "publisher",
            "publicationDate_if_available",
            "observedAt",
            "eventDate_or_fiscalPeriod_if_applicable",
            "claim",
            "reviewer"
          ],
          "freshnessRule": "Use current dated client attestation; recheck changes and eligibility immediately before enrolment.",
          "actualEvidenceCollected": false,
          "sourceStatus": "Operational check based on source group; proposed detailed evidence specification, pending Example Representative validation"
        },
        {
          "id": "family_offices-5",
          "group": "Relationship access",
          "signal": "Permitted relationship access",
          "requiredEvidence": "Professional office channel, authorised coordinator and client-controlled relationship check.",
          "admissibleSourceTypes": [
            "official professional channel, current role source, independent verification when authorised"
          ],
          "evidenceRecordRequired": [
            "sourceURL_or_clientAttestationReference",
            "publisher",
            "publicationDate_if_available",
            "observedAt",
            "eventDate_or_fiscalPeriod_if_applicable",
            "claim",
            "reviewer"
          ],
          "freshnessRule": "Recheck before use; proposed 90-day role/contact refresh; unknown/catch-all/risky held.",
          "actualEvidenceCollected": false,
          "sourceStatus": "Operational check based on source group; proposed detailed evidence specification, pending Example Representative validation"
        }
      ],
      "falsePositivesAndExclusions": [
        "Investment-only office without operations/travel remit.",
        "Assumed family itineraries, private residences or personal wealth.",
        "Protected existing relationship or unapproved introduction."
      ],
      "aiExtractsFromPermittedProfessionalEvidence": [
        "Office service scope",
        "Current professional roles and office geography",
        "Public professional contact channel"
      ],
      "requiresHumanReview": [
        "Travel responsibility and introduction permission",
        "Principal-service need",
        "Relationship protection and manual Tier 1 handling"
      ],
      "scoringFactors": [
        {
          "name": "Principal-service fit",
          "capPoints": 40,
          "sourceRule": "Evidence checklist: missing/partial/complete must be explained with source and date. Legacy40 cap is retained for source compatibility only; these factors add no points to v2.",
          "status": "source-proposed, not proven client-approved"
        },
        {
          "name": "Travel remit",
          "capPoints": 40,
          "sourceRule": "Evidence checklist: missing/partial/complete must be explained with source and date. Legacy40 cap is retained for source compatibility only; these factors add no points to v2.",
          "status": "source-proposed, not proven client-approved"
        },
        {
          "name": "International footprint",
          "capPoints": 40,
          "sourceRule": "Evidence checklist: missing/partial/complete must be explained with source and date. Legacy40 cap is retained for source compatibility only; these factors add no points to v2.",
          "status": "source-proposed, not proven client-approved"
        },
        {
          "name": "Relevant service need",
          "capPoints": 40,
          "sourceRule": "Evidence checklist: missing/partial/complete must be explained with source and date. Legacy40 cap is retained for source compatibility only; these factors add no points to v2.",
          "status": "source-proposed, not proven client-approved"
        },
        {
          "name": "Relationship access",
          "capPoints": 40,
          "sourceRule": "Evidence checklist: missing/partial/complete must be explained with source and date. Legacy40 cap is retained for source compatibility only; these factors add no points to v2.",
          "status": "source-proposed, not proven client-approved"
        }
      ],
      "sourceNumericWeights": "Profile evidence checklist only; no second weighted score. Role, source, contact and economic facts are filters, not bonus points.",
      "aviationMaturityAdjustment": {
        "sharedRuleReference": "aviationMaturityRules",
        "personaApplication": "Ask about the office/client/principal arrangements only within this role; never infer the contact personally owns an aircraft or card. For intermediaries, no principal details without permission."
      },
      "sequence": {
        "language": "en",
        "status": "revised_from_Luca_feedback_draft_not_send_approved",
        "sendEnabled": false,
        "steps": [
          {
            "minimumCalendarDayOffset": 0,
            "subject": "Aviation enquiries through your office",
            "threadRule": "Same-thread continuation; never create a separate overlapping follow-up sequence.",
            "body": "{{greeting}}\n\nI saw that {{officeName}} provides {{principalServiceName}} for principals.\n\nI'm Example Representative at Example Charter. We arrange private charter options around individual travel requirements.\n\nWe would be happy to discuss how your nominated contact handles private flight enquiries. May I send you our company presentation and aircraft network overview? No principal details are needed at this stage.\n\nIf you prefer no further follow-up, just let me know.\n\nKind regards,\nExample Representative\nInsiJets"
          },
          {
            "minimumCalendarDayOffset": 7,
            "subject": "Re: Aviation enquiries through your office",
            "threadRule": "Same-thread continuation; never create a separate overlapping follow-up sequence.",
            "body": "{{greeting}}\n\nWe could start with your preferred briefing and approval process before considering an itinerary. What would your office need from an aviation contact before making a permitted introduction?\n\nIf you prefer no further follow-up, just let me know.\n\nKind regards,\nExample Representative\nInsiJets"
          },
          {
            "minimumCalendarDayOffset": 17,
            "subject": "Re: Aviation enquiries through your office",
            "threadRule": "Same-thread continuation; never create a separate overlapping follow-up sequence.",
            "body": "{{greeting}}\n\nI'll leave this with your office. Your nominated coordinator is welcome to contact me when a private flight request arises. If you prefer no further follow-up, just let me know.\n\nKind regards,\nExample Representative\nInsiJets"
          }
        ],
        "eligibilityRequirement": "Verified principal services and aviation/travel or supplier-introduction remit; investment-only offices held; replaces independent wealth sequence."
      },
      "sourceRefs": [
        "ICP_CURRENT_BODY",
        "ICP_MEETING_COMMENTS",
        "WORKING_MIX",
        "EVIDENCE_PLAN",
        "CAMPAIGN_DEMOS"
      ],
      "refinementNote": "The five source group labels and fit statement are preserved; detailed evidence checks and finished persona-specific copy are proposed editorial refinements for validation."
    },
    {
      "id": "wealth_managers",
      "name": "Wealth managers",
      "sourceFitStatement": "Private-client teams with a legitimate travel introduction role.",
      "fitAndDecisionRole": "Retired standalone lane. Use the family offices and wealth managers contact plan; never enrol a second sequence.",
      "sharePercent": 0,
      "monthOneEnabled": false,
      "status": "retired_standalone_merged_into_family_offices",
      "regions": [
        "Switzerland",
        "UK",
        "Luxembourg",
        "Monaco"
      ],
      "signals": [
        {
          "id": "wealth_managers-1",
          "group": "Private-client segment",
          "signal": "Published private-client proposition",
          "requiredEvidence": "Official UHNW/private-client service description; never individual client wealth inference.",
          "admissibleSourceTypes": [
            "official company/organisation report, service or team page",
            "official management roster or event calendar",
            "client-attested professional requirement or remit"
          ],
          "evidenceRecordRequired": [
            "sourceURL_or_clientAttestationReference",
            "publisher",
            "publicationDate_if_available",
            "observedAt",
            "eventDate_or_fiscalPeriod_if_applicable",
            "claim",
            "reviewer"
          ],
          "freshnessRule": "Recheck before use; proposed 90-day role refresh.",
          "actualEvidenceCollected": false,
          "sourceStatus": "Operational check based on source group; proposed detailed evidence specification, pending Example Representative validation"
        },
        {
          "id": "wealth_managers-2",
          "group": "Introductions remit",
          "signal": "Introductions responsibility",
          "requiredEvidence": "Current professional remit or confirmation permitting service introductions.",
          "admissibleSourceTypes": [
            "official company/organisation report, service or team page",
            "official management roster or event calendar",
            "client-attested professional requirement or remit"
          ],
          "evidenceRecordRequired": [
            "sourceURL_or_clientAttestationReference",
            "publisher",
            "publicationDate_if_available",
            "observedAt",
            "eventDate_or_fiscalPeriod_if_applicable",
            "claim",
            "reviewer"
          ],
          "freshnessRule": "Recheck before use; proposed 90-day role refresh.",
          "actualEvidenceCollected": false,
          "sourceStatus": "Operational check based on source group; proposed detailed evidence specification, pending Example Representative validation"
        },
        {
          "id": "wealth_managers-3",
          "group": "Travel service relevance",
          "signal": "Travel/concierge relevance",
          "requiredEvidence": "Published concierge/lifestyle/travel partner service or a client-confirmed service need.",
          "admissibleSourceTypes": [
            "dated client/recipient confirmation within agreed scope"
          ],
          "evidenceRecordRequired": [
            "sourceURL_or_clientAttestationReference",
            "publisher",
            "publicationDate_if_available",
            "observedAt",
            "eventDate_or_fiscalPeriod_if_applicable",
            "claim",
            "reviewer"
          ],
          "freshnessRule": "Use current dated client attestation; recheck changes and eligibility immediately before enrolment.",
          "actualEvidenceCollected": false,
          "sourceStatus": "Operational check based on source group; proposed detailed evidence specification, pending Example Representative validation"
        },
        {
          "id": "wealth_managers-4",
          "group": "Cross-border practice",
          "signal": "Cross-border practice",
          "requiredEvidence": "Official practice offices or service remit in relevant countries, not assumed client movements.",
          "admissibleSourceTypes": [
            "official company/organisation report, service or team page",
            "official management roster or event calendar",
            "client-attested professional requirement or remit"
          ],
          "evidenceRecordRequired": [
            "sourceURL_or_clientAttestationReference",
            "publisher",
            "publicationDate_if_available",
            "observedAt",
            "eventDate_or_fiscalPeriod_if_applicable",
            "claim",
            "reviewer"
          ],
          "freshnessRule": "Recheck before use; proposed 90-day role refresh.",
          "actualEvidenceCollected": false,
          "sourceStatus": "Operational check based on source group; proposed detailed evidence specification, pending Example Representative validation"
        },
        {
          "id": "wealth_managers-5",
          "group": "Partnership pathway",
          "signal": "Permitted partnership route",
          "requiredEvidence": "Official partnership channel or confirmed introduction process and restrictions.",
          "admissibleSourceTypes": [
            "official professional channel, current role source, independent verification when authorised"
          ],
          "evidenceRecordRequired": [
            "sourceURL_or_clientAttestationReference",
            "publisher",
            "publicationDate_if_available",
            "observedAt",
            "eventDate_or_fiscalPeriod_if_applicable",
            "claim",
            "reviewer"
          ],
          "freshnessRule": "Recheck before use; proposed 90-day role/contact refresh; unknown/catch-all/risky held.",
          "actualEvidenceCollected": false,
          "sourceStatus": "Operational check based on source group; proposed detailed evidence specification, pending Example Representative validation"
        }
      ],
      "falsePositivesAndExclusions": [
        "Investment advice alone without a legitimate travel introduction role.",
        "Private-client asset information used as travel intent.",
        "Unapproved referral payments, client disclosures or introductions."
      ],
      "aiExtractsFromPermittedProfessionalEvidence": [
        "Published services and practice geography",
        "Professional role",
        "Official partnership route"
      ],
      "requiresHumanReview": [
        "Introduction permission and confidentiality",
        "Whether travel support is relevant",
        "Any commercial referral arrangement separately agreed"
      ],
      "scoringFactors": [
        {
          "name": "Private-client segment",
          "capPoints": 40,
          "sourceRule": "Evidence checklist: missing/partial/complete must be explained with source and date. Legacy40 cap is retained for source compatibility only; these factors add no points to v2.",
          "status": "source-proposed, not proven client-approved"
        },
        {
          "name": "Introductions remit",
          "capPoints": 40,
          "sourceRule": "Evidence checklist: missing/partial/complete must be explained with source and date. Legacy40 cap is retained for source compatibility only; these factors add no points to v2.",
          "status": "source-proposed, not proven client-approved"
        },
        {
          "name": "Travel service relevance",
          "capPoints": 40,
          "sourceRule": "Evidence checklist: missing/partial/complete must be explained with source and date. Legacy40 cap is retained for source compatibility only; these factors add no points to v2.",
          "status": "source-proposed, not proven client-approved"
        },
        {
          "name": "Cross-border practice",
          "capPoints": 40,
          "sourceRule": "Evidence checklist: missing/partial/complete must be explained with source and date. Legacy40 cap is retained for source compatibility only; these factors add no points to v2.",
          "status": "source-proposed, not proven client-approved"
        },
        {
          "name": "Partnership pathway",
          "capPoints": 40,
          "sourceRule": "Evidence checklist: missing/partial/complete must be explained with source and date. Legacy40 cap is retained for source compatibility only; these factors add no points to v2.",
          "status": "source-proposed, not proven client-approved"
        }
      ],
      "sourceNumericWeights": "Profile evidence checklist only; no second weighted score. Role, source, contact and economic facts are filters, not bonus points.",
      "aviationMaturityAdjustment": {
        "sharedRuleReference": "aviationMaturityRules",
        "personaApplication": "Ask about the office/client/principal arrangements only within this role; never infer the contact personally owns an aircraft or card. For intermediaries, no principal details without permission."
      },
      "sequence": {
        "language": "en",
        "status": "retired_independent_sequence_use_family_offices",
        "sendEnabled": false,
        "steps": [
          {
            "minimumCalendarDayOffset": 0,
            "subject": "Aviation enquiries through your office",
            "threadRule": "Same-thread continuation; never create a separate overlapping follow-up sequence.",
            "body": "{{greeting}}\n\nI saw that {{officeName}} provides {{principalServiceName}} for principals.\n\nI'm Example Representative at Example Charter. We arrange private charter options around individual travel requirements.\n\nWe would be happy to discuss how your nominated contact handles private flight enquiries. May I send you our company presentation and aircraft network overview? No principal details are needed at this stage.\n\nIf you prefer no further follow-up, just let me know.\n\nKind regards,\nExample Representative\nInsiJets"
          },
          {
            "minimumCalendarDayOffset": 7,
            "subject": "Re: Aviation enquiries through your office",
            "threadRule": "Same-thread continuation; never create a separate overlapping follow-up sequence.",
            "body": "{{greeting}}\n\nWe could start with your preferred briefing and approval process before considering an itinerary. What would your office need from an aviation contact before making a permitted introduction?\n\nIf you prefer no further follow-up, just let me know.\n\nKind regards,\nExample Representative\nInsiJets"
          },
          {
            "minimumCalendarDayOffset": 17,
            "subject": "Re: Aviation enquiries through your office",
            "threadRule": "Same-thread continuation; never create a separate overlapping follow-up sequence.",
            "body": "{{greeting}}\n\nI'll leave this with your office. Your nominated coordinator is welcome to contact me when a private flight request arises. If you prefer no further follow-up, just let me know.\n\nKind regards,\nExample Representative\nInsiJets"
          }
        ],
        "eligibilityRequirement": "Verified principal services and aviation/travel or supplier-introduction remit; investment-only offices held; replaces independent wealth sequence.",
        "canonicalSequenceId": "family_offices"
      },
      "sourceRefs": [
        "ICP_CURRENT_BODY",
        "ICP_MEETING_COMMENTS",
        "WORKING_MIX",
        "EVIDENCE_PLAN",
        "CAMPAIGN_DEMOS"
      ],
      "refinementNote": "The five source group labels and fit statement are preserved; detailed evidence checks and finished persona-specific copy are proposed editorial refinements for validation."
    },
    {
      "id": "sports_managers",
      "name": "Sports managers",
      "sourceFitStatement": "Agents, athlete managers, team travel and player-services coordinators.",
      "fitAndDecisionRole": "Agent, athlete manager, player-services or team-travel coordinator with actual logistics authority.",
      "sharePercent": 7,
      "monthOneEnabled": true,
      "status": "proposed_for_client_validation_not_activated",
      "regions": [
        "UK",
        "Spain",
        "Italy",
        "France",
        "Switzerland"
      ],
      "signals": [
        {
          "id": "sports_managers-1",
          "group": "Relevant roster",
          "signal": "Current relevant roster",
          "requiredEvidence": "Official representation/team roster of international professional athletes; verify role and current status.",
          "admissibleSourceTypes": [
            "official company/organisation report, service or team page",
            "official management roster or event calendar",
            "client-attested professional requirement or remit"
          ],
          "evidenceRecordRequired": [
            "sourceURL_or_clientAttestationReference",
            "publisher",
            "publicationDate_if_available",
            "observedAt",
            "eventDate_or_fiscalPeriod_if_applicable",
            "claim",
            "reviewer"
          ],
          "freshnessRule": "Recheck before use; proposed 90-day role refresh.",
          "actualEvidenceCollected": false,
          "sourceStatus": "Operational check based on source group; proposed detailed evidence specification, pending Example Representative validation"
        },
        {
          "id": "sports_managers-2",
          "group": "Itinerary density",
          "signal": "Dated itinerary density",
          "requiredEvidence": "Official competition/appearance calendar with event dates and locations.",
          "admissibleSourceTypes": [
            "official company/organisation report, service or team page",
            "official management roster or event calendar",
            "client-attested professional requirement or remit"
          ],
          "evidenceRecordRequired": [
            "sourceURL_or_clientAttestationReference",
            "publisher",
            "publicationDate_if_available",
            "observedAt",
            "eventDate_or_fiscalPeriod_if_applicable",
            "claim",
            "reviewer"
          ],
          "freshnessRule": "Future event in next 60 days full timing weight; later announced event half timing weight; expired event zero. Recheck at enrolment.",
          "actualEvidenceCollected": false,
          "sourceStatus": "Operational check based on source group; proposed detailed evidence specification, pending Example Representative validation"
        },
        {
          "id": "sports_managers-3",
          "group": "Travel authority",
          "signal": "Travel coordination authority",
          "requiredEvidence": "Official role or client/recipient confirmation of logistics responsibility.",
          "admissibleSourceTypes": [
            "official company/organisation report, service or team page",
            "official management roster or event calendar",
            "client-attested professional requirement or remit"
          ],
          "evidenceRecordRequired": [
            "sourceURL_or_clientAttestationReference",
            "publisher",
            "publicationDate_if_available",
            "observedAt",
            "eventDate_or_fiscalPeriod_if_applicable",
            "claim",
            "reviewer"
          ],
          "freshnessRule": "Recheck before use; proposed 90-day role refresh.",
          "actualEvidenceCollected": false,
          "sourceStatus": "Operational check based on source group; proposed detailed evidence specification, pending Example Representative validation"
        },
        {
          "id": "sports_managers-4",
          "group": "Operational complexity",
          "signal": "Supported logistics complexity",
          "requiredEvidence": "Confirmed party/equipment requirements and checked transfer constraints; never medical assumptions.",
          "admissibleSourceTypes": [
            "dated client/recipient confirmation within agreed scope"
          ],
          "evidenceRecordRequired": [
            "sourceURL_or_clientAttestationReference",
            "publisher",
            "publicationDate_if_available",
            "observedAt",
            "eventDate_or_fiscalPeriod_if_applicable",
            "claim",
            "reviewer"
          ],
          "freshnessRule": "Use current dated client attestation; recheck changes and eligibility immediately before enrolment.",
          "actualEvidenceCollected": false,
          "sourceStatus": "Operational check based on source group; proposed detailed evidence specification, pending Example Representative validation"
        },
        {
          "id": "sports_managers-5",
          "group": "Portfolio relevance",
          "signal": "Relevant portfolio need",
          "requiredEvidence": "Current represented roster and professional travel relevance, not athlete fame alone.",
          "admissibleSourceTypes": [
            "official company/organisation report, service or team page",
            "official management roster or event calendar",
            "client-attested professional requirement or remit"
          ],
          "evidenceRecordRequired": [
            "sourceURL_or_clientAttestationReference",
            "publisher",
            "publicationDate_if_available",
            "observedAt",
            "eventDate_or_fiscalPeriod_if_applicable",
            "claim",
            "reviewer"
          ],
          "freshnessRule": "Recheck before use; proposed 90-day role refresh.",
          "actualEvidenceCollected": false,
          "sourceStatus": "Operational check based on source group; proposed detailed evidence specification, pending Example Representative validation"
        }
      ],
      "falsePositivesAndExclusions": [
        "Agent role without travel authority.",
        "Private tracking, inferred health/recovery or household movements.",
        "Same athlete approached separately from their manager/team."
      ],
      "aiExtractsFromPermittedProfessionalEvidence": [
        "Official roster, calendar and manager remit",
        "Event date/location",
        "Candidate airport and transfer checks"
      ],
      "requiresHumanReview": [
        "Actual travel party, equipment and logistics",
        "Authority and appropriate contact",
        "Account-level overlap and confidential requirements"
      ],
      "scoringFactors": [
        {
          "name": "Relevant roster",
          "capPoints": 40,
          "sourceRule": "Evidence checklist: missing/partial/complete must be explained with source and date. Legacy40 cap is retained for source compatibility only; these factors add no points to v2.",
          "status": "source-proposed, not proven client-approved"
        },
        {
          "name": "Itinerary density",
          "capPoints": 40,
          "sourceRule": "Evidence checklist: missing/partial/complete must be explained with source and date. Legacy40 cap is retained for source compatibility only; these factors add no points to v2.",
          "status": "source-proposed, not proven client-approved"
        },
        {
          "name": "Travel authority",
          "capPoints": 40,
          "sourceRule": "Evidence checklist: missing/partial/complete must be explained with source and date. Legacy40 cap is retained for source compatibility only; these factors add no points to v2.",
          "status": "source-proposed, not proven client-approved"
        },
        {
          "name": "Operational complexity",
          "capPoints": 40,
          "sourceRule": "Evidence checklist: missing/partial/complete must be explained with source and date. Legacy40 cap is retained for source compatibility only; these factors add no points to v2.",
          "status": "source-proposed, not proven client-approved"
        },
        {
          "name": "Portfolio relevance",
          "capPoints": 40,
          "sourceRule": "Evidence checklist: missing/partial/complete must be explained with source and date. Legacy40 cap is retained for source compatibility only; these factors add no points to v2.",
          "status": "source-proposed, not proven client-approved"
        }
      ],
      "sourceNumericWeights": "Profile evidence checklist only; no second weighted score. Role, source, contact and economic facts are filters, not bonus points.",
      "aviationMaturityAdjustment": {
        "sharedRuleReference": "aviationMaturityRules",
        "personaApplication": "Ask about the office/client/principal arrangements only within this role; never infer the contact personally owns an aircraft or card. For intermediaries, no principal details without permission."
      },
      "sequence": {
        "language": "en",
        "status": "revised_from_Luca_feedback_draft_not_send_approved",
        "sendEnabled": false,
        "steps": [
          {
            "minimumCalendarDayOffset": 0,
            "subject": "Flights between sporting and sponsor commitments",
            "threadRule": "Same-thread continuation; never create a separate overlapping follow-up sequence.",
            "body": "{{greeting}}\n\nI saw that {{agencyName}} represents athletes taking part in {{competitionName}}.\n\nI'm Example Representative at Example Charter. We arrange private charter options around individual travel requirements.\n\nIf useful, we can review flights between competitions, sponsor events and other commitments. May I send you our company presentation and aircraft network overview?\n\nIf you prefer no further follow-up, just let me know.\n\nKind regards,\nExample Representative\nInsiJets"
          },
          {
            "minimumCalendarDayOffset": 7,
            "subject": "Re: Flights between sporting and sponsor commitments",
            "threadRule": "Same-thread continuation; never create a separate overlapping follow-up sequence.",
            "body": "{{greeting}}\n\nFor an event transfer, we would start with the release time, required arrival time and travelling party. Could your travel team share one itinerary they would like assessed, including any equipment requirements?\n\nIf you prefer no further follow-up, just let me know.\n\nKind regards,\nExample Representative\nInsiJets"
          },
          {
            "minimumCalendarDayOffset": 17,
            "subject": "Re: Flights between sporting and sponsor commitments",
            "threadRule": "Same-thread continuation; never create a separate overlapping follow-up sequence.",
            "body": "{{greeting}}\n\nI'll leave this with you. If your travel team needs options for competition or sponsor travel, let me know the outline. If you prefer no further follow-up, just let me know.\n\nKind regards,\nExample Representative\nInsiJets"
          }
        ],
        "eligibilityRequirement": "Roster, future competition and actual travel responsibility verified; sponsor travel is an offer, not an asserted itinerary."
      },
      "sourceRefs": [
        "ICP_CURRENT_BODY",
        "ICP_MEETING_COMMENTS",
        "WORKING_MIX",
        "EVIDENCE_PLAN",
        "CAMPAIGN_DEMOS"
      ],
      "refinementNote": "The five source group labels and fit statement are preserved; detailed evidence checks and finished persona-specific copy are proposed editorial refinements for validation."
    },
    {
      "id": "artist_managers",
      "name": "Artist managers",
      "sourceFitStatement": "Artist, tour and production managers with responsibility for itinerary logistics.",
      "fitAndDecisionRole": "Artist, tour or production manager responsible for professional itinerary logistics.",
      "sharePercent": 5,
      "monthOneEnabled": true,
      "status": "proposed_for_client_validation_not_activated",
      "regions": [
        "UK",
        "Italy",
        "France",
        "Germany",
        "Spain"
      ],
      "signals": [
        {
          "id": "artist_managers-1",
          "group": "Current roster",
          "signal": "Current active roster",
          "requiredEvidence": "Official management/agency roster of active touring artists and current manager affiliation.",
          "admissibleSourceTypes": [
            "official company/organisation report, service or team page",
            "official management roster or event calendar",
            "client-attested professional requirement or remit"
          ],
          "evidenceRecordRequired": [
            "sourceURL_or_clientAttestationReference",
            "publisher",
            "publicationDate_if_available",
            "observedAt",
            "eventDate_or_fiscalPeriod_if_applicable",
            "claim",
            "reviewer"
          ],
          "freshnessRule": "Recheck before use; proposed 90-day role refresh.",
          "actualEvidenceCollected": false,
          "sourceStatus": "Operational check based on source group; proposed detailed evidence specification, pending Example Representative validation"
        },
        {
          "id": "artist_managers-2",
          "group": "Dated itinerary",
          "signal": "Dated professional itinerary",
          "requiredEvidence": "Official announced tour/festival dates and locations; rumours and stale calendars excluded.",
          "admissibleSourceTypes": [
            "official company/organisation report, service or team page",
            "official management roster or event calendar",
            "client-attested professional requirement or remit"
          ],
          "evidenceRecordRequired": [
            "sourceURL_or_clientAttestationReference",
            "publisher",
            "publicationDate_if_available",
            "observedAt",
            "eventDate_or_fiscalPeriod_if_applicable",
            "claim",
            "reviewer"
          ],
          "freshnessRule": "Future event in next 60 days full timing weight; later announced event half timing weight; expired event zero. Recheck at enrolment.",
          "actualEvidenceCollected": false,
          "sourceStatus": "Operational check based on source group; proposed detailed evidence specification, pending Example Representative validation"
        },
        {
          "id": "artist_managers-3",
          "group": "Logistics remit",
          "signal": "Logistics responsibility",
          "requiredEvidence": "Official tour/production/artist role or client confirmation of itinerary remit.",
          "admissibleSourceTypes": [
            "official company/organisation report, service or team page",
            "official management roster or event calendar",
            "client-attested professional requirement or remit"
          ],
          "evidenceRecordRequired": [
            "sourceURL_or_clientAttestationReference",
            "publisher",
            "publicationDate_if_available",
            "observedAt",
            "eventDate_or_fiscalPeriod_if_applicable",
            "claim",
            "reviewer"
          ],
          "freshnessRule": "Recheck before use; proposed 90-day role refresh.",
          "actualEvidenceCollected": false,
          "sourceStatus": "Operational check based on source group; proposed detailed evidence specification, pending Example Representative validation"
        },
        {
          "id": "artist_managers-4",
          "group": "Transfer complexity",
          "signal": "Checked transfer complexity",
          "requiredEvidence": "Two professional commitments and real transfer/airport checks; avoid assumed crew requirements.",
          "admissibleSourceTypes": [
            "official company/organisation report, service or team page",
            "official management roster or event calendar",
            "client-attested professional requirement or remit"
          ],
          "evidenceRecordRequired": [
            "sourceURL_or_clientAttestationReference",
            "publisher",
            "publicationDate_if_available",
            "observedAt",
            "eventDate_or_fiscalPeriod_if_applicable",
            "claim",
            "reviewer"
          ],
          "freshnessRule": "Future event in next 60 days full timing weight; later announced event half timing weight; expired event zero. Recheck at enrolment.",
          "actualEvidenceCollected": false,
          "sourceStatus": "Operational check based on source group; proposed detailed evidence specification, pending Example Representative validation"
        },
        {
          "id": "artist_managers-5",
          "group": "Service opportunity",
          "signal": "Specific service opportunity",
          "requiredEvidence": "Client-stated need or professionally evidenced schedule constraint within the manager remit.",
          "admissibleSourceTypes": [
            "dated client/recipient confirmation within agreed scope"
          ],
          "evidenceRecordRequired": [
            "sourceURL_or_clientAttestationReference",
            "publisher",
            "publicationDate_if_available",
            "observedAt",
            "eventDate_or_fiscalPeriod_if_applicable",
            "claim",
            "reviewer"
          ],
          "freshnessRule": "Use current dated client attestation; recheck changes and eligibility immediately before enrolment.",
          "actualEvidenceCollected": false,
          "sourceStatus": "Operational check based on source group; proposed detailed evidence specification, pending Example Representative validation"
        }
      ],
      "falsePositivesAndExclusions": [
        "Publicity/booking representative without logistics remit.",
        "Rumours, private itineraries or social-media location tracking.",
        "Artist and manager enrolled independently."
      ],
      "aiExtractsFromPermittedProfessionalEvidence": [
        "Official roster and announced dates",
        "Professional manager role",
        "Route/airport candidates"
      ],
      "requiresHumanReview": [
        "Travel party and crew/equipment needs",
        "Actual authority and transfer requirement",
        "Whether to approach the manager instead of artist"
      ],
      "scoringFactors": [
        {
          "name": "Current roster",
          "capPoints": 40,
          "sourceRule": "Evidence checklist: missing/partial/complete must be explained with source and date. Legacy40 cap is retained for source compatibility only; these factors add no points to v2.",
          "status": "source-proposed, not proven client-approved"
        },
        {
          "name": "Dated itinerary",
          "capPoints": 40,
          "sourceRule": "Evidence checklist: missing/partial/complete must be explained with source and date. Legacy40 cap is retained for source compatibility only; these factors add no points to v2.",
          "status": "source-proposed, not proven client-approved"
        },
        {
          "name": "Logistics remit",
          "capPoints": 40,
          "sourceRule": "Evidence checklist: missing/partial/complete must be explained with source and date. Legacy40 cap is retained for source compatibility only; these factors add no points to v2.",
          "status": "source-proposed, not proven client-approved"
        },
        {
          "name": "Transfer complexity",
          "capPoints": 40,
          "sourceRule": "Evidence checklist: missing/partial/complete must be explained with source and date. Legacy40 cap is retained for source compatibility only; these factors add no points to v2.",
          "status": "source-proposed, not proven client-approved"
        },
        {
          "name": "Service opportunity",
          "capPoints": 40,
          "sourceRule": "Evidence checklist: missing/partial/complete must be explained with source and date. Legacy40 cap is retained for source compatibility only; these factors add no points to v2.",
          "status": "source-proposed, not proven client-approved"
        }
      ],
      "sourceNumericWeights": "Profile evidence checklist only; no second weighted score. Role, source, contact and economic facts are filters, not bonus points.",
      "aviationMaturityAdjustment": {
        "sharedRuleReference": "aviationMaturityRules",
        "personaApplication": "Ask about the office/client/principal arrangements only within this role; never infer the contact personally owns an aircraft or card. For intermediaries, no principal details without permission."
      },
      "sequence": {
        "language": "en",
        "status": "revised_from_Luca_feedback_draft_not_send_approved",
        "sendEnabled": false,
        "steps": [
          {
            "minimumCalendarDayOffset": 0,
            "subject": "Flight planning for your artists",
            "threadRule": "Same-thread continuation; never create a separate overlapping follow-up sequence.",
            "body": "{{greeting}}\n\nI saw your team is working on {{tourOrPerformanceName}}.\n\nI'm Example Representative at Example Charter. We arrange private charter options around individual travel requirements.\n\nWe would be happy to review private flight options between performances and for other travel requirements. May I send you our company presentation and aircraft network overview?\n\nIf you prefer no further follow-up, just let me know.\n\nKind regards,\nExample Representative\nInsiJets"
          },
          {
            "minimumCalendarDayOffset": 7,
            "subject": "Re: Flight planning for your artists",
            "threadRule": "Same-thread continuation; never create a separate overlapping follow-up sequence.",
            "body": "{{greeting}}\n\nFor a transfer between performances, we would review departure after the show and arrival before the next commitment. Could we assess one leg with your tour or production coordinator?\n\nIf you prefer no further follow-up, just let me know.\n\nKind regards,\nExample Representative\nInsiJets"
          },
          {
            "minimumCalendarDayOffset": 17,
            "subject": "Re: Flight planning for your artists",
            "threadRule": "Same-thread continuation; never create a separate overlapping follow-up sequence.",
            "body": "{{greeting}}\n\nI'll leave this here for now. Your coordinator can contact me if a performance transfer or another trip needs private flight options. If you prefer no further follow-up, just let me know.\n\nKind regards,\nExample Representative\nInsiJets"
          }
        ],
        "eligibilityRequirement": "Verified manager/logistics remit and named tour or performance relationship; no inferred travel plans."
      },
      "sourceRefs": [
        "ICP_CURRENT_BODY",
        "ICP_MEETING_COMMENTS",
        "WORKING_MIX",
        "EVIDENCE_PLAN",
        "CAMPAIGN_DEMOS"
      ],
      "refinementNote": "The five source group labels and fit statement are preserved; detailed evidence checks and finished persona-specific copy are proposed editorial refinements for validation."
    },
    {
      "id": "elite_athletes",
      "name": "Elite athletes",
      "sourceFitStatement": "F1 first, drawing on our prior experience; also football, golf, tennis and other international sports.",
      "fitAndDecisionRole": "International professional athlete; prefer the authorised manager/team travel contact where appropriate.",
      "sharePercent": 5,
      "monthOneEnabled": true,
      "status": "proposed_for_client_validation_not_activated",
      "regions": [
        "European bases and competition circuits"
      ],
      "signals": [
        {
          "id": "elite_athletes-1",
          "group": "Competition schedule",
          "signal": "Confirmed upcoming competition",
          "requiredEvidence": "Official governing-body/team/event calendar with dated international commitments.",
          "admissibleSourceTypes": [
            "official company/organisation report, service or team page",
            "official management roster or event calendar",
            "client-attested professional requirement or remit"
          ],
          "evidenceRecordRequired": [
            "sourceURL_or_clientAttestationReference",
            "publisher",
            "publicationDate_if_available",
            "observedAt",
            "eventDate_or_fiscalPeriod_if_applicable",
            "claim",
            "reviewer"
          ],
          "freshnessRule": "Future event in next 60 days full timing weight; later announced event half timing weight; expired event zero. Recheck at enrolment.",
          "actualEvidenceCollected": false,
          "sourceStatus": "Operational check based on source group; proposed detailed evidence specification, pending Example Representative validation"
        },
        {
          "id": "elite_athletes-2",
          "group": "Transfer compression",
          "signal": "Checked compressed transfer",
          "requiredEvidence": "Two commitments within 72 hours plus checked transfer constraints, as source strong-signal example.",
          "admissibleSourceTypes": [
            "official company/organisation report, service or team page",
            "official management roster or event calendar",
            "client-attested professional requirement or remit"
          ],
          "evidenceRecordRequired": [
            "sourceURL_or_clientAttestationReference",
            "publisher",
            "publicationDate_if_available",
            "observedAt",
            "eventDate_or_fiscalPeriod_if_applicable",
            "claim",
            "reviewer"
          ],
          "freshnessRule": "Future event in next 60 days full timing weight; later announced event half timing weight; expired event zero. Recheck at enrolment.",
          "actualEvidenceCollected": false,
          "sourceStatus": "Operational check based on source group; proposed detailed evidence specification, pending Example Representative validation"
        },
        {
          "id": "elite_athletes-3",
          "group": "Professional scale",
          "signal": "Professional competition scale",
          "requiredEvidence": "Official top-tier roster/ranking/competition participation, not fame or follower count.",
          "admissibleSourceTypes": [
            "official company/organisation report, service or team page",
            "official management roster or event calendar",
            "client-attested professional requirement or remit"
          ],
          "evidenceRecordRequired": [
            "sourceURL_or_clientAttestationReference",
            "publisher",
            "publicationDate_if_available",
            "observedAt",
            "eventDate_or_fiscalPeriod_if_applicable",
            "claim",
            "reviewer"
          ],
          "freshnessRule": "Recheck before use; proposed 90-day role refresh.",
          "actualEvidenceCollected": false,
          "sourceStatus": "Operational check based on source group; proposed detailed evidence specification, pending Example Representative validation"
        },
        {
          "id": "elite_athletes-4",
          "group": "Delegated travel contact",
          "signal": "Delegated travel contact",
          "requiredEvidence": "Official agent/team travel role and authority; direct athlete contact requires review.",
          "admissibleSourceTypes": [
            "official company/organisation report, service or team page",
            "official management roster or event calendar",
            "client-attested professional requirement or remit"
          ],
          "evidenceRecordRequired": [
            "sourceURL_or_clientAttestationReference",
            "publisher",
            "publicationDate_if_available",
            "observedAt",
            "eventDate_or_fiscalPeriod_if_applicable",
            "claim",
            "reviewer"
          ],
          "freshnessRule": "Recheck before use; proposed 90-day role refresh.",
          "actualEvidenceCollected": false,
          "sourceStatus": "Operational check based on source group; proposed detailed evidence specification, pending Example Representative validation"
        },
        {
          "id": "elite_athletes-5",
          "group": "Operational fit",
          "signal": "Operational suitability",
          "requiredEvidence": "Client-confirmed travel party and requirements plus airport/route checks; no recovery/health inferences.",
          "admissibleSourceTypes": [
            "dated client/recipient confirmation within agreed scope"
          ],
          "evidenceRecordRequired": [
            "sourceURL_or_clientAttestationReference",
            "publisher",
            "publicationDate_if_available",
            "observedAt",
            "eventDate_or_fiscalPeriod_if_applicable",
            "claim",
            "reviewer"
          ],
          "freshnessRule": "Use current dated client attestation; recheck changes and eligibility immediately before enrolment.",
          "actualEvidenceCollected": false,
          "sourceStatus": "Operational check based on source group; proposed detailed evidence specification, pending Example Representative validation"
        }
      ],
      "falsePositivesAndExclusions": [
        "Celebrity status treated as intent or wealth.",
        "Private travel/health surveillance.",
        "Existing team travel commitments or manager contact conflict."
      ],
      "aiExtractsFromPermittedProfessionalEvidence": [
        "Public competition and roster data",
        "Current management/team route",
        "Candidate airport/transfer evidence"
      ],
      "requiresHumanReview": [
        "Contact permission and delegated authority",
        "Actual travel need and party",
        "No parallel athlete/manager/team enrolment"
      ],
      "scoringFactors": [
        {
          "name": "Competition schedule",
          "capPoints": 40,
          "sourceRule": "Evidence checklist: missing/partial/complete must be explained with source and date. Legacy40 cap is retained for source compatibility only; these factors add no points to v2.",
          "status": "source-proposed, not proven client-approved"
        },
        {
          "name": "Transfer compression",
          "capPoints": 40,
          "sourceRule": "Evidence checklist: missing/partial/complete must be explained with source and date. Legacy40 cap is retained for source compatibility only; these factors add no points to v2.",
          "status": "source-proposed, not proven client-approved"
        },
        {
          "name": "Professional scale",
          "capPoints": 40,
          "sourceRule": "Evidence checklist: missing/partial/complete must be explained with source and date. Legacy40 cap is retained for source compatibility only; these factors add no points to v2.",
          "status": "source-proposed, not proven client-approved"
        },
        {
          "name": "Delegated travel contact",
          "capPoints": 40,
          "sourceRule": "Evidence checklist: missing/partial/complete must be explained with source and date. Legacy40 cap is retained for source compatibility only; these factors add no points to v2.",
          "status": "source-proposed, not proven client-approved"
        },
        {
          "name": "Operational fit",
          "capPoints": 40,
          "sourceRule": "Evidence checklist: missing/partial/complete must be explained with source and date. Legacy40 cap is retained for source compatibility only; these factors add no points to v2.",
          "status": "source-proposed, not proven client-approved"
        }
      ],
      "sourceNumericWeights": "Profile evidence checklist only; no second weighted score. Role, source, contact and economic facts are filters, not bonus points.",
      "aviationMaturityAdjustment": {
        "sharedRuleReference": "aviationMaturityRules",
        "personaApplication": "Use neutral unknown-maturity copy until the recipient/client confirms the actual travel arrangement. Never infer ownership or card use from scale, status or fame."
      },
      "sequence": {
        "language": "en",
        "status": "revised_from_Luca_feedback_draft_not_send_approved",
        "sendEnabled": false,
        "steps": [
          {
            "minimumCalendarDayOffset": 0,
            "subject": "Private flight options for your travel",
            "threadRule": "Same-thread continuation; never create a separate overlapping follow-up sequence.",
            "body": "{{greeting}}\n\nI'm Example Representative at Example Charter. We arrange private charter options around individual travel requirements.\n\nWe would be happy to review private flight options for your sporting commitments or other travel. Would you or your manager like support assessing an upcoming trip?\n\nIf you prefer no further follow-up, just let me know.\n\nKind regards,\nExample Representative\nInsiJets"
          },
          {
            "minimumCalendarDayOffset": 7,
            "subject": "Re: Private flight options for your travel",
            "threadRule": "Same-thread continuation; never create a separate overlapping follow-up sequence.",
            "body": "{{greeting}}\n\nFor any itinerary you would like assessed, we can review the route, required arrival time and travelling party with your coordinator. Would you like us to work through the details with that person?\n\nIf you prefer no further follow-up, just let me know.\n\nKind regards,\nExample Representative\nInsiJets"
          },
          {
            "minimumCalendarDayOffset": 17,
            "subject": "Re: Private flight options for your travel",
            "threadRule": "Same-thread continuation; never create a separate overlapping follow-up sequence.",
            "body": "{{greeting}}\n\nI'll leave this with you. Your manager or travel coordinator can contact me whenever private flight options would be useful. If you prefer no further follow-up, just let me know.\n\nKind regards,\nExample Representative\nInsiJets"
          }
        ],
        "eligibilityRequirement": "Verified identity and professional role; prefer authorised manager; do not require competition-congratulations opener or imply a known trip."
      },
      "sourceRefs": [
        "ICP_CURRENT_BODY",
        "ICP_MEETING_COMMENTS",
        "WORKING_MIX",
        "EVIDENCE_PLAN",
        "CAMPAIGN_DEMOS"
      ],
      "refinementNote": "The five source group labels and fit statement are preserved; detailed evidence checks and finished persona-specific copy are proposed editorial refinements for validation."
    },
    {
      "id": "artists_djs",
      "name": "Artists and DJs",
      "sourceFitStatement": "International touring artists and DJs; reach the manager where appropriate.",
      "fitAndDecisionRole": "International touring artist/DJ; the responsible manager is often the appropriate decision route.",
      "sharePercent": 6,
      "monthOneEnabled": true,
      "status": "proposed_for_client_validation_not_activated",
      "regions": [
        "UK",
        "Spain",
        "Italy",
        "France",
        "Germany"
      ],
      "signals": [
        {
          "id": "artists_djs-1",
          "group": "Upcoming tour",
          "signal": "Announced upcoming dates",
          "requiredEvidence": "Official artist, promoter or venue programme with future dates and locations; verify any contradictions.",
          "admissibleSourceTypes": [
            "official company/organisation report, service or team page",
            "official management roster or event calendar",
            "client-attested professional requirement or remit"
          ],
          "evidenceRecordRequired": [
            "sourceURL_or_clientAttestationReference",
            "publisher",
            "publicationDate_if_available",
            "observedAt",
            "eventDate_or_fiscalPeriod_if_applicable",
            "claim",
            "reviewer"
          ],
          "freshnessRule": "Future event in next 60 days full timing weight; later announced event half timing weight; expired event zero. Recheck at enrolment.",
          "actualEvidenceCollected": false,
          "sourceStatus": "Operational check based on source group; proposed detailed evidence specification, pending Example Representative validation"
        },
        {
          "id": "artists_djs-2",
          "group": "Turnaround pressure",
          "signal": "Supported turnaround pressure",
          "requiredEvidence": "Back-to-back dates and checked practical transfer rather than inferred personal plans.",
          "admissibleSourceTypes": [
            "official company/organisation report, service or team page",
            "official management roster or event calendar",
            "client-attested professional requirement or remit"
          ],
          "evidenceRecordRequired": [
            "sourceURL_or_clientAttestationReference",
            "publisher",
            "publicationDate_if_available",
            "observedAt",
            "eventDate_or_fiscalPeriod_if_applicable",
            "claim",
            "reviewer"
          ],
          "freshnessRule": "Future event in next 60 days full timing weight; later announced event half timing weight; expired event zero. Recheck at enrolment.",
          "actualEvidenceCollected": false,
          "sourceStatus": "Operational check based on source group; proposed detailed evidence specification, pending Example Representative validation"
        },
        {
          "id": "artists_djs-3",
          "group": "Tour scale",
          "signal": "International professional scale",
          "requiredEvidence": "Official international touring footprint; follower count alone insufficient.",
          "admissibleSourceTypes": [
            "official company/organisation report, service or team page",
            "official management roster or event calendar",
            "client-attested professional requirement or remit"
          ],
          "evidenceRecordRequired": [
            "sourceURL_or_clientAttestationReference",
            "publisher",
            "publicationDate_if_available",
            "observedAt",
            "eventDate_or_fiscalPeriod_if_applicable",
            "claim",
            "reviewer"
          ],
          "freshnessRule": "Recheck before use; proposed 90-day role refresh.",
          "actualEvidenceCollected": false,
          "sourceStatus": "Operational check based on source group; proposed detailed evidence specification, pending Example Representative validation"
        },
        {
          "id": "artists_djs-4",
          "group": "Team access",
          "signal": "Responsible team access",
          "requiredEvidence": "Official management/tour contact with current logistics remit and account coordination.",
          "admissibleSourceTypes": [
            "official company/organisation report, service or team page",
            "official management roster or event calendar",
            "client-attested professional requirement or remit"
          ],
          "evidenceRecordRequired": [
            "sourceURL_or_clientAttestationReference",
            "publisher",
            "publicationDate_if_available",
            "observedAt",
            "eventDate_or_fiscalPeriod_if_applicable",
            "claim",
            "reviewer"
          ],
          "freshnessRule": "Recheck before use; proposed 90-day role refresh.",
          "actualEvidenceCollected": false,
          "sourceStatus": "Operational check based on source group; proposed detailed evidence specification, pending Example Representative validation"
        },
        {
          "id": "artists_djs-5",
          "group": "Flight practicality",
          "signal": "Flight practicality",
          "requiredEvidence": "Viable airport pair, ground transfer and actual requirements checked before flight-specific claims.",
          "admissibleSourceTypes": [
            "official company/organisation report, service or team page",
            "official management roster or event calendar",
            "client-attested professional requirement or remit"
          ],
          "evidenceRecordRequired": [
            "sourceURL_or_clientAttestationReference",
            "publisher",
            "publicationDate_if_available",
            "observedAt",
            "eventDate_or_fiscalPeriod_if_applicable",
            "claim",
            "reviewer"
          ],
          "freshnessRule": "Future event in next 60 days full timing weight; later announced event half timing weight; expired event zero. Recheck at enrolment.",
          "actualEvidenceCollected": false,
          "sourceStatus": "Operational check based on source group; proposed detailed evidence specification, pending Example Representative validation"
        }
      ],
      "falsePositivesAndExclusions": [
        "Old/rumoured event listings.",
        "Fame or follower count used as ownership/buying intent.",
        "Private location tracking or duplicate artist/manager approaches."
      ],
      "aiExtractsFromPermittedProfessionalEvidence": [
        "Announced professional dates and management",
        "Documented touring footprint",
        "Airport/route candidates"
      ],
      "requiresHumanReview": [
        "Actual transfer requirements and travel party",
        "Whether manager should receive the approach",
        "Any claimed flight suitability"
      ],
      "scoringFactors": [
        {
          "name": "Upcoming tour",
          "capPoints": 40,
          "sourceRule": "Evidence checklist: missing/partial/complete must be explained with source and date. Legacy40 cap is retained for source compatibility only; these factors add no points to v2.",
          "status": "source-proposed, not proven client-approved"
        },
        {
          "name": "Turnaround pressure",
          "capPoints": 40,
          "sourceRule": "Evidence checklist: missing/partial/complete must be explained with source and date. Legacy40 cap is retained for source compatibility only; these factors add no points to v2.",
          "status": "source-proposed, not proven client-approved"
        },
        {
          "name": "Tour scale",
          "capPoints": 40,
          "sourceRule": "Evidence checklist: missing/partial/complete must be explained with source and date. Legacy40 cap is retained for source compatibility only; these factors add no points to v2.",
          "status": "source-proposed, not proven client-approved"
        },
        {
          "name": "Team access",
          "capPoints": 40,
          "sourceRule": "Evidence checklist: missing/partial/complete must be explained with source and date. Legacy40 cap is retained for source compatibility only; these factors add no points to v2.",
          "status": "source-proposed, not proven client-approved"
        },
        {
          "name": "Flight practicality",
          "capPoints": 40,
          "sourceRule": "Evidence checklist: missing/partial/complete must be explained with source and date. Legacy40 cap is retained for source compatibility only; these factors add no points to v2.",
          "status": "source-proposed, not proven client-approved"
        }
      ],
      "sourceNumericWeights": "Profile evidence checklist only; no second weighted score. Role, source, contact and economic facts are filters, not bonus points.",
      "aviationMaturityAdjustment": {
        "sharedRuleReference": "aviationMaturityRules",
        "personaApplication": "Use neutral unknown-maturity copy until the recipient/client confirms the actual travel arrangement. Never infer ownership or card use from scale, status or fame."
      },
      "sequence": {
        "language": "en",
        "status": "revised_from_Luca_feedback_draft_not_send_approved",
        "sendEnabled": false,
        "steps": [
          {
            "minimumCalendarDayOffset": 0,
            "subject": "Private flights for your tour and other travel",
            "threadRule": "Same-thread continuation; never create a separate overlapping follow-up sequence.",
            "body": "{{greeting}}\n\nI saw the announcement for {{tourName}}, including {{cityA}} and {{cityB}}.\n\nI'm Example Representative at Example Charter. We arrange private charter options around individual travel requirements.\n\nWould you or your tour manager like to review private flight options for the tour or another upcoming itinerary?\n\nIf you prefer no further follow-up, just let me know.\n\nKind regards,\nExample Representative\nInsiJets"
          },
          {
            "minimumCalendarDayOffset": 7,
            "subject": "Re: Private flights for your tour and other travel",
            "threadRule": "Same-thread continuation; never create a separate overlapping follow-up sequence.",
            "body": "{{greeting}}\n\nWe can start with one transfer between {{cityA}} and {{cityB}}, taking performance times and the travelling party into account. Would you like us to assess it with your tour manager, or is there another trip to review?\n\nIf you prefer no further follow-up, just let me know.\n\nKind regards,\nExample Representative\nInsiJets"
          },
          {
            "minimumCalendarDayOffset": 17,
            "subject": "Re: Private flights for your tour and other travel",
            "threadRule": "Same-thread continuation; never create a separate overlapping follow-up sequence.",
            "body": "{{greeting}}\n\nI'll leave this here for now. If you or your tour manager need flight options for the tour or another trip, feel free to contact me. If you prefer no further follow-up, just let me know.\n\nKind regards,\nExample Representative\nInsiJets"
          }
        ],
        "eligibilityRequirement": "Official upcoming tour with verified dates/cities; prefer authorised manager and suppress parallel approaches."
      },
      "sourceRefs": [
        "ICP_CURRENT_BODY",
        "ICP_MEETING_COMMENTS",
        "WORKING_MIX",
        "EVIDENCE_PLAN",
        "CAMPAIGN_DEMOS"
      ],
      "refinementNote": "The five source group labels and fit statement are preserved; detailed evidence checks and finished persona-specific copy are proposed editorial refinements for validation."
    },
    {
      "id": "art_galleries",
      "name": "Art and galleries",
      "sourceFitStatement": "Gallery leadership, dealers and art advisers with international fair or client travel.",
      "fitAndDecisionRole": "Gallery owner/director, dealer or art adviser; inactive 0% month one and review-only copy.",
      "sharePercent": 0,
      "monthOneEnabled": false,
      "status": "inactive_0_percent_review_only",
      "regions": [
        "UK",
        "France",
        "Italy",
        "Switzerland",
        "Monaco"
      ],
      "signals": [
        {
          "id": "art_galleries-1",
          "group": "International programme",
          "signal": "International professional programme",
          "requiredEvidence": "Official gallery/fair/exhibition programme with countries and dates.",
          "admissibleSourceTypes": [
            "official company/organisation report, service or team page",
            "official management roster or event calendar",
            "client-attested professional requirement or remit"
          ],
          "evidenceRecordRequired": [
            "sourceURL_or_clientAttestationReference",
            "publisher",
            "publicationDate_if_available",
            "observedAt",
            "eventDate_or_fiscalPeriod_if_applicable",
            "claim",
            "reviewer"
          ],
          "freshnessRule": "Future event in next 60 days full timing weight; later announced event half timing weight; expired event zero. Recheck at enrolment.",
          "actualEvidenceCollected": false,
          "sourceStatus": "Operational check based on source group; proposed detailed evidence specification, pending Example Representative validation"
        },
        {
          "id": "art_galleries-2",
          "group": "Decision-maker role",
          "signal": "Current relevant decision role",
          "requiredEvidence": "Official gallery/organisation team page for director, owner, dealer or adviser.",
          "admissibleSourceTypes": [
            "official company/organisation report, service or team page",
            "official management roster or event calendar",
            "client-attested professional requirement or remit"
          ],
          "evidenceRecordRequired": [
            "sourceURL_or_clientAttestationReference",
            "publisher",
            "publicationDate_if_available",
            "observedAt",
            "eventDate_or_fiscalPeriod_if_applicable",
            "claim",
            "reviewer"
          ],
          "freshnessRule": "Recheck before use; proposed 90-day role refresh.",
          "actualEvidenceCollected": false,
          "sourceStatus": "Operational check based on source group; proposed detailed evidence specification, pending Example Representative validation"
        },
        {
          "id": "art_galleries-3",
          "group": "Dated travel trigger",
          "signal": "Dated travel trigger",
          "requiredEvidence": "Upcoming professional fair/client event and a credible client-attested itinerary; no assumption of attendance.",
          "admissibleSourceTypes": [
            "official company/organisation report, service or team page",
            "official management roster or event calendar",
            "client-attested professional requirement or remit"
          ],
          "evidenceRecordRequired": [
            "sourceURL_or_clientAttestationReference",
            "publisher",
            "publicationDate_if_available",
            "observedAt",
            "eventDate_or_fiscalPeriod_if_applicable",
            "claim",
            "reviewer"
          ],
          "freshnessRule": "Future event in next 60 days full timing weight; later announced event half timing weight; expired event zero. Recheck at enrolment.",
          "actualEvidenceCollected": false,
          "sourceStatus": "Operational check based on source group; proposed detailed evidence specification, pending Example Representative validation"
        },
        {
          "id": "art_galleries-4",
          "group": "Client service fit",
          "signal": "Relevant client-service need",
          "requiredEvidence": "Published advisory/service remit plus client-confirmed travel responsibility.",
          "admissibleSourceTypes": [
            "dated client/recipient confirmation within agreed scope"
          ],
          "evidenceRecordRequired": [
            "sourceURL_or_clientAttestationReference",
            "publisher",
            "publicationDate_if_available",
            "observedAt",
            "eventDate_or_fiscalPeriod_if_applicable",
            "claim",
            "reviewer"
          ],
          "freshnessRule": "Use current dated client attestation; recheck changes and eligibility immediately before enrolment.",
          "actualEvidenceCollected": false,
          "sourceStatus": "Operational check based on source group; proposed detailed evidence specification, pending Example Representative validation"
        },
        {
          "id": "art_galleries-5",
          "group": "Airport relevance",
          "signal": "Airport-to-event practicality",
          "requiredEvidence": "Official airport/handler and venue sources with checked ground transfer and caveats.",
          "admissibleSourceTypes": [
            "official company/organisation report, service or team page",
            "official management roster or event calendar",
            "client-attested professional requirement or remit"
          ],
          "evidenceRecordRequired": [
            "sourceURL_or_clientAttestationReference",
            "publisher",
            "publicationDate_if_available",
            "observedAt",
            "eventDate_or_fiscalPeriod_if_applicable",
            "claim",
            "reviewer"
          ],
          "freshnessRule": "Future event in next 60 days full timing weight; later announced event half timing weight; expired event zero. Recheck at enrolment.",
          "actualEvidenceCollected": false,
          "sourceStatus": "Operational check based on source group; proposed detailed evidence specification, pending Example Representative validation"
        }
      ],
      "falsePositivesAndExclusions": [
        "Inactive month-one lane: no sourcing/enrolment.",
        "Art shipping requirements confused with passenger travel.",
        "Fair listing treated as proof of a person attending."
      ],
      "aiExtractsFromPermittedProfessionalEvidence": [
        "Official programme and current role",
        "Event venue and airport candidates",
        "Professional service remit"
      ],
      "requiresHumanReview": [
        "Example Representative must activate lane separately",
        "Actual attendance/travel role",
        "No inferred collector wealth or private movements"
      ],
      "scoringFactors": [
        {
          "name": "International programme",
          "capPoints": 40,
          "sourceRule": "Evidence checklist: missing/partial/complete must be explained with source and date. Legacy40 cap is retained for source compatibility only; these factors add no points to v2.",
          "status": "source-proposed, not proven client-approved"
        },
        {
          "name": "Decision-maker role",
          "capPoints": 40,
          "sourceRule": "Evidence checklist: missing/partial/complete must be explained with source and date. Legacy40 cap is retained for source compatibility only; these factors add no points to v2.",
          "status": "source-proposed, not proven client-approved"
        },
        {
          "name": "Dated travel trigger",
          "capPoints": 40,
          "sourceRule": "Evidence checklist: missing/partial/complete must be explained with source and date. Legacy40 cap is retained for source compatibility only; these factors add no points to v2.",
          "status": "source-proposed, not proven client-approved"
        },
        {
          "name": "Client service fit",
          "capPoints": 40,
          "sourceRule": "Evidence checklist: missing/partial/complete must be explained with source and date. Legacy40 cap is retained for source compatibility only; these factors add no points to v2.",
          "status": "source-proposed, not proven client-approved"
        },
        {
          "name": "Airport relevance",
          "capPoints": 40,
          "sourceRule": "Evidence checklist: missing/partial/complete must be explained with source and date. Legacy40 cap is retained for source compatibility only; these factors add no points to v2.",
          "status": "source-proposed, not proven client-approved"
        }
      ],
      "sourceNumericWeights": "Profile evidence checklist only; no second weighted score. Role, source, contact and economic facts are filters, not bonus points.",
      "aviationMaturityAdjustment": {
        "sharedRuleReference": "aviationMaturityRules",
        "personaApplication": "Ask about the office/client/principal arrangements only within this role; never infer the contact personally owns an aircraft or card. For intermediaries, no principal details without permission."
      },
      "sequence": {
        "language": "en",
        "status": "parked_future_review_not_send_approved",
        "sendEnabled": false,
        "steps": [
          {
            "minimumCalendarDayOffset": 0,
            "subject": "Passenger travel around art events",
            "threadRule": "Same-thread continuation; never create a separate overlapping follow-up sequence.",
            "body": "{{greeting}}\n\nI saw your gallery's programme for {{artEventName}} on {{artEventDate}}.\n\nI'm Example Representative at Example Charter. We arrange private charter options around individual travel requirements.\n\nWe can review passenger travel for your team or invited clients around fairs, auctions and exhibitions. If you are planning a visit, would private flight options be useful?\n\nIf you prefer no further follow-up, just let me know.\n\nKind regards,\nExample Representative\nInsiJets"
          },
          {
            "minimumCalendarDayOffset": 7,
            "subject": "Re: Passenger travel around art events",
            "threadRule": "Same-thread continuation; never create a separate overlapping follow-up sequence.",
            "body": "{{greeting}}\n\nFor an art event, we can review the airport, onward journey and timing around appointments. Could we assess an outline passenger itinerary with your authorised travel coordinator?\n\nIf you prefer no further follow-up, just let me know.\n\nKind regards,\nExample Representative\nInsiJets"
          },
          {
            "minimumCalendarDayOffset": 17,
            "subject": "Re: Passenger travel around art events",
            "threadRule": "Same-thread continuation; never create a separate overlapping follow-up sequence.",
            "body": "{{greeting}}\n\nI'll leave this here. If your team or invited clients need passenger flight options for a future fair, auction or exhibition, you can contact me. If you prefer no further follow-up, just let me know.\n\nKind regards,\nExample Representative\nInsiJets"
          }
        ],
        "eligibilityRequirement": "Parked at 0% in month one; verified relevant future fair/auction/exhibition and travel role; passenger travel only."
      },
      "sourceRefs": [
        "ICP_CURRENT_BODY",
        "ICP_MEETING_COMMENTS",
        "WORKING_MIX",
        "EVIDENCE_PLAN",
        "CAMPAIGN_DEMOS"
      ],
      "refinementNote": "The five source group labels and fit statement are preserved; detailed evidence checks and finished persona-specific copy are proposed editorial refinements for validation."
    },
    {
      "id": "yachting",
      "name": "Yachting",
      "sourceFitStatement": "Yacht managers, charter advisers and owner-representative offices.",
      "fitAndDecisionRole": "Yacht manager, charter adviser or owner-representative office; inactive 0% month one and review-only copy.",
      "sharePercent": 0,
      "monthOneEnabled": false,
      "status": "inactive_0_percent_review_only",
      "regions": [
        "Monaco",
        "France",
        "Italy",
        "Spain",
        "Greece"
      ],
      "signals": [
        {
          "id": "yachting-1",
          "group": "Owner-service remit",
          "signal": "Owner/guest-service remit",
          "requiredEvidence": "Official management/charter advisory service and current professional role.",
          "admissibleSourceTypes": [
            "official company/organisation report, service or team page",
            "official management roster or event calendar",
            "client-attested professional requirement or remit"
          ],
          "evidenceRecordRequired": [
            "sourceURL_or_clientAttestationReference",
            "publisher",
            "publicationDate_if_available",
            "observedAt",
            "eventDate_or_fiscalPeriod_if_applicable",
            "claim",
            "reviewer"
          ],
          "freshnessRule": "Recheck before use; proposed 90-day role refresh.",
          "actualEvidenceCollected": false,
          "sourceStatus": "Operational check based on source group; proposed detailed evidence specification, pending Example Representative validation"
        },
        {
          "id": "yachting-2",
          "group": "Regional itinerary",
          "signal": "Professional regional itinerary",
          "requiredEvidence": "Official marina/homeport or Mediterranean service geography; no private vessel tracking.",
          "admissibleSourceTypes": [
            "official company/organisation report, service or team page",
            "official management roster or event calendar",
            "client-attested professional requirement or remit"
          ],
          "evidenceRecordRequired": [
            "sourceURL_or_clientAttestationReference",
            "publisher",
            "publicationDate_if_available",
            "observedAt",
            "eventDate_or_fiscalPeriod_if_applicable",
            "claim",
            "reviewer"
          ],
          "freshnessRule": "Recheck before use; proposed 90-day role refresh.",
          "actualEvidenceCollected": false,
          "sourceStatus": "Operational check based on source group; proposed detailed evidence specification, pending Example Representative validation"
        },
        {
          "id": "yachting-3",
          "group": "Dated movement",
          "signal": "Dated professional movement",
          "requiredEvidence": "Published boat show/charter start or client-attested guest trip; no unconfirmed personal attendance.",
          "admissibleSourceTypes": [
            "official company/organisation report, service or team page",
            "official management roster or event calendar",
            "client-attested professional requirement or remit"
          ],
          "evidenceRecordRequired": [
            "sourceURL_or_clientAttestationReference",
            "publisher",
            "publicationDate_if_available",
            "observedAt",
            "eventDate_or_fiscalPeriod_if_applicable",
            "claim",
            "reviewer"
          ],
          "freshnessRule": "Future event in next 60 days full timing weight; later announced event half timing weight; expired event zero. Recheck at enrolment.",
          "actualEvidenceCollected": false,
          "sourceStatus": "Operational check based on source group; proposed detailed evidence specification, pending Example Representative validation"
        },
        {
          "id": "yachting-4",
          "group": "Coordination authority",
          "signal": "Coordination authority",
          "requiredEvidence": "Official role or client confirmation of air/ground/guest logistics remit.",
          "admissibleSourceTypes": [
            "official company/organisation report, service or team page",
            "official management roster or event calendar",
            "client-attested professional requirement or remit"
          ],
          "evidenceRecordRequired": [
            "sourceURL_or_clientAttestationReference",
            "publisher",
            "publicationDate_if_available",
            "observedAt",
            "eventDate_or_fiscalPeriod_if_applicable",
            "claim",
            "reviewer"
          ],
          "freshnessRule": "Recheck before use; proposed 90-day role refresh.",
          "actualEvidenceCollected": false,
          "sourceStatus": "Operational check based on source group; proposed detailed evidence specification, pending Example Representative validation"
        },
        {
          "id": "yachting-5",
          "group": "Ground/air connection",
          "signal": "Ground/air connection",
          "requiredEvidence": "Official airport/handler/marina sources and checked ground transfer for an actual itinerary.",
          "admissibleSourceTypes": [
            "official company/organisation report, service or team page",
            "official management roster or event calendar",
            "client-attested professional requirement or remit"
          ],
          "evidenceRecordRequired": [
            "sourceURL_or_clientAttestationReference",
            "publisher",
            "publicationDate_if_available",
            "observedAt",
            "eventDate_or_fiscalPeriod_if_applicable",
            "claim",
            "reviewer"
          ],
          "freshnessRule": "Future event in next 60 days full timing weight; later announced event half timing weight; expired event zero. Recheck at enrolment.",
          "actualEvidenceCollected": false,
          "sourceStatus": "Operational check based on source group; proposed detailed evidence specification, pending Example Representative validation"
        }
      ],
      "falsePositivesAndExclusions": [
        "Inactive month-one lane: no sourcing/enrolment.",
        "AIS/private vessel movement used to infer owner whereabouts.",
        "Public yacht listing treated as personal ownership or travel intent."
      ],
      "aiExtractsFromPermittedProfessionalEvidence": [
        "Published professional service remit and operating geography",
        "Official event dates",
        "Airport/marina connection candidates"
      ],
      "requiresHumanReview": [
        "Example Representative must activate lane separately",
        "Actual guest requirements and authorised contact",
        "No disclosure of private itinerary without permission"
      ],
      "scoringFactors": [
        {
          "name": "Owner-service remit",
          "capPoints": 40,
          "sourceRule": "Evidence checklist: missing/partial/complete must be explained with source and date. Legacy40 cap is retained for source compatibility only; these factors add no points to v2.",
          "status": "source-proposed, not proven client-approved"
        },
        {
          "name": "Regional itinerary",
          "capPoints": 40,
          "sourceRule": "Evidence checklist: missing/partial/complete must be explained with source and date. Legacy40 cap is retained for source compatibility only; these factors add no points to v2.",
          "status": "source-proposed, not proven client-approved"
        },
        {
          "name": "Dated movement",
          "capPoints": 40,
          "sourceRule": "Evidence checklist: missing/partial/complete must be explained with source and date. Legacy40 cap is retained for source compatibility only; these factors add no points to v2.",
          "status": "source-proposed, not proven client-approved"
        },
        {
          "name": "Coordination authority",
          "capPoints": 40,
          "sourceRule": "Evidence checklist: missing/partial/complete must be explained with source and date. Legacy40 cap is retained for source compatibility only; these factors add no points to v2.",
          "status": "source-proposed, not proven client-approved"
        },
        {
          "name": "Ground/air connection",
          "capPoints": 40,
          "sourceRule": "Evidence checklist: missing/partial/complete must be explained with source and date. Legacy40 cap is retained for source compatibility only; these factors add no points to v2.",
          "status": "source-proposed, not proven client-approved"
        }
      ],
      "sourceNumericWeights": "Profile evidence checklist only; no second weighted score. Role, source, contact and economic facts are filters, not bonus points.",
      "aviationMaturityAdjustment": {
        "sharedRuleReference": "aviationMaturityRules",
        "personaApplication": "Ask about the office/client/principal arrangements only within this role; never infer the contact personally owns an aircraft or card. For intermediaries, no principal details without permission."
      },
      "sequence": {
        "language": "en",
        "status": "parked_future_review_not_send_approved",
        "sendEnabled": false,
        "steps": [
          {
            "minimumCalendarDayOffset": 0,
            "subject": "Guest flights and marina transfers",
            "threadRule": "Same-thread continuation; never create a separate overlapping follow-up sequence.",
            "body": "{{greeting}}\n\nI saw your team handles {{guestServiceName}}. I'm Example Representative at Example Charter. We arrange private charter options around individual travel requirements. We can review private flight options for guest arrivals and departures, taking the onward marina transfer into account.\n\nWould it help to assess a flight around a confirmed embarkation time with your guest coordinator?\n\nIf you prefer no further follow-up, just let me know.\n\nKind regards,\nExample Representative\nInsiJets"
          },
          {
            "minimumCalendarDayOffset": 7,
            "subject": "Re: Guest flights and marina transfers",
            "threadRule": "Same-thread continuation; never create a separate overlapping follow-up sequence.",
            "body": "{{greeting}}\n\nFor an embarkation or disembarkation, we can review flight timing against the confirmed marina transfer. Could your coordinator share an outline route, guest count and required arrival time?\n\nIf you prefer no further follow-up, just let me know.\n\nKind regards,\nExample Representative\nInsiJets"
          },
          {
            "minimumCalendarDayOffset": 17,
            "subject": "Re: Guest flights and marina transfers",
            "threadRule": "Same-thread continuation; never create a separate overlapping follow-up sequence.",
            "body": "{{greeting}}\n\nI'll leave this with you. If a guest arrival or departure needs private flight options, feel free to send the outline. If you prefer no further follow-up, just let me know.\n\nKind regards,\nExample Representative\nInsiJets"
          }
        ],
        "eligibilityRequirement": "Parked at 0% in month one; future Example Representative review required; verify guest logistics responsibility; use only authorised itinerary details."
      },
      "sourceRefs": [
        "ICP_CURRENT_BODY",
        "ICP_MEETING_COMMENTS",
        "WORKING_MIX",
        "EVIDENCE_PLAN",
        "CAMPAIGN_DEMOS"
      ],
      "refinementNote": "The five source group labels and fit statement are preserved; detailed evidence checks and finished persona-specific copy are proposed editorial refinements for validation."
    },
    {
      "id": "luxury_travel",
      "name": "Luxury travel",
      "sourceFitStatement": "Concierge and specialist travel advisers serving recurring private-travel needs.",
      "fitAndDecisionRole": "Professional concierge or bespoke travel adviser with actual flight coordination or a permitted partnership route.",
      "sharePercent": 3,
      "monthOneEnabled": true,
      "status": "proposed_for_client_validation_not_activated",
      "regions": [
        "UK",
        "Switzerland",
        "France",
        "Italy",
        "Spain"
      ],
      "signals": [
        {
          "id": "luxury_travel-1",
          "group": "Private travel clientele",
          "signal": "Published bespoke travel proposition",
          "requiredEvidence": "Official high-end bespoke/concierge offering; no assumed individual client wealth.",
          "admissibleSourceTypes": [
            "official company/organisation report, service or team page",
            "official management roster or event calendar",
            "client-attested professional requirement or remit"
          ],
          "evidenceRecordRequired": [
            "sourceURL_or_clientAttestationReference",
            "publisher",
            "publicationDate_if_available",
            "observedAt",
            "eventDate_or_fiscalPeriod_if_applicable",
            "claim",
            "reviewer"
          ],
          "freshnessRule": "Recheck before use; proposed 90-day role refresh.",
          "actualEvidenceCollected": false,
          "sourceStatus": "Operational check based on source group; proposed detailed evidence specification, pending Example Representative validation"
        },
        {
          "id": "luxury_travel-2",
          "group": "Flight coordination",
          "signal": "Flight coordination remit",
          "requiredEvidence": "Published aviation/travel logistics service or client-confirmed professional role.",
          "admissibleSourceTypes": [
            "official company/organisation report, service or team page",
            "official management roster or event calendar",
            "client-attested professional requirement or remit"
          ],
          "evidenceRecordRequired": [
            "sourceURL_or_clientAttestationReference",
            "publisher",
            "publicationDate_if_available",
            "observedAt",
            "eventDate_or_fiscalPeriod_if_applicable",
            "claim",
            "reviewer"
          ],
          "freshnessRule": "Recheck before use; proposed 90-day role refresh.",
          "actualEvidenceCollected": false,
          "sourceStatus": "Operational check based on source group; proposed detailed evidence specification, pending Example Representative validation"
        },
        {
          "id": "luxury_travel-3",
          "group": "Trip complexity",
          "signal": "Specific complex trip",
          "requiredEvidence": "Client-attested multi-stop/remote-resort/time-sensitive itinerary, not an invented guest trip.",
          "admissibleSourceTypes": [
            "dated client/recipient confirmation within agreed scope"
          ],
          "evidenceRecordRequired": [
            "sourceURL_or_clientAttestationReference",
            "publisher",
            "publicationDate_if_available",
            "observedAt",
            "eventDate_or_fiscalPeriod_if_applicable",
            "claim",
            "reviewer"
          ],
          "freshnessRule": "Use current dated client attestation; recheck changes and eligibility immediately before enrolment.",
          "actualEvidenceCollected": false,
          "sourceStatus": "Operational check based on source group; proposed detailed evidence specification, pending Example Representative validation"
        },
        {
          "id": "luxury_travel-4",
          "group": "Partnership fit",
          "signal": "Permitted partnership fit",
          "requiredEvidence": "Official partner process or recipient confirmation of an appropriate service introduction.",
          "admissibleSourceTypes": [
            "dated client/recipient confirmation within agreed scope"
          ],
          "evidenceRecordRequired": [
            "sourceURL_or_clientAttestationReference",
            "publisher",
            "publicationDate_if_available",
            "observedAt",
            "eventDate_or_fiscalPeriod_if_applicable",
            "claim",
            "reviewer"
          ],
          "freshnessRule": "Use current dated client attestation; recheck changes and eligibility immediately before enrolment.",
          "actualEvidenceCollected": false,
          "sourceStatus": "Operational check based on source group; proposed detailed evidence specification, pending Example Representative validation"
        },
        {
          "id": "luxury_travel-5",
          "group": "Professional channel",
          "signal": "Professional contact channel",
          "requiredEvidence": "Current official agency contact and independent verification when email lookup is authorised.",
          "admissibleSourceTypes": [
            "official professional channel, current role source, independent verification when authorised"
          ],
          "evidenceRecordRequired": [
            "sourceURL_or_clientAttestationReference",
            "publisher",
            "publicationDate_if_available",
            "observedAt",
            "eventDate_or_fiscalPeriod_if_applicable",
            "claim",
            "reviewer"
          ],
          "freshnessRule": "Recheck before use; proposed 90-day role/contact refresh; unknown/catch-all/risky held.",
          "actualEvidenceCollected": false,
          "sourceStatus": "Operational check based on source group; proposed detailed evidence specification, pending Example Representative validation"
        }
      ],
      "falsePositivesAndExclusions": [
        "General travel list without charter relevance.",
        "Unapproved client disclosures/referral promises.",
        "Same principal already approached through another intermediary."
      ],
      "aiExtractsFromPermittedProfessionalEvidence": [
        "Published service scope and professional role",
        "Official agency channel",
        "Professionally documented relevant itinerary"
      ],
      "requiresHumanReview": [
        "Client permission and actual trip",
        "Partnership/fee terms separately agreed",
        "Principal/assistant/adviser account collision"
      ],
      "scoringFactors": [
        {
          "name": "Private travel clientele",
          "capPoints": 40,
          "sourceRule": "Evidence checklist: missing/partial/complete must be explained with source and date. Legacy40 cap is retained for source compatibility only; these factors add no points to v2.",
          "status": "source-proposed, not proven client-approved"
        },
        {
          "name": "Flight coordination",
          "capPoints": 40,
          "sourceRule": "Evidence checklist: missing/partial/complete must be explained with source and date. Legacy40 cap is retained for source compatibility only; these factors add no points to v2.",
          "status": "source-proposed, not proven client-approved"
        },
        {
          "name": "Trip complexity",
          "capPoints": 40,
          "sourceRule": "Evidence checklist: missing/partial/complete must be explained with source and date. Legacy40 cap is retained for source compatibility only; these factors add no points to v2.",
          "status": "source-proposed, not proven client-approved"
        },
        {
          "name": "Partnership fit",
          "capPoints": 40,
          "sourceRule": "Evidence checklist: missing/partial/complete must be explained with source and date. Legacy40 cap is retained for source compatibility only; these factors add no points to v2.",
          "status": "source-proposed, not proven client-approved"
        },
        {
          "name": "Professional channel",
          "capPoints": 40,
          "sourceRule": "Evidence checklist: missing/partial/complete must be explained with source and date. Legacy40 cap is retained for source compatibility only; these factors add no points to v2.",
          "status": "source-proposed, not proven client-approved"
        }
      ],
      "sourceNumericWeights": "Profile evidence checklist only; no second weighted score. Role, source, contact and economic facts are filters, not bonus points.",
      "aviationMaturityAdjustment": {
        "sharedRuleReference": "aviationMaturityRules",
        "personaApplication": "Ask about the office/client/principal arrangements only within this role; never infer the contact personally owns an aircraft or card. For intermediaries, no principal details without permission."
      },
      "sequence": {
        "language": "en",
        "status": "revised_from_Luca_feedback_draft_not_send_approved",
        "sendEnabled": false,
        "steps": [
          {
            "minimumCalendarDayOffset": 0,
            "subject": "An aviation contact for your client itineraries",
            "threadRule": "Same-thread continuation; never create a separate overlapping follow-up sequence.",
            "body": "{{greeting}}\n\nI noticed your team offers {{bespokeTravelService}}.\n\nI'm Example Representative at Example Charter. We arrange private charter options around individual travel requirements.\n\nWould an additional aviation contact be useful for your charter enquiries? May I share a presentation about our services and aircraft network?\n\nIf you prefer no further follow-up, just let me know.\n\nKind regards,\nExample Representative\nInsiJets"
          },
          {
            "minimumCalendarDayOffset": 7,
            "subject": "Re: An aviation contact for your client itineraries",
            "threadRule": "Same-thread continuation; never create a separate overlapping follow-up sequence.",
            "body": "{{greeting}}\n\nFor a resort or multi-stop itinerary, we can review flight timing alongside the onward journey. Could your team share an outline brief, without client details, to assess the aviation requirements?\n\nIf you prefer no further follow-up, just let me know.\n\nKind regards,\nExample Representative\nInsiJets"
          },
          {
            "minimumCalendarDayOffset": 17,
            "subject": "Re: An aviation contact for your client itineraries",
            "threadRule": "Same-thread continuation; never create a separate overlapping follow-up sequence.",
            "body": "{{greeting}}\n\nI'll leave this with your team. When a client itinerary calls for a private flight, feel free to get in touch. If you prefer no further follow-up, just let me know.\n\nKind regards,\nExample Representative\nInsiJets"
          }
        ],
        "eligibilityRequirement": "Bespoke service and recipient aviation coordination remit verified; no sharing private client data."
      },
      "sourceRefs": [
        "ICP_CURRENT_BODY",
        "ICP_MEETING_COMMENTS",
        "WORKING_MIX",
        "EVIDENCE_PLAN",
        "CAMPAIGN_DEMOS"
      ],
      "refinementNote": "The five source group labels and fit statement are preserved; detailed evidence checks and finished persona-specific copy are proposed editorial refinements for validation."
    },
    {
      "id": "politicians",
      "name": "Politicians",
      "sourceFitStatement": "Separate research stream; any campaign requires Example Representative’s decision.",
      "fitAndDecisionRole": "Official professional office/administrative travel remit only; inactive 0%, separate Example Representative decision and protocol review.",
      "sharePercent": 0,
      "monthOneEnabled": false,
      "status": "inactive_0_percent_review_only",
      "regions": [
        "Europe-public-office-only"
      ],
      "signals": [
        {
          "id": "politicians-1",
          "group": "Office contact availability",
          "signal": "Official office channel",
          "requiredEvidence": "Current official parliamentary/government/office contact page; no personal contacts inferred.",
          "admissibleSourceTypes": [
            "official professional channel, current role source, independent verification when authorised"
          ],
          "evidenceRecordRequired": [
            "sourceURL_or_clientAttestationReference",
            "publisher",
            "publicationDate_if_available",
            "observedAt",
            "eventDate_or_fiscalPeriod_if_applicable",
            "claim",
            "reviewer"
          ],
          "freshnessRule": "Recheck before use; proposed 90-day role/contact refresh; unknown/catch-all/risky held.",
          "actualEvidenceCollected": false,
          "sourceStatus": "Operational check based on source group; proposed detailed evidence specification, pending Example Representative validation"
        },
        {
          "id": "politicians-2",
          "group": "Professional relevance",
          "signal": "Legitimate professional travel relevance",
          "requiredEvidence": "Official professional event/remit or client-attested office travel need; no campaigning or political profiling.",
          "admissibleSourceTypes": [
            "official company/organisation report, service or team page",
            "official management roster or event calendar",
            "client-attested professional requirement or remit"
          ],
          "evidenceRecordRequired": [
            "sourceURL_or_clientAttestationReference",
            "publisher",
            "publicationDate_if_available",
            "observedAt",
            "eventDate_or_fiscalPeriod_if_applicable",
            "claim",
            "reviewer"
          ],
          "freshnessRule": "Future event in next 60 days full timing weight; later announced event half timing weight; expired event zero. Recheck at enrolment.",
          "actualEvidenceCollected": false,
          "sourceStatus": "Operational check based on source group; proposed detailed evidence specification, pending Example Representative validation"
        },
        {
          "id": "politicians-3",
          "group": "Office remit",
          "signal": "Office travel responsibility",
          "requiredEvidence": "Named administrative/office role confirmed through official source or office confirmation.",
          "admissibleSourceTypes": [
            "official company/organisation report, service or team page",
            "official management roster or event calendar",
            "client-attested professional requirement or remit"
          ],
          "evidenceRecordRequired": [
            "sourceURL_or_clientAttestationReference",
            "publisher",
            "publicationDate_if_available",
            "observedAt",
            "eventDate_or_fiscalPeriod_if_applicable",
            "claim",
            "reviewer"
          ],
          "freshnessRule": "Recheck before use; proposed 90-day role refresh.",
          "actualEvidenceCollected": false,
          "sourceStatus": "Operational check based on source group; proposed detailed evidence specification, pending Example Representative validation"
        },
        {
          "id": "politicians-4",
          "group": "Timing and protocol",
          "signal": "Protocol and timing",
          "requiredEvidence": "Official professional dates and reviewed procurement/contact protocol; no political-affiliation inference.",
          "admissibleSourceTypes": [
            "official company/organisation report, service or team page",
            "official management roster or event calendar",
            "client-attested professional requirement or remit"
          ],
          "evidenceRecordRequired": [
            "sourceURL_or_clientAttestationReference",
            "publisher",
            "publicationDate_if_available",
            "observedAt",
            "eventDate_or_fiscalPeriod_if_applicable",
            "claim",
            "reviewer"
          ],
          "freshnessRule": "Future event in next 60 days full timing weight; later announced event half timing weight; expired event zero. Recheck at enrolment.",
          "actualEvidenceCollected": false,
          "sourceStatus": "Operational check based on source group; proposed detailed evidence specification, pending Example Representative validation"
        },
        {
          "id": "politicians-5",
          "group": "Client approval",
          "signal": "Explicit client decision",
          "requiredEvidence": "Example Representative written approval of this separate lane, professional purpose and channel before any research/enrolment.",
          "admissibleSourceTypes": [
            "dated client/recipient confirmation within agreed scope"
          ],
          "evidenceRecordRequired": [
            "sourceURL_or_clientAttestationReference",
            "publisher",
            "publicationDate_if_available",
            "observedAt",
            "eventDate_or_fiscalPeriod_if_applicable",
            "claim",
            "reviewer"
          ],
          "freshnessRule": "Use current dated client attestation; recheck changes and eligibility immediately before enrolment.",
          "actualEvidenceCollected": false,
          "sourceStatus": "Operational check based on source group; proposed detailed evidence specification, pending Example Representative validation"
        }
      ],
      "falsePositivesAndExclusions": [
        "Inactive 0% lane: no sourcing/enrolment.",
        "Political beliefs, party affinity or persuasion inferred or used.",
        "Personal contact, private travel or public-office influence assumptions."
      ],
      "aiExtractsFromPermittedProfessionalEvidence": [
        "Official professional office remit/channel only",
        "Official public event dates",
        "Source/protocol evidence"
      ],
      "requiresHumanReview": [
        "Example Representative separate activation and public-office protocol",
        "Professional travel remit and procurement rules",
        "No political persuasion or belief-based scoring"
      ],
      "scoringFactors": [
        {
          "name": "Office contact availability",
          "capPoints": 40,
          "sourceRule": "Evidence checklist: missing/partial/complete must be explained with source and date. Legacy40 cap is retained for source compatibility only; these factors add no points to v2.",
          "status": "source-proposed, not proven client-approved"
        },
        {
          "name": "Professional relevance",
          "capPoints": 40,
          "sourceRule": "Evidence checklist: missing/partial/complete must be explained with source and date. Legacy40 cap is retained for source compatibility only; these factors add no points to v2.",
          "status": "source-proposed, not proven client-approved"
        },
        {
          "name": "Office remit",
          "capPoints": 40,
          "sourceRule": "Evidence checklist: missing/partial/complete must be explained with source and date. Legacy40 cap is retained for source compatibility only; these factors add no points to v2.",
          "status": "source-proposed, not proven client-approved"
        },
        {
          "name": "Timing and protocol",
          "capPoints": 40,
          "sourceRule": "Evidence checklist: missing/partial/complete must be explained with source and date. Legacy40 cap is retained for source compatibility only; these factors add no points to v2.",
          "status": "source-proposed, not proven client-approved"
        },
        {
          "name": "Client approval",
          "capPoints": 40,
          "sourceRule": "Evidence checklist: missing/partial/complete must be explained with source and date. Legacy40 cap is retained for source compatibility only; these factors add no points to v2.",
          "status": "source-proposed, not proven client-approved"
        }
      ],
      "sourceNumericWeights": "Profile evidence checklist only; no second weighted score. Role, source, contact and economic facts are filters, not bonus points.",
      "aviationMaturityAdjustment": {
        "sharedRuleReference": "aviationMaturityRules",
        "personaApplication": "Use neutral unknown-maturity copy until the recipient/client confirms the actual travel arrangement. Never infer ownership or card use from scale, status or fame."
      },
      "sequence": {
        "language": "en",
        "status": "parked_future_review_not_send_approved",
        "sendEnabled": false,
        "steps": [
          {
            "minimumCalendarDayOffset": 0,
            "subject": "Official travel enquiries",
            "threadRule": "Same-thread continuation; never create a separate overlapping follow-up sequence.",
            "body": "{{greeting}}\n\nI'm Example Representative at Example Charter. We can review charter options for authorised professional travel, following your procurement procedures.\n\nCould you direct me to the person responsible for official travel enquiries?\n\nIf you prefer no further follow-up, just let me know.\n\nKind regards,\nExample Representative\nInsiJets"
          },
          {
            "minimumCalendarDayOffset": 7,
            "subject": "Re: Official travel enquiries",
            "threadRule": "Same-thread continuation; never create a separate overlapping follow-up sequence.",
            "body": "{{greeting}}\n\nAny assessment would follow your office's procurement and approval process. Could the responsible administrator confirm the appropriate channel for a charter enquiry?\n\nIf you prefer no further follow-up, just let me know.\n\nKind regards,\nExample Representative\nInsiJets"
          },
          {
            "minimumCalendarDayOffset": 17,
            "subject": "Re: Official travel enquiries",
            "threadRule": "Same-thread continuation; never create a separate overlapping follow-up sequence.",
            "body": "{{greeting}}\n\nI'll close this enquiry for now. If an authorised professional travel requirement arises, your travel administrator is welcome to contact me through this channel. If you prefer no further follow-up, just let me know.\n\nKind regards,\nExample Representative\nInsiJets"
          }
        ],
        "eligibilityRequirement": "Parked at 0% in month one; separate future review and procurement approval; official professional travel only."
      },
      "sourceRefs": [
        "ICP_CURRENT_BODY",
        "ICP_MEETING_COMMENTS",
        "WORKING_MIX",
        "EVIDENCE_PLAN",
        "CAMPAIGN_DEMOS"
      ],
      "refinementNote": "The five source group labels and fit statement are preserved; detailed evidence checks and finished persona-specific copy are proposed editorial refinements for validation."
    },
    {
      "id": "pet_relocation",
      "name": "Pet relocation partners",
      "sourceFitStatement": "Pet relocation companies with a legitimate passenger-and-pet flight coordination or permitted referral role.",
      "fitAndDecisionRole": "Professional partnerships or relocation coordinator; Europe and UAE (Dubai/Abu Dhabi) covered in research design, with geographic allocation and economic applicability awaiting Example Representative confirmation.",
      "sharePercent": 0,
      "monthOneEnabled": false,
      "status": "new_partner_profile_pending_geography_and_client_validation",
      "regions": [
        "Europe",
        "UAE",
        "Dubai",
        "Abu Dhabi"
      ],
      "signals": [
        {
          "id": "pet_relocation-1",
          "group": "Service geography",
          "signal": "Service geography",
          "requiredEvidence": "Official service pages identify current countries/cities served; include UAE, Dubai and Abu Dhabi without claiming all are approved for month one.",
          "admissibleSourceTypes": [
            "official company/organisation report, service or team page",
            "official management roster or event calendar",
            "client-attested professional requirement or remit"
          ],
          "evidenceRecordRequired": [
            "sourceURL_or_clientAttestationReference",
            "publisher",
            "publicationDate_if_available",
            "observedAt",
            "eventDate_or_fiscalPeriod_if_applicable",
            "claim",
            "reviewer"
          ],
          "freshnessRule": "Recheck before use; proposed 90-day role refresh.",
          "actualEvidenceCollected": false,
          "sourceStatus": "New proposed check based on Example Representative pet partner request; not client-approved"
        },
        {
          "id": "pet_relocation-2",
          "group": "Partnership authority",
          "signal": "Partnership authority",
          "requiredEvidence": "Official partnership role or dated company confirmation of permission for introductions; no fees or client details assumed.",
          "admissibleSourceTypes": [
            "official company/organisation report, service or team page",
            "official management roster or event calendar",
            "client-attested professional requirement or remit"
          ],
          "evidenceRecordRequired": [
            "sourceURL_or_clientAttestationReference",
            "publisher",
            "publicationDate_if_available",
            "observedAt",
            "eventDate_or_fiscalPeriod_if_applicable",
            "claim",
            "reviewer"
          ],
          "freshnessRule": "Recheck before use; proposed 90-day role refresh.",
          "actualEvidenceCollected": false,
          "sourceStatus": "New proposed check based on Example Representative pet partner request; not client-approved"
        },
        {
          "id": "pet_relocation-3",
          "group": "Passenger and pet need",
          "signal": "Passenger and pet need",
          "requiredEvidence": "Client-confirmed passenger/pet requirement; pet shipping alone does not prove a passenger charter need.",
          "admissibleSourceTypes": [
            "dated client/recipient confirmation within agreed scope"
          ],
          "evidenceRecordRequired": [
            "sourceURL_or_clientAttestationReference",
            "publisher",
            "publicationDate_if_available",
            "observedAt",
            "eventDate_or_fiscalPeriod_if_applicable",
            "claim",
            "reviewer"
          ],
          "freshnessRule": "Use current dated client attestation; recheck changes and eligibility immediately before enrolment.",
          "actualEvidenceCollected": false,
          "sourceStatus": "New proposed check based on Example Representative pet partner request; not client-approved"
        },
        {
          "id": "pet_relocation-4",
          "group": "Operational constraints",
          "signal": "Operational constraints",
          "requiredEvidence": "Trip-specific aircraft pet acceptance, documents, entry rules, airports and handler checks; no acceptance guarantee.",
          "admissibleSourceTypes": [
            "dated client/recipient confirmation within agreed scope"
          ],
          "evidenceRecordRequired": [
            "sourceURL_or_clientAttestationReference",
            "publisher",
            "publicationDate_if_available",
            "observedAt",
            "eventDate_or_fiscalPeriod_if_applicable",
            "claim",
            "reviewer"
          ],
          "freshnessRule": "Use current dated client attestation; recheck changes and eligibility immediately before enrolment.",
          "actualEvidenceCollected": false,
          "sourceStatus": "New proposed check based on Example Representative pet partner request; not client-approved"
        },
        {
          "id": "pet_relocation-5",
          "group": "Professional contact",
          "signal": "Professional contact",
          "requiredEvidence": "Confirmed professional role plus independently valid email and current client suppression/account coordination; unknown holds.",
          "admissibleSourceTypes": [
            "official professional channel, current role source, independent verification when authorised"
          ],
          "evidenceRecordRequired": [
            "sourceURL_or_clientAttestationReference",
            "publisher",
            "publicationDate_if_available",
            "observedAt",
            "eventDate_or_fiscalPeriod_if_applicable",
            "claim",
            "reviewer"
          ],
          "freshnessRule": "Recheck before use; proposed 90-day role/contact refresh; unknown/catch-all/risky held.",
          "actualEvidenceCollected": false,
          "sourceStatus": "New proposed check based on Example Representative pet partner request; not client-approved"
        }
      ],
      "falsePositivesAndExclusions": [
        "Pet transport without a relevant passenger/private-flight coordination need",
        "Unapproved UAE geographic allocation",
        "Unknown partnership authority, economic applicability or customer suppression",
        "No disclosure of private client/pet health details"
      ],
      "aiExtractsFromPermittedProfessionalEvidence": [
        "Published service scope and professional role",
        "Official agency channel",
        "Professionally documented relevant itinerary"
      ],
      "requiresHumanReview": [
        "Client permission and actual trip",
        "Partnership/fee terms separately agreed",
        "Principal/assistant/adviser account collision"
      ],
      "scoringFactors": [
        {
          "name": "Service geography",
          "capPoints": 40,
          "sourceRule": "Evidence checklist: missing/partial/complete must be explained with source and date. Legacy40 cap is retained for source compatibility only; these factors add no points to v2.",
          "status": "source-proposed, not proven client-approved"
        },
        {
          "name": "Partnership authority",
          "capPoints": 40,
          "sourceRule": "Evidence checklist: missing/partial/complete must be explained with source and date. Legacy40 cap is retained for source compatibility only; these factors add no points to v2.",
          "status": "source-proposed, not proven client-approved"
        },
        {
          "name": "Passenger and pet need",
          "capPoints": 40,
          "sourceRule": "Evidence checklist: missing/partial/complete must be explained with source and date. Legacy40 cap is retained for source compatibility only; these factors add no points to v2.",
          "status": "source-proposed, not proven client-approved"
        },
        {
          "name": "Operational constraints",
          "capPoints": 40,
          "sourceRule": "Evidence checklist: missing/partial/complete must be explained with source and date. Legacy40 cap is retained for source compatibility only; these factors add no points to v2.",
          "status": "source-proposed, not proven client-approved"
        },
        {
          "name": "Professional contact",
          "capPoints": 40,
          "sourceRule": "Evidence checklist: missing/partial/complete must be explained with source and date. Legacy40 cap is retained for source compatibility only; these factors add no points to v2.",
          "status": "source-proposed, not proven client-approved"
        }
      ],
      "sourceNumericWeights": "Profile evidence checklist only; no second weighted score. Role, source, contact and economic facts are filters, not bonus points.",
      "aviationMaturityAdjustment": {
        "sharedRuleReference": "aviationMaturityRules",
        "personaApplication": "Ask about the office/client/principal arrangements only within this role; never infer the contact personally owns an aircraft or card. For intermediaries, no principal details without permission."
      },
      "sequence": {
        "language": "en",
        "status": "new_partner_copy_for_review_not_approved",
        "sendEnabled": false,
        "eligibilityRequirement": "New proposal for Example Representative review; verified pet relocation service and partner remit; Europe default, UAE/Dubai/Abu Dhabi research explicitly segregated pending geographic allocation decision.",
        "steps": [
          {
            "minimumCalendarDayOffset": 0,
            "subject": "Private flight coordination for pet relocations",
            "threadRule": "Same-thread continuation; no overlapping sequence.",
            "body": "{{greeting}}\n\nI saw that {{companyName}} provides {{verifiedPetRelocationService}} in {{verifiedServiceLocation}}.\n\nI'm Example Representative at Example Charter. We arrange private charter options around individual travel requirements.\n\nWhen a relocation involves a family travelling with a pet, would an additional aviation contact be useful? We would be happy to explain how we assess flight options alongside the relocation team's requirements.\n\nIf you prefer no further follow-up, just let me know.\n\nKind regards,\nExample Representative\nInsiJets"
          },
          {
            "minimumCalendarDayOffset": 7,
            "subject": "Re: Private flight coordination for pet relocations",
            "threadRule": "Same-thread continuation; no overlapping sequence.",
            "body": "{{greeting}}\n\nAn initial discussion could cover the route, travelling party and pet requirements without client details. Would you be the right person to discuss how a permitted referral would work?\n\nIf you prefer no further follow-up, just let me know.\n\nKind regards,\nExample Representative\nInsiJets"
          },
          {
            "minimumCalendarDayOffset": 17,
            "subject": "Re: Private flight coordination for pet relocations",
            "threadRule": "Same-thread continuation; no overlapping sequence.",
            "body": "{{greeting}}\n\nI'll leave this here for now. If an appropriate relocation enquiry needs private flight options, feel free to contact me. Pet acceptance, documentation and entry requirements would be checked for the specific trip. If you prefer no further follow-up, just let me know.\n\nKind regards,\nExample Representative\nInsiJets"
          }
        ]
      },
      "sourceRefs": [
        "Example Representative DOC01 19Oct",
        "Roadmap05 pet relocation"
      ],
      "refinementNote": "The five source group labels and fit statement are preserved; detailed evidence checks and finished persona-specific copy are proposed editorial refinements for validation."
    }
  ],
  "historicalSequences": [
    {
      "id": "H1_EN",
      "name": "Previous enquiry — main historical campaign",
      "language": "en",
      "status": "revised_from_Luca_feedback_draft_not_send_approved",
      "sendEnabled": false,
      "eligibilityRequirement": "Dated CRM enquiry, service and route/context; no booking, active conversation or exclusion; current permission to reconnect.",
      "additionalGate": "Current clients, active deals/conversations, opt-outs, complaints/bounces, other active sequences and protected Tier 1 excluded; unknown eligibility hold. One canonical account/contact coordinator.",
      "steps": [
        {
          "minimumCalendarDayOffset": 0,
          "subject": "Revisiting your travel plans",
          "threadRule": "Same-thread continuation; never create a separate overlapping follow-up sequence.",
          "body": "{{greeting}}\n\nYou contacted Example Charter on {{previousEnquiryDate}} about {{previousService}} for {{previousItineraryOrServiceContext}}.\n\nI would welcome an update on your travel requirements and the chance to see how we could help. Do you have an upcoming trip you would like us to review?\n\nIf you prefer no further follow-up, just let me know.\n\nKind regards,\nExample Representative\nInsiJets"
        },
        {
          "minimumCalendarDayOffset": 7,
          "subject": "Re: Revisiting your travel plans",
          "threadRule": "Same-thread continuation; never create a separate overlapping follow-up sequence.",
          "body": "{{greeting}}\n\nHave your requirements changed since your enquiry about {{previousService}}? If a trip is taking shape, send the current route, dates and passenger count and we can review the options.\n\nIf you prefer no further follow-up, just let me know.\n\nKind regards,\nExample Representative\nInsiJets"
        },
        {
          "minimumCalendarDayOffset": 17,
          "subject": "Re: Revisiting your travel plans",
          "threadRule": "Same-thread continuation; never create a separate overlapping follow-up sequence.",
          "body": "{{greeting}}\n\nI'll leave this with you for now. If a trip comes up, reply here and we can review current options. If you prefer no further follow-up, just let me know.\n\nKind regards,\nExample Representative\nInsiJets"
        }
      ],
      "sourceRefs": [
        "HISTORICAL_CURRENT",
        "CAMPAIGN_DEMOS",
        "EVIDENCE_PLAN"
      ],
      "refinementNote": "Example Representative 19 October feedback reflected with corrected English; held claims and attachment conflict require review. Exact recipient copy, language, salutation, sender and exclusions remain approval gates."
    },
    {
      "id": "H2_EN",
      "name": "Previous quote, no booking",
      "language": "en",
      "status": "revised_from_Luca_feedback_draft_not_send_approved",
      "sendEnabled": false,
      "eligibilityRequirement": "Verified quote date, route and service; mutually exclusive with historical-enquiry for one person/account plan.",
      "additionalGate": "Current clients, active deals/conversations, opt-outs, complaints/bounces, other active sequences and protected Tier 1 excluded; unknown eligibility hold. One canonical account/contact coordinator.",
      "steps": [
        {
          "minimumCalendarDayOffset": 0,
          "subject": "Your previous charter enquiry",
          "threadRule": "Same-thread continuation; never create a separate overlapping follow-up sequence.",
          "body": "{{greeting}}\n\nWe prepared a {{previousService}} quote on {{previousQuoteDate}} for {{previousRoute}}. Is a similar journey coming up, or have your plans changed?\n\nWe would check current availability and pricing afresh. Would you like an updated proposal?\n\nIf you prefer no further follow-up, just let me know.\n\nKind regards,\nExample Representative\nInsiJets"
        },
        {
          "minimumCalendarDayOffset": 7,
          "subject": "Re: Your previous charter enquiry",
          "threadRule": "Same-thread continuation; never create a separate overlapping follow-up sequence.",
          "body": "{{greeting}}\n\nIf you are still considering a trip, we can work from your current dates and passenger count. Would you like us to review the original route or a different itinerary?\n\nIf you prefer no further follow-up, just let me know.\n\nKind regards,\nExample Representative\nInsiJets"
        },
        {
          "minimumCalendarDayOffset": 17,
          "subject": "Re: Your previous charter enquiry",
          "threadRule": "Same-thread continuation; never create a separate overlapping follow-up sequence.",
          "body": "{{greeting}}\n\nI'll close the loop for now. If the trip comes back onto your calendar, send the details and we can reassess it. If you prefer no further follow-up, just let me know.\n\nKind regards,\nExample Representative\nInsiJets"
        }
      ],
      "sourceRefs": [
        "HISTORICAL_CURRENT",
        "CAMPAIGN_DEMOS",
        "EVIDENCE_PLAN"
      ],
      "refinementNote": "Example Representative 19 October feedback reflected with corrected English; held claims and attachment conflict require review. Exact recipient copy, language, salutation, sender and exclusions remain approval gates."
    },
    {
      "id": "H3_EN",
      "name": "Dormant professional partner",
      "language": "en",
      "status": "revised_from_Luca_feedback_draft_not_send_approved",
      "sendEnabled": false,
      "eligibilityRequirement": "Confirmed previous professional cooperation/context, contact date and permitted reconnection.",
      "additionalGate": "Current clients, active deals/conversations, opt-outs, complaints/bounces, other active sequences and protected Tier 1 excluded; unknown eligibility hold. One canonical account/contact coordinator.",
      "steps": [
        {
          "minimumCalendarDayOffset": 0,
          "subject": "Reconnecting on client flight requests",
          "threadRule": "Same-thread continuation; never create a separate overlapping follow-up sequence.",
          "body": "{{greeting}}\n\nWe were previously in touch in {{previousContactMonth}} about {{confirmedProfessionalContext}}. Does your team still receive private flight requests from clients?\n\nMay I send you our current on-demand charter presentation and aircraft network overview?\n\nIf you prefer no further follow-up, just let me know.\n\nKind regards,\nExample Representative\nInsiJets"
        },
        {
          "minimumCalendarDayOffset": 7,
          "subject": "Re: Reconnecting on client flight requests",
          "threadRule": "Same-thread continuation; never create a separate overlapping follow-up sequence.",
          "body": "{{greeting}}\n\nWhen an enquiry falls outside your usual arrangements, we can review the route and timing with your nominated contact. Would you be the right person to discuss this with?\n\nIf you prefer no further follow-up, just let me know.\n\nKind regards,\nExample Representative\nInsiJets"
        },
        {
          "minimumCalendarDayOffset": 17,
          "subject": "Re: Reconnecting on client flight requests",
          "threadRule": "Same-thread continuation; never create a separate overlapping follow-up sequence.",
          "body": "{{greeting}}\n\nI'll leave this here for now. If a suitable client request arises, feel free to contact me. No client details are needed at this stage. If you prefer no further follow-up, just let me know.\n\nKind regards,\nExample Representative\nInsiJets"
        }
      ],
      "sourceRefs": [
        "HISTORICAL_CURRENT",
        "CAMPAIGN_DEMOS",
        "EVIDENCE_PLAN"
      ],
      "refinementNote": "Example Representative 19 October feedback reflected with corrected English; held claims and attachment conflict require review. Exact recipient copy, language, salutation, sender and exclusions remain approval gates."
    },
    {
      "id": "H1_IT",
      "name": "Richiesta precedente — campagna principale",
      "language": "it",
      "status": "legacy_translation_pending_Luca_feedback_review_not_send_approved",
      "sendEnabled": false,
      "eligibilityRequirement": "Example Representative/cliente deve confermare una reale precedente richiesta a Example Charter e l’idoneità attuale al ricontatto. Non usare per contatti nuovi; lingua italiana confermata, non dedotta automaticamente dal paese.",
      "additionalGate": "Current clients, active deals/conversations, opt-outs, complaints/bounces, other active sequences and protected Tier 1 excluded; unknown eligibility hold. One canonical account/contact coordinator.",
      "steps": [
        {
          "minimumCalendarDayOffset": 0,
          "subject": "Voli privati — restiamo in contatto",
          "threadRule": "initial subject for step 1; subsequent subject only if same-thread continuation unavailable",
          "body": "{{greeting}}\n\nIn passato ha contattato Example Charter per un volo privato, quindi desideravo ricontattarla.\n\nSe sta pensando a un nuovo viaggio, possiamo valutare le opzioni charter in base a tratta, date e numero di passeggeri. Le sarebbe utile restare in contatto per una futura richiesta?\n\nSe preferisce non ricevere altri messaggi, mi risponda ‘no grazie’ e non la ricontatterò.\n\nLuca\nInsiJets"
        },
        {
          "minimumCalendarDayOffset": 7,
          "subject": "Un seguito alla mia email",
          "threadRule": "initial subject for step 1; subsequent subject only if same-thread continuation unavailable",
          "body": "{{greeting}}\n\nLe scrivo brevemente in seguito alla mia email. Se sta organizzando un viaggio, può rispondere indicando la tratta, le date indicative e il numero di passeggeri.\n\nPotremo così valutare le opzioni adatte. Se i suoi programmi sono cambiati, nessun problema.\n\nSe preferisce non ricevere altri messaggi, mi risponda ‘no grazie’ e non la ricontatterò.\n\nLuca\nInsiJets"
        },
        {
          "minimumCalendarDayOffset": 17,
          "subject": "Chiudo qui per ora",
          "threadRule": "initial subject for step 1; subsequent subject only if same-thread continuation unavailable",
          "body": "{{greeting}}\n\nChiudo qui per ora. Se in futuro un volo privato dovesse esserle utile, può rispondere a questa email con i dettagli del viaggio. Preferisce che per il momento non la ricontatti?\n\nSe preferisce non ricevere altri messaggi, mi risponda ‘no grazie’ e non la ricontatterò.\n\nLuca\nInsiJets"
        }
      ],
      "sourceRefs": [
        "HISTORICAL_CURRENT",
        "CAMPAIGN_DEMOS",
        "EVIDENCE_PLAN"
      ],
      "refinementNote": "Historical Italian translation preserved; complete CRM salutation required. Does not establish current relationship detail, confirmed Italian preference or approval of translation against revised English copy.",
      "initialCohortEnabled": false
    }
  ],
  "workingMix": {
    "status": "Working European mix pending approval; wealth5 combined with family8 as13, pet0 pending allocation",
    "scope": "New European acquisition research allocation; not historical cohort allocation or sending commitment",
    "EuropePercent": 100,
    "MiddleEastPercent": 0,
    "totalPercent": 100,
    "historicalFirst": true,
    "protectedTier1": "Always excluded from automated historical/new email enrolment until Example Representative approves coordinated manual approach.",
    "petPartners": "UAE/Dubai/Abu Dhabi supported in specification; allocation and launch approval pending, no automatic expansion."
  },
  "sharedEvidenceAndRouting": {
    "allMaterialClaims": [
      "sourceURL or client attestation reference",
      "publisher",
      "publication date if available",
      "observed/review date",
      "event/fiscal period if applicable",
      "current role and remit",
      "claim supported and reviewer"
    ],
    "sourceWeights": "Current valid sources are mandatory filters, not points or provider multipliers. Multiple copies add no weight; role, email and financial eligibility are not scored.",
    "noCollectedEvidence": "Signal definitions are designed evidence requirements, not actual qualified people or proof any prospect meets them.",
    "accountControls": [
      "One canonical account links principal, assistant, manager and intermediary.",
      "One owner and active contact plan per account; hold overlapping sequences and email versus Tier 1 manual LinkedIn activity.",
      "Example Charter supplies current client-controlled eligibility and timestamp; unknown means hold.",
      "Exclude current clients, active deals/conversations, opt-outs, complaints, bounces, other active sequences and protected Tier 1.",
      "Stop follow-ups on any reply, opt-out, bounce, complaint or new exclusion; commercial AI replies stay drafts for Example Representative."
    ],
    "prohibitedInference": [
      "No private locations or personal tracking",
      "No assumed wealth or aircraft/card ownership",
      "No assumed itinerary from office footprint, celebrity or event listing",
      "No invented price, availability, saving, prior relationship or referral permission"
    ]
  },
  "scoring": {
    "status": "Luca19Oct filters and suggested points incorporated; remaining weights/routing are our proposal pending validation",
    "source": "LUCA_DOC01_19OCT",
    "commonLayer": [
      {
        "name": "Mobile found",
        "capPoints": 15,
        "levels": "0 missing;15 sourced professional mobile, identity linked. No call or personal lookup authority."
      },
      {
        "name": "PA/EA found",
        "capPoints": 15,
        "levels": "0 missing;15 current named assistant with verified relevant remit; not authority gate recycled."
      },
      {
        "name": "News",
        "capPoints": 20,
        "levels": "0 none;5 sourced positive person/company news;20 accredited private-jet-use news. Choose one level; never25."
      },
      {
        "name": "Checked travel need",
        "capPoints": 20,
        "levels": "Proposed0/10/20 for missing, partial or confirmed practical requirement; no inferred itinerary."
      },
      {
        "name": "Route friction",
        "capPoints": 20,
        "levels": "Proposed0/10/20 from dated practical commercial-airline comparison for an actual supported route/date need."
      },
      {
        "name": "FBO practicality",
        "capPoints": 10,
        "levels": "Proposed0/5/10 for unknown, sourced candidate, checked airport/FBO/transfer/operational constraints. No aircraft availability guarantee."
      }
    ],
    "personaLayer": "Profile checklist only; no second score.",
    "displayFormula": "sum(commonScore)",
    "example": {
      "common": 100,
      "persona": 0,
      "display": 100,
      "status": "illustration only; any missing filter still holds"
    },
    "routing": {
      "75to100": "Priority human review only after all gates pass and confidence strong.",
      "55to74": "Further qualification.",
      "below55": "Research hold."
    },
    "timing": "Role/source90 days, email verification7 days and financial180 days are proposed freshness limits; recheck before use. Event facts outside60 days have half timing weight; past events hold.",
    "antiDoubleCounting": "Gate evidence earns no points. One fact is scored once. Jet-use news20 and positive news5 share one20-point cap; they never sum25.",
    "precedence": "Suppression, relationship/account controls, verification, manual approval and protected Tier 1 always override score.",
    "mandatoryFilters": [
      {
        "id": "role",
        "required": true,
        "rule": "Current correct role and relevant authority confirmed."
      },
      {
        "id": "source",
        "required": true,
        "rule": "Every material claim has valid current admissible source and reviewer."
      },
      {
        "id": "email",
        "required": true,
        "rule": "Professional address and identity independently verified; unknown/catch-all/risky held."
      },
      {
        "id": "economic",
        "required": true,
        "rule": "Personal minimum20M net worth AND company net revenue20M each last2 years with positive trajectory; currency/definition/application confirmed, else hold."
      },
      {
        "id": "eligibility",
        "required": true,
        "rule": "Current client-controlled exclusion, opt-out, complaint, bounce, active-deal and relationship check."
      },
      {
        "id": "accountCoordination",
        "required": true,
        "rule": "Single owner and contact plan across principal/assistant/manager; no overlapping approach."
      }
    ]
  },
  "aviationMaturityRules": [
    {
      "maturity": "unknown",
      "approach": "Use the supplied neutral sequence. Ask about practical trip requirements; no ownership/card assumption.",
      "optionalApprovedSentence": "If a suitable trip comes up, we can review the practical options with you.",
      "gate": "Default unless Example Representative/recipient confirms context."
    },
    {
      "maturity": "newcomer",
      "approach": "Explain charter simply; introductory brochure only after relevance and Example Representative review.",
      "optionalApprovedSentence": "We can start with the route, dates and passenger count, then explain how charter options are assessed.",
      "gate": "Need confirmed; no promise of savings."
    },
    {
      "maturity": "uses_another_broker",
      "approach": "Additional or backup contact; no unsupported criticism/comparison.",
      "optionalApprovedSentence": "We can be an additional contact for a particular request alongside your usual arrangements.",
      "gate": "Existing provider context must be client/recipient-confirmed if directly referenced."
    },
    {
      "maturity": "jet_card_customer",
      "approach": "Only relevant confirmed Jet Card context and Example Representative-approved current claims/material.",
      "optionalApprovedSentence": "If you need an option alongside your current arrangement, we can review a specific trip.",
      "gate": "Do not claim contract constraints, pricing or superiority."
    },
    {
      "maturity": "fractional_owner",
      "approach": "Ask about supplementary flexibility/coverage only for a confirmed need.",
      "optionalApprovedSentence": "If a trip falls outside your usual arrangement, we can assess a supplementary charter option.",
      "gate": "Actual ownership/product context confirmed."
    },
    {
      "maturity": "aircraft_owner",
      "approach": "Supplementary charter; management/acquisition material only if stated need fits and Example Representative approves.",
      "optionalApprovedSentence": "If you need supplementary charter for a particular trip, we can review the requirements.",
      "gate": "Never infer ownership from status; no assumption aircraft unavailable."
    },
    {
      "maturity": "former_owner",
      "approach": "Understand changed arrangement before selecting charter/card proposition.",
      "optionalApprovedSentence": "If your travel arrangements have changed, we can discuss what would be useful for future trips.",
      "gate": "Former ownership client-confirmed; do not mention reason unless volunteered."
    }
  ],
  "messageUseRules": {
    "status": "Revised against Example Representative 19 October feedback for review; no approval, enrolment or sending.",
    "cadence": "Minimum absolute calendar offsets 0/7/17, equivalent minimum gaps 7 then 10 days. Not business-day offsets. Roll forward to the next approved Tuesday–Thursday local sending window; later send shifts minimum next gap accordingly. No fixed launch dates or active schedules.",
    "language": "Use client/recipient-confirmed language only; never infer it from name, nationality or country. Revised EN copy is draft. Legacy H1 IT is preserved pending review against revised EN; other translations need separate review.",
    "placeholderRules": {
      "{{greeting}}": "Complete CRM-confirmed salutation including correct title/name/punctuation. Preserve verified surname, Dr, Avv., Ing., Lord or established first-name form. Never infer gender, marital status, title or preference from name or nationality. Missing salutation holds personalised approval; Hello, is a proposed human-reviewed fallback only.",
      "optionalFactSentence": "Use only exact sourced and dated facts. A site list or event date is not proof of travel need. Missing named facts require a reviewed neutral rewrite, never an invented placeholder value.",
      "historicalRelationship": "H1/H2/H3 require dated evidence of actual enquiry, quote/service or previous professional contact and permitted reconnection. Missing relationship context holds the record; do not silently switch to cold copy.",
      "historicalLane": "H1 EN enquiry and H2 EN quote are mutually exclusive alternatives in one account plan. Example Representative unfinished quote note remains a decision, not approval of both lanes."
    },
    "signature": "Proposed Example Representative / Example Charter. Confirm sender mailbox, approved signature role, legal footer and monitored reply owner before staging; no invented title or phone.",
    "controls": [
      "No unverified network size, airport percentage, 24-hour notice, 24/7 cover or local aircraft expansion claim. Held commercial modules require evidence and wording approval; one short-notice trip is not a guarantee.",
      "No first-contact attachment until doc01 no-attachments rule versus Example Representative dormant-partner presentation request is resolved. Draft offers presentation; approve exact version before attaching. Tracking remains off.",
      "Plain reply-based opt-out in every message. Stop on reply, opt-out, complaint, bounce, new exclusion or loss of eligibility; actual suppression and monitored reply readback remain required.",
      "One linked principal/assistant/manager/intermediary account plan across channels. No duplicate approach, independent wealth-manager sequence or parallel H1/H2 enrolment.",
      "Family offices and wealth managers use family_offices canonical sequence; wealth_managers ID retained for compatibility/history only. Art/galleries, yachting and politicians remain parked.",
      "Exact final copy, recipient list, sender, language, salutation, signature and attachments require the applicable human approval. General copy or this source asset authorises no sending, campaign, provider purchase or CRM write."
    ]
  },
  "coreDecisionsForLuca": [
    {
      "id": "D1",
      "decision": "Confirm combined family offices/wealth13% and pet partner geographic allocation, including UAE/Dubai/Abu Dhabi, without automatic month-one expansion.",
      "reason": "Embedded meeting notes are working amendments, not proven final acceptance."
    },
    {
      "id": "D2",
      "decision": "Confirm economic currency, net revenue definition and applicability by persona; until confirmed the20M personal AND company/two-year gate holds.",
      "reason": "Turn mockups into a validated qualification framework; no real lead sourcing yet."
    },
    {
      "id": "D3",
      "decision": "Approve the full copy library and actual sender signature/reply owner, starting with the appropriate H1/H2/H3 historical segment and language.",
      "reason": "Client-attested relationship and current eligibility determine historical opener; no past-relationship claim for new prospects."
    },
    {
      "id": "D4",
      "decision": "Confirm initial eligible historical cohort, countries/languages, protected relationships and a current client-controlled suppression check.",
      "reason": "Historical first, separate from acquisition research quotas; unknown eligibility holds."
    },
    {
      "id": "D5",
      "decision": "Approve scoring/routing proposals and manual account/Tier 1 coordination.",
      "reason": "No score alone authorises outreach; principal/assistant/manager overlap blocked."
    },
    {
      "id": "D6",
      "decision": "Confirm maturity-to-brochure mapping, any current commercial claims, cadence and send limits after technical validation.",
      "reason": "No unverified card/ownership/product claims or inferred volume from warm-up accounts."
    },
    {
      "id": "D7",
      "decision": "Clarify “Canary log records also.”: decoy records/access detection or canary release logs?",
      "reason": "No specific mechanism or acceptance test established; ordinary request logs do not prove this."
    },
    {
      "id": "D8",
      "decision": "Confirm first-contact brochure policy and claims7000 aircraft/98% airports/24h/24-7/Linate–Crete1h45 with conditions.",
      "reason": "Requested copy is held for attestation; no guarantee or first-contact attachment inserted."
    }
  ],
  "structuredSourceChanges": [
    {
      "source": "ICP_CURRENT_BODY + ICP_MEETING_COMMENTS",
      "item": "Business owners share",
      "old": "15%",
      "working": "18%",
      "basis": "David comment +3%, 5 Oct; interpreted as +3 percentage points; pending Example Representative confirmation."
    },
    {
      "source": "ICP_MEETING_COMMENTS",
      "item": "Artists/DJs share",
      "old": "3%",
      "working": "6%",
      "basis": "David comment let’s go with 6%."
    },
    {
      "source": "ICP_MEETING_COMMENTS",
      "item": "Art/galleries share",
      "old": "3%, then comment 6%",
      "working": "0% inactive",
      "basis": "Later reply 0% supersedes earlier 6%; history preserved."
    },
    {
      "source": "ICP_MEETING_COMMENTS",
      "item": "Yachting share",
      "old": "3%",
      "working": "0% inactive",
      "basis": "David comment let’s go with 0."
    },
    {
      "source": "ICP_CURRENT_BODY + ICP_MEETING_COMMENTS",
      "item": "Month-one Middle East",
      "old": "20% body; 10% earlier revision",
      "working": "0% / Europe100%",
      "basis": "David latest first-month note; not a permanent geography exclusion."
    },
    {
      "source": "ICP_MEETING_COMMENTS",
      "item": "Architect Tier 1 / Dusseldorf–Malaga",
      "old": "Illustrative future route concept",
      "working": "No new quota or approved targets added",
      "basis": "Possible future reviewed Tier 1 subsegment; no verified itinerary or route availability."
    },
    {
      "source": "CAMPAIGN_DEMOS",
      "item": "Copy",
      "old": "Mockups, mixed signatures, some unverified placeholders, no consistent opt-out",
      "working": "14 full EN persona sequences plus H1/H2/H3 EN and H1 IT; Example Representative-only sign-off; plain opt-out; no past claims in new acquisition",
      "basis": "Proposed editorial completion for Example Representative review, not new client-approved claims."
    },
    {
      "source": "ICP_CURRENT_BODY",
      "item": "Signal groups",
      "old": "Five group names per persona plus concise signal examples",
      "working": "Names/caps retained; five operational checks each with source/date requirements",
      "basis": "Detailed check design is proposed refinement; no actual person scored or evidence collected."
    }
  ],
  "criticalAmbiguities": [
    "Revised copy and filters implement feedback, not approval to launch or final client acceptance.",
    "Economic currency, definition and application by persona unresolved; no invented wealth or thresholds.",
    "Remaining score weights20 need/20 friction/10 FBO and thresholds75/55 are our proposal.",
    "Wealth standalone retired; grouped13% is bookkeeping reconciliation pending approval. Pet partner geography/allocation pending.",
    "Historical cohort, CRM exclusions/salutations/languages, provider accounts and verifier are not yet verified.",
    "Canary request needs a precise mechanism, owner and acceptance test.",
    "Launch requested by Luca21Oct: readiness before1Nov and intended3Nov with English website; this is not send approval.",
    "Available sources do not include all WhatsApp/calls after9Oct; coverage gap recorded."
  ]
} as const;

export const FINAL_CONTENT_PERSONA_ALIASES = {pa_ea:'pa-ea',executives:'executives',business_owners:'business-owners',investors:'investors',family_offices:'family-offices',wealth_managers:'wealth-managers',sports_managers:'sports-managers',artist_managers:'artist-managers',elite_athletes:'athletes',artists_djs:'artists-djs',art_galleries:'art',yachting:'yachting',luxury_travel:'luxury-travel',politicians:'politicians',pet_relocation:'pet-relocation'} as const;
export type FinalOutreachPersona = typeof OUTREACH_FINAL_CONTENT.personas[number];
export type FinalOutreachHistoricalSequence = typeof OUTREACH_FINAL_CONTENT.historicalSequences[number];
export type FinalOutreachSequence = FinalOutreachPersona['sequence'] | FinalOutreachHistoricalSequence;
const campaignIds: Record<string, string> = {'pa-ea':'c3','business-owners':'f4',art:'a1'};
function campaignDraft(id: string, name: string, persona: string, audience: CampaignDraft['audience'], sourceId: string, sequence: FinalOutreachSequence): CampaignDraft {
  return {id, name, audience, persona, locale: sequence.language, subject: sequence.steps[0].subject,
    steps: sequence.steps.map(step => ({offset: step.minimumCalendarDayOffset, offsetUnit:'calendar-days', subject:step.subject, body:step.body, threadRule:step.threadRule})),
    sourceReference:`phase1-editorial-sha256:${OUTREACH_FINAL_SOURCE_SHA256}`,sourceDate:OUTREACH_FINAL_CONTENT_VERSION,
    cadenceOriginal:'Source offsets 0/+7/+17 calendar days. Same-thread continuation; later subject only when a new thread is needed.',
    version:1, reviewState:'draft', sendEnabled:false,
    notes:['Finished proposed editorial copy for Example Representative validation. Not client-approved or permission to send.',`Source sequence: ${sourceId}`]};
}
/** Interoperable preparation inputs. They do not replace privately edited drafts on read. */
export const FINAL_REVIEW_CAMPAIGNS: CampaignDraft[] = [
  ...OUTREACH_FINAL_CONTENT.historicalSequences.map(sequence => campaignDraft(sequence.id==='H1_EN'?'historical-current-en':`historical-${sequence.id}`,sequence.name,sequence.id,'historical',sequence.id,sequence)),
  ...OUTREACH_FINAL_CONTENT.personas.filter(persona => persona.id !== 'wealth_managers').map(persona => {const alias=FINAL_CONTENT_PERSONA_ALIASES[persona.id];return campaignDraft(campaignIds[alias]??`icp-${alias}`,persona.name,alias,'new-icp',persona.id,persona.sequence);}),
];
export const OUTREACH_FINAL_CONTENT_COUNTS = {
  profiles:OUTREACH_FINAL_CONTENT.personas.length,
  signalChecks:OUTREACH_FINAL_CONTENT.personas.reduce((n,p)=>n+p.signals.length,0),
  sequences:FINAL_REVIEW_CAMPAIGNS.length,
  messages:FINAL_REVIEW_CAMPAIGNS.reduce((n,s)=>n+s.steps.length,0),
};
export type FinalOutreachContentQuery = {section?:'summary'|'profile'|'sequence'|'scoring'|'controls'; personaId?:string; sequenceId?:string};
/** A bounded data-only export for the guarded foreground chat tool. No implicit lookup or write. */
export function getOutreachFinalContent(query: FinalOutreachContentQuery = {}) {
  const base = {version:OUTREACH_FINAL_CONTENT_VERSION,sourceSha256:OUTREACH_FINAL_SOURCE_SHA256,approvalState:OUTREACH_FINAL_CONTENT.approvalState,sendEnabled:false,counts:OUTREACH_FINAL_CONTENT_COUNTS};
  const personas=OUTREACH_FINAL_CONTENT.personas;
  const persona=personas.find(p=>p.id===query.personaId||FINAL_CONTENT_PERSONA_ALIASES[p.id]===query.personaId);
  if(query.personaId&&!persona) throw new Error('FINAL_CONTENT_PERSONA_NOT_FOUND');
  if(query.section==='profile') {
    if(!persona) throw new Error('FINAL_CONTENT_PERSONA_NOT_FOUND');
    return {...base,persona};
  }
  if(query.section==='sequence') {
    const historical=OUTREACH_FINAL_CONTENT.historicalSequences.find(s=>s.id===query.sequenceId);
    const selectedPersona=persona??personas.find(p=>p.id===query.sequenceId||FINAL_CONTENT_PERSONA_ALIASES[p.id]===query.sequenceId);
    const campaign=FINAL_REVIEW_CAMPAIGNS.find(s=>s.id===query.sequenceId);
    if(!historical&&!selectedPersona&&!campaign) throw new Error('FINAL_CONTENT_SEQUENCE_NOT_FOUND');
    return {...base,sequence:historical??selectedPersona?.sequence??campaign,messageUseRules:OUTREACH_FINAL_CONTENT.messageUseRules};
  }
  if(query.section==='scoring') return {...base,scoring:OUTREACH_FINAL_CONTENT.scoring,...(persona?{personaFactors:persona.scoringFactors}:{}),evidenceRules:OUTREACH_FINAL_CONTENT.sharedEvidenceAndRouting};
  if(query.section==='controls') return {...base,workingMix:OUTREACH_FINAL_CONTENT.workingMix,evidenceRules:OUTREACH_FINAL_CONTENT.sharedEvidenceAndRouting,messageUseRules:OUTREACH_FINAL_CONTENT.messageUseRules,aviationMaturityRules:OUTREACH_FINAL_CONTENT.aviationMaturityRules,decisions:OUTREACH_FINAL_CONTENT.coreDecisionsForLuca,ambiguities:OUTREACH_FINAL_CONTENT.criticalAmbiguities};
  return {...base,profiles:personas.map(p=>({id:p.id,engineId:FINAL_CONTENT_PERSONA_ALIASES[p.id],name:p.name,sharePercent:p.sharePercent,monthOneEnabled:p.monthOneEnabled,fit:p.fitAndDecisionRole,signalGroups:p.scoringFactors.map(f=>f.name)})),historicalSequences:OUTREACH_FINAL_CONTENT.historicalSequences.map(s=>({id:s.id,name:s.name,language:s.language,eligibility:s.eligibilityRequirement})),workingMix:OUTREACH_FINAL_CONTENT.workingMix,scoring:OUTREACH_FINAL_CONTENT.scoring,decisions:OUTREACH_FINAL_CONTENT.coreDecisionsForLuca};
}
