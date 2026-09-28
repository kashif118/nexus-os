import type { Ctx } from '@/kernel/tenancy/ctx'
import type { ListParams } from '@/kernel/validation/list-params'

import type { ExpenseSort, InvoiceSort } from './schema'
import * as service from './service'

/** Read boundary for finance Server Components. */

export const listInvoices = (
  ctx: Ctx,
  params: ListParams<InvoiceSort>,
  filters?: { status?: string | undefined; companyId?: string | undefined },
) => service.listInvoices(ctx, params, filters)

export const getInvoice = (ctx: Ctx, id: string) => service.getInvoice(ctx, id)

export const listExpenses = (
  ctx: Ctx,
  params: ListParams<ExpenseSort>,
  filters?: { status?: string | undefined; projectId?: string | undefined },
) => service.listExpenses(ctx, params, filters)

export const getExpense = (ctx: Ctx, id: string) => service.getExpense(ctx, id)
export const listExpenseCategories = (ctx: Ctx) => service.listExpenseCategories(ctx)
export const listBudgets = (ctx: Ctx) => service.listBudgets(ctx)
export const getFinancialSummary = (ctx: Ctx, since?: Date) =>
  service.getFinancialSummary(ctx, since)
export const getFinanceFormOptions = (ctx: Ctx) => service.getFinanceFormOptions(ctx)
