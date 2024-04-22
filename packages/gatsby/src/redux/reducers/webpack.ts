import merge from "webpack-merge"
import type { ActionsUnion, IGatsbyState } from "../types"

export function webpackReducer(
  state: IGatsbyState["webpack"] = {},
  action: ActionsUnion,
): IGatsbyState["webpack"] {
  switch (action.type) {
    case `SET_WEBPACK_CONFIG`: {
      const nextConfig = action.payload
      delete nextConfig.entry
      delete nextConfig.output
      delete nextConfig.target
      delete nextConfig.resolveLoader

      return merge(state, nextConfig)
    }
    case `REPLACE_WEBPACK_CONFIG`:
      return { ...action.payload }

    default:
      return state
  }
}
