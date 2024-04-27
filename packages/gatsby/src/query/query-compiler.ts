/** Query compiler extracts queries and fragments from all files, validates them
 * and then collocates them with fragments they require. This way fragments
 * have global scope and can be used in any other query or fragment.
 */

// eslint-disable-next-line @typescript-eslint/naming-convention
import _ from "lodash";

import path from "node:path";
import normalize from "normalize-path";
import glob from "glob";

import {
  validate,
  print,
  visit,
  // visitWithTypeInfo,
  // TypeInfo,
  // isAbstractType,
  Kind,
  FragmentsOnCompositeTypesRule,
  LoneAnonymousOperationRule,
  PossibleFragmentSpreadsRule,
  ScalarLeafsRule,
  ValuesOfCorrectTypeRule,
  VariablesAreInputTypesRule,
  VariablesInAllowedPositionRule,
  type DocumentNode,
} from "graphql";

import { getGatsbyDependents } from "../utils/gatsby-dependents";
import { store } from "../redux";
import { actions } from "../redux/actions";

import { websocketManager } from "../utils/websocket-manager";
import { getPathToLayoutComponent } from "gatsby-core-utils";
import { tranformDocument } from "./transform-document";
import { default as FileParser } from "./file-parser";
import {
  graphqlError,
  multipleRootQueriesError,
  duplicateFragmentError,
  unknownFragmentError,
} from "./graphql-errors";
import report from "gatsby-cli/lib/reporter";
import {
  default as errorParser,
  locInGraphQlToLocInFile,
} from "./error-parser";
import type { Span, SpanContext } from "opentracing";

const overlayErrorID = "graphql-compiler";

export default async function compile({
  parentSpan,
}: { parentSpan?: Span | SpanContext | undefined } = {}): Promise<
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  Map<string, any>
> {
  const { program, schema, flattenedPlugins } = store.getState();

  const activity = report.activityTimer("extract queries from components", {
    parentSpan,
    id: "query-extraction",
  });
  activity.start();

  const errors = [];
  const addError = errors.push.bind(errors);

  const parsedQueries = await parseQueries({
    base: program.directory,
    additional: resolveThemes(
      flattenedPlugins.map((plugin) => {
        return {
          themeDir: plugin.pluginFilepath,
        };
      }),
    ),
    addError,
    parentSpan: activity.span,
  });

  const queries = processQueries({
    schema,
    parsedQueries,
    addError,
    // parentSpan: activity.span,
  });

  if (errors.length !== 0) {
    const structuredErrors = activity.panicOnBuild(errors);
    if (process.env.gatsby_executing_command === "develop") {
      websocketManager.emitError(overlayErrorID, structuredErrors);
    }
  } else {
    if (process.env.gatsby_executing_command === "develop") {
      // emitError with `null` as 2nd param to clear browser error overlay
      websocketManager.emitError(overlayErrorID, null);
    }
  }
  activity.end();

  return queries;
}

export function resolveThemes(
  themes: Array<{ themeDir: string }> = [],
): Array<string> {
  return themes.reduce((merged: Array<string>, theme) => {
    merged.push(theme.themeDir);
    return merged;
  }, []);
}

export async function parseQueries({
  base,
  additional,
  addError,
  parentSpan,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
}): Promise<Array<any>> {
  const filesRegex = "*.?(m|c)+(t|j)s?(x)";
  // Pattern that will be appended to searched directories.
  // It will match any .js, .jsx, .ts, .tsx, .cjs, .cjsx,
  // .cts, .ctsx, .mjs, .mjsx, .mts, and .mtsx files,
  // that are not inside <searched_directory>/node_modules.
  const pathRegex = `/{${filesRegex},!(node_modules)/**/${filesRegex}}`;

  const modulesThatUseGatsby = await getGatsbyDependents();

  let files = [
    path.join(base, "src"),
    path.join(base, ".cache", "fragments"),
    ...additional.map((additional) => path.join(additional, "src")),
    ...modulesThatUseGatsby.map((module) => module.path),
  ].reduce((merged, folderPath) => {
    merged.push(
      ...glob.sync(path.join(folderPath, pathRegex), {
        nodir: true,
      }),
    );
    return merged;
  }, []);

  files = files.filter((d) => !d.match(/\.d\.ts$/));

  files = files.map(normalize);

  // We should be able to remove the following and preliminary tests do suggest
  // that they aren't needed anymore since we transpile node_modules now
  // However, there could be some cases (where a page is outside of src for example)
  // that warrant keeping this and removing later once we have more confidence (and tests)
  // Ensure all page components added as they're not necessarily in the
  // pages directory e.g. a plugin could add a page component. Plugins
  // *should* copy their components (if they add a query) to .cache so that
  // our babel plugin to remove the query on building is active.
  // Otherwise the component will throw an error in the browser of
  // "graphql is not defined".
  files = files.concat(
    Array.from(store.getState().components.keys(), (c) => normalize(c)),
  );

  files = _.uniq(files);

  const parser = new FileParser({ parentSpan: parentSpan });

  return await parser.parseFiles(files, addError);
}

export function processQueries({
  schema,
  parsedQueries,
  addError,
}: {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  schema: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  parsedQueries: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  addError: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
}): Map<any, any> {
  const { definitionsByName, operations } = extractOperations(
    schema,
    parsedQueries,
    addError,
  );

  store.dispatch(actions.setGraphQLDefinitions(definitionsByName));

  return processDefinitions({
    schema,
    operations,
    definitionsByName,
    addError,
  });
}

const preValidationRules = [
  LoneAnonymousOperationRule,
  FragmentsOnCompositeTypesRule,
  VariablesAreInputTypesRule,
  ScalarLeafsRule,
  PossibleFragmentSpreadsRule,
  ValuesOfCorrectTypeRule,
  VariablesInAllowedPositionRule,
];

type Operation = {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  def: any;
  filePath: string;
  templatePath: string;
  hash: string;
};

function extractOperations(
  schema,
  parsedQueries,
  addError,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): { definitionsByName: Map<any, any>; operations: Array<Operation> } {
  const definitionsByName = new Map();
  const operations: Array<Operation> = [];

  for (const {
    filePath,
    text,
    templateLoc,
    hash,
    doc: originalDoc,
    isHook,
    isStaticQuery,
    isConfigQuery,
  } of parsedQueries) {
    let doc = originalDoc;

    let errors = validate(schema, doc, preValidationRules);
    if (errors && errors.length) {
      const originalQueryText = print(originalDoc);
      const { ast: transformedDocument, hasChanged } = tranformDocument(doc);
      if (hasChanged) {
        const newErrors = validate(
          schema,
          transformedDocument,
          preValidationRules,
        );
        if (newErrors.length === 0) {
          report.warn(
            `Deprecated syntax of sort and/or aggregation field arguments were found in your query (see https://gatsby.dev/graphql-nested-sort-and-aggregate). Query was automatically converted to a new syntax. You should update query in your code.\n\nFile: ${filePath}\n\nCurrent query:\n\n${originalQueryText}\n\nConverted query:\n\n${print(
              transformedDocument,
            )}`,
          );
          doc = transformedDocument;
          errors = newErrors;
        }
      }
    }

    if (errors && errors.length) {
      addError(
        ...errors.map((error) => {
          const location = {
            start: locInGraphQlToLocInFile(templateLoc, error.locations?.[0]),
          };
          return errorParser({
            message: error.message,
            filePath,
            location,
            error,
          });
        }),
      );

      store.dispatch(
        actions.queryExtractionGraphQLError({
          componentPath: filePath,
        }),
      );
      // Something is super wrong with this document, so we report it and skip
      continue;
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    doc.definitions.forEach((def: any) => {
      const name = def.name.value;

      let printedAst: string | null = null;

      if (def.kind === Kind.OPERATION_DEFINITION) {
        operations.push({
          def,
          filePath,
          templatePath: getPathToLayoutComponent(filePath),
          hash,
        });
      } else if (def.kind === Kind.FRAGMENT_DEFINITION) {
        // Check if we already registered a fragment with this name
        printedAst = print(def);
        if (definitionsByName.has(name)) {
          const otherDef = definitionsByName.get(name);
          // If it's not an accidental duplicate fragment, but is a different
          // one - we report an error
          if (printedAst !== otherDef.printedAst) {
            addError(
              duplicateFragmentError({
                name,
                leftDefinition: {
                  def,
                  filePath,
                  text,
                  templateLoc,
                },
                rightDefinition: otherDef,
              }),
            );
            // We won't know which one to use, so it's better to fail both of
            // them.
            definitionsByName.delete(name);
          }
          return;
        }
      }

      definitionsByName.set(name, {
        name,
        def,
        filePath,
        text: text,
        templateLoc,
        printedAst,
        isHook,
        isStaticQuery,
        isConfigQuery,
        isFragment: def.kind === Kind.FRAGMENT_DEFINITION,
        hash: hash,
        templatePath: getPathToLayoutComponent(filePath),
      });
    });
  }

  return {
    definitionsByName,
    operations,
  };
}

function processDefinitions({
  schema,
  operations,
  definitionsByName,
  addError,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
}): Map<any, any> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const processedQueries: Map<any, any> = new Map();

  const fragmentsUsedByFragment = new Map();

  const fragmentNames = Array.from(definitionsByName.entries())
    // @ts-ignore Types of parameters '__0' and 'value' are incompatible. Type 'unknown' is not assignable to type '[any, any]'.ts(2769)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unused-vars
    .filter(([_, def]): any => def.isFragment)
    // @ts-ignore Types of parameters '__0' and 'value' are incompatible. Type 'unknown' is not assignable to type '[any, any]'.ts(2345)
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    .map(([name, _]) => {
      return name;
    });

  for (const operation of operations) {
    const { filePath, templatePath, def } = operation;
    const name = def.name.value;
    const originalDefinition = definitionsByName.get(name);

    const { usedFragments, missingFragments } =
      determineUsedFragmentsForDefinition(
        originalDefinition,
        definitionsByName,
        fragmentsUsedByFragment,
      );

    if (missingFragments.length > 0) {
      for (const { filePath, definition, node } of missingFragments) {
        store.dispatch(
          actions.queryExtractionGraphQLError({
            componentPath: filePath,
          }),
        );
        addError(
          unknownFragmentError({
            fragmentNames,
            filePath,
            definition,
            node,
          }),
        );
      }
      continue;
    }

    const document: DocumentNode = {
      kind: Kind.DOCUMENT,
      definitions: Array.from(usedFragments.values())
        .map((name) => definitionsByName.get(name).def)
        .concat([operation.def]),
    };

    const errors = validate(schema, document);

    if (errors && errors.length) {
      for (const error of errors) {
        const { formattedMessage, message } = graphqlError(
          definitionsByName,
          error,
        );

        const filePath = originalDefinition.filePath;
        store.dispatch(
          actions.queryExtractionGraphQLError({
            componentPath: filePath,
            error: formattedMessage,
          }),
        );
        const location = locInGraphQlToLocInFile(
          originalDefinition.templateLoc,
          error.locations?.[0],
        );
        addError(
          errorParser({
            location: {
              start: location,
              end: location,
            },
            message,
            filePath,
            error,
          }),
        );
      }
      continue;
    }

    const printedDocument = print(document);
    // Check for duplicate page/static queries in the same component.
    // (config query is not a duplicate of page/static query in the component)
    // TODO: make sure there is at most one query type per component (e.g. one config + one page)
    if (processedQueries.has(filePath) && !originalDefinition.isConfigQuery) {
      const otherQuery = processedQueries.get(filePath);

      if (
        templatePath !== otherQuery.templatePath ||
        printedDocument !== otherQuery.text
      ) {
        addError(
          multipleRootQueriesError(
            filePath,
            originalDefinition.def,
            otherQuery && definitionsByName.get(otherQuery.name).def,
          ),
        );

        store.dispatch(
          actions.queryExtractionGraphQLError({
            componentPath: filePath,
          }),
        );
        continue;
      }
    }

    const query = {
      name,
      text: printedDocument,
      originalText: originalDefinition.text,
      path: filePath,
      isHook: originalDefinition.isHook,
      isStaticQuery: originalDefinition.isStaticQuery,
      isConfigQuery: originalDefinition.isConfigQuery,
      templatePath,
      // ensure hash should be a string and not a number
      hash: String(originalDefinition.hash),
    };

    if (query.isStaticQuery) {
      // @ts-ignore Property 'id' does not exist on type '{ name: any; text: string; originalText: any; path: any; isHook: any; isStaticQuery: any; isConfigQuery: any; templatePath: any; hash: string; }'.ts(2339)
      query.id =
        "sq--" +
        _.kebabCase(
          `${path.relative(store.getState().program.directory, filePath)}`,
        );
    }

    if (
      query.isHook &&
      process.env.NODE_ENV === "production" &&
      typeof require("react").useContext !== "function"
    ) {
      report.panicOnBuild(
        "You're likely using a version of React that doesn't support Hooks\n" +
          "Please update React and ReactDOM to 16.8.0 or later to use the useStaticQuery hook.",
      );
    }

    // Our current code only supports single graphql query per file (page or static query per file)
    // So, not adding config query because it can overwrite existing page query
    // TODO: allow multiple queries in single file, while preserving limitation of a single page query per file
    if (!query.isConfigQuery) {
      processedQueries.set(filePath, query);
    }
  }

  return processedQueries;
}

function determineUsedFragmentsForDefinition(
  definition: {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    def: any;
    name: string;
    isFragment: boolean;
    filePath: string;
  },
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  definitionsByName: Map<string, any>,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  fragmentsUsedByFragment: any,
  traversalPath: Array<string> | undefined = [],
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): { usedFragments: any; missingFragments: any } {
  const { def, name, isFragment, filePath } = definition;
  const cachedUsedFragments = fragmentsUsedByFragment.get(name);
  if (cachedUsedFragments) {
    return { usedFragments: cachedUsedFragments, missingFragments: [] };
  } else {
    const usedFragments = new Set();
    const missingFragments: Array<{
      filePath: string;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      definition: any;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      node: any;
    }> = [];
    visit(def, {
      [Kind.FRAGMENT_SPREAD]: (node) => {
        const name = node.name.value;
        const fragmentDefinition = definitionsByName.get(name);
        if (fragmentDefinition) {
          if (traversalPath.includes(name)) {
            // Already visited this fragment during current traversal.
            //   Visiting it again will cause a stack overflow
            return;
          }
          traversalPath.push(name);
          usedFragments.add(name);
          const {
            usedFragments: usedFragmentsForFragment,
            missingFragments: missingFragmentsForFragment,
          } = determineUsedFragmentsForDefinition(
            fragmentDefinition,
            definitionsByName,
            fragmentsUsedByFragment,
            traversalPath,
          );
          traversalPath.pop();
          usedFragmentsForFragment.forEach((fragmentName) =>
            usedFragments.add(fragmentName),
          );
          missingFragments.push(...missingFragmentsForFragment);
        } else {
          missingFragments.push({
            filePath,
            definition,
            node,
          });
        }
      },
    });
    if (isFragment) {
      fragmentsUsedByFragment.set(name, usedFragments);
    }
    return { usedFragments, missingFragments };
  }
}
