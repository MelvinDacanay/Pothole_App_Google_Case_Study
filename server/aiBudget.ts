import { hashBytes } from './verificationPolicy.ts';

export const APPROVED_GEMINI_MODEL = 'gemini-3.5-flash-lite';
// Configuration can reduce these ceilings, never silently increase them.
export function hardLimit(value: string | undefined, ceiling: number): number {
  if (value === undefined) return ceiling;
  if (!/^\d+$/.test(value)) return 0;
  const n = Number(value);
  return Number.isSafeInteger(n) ? Math.min(n, ceiling) : 0;
}
export function aiBudgetWindows(uid: string, now: number, env: NodeJS.ProcessEnv = process.env) {
  const day = new Date(now).toISOString().slice(0,10), minute = Math.floor(now/60_000);
  const user = hashBytes(uid);
  return [
    {id:`day_${day}`,max:hardLimit(env.PATCHUP_AI_DAILY_LIMIT,100),expires:now+2*86400_000},
    {id:`user_${user}_${day}`,max:hardLimit(env.PATCHUP_AI_USER_DAILY_LIMIT,25),expires:now+2*86400_000,ownerId:uid},
    {id:`month_${day.slice(0,7)}`,max:hardLimit(env.PATCHUP_AI_MONTHLY_LIMIT,3000),expires:now+62*86400_000},
    {id:`minute_${minute}`,max:hardLimit(env.PATCHUP_AI_MINUTE_LIMIT,10),expires:now+2*86400_000},
    {id:`userminute_${user}_${minute}`,max:hardLimit(env.PATCHUP_AI_USER_MINUTE_LIMIT,3),expires:now+2*86400_000,ownerId:uid},
  ];
}
export function budgetAvailable(count: unknown, max: number): boolean {
  return typeof count === 'number' && Number.isSafeInteger(count) && count >= 0 && count < max;
}
