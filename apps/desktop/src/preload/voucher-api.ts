import { ipcRenderer } from 'electron';

import {
  addVoucherBalanceInputSchema,
  changeVoucherStatusInputSchema,
  createVoucherInputSchema,
  deleteVoucherInputSchema,
  deleteVoucherResultSchema,
  IPC_CHANNELS,
  setVoucherTotalInputSchema,
  updateVoucherInputSchema,
  voucherSchema,
  voucherStateSchema,
  type AddVoucherBalanceInput,
  type ChangeVoucherStatusInput,
  type CreateVoucherInput,
  type DeleteVoucherInput,
  type DeleteVoucherResult,
  type UpdateVoucherInput,
  type SetVoucherTotalInput,
  type Voucher,
  type VoucherApi,
  type VoucherState,
} from '@gtrz/contracts';

export const voucherApi: VoucherApi = {
  async getState(): Promise<VoucherState> {
    const payload: unknown = await ipcRenderer.invoke(IPC_CHANNELS.vouchersGetState);
    return voucherStateSchema.parse(payload);
  },

  async create(input: CreateVoucherInput): Promise<Voucher> {
    const parsedInput = createVoucherInputSchema.parse(input);
    const payload: unknown = await ipcRenderer.invoke(IPC_CHANNELS.vouchersCreate, parsedInput);
    return voucherSchema.parse(payload);
  },

  async changeStatus(input: ChangeVoucherStatusInput): Promise<Voucher> {
    const parsedInput = changeVoucherStatusInputSchema.parse(input);
    const payload: unknown = await ipcRenderer.invoke(
      IPC_CHANNELS.vouchersChangeStatus,
      parsedInput,
    );
    return voucherSchema.parse(payload);
  },

  async update(input: UpdateVoucherInput): Promise<Voucher> {
    const parsedInput = updateVoucherInputSchema.parse(input);
    const payload: unknown = await ipcRenderer.invoke(IPC_CHANNELS.vouchersUpdate, parsedInput);
    return voucherSchema.parse(payload);
  },

  async addBalance(input: AddVoucherBalanceInput): Promise<Voucher> {
    const parsedInput = addVoucherBalanceInputSchema.parse(input);
    const payload: unknown = await ipcRenderer.invoke(IPC_CHANNELS.vouchersAddBalance, parsedInput);
    return voucherSchema.parse(payload);
  },

  async setTotal(input: SetVoucherTotalInput): Promise<Voucher> {
    const parsedInput = setVoucherTotalInputSchema.parse(input);
    const payload: unknown = await ipcRenderer.invoke(IPC_CHANNELS.vouchersSetTotal, parsedInput);
    return voucherSchema.parse(payload);
  },

  async delete(input: DeleteVoucherInput): Promise<DeleteVoucherResult> {
    const parsedInput = deleteVoucherInputSchema.parse(input);
    const payload: unknown = await ipcRenderer.invoke(IPC_CHANNELS.vouchersDelete, parsedInput);
    return deleteVoucherResultSchema.parse(payload);
  },
};
