// import type { Reporter } from "gatsby";

export function reportError(
  message: string,
  err?: Error | undefined,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  reporter?: any | undefined, // Reporter | undefined,
): void {
  if (reporter) {
    reporter.error({
      id: "gatsby-plugin-sharp-20000",
      context: { sourceMessage: message },
      error: err,
    });
  } else {
    console.error(message, err);
  }

  if (process.env.gatsby_executing_command === "build") {
    process.exit(1);
  }
}
