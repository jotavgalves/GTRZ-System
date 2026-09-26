import { ipcMain } from 'electron';

import {
  cancelExpenseInputSchema,
  cashStateSchema,
  closeCashRegisterInputSchema,
  createExpenseInputSchema,
  deleteExpenseInputSchema,
  expenseDeletionResultSchema,
  expenseSchema,
  expenseStateSchema,
  IPC_CHANNELS,
  openCashRegisterInputSchema,
  recordCashMovementInputSchema,
  updateExpenseInputSchema,
  updateExpensePaymentStatusInputSchema,
  recordExpensePaymentInputSchema,
  capitalContributionSchema,
  capitalStateSchema,
  createCapitalContributionInputSchema,
  updateCapitalContributionInputSchema,
  recordCapitalReimbursementInputSchema,
} from '@gtrz/contracts';
import {
  cancelExpense,
  closeCashRegister,
  createExpense,
  deleteExpense,
  getCashState,
  getExpenseState,
  openCashRegister,
  recordCashMovement,
  updateExpense,
  updateExpensePaymentStatus,
  recordExpensePayment,
  getCapitalState,
  createCapitalContribution,
  updateCapitalContribution,
  recordCapitalReimbursement,
  type DatabaseContext,
} from '@gtrz/database';

interface RegisterFinanceIpcOptions {
  readonly getDatabase: () => DatabaseContext;
}

const FINANCE_CHANNELS = [
  IPC_CHANNELS.cashGetState,
  IPC_CHANNELS.cashOpen,
  IPC_CHANNELS.cashRecordMovement,
  IPC_CHANNELS.cashClose,
  IPC_CHANNELS.expensesGetState,
  IPC_CHANNELS.expensesCreate,
  IPC_CHANNELS.expensesUpdate,
  IPC_CHANNELS.expensesUpdatePaymentStatus,
  IPC_CHANNELS.expensesRecordPayment,
  IPC_CHANNELS.expensesCancel,
  IPC_CHANNELS.expensesDelete,
  IPC_CHANNELS.capitalGetState,
  IPC_CHANNELS.capitalCreate,
  IPC_CHANNELS.capitalUpdate,
  IPC_CHANNELS.capitalReimburse,
] as const;

export function registerFinanceIpcHandlers(options: RegisterFinanceIpcOptions): void {
  for (const channel of FINANCE_CHANNELS) {
    ipcMain.removeHandler(channel);
  }

  ipcMain.handle(IPC_CHANNELS.cashGetState, () => {
    return cashStateSchema.parse(getCashState(options.getDatabase()));
  });

  ipcMain.handle(IPC_CHANNELS.cashOpen, (_event, payload: unknown) => {
    const input = openCashRegisterInputSchema.parse(payload);
    return cashStateSchema.parse(openCashRegister(options.getDatabase(), input.openingCashCents));
  });

  ipcMain.handle(IPC_CHANNELS.cashRecordMovement, (_event, payload: unknown) => {
    const input = recordCashMovementInputSchema.parse(payload);
    const databaseInput =
      input.note === undefined
        ? { type: input.type, amountCents: input.amountCents }
        : { type: input.type, amountCents: input.amountCents, note: input.note };
    return cashStateSchema.parse(recordCashMovement(options.getDatabase(), databaseInput));
  });

  ipcMain.handle(IPC_CHANNELS.cashClose, (_event, payload: unknown) => {
    const input = closeCashRegisterInputSchema.parse(payload);
    return cashStateSchema.parse(closeCashRegister(options.getDatabase(), input.countedCashCents));
  });

  ipcMain.handle(IPC_CHANNELS.expensesGetState, () => {
    return expenseStateSchema.parse(getExpenseState(options.getDatabase()));
  });

  ipcMain.handle(IPC_CHANNELS.expensesCreate, (_event, payload: unknown) => {
    const input = createExpenseInputSchema.parse(payload);
    return expenseSchema.parse(
      createExpense(options.getDatabase(), {
        category: input.category,
        description: input.description,
        amountCents: input.amountCents,
        paymentMethod: input.paymentMethod,
        ...(input.paymentStatus === undefined ? {} : { paymentStatus: input.paymentStatus }),
        ...(input.note === undefined ? {} : { note: input.note }),
      }),
    );
  });

  ipcMain.handle(IPC_CHANNELS.expensesUpdate, (_event, payload: unknown) => {
    const input = updateExpenseInputSchema.parse(payload);
    return expenseSchema.parse(
      updateExpense(options.getDatabase(), {
        expenseId: input.expenseId,
        category: input.category,
        description: input.description,
        amountCents: input.amountCents,
        paymentMethod: input.paymentMethod,
        paymentStatus: input.paymentStatus,
        ...(input.note === undefined ? {} : { note: input.note }),
      }),
    );
  });

  ipcMain.handle(IPC_CHANNELS.expensesUpdatePaymentStatus, (_event, payload: unknown) => {
    const input = updateExpensePaymentStatusInputSchema.parse(payload);
    return expenseSchema.parse(updateExpensePaymentStatus(options.getDatabase(), input));
  });

  ipcMain.handle(IPC_CHANNELS.expensesRecordPayment, (_event, payload: unknown) => {
    const input = recordExpensePaymentInputSchema.parse(payload);
    return expenseSchema.parse(
      recordExpensePayment(options.getDatabase(), {
        expenseId: input.expenseId,
        method: input.method,
        amountCents: input.amountCents,
        ...(input.note === undefined ? {} : { note: input.note }),
      }),
    );
  });

  ipcMain.handle(IPC_CHANNELS.expensesCancel, (_event, payload: unknown) => {
    const input = cancelExpenseInputSchema.parse(payload);
    return expenseSchema.parse(cancelExpense(options.getDatabase(), input));
  });

  ipcMain.handle(IPC_CHANNELS.expensesDelete, (_event, payload: unknown) => {
    const input = deleteExpenseInputSchema.parse(payload);
    return expenseDeletionResultSchema.parse(deleteExpense(options.getDatabase(), input));
  });

  ipcMain.handle(IPC_CHANNELS.capitalGetState, () =>
    capitalStateSchema.parse(getCapitalState(options.getDatabase())),
  );
  ipcMain.handle(IPC_CHANNELS.capitalCreate, (_event, payload: unknown) => {
    const input = createCapitalContributionInputSchema.parse(payload);
    return capitalContributionSchema.parse(
      createCapitalContribution(options.getDatabase(), {
        contributorName: input.contributorName,
        kind: input.kind,
        amountCents: input.amountCents,
        ...(input.remainingStockValueCents === undefined
          ? {}
          : { remainingStockValueCents: input.remainingStockValueCents }),
        ...(input.recoveryPriority === undefined
          ? {}
          : { recoveryPriority: input.recoveryPriority }),
        ...(input.note === undefined ? {} : { note: input.note }),
      }),
    );
  });
  ipcMain.handle(IPC_CHANNELS.capitalUpdate, (_event, payload: unknown) => {
    const input = updateCapitalContributionInputSchema.parse(payload);
    return capitalContributionSchema.parse(
      updateCapitalContribution(options.getDatabase(), {
        contributionId: input.contributionId,
        remainingStockValueCents: input.remainingStockValueCents,
        ...(input.note === undefined ? {} : { note: input.note }),
      }),
    );
  });
  ipcMain.handle(IPC_CHANNELS.capitalReimburse, (_event, payload: unknown) => {
    const input = recordCapitalReimbursementInputSchema.parse(payload);
    return capitalStateSchema.parse(
      recordCapitalReimbursement(options.getDatabase(), {
        contributionId: input.contributionId,
        method: input.method,
        amountCents: input.amountCents,
        ...(input.note === undefined ? {} : { note: input.note }),
      }),
    );
  });
}
