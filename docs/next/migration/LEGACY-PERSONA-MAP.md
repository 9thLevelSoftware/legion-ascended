---
title: Legacy Persona ID Migration Map
status: migration-only
source: docs/next/adr/ADR-002-functional-workers.md
---

# Legacy Persona ID Migration Map

This table maps the 48 legacy v8 personas to v9 functional roles and domain packs.
`testing-code-polisher` is intentionally excluded because it was added after the legacy v8 compatibility surface and is not part of the migration set.

The map is migration-only: it preserves meaning for imported plans, outcomes, and evidence, but it is not a runtime dispatch router.

## Design Division

| Legacy persona ID | Functional role | Domain packs |
| --- | --- | --- |
| `design-brand-guardian` | `specifier` | brand-system, identity, tone-voice, visual-language |
| `design-ui-designer` | `specifier` | ui-systems, components, accessibility, visual-design |
| `design-ux-architect` | `architect` | ux-architecture, accessibility, information-architecture, layout-systems |
| `design-ux-researcher` | `explorer` | user-research, usability-testing, behavior-analysis, validation |
| `design-visual-storyteller` | `specifier` | visual-storytelling, presentation-design, multimedia, infographics |
| `design-whimsy-injector` | `specifier` | delight-design, motion, personality, microinteractions |

## Engineering Division

| Legacy persona ID | Functional role | Domain packs |
| --- | --- | --- |
| `engineering-ai-engineer` | `implementer` | ai-integration, ml-ops, prompts, data-pipelines |
| `engineering-backend-architect` | `architect` | backend-architecture, api-design, database-design, microservices |
| `engineering-infrastructure-devops` | `implementer` | ci-cd, infrastructure, deployment, observability |
| `engineering-frontend-developer` | `implementer` | frontend, spa, responsive-design, performance |
| `engineering-laravel-specialist` | `implementer` | laravel, livewire, fluxui, php |
| `engineering-mobile-app-builder` | `implementer` | mobile-ios, mobile-android, react-native, flutter |
| `engineering-rapid-prototyper` | `implementer` | prototyping, mvp, proof-of-concept, experimentation |
| `engineering-security-engineer` | `task-reviewer` | security, owasp, stride, secure-code-review |
| `engineering-senior-developer` | `implementer` | full-stack, refactoring, reliability, code-quality |

## Marketing Division

| Legacy persona ID | Functional role | Domain packs |
| --- | --- | --- |
| `marketing-app-store-optimizer` | `specifier` | aso, app-store, keyword-optimization, conversion-optimization |
| `marketing-content-social-strategist` | `specifier` | content-strategy, copywriting, editorial-calendar, brand-storytelling |
| `marketing-growth-hacker` | `explorer` | growth-hacking, experiments, acquisition, funnels |
| `marketing-social-platform-specialist` | `specifier` | social-platforms, visual-content, engagement, community-building |

## Product Division

| Legacy persona ID | Functional role | Domain packs |
| --- | --- | --- |
| `product-feedback-synthesizer` | `explorer` | user-feedback, sentiment-analysis, feature-triage, product-insights |
| `product-sprint-prioritizer` | `planner` | prioritization, backlog-grooming, roadmap, resource-allocation |
| `product-technical-writer` | `oracle-author` | api-docs, user-guides, readme, technical-writing |
| `product-trend-researcher` | `explorer` | market-research, competitive-analysis, opportunity-assessment, industry-intelligence |

## Project Management Division

| Legacy persona ID | Functional role | Domain packs |
| --- | --- | --- |
| `project-management-experiment-tracker` | `planner` | ab-testing, experiment-tracking, hypothesis-validation, metrics |
| `project-management-project-shepherd` | `planner` | cross-functional, timeline-management, stakeholder-alignment, risk-management |
| `project-management-studio-operations` | `planner` | operations, process-optimization, resource-coordination, productivity |
| `project-management-studio-producer` | `planner` | portfolio-management, creative-direction, strategic-planning, executive-oversight |
| `project-manager-senior` | `planner` | task-breakdown, spec-to-tasks, scope-management, implementation-planning |

## Spatial Computing Division

| Legacy persona ID | Functional role | Domain packs |
| --- | --- | --- |
| `macos-spatial-metal-engineer` | `implementer` | metal, swift, 3d-rendering, vision-pro |
| `terminal-integration-specialist` | `implementer` | terminal-emulation, swiftterm, vt100, text-rendering |
| `visionos-spatial-engineer` | `implementer` | visionos, spatial-computing, swiftui-volumetric, realitykit |
| `xr-cockpit-interaction-specialist` | `architect` | xr-cockpit, immersive-ui, spatial-controls, cockpit-design |
| `xr-immersive-developer` | `implementer` | webxr, ar-vr, browser-3d, immersive-apps |
| `xr-interface-architect` | `architect` | spatial-ux, xr-interfaces, comfort-design, 3d-navigation |

## Specialized Division

| Legacy persona ID | Functional role | Domain packs |
| --- | --- | --- |
| `agents-orchestrator` | `release-controller` | orchestration, pipeline-management, workflow-automation, agent-coordination |
| `data-analytics-engineer` | `implementer` | data-pipelines, etl, data-quality, dashboards, business-intelligence |
| `lsp-index-engineer` | `architect` | lsp, semantic-indexing, language-servers, developer-tooling |
| `polymath` | `explorer` | exploration, clarification, research-first, gap-detection |

## Support Division

| Legacy persona ID | Functional role | Domain packs |
| --- | --- | --- |
| `support-executive-summary-generator` | `oracle-author` | executive-summaries, strategy-consulting, business-communication, c-suite-reporting |
| `support-finance-tracker` | `oracle-author` | financial-planning, budget-management, cash-flow, financial-risk |
| `support-legal-compliance-checker` | `task-reviewer` | legal-compliance, risk-assessment, policy-development, regulatory |
| `support-support-responder` | `oracle-author` | customer-support, issue-resolution, multi-channel-support, user-onboarding |

## Testing Division

| Legacy persona ID | Functional role | Domain packs |
| --- | --- | --- |
| `testing-api-tester` | `integration-evaluator` | api-testing, contract-testing, endpoint-validation, performance-testing |
| `testing-performance-benchmarker` | `integration-evaluator` | performance-benchmarking, load-testing, metrics-analysis, capacity-planning |
| `testing-qa-verification-specialist` | `task-reviewer` | visual-qa, evidence-gathering, production-readiness, bug-verification |
| `testing-test-results-analyzer` | `task-reviewer` | test-analysis, root-cause-analysis, quality-metrics, trend-analysis |
| `testing-tool-evaluator` | `integration-evaluator` | tool-evaluation, technology-assessment, competitive-comparison, adoption-strategy |
| `testing-workflow-optimizer` | `planner` | test-pipeline-optimization, ci-optimization, qa-process-improvement, automation-strategy |

## Coverage summary

- Legacy personas covered: 48
- Migration exclusions: 1 (`testing-code-polisher`)
- Runtime policy: use functional-role routing, not persona-first routing
