import { ipcRenderer } from 'electron';

import {
  comboListSchema,
  comboSchema,
  comboDeletionResultSchema,
  createComboInputSchema,
  deleteComboInputSchema,
  IPC_CHANNELS,
  updateComboInputSchema,
  type ComboApi,
  type ComboDeletionResult,
  type CreateComboInput,
  type DeleteComboInput,
  type InventoryCombo,
  type UpdateComboInput,
} from '@gtrz/contracts';

export const comboApi: ComboApi = {
  async list(): Promise<readonly InventoryCombo[]> {
    const payload: unknown = await ipcRenderer.invoke(IPC_CHANNELS.combosList);
    return comboListSchema.parse(payload);
  },
  async create(input: CreateComboInput): Promise<InventoryCombo> {
    const parsedInput = createComboInputSchema.parse(input);
    const payload: unknown = await ipcRenderer.invoke(IPC_CHANNELS.combosCreate, parsedInput);
    return comboSchema.parse(payload);
  },
  async update(input: UpdateComboInput): Promise<InventoryCombo> {
    const parsedInput = updateComboInputSchema.parse(input);
    const payload: unknown = await ipcRenderer.invoke(IPC_CHANNELS.combosUpdate, parsedInput);
    return comboSchema.parse(payload);
  },
  async delete(input: DeleteComboInput): Promise<ComboDeletionResult> {
    const payload: unknown = await ipcRenderer.invoke(
      IPC_CHANNELS.combosDelete,
      deleteComboInputSchema.parse(input),
    );
    return comboDeletionResultSchema.parse(payload);
  },
};
