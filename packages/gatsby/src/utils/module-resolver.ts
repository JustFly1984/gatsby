import * as fs from "fs";
import enhancedResolve, { CachedInputFileSystem } from "enhanced-resolve";

export type ModuleResolver = (modulePath: string) => string | false;
type ResolveType = (
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  context?: any | undefined,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  path?: any | undefined,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  request?: any | undefined,
) => string | false;

export const resolveModule: ModuleResolver = (modulePath) => {
  let resolve: ResolveType;

  try {
    resolve = enhancedResolve.create.sync({
      fileSystem: new CachedInputFileSystem(fs, 5000),
      extensions: [".ts", ".tsx", ".js", ".jsx"],
    });
  } catch (err) {
    // ignore
  }

  // @ts-ignore - See https://github.com/microsoft/TypeScript/issues/9568
  return resolve({}, modulePath, modulePath);
};
