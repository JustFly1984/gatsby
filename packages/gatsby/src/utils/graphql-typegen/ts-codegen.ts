import * as fs from "fs-extra";
import { join } from "path";
import { codegen } from "@graphql-codegen/core";
import { GraphQLSchema, Kind } from "graphql";
import type { Types } from "@graphql-codegen/plugin-helpers";
import type { TypeScriptPluginConfig } from "@graphql-codegen/typescript";
import type { TypeScriptDocumentsPluginConfig } from "@graphql-codegen/typescript-operations";
import { CodeFileLoader } from "@graphql-tools/code-file-loader";
import { loadDocuments } from "@graphql-tools/load";
import type {
  IDefinitionMeta,
  IStateProgram,
  IGraphQLTypegenOptions,
} from "../../redux/types";
import {
  filterTargetDefinitions,
  sortDefinitions,
  stabilizeSchema,
} from "./utils";

export const DEFAULT_TYPES_OUTPUT_PATH = "src/gatsby-types.d.ts";
export const DEFAULT_DOCUMENT_SEARCH_PATHS = [
  "./gatsby-node.ts",
  "./plugins/**/gatsby-node.ts",
];
const NAMESPACE = "Queries";

// These override the defaults from
// https://www.graphql-code-generator.com/plugins/typescript
const DEFAULT_TYPESCRIPT_CONFIG: Readonly<TypeScriptPluginConfig> = {
  // <Maybe> Type is enough
  avoidOptionals: true,
  // Types come from the data layer so they can't be modified
  immutableTypes: true,
  // TODO: Better maybeValue
  maybeValue: "T | null",
  // We'll want to re-export ourselves
  noExport: true,
  // Recommended for .d.ts files
  enumsAsTypes: true,
  scalars: {
    Date: "string",
    JSON: "Record<string, unknown>",
    GatsbyImageData: "import('gatsby-plugin-image').IGatsbyImageData",
  },
  // import type {} syntax is nicer
  useTypeImports: true,
};

const DEFAULT_TYPESCRIPT_OPERATIONS_CONFIG: Readonly<TypeScriptDocumentsPluginConfig> =
  {
    ...DEFAULT_TYPESCRIPT_CONFIG,
    exportFragmentSpreadSubTypes: true,
  };

export async function writeTypeScriptTypes(
  directory: IStateProgram["directory"],
  schema: GraphQLSchema,
  definitions: Map<string, IDefinitionMeta>,
  graphqlTypegenOptions: IGraphQLTypegenOptions,
): Promise<void> {
  const pluginConfig: Pick<Types.GenerateOptions, "plugins" | "pluginMap"> = {
    pluginMap: {
      add: require("@graphql-codegen/add"),
      typescript: require("@graphql-codegen/typescript"),
      typescriptOperations: require("@graphql-codegen/typescript-operations"),
    },
    plugins: [
      {
        add: {
          placement: "prepend",
          content: "/* eslint-disable */\n",
        },
      },
      {
        add: {
          placement: "prepend",
          content: "/* prettier-ignore */\n",
        },
      },
      {
        add: {
          placement: "prepend",
          content:
            "/* THIS FILE IS AUTOGENERATED. CHANGES WILL BE LOST ON SUBSEQUENT RUNS. */\n",
        },
      },
      {
        add: {
          placement: "prepend",
          content: `declare namespace ${NAMESPACE} {\n`,
        },
      },
      {
        typescript: DEFAULT_TYPESCRIPT_CONFIG,
      },
      {
        typescriptOperations: DEFAULT_TYPESCRIPT_OPERATIONS_CONFIG,
      },
      {
        add: {
          placement: "append",
          content: "\n}\n",
        },
      },
    ],
  };

  const filename = join(directory, graphqlTypegenOptions.typesOutputPath);

  let gatsbyNodeDocuments: Array<Types.DocumentFile> = [];
  // The loadDocuments + CodeFileLoader looks for graphql(``) functions inside the gatsby-node.ts files
  // And then extracts the queries into documents
  // TODO: This codepath can be made obsolete if Gatsby itself already places the queries inside gatsby-node into the `definitions`
  try {
    gatsbyNodeDocuments = await loadDocuments(
      graphqlTypegenOptions.documentSearchPaths,
      {
        loaders: [
          new CodeFileLoader({
            // Configures https://www.graphql-tools.com/docs/graphql-tag-pluck to only check graphql function from Gatsby
            pluckConfig: {
              modules: [{ name: "gatsby", identifier: "graphql" }],
            },
          }),
        ],
        sort: true,
      },
    );
  } catch (e) {
    // These files might not exist, so just skip this
  }

  const documents: Array<Types.DocumentFile> = [
    ...filterTargetDefinitions(definitions).values(),
  ]
    .sort(sortDefinitions)
    .map((definitionMeta) => {
      return {
        document: {
          kind: Kind.DOCUMENT,
          definitions: [definitionMeta.def],
        },
        hash: definitionMeta.hash.toString(),
      };
    });

  const codegenOptions: Omit<Types.GenerateOptions, "plugins" | "pluginMap"> = {
    // @ts-ignore - Incorrect types
    schema: undefined,
    schemaAst: stabilizeSchema(schema),
    documents: documents.concat(gatsbyNodeDocuments),
    filename,
    config: {
      namingConvention: {
        typeNames: "keep",
        enumValues: "keep",
        transformUnderscore: false,
      },
      addUnderscoreToArgsType: true,
      skipTypename: true,
    },
  };

  const result = await codegen({
    ...pluginConfig,
    ...codegenOptions,
  });

  await fs.outputFile(filename, result);
}
