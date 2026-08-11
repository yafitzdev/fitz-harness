export type ActionStatusTone = "neutral" | "success" | "error";
export type ActionFeedback = (message: string, tone: ActionStatusTone) => void;
