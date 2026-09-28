import { ipcMain } from 'electron';

import {
  comboListSchema,
  comboSchema,
  comboDeletionResultSchema,
  createComboInputSchema,
  deleteComboInputSchema,
  IPC_CHANNELS,
  updateComboInputSchema,
} from '@gtrz/contracts';
import {
  createCombo,
  deleteCombo,
  listCombos,
  updateCombo,
  type DatabaseContext,
} from '@gtrz/database';

interface RegisterComboIpcOptions {
  readonly getDatabase: () => DatabaseContext;
}

const COMBO_CHANNELS = [
  IPC_CHANNELS.combosList,
  IPC_CHANNELS.combosCreate,
  IPC_CHANNELS.combosUpdate,
  IPC_CHANNELS.combosDelete,
] as const;

export function registerComboIpcHandlers(options: RegisterComboIpcOptions): void {
  for (const channel of COMBO_CHANNELS) {
    ipcMain.removeHandler(channel);
  }

  ipcMain.handle(IPC_CHANNELS.combosList, () => {
    return comboListSchema.parse(listCombos(options.getDatabase()));
  });

  ipcMain.handle(IPC_CHANNELS.combosCreate, (_event, payload: unknown) => {
    const input = createComboInputSchema.parse(payload);
    return comboSchema.parse(createCombo(options.getDatabase(), input));
  });

  ipcMain.handle(IPC_CHANNELS.combosUpdate, (_event, payload: unknown) => {
    const input = updateComboInputSchema.parse(payload);
    return comboSchema.parse(updateCombo(options.getDatabase(), input));
  });

  ipcMain.handle(IPC_CHANNELS.combosDelete, (_event, payload: unknown) => {
    return comboDeletionResultSchema.parse(
      deleteCombo(options.getDatabase(), deleteComboInputSchema.parse(payload)),
    );
  });
}
