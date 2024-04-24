import type { CreateSchemaCustomizationArgs } from "../../gatsby";

import { collectionTypeBuilder } from "./type-builders/collection-type";
import { commonTypeBuilder } from "./type-builders/common-type";
import { locationTypeBuilder } from "./type-builders/location-type";
import { mediaTypeBuilder } from "./type-builders/media-type";
import { metafieldTypeBuilder } from "./type-builders/metafield-type";
import { orderTypeBuilder } from "./type-builders/order-type";
import { productTypeBuilder } from "./type-builders/product-type";
import { productVariantTypeBuilder } from "./type-builders/product-variant-type";

export function createSchemaCustomization(
  gatsbyApi: CreateSchemaCustomizationArgs,
  pluginOptions: IShopifyPluginOptions,
): void {
  const { actions } = gatsbyApi;
  const {
    downloadImages,
    shopifyConnections: connections,
    typePrefix,
  } = pluginOptions;

  const prefix = `${typePrefix}Shopify`;

  const typeDefs = [
    commonTypeBuilder(prefix),
    mediaTypeBuilder(prefix),
    metafieldTypeBuilder(prefix),
    productTypeBuilder(prefix),
    productVariantTypeBuilder(prefix),
  ];

  if (connections.includes("collections")) {
    typeDefs.push(collectionTypeBuilder(prefix));
  }

  if (connections.includes("locations")) {
    typeDefs.push(locationTypeBuilder(prefix));
  }

  if (connections.includes("orders")) {
    typeDefs.push(orderTypeBuilder(prefix));
  }

  if (downloadImages) {
    typeDefs.push(`
      extend type ${prefix}Image {
        localFile: File @link(from: "localFile___NODE", by: "id")
      }
    `);
  }

  actions.createTypes(typeDefs);
}
