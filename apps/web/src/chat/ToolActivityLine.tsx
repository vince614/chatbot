import type { ToolActivity } from "./types";

interface ToolActivityLineProps {
  activity: ToolActivity;
}

/** Une ligne discrète par outil appelé : nom, arguments, état. */
export function ToolActivityLine({ activity }: ToolActivityLineProps) {
  const state = activity.ok === undefined ? "pending" : activity.ok ? "ok" : "failed";
  const label = { pending: "en cours", ok: "succès", failed: "échec" }[state];

  return (
    <div className={`tool-activity tool-activity--${state}`} title={`${activity.name} : ${label}`}>
      <span className="tool-activity__icon" aria-hidden="true" />
      <code className="tool-activity__name">{activity.name}</code>
      <code className="tool-activity__input">{formatInput(activity.input)}</code>
      <span className="tool-activity__state">{label}</span>
    </div>
  );
}

function formatInput(input: unknown): string {
  const text = JSON.stringify(input) ?? "";
  return text.length > 120 ? `${text.slice(0, 117)}…` : text;
}
