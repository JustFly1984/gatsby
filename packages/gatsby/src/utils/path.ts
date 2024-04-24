import path from "node:path";
import { joinPath, createContentDigest } from "gatsby-core-utils";

export function withBasePath(basePath: string) {
  return (...paths: Array<string>): string => {
    return joinPath(basePath, ...paths);
  };
}

export function withTrailingSlash(basePath: string): string {
  return `${basePath}/`;
}

function posixJoinWithLeadingSlash(paths: Array<string>): string {
  return path.posix.join(
    ...paths.map((segment, index) =>
      segment === "" && index === 0 ? "/" : segment,
    ),
  );
}

export function getCommonDir(path1: string, path2: string): string {
  const path1Segments = path1.split(/[/\\]/);
  const path2Segments = path2.split(/[/\\]/);

  for (let i = 0; i < path1Segments.length; i++) {
    if (i >= path2Segments.length) {
      return posixJoinWithLeadingSlash(path2Segments);
    } else if (
      path1Segments[i].toLowerCase() !== path2Segments[i].toLowerCase()
    ) {
      const joined = path1Segments.slice(0, i);
      return posixJoinWithLeadingSlash(joined);
    }
  }

  return posixJoinWithLeadingSlash(path1Segments);
}

// MacOS (APFS) and Windows (NTFS) filename length limit = 255 chars, Others = 255 bytes
const MAX_PATH_SEGMENT_CHARS = 255;
const MAX_PATH_SEGMENT_BYTES = 255;
const SLICING_INDEX = 50;
const pathSegmentRe = /[^/]+/g;

const isMacOs = process.platform === "darwin";
const isWindows = process.platform === "win32";

function isNameTooLong(segment: string): boolean {
  return isMacOs || isWindows
    ? segment.length > MAX_PATH_SEGMENT_CHARS // MacOS (APFS) and Windows (NTFS) filename length limit (255 chars)
    : Buffer.from(segment).length > MAX_PATH_SEGMENT_BYTES;
} // Other (255 bytes)

export function tooLongSegmentsInPath(path: string): Array<string> {
  const invalidFilenames: Array<string> = [];
  for (const segment of path.split("/")) {
    if (isNameTooLong(segment)) {
      invalidFilenames.push(segment);
    }
  }
  return invalidFilenames;
}

export function truncatePath(path: string): string {
  return path.replace(pathSegmentRe, (match) => {
    if (isNameTooLong(match)) {
      return (
        match.slice(0, SLICING_INDEX) +
        createContentDigest(match.slice(SLICING_INDEX))
      );
    }
    return match;
  });
}
