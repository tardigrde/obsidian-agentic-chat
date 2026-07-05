import {
  PLAN_ITEM_STATUS_LABELS,
  PLAN_TEST_STATUS_LABELS,
  summarizePlanTracker,
  type PlanItemStatus,
  type PlanTestStatus,
  type PlanTrackerState,
} from "../agent/plan-tracker";

export interface PlanTrackerPanelItem {
  id: string;
  title: string;
  status: PlanItemStatus;
  statusLabel: string;
  testStatus: PlanTestStatus;
  testLabel: string;
  checkpointCommit: string;
  note: string;
}

export interface PlanTrackerPanelState {
  visible: boolean;
  title: string;
  summary: string;
  items: PlanTrackerPanelItem[];
}

export function buildPlanTrackerPanelState(state: PlanTrackerState | null): PlanTrackerPanelState {
  if (!state || state.items.length === 0) {
    return { visible: false, title: "", summary: "", items: [] };
  }
  return {
    visible: true,
    title: state.title,
    summary: summarizePlanTracker(state),
    items: state.items.map((item) => ({
      id: item.id,
      title: item.title,
      status: item.status,
      statusLabel: PLAN_ITEM_STATUS_LABELS[item.status],
      testStatus: item.testStatus,
      testLabel: `tests ${PLAN_TEST_STATUS_LABELS[item.testStatus]}`,
      checkpointCommit: item.checkpointCommit ?? "",
      note: item.note ?? "",
    })),
  };
}
