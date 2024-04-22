import type { Reporter } from "gatsby-cli/lib/reporter/reporter"
import {
  WebpackError,
  type StatsCompilation,
  Module,
  NormalModule,
} from "webpack"
import type { Stage } from "../commands/types"
import formatWebpackMessages from "react-dev-utils/formatWebpackMessages"

const stageCodeToReadableLabel: Record<Stage, string> = {
  [`build-javascript`]: `Generating JavaScript bundles`,
  [`build-html`]: `Generating SSR bundle`,
  [`develop-html`]: `Generating development SSR bundle`,
  [`develop`]: `Generating development JavaScript bundle`,
}

type IFileLocation = {
  line: number
  column: number
}

type IWebpackError = {
  name: string
  message: string
  file?: string | undefined
  error?:
    | {
        message: string
        loc?:
          | {
              start: IFileLocation
              end: IFileLocation
            }
          | undefined
      }
    | undefined
  module: Module
  loc?:
    | {
        start: IFileLocation
        end: IFileLocation
      }
    | undefined
}

type ITransformedWebpackError = {
  id: string
  filePath: string
  location?:
    | {
        start: IFileLocation
        end: IFileLocation
      }
    | undefined
  context: {
    stage: Stage
    stageLabel: string
    sourceMessage?: string | undefined
    [key: string]: unknown
  }
}

function transformWebpackError(
  stage: Stage,
  webpackError: WebpackError,
): ITransformedWebpackError {
  const castedWebpackError = webpackError as unknown as IWebpackError

  let location
  if (castedWebpackError.loc && castedWebpackError.loc.start) {
    location = {
      start: castedWebpackError.loc.start,
      end: castedWebpackError.loc.end,
    }
  }

  if (!location && castedWebpackError.error?.loc) {
    if (castedWebpackError.error.loc.start) {
      location = castedWebpackError.error.loc
    } else {
      location = {
        start: castedWebpackError.error.loc,
      }
    }
  }

  // try to get location out of stacktrace
  if (!location) {
    const matches = castedWebpackError.message.match(/\((\d+):(\d+)\)/)
    if (matches && matches[1] && matches[2]) {
      location = {
        start: {
          line: Number(matches[1]),
          column: Number(matches[2]),
        },
      }
    }
  }

  let id = `98123`
  const context: ITransformedWebpackError["context"] = {
    stage,
    stageLabel: stageCodeToReadableLabel[stage],
    // TODO use formatWebpackMessages like in warnings
    sourceMessage:
      castedWebpackError.error?.message ?? castedWebpackError.message,
  }

  // When a module cannot be found we can short circuit
  if (castedWebpackError.name === `ModuleNotFoundError`) {
    const matches =
      castedWebpackError.error?.message.match(
        /Can't resolve '(.*?)' in '(.*?)'/m,
      ) ?? []

    id = `98124`
    context.packageName = matches?.[1]
    context.sourceMessage = matches?.[0]

    // get Breaking change message out of error
    // it shows extra information for things that changed with webpack
    const BreakingChangeRegex = /BREAKING CHANGE[\D\n\d]+$/
    if (BreakingChangeRegex.test(castedWebpackError.message)) {
      const breakingMatch =
        castedWebpackError.message.match(BreakingChangeRegex)

      context.deprecationReason = breakingMatch?.[0]
    }
  }

  return {
    id,
    filePath:
      (castedWebpackError?.module as NormalModule)?.resource ??
      castedWebpackError.file,
    location,
    context,
    // We use original error to display stack trace for the most part.
    // In case of webpack error stack will include internals of webpack
    // or one of loaders (for example babel-loader) and doesn't provide
    // much value to user, so it's purposely omitted.
    // error: webpackError?.error || webpackError,
  }
}

// With the introduction of Head API, the modulePath can have a resourceQuery so this function can be used to remove it
function removeResourceQuery(
  moduleName: string | undefined,
): string | undefined {
  const moduleNameWithoutQuery = moduleName?.replace(
    /(\?|&)export=(default|head)$/,
    ``,
  )

  return moduleNameWithoutQuery
}

export function structureWebpackErrors(
  stage: Stage,
  webpackError: WebpackError | Array<WebpackError>,
): Array<ITransformedWebpackError> | ITransformedWebpackError {
  if (Array.isArray(webpackError)) {
    return webpackError.map((e) => transformWebpackError(stage, e))
  }

  return transformWebpackError(stage, webpackError)
}

export function reportWebpackWarnings(
  warnings: StatsCompilation["warnings"] | undefined = [],
  reporter: Reporter,
): void {
  let warningMessages: Array<string> = []

  if (typeof warnings[0] === `string`) {
    warningMessages = warnings as unknown as Array<string>
  } else if (
    warnings[0]?.message &&
    removeResourceQuery(warnings[0]?.moduleName)
  ) {
    warningMessages = warnings.map(
      (warning) =>
        `${removeResourceQuery(warning.moduleName)}\n\n${warning.message}`,
    )
  } else if (warnings[0]?.message) {
    warningMessages = warnings.map((warning) => warning.message)
  }

  formatWebpackMessages({
    errors: [],
    warnings: warningMessages,
  }).warnings.forEach((warning) => reporter.warn(warning))
}
