import { createHash, randomBytes } from 'node:crypto';
import { z } from 'zod';
import {
  addOrderItem,
  closeOrder,
  getOperationState,
  getSessionState,
  type DatabaseContext,
} from '@gtrz/database';

const permissionsSchema = z.object({
  sales: z.boolean(),
  inventory: z.boolean(),
  tickets: z.boolean(),
  expenses: z.boolean(),
  vouchers: z.boolean(),
});
const operatorSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  permissions: permissionsSchema,
});
const loginSchema = z.object({
  token: z.string().min(16),
  eventId: z.string().min(1),
  operator: operatorSchema,
});
const saleSchema = z.object({
  commandId: z.string().min(16).max(160),
  saleId: z.string().min(16).max(160),
  servicePointId: z.string().min(1),
  items: z
    .array(
      z.object({
        productId: z.string().min(1),
        itemKind: z.enum(['product', 'combo']),
        quantity: z.number().int().positive().max(10000),
        componentSelections: z
          .array(
            z.object({
              choiceGroup: z.string(),
              productId: z.string(),
              quantity: z.number().int().positive(),
            }),
          )
          .optional(),
      }),
    )
    .min(1)
    .max(100),
  paymentMethod: z.enum(['cash', 'pix', 'credit-card', 'debit-card']).nullable(),
  receivedCents: z.number().int().nonnegative().nullable(),
  voucherUse: z.object({ code: z.string(), amountCents: z.number().int().positive() }).optional(),
});
const hash = (raw: string): string => createHash('sha256').update(raw).digest('hex');
const reply = (data: unknown, status = 200): Response =>
  Response.json(data, { status, headers: { 'Cache-Control': 'no-store' } });
interface LocalSession {
  event_id: string;
  operator_json: string;
  expires_at: number;
}
export class LocalMobileHub {
  constructor(
    private readonly getDatabase: () => DatabaseContext,
    private readonly authenticate: (input: unknown) => Promise<unknown>,
    private readonly onSale: (id: string) => void = () => undefined,
  ) {}
  async handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const route = url.pathname.replace(/^\/cashier\/api/, '');
    if (request.headers.get('Origin') && request.headers.get('Origin') !== url.origin)
      return reply({ error: { message: 'Origem não autorizada.' } }, 403);
    const db = this.getDatabase();
    try {
      if (route === '/v1/mobile/session' && request.method === 'POST') {
        const input = z
          .object({ password: z.string().min(1).max(128), deviceId: z.string().min(1).max(80) })
          .parse(await request.json());
        const result = loginSchema.parse(await this.authenticate(input));
        if (getSessionState(db).activeEvent?.id !== result.eventId)
          return reply(
            {
              error: { message: 'O evento do PC não corresponde ao evento autorizado na central.' },
            },
            409,
          );
        const token = randomBytes(32).toString('hex');
        // No passwords or cloud bearer tokens are persisted. The offline lease is
        // scoped to this PC, operator and event, and is never silently extended.
        db.sqlite
          .prepare(
            'INSERT INTO lan_sessions(token_hash,event_id,operator_json,expires_at) VALUES(?,?,?,?)',
          )
          .run(
            hash(token),
            result.eventId,
            JSON.stringify(result.operator),
            Date.now() + 12 * 60 * 60 * 1000,
          );
        return reply({
          token,
          eventId: result.eventId,
          operator: this.localOperator(result.operator),
        });
      }
      const token = request.headers.get('X-GTRZ-Session');
      const session = token
        ? (db.sqlite
            .prepare('SELECT * FROM lan_sessions WHERE token_hash=? AND expires_at>?')
            .get(hash(token), Date.now()) as LocalSession | undefined)
        : undefined;
      if (!session)
        return reply(
          {
            error: {
              message:
                'Vincule este celular à central local enquanto há internet. A autorização local dura 12 horas.',
            },
          },
          401,
        );
      const operator = this.localOperator(operatorSchema.parse(JSON.parse(session.operator_json)));
      if (getSessionState(db).activeEvent?.id !== session.event_id)
        return reply(
          { error: { message: 'O evento ativo mudou. Entre novamente neste celular.' } },
          409,
        );
      if (route === '/v1/mobile/session' && request.method === 'DELETE') {
        db.sqlite.prepare('DELETE FROM lan_sessions WHERE token_hash=?').run(hash(token ?? ''));
        return reply({ success: true });
      }
      if (
        request.method === 'GET' &&
        (route === '/v1/mobile/refresh' || route === '/v1/mobile/session')
      )
        return reply({
          operator,
          eventId: session.event_id,
          ...this.snapshot(db, session.event_id),
        });
      if (request.method === 'GET' && route === '/v1/mobile/sales/status') {
        const row = db.sqlite
          .prepare(
            'SELECT sale_id FROM lan_commands WHERE command_id=? AND event_id=? AND operator_id=?',
          )
          .get(url.searchParams.get('commandId'), session.event_id, operator.id) as
          | { sale_id: string }
          | undefined;
        return reply({
          accepted: row?.sale_id === url.searchParams.get('saleId'),
        });
      }
      if (request.method === 'POST' && route === '/v1/mobile/sales') {
        if (!operator.permissions.sales)
          return reply({ error: { message: 'Perfil sem permissão de venda.' } }, 403);
        const input = saleSchema.parse(await request.json());
        const fingerprint = hash(JSON.stringify(input));
        const sale = db.sqlite.transaction(() => {
          const prior = db.sqlite
            .prepare('SELECT * FROM lan_commands WHERE command_id=?')
            .get(input.commandId) as
            | { request_hash: string; response_json: string; event_id: string; operator_id: string }
            | undefined;
          if (prior) {
            if (
              prior.request_hash !== fingerprint ||
              prior.event_id !== session.event_id ||
              prior.operator_id !== operator.id
            )
              throw new Error('O ID já pertence a outra operação.');
            return { ...JSON.parse(prior.response_json), replayed: true } as {
              saleId: string;
              totalCents: number;
              replayed: boolean;
            };
          }
          const point = db.sqlite
            .prepare('SELECT id,label FROM service_points WHERE id=? AND event_id=? AND active=1')
            .get(input.servicePointId, session.event_id) as
            | { id: string; label: string }
            | undefined;
          if (!point) throw new Error('Mesa ou balcão indisponível neste evento.');
          const now = Date.now();
          db.sqlite
            .prepare(
              "INSERT INTO orders(id,event_id,service_point_id,service_point_label,status,subtotal_cents,discount_cents,total_cents,opened_at,closed_at,updated_at) VALUES(?,?,?,?,'open',0,0,0,?,NULL,?)",
            )
            .run(input.saleId, session.event_id, point.id, point.label, now, now);
          for (const item of input.items)
            addOrderItem(db, {
              orderId: input.saleId,
              itemKind: item.itemKind,
              itemId: item.productId,
              quantity: item.quantity,
              ...(item.componentSelections
                ? { componentSelections: item.componentSelections }
                : {}),
            });
          const total = (
            db.sqlite.prepare('SELECT total_cents FROM orders WHERE id=?').get(input.saleId) as {
              total_cents: number;
            }
          ).total_cents;
          const voucherCents = input.voucherUse?.amountCents ?? 0;
          const remaining = total - voucherCents;
          if (remaining < 0) throw new Error('O voucher excede o total.');
          if (remaining > 0 && input.paymentMethod === null)
            throw new Error('Informe a forma de pagamento.');
          const order = closeOrder(db, {
            orderId: input.saleId,
            discountCents: 0,
            payments:
              remaining > 0
                ? [
                    {
                      method: input.paymentMethod ?? 'cash',
                      amountCents: remaining,
                      ...(input.paymentMethod === 'cash' && input.receivedCents !== null
                        ? { receivedCents: input.receivedCents }
                        : {}),
                    },
                  ]
                : [],
            voucherUses: input.voucherUse ? [input.voucherUse] : [],
          });
          const audit = db.sqlite
            .prepare(
              "SELECT id FROM audit_log WHERE action='operations.order-paid' AND entity_id=? ORDER BY id DESC LIMIT 1",
            )
            .get(order.id) as { id: number };
          // The ID received from the phone remains the same through SQLite, outbox
          // and the cloud. This update is inside the sale/stock/payment transaction.
          db.sqlite
            .prepare('UPDATE local_operation_ids SET operation_id=? WHERE audit_id=?')
            .run(input.commandId, audit.id);
          db.sqlite
            .prepare(
              "UPDATE sync_outbox SET operation_id=?,payload_json=json_set(payload_json,'$.commandId',?,'$.details.operatorName',?,'$.details.originLabel','Rede local') WHERE audit_id=?",
            )
            .run(input.commandId, input.commandId, operator.name, audit.id);
          const response = { saleId: order.id, totalCents: order.totalCents, replayed: false };
          db.sqlite
            .prepare(
              'INSERT INTO lan_commands(command_id,event_id,operator_id,sale_id,request_hash,response_json,created_at) VALUES(?,?,?,?,?,?,?)',
            )
            .run(
              input.commandId,
              session.event_id,
              operator.id,
              order.id,
              fingerprint,
              JSON.stringify(response),
              now,
            );
          return response;
        })();
        if (!sale.replayed) {
          try {
            this.onSale(sale.saleId);
          } catch {
            /* Receipt delivery never rolls back a committed sale. */
          }
        }
        return reply({ status: 'accepted', ...sale });
      }
      return reply(
        {
          error: {
            message:
              'Nesta etapa, operações administrativas são feitas no PC. A venda local permanece disponível sem internet.',
          },
        },
        404,
      );
    } catch (error: unknown) {
      return reply(
        { error: { message: error instanceof Error ? error.message : 'Operação não concluída.' } },
        409,
      );
    }
  }
  private localOperator(operator: z.infer<typeof operatorSchema>): z.infer<typeof operatorSchema> {
    return {
      ...operator,
      permissions: {
        sales: operator.permissions.sales,
        inventory: false,
        tickets: false,
        expenses: false,
        vouchers: false,
      },
    };
  }
  private snapshot(
    db: DatabaseContext,
    eventId: string,
  ): {
    catalog: { products: readonly Record<string, unknown>[] };
    context: {
      servicePoints: readonly Record<string, unknown>[];
      ticketLots: readonly unknown[];
      vouchers: readonly unknown[];
      voucherCodes: readonly string[];
    };
  } {
    const state = getOperationState(db);
    const products = state.catalog
      .filter((item) => item.active)
      .map((item) => ({
        productId: item.id,
        label: item.name,
        kind: item.category,
        itemKind: item.kind,
        visible: true,
        categoryLabel: item.category === 'food' ? 'Comidas' : 'Bebidas',
        unitPriceCents: item.salePriceCents,
        quantity: item.availableQuantity,
        imageDataUrl: item.imageDataUrl,
        fallbackIcon: item.fallbackIcon,
        components:
          item.kind === 'combo'
            ? db.sqlite
                .prepare(
                  'SELECT product_id AS productId,quantity,choice_group AS choiceGroup,choice_label AS choiceLabel,sort_order AS sortOrder FROM combo_components WHERE combo_id=? ORDER BY sort_order,id',
                )
                .all(item.id)
            : [],
      }));
    const vouchers = db.sqlite
      .prepare(
        "SELECT v.id,v.code,v.label,v.remaining_balance_cents AS remainingBalanceCents,v.status,v.updated_at AS updatedAt,b.value AS servicePointId FROM vouchers v LEFT JOIN app_meta b ON b.key='voucher.service-point:'||v.id WHERE v.event_id=?",
      )
      .all(eventId);
    return {
      catalog: { products },
      context: {
        servicePoints: state.servicePoints.map((p) => ({
          id: p.id,
          label: p.label,
          type: p.type,
          active: true,
        })),
        ticketLots: [],
        vouchers,
        voucherCodes: [],
      },
    };
  }
}
