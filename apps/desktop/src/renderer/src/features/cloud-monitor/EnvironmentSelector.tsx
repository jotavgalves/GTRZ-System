import { Cloud, FlaskConical } from 'lucide-react';
import { useEffect, useState } from 'react';

import type { RuntimeEnvironment } from '@gtrz/contracts';

const environments: readonly {
  readonly value: RuntimeEnvironment;
  readonly label: string;
  readonly description: string;
}[] = [
  {
    value: 'production',
    label: 'Operação oficial',
    description: 'Vendas e dados reais',
  },
  {
    value: 'test',
    label: 'Teste isolado',
    description: 'Banco e nuvem separados',
  },
];

export function EnvironmentSelector(): React.JSX.Element | null {
  const [current, setCurrent] = useState<RuntimeEnvironment | null>(null);
  const [switching, setSwitching] = useState<RuntimeEnvironment | null>(null);

  useEffect(() => {
    void window.gtrz.system.getInfo().then((info) => {
      setCurrent(info.environment);
    });
  }, []);

  const switchEnvironment = (environment: RuntimeEnvironment): void => {
    if (environment === current || switching !== null) return;
    setSwitching(environment);
    void window.gtrz.system.switchEnvironment({ environment });
  };

  if (current === null) return null;

  return (
    <section className="cloud-environment panel" aria-label="Ambiente de operação">
      <div className="cloud-environment__heading">
        <div>
          <span className="eyebrow">Ambiente do sistema</span>
          <h2>Trocar operação</h2>
          <p>O app reinicia no ambiente escolhido sem misturar os dados.</p>
        </div>
      </div>
      <div className="cloud-environment__choices" role="group" aria-label="Selecionar ambiente">
        {environments.map((environment) => {
          const selected = current === environment.value;
          const Icon = environment.value === 'production' ? Cloud : FlaskConical;
          return (
            <button
              className={
                selected
                  ? 'cloud-environment__choice cloud-environment__choice--selected'
                  : 'cloud-environment__choice'
              }
              disabled={selected || switching !== null}
              key={environment.value}
              onClick={() => {
                switchEnvironment(environment.value);
              }}
              type="button"
            >
              <Icon size={18} aria-hidden="true" />
              <span>
                <strong>
                  {switching === environment.value ? 'Abrindo ambiente...' : environment.label}
                </strong>
                <small>{environment.description}</small>
              </span>
            </button>
          );
        })}
      </div>
    </section>
  );
}
