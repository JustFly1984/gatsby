// spawned process won't use jest config to support TS, so we need to add support ourselves
require("@babel/register")({
  extensions: [".js", ".ts"],
  configFile: require.resolve("../../../.babelrc"),
  ignore: [/node_modules/],
});
