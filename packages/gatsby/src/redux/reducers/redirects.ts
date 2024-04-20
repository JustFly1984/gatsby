// eslint-disable-next-line @typescript-eslint/naming-convention
import _ from "lodash"
import type { IGatsbyState, IRedirect, ICreateRedirectAction } from "../types"

const redirects = new Map<string, Array<IRedirect>>()

function exists(newRedirect: IRedirect): boolean {
  const fromPathRedirects = redirects.get(newRedirect.fromPath)

  if (!fromPathRedirects) return false

  return fromPathRedirects.some(redirect => _.isEqual(redirect, newRedirect))
}

function add(redirect: IRedirect): void {
  let samePathRedirects = redirects.get(redirect.fromPath)

  if (!samePathRedirects) {
    samePathRedirects = []
    redirects.set(redirect.fromPath, samePathRedirects)
  }

  samePathRedirects.push(redirect)
}

export function redirectsReducer(
  state: IGatsbyState["redirects"] = [],
  action: ICreateRedirectAction,
): IGatsbyState["redirects"] {
  switch (action.type) {
    case `CREATE_REDIRECT`: {
      const redirect = action.payload

      // Add redirect only if it wasn't yet added to prevent duplicates
      if (!exists(redirect)) {
        add(redirect)

        state.push(redirect)
      }

      return state
    }

    default:
      return state
  }
}
