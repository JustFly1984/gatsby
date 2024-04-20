import { ErrorId } from "./error-map"

export type IConstructError = {
  details: {
    id?: ErrorId | undefined
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    context?: Record<string, any> | undefined
    error?: Error | undefined
    pluginName?: string | undefined
    [key: string]: unknown
  }
}

export type ILocationPosition = {
  line: number
  column: number
}

export type IStructuredStackFrame = {
  fileName: string
  functionName?: string | undefined
  lineNumber?: number | undefined
  columnNumber?: number | undefined
}

export type IStructuredError = {
  code?: string | undefined
  text: string
  stack: Array<IStructuredStackFrame>
  filePath?: string | undefined
  location?:
    | {
        start: ILocationPosition
        end?: ILocationPosition | undefined
      }
    | undefined
  category?: `${ErrorCategory}` | undefined
  error?: Error | undefined
  group?: string | undefined
  level: `${Level}`
  type: `${Type}`
  docsUrl?: string | undefined
  pluginName?: string | undefined
}

export type IOptionalGraphQLInfoContext = {
  codeFrame?: string | undefined
  filePath?: string | undefined
  urlPath?: string | undefined
  plugin?: string | undefined
}

export enum Level {
  ERROR = `ERROR`,
  WARNING = `WARNING`,
  INFO = `INFO`,
  DEBUG = `DEBUG`,
}

export enum Type {
  HTML_COMPILATION = `HTML.COMPILATION`,
  HTML_GENERATION = `HTML.GENERATION`,
  HTML_GENERATION_DEV_SSR = `HTML.GENERATION.DEV_SSR`,
  HTML_GENERATION_SSG = `HTML.GENERATION.SSG`,
  RSC_COMPILATION = `RSC.COMPILATION`,
  RSC_UNKNOWN = `RSC.UNKNOWN`,
  PAGE_DATA = `PAGE_DATA`,
  GRAPHQL_SCHEMA = `GRAPHQL.SCHEMA`,
  GRAPHQL_QUERY_RUNNING = `GRAPHQL.QUERY_RUNNING`,
  GRAPHQL_EXTRACTION = `GRAPHQL.EXTRACTION`,
  GRAPHQL_VALIDATION = `GRAPHQL.VALIDATION`,
  GRAPHQL_UNKNOWN = `GRAPHQL.UNKNOWN`,
  ENGINE_COMPILATION = `ENGINE.COMPILATION`,
  ENGINE_HTML = `ENGINE.HTML`,
  ENGINE_VALIDATION = `ENGINE.VALIDATION`,
  ENGINE_EXECUTION = `ENGINE.EXECUTION`,
  API_CONFIG_VALIDATION = `API.CONFIG.VALIDATION`,
  API_CONFIG_LOADING = `API.CONFIG.LOADING`,
  API_CONFIG_COMPILATION = `API.CONFIG.COMPILATION`,
  API_NODE_VALIDATION = `API.NODE.VALIDATION`,
  API_NODE_COMPILATION = `API.NODE.COMPILATION`,
  API_NODE_EXECUTION = `API.NODE.EXECUTION`,
  API_TYPESCRIPT_COMPILATION = `API.TYPESCRIPT.COMPILATION`,
  API_TYPESCRIPT_TYPEGEN = `API.TYPESCRIPT.TYPEGEN`,
  FUNCTIONS_COMPILATION = `FUNCTIONS.COMPILATION`,
  FUNCTIONS_EXECUTION = `FUNCTIONS.EXECUTION`,
  CLI_VALIDATION = `CLI.VALIDATION`,
  ADAPTER = `ADAPTER`,
  // webpack errors for each stage enum: packages/gatsby/src/commands/types.ts
  WEBPACK_DEVELOP = `WEBPACK.DEVELOP`,
  WEBPACK_DEVELOP_HTML = `WEBPACK.DEVELOP-HTML`,
  WEBPACK_BUILD_JAVASCRIPT = `WEBPACK.BUILD-JAVASCRIPT`,
  WEBPACK_BUILD_HTML = `WEBPACK.BUILD-HTML`,
  UNKNOWN = `UNKNOWN`,
  // Backwards compatibility for plugins
  // TODO(v6): Remove these types
  /** @deprecated */
  GRAPHQL = `GRAPHQL`,
  /** @deprecated */
  CONFIG = `CONFIG`,
  /** @deprecated */
  WEBPACK = `WEBPACK`,
  /** @deprecated */
  PLUGIN = `PLUGIN`,
  /** @deprecated */
  COMPILATION = `COMPILATION`,
}

export enum ErrorCategory {
  USER = `USER`,
  SYSTEM = `SYSTEM`,
  THIRD_PARTY = `THIRD_PARTY`,
  UNKNOWN = `UNKNOWN`,
}
