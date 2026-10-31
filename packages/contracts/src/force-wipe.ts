import { z } from 'zod';

/** The phrase the administrator must type before anything is really deleted. */
export const FORCE_WIPE_CONFIRMATION = 'APAGAR TUDO';

const countSchema = z.number().int().nonnegative();

export const forceWipeGlobalEventInputSchema = z.object({
  eventId: z.uuid(),
  confirmationName: z.string().trim().min(2).max(100),
  reason: z.string().trim().min(3).max(240),
  /** A simulation only counts what would be deleted; nothing is touched. */
  dryRun: z.boolean(),
  confirmation: z.string().trim().max(40).optional(),
});

export const forceWipeResultSchema = z.object({
  dryRun: z.boolean(),
  eventId: z.string(),
  eventName: z.string(),
  cloud: z.object({
    journal: countSchema,
    commands: countSchema,
    projections: countSchema,
    state: countSchema,
    printJobs: countSchema,
    printAttempts: countSchema,
    snapshots: countSchema,
    pendingResets: countSchema,
  }),
  local: z.object({
    orders: countSchema,
    paidOrders: countSchema,
    paidCents: countSchema,
    tables: countSchema,
    expenses: countSchema,
    vouchers: countSchema,
    ticketSales: countSchema,
    stockMovements: countSchema,
    cashMovements: countSchema,
  }),
});

export type ForceWipeGlobalEventInput = z.infer<typeof forceWipeGlobalEventInputSchema>;
export type ForceWipeResult = z.infer<typeof forceWipeResultSchema>;
