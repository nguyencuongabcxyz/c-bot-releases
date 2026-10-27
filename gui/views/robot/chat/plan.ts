// Plan mode: what each permission mode is called in the chat, and a plan Claude made,
// as the chat shows it (live on its card, and kept in the history and past conversations).
import { Icon } from '@/ui/icons';
import type { PermissionMode, PlanEntry } from '@/types/model';

/** The modes as the chat offers them, in Shift+Tab order: [icon, name, what it means]. */
export const MODES: Record<PermissionMode, [string, string, string]> = {
  default: ['eye', 'Read-only', 'Looks and answers, changes nothing'],
  acceptEdits: ['edit', 'Auto-accept edits', 'Edits files in my folder without asking'],
  plan: ['plan', 'Plan mode', 'Explores and writes a plan for your OK first'],
  bypassPermissions: ['flame', 'Full access', 'Edits and runs anything, no asking'],
};

/** What going ahead with a plan means, per mode it goes ahead in. */
export const GO_LABEL: Partial<Record<PermissionMode, string>> = {
  acceptEdits: 'auto-accepting edits',
  bypassPermissions: 'with full access',
  default: 'read-only',
};

/** A decided plan, folded: the decision on its summary line, the plan inside. */
export function planSummary(md: (text: string) => string, p: Pick<PlanEntry, 'plan' | 'approved' | 'mode' | 'feedback'>) {
  const el = document.createElement('details');
  el.className = `msg plan-summary ${p.approved ? 'approved' : 'sent-back'}`;
  const sum = document.createElement('summary');
  const how = p.approved && p.mode ? GO_LABEL[p.mode] : '';
  sum.innerHTML = `${Icon('plan', 'sm lead')}<span></span>`;
  sum.querySelector('span')!.textContent = p.approved ? `Plan approved${how ? `, ${how}` : ''}` : 'Plan sent back for changes';
  el.appendChild(sum);
  const body = document.createElement('div');
  body.className = 'plan-body';
  body.innerHTML = md(p.plan || '_(an empty plan)_');
  el.appendChild(body);
  if (p.feedback) el.appendChild(planNotes(p.feedback));
  return el;
}

/** Your notes on a plan sent back. */
export function planNotes(text: string) {
  const el = document.createElement('div');
  el.className = 'plan-notes';
  el.innerHTML = `${Icon('edit', 'sm lead')}<span></span>`;
  el.querySelector('span')!.textContent = text;
  return el;
}
