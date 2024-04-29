// eslint-disable-next-line @typescript-eslint/naming-convention
import _ from "lodash";
import Promise from "bluebird";
import chalk from "chalk";
import { bindActionCreators as origBindActionCreators } from "redux";
import memoize from "memoizee";
import opentracing, { Span, SpanContext } from "opentracing";

import reporter from "gatsby-cli/lib/reporter";
import stackTrace from "stack-trace";
import { codeFrameColumns } from "@babel/code-frame";
import fs from "fs-extra";
import { getCache } from "./get-cache";
import { createNodeId } from "./create-node-id";
import { createContentDigest as _createContentDigest } from "gatsby-core-utils";
import {
  buildObjectType,
  buildUnionType,
  buildInterfaceType,
  buildInputObjectType,
  buildEnumType,
  buildScalarType,
} from "../schema/types/type-builders";
import { emitter, store } from "../redux";
import { getNodes, getNode, getNodesByType } from "../datastore";
import { getNodeAndSavePathDependency, loadNodeContent } from "./nodes";
import { getPublicPath } from "./get-public-path";
import { importGatsbyPlugin } from "./import-gatsby-plugin";
import { getNonGatsbyCodeFrameFormatted } from "./stack-trace-utils";
import { trackBuildError, decorateEvent } from "gatsby-telemetry";
import errorParser from "./api-runner-error-parser";
import { wrapNode, wrapNodes } from "./detect-node-mutations";
import { reportOnce } from "./report-once";
import type {
  FlattenedPlugin,
  GatsbyNodeAPI,
  IGatsbyNode,
  IGatsbyState,
  Stage,
} from "../internal";
import webpack from "webpack";
import type { ILoaderUtils, IRuleUtils, PluginUtils } from "./webpack-utils";
import type { Runner } from "../bootstrap/create-graphql-runner";
import {
  publicActions,
  restrictedActionsAvailableInAPI,
} from "../redux/actions";
import type { IActivityArgs, Reporter } from "gatsby-cli/lib/reporter/reporter";
import type { ErrorMeta } from "gatsby-cli/lib/reporter/types";
import type { IStructuredError } from "gatsby-cli/lib/structured-errors/types";
import type { IProgressReporter } from "gatsby-cli/lib/reporter/reporter-progress";
import type { ITimerReporter } from "gatsby-cli/lib/reporter/reporter-timer";
import type express from "express";

type ApiRunInstance = {
  api: GatsbyNodeAPI;
  args: {
    pluginName?: string | undefined;
    parentSpan?: Span | SpanContext | undefined;
    traceId?: string | undefined;
    traceTags?: Record<string, string> | undefined;
    waitForCascadingActions?: boolean | undefined;
    type?:
      | {
          name?: string | undefined;
        }
      | undefined;
    page?:
      | {
          path?: string | undefined;
        }
      | undefined;
    filename?: string | undefined;
    node?: IGatsbyNode | undefined;
  };
  pluginSource: string | undefined;
  resolve: (thenableOrResult?: unknown) => void;
  span: Span;
  startTime: string;
  traceId: string | undefined;
  id?: string | undefined;
};

const bindActionCreators = memoize(origBindActionCreators);

const tracer = opentracing.globalTracer();
// Override createContentDigest to remove autogenerated data from nodes to
// ensure consistent digests.
function createContentDigest(node): string {
  if (!node?.internal?.type) {
    // this doesn't look like a node, so let's just pass it as-is
    return _createContentDigest(node);
  }

  return _createContentDigest({
    ...node,
    internal: {
      ...node.internal,
      // Remove auto-generated fields that'd prevent
      // creating a consistent contentDigest.
      contentDigest: undefined,
      owner: undefined,
      fieldOwners: undefined,
      ignoreType: undefined,
      counter: undefined,
    },
    fields: undefined,
  });
}

if (!process.env.BLUEBIRD_DEBUG && !process.env.BLUEBIRD_LONG_STACK_TRACES) {
  // Unless specified - disable longStackTraces
  // as this have severe perf penalty ( http://bluebirdjs.com/docs/api/promise.longstacktraces.html )
  // This is mainly for `gatsby develop` due to NODE_ENV being set to development
  // which cause bluebird to enable longStackTraces
  // `gatsby build` (with NODE_ENV=production) already doesn't enable longStackTraces
  Promise.config({ longStackTraces: false });
}

const nodeMutationsWrappers = {
  getNode(id: string): IGatsbyNode | undefined {
    return wrapNode(getNode(id));
  },
  getNodes(): Array<IGatsbyNode> | undefined {
    return wrapNodes(getNodes());
  },
  getNodesByType(type: string): Array<IGatsbyNode> {
    return wrapNodes(getNodesByType(type));
  },
  getNodeAndSavePathDependency(id: string): IGatsbyNode | undefined {
    return wrapNode(getNodeAndSavePathDependency(id));
  },
};

// Bind action creators per plugin so we can auto-add
// metadata to actions they create.
const boundPluginActionCreators = {};
function doubleBind(
  // eslint-disable-next-line @typescript-eslint/ban-types
  boundActionCreators: Record<string, Function>,
  api,
  plugin,
  actionOptions,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): any {
  const { traceId, deferNodeMutation } = actionOptions;
  const defer = deferNodeMutation ? "defer-node-mutation" : "";
  const actionKey = plugin.name + api + traceId + defer;
  if (boundPluginActionCreators[actionKey]) {
    return boundPluginActionCreators[actionKey];
  } else {
    const keys = Object.keys(boundActionCreators);
    const doubleBoundActionCreators = {};
    for (let i = 0; i < keys.length; i++) {
      const key = keys[i];

      const boundActionCreator = boundActionCreators[key];
      if (typeof boundActionCreator === "function") {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        doubleBoundActionCreators[key] = (...args): any => {
          if (args.length === 0) {
            return boundActionCreator(plugin, actionOptions);
          }

          // Let action callers override who the plugin is. Shouldn't be
          // used that often.
          else if (args.length === 1) {
            return boundActionCreator(args[0], plugin, actionOptions);
          } else if (args.length === 2) {
            return boundActionCreator(args[0], args[1], actionOptions);
          }

          reportOnce(
            `Unhandled redux action: ${key}, in plugin: ${plugin.name}`,
          );

          return undefined;
        };
      }
    }
    boundPluginActionCreators[actionKey] = doubleBoundActionCreators;
    return doubleBoundActionCreators;
  }
}

function initAPICallTracing(
  parentSpan?: opentracing.Span | opentracing.SpanContext | undefined,
): {
  tracer: opentracing.Tracer;
  parentSpan: opentracing.Span | opentracing.SpanContext | undefined;
  startSpan: (
    spanName: string,
    spanArgs?: opentracing.SpanOptions | undefined,
  ) => opentracing.Span;
} {
  const startSpan = (
    spanName: string,
    spanArgs: opentracing.SpanOptions = {},
  ): opentracing.Span => {
    // @ts-ignore - TODO: Remove this once we have a proper typing for opentracing
    // Type '{ childOf: opentracing.Span | opentracing.SpanContext | undefined; }' is not assignable to type 'SpanOptions' with 'exactOptionalPropertyTypes: true'. Consider adding 'undefined' to the types of the target's properties.
    // Types of property 'childOf' are incompatible.
    // Type 'Span | SpanContext | undefined' is not assignable to type 'Span | SpanContext'.
    // Type 'undefined' is not assignable to type 'Span | SpanContext'.ts(2375)
    const defaultSpanArgs: opentracing.SpanOptions = { childOf: parentSpan };

    return tracer.startSpan(spanName, _.merge(defaultSpanArgs, spanArgs));
  };

  return {
    tracer,
    parentSpan,
    startSpan,
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function deferredAction(type): (...args: Array<any>) => void | Promise<void> {
  return (...args): void | Promise<void> => {
    // Regular createNode returns a Promise, but when deferred we need
    // to wrap it in another which we resolve when it's actually called
    if (type === "createNode") {
      return new Promise((resolve) => {
        emitter.emit("ENQUEUE_NODE_MUTATION", {
          type,
          payload: args,
          resolve,
        });
      });
    }

    return emitter.emit("ENQUEUE_NODE_MUTATION", {
      type,
      payload: args,
    });
  };
}

const NODE_MUTATION_ACTIONS = [
  "createNode",
  "deleteNode",
  "touchNode",
  "createParentChildLink",
  "createNodeField",
];

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function deferActions(actions: any): any {
  const deferred = { ...actions };
  NODE_MUTATION_ACTIONS.forEach((action) => {
    deferred[action] = deferredAction(action);
  });
  return deferred;
}

/**
 * Create a local reporter
 * Used to override reporter methods with activity methods
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function getLocalReporter({
  activity,
  reporter,
}: {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  activity: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  reporter: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
}): any {
  // If we have an activity, bind panicOnBuild to the activities method to
  // join them
  if (activity) {
    return { ...reporter, panicOnBuild: activity.panicOnBuild.bind(activity) };
  }

  return reporter;
}

function getErrorMapWithPluginName(
  pluginName: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  errorMap: any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): Record<string, any> {
  const entries = Object.entries(errorMap);

  return entries.reduce((memo, [key, val]) => {
    memo[`${pluginName}_${key}`] = val;

    return memo;
  }, {});
}

function extendLocalReporterToCatchPluginErrors({
  reporter,
  pluginName,
  runningActivities,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
}: {
  reporter: Reporter;
  pluginName: string | undefined;
  runningActivities: Set<{ end: () => void }>;
}): Reporter & {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  setErrorMap: any;
  error: (
    errorMeta: ErrorMeta | Array<ErrorMeta>,
    error?: Error | Array<Error> | undefined,
    pluginName?: string | undefined,
  ) => IStructuredError | Array<IStructuredError>;
  panic: (
    errorMeta: ErrorMeta,
    error?: Error | Array<Error> | undefined,
    pluginName?: string | undefined,
  ) => never;
  panicOnBuild: (
    errorMeta: ErrorMeta,
    error?: Error | Array<Error> | undefined,
    pluginName?: string | undefined,
  ) => IStructuredError | Array<IStructuredError>;
  // If you change arguments here, update reporter.ts as well
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  activityTimer: (text: any, activityArgs?: IActivityArgs | undefined) => any;
  // If you change arguments here, update reporter.ts as well
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  createProgress: (
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    text: any,
    total?: number | undefined,
    start?: number | undefined,
    activityArgs?: IActivityArgs | undefined,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ) => any;
} {
  let setErrorMap;

  let error = reporter.error;
  let panic = reporter.panic;
  let panicOnBuild = reporter.panicOnBuild;

  if (pluginName && reporter?.setErrorMap) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    setErrorMap = (errorMap): any => {
      return reporter.setErrorMap(
        getErrorMapWithPluginName(pluginName, errorMap),
      );
    };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    error = (errorMeta, error): any => {
      reporter.error(errorMeta, error, pluginName);
    };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    panic = (
      errorMeta: ErrorMeta,
      error?: Error | Array<Error> | undefined,
    ): never => {
      return reporter.panic(errorMeta, error, pluginName);
    };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    panicOnBuild = (
      errorMeta: ErrorMeta,
      error?: Error | Array<Error> | undefined,
    ): IStructuredError | Array<IStructuredError> => {
      return reporter.panicOnBuild(errorMeta, error, pluginName);
    };
  }

  return Object.assign({}, reporter, {
    setErrorMap,
    error,
    panic,
    panicOnBuild,
    // If you change arguments here, update reporter.ts as well
    activityTimer: (
      text: string,
      activityArgs: IActivityArgs | undefined = {},
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ): ITimerReporter => {
      let args: [
        text: string,
        activityArg: IActivityArgs,
        pluginName?: string | undefined,
      ] = [text, activityArgs];

      if (pluginName && setErrorMap) {
        // @ts-ignore weird ts issue, code is vslid
        // Type '[text: string, activityArg: IActivityArgs, pluginName: string | undefined, string]' is not assignable to type '[text: string, activityArg: IActivityArgs, pluginName?: string | undefined]'.
        // Source has 4 element(s) but target allows only 3.ts(2322)
        args = [...args, pluginName];
      }

      const activity = reporter.activityTimer(...args);

      const originalStart = activity.start;
      const originalEnd = activity.end;

      activity.start = (): void => {
        originalStart.apply(activity);
        runningActivities.add(activity);
      };

      activity.end = (): void => {
        originalEnd.apply(activity);
        runningActivities.delete(activity);
      };

      return activity;
    },
    // If you change arguments here, update reporter.ts as well
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    createProgress: (
      text: string,
      total: number | undefined = 0,
      start: number | undefined = 0,
      activityArgs: IActivityArgs | undefined = {},
    ): IProgressReporter => {
      let args:
        | [
            text: string,
            total: number | undefined,
            start: number | undefined,
            activityArgs: IActivityArgs,
          ]
        | [
            text: string,
            total: number | undefined,
            start: number | undefined,
            activityArgs: IActivityArgs,
            pluginName?: string | undefined,
          ] = [text, total, start, activityArgs];

      if (pluginName && setErrorMap) {
        // @ts-ignore weird ts issue, code is vslid
        // Type '[text: string, total: number | undefined, start: number | undefined, activityArgs: IActivityArgs | undefined, pluginName: string | undefined, string]' is not assignable to type '[text: string, total?: number | undefined, start?: number | undefined, activityArgs?: IActivityArgs | undefined, pluginName?: string | undefined]'.
        // Source has 6 element(s) but target allows only 5.ts(2322)
        args = [...args, pluginName];
      }

      // eslint-disable-next-line prefer-spread
      const activity = reporter.createProgress.apply(reporter, args);

      const originalStart = activity.start;
      const originalEnd = activity.end;
      const originalDone = activity.done;

      activity.start = (): void => {
        originalStart.apply(activity);
        runningActivities.add(activity);
      };

      activity.end = (): void => {
        originalEnd.apply(activity);
        runningActivities.delete(activity);
      };

      activity.done = (): void => {
        originalDone.apply(activity);
        runningActivities.delete(activity);
      };

      return activity;
    },
  });
}

function getUninitializedCache(plugin: string): {
  get(): globalThis.Promise<never>;
  set(): globalThis.Promise<never>;
  del(): globalThis.Promise<never>;
} {
  const message =
    'Usage of "cache" instance in "onPreInit" API is not supported as ' +
    "this API runs before cache initialization" +
    (plugin && plugin !== "default-site-plugin"
      ? ` (called in ${plugin})`
      : "");

  return {
    // GatsbyCache
    async get(): globalThis.Promise<never> {
      throw new Error(message);
    },
    async set(): globalThis.Promise<never> {
      throw new Error(message);
    },
    async del(): globalThis.Promise<never> {
      throw new Error(message);
    },
  };
}

const availableActionsCache = new Map();

let publicPath;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function runAPI(plugin, api, args, activity): globalThis.Promise<any> {
  const gatsbyNode = await importGatsbyPlugin(plugin, "gatsby-node");

  if (gatsbyNode[api]) {
    const parentSpan = args && args.parentSpan;
    const spanOptions = parentSpan ? { childOf: parentSpan } : {};
    const pluginSpan = tracer.startSpan("run-plugin", spanOptions);

    pluginSpan.setTag("api", api);
    pluginSpan.setTag("plugin", plugin.name);

    let availableActions;
    if (availableActionsCache.has(api)) {
      availableActions = availableActionsCache.get(api);
    } else {
      availableActions = {
        ...publicActions,
        ...(restrictedActionsAvailableInAPI[api] ?? {}),
      };

      availableActionsCache.set(api, availableActions);
    }

    let boundActionCreators = bindActionCreators(
      availableActions,
      store.dispatch,
    );

    if (args.deferNodeMutation) {
      boundActionCreators = deferActions(boundActionCreators);
    }

    const doubleBoundActionCreators = doubleBind(
      boundActionCreators,
      api,
      plugin,
      { ...args, parentSpan: pluginSpan, activity },
    );

    const { config, program } = store.getState();

    const pathPrefix = (program.prefixPaths && config.pathPrefix) || "";

    if (typeof publicPath === "undefined") {
      publicPath = getPublicPath({ ...config, ...program });
    }

    function namespacedCreateNodeId(id: string | number): string {
      return createNodeId(id, plugin.name);
    }

    const tracing = initAPICallTracing(pluginSpan);

    // See https://github.com/gatsbyjs/gatsby/issues/11369
    const cache =
      api === "onPreInit"
        ? getUninitializedCache(plugin.name)
        : getCache(plugin.name);

    // Ideally this would be more abstracted and applied to more situations, but right now
    // this can be potentially breaking so targeting `createPages` API and `createPage` action
    let actions = doubleBoundActionCreators;
    let apiFinished = false;
    if (api === "createPages") {
      let alreadyDisplayed = false;
      const createPageAction = actions.createPage;
      // create new actions object with wrapped createPage action
      // doubleBoundActionCreators is memoized, so we can't just
      // reassign createPage field as this would cause this extra logic
      // to be used in subsequent APIs and we only want to target this `createPages` call.
      actions = {
        ...actions,
        createPage: (...args): void => {
          createPageAction(...args);

          if (apiFinished && !alreadyDisplayed) {
            const warning = [
              reporter.stripIndent(`
              Action ${chalk.bold(
                "createPage",
              )} was called outside of its expected asynchronous lifecycle ${chalk.bold(
                "createPages",
              )} in ${chalk.bold(plugin.name)}.
              Ensure that you return a Promise from ${chalk.bold(
                "createPages",
              )} and are awaiting any asynchronous method invocations (like ${chalk.bold(
                "graphql",
              )} or http requests).
              For more info and debugging tips: see ${chalk.bold(
                "https://gatsby.dev/sync-actions",
              )}
            `),
            ];

            const possiblyCodeFrame = getNonGatsbyCodeFrameFormatted();
            if (possiblyCodeFrame) {
              warning.push(possiblyCodeFrame);
            }

            reporter.warn(warning.join("\n\n"));
            alreadyDisplayed = true;
          }
        },
      };
    }

    const localReporter = getLocalReporter({ activity, reporter });

    const runningActivities = new Set<{ end: () => void }>();

    const extendedLocalReporter = extendLocalReporterToCatchPluginErrors({
      reporter: localReporter,
      pluginName: plugin.name,
      runningActivities,
    });

    function endInProgressActivitiesCreatedByThisRun(): void {
      runningActivities.forEach((activity) => {
        return activity.end();
      });
    }

    const shouldDetectNodeMutations = [
      "sourceNodes",
      "onCreateNode",
      "createResolvers",
      "createSchemaCustomization",
      "setFieldsOnGraphQLNodeType",
    ].includes(api);

    const apiCallArgs = [
      {
        ...args,
        parentSpan: pluginSpan,
        basePath: pathPrefix,
        pathPrefix: publicPath,
        actions,
        loadNodeContent,
        store,
        emitter,
        getCache,
        getNodes: shouldDetectNodeMutations
          ? nodeMutationsWrappers.getNodes
          : getNodes,
        getNode: shouldDetectNodeMutations
          ? nodeMutationsWrappers.getNode
          : getNode,
        getNodesByType: shouldDetectNodeMutations
          ? nodeMutationsWrappers.getNodesByType
          : getNodesByType,
        reporter: extendedLocalReporter,
        getNodeAndSavePathDependency: shouldDetectNodeMutations
          ? nodeMutationsWrappers.getNodeAndSavePathDependency
          : getNodeAndSavePathDependency,
        cache,
        createNodeId: namespacedCreateNodeId,
        createContentDigest,
        tracing,
        schema: {
          buildObjectType,
          buildUnionType,
          buildInterfaceType,
          buildInputObjectType,
          buildEnumType,
          buildScalarType,
        },
      },
      plugin.pluginOptions,
    ];

    // If the plugin is using a callback use that otherwise
    // expect a Promise to be returned.
    if (gatsbyNode[api].length === 3) {
      return Promise.fromCallback((callback) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        function cb(err: any, val: unknown): void {
          pluginSpan.finish();
          apiFinished = true;
          endInProgressActivitiesCreatedByThisRun();
          callback(err, val);
        }

        try {
          gatsbyNode[api](...apiCallArgs, cb);
        } catch (e) {
          trackBuildError(api, {
            error: e,
            pluginName: `${plugin.name}@${plugin.version}`,
          });
          throw e;
        }
      });
    } else {
      try {
        return await gatsbyNode[api](...apiCallArgs);
      } finally {
        pluginSpan.finish();
        apiFinished = true;
        endInProgressActivitiesCreatedByThisRun();
      }
    }
  }

  return null;
}

const apisRunningById = new Map();
const apisRunningByTraceId = new Map();
let waitingForCasacadeToFinish: Array<ApiRunInstance> = [];

export function apiRunnerNode(
  api: GatsbyNodeAPI,
  args: {
    app?: express.Express | undefined;
    graphql?: Runner | undefined;
    getConfig?: (() => webpack.Configuration) | undefined;
    pluginName?: string | undefined;
    parentSpan?: Span | SpanContext | undefined;
    traceId?: string | undefined;
    stage?: Stage | undefined;
    rules?: IRuleUtils | undefined;
    loaders?: ILoaderUtils | undefined;
    plugins?: PluginUtils | undefined;
    webhookBody?: unknown | undefined;
    traceTags?: Record<string, string> | undefined;
    waitForCascadingActions?: boolean | undefined;
    type?: { name?: string | undefined } | undefined;
    page?: { path?: string | undefined } | undefined;
    filename?: string | undefined;
    contents?: string | undefined;
    node?: IGatsbyNode | undefined;
    deferNodeMutation?: boolean | undefined;
  } = {},
  {
    pluginSource,
    activity,
  }: {
    pluginSource?: GatsbyNodeAPI | undefined;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    activity?: any | undefined;
  } = {},
): Promise<unknown> | null {
  const plugins: IGatsbyState["flattenedPlugins"] =
    store.getState().flattenedPlugins;

  // Get the list of plugins that implement this API.
  // Also: Break infinite loops. Sometimes a plugin will implement an API and
  // call an action which will trigger the same API being called.
  // `onCreatePage` is the only example right now. In these cases, we should
  // avoid calling the originating plugin again.
  let implementingPlugins = plugins.filter((plugin) => {
    return plugin.nodeAPIs.includes(api) && plugin.name !== pluginSource;
  });

  if (api === "sourceNodes" && args.pluginName) {
    implementingPlugins = implementingPlugins.filter(
      (plugin) => plugin.name === args.pluginName,
    );
  }

  // If there's no implementing plugins, return early.
  if (implementingPlugins.length === 0) {
    return null;
  }

  return new Promise((resolve) => {
    const { parentSpan, traceId, traceTags, waitForCascadingActions } = args;
    const apiSpanArgs = parentSpan ? { childOf: parentSpan } : {};
    const apiSpan = tracer.startSpan("run-api", apiSpanArgs);

    apiSpan.setTag("api", api);
    _.forEach(traceTags, (value, key) => {
      apiSpan.setTag(key, value);
    });

    const apiRunInstance: ApiRunInstance = {
      api,
      args,
      pluginSource,
      resolve,
      span: apiSpan,
      startTime: new Date().toJSON(),
      traceId,
    };

    // Generate IDs for api runs. Most IDs we generate from the args
    // but some API calls can have very large argument objects so we
    // have special ways of generating IDs for those to avoid stringifying
    // large objects.
    let id: string | undefined;
    if (api === "setFieldsOnGraphQLNodeType") {
      id = `${api}${apiRunInstance.startTime}${args.type?.name ?? ""}${traceId}`;
    } else if (api === "onCreateNode") {
      id = `${api}${apiRunInstance.startTime}${args.node?.internal.contentDigest ?? ""}${traceId}`;
    } else if (api === "preprocessSource") {
      id = `${api}${apiRunInstance.startTime}${args.filename ?? ""}${traceId}`;
    } else if (api === "onCreatePage") {
      id = `${api}${apiRunInstance.startTime}${args.page?.path ?? ""}${traceId}`;
    } else {
      // When tracing is turned on, the `args` object will have a
      // `parentSpan` field that can be quite large. So we omit it
      // before calling stringify
      const argsJson = JSON.stringify(_.omit(args, "parentSpan"));
      id = `${api}|${apiRunInstance.startTime}|${apiRunInstance.traceId}|${argsJson}`;
    }
    apiRunInstance.id = id;

    if (waitForCascadingActions) {
      waitingForCasacadeToFinish.push(apiRunInstance);
    }

    if (apisRunningById.size === 0) {
      // TODO: there is no on handler for this event
      // @ts-ignore Argument of type '"API_RUNNING_START"' is not assignable to parameter of type
      emitter.emit("API_RUNNING_START");
    }

    apisRunningById.set(apiRunInstance.id, apiRunInstance);
    if (apisRunningByTraceId.has(apiRunInstance.traceId)) {
      const currentCount = apisRunningByTraceId.get(apiRunInstance.traceId);
      apisRunningByTraceId.set(apiRunInstance.traceId, currentCount + 1);
    } else {
      apisRunningByTraceId.set(apiRunInstance.traceId, 1);
    }

    let stopQueuedApiRuns = false;

    let onAPIRunComplete: (() => void) | null = null;

    if (api === "onCreatePage") {
      const path = args.page?.path;

      function actionHandler(action: {
        payload: { path: string | undefined };
      }): void {
        if (action.payload.path === path) {
          stopQueuedApiRuns = true;
        }
      }

      emitter.on("DELETE_PAGE", actionHandler);
      onAPIRunComplete = (): void => {
        emitter.off("DELETE_PAGE", actionHandler);
      };
    }

    let apiRunPromiseOptions: { concurrency?: number | undefined } | undefined =
      {};

    let runPromise;

    if (
      api === "sourceNodes" &&
      process.env.GATSBY_EXPERIMENTAL_PARALLEL_SOURCING
    ) {
      runPromise = Promise.map;
      apiRunPromiseOptions.concurrency = 20;
    } else {
      runPromise = Promise.mapSeries;
      apiRunPromiseOptions = undefined;
    }

    runPromise(
      implementingPlugins,
      (plugin: FlattenedPlugin) => {
        if (stopQueuedApiRuns) {
          return null;
        }

        return importGatsbyPlugin(plugin, "gatsby-node").then((gatsbyNode) => {
          const pluginName =
            plugin.name === "default-site-plugin"
              ? "gatsby-node.js"
              : plugin.name;

          // TODO: rethink createNode API to handle this better
          if (
            api === "onCreateNode" &&
            gatsbyNode?.shouldOnCreateNode && // Don't bail if this api is not exported
            !gatsbyNode.shouldOnCreateNode(
              { node: args.node },
              plugin.pluginOptions,
            )
          ) {
            // Do not try to schedule an async event for this node for this plugin
            return null;
          }

          return new Promise((resolve) => {
            resolve(
              runAPI(plugin, api, { ...args, parentSpan: apiSpan }, activity),
            );
          }).catch((err) => {
            decorateEvent("BUILD_PANIC", {
              pluginName: `${plugin.name}@${plugin.version}`,
            });

            const localReporter = getLocalReporter({ activity, reporter });

            const file = stackTrace
              .parse(err)
              // @ts-ignore Property 'fileName' does not exist on type 'StackFrame'.ts(2339)
              .find((file) => /gatsby-node/.test(file.fileName));

            let codeFrame = "";
            const structuredError = errorParser({ err });

            if (file) {
              // @ts-ignore Property 'fileName' does not exist on type 'StackFrame'.ts(2339)
              // Property 'lineNumber' does not exist on type 'StackFrame'.ts(2339)
              // Property 'columnNumber' does not exist on type 'StackFrame'.ts(2339)
              const { fileName, lineNumber: line, columnNumber: column } = file;
              const trimmedFileName = fileName.match(/^(async )?(.*)/)[2];

              try {
                const code = fs.readFileSync(trimmedFileName, {
                  encoding: "utf-8",
                });
                codeFrame = codeFrameColumns(
                  code,
                  {
                    start: {
                      line,
                      column,
                    },
                  },
                  {
                    highlightCode: true,
                  },
                );
              } catch (_e) {
                // sometimes stack trace point to not existing file
                // particularly when file is transpiled and path actually changes
                // (like pointing to not existing `src` dir or original typescript file)
              }

              structuredError.location = {
                start: { line: line, column: column },
              };
              structuredError.filePath = fileName;
            }

            structuredError.context = {
              ...structuredError.context,
              pluginName,
              api,
              codeFrame,
            };

            localReporter.panicOnBuild(structuredError);

            return null;
          });
        });
      },
      apiRunPromiseOptions,
    ).then((results) => {
      if (onAPIRunComplete) {
        onAPIRunComplete();
      }
      // Remove runner instance
      apisRunningById.delete(apiRunInstance.id);
      const currentCount = apisRunningByTraceId.get(apiRunInstance.traceId);
      apisRunningByTraceId.set(apiRunInstance.traceId, currentCount - 1);

      if (apisRunningById.size === 0) {
        emitter.emit("API_RUNNING_QUEUE_EMPTY");
      }

      // Filter empty results
      // @ts-ignore Property 'results' does not exist on type 'ApiRunInstance'.ts(2339)
      apiRunInstance.results = results.filter((result) => !_.isEmpty(result));

      // Filter out empty responses and return if the
      // api caller isn't waiting for cascading actions to finish.
      if (!waitForCascadingActions) {
        apiSpan.finish();
        // @ts-ignore Property 'results' does not exist on type 'ApiRunInstance'.ts(2339)
        resolve(apiRunInstance.results);
      }

      // Check if any of our waiters are done.
      waitingForCasacadeToFinish = waitingForCasacadeToFinish.filter(
        (instance) => {
          // If none of its trace IDs are running, it's done.
          const apisByTraceIdCount = apisRunningByTraceId.get(instance.traceId);

          if (apisByTraceIdCount === 0) {
            instance.span.finish();
            // @ts-ignore Property 'results' does not exist on type 'ApiRunInstance'.ts(2339)
            instance.resolve(instance.results);
            return false;
          } else {
            return true;
          }
        },
      );
      return;
    });
  });
}
