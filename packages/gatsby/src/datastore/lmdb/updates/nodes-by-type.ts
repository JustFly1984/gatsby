import type { ActionsUnion } from "../../../redux/types";
import type { ILmdbDatabases } from "../../types";

export function updateNodesByType(
  nodesByTypeDb: ILmdbDatabases["nodesByType"],
  action: ActionsUnion,
): Promise<boolean> | boolean {
  switch (action.type) {
    case "CREATE_NODE":
    case "ADD_FIELD_TO_NODE":
    case "ADD_CHILD_NODE_TO_PARENT_NODE": {
      // nodesByType db uses dupSort, so `put` will effectively append an id
      return action.payload.internal?.type
        ? nodesByTypeDb.put(action.payload.internal.type, action.payload.id)
        : false;
    }
    case "DELETE_NODE": {
      return action.payload?.internal.type
        ? nodesByTypeDb.remove(action.payload.internal.type, action.payload.id)
        : false;
    }
  }
  return false;
}
