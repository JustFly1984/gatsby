// `gatsby-confi.tsx` name is intentional. This is used for testing misspelled `gatsby-config` errors
// @ts-ignore Cannot find module 'gatsby' or its corresponding type declarations.ts(2307)
import type { GatsbyConfig } from "gatsby";

const config: GatsbyConfig = {
  siteMetadata: {
    title: "ts",
    siteUrl: "https://www.yourdomain.tld",
  },
  plugins: [],
};

export default config;
