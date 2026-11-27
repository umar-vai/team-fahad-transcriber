/**
 * Pricing plans. Admins create and edit plans on /admin/pricing and decide which plan each person is on.
 * The public home page shows the public plans. People without a plan of their own get the default plan.
 */
import { env } from "cloudflare:workers";

export interface Plan {
  id: string;
  name: string;
  tagline: string | null;
  price_monthly: number | null;
  price_yearly: number | null;
  currency: string;
  minutes_month: number | null;
  max_file_minutes: number | null;
  features: string;
  cta_label: string | null;
  highlighted: number;
  is_public: number;
  is_default: number;
  sort: number;
  created_at: number;
  updated_at: number;
}

export interface Assignment {
  email: string;
  plan_id: string;
  expires_at: number | null;
  note: string | null;
  assigned_by: string | null;
  assigned_at: number;
}

export const CURRENCIES: Record<string, { symbol: string; label: string }> = {
  BDT: { symbol: "৳", label: "Bangladeshi taka (৳)" },
  USD: { symbol: "$", label: "US dollar ($)" },
  EUR: { symbol: "€", label: "Euro (€)" },
  GBP: { symbol: "£", label: "British pound (£)" },
  INR: { symbol: "₹", label: "Indian rupee (₹)" },
  SAR: { symbol: "SAR ", label: "Saudi riyal (SAR)" },
  AED: { symbol: "AED ", label: "UAE dirham (AED)" },
};

/** "৳990" or "$9.99". Null price means a custom price. */
export function formatPrice(amount: number | null, currency: string): string {
  if (amount === null || amount === undefined) return "Custom";
  const symbol = CURRENCIES[currency]?.symbol ?? `${currency} `;
  const digits = Number.isInteger(amount) ? 0 : 2;
  return `${symbol}${amount.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
}

export function minutesLabel(minutes: number | null): string {
  if (minutes === null || minutes === undefined) return "Unlimited minutes";
  if (minutes >= 600 && minutes % 60 === 0) return `${(minutes / 60).toLocaleString("en-US")} hours a month`;
  return `${minutes.toLocaleString("en-US")} minutes a month`;
}

export function featureList(plan: Pick<Plan, "features">): string[] {
  return String(plan.features || "").split("\n").map((line) => line.trim()).filter(Boolean);
}

/** Missing table (migration not applied yet) must not break the home page. */
async function safe<T>(fn: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    console.warn("plans lookup failed", error);
    return fallback;
  }
}

export function listPlans(): Promise<Plan[]> {
  return safe(async () => (await env.DB.prepare("SELECT * FROM plans ORDER BY sort, created_at").all<Plan>()).results, []);
}

export async function publicPlans(): Promise<Plan[]> {
  return (await listPlans()).filter((plan) => plan.is_public);
}

export function getPlan(id: string): Promise<Plan | null> {
  return safe(() => env.DB.prepare("SELECT * FROM plans WHERE id = ?").bind(id).first<Plan>(), null);
}

/** The plan this person is on now: their own (if not expired), else the default plan. */
export async function planFor(email: string): Promise<{ plan: Plan | null; assignment: Assignment | null }> {
  return safe(async () => {
    const assignment = await env.DB.prepare("SELECT * FROM user_plans WHERE email = ?").bind(email.toLowerCase()).first<Assignment>();
    if (assignment && (!assignment.expires_at || assignment.expires_at > Date.now())) {
      const plan = await getPlan(assignment.plan_id);
      if (plan) return { plan, assignment };
    }
    const fallback = await env.DB.prepare("SELECT * FROM plans WHERE is_default = 1 ORDER BY sort LIMIT 1").first<Plan>();
    return { plan: fallback, assignment: null };
  }, { plan: null, assignment: null });
}

export function monthStart(now = new Date()): number {
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
}

/** Minutes this person transcribed for themselves since the start of this month (UTC). */
export async function minutesUsed(userId: string): Promise<number> {
  return safe(async () => {
    const row = await env.DB.prepare(
      "SELECT COALESCE(SUM(duration), 0) AS seconds FROM transcriptions WHERE user_id = ? AND workspace_id IS NULL AND created_at >= ?",
    ).bind(userId, monthStart()).first<{ seconds: number }>();
    return Math.round((row?.seconds || 0) / 60);
  }, 0);
}

export function slugPlanId(name: string): string {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 24) || "plan";
  return `${base}-${crypto.randomUUID().slice(0, 4)}`;
}
