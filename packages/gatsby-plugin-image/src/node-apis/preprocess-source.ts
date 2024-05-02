// import type { PreprocessSourceArgs } from "gatsby";
import { babelParseToAst } from "./parser";
import path from "node:path";
import { extractStaticImageProps } from "./parser";
import { codeFrameColumns } from "@babel/code-frame";

import { writeImages } from "./image-processing";
import { getCacheDir } from "./node-utils";
import { stripIndents } from "common-tags";
import type { NodePath } from "@babel/traverse";
import type { JSXAttribute } from "@babel/types";
const extensions: Array<string> = [".js", ".jsx", ".tsx"];

export async function preprocessSource({
  filename,
  contents,
  pathPrefix,
  cache,
  reporter,
  store,
  createNodeId,
  actions: { createNode },
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
}: any): Promise<void> {
  if (
    !contents.includes("StaticImage") ||
    !contents.includes("gatsby-plugin-image") ||
    !extensions.includes(path.extname(filename))
  ) {
    return;
  }
  const root = store.getState().program.directory;

  const cacheDir = getCacheDir(root);

  const ast = babelParseToAst(contents, filename);
  reporter.setErrorMap({
    "95314": {
      text: (context): string =>
        stripIndents`
          Error extracting property "${context.prop}" from StaticImage component.
          There are restrictions on how props can be passed to the StaticImage component. Learn more at https://gatsby.dev/static-image-props

          ${context.codeFrame}
        `,
      docsUrl: "https://gatsby.dev/static-image-props",
      level: "ERROR",
      category: "USER",
    },
  });

  const images = extractStaticImageProps(
    ast,
    filename,
    (prop: string, nodePath: NodePath<JSXAttribute> | undefined): void => {
      const sourceLocation = nodePath?.node.loc;

      reporter.error({
        id: "95314",
        filePath: filename,
        location: {
          start: sourceLocation?.start,
          end: sourceLocation?.end,
        },
        context: {
          prop,
          codeFrame: codeFrameColumns(
            contents,
            sourceLocation ?? { start: { line: 0 }, end: { line: 1 } },
            {
              linesAbove: 6,
              linesBelow: 6,
              highlightCode: true,
            },
          ),
        },
      });
    },
  );

  const sourceDir = path.dirname(filename);
  await writeImages({
    images,
    pathPrefix,
    cache,
    reporter,
    cacheDir,
    sourceDir,
    createNodeId,
    createNode,
    filename,
  });

  return;
}
