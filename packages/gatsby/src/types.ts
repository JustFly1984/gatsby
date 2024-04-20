import "@total-typescript/ts-reset"

export type IMatch = {
  id: string
  context: {
    sourceMessage: string
    [key: string]: unknown
  }
  error?: Error | undefined
  [key: string]: unknown
}
