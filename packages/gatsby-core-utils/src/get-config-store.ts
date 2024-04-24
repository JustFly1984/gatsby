// eslint-disable-next-line @typescript-eslint/naming-convention
import Configstore from "configstore";

let config: Configstore;
/**
 * Gets the configstore instance related to gatsby
 * @return the ConfigStore instance for gatsby
 */

export function getConfigStore(): Configstore {
  if (!config) {
    config = new Configstore(
      "gatsby",
      {},
      {
        globalConfigPath: true,
      },
    );
  }

  return config;
}
