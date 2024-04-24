const GatsbyThemeComponentShadowingResolverPlugin = require(".");

exports.onCreateWebpackConfig = ({ store, actions }) => {
  const { flattenedPlugins, program } = store.getState();

  actions.setWebpackConfig({
    resolve: {
      plugins: [
        new GatsbyThemeComponentShadowingResolverPlugin({
          extensions: program.extensions,
          themes: flattenedPlugins.map((plugin) => {
            return {
              themeDir: plugin.pluginFilepath,
              themeName: plugin.name,
            };
          }),
          projectRoot: program.directory,
        }),
      ],
    },
  });
};
