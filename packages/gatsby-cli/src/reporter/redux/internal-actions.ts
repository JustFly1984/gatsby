import { uuid } from "gatsby-core-utils";
import { trackCli } from "gatsby-telemetry";
import signalExit from "signal-exit";
import type { Dispatch } from "redux";
import { getStore } from "./";
import {
  Actions,
  ActivityLogLevels,
  type ActivityStatuses,
  ActivityTypes,
} from "../constants";
import type {
  IPendingActivity,
  ICreateLog,
  ISetStatus,
  IStartActivity,
  ICancelActivity,
  IEndActivity,
  IUpdateActivity,
  IActivityErrored,
  IGatsbyCLIState,
  ISetLogs,
  IRenderPageTree,
} from "./types";
import {
  delayedCall,
  getActivity,
  getElapsedTimeMS,
  getGlobalStatus,
} from "./utils";
import {
  type IStructuredError,
  ErrorCategory,
} from "../../structured-errors/types";
import type { IRenderPageArgs } from "../types";

const ActivityStatusToLogLevel = {
  ["INTERRUPTED"]: ActivityLogLevels.Interrupted,
  ["FAILED"]: ActivityLogLevels.Failed,
  ["SUCCESS"]: ActivityLogLevels.Success,
};

let weShouldExit = false;
signalExit.onExit(() => {
  weShouldExit = true;
});

let cancelDelayedSetStatus: (() => void) | null;

let pendingStatus: ActivityStatuses | "" = "";

// We debounce "done" statuses because activities don't always overlap
// and there is timing window after one activity ends and before next one starts
// where technically we are "done" (all activities are done).
// We don't want to emit multiple SET_STATUS events that would toggle between
// IN_PROGRESS and SUCCESS/FAILED in short succession in those cases.
export function setStatus(
  status: ActivityStatuses | "",
  force: boolean = false,
) {
  return (dispatch: Dispatch<ISetStatus>): void => {
    const currentStatus = getStore().getState().logs.status;

    if (cancelDelayedSetStatus) {
      cancelDelayedSetStatus();
      cancelDelayedSetStatus = null;
    }

    if (
      status !== currentStatus &&
      (status === "IN_PROGRESS" || force || weShouldExit)
    ) {
      dispatch({
        type: Actions.SetStatus,
        payload: status,
      });
      pendingStatus = "";
    } else {
      // use pending status if truthy, fallback to current status if we don't have pending status
      const pendingOrCurrentStatus = pendingStatus || currentStatus;

      if (status !== pendingOrCurrentStatus) {
        pendingStatus = status;
        cancelDelayedSetStatus = delayedCall(() => {
          setStatus(status, true)(dispatch);
        }, 1000);
      }
    }
  };
}

export function createLog({
  level,
  text,
  statusText,
  duration,
  group,
  code,
  type,
  category,
  filePath,
  location,
  docsUrl,
  context,
  activity_current,
  activity_total,
  activity_type,
  activity_uuid,
  stack,
  pluginName,
}: {
  level: string;
  text?: string | undefined;
  statusText?: string | undefined;
  duration?: number | undefined;
  group?: string | undefined;
  code?: string | undefined;
  type?: string | undefined;
  category?: keyof typeof ErrorCategory | undefined;
  filePath?: string | undefined;
  location?: IStructuredError["location"] | undefined;
  docsUrl?: string | undefined;
  context?: string | undefined;
  activity_current?: number | undefined;
  activity_total?: number | undefined;
  activity_type?: string | undefined;
  activity_uuid?: string | undefined;
  stack?: IStructuredError["stack"] | undefined;
  pluginName?: string | undefined;
}): ICreateLog {
  return {
    type: Actions.Log,
    payload: {
      level,
      text: !text ? "\u2800" : text,
      statusText,
      duration,
      group,
      code,
      type,
      category,
      filePath,
      location,
      docsUrl,
      context,
      activity_current,
      activity_total,
      activity_type,
      activity_uuid,
      timestamp: new Date().toJSON(),
      stack,
      pluginName,
    },
  };
}

type ActionsToEmit = Array<IPendingActivity | ReturnType<typeof setStatus>>;
export function createPendingActivity({
  id,
  status = "NOT_STARTED",
}: {
  id: string;
  status?: ActivityStatuses | undefined;
}): ActionsToEmit {
  const globalStatus = getGlobalStatus(id, status);
  return [
    setStatus(globalStatus),
    {
      type: Actions.PendingActivity,
      payload: {
        id,
        type: ActivityTypes.Pending,
        startTime: process.hrtime(),
        status,
      },
    },
  ];
}

type QueuedStartActivityActions = Array<
  IStartActivity | ReturnType<typeof setStatus>
>;
export function startActivity({
  id,
  text,
  type,
  status = "IN_PROGRESS",
  current,
  total,
}: {
  id: string;
  text: string;
  type: ActivityTypes;
  status?: ActivityStatuses | undefined;
  current?: number | undefined;
  total?: number | undefined;
}): QueuedStartActivityActions {
  const globalStatus = getGlobalStatus(id, status);

  return [
    setStatus(globalStatus),
    {
      type: Actions.StartActivity,
      payload: {
        id,
        uuid: uuid.v4(),
        text,
        type,
        status,
        startTime: process.hrtime(),
        statusText: "",
        current,
        total,
      },
    },
  ];
}

type QueuedEndActivity = Array<
  ICancelActivity | IEndActivity | ICreateLog | ReturnType<typeof setStatus>
>;

export function endActivity({
  id,
  status,
}: {
  id: string;
  status: ActivityStatuses;
}): QueuedEndActivity | null {
  const activity = getActivity(id);
  if (!activity) {
    return null;
  }

  const actionsToEmit: QueuedEndActivity = [];
  const durationMS = getElapsedTimeMS(activity);
  const durationS = durationMS / 1000;

  if (activity.type === ActivityTypes.Pending) {
    actionsToEmit.push({
      type: Actions.CancelActivity,
      payload: {
        id,
        status: "CANCELLED",
        type: activity.type,
        duration: durationS,
      },
    });
  } else if (activity.status === "IN_PROGRESS") {
    trackCli("ACTIVITY_DURATION", {
      name: activity.text,
      duration: Math.round(durationMS),
    });

    if (activity.errored) {
      status = "FAILED";
    }
    actionsToEmit.push({
      type: Actions.EndActivity,
      payload: {
        uuid: activity.uuid,
        id,
        status,
        duration: durationS,
        type: activity.type,
      },
    });

    if (activity.type !== ActivityTypes.Hidden) {
      actionsToEmit.push(
        createLog({
          text: activity.text,
          level: ActivityStatusToLogLevel[status],
          duration: durationS,
          statusText:
            activity.statusText ||
            (status === "SUCCESS" && activity.type === ActivityTypes.Progress
              ? `${activity.current}/${activity.total} ${(
                  (activity.total || 0) / durationS
                ).toFixed(2)}/s`
              : undefined),
          activity_uuid: activity.uuid,
          activity_current: activity.current,
          activity_total: activity.total,
          activity_type: activity.type,
        }),
      );
    }
  }

  const globalStatus = getGlobalStatus(id, status);
  actionsToEmit.push(setStatus(globalStatus));

  return actionsToEmit;
}

export function updateActivity({
  id = "",
  ...rest
}: {
  id: string;
  statusText?: string | undefined;
  total?: number | undefined;
  current?: number | undefined;
}): IUpdateActivity | null {
  const activity = getActivity(id);
  if (!activity) {
    return null;
  }

  return {
    type: Actions.UpdateActivity,
    payload: {
      uuid: activity.uuid,
      id,
      ...rest,
    },
  };
}

export const setActivityErrored = ({
  id,
}: {
  id: string;
}): IActivityErrored | null => {
  const activity = getActivity(id);
  if (!activity) {
    return null;
  }

  return {
    type: Actions.ActivityErrored,
    payload: {
      id,
    },
  };
};

export const setActivityStatusText = ({
  id,
  statusText,
}: {
  id: string;
  statusText: string;
}): IUpdateActivity | null =>
  updateActivity({
    id,
    statusText,
  });

export const setActivityTotal = ({
  id,
  total,
}: {
  id: string;
  total: number;
}): IUpdateActivity | null =>
  updateActivity({
    id,
    total,
  });

export const activityTick = ({
  id,
  increment = 1,
}: {
  id: string;
  increment: number;
}): IUpdateActivity | null => {
  const activity = getActivity(id);
  if (!activity) {
    return null;
  }

  return updateActivity({
    id,
    current: (activity.current || 0) + increment,
  });
};

export const setLogs = (logs: IGatsbyCLIState): ISetLogs => {
  return {
    type: Actions.SetLogs,
    payload: logs,
  };
};

export const renderPageTree = (payload: IRenderPageArgs): IRenderPageTree => {
  return {
    type: Actions.RenderPageTree,
    payload,
  };
};
