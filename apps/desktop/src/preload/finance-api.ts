import { ipcRenderer } from 'electron';

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
  capitalStateSchema,
  capitalContributionSchema,
  createCapitalContributionInputSchema,
  updateCapitalContributionInputSchema,
  recordCapitalReimbursementInputSchema,
  type CancelExpenseInput,
  type CashApi,
  type CashState,
  type CloseCashRegisterInput,
  type CreateExpenseInput,
  type DeleteExpenseInput,
  type Expense,
  type ExpenseApi,
  type ExpenseDeletionResult,
  type ExpenseState,
  type OpenCashRegisterInput,
  type RecordCashMovementInput,
  type UpdateExpenseInput,
  type UpdateExpensePaymentStatusInput,
  type CapitalApi,
} from '@gtrz/contracts';

export const cashApi: CashApi = {
  async getState(): Promise<CashState> {
    const payload: unknown = await ipcRenderer.invoke(IPC_CHANNELS.cashGetState);
    return cashStateSchema.parse(payload);
  },

  async open(input: OpenCashRegisterInput): Promise<CashState> {
    const parsedInput = openCashRegisterInputSchema.parse(input);
    const payload: unknown = await ipcRenderer.invoke(IPC_CHANNELS.cashOpen, parsedInput);
    return cashStateSchema.parse(payload);
  },

  async recordMovement(input: RecordCashMovementInput): Promise<CashState> {
    const parsedInput = recordCashMovementInputSchema.parse(input);
    const payload: unknown = await ipcRenderer.invoke(IPC_CHANNELS.cashRecordMovement, parsedInput);
    return cashStateSchema.parse(payload);
  },

  async close(input: CloseCashRegisterInput): Promise<CashState> {
    const parsedInput = closeCashRegisterInputSchema.parse(input);
    const payload: unknown = await ipcRenderer.invoke(IPC_CHANNELS.cashClose, parsedInput);
    return cashStateSchema.parse(payload);
  },
};

export const expenseApi: ExpenseApi = {
  async getState(): Promise<ExpenseState> {
    const payload: unknown = await ipcRenderer.invoke(IPC_CHANNELS.expensesGetState);
    return expenseStateSchema.parse(payload);
  },

  async create(input: CreateExpenseInput): Promise<Expense> {
    const parsedInput = createExpenseInputSchema.parse(input);
    const payload: unknown = await ipcRenderer.invoke(IPC_CHANNELS.expensesCreate, parsedInput);
    return expenseSchema.parse(payload);
  },

  async update(input: UpdateExpenseInput): Promise<Expense> {
    const parsedInput = updateExpenseInputSchema.parse(input);
    const payload: unknown = await ipcRenderer.invoke(IPC_CHANNELS.expensesUpdate, parsedInput);
    return expenseSchema.parse(payload);
  },

  async updatePaymentStatus(input: UpdateExpensePaymentStatusInput): Promise<Expense> {
    const parsedInput = updateExpensePaymentStatusInputSchema.parse(input);
    const payload: unknown = await ipcRenderer.invoke(
      IPC_CHANNELS.expensesUpdatePaymentStatus,
      parsedInput,
    );
    return expenseSchema.parse(payload);
  },
  async recordPayment(input) {
    const payload: unknown = await ipcRenderer.invoke(
      IPC_CHANNELS.expensesRecordPayment,
      recordExpensePaymentInputSchema.parse(input),
    );
    return expenseSchema.parse(payload);
  },

  async cancel(input: CancelExpenseInput): Promise<Expense> {
    const parsedInput = cancelExpenseInputSchema.parse(input);
    const payload: unknown = await ipcRenderer.invoke(IPC_CHANNELS.expensesCancel, parsedInput);
    return expenseSchema.parse(payload);
  },

  async delete(input: DeleteExpenseInput): Promise<ExpenseDeletionResult> {
    const parsedInput = deleteExpenseInputSchema.parse(input);
    const payload: unknown = await ipcRenderer.invoke(IPC_CHANNELS.expensesDelete, parsedInput);
    return expenseDeletionResultSchema.parse(payload);
  },
};

export const capitalApi: CapitalApi = {
  async getState() {
    return capitalStateSchema.parse(await ipcRenderer.invoke(IPC_CHANNELS.capitalGetState));
  },
  async create(input) {
    return capitalContributionSchema.parse(
      await ipcRenderer.invoke(
        IPC_CHANNELS.capitalCreate,
        createCapitalContributionInputSchema.parse(input),
      ),
    );
  },
  async update(input) {
    return capitalContributionSchema.parse(
      await ipcRenderer.invoke(
        IPC_CHANNELS.capitalUpdate,
        updateCapitalContributionInputSchema.parse(input),
      ),
    );
  },
  async reimburse(input) {
    return capitalStateSchema.parse(
      await ipcRenderer.invoke(
        IPC_CHANNELS.capitalReimburse,
        recordCapitalReimbursementInputSchema.parse(input),
      ),
    );
  },
};
