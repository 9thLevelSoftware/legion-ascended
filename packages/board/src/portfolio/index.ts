/**
 * P11-T02 — Portfolio projection barrel.
 *
 * Re-exports the portfolio contract, reducer, hash helpers,
 * and descriptor so consumers (SQLite projector, CLI) can
 * import the full portfolio surface from
 * `@legion/board/portfolio`.
 */

export {
  PORTFOLIO_ADAPTER_KIND,
  PORTFOLIO_ADAPTER_SCHEMA_VERSION,
  PORTFOLIO_ADAPTER_KEYS,
  PORTFOLIO_DEPENDENCY_RELATIONS,
  PORTFOLIO_PROJECTION_KEY_PREFIX,
  PORTFOLIO_PROJECTION_VERSION,
  PORTFOLIO_PRIORITY_BANDS,
  PORTFOLIO_ROLLUP_AGGREGATE_KINDS,
  asTenantId,
  isPortfolioProjectionState,
  makeInitialPortfolioState,
  parsePortfolioProjectionKey,
  portfolioEdgeKey,
  portfolioPriorityBand,
  portfolioProjectionKey,
  portfolioScopeFromList
} from "./contract.js";

export {
  derivePortfolioProjectionStateHash,
  sha256OfCanonicalPortfolioInput
} from "./hash.js";

export {
  PORTFOLIO_REDUCER_KIND,
  PORTFOLIO_REDUCER_KIND_LITERAL,
  makePortfolioReducer,
  portfolioProjectionDescriptor,
  reducePortfolio,
  replayPortfolio
} from "./reducer.js";

export type {
  PortfolioAdapterKey,
  PortfolioAggregateId,
  PortfolioDependencyEdge,
  PortfolioDependencyRelation,
  PortfolioPriorityBand,
  PortfolioProjectionDescriptor,
  PortfolioProjectionDescriptorOptions,
  PortfolioProjectionState,
  PortfolioProjectRollup,
  PortfolioReducer,
  PortfolioResourceLedger,
  PortfolioRollupAggregateKind,
  PortfolioScope,
  ReducePortfolioOptions,
  ReplayPortfolioOptions,
  TenantId
} from "./reducer.js";

export type { PortfolioReducer as PortfolioReducerType } from "./contract.js";
