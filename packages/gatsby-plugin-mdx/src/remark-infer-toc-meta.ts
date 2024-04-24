import type { Plugin } from "unified";
import type { Node } from "unist";
import type {
  BlockContent,
  DefinitionContent,
  ListItem,
  TableCell,
} from "mdast";
import type { IMdxVFile } from "./types";
import type { Options, toc } from "mdast-util-toc";
import type { visit } from "unist-util-visit";
import { VFile } from "vfile";

type ITocNodeEntry = {
  url?: string | undefined;
  title?: string | undefined;
};

type TocNodeType =
  | ITocNodeEntry
  | {
      items: Array<TocNodeType>;
    };

type IRemarkTocOptions = {
  maxDepth?: Options["maxDepth"] | undefined;
  toc: typeof toc;
  visit: typeof visit;
};

const remarkInferTocMeta: Plugin<[IRemarkTocOptions]> = (
  options: IRemarkTocOptions,
): ((tree: Node, file: VFile) => void) => {
  const { toc, visit, maxDepth }: IRemarkTocOptions = {
    maxDepth: 6,
    ...options,
  };

  function processToC(
    node: BlockContent | DefinitionContent | ListItem | null,
    current: TocNodeType,
  ): TocNodeType {
    if (!node) {
      return {};
    }

    switch (node.type) {
      case "paragraph": {
        const typedCurrent = current as ITocNodeEntry;

        visit(node, (item) => {
          if (item.type === "link") {
            typedCurrent.url = item.url;
          }
          if (item.type === "text" || item.type === "inlineCode") {
            if (typedCurrent.title) {
              typedCurrent.title += item.value;
            } else {
              typedCurrent.title = item.value;
            }
          }
        });

        return current;
      }

      case "list": {
        const typedCurrent = current as { items: Array<TocNodeType> };

        typedCurrent.items = node.children.map((item) => processToC(item, {}));

        return typedCurrent;
      }

      case "listItem": {
        if (node.children.length) {
          const heading = processToC(node.children[0], {});

          if (node.children.length > 1) {
            processToC(node.children[1], heading);
          }

          return heading;
        }
      }
    }

    return {};
  }

  return (tree: Node, file): void => {
    const generatedToC = toc(tree as TableCell, { maxDepth });
    // @ts-ignore
    const mdxFile: IMdxVFile = file;
    if (!mdxFile.data.meta) {
      mdxFile.data.meta = {};
    }

    mdxFile.data.meta.toc = processToC(generatedToC.map ?? null, {});
  };
};

export default remarkInferTocMeta;
